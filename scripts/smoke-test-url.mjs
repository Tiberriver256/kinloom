#!/usr/bin/env node
import { createRequire } from 'node:module';
/**
 * Reusable post-deploy Playwright browser smoke test for Kinloom archives.
 * Usage:
 *   node scripts/smoke-test-url.mjs --url https://example.org/ --expect-gate
 *   node scripts/smoke-test-url.mjs --url https://example.org/ --expect-archive
 */
import path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '../package.json'));
const { chromium } = require('@playwright/test');

function parseArgs(argv) {
  let url = null;
  let mode = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) {
      url = argv[i + 1];
      i += 1;
    } else if (arg === '--expect-gate') {
      mode = 'gate';
    } else if (arg === '--expect-archive') {
      mode = 'archive';
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node scripts/smoke-test-url.mjs --url <https://...> [--expect-gate | --expect-archive]'
      );
      process.exit(0);
    }
  }
  if (!url) {
    console.error('Error: --url <https://...> is required.');
    process.exit(2);
  }
  try {
    new URL(url);
  } catch {
    console.error(`Error: invalid --url value "${url}".`);
    process.exit(2);
  }
  return { url, mode };
}

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

async function inspectViewport(page, mode, phaseLabel) {
  const failures = [];
  const summary = await page.evaluate((expectMode) => {
    const root = document.querySelector('#root');
    const rootTextLen = root?.textContent?.trim().length ?? 0;
    const h1 = document.querySelector('h1')?.textContent?.trim() ?? null;
    const docEl = document.documentElement;
    const clientWidth = docEl.clientWidth;
    const scrollWidth = docEl.scrollWidth;

    let cssRules = 0;
    for (const sheet of document.styleSheets) {
      try {
        cssRules += sheet.cssRules.length;
      } catch {
        // Cross-origin font stylesheet
      }
    }

    const emailInput = document.querySelector('input[type="email"]');
    const magicLinkBtn = [...document.querySelectorAll('button')].find((b) =>
      /magic link/i.test(b.textContent ?? '')
    );
    const personLinks = document.querySelectorAll('a[href*="/person/"]').length;

    const brokenImages = [];
    if (expectMode === 'archive') {
      for (const img of document.querySelectorAll('img')) {
        const style = getComputedStyle(img);
        if (style.display === 'none' || style.visibility === 'hidden') {
          continue;
        }
        // Only flag images that were eagerly loaded or have completed with zero width.
        const rect = img.getBoundingClientRect();
        const inViewport = rect.top < window.innerHeight * 1.5 && rect.bottom > -200;
        if ((inViewport || img.loading !== 'lazy') && (!img.complete || img.naturalWidth === 0)) {
          brokenImages.push(img.getAttribute('src') ?? '(missing src)');
        }
      }
    }

    return {
      rootTextLen,
      h1,
      clientWidth,
      scrollWidth,
      cssRules,
      hasEmailInput: Boolean(emailInput),
      hasMagicLinkBtn: Boolean(magicLinkBtn),
      personLinks,
      brokenImages,
    };
  }, mode);

  if (summary.rootTextLen === 0) {
    failures.push(`${phaseLabel}: #root is empty`);
  }
  if (!summary.h1) {
    failures.push(`${phaseLabel}: missing visible <h1> landmark`);
  }
  if (summary.cssRules <= 100) {
    failures.push(`${phaseLabel}: expected >100 CSS rules loaded, measured ${summary.cssRules}`);
  }
  if (summary.scrollWidth > summary.clientWidth) {
    failures.push(`${phaseLabel}: horizontal overflow (${summary.scrollWidth}px > ${summary.clientWidth}px)`);
  }
  if (mode === 'gate') {
    if (!summary.hasEmailInput) {
      failures.push(`${phaseLabel}: missing email input on private archive gate`);
    }
    if (!summary.hasMagicLinkBtn) {
      failures.push(`${phaseLabel}: missing Magic Link submit button on private archive gate`);
    }
  } else if (mode === 'archive') {
    if (summary.personLinks === 0) {
      failures.push(`${phaseLabel}: expected person links on archive index, found 0`);
    }
    if (summary.brokenImages.length > 0) {
      failures.push(
        `${phaseLabel}: ${summary.brokenImages.length} broken image(s): ${summary.brokenImages.slice(0, 5).join(', ')}`
      );
    }
  }

  return { summary, failures };
}

async function run() {
  const { url, mode } = parseArgs(process.argv.slice(2));
  const browser = await chromium.launch({ headless: true });
  const allFailures = [];

  try {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
      });
      const page = await context.newPage();
      const pageerrors = [];
      const failedAssets = [];

      page.on('pageerror', (err) => {
        pageerrors.push(String(err));
      });
      page.on('response', (res) => {
        const resUrl = res.url();
        let pathname = '';
        try {
          pathname = new URL(resUrl).pathname;
        } catch {
          pathname = resUrl;
        }
        if (pathname.includes('/assets/') && res.status() >= 400) {
          failedAssets.push(`${res.status()} ${pathname}`);
        }
      });

      const initialRes = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
      if (!initialRes || initialRes.status() >= 400) {
        allFailures.push(`[${vp.name} initial] HTTP ${initialRes?.status() ?? 'NO_RESPONSE'} loading ${url}`);
      }
      await page
        .locator('h1')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {});

      const initialCheck = await inspectViewport(page, mode, `[${vp.name} initial]`);
      allFailures.push(...initialCheck.failures);

      const assetsBeforeReload = failedAssets.length;
      const errorsBeforeReload = pageerrors.length;

      // Explicit reload catches 304 -> 404 Cloudflare ASSETS / SPA fallback regressions.
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      await page
        .locator('h1')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {});

      const reloadCheck = await inspectViewport(page, mode, `[${vp.name} reload]`);
      allFailures.push(...reloadCheck.failures);

      if (pageerrors.length > 0) {
        allFailures.push(
          `[${vp.name}] ${pageerrors.length} pageerror(s) (${pageerrors.length - errorsBeforeReload} after reload): ${pageerrors[0]}`
        );
      }
      if (failedAssets.length > 0) {
        allFailures.push(
          `[${vp.name}] ${failedAssets.length} failed /assets/* response(s) (${failedAssets.length - assetsBeforeReload} after reload): ${failedAssets.join(', ')}`
        );
      }

      const statusTag =
        initialCheck.failures.length === 0 &&
        reloadCheck.failures.length === 0 &&
        pageerrors.length === 0 &&
        failedAssets.length === 0
          ? 'PASS'
          : 'FAIL';
      console.log(
        `${statusTag} [${vp.name} ${vp.width}x${vp.height}] h1="${reloadCheck.summary.h1 ?? ''}" css=${reloadCheck.summary.cssRules} width=${reloadCheck.summary.scrollWidth}/${reloadCheck.summary.clientWidth} links=${reloadCheck.summary.personLinks} pageerrors=${pageerrors.length} failedAssets=${failedAssets.length}`
      );

      await context.close();
    }
  } finally {
    await browser.close();
  }

  if (allFailures.length > 0) {
    console.error(`\nSmoke test FAILED for ${url}:`);
    for (const msg of allFailures) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }
  console.log(`Smoke test PASSED for ${url} (${mode ?? 'generic'}).`);
}

await run();
