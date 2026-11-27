import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const PNG_MAGIC_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_ENTRYPOINT = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');

interface ScreenshotsManifestSubset {
  readonly summary: {
    readonly failed: number;
    readonly byCategory: {
      readonly page: number;
      readonly component: number;
      readonly plugin: number;
    };
  };
  readonly captures: ReadonlyArray<{
    readonly category: string;
    readonly slug: string;
    readonly state: string;
    readonly status: string;
    readonly file: string | null;
  }>;
}

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

function runCliProcess(
  args: readonly string[],
  options: { readonly cwd: string }
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRYPOINT, ...args],
      { cwd: options.cwd, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        const errCode = typeof error.code === 'number' ? error.code : null;
        if (errCode !== null) {
          resolve({ exitCode: errCode, stdout, stderr });
          return;
        }
        reject(error);
      }
    );
  });
}

test('kinloom screenshots CLI captures real Chromium PNGs, manifest.json, and index.html with secret redaction', async () => {
  test.setTimeout(90_000);
  const server = await startSyntheticArchiveServer();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kinloom-e2e-shots-'));
  const defaultOutCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'kinloom-e2e-shots-cwd-'));

  try {
    const jsonRun = await runCliProcess(
      [
        'screenshots',
        '--url',
        server.url,
        '--out-dir',
        outDir,
        '--viewports',
        'mobile:390x844',
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
        '15000',
        '--concurrency',
        '1',
        '--json',
      ],
      { cwd: REPO_ROOT }
    );

    expect(jsonRun.stderr).toBe('');
    expect(jsonRun.exitCode).toBe(0);
    expect(server.receivedAuthHeaders).toContain('LOCAL_SECRET_HEADER_99');
    expect(server.receivedCookies.some((c) => c.includes('LOCAL_SECRET_COOKIE_42'))).toBe(true);

    const manifestRaw = await fs.readFile(path.join(outDir, 'manifest.json'), 'utf8');
    const indexHtml = await fs.readFile(path.join(outDir, 'index.html'), 'utf8');
    expect(manifestRaw).not.toContain('LOCAL_SECRET_COOKIE_42');
    expect(manifestRaw).not.toContain('LOCAL_SECRET_HEADER_99');
    expect(indexHtml).not.toContain('LOCAL_SECRET_COOKIE_42');
    expect(indexHtml).not.toContain('LOCAL_SECRET_HEADER_99');
    expect(jsonRun.stdout).not.toContain('LOCAL_SECRET_COOKIE_42');
    expect(jsonRun.stdout).not.toContain('LOCAL_SECRET_HEADER_99');

    const manifest = JSON.parse(manifestRaw) as ScreenshotsManifestSubset;
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

    const darkTextRun = await runCliProcess(
      [
        'screenshots',
        '--url',
        server.url,
        '--viewports',
        'desktop:1280x800',
        '--themes',
        'dark',
        '--include',
        'plugins',
        '--plugin-routes',
        '/stories/demo-reel',
        '--sample-people',
        '0',
        '--sample-places',
        '0',
        '--no-full-page',
        '--wait-ms',
        '0',
      ],
      { cwd: defaultOutCwd }
    );
    expect(darkTextRun.stderr).toBe('');
    expect(darkTextRun.exitCode).toBe(0);
    expect(darkTextRun.stdout).toContain('Kinloom UI Screenshots Export');
    const defaultManifestStat = await fs.stat(
      path.join(defaultOutCwd, 'kinloom-screenshots', 'manifest.json')
    );
    expect(defaultManifestStat.isFile()).toBe(true);
  } finally {
    await server.close();
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(defaultOutCwd, { recursive: true, force: true });
  }
});
