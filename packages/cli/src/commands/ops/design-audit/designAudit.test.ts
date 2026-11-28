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
  type DesignAuditBrowser,
  type DesignAuditBrowserPage,
  type DesignAuditFinding,
  type DesignAuditManifest,
  type DesignAuditPlan,
  type DesignAuditTelemetry,
  dedupeFindings,
  emitSarifAndDossier,
  evaluateBundleDeterministic,
  initDesignAuditPlan,
  isPlaywrightLauncher,
  parseCssRgbTuple,
  resolveDesignAuditArchetype,
  runDesignAuditCaptureMatrix,
  runDesignAuditCommand,
  slugifyRoute,
} from '../design-audit.js';

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
    expect(rules).toContain('DA-02-NAV-OVERFLOW');
    expect(rules).toContain('DA-10-HORIZONTAL-OVERFLOW');
    expect(rules).toContain('DA-10-H1-TRUNCATED');
    expect(rules).toContain('DA-10-PINCH-ZOOM-DISABLED');
    expect(rules).toContain('DA-10-TOUCH-TARGET-BELOW-24PX');
    expect(rules).toContain('DA-07-FOCUS-OCCLUDED');
    expect(rules).toContain('DA-07-FOCUS-INDICATOR-MISSING');
    expect(rules).toContain('DA-05-TEXT-SPACING-CLIP');
    expect(rules).toContain('DA-09-CONTRAST-BELOW-FLOOR');
    expect(rules).toContain('DA-09-DARK-MODE-HALATION');
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
            if (code.includes('fixed') && code.includes('sticky')) {
              return [{ tag: 'header', rect: [0, 0, 360, 56] }] as T;
            }
            if (code.includes('document.activeElement')) {
              return {
                tag: 'a',
                text: 'Nav Link',
                rect: [10, 10, 100, 44],
                outlineStyle: 'none',
                boxShadow: 'none',
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
