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
      const stageLegendCount = document.querySelectorAll('.map-stage-legend').length;
      const swatchCount = document.querySelectorAll(
        'fieldset[aria-label="Filter migration map by era"] .map-era-swatch'
      ).length;
      return {
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        toolbarHeight: toolbar ? Math.round(toolbar.height) : 999,
        toolbarRight: toolbar ? Math.round(toolbar.right) : 9999,
        eraButtons,
        stageLegendCount,
        swatchCount,
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
    expect(metrics.stageLegendCount, `Duplicate stage legend removed at ${vp.width}px`).toBe(0);
    expect(
      metrics.swatchCount,
      `Era color swatches embedded in toolbar at ${vp.width}px`
    ).toBeGreaterThanOrEqual(1);
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

  await page.setViewportSize({ width: 360, height: 800 });
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
    const zoomButtons = [...document.querySelectorAll<HTMLButtonElement>('.map-zoom-controls button')].map(
      (btn) => {
        const r = btn.getBoundingClientRect();
        return { width: Math.round(r.width), height: Math.round(r.height) };
      }
    );
    const filtersBtn = document.querySelector<HTMLButtonElement>('.map-filters-toggle-btn');
    const filtersRect = filtersBtn?.getBoundingClientRect();
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
    const unobstructedHeight = toolbarRect && dockRect ? Math.max(0, dockRect.top - toolbarRect.bottom) : 0;
    return {
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      toolbarScrollDiff: toolbar ? Math.round(toolbar.scrollWidth - toolbar.clientWidth) : 999,
      toolbarHeight: toolbarRect ? Math.round(toolbarRect.height) : 999,
      filtersHeight: filtersRect ? Math.round(filtersRect.height) : 0,
      modeButtons,
      zoomButtons,
      zoomBottomGapToDock: zoomRect && dockRect ? Math.round(dockRect.top - zoomRect.bottom) : -999,
      zoomMidYRatio: zoomRect ? (zoomRect.top + zoomRect.height / 2) / window.innerHeight : 0,
      canvasYieldPct: (unobstructedHeight / window.innerHeight) * 100,
      floatingStyleNoteCount: document.querySelectorAll('.map-style-note').length,
      stageLegendCount: document.querySelectorAll('.map-stage-legend').length,
      canvasRightGap: main && glCanvas ? Math.round(Math.abs(main.right - glCanvas.right)) : 999,
      canvasBottomGap: main && glCanvas ? Math.round(Math.abs(main.bottom - glCanvas.bottom)) : 999,
      dockBottomGap: main && dockRect ? Math.round(Math.abs(main.bottom - dockRect.bottom)) : 999,
    };
  });

  expect(mobileMetrics.docOverflow).toBeLessThanOrEqual(0);
  expect(mobileMetrics.toolbarScrollDiff).toBeLessThanOrEqual(1);
  expect(mobileMetrics.toolbarHeight).toBeLessThanOrEqual(64);
  expect(mobileMetrics.filtersHeight).toBeGreaterThanOrEqual(44);
  expect(mobileMetrics.modeButtons).toHaveLength(2);
  expect(mobileMetrics.modeButtons.map((b) => b.text)).toEqual(['By person', 'Chronological']);
  expect(mobileMetrics.modeButtons.every((b) => b.height >= 44)).toBe(true);
  expect(mobileMetrics.zoomButtons).toHaveLength(3);
  expect(mobileMetrics.zoomButtons.every((b) => b.width >= 44 && b.height >= 44)).toBe(true);
  expect(mobileMetrics.zoomBottomGapToDock).toBeGreaterThanOrEqual(4);
  expect(mobileMetrics.zoomBottomGapToDock).toBeLessThanOrEqual(24);
  expect(mobileMetrics.zoomMidYRatio).toBeGreaterThanOrEqual(0.55);
  expect(mobileMetrics.canvasYieldPct).toBeGreaterThanOrEqual(62);
  expect(mobileMetrics.floatingStyleNoteCount).toBe(0);
  expect(mobileMetrics.stageLegendCount).toBe(0);
  expect(mobileMetrics.canvasRightGap).toBeLessThanOrEqual(1);
  expect(mobileMetrics.canvasBottomGap).toBeLessThanOrEqual(1);
  expect(mobileMetrics.dockBottomGap).toBeLessThanOrEqual(1);

  // Open mobile Filters popover, verify person select + era swatch buttons, close cleanly
  await page.locator('.map-filters-toggle-btn').click();
  await expect(page.getByLabel('Filter migration map by person')).toBeVisible();
  await expect(
    page.locator('fieldset[aria-label="Filter migration map by era"] .map-era-swatch').first()
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close map filters' }).click();

  await page.getByRole('button', { name: 'Chronological' }).click();
  await expect(page.getByRole('button', { name: 'Chronological' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'By person' })).toHaveAttribute('aria-pressed', 'false');

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('evidence and sources leads discrepancy cards with h2 in 2-col desktop grid, separates Needs Citation tab, hides empty /changes filters, and honors reduced-motion (#102)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/evidence');
  await expect(page.getByRole('heading', { name: 'Evidence & Sources' })).toBeVisible();

  // Source Discrepancies tab: h2 leads every card, 2-column balanced grid on desktop
  await expect(page.getByText(/Preserved Discrepanc/).first()).toBeVisible();
  await expect(page.getByText(/Real estate valued at \$3,000/)).toBeVisible();
  const evidenceLayout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('article')];
    const first = cards[0];
    const second = cards[1];
    const h2Rect = first?.querySelector('h2')?.getBoundingClientRect();
    const dateRect = first?.querySelector('[class*="date-stamp"]')?.getBoundingClientRect();
    const badgeRect = first?.querySelector('[class*="evidence-discrepancy-badge"]')?.getBoundingClientRect();
    const firstRect = first?.getBoundingClientRect();
    const secondRect = second?.getBoundingClientRect();
    return {
      cardCount: cards.length,
      h2AboveDate: Boolean(h2Rect && dateRect && h2Rect.top < dateRect.top),
      h2AboveBadge: Boolean(h2Rect && badgeRect && h2Rect.top < badgeRect.top),
      twoColumnDesktop: Boolean(
        firstRect &&
          secondRect &&
          Math.abs(firstRect.top - secondRect.top) < 8 &&
          secondRect.left > firstRect.right
      ),
    };
  });
  expect(evidenceLayout.cardCount).toBeGreaterThanOrEqual(2);
  expect(evidenceLayout.h2AboveDate).toBe(true);
  expect(evidenceLayout.h2AboveBadge).toBe(true);
  expect(evidenceLayout.twoColumnDesktop).toBe(true);

  // Sources & Citations tab shows Source Registry cleanly separated from Needs Citation
  await page.getByRole('tab', { name: /Sources & Citations/ }).click();
  await expect(page.getByRole('heading', { name: /Source Registry/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Entries Needing Primary Citation/ })).toHaveCount(0);

  // Needs Citation tab is its own first-class audit bucket
  await page.getByRole('tab', { name: /Needs Citation/ }).click();
  await expect(page.getByRole('heading', { name: /Entries Needing Primary Citation/ })).toBeVisible();

  // Photos & Documents tab
  await page.getByRole('tab', { name: /Photos & Documents/ }).click();
  await expect(page.getByRole('heading', { name: /Photos & Documents/ })).toBeVisible();
  await expect(page.getByText(/Oak Ridge Cemetery monument/)).toBeVisible();

  // /changes hides dead author filter tabs when revisions.length === 0 and shows next-step CTA links
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/changes');
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('No archival changes have been recorded yet.')).toBeVisible();
  await expect(page.getByRole('link', { name: /Explore People Directory/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /Inspect Evidence & Sources/i })).toBeVisible();
  const changesOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(changesOverflow).toBeLessThanOrEqual(0);

  // Reduced-motion media query disables jump-strip scroll animation
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const jumpStripAnim = await page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('[class*="jump-strip"]');
    return strip ? getComputedStyle(strip).animationName : 'none';
  });
  expect(jumpStripAnim).toBe('none');
});
