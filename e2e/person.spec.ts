import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('person profile displays vital facts, compositional pronunciation, residence spans, shared headstone, and exports GEDCOM 7', async ({ page }) => {
  await page.goto('/person/abraham-lincoln-1809');
  await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
  await expect(page.getByText('1809-02-12 — 1865-04-15')).toBeVisible();

  // Compositional full-name pronunciation renders cleanly without single-word prefix clutter
  const fullPron = page.locator('.person-pronunciation-row .pronunciation-badge');
  await expect(fullPron).toBeVisible();
  await expect(fullPron).toHaveAttribute('data-coverage', 'full');
  await expect(fullPron).toContainText('AY-bruh-ham LING-kun');
  await expect(fullPron.locator('.pronunciation-prefix')).toHaveCount(0);

  await expect(page.getByLabel('Immediate family connections')).toBeVisible();
  await expect(page.getByLabel('Documented residence spans')).toBeVisible();
  await expect(page.getByLabel('Documented residence spans')).toContainText('Springfield');

  // Shared multi-person headstone via MediaItem.person_ids appears on Abraham Lincoln's page
  const mediaSection = page.locator('section[aria-label="Photos and documents"]');
  await expect(mediaSection).toContainText(/Oak Ridge Cemetery monument/);

  // Open lightbox from media card and close via Escape
  await mediaSection.locator('button.person-media-card').first().click();
  await expect(page.getByLabel('Photo and document lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Photo and document lightbox')).toHaveCount(0);

  // Export GEDCOM 7 from person profile
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export GEDCOM' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.ged$/);
  const dlPath = await download.path();
  expect(dlPath).not.toBeNull();
  if (dlPath) {
    const content = await fs.readFile(dlPath, 'utf8');
    expect(content).toContain('2 VERS 7.0');
    expect(content).toContain('1 SOUR LINCOLN_TODD_DEMO');
    expect(content).toContain('Abraham /Lincoln/');
  }

  // Navigate to spouse Mary Ann Todd and confirm compositional 3-part pronunciation + shared headstone
  await page.goto('/person/mary-ann-todd');
  await expect(page.getByRole('heading', { name: 'Mary Ann Todd', exact: true })).toBeVisible();
  const maryPron = page.locator('.person-pronunciation-row .pronunciation-badge');
  await expect(maryPron).toHaveAttribute('data-coverage', 'full');
  await expect(maryPron).toContainText('MAIR-ee AN TAHD');
  await expect(
    page.locator('section[aria-label="Photos and documents"]'),
  ).toContainText(/Oak Ridge Cemetery monument/);

  // Navigate to Thomas Lincoln (surname-only lexicon match) and confirm canonical "Surname:" scope label
  await page.goto('/person/thomas-lincoln');
  await expect(page.getByRole('heading', { name: 'Thomas Lincoln', exact: true })).toBeVisible();
  const thomasPron = page.locator('.person-pronunciation-row .pronunciation-badge');
  await expect(thomasPron).toHaveAttribute('data-coverage', 'surname');
  await expect(thomasPron.locator('.pronunciation-prefix')).toHaveText('Surname:');
  await expect(thomasPron).toContainText('LING-kun');
});

test('index page exports filtered GEDCOM 7 with configured source name', async ({ page }) => {
  await page.goto('/');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: /Export GEDCOM \(\d+\)/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^lincoln-todd-family-.*\.ged$/);
  const dlPath = await download.path();
  if (dlPath) {
    const content = await fs.readFile(dlPath, 'utf8');
    expect(content).toContain('1 SOUR LINCOLN_TODD_DEMO');
    expect(content).toContain('2 NAME Lincoln & Todd Historical Archive');
    expect(content).not.toContain('Jordan Mercer');
  }
});
