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
  await page.getByRole('button', { name: /All Stages/ }).click();
  await page.getByRole('button', { name: 'Next →' }).click();
  const stopCard = page.getByRole('region', { name: 'Selected stop details' });
  await expect(stopCard).toBeVisible();
  await expect(stopCard.getByRole('link', { name: 'Place Profile →' })).toBeVisible();

  await page.getByRole('button', { name: /All \(\d+\)/ }).click();
  await expect(stopCard).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test('map toolbar prevents desktop era clipping, keeps mobile selects and route mode clear, and fills canvas without slivers (#60)', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  await page.route('https://www.openhistoricalmap.org/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        version: 8,
        name: 'offline-test-paper',
        sources: {},
        layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#F5EFE2' } }],
      }),
    })
  );
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) =>
    route.fulfill({ status: 204, body: '' })
  );

  for (const vp of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(vp);
    await page.goto('/map');
    await expect(page.locator('.map-toolbar')).toBeVisible();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();

    const metrics = await page.evaluate(() => {
      const main = document.querySelector('main')?.getBoundingClientRect();
      const canvasHost = document.querySelector('.map-canvas')?.getBoundingClientRect();
      const glCanvas = document.querySelector('.maplibregl-canvas')?.getBoundingClientRect();
      const toolbar = document.querySelector('.map-toolbar')?.getBoundingClientRect();
      const presets = document
        .querySelector('fieldset[aria-label="Filter migration map by era"]')
        ?.getBoundingClientRect();
      const routeMode = document
        .querySelector('fieldset[aria-label="Full lineage route mode"]')
        ?.getBoundingClientRect();
      const eraButtons = [
        ...document.querySelectorAll<HTMLButtonElement>(
          'fieldset[aria-label="Filter migration map by era"] button'
        ),
      ].map((btn) => {
        const rect = btn.getBoundingClientRect();
        return {
          text: btn.textContent?.trim() ?? '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          overflowsPresets: presets ? rect.right - presets.right : 999,
          overlapsRouteMode: routeMode ? rect.right - routeMode.left : -999,
          clippedText: btn.scrollWidth - btn.clientWidth,
        };
      });
      const moreBtn = document.querySelector<HTMLButtonElement>('.map-toolbar button[aria-haspopup="menu"]');
      return {
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        toolbarHeight: toolbar ? Math.round(toolbar.height) : 999,
        toolbarRight: toolbar ? Math.round(toolbar.right) : 9999,
        eraButtons,
        moreBtnText: moreBtn?.textContent?.trim() ?? null,
        canvasRightGap: main && glCanvas ? Math.round(Math.abs(main.right - glCanvas.right)) : 999,
        canvasBottomGap: main && glCanvas ? Math.round(Math.abs(main.bottom - glCanvas.bottom)) : 999,
        hostRightGap: main && canvasHost ? Math.round(Math.abs(main.right - canvasHost.right)) : 999,
        hostBottomGap: main && canvasHost ? Math.round(Math.abs(main.bottom - canvasHost.bottom)) : 999,
      };
    });

    expect(metrics.docOverflow, `Doc overflow at ${vp.width}px`).toBeLessThanOrEqual(0);
    expect(metrics.toolbarHeight, `Toolbar height at ${vp.width}px`).toBeLessThanOrEqual(64);
    expect(metrics.toolbarRight, `Toolbar right edge at ${vp.width}px`).toBeLessThanOrEqual(vp.width);
    expect(metrics.eraButtons.length, `Visible era buttons at ${vp.width}px`).toBeGreaterThanOrEqual(2);
    for (const btn of metrics.eraButtons) {
      expect(btn.overflowsPresets, `Button "${btn.text}" clipped at ${vp.width}px`).toBeLessThanOrEqual(1);
      expect(
        btn.overlapsRouteMode,
        `Button "${btn.text}" overlaps route mode at ${vp.width}px`
      ).toBeLessThanOrEqual(0);
      expect(btn.clippedText, `Button "${btn.text}" text clipped at ${vp.width}px`).toBeLessThanOrEqual(1);
    }
    expect(metrics.canvasRightGap, `Canvas right sliver at ${vp.width}px`).toBeLessThanOrEqual(1);
    expect(metrics.canvasBottomGap, `Canvas bottom sliver at ${vp.width}px`).toBeLessThanOrEqual(1);
    expect(metrics.hostRightGap, `Host right sliver at ${vp.width}px`).toBeLessThanOrEqual(1);
    expect(metrics.hostBottomGap, `Host bottom sliver at ${vp.width}px`).toBeLessThanOrEqual(1);

    if (metrics.moreBtnText) {
      const moreBtn = page.locator('.map-toolbar button[aria-haspopup="menu"]');
      await moreBtn.click();
      const menuItems = page.locator('[role="menu"] [role="menuitemradio"]');
      await expect(menuItems.first()).toBeVisible();
      const promotedText = (await menuItems.first().textContent())?.trim() ?? '';
      await menuItems.first().click();
      await expect(page.locator('[role="menu"]')).toHaveCount(0);
      const promotedLabel = promotedText.replace(/\(\d+\)$/, '').trim();
      await expect(
        page.locator('fieldset[aria-label="Filter migration map by era"] button[aria-pressed="true"]')
      ).toContainText(promotedLabel);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/map');
  await expect(page.locator('.map-toolbar')).toBeVisible();
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  const mobileMetrics = await page.evaluate(() => {
    const main = document.querySelector('main')?.getBoundingClientRect();
    const glCanvas = document.querySelector('.maplibregl-canvas')?.getBoundingClientRect();
    const toolbar = document.querySelector('.map-toolbar');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const dockRect = document.querySelector('.map-bottom-dock')?.getBoundingClientRect();
    const zoomRect = document.querySelector('.map-zoom-controls')?.getBoundingClientRect();
    const personSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter migration map by person"]'
    );
    const eraSelect = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter migration map by migration stage"]'
    );
    const modeButtons = [
      ...document.querySelectorAll<HTMLButtonElement>(
        'fieldset[aria-label="Full lineage route mode"] button'
      ),
    ].map((btn) => {
      const rect = btn.getBoundingClientRect();
      return {
        text: btn.textContent?.trim() ?? '',
        pressed: btn.getAttribute('aria-pressed'),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      toolbarScrollDiff: toolbar ? Math.round(toolbar.scrollWidth - toolbar.clientWidth) : 999,
      personSelectWidth: personSelect ? Math.round(personSelect.getBoundingClientRect().width) : 0,
      personSelectHeight: personSelect ? Math.round(personSelect.getBoundingClientRect().height) : 0,
      eraSelectWidth: eraSelect ? Math.round(eraSelect.getBoundingClientRect().width) : 0,
      eraSelectHeight: eraSelect ? Math.round(eraSelect.getBoundingClientRect().height) : 0,
      modeButtons,
      zoomClearance: toolbarRect && zoomRect ? Math.round(zoomRect.top - toolbarRect.bottom) : -999,
      canvasRightGap: main && glCanvas ? Math.round(Math.abs(main.right - glCanvas.right)) : 999,
      canvasBottomGap: main && glCanvas ? Math.round(Math.abs(main.bottom - glCanvas.bottom)) : 999,
      dockBottomGap: main && dockRect ? Math.round(Math.abs(main.bottom - dockRect.bottom)) : 999,
    };
  });

  expect(mobileMetrics.docOverflow).toBeLessThanOrEqual(0);
  expect(mobileMetrics.toolbarScrollDiff).toBeLessThanOrEqual(1);
  expect(mobileMetrics.personSelectWidth).toBeGreaterThanOrEqual(165);
  expect(mobileMetrics.personSelectHeight).toBeGreaterThanOrEqual(44);
  expect(mobileMetrics.eraSelectWidth).toBeGreaterThanOrEqual(165);
  expect(mobileMetrics.eraSelectHeight).toBeGreaterThanOrEqual(44);
  expect(mobileMetrics.modeButtons).toHaveLength(2);
  expect(mobileMetrics.modeButtons.map((b) => b.text)).toEqual(['By person', 'Chronological']);
  expect(mobileMetrics.modeButtons.every((b) => b.height >= 44 && b.width >= 140)).toBe(true);
  expect(mobileMetrics.zoomClearance).toBeGreaterThanOrEqual(0);
  expect(mobileMetrics.canvasRightGap).toBeLessThanOrEqual(1);
  expect(mobileMetrics.canvasBottomGap).toBeLessThanOrEqual(1);
  expect(mobileMetrics.dockBottomGap).toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Chronological' }).click();
  await expect(page.getByRole('button', { name: 'Chronological' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'By person' })).toHaveAttribute('aria-pressed', 'false');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
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
