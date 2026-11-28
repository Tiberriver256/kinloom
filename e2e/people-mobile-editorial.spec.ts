import { expect, test } from '@playwright/test';

test.describe('People landing mobile editorial layout (#89, #90)', () => {
  test('renders collapsed Reader guide and above-the-fold ancestors on fresh 390x844 and 360x800 visits with zero pre-dismissal', async ({
    browser,
  }) => {
    for (const vp of [
      { name: '390x844', width: 390, height: 844 },
      { name: '360x800', width: 360, height: 800 },
    ]) {
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      try {
        const page = await context.newPage();
        await page.goto('/');
        await page.waitForSelector('.person-card', { state: 'visible' });

        const storageLen = await page.evaluate(() => window.localStorage.length);
        expect(storageLen, `fresh visitor localStorage at ${vp.name}`).toBe(0);

        const guideStrip = page.getByTestId('onboarding-checklist-card');
        await expect(guideStrip).toBeVisible();
        await expect(guideStrip).toContainText('Reader guide');
        await expect(guideStrip.getByRole('button', { name: 'Open Reader guide' })).toHaveAttribute(
          'aria-expanded',
          'false'
        );

        const metrics = await page.evaluate(() => {
          const strip = document.querySelector('[data-testid="onboarding-checklist-card"]');
          const firstCard = document.querySelector('.person-card');
          const cards = [...document.querySelectorAll('.person-card')];
          const visibleAboveFold = cards.filter((card) => {
            const rect = card.getBoundingClientRect();
            return rect.top < window.innerHeight && rect.bottom > 0;
          }).length;
          const firstHeading = document.querySelector('#dir-sec-before-1700 .index-section-heading');
          const eraSubtitle = document.querySelector('#dir-sec-before-1700 .index-section-subtitle');
          const firstHook = firstCard?.querySelector('.person-card-hook');
          const filtersPanel = document.querySelector('.index-filters-panel');
          const aboutBody = document.querySelector('.index-banner-about');
          return {
            docOverflowX: document.documentElement.scrollWidth - window.innerWidth,
            guideStripHeight: strip ? Math.round(strip.getBoundingClientRect().height) : 9999,
            firstCardTop: firstCard ? Math.round(firstCard.getBoundingClientRect().top) : 9999,
            visibleAboveFold,
            headingTitle: firstHeading?.querySelector('.index-section-heading-title')?.textContent ?? '',
            snapshotLink: firstHeading?.querySelector('.index-era-snapshot-link')?.textContent ?? '',
            hasMiddotSep: Boolean(firstHeading?.querySelector('.index-section-meta-sep')),
            hasRedundantSubtitle: Boolean(eraSubtitle),
            firstHookText: firstHook?.textContent?.trim() ?? '',
            filtersPanelHidden: filtersPanel
              ? window.getComputedStyle(filtersPanel).display === 'none'
              : false,
            aboutBodyHidden: aboutBody ? window.getComputedStyle(aboutBody).display === 'none' : false,
          };
        });

        expect(metrics.docOverflowX, `docOverflowX at ${vp.name}`).toBeLessThanOrEqual(1);
        expect(metrics.guideStripHeight, `guideStripHeight at ${vp.name}`).toBeLessThanOrEqual(48);
        expect(metrics.firstCardTop, `firstCardTop at ${vp.name}`).toBeLessThan(420);
        expect(metrics.visibleAboveFold, `visibleAboveFold at ${vp.name}`).toBeGreaterThanOrEqual(3);
        expect(metrics.headingTitle).toBe('Before 1700(8)');
        expect(metrics.snapshotLink).toBe('1665 snapshot →');
        expect(metrics.hasMiddotSep).toBe(false);
        expect(metrics.hasRedundantSubtitle).toBe(false);
        expect(metrics.firstHookText.length).toBeGreaterThan(10);
        expect(metrics.filtersPanelHidden).toBe(true);
        expect(metrics.aboutBodyHidden).toBe(true);

        // Expand About this archive disclosure and verify zero overflow
        await page.locator('.index-about-toggle').click();
        await expect(page.locator('.index-banner-about.is-open')).toBeVisible();
        const overflowWithAbout = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(overflowWithAbout, `overflow with About open at ${vp.name}`).toBeLessThanOrEqual(1);
        await page.locator('.index-about-toggle').click();

        // Open Filters popover, apply photo filter, verify active badge, and clear cleanly
        const filtersBtn = page.locator('.index-filters-toggle-btn');
        await filtersBtn.click();
        await expect(page.locator('.index-filters-panel.is-open')).toBeVisible();
        await page.locator('.index-media-filter-btn').click();
        await expect(filtersBtn.locator('.index-filters-badge')).toHaveText('1');
        const overflowWithFilters = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth
        );
        expect(overflowWithFilters, `overflow with Filters open at ${vp.name}`).toBeLessThanOrEqual(1);
        await page.locator('.index-clear-btn').click();
        await expect(filtersBtn.locator('.index-filters-badge')).toHaveCount(0);
      } finally {
        await context.close();
      }
    }
  });

  test('clears DirectoryJumpStrip edge fades when transitioning from scrollable By Era to non-scrollable A–Z or desktop width (#103)', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.goto('/');
      const eraNav = page.locator('nav[aria-label="Jump to era"]');
      await expect(eraNav).toBeVisible();

      const readFadeState = async (selector: string) =>
        page.evaluate(async (sel) => {
          await new Promise<void>((resolve) => {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => resolve());
            });
          });
          const nav = document.querySelector<HTMLElement>(sel);
          if (!nav) {
            return null;
          }
          const cs = window.getComputedStyle(nav);
          return {
            scrollWidth: nav.scrollWidth,
            clientWidth: nav.clientWidth,
            scrollLeft: Math.round(nav.scrollLeft),
            fadeStart: cs.getPropertyValue('--jump-fade-start').trim(),
            fadeEnd: cs.getPropertyValue('--jump-fade-end').trim(),
            animationDuration: cs.animationDuration,
          };
        }, selector);

      const eraStart = await readFadeState('nav[aria-label="Jump to era"]');
      expect(eraStart).not.toBeNull();
      expect(eraStart?.scrollWidth).toBeGreaterThan(eraStart?.clientWidth ?? 0);
      expect(eraStart?.fadeStart).toBe('0px');
      expect(eraStart?.fadeEnd).not.toBe('0px');
      expect(eraStart?.animationDuration).toBe('auto, auto');

      await eraNav.evaluate((el) => {
        el.scrollLeft = 40;
      });
      const eraMid = await readFadeState('nav[aria-label="Jump to era"]');
      expect(eraMid?.fadeStart).not.toBe('0px');
      expect(eraMid?.fadeEnd).not.toBe('0px');

      await eraNav.evaluate((el) => {
        el.scrollLeft = el.scrollWidth - el.clientWidth;
      });
      const eraEnd = await readFadeState('nav[aria-label="Jump to era"]');
      expect(eraEnd?.fadeStart).not.toBe('0px');
      expect(eraEnd?.fadeEnd).toBe('0px');

      await page.getByRole('button', { name: 'A–Z' }).click();
      const azNav = page.locator('nav[aria-label="Jump to surname letter"]');
      await expect(azNav).toBeVisible();
      const azState = await readFadeState('nav[aria-label="Jump to surname letter"]');
      expect(azState).not.toBeNull();
      expect(azState?.fadeStart).toBe('0px');
      if ((azState?.scrollWidth ?? 0) <= (azState?.clientWidth ?? 0)) {
        expect(azState?.fadeEnd).toBe('0px');
      }

      await page.getByRole('button', { name: 'By Era' }).click();
      await expect(eraNav).toBeVisible();
      await eraNav.evaluate((el) => {
        el.scrollLeft = 40;
      });
      const eraScrolledAgain = await readFadeState('nav[aria-label="Jump to era"]');
      expect(eraScrolledAgain?.fadeStart).not.toBe('0px');

      await page.setViewportSize({ width: 1280, height: 800 });
      await expect
        .poll(async () => readFadeState('nav[aria-label="Jump to era"]'))
        .toMatchObject({ fadeStart: '0px', fadeEnd: '0px' });
      const desktopState = await readFadeState('nav[aria-label="Jump to era"]');
      expect(desktopState?.scrollWidth).toBeLessThanOrEqual(desktopState?.clientWidth ?? 0);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(async () => {
          const state = await readFadeState('nav[aria-label="Jump to era"]');
          return state ? { fadeStart: state.fadeStart, hasEndFade: state.fadeEnd !== '0px' } : null;
        })
        .toEqual({ fadeStart: '0px', hasEndFade: true });
    } finally {
      await context.close();
    }
  });
});
