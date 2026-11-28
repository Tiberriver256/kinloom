import { expect, test } from '@playwright/test';

test.describe('People landing mobile editorial layout (#89)', () => {
  test('reclaims 390x844 and 360x800 first-screen viewport with progressive filters, simplified era headers, and story hooks', async ({
    page,
  }) => {
    for (const vp of [
      { name: '390x844', width: 390, height: 844 },
      { name: '360x800', width: 360, height: 800 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await page.waitForSelector('.person-card', { state: 'visible' });

      const dismissBtn = page.getByRole('button', { name: /Dismiss checklist/i });
      if ((await dismissBtn.count()) > 0) {
        await dismissBtn.click();
      }
      await page.evaluate(() => {
        window.scrollTo(0, 0);
      });

      const metrics = await page.evaluate(() => {
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
          firstCardTop: firstCard ? Math.round(firstCard.getBoundingClientRect().top) : 9999,
          visibleAboveFold,
          headingTitle: firstHeading?.querySelector('.index-section-heading-title')?.textContent ?? '',
          snapshotLink: firstHeading?.querySelector('.index-era-snapshot-link')?.textContent ?? '',
          hasMiddotSep: Boolean(firstHeading?.querySelector('.index-section-meta-sep')),
          hasRedundantSubtitle: Boolean(eraSubtitle),
          firstHookText: firstHook?.textContent?.trim() ?? '',
          filtersPanelHidden: filtersPanel ? window.getComputedStyle(filtersPanel).display === 'none' : false,
          aboutBodyHidden: aboutBody ? window.getComputedStyle(aboutBody).display === 'none' : false,
        };
      });

      expect(metrics.docOverflowX, `docOverflowX at ${vp.name}`).toBeLessThanOrEqual(1);
      if (vp.width === 390) {
        expect(metrics.firstCardTop, `firstCardTop at ${vp.name}`).toBeLessThan(420);
      }
      expect(metrics.visibleAboveFold, `visibleAboveFold at ${vp.name}`).toBeGreaterThanOrEqual(2);
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
    }
  });
});
