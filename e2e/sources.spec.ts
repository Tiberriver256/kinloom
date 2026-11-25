import { expect, test } from '@playwright/test';

const READER_LABEL = 'Primary source transcription and scan reader';
const INSPECTOR_LABEL = 'Source bibliographic inspector';

test('source inspector and multi-document source reader work end to end', async ({ page }) => {
  await page.goto('/person/abraham-lincoln-1809');

  // Expand citation on the 1850 Census event and open Source Inspector
  const censusCard = page.locator('article').filter({ hasText: '1850 U.S. Federal Census records the Lincoln household' }).first();
  await expect(censusCard).toBeVisible();
  await censusCard.locator('button.source-toggle').click();
  await censusCard.getByRole('button', { name: 'Inspect Source →' }).first().click();

  const inspector = page.getByRole('dialog', { name: INSPECTOR_LABEL });
  await expect(inspector).toBeVisible();
  await expect(inspector.getByText('Bibliographic Record')).toBeVisible();
  await expect(inspector.getByText('Formatted Reference')).toBeVisible();
  await expect(inspector.getByText(/Cited Across This Archive/)).toBeVisible();

  // Transition directly from Inspector into Primary Text Reader
  await inspector.getByRole('button', { name: 'Open Primary Text Reader →' }).click();
  const reader = page.getByRole('dialog', { name: READER_LABEL });
  await expect(reader).toBeVisible();
  await expect(reader.locator('.transcript-body')).toContainText('SCHEDULE I');

  // Switch to Side-by-Side scan view on the 1850 Census plate
  await reader.getByRole('button', { name: 'Side-by-Side' }).click();
  await expect(reader.locator('img.scan-page-img')).toBeVisible();

  // Switch to the second document dynamically loaded from readings.json
  await reader.getByRole('tab', { name: /Autobiographical Sketch/ }).click();
  await expect(reader.locator('.transcript-body')).toContainText('Rockingham County, Virginia');

  // Advance pages with Next → button
  await reader.getByRole('button', { name: 'Next page' }).click();
  await expect(reader.locator('.transcript-body')).toContainText('Spencer County, Indiana');

  // Download all-sources bundle
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    reader.getByRole('button', { name: 'All Sources (.txt)' }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('lincoln-todd-family-all-primary-sources.txt');

  // Close with Escape
  await page.keyboard.press('Escape');
  await expect(reader).toHaveCount(0);
});
