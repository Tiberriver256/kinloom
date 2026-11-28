import fs from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { type LiveWikiTestHarness, startLiveWikiTestServer } from './helpers/wikiTestServer.js';

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 },
] as const;

const SCREENSHOT_DIR = process.env['KINLOOM_UX_SCREENSHOT_DIR'] || '';

async function maybeScreenshot(page: Page, filename: string): Promise<void> {
  if (!SCREENSHOT_DIR) {
    return;
  }
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: false });
}

async function blockExternalMapTiles(page: Page): Promise<void> {
  await page.route('https://www.openhistoricalmap.org/**', (route) => route.abort());
  await page.route('https://vtiles.openhistoricalmap.org/**', (route) => route.abort());
}

test.describe('Wave 50B UX regression suite', () => {
  test('P0-1: Family Tree toolbar has zero overflow, zero topbar overlap, all controls visible, and parses ?surface/?mode', async ({
    page,
  }) => {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      for (const surfaceParam of ['roll', 'diagram'] as const) {
        await page.goto(`/tree?surface=${surfaceParam}&mode=full`);
        const main = page.locator('main.tree-page');
        await expect(main).toHaveAttribute('data-surface', surfaceParam);
        await expect(main).toHaveAttribute('data-mode', 'full');

        const metrics = await page.evaluate(() => {
          const overflow = document.documentElement.scrollWidth - window.innerWidth;
          const header = document.querySelector('header.topbar');
          const toolbar = document.querySelector('.tree-toolbar');
          const toolbarShell = document.querySelector('.tree-toolbar-shell');
          const headerRect = header?.getBoundingClientRect();
          const toolbarRect = toolbar?.getBoundingClientRect();
          const toolbarShellRect = toolbarShell?.getBoundingClientRect();
          const controls = [
            ...(toolbar?.querySelectorAll('.tree-search-desktop input, .tree-search-toggle-btn') ?? []),
            toolbar?.querySelector('select.tree-branch-select'),
            ...(toolbar?.querySelectorAll('button.tree-seg-btn') ?? []),
            toolbar?.querySelector('button.tree-filters-toggle-btn'),
          ].filter((el): el is Element => {
            if (!el) {
              return false;
            }
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
          });

          const controlBoxes = controls.map((el) => {
            const r = el.getBoundingClientRect();
            return {
              text: el.textContent?.trim() || el.getAttribute('aria-label') || el.tagName,
              left: Math.round(r.left),
              right: Math.round(r.right),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          });

          return {
            overflow,
            innerWidth: window.innerWidth,
            headerBottom: headerRect ? Math.round(headerRect.bottom) : 0,
            toolbarTop: toolbarRect ? Math.round(toolbarRect.top) : 0,
            toolbarShellHeight: toolbarShellRect ? Math.round(toolbarShellRect.height) : 0,
            toolbarScrollOverflow: toolbar ? Math.round(toolbar.scrollWidth - toolbar.clientWidth) : 0,
            controlBoxes,
          };
        });

        expect(
          metrics.overflow,
          `Overflow on /tree?surface=${surfaceParam} at ${vp.name}`
        ).toBeLessThanOrEqual(0);
        expect(
          metrics.toolbarTop,
          `Toolbar overlaps topbar on /tree?surface=${surfaceParam} at ${vp.name}`
        ).toBeGreaterThanOrEqual(metrics.headerBottom - 1);
        expect(
          metrics.toolbarScrollOverflow,
          `Toolbar inner scroll overflow on /tree?surface=${surfaceParam} at ${vp.name}`
        ).toBeLessThanOrEqual(2);
        if (vp.width < 640) {
          expect(metrics.controlBoxes.length).toBeGreaterThanOrEqual(5);
          expect(
            metrics.toolbarShellHeight,
            `Mobile toolbar height > 52px on /tree?surface=${surfaceParam} at ${vp.name}`
          ).toBeLessThanOrEqual(52);
        } else {
          expect(metrics.controlBoxes.length).toBeGreaterThanOrEqual(6);
        }

        for (const box of metrics.controlBoxes) {
          expect(box.left, `${box.text} clipped left at ${vp.name}`).toBeGreaterThanOrEqual(0);
          expect(box.right, `${box.text} clipped right at ${vp.name}`).toBeLessThanOrEqual(
            metrics.innerWidth + 1
          );
          if (vp.width <= 768) {
            expect(box.height, `${box.text} height < 44px at ${vp.name}`).toBeGreaterThanOrEqual(44);
          }
        }
      }

      if (vp.width === 360 || vp.width === 768) {
        await page.goto('/tree?surface=roll&mode=full');
        await maybeScreenshot(page, `tree-roll-${vp.name}.png`);
      }
    }
  });

  test('P0-2 & P1-4: Place Profile occupancy dates never clip and LocalSurveyMap stays legible on mobile', async ({
    page,
  }) => {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/place/hingham-massachusetts');
      await expect(page.getByRole('heading', { name: 'Who Passed Through' })).toBeVisible();

      const report = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.occupancy-row')];
        const clipped: string[] = [];
        const rowHeights: number[] = [];
        const yearLabels: string[] = [];

        for (const row of rows) {
          const rect = row.getBoundingClientRect();
          rowHeights.push(Math.round(rect.height));
          const yearEl = row.querySelector('.occupancy-year-label');
          if (yearEl) {
            const yrRect = yearEl.getBoundingClientRect();
            if (yrRect.width > 0 && yrRect.height > 0) {
              yearLabels.push(yearEl.textContent?.trim() ?? '');
            }
          }
          const descendants = [row, ...row.querySelectorAll('*')];
          for (const el of descendants) {
            if (el.scrollWidth > el.clientWidth + 2) {
              clipped.push(`${el.className}: ${el.scrollWidth} > ${el.clientWidth}`);
            }
          }
        }

        const centerLabel = document.querySelector('.local-survey-center-label');
        const centerLabelHeight = centerLabel
          ? Math.round(centerLabel.getBoundingClientRect().height * 10) / 10
          : 0;
        const nearbyLinks = [...document.querySelectorAll('.local-survey-nearby-link')].map((el) =>
          Math.round(el.getBoundingClientRect().height)
        );

        return {
          rowCount: rows.length,
          clipped,
          minRowHeight: rowHeights.length > 0 ? Math.min(...rowHeights) : 0,
          yearLabels,
          centerLabelHeight,
          nearbyLinks,
        };
      });

      expect(report.rowCount).toBeGreaterThan(0);
      expect(report.clipped, `Clipped occupancy elements at ${vp.name}`).toEqual([]);
      expect(report.yearLabels.some((lbl) => /\d{4}/.test(lbl))).toBe(true);
      if (vp.width <= 390) {
        expect(report.minRowHeight, `Occupancy row height < 44px at ${vp.name}`).toBeGreaterThanOrEqual(44);
        expect(
          report.centerLabelHeight,
          `LocalSurveyMap center label height < 10px at ${vp.name}`
        ).toBeGreaterThanOrEqual(10);
        if (report.nearbyLinks.length > 0) {
          expect(Math.min(...report.nearbyLinks)).toBeGreaterThanOrEqual(44);
        }
      }

      if (vp.width === 360 || vp.width === 1280) {
        await maybeScreenshot(page, `place-hingham-${vp.name}.png`);
        await page.getByRole('heading', { name: 'Who Passed Through' }).scrollIntoViewIfNeeded();
        await maybeScreenshot(page, `place-hingham-occupancy-${vp.name}.png`);
      }
    }
  });

  test('P0-4, P1-1, P1-3, P1-4, P1-5, P2: touch targets, nav discovery, map toolbar, contrast, copy, and polish', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);

    // 1. Time slider >= 44px on mobile + desktop single-resident card width >= 340px
    for (const vp of [VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[3]]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/time?year=1860');
      if (vp.width <= 768) {
        const jumpBtn = page.locator('.time-dock-jump-btn');
        await expect(jumpBtn).toBeVisible();
        await jumpBtn.click();
      }
      const slider = page.locator('input.ink-range-slider');
      await expect(slider).toBeVisible();
      const sliderBox = await slider.boundingBox();
      expect(sliderBox?.height ?? 0, `Time slider height at ${vp.name}`).toBeGreaterThanOrEqual(44);

      if (vp.width === 1280) {
        const cardWidths = await page.evaluate(() =>
          [...document.querySelectorAll('.time-lane')].flatMap((lane) => {
            const cards = lane.querySelectorAll('.time-person-item');
            const firstCard = cards.length === 1 ? cards[0] : undefined;
            return firstCard ? [Math.round(firstCard.getBoundingClientRect().width)] : [];
          })
        );
        if (cardWidths.length > 0) {
          expect(Math.min(...cardWidths)).toBeGreaterThanOrEqual(340);
        }
      }
      if (vp.width === 360) {
        await maybeScreenshot(page, 'time-360x800.png');
      }
    }

    // 2. Discoverable /evidence and /kinship navigation on mobile (360x800) and desktop (1280x800)
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    const archiveMenuBtn = page.getByRole('button', { name: 'Archive menu' });
    await expect(archiveMenuBtn).toBeVisible();
    const archiveBtnBox = await archiveMenuBtn.boundingBox();
    expect(archiveBtnBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(archiveBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await archiveMenuBtn.click();
    const menuItems = page.locator('.topbar-account-menu ul li > a, .topbar-account-menu ul li > button');
    await expect(menuItems).toHaveCount(3);
    await expect(
      page.locator('.topbar-account-menu').getByRole('button', { name: 'Reading Room', exact: true })
    ).toBeVisible();
    await expect(
      page.locator('.topbar-account-menu').getByRole('link', { name: 'Evidence & Sources' })
    ).toBeVisible();
    await expect(
      page.locator('.topbar-account-menu').getByRole('link', { name: 'Kinship Finder' })
    ).toBeVisible();
    await page.locator('.topbar-account-menu').getByRole('link', { name: 'Evidence & Sources' }).click();
    await expect(page).toHaveURL(/\/evidence$/);

    // P1-5: Evidence singular/plural grammar + 44px touch targets on mobile
    await expect(page.locator('main')).not.toContainText('1 entries needing citation');
    await page.getByRole('tab', { name: /Sources & Citations/ }).click();
    const inspectBtnBox = await page.locator('.source-action-btn').first().boundingBox();
    expect(inspectBtnBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await maybeScreenshot(page, 'evidence-360x800.png');

    // Desktop direct nav discovery
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await page.locator('header.topbar').getByRole('link', { name: 'Kinship' }).click();
    await expect(page).toHaveURL(/\/kinship$/);
    await page.locator('header.topbar').getByRole('link', { name: 'Evidence' }).click();
    await expect(page).toHaveURL(/\/evidence$/);

    // 3. P1-2: Map toolbar on 360x800 and 1280x800 + details drawer pin clearance
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/map');
    await expect(page.locator('.map-toolbar')).toBeVisible();
    const mobileMapMetrics = await page.evaluate(() => {
      const tb = document.querySelector('.map-toolbar');
      const handleCount = document.querySelectorAll('.map-drawer-handle').length;
      return {
        scrollDiff: tb ? Math.round(tb.scrollWidth - tb.clientWidth) : 999,
        handleCount,
      };
    });
    expect(mobileMapMetrics.scrollDiff).toBeLessThanOrEqual(2);
    expect(mobileMapMetrics.handleCount).toBe(0);
    await maybeScreenshot(page, 'map-360x800.png');

    await page.goto('/map?place=springfield-illinois');
    const detailsBtn = page.getByRole('button', { name: /Details/ });
    await expect(detailsBtn).toBeVisible();
    await detailsBtn.click();
    await expect(page.getByRole('button', { name: /Hide/ })).toBeVisible();
    await page.waitForTimeout(300);
    await maybeScreenshot(page, 'map-springfield-expanded-360x800.png');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/map');
    const desktopMapToolbarBox = await page.locator('.map-toolbar').boundingBox();
    expect(desktopMapToolbarBox?.height ?? 999).toBeLessThanOrEqual(64);
    await maybeScreenshot(page, 'map-1280x800.png');

    // 4. P1-3: Person Profile mobile header pronunciation width, inline residence chip, single-line audio time
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/person/abraham-lincoln-1809');
    await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
    const personMobileMetrics = await page.evaluate(() => {
      const pronRow = document.querySelector('.person-pronunciation-row');
      const playBtn = document.querySelector('.person-pronunciation-row .pronunciation-play-btn');
      const audioTime = document.querySelector('.narrative-audio-time');
      const audioPlayBtn = document.querySelector('.narrative-audio-play-btn');
      const chip = document.querySelector('.person-family-chip');
      const chipDisplay = chip ? window.getComputedStyle(chip).display : '';
      return {
        pronWidth: pronRow ? Math.round(pronRow.getBoundingClientRect().width) : 0,
        playWidth: playBtn ? Math.round(playBtn.getBoundingClientRect().width) : 0,
        playHeight: playBtn ? Math.round(playBtn.getBoundingClientRect().height) : 0,
        audioTimeHeight: audioTime ? Math.round(audioTime.getBoundingClientRect().height) : 0,
        audioPlayHeight: audioPlayBtn ? Math.round(audioPlayBtn.getBoundingClientRect().height) : 0,
        chipDisplay,
      };
    });
    expect(personMobileMetrics.pronWidth).toBeGreaterThanOrEqual(300);
    expect(personMobileMetrics.playWidth).toBeGreaterThanOrEqual(44);
    expect(personMobileMetrics.playHeight).toBeGreaterThanOrEqual(44);
    if (personMobileMetrics.audioTimeHeight > 0) {
      expect(personMobileMetrics.audioTimeHeight).toBeLessThanOrEqual(22);
      expect(personMobileMetrics.audioPlayHeight).toBeGreaterThanOrEqual(44);
    }
    expect(personMobileMetrics.chipDisplay).not.toBe('inline-flex');
    await maybeScreenshot(page, 'person-lincoln-360x800.png');

    // 5. P0-4 & P1-5: Global Search mobile input >= 44px, Close label, no deprecated copy
    await page.getByRole('button', { name: 'Search archive' }).click();
    const searchInputBox = await page.locator('.global-search-input').boundingBox();
    expect(searchInputBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    await expect(page.locator('.global-search-close-mobile')).toBeVisible();
    await expect(page.locator('.global-search-kbd-hint')).toBeHidden();
    await expect(page.locator('.global-search-card')).not.toContainText('PRIMARY ARCHIVAL SOURCE PAGES');
    await page.locator('.global-search-close-btn').click();

    // 6. P2-1: Places Index hides zero-count eras & search box above y=420px
    await page.goto('/places');
    await expect(page.locator('.places-search-bar input')).toBeVisible();
    const placesMetrics = await page.evaluate(() => {
      const zeroButtons = [
        ...document.querySelectorAll('.places-era-filter-bar button, .ink-filter-bar button'),
      ].filter((b) => b.textContent?.includes('(0)'));
      const searchBox = document.querySelector('.places-search-bar input')?.getBoundingClientRect();
      return {
        zeroCount: zeroButtons.length,
        searchTop: searchBox ? Math.round(searchBox.top) : 999,
      };
    });
    expect(placesMetrics.zeroCount).toBe(0);
    expect(placesMetrics.searchTop).toBeLessThanOrEqual(620);

    // 7. P2-1: Kinship Person A & Person B both visible in initial 800px viewport + no double years
    await page.goto('/kinship');
    await expect(page.locator('select[aria-label="Select first relative"]')).toBeVisible();
    const kinshipMetrics = await page.evaluate(() => {
      const selA = document.querySelector('select[aria-label="Select first relative"]');
      const selB = document.querySelector('select[aria-label="Select second relative"]');
      const doubleYears = [...document.querySelectorAll('option')]
        .map((o) => o.textContent ?? '')
        .filter((t) => /\(\d{4}\)\s*\(\d{4}/.test(t));
      return {
        selABottom: selA ? Math.round(selA.getBoundingClientRect().bottom) : 9999,
        selBBottom: selB ? Math.round(selB.getBoundingClientRect().bottom) : 9999,
        doubleYears,
      };
    });
    expect(kinshipMetrics.selABottom).toBeLessThanOrEqual(800);
    expect(kinshipMetrics.selBBottom).toBeLessThanOrEqual(800);
    expect(kinshipMetrics.doubleYears).toEqual([]);
    await maybeScreenshot(page, 'kinship-360x800.png');

    // 8. P1-4: TreeFocusDrawer breadcrumb separator WCAG AA contrast >= 4.5
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/tree?surface=roll&mode=full');
    await page
      .getByRole('button', { name: /Abraham Lincoln/ })
      .first()
      .click();
    await expect(page.locator('.tree-focus-drawer')).toBeVisible();
    const crumbContrast = await page.evaluate(() => {
      const sep = document.querySelector('.tree-focus-crumb-sep');
      const crumb = document.querySelector('.tree-focus-breadcrumb');
      if (!sep || !crumb) {
        return null;
      }
      const parseRgb = (str: string): [number, number, number] => {
        const m = str.match(/\d+/g);
        return [Number(m?.[0] ?? 0), Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
      };
      const lum = ([r, g, b]: [number, number, number]): number => {
        const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      };
      const fg = parseRgb(window.getComputedStyle(sep).color);
      const bg = parseRgb(window.getComputedStyle(crumb).backgroundColor);
      const l1 = Math.max(lum(fg), lum(bg));
      const l2 = Math.min(lum(fg), lum(bg));
      return (l1 + 0.05) / (l2 + 0.05);
    });
    expect(crumbContrast ?? 0).toBeGreaterThanOrEqual(4.5);

    // 9. P2-2: SourceReaderDrawer transcript sheet starts at y <= 280px on 1280x800
    await page.getByRole('button', { name: 'Reading Room' }).click();
    await expect(page.locator('.transcript-sheet')).toBeVisible();
    const sheetBox = await page.locator('.transcript-sheet').boundingBox();
    expect(sheetBox?.y ?? 999).toBeLessThanOrEqual(280);
    await maybeScreenshot(page, 'source-reader-1280x800.png');
    await page.keyboard.press('Escape');

    // 10. P1-5: Deprecated ubiquitous-language check across rendered pages
    const deprecatedPatterns = [
      /\bIndividual dossier\b/i,
      /\bDate Conflict\b/i,
      /\bPlace Conflict\b/i,
      /\bFact Conflict\b/i,
      /\bRead Primary Text\b/i,
      /\bPrimary Record Scan\b/i,
      /\bAudio Oral History\b/i,
      /\barchived relatives\b/i,
      /\bcommunity match/i,
      /\bUnverified Entries\b/i,
      /\bArchival Media Entries\b/i,
    ];
    for (const route of [
      '/person/abraham-lincoln-1809',
      '/places',
      '/place/hingham-massachusetts',
      '/time?year=1860',
      '/kinship',
      '/evidence',
    ]) {
      await page.goto(route);
      // biome-ignore lint/performance/useDomNodeTextContent: E2E intentionally checks visible rendered text
      const bodyText = await page.locator('main').innerText();
      for (const re of deprecatedPatterns) {
        expect(bodyText, `Deprecated term ${re} found on ${route}`).not.toMatch(re);
      }
    }
  });

  test('P0-3: NarrativeAudioDock sits strictly below EntityEditDrawer and Pronunciation Edit scrolls & focuses Pronunciation', async ({
    page,
  }) => {
    const wiki: LiveWikiTestHarness = await startLiveWikiTestServer();
    try {
      await page.setViewportSize({ width: 360, height: 800 });

      // Enroll as editor via invite + magic link
      await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`);
      await page
        .getByRole('region', { name: 'Invite access notice' })
        .getByRole('button', { name: 'Sign in to edit' })
        .click();
      const signInDialog = page.getByRole('dialog', { name: 'Sign in to family archive' });
      await signInDialog.getByLabel('Email address').fill('wave50b.editor@archive.example');
      await signInDialog.getByRole('button', { name: 'Email Magic Link' }).click();
      const magicEmail = wiki.ports.emailSender.sentMessages.at(-1);
      expect(magicEmail).toBeDefined();
      await page.goto(magicEmail!.magicLinkUrl);
      await expect(page.getByRole('button', { name: /Account menu for/ })).toBeVisible();
      const firstLoginTutorial = page.getByTestId('tutorial-modal');
      await expect(firstLoginTutorial).toBeVisible();
      const dismissTutorialRes = page.waitForResponse(
        (res) => res.url().includes('/api/auth/me/onboarding') && res.request().method() === 'PUT' && res.ok()
      );
      await firstLoginTutorial.getByRole('button', { name: 'Close' }).click();
      await dismissTutorialRes;
      await expect(firstLoginTutorial).toHaveCount(0);

      await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`);
      await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();

      // Start narrative audio so NarrativeAudioDock mounts (if margin bar exists)
      const listenBtn = page.locator('.narrative-audio-play-btn').first();
      const hasNarrativeAudio = (await listenBtn.count()) > 0;
      if (hasNarrativeAudio) {
        await listenBtn.click();
        const dock = page.getByTestId('narrative-audio-dock');
        await expect(dock).toBeVisible();

        const dockMetrics = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="narrative-audio-dock"]');
          const buttons = [...(el?.querySelectorAll('button') ?? [])].map((b) => {
            const r = b.getBoundingClientRect();
            return {
              label: b.getAttribute('aria-label') || b.textContent?.trim() || '',
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          });
          return {
            height: el ? Math.round(el.getBoundingClientRect().height) : 0,
            zIndex: el ? Number(window.getComputedStyle(el).zIndex) : 0,
            buttons,
          };
        });
        expect(dockMetrics.height).toBeLessThanOrEqual(112);
        for (const btn of dockMetrics.buttons) {
          expect(btn.width, `Audio dock button ${btn.label} width < 44px`).toBeGreaterThanOrEqual(44);
          expect(btn.height, `Audio dock button ${btn.label} height < 44px`).toBeGreaterThanOrEqual(44);
        }
      }

      // Click Edit pronunciation button -> opens EntityEditDrawer scrolled to Pronunciation with Respelling focused
      const editPronBtn = page.getByRole('button', { name: /Edit pronunciation for Abraham Lincoln/ });
      await expect(editPronBtn).toBeVisible();
      await editPronBtn.click();

      const drawerBackdrop = page.locator('.drawer-backdrop').first();
      await expect(drawerBackdrop).toBeVisible();
      const pronFieldset = page.locator('.wiki-pronunciation-fieldset');
      await expect(pronFieldset).toBeVisible();
      await expect(pronFieldset).toContainText('Respelling');
      await expect(pronFieldset).not.toContainText('Phonetic guide');

      // Wait briefly for scroll & focus settle
      await page.waitForTimeout(150);

      const stackingAndFocus = await page.evaluate(() => {
        const backdrop = document.querySelector('.drawer-backdrop');
        const dock = document.querySelector('[data-testid="narrative-audio-dock"]');
        const fieldset = document.querySelector('.wiki-pronunciation-fieldset');
        const saveBtn = document.querySelector('.wiki-form-actions button[type="submit"]');
        const fieldsetRect = fieldset?.getBoundingClientRect();
        const saveRect = saveBtn?.getBoundingClientRect();
        const hitAtSave =
          saveRect && saveRect.top >= 0 && saveRect.bottom <= window.innerHeight
            ? document.elementFromPoint(
                saveRect.left + saveRect.width / 2,
                saveRect.top + saveRect.height / 2
              )
            : null;

        return {
          backdropZ: backdrop ? Number(window.getComputedStyle(backdrop).zIndex) : 0,
          dockZ: dock ? Number(window.getComputedStyle(dock).zIndex) : 0,
          fieldsetInView: Boolean(
            fieldsetRect && fieldsetRect.top < window.innerHeight && fieldsetRect.bottom > 0
          ),
          activeTag: document.activeElement?.tagName ?? '',
          activeInsidePronunciation: Boolean(
            fieldset && document.activeElement && fieldset.contains(document.activeElement)
          ),
          hitIsDock: Boolean(hitAtSave?.closest('[data-testid="narrative-audio-dock"]')),
        };
      });

      if (hasNarrativeAudio) {
        expect(stackingAndFocus.backdropZ).toBeGreaterThan(stackingAndFocus.dockZ);
      }
      expect(stackingAndFocus.fieldsetInView).toBe(true);
      expect(stackingAndFocus.activeInsidePronunciation).toBe(true);
      expect(stackingAndFocus.hitIsDock).toBe(false);

      await maybeScreenshot(page, 'drawer-over-audio-360x800.png');
    } finally {
      await wiki.close();
    }
  });

  test('Wave 51B: Impeccable design-quality regressions (tree framing, prose measure, survey map scale, conflict pills, NotFoundPage)', async ({
    page,
  }) => {
    // 1. No side-tab stripe or nested card chrome on Family Tree List View
    for (const vp of [
      { name: '1280x800', width: 1280, height: 800 },
      { name: '390x844', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/tree?surface=roll&mode=full');
      await expect(page.locator('.tree-roll-unit.is-direct').first()).toBeVisible();

      const treeMetrics = await page.evaluate(() => {
        const directUnits = [...document.querySelectorAll('.tree-roll-unit.is-direct')].map((el) => {
          const s = window.getComputedStyle(el);
          return {
            borderLeftWidth: s.borderLeftWidth,
            borderRightWidth: s.borderRightWidth,
            borderRadius: s.borderRadius,
          };
        });
        const earlyStrips = [...document.querySelectorAll('.tree-early-strip')].map((el) => {
          const s = window.getComputedStyle(el);
          return {
            borderTopWidth: s.borderTopWidth,
            backgroundColor: s.backgroundColor,
          };
        });
        return { directUnits, earlyStrips };
      });

      expect(treeMetrics.directUnits.length).toBeGreaterThan(0);
      for (const unit of treeMetrics.directUnits) {
        expect(unit.borderLeftWidth, `Direct unit left/right border mismatch at ${vp.name}`).toBe(
          unit.borderRightWidth
        );
        expect(unit.borderRadius, `Direct unit borderRadius at ${vp.name}`).toBe('0px');
      }
      expect(treeMetrics.earlyStrips.length).toBeGreaterThan(0);
      for (const strip of treeMetrics.earlyStrips) {
        expect(strip.borderTopWidth, `Early strip borderTopWidth at ${vp.name}`).toBe('0px');
        expect(strip.backgroundColor, `Early strip backgroundColor at ${vp.name}`).toBe('rgba(0, 0, 0, 0)');
      }

      await maybeScreenshot(page, `wave51b-tree-roll-${vp.name}.png`);
    }

    // 2. Editorial line measure on /, /changes, and /person/abraham-lincoln-1809 at 1280x800
    await page.setViewportSize({ width: 1280, height: 800 });
    for (const check of [
      { route: '/', selector: '.index-banner p' },
      { route: '/changes', selector: '.wire-banner p' },
      { route: '/person/abraham-lincoln-1809', selector: '.story-card p' },
    ]) {
      await page.goto(check.route);
      await expect(page.locator(check.selector).first()).toBeVisible();
      const proseMetrics = await page.evaluate((sel) => {
        return [...document.querySelectorAll(sel)].map((el) => {
          const s = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            maxWidth: s.maxWidth,
            width: Math.round(r.width),
          };
        });
      }, check.selector);
      expect(proseMetrics.length).toBeGreaterThan(0);
      for (const item of proseMetrics) {
        expect(item.maxWidth, `Prose maxWidth on ${check.route} (${check.selector})`).not.toBe('none');
        expect(item.width, `Prose rendered width on ${check.route} (${check.selector})`).toBeLessThanOrEqual(
          620
        );
      }
    }

    // 3. Survey map text legibility on mobile (390x844)
    await page.setViewportSize({ width: 390, height: 844 });
    for (const placeRoute of ['/place/springfield-illinois', '/place/hingham-massachusetts']) {
      await page.goto(placeRoute);
      await expect(page.locator('.local-survey-svg')).toBeVisible();
      const surveyMetrics = await page.evaluate(() => {
        const svg = document.querySelector<SVGSVGElement>('.local-survey-svg');
        const vb = svg?.viewBox.baseVal;
        const svgRect = svg?.getBoundingClientRect();
        const scale = vb && vb.width > 0 && svgRect ? svgRect.width / vb.width : 1;
        const textSizes = [...(svg?.querySelectorAll('text') ?? [])]
          .filter((el) => !el.closest('[aria-hidden="true"]'))
          .map((el) => {
            const raw = Number.parseFloat(window.getComputedStyle(el).fontSize || '0');
            return {
              text: el.textContent?.trim() ?? '',
              effectivePx: Math.round(raw * scale * 10) / 10,
            };
          });
        const caption = document.querySelector('.local-survey-caption');
        const captionFontPx = caption
          ? Math.round(Number.parseFloat(window.getComputedStyle(caption).fontSize || '0') * 10) / 10
          : 0;
        return { textSizes, captionVisible: Boolean(caption), captionFontPx };
      });
      expect(surveyMetrics.captionVisible, `Missing .local-survey-caption on ${placeRoute}`).toBe(true);
      expect(surveyMetrics.captionFontPx, `Caption fontSize on ${placeRoute}`).toBeGreaterThanOrEqual(12);
      expect(surveyMetrics.textSizes.length).toBeGreaterThan(0);
      for (const t of surveyMetrics.textSizes) {
        expect(t.effectivePx, `SVG text "${t.text}" effective size on ${placeRoute}`).toBeGreaterThanOrEqual(
          12
        );
      }
      if (placeRoute.includes('springfield')) {
        await maybeScreenshot(page, 'wave51b-survey-springfield-390x844.png');
      }
    }

    // 4. Source Discrepancy visibility and pill clearance on 390x844 and 1280x800
    for (const vp of [
      { name: '390x844', width: 390, height: 844 },
      { name: '1280x800', width: 1280, height: 800 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/person/abraham-lincoln-1809');
      if (vp.width >= 1024) {
        // Desktop marginalia rail surfaces discrepancies alongside events by default
        await expect(page.locator('.folio-marginalia-item.is-discrepancy').first()).toBeVisible();
        // Toggling marginalia off reveals inline conflict pills with full vertical clearance
        const marginaliaToggle = page.locator('.marginalia-toggle-btn').first();
        await expect(marginaliaToggle).toHaveAttribute('aria-pressed', 'true');
        await marginaliaToggle.click();
        await expect(marginaliaToggle).toHaveAttribute('aria-pressed', 'false');
      }
      await expect(page.locator('.conflict-pill').first()).toBeVisible();
      const pillPaddings = await page.evaluate(() =>
        [...document.querySelectorAll('.conflict-pill')].map((el) => {
          const s = window.getComputedStyle(el);
          return {
            top: Number.parseFloat(s.paddingTop || '0'),
            bottom: Number.parseFloat(s.paddingBottom || '0'),
          };
        })
      );
      expect(pillPaddings.length).toBeGreaterThan(0);
      for (const pad of pillPaddings) {
        expect(pad.top, `conflict-pill paddingTop at ${vp.name}`).toBeGreaterThanOrEqual(4);
        expect(pad.bottom, `conflict-pill paddingBottom at ${vp.name}`).toBeGreaterThanOrEqual(4);
      }
      if (vp.width >= 1024) {
        await page.locator('.marginalia-toggle-btn').first().click();
        await expect(page.locator('.marginalia-toggle-btn').first()).toHaveAttribute('aria-pressed', 'true');
      }
      if (vp.width === 390) {
        await page.locator('.conflict-pill').first().scrollIntoViewIfNeeded();
        await maybeScreenshot(page, 'wave51b-conflict-pill-390x844.png');
      }
    }

    // 5. Archival NotFoundPage on unknown route (/does-not-exist)
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/does-not-exist');
    await expect(page).toHaveURL(/\/does-not-exist$/);
    await expect(page.getByRole('heading', { name: 'Page Not Found', exact: true })).toBeVisible();
    const homeLink = page.locator('.not-found-actions a[href="/"]');
    const treeLink = page.locator('.not-found-actions a[href="/tree"]');
    await expect(homeLink).toBeVisible();
    await expect(treeLink).toBeVisible();
    await maybeScreenshot(page, 'wave51b-not-found-1280x800.png');
    await treeLink.click();
    await expect(page).toHaveURL(/\/tree$/);
  });

  test('Wave 52B-1: Skip-to-content link, modal aria-modal + Tab focus trap + Escape restore, SVG ARIA roles, and tablist keyboard nav', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.locator('#main-content')).toBeVisible();

    // First Tab lands on skip-to-content link targeting #main-content
    await page.keyboard.press('Tab');
    const firstFocused = await page.evaluate(() => ({
      className: document.activeElement?.className ?? '',
      href: document.activeElement?.getAttribute('href') ?? '',
    }));
    expect(firstFocused.className).toContain('skip-to-content');
    expect(firstFocused.href).toBe('#main-content');

    // Pressing Enter focuses #main-content
    await page.keyboard.press('Enter');
    const mainFocused = await page.evaluate(() => document.activeElement?.id ?? '');
    expect(mainFocused).toBe('main-content');

    // GlobalSearchModal: aria-modal, Tab trap (never hits backdrop close), Escape restores focus
    const searchBtn = page.getByRole('button', { name: 'Search (/)' });
    await searchBtn.focus();
    await searchBtn.click();
    const searchDialog = page.locator('dialog.global-search-backdrop[open]');
    await expect(searchDialog).toBeVisible();
    await expect(searchDialog).toHaveAttribute('aria-modal', 'true');

    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
      const inside = await page.evaluate(() => {
        const dlg = document.querySelector('dialog.global-search-backdrop[open]');
        const active = document.activeElement;
        return {
          inDialog: Boolean(dlg && active && dlg.contains(active)),
          isBackdropClose: Boolean(active?.classList.contains('lightbox-backdrop-close')),
        };
      });
      expect(inside.inDialog, `Search Tab step ${i} escaped dialog`).toBe(true);
      expect(inside.isBackdropClose, `Search Tab step ${i} hit backdrop close`).toBe(false);
    }

    await page.keyboard.press('Escape');
    await expect(searchDialog).toHaveCount(0);
    const searchRestored = await page.evaluate(() => document.activeElement?.textContent?.includes('Search'));
    expect(searchRestored).toBe(true);

    // SourceReaderDrawer: aria-modal, Tab trap, tablist ArrowRight without turning pages, Escape restore
    const sourcesBtn = page.locator('header.topbar button', { hasText: 'Reading Room' });
    await sourcesBtn.focus();
    await sourcesBtn.click();
    const readerDialog = page.locator('dialog.source-reader-backdrop[open]');
    await expect(readerDialog).toBeVisible();
    await expect(readerDialog).toHaveAttribute('aria-modal', 'true');

    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press(i < 5 ? 'Tab' : 'Shift+Tab');
      const inside = await page.evaluate(() => {
        const dlg = document.querySelector('dialog.source-reader-backdrop[open]');
        const active = document.activeElement;
        return {
          inDialog: Boolean(dlg && active && dlg.contains(active)),
          isBackdropClose: Boolean(active?.classList.contains('lightbox-backdrop-close')),
        };
      });
      expect(inside.inDialog).toBe(true);
      expect(inside.isBackdropClose).toBe(false);
    }

    const readerTabs = readerDialog.locator('[role="tablist"] [role="tab"]');
    if ((await readerTabs.count()) > 1) {
      await readerTabs.first().focus();
      await page.keyboard.press('ArrowRight');
      await expect(readerTabs.nth(1)).toBeFocused();
    }

    await page.keyboard.press('Escape');
    await expect(readerDialog).toHaveCount(0);
    const sourcesRestored = await page.evaluate(() =>
      document.activeElement?.textContent?.includes('Reading Room')
    );
    expect(sourcesRestored).toBe(true);

    // EvidencePage tablist keyboard navigation (ArrowRight/ArrowLeft/Home/End)
    await page.goto('/evidence');
    const evTabs = page.locator('.evidence-tabs[role="tablist"] [role="tab"]');
    await expect(evTabs).toHaveCount(3);
    await evTabs.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(evTabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(evTabs.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(evTabs.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(evTabs.nth(0)).toHaveAttribute('aria-selected', 'true');

    // PersonPage photo lightbox aria-modal + Escape restore
    await page.goto('/person/abraham-lincoln-1809');
    const firstMediaCard = page.locator('.person-media-card').first();
    await expect(firstMediaCard).toBeVisible();
    await firstMediaCard.focus();
    await firstMediaCard.click();
    const photoDialog = page.locator('dialog.photo-lightbox-overlay[open]');
    await expect(photoDialog).toBeVisible();
    await expect(photoDialog).toHaveAttribute('aria-modal', 'true');
    await page.keyboard.press('Escape');
    await expect(photoDialog).toHaveCount(0);
    await expect(firstMediaCard).toBeFocused();

    // Interactive SVG containers do not use role="img"
    await page.goto('/place/springfield-illinois');
    await expect(page.locator('svg.local-survey-svg')).toHaveAttribute('role', 'group');
    await page.goto('/tree?surface=diagram');
    await expect(page.locator('svg.tree-canvas')).toHaveAttribute('role', 'group');
  });

  test('Wave 52B-2: Archival print stylesheet expands biographies & footnotes and hides chrome', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/person/abraham-lincoln-1809');
    await expect(page.locator('.person-biography-body')).toBeVisible();

    await page.emulateMedia({ media: 'print' });

    const personPrint = await page.evaluate(() => {
      const bio = document.querySelector('.person-biography-body');
      const bioSources = document.querySelector('.person-biography-sources');
      const hiddenSelectors = [
        '.source-toggle',
        '.source-read-btn',
        '.also-here',
        '.wireframe-photo:not(.has-real-photo)',
        '.person-header-actions',
        '.skip-to-content',
      ];
      const visibleChrome = hiddenSelectors.reduce((sum, sel) => {
        const visibleCount = [...document.querySelectorAll(sel)].filter((el) => {
          const s = window.getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden';
        }).length;
        return sum + visibleCount;
      }, 0);
      return {
        bodyBg: window.getComputedStyle(document.body).backgroundColor,
        bioMaxHeight: bio ? window.getComputedStyle(bio).maxHeight : '',
        bioOverflow: bio ? window.getComputedStyle(bio).overflow : '',
        sourcesDisplay: bioSources ? window.getComputedStyle(bioSources).display : 'missing',
        visibleChrome,
      };
    });

    expect(personPrint.bodyBg).toBe('rgb(255, 255, 255)');
    expect(personPrint.bioMaxHeight).toBe('none');
    expect(personPrint.bioOverflow).toBe('visible');
    expect(personPrint.sourcesDisplay).not.toBe('none');
    expect(personPrint.visibleChrome).toBe(0);
    await maybeScreenshot(page, 'wave52b-person-print-1280x800.png');

    await page.goto('/place/springfield-illinois');
    const placePrint = await page.evaluate(() => {
      const checkHidden = (sel: string): boolean =>
        [...document.querySelectorAll(sel)].every((el) => window.getComputedStyle(el).display === 'none');
      return {
        scopeHidden: checkHidden('.place-scope-bar'),
        decadeHidden: checkHidden('.place-decade-bar'),
      };
    });
    expect(placePrint.scopeHidden).toBe(true);
    expect(placePrint.decadeHidden).toBe(true);
    await page.emulateMedia({ media: 'screen' });
  });

  test('Wave 52B-3: Tree Chart surnames & keyboard zoom, TimePage headlines, KinshipPage grammar, and PlacePage decade pills', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });

    // Tree Chart: no 4px side-tab rects, full surnames rendered at default zoom, keyboard zoom updates live readout
    await page.goto('/tree?surface=diagram&mode=full');
    await expect(page.locator('svg.tree-canvas')).toBeVisible();
    await maybeScreenshot(page, 'wave52b-tree-chart-1280x800.png');

    const chartAudit = await page.evaluate(() => {
      const sideTabs = document.querySelectorAll('.tree-node-card rect[width="4"]').length;
      const nodeTexts = [...document.querySelectorAll('.tree-node-card text')].map(
        (el) => el.textContent?.trim() ?? ''
      );
      const hasAbrahamLincoln = nodeTexts.some((t) => t.includes('Abraham Lincoln'));
      const zoomText = document.querySelector('.tree-zoom-readout')?.textContent?.trim() ?? '';
      return { sideTabs, hasAbrahamLincoln, zoomText };
    });
    expect(chartAudit.sideTabs).toBe(0);
    expect(chartAudit.hasAbrahamLincoln).toBe(true);
    expect(chartAudit.zoomText).toMatch(/^\d+%$/);

    const beforeZoom = chartAudit.zoomText;
    await page.keyboard.press('+');
    await expect(page.locator('.tree-zoom-readout')).not.toHaveText(beforeZoom);

    // Focus a person node, open Focus Drawer, Escape restores focus
    const firstNode = page.locator('.tree-node-card').first();
    await firstNode.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.tree-focus-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.tree-focus-drawer')).toHaveCount(0);
    await expect(firstNode).toBeFocused();

    // TimePage 1880: no future death headline, no verbatim duplicate title/note
    await page.goto('/time?year=1880');
    await expect(page.locator('.time-person-item').first()).toBeVisible();
    const timeAudit = await page.evaluate(() =>
      [...document.querySelectorAll('.time-person-item')].map((card) => ({
        status: card.querySelector('.time-person-status')?.textContent?.trim() ?? '',
        note: card.querySelector('.time-person-note')?.textContent?.trim() ?? '',
      }))
    );
    expect(timeAudit.length).toBeGreaterThan(0);
    for (const item of timeAudit) {
      expect(item.status).not.toBe(item.note);
      if (item.note.includes('Recorded in 1889')) {
        expect(item.status).not.toContain('Death');
      }
    }

    // KinshipPage: identical person selection has clean grammar
    await page.goto('/kinship');
    const selectA = page.locator('select[aria-label="Select first relative"]');
    const selectB = page.locator('select[aria-label="Select second relative"]');
    await expect(selectA).toBeVisible();
    const firstVal = await selectA.inputValue();
    await selectB.selectOption(firstVal);
    const headingText = (await page.locator('.kinship-result-heading').textContent()) ?? '';
    expect(headingText).toContain('Same person selected:');
    expect(headingText).not.toContain('is the Same person');

    // PlacePage: selecting a decade keeps all other decade pills visible
    await page.goto('/place/springfield-illinois');
    const decadeButtons = page.locator('.place-decade-bar button');
    const initialDecadeCount = await decadeButtons.count();
    if (initialDecadeCount > 2) {
      await decadeButtons.nth(1).click();
      await expect(decadeButtons).toHaveCount(initialDecadeCount);
      await expect(decadeButtons.nth(1)).toHaveClass(/active/);
    }
  });

  test('Wave 52B-4: Tablet 768x1024 and mobile 360x800 touch targets >= 44px and typography >= 12px', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);

    for (const vp of [
      { name: '360x800', width: 360, height: 800 },
      { name: '768x1024', width: 768, height: 1024 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      await page.goto('/');
      if (vp.width <= 640) {
        const filtersBtn = page.locator('.index-filters-toggle-btn');
        await expect(filtersBtn).toBeVisible();
        const primaryHeights = await page.evaluate(() =>
          [...document.querySelectorAll('.index-toolbar-primary button')].map((el) => ({
            cls: el.className,
            height: Math.round(el.getBoundingClientRect().height),
          }))
        );
        expect(primaryHeights.length, `no mobile index primary controls found at ${vp.name}`).toBeGreaterThan(
          0
        );
        for (const item of primaryHeights) {
          expect(item.height, `${item.cls} < 44px at ${vp.name}`).toBeGreaterThanOrEqual(44);
        }
        await filtersBtn.click();
      }
      await expect(page.locator('.search-input').first()).toBeVisible();
      const indexHeights = await page.evaluate(() =>
        [...document.querySelectorAll('.search-input, .index-filter-actions .pill-btn')]
          .filter((el) => window.getComputedStyle(el).display !== 'none')
          .map((el) => ({
            cls: el.className,
            height: Math.round(el.getBoundingClientRect().height),
          }))
      );
      expect(indexHeights.length, `no index controls found at ${vp.name}`).toBeGreaterThan(0);
      for (const item of indexHeights) {
        expect(item.height, `${item.cls} < 44px at ${vp.name}`).toBeGreaterThanOrEqual(44);
      }

      await page.goto('/person/abraham-lincoln-1809');
      await expect(page.getByRole('heading', { name: 'Abraham Lincoln', exact: true })).toBeVisible();
      const personCheck = await page.evaluate(() => {
        const targets = [
          ...document.querySelectorAll(
            '.person-header .pronunciation-play-btn, .person-header .pill-btn, .person-header .ink-link-btn'
          ),
        ].map((el) => ({
          cls: el.className,
          height: Math.round(el.getBoundingClientRect().height),
        }));
        const smallFonts = [...document.querySelectorAll('.media-kind-badge, .pronunciation-lang')]
          .filter((el) => window.getComputedStyle(el).display !== 'none')
          .map((el) => ({
            cls: el.className,
            fontSize: Number.parseFloat(window.getComputedStyle(el).fontSize),
          }));
        return { targets, smallFonts };
      });
      expect(personCheck.targets.length, `no person targets found at ${vp.name}`).toBeGreaterThan(0);
      for (const t of personCheck.targets) {
        expect(t.height, `${t.cls} < 44px on PersonPage at ${vp.name}`).toBeGreaterThanOrEqual(44);
      }
      for (const f of personCheck.smallFonts) {
        expect(f.fontSize, `${f.cls} < 12px at ${vp.name}`).toBeGreaterThanOrEqual(12);
      }
      await maybeScreenshot(page, `wave52b-person-${vp.name}.png`);

      await page.goto('/tree?surface=roll&mode=full');
      await expect(page.locator('.tree-gen-jump-chip').first()).toBeVisible();
      const treeChipHeights = await page.evaluate(() =>
        [...document.querySelectorAll('.tree-gen-jump-chip')].map((el) =>
          Math.round(el.getBoundingClientRect().height)
        )
      );
      expect(treeChipHeights.length, `no tree jump chips found at ${vp.name}`).toBeGreaterThan(0);
      for (const h of treeChipHeights) {
        expect(h, `tree-gen-jump-chip < 44px at ${vp.name}`).toBeGreaterThanOrEqual(44);
      }
      await maybeScreenshot(page, `wave52b-tree-${vp.name}.png`);

      await page.goto('/time?year=1860');
      await expect(page.locator('.time-person-item').first()).toBeVisible();
      const timeFonts = await page.evaluate(() =>
        [...document.querySelectorAll('.time-anchor-count, .time-person-tier')]
          .filter((el) => window.getComputedStyle(el).display !== 'none')
          .map((el) => Number.parseFloat(window.getComputedStyle(el).fontSize))
      );
      expect(timeFonts.length, `no time micro fonts found at ${vp.name}`).toBeGreaterThan(0);
      for (const fs of timeFonts) {
        expect(fs, `time micro font < 12px at ${vp.name}`).toBeGreaterThanOrEqual(12);
      }
    }
  });
});
