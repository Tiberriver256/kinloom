import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inspectLiveNavLinks,
  inspectThemeSurface,
  inspectVisiblePluginSlots,
  navigateAndSettlePage,
  safeCloseHandle,
} from './browser.js';
import { prepareComponentCapture } from './components.js';
import { classifyDiscoveredNavLinks } from './discovery.js';
import { buildScreenshotRelativePath, resolveCaptureTimeoutPolicy, sanitizeUrlForReport } from './parse.js';
import { buildCaptureThemeAudit } from './report.js';
import type {
  AuthHeader,
  BundleDiscoveryResult,
  CaptureTarget,
  DiscoveredPluginSlot,
  IncludeScope,
  ManifestCaptureEntry,
  ScreenshotBrowserHandle,
  ScreenshotContextHandle,
  ScreenshotCookieSpec,
  ScreenshotPageHandle,
  ScreenshotTheme,
  ViewportSpec,
} from './types.js';

export interface ResolvedScreenshotRunConfig {
  readonly targetUrl: string;
  readonly outDir: string;
  readonly viewports: readonly ViewportSpec[];
  readonly themes: readonly ScreenshotTheme[];
  readonly include: readonly IncludeScope[];
  readonly explicitRoutes: readonly string[];
  readonly explicitPluginRoutes: readonly string[];
  readonly samplePeople: number;
  readonly samplePlaces: number;
  readonly authCookie?: string;
  readonly authHeaders: readonly AuthHeader[];
  readonly cookieSpecs: readonly ScreenshotCookieSpec[];
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly fullPage: boolean;
  readonly waitMs: number;
  readonly timeoutMs: number;
  readonly heavyTimeoutMs?: number;
  readonly mapSettleTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly concurrency: number;
  readonly json: boolean;
}

export function isMapCaptureTarget(target: CaptureTarget): boolean {
  const pathOnly = target.route.split('?')[0].toLowerCase();
  return (target.category === 'page' && target.isMap === true) || pathOnly === '/map';
}

export function isHeavyCaptureTarget(target: CaptureTarget): boolean {
  const pathOnly = target.route.split('?')[0].toLowerCase();
  return (target.category === 'page' && target.isHeavyPage === true) || pathOnly === '/evidence';
}

export function requiresIsolatedCaptureContext(target: CaptureTarget): boolean {
  return target.category === 'component' && target.recipeId === 'theme-toggle';
}

export function isScreenshotTimeoutError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|timed out/i.test(message);
}

async function computeFileSha256(filePath: string): Promise<string | undefined> {
  try {
    const bytes = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

async function capturePageScreenshotResilient(options: {
  readonly page: ScreenshotPageHandle;
  readonly filePath: string;
  readonly fullPage: boolean;
  readonly captureTimeoutMs: number;
  readonly fallbackTimeoutMs: number;
}): Promise<{
  readonly fallbackUsed?: 'viewport-after-fullpage-timeout';
  readonly reason?: string;
}> {
  try {
    await options.page.screenshot({
      path: options.filePath,
      fullPage: options.fullPage,
      timeout: options.captureTimeoutMs,
      animations: 'disabled',
    });
    return {};
  } catch (err: unknown) {
    if (!options.fullPage || !isScreenshotTimeoutError(err)) {
      throw err;
    }
    await options.page.screenshot({
      path: options.filePath,
      fullPage: false,
      timeout: options.fallbackTimeoutMs,
      animations: 'disabled',
    });
    return {
      fallbackUsed: 'viewport-after-fullpage-timeout',
      reason: 'Full-page capture timed out; captured viewport fallback',
    };
  }
}

export function redactErrorReason(rawMessage: string, secrets: readonly string[]): string {
  let clean = rawMessage.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) {
    if (secret.length >= 4) {
      clean = clean.replaceAll(secret, '[redacted]');
    }
  }
  return clean.slice(0, 300);
}

export async function openConfiguredContext(
  browser: ScreenshotBrowserHandle,
  viewport: ViewportSpec,
  theme: ScreenshotTheme,
  config: ResolvedScreenshotRunConfig
): Promise<ScreenshotContextHandle> {
  const hasHeaders = Object.keys(config.extraHeaders).length > 0;
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: theme,
    extraHTTPHeaders: hasHeaders ? config.extraHeaders : undefined,
  });
  context.setDefaultTimeout?.(config.timeoutMs);
  context.setDefaultNavigationTimeout?.(config.timeoutMs);
  if (config.cookieSpecs.length > 0 && context.addCookies) {
    await context.addCookies(config.cookieSpecs);
  }
  return context;
}

