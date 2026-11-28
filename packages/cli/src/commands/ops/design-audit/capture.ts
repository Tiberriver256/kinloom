import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveDesignAuditArchetype } from './archetypes.js';
import type {
  DesignAuditCaptureRecord,
  DesignAuditClippedTextSample,
  DesignAuditFocusIssue,
  DesignAuditManifest,
  DesignAuditPlan,
  DesignAuditTelemetry,
  DesignAuditTheme,
  DesignAuditUiState,
} from './types.js';

export interface DesignAuditBrowserPage {
  emulateMedia?: (opts: {
    colorScheme?: 'light' | 'dark' | 'no-preference';
    contrast?: 'more' | 'no-preference';
    reducedMotion?: 'reduce' | 'no-preference';
  }) => Promise<void>;
  route?: (
    pattern: string,
    handler: (route: {
      fulfill: (opts: { status: number; contentType: string; body: string }) => Promise<void>;
      continue: () => Promise<void>;
    }) => Promise<void>
  ) => Promise<void>;
  goto: (url: string, opts?: { waitUntil?: string; timeout?: number | undefined }) => Promise<unknown>;
  waitForTimeout?: (ms: number) => Promise<void>;
  screenshot: (opts: {
    path: string;
    fullPage?: boolean | undefined;
    animations?: 'disabled' | 'allow' | undefined;
    caret?: 'hide' | 'initial';
  }) => Promise<unknown>;
  evaluate: <T = unknown>(fn: string | ((...args: never[]) => T)) => Promise<T>;
  addStyleTag?: (opts: { content: string }) => Promise<unknown>;
  keyboard?: { press: (key: string) => Promise<void> };
}

export interface DesignAuditBrowserContext {
  newPage: () => Promise<DesignAuditBrowserPage>;
  close: () => Promise<void>;
}

export interface DesignAuditBrowser {
  newContext: (opts: {
    viewport: { width: number; height: number };
    deviceScaleFactor?: number;
  }) => Promise<DesignAuditBrowserContext>;
  close: () => Promise<void>;
}

export type DesignAuditBrowserFactory = () => Promise<DesignAuditBrowser>;

interface PlaywrightLauncherModule {
  readonly chromium: {
    launch: (opts: { headless: boolean }) => Promise<DesignAuditBrowser>;
  };
}

interface RawTelemetryWithStylesheets extends DesignAuditTelemetry {
  stylesheets?: ReadonlyArray<{ readonly href: string; readonly cssText: string }>;
}

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function slugifyRoute(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_-]+/g, '_') || 'root';
}

const FREEZE_TIMELINES_EXPR = `(() => {
  let count = 0;
  for (const anim of document.getAnimations ? document.getAnimations() : []) {
    const timelineName = anim.timeline && anim.timeline.constructor ? anim.timeline.constructor.name : '';
    if (timelineName && timelineName !== 'DocumentTimeline') {
      anim.pause();
      count += 1;
    }
  }
  return count;
})()`;

