import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  BOOK_PUBLISHING_PLUGIN_ID,
  BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE,
  computeCrc32,
  OPEN_FINANCE_PLUGIN_ID,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PRONUNCIATION_PLUGIN_ID,
  RECIPES_PLUGIN_ID,
  signLuluWebhookHmacHex,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
} from '@kinloom/server';
import { expect, test } from '@playwright/test';
import {
  type MiniflarePluginHarness,
  startMiniflarePluginHarness,
} from './helpers/miniflarePluginHarness.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CLI_BIN_PATH = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'cli.js');
const CLI_DIST_INDEX_URL = pathToFileURL(path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')).href;

function buildSyntheticPngWithExif(secretExif: string): Buffer {
  const enc = new TextEncoder();
  const makeChunk = (type: string, data: Uint8Array): Uint8Array => {
    const body = new Uint8Array(4 + data.byteLength);
    body.set(enc.encode(type), 0);
    body.set(data, 4);
    const out = new Uint8Array(12 + data.byteLength);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.byteLength, false);
    out.set(body, 4);
    dv.setUint32(8 + data.byteLength, computeCrc32(body), false);
    return out;
  };
  const ihdr = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = new Uint8Array([
    0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0,
  ]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    makeChunk('IHDR', ihdr),
    makeChunk('eXIf', enc.encode(secretExif)),
    makeChunk('IDAT', idat),
    makeChunk('IEND', new Uint8Array(0)),
  ];
  return Buffer.concat(parts.map((p) => Buffer.from(p)));
}

