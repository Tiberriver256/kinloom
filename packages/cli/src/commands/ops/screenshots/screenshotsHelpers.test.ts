import { describe, expect, it, vi } from 'vitest';
import {
  buildHeadlessEnv,
  createPlaywrightBrowserFactory,
  inspectLiveNavLinks,
  inspectThemeSurface,
  inspectVisiblePluginSlots,
  isExecutableBinary,
  loadPlaywrightModule,
  navigateAndSettlePage,
  type PlaywrightLaunchModule,
  resolveScreenshotChromiumPath,
  safeCloseHandle,
  withTimeout,
} from './browser.js';
import { buildComponentCaptureTargets, prepareComponentCapture } from './components.js';
import {
  buildPageCaptureTargets,
  buildPluginCaptureTargets,
  classifyDiscoveredNavLinks,
  extractSamplesFromBundle,
  fetchArchiveBundleForDiscovery,
  isKnownCoreRoute,
} from './discovery.js';
import {
  buildAuthRequestHeaders,
  buildScreenshotRelativePath,
  normalizeRoutePath,
  parseAuthCookieSpecs,
  parseAuthHeader,
  parseBoundedTimeoutEnv,
  parseIncludeOption,
  parseRouteList,
  parseThemesOption,
  parseViewportsOption,
  resolveCaptureTimeoutPolicy,
  routeToSlug,
  sanitizeSlug,
  sanitizeUrlForReport,
  validateTargetBaseUrl,
} from './parse.js';
import {
  buildCaptureThemeAudit,
  buildScreenshotsManifest,
  computeContrastRatio,
  computeDarkThemeVerification,
  computeRelativeLuminance,
  escapeHtml,
  formatScreenshotsTextReport,
  parseCssRgbColor,
  renderContactSheetHtml,
} from './report.js';
import {
  isHeavyCaptureTarget,
  isMapCaptureTarget,
  isScreenshotTimeoutError,
  requiresIsolatedCaptureContext,
} from './runner.js';
import type {
  BundleDiscoveryResult,
  ComponentRecipeId,
  ScreenshotLocatorHandle,
  ScreenshotPageHandle,
} from './types.js';

describe('screenshots/parse boundary validation', () => {
  it('validates http and https target URLs and rejects invalid or credentialed URLs', () => {
    expect(validateTargetBaseUrl('https://demo.kinloom.example/archive///')).toBe(
      'https://demo.kinloom.example/archive'
    );
    expect(validateTargetBaseUrl('http://127.0.0.1:4173/')).toBe('http://127.0.0.1:4173');
    expect(() => validateTargetBaseUrl('   ')).toThrow('Missing required option `--url`');
    expect(() => validateTargetBaseUrl('not-a-url')).toThrow('Invalid `--url`');
    expect(() => validateTargetBaseUrl('file:///etc/passwd')).toThrow('Unsupported URL protocol');
    expect(() => validateTargetBaseUrl('https://user:pass@demo.kinloom.example')).toThrow(
      'Embedded credentials'
    );
  });

  it('normalizes routes, slugs, and relative screenshot paths', () => {
    expect(normalizeRoutePath('tree/')).toBe('/tree');
    expect(normalizeRoutePath('///person//abraham-lincoln/?tab=bio#top')).toBe(
      '/person/abraham-lincoln?tab=bio'
    );
    expect(normalizeRoutePath('/')).toBe('/');
    expect(() => normalizeRoutePath('   ')).toThrow('Route path cannot be empty');
    expect(() => normalizeRoutePath('https://evil.example/x')).toThrow('must be a relative path');

    expect(routeToSlug('/')).toBe('home');
    expect(routeToSlug('/stories/demo-reel?v=1')).toBe('stories-demo-reel');
    expect(sanitizeSlug('!!!', 'fallback')).toBe('fallback');

    expect(
      buildScreenshotRelativePath({
        category: 'page',
        slug: 'home',
        viewport: 'desktop',
        theme: 'light',
      })
    ).toBe('pages/home/desktop-light.png');
    expect(
      buildScreenshotRelativePath({
        category: 'component',
        slug: 'global-search',
        state: 'results',
        viewport: 'mobile',
        theme: 'dark',
      })
    ).toBe('components/global-search/results/mobile-dark.png');
    expect(
      buildScreenshotRelativePath({
        category: 'plugin',
        slug: 'stories-demo-reel',
        viewport: 'tablet',
        theme: 'light',
      })
    ).toBe('plugins/stories-demo-reel/tablet-light.png');
  });

  it('parses viewports, themes, include scopes, routes, and auth options', () => {
    expect(parseViewportsOption('mobile,tablet,desktop')).toEqual([
      { name: 'mobile', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1440, height: 900 },
    ]);
    expect(parseViewportsOption('wide:1920x1080,mobile,mobile')).toEqual([
      { name: 'wide', width: 1920, height: 1080 },
      { name: 'mobile', width: 390, height: 844 },
    ]);
    expect(() => parseViewportsOption(' , ')).toThrow('at least one viewport');
    expect(() => parseViewportsOption('badspec')).toThrow('Invalid viewport');
    expect(() => parseViewportsOption('tiny:100x100')).toThrow('between 200 and 7680');
    expect(() => parseViewportsOption('custom:400x800,custom:500x900')).toThrow('Duplicate viewport name');

    expect(parseThemesOption('light,dark,light')).toEqual(['light', 'dark']);
    expect(() => parseThemesOption('')).toThrow('Option `--themes`');
    expect(() => parseThemesOption('sepia')).toThrow("Unknown theme 'sepia'");

    expect(parseIncludeOption('pages,plugins,pages')).toEqual(['pages', 'plugins']);
    expect(() => parseIncludeOption('')).toThrow('Option `--include`');
    expect(() => parseIncludeOption('widgets')).toThrow("Unknown include scope 'widgets'");

    expect(parseRouteList(['/tree,/map', '/tree, /custom '])).toEqual(['/tree', '/map', '/custom']);

    expect(parseAuthHeader('Authorization: Bearer demo-token')).toEqual({
      name: 'Authorization',
      value: 'Bearer demo-token',
    });
    expect(() => parseAuthHeader('Bad\r\nHeader: x')).toThrow('CR or LF');
    expect(() => parseAuthHeader('NoColonHeader')).toThrow('Header-Name: value');
    expect(() => parseAuthHeader('Bad Name: value')).toThrow('invalid HTTP header name');

    expect(parseAuthCookieSpecs('sid=abc123; mode=editor', 'https://demo.kinloom.example/sub')).toEqual([
      { name: 'sid', value: 'abc123', url: 'https://demo.kinloom.example' },
      { name: 'mode', value: 'editor', url: 'https://demo.kinloom.example' },
    ]);
    expect(() => parseAuthCookieSpecs('a=1\nb=2', 'https://demo.kinloom.example')).toThrow('CR or LF');
    expect(() => parseAuthCookieSpecs('badcookie', 'https://demo.kinloom.example')).toThrow('name=value');
    expect(() => parseAuthCookieSpecs(' ; ', 'https://demo.kinloom.example')).toThrow('at least one');

    expect(
      buildAuthRequestHeaders({
        authCookie: 'sid=1',
        authHeaders: [{ name: 'X-Preview', value: 'yes' }],
      })
    ).toEqual({
      'X-Preview': 'yes',
      Cookie: 'sid=1',
    });
  });

  it('redacts sensitive URL credentials and query params for reporting', () => {
    expect(
      sanitizeUrlForReport('https://user:pw@demo.kinloom.example/api?token=secret123&page=2&key=abc')
    ).toBe('https://demo.kinloom.example/api?token=%5Bredacted%5D&page=2&key=%5Bredacted%5D');
    expect(sanitizeUrlForReport('not a url token=xyz123')).toBe('not a url token=[redacted]');
  });
});