export async function discoverLiveDomMetadata(
  browser: ScreenshotBrowserHandle,
  config: ResolvedScreenshotRunConfig,
  bundleDiscovery: BundleDiscoveryResult
): Promise<{
  readonly navExtraCoreRoutes: readonly { readonly route: string; readonly label: string }[];
  readonly discoveredPluginRoutes: readonly { readonly route: string; readonly label: string }[];
  readonly discoveredSlots: readonly DiscoveredPluginSlot[];
}> {
  const includePlugins = config.include.includes('plugins');
  const includePages = config.include.includes('pages');
  if (!includePlugins && !includePages) {
    return { navExtraCoreRoutes: [], discoveredPluginRoutes: [], discoveredSlots: [] };
  }

  const probeViewport = config.viewports[config.viewports.length - 1];
  const probeTheme = config.themes[0];
  let context: ScreenshotContextHandle | undefined;
  try {
    context = await openConfiguredContext(browser, probeViewport, probeTheme, config);
    const page = await context.newPage();
    try {
      await navigateAndSettlePage({
        page,
        url: `${config.targetUrl}/`,
        theme: probeTheme,
        timeoutMs: config.timeoutMs,
        waitMs: Math.min(config.waitMs, 250),
      });
      const navLinks = await inspectLiveNavLinks(page);
      const classified = classifyDiscoveredNavLinks(navLinks, config.targetUrl);
      const slots: DiscoveredPluginSlot[] = [];

      if (includePlugins) {
        slots.push(...(await inspectVisiblePluginSlots(page, '/')));
        const samplePerson = bundleDiscovery.people[0];
        if (samplePerson) {
          const personRoute = `/person/${samplePerson.slug}`;
          await navigateAndSettlePage({
            page,
            url: `${config.targetUrl}${personRoute}`,
            theme: probeTheme,
            timeoutMs: config.timeoutMs,
            waitMs: Math.min(config.waitMs, 250),
          });
          slots.push(...(await inspectVisiblePluginSlots(page, personRoute)));
        }
        const samplePlace = bundleDiscovery.places[0];
        if (samplePlace) {
          const placeRoute = `/place/${samplePlace.slug}`;
          await navigateAndSettlePage({
            page,
            url: `${config.targetUrl}${placeRoute}`,
            theme: probeTheme,
            timeoutMs: config.timeoutMs,
            waitMs: Math.min(config.waitMs, 250),
          });
          slots.push(...(await inspectVisiblePluginSlots(page, placeRoute)));
        }
      }

      return {
        navExtraCoreRoutes: classified.extraCoreRoutes,
        discoveredPluginRoutes: classified.pluginRoutes,
        discoveredSlots: slots,
      };
    } finally {
      await safeCloseHandle(page, 'discovery.page.close', 2_000);
    }
  } catch {
    return { navExtraCoreRoutes: [], discoveredPluginRoutes: [], discoveredSlots: [] };
  } finally {
    await safeCloseHandle(context, 'discovery.context.close', 2_000);
  }
}

