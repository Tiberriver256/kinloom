import { describe, expect, it } from 'vitest';
import {
  BrowserTimeoutError,
  buildSanitizedBrowserEnv,
  launchOptionalChromium,
  type OptionalBrowser,
  type OptionalBrowserProcess,
  type PlaywrightCoreModule,
  resolveChromiumExecutable,
  runWithBrowserSession,
  safeCloseBrowser,
} from './browser.js';

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function makeFakeProcess(options: { readonly exitOnSigterm?: boolean } = {}): {
  readonly proc: OptionalBrowserProcess;
  readonly signals: (NodeJS.Signals | number | undefined)[];
} {
  const signals: (NodeJS.Signals | number | undefined)[] = [];
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let killed = false;

  const proc: OptionalBrowserProcess = {
    pid: 424242,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    get killed() {
      return killed;
    },
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal);
      killed = true;
      if (signal === 'SIGTERM' && options.exitOnSigterm) {
        exitCode = 0;
        signalCode = 'SIGTERM';
      } else if (signal === 'SIGKILL') {
        signalCode = 'SIGKILL';
      }
      return true;
    },
  };

  return { proc, signals };
}

describe('records/runtime/browser', () => {
  it('resolves executable priority: override env var > Playwright bundled > direct system > PATH', () => {
    const existing = new Set([
      '/custom/override-chrome',
      '/home/test/.cache/ms-playwright/chromium/chrome',
      '/usr/lib/chromium/chromium',
      '/usr/bin/chromium',
    ]);
    const isExec = (p: string): boolean => existing.has(p);

    const withOverride = resolveChromiumExecutable({
      env: { CA_ARCHIVES_BROWSER: '/custom/override-chrome', PATH: '/usr/bin' },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      playwrightExecutablePath: '/home/test/.cache/ms-playwright/chromium/chrome',
      isExecutable: isExec,
    });
    expect(withOverride).toEqual({
      kind: 'override',
      executablePath: '/custom/override-chrome',
      envVar: 'CA_ARCHIVES_BROWSER',
    });

    const withMissingOverride = resolveChromiumExecutable({
      env: { CA_ARCHIVES_BROWSER: '/does/not/exist', PATH: '/usr/bin' },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      playwrightExecutablePath: '/home/test/.cache/ms-playwright/chromium/chrome',
      isExecutable: isExec,
    });
    expect(withMissingOverride).toEqual({
      kind: 'playwright-bundled',
      executablePath: '/home/test/.cache/ms-playwright/chromium/chrome',
    });

    const withoutPlaywrightBinary = resolveChromiumExecutable({
      env: { PATH: '/usr/bin' },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      playwrightExecutablePath: '/missing/playwright/chrome',
      isExecutable: isExec,
    });
    expect(withoutPlaywrightBinary).toEqual({
      kind: 'system-binary',
      executablePath: '/usr/lib/chromium/chromium',
    });

    const pathOnly = resolveChromiumExecutable({
      env: { PATH: '/usr/bin' },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      playwrightExecutablePath: '/missing/playwright/chrome',
      isExecutable: (p) => p === '/usr/bin/chromium',
    });
    expect(pathOnly).toEqual({
      kind: 'system-binary',
      executablePath: '/usr/bin/chromium',
    });

    const noneFound = resolveChromiumExecutable({
      env: { PATH: '/usr/bin' },
      playwrightExecutablePath: '/missing/playwright/chrome',
      isExecutable: () => false,
    });
    expect(noneFound).toEqual({ kind: 'playwright-default' });
  });

  it('prefers Playwright bundled binary without passing system executablePath, and sanitizes env for system fallback', async () => {
    const launchCalls: Parameters<PlaywrightCoreModule['chromium']['launch']>[0][] = [];
    const fakeBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          evaluate: async <T>() => '' as unknown as T,
          close: async () => {},
        }),
        close: async () => {},
      }),
      close: async () => {},
    };

    const makeMod = (bundledPath: string): PlaywrightCoreModule => ({
      chromium: {
        executablePath: () => bundledPath,
        launch: async (opts) => {
          launchCalls.push(opts);
          return fakeBrowser;
        },
      },
    });

    await launchOptionalChromium({
      env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-1', HOME: '/home/test' },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      launchTimeoutMs: 5_000,
      loadPlaywright: async () => makeMod('/pw/bundled/chrome'),
      isExecutable: (p) => p === '/pw/bundled/chrome' || p === '/usr/bin/chromium',
    });

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0]?.executablePath).toBeUndefined();
    expect(launchCalls[0]?.timeout).toBe(5_000);
    expect(launchCalls[0]?.env).toBeUndefined();

    await launchOptionalChromium({
      env: {
        PATH: '/usr/bin',
        WAYLAND_DISPLAY: 'wayland-1',
        GTK_USE_PORTAL: '1',
        CHROMIUM_USER_FLAGS: '--load-extension=foo',
        HOME: '/home/test',
      },
      overrideEnvVar: 'CA_ARCHIVES_BROWSER',
      launchTimeoutMs: 7_500,
      loadPlaywright: async () => makeMod('/missing/pw/chrome'),
      isExecutable: (p) => p === '/usr/lib/chromium/chromium' || p === '/usr/bin/chromium',
    });

    expect(launchCalls).toHaveLength(2);
    expect(launchCalls[1]?.executablePath).toBe('/usr/lib/chromium/chromium');
    expect(launchCalls[1]?.timeout).toBe(7_500);
    expect(launchCalls[1]?.args).toContain('--ozone-platform=headless');
    expect(launchCalls[1]?.args).toContain('--password-store=basic');
    expect(launchCalls[1]?.env?.['WAYLAND_DISPLAY']).toBeUndefined();
    expect(launchCalls[1]?.env?.['GTK_USE_PORTAL']).toBeUndefined();
    expect(launchCalls[1]?.env?.['CHROMIUM_USER_FLAGS']).toBeUndefined();
    expect(launchCalls[1]?.env?.['XDG_CONFIG_HOME']).toContain('kinloom-headless-xdg-config');
  });

  it('buildSanitizedBrowserEnv strips desktop flags and isolates XDG_CONFIG_HOME', () => {
    const cleaned = buildSanitizedBrowserEnv({
      PATH: '/usr/bin',
      WAYLAND_DISPLAY: 'wayland-0',
      ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
      XDG_CONFIG_HOME: '/home/test/.config',
    });
    expect(cleaned['PATH']).toBe('/usr/bin');
    expect(cleaned['WAYLAND_DISPLAY']).toBeUndefined();
    expect(cleaned['ELECTRON_OZONE_PLATFORM_HINT']).toBeUndefined();
    expect(cleaned['XDG_CONFIG_HOME']).not.toBe('/home/test/.config');
  });

  it('aborts a hanging launch within launchTimeoutMs and cleans up late-resolving browsers', async () => {
    let resolveLate!: (browser: OptionalBrowser) => void;
    let closedLate = false;
    const { proc, signals } = makeFakeProcess({ exitOnSigterm: true });

    const start = Date.now();
    await expect(
      launchOptionalChromium({
        env: {},
        launchTimeoutMs: 30,
        closeTimeoutMs: 25,
        killGraceMs: 10,
        loadPlaywright: async () => ({
          chromium: {
            executablePath: () => '/pw/chrome',
            launch: () =>
              new Promise<OptionalBrowser>((resolve) => {
                resolveLate = resolve;
              }),
          },
        }),
        isExecutable: (p) => p === '/pw/chrome',
      })
    ).rejects.toMatchObject({
      name: 'BrowserTimeoutError',
      phase: 'launch',
    });
    expect(Date.now() - start).toBeLessThan(500);

    resolveLate({
      newContext: async () => neverSettles(),
      close: async () => {
        closedLate = true;
      },
      process: () => proc,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(closedLate).toBe(true);
    expect(signals).toEqual(['SIGTERM']);
  });

  it('aborts hanging page.evaluate() and hanging browser.close() with SIGTERM then SIGKILL escalation', async () => {
    const { proc, signals } = makeFakeProcess({ exitOnSigterm: false });
    const hangingBrowser: OptionalBrowser = {
      newContext: async () => ({
        newPage: async () => ({
          goto: async () => {},
          content: async () => '',
          evaluate: () => neverSettles(),
          close: () => neverSettles(),
        }),
        close: () => neverSettles(),
      }),
      close: () => neverSettles(),
      process: () => proc,
    };

    const start = Date.now();
    await expect(
      runWithBrowserSession(
        {
          env: {},
          totalTimeoutMs: 40,
          launchTimeoutMs: 30,
          closeTimeoutMs: 30,
          killGraceMs: 15,
          launcher: async () => hangingBrowser,
        },
        async (session) => {
          return session.runStep('evaluate', () => session.page.evaluate<string>('document.body.innerText'));
        }
      )
    ).rejects.toBeInstanceOf(BrowserTimeoutError);

    expect(Date.now() - start).toBeLessThan(500);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('safeCloseBrowser stops after SIGTERM when child exits cleanly', async () => {
    const { proc, signals } = makeFakeProcess({ exitOnSigterm: true });
    const browser: OptionalBrowser = {
      newContext: async () => neverSettles(),
      close: () => neverSettles(),
      process: () => proc,
    };

    const start = Date.now();
    await safeCloseBrowser({ browser }, { closeTimeoutMs: 25, killGraceMs: 15 });
    expect(Date.now() - start).toBeLessThan(300);
    expect(signals).toEqual(['SIGTERM']);
  });
});
