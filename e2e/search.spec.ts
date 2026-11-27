import { expect, test } from '@playwright/test';

test('global search opens via / shortcut, searches people/places/readings, and navigates cleanly', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Lincoln & Todd Family' })).toBeVisible();

  // Open via "/" keyboard shortcut and close via Escape
  await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: 'Search archive' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // Open via button and search for a person
  await page.getByRole('button', { name: 'Search (/)' }).click();
  await expect(dialog).toBeVisible();
  const input = page.getByLabel('Search the archive');
  await input.fill('Mary Ann Todd');
  await expect(page.getByText(/People \(\d+\)/)).toBeVisible();
  await page
    .getByRole('button', { name: /Mary Ann Todd/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/person\/mary-ann-todd$/);
  await expect(page.getByRole('heading', { name: 'Mary Ann Todd', exact: true })).toBeVisible();

  // Search for a place and navigate
  await page.keyboard.press('/');
  await page.getByLabel('Search the archive').fill('Hodgenville');
  await expect(page.getByText(/Places \(\d+\)/)).toBeVisible();
  await page
    .getByRole('button', { name: /Hodgenville, Hardin County/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/place\/hodgenville-kentucky$/);

  // Search for a phrase in source pages and open SourceReaderDrawer
  await page.keyboard.press('/');
  await page.getByLabel('Search the archive').fill('Rule of Three');
  await expect(page.getByText(/Source Pages \(\d+\)/)).toBeVisible();
  await page
    .getByRole('button', { name: /Autobiographical Sketch/ })
    .first()
    .click();
  const reader = page.getByRole('dialog', { name: 'Source Reader' });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.transcript-body')).toContainText('Rule of Three');
});
