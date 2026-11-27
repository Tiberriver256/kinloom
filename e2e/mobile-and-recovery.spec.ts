import type { Route } from '@playwright/test';
import { expect, test } from '@playwright/test';

const MOBILE_ROUTES = [
  '/',
  '/person/abraham-lincoln-1809',
  '/places',
  '/place/springfield-illinois',
  '/time',
  '/tree',
  '/map',
  '/kinship',
  '/evidence',
];

test('mobile viewports (390px and 360px) render every route without horizontal overflow', async ({
  page,
}) => {
  await page.route('https://www.openhistoricalmap.org/**', (route) => route.abort());
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) => route.abort());

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    for (const url of MOBILE_ROUTES) {
      await page.goto(url);
      await expect(page.locator('main')).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `Horizontal overflow on ${url} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
});

test('error boundary catches a broken lazy route chunk and posts client telemetry', async ({ page }) => {
  await page.addInitScript(() => {
    // Prevent guarded auto-reload loop so the recovery card stays visible for assertions.
    window.sessionStorage.setItem('kinloom_chunk_reload_at', String(Date.now()));
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: undefined,
    });
  });

  // Opt in to client telemetry via host meta tag (default static deployments emit zero telemetry POSTs).
  await page.route('**/person/abraham-lincoln-1809', async (route) => {
    const response = await route.fetch();
    const html = await response.text();
    const injected = html.replace(
      '</head>',
      '<meta name="kinloom-telemetry-endpoint" content="/telemetry/client-error" /></head>'
    );
    await route.fulfill({ response, body: injected });
  });

  const telemetryPosted = page.waitForRequest(
    (req) => req.url().includes('/telemetry/client-error') && req.method() === 'POST'
  );

  await page.route('**/telemetry/client-error', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });

  const breakChunk = async (route: Route): Promise<void> => {
    await route.fulfill({
      status: 404,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>missing</title>',
    });
  };
  await page.route('**/assets/*PersonPage*.js', breakChunk);

  await page.goto('/person/abraham-lincoln-1809', { waitUntil: 'domcontentloaded' });

  const recovery = page.getByRole('alert');
  await expect(recovery).toBeVisible({ timeout: 20_000 });
  await expect(recovery).toContainText(/LINCOLN & TODD HISTORICAL ARCHIVE/i);
  await expect(recovery).toContainText(/could not be displayed|newer archive version/i);
  await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();

  await telemetryPosted;
});