test.describe('Full-stack Miniflare D1+R2 all-plugins E2E (ARCHIVE_MODE=private)', () => {
  test.describe.configure({ mode: 'serial' });

  let harness: MiniflarePluginHarness;

  test.beforeAll(async () => {
    harness = await startMiniflarePluginHarness({ mode: 'private' });
  });

  test.afterAll(async () => {
    await harness.close();
  });

  test('blocks unauthenticated plugin reads and skips visit counting on private SPA shell loads', async ({
    page,
  }) => {
    await harness.signOut(page);

    for (const endpoint of [
      '/api/observability/config',
      '/api/observability/page-visits?kind=person&slug=abraham-lincoln-1809',
      '/api/open-finance/summary',
      '/api/plugins/recipes',
      '/api/plugins/book-publishing/status',
      '/api/pronunciations',
    ]) {
      const res = await page.request.get(`${harness.baseUrl}${endpoint}`);
      expect(res.status(), `Unauthenticated GET ${endpoint} must be 401 in private mode`).toBe(401);
    }

    await page.goto(`${harness.baseUrl}/person/abraham-lincoln-1809`);
    await expect(page.getByText(/private family archive/i)).toBeVisible();
    await harness.flushWaitUntil();

    const visitCountRow = await harness.db
      .prepare('SELECT COALESCE(SUM(views), 0) AS total FROM page_visit_daily')
      .first<{ total: number }>();
    expect(visitCountRow?.total ?? 0).toBe(0);
  });

  test('Page Visit Stats: SPA beacons, live Admin toggle sync, reload & cold isolate persistence', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');

    // Load home, then transition via SPA links to a deceased person and place.
    await page.goto(`${harness.baseUrl}/`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.locator('a[href="/person/abraham-lincoln-1809"]').first().click();
    await expect(page).toHaveURL(/\/person\/abraham-lincoln-1809$/);
    await expect(page.getByRole('heading', { name: 'Abraham Lincoln', level: 1 })).toBeVisible();

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Places' }).click();
    await expect(page).toHaveURL(/\/places$/);
    await page.locator('a[href="/place/springfield-illinois"]').first().click();
    await expect(page).toHaveURL(/\/place\/springfield-illinois$/);
    await expect(page.getByRole('heading', { name: /Springfield/i, level: 1 })).toBeVisible();
    await harness.flushWaitUntil();

    // Confirm real D1 page_visit_daily recorded SPA person/place transitions and 0 living rows.
    const lincolnViews = await harness.db
      .prepare(
        "SELECT COALESCE(SUM(views), 0) AS total FROM page_visit_daily WHERE entity_slug = 'abraham-lincoln-1809'"
      )
      .first<{ total: number }>();
    expect(lincolnViews?.total ?? 0).toBeGreaterThanOrEqual(1);

    const livingViews = await harness.db
      .prepare(
        "SELECT COALESCE(SUM(views), 0) AS total FROM page_visit_daily WHERE entity_slug = 'jordan-mercer'"
      )
      .first<{ total: number }>();
    expect(livingViews?.total ?? 0).toBe(0);

    // Navigate via SPA account menu to /admin -> enable show_public_visit_badges -> verify live sync.
    await page.getByRole('button', { name: /Account menu/i }).click();
    await page.locator('a[href="/admin"]').first().click();
    await expect(page).toHaveURL(/\/admin$/);

    const statsCard = page.getByTestId(`plugin-settings-card-${PAGE_VISIT_STATS_PLUGIN_ID}`);
    await expect(statsCard).toBeVisible();
    await statsCard.locator('input[data-field-key="show_public_visit_badges"]').check();
    await statsCard.locator('button[type="submit"]').click();
    await expect(statsCard.getByRole('status')).toContainText(/saved/i);
    await expect(page.getByTestId('obs-public-badges-switch')).toBeChecked();

    // Navigate via SPA to Abraham Lincoln -> badge renders immediately with no reload.
    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'People' }).click();
    await page.locator('a[href="/person/abraham-lincoln-1809"]').first().click();
    const personBadge = page.getByTestId('page-visit-badge-person');
    await expect(personBadge).toBeVisible();
    await expect(personBadge).toContainText(/\d+\s+visits?/i);

    // Cold Worker isolate + hard reload (F5) -> badge still renders from D1.
    harness.rotateIsolate();
    await page.reload();
    await expect(page.getByTestId('page-visit-badge-person')).toBeVisible();

    // Disable public badges via SPA /admin -> return via SPA history -> badge disappears without reload.
    await page.getByRole('button', { name: /Account menu/i }).click();
    await page.locator('a[href="/admin"]').first().click();
    await expect(statsCard).toBeVisible();
    await statsCard.locator('input[data-field-key="show_public_visit_badges"]').uncheck();
    await statsCard.locator('button[type="submit"]').click();
    await expect(statsCard.getByRole('status')).toContainText(/saved/i);
    await expect(page.getByTestId('obs-public-badges-switch')).not.toBeChecked();

    await page.goBack();
    await expect(page).toHaveURL(/\/person\/abraham-lincoln-1809(?:\?|$)/);
    await expect(page.getByTestId('page-visit-badge-person')).toHaveCount(0);
  });

  test('Open Finance: live nav/footer sync, lossless preserveKeys save, no-cache across cold isolate, and mobile menu', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');
    await page.goto(`${harness.baseUrl}/admin`);

    // Initially unpublished -> zero nav/footer links.
    await expect(page.getByTestId('open-finance-nav-link')).toHaveCount(0);
    await expect(page.getByTestId('open-finance-footer-link')).toHaveCount(0);

    // Configure platform + funding goal in OpenFinanceAdminPanel and save (writes platform_order_json & funding_goal_json).
    const financePanel = page.getByTestId('admin-open-finance-panel');
    await expect(financePanel).toBeVisible();
    await financePanel.getByLabel('Choose donation platform to add').selectOption('github_sponsors');
    await financePanel.getByRole('button', { name: 'Add Platform' }).click();
    const ghCard = financePanel.getByTestId('admin-of-platform-github_sponsors');
    await ghCard
      .locator('input[type="url"], input[type="text"]')
      .first()
      .fill('https://github.com/sponsors/kinloom-demo');
    await ghCard.getByLabel('Button Label').fill('Sponsor Archive on GitHub');

    await financePanel.getByLabel(/Show funding goal progress bar/i).check();
    await financePanel.getByLabel(/Target Amount/i).fill('120');
    await financePanel.getByLabel(/Received So Far/i).fill('45');
    await financePanel.getByLabel(/Goal Label/i).fill('2026 Archive Hosting Goal');
    await financePanel.locator('button[type="submit"]').click();
    await expect(financePanel.getByRole('status')).toContainText(/saved/i);

    // Wait for PluginSettingsBus sync from OpenFinanceAdminPanel -> PluginSettingsSection before toggling!
    const financeCard = page.getByTestId(`plugin-settings-card-${OPEN_FINANCE_PLUGIN_ID}`);
    await expect(financeCard).toContainText(/Active Donation Platforms\s*1/i);

    // Now toggle visibility ON via PluginSettingsSection -> must sync immediately AND preserve funding_goal_json & platform_order_json!
    await financeCard.locator('input[data-field-key="show_support_page"]').check();
    await financeCard.locator('input[data-field-key="show_in_nav"]').check();
    await financeCard.locator('input[data-field-key="show_in_footer"]').check();
    await financeCard.locator('button[type="submit"]').click();
    await expect(financeCard.getByRole('status')).toContainText(/saved/i);

    // Immediate live sync with ZERO page reload!
    await expect(page.getByTestId('open-finance-nav-link')).toBeVisible();
    await expect(page.getByTestId('open-finance-footer-link')).toBeVisible();

    // Verify lossless preserveKeys in D1 + Cache-Control: private, no-cache across cold isolate + reload.
    harness.rotateIsolate();
    const summaryRes = await page.request.get(`${harness.baseUrl}/api/open-finance/summary`);
    expect(summaryRes.status()).toBe(200);
    expect(summaryRes.headers()['cache-control']).toBe('private, no-cache');
    const summaryJson = (await summaryRes.json()) as {
      funding_goal: { label?: string } | null;
      platforms: Array<{ platform: string; label: string }>;
    };
    expect(summaryJson.funding_goal?.label).toBe('2026 Archive Hosting Goal');
    expect(summaryJson.platforms.find((p) => p.platform === 'github_sponsors')?.label).toBe(
      'Sponsor Archive on GitHub'
    );

    await page.reload();
    await expect(page.getByTestId('open-finance-nav-link')).toBeVisible();
    await page.getByTestId('open-finance-nav-link').click();
    await expect(page).toHaveURL(/\/support$/);
    await expect(page.getByTestId('open-finance-support-page')).toBeVisible();
    await expect(page.getByTestId('open-finance-funding-goal')).toContainText('2026 Archive Hosting Goal');

    // Mobile viewport Archive/Account Menu exposes Support link.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole('button', { name: /Account menu|Archive menu/i }).click();
    await expect(page.getByTestId('open-finance-mobile-nav-link')).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('Family Recipes: D1 create/star/list, R2 EXIF-stripped photo upload, cold isolate & live widget toggle', async ({
    page,
  }) => {
    await harness.signInAs(page, 'editor');
    await page.goto(`${harness.baseUrl}/recipes`);
    await expect(page.getByRole('heading', { name: 'Family Recipe Box', level: 1 })).toBeVisible();

    // Create a recipe via UI button as editor.
    await page
      .getByRole('link', { name: /Add Recipe|Add First Recipe/i })
      .first()
      .click();
    await expect(page).toHaveURL(/\/recipes\/new$/);
    await page
      .getByLabel(/Recipe Title/i)
      .or(page.getByLabel(/^Title/i))
      .first()
      .fill('Sangamon Apple Cobbler');
    await page.getByLabel(/Summary/i).fill('Autumn orchard cobbler baked in a cast-iron skillet.');
    await page.getByLabel(/^Course/i).selectOption('dessert');
    await page.getByRole('button', { name: 'Save New Recipe' }).click();
    await expect(page).toHaveURL(/\/recipes\/sangamon-apple-cobbler$/);
    await expect(page.getByRole('heading', { name: 'Sangamon Apple Cobbler', level: 1 })).toBeVisible();

    // Star the recipe and upload a recipe card photo with synthetic EXIF chunk -> R2.
    const starBtn = page.getByRole('button', { name: /star|favorite/i }).first();
    await starBtn.click();
    await expect(starBtn).toHaveAttribute('aria-pressed', 'true');

    await page.getByLabel('Photo Caption (Optional)').fill('Handwritten cobbler card');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cobbler-card.png',
      mimeType: 'image/png',
      buffer: buildSyntheticPngWithExif('E2E_MINIFLARE_EXIF_GPS_SECRET_99'),
    });
    await expect(page.getByText('Recipe card photo uploaded.')).toBeVisible();

    // Cold isolate + reload -> recipe, star, and R2 photo (with EXIF stripped) survive!
    harness.rotateIsolate();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sangamon Apple Cobbler', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: /star|favorite/i }).first()).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const imgSrc = await page
      .getByRole('button', { name: /Handwritten cobbler card/ })
      .locator('img')
      .getAttribute('src');
    expect(imgSrc).toMatch(/^\/api\/plugins\/recipes\/photos\/pho_/);
    const photoRes = await page.request.get(`${harness.baseUrl}${imgSrc}`);
    expect(photoRes.status()).toBe(200);
    expect((await photoRes.body()).toString('latin1')).not.toContain('E2E_MINIFLARE_EXIF_GPS_SECRET_99');

    // Admin toggles show_home_widget OFF in PluginSettingsSection -> home widget updates live.
    await harness.signInAs(page, 'admin');
    await page.goto(`${harness.baseUrl}/`);
    await expect(page.locator('[data-slot="indexWidgets"]')).toContainText('Sangamon Apple Cobbler');

    await page.goto(`${harness.baseUrl}/admin`);
    const recipesCard = page.getByTestId(`plugin-settings-card-${RECIPES_PLUGIN_ID}`);
    await recipesCard.locator('input[data-field-key="show_home_widget"]').uncheck();
    await recipesCard.locator('button[type="submit"]').click();
    await expect(recipesCard.getByRole('status')).toContainText(/saved/i);

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'People' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('#index-recipes-widget-heading')).toHaveCount(0);
    await expect(page.locator('[data-slot="indexWidgets"]')).not.toContainText('Sangamon Apple Cobbler');
  });

  test('Book Publishing: settings sync, R2 PDF compile & download across cold isolate, D1 jobs, and webhook revocation', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');
    await page.goto(`${harness.baseUrl}/admin`);

    const webhookSecret = 'lulu-e2e-webhook-secret-74';
    const bpCard = page.getByTestId(`plugin-settings-card-${BOOK_PUBLISHING_PLUGIN_ID}`);
    await expect(bpCard).toBeVisible();
    await bpCard.locator('input[data-field-key="contact_email"]').fill(harness.adminEmail);
    await bpCard.locator('button[data-field-key="lulu_webhook_secret"]').click();
    await bpCard.locator('input[data-field-key="lulu_webhook_secret"]').fill(webhookSecret);
    await bpCard.locator('button[type="submit"]').click();
    await expect(bpCard.getByRole('status')).toContainText(/saved/i);

    // Compile PDFs via BookPublishingAdminPanel -> stored in Miniflare R2.
    await page.getByTestId('bp-compile-btn').click();
    await expect(page.getByTestId('bp-compiled-preview')).toBeVisible();
    const interiorHref = await page.getByTestId('bp-download-interior').getAttribute('href');
    const coverHref = await page.getByTestId('bp-download-cover').getAttribute('href');
    expect(interiorHref).toMatch(/^\/api\/plugins\/book-publishing\/artifacts\//);
    expect(coverHref).toMatch(/^\/api\/plugins\/book-publishing\/artifacts\//);

    // Submit a mock print job (stored in D1 plugin_book_publishing_jobs + PDF artifacts in R2).
    const submitRes = await page.request.post(`${harness.baseUrl}/api/plugins/book-publishing/jobs`, {
      headers: { origin: harness.baseUrl, 'content-type': 'application/json' },
      data: {
        title: 'Lincoln-Todd Heritage Volume',
        quantity: 1,
        shippingLevel: 'ground',
        shippingAddress: {
          name: 'Archive Steward',
          street1: '100 Main St',
          city: 'Springfield',
          stateCode: 'IL',
          countryCode: 'US',
          postalCode: '62701',
          phoneNumber: '+15555550100',
        },
      },
    });
    expect(submitRes.status()).toBe(201);
    const submitJson = (await submitRes.json()) as { job: { jobId: string } };
    const jobId = submitJson.job.jobId;

    // Cold Worker isolate -> compiled PDF downloads succeed with %PDF- header AND job persists!
    harness.rotateIsolate();

    const [interiorRes, coverRes] = await Promise.all([
      page.request.get(`${harness.baseUrl}${interiorHref}`),
      page.request.get(`${harness.baseUrl}${coverHref}`),
    ]);
    expect(interiorRes.status()).toBe(200);
    expect(interiorRes.headers()['content-type']).toBe('application/pdf');
    expect((await interiorRes.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(coverRes.status()).toBe(200);
    expect((await coverRes.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-');

    await page.reload();
    await expect(page.getByTestId(`bp-job-${jobId}`)).toBeVisible();

    // Capture the job's R2 artifact keys before webhook revocation.
    const jobRow = await harness.db
      .prepare('SELECT artifact_ids_json FROM plugin_book_publishing_jobs WHERE job_id = ?')
      .bind(jobId)
      .first<{ artifact_ids_json: string }>();
    const artifactIds = JSON.parse(jobRow?.artifact_ids_json ?? '[]') as string[];
    expect(artifactIds.length).toBeGreaterThanOrEqual(2);
    for (const id of artifactIds) {
      expect(await harness.bucket.head(`plugins/book-publishing/${id}.pdf`)).not.toBeNull();
    }

    // Signed Lulu SHIPPED webhook -> deletes R2 artifact objects cleanly across cold isolate!
    const payloadBytes = new TextEncoder().encode(
      JSON.stringify({
        topic: 'PRINT_JOB_STATUS_CHANGED',
        data: {
          id: jobId,
          status: { name: 'SHIPPED', message: 'Dispatched' },
          line_items: [{ tracking_urls: ['https://track.example.test/e2e-74'] }],
        },
      })
    );
    const signature = await signLuluWebhookHmacHex(webhookSecret, payloadBytes);
    // Deliver as an unauthenticated external Lulu webhook (no browser session cookie).
    const webhookRes = await fetch(`${harness.baseUrl}${BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Lulu-HMAC-SHA256': signature },
      body: Buffer.from(payloadBytes),
    });
    expect(webhookRes.status).toBe(200);

    for (const id of artifactIds) {
      expect(await harness.bucket.head(`plugins/book-publishing/${id}.pdf`)).toBeNull();
    }
  });

  test('Pronunciation & TTS: masked write-only D1 secret, mocked synthesis across cold isolate, and disabled 503', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');
    await page.goto(`${harness.baseUrl}/admin`);

    const secretApiKey = 'AIzaSyE2EWriteOnlyPronunciationKey_74';
    const pronCard = page.getByTestId(`plugin-settings-card-${PRONUNCIATION_PLUGIN_ID}`);
    await expect(pronCard).toBeVisible();

    await pronCard.locator('select[data-field-key="primary_backend"]').selectOption('gemini');
    await pronCard.locator('input[data-field-key="default_voice"]').fill('Kore');
    await pronCard.locator('select[data-field-key="phoneme_mode"]').selectOption('plain');
    await pronCard.locator('button[data-field-key="gemini_api_key"]').click();
    await pronCard.locator('input[data-field-key="gemini_api_key"]').fill(secretApiKey);
    await pronCard.locator('button[type="submit"]').click();
    await expect(pronCard.getByRole('status')).toContainText(/saved/i);

    // Secret must be masked in DOM and NEVER echoed back in API responses.
    expect(await pronCard.textContent()).not.toContain(secretApiKey);
    const settingsRes = await page.request.get(`${harness.baseUrl}/api/admin/plugin-settings`);
    expect(await settingsRes.text()).not.toContain(secretApiKey);

    // Cold isolate uses D1 secret + voice + plain mode via deterministic mock fetch.
    harness.rotateIsolate();
    const beforeCalls = harness.ttsCalls.length;
    const genRes = await page.request.post(`${harness.baseUrl}/api/pronunciation/generate`, {
      headers: { origin: harness.baseUrl, 'content-type': 'application/json' },
      data: {
        entity_type: 'person',
        entity_id: 'p_abraham_lincoln_1809',
        phonetic: 'AY-bruh-ham LING-kun',
        ipa: 'ˈeɪbrəhæm ˈlɪŋkən',
      },
    });
    expect(genRes.status()).toBe(200);
    expect(harness.ttsCalls.length).toBe(beforeCalls + 1);
    const lastCall = harness.ttsCalls.at(-1);
    expect(lastCall?.apiKey).toBe(secretApiKey);
    expect(lastCall?.body).toContain('"voiceName":"Kore"');
    expect(lastCall?.body).not.toContain('ˈeɪbrəhæm');

    // Switch primary_backend to disabled -> cold isolate returns 503 PRONUNCIATION_DISABLED!
    await pronCard.locator('select[data-field-key="primary_backend"]').selectOption('disabled');
    await pronCard.locator('button[type="submit"]').click();
    await expect(pronCard.getByRole('status')).toContainText(/saved/i);

    harness.rotateIsolate();
    const disabledRes = await page.request.post(`${harness.baseUrl}/api/pronunciation/generate`, {
      headers: { origin: harness.baseUrl, 'content-type': 'application/json' },
      data: { entity_type: 'person', entity_id: 'p_abraham_lincoln_1809' },
    });
    expect(disabledRes.status()).toBe(503);
    expect(((await disabledRes.json()) as { error: { code: string } }).error.code).toBe(
      'PRONUNCIATION_DISABLED'
    );
  });

  test('Workers Observability, Security Telemetry & Web Analytics persist across cold isolate and diagnostics', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');

    // Verify Web Analytics beacon in root HTML and initial Server-Timing + X-Request-Id headers.
    const rootRes = await page.request.get(`${harness.baseUrl}/`);
    expect(rootRes.status()).toBe(200);
    expect(await rootRes.text()).toContain('static.cloudflareinsights.com/beacon.min.js');

    const bundleBefore = await page.request.get(`${harness.baseUrl}/api/bundle`);
    expect(bundleBefore.status()).toBe(200);
    expect(bundleBefore.headers()['x-request-id']).toBeTruthy();
    expect(bundleBefore.headers()['server-timing']).toBeTruthy();

    // Disable emit_server_timing in Admin Settings -> SystemDiagnosticsSection updates live.
    await page.goto(`${harness.baseUrl}/admin`);
    const obsCard = page.getByTestId(`plugin-settings-card-${WORKERS_OBSERVABILITY_PLUGIN_ID}`);
    await obsCard.locator('input[data-field-key="emit_server_timing"]').uncheck();
    await obsCard.locator('button[type="submit"]').click();
    await expect(obsCard.getByRole('status')).toContainText(/saved/i);

    // Cold isolate hydrates emit_server_timing = false from D1 and reflects it in /api/admin/system!
    harness.rotateIsolate();
    const bundleAfter = await page.request.get(`${harness.baseUrl}/api/bundle`);
    expect(bundleAfter.status()).toBe(200);
    expect(bundleAfter.headers()['server-timing']).toBeUndefined();

    const sysRes = await page.request.get(`${harness.baseUrl}/api/admin/system`);
    expect(sysRes.status()).toBe(200);
    const sysJson = (await sysRes.json()) as {
      config: { observability: { server_timing: boolean } };
      plugins: Array<{ id: string; status: string }>;
    };
    expect(sysJson.config.observability.server_timing).toBe(false);
    expect(sysJson.plugins.some((p) => p.id === WORKERS_OBSERVABILITY_PLUGIN_ID)).toBe(true);

    // Re-enable emit_server_timing for subsequent CLI probe check.
    await obsCard.locator('input[data-field-key="emit_server_timing"]').check();
    await obsCard.locator('button[type="submit"]').click();
    await expect(obsCard.getByRole('status')).toContainText(/saved/i);

    // Trigger CSRF origin mismatch -> security telemetry records security_event.
    const secCountBefore = harness.securityEvents.length;
    const csrfRes = await page.request.post(`${harness.baseUrl}/api/observability/page-visits/beacon`, {
      headers: { origin: 'https://evil-origin.example.test', 'content-type': 'application/json' },
      data: { path: '/' },
    });
    expect(csrfRes.status()).toBe(403);
    await harness.flushWaitUntil();
    expect(harness.securityEvents.length).toBeGreaterThan(secCountBefore);
  });

  test('Narrative Audio: kind-specific labels, persistent dock across SPA routes, and audio onError fallback', async ({
    page,
  }) => {
    await harness.signInAs(page, 'admin');
    await page.goto(`${harness.baseUrl}/person/abraham-lincoln-1809`);

    const bars = page.getByTestId('narrative-audio-margin-bar');
    await expect(bars).toHaveCount(3);
    const bioBar = bars.filter({ hasText: 'Listen to Biography · Charon' });
    const storyBar = bars.filter({ hasText: 'Listen to Story · Puck' });
    const noteBar = bars.filter({ hasText: 'Listen to Research Note · Aoede' });
    await expect(bioBar).toHaveCount(1);
    await expect(storyBar).toHaveCount(1);
    await expect(noteBar).toHaveCount(1);

    // Play the Family Story -> dock shows Story Narration and persists across SPA navigation!
    await storyBar.getByRole('button', { name: /Listen to Evening on Eighth Street/i }).click();
    const dock = page.getByTestId('narrative-audio-dock');
    await expect(dock).toBeVisible();
    await expect(dock).toContainText('Story Narration (Puck)');

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Places' }).click();
    await expect(page).toHaveURL(/\/places$/);
    await expect(dock).toBeVisible();
    await expect(dock).toContainText('Story Narration (Puck)');

    // Return to person page and trigger missing-audio Research Note -> graceful onError alert!
    await page.goto(`${harness.baseUrl}/person/abraham-lincoln-1809`);
    await page
      .getByTestId('narrative-audio-margin-bar')
      .filter({ hasText: 'Listen to Research Note · Aoede' })
      .getByRole('button', { name: /Listen to Sangamon County Deed Proof Note/i })
      .click();
    await expect(page.getByTestId('narrative-audio-error')).toBeVisible();
  });

  test('CLI extension discovery (no circular deadlock) and kinloom probe --plugins live against Miniflare', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-e2e-cli-probe-'));
    try {
      const probeExtDir = path.join(tempDir, 'extensions', 'probe');
      const bookExtDir = path.join(tempDir, 'extensions', 'book');
      await Promise.all([mkdir(probeExtDir, { recursive: true }), mkdir(bookExtDir, { recursive: true })]);
      await Promise.all([
        writeFile(
          path.join(probeExtDir, 'cli.mjs'),
          `import { createSyntheticProbePlugin } from ${JSON.stringify(CLI_DIST_INDEX_URL)};
export default createSyntheticProbePlugin();
`,
          'utf8'
        ),
        writeFile(
          path.join(bookExtDir, 'cli.mjs'),
          `import { createBookPublishingCliPlugin } from ${JSON.stringify(CLI_DIST_INDEX_URL)};
export default createBookPublishingCliPlugin();
`,
          'utf8'
        ),
      ]);

      // 1. Subprocess --help with extensions importing @kinloom/cli completes rapidly (no ESM circular deadlock).
      const helpRun = await execFileAsync(process.execPath, [CLI_BIN_PATH, '--help'], {
        cwd: tempDir,
        timeout: 8000,
      });
      expect(helpRun.stdout).toContain('probe');
      expect(helpRun.stdout).toContain('book');

      // 2. Run live `kinloom probe --plugins --json` using KINLOOM_TOKEN env fallback (read_backup token).
      let probeStdout = '';
      let probeStderr = '';
      try {
        const probeRun = await execFileAsync(
          process.execPath,
          [
            CLI_BIN_PATH,
            'probe',
            '--url',
            harness.baseUrl,
            '--plugins',
            '--expect-plugins',
            'kinloom-workers-observability,kinloom-web-analytics,kinloom-page-visit-stats,kinloom-open-finance,kinloom-recipes,kinloom-book-publishing,kinloom-pronunciation',
            '--max-html-ttfb-ms',
            '5000',
            '--max-bundle-cold-ms',
            '5000',
            '--max-bundle-warm-ms',
            '5000',
            '--max-media-range-ms',
            '5000',
            '--json',
          ],
          {
            cwd: tempDir,
            timeout: 20_000,
            env: {
              ...process.env,
              KINLOOM_TOKEN: harness.readBackupToken,
            },
          }
        );
        probeStdout = probeRun.stdout;
        probeStderr = probeRun.stderr;
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        throw new Error(
          `kinloom probe --plugins failed: ${e.message ?? String(err)}\nSTDOUT:\n${e.stdout ?? ''}\nSTDERR:\n${e.stderr ?? ''}`
        );
      }

      expect(probeStdout).not.toContain(harness.readBackupToken);
      expect(probeStderr).not.toContain(harness.readBackupToken);
      const report = JSON.parse(probeStdout) as {
        ok: boolean;
        html: { status: string };
        bundle: { status: string; warm: { httpStatus: number } };
        mediaRange: { status: string; httpStatus?: number };
        plugins: {
          status: string;
          leakGuardPassed: boolean | null;
          checks: Array<{ pluginId: string; status: string }>;
        };
      };
      expect(report.ok).toBe(true);
      expect(report.html.status).toBe('pass');
      expect(report.bundle.status).toBe('pass');
      expect(report.bundle.warm.httpStatus).toBe(304);
      expect(report.mediaRange.status).toBe('pass');
      expect(report.mediaRange.httpStatus).toBe(206);
      expect(report.plugins.status).toBe('pass');
      expect(report.plugins.leakGuardPassed).toBe(true);
      expect(report.plugins.checks.every((c) => c.status === 'pass')).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

test.describe('Full-stack Miniflare D1+R2 all-plugins E2E (ARCHIVE_MODE=public)', () => {
  let harness: MiniflarePluginHarness;

  test.beforeAll(async () => {
    harness = await startMiniflarePluginHarness({ mode: 'public' });
  });

  test.afterAll(async () => {
    await harness.close();
  });

  test('allows anonymous public archive_read endpoints, increments public visits, and blocks anonymous admin routes', async ({
    page,
  }) => {
    await harness.signOut(page);

    for (const publicEndpoint of [
      '/api/observability/config',
      '/api/open-finance/summary',
      '/api/plugins/recipes',
      '/api/pronunciations',
    ]) {
      const res = await page.request.get(`${harness.baseUrl}${publicEndpoint}`);
      expect(res.status(), `Public GET ${publicEndpoint} must be 200`).toBe(200);
    }

    for (const adminEndpoint of ['/api/admin/system', '/api/plugins/book-publishing/status']) {
      const res = await page.request.get(`${harness.baseUrl}${adminEndpoint}`);
      expect(res.status(), `Anonymous GET ${adminEndpoint} must remain 401`).toBe(401);
    }

    // Anonymous visitor loads /person/abraham-lincoln-1809 and browses /recipes publicly!
    await page.goto(`${harness.baseUrl}/person/abraham-lincoln-1809`);
    await expect(page.getByRole('heading', { name: 'Abraham Lincoln', level: 1 })).toBeVisible();
    await harness.flushWaitUntil();

    const viewsAfterPublicVisit = await harness.db
      .prepare(
        "SELECT COALESCE(SUM(views), 0) AS total FROM page_visit_daily WHERE entity_slug = 'abraham-lincoln-1809'"
      )
      .first<{ total: number }>();
    expect(viewsAfterPublicVisit?.total ?? 0).toBe(1);

    await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Recipes' }).click();
    await expect(page).toHaveURL(/\/recipes$/);
    await expect(page.getByRole('heading', { name: 'Family Recipe Box', level: 1 })).toBeVisible();
  });
});