const COLLECT_TELEMETRY_EXPR = `(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const docOverflowX = Math.max(0, document.documentElement.scrollWidth - vw);
  const rectAreaInFold = (el) => {
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x1 = Math.max(0, r.left);
    const y1 = Math.max(0, r.top);
    const x2 = Math.min(vw, r.right);
    const y2 = Math.min(vh, r.bottom);
    return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  };
  const mainEl = document.querySelector('main, [role="main"]');
  const chromeEls = [...document.querySelectorAll('header, nav, [role="banner"], [role="navigation"]')];
  const mainArea = rectAreaInFold(mainEl);
  const chromeArea = chromeEls.reduce((acc, el) => acc + rectAreaInFold(el), 0);
  const foldArea = vw * vh || 1;
  const interactives = [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')]
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
        touchAction: cs.touchAction,
        pointerEvents: cs.pointerEvents,
      };
    })
    .filter((item) => item.visible);
  const textSamples = [...document.querySelectorAll('h1, h2, h3, p, li, a, button, label, td, th')]
    .slice(0, 120)
    .map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      let bg = cs.backgroundColor;
      let cur = el.parentElement;
      while ((bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') && cur) {
        bg = getComputedStyle(cur).backgroundColor;
        cur = cur.parentElement;
      }
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 80),
        fontSizePx: parseFloat(cs.fontSize) || 16,
        fontWeight: parseInt(cs.fontWeight, 10) || 400,
        fontStyle: cs.fontStyle,
        lineHeight: cs.lineHeight,
        textDecorationLine: cs.textDecorationLine,
        textTransform: cs.textTransform,
        fontFamily: cs.fontFamily,
        color: cs.color,
        backgroundColor: bg || 'rgb(255, 255, 255)',
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    })
    .filter((s) => s.text.length > 0 && s.rect[2] > 0 && s.rect[3] > 0);
  const h1 = document.querySelector('h1');
  const title = document.title || '';
  const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') || '';
  const stylesheets = [];
  for (const sheet of document.styleSheets) {
    try {
      const cssText = [...sheet.cssRules].map((rule) => rule.cssText).join('\\n');
      if (cssText.trim()) stylesheets.push({ href: sheet.href || 'inline', cssText });
    } catch {}
  }
  const navLinks = [...document.querySelectorAll('header a, nav a')].length;
  const h1Rect = h1 ? h1.getBoundingClientRect() : null;
  const h1Truncated = h1 ? h1.scrollWidth > h1.clientWidth + 2 : false;
  return {
    viewport: vw + 'x' + vh,
    docOverflowX,
    aboveFoldMainRatio: Number((mainArea / foldArea).toFixed(4)),
    aboveFoldChromeRatio: Number((chromeArea / foldArea).toFixed(4)),
    navLinkCount: navLinks,
    title,
    h1Text: h1 ? h1.innerText.trim() : '',
    h1Truncated,
    h1Rect: h1Rect ? [Math.round(h1Rect.x), Math.round(h1Rect.y), Math.round(h1Rect.width), Math.round(h1Rect.height)] : null,
    viewportMeta,
    interactives,
    textSamples,
    stylesheets,
  };
})()`;

const RUNNING_ANIMS_EXPR = `(() => {
  return document.getAnimations ? document.getAnimations().filter((a) => a.playState === 'running').length : 0;
})()`;

const TEXT_SPACING_CLIP_EXPR = `(() => {
  const clipped = [];
  for (const el of document.querySelectorAll('h1, h2, h3, p, button, a, label')) {
    const cs = getComputedStyle(el);
    if ((cs.overflow === 'hidden' || cs.overflowY === 'hidden') && el.scrollHeight > el.clientHeight + 4) {
      const r = el.getBoundingClientRect();
      clipped.push({
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 60),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      });
    }
  }
  return clipped.slice(0, 25);
})()`;

export function isPlaywrightLauncher(value: unknown): value is PlaywrightLauncherModule {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const rec = value as { chromium?: { launch?: unknown } };
  return typeof rec.chromium?.launch === 'function';
}

async function defaultBrowserFactory(): Promise<DesignAuditBrowser> {
  const candidates = ['playwright-core', 'playwright'];
  for (const modName of candidates) {
    try {
      const loaded: unknown = await import(modName);
      if (isPlaywrightLauncher(loaded)) {
        return await loaded.chromium.launch({ headless: true });
      }
    } catch {
      // Try next candidate
    }
  }
  throw new Error(
    'Playwright is not installed (install playwright-core or playwright for live browser audits).'
  );
}

async function configureUiStateRoute(
  page: DesignAuditBrowserPage,
  apiInterceptPattern: string | undefined,
  partialPayload: Record<string, unknown> | undefined,
  uiState: DesignAuditUiState,
  loadingDelayMs = 1500
): Promise<void> {
  if (!page.route || !apiInterceptPattern || uiState === 'ideal') {
    return;
  }
  await page.route(apiInterceptPattern, async (route) => {
    if (uiState === 'loading') {
      await new Promise((r) => setTimeout(r, loadingDelayMs));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    if (uiState === 'empty-first' || uiState === 'empty-cleared' || uiState === 'empty-zero') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [], results: [], total: 0 }),
      });
      return;
    }
    if (uiState === 'partial') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(partialPayload ?? { items: [{ id: 'partial-1', title: 'Sparse Record' }] }),
      });
      return;
    }
    if (uiState === 'error') {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Simulated server failure for UI Stack audit' }),
      });
      return;
    }
    await route.continue();
  });
}

