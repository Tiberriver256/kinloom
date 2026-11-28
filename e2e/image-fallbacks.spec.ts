import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

function attachRuntimeErrorCollector(page: Page, allowExpected404 = false): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (text.includes('openhistoricalmap.org')) {
        return;
      }
      if (allowExpected404 && text.includes('status of 404')) {
        return;
      }
      errors.push(`console.error: ${text}`);
    }
  });
  return errors;
}

async function scrollAndWaitForImages(page: Page): Promise<{ total: number; broken: string[] }> {
  await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('img')];
    for (const img of imgs) {
      img.scrollIntoView({ behavior: 'instant', block: 'center' });
      if (!img.complete || img.naturalWidth === 0) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            resolve();
          };
          img.addEventListener('load', done, { once: true });
          img.addEventListener('error', done, { once: true });
          window.setTimeout(done, 4000);
        });
      }
    }
  });

  return page.evaluate(() => {
    const imgs = [...document.querySelectorAll<HTMLImageElement>('img')];
    const broken = imgs
      .filter((img) => !img.complete || img.naturalWidth === 0)
      .map((img) => img.getAttribute('src') || '<missing-src>');
    return { total: imgs.length, broken };
  });
}

test('demo archive routes load all archival portraits and photos with zero broken images and warm linen underlays', async ({
  page,
}) => {
  const errors = attachRuntimeErrorCollector(page);
  await page.route('https://www.openhistoricalmap.org/map-styles/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#ece4d2' } }],
      }),
    })
  );
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) =>
    route.fulfill({ status: 204, body: '' })
  );

  for (const routePath of [
    '/',
    '/person/abraham-lincoln-1809',
    '/place/springfield-illinois',
    '/time',
    '/kinship',
    '/evidence?tab=media',
  ]) {
    await page.goto(routePath);
    await expect(page.locator('main img').first()).toBeAttached();
    const imgAudit = await scrollAndWaitForImages(page);
    expect(imgAudit.total, `expected rendered images on ${routePath}`).toBeGreaterThan(0);
    expect(imgAudit.broken, `expected zero broken images on ${routePath}`).toEqual([]);
  }

  // Person Dossier hero portrait uses eager + high fetchpriority and loads cleanly
  await page.goto('/person/abraham-lincoln-1809');
  const heroImg = page.locator('.person-portrait-btn [data-portrait-status="loaded"] img');
  await expect(heroImg).toHaveCount(1);
  await expect(heroImg).toHaveAttribute('loading', 'eager');
  await expect(heroImg).toHaveAttribute('fetchpriority', 'high');

  // Kinship lineage nodes render real portraits rather than monogram-only circles
  await page.goto('/kinship');
  await page.getByRole('button', { name: 'Abraham Lincoln ↔ Mary Ann Todd' }).click();
  const kinshipPortraits = page.locator('.kinship-node-pill [data-portrait-status="loaded"] img');
  await expect(kinshipPortraits).toHaveCount(2);

  // Portrait inner backing uses warm --surface-linen (#eae1ce = rgb(234, 225, 206)), never stark white
  const backingBg = await page
    .locator('.kinship-node-pill [data-portrait-status] > span')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(backingBg).toBe('rgb(234, 225, 206)');

  expect(errors).toEqual([]);
});

test('404 portrait and place photo responses degrade gracefully to archival monograms and plates with zero broken imgs', async ({
  page,
}) => {
  const errors = attachRuntimeErrorCollector(page, true);
  await page.route('**/media/portrait-*.jpg', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
  );
  await page.route('**/media/place-*.jpg', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not Found' })
  );

  // People Directory: failed portraits swap cleanly to monogram plates with zero broken <img>
  await page.goto('/');
  await expect(page.locator('[data-portrait-status="error"]').first()).toBeVisible();
  const indexAudit = await scrollAndWaitForImages(page);
  expect(indexAudit.broken).toEqual([]);

  // Person Dossier header: 404 portrait swaps to archival AL monogram
  await page.goto('/person/abraham-lincoln-1809');
  const headerPortrait = page.locator('.person-portrait-btn [data-portrait-status="error"]');
  await expect(headerPortrait).toBeVisible();
  await expect(headerPortrait).toContainText('AL');
  await expect(page.locator('.person-portrait-btn img')).toHaveCount(0);

  // Kinship chain: 404 portraits swap cleanly to AL and MT monograms
  await page.goto('/kinship');
  await page.getByRole('button', { name: 'Abraham Lincoln ↔ Mary Ann Todd' }).click();
  const kinshipFallbacks = page.locator('.kinship-node-pill [data-portrait-status="error"]');
  await expect(kinshipFallbacks).toHaveCount(2);
  await expect(page.locator('.kinship-node-pill img')).toHaveCount(0);

  // Place Dossier historical photo: 404 swaps to archival fallback plate
  await page.goto('/place/springfield-illinois');
  const placeFallback = page.locator('.place-history-figure [data-image-status="error"]');
  await expect(placeFallback).toBeVisible();
  await expect(page.locator('.place-history-figure img')).toHaveCount(0);

  expect(errors).toEqual([]);
});
