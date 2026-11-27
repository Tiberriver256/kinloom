import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import {
  runScreenshotsCommand,
  SCREENSHOTS_HELP,
  type ScreenshotBrowserFactory,
  type ScreenshotBrowserHandle,
  type ScreenshotContextOptions,
  type ScreenshotCookieSpec,
  type ScreenshotLocatorHandle,
  type ScreenshotPageHandle,
  type ScreenshotsManifest,
} from './screenshots.js';

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MINIMAL_FAKE_PNG = Buffer.concat([PNG_MAGIC_BYTES, Buffer.from('FAKEPNGDATA')]);

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});

function createSyntheticArchiveHtml(pathname: string): string {
  const isPerson = pathname.startsWith('/person/');
  const isTree = pathname === '/tree';
  const isMap = pathname === '/map';
  const isPlugin = pathname === '/stories/demo-reel';

  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8" />
<title>Lincoln Synthetic Archive — ${pathname}</title>
<style>
  body { margin: 0; font-family: sans-serif; background: #f5efe2; color: #23272e; }
  html[data-theme="dark"] body { background: #181c22; color: #f5efe2; }
  header { background: #1b2a41; color: #fcf9f2; padding: 12px 16px; display: flex; gap: 12px; align-items: center; }
  header a { color: #fcf9f2; text-decoration: none; }
  main { padding: 20px; min-height: 320px; }
  footer { padding: 14px 16px; border-top: 1px solid #d6cebe; }
  .menu-panel { position: absolute; top: 52px; right: 16px; background: #fff; color: #111; border: 1px solid #333; padding: 10px; }
  dialog[open] { position: fixed; top: 80px; left: 50%; transform: translateX(-50%); background: #fff; color: #111; padding: 16px; border: 1px solid #222; min-width: 280px; }
</style>
</head>
<body>
  <header>
    <nav aria-label="Primary">
      <a href="/">People</a>
      <a href="/places">Places</a>
      <a href="/tree">Tree</a>
      <a href="/map">Map</a>
      <a href="/stories/demo-reel">Stories</a>
    </nav>
    <button type="button" id="btnSources">Sources</button>
    <button type="button" id="btnSearch" aria-label="Search archive">Search (/)</button>
    <button type="button" id="btnTheme" data-testid="theme-toggle" aria-label="Toggle color theme">Theme</button>
    <button type="button" id="btnMenu" aria-label="Archive menu" aria-haspopup="menu" aria-expanded="false">Menu</button>
    <button type="button" id="btnSignIn">Sign in to edit</button>
  </header>
  <div id="mobileMenu" class="menu-panel" role="menu" hidden>
    <a href="/evidence" role="menuitem">Evidence</a>
  </div>
  <main id="main-content">
    <h1>${isPlugin ? 'Archival Story Reel Plugin' : `Route ${pathname}`}</h1>
    ${
      isPerson
        ? `<span class="pronunciation-badge" data-coverage="full">
             <button type="button" aria-label="Listen to pronunciation of Abraham Lincoln">Play</button>
             <span>AY-bruh-ham LINK-un</span>
             <span role="group" aria-label="Pronunciation variants">
               <button type="button">Primary</button>
               <button type="button">Regional</button>
             </span>
           </span>
           <div data-testid="narrative-audio-margin-bar" role="region" aria-label="Audio narration for Biography">
             Listen to Biography · Charon
           </div>
           <section id="person-media">
             <button type="button" id="mediaThumb" class="person-media-card">1860 Portrait Scan</button>
           </section>
           <div class="kinloom-plugin-slot" data-slot="personDetail">
             <div class="kinloom-plugin-slot-item" data-plugin-id="demo-story-reel">
               Archival Story Spotlight for Abraham Lincoln
             </div>
           </div>`
        : ''
    }
    ${
      isTree
        ? `<div class="tree-toolbar" role="toolbar" aria-label="Family tree view controls">
             <button type="button">Direct Line</button>
             <button type="button">Full Tree</button>
           </div>
           <div class="tree-node"><button type="button" id="treeNodeBtn">Abraham Lincoln (1809-1865)</button></div>
           <aside id="treeFocus" class="tree-focus" aria-label="Focused person" hidden>
             <strong>Abraham Lincoln</strong>
             <button type="button">Clear focus</button>
           </aside>`
        : ''
    }
    ${
      isMap
        ? `<canvas width="300" height="160"></canvas>
           <aside class="map-stage-legend" aria-label="Migration stage color legend">Illinois Era</aside>
           <div class="map-bottom-dock">
             <button type="button" id="nextStopBtn" aria-label="Next stop">Next stop</button>
             <div id="stopCard" hidden>Stop 1: Springfield, Illinois (1837)</div>
           </div>`
        : ''
    }
  </main>
  <footer>Built with Kinloom Synthetic Demo</footer>

  <dialog id="searchDialog" aria-label="Search archive">
    <input type="search" id="searchInput" aria-label="Search the archive" placeholder="Search..." />
    <div id="searchResults">Type to search</div>
  </dialog>
  <dialog id="sourceDialog" aria-label="Source Reader">
    <h2>Source Reader</h2>
    <p>1860 U.S. Federal Census transcription.</p>
  </dialog>
  <dialog id="lightboxDialog" aria-label="Photo and document lightbox">
    <h2>1860 Portrait Scan</h2>
  </dialog>
  <dialog id="signInDialog" aria-label="Sign in to family archive">
    <h2>Sign in to Archive</h2>
  </dialog>

  <script>
    document.getElementById('btnMenu')?.addEventListener('click', () => {
      const m = document.getElementById('mobileMenu');
      if (m) m.hidden = !m.hidden;
    });
    document.getElementById('btnSearch')?.addEventListener('click', () => {
      document.getElementById('searchDialog')?.setAttribute('open', '');
    });
    document.getElementById('searchInput')?.addEventListener('input', (e) => {
      const out = document.getElementById('searchResults');
      if (out) out.textContent = 'Results for: ' + e.target.value;
    });
    document.getElementById('btnTheme')?.addEventListener('click', () => {
      const root = document.documentElement;
      root.setAttribute('data-theme', root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    document.getElementById('btnSources')?.addEventListener('click', () => {
      document.getElementById('sourceDialog')?.setAttribute('open', '');
    });
    document.getElementById('mediaThumb')?.addEventListener('click', () => {
      document.getElementById('lightboxDialog')?.setAttribute('open', '');
    });
    document.getElementById('btnSignIn')?.addEventListener('click', () => {
      document.getElementById('signInDialog')?.setAttribute('open', '');
    });
    document.getElementById('treeNodeBtn')?.addEventListener('click', () => {
      const f = document.getElementById('treeFocus');
      if (f) f.hidden = false;
    });
    document.getElementById('nextStopBtn')?.addEventListener('click', () => {
      const s = document.getElementById('stopCard');
      if (s) s.hidden = false;
    });
  </script>
</body>
</html>`;
}

async function startSyntheticArchiveServer(): Promise<{
  readonly url: string;
  readonly receivedAuthHeaders: string[];
  readonly receivedCookies: string[];
  readonly close: () => Promise<void>;
}> {
  const receivedAuthHeaders: string[] = [];
  const receivedCookies: string[] = [];

  const bundlePayload = {
    people: [
      {
        id: 'person-lincoln',
        slug: 'abraham-lincoln',
        full_name: 'Abraham Lincoln',
        pronunciation: { phonetic: 'AY-bruh-ham LINK-un' },
        event_count: 10,
      },
    ],
    places: [
      {
        id: 'place-springfield',
        slug: 'springfield-il',
        name: 'Springfield, Illinois',
        lat: 39.7817,
        lng: -89.6501,
        description: 'Capital of Illinois.',
      },
    ],
    narratives: [
      {
        id: 'nar-lincoln',
        person_id: 'person-lincoln',
        title: 'Springfield Biography',
        extensions: { narrative_audio: { file: '/media/lincoln.mp3' } },
      },
    ],
    media: [{ id: 'media-1', person_id: 'person-lincoln', caption: '1860 Portrait Scan' }],
  };

  const server = http.createServer((req, res) => {
    if (typeof req.headers['x-preview-auth'] === 'string') {
      receivedAuthHeaders.push(req.headers['x-preview-auth']);
    }
    if (typeof req.headers.cookie === 'string') {
      receivedCookies.push(req.headers.cookie);
    }
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname === '/api/bundle') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(bundlePayload));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(createSyntheticArchiveHtml(reqUrl.pathname));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    receivedAuthHeaders,
    receivedCookies,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
  };
}

describe('runScreenshotsCommand orchestration and redaction', () => {
  it('captures pages/components/plugins, records errors/skips, and never leaks auth credentials', async () => {
    const outDir = await makeTempDir('kinloom-shots-unit-');
    const seenContextOpts: ScreenshotContextOptions[] = [];
    const seenCookies: ScreenshotCookieSpec[][] = [];
    let browserClosed = false;

    const secretCookie = 'kinloom_session=SUPER_SECRET_COOKIE_VALUE_999';
    const secretHeaderValue = 'Bearer SUPER_SECRET_TOKEN_888';

    const fakeBrowserFactory: ScreenshotBrowserFactory = async () => {
      const browser: ScreenshotBrowserHandle = {
        newContext: async (opts) => {
          seenContextOpts.push(opts);
          return {
            addCookies: async (cookies) => {
              seenCookies.push([...cookies]);
            },
            newPage: async () => {
              let currentUrl = '';
              const consoleListeners: Array<(msg: { type(): string; text(): string }) => void> = [];
              const pageErrorListeners: Array<(err: Error) => void> = [];
              const reqFailListeners: Array<
                (req: { url(): string; failure(): { errorText?: string } | null }) => void
              > = [];

              const makeLocator = (selector: string): ScreenshotLocatorHandle => {
                const isSlotVisible = selector.includes('demo-story-reel');
                const isVisibleEl = selector === 'header' || selector === 'footer' || isSlotVisible;
                const handle: ScreenshotLocatorHandle = {
                  count: async () => (isVisibleEl ? 1 : 0),
                  first: () => handle,
                  nth: () => handle,
                  isVisible: async () => isVisibleEl,
                  click: async () => undefined,
                  fill: async () => undefined,
                  screenshot: async ({ path: outPath }) => {
                    await fs.writeFile(outPath, MINIMAL_FAKE_PNG);
                  },
                  boundingBox: async () => (isVisibleEl ? { width: 200, height: 60 } : null),
                  textContent: async () => 'ok',
                };
                return handle;
              };

              const page: ScreenshotPageHandle = {
                goto: async (url) => {
                  currentUrl = url;
                  if (url.endsWith('/broken-route')) {
                    throw new Error(`Navigation failed with header ${secretHeaderValue}`);
                  }
                  if (url.endsWith('/tree')) {
                    for (const fn of consoleListeners) {
                      fn({ type: () => 'error', text: () => `Leaked ${secretCookie}` });
                    }
                    for (const fn of pageErrorListeners) {
                      fn(new Error(`Page crash ${secretHeaderValue}`));
                    }
                    for (const fn of reqFailListeners) {
                      fn({
                        url: () => 'https://demo.kinloom.example/tile.png?token=TOPSECRET',
                        failure: () => ({ errorText: 'net::ERR_TIMED_OUT' }),
                      });
                    }
                  }
                },
                screenshot: async ({ path: outPath }) => {
                  await fs.writeFile(outPath, MINIMAL_FAKE_PNG);
                },
                locator: (selector) => makeLocator(selector),
                evaluate: async (expr) => {
                  if (expr.includes('header a[href]')) {
                    return [{ href: '/stories/demo-reel', text: 'Stories' }] as never;
                  }
                  if (expr.includes('data-kinloom-plugin-slot')) {
                    if (currentUrl.includes('/person/')) {
                      return [
                        {
                          pluginId: 'demo-story-reel',
                          slotName: 'personDetail',
                          selector: '[data-plugin-id="demo-story-reel"]',
                        },
                        {
                          pluginId: 'hidden-slot',
                          slotName: 'appShell',
                          selector: '[data-plugin-id="hidden-slot"]',
                        },
                      ] as never;
                    }
                    return [] as never;
                  }
                  return true as never;
                },
                waitForTimeout: async () => undefined,
                waitForSelector: async () => undefined,
                keyboard: { press: async () => undefined },
                on: ((event: string, listener: unknown) => {
                  if (event === 'console') {
                    consoleListeners.push(listener as (msg: { type(): string; text(): string }) => void);
                  } else if (event === 'pageerror') {
                    pageErrorListeners.push(listener as (err: Error) => void);
                  } else if (event === 'requestfailed') {
                    reqFailListeners.push(
                      listener as (req: { url(): string; failure(): { errorText?: string } | null }) => void
                    );
                  }
                }) as ScreenshotPageHandle['on'],
                close: async () => undefined,
              };
              return page;
            },
            close: async () => undefined,
          };
        },
        close: async () => {
          browserClosed = true;
        },
      };
      return browser;
    };

    const mockFetch: typeof fetch = async (input) => {
      if (String(input).endsWith('/api/bundle')) {
        return new Response(
          JSON.stringify({
            people: [{ id: 'p1', slug: 'abraham-lincoln', full_name: 'Abraham Lincoln' }],
            places: [{ id: 'pl1', slug: 'springfield-il', name: 'Springfield, Illinois' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const result = await runScreenshotsCommand({
      url: 'https://demo.kinloom.example',
      outDir,
      viewports: [
        { name: 'mobile', width: 390, height: 844 },
        { name: 'desktop', width: 1440, height: 900 },
      ],
      themes: ['light'],
      include: ['pages', 'components', 'plugins'],
      routes: ['/broken-route'],
      pluginRoutes: ['/extra-plugin'],
      authCookie: secretCookie,
      authHeaders: [{ name: 'Authorization', value: secretHeaderValue }],
      waitMs: 0,
      timeoutMs: 2_000,
      concurrency: 2,
      json: true,
      fetchImpl: mockFetch,
      browserFactory: fakeBrowserFactory,
      now: () => new Date('2026-11-27T12:00:00.000Z'),
    });

    expect(browserClosed).toBe(true);
    expect(result.ok).toBe(false);
    expect(seenContextOpts[0]?.extraHTTPHeaders?.Authorization).toBe(secretHeaderValue);
    expect(seenCookies[0]?.[0]?.name).toBe('kinloom_session');

    const manifestRaw = await fs.readFile(result.manifestPath, 'utf8');
    const htmlRaw = await fs.readFile(result.indexHtmlPath, 'utf8');
    expect(manifestRaw).not.toContain('SUPER_SECRET_COOKIE_VALUE_999');
    expect(manifestRaw).not.toContain('SUPER_SECRET_TOKEN_888');
    expect(manifestRaw).not.toContain('TOPSECRET');
    expect(htmlRaw).not.toContain('SUPER_SECRET_COOKIE_VALUE_999');
    expect(htmlRaw).not.toContain('SUPER_SECRET_TOKEN_888');
    expect(htmlRaw).not.toContain('TOPSECRET');
    expect(result.rendered).not.toContain('SUPER_SECRET_COOKIE_VALUE_999');
    expect(result.rendered).not.toContain('SUPER_SECRET_TOKEN_888');

    const parsedManifest = JSON.parse(manifestRaw) as ScreenshotsManifest;
    expect(parsedManifest.summary.failed).toBe(2);
    expect(parsedManifest.summary.captured).toBeGreaterThan(10);
    expect(parsedManifest.summary.skipped).toBeGreaterThan(10);
    // /tree is visited by page:tree, component:tree-controls, and component:tree-focus-card (3 × 2 viewports = 6 visits)
    expect(parsedManifest.summary.consoleErrorCount).toBe(12);
    expect(parsedManifest.summary.failedRequestCount).toBe(6);
    expect(
      parsedManifest.captures.some(
        (c) => c.category === 'plugin' && c.slug === 'stories-demo-reel' && c.status === 'captured'
      )
    ).toBe(true);
    expect(
      parsedManifest.captures.some(
        (c) => c.category === 'plugin' && c.slug === 'slot-hidden-slot-appshell' && c.status === 'skipped'
      )
    ).toBe(true);
  });

  it('handles components-only scope and recovers when live DOM discovery fails', async () => {
    const outDir = await makeTempDir('kinloom-shots-componly-');
    let contextCalls = 0;
    const browserFactory: ScreenshotBrowserFactory = async () => ({
      newContext: async () => {
        contextCalls += 1;
        return {
          newPage: async () => ({
            goto: async () => {
              if (contextCalls === 1) {
                throw 'string-failure';
              }
            },
            screenshot: async ({ path: outPath }) => {
              await fs.writeFile(outPath, MINIMAL_FAKE_PNG);
            },
            locator: () => {
              const handle: ScreenshotLocatorHandle = {
                count: async () => 0,
                first: () => handle,
                nth: () => handle,
                isVisible: async () => false,
                click: async () => undefined,
                fill: async () => undefined,
                screenshot: async () => undefined,
                boundingBox: async () => null,
                textContent: async () => null,
              };
              return handle;
            },
            evaluate: async () => true as never,
            waitForTimeout: async () => undefined,
            waitForSelector: async () => undefined,
            keyboard: { press: async () => undefined },
            on: () => undefined,
            close: async () => undefined,
          }),
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    });

    const compOnly = await runScreenshotsCommand({
      url: 'https://demo.kinloom.example',
      outDir,
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      themes: ['light'],
      include: ['components'],
      waitMs: 0,
      fetchImpl: async () => new Response('missing', { status: 404 }),
      browserFactory,
    });
    expect(compOnly.manifest.summary.byCategory.page).toBe(0);
    expect(compOnly.manifest.summary.byCategory.component).toBe(16);
    expect(compOnly.manifest.summary.skipped).toBe(1);
    expect(compOnly.manifest.summary.failed).toBe(15);
    expect(compOnly.rendered).toContain('string-failure');

    contextCalls = 0;
    const discoveryFail = await runScreenshotsCommand({
      url: 'https://demo.kinloom.example',
      outDir,
      viewports: [{ name: 'desktop', width: 1440, height: 900 }],
      themes: ['light'],
      include: ['pages'],
      waitMs: 0,
      fetchImpl: async () => new Response('missing', { status: 404 }),
      browserFactory: async () => ({
        newContext: async () => {
          contextCalls += 1;
          if (contextCalls === 1) {
            throw new Error('discovery context exploded');
          }
          return {
            newPage: async () => ({
              goto: async () => undefined,
              screenshot: async ({ path: outPath }) => {
                await fs.writeFile(outPath, MINIMAL_FAKE_PNG);
              },
              locator: () => {
                throw new Error('unused');
              },
              evaluate: async () => true as never,
              waitForTimeout: async () => undefined,
              waitForSelector: async () => undefined,
              keyboard: { press: async () => undefined },
              on: () => undefined,
              close: async () => undefined,
            }),
            close: async () => undefined,
          };
        },
        close: async () => undefined,
      }),
    });
    expect(discoveryFail.ok).toBe(true);
    expect(discoveryFail.manifest.summary.captured).toBeGreaterThan(0);
  });

  it('rejects out-of-range numeric run options at the boundary', async () => {
    await expect(runScreenshotsCommand({ url: 'http://127.0.0.1:4173', samplePeople: -1 })).rejects.toThrow(
      '--sample-people'
    );
    await expect(runScreenshotsCommand({ url: 'http://127.0.0.1:4173', samplePlaces: 25 })).rejects.toThrow(
      '--sample-places'
    );
    await expect(runScreenshotsCommand({ url: 'http://127.0.0.1:4173', waitMs: -5 })).rejects.toThrow(
      '--wait-ms'
    );
    await expect(runScreenshotsCommand({ url: 'http://127.0.0.1:4173', timeoutMs: 100 })).rejects.toThrow(
      '--timeout-ms'
    );
    await expect(runScreenshotsCommand({ url: 'http://127.0.0.1:4173', concurrency: 99 })).rejects.toThrow(
      '--concurrency'
    );
  });
});

describe('kinloom screenshots CLI + live Playwright integration', () => {
  it('validates CLI flags and prints SCREENSHOTS_HELP', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    const helpCode = await runCli(['screenshots', '--help'], { io });
    expect(helpCode).toBe(0);
    expect(stdout.join('\n')).toBe(SCREENSHOTS_HELP);

    stderr.length = 0;
    const missingUrlCode = await runCli(['screenshots'], { io });
    expect(missingUrlCode).toBe(2);
    expect(stderr.join('\n')).toContain('--url');

    stderr.length = 0;
    const conflictCode = await runCli(
      ['screenshots', '--url', 'http://127.0.0.1:4173', '--full-page', '--no-full-page'],
      { io }
    );
    expect(conflictCode).toBe(2);
    expect(stderr.join('\n')).toContain('not both');

    stderr.length = 0;
    const badSampleCode = await runCli(
      ['screenshots', '--url', 'http://127.0.0.1:4173', '--sample-people=-1'],
      { io }
    );
    expect(badSampleCode).toBe(2);
    expect(stderr.join('\n')).toContain('non-negative integer');
  });

  it('runs real Playwright against a local HTTP archive server and writes valid PNGs, manifest.json, and index.html', async () => {
    const server = await startSyntheticArchiveServer();
    const outDir = await makeTempDir('kinloom-shots-live-');
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const exitCode = await runCli(
        [
          'screenshots',
          '--url',
          server.url,
          '--out-dir',
          outDir,
          '--viewports',
          'mobile:390x844,desktop:1280x800',
          '--themes',
          'light',
          '--include',
          'pages,components,plugins',
          '--routes',
          '/privacy',
          '--plugin-routes',
          '/stories/demo-reel',
          '--sample-people',
          '1',
          '--sample-places',
          '1',
          '--auth-cookie',
          'demo_sid=LOCAL_SECRET_COOKIE_42',
          '--auth-header',
          'X-Preview-Auth: LOCAL_SECRET_HEADER_99',
          '--wait-ms',
          '0',
          '--timeout-ms',
          '12000',
          '--concurrency',
          '2',
          '--json',
        ],
        {
          io: {
            stdout: (line) => stdout.push(line),
            stderr: (line) => stderr.push(line),
          },
        }
      );

      expect(stderr).toEqual([]);
      expect(exitCode).toBe(0);
      expect(server.receivedAuthHeaders).toContain('LOCAL_SECRET_HEADER_99');
      expect(server.receivedCookies.some((c) => c.includes('LOCAL_SECRET_COOKIE_42'))).toBe(true);

      const defaultOutCwd = await makeTempDir('kinloom-shots-default-cwd-');
      const textStdout: string[] = [];
      const darkExit = await runCli(
        [
          'screenshots',
          '--url',
          server.url,
          '--viewports',
          'desktop:1280x800',
          '--themes',
          'dark',
          '--include',
          'pages',
          '--no-full-page',
          '--wait-ms',
          '0',
        ],
        {
          cwd: defaultOutCwd,
          io: {
            stdout: (line) => textStdout.push(line),
            stderr: (line) => stderr.push(line),
          },
        }
      );
      expect(darkExit).toBe(0);
      expect(textStdout.join('\n')).toContain('Kinloom UI Screenshots Export');
      const defaultManifestStat = await fs.stat(
        path.join(defaultOutCwd, 'kinloom-screenshots', 'manifest.json')
      );
      expect(defaultManifestStat.isFile()).toBe(true);

      const manifestRaw = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8');
      const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
      expect(manifestRaw).not.toContain('LOCAL_SECRET_COOKIE_42');
      expect(manifestRaw).not.toContain('LOCAL_SECRET_HEADER_99');
      expect(indexHtml).not.toContain('LOCAL_SECRET_COOKIE_42');
      expect(indexHtml).not.toContain('LOCAL_SECRET_HEADER_99');

      const manifest = JSON.parse(manifestRaw) as ScreenshotsManifest;
      expect(manifest.summary.failed).toBe(0);
      expect(manifest.summary.byCategory.page).toBeGreaterThan(0);
      expect(manifest.summary.byCategory.component).toBeGreaterThan(0);
      expect(manifest.summary.byCategory.plugin).toBeGreaterThan(0);

      const samplePage = manifest.captures.find(
        (c) => c.category === 'page' && c.slug === 'home' && c.status === 'captured' && c.file
      );
      const sampleComponent = manifest.captures.find(
        (c) => c.category === 'component' && c.slug === 'global-search' && c.state === 'results' && c.file
      );
      const samplePluginRoute = manifest.captures.find(
        (c) => c.category === 'plugin' && c.slug === 'stories-demo-reel' && c.file
      );
      const samplePluginSlot = manifest.captures.find(
        (c) => c.category === 'plugin' && c.slug.startsWith('slot-demo-story-reel') && c.file
      );

      expect(samplePage?.file).toBe('pages/home/mobile-light.png');
      expect(sampleComponent?.file).toBe('components/global-search/results/mobile-light.png');
      expect(samplePluginRoute?.file).toBe('plugins/stories-demo-reel/mobile-light.png');
      expect(samplePluginSlot?.file).toBe('plugins/slot-demo-story-reel-persondetail/mobile-light.png');

      for (const entry of [samplePage, sampleComponent, samplePluginRoute, samplePluginSlot]) {
        expect(entry?.file).toBeTruthy();
        const pngBytes = await fs.readFile(path.join(outDir, ...(entry?.file ?? '').split('/')));
        expect(pngBytes.subarray(0, 8).equals(PNG_MAGIC_BYTES)).toBe(true);
        expect(pngBytes.length).toBeGreaterThan(200);
      }

      expect(indexHtml).toContain('Kinloom UI Review Contact Sheet');
      expect(indexHtml).toContain('pages/home/mobile-light.png');
      expect(indexHtml).toContain('plugins/stories-demo-reel/mobile-light.png');
    } finally {
      await server.close();
    }
  }, 30_000);
});
