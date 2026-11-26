import { expect, test } from '@playwright/test';

test('time route updates town lanes when selecting anchor years and scrubbing slider', async ({ page }) => {
  await page.goto('/time');
  await expect(page.getByRole('heading', { name: /Lincoln & Todd Family in \d{4}/ })).toBeVisible();

  // Click the 1860 anchor year button
  await page.locator('.time-anchor-btn', { hasText: '1860' }).click();
  await expect(page.locator('.handwritten-year-hero')).toHaveText('1860');
  await expect(page.locator('.time-lanes')).toContainText('Springfield');
  await expect(page.locator('.time-lanes')).toContainText('Abraham Lincoln');
  await expect(page.locator('.time-macro-ribbon')).toContainText('1860 United States Presidential Election');

  // Scrub slider to 1820
  const slider = page.getByLabel(/Select year to inspect/);
  await slider.fill('1820');
  await expect(page.locator('.handwritten-year-hero')).toHaveText('1820');
  await expect(page.locator('.time-lanes')).toContainText('Little Pigeon Creek');
});

test('tree route filters branches, toggles direct line, and opens focus drawer', async ({ page }) => {
  await page.goto('/tree');
  const canvas = page.getByRole('group', { name: /family tree chart/ });
  await expect(canvas).toBeVisible();

  // Switch branch filter
  const branchSelect = page.getByLabel('Select family branch');
  await expect(branchSelect).toBeVisible();
  await branchSelect.selectOption('todd_edwards');
  await expect(page.locator('.tree-node-card', { hasText: 'Levi Todd' }).first()).toBeVisible();

  // Switch back to all and test Direct Line toggle
  await branchSelect.selectOption('all');
  await page.getByRole('button', { name: 'Direct Line' }).click();
  await expect(page.getByRole('button', { name: 'Direct Line' })).toHaveClass(/active/);

  // Select a person node to open focus drawer
  await page.locator('.tree-node-card[aria-label="Inspect Abraham Lincoln"]').click();
  const popover = page.locator('.tree-popover');
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Abraham Lincoln');
  await expect(popover.getByRole('link', { name: 'Open Profile →' })).toBeVisible();
});

test('kinship finder evaluates configured featured pairs and custom selections', async ({ page }) => {
  await page.goto('/kinship');
  await expect(page.getByRole('heading', { name: 'Kinship Finder' })).toBeVisible();

  // Click configured featured kinship pair
  await page.getByRole('button', { name: 'Abraham Lincoln ↔ Mary Ann Todd' }).click();
  await expect(page.locator('main')).toContainText('Spouse of');
  await expect(page.locator('main')).toContainText('Springfield');

  // Click grandfather-grandson featured pair
  await page.getByRole('button', { name: 'Abraham Lincoln (1744) ↔ Abraham Lincoln (1809)' }).click();
  await expect(page.locator('main')).toContainText('Grandparent of');

  // Swap direction via Swap button
  await page.getByRole('button', { name: 'Swap relatives' }).click();
  await expect(page.locator('main')).toContainText('Grandchild of');
});
