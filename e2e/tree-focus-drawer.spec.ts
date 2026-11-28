import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

interface DrawerMetrics {
  readonly position: string;
  readonly zIndex: number;
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly docOverflow: number;
  readonly scrollY: number;
  readonly closeBtnWidth: number;
  readonly closeBtnHeight: number;
  readonly kbdDisplay: string;
  readonly glyphDisplay: string;
  readonly htmlOverflow: string;
}

async function readDrawerMetrics(page: Page): Promise<DrawerMetrics> {
  return page.evaluate(() => {
    const drawer = document.querySelector<HTMLElement>('aside[aria-label*="Lineage focus"]');
    if (!drawer) {
      throw new Error('TreeFocusDrawer not found');
    }
    const rect = drawer.getBoundingClientRect();
    const cs = window.getComputedStyle(drawer);
    const closeBtn = drawer.querySelector<HTMLElement>('.tree-focus-close-btn');
    const closeRect = closeBtn?.getBoundingClientRect();
    const kbd = drawer.querySelector<HTMLElement>('.tree-focus-close-kbd');
    const glyph = drawer.querySelector<HTMLElement>('.tree-focus-close-glyph');
    return {
      position: cs.position,
      zIndex: Number.parseInt(cs.zIndex || '0', 10),
      top: Math.round(rect.top),
      bottom: Math.round(rect.bottom),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      scrollY: Math.round(window.scrollY),
      closeBtnWidth: closeRect ? Math.round(closeRect.width) : 0,
      closeBtnHeight: closeRect ? Math.round(closeRect.height) : 0,
      kbdDisplay: kbd ? window.getComputedStyle(kbd).display : 'none',
      glyphDisplay: glyph ? window.getComputedStyle(glyph).display : 'none',
      htmlOverflow: window.getComputedStyle(document.documentElement).overflow,
    };
  });
}

function assertDrawerInsideViewport(metrics: DrawerMetrics, label: string): void {
  expect(metrics.position, `${label}: position`).toBe('fixed');
  expect(metrics.top, `${label}: rect.top >= 0`).toBeGreaterThanOrEqual(0);
  expect(metrics.bottom, `${label}: rect.bottom <= viewportHeight`).toBeLessThanOrEqual(
    metrics.viewportHeight
  );
  expect(metrics.left, `${label}: rect.left >= 0`).toBeGreaterThanOrEqual(0);
  expect(metrics.right, `${label}: rect.right <= viewportWidth`).toBeLessThanOrEqual(metrics.viewportWidth);
  expect(metrics.width, `${label}: rect.width > 200`).toBeGreaterThan(200);
  expect(metrics.docOverflow, `${label}: zero horizontal overflow`).toBeLessThanOrEqual(0);
}