describe('screenshots/discovery bundle and nav classification', () => {
  it('ranks deceased people with audio/bio/pronunciation/media first and excludes living records', () => {
    const bundle = {
      people: [
        { id: 'p-living', slug: 'living-person', full_name: 'Living', is_living: true, event_count: 99 },
        { id: 'p-plain', slug: 'thomas-lincoln', full_name: 'Thomas Lincoln', event_count: 3 },
        {
          id: 'p-rich',
          slug: 'abraham-lincoln',
          full_name: 'Abraham Lincoln',
          pronunciation: { phonetic: 'AY-bruh-ham LINK-un' },
          portrait_url: '/media/abe.jpg',
          event_count: 15,
        },
        'not-an-object',
      ],
      media: [{ id: 'm1', person_id: 'p-rich', person_ids: ['p-plain'] }],
      narratives: [
        {
          id: 'n1',
          slug: 'springfield-years',
          title: 'Springfield Years',
          person_id: 'p-rich',
          subject_person_ids: ['p-rich'],
          extensions: { narrative_audio: { file: '/media/abe.mp3' } },
        },
      ],
      places: [
        { id: 'pl-bare', slug: 'hodgenville', name: 'Hodgenville' },
        {
          id: 'pl-rich',
          slug: 'springfield-il',
          name: 'Springfield, Illinois',
          lat: 39.78,
          lng: -89.65,
          description: 'State capital.',
          pronunciation: { phonetic: 'SPRING-feeld' },
        },
      ],
    };

    const result = extractSamplesFromBundle(bundle, { samplePeople: 2, samplePlaces: 1 });
    expect(result.people.map((p) => p.slug)).toEqual(['abraham-lincoln', 'thomas-lincoln']);
    expect(result.people[0]).toMatchObject({
      slug: 'abraham-lincoln',
      searchTerm: 'Lincoln',
      hasPronunciation: true,
      hasMedia: true,
      hasBiography: true,
      hasNarrativeAudio: true,
    });
    expect(result.places.map((pl) => pl.slug)).toEqual(['springfield-il']);
    expect(result.narratives).toEqual([{ id: 'n1', slug: 'springfield-years', title: 'Springfield Years' }]);
    expect(extractSamplesFromBundle(null, { samplePeople: 1, samplePlaces: 1 })).toEqual({
      people: [],
      places: [],
      narratives: [],
    });
  });

  it('fetches /api/bundle first, falls back to /data/bundle.json, and handles unavailable endpoints', async () => {
    const samplePayload = {
      people: [{ id: 'p1', slug: 'mary-todd', full_name: 'Mary Todd' }],
      places: [{ id: 'pl1', slug: 'lexington-ky', name: 'Lexington, Kentucky' }],
    };

    const apiFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/bundle')) {
        return new Response(JSON.stringify(samplePayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const fromApi = await fetchArchiveBundleForDiscovery({
      baseUrl: 'https://demo.kinloom.example',
      samplePeople: 1,
      samplePlaces: 1,
      timeoutMs: 5_000,
      fetchImpl: apiFetch,
    });
    expect(fromApi.source).toBe('api-bundle');
    expect(fromApi.people[0]?.slug).toBe('mary-todd');

    const staticFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/bundle')) {
        return new Response('<html>SPA fallback</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(JSON.stringify(samplePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const fromStatic = await fetchArchiveBundleForDiscovery({
      baseUrl: 'https://demo.kinloom.example',
      samplePeople: 1,
      samplePlaces: 1,
      timeoutMs: 5_000,
      fetchImpl: staticFetch,
    });
    expect(fromStatic.source).toBe('static-bundle');
    expect(fromStatic.places[0]?.slug).toBe('lexington-ky');

    const failFetch: typeof fetch = vi.fn(async () => {
      throw new Error('network down');
    });
    const noneRes = await fetchArchiveBundleForDiscovery({
      baseUrl: 'https://demo.kinloom.example',
      samplePeople: 1,
      samplePlaces: 1,
      timeoutMs: 5_000,
      fetchImpl: failFetch,
    });
    expect(noneRes.source).toBe('none');
    expect(noneRes.people).toEqual([]);
  });

  it('classifies core routes vs custom plugin routes from nav links and builds targets', () => {
    expect(isKnownCoreRoute('/tree')).toBe(true);
    expect(isKnownCoreRoute('/person/abraham-lincoln')).toBe(true);
    expect(isKnownCoreRoute('/stories/demo-reel')).toBe(false);

    const classified = classifyDiscoveredNavLinks(
      [
        { href: '/', text: 'People' },
        { href: '/archive/privacy', text: 'Privacy' },
        { href: '/archive/narratives', text: 'Narratives' },
        { href: '/archive/stories/demo-reel', text: 'Stories' },
        { href: '/archive/stories/demo-reel', text: 'Duplicate Stories' },
        { href: '/archive/bare-plugin', text: '   ' },
        { href: 'https://external.example/about', text: 'External' },
        { href: '#main-content', text: 'Skip' },
        { href: 'mailto:info@example.com', text: 'Email' },
        { href: 'http://[::1', text: 'Malformed' },
        { href: '/archive/api/bundle', text: 'API' },
        { href: '/archive/media/photo.jpg', text: 'Media' },
      ],
      'https://demo.kinloom.example/archive'
    );

    expect(classified.extraCoreRoutes).toEqual([
      { route: '/', label: 'People' },
      { route: '/privacy', label: 'Privacy' },
      { route: '/narratives', label: 'Narratives' },
    ]);
    expect(classified.pluginRoutes).toEqual([
      { route: '/stories/demo-reel', label: 'Stories' },
      { route: '/bare-plugin', label: '/bare-plugin' },
    ]);

    const discovery: BundleDiscoveryResult = {
      source: 'api-bundle',
      people: [
        {
          id: 'p1',
          slug: 'abraham-lincoln',
          fullName: 'Abraham Lincoln',
          searchTerm: 'Lincoln',
          hasPronunciation: true,
          hasMedia: true,
          hasBiography: true,
          hasNarrativeAudio: false,
        },
      ],
      places: [{ id: 'pl1', slug: 'springfield-il', name: 'Springfield, Illinois' }],
      narratives: [{ id: 'n1', slug: 'springfield-years', title: 'Springfield Years' }],
    };

    const pageTargets = buildPageCaptureTargets({
      discovery,
      navExtraCoreRoutes: [
        { route: '/people', label: 'People' },
        { route: '/privacy', label: 'Privacy' },
        { route: '/narratives', label: 'Narratives' },
      ],
      explicitRoutes: ['/custom-view'],
    });
    const pageRoutes = pageTargets.map((t) => t.route);
    expect(pageRoutes).toContain('/');
    expect(pageRoutes).toContain('/person/abraham-lincoln');
    expect(pageRoutes).toContain('/place/springfield-il');
    expect(pageRoutes).toContain('/privacy');
    expect(pageRoutes).toContain('/narratives/springfield-years');
    expect(pageRoutes).toContain('/custom-view');
    expect(pageRoutes).not.toContain('/people');

    const pluginTargets = buildPluginCaptureTargets({
      discoveredPluginRoutes: classified.pluginRoutes,
      explicitPluginRoutes: ['/stories/demo-reel', '/custom-plugin'],
      discoveredSlots: [
        {
          pluginId: 'demo-story-reel',
          slotName: 'personDetail',
          selector: '[data-plugin-id="demo-story-reel"]',
          route: '/person/abraham-lincoln',
        },
      ],
    });
    expect(pluginTargets.map((t) => t.id)).toEqual([
      'plugin:route:stories-demo-reel',
      'plugin:route:bare-plugin',
      'plugin:route:custom-plugin',
      'plugin:slot:slot-demo-story-reel-persondetail',
    ]);
  });
});

describe('screenshots/browser utilities', () => {
  it('resolves chromium executable precedence and builds sanitized headless env', () => {
    const execSet = new Set(['/override/chrome', '/bundled/chrome', '/usr/lib/chromium/chromium']);
    const isExec = (p: string): boolean => execSet.has(p);

    expect(
      resolveScreenshotChromiumPath({
        env: { KINLOOM_CHROMIUM_PATH: '/override/chrome', PATH: '/usr/bin' },
        playwrightExecutablePath: '/bundled/chrome',
        isExecutable: isExec,
      })
    ).toEqual({ executablePath: '/override/chrome', isSystemBinary: false });

    expect(
      resolveScreenshotChromiumPath({
        env: { PATH: '/usr/bin' },
        playwrightExecutablePath: '/bundled/chrome',
        isExecutable: isExec,
      })
    ).toEqual({ executablePath: undefined, isSystemBinary: false });

    expect(
      resolveScreenshotChromiumPath({
        env: { PATH: '/usr/bin' },
        playwrightExecutablePath: '/missing/chrome',
        isExecutable: isExec,
      })
    ).toEqual({ executablePath: '/usr/lib/chromium/chromium', isSystemBinary: true });

    expect(
      resolveScreenshotChromiumPath({
        env: { PATH: ':/custom/bin:' },
        isExecutable: (p) => p === '/custom/bin/chromium',
      })
    ).toEqual({ executablePath: '/custom/bin/chromium', isSystemBinary: true });

    expect(resolveScreenshotChromiumPath({ env: {}, isExecutable: () => false })).toEqual({
      executablePath: undefined,
      isSystemBinary: false,
    });
    expect(isExecutableBinary('/nonexistent-kinloom-binary-path')).toBe(false);

    const env = buildHeadlessEnv({
      PATH: '/usr/bin',
      WAYLAND_DISPLAY: 'wayland-1',
      GTK_USE_PORTAL: '1',
      HOME: '/home/demo',
    });
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    expect(env.GTK_USE_PORTAL).toBeUndefined();
    expect(env.HOME).toBe('/home/demo');
    expect(env.XDG_CONFIG_HOME).toContain('kinloom-headless-xdg-config');
  });

  it('enforces withTimeout, safeCloseHandle, and navigateAndSettlePage fallback', async () => {
    await expect(withTimeout(Promise.resolve(42), 500, 'ok')).resolves.toBe(42);
    await expect(withTimeout(Promise.reject(new Error('boom')), 500, 'err')).rejects.toThrow('boom');
    await expect(
      withTimeout(
        new Promise((resolve) => {
          setTimeout(resolve, 1_000);
        }),
        60,
        'slow-step'
      )
    ).rejects.toThrow('Timed out after 60ms during slow-step');

    await safeCloseHandle(undefined, 'noop');
    await safeCloseHandle(
      {
        close: async () => {
          throw new Error('close failed');
        },
      },
      'close-err'
    );

    const gotoCalls: string[] = [];
    const fakePage: ScreenshotPageHandle = {
      goto: vi.fn(async (_url, opts) => {
        gotoCalls.push(opts?.waitUntil ?? 'none');
        if (opts?.waitUntil === 'load') {
          throw new Error('load timeout');
        }
      }),
      screenshot: vi.fn(async () => undefined),
      locator: vi.fn(() => {
        throw new Error('unused');
      }),
      evaluate: vi.fn(async () => true as never),
      waitForTimeout: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      keyboard: { press: vi.fn(async () => undefined) },
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    await navigateAndSettlePage({
      page: fakePage,
      url: 'http://127.0.0.1:4173/map',
      theme: 'dark',
      timeoutMs: 2_000,
      waitMs: 5,
      isMap: true,
    });
    expect(gotoCalls).toEqual(['load', 'domcontentloaded']);

    const failingPage: ScreenshotPageHandle = {
      ...fakePage,
      goto: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => {
        throw new Error('eval failed');
      }),
      waitForSelector: vi.fn(async () => {
        throw new Error('selector timeout');
      }),
    };
    await navigateAndSettlePage({
      page: failingPage,
      url: 'http://127.0.0.1:4173/map',
      theme: 'light',
      timeoutMs: 1_000,
      waitMs: 0,
      isMap: true,
    });
    expect(await inspectLiveNavLinks(failingPage)).toEqual([]);
    expect(await inspectVisiblePluginSlots(failingPage, '/')).toEqual([]);
  });

  it('loads playwright-core or falls back to playwright and throws when neither is installed', async () => {
    const fakeBrowser = {
      newContext: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const coreMod: PlaywrightLaunchModule = {
      chromium: {
        launch: vi.fn(async () => fakeBrowser),
      },
    };
    const pwMod: PlaywrightLaunchModule = {
      chromium: {
        launch: vi.fn(async () => fakeBrowser),
      },
    };

    const loadedCore = await loadPlaywrightModule(async (name) => {
      if (name === 'playwright-core') {
        return coreMod;
      }
      throw new Error('should not inspect fallback');
    });
    expect(loadedCore).toBe(coreMod);

    const loadedFallback = await loadPlaywrightModule(async (name) => {
      if (name === 'playwright-core') {
        return { chromium: null };
      }
      return pwMod;
    });
    expect(loadedFallback).toBe(pwMod);

    await expect(
      loadPlaywrightModule(async () => {
        throw new Error('Cannot find package');
      })
    ).rejects.toThrow('playwright-core');
  });

  it('launches bundled vs system chromium with expected args, env, and minimum timeout floor', async () => {
    const launchCalls: Array<Record<string, unknown>> = [];
    const fakeBrowser = {
      newContext: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    const bundledFactory = createPlaywrightBrowserFactory({
      loadModule: async () => ({
        chromium: {
          executablePath: () => '/bundled/chromium',
          launch: async (opts) => {
            launchCalls.push({ ...(opts ?? {}) });
            return fakeBrowser;
          },
        },
      }),
      isExecutable: (filePath) => filePath === '/bundled/chromium',
    });

    const bundledBrowser = await bundledFactory({
      timeoutMs: 1_000,
      env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-1' },
    });
    expect(bundledBrowser).toBe(fakeBrowser);
    expect(launchCalls[0]).toEqual({
      headless: true,
      timeout: 5_000,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-dev-shm-usage',
      ],
      executablePath: undefined,
      env: undefined,
    });

    const systemFactory = createPlaywrightBrowserFactory({
      loadModule: async () => ({
        chromium: {
          executablePath: () => {
            throw new Error('bundled missing');
          },
          launch: async (opts) => {
            launchCalls.push({ ...(opts ?? {}) });
            return fakeBrowser;
          },
        },
      }),
      isExecutable: (filePath) => filePath === '/usr/lib/chromium/chromium',
    });

    const systemBrowser = await systemFactory({
      timeoutMs: 12_000,
      env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'wayland-1', HOME: '/home/demo' },
    });
    expect(systemBrowser).toBe(fakeBrowser);
    expect(launchCalls[1]?.executablePath).toBe('/usr/lib/chromium/chromium');
    expect(launchCalls[1]?.timeout).toBe(12_000);
    expect(launchCalls[1]?.args).toContain('--ozone-platform=headless');
    const launchEnv = launchCalls[1]?.env as Record<string, string> | undefined;
    expect(launchEnv?.WAYLAND_DISPLAY).toBeUndefined();
    expect(launchEnv?.HOME).toBe('/home/demo');
  });
});

describe('screenshots/components recipe preparation', () => {
  function createFakePage(visibleSelectors: ReadonlySet<string>): ScreenshotPageHandle {
    const makeLocator = (selector: string): ScreenshotLocatorHandle => {
      const present = visibleSelectors.has(selector);
      const handle: ScreenshotLocatorHandle = {
        count: async () => (present ? 2 : 0),
        first: () => handle,
        nth: () => handle,
        isVisible: async () => present,
        click: async () => undefined,
        fill: async () => undefined,
        screenshot: async () => undefined,
        boundingBox: async () => (present ? { width: 120, height: 48 } : null),
        textContent: async () => (present ? 'Sample' : null),
      };
      return handle;
    };
    return {
      goto: async () => undefined,
      screenshot: async () => undefined,
      locator: (selector) => makeLocator(selector),
      evaluate: async () => undefined as never,
      waitForTimeout: async () => undefined,
      waitForSelector: async () => undefined,
      keyboard: { press: async () => undefined },
      on: () => undefined,
      close: async () => undefined,
    };
  }

  it('prepares every component recipe when selectors exist and skips cleanly when absent', async () => {
    const discovery: BundleDiscoveryResult = {
      source: 'api-bundle',
      people: [
        {
          id: 'p1',
          slug: 'abraham-lincoln',
          fullName: 'Abraham Lincoln',
          searchTerm: 'Lincoln',
          hasPronunciation: true,
          hasMedia: true,
          hasBiography: true,
          hasNarrativeAudio: true,
        },
      ],
      places: [{ id: 'pl1', slug: 'springfield-il', name: 'Springfield' }],
      narratives: [],
    };
    const targets = buildComponentCaptureTargets(discovery);
    expect(targets.length).toBe(16);

    const emptyPage = createFakePage(new Set());
    const mobileCtx = {
      viewport: { name: 'mobile', width: 390, height: 844 },
      searchQuery: 'Lincoln',
      actionTimeoutMs: 500,
      settleMs: 10,
    };
    for (const target of targets) {
      const prepared = await prepareComponentCapture(target, emptyPage, mobileCtx);
      expect(prepared.kind).toBe('skip');
    }

    const mobileOnlyTarget = targets.find((t) => t.recipeId === 'topbar-mobile-menu');
    expect(mobileOnlyTarget).toBeDefined();
    if (mobileOnlyTarget) {
      const desktopSkip = await prepareComponentCapture(mobileOnlyTarget, emptyPage, {
        ...mobileCtx,
        viewport: { name: 'desktop', width: 1440, height: 900 },
      });
      expect(desktopSkip).toEqual({
        kind: 'skip',
        reason: 'Only applicable to viewports: mobile',
      });
    }

    const richSelectors = new Set<string>([
      'header',
      'button[aria-label="Archive menu"]',
      '[role="menu"]',
      'button[aria-label="Search archive"]',
      'dialog[open][aria-label*="Search" i]',
      'dialog[open] input[type="search"]',
      '[data-testid="theme-toggle"]',
      '[class*="pronunciation-badge"]',
      '[role="group"][aria-label*="Pronunciation" i] button, button[aria-expanded][aria-label*="pronunciation" i]',
      'header button:has-text("Sources")',
      'dialog[open][aria-label*="Source" i]',
      '#person-media button[class*="person-media-card"]',
      'dialog[open][aria-label*="lightbox" i]',
      '[role="toolbar"][aria-label*="Family tree" i]',
      '[class*="tree-node"] button',
      'aside[aria-label*="Focus" i]',
      'aside[aria-label="Migration stage color legend"]',
      'button[aria-label*="Next stop" i]',
      'button:has-text("Sign in to edit")',
      'dialog[open][aria-label*="Sign in" i]',
      '[data-testid="narrative-audio-margin-bar"]',
      'footer',
    ]);
    const richPage = createFakePage(richSelectors);

    const expectedKinds: Record<ComponentRecipeId, 'element' | 'viewport'> = {
      'topbar-default': 'element',
      'topbar-mobile-menu': 'viewport',
      'global-search-open': 'viewport',
      'global-search-results': 'viewport',
      'theme-toggle': 'element',
      'pronunciation-badge-default': 'element',
      'pronunciation-badge-variant': 'element',
      'source-reader-open': 'viewport',
      'media-lightbox-open': 'viewport',
      'tree-controls': 'element',
      'tree-focus-card': 'viewport',
      'map-controls': 'viewport',
      'map-stop-card': 'viewport',
      'auth-sign-in-modal': 'viewport',
      'narrative-audio-bar': 'element',
      'footer-default': 'element',
    };

    for (const target of targets) {
      const prepared = await prepareComponentCapture(target, richPage, mobileCtx);
      expect(prepared.kind).toBe(expectedKinds[target.recipeId]);
    }

    // Cover fallback / partial-state branches in component recipes
    const triggerOnlyPage = createFakePage(
      new Set([
        'button[aria-label="Archive menu"]',
        'dialog[open][aria-label*="Search" i]',
        'header button:has-text("Sources")',
        '#person-media button[class*="person-media-card"]',
        '[class*="tree-node"] button',
        '[role="region"][aria-label="Invite access notice"]',
        '[role="group"][aria-label*="Pronunciation" i] button, button[aria-expanded][aria-label*="pronunciation" i]',
      ])
    );
    const byId = new Map(targets.map((t) => [t.recipeId, t]));
    expect(
      (await prepareComponentCapture(byId.get('topbar-mobile-menu')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('skip');
    expect(
      (await prepareComponentCapture(byId.get('global-search-results')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('skip');
    expect(
      (await prepareComponentCapture(byId.get('source-reader-open')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('skip');
    expect(
      (await prepareComponentCapture(byId.get('media-lightbox-open')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('skip');
    expect(
      (await prepareComponentCapture(byId.get('tree-focus-card')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('skip');
    expect(
      (await prepareComponentCapture(byId.get('auth-sign-in-modal')!, triggerOnlyPage, mobileCtx)).kind
    ).toBe('element');
    expect(
      (await prepareComponentCapture(byId.get('pronunciation-badge-variant')!, triggerOnlyPage, mobileCtx))
        .kind
    ).toBe('viewport');

    // Also cover buildComponentCaptureTargets fallbacks when only a place or nothing is discovered
    const placeOnlyTargets = buildComponentCaptureTargets({
      source: 'static-bundle',
      people: [],
      places: [{ id: 'pl1', slug: 'springfield-il', name: 'Springfield' }],
      narratives: [],
    });
    expect(placeOnlyTargets.find((t) => t.recipeId === 'pronunciation-badge-default')?.route).toBe(
      '/place/springfield-il'
    );
    const emptyTargets = buildComponentCaptureTargets({
      source: 'none',
      people: [],
      places: [],
      narratives: [],
    });
    expect(emptyTargets.find((t) => t.recipeId === 'pronunciation-badge-default')?.route).toBe('/');
  });
});

describe('screenshots/report manifest and XSS-safe contact sheet', () => {
  it('renders an XSS-escaped zero-dependency HTML contact sheet and text summary', () => {
    expect(escapeHtml(`<script>alert("x'&")</script>`)).toBe(
      '&lt;script&gt;alert(&quot;x&#39;&amp;&quot;)&lt;/script&gt;'
    );

    const manifest = buildScreenshotsManifest({
      targetUrl: 'https://demo.kinloom.example',
      generatedAt: '2026-11-27T12:00:00.000Z',
      viewports: [
        { name: 'mobile', width: 390, height: 844 },
        { name: 'desktop', width: 1440, height: 900 },
      ],
      themes: ['light', 'dark'],
      include: ['pages', 'components', 'plugins'],
      captures: [
        {
          category: 'page',
          id: 'page:home',
          slug: 'home',
          label: 'Home <script>alert(1)</script>',
          state: 'default',
          route: '/',
          viewport: 'desktop',
          theme: 'light',
          file: 'pages/home/desktop-light.png',
          width: 1440,
          height: 900,
          durationMs: 120,
          status: 'captured',
          consoleErrors: ['Console <img src=x onerror=alert(1)>'],
          failedRequests: ['https://demo.kinloom.example/missing.png (net::ERR_ABORTED)'],
        },
        {
          category: 'component',
          id: 'component:theme-toggle:toggled',
          slug: 'theme-toggle',
          state: 'toggled',
          label: 'Theme Toggle',
          route: '/',
          viewport: 'mobile',
          theme: 'dark',
          file: null,
          width: 390,
          height: 844,
          durationMs: 25,
          status: 'skipped',
          reason: 'No theme toggle found',
          consoleErrors: [],
          failedRequests: [],
        },
        {
          category: 'plugin',
          id: 'plugin:route:stories-demo-reel',
          slug: 'stories-demo-reel',
          state: 'default',
          label: 'Stories Plugin',
          route: '/stories/demo-reel',
          viewport: 'desktop',
          theme: 'dark',
          file: null,
          width: 1440,
          height: 900,
          durationMs: 90,
          status: 'failed',
          reason: 'Navigation timeout',
          consoleErrors: [],
          failedRequests: [],
        },
      ],
    });

    expect(manifest.summary).toEqual({
      total: 3,
      captured: 1,
      skipped: 1,
      failed: 1,
      byCategory: { page: 1, component: 1, plugin: 1 },
      consoleErrorCount: 1,
      failedRequestCount: 1,
    });

    const html = renderContactSheetHtml(manifest);
    expect(html).toContain('<!doctype html>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('Home &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('data-filter-category="page"');
    expect(html).toContain('data-filter-category="component"');
    expect(html).toContain('data-filter-category="plugin"');
    expect(html).toContain('data-filter-viewport="mobile"');
    expect(html).toContain('data-filter-theme="dark"');
    expect(html).toContain('data-filter-status="errors"');
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);

    const textReport = formatScreenshotsTextReport({
      ok: false,
      outDir: '/tmp/out',
      manifestPath: '/tmp/out/manifest.json',
      indexHtmlPath: '/tmp/out/index.html',
      manifest,
    });
    expect(textReport).toContain('1 captured, 1 skipped, 1 failed (3 total)');
    expect(textReport).toContain('[plugin] /stories/demo-reel (desktop/dark): Navigation timeout');

    const cleanManifest = buildScreenshotsManifest({
      targetUrl: 'https://demo.kinloom.example',
      generatedAt: '2026-11-27T12:00:00.000Z',
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      themes: ['light'],
      include: ['pages'],
      captures: [
        {
          category: 'page',
          id: 'page:home',
          slug: 'home',
          label: 'Home',
          state: 'default',
          route: '/',
          viewport: 'desktop',
          theme: 'light',
          file: 'pages/home/desktop-light.png',
          width: 1440,
          height: 900,
          durationMs: 40,
          status: 'captured',
          consoleErrors: ['Single warning'],
          failedRequests: [],
        },
        {
          category: 'component',
          id: 'component:footer:default',
          slug: 'footer',
          state: 'default',
          label: 'Footer',
          route: '/',
          viewport: 'desktop',
          theme: 'light',
          file: null,
          width: 1440,
          height: 900,
          durationMs: 10,
          status: 'skipped',
          consoleErrors: [],
          failedRequests: [],
        },
      ],
    });
    const cleanHtml = renderContactSheetHtml(cleanManifest);
    expect(cleanHtml).toContain('1 issue');
    expect(cleanHtml).toContain('Not captured');
    const cleanReport = formatScreenshotsTextReport({
      ok: true,
      outDir: '/tmp/out',
      manifestPath: '/tmp/out/manifest.json',
      indexHtmlPath: '/tmp/out/index.html',
      manifest: cleanManifest,
    });
    expect(cleanReport).not.toContain('Failures:');
  });

  it('discovers static /data/archive.json before /data/bundle.json and skips non-bundle JSON payloads', async () => {
    const archivePayload = {
      people: [{ id: 'p-demo', slug: 'nancy-hanks', full_name: 'Nancy Hanks' }],
      places: [{ id: 'pl-demo', slug: 'hardin-ky', name: 'Hardin County, Kentucky' }],
    };
    const requestedUrls: string[] = [];
    const archiveFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.endsWith('/api/bundle')) {
        return new Response(JSON.stringify({ error: 'static site has no api' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/data/archive.json')) {
        return new Response(JSON.stringify(archivePayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('should not reach bundle.json', { status: 404 });
    });

    const fromArchiveJson = await fetchArchiveBundleForDiscovery({
      baseUrl: 'https://static.kinloom.example',
      samplePeople: 1,
      samplePlaces: 1,
      timeoutMs: 5_000,
      fetchImpl: archiveFetch,
    });
    expect(fromArchiveJson.source).toBe('static-bundle');
    expect(fromArchiveJson.people[0]?.slug).toBe('nancy-hanks');
    expect(fromArchiveJson.places[0]?.slug).toBe('hardin-ky');
    expect(requestedUrls).toEqual([
      'https://static.kinloom.example/api/bundle',
      'https://static.kinloom.example/data/archive.json',
    ]);

    const bundleFallbackUrls: string[] = [];
    const legacyBundleFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      bundleFallbackUrls.push(url);
      if (url.endsWith('/data/bundle.json')) {
        return new Response(JSON.stringify(archivePayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });

    const fromLegacyBundle = await fetchArchiveBundleForDiscovery({
      baseUrl: 'https://legacy.kinloom.example',
      samplePeople: 1,
      samplePlaces: 1,
      timeoutMs: 5_000,
      fetchImpl: legacyBundleFetch,
    });
    expect(fromLegacyBundle.source).toBe('static-bundle');
    expect(bundleFallbackUrls).toEqual([
      'https://legacy.kinloom.example/api/bundle',
      'https://legacy.kinloom.example/data/archive.json',
      'https://legacy.kinloom.example/data/bundle.json',
    ]);
  });

  it('resolves configurable capture timeout policies for standard, map, and heavy evidence targets', () => {
    expect(parseBoundedTimeoutEnv(undefined, 500, 120_000)).toBeUndefined();
    expect(parseBoundedTimeoutEnv('not-a-number', 500, 120_000)).toBeUndefined();
    expect(parseBoundedTimeoutEnv('100', 500, 120_000)).toBeUndefined();
    expect(parseBoundedTimeoutEnv('45000', 500, 120_000)).toBe(45_000);

    expect(
      resolveCaptureTimeoutPolicy({
        baseTimeoutMs: 20_000,
        isMap: false,
        isHeavyPage: false,
      })
    ).toEqual({
      navigationTimeoutMs: 20_000,
      captureTimeoutMs: 20_000,
      mapSettleTimeoutMs: 4_000,
      fullPageFallbackTimeoutMs: 15_000,
    });

    expect(
      resolveCaptureTimeoutPolicy({
        baseTimeoutMs: 20_000,
        isMap: true,
        isHeavyPage: false,
      })
    ).toEqual({
      navigationTimeoutMs: 10_000,
      captureTimeoutMs: 40_000,
      mapSettleTimeoutMs: 4_000,
      fullPageFallbackTimeoutMs: 15_000,
    });

    expect(
      resolveCaptureTimeoutPolicy({
        baseTimeoutMs: 20_000,
        isMap: false,
        isHeavyPage: true,
        env: {
          KINLOOM_SCREENSHOT_HEAVY_TIMEOUT_MS: '55000',
          KINLOOM_SCREENSHOT_MAP_SETTLE_MS: '6500',
        },
      })
    ).toEqual({
      navigationTimeoutMs: 20_000,
      captureTimeoutMs: 55_000,
      mapSettleTimeoutMs: 6_500,
      fullPageFallbackTimeoutMs: 15_000,
    });

    const pageTargets = buildPageCaptureTargets({
      discovery: { source: 'none', people: [], places: [], narratives: [] },
      navExtraCoreRoutes: [],
      explicitRoutes: ['/evidence?tab=media', '/map?place=springfield-il'],
    });
    const evidenceTarget = pageTargets.find((t) => t.route === '/evidence');
    const evidenceQueryTarget = pageTargets.find((t) => t.route === '/evidence?tab=media');
    const mapQueryTarget = pageTargets.find((t) => t.route === '/map?place=springfield-il');
    expect(evidenceTarget?.isHeavyPage).toBe(true);
    expect(evidenceQueryTarget?.isHeavyPage).toBe(true);
    expect(mapQueryTarget?.isMap).toBe(true);

    expect(isMapCaptureTarget(mapQueryTarget!)).toBe(true);
    expect(isHeavyCaptureTarget(evidenceQueryTarget!)).toBe(true);
    const componentTargets = buildComponentCaptureTargets({
      source: 'none',
      people: [],
      places: [],
      narratives: [],
    });
    const themeToggleTarget = componentTargets.find((t) => t.recipeId === 'theme-toggle')!;
    const footerTarget = componentTargets.find((t) => t.recipeId === 'footer-default')!;
    expect(requiresIsolatedCaptureContext(themeToggleTarget)).toBe(true);
    expect(requiresIsolatedCaptureContext(footerTarget)).toBe(false);
    expect(requiresIsolatedCaptureContext(evidenceTarget!)).toBe(false);
    expect(isScreenshotTimeoutError(new Error('page.screenshot: Timeout 20000ms exceeded.'))).toBe(true);
    expect(isScreenshotTimeoutError('Timed out after 500ms')).toBe(true);
    expect(isScreenshotTimeoutError(new Error('Target closed'))).toBe(false);
  });

  it('emulates media colorScheme, settles map tiles, inspects theme surface, and prepares map-stop-card deterministically', async () => {
    const emulateCalls: Array<{ colorScheme?: string | null }> = [];
    const evalCalls: string[] = [];
    const mapPage: ScreenshotPageHandle = {
      goto: vi.fn(async () => undefined),
      emulateMedia: vi.fn(async (opts) => {
        emulateCalls.push(opts);
      }),
      screenshot: vi.fn(async () => undefined),
      locator: vi.fn(() => {
        throw new Error('unused');
      }),
      evaluate: vi.fn(async (expr) => {
        evalCalls.push(expr);
        if (expr.includes('getComputedStyle')) {
          return {
            backgroundColor: 'rgb(23, 22, 20)',
            textColor: 'rgb(234, 227, 213)',
            dataTheme: 'dark',
            colorScheme: 'dark',
            prefersDark: true,
          } as never;
        }
        return true as never;
      }),
      waitForTimeout: vi.fn(async () => undefined),
      waitForSelector: vi.fn(async () => undefined),
      keyboard: { press: vi.fn(async () => undefined) },
      on: vi.fn(),
      close: vi.fn(async () => undefined),
    };

    await navigateAndSettlePage({
      page: mapPage,
      url: 'http://127.0.0.1:4173/map',
      theme: 'dark',
      timeoutMs: 8_000,
      navigationTimeoutMs: 4_000,
      mapSettleTimeoutMs: 500,
      waitMs: 0,
      isMap: true,
    });
    expect(emulateCalls).toEqual([{ colorScheme: 'dark' }]);
    expect(evalCalls.some((expr) => expr.includes('kinloomMigrationMap'))).toBe(true);

    const surface = await inspectThemeSurface(mapPage);
    expect(surface).toEqual({
      backgroundColor: 'rgb(23, 22, 20)',
      textColor: 'rgb(234, 227, 213)',
      dataTheme: 'dark',
      colorScheme: 'dark',
      prefersDark: true,
    });

    const failingEmulatePage: ScreenshotPageHandle = {
      ...mapPage,
      emulateMedia: vi.fn(async () => {
        throw new Error('unsupported');
      }),
      evaluate: vi.fn(async () => ({}) as never),
    };
    await navigateAndSettlePage({
      page: failingEmulatePage,
      url: 'http://127.0.0.1:4173/',
      theme: 'light',
      timeoutMs: 2_000,
      waitMs: 0,
    });
    expect(await inspectThemeSurface(failingEmulatePage)).toBeNull();

    const mapStopTarget = buildComponentCaptureTargets({
      source: 'none',
      people: [],
      places: [],
      narratives: [],
    }).find((t) => t.recipeId === 'map-stop-card')!;

    const makeLocator = (visible: boolean, disabled = false): ScreenshotLocatorHandle => {
      const handle: ScreenshotLocatorHandle = {
        count: async () => (visible ? 1 : 0),
        first: () => handle,
        nth: () => handle,
        isVisible: async () => visible,
        isDisabled: async () => disabled,
        click: vi.fn(async () => undefined),
        fill: async () => undefined,
        screenshot: async () => undefined,
        boundingBox: async () => (visible ? { width: 100, height: 32 } : null),
        textContent: async () => 'Next →',
      };
      return handle;
    };

    const disabledNextPage: ScreenshotPageHandle = {
      ...mapPage,
      locator: (selector) =>
        makeLocator(selector === '[data-map-playback-bar="true"] button:has-text("Next")', true),
    };
    expect(
      await prepareComponentCapture(mapStopTarget, disabledNextPage, {
        viewport: { name: 'desktop', width: 1440, height: 900 },
        searchQuery: 'Lincoln',
        actionTimeoutMs: 500,
        settleMs: 10,
      })
    ).toEqual({
      kind: 'skip',
      reason: 'No enabled interactive map stop control found',
    });

    const alreadyOpenPage: ScreenshotPageHandle = {
      ...mapPage,
      locator: (selector) => makeLocator(selector === 'section[aria-label="Selected stop details"]', false),
    };
    expect(
      await prepareComponentCapture(mapStopTarget, alreadyOpenPage, {
        viewport: { name: 'desktop', width: 1440, height: 900 },
        searchQuery: 'Lincoln',
        actionTimeoutMs: 500,
        settleMs: 10,
      })
    ).toEqual({ kind: 'viewport', fullPage: false });

    const playbackNextLocator = makeLocator(true, false);
    const playbackNextPage: ScreenshotPageHandle = {
      ...mapPage,
      waitForSelector: vi.fn(async () => {
        throw new Error('popover timeout');
      }),
      locator: (selector) =>
        selector === '[data-map-playback-bar="true"] button:has-text("Next")'
          ? playbackNextLocator
          : makeLocator(false),
    };
    expect(
      await prepareComponentCapture(mapStopTarget, playbackNextPage, {
        viewport: { name: 'desktop', width: 1440, height: 900 },
        searchQuery: 'Lincoln',
        actionTimeoutMs: 500,
        settleMs: 10,
      })
    ).toEqual({ kind: 'viewport', fullPage: false });
    expect(playbackNextLocator.click).toHaveBeenCalledTimes(1);
  });

  it('computes dark-theme canvas luminance, WCAG contrast, no-op detection, and report annotations', () => {
    expect(parseCssRgbColor('rgb(23, 22, 20)')).toEqual({ r: 23, g: 22, b: 20, a: 1 });
    expect(parseCssRgbColor('rgba(245, 239, 226, 0.95)')).toEqual({ r: 245, g: 239, b: 226, a: 0.95 });
    expect(parseCssRgbColor('#171614')).toEqual({ r: 23, g: 22, b: 20, a: 1 });
    expect(parseCssRgbColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssRgbColor('rgba(0, 0, 0, 0)')).toBeNull();
    expect(parseCssRgbColor('rgb(300, 0, 0)')).toBeNull();
    expect(parseCssRgbColor('transparent')).toBeNull();
    expect(parseCssRgbColor(null)).toBeNull();

    const darkBgLum = computeRelativeLuminance({ r: 23, g: 22, b: 20 });
    const darkFgLum = computeRelativeLuminance({ r: 234, g: 227, b: 213 });
    expect(computeContrastRatio(darkBgLum, darkFgLum)).toBeGreaterThan(13.5);

    const darkAudit = buildCaptureThemeAudit(
      {
        backgroundColor: 'rgb(23, 22, 20)',
        textColor: 'rgb(234, 227, 213)',
        dataTheme: 'dark',
        prefersDark: true,
      },
      'sha-dark-home'
    );
    expect(darkAudit?.isDarkSurface).toBe(true);
    expect(darkAudit?.contrastRatio).toBeGreaterThan(13.5);

    const lightAudit = buildCaptureThemeAudit(
      {
        backgroundColor: '#f5efe2',
        textColor: '#23272e',
        dataTheme: 'light',
        prefersDark: false,
      },
      'sha-light-home'
    );
    expect(lightAudit?.isDarkSurface).toBe(false);
    expect(buildCaptureThemeAudit(null)).toBeUndefined();

    const baseEntry = {
      category: 'page' as const,
      id: 'page:home',
      slug: 'home',
      label: 'Home',
      state: 'default',
      route: '/',
      viewport: 'desktop',
      file: 'pages/home/desktop-light.png',
      width: 1440,
      height: 900,
      durationMs: 100,
      status: 'captured' as const,
      consoleErrors: [],
      failedRequests: [],
    };

    expect(computeDarkThemeVerification(['light'], [{ ...baseEntry, theme: 'light' }]).status).toBe(
      'not-requested'
    );
    expect(computeDarkThemeVerification(['dark'], []).status).toBe('unverified');

    const verified = computeDarkThemeVerification(
      ['light', 'dark'],
      [
        { ...baseEntry, theme: 'light', themeAudit: lightAudit },
        { ...baseEntry, theme: 'dark', file: 'pages/home/desktop-dark.png', themeAudit: darkAudit },
      ]
    );
    expect(verified).toEqual({
      status: 'verified',
      darkCaptureCount: 1,
      pairedCaptureCount: 1,
      distinctFromLightCount: 1,
      identicalToLightCount: 0,
      darkSurfaceVerifiedCount: 1,
      lightCanvasInDarkModeCount: 0,
      minDarkContrastRatio: darkAudit!.contrastRatio,
      identicalCaptureIds: [],
    });

    const noopAudit = buildCaptureThemeAudit(
      {
        backgroundColor: '#f5efe2',
        textColor: '#23272e',
        dataTheme: null,
        prefersDark: true,
      },
      'sha-light-home'
    );
    const noopManifest = buildScreenshotsManifest({
      targetUrl: 'https://demo.kinloom.example',
      generatedAt: '2026-11-27T12:00:00.000Z',
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      themes: ['light', 'dark'],
      include: ['pages'],
      captures: [
        { ...baseEntry, theme: 'light', themeAudit: lightAudit },
        {
          ...baseEntry,
          theme: 'dark',
          file: 'pages/home/desktop-dark.png',
          fallbackUsed: 'viewport-after-fullpage-timeout',
          reason: 'Full-page capture timed out; captured viewport fallback',
          themeAudit: noopAudit,
        },
      ],
    });
    expect(noopManifest.darkThemeVerification?.status).toBe('noop');
    expect(noopManifest.darkThemeVerification?.identicalCaptureIds).toEqual(['page:home@desktop']);

    const noopHtml = renderContactSheetHtml(noopManifest);
    expect(noopHtml).toContain('dark theme: noop');
    expect(noopHtml).toContain('dark no-op');
    expect(noopHtml).toContain('viewport fallback');

    const noopText = formatScreenshotsTextReport({
      ok: true,
      outDir: '/tmp/out',
      manifestPath: '/tmp/out/manifest.json',
      indexHtmlPath: '/tmp/out/index.html',
      manifest: noopManifest,
    });
    expect(noopText).toContain('Dark Theme:');
    expect(noopText).toContain('0/1 distinct from light');
    expect(noopText).toContain('1 light canvas in dark mode');
    expect(noopText).toContain('Fallbacks:     1 viewport fallback(s)');

    const partial = computeDarkThemeVerification(
      ['light', 'dark'],
      [
        { ...baseEntry, theme: 'light', themeAudit: lightAudit },
        { ...baseEntry, theme: 'dark', file: 'pages/home/desktop-dark.png', themeAudit: darkAudit },
        {
          ...baseEntry,
          id: 'page:evidence',
          slug: 'evidence',
          route: '/evidence',
          theme: 'light',
          themeAudit: lightAudit,
        },
        {
          ...baseEntry,
          id: 'page:evidence',
          slug: 'evidence',
          route: '/evidence',
          theme: 'dark',
          themeAudit: noopAudit,
        },
      ]
    );
    expect(partial.status).toBe('partial-noop');
    expect(partial.identicalCaptureIds).toEqual(['page:evidence@desktop']);
  });
});
