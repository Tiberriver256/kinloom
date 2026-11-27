#!/usr/bin/env node
/**
 * Generates Kinloom's GitHub Social Preview (1280x640) and live demo showcase
 * screenshots (1280x800) from the built public-domain demo in examples/demo/dist.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DEMO_DIST = path.join(REPO_ROOT, 'examples/demo/dist');
const ASSETS_DIR = path.join(REPO_ROOT, 'docs/assets');

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

function startDemoServer(distDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0];
      const normalized = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
      const candidate = path.join(distDir, normalized === '/' ? 'index.html' : normalized);
      const filePath =
        fs.existsSync(candidate) && fs.statSync(candidate).isFile()
          ? candidate
          : path.join(distDir, 'index.html');
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to bind ephemeral demo server port.'));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function buildSocialPreviewHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;0,6..72,700;1,6..72,400&display=swap"
      rel="stylesheet"
    />
    <style>
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      html,
      body {
        width: 1280px;
        height: 640px;
        overflow: hidden;
        background: #1f242d;
        color: #f8f4ec;
        font-family: 'Newsreader', Georgia, 'Times New Roman', serif;
        -webkit-font-smoothing: antialiased;
      }
      .canvas {
        position: relative;
        width: 1280px;
        height: 640px;
        background:
          radial-gradient(circle at 84% 18%, rgba(200, 138, 75, 0.14), transparent 44%),
          radial-gradient(circle at 12% 92%, rgba(248, 244, 236, 0.05), transparent 40%),
          #1f242d;
        padding: 36px 40px;
        display: flex;
      }
      .frame {
        position: relative;
        flex: 1;
        border: 1px solid rgba(200, 138, 75, 0.32);
        border-radius: 4px;
        padding: 44px 52px;
        display: grid;
        grid-template-columns: 1.38fr 0.92fr;
        gap: 48px;
        align-items: center;
        overflow: hidden;
      }
      .top-rule {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 5px;
        display: flex;
      }
      .top-rule-brass {
        width: 34%;
        background: #c88a4b;
      }
      .top-rule-slate {
        flex: 1;
        background: rgba(248, 244, 236, 0.18);
      }
      .left {
        display: flex;
        flex-direction: column;
        gap: 24px;
      }
      .brand-row {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .brand-name {
        font-family: 'Newsreader', Georgia, serif;
        font-size: 32px;
        font-weight: 500;
        letter-spacing: -0.015em;
        color: #f8f4ec;
      }
      .brand-tag {
        margin-left: 4px;
        padding: 4px 10px;
        border: 1px solid rgba(200, 138, 75, 0.45);
        border-radius: 3px;
        font-family: 'IBM Plex Mono', ui-monospace, monospace;
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #e6ba83;
        background: rgba(200, 138, 75, 0.1);
      }
      .headline {
        font-size: 50px;
        line-height: 1.12;
        font-weight: 600;
        letter-spacing: -0.02em;
        color: #f8f4ec;
      }
      .headline em {
        font-style: italic;
        font-weight: 500;
        color: #e6ba83;
      }
      .brass-rule {
        width: 88px;
        height: 3px;
        background: #c88a4b;
        border-radius: 2px;
      }
      .subtitle {
        font-size: 21px;
        line-height: 1.48;
        color: #d6cfc2;
        max-width: 580px;
      }
      .chips {
        display: grid;
        grid-template-columns: repeat(2, max-content);
        gap: 10px 12px;
        margin-top: 4px;
      }
      .chip {
        font-family: 'IBM Plex Mono', ui-monospace, monospace;
        font-size: 12.5px;
        font-weight: 500;
        letter-spacing: 0.03em;
        color: #f8f4ec;
        background: rgba(248, 244, 236, 0.06);
        border: 1px solid rgba(248, 244, 236, 0.18);
        border-radius: 3px;
        padding: 6px 12px;
      }
      .folio {
        background: #f8f4ec;
        color: #1f242d;
        border-radius: 4px;
        border: 1px solid rgba(200, 138, 75, 0.55);
        box-shadow: 0 18px 44px rgba(0, 0, 0, 0.38);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      .folio-bar {
        height: 4px;
        display: flex;
      }
      .folio-bar-left {
        width: 38%;
        background: #c88a4b;
      }
      .folio-bar-right {
        flex: 1;
        background: #1f242d;
      }
      .folio-body {
        padding: 24px 26px 22px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .folio-meta {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-family: 'IBM Plex Mono', ui-monospace, monospace;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: #7a4612;
      }
      .folio-title {
        font-size: 22px;
        font-weight: 600;
        line-height: 1.2;
        color: #1f242d;
        border-bottom: 1px solid #d6cebe;
        padding-bottom: 12px;
      }
      .diagram-box {
        background: #f1eadc;
        border: 1px solid #d6cebe;
        border-radius: 3px;
        padding: 16px 14px;
        display: flex;
        justify-content: center;
        align-items: center;
      }
      .folio-badges {
        display: flex;
        gap: 6px;
        flex-wrap: nowrap;
        justify-content: space-between;
      }
      .pill {
        font-family: 'IBM Plex Mono', ui-monospace, monospace;
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.03em;
        padding: 4px 7px;
        border-radius: 2px;
        white-space: nowrap;
      }
      .pill-cited {
        background: #dfece6;
        color: #244a3c;
      }
      .pill-memory {
        background: #f3e4c8;
        color: #6b3d0e;
      }
      .pill-ledger {
        background: #e6e2d8;
        color: #1f242d;
      }
      .folio-footer {
        border-top: 1px solid #d6cebe;
        padding-top: 12px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-family: 'IBM Plex Mono', ui-monospace, monospace;
        font-size: 11.5px;
        color: #4e4a42;
      }
    </style>
  </head>
  <body>
    <div class="canvas">
      <div class="frame">
        <div class="top-rule">
          <div class="top-rule-brass"></div>
          <div class="top-rule-slate"></div>
        </div>

        <div class="left">
          <div class="brand-row">
            <svg width="38" height="38" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M8 2.5V13.5M8 18.5V21.5" stroke="#F8F4EC" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M16 2.5V5.5M16 10.5V21.5" stroke="#F8F4EC" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M2.5 8H5.5M10.5 8H21.5" stroke="#C88A4B" stroke-width="2.4" stroke-linecap="round"/>
              <path d="M2.5 16H13.5M18.5 16H21.5" stroke="#F8F4EC" stroke-width="2.4" stroke-linecap="round"/>
            </svg>
            <span class="brand-name">Kinloom</span>
            <span class="brand-tag">MIT Open Source</span>
          </div>

          <h1 class="headline">
            Weave primary sources,<br />
            places, and <em>family memory</em><br />
            into one living archive.
          </h1>

          <div class="brass-rule"></div>

          <p class="subtitle">
            Collaborative family history wiki with interactive pedigree trees, historical migration maps, a living-person privacy fence, and a TypeScript archival CLI.
          </p>

          <div class="chips">
            <span class="chip">GEDCOM 7 + EDTF</span>
            <span class="chip">Cloudflare D1 + R2</span>
            <span class="chip">23 Archive CLI Tools</span>
            <span class="chip">WCAG AAA Paper &amp; Ink</span>
          </div>
        </div>

        <div class="folio">
          <div class="folio-bar">
            <div class="folio-bar-left"></div>
            <div class="folio-bar-right"></div>
          </div>
          <div class="folio-body">
            <div class="folio-meta">
              <span>Archival Folio</span>
              <span>10 Generations · 1622–1985</span>
            </div>
            <div class="folio-title">Primary-Source Family Explorer</div>
            <div class="diagram-box">
              <svg width="320" height="194" viewBox="0 0 320 194" fill="none" aria-hidden="true">
                <!-- Background subtle archival grid lines -->
                <line x1="16" y1="26" x2="304" y2="26" stroke="#DFD7C6" stroke-width="1" stroke-dasharray="3 4"/>
                <line x1="16" y1="78" x2="304" y2="78" stroke="#DFD7C6" stroke-width="1" stroke-dasharray="3 4"/>
                <line x1="16" y1="130" x2="304" y2="130" stroke="#DFD7C6" stroke-width="1" stroke-dasharray="3 4"/>
                <line x1="16" y1="176" x2="304" y2="176" stroke="#DFD7C6" stroke-width="1" stroke-dasharray="3 4"/>

                <!-- Generation connectors (muted branches) -->
                <path d="M52 26 V78 M124 26 V78 M196 26 V78 M268 26 V78" stroke="#A69D8E" stroke-width="2"/>
                <path d="M52 78 V130 H124 V78 M196 78 V130 H268 V78" stroke="#A69D8E" stroke-width="2"/>
                <path d="M88 130 V156 H232 V130" stroke="#A69D8E" stroke-width="2"/>

                <!-- Highlighted direct-line brass weave -->
                <path d="M124 26 V130 H88 V156 H160 V176" stroke="#C88A4B" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>

                <!-- Nodes row 1 -->
                <circle cx="52" cy="26" r="5" fill="#A69D8E"/>
                <circle cx="124" cy="26" r="6.5" fill="#1F242D" stroke="#C88A4B" stroke-width="2"/>
                <circle cx="196" cy="26" r="5" fill="#A69D8E"/>
                <circle cx="268" cy="26" r="5" fill="#A69D8E"/>

                <!-- Nodes row 2 -->
                <circle cx="52" cy="78" r="5.5" fill="#8C8375"/>
                <circle cx="124" cy="78" r="7" fill="#1F242D"/>
                <circle cx="196" cy="78" r="5.5" fill="#8C8375"/>
                <circle cx="268" cy="78" r="5.5" fill="#8C8375"/>

                <!-- Nodes row 3 -->
                <circle cx="52" cy="130" r="6" fill="#7D7568"/>
                <circle cx="124" cy="130" r="7.5" fill="#C88A4B"/>
                <circle cx="88" cy="130" r="7" fill="#1F242D"/>
                <circle cx="232" cy="130" r="6" fill="#7D7568"/>

                <!-- Root focal node -->
                <circle cx="160" cy="176" r="9.5" fill="#C88A4B" stroke="#1F242D" stroke-width="2.5"/>
              </svg>
            </div>

            <div class="folio-badges">
              <span class="pill pill-cited">CITED SOURCES</span>
              <span class="pill pill-memory">FAMILY MEMORY</span>
              <span class="pill pill-ledger">REVISION LEDGER</span>
            </div>

            <div class="folio-footer">
              <span>tiberriver256.github.io/kinloom</span>
              <span>@kinloom/cli</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

async function waitForPageReady(page, selector, { waitForNetworkIdle = false, extraDelayMs = 600 } = {}) {
  await page.waitForSelector(selector, { state: 'visible', timeout: 20_000 });
  if (waitForNetworkIdle) {
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  }
  await page.evaluate(async () => {
    await document.fonts.ready;
    const images = Array.from(document.images);
    await Promise.all(
      images.map((img) =>
        img.complete
          ? Promise.resolve()
          : Promise.race([
              new Promise((res) => {
                img.addEventListener('load', res, { once: true });
                img.addEventListener('error', res, { once: true });
              }),
              new Promise((res) => setTimeout(res, 5000)),
            ])
      )
    );
  });
  await page.waitForTimeout(extraDelayMs);
}

async function main() {
  if (!fs.existsSync(path.join(DEMO_DIST, 'index.html'))) {
    throw new Error('examples/demo/dist is missing. Run `npm run build --workspace=@kinloom/demo` first.');
  }
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const { server, url } = await startDemoServer(DEMO_DIST);
  const browser = await chromium.launch({ headless: true });
  try {
    // 1. Generate 1280x640 GitHub Social Preview
    const socialContext = await browser.newContext({
      viewport: { width: 1280, height: 640 },
      deviceScaleFactor: 1,
    });
    const socialPage = await socialContext.newPage();
    await socialPage.setContent(buildSocialPreviewHtml(), { waitUntil: 'networkidle' });
    await socialPage.evaluate(() => document.fonts.ready);
    await socialPage.waitForTimeout(300);
    const socialOut = path.join(ASSETS_DIR, 'social-preview.png');
    await socialPage.screenshot({ path: socialOut, type: 'png' });
    await socialContext.close();
    console.log(`Wrote ${path.relative(REPO_ROOT, socialOut)} (1280x640)`);

    // 2. Capture 1280x800 live demo screenshots (isolated contexts keep WebGL/map memory bounded)
    const errors = [];
    const shots = [
      {
        file: 'demo-home.png',
        route: '/',
        selector: 'h1',
        waitForNetworkIdle: true,
        delayMs: 500,
      },
      {
        file: 'demo-tree.png',
        route: '/tree',
        selector: '[role="group"]',
        waitForNetworkIdle: true,
        delayMs: 700,
      },
      {
        file: 'demo-person.png',
        route: '/person/abraham-lincoln-1809',
        selector: 'h1',
        waitForNetworkIdle: true,
        delayMs: 700,
      },
      {
        file: 'demo-map.png',
        route: '/map',
        selector: '.map-canvas',
        waitForNetworkIdle: true,
        delayMs: 3500,
      },
    ];

    for (const shot of shots) {
      const demoContext = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1,
      });
      const page = await demoContext.newPage();
      page.on('pageerror', (err) => errors.push(`${shot.route} pageerror: ${err.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          if (!text.includes('openhistoricalmap.org')) {
            errors.push(`${shot.route} console.error: ${text}`);
          }
        }
      });
      await page.goto(`${url}${shot.route}`, { waitUntil: 'domcontentloaded' });
      await waitForPageReady(page, shot.selector, {
        waitForNetworkIdle: shot.waitForNetworkIdle,
        extraDelayMs: shot.delayMs,
      });
      const outPath = path.join(ASSETS_DIR, shot.file);
      await page.screenshot({ path: outPath, type: 'png' });
      await demoContext.close();
      console.log(`Wrote ${path.relative(REPO_ROOT, outPath)} (1280x800) from ${shot.route}`);
    }

    if (errors.length > 0) {
      throw new Error(`Demo screenshot capture observed runtime errors:\n${errors.join('\n')}`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
