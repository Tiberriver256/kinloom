import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../../../cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../../../errors.js';
import {
  analyzeCssMetrics,
  auditTokensAndCss,
  calcApcaLc,
  calcWcag2Contrast,
  DESIGN_AUDIT_CORE_ROUTES,
  type DesignAuditBrowser,
  type DesignAuditBrowserPage,
  type DesignAuditFinding,
  type DesignAuditManifest,
  type DesignAuditPlan,
  type DesignAuditTelemetry,
  dedupeFindings,
  discoverDesignAuditAutoRoutes,
  emitSarifAndDossier,
  evaluateBundleDeterministic,
  initDesignAuditPlan,
  isPlaywrightLauncher,
  mergeUniqueRoutes,
  parseCssRgbTuple,
  resolveDesignAuditArchetype,
  runDesignAuditCaptureMatrix,
  runDesignAuditCommand,
  slugifyRoute,
} from '../design-audit.js';
import { extractEnabledPluginRoutesFromBundle } from '../shared/routeDiscovery.js';
import type { WranglerExecutor } from '../shared/wrangler.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

afterEach(async () => {
  delete process.env['KINLOOM_TELEMETRY_FILE'];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('design-audit APCA & WCAG contrast math', () => {
  it('parses rgb, rgba, 3-digit hex, and 6-digit hex colors and computes APCA/WCAG contrast', () => {
    expect(parseCssRgbTuple('rgb(35, 39, 46)')).toEqual([35, 39, 46]);
    expect(parseCssRgbTuple('rgba(245, 239, 226, 0.95)')).toEqual([245, 239, 226]);
    expect(parseCssRgbTuple('#fff')).toEqual([255, 255, 255]);
    expect(parseCssRgbTuple('#171614')).toEqual([23, 22, 20]);
    expect(parseCssRgbTuple('transparent')).toBeNull();

    const blackOnWhiteWcag = calcWcag2Contrast([0, 0, 0], [255, 255, 255]);
    expect(blackOnWhiteWcag).toBeCloseTo(21, 1);

    const blackOnWhiteApca = calcApcaLc([0, 0, 0], [255, 255, 255]);
    expect(blackOnWhiteApca).toBeGreaterThan(100);

    const whiteOnBlackApca = calcApcaLc([255, 255, 255], [0, 0, 0]);
    expect(whiteOnBlackApca).toBeLessThan(-100);

    expect(calcApcaLc([120, 120, 120], [120, 120, 120])).toBe(0);
  });

  it('resolves calibrated archetypes and rejects unknown ones', () => {
    expect(resolveDesignAuditArchetype('editorial').metrics.maxUniqueColors).toBe(24);
    expect(resolveDesignAuditArchetype('saas').metrics.maxTopLevelNavLinks).toBe(9);
    expect(resolveDesignAuditArchetype('ecommerce').metrics.touchTargetRecommendedPx).toBe(48);
    expect(resolveDesignAuditArchetype('mobile-app').metrics.maxTopLevelNavLinks).toBe(5);
    expect(() => resolveDesignAuditArchetype('unknown-kind')).toThrow(/Unknown design-audit archetype/);
  });
});

describe('design-audit CSS entropy & W3C DTCG 2025.10 token auditor', () => {
  it('detects color/font-size entropy, invalid DTCG JSON, missing resolutionOrder, alias cycles, and mode-baked names', async () => {
    const tmp = await makeTempDir('kinloom-da-css-');
    const cssLines: string[] = ['/* comment */'];
    for (let i = 0; i < 28; i += 1) {
      const hex = `#${i.toString(16).padStart(2, '0')}2233`;
      cssLines.push(`.c-${i} { color: ${hex}; font-size: ${10 + i}px !important; }`);
    }
    const cssPath = path.join(tmp, 'styles.css');
    fs.writeFileSync(cssPath, cssLines.join('\n'), 'utf8');

    const badJsonPath = path.join(tmp, 'broken.tokens.json');
    fs.writeFileSync(badJsonPath, '{ bad json', 'utf8');

    const badResolverPath = path.join(tmp, 'site.resolver.json');
    fs.writeFileSync(badResolverPath, JSON.stringify({ sets: {} }), 'utf8');

    const cycleTokensPath = path.join(tmp, 'theme.tokens.json');
    fs.writeFileSync(
      cycleTokensPath,
      JSON.stringify({
        color: {
          a: { $value: '{color.b}' },
          b: { $value: '{color.a}' },
          'dark-surface': { $value: '#171614' },
        },
      }),
      'utf8'
    );

    const stats = analyzeCssMetrics(cssLines.join('\n'));
    expect(stats.uniqueColors).toBe(28);
    expect(stats.uniqueFontSizes).toBe(28);
    expect(stats.importants).toBe(28);

    const res = auditTokensAndCss({
      repoRoot: tmp,
      archetype: 'editorial',
      writeOutput: false,
    });
    expect(res.ok).toBe(false);
    const ruleIds = res.findings.map((f) => f.ruleId);
    expect(ruleIds).toContain('DA-06-COLOR-ENTROPY');
    expect(ruleIds).toContain('DA-05-FONT-SIZE-ENTROPY');
    expect(ruleIds).toContain('DA-06-DTCG-INVALID-JSON');
    expect(ruleIds).toContain('DA-06-DTCG-RESOLVER-ORDER');
    expect(ruleIds).toContain('DA-06-DTCG-CIRCULAR-ALIAS');
    expect(ruleIds).toContain('DA-06-DTCG-MODE-NOT-ORTHOGONAL');
  });
});

describe('design-audit deterministic probes, capture matrix & SARIF 2.1.0', () => {
  it('flags deterministic DOM, contrast, halation, touch, focus, text-spacing, and reduced-motion defects', async () => {
    const tmp = await makeTempDir('kinloom-da-det-');
    fs.mkdirSync(path.join(tmp, 'dom'), { recursive: true });

    const telemetry: DesignAuditTelemetry = {
      viewport: '360x800',
      docOverflowX: 24,
      aboveFoldMainRatio: 0.3,
      aboveFoldChromeRatio: 0.5,
      aboveFoldContentYieldRatio: 0.375,
      firstContentY: 420,
      firstContentSelector: 'article.story-card',
      navLinkCount: 12,
      title: 'Archive',
      h1Text: 'Very Long Archival Heading That Clips',
      h1Truncated: true,
      h1Rect: [10, 60, 340, 40],
      viewportMeta: 'width=device-width, initial-scale=1, user-scalable=no',
      interactives: [
        {
          tag: 'button',
          role: 'button',
          text: 'Tiny',
          rect: [10, 100, 18, 18],
          visible: true,
          touchAction: 'auto',
          pointerEvents: 'auto',
        },
      ],
      textSamples: [
        {
          tag: 'p',
          text: 'Low contrast muted note',
          fontSizePx: 14,
          fontWeight: 400,
          fontStyle: 'normal',
          lineHeight: '20px',
          textDecorationLine: 'none',
          textTransform: 'none',
          fontFamily: 'serif',
          color: 'rgb(110, 110, 110)',
          backgroundColor: 'rgb(95, 95, 95)',
          rect: [10, 140, 200, 20],
        },
        {
          tag: 'h1',
          text: 'Pure White Dark Headline',
          fontSizePx: 32,
          fontWeight: 700,
          fontStyle: 'normal',
          lineHeight: '38px',
          textDecorationLine: 'none',
          textTransform: 'none',
          fontFamily: 'serif',
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(0, 0, 0)',
          rect: [10, 60, 300, 38],
        },
      ],
      focusIssues: [
        { type: 'focus-occluded', target: 'Skip link', rect: [0, 0, 100, 40], occluder: 'header' },
        { type: 'focus-missing-indicator', target: 'Menu', rect: [10, 10, 50, 40] },
      ],
      textSpacingClipped: [{ tag: 'p', text: 'Clipped text', rect: [10, 200, 150, 20] }],
    };

    fs.writeFileSync(path.join(tmp, 'dom', 'root.telemetry.json'), JSON.stringify(telemetry), 'utf8');

    const manifest: DesignAuditManifest = {
      runId: 'test-run',
      sealedAtUtc: '2026-11-28T00:00:00.000Z',
      baseUrl: 'http://127.0.0.1:4173',
      mode: 'audit-only',
      deterministicRuntime: true,
      coverage: 'full',
      captureCount: 2,
      cssFiles: [],
      captures: [
        {
          id: 'root__360x800__dark__ideal',
          route: '/',
          archetype: 'editorial',
          viewport: '360x800',
          theme: 'dark',
          uiState: 'ideal',
          screenshotUri: 'screenshots/root.png',
          screenshotSha256: 'abc',
          telemetryUri: 'dom/root.telemetry.json',
        },
        {
          id: 'root__1440x900__light__reduced-motion',
          route: '/',
          archetype: 'editorial',
          viewport: '1440x900',
          theme: 'light',
          uiState: 'reduced-motion',
          screenshotUri: 'screenshots/rm.png',
          screenshotSha256: 'def',
          runningAnimationsUnderReducedMotion: 2,
        },
      ],
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    const findings = evaluateBundleDeterministic(manifest, tmp);
    const rules = findings.map((f) => f.ruleId);
    expect(rules).toContain('DA-01-LOW-ABOVE-FOLD-YIELD');
    expect(rules).toContain('DA-01-ABOVE-THE-FOLD-YIELD');
    expect(rules).toContain('DA-02-NAV-OVERFLOW');
    expect(rules).toContain('DA-10-HORIZONTAL-OVERFLOW');
    expect(rules).toContain('DA-10-H1-TRUNCATED');
    expect(rules).toContain('DA-10-PINCH-ZOOM-DISABLED');
    expect(rules).toContain('DA-10-TOUCH-TARGET-BELOW-24PX');
    expect(rules).toContain('DA-07-FOCUS-OCCLUDED');
    expect(rules).toContain('DA-07-FOCUS-INDICATOR-MISSING');
    expect(rules).toContain('DA-05-TEXT-SPACING-CLIP');
    expect(rules).toContain('DA-09-CONTRAST-BELOW-FLOOR');
    expect(rules).toContain('DA-09-DARK-HALATION');
    expect(rules).toContain('DA-12-REDUCED-MOTION-ACTIVE');

    // Add a VLM finding on the same target to verify deterministic supersession & SARIF baseline ratchet
    const vlmDuplicate: DesignAuditFinding = {
      ...findings[0]!,
      provenance: 'vlm-reference-anchored',
      message: 'VLM duplicate should be superseded',
    };
    const vlmUnique: DesignAuditFinding = {
      ...findings[0]!,
      ruleId: 'DA-04-VLM-SQUINT',
      metricId: '04',
      pillar: 'II',
      provenance: 'vlm-reference-anchored',
      severity: 'warning',
      message: 'Squint hierarchy note',
    };
    expect(dedupeFindings([vlmDuplicate, findings[0]!]).length).toBe(1);
    expect(dedupeFindings([vlmDuplicate, findings[0]!])[0]!.provenance).toBe('deterministic');

    fs.writeFileSync(path.join(tmp, 'track-b-findings.json'), JSON.stringify([vlmUnique]), 'utf8');
    const firstSarif = emitSarifAndDossier({ bundleDir: tmp });
    expect(firstSarif.ok).toBe(false);
    expect(firstSarif.newBlockingRegressions).toBeGreaterThan(0);
    expect(fs.existsSync(firstSarif.sarifPath)).toBe(true);
    expect(fs.existsSync(firstSarif.dossierPath)).toBe(true);

    // Re-run using first SARIF as baseline -> 0 new regressions
    const secondSarif = emitSarifAndDossier({
      bundleDir: tmp,
      baselinePath: firstSarif.sarifPath,
    });
    expect(secondSarif.newBlockingRegressions).toBe(0);
  });

  it('runs capture matrix with injectable browser and degrades gracefully on launch failure', async () => {
    const tmp = await makeTempDir('kinloom-da-cap-');
    expect(slugifyRoute('/')).toBe('root');
    expect(slugifyRoute('/person/abraham-lincoln')).toBe('person_abraham-lincoln');

    const fakeBrowser: DesignAuditBrowser = {
      newContext: async () => ({
        newPage: async (): Promise<DesignAuditBrowserPage> => ({
          emulateMedia: async () => undefined,
          route: async () => undefined,
          goto: async () => undefined,
          waitForTimeout: async () => undefined,
          addStyleTag: async () => undefined,
          keyboard: { press: async () => undefined },
          screenshot: async (opts) => {
            fs.writeFileSync(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          },
          evaluate: async <T = unknown>(expr: string | ((...args: never[]) => T)): Promise<T> => {
            const s = String(expr);
            if (s.includes('aboveFoldMainRatio')) {
              return {
                viewport: '1440x900',
                docOverflowX: 0,
                aboveFoldMainRatio: 0.72,
                aboveFoldChromeRatio: 0.12,
                navLinkCount: 5,
                title: 'Kinloom',
                h1Text: 'Archive',
                h1Truncated: false,
                h1Rect: [20, 80, 200, 36],
                viewportMeta: 'width=device-width, initial-scale=1',
                interactives: [],
                textSamples: [],
                stylesheets: [{ href: 'inline', cssText: 'body { color: #23272e; font-size: 16px; }' }],
              } as T;
            }
            if (s.includes('getAnimations') && s.includes('playState')) {
              return 0 as T;
            }
            if (s.includes('sticky') || s.includes('overflowY')) {
              return [] as T;
            }
            return null as T;
          },
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    };

    const plan: DesignAuditPlan = {
      runId: 'cap-test',
      baseUrl: 'http://127.0.0.1:4173',
      mode: 'audit-only',
      themes: ['light'],
      routes: [{ path: '/', archetype: 'editorial', uiStates: ['ideal'] }],
    };

    const manifest = await runDesignAuditCaptureMatrix({
      plan,
      bundleDir: tmp,
      browserFactory: async () => fakeBrowser,
    });
    expect(manifest.deterministicRuntime).toBe(true);
    expect(manifest.captureCount).toBe(5); // 4 viewports + 1 reduced-motion
    expect(manifest.cssFiles).toHaveLength(1);

    // Graceful degradation when browser factory throws
    const degradedOut = path.join(tmp, 'degraded');
    const degraded = await runDesignAuditCommand({
      url: 'http://127.0.0.1:4173',
      outDir: degradedOut,
      repoRoot: tmp,
      browserFactory: async () => {
        throw new Error('Chromium unavailable');
      },
    });
    expect(degraded.deterministicRuntime).toBe(false);
    expect(degraded.coverage).toBe('partial');
    expect(degraded.degradedReason).toContain('Chromium unavailable');
  });
});

describe('kinloom design-audit CLI subcommand dispatch', () => {
  it('supports help, guide, archetypes, standards, init, css, static-only run, and sarif', async () => {
    const tmp = await makeTempDir('kinloom-da-cli-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'calls.jsonl');

    const helpCap = createCaptureIo();
    expect(await runCli(['design-audit', '--help'], { io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stdout.join('\n')).toContain('Usage: kinloom design-audit');

    const guideCap = createCaptureIo();
    expect(await runCli(['design-audit', '--guide'], { io: guideCap.io })).toBe(EXIT_OK);
    expect(guideCap.stdout.join('\n')).toContain('# Design Audit');

    const archCap = createCaptureIo();
    expect(
      await runCli(['design-audit', 'archetypes', '--archetype', 'editorial', '--json'], { io: archCap.io })
    ).toBe(EXIT_OK);
    expect(JSON.parse(archCap.stdout.join('\n')).archetype.id).toBe('editorial');

    const stdCap = createCaptureIo();
    expect(await runCli(['design-audit', 'standards', '--json'], { io: stdCap.io })).toBe(EXIT_OK);
    expect(JSON.parse(stdCap.stdout.join('\n')).ok).toBe(true);

    const planPath = path.join(tmp, 'plan.json');
    const initCap = createCaptureIo();
    expect(
      await runCli(
        ['design-audit', 'init', '--out', planPath, '--url', 'http://127.0.0.1:4173', '--routes', '/,/tree'],
        { io: initCap.io, cwd: tmp }
      )
    ).toBe(EXIT_OK);
    expect(fs.existsSync(planPath)).toBe(true);
    expect(() => initDesignAuditPlan({ outPath: planPath })).toThrow(/already exists/);

    const bundleDir = path.join(tmp, 'bundle');
    const runCap = createCaptureIo();
    expect(
      await runCli(['design-audit', '--static-only', '--repo', tmp, '--out-dir', bundleDir, '--json'], {
        io: runCap.io,
        cwd: tmp,
      })
    ).toBe(EXIT_OK);
    const parsedRun = JSON.parse(runCap.stdout.join('\n'));
    expect(parsedRun.mode).toBe('static-degraded');
    expect(fs.existsSync(parsedRun.sarifPath)).toBe(true);

    const cssCap = createCaptureIo();
    expect(await runCli(['design-audit', 'css', '--repo', tmp], { io: cssCap.io, cwd: tmp })).toBe(EXIT_OK);

    const sarifCap = createCaptureIo();
    expect(
      await runCli(['design-audit', 'sarif', '--bundle', bundleDir], { io: sarifCap.io, cwd: tmp })
    ).toBe(EXIT_OK);

    const badSub = createCaptureIo();
    expect(await runCli(['design-audit', 'nope'], { io: badSub.io, cwd: tmp })).toBe(EXIT_USAGE);

    const missingBundle = createCaptureIo();
    expect(await runCli(['design-audit', 'sarif'], { io: missingBundle.io, cwd: tmp })).toBe(EXIT_USAGE);

    const badTheme = createCaptureIo();
    expect(
      await runCli(['design-audit', '--static-only', '--themes', 'sepia'], { io: badTheme.io, cwd: tmp })
    ).toBe(EXIT_USAGE);
    expect(EXIT_ERROR).toBe(1);
  });

  it('exercises UI Stack route interceptors, focus occlusion trace, plan-based runs, and text/fail-on-error CLI paths', async () => {
    const tmp = await makeTempDir('kinloom-da-branches-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'calls.jsonl');

    const fulfilledStatuses: number[] = [];
    const fakeBrowser: DesignAuditBrowser = {
      newContext: async () => ({
        newPage: async (): Promise<DesignAuditBrowserPage> => ({
          emulateMedia: async () => undefined,
          route: async (_pattern, handler) => {
            await handler({
              fulfill: async (opts) => {
                fulfilledStatuses.push(opts.status);
              },
              continue: async () => undefined,
            });
          },
          goto: async () => {
            throw new Error('simulated slow load');
          },
          waitForTimeout: async () => undefined,
          addStyleTag: async () => undefined,
          keyboard: { press: async () => undefined },
          screenshot: async (opts) => {
            fs.writeFileSync(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          },
          evaluate: async <T = unknown>(expr: string | ((...args: never[]) => T)): Promise<T> => {
            const code = String(expr);
            if (code.includes('aboveFoldMainRatio')) {
              return {
                viewport: '360x800',
                docOverflowX: 0,
                aboveFoldMainRatio: 0.8,
                aboveFoldChromeRatio: 0.1,
                navLinkCount: 4,
                title: 'Kinloom',
                h1Text: 'Archive',
                h1Truncated: false,
                h1Rect: [10, 60, 200, 32],
                viewportMeta: 'width=device-width, initial-scale=1',
                interactives: [],
                textSamples: [],
                stylesheets: [{ href: 'main.css', cssText: 'body { color: #23272e; font-size: 16px; }' }],
              } as T;
            }
            if (code.includes('document.activeElement')) {
              expect(code).toContain('candidate.contains(el)');
              return {
                tag: 'a',
                text: 'Nav Link',
                rect: [10, 10, 100, 44],
                outlineStyle: 'none',
                boxShadow: 'none',
                occluders: ['header'],
              } as T;
            }
            if (code.includes('overflowY')) {
              return [{ tag: 'p', text: 'Clipped', rect: [10, 100, 120, 20] }] as T;
            }
            if (code.includes('getAnimations') && code.includes('playState')) {
              return 1 as T;
            }
            return null as T;
          },
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    };

    const planPath = path.join(tmp, 'plan.json');
    const badTokenPath = path.join(tmp, 'bad.tokens.json');
    fs.writeFileSync(badTokenPath, '{ invalid', 'utf8');

    const plan: DesignAuditPlan = {
      runId: 'branch-run',
      baseUrl: 'http://127.0.0.1:4173',
      mode: 'audit-only',
      repoRoot: tmp,
      themes: ['light', 'dark', 'more-contrast'],
      tokenPaths: [badTokenPath],
      routes: [
        {
          path: '/places',
          archetype: 'editorial',
          apiInterceptPattern: '**/api/**',
          uiStates: ['ideal', 'loading', 'empty-first', 'partial', 'error'],
        },
      ],
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    const runResult = await runDesignAuditCommand({
      planPath,
      outDir: path.join(tmp, 'bundle'),
      failOnError: true,
      loadingDelayMs: 0,
      browserFactory: async () => fakeBrowser,
    });
    expect(runResult.ok).toBe(false);
    expect(fulfilledStatuses).toContain(500);
    expect(fulfilledStatuses).toContain(200);
    expect(runResult.rendered).toContain('Design Audit (branch-run)');

    // Exercise non-JSON text outputs & fail-on-error exit codes in CLI handler
    const archAll = createCaptureIo();
    expect(await runCli(['design-audit', 'archetypes'], { io: archAll.io })).toBe(EXIT_OK);
    expect(archAll.stdout.join('\n')).toContain('editorial');

    const archOne = createCaptureIo();
    expect(await runCli(['design-audit', 'archetypes', '--archetype', 'saas'], { io: archOne.io })).toBe(
      EXIT_OK
    );
    expect(archOne.stdout.join('\n')).toContain('saas');

    const stdText = createCaptureIo();
    expect(await runCli(['design-audit', 'standards'], { io: stdText.io })).toBe(EXIT_OK);
    expect(stdText.stdout.join('\n')).toContain('WCAG 2.2');

    const cssFail = createCaptureIo();
    expect(
      await runCli(
        ['design-audit', 'css', '--bundle', path.join(tmp, 'bundle'), '--repo', tmp, '--fail-on-error'],
        { io: cssFail.io, cwd: tmp }
      )
    ).toBe(EXIT_ERROR);

    const sarifFail = createCaptureIo();
    expect(
      await runCli(
        ['design-audit', 'sarif', '--bundle', path.join(tmp, 'bundle'), '--fail-on-error', '--json'],
        { io: sarifFail.io, cwd: tmp }
      )
    ).toBe(EXIT_ERROR);

    const badState = createCaptureIo();
    expect(
      await runCli(['design-audit', '--static-only', '--states', 'bogus'], { io: badState.io, cwd: tmp })
    ).toBe(EXIT_USAGE);

    const missingPlan = createCaptureIo();
    expect(
      await runCli(['design-audit', '--plan', path.join(tmp, 'nope.json')], { io: missingPlan.io, cwd: tmp })
    ).toBe(EXIT_USAGE);
  });

  it('covers clean telemetry, empty SARIF dossier, phase-3b override, APCA low-clip, and CLI theme/state flags', async () => {
    const tmp = await makeTempDir('kinloom-da-edge-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'calls.jsonl');

    // APCA low-clip both polarities & default archetype
    expect(parseCssRgbTuple(undefined)).toBeNull();
    expect(isPlaywrightLauncher(null)).toBe(false);
    expect(isPlaywrightLauncher({ chromium: { launch: () => null } })).toBe(true);
    expect(calcApcaLc([120, 120, 120], [126, 126, 126])).toBe(0);
    expect(calcApcaLc([126, 126, 126], [120, 120, 120])).toBe(0);
    expect(resolveDesignAuditArchetype(undefined).id).toBe('editorial');

    // Empty SARIF & Executive Dossier (0 findings) + phase-3b-findings override + note severity
    const emptyDir = path.join(tmp, 'empty');
    const emptySarif = emitSarifAndDossier({ bundleDir: emptyDir });
    expect(emptySarif.ok).toBe(true);
    expect(fs.readFileSync(emptySarif.dossierPath, 'utf8')).toContain('No blocking errors or warnings');

    const p3bDir = path.join(tmp, 'p3b');
    fs.mkdirSync(p3bDir, { recursive: true });
    const noteFinding: DesignAuditFinding = {
      ruleId: 'DA-08-NOTE',
      metricId: '08',
      pillar: 'III',
      provenance: 'code-translated',
      severity: 'note',
      confidence: 0.9,
      route: '/',
      viewport: '1440x900',
      theme: 'light',
      uiState: 'ideal',
      message: 'Informational spacing note',
      physicalLocation: { uri: 'styles.css', startLine: 12, selector: '.card' },
      evidence: { screenshotUri: 'screenshots/root.png', pairwiseVerdict: 'tie' },
      masterCitations: ['Kengo Kuma'],
    };
    fs.writeFileSync(path.join(p3bDir, 'phase-3b-findings.json'), JSON.stringify([noteFinding]), 'utf8');
    const p3bSarif = emitSarifAndDossier({ bundleDir: p3bDir });
    expect(p3bSarif.notes).toBe(1);
    expect(p3bSarif.ok).toBe(true);

    // Deterministic evaluator with clean telemetry & missing telemetry file
    const detDir = path.join(tmp, 'det-clean');
    fs.mkdirSync(path.join(detDir, 'dom'), { recursive: true });
    const cleanTel: DesignAuditTelemetry = {
      viewport: '1440x900',
      docOverflowX: 0,
      aboveFoldMainRatio: 0.75,
      aboveFoldChromeRatio: 0.1,
      navLinkCount: 5,
      title: 'Clean',
      h1Text: 'Clean Heading',
      h1Truncated: false,
      h1Rect: [0, 0, 200, 32],
      viewportMeta: 'width=device-width, initial-scale=1',
      interactives: [
        {
          tag: 'button',
          role: 'button',
          text: 'OK',
          rect: [0, 0, 48, 48],
          visible: true,
          touchAction: 'manipulation',
          pointerEvents: 'auto',
        },
      ],
      textSamples: [
        {
          tag: 'p',
          text: 'Readable text',
          fontSizePx: 16,
          fontWeight: 400,
          fontStyle: 'normal',
          lineHeight: '24px',
          textDecorationLine: 'none',
          textTransform: 'none',
          fontFamily: 'serif',
          color: 'rgb(20, 20, 20)',
          backgroundColor: 'rgb(250, 250, 250)',
          rect: [0, 0, 200, 24],
        },
        {
          tag: 'span',
          text: 'Unparseable color ignored',
          fontSizePx: 16,
          fontWeight: 400,
          fontStyle: 'normal',
          lineHeight: '24px',
          textDecorationLine: 'none',
          textTransform: 'none',
          fontFamily: 'serif',
          color: 'inherit',
          backgroundColor: 'transparent',
          rect: [0, 0, 100, 24],
        },
      ],
    };
    fs.writeFileSync(path.join(detDir, 'dom', 'clean.telemetry.json'), JSON.stringify(cleanTel), 'utf8');
    const cleanManifest: DesignAuditManifest = {
      runId: 'clean-run',
      sealedAtUtc: '2026-11-28T00:00:00.000Z',
      baseUrl: 'http://127.0.0.1:4173',
      mode: 'audit-only',
      deterministicRuntime: true,
      coverage: 'full',
      captureCount: 3,
      cssFiles: [],
      captures: [
        {
          id: 'clean',
          route: '/',
          archetype: 'editorial',
          viewport: '1440x900',
          theme: 'light',
          uiState: 'ideal',
          screenshotUri: 'screenshots/clean.png',
          screenshotSha256: 'aaa',
          telemetryUri: 'dom/clean.telemetry.json',
        },
        {
          id: 'missing-tel',
          route: '/',
          archetype: 'editorial',
          viewport: '1440x900',
          theme: 'light',
          uiState: 'ideal',
          screenshotUri: 'screenshots/missing.png',
          screenshotSha256: 'bbb',
          telemetryUri: 'dom/does-not-exist.json',
        },
        {
          id: 'no-tel',
          route: '/',
          archetype: 'editorial',
          viewport: '1440x900',
          theme: 'light',
          uiState: 'reduced-motion',
          screenshotUri: 'screenshots/rm.png',
          screenshotSha256: 'ccc',
          runningAnimationsUnderReducedMotion: 0,
        },
      ],
    };
    expect(evaluateBundleDeterministic(cleanManifest, detDir)).toEqual([]);

    // CLI paths: archetypes --json (all), init --force --json --archetype saas, run with valid --themes & --states, css --css --tokens --json
    const archAllJson = createCaptureIo();
    expect(await runCli(['design-audit', 'archetypes', '--json'], { io: archAllJson.io })).toBe(EXIT_OK);
    expect(JSON.parse(archAllJson.stdout.join('\n')).archetypes.editorial.id).toBe('editorial');

    const planPath = path.join(tmp, 'p.json');
    const init1 = createCaptureIo();
    expect(
      await runCli(['design-audit', 'init', '--out', planPath, '--archetype', 'saas', '--json'], {
        io: init1.io,
        cwd: tmp,
      })
    ).toBe(EXIT_OK);
    const init2 = createCaptureIo();
    expect(
      await runCli(['design-audit', 'init', '--out', planPath, '--force', '--routes', 'tree'], {
        io: init2.io,
        cwd: tmp,
      })
    ).toBe(EXIT_OK);

    const cssFile = path.join(tmp, 'one.css');
    const tokFile = path.join(tmp, 'valid.resolver.json');
    fs.writeFileSync(cssFile, 'body { color: #23272e; font-size: 16px; }', 'utf8');
    fs.writeFileSync(tokFile, JSON.stringify({ resolutionOrder: [] }), 'utf8');
    const cssCap = createCaptureIo();
    expect(
      await runCli(
        ['design-audit', 'css', '--css', cssFile, '--tokens', tokFile, '--archetype', 'saas', '--json'],
        { io: cssCap.io, cwd: tmp }
      )
    ).toBe(EXIT_OK);
    expect(JSON.parse(cssCap.stdout.join('\n')).ok).toBe(true);

    const runCap = createCaptureIo();
    expect(
      await runCli(
        [
          'design-audit',
          'run',
          '--static-only',
          '--archetype',
          'mobile-app',
          '--routes',
          '/,/tree',
          '--themes',
          'light,dark,light',
          '--states',
          'ideal,error,ideal',
          '--css',
          cssFile,
          '--tokens',
          tokFile,
          '--out-dir',
          path.join(tmp, 'out-static'),
        ],
        { io: runCap.io, cwd: tmp }
      )
    ).toBe(EXIT_OK);
    expect(runCap.stdout.join('\n')).toContain('static-degraded');

    // Minimal page without optional route/keyboard/emulateMedia/addStyleTag hooks
    const evaluatedExprs: string[] = [];
    const minimalBrowser: DesignAuditBrowser = {
      newContext: async () => ({
        newPage: async (): Promise<DesignAuditBrowserPage> => ({
          goto: async () => undefined,
          screenshot: async (opts) => {
            fs.writeFileSync(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
          },
          evaluate: async <T = unknown>(expr: string | ((...args: never[]) => T)): Promise<T> => {
            const code = String(expr);
            evaluatedExprs.push(code);
            if (code.includes('aboveFoldMainRatio')) {
              return {
                viewport: '1440x900',
                docOverflowX: 0,
                aboveFoldMainRatio: 0.7,
                aboveFoldChromeRatio: 0.1,
                navLinkCount: 3,
                title: 'Min',
                h1Text: 'Min',
                h1Truncated: false,
                h1Rect: null,
                viewportMeta: '',
                interactives: [],
                textSamples: [],
              } as T;
            }
            if (code.includes('overflowY')) {
              return [] as T;
            }
            return 0 as T;
          },
        }),
        close: async () => undefined,
      }),
      close: async () => undefined,
    };
    const minManifest = await runDesignAuditCaptureMatrix({
      plan: {
        runId: 'min-run',
        baseUrl: 'http://127.0.0.1:4173',
        mode: 'audit-only',
        routes: [{ path: '/min', archetype: 'mobile-app' }],
      },
      bundleDir: path.join(tmp, 'min-bundle'),
      browserFactory: async () => minimalBrowser,
    });
    expect(minManifest.captureCount).toBe(6);
    expect(evaluatedExprs.some((expr) => expr.includes("removeItem('kinloom-theme')"))).toBe(true);
    expect(evaluatedExprs.some((expr) => expr.includes("removeItem('kinloom:theme')"))).toBe(false);

    // Cover auto-degrade when no --url is given, plus skipDirs & nonexistent dir in discoverRepoStyleFiles
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'ignored.css'), 'a { color: #000; }', 'utf8');
    const noUrlRun = await runDesignAuditCommand({
      outDir: path.join(tmp, 'no-url-out'),
      repoRoot: tmp,
      json: true,
    });
    expect(noUrlRun.mode).toBe('static-degraded');
    expect(noUrlRun.degradedReason).toContain('no --url');
    const emptyCssRes = auditTokensAndCss({ repoRoot: path.join(tmp, 'does-not-exist'), writeOutput: false });
    expect(emptyCssRes.cssStats).toBeNull();
  });
});

function makeMockD1Wrangler(sqlLog: string[]): WranglerExecutor {
  return async (_bin, args) => {
    const sql = args[args.indexOf('--command') + 1] ?? '';
    sqlLog.push(sql);
    if (sql.startsWith('SELECT COUNT(*) AS count FROM agent_tokens')) {
      return { stdout: JSON.stringify([{ success: true, results: [{ count: 1 }] }]), stderr: '' };
    }
    if (sql.includes('DELETE FROM')) {
      const inviteDeletes = (sql.match(/DELETE FROM invites/g) ?? []).length;
      const statements: Array<{ success: true; results: Array<Record<string, unknown>> }> = [];
      for (let i = 0; i < inviteDeletes; i += 1) {
        statements.push({ success: true, results: [] });
      }
      statements.push({ success: true, results: [{ count: 1 }] });
      if (inviteDeletes > 0) {
        statements.push({ success: true, results: [{ count: 0 }] });
      }
      return { stdout: JSON.stringify(statements), stderr: '' };
    }
    return { stdout: JSON.stringify([{ success: true, results: [] }]), stderr: '' };
  };
}

describe('design-audit Issue #115 auth modes, --auto-routes discovery, and fold/halation telemetry', () => {
  it('discovers core routes, deceased-only person, place, and enabled plugin routes from /api/bundle with graceful fallback', async () => {
    expect(DESIGN_AUDIT_CORE_ROUTES).toEqual([
      '/',
      '/places',
      '/evidence',
      '/time',
      '/tree',
      '/map',
      '/kinship',
      '/changes',
    ]);
    expect(mergeUniqueRoutes(['/', '/tree'], ['/tree', 'map', '/'])).toEqual(['/', '/tree', '/map']);

    expect(extractEnabledPluginRoutesFromBundle(null)).toEqual([]);
    expect(
      extractEnabledPluginRoutesFromBundle({
        plugins: [
          'recipes',
          { id: 'open-finance', enabled: true },
          { id: 'disabled-plugin', enabled: false, route: '/hidden' },
          { id: 'custom-ext', route: '/stories' },
          { id: 'bad-core', path: '/tree' },
          { id: 'bad-api', path: '/api/secret' },
          { id: 'bad-url', path: 'http://evil.example/x' },
          '',
          123,
        ],
        meta: {
          enabled_plugins: ['support'],
          pluginRoutes: ['/chronicle', '/api/ignore', '/invite/secret', '/media/x', '/data/x'],
          extensions: {
            recipes: { enabled: true },
            disabled_ext: false,
            disabled_obj: { enabled: false, route: '/nope' },
            custom_map: { enabled: true, navPath: '/oral-history' },
            null_entry: null,
          },
        },
      })
    ).toEqual(['/recipes', '/support', '/stories', '/chronicle', '/oral-history']);

    const seenHeaders: Array<{ url: string; cookie: string | null; header: string | null }> = [];
    const fetchBundle: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      seenHeaders.push({
        url,
        cookie: headers.get('cookie'),
        header: headers.get('x-archive-test'),
      });
      if (url === 'https://archive.example/api/bundle') {
        return new Response(
          JSON.stringify({
            people: [
              { id: 'p_live_1', slug: 'living-person', full_name: 'Private Living', is_living: true },
              { id: 'p_live_2', slug: 'living-flag', full_name: 'Flagged Living', living: true },
              { id: 'p_live_3', slug: 'eff-living', full_name: 'Effective Living', effective_living: true },
              { id: 'p_live_4', slug: 'redacted-one', full_name: 'Living', is_living: false },
              { id: 'p_live_5', slug: 'living', full_name: 'Slug Living', is_living: false },
              {
                id: 'p_dec_1',
                slug: 'ada-lovelace',
                full_name: 'Ada Lovelace',
                is_living: false,
                event_count: 8,
              },
            ],
            places: [{ id: 'pl_1', slug: 'london-england', name: 'London, England', lat: 51.5, lng: -0.12 }],
            plugins: ['recipes', { id: 'open-finance', enabled: true }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const auto = await discoverDesignAuditAutoRoutes({
      baseUrl: 'https://archive.example/',
      explicitRoutes: ['/custom-extra'],
      authCookie: '__Host-kinloom_session=sess123',
      authHeaders: { 'X-Archive-Test': 'ok' },
      fetchImpl: fetchBundle,
    });

    expect(auto.source).toBe('api-bundle');
    expect(auto.personRoute).toBe('/person/ada-lovelace');
    expect(auto.placeRoute).toBe('/place/london-england');
    expect(auto.pluginRoutes).toEqual(['/recipes', '/support']);
    expect(auto.routes).toEqual([
      '/',
      '/places',
      '/evidence',
      '/time',
      '/tree',
      '/map',
      '/kinship',
      '/changes',
      '/person/ada-lovelace',
      '/place/london-england',
      '/recipes',
      '/support',
      '/custom-extra',
    ]);
    expect(auto.routes.some((r) => r.includes('living'))).toBe(false);
    expect(seenHeaders[0]).toEqual({
      url: 'https://archive.example/api/bundle',
      cookie: '__Host-kinloom_session=sess123',
      header: 'ok',
    });

    // Graceful fallback when /api/bundle returns 401
    const unauthFetch: typeof fetch = async () => new Response('unauthorized', { status: 401 });
    const fallbackDefault = await discoverDesignAuditAutoRoutes({
      baseUrl: 'https://archive.example',
      fetchImpl: unauthFetch,
    });
    expect(fallbackDefault.source).toBe('none');
    expect(fallbackDefault.routes).toEqual(['/']);
    expect(fallbackDefault.fallbackReason).toContain('/api/bundle');

    const fallbackExplicit = await discoverDesignAuditAutoRoutes({
      baseUrl: 'https://archive.example',
      explicitRoutes: ['/places'],
      fetchImpl: unauthFetch,
    });
    expect(fallbackExplicit.routes).toEqual(['/places']);

    // Empty bundle with zero deceased people and zero places returns only core routes
    const emptyBundleFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          people: [{ id: 'p_l', slug: 'l', full_name: 'Living', is_living: true }],
          places: [],
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }
      );
    const emptyAuto = await discoverDesignAuditAutoRoutes({
      baseUrl: 'https://archive.example',
      fetchImpl: emptyBundleFetch,
    });
    expect(emptyAuto.source).toBe('api-bundle');
    expect(emptyAuto.personRoute).toBeNull();
    expect(emptyAuto.placeRoute).toBeNull();
    expect(emptyAuto.routes).toEqual([...DESIGN_AUDIT_CORE_ROUTES]);
  });

  it('supports --invite-token redemption, --with-temp-auth + --auto-routes, live DOM plugin nav discovery, and auth validation', async () => {
    const tmp = await makeTempDir('kinloom-da-115-auth-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'calls.jsonl');
    fs.writeFileSync(
      path.join(tmp, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [{ database_name: 'alder-db' }],
        routes: [{ pattern: 'alder.example.org/*' }],
      }),
      'utf8'
    );

    const visitedRoutes: string[] = [];
    const seenContextCookies: Array<{ name: string; value: string; url: string }> = [];
    const seenContextHeaders: Array<Readonly<Record<string, string>> | undefined> = [];

    const makeAuthBrowser = (): DesignAuditBrowser => ({
      newContext: async (opts) => {
        seenContextHeaders.push(opts.extraHTTPHeaders);
        return {
          addCookies: async (cookies) => {
            seenContextCookies.push(...cookies);
          },
          newPage: async (): Promise<DesignAuditBrowserPage> => {
            let currentPath = '/';
            return {
              emulateMedia: async () => undefined,
              goto: async (url) => {
                currentPath = new URL(url).pathname;
                visitedRoutes.push(currentPath);
              },
              waitForTimeout: async () => undefined,
              addStyleTag: async () => undefined,
              screenshot: async (opts) => {
                fs.writeFileSync(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
              },
              evaluate: async <T = unknown>(expr: string | ((...args: never[]) => T)): Promise<T> => {
                const src = String(expr);
                if (src.includes('aboveFoldMainRatio')) {
                  return {
                    viewport: '1440x900',
                    docOverflowX: 0,
                    aboveFoldMainRatio: 0.72,
                    aboveFoldChromeRatio: 0.12,
                    aboveFoldContentYieldRatio: 0.8571,
                    firstContentY: currentPath === '/recipes' ? 410 : 120,
                    firstContentSelector: currentPath === '/recipes' ? 'article.recipe-card' : 'main h1',
                    navLinkCount: 5,
                    title: 'Alder Archive',
                    h1Text: 'Alder Archive',
                    h1Truncated: false,
                    h1Rect: [24, 96, 300, 42],
                    viewportMeta: 'width=device-width, initial-scale=1',
                    interactives: [],
                    textSamples: [],
                    displayTextSamples:
                      currentPath === '/recipes'
                        ? [
                            {
                              tag: 'div',
                              text: 'Bright White Hero Display',
                              fontSizePx: 36,
                              fontWeight: 700,
                              color: 'rgb(255, 255, 255)',
                              backgroundColor: 'rgb(12, 12, 12)',
                              rect: [24, 410, 400, 44],
                            },
                          ]
                        : [],
                    stylesheets: [],
                    navLinks:
                      currentPath === '/'
                        ? [
                            { href: '/places', text: 'Places' },
                            { href: '/recipes', text: 'Recipes' },
                            { href: '/support', text: 'Support' },
                          ]
                        : [],
                  } as T;
                }
                if (src.includes('playState')) {
                  return 0 as T;
                }
                return [] as T;
              },
            };
          },
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    });

    const redeemedUrls: string[] = [];
    const bundleAuthCookies: Array<string | null> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/auth/invite/')) {
        redeemedUrls.push(url);
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': '__Host-kinloom_session=redeemed_sess_115; Path=/; HttpOnly; Secure',
          },
        });
      }
      if (url.endsWith('/api/bundle')) {
        bundleAuthCookies.push(new Headers(init?.headers).get('cookie'));
        return new Response(
          JSON.stringify({
            people: [
              { id: 'p1', slug: 'living-skip', full_name: 'Living Person', is_living: true },
              { id: 'p2', slug: 'grace-hopper', full_name: 'Grace Hopper', is_living: false },
            ],
            places: [{ id: 'pl1', slug: 'new-york-ny', name: 'New York, NY' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('not found', { status: 404 });
    };

    // 1. --invite-token + --auto-routes (with live DOM nav plugin discovery for /recipes & /support)
    const inviteOut = path.join(tmp, 'invite-out');
    const inviteRun = await runDesignAuditCommand({
      url: 'https://alder.example.org',
      outDir: inviteOut,
      repoRoot: tmp,
      archetype: 'mobile-app',
      themes: ['dark'],
      inviteToken: 'inv_viewer_secret_115',
      authHeaders: { 'X-Audit-Client': 'issue-115' },
      autoRoutes: true,
      fetchImpl,
      browserFactory: async () => makeAuthBrowser(),
    });

    expect(inviteRun.deterministicRuntime).toBe(true);
    expect(redeemedUrls).toEqual(['https://alder.example.org/api/auth/invite/inv_viewer_secret_115']);
    expect(bundleAuthCookies).toEqual(['__Host-kinloom_session=redeemed_sess_115']);
    expect(seenContextCookies.every((c) => c.value === 'redeemed_sess_115')).toBe(true);
    expect(seenContextHeaders.every((h) => h?.['X-Audit-Client'] === 'issue-115')).toBe(true);
    expect(inviteRun.discoveredRoutes).toContain('/person/grace-hopper');
    expect(inviteRun.discoveredRoutes).toContain('/place/new-york-ny');
    expect(inviteRun.discoveredRoutes).toContain('/recipes');
    expect(inviteRun.discoveredRoutes).toContain('/support');
    expect(inviteRun.discoveredRoutes).not.toContain('/person/living-skip');
    expect(inviteRun.rendered).toContain('Routes:');
    expect(inviteRun.rendered).not.toContain('inv_viewer_secret_115');
    expect(inviteRun.rendered).not.toContain('redeemed_sess_115');
    expect(fs.readFileSync(path.join(inviteOut, 'plan.json'), 'utf8')).not.toContain('redeemed_sess_115');

    const detFindings = JSON.parse(
      fs.readFileSync(path.join(inviteOut, 'track-a-deterministic.json'), 'utf8')
    ) as DesignAuditFinding[];
    const detRules = detFindings.map((f) => f.ruleId);
    expect(detRules).toContain('DA-01-ABOVE-THE-FOLD-YIELD');
    expect(detRules).toContain('DA-09-DARK-HALATION');
    const sarifRaw = JSON.parse(fs.readFileSync(inviteRun.sarifPath, 'utf8')) as {
      runs: Array<{ results: Array<{ ruleId: string }> }>;
    };
    const sarifRuleIds = sarifRaw.runs.flatMap((r) => r.results.map((res) => res.ruleId));
    expect(sarifRuleIds).toContain('DA-01-ABOVE-THE-FOLD-YIELD');
    expect(sarifRuleIds).toContain('DA-09-DARK-HALATION');

    // 2. --with-temp-auth + --auto-routes end-to-end with guaranteed D1 cleanup
    const sqlLog: string[] = [];
    const execWrangler = makeMockD1Wrangler(sqlLog);
    const tempAuthRun = await runDesignAuditCommand({
      repoRoot: tmp,
      outDir: path.join(tmp, 'temp-auth-out'),
      archetype: 'mobile-app',
      themes: ['light'],
      withTempAuth: true,
      autoRoutes: true,
      fetchImpl,
      execWrangler,
      browserFactory: async () => makeAuthBrowser(),
    });
    expect(tempAuthRun.deterministicRuntime).toBe(true);
    expect(tempAuthRun.discoveredRoutes).toContain('/person/grace-hopper');
    expect(sqlLog.some((s) => s.includes('INSERT INTO invites'))).toBe(true);
    expect(sqlLog.some((s) => s.includes('DELETE FROM invites'))).toBe(true);

    // 3. --plan + --auto-routes + --invite-token (resolves baseUrl from plan.json)
    const planPath = path.join(tmp, 'existing-plan.json');
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        runId: 'plan-auto-run',
        baseUrl: 'https://alder.example.org',
        mode: 'audit-only',
        repoRoot: tmp,
        themes: ['light'],
        routes: [{ path: '/custom-from-plan', archetype: 'mobile-app', uiStates: ['ideal'] }],
      }),
      'utf8'
    );
    const planAutoRun = await runDesignAuditCommand({
      planPath,
      outDir: path.join(tmp, 'plan-auto-out'),
      inviteToken: 'inv_plan_token',
      autoRoutes: true,
      fetchImpl,
      browserFactory: async () => makeAuthBrowser(),
    });
    expect(planAutoRun.discoveredRoutes).toContain('/custom-from-plan');
    expect(planAutoRun.discoveredRoutes).toContain('/person/grace-hopper');

    // 4. CLI init --auto-routes --invite-token
    const autoPlanOut = path.join(tmp, 'auto-init.plan.json');
    const initIo = createCaptureIo();
    expect(
      await runCli(
        [
          'design-audit',
          'init',
          '--out',
          autoPlanOut,
          '--url',
          'https://alder.example.org',
          '--invite-token',
          'inv_init_tok',
          '--auto-routes',
          '--json',
        ],
        { cwd: tmp, io: initIo.io, fetchImpl }
      )
    ).toBe(EXIT_OK);
    const initParsed = JSON.parse(initIo.stdout.join('\n')) as { plan: DesignAuditPlan };
    expect(initParsed.plan.routes.map((r) => r.path)).toContain('/person/grace-hopper');

    // 5. Auth validation & error paths
    await expect(
      runDesignAuditCommand({
        url: 'https://alder.example.org',
        authCookie: 'kinloom_session=a',
        inviteToken: 'inv_1',
      })
    ).rejects.toThrow(/Specify at most one/);

    await expect(
      runDesignAuditCommand({
        url: 'https://alder.example.org',
        inviteToken: 'bad\ntoken',
      })
    ).rejects.toThrow(/CR or LF/);

    await expect(
      runDesignAuditCommand({
        url: 'https://alder.example.org',
        inviteToken: '   ',
      })
    ).rejects.toThrow(/must not be empty/);

    await expect(
      runDesignAuditCommand({
        inviteToken: 'inv_no_url',
      })
    ).rejects.toThrow(/requires `--url <baseUrl>` or `--plan <path>`/);

    // CLI boundary conflicts and validation
    const cliConflict = createCaptureIo();
    expect(
      await runCli(['design-audit', 'run', '--invite-token', 'inv_a', '--with-temp-auth', '--static-only'], {
        cwd: tmp,
        io: cliConflict.io,
      })
    ).toBe(EXIT_USAGE);

    const initConflict = createCaptureIo();
    expect(
      await runCli(
        [
          'design-audit',
          'init',
          '--url',
          'https://alder.example.org',
          '--auto-routes',
          '--auth-cookie',
          'k=1',
          '--invite-token',
          'inv_a',
        ],
        { cwd: tmp, io: initConflict.io }
      )
    ).toBe(EXIT_USAGE);

    const initBadInvite = createCaptureIo();
    expect(
      await runCli(
        [
          'design-audit',
          'init',
          '--url',
          'https://alder.example.org',
          '--auto-routes',
          '--invite-token',
          '   ',
        ],
        { cwd: tmp, io: initBadInvite.io }
      )
    ).toBe(EXIT_USAGE);

    const badHeaderCrLf = createCaptureIo();
    expect(
      await runCli(['design-audit', '--auth-header', 'X-Bad: val\nnext', '--static-only'], {
        cwd: tmp,
        io: badHeaderCrLf.io,
      })
    ).toBe(EXIT_USAGE);

    const badHeaderName = createCaptureIo();
    expect(
      await runCli(['design-audit', '--auth-header', 'Bad Name: val', '--static-only'], {
        cwd: tmp,
        io: badHeaderName.io,
      })
    ).toBe(EXIT_USAGE);
  });

  it('evaluates firstContentY thresholds and dark-mode displayTextSamples halation/contrast accurately across themes', async () => {
    const tmp = await makeTempDir('kinloom-da-115-probes-');
    fs.mkdirSync(path.join(tmp, 'dom'), { recursive: true });

    // Light theme + clean firstContentY + softened dark display ink -> 0 fold/halation findings
    const cleanLightTel: DesignAuditTelemetry = {
      viewport: '1440x900',
      docOverflowX: 0,
      aboveFoldMainRatio: 0.72,
      aboveFoldChromeRatio: 0.12,
      aboveFoldContentYieldRatio: 0.86,
      firstContentY: 140,
      firstContentSelector: 'main h1',
      navLinkCount: 5,
      title: 'Clean',
      h1Text: 'Archive',
      h1Truncated: false,
      h1Rect: [24, 140, 300, 40],
      viewportMeta: 'width=device-width, initial-scale=1',
      interactives: [],
      textSamples: [],
      displayTextSamples: [
        {
          tag: 'h1',
          text: 'Pure white ignored in light mode',
          fontSizePx: 36,
          fontWeight: 700,
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(0, 0, 0)',
          rect: [24, 140, 300, 40],
        },
      ],
    };

    // Dark theme with softened off-white display text (|Lc| <= 90) and low-contrast display text + bad color + duplicate
    const darkTel: DesignAuditTelemetry = {
      viewport: '1440x900',
      docOverflowX: 0,
      aboveFoldMainRatio: 0.65,
      aboveFoldChromeRatio: 0.2,
      firstContentY: 310, // exceeds saas maxFirstContentYPx (280) without yield ratio or selector
      navLinkCount: 6,
      title: 'Workbench',
      h1Text: 'Workbench',
      h1Truncated: false,
      h1Rect: [24, 310, 300, 40],
      viewportMeta: 'width=device-width, initial-scale=1',
      interactives: [],
      textSamples: [
        {
          tag: 'h1',
          text: 'Duplicate display heading',
          fontSizePx: 28,
          fontWeight: 700,
          fontStyle: 'normal',
          lineHeight: '34px',
          textDecorationLine: 'none',
          textTransform: 'none',
          fontFamily: 'serif',
          color: 'rgb(245, 245, 245)',
          backgroundColor: 'rgb(15, 15, 15)',
          rect: [24, 310, 300, 34],
        },
      ],
      displayTextSamples: [
        {
          tag: 'h1',
          text: 'Duplicate display heading',
          fontSizePx: 28,
          fontWeight: 700,
          color: 'rgb(245, 245, 245)',
          backgroundColor: 'rgb(15, 15, 15)',
          rect: [24, 310, 300, 34],
        },
        {
          tag: 'div',
          text: 'Softened dark display',
          fontSizePx: 32,
          fontWeight: 600,
          color: 'rgb(214, 210, 200)',
          backgroundColor: 'rgb(24, 26, 29)',
          rect: [24, 360, 280, 36],
        },
        {
          tag: 'div',
          text: 'Pure white worst halation',
          fontSizePx: 40,
          fontWeight: 700,
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(0, 0, 0)',
          rect: [24, 410, 340, 44],
        },
        {
          tag: 'div',
          text: 'Muddy low-contrast display',
          fontSizePx: 26,
          fontWeight: 600,
          color: 'rgb(52, 52, 52)',
          backgroundColor: 'rgb(34, 34, 34)',
          rect: [24, 470, 280, 32],
        },
        {
          tag: 'span',
          text: 'Invalid color skipped',
          fontSizePx: 28,
          fontWeight: 600,
          color: 'currentcolor',
          backgroundColor: 'transparent',
          rect: [24, 510, 120, 32],
        },
      ],
    };

    fs.writeFileSync(path.join(tmp, 'dom', 'light.telemetry.json'), JSON.stringify(cleanLightTel), 'utf8');
    fs.writeFileSync(path.join(tmp, 'dom', 'dark.telemetry.json'), JSON.stringify(darkTel), 'utf8');

    const manifest: DesignAuditManifest = {
      runId: 'probes-115',
      sealedAtUtc: '2026-11-28T00:00:00.000Z',
      baseUrl: 'http://127.0.0.1:4173',
      mode: 'audit-only',
      deterministicRuntime: true,
      coverage: 'full',
      captureCount: 2,
      cssFiles: [],
      captures: [
        {
          id: 'light',
          route: '/',
          archetype: 'editorial',
          viewport: '1440x900',
          theme: 'light',
          uiState: 'ideal',
          screenshotUri: 'screenshots/light.png',
          screenshotSha256: 'l1',
          telemetryUri: 'dom/light.telemetry.json',
        },
        {
          id: 'dark',
          route: '/workbench',
          archetype: 'saas',
          viewport: '1440x900',
          theme: 'dark',
          uiState: 'ideal',
          screenshotUri: 'screenshots/dark.png',
          screenshotSha256: 'd1',
          telemetryUri: 'dom/dark.telemetry.json',
        },
      ],
    };

    const findings = evaluateBundleDeterministic(manifest, tmp);
    expect(findings.filter((f) => f.theme === 'light')).toEqual([]);

    const foldFinding = findings.find((f) => f.ruleId === 'DA-01-ABOVE-THE-FOLD-YIELD');
    expect(foldFinding?.measuredValue).toBe(310);
    expect(foldFinding?.thresholdValue).toBe(280);

    const halationFinding = findings.find((f) => f.ruleId === 'DA-09-DARK-HALATION');
    expect(halationFinding?.message).toContain('Pure white worst halation');
    expect(Number(halationFinding?.measuredValue)).toBeGreaterThan(100);

    const contrastFinding = findings.find((f) => f.ruleId === 'DA-09-CONTRAST-BELOW-FLOOR');
    expect(contrastFinding?.message).toContain('Muddy low-contrast display');
  });
});
