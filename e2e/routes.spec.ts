import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

function mentionsOpenHistoricalMapUrl(text: string): boolean {
  const matches = text.match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
  return matches.some((rawUrl) => {
    try {
      const host = new URL(rawUrl).hostname.toLowerCase();
      return host === 'openhistoricalmap.org' || host.endsWith('.openhistoricalmap.org');
    } catch {
      return false;
    }
  });
}

function attachErrorCollector(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      const locUrl = msg.location().url;
      if (!mentionsOpenHistoricalMapUrl(text) && !mentionsOpenHistoricalMapUrl(locUrl)) {
        errors.push(`console.error: ${text}`);
      }
    }
  });
  return errors;
}

test('index route renders white-labeled header, footer credit, demo lineage, and redacts living test entry', async ({
  page,
}) => {
  const errors = attachErrorCollector(page);
  await page.goto('/');

  await expect(page.locator('.brand-link')).toHaveText('Lincoln & Todd Historical Archive');
  await expect(page.getByRole('heading', { name: 'Lincoln & Todd Family' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Abraham Lincoln/ }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Mary Ann Todd/ }).first()).toBeVisible();

  // Synthetic living entry (Jordan Mercer) must be redacted out of public listing
  await expect(page.getByText('Jordan Mercer')).toHaveCount(0);

  // Quiet footer credit displays Built with Kinloom + mark
  const footer = page.locator('footer.kinloom-footer');
  await expect(footer).toContainText('Built with Kinloom');
  await expect(footer.locator('svg[aria-label="Kinloom mark"]')).toBeVisible();

  expect(errors).toEqual([]);
});

test('all 9 archival routes render cleanly with zero console or page errors', async ({ page }) => {
  const errors = attachErrorCollector(page);
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

  const checks: { url: string; assertVisible: () => Promise<void> }[] = [
    {
      url: '/',
      assertVisible: async () => {
        await expect(page.getByRole('heading', { name: 'Lincoln & Todd Family' })).toBeVisible();
      },
    },
    {
      url: '/person/abraham-lincoln-1809',
      assertVisible: async () => {
        await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
      },
    },
    {
      url: '/places',
      assertVisible: async () => {
        await expect(
          page.getByRole('heading', { name: 'Places in the Lincoln & Todd Family Archive' })
        ).toBeVisible();
        await expect(page.getByRole('link', { name: 'Springfield', exact: true }).first()).toBeVisible();
      },
    },
    {
      url: '/place/springfield-illinois',
      assertVisible: async () => {
        await expect(
          page.getByRole('heading', { name: 'Springfield, Sangamon County, Illinois, USA' })
        ).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Who Passed Through' })).toBeVisible();
      },
    },
    {
      url: '/time',
      assertVisible: async () => {
        await expect(page.getByRole('heading', { name: /Lincoln & Todd Family in \d{4}/ })).toBeVisible();
      },
    },
    {
      url: '/tree',
      assertVisible: async () => {
        await expect(page.getByRole('group', { name: /family tree chart/ })).toBeVisible();
      },
    },
    {
      url: '/map',
      assertVisible: async () => {
        await expect(page.getByLabel('Filter migration map by person')).toContainText(/All People \(\d+\)/);
        await expect(page.locator('.map-canvas')).toBeVisible();
      },
    },
    {
      url: '/kinship',
      assertVisible: async () => {
        await expect(page.getByRole('heading', { name: 'Kinship Finder' })).toBeVisible();
      },
    },
    {
      url: '/evidence',
      assertVisible: async () => {
        await expect(page.getByRole('heading', { name: 'Evidence & Sources' })).toBeVisible();
      },
    },
  ];

  for (const item of checks) {
    await page.goto(item.url);
    await item.assertVisible();
  }

  expect(errors).toEqual([]);
});

test('unknown route renders archival NotFoundPage with recovery links', async ({ page }) => {
  await page.goto('/nonexistent-route-check');
  await expect(page).toHaveURL(/\/nonexistent-route-check$/);
  await expect(page.getByRole('heading', { name: 'Page Not Found', exact: true })).toBeVisible();
  await page.locator('.not-found-actions a[href="/"]').click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Lincoln & Todd Family' })).toBeVisible();
});