async function auditFocusOcclusion(page: DesignAuditBrowserPage): Promise<DesignAuditFocusIssue[]> {
  if (!page.keyboard) {
    return [];
  }
  const issues: DesignAuditFocusIssue[] = [];
  const stickyBars =
    (await page.evaluate<Array<{ tag: string; rect: [number, number, number, number] }>>(`(() => {
    return [...document.querySelectorAll('*')]
      .filter((el) => {
        const pos = getComputedStyle(el).position;
        return pos === 'fixed' || pos === 'sticky';
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { tag: el.tagName.toLowerCase(), rect: [r.left, r.top, r.right, r.bottom] };
      })
      .filter((b) => b.rect[2] - b.rect[0] > 0 && b.rect[3] - b.rect[1] > 0);
  })()`)) ?? [];

  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate<{
      tag: string;
      text: string;
      rect: [number, number, number, number];
      outlineStyle: string;
      boxShadow: string;
    } | null>(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60),
        rect: [r.left, r.top, r.right, r.bottom],
        outlineStyle: cs.outlineStyle,
        boxShadow: cs.boxShadow,
      };
    })()`);
    if (!active) {
      continue;
    }
    for (const bar of stickyBars) {
      const overlapX = Math.max(
        0,
        Math.min(active.rect[2], bar.rect[2]) - Math.max(active.rect[0], bar.rect[0])
      );
      const overlapY = Math.max(
        0,
        Math.min(active.rect[3], bar.rect[3]) - Math.max(active.rect[1], bar.rect[1])
      );
      if (overlapX > 2 && overlapY > 2) {
        issues.push({
          type: 'focus-occluded',
          target: active.text || active.tag,
          rect: [
            Math.round(active.rect[0]),
            Math.round(active.rect[1]),
            Math.round(active.rect[2]),
            Math.round(active.rect[3]),
          ],
          occluder: bar.tag,
        });
      }
    }
    if (active.outlineStyle === 'none' && (!active.boxShadow || active.boxShadow === 'none')) {
      issues.push({
        type: 'focus-missing-indicator',
        target: active.text || active.tag,
        rect: [
          Math.round(active.rect[0]),
          Math.round(active.rect[1]),
          Math.round(active.rect[2]),
          Math.round(active.rect[3]),
        ],
      });
    }
  }
  return issues;
}

export async function runDesignAuditCaptureMatrix(options: {
  readonly plan: DesignAuditPlan;
  readonly bundleDir: string;
  readonly browserFactory?: DesignAuditBrowserFactory | undefined;
  readonly loadingDelayMs?: number | undefined;
}): Promise<DesignAuditManifest> {
  const { plan, bundleDir } = options;
  const shotsDir = path.join(bundleDir, 'screenshots');
  const domDir = path.join(bundleDir, 'dom');
  const cssDir = path.join(bundleDir, 'css');
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(domDir, { recursive: true });
  fs.mkdirSync(cssDir, { recursive: true });

  const browser = await (options.browserFactory ?? defaultBrowserFactory)();
  const captures: DesignAuditCaptureRecord[] = [];
  const cssExtracted = new Map<string, string>();

  try {
    for (const routeCfg of plan.routes) {
      const arch = resolveDesignAuditArchetype(routeCfg.archetype);
      const themes: readonly DesignAuditTheme[] = plan.themes ?? ['light', 'dark'];
      const states: readonly DesignAuditUiState[] = routeCfg.uiStates ?? ['ideal'];

      for (const vp of arch.viewports) {
        for (const theme of themes) {
          for (const uiState of states) {
            if (uiState !== 'ideal' && vp.width !== 360 && vp.width !== 1440) {
              continue;
            }
            const context = await browser.newContext({
              viewport: { width: vp.width, height: vp.height },
              deviceScaleFactor: 1,
            });
            try {
              const page = await context.newPage();
              if (page.emulateMedia) {
                await page.emulateMedia({
                  colorScheme: theme === 'dark' ? 'dark' : 'light',
                  contrast: theme === 'more-contrast' ? 'more' : 'no-preference',
                  reducedMotion: 'no-preference',
                });
              }
              await configureUiStateRoute(
                page,
                routeCfg.apiInterceptPattern,
                routeCfg.partialPayload,
                uiState,
                options.loadingDelayMs
              );
              const targetUrl = new URL(routeCfg.path, plan.baseUrl).toString();
              try {
                await page.goto(targetUrl, {
                  waitUntil: uiState === 'loading' ? 'domcontentloaded' : 'networkidle',
                  timeout: 20_000,
                });
              } catch {
                await page.waitForTimeout?.(400);
              }
              if (uiState === 'loading') {
                await page.waitForTimeout?.(300);
              }
              await page
                .evaluate(
                  `(() => { try { window.localStorage?.removeItem('kinloom:theme'); } catch {} const root = document.documentElement; if (root && root.hasAttribute('data-theme')) { root.setAttribute('data-theme', '${theme === 'dark' ? 'dark' : 'light'}'); } })()`
                )
                .catch(() => undefined);

              const baseName = `${slugifyRoute(routeCfg.path)}__${vp.width}x${vp.height}__${theme}__${uiState}`;
              const shotPath = path.join(shotsDir, `${baseName}.png`);
              await page.evaluate(FREEZE_TIMELINES_EXPR).catch(() => 0);
              await page.screenshot({
                path: shotPath,
                fullPage: false,
                animations: 'disabled',
                caret: 'hide',
              });

              const rawTelemetry = await page.evaluate<RawTelemetryWithStylesheets>(COLLECT_TELEMETRY_EXPR);
              for (const sheet of rawTelemetry.stylesheets ?? []) {
                cssExtracted.set(sheet.href, sheet.cssText);
              }
              const { stylesheets: _omit, ...telemetryBase } = rawTelemetry;

              let focusIssues: DesignAuditFocusIssue[] = [];
              let textSpacingClipped: DesignAuditClippedTextSample[] = [];
              if (uiState === 'ideal' && (vp.width === 360 || vp.width === 1440)) {
                focusIssues = await auditFocusOcclusion(page);
                if (page.addStyleTag) {
                  await page.addStyleTag({
                    content:
                      '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
                  });
                }
                textSpacingClipped =
                  await page.evaluate<DesignAuditClippedTextSample[]>(TEXT_SPACING_CLIP_EXPR);
              }

              const telemetryPath = path.join(domDir, `${baseName}.telemetry.json`);
              fs.writeFileSync(
                telemetryPath,
                JSON.stringify({ ...telemetryBase, focusIssues, textSpacingClipped }, null, 2)
              );

              captures.push({
                id: baseName,
                route: routeCfg.path,
                archetype: routeCfg.archetype,
                viewport: `${vp.width}x${vp.height}`,
                theme,
                uiState,
                screenshotUri: path.relative(bundleDir, shotPath),
                screenshotSha256: sha256File(shotPath),
                telemetryUri: path.relative(bundleDir, telemetryPath),
              });
            } finally {
              await context.close();
            }
          }

          if (vp.width === 1440 && theme === 'light') {
            const rmCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            try {
              const rmPage = await rmCtx.newPage();
              if (rmPage.emulateMedia) {
                await rmPage.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
              }
              await rmPage.goto(new URL(routeCfg.path, plan.baseUrl).toString(), {
                waitUntil: 'networkidle',
                timeout: 20_000,
              });
              const runningSpatialAnims = await rmPage.evaluate<number>(RUNNING_ANIMS_EXPR);
              const rmBase = `${slugifyRoute(routeCfg.path)}__1440x900__light__reduced-motion`;
              const rmShot = path.join(shotsDir, `${rmBase}.png`);
              await rmPage.screenshot({ path: rmShot, fullPage: false, caret: 'hide' });
              captures.push({
                id: rmBase,
                route: routeCfg.path,
                archetype: routeCfg.archetype,
                viewport: '1440x900',
                theme: 'light',
                uiState: 'reduced-motion',
                runningAnimationsUnderReducedMotion: runningSpatialAnims,
                screenshotUri: path.relative(bundleDir, rmShot),
                screenshotSha256: sha256File(rmShot),
              });
            } finally {
              await rmCtx.close();
            }
          }
        }
      }
    }
  } finally {
    await browser.close();
  }

  let cssIdx = 0;
  const cssFiles: string[] = [];
  for (const [href, cssText] of cssExtracted.entries()) {
    const out = path.join(cssDir, `sheet-${cssIdx++}.css`);
    fs.writeFileSync(out, `/* source: ${href} */\n${cssText}`, 'utf8');
    cssFiles.push(path.relative(bundleDir, out));
  }

  const manifest: DesignAuditManifest = {
    runId: plan.runId,
    sealedAtUtc: new Date().toISOString(),
    baseUrl: plan.baseUrl,
    mode: plan.mode,
    deterministicRuntime: true,
    coverage: 'full',
    captureCount: captures.length,
    cssFiles,
    captures,
  };
  fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