test.describe('TreeFocusDrawer viewport positioning (#104)', () => {
  test('List view keeps TreeFocusDrawer fixed inside viewport at top and deep scroll across mobile and desktop', async ({
    page,
  }) => {
    const matrix = [
      { name: '390x844 dark', width: 390, height: 844, colorScheme: 'dark' as const },
      { name: '390x844 light', width: 390, height: 844, colorScheme: 'light' as const },
      { name: '360x800 dark', width: 360, height: 800, colorScheme: 'dark' as const },
      { name: '1280x800 light', width: 1280, height: 800, colorScheme: 'light' as const },
      { name: '1440x900 dark', width: 1440, height: 900, colorScheme: 'dark' as const },
    ];

    for (const entry of matrix) {
      await page.setViewportSize({ width: entry.width, height: entry.height });
      await page.emulateMedia({ colorScheme: entry.colorScheme });
      await page.goto('/tree?surface=roll&mode=full');

      const cards = page.locator('button.tree-roll-card');
      await expect(cards.first(), `${entry.name}: roll cards visible`).toBeVisible();
      const cardCount = await cards.count();
      expect(cardCount, `${entry.name}: cards rendered`).toBeGreaterThan(6);

      // 1. Tap a card near the top of List view
      await cards.first().click();
      const drawer = page.locator('aside[aria-label*="Lineage focus"]');
      await expect(drawer).toBeVisible();
      const topMetrics = await readDrawerMetrics(page);
      assertDrawerInsideViewport(topMetrics, `${entry.name} roll top`);
      expect(topMetrics.htmlOverflow).not.toBe('hidden');

      if (entry.width <= 768) {
        expect(topMetrics.closeBtnWidth, `${entry.name}: close btn width >= 44px`).toBeGreaterThanOrEqual(44);
        expect(topMetrics.closeBtnHeight, `${entry.name}: close btn height >= 44px`).toBeGreaterThanOrEqual(
          44
        );
        expect(topMetrics.kbdDisplay, `${entry.name}: hide Esc keycap on mobile`).toBe('none');
        expect(topMetrics.glyphDisplay, `${entry.name}: show × glyph on mobile`).not.toBe('none');
      } else {
        expect(topMetrics.kbdDisplay, `${entry.name}: show Esc keycap on desktop`).not.toBe('none');
      }

      // 2. Dismiss via Close button
      await drawer.locator('.tree-focus-close-btn').click();
      await expect(drawer).toHaveCount(0);

      // 3. Scroll far down (Generation 4+ / near bottom of list) and tap another person
      const deepIndex = Math.min(cardCount - 2, 12);
      const deepCard = cards.nth(deepIndex);
      await deepCard.scrollIntoViewIfNeeded();
      await deepCard.click();
      await expect(drawer).toBeVisible();

      const deepMetrics = await readDrawerMetrics(page);
      expect(deepMetrics.scrollY, `${entry.name}: page scrolled down`).toBeGreaterThan(200);
      assertDrawerInsideViewport(deepMetrics, `${entry.name} roll scrolled`);

      // 4. Switch to a sibling/adjacent person while drawer is open
      const altCard = cards.nth(deepIndex - 1);
      const altLabel = (await altCard.locator('.tree-roll-card-name').textContent())?.trim() ?? '';
      expect(altLabel.length, `${entry.name}: adjacent card name`).toBeGreaterThan(0);
      await altCard.scrollIntoViewIfNeeded();
      await altCard.click();
      await expect(drawer).toContainText(altLabel);

      // 5. Dismiss via Escape
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
    }

    // 6. Primary action ("Open Profile →") navigates cleanly from List view drawer
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tree?surface=roll&mode=full');
    await page.locator('button.tree-roll-card', { hasText: 'Abraham Lincoln' }).first().click();
    const drawer = page.locator('aside[aria-label*="Lineage focus"]');
    await expect(drawer).toBeVisible();
    await drawer.getByRole('link', { name: 'Open Profile →' }).click();
    await expect(page).toHaveURL(/\/person\/abraham-lincoln/);
  });

  test('Chart view keeps TreeFocusDrawer fixed inside viewport without overlapping toolbar or mobile zoom controls', async ({
    page,
  }) => {
    const matrix = [
      { name: '390x844 dark', width: 390, height: 844, colorScheme: 'dark' as const },
      { name: '360x800 light', width: 360, height: 800, colorScheme: 'light' as const },
      { name: '1280x800 dark', width: 1280, height: 800, colorScheme: 'dark' as const },
      { name: '1440x900 light', width: 1440, height: 900, colorScheme: 'light' as const },
    ];

    for (const entry of matrix) {
      await page.setViewportSize({ width: entry.width, height: entry.height });
      await page.emulateMedia({ colorScheme: entry.colorScheme });
      await page.goto('/tree?surface=diagram&mode=full');
      await expect(page.locator('svg.tree-canvas')).toBeVisible();

      // Open drawer via keyboard Enter on a person node so test never depends on pan coordinates
      const targetNode = page
        .locator('.tree-node-card[aria-label="Inspect Abraham Lincoln"]')
        .or(page.locator('.tree-node-card'))
        .first();
      await targetNode.focus();
      await page.keyboard.press('Enter');

      const drawer = page.locator('aside[aria-label*="Lineage focus"]');
      await expect(drawer).toBeVisible();

      const metrics = await readDrawerMetrics(page);
      assertDrawerInsideViewport(metrics, `${entry.name} chart`);
      expect(metrics.htmlOverflow, `${entry.name}: viewport lock active`).toBe('hidden');

      const overlapCheck = await page.evaluate(() => {
        const drawerEl = document.querySelector<HTMLElement>('aside[aria-label*="Lineage focus"]');
        const toolbarEl = document.querySelector<HTMLElement>('.tree-toolbar-shell');
        const controlsEl = document.querySelector<HTMLElement>('.tree-controls');
        const minimapEl = document.querySelector<HTMLElement>('.tree-minimap');
        const dr = drawerEl?.getBoundingClientRect();
        const tb = toolbarEl?.getBoundingClientRect();
        const ct = controlsEl?.getBoundingClientRect();
        const controlsVis = controlsEl ? window.getComputedStyle(controlsEl).visibility : 'hidden';
        const minimapVis = minimapEl ? window.getComputedStyle(minimapEl).visibility : 'hidden';
        const overlaps = (a: DOMRect | undefined, b: DOMRect | undefined): boolean => {
          if (!a || !b) {
            return false;
          }
          return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        };
        return {
          overlapsToolbar: overlaps(dr, tb),
          overlapsControls: controlsVis !== 'hidden' && overlaps(dr, ct),
          controlsVis,
          minimapVis,
        };
      });

      expect(overlapCheck.overlapsToolbar, `${entry.name}: drawer overlaps toolbar`).toBe(false);
      expect(overlapCheck.overlapsControls, `${entry.name}: drawer overlaps zoom controls`).toBe(false);
      if (entry.width <= 768) {
        expect(overlapCheck.controlsVis, `${entry.name}: mobile zoom controls hidden behind sheet`).toBe(
          'hidden'
        );
        expect(overlapCheck.minimapVis, `${entry.name}: mobile minimap hidden behind sheet`).toBe('hidden');
      }

      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);

      if (entry.width <= 768) {
        const restoredVis = await page.evaluate(() => {
          const controlsEl = document.querySelector<HTMLElement>('.tree-controls');
          return controlsEl ? window.getComputedStyle(controlsEl).visibility : 'hidden';
        });
        expect(restoredVis, `${entry.name}: mobile zoom controls restored after close`).toBe('visible');
      }
    }
  });
});
