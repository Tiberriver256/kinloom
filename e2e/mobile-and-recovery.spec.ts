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

test('mobile PersonPage wraps long archival handles in discrepancy boxes and keeps zero sticky gap between top bar and decade bar', async ({
  page,
}) => {
  await page.route('**/data/archive.json', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const longSourceId = 'src_e2e_long_handle';
    data.sources.push({
      id: longSourceId,
      citation:
        'Regional Archival Register, hdl 21.12113/2376FEBC188D4479B8E3CEC8CE129447: Civil birth index entry https://archive.example.test/ark:/61903/1:1:Q234-5678-LONG-UNBROKEN',
      source_type: 'vital_record',
      has_primary_source: true,
    });
    const person = data.people.find((p: { slug: string }) => p.slug === 'abraham-lincoln-1809');
    const evt = data.events.find((e: { participants: Array<{ person_id: string }> }) =>
      e.participants.some((pt) => pt.person_id === person.id)
    );
    if (evt) {
      evt.alternate_dates = [
        {
          edtf_date: '1809-02-12',
          source_id: longSourceId,
          note: 'Parish roll reference hdl:21.12113/2376FEBC188D4479B8E3CEC8CE129447',
        },
      ];
      evt.alternate_places = [
        {
          place_name: 'HardinCountyDistrict/Subdivision-2376FEBC188D4479B8E3CEC8CE129447',
          source_id: longSourceId,
          note: 'Township boundary ledger lists alternate parish name',
        },
      ];
      evt.fact_conflicts = [
        {
          claim: 'Witness ledger ref 21.12113/2376FEBC188D4479B8E3CEC8CE129447',
          source_id: longSourceId,
          note: 'Secondary transcript differs on witness order',
        },
      ];
    }
    await route.fulfill({
      response,
      contentType: 'application/json',
      body: JSON.stringify(data),
    });
  });

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/person/abraham-lincoln-1809');
    await expect(page.locator('main')).toBeVisible();

    await page.locator('.source-toggle').first().click();
    await expect(page.locator('.citation-conflicts-box')).toHaveCount(3);

    const overflowMetrics = await page.evaluate(() => {
      const docOverflow = document.documentElement.scrollWidth - window.innerWidth;
      const boxes = [...document.querySelectorAll('.citation-conflicts-box')].map((box) => {
        const boxRect = box.getBoundingClientRect();
        const btn = box.querySelector('.source-read-inline');
        const btnRect = btn?.getBoundingClientRect();
        return {
          heading: box.querySelector('strong')?.textContent ?? '',
          boxScrollOverflow: box.scrollWidth - box.clientWidth,
          btnOverflowPastBox: btnRect ? btnRect.right - boxRect.right : 0,
          btnHeight: btnRect ? btnRect.height : 0,
        };
      });
      return { docOverflow, boxes };
    });

    expect(overflowMetrics.docOverflow, `Page overflow at ${width}px`).toBeLessThanOrEqual(0);
    for (const box of overflowMetrics.boxes) {
      expect(box.boxScrollOverflow, `${box.heading} scroll overflow at ${width}px`).toBeLessThanOrEqual(0);
      expect(
        box.btnOverflowPastBox,
        `${box.heading} citation button overflows box border at ${width}px`
      ).toBeLessThanOrEqual(0.5);
      expect(box.btnHeight, `${box.heading} touch target height at ${width}px`).toBeGreaterThanOrEqual(44);
    }

    await page.evaluate(() => {
      const spine = document.querySelector('nav[aria-label="Jump to decade"]');
      if (spine) {
        window.scrollTo(0, spine.getBoundingClientRect().top + window.scrollY + 300);
      }
    });

    const stickyGap = await page.evaluate(() => {
      const header = document.querySelector('header');
      const spine = document.querySelector('nav[aria-label="Jump to decade"]');
      if (!header || !spine) {
        return 999;
      }
      return spine.getBoundingClientRect().top - header.getBoundingClientRect().bottom;
    });

    expect(stickyGap, `Sticky gap between top bar and decade bar at ${width}px`).toBeLessThanOrEqual(0);
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