export async function runSingleCapture(input: {
  readonly context: ScreenshotContextHandle;
  readonly target: CaptureTarget;
  readonly viewport: ViewportSpec;
  readonly theme: ScreenshotTheme;
  readonly config: ResolvedScreenshotRunConfig;
  readonly searchQuery: string;
  readonly secrets: readonly string[];
}): Promise<ManifestCaptureEntry> {
  const { context, target, viewport, theme, config, searchQuery, secrets } = input;
  const startedAt = Date.now();
  const state = target.category === 'page' ? 'default' : target.state;

  if (
    target.category === 'component' &&
    target.viewportFilter &&
    !target.viewportFilter.includes(viewport.name)
  ) {
    return {
      category: target.category,
      id: target.id,
      slug: target.slug,
      label: target.label,
      state,
      route: target.route,
      viewport: viewport.name,
      theme,
      file: null,
      width: viewport.width,
      height: viewport.height,
      durationMs: 0,
      status: 'skipped',
      reason: `Only applicable to viewports: ${target.viewportFilter.join(', ')}`,
      consoleErrors: [],
      failedRequests: [],
    };
  }

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const relativeFile = buildScreenshotRelativePath({
    category: target.category,
    slug: target.slug,
    state,
    viewport: viewport.name,
    theme,
  });
  const absoluteFile = path.join(config.outDir, ...relativeFile.split('/'));

  const page = await context.newPage();
  try {
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(redactErrorReason(msg.text(), secrets));
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(redactErrorReason(err.message, secrets));
    });
    page.on('requestfailed', (req) => {
      const safeUrl = sanitizeUrlForReport(req.url());
      const detail = req.failure()?.errorText;
      failedRequests.push(detail ? `${safeUrl} (${detail})` : safeUrl);
    });

    const isMap = isMapCaptureTarget(target);
    const isHeavyPage = isHeavyCaptureTarget(target);
    const timeoutPolicy = resolveCaptureTimeoutPolicy({
      baseTimeoutMs: config.timeoutMs,
      isMap,
      isHeavyPage,
      heavyTimeoutMs: config.heavyTimeoutMs,
      mapSettleTimeoutMs: config.mapSettleTimeoutMs,
      env: config.env ?? process.env,
    });

    await navigateAndSettlePage({
      page,
      url: `${config.targetUrl}${target.route}`,
      theme,
      timeoutMs: timeoutPolicy.captureTimeoutMs,
      navigationTimeoutMs: timeoutPolicy.navigationTimeoutMs,
      mapSettleTimeoutMs: timeoutPolicy.mapSettleTimeoutMs,
      waitMs: config.waitMs,
      isMap,
    });

    let fallbackUsed: ManifestCaptureEntry['fallbackUsed'];
    let captureReason: string | undefined;

    if (target.category === 'page') {
      await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
      const shotResult = await capturePageScreenshotResilient({
        page,
        filePath: absoluteFile,
        fullPage: isMap ? false : config.fullPage,
        captureTimeoutMs: timeoutPolicy.captureTimeoutMs,
        fallbackTimeoutMs: timeoutPolicy.fullPageFallbackTimeoutMs,
      });
      fallbackUsed = shotResult.fallbackUsed;
      captureReason = shotResult.reason;
    } else if (target.category === 'component') {
      const prepared = await prepareComponentCapture(target, page, {
        viewport,
        searchQuery,
        actionTimeoutMs: Math.min(4_000, timeoutPolicy.captureTimeoutMs),
        settleMs: Math.max(150, Math.min(config.waitMs, 800)),
      });
      if (prepared.kind === 'skip') {
        return {
          category: target.category,
          id: target.id,
          slug: target.slug,
          label: target.label,
          state,
          route: target.route,
          viewport: viewport.name,
          theme,
          file: null,
          width: viewport.width,
          height: viewport.height,
          durationMs: Date.now() - startedAt,
          status: 'skipped',
          reason: prepared.reason,
          consoleErrors,
          failedRequests,
        };
      }
      await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
      if (prepared.kind === 'element') {
        await prepared.locator.screenshot({
          path: absoluteFile,
          timeout: timeoutPolicy.captureTimeoutMs,
          animations: 'disabled',
        });
      } else {
        await page.screenshot({
          path: absoluteFile,
          fullPage: prepared.fullPage,
          timeout: timeoutPolicy.captureTimeoutMs,
          animations: 'disabled',
        });
      }
    } else if (target.slotSelector) {
      const locator = page.locator(target.slotSelector).first();
      const count = await page.locator(target.slotSelector).count();
      const visible = count > 0 && (await locator.isVisible());
      const box = visible ? await locator.boundingBox() : null;
      if (!visible || !box || box.width < 2 || box.height < 2) {
        return {
          category: target.category,
          id: target.id,
          slug: target.slug,
          label: target.label,
          state,
          route: target.route,
          viewport: viewport.name,
          theme,
          file: null,
          width: viewport.width,
          height: viewport.height,
          durationMs: Date.now() - startedAt,
          status: 'skipped',
          reason: `Plugin slot '${target.slotSelector}' is not visible at ${viewport.name}`,
          consoleErrors,
          failedRequests,
        };
      }
      await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
      await locator.screenshot({
        path: absoluteFile,
        timeout: timeoutPolicy.captureTimeoutMs,
        animations: 'disabled',
      });
    } else {
      await fs.mkdir(path.dirname(absoluteFile), { recursive: true });
      const shotResult = await capturePageScreenshotResilient({
        page,
        filePath: absoluteFile,
        fullPage: config.fullPage,
        captureTimeoutMs: timeoutPolicy.captureTimeoutMs,
        fallbackTimeoutMs: timeoutPolicy.fullPageFallbackTimeoutMs,
      });
      fallbackUsed = shotResult.fallbackUsed;
      captureReason = shotResult.reason;
    }

    const [surfaceProbe, contentSha256] = await Promise.all([
      inspectThemeSurface(page),
      computeFileSha256(absoluteFile),
    ]);
    const themeAudit = buildCaptureThemeAudit(surfaceProbe, contentSha256);

    return {
      category: target.category,
      id: target.id,
      slug: target.slug,
      label: target.label,
      state,
      route: target.route,
      viewport: viewport.name,
      theme,
      file: relativeFile,
      width: viewport.width,
      height: viewport.height,
      durationMs: Date.now() - startedAt,
      status: 'captured',
      ...(captureReason ? { reason: captureReason } : {}),
      ...(fallbackUsed ? { fallbackUsed } : {}),
      ...(themeAudit ? { themeAudit } : {}),
      consoleErrors,
      failedRequests,
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    return {
      category: target.category,
      id: target.id,
      slug: target.slug,
      label: target.label,
      state,
      route: target.route,
      viewport: viewport.name,
      theme,
      file: null,
      width: viewport.width,
      height: viewport.height,
      durationMs: Date.now() - startedAt,
      status: 'failed',
      reason: redactErrorReason(rawMsg, secrets),
      consoleErrors,
      failedRequests,
    };
  } finally {
    await safeCloseHandle(page, 'capture.page.close', 2_000);
  }
}

export async function runWithBoundedConcurrency<Item, Result>(
  items: readonly Item[],
  concurrency: number,
  worker: (item: Item, index: number) => Promise<Result>
): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));

  const runNext = async (): Promise<void> => {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
  return results;
}
