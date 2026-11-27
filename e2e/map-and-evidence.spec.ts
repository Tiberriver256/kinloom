import { expect, test } from '@playwright/test';

test('map route filters by migration era, steps through journey stops, and handles offline tiles gracefully', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Block external OpenHistoricalMap requests so headless runs verify offline paper fallback cleanly
  await page.route('https://www.openhistoricalmap.org/**', (route) => route.abort());
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) => route.abort());

  await page.goto('/map');
  await expect(page.getByLabel('Filter migration map by person')).toContainText(/All People \(\d+\)/);
  await expect(page.locator('.map-canvas')).toBeVisible();

  // Era filter buttons from kinloom.config.yaml
  const prairieBtn = page.getByRole('button', { name: /Illinois Prairie/ });
  await expect(prairieBtn).toBeVisible();
  await prairieBtn.click();
  await expect(prairieBtn).toHaveAttribute('aria-pressed', 'true');

  // Reset to all eras and step through journey playback
  await page.getByRole('button', { name: /All Eras/ }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  const stopCard = page.getByRole('region', { name: 'Selected stop details' });
  await expect(stopCard).toBeVisible();
  await expect(stopCard.getByRole('link', { name: 'Place Profile →' })).toBeVisible();

  await page.getByRole('button', { name: /All \(\d+\)/ }).click();
  await expect(stopCard).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('evidence and sources displays discrepancies, source registry, and photos and documents', async ({
  page,
}) => {
  await page.goto('/evidence');
  await expect(page.getByRole('heading', { name: 'Evidence & Sources' })).toBeVisible();

  // Source Discrepancies tab
  await expect(page.getByText(/Preserved Discrepanc/).first()).toBeVisible();
  await expect(page.getByText(/Real estate valued at \$3,000/)).toBeVisible();

  // Sources & Citations tab
  await page.getByRole('tab', { name: /Sources & Citations/ }).click();
  await expect(page.getByRole('heading', { name: /Source Registry/ })).toBeVisible();
  await expect(page.getByText(/Entries Needing Primary Citation/)).toBeVisible();

  // Photos & Documents tab
  await page.getByRole('tab', { name: /Photos & Documents/ }).click();
  await expect(page.getByRole('heading', { name: /Photos & Documents/ })).toBeVisible();
  await expect(page.getByText(/Oak Ridge Cemetery monument/)).toBeVisible();
});
