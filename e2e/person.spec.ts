import fs from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('person dossier displays vital facts, residence spans, shared multi-person headstone, and exports GEDCOM 7', async ({ page }) => {
  await page.goto('/person/abraham-lincoln-1809');
  await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
  await expect(page.getByText('1809-02-12 — 1865-04-15')).toBeVisible();
  await expect(page.getByLabel('Immediate family connections')).toBeVisible();
  await expect(page.getByLabel('Documented residence spans')).toBeVisible();
  await expect(page.getByLabel('Documented residence spans')).toContainText('Springfield');

  // Shared multi-person headstone via MediaItem.person_ids appears on Abraham Lincoln's page
  const mediaSection = page.locator('section[aria-label="Archival photos and primary record scans"]');
  await expect(mediaSection).toContainText(/Oak Ridge Cemetery monument/);

  // Open lightbox from media card and close via Escape
  await mediaSection.locator('button.person-media-card').first().click();
  await expect(page.getByLabel('Archival media lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Archival media lightbox')).toHaveCount(0);

  // Export GEDCOM 7 from person dossier
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

  // Navigate to spouse Mary Ann Todd and confirm the SAME shared headstone appears via person_ids[]
  await page.goto('/person/mary-ann-todd');
  await expect(page.getByRole('heading', { name: 'Mary Ann Todd', exact: true })).toBeVisible();
  await expect(
    page.locator('section[aria-label="Archival photos and primary record scans"]'),
  ).toContainText(/Oak Ridge Cemetery monument/);
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
