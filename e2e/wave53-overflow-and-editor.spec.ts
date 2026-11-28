import fs from 'node:fs';
import path from 'node:path';
import { getSessionCookieName, signSessionToken } from '@kinloom/server';
import { expect, type Page, test } from '@playwright/test';
import { type LiveWikiTestHarness, startLiveWikiTestServer } from './helpers/wikiTestServer.js';

const STATIC_DEMO_ORIGIN = 'http://127.0.0.1:4173';
const SESSION_SECRET = 'kinloom-e2e-test-session-secret-0123456789abcdef';

const CORE_ROUTES = [
  '/',
  '/places',
  '/time',
  '/tree',
  '/tree?surface=roll',
  '/tree?surface=diagram',
  '/map',
  '/kinship',
  '/evidence',
  '/changes',
  '/admin',
  '/person/abraham-lincoln-1809',
  '/place/springfield-illinois',
] as const;

const VIEWPORTS = [
  { name: '360x800', width: 360, height: 800 },
  { name: '390x844', width: 390, height: 844 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '1280x800', width: 1280, height: 800 },
] as const;

interface OverflowAuditResult {
  readonly docOverflowX: number;
  readonly elementOverflows: readonly string[];
  readonly textEscapes: readonly string[];
  readonly parentEscapes: readonly string[];
  readonly siblingCollisions: readonly string[];
}

async function blockExternalMapTiles(page: Page): Promise<void> {
  await page.route(
    /^https?:\/\/(?:[^/]*openstreetmap\.org|[^/]*cartocdn\.com|[^/]*tile\.|fonts\.googleapis\.com|fonts\.gstatic\.com)/i,
    (route) => route.abort()
  );
}

async function maybeScreenshot(page: Page, filename: string): Promise<void> {
  const dir = process.env.KINLOOM_SCREENSHOT_DIR;
  if (!dir) {
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, filename), fullPage: false });
}

async function signInAsAdmin(page: Page, wiki: LiveWikiTestHarness): Promise<void> {
  const cookieName = getSessionCookieName(false);
  const token = await signSessionToken({
    secret: SESSION_SECRET,
    clock: wiki.ports.clock,
    ttlSeconds: 3600,
    payload: {
      kind: 'user',
      email: wiki.adminEmail,
      display_name: 'Archive Admin',
      role: 'admin',
    },
  });
  await page.context().addCookies([
    {
      name: cookieName,
      value: token,
      url: wiki.baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}

async function seedResearchBatch(page: Page, wiki: LiveWikiTestHarness, batchId: string): Promise<void> {
  const res = await page.request.post(`${wiki.baseUrl}/api/batches`, {
    headers: {
      Authorization: `Bearer ${wiki.agentWriteToken}`,
      'Content-Type': 'application/json',
    },
    data: {
      batch_id: batchId,
      author_name: 'Demo Research Agent',
      summary: 'Seeded census enrichment for Wave 53B diff and confirmation tests',
      has_primary_source: true,
      patches: [
        {
          action: 'update',
          entity_type: 'person',
          entity_id: 'p_abraham_lincoln_1809',
          merge: true,
          data: {
            alt_names: ['Honest Abe', 'Rail Splitter of Sangamon County Illinois'],
          },
          summary: 'Update Abraham Lincoln alt_names with census verification note',
        },
        {
          action: 'update',
          entity_type: 'place',
          entity_id: 'pl_springfield_il',
          merge: true,
          data: {
            summary:
              'Capital of Illinois and long-term residence documented in 1850 and 1860 federal censuses.',
          },
          summary: 'Expand Springfield historical profile from 1860 census',
        },
      ],
    },
  });
  expect(res.status()).toBe(201);
}

async function runPerElementOverflowAndCollisionAudit(page: Page): Promise<OverflowAuditResult> {
  return page.evaluate(() => {
    const docOverflowX = Math.max(
      0,
      Math.round((document.documentElement.scrollWidth - window.innerWidth) * 10) / 10
    );

    const TARGET_SELECTOR =
      'button, a[href], [role="tab"], [role="menuitem"], .pill-btn, .nav-pill, .wiki-btn-primary, .wiki-btn-secondary, .wiki-badge, .wiki-author-pill, .wiki-role-chip, .wiki-action-tag, h1, h2, h3, h4';
    const EXCLUDED_SELECTOR = '.visually-hidden, .sr-only, .lightbox-backdrop-close, .skip-to-content';

    const isVisibleElement = (el: Element): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) {
        return false;
      }
      if (el.closest(EXCLUDED_SELECTOR) || el.closest('svg')) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0
      ) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 0.5 && rect.height > 0.5;
    };

    const describeEl = (el: HTMLElement): string => {
      const tag = el.tagName.toLowerCase();
      const cls =
        typeof el.className === 'string' && el.className.trim()
          ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
          : '';
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 36);
      return `${tag}${cls}("${text}")`;
    };

    const elementOverflows: string[] = [];
    const textEscapes: string[] = [];

    for (const raw of document.querySelectorAll(TARGET_SELECTOR)) {
      if (!isVisibleElement(raw)) {
        continue;
      }
      const style = window.getComputedStyle(raw);
      const isHorizontalScroller = style.overflowX === 'auto' || style.overflowX === 'scroll';
      const isTruncatedEllipsis = style.textOverflow === 'ellipsis' && style.overflowX === 'hidden';
      const hasOverflowScroll = raw.scrollWidth > raw.clientWidth + 1.5;

      if (!isHorizontalScroller && !isTruncatedEllipsis && hasOverflowScroll) {
        elementOverflows.push(
          `${describeEl(raw)} scrollWidth=${Math.round(raw.scrollWidth)} > clientWidth=${Math.round(raw.clientWidth)}`
        );
      }

      if (!isHorizontalScroller && !isTruncatedEllipsis && style.overflowX === 'visible') {
        const box = raw.getBoundingClientRect();
        const walker = document.createTreeWalker(raw, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          if (node.textContent && node.textContent.trim().length > 0) {
            const parentEl = node.parentElement;
            if (parentEl && !parentEl.closest(EXCLUDED_SELECTOR)) {
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const tr of range.getClientRects()) {
                if (tr.width <= 0.5 || tr.height <= 0.5) {
                  continue;
                }
                const leftEsc = box.left - tr.left;
                const rightEsc = tr.right - box.right;
                if (leftEsc > 1.5 || rightEsc > 1.5) {
                  textEscapes.push(
                    `${describeEl(raw)} textEsc(L=${leftEsc.toFixed(1)},R=${rightEsc.toFixed(1)})`
                  );
                  break;
                }
              }
            }
          }
          node = walker.nextNode();
        }
      }
    }

    const parentEscapes: string[] = [];
    const CONTAINER_SELECTORS = [
      '.index-filter-actions',
      '.index-archive-utility-bar',
      '.tree-toolbar',
      '.tree-scope-segmented',
      '.wiki-action-bar',
      '.evidence-tabs',
    ];
    for (const sel of CONTAINER_SELECTORS) {
      for (const container of document.querySelectorAll<HTMLElement>(sel)) {
        if (!isVisibleElement(container)) {
          continue;
        }
        const cStyle = window.getComputedStyle(container);
        if (cStyle.overflowX === 'auto' || cStyle.overflowX === 'scroll') {
          continue;
        }
        const pRect = container.getBoundingClientRect();
        for (const child of container.querySelectorAll<HTMLElement>('button, a[href], select')) {
          if (!isVisibleElement(child)) {
            continue;
          }
          const cRect = child.getBoundingClientRect();
          if (cRect.left < pRect.left - 1.5 || cRect.right > pRect.right + 1.5) {
            parentEscapes.push(
              `${sel} -> ${describeEl(child)} child[${Math.round(cRect.left)}..${Math.round(cRect.right)}] outside parent[${Math.round(pRect.left)}..${Math.round(pRect.right)}]`
            );
          }
        }
      }
    }

    const siblingCollisions: string[] = [];
    const COLLISION_SCOPES = [
      '.topbar',
      '.nav-links',
      '.index-filter-actions',
      '.index-archive-utility-bar',
      '.tree-toolbar',
      '.wiki-action-bar',
      '.evidence-tabs',
    ];
    for (const sel of COLLISION_SCOPES) {
      for (const scope of document.querySelectorAll<HTMLElement>(sel)) {
        if (!isVisibleElement(scope)) {
          continue;
        }
        const controls = [...scope.querySelectorAll<HTMLElement>('button, a[href], select')].filter(
          (el) => isVisibleElement(el) && !el.closest('[role="menu"], [role="listbox"]')
        );
        for (let i = 0; i < controls.length; i += 1) {
          for (let j = i + 1; j < controls.length; j += 1) {
            const a = controls[i];
            const b = controls[j];
            if (a.contains(b) || b.contains(a)) {
              continue;
            }
            const ra = a.getBoundingClientRect();
            const rb = b.getBoundingClientRect();
            const overlapX = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
            const overlapY = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
            if (overlapX > 1.5 && overlapY > 1.5) {
              siblingCollisions.push(
                `${sel}: ${describeEl(a)} overlaps ${describeEl(b)} by ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px`
              );
            }
          }
        }
      }
    }

    return {
      docOverflowX,
      elementOverflows,
      textEscapes,
      parentEscapes,
      siblingCollisions,
    };
  });
}

async function navigateAndWaitReady(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main#main-content', { state: 'visible' });
  await page.waitForFunction(
    () => {
      const text = document.querySelector('main#main-content')?.textContent ?? '';
      return (
        !text.includes('Loading family archive') &&
        !text.includes('Loading family tree') &&
        !text.includes('Loading revision history') &&
        !text.includes('Loading research field reports') &&
        !text.includes('Loading administration records')
      );
    },
    { timeout: 10_000 }
  );
  await page.waitForTimeout(80);
}

test.describe('Wave 53B signed-in editor UX, per-element overflow/collision, and tree clarity gates', () => {
  let wiki: LiveWikiTestHarness;

  test.beforeEach(async () => {
    wiki = await startLiveWikiTestServer();
  });

  test.afterEach(async () => {
    await wiki.close();
  });

  test('W53-U1/U2a: zero per-element overflow, parent escape, or sibling collision across public routes and signed-in 3-digit stress fixtures', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await blockExternalMapTiles(page);

    // 1. Public static demo sweep across 4 viewports on key routes
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of ['/', '/tree?surface=roll', '/person/abraham-lincoln-1809', '/evidence']) {
        await navigateAndWaitReady(page, `${STATIC_DEMO_ORIGIN}${route}`);
        const audit = await runPerElementOverflowAndCollisionAudit(page);
        expect(audit.docOverflowX, `public ${route} @ ${vp.name} docOverflowX`).toBeLessThanOrEqual(1);
        expect(audit.elementOverflows, `public ${route} @ ${vp.name} elementOverflows`).toEqual([]);
        expect(audit.textEscapes, `public ${route} @ ${vp.name} textEscapes`).toEqual([]);
        expect(audit.parentEscapes, `public ${route} @ ${vp.name} parentEscapes`).toEqual([]);
        expect(audit.siblingCollisions, `public ${route} @ ${vp.name} siblingCollisions`).toEqual([]);
      }
    }

    // 2. Signed-in 3-digit count + multi-word plugin nav tab stress verification at 360x800 and 390x844
    await signInAsAdmin(page, wiki);
    for (const vp of [
      { name: '360x800', width: 360, height: 800 },
      { name: '390x844', width: 390, height: 844 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // IndexPage signed-in with 3-digit counts + multi-word plugin tab
      await navigateAndWaitReady(page, `${wiki.baseUrl}/`);
      await expect(page.locator('.index-filter-actions .index-add-person-btn')).toBeVisible();
      await expect(page.locator('.index-archive-utility-bar .index-export-link')).toBeVisible();
      await page.evaluate(() => {
        const mediaBtn = document.querySelector('.index-media-filter-btn');
        if (mediaBtn) {
          mediaBtn.textContent = 'With photos (108)';
        }
        const exportLink = document.querySelector('.index-archive-utility-bar .index-export-link');
        if (exportLink) {
          exportLink.textContent = 'Export GEDCOM (128)';
        }
        const summary = document.querySelector('.index-archive-utility-bar .index-archive-utility-summary');
        if (summary) {
          summary.textContent = 'Showing 128 of 128 people';
        }
        const nav = document.querySelector('.nav-links');
        if (
          nav &&
          ![...nav.querySelectorAll('a.nav-pill')].some((a) =>
            a.textContent?.includes('Read Memoir Chapters')
          )
        ) {
          const pluginLink = document.createElement('a');
          pluginLink.className = 'nav-pill';
          pluginLink.href = '/memoir';
          pluginLink.textContent = 'Read Memoir Chapters';
          nav.appendChild(pluginLink);
        }
      });

      const indexAudit = await runPerElementOverflowAndCollisionAudit(page);
      expect(indexAudit.docOverflowX, `3-digit / @ ${vp.name}`).toBeLessThanOrEqual(1);
      expect(indexAudit.elementOverflows, `3-digit / @ ${vp.name} elementOverflows`).toEqual([]);
      expect(indexAudit.textEscapes, `3-digit / @ ${vp.name} textEscapes`).toEqual([]);
      expect(indexAudit.parentEscapes, `3-digit / @ ${vp.name} parentEscapes`).toEqual([]);
      expect(indexAudit.siblingCollisions, `3-digit / @ ${vp.name} siblingCollisions`).toEqual([]);

      // Verify #65 browse toolbar rows and demoted archive utility bar stay clean with zero overflow
      const rowMetrics = await page.evaluate(() => {
        const container = document.querySelector('.index-filter-actions')!.getBoundingClientRect();
        const toggles = document.querySelector('.index-filter-toggles')!.getBoundingClientRect();
        const add = document.querySelector('.index-add-person-btn')!.getBoundingClientRect();
        const utilityBar = document.querySelector('.index-archive-utility-bar')!.getBoundingClientRect();
        const exportLink = document
          .querySelector('.index-archive-utility-bar .index-export-link')!
          .getBoundingClientRect();
        return {
          containerWidth: Math.round(container.width),
          togglesWidth: Math.round(toggles.width),
          addWidth: Math.round(add.width),
          addBelowToggles: add.top >= toggles.bottom - 2,
          exportInsideUtilityBar:
            exportLink.left >= utilityBar.left - 1.5 && exportLink.right <= utilityBar.right + 1.5,
          exportInFilterActions: Boolean(document.querySelector('.index-filter-actions .index-export-link')),
        };
      });
      expect(rowMetrics.togglesWidth).toBeGreaterThanOrEqual(rowMetrics.containerWidth - 4);
      expect(rowMetrics.addBelowToggles).toBe(true);
      expect(rowMetrics.addWidth).toBeGreaterThanOrEqual(rowMetrics.containerWidth - 4);
      expect(rowMetrics.exportInsideUtilityBar).toBe(true);
      expect(rowMetrics.exportInFilterActions).toBe(false);

      await maybeScreenshot(page, `index-signed-in-3digit-${vp.name}.png`);

      // TreePage signed-in Direct Line and Full Tree with 3-digit count (128)
      await navigateAndWaitReady(page, `${wiki.baseUrl}/tree?surface=roll`);
      await expect(page.locator('.tree-scope-segmented')).toBeVisible();
      await page.evaluate(() => {
        const buttons = [
          ...document.querySelectorAll<HTMLButtonElement>('.tree-scope-segmented .tree-seg-btn'),
        ];
        const fullBtn = buttons.find((b) => b.textContent?.includes('Full Tree'));
        if (fullBtn) {
          fullBtn.textContent = 'Full Tree (128)';
        }
      });
      const treeAudit = await runPerElementOverflowAndCollisionAudit(page);
      expect(treeAudit.docOverflowX, `3-digit /tree @ ${vp.name}`).toBeLessThanOrEqual(1);
      expect(treeAudit.elementOverflows, `3-digit /tree @ ${vp.name} elementOverflows`).toEqual([]);
      expect(treeAudit.textEscapes, `3-digit /tree @ ${vp.name} textEscapes`).toEqual([]);
      expect(treeAudit.parentEscapes, `3-digit /tree @ ${vp.name} parentEscapes`).toEqual([]);
      expect(treeAudit.siblingCollisions, `3-digit /tree @ ${vp.name} siblingCollisions`).toEqual([]);
      await expect(page.locator('.tree-toolbar .tree-add-person-btn')).toBeHidden();
      const addIconBox = await page.locator('.tree-add-person-mobile-btn').boundingBox();
      expect(addIconBox?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(addIconBox?.height ?? 0).toBeGreaterThanOrEqual(44);
      const scopeSpan = await page.evaluate(() => {
        const row = document.querySelector('.tree-toolbar-row-secondary')!.getBoundingClientRect();
        const seg = document.querySelector('.tree-scope-segmented')!.getBoundingClientRect();
        return { rowWidth: Math.round(row.width), segWidth: Math.round(seg.width) };
      });
      expect(scopeSpan.segWidth).toBeGreaterThanOrEqual(scopeSpan.rowWidth - 4);
      await maybeScreenshot(page, `tree-direct-3digit-${vp.name}.png`);
    }
  });

  test('W53-U1/U2b: zero per-element overflow, parent escape, or sibling collision across all 13 signed-in routes at 4 viewports', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await blockExternalMapTiles(page);
    await signInAsAdmin(page, wiki);
    await seedResearchBatch(page, wiki, 'batch_wave53b_matrix');

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      for (const route of CORE_ROUTES) {
        await navigateAndWaitReady(page, `${wiki.baseUrl}${route}`);
        const audit = await runPerElementOverflowAndCollisionAudit(page);
        expect(audit.docOverflowX, `signed-in ${route} @ ${vp.name} docOverflowX`).toBeLessThanOrEqual(1);
        expect(audit.elementOverflows, `signed-in ${route} @ ${vp.name} elementOverflows`).toEqual([]);
        expect(audit.textEscapes, `signed-in ${route} @ ${vp.name} textEscapes`).toEqual([]);
        expect(audit.parentEscapes, `signed-in ${route} @ ${vp.name} parentEscapes`).toEqual([]);
        expect(audit.siblingCollisions, `signed-in ${route} @ ${vp.name} siblingCollisions`).toEqual([]);
      }
    }
  });

  test('W53-U3/U8: Tree child-tray uses parent-relative wording, sums consistently across Direct Line and Full Tree, and renders full spouse names', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);
    await signInAsAdmin(page, wiki);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto(`${wiki.baseUrl}/tree?surface=roll&mode=spine`, { waitUntil: 'networkidle' });
    const pill = page.locator('button.tree-sibling-pill').first();
    await expect(pill).toBeVisible();

    const directText = (await pill.textContent()) ?? '';
    expect(directText).not.toMatch(/\bsibling/i);
    expect(directText).toMatch(/other child(?:ren)? \(\d+ in direct line below\)/);

    const directMatch = directText.match(/\+(\d+) other child(?:ren)? \((\d+) in direct line below\)/);
    expect(directMatch).not.toBeNull();
    const directTotal = Number(directMatch![1]) + Number(directMatch![2]);

    await pill.click();
    await expect(pill).toHaveAttribute('aria-expanded', 'true');
    const expandedText = (await pill.textContent()) ?? '';
    expect(expandedText).toContain(`Hide ${directMatch![1]} other child`);

    // Check full spouse name renders on dedicated sub-line if any child in the tray has a spouse
    const spouseSubLines = await page.locator('.tree-hanging-grid .tree-roll-card-spouse').allTextContents();
    for (const line of spouseSubLines) {
      expect(line).toMatch(/^m\. \S+\s+\S+/);
    }

    await maybeScreenshot(page, 'tree-direct-expanded-390x844.png');

    // Switch to Full Tree and verify counts stay transparent and consistent
    await page.locator('.tree-scope-segmented .tree-seg-btn', { hasText: 'Full Tree' }).click();
    await page.waitForTimeout(100);
    const fullPills = await page.locator('button.tree-sibling-pill').allTextContents();
    for (const text of fullPills) {
      expect(text).not.toMatch(/\bsibling/i);
      const m = text.match(/(\d+) other child(?:ren)? \((\d+) shown below\)/);
      if (m) {
        expect(Number(m[1]) + Number(m[2])).toBeGreaterThanOrEqual(2);
      }
    }
    expect(directTotal).toBeGreaterThanOrEqual(2);
    await maybeScreenshot(page, 'tree-full-3digit-390x844.png');
  });

  test('W53-U4: AuthStatusBanner auto-opens SignInModal on invite_viewer auth_error redirect and preserves focus on Magic Link submit', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);
    await page.setViewportSize({ width: 360, height: 800 });

    // Establish invite_viewer session first
    await page.goto(`${wiki.baseUrl}/api/auth/invite/${wiki.inviteToken}`, {
      waitUntil: 'networkidle',
    });
    await expect(page.getByRole('region', { name: 'Invite access notice' })).toBeVisible();

    // Navigate with auth_error query parameters -> SignInModal must auto-open after /api/session resolves
    await page.goto(
      `${wiki.baseUrl}/person/abraham-lincoln-1809?auth_error=INVITE_REQUIRED&auth_provider=google`,
      { waitUntil: 'networkidle' }
    );

    const dialog = page.getByRole('dialog', { name: 'Sign in to family archive' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.wiki-auth-feedback')).toBeVisible();

    // Submit Magic Link -> focus moves inside .wiki-auth-sent (never BODY), and duplicate invite banner hides
    await dialog.getByLabel('Email address').fill('focus.check@archive.example');
    await dialog.getByRole('button', { name: 'Email Magic Link' }).click();
    await expect(dialog.locator('.wiki-auth-sent')).toBeVisible();

    const activeState = await page.evaluate(() => ({
      tag: document.activeElement?.tagName ?? '',
      insideSent: Boolean(document.activeElement?.closest('.wiki-auth-sent')),
      infoBannerCount: document.querySelectorAll('.wiki-signin-card .wiki-status-banner.is-info').length,
    }));
    expect(activeState.tag).not.toBe('BODY');
    expect(activeState.insideSent).toBe(true);
    expect(activeState.infoBannerCount).toBe(0);

    // Escape closes dialog cleanly
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('W53-U6/U9: EntityEditDrawer keeps header and footer visible in viewport on Pronunciation Edit jump and meets 44px touch floor', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);
    await signInAsAdmin(page, wiki);

    for (const vp of [
      { name: '360x800', width: 360, height: 800 },
      { name: '768x1024', width: 768, height: 1024 },
      { name: '1280x800', width: 1280, height: 800 },
    ]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`${wiki.baseUrl}/person/abraham-lincoln-1809`, { waitUntil: 'networkidle' });
      const editPronBtn = page.locator('.pronunciation-edit-link').first();
      await expect(editPronBtn).toBeVisible();
      await editPronBtn.click();

      const drawer = page.getByRole('dialog', { name: /Edit Abraham Lincoln/ });
      await expect(drawer).toBeVisible();
      await page.waitForTimeout(150);

      const stickyCheck = await page.evaluate(() => {
        const top = document.querySelector('.wiki-edit-drawer-panel > .drawer-top')!.getBoundingClientRect();
        const footer = document.querySelector('.wiki-drawer-footer')!.getBoundingClientRect();
        const saveBtn = document
          .querySelector('.wiki-drawer-footer button[type="submit"]')!
          .getBoundingClientRect();
        const hint = document.querySelector('.wiki-drawer-footer-hint')?.textContent?.trim() ?? '';
        return {
          vh: window.innerHeight,
          topVisible: top.top >= -1 && top.bottom <= window.innerHeight + 1,
          footerVisible: footer.top >= 0 && footer.bottom <= window.innerHeight + 1,
          saveBtnHeight: Math.round(saveBtn.height),
          hint,
        };
      });
      expect(stickyCheck.topVisible, `drawer header visible @ ${vp.name}`).toBe(true);
      expect(stickyCheck.footerVisible, `drawer footer visible @ ${vp.name}`).toBe(true);
      expect(stickyCheck.hint).toBe('Change any field to save.');
      if (vp.width <= 768) {
        expect(stickyCheck.saveBtnHeight, `Save button >= 44px @ ${vp.name}`).toBeGreaterThanOrEqual(44);
      }

      if (vp.name === '360x800') {
        await maybeScreenshot(page, 'edit-drawer-pronunciation-360x800.png');
      }

      await drawer.getByRole('button', { name: 'Close', exact: true }).click();
    }
  });

  test('Issue #28: Mobile 390x844 Edit Pronunciation shows segmented shared token chips above the fold with >= 44px tap targets and inline token editing', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);
    await signInAsAdmin(page, wiki);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${wiki.baseUrl}/person/mary-ann-todd`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Mary Ann Todd', exact: true })).toBeVisible();

    const editPronBtn = page.locator('.pronunciation-edit-link').first();
    await expect(editPronBtn).toBeVisible();
    await editPronBtn.click();

    const drawer = page.getByRole('dialog', { name: /Edit Mary Ann Todd/ });
    await expect(drawer).toBeVisible();
    await page.waitForTimeout(150);

    const tokenChips = drawer.locator('[data-pronunciation-token]');
    await expect(tokenChips).toHaveCount(3);
    await expect(drawer.locator('[data-pronunciation-token="Mary"]')).toBeVisible();
    await expect(drawer.locator('[data-pronunciation-token="Ann"]')).toBeVisible();
    await expect(drawer.locator('[data-pronunciation-token="Todd"]')).toBeVisible();

    // Composed preview renders and Personal override stays collapsed when all shared tokens resolve
    await expect(drawer.getByTestId('pronunciation-composed-preview')).toContainText('MAIR-ee AN TAHD');
    await expect(drawer.getByRole('button', { name: 'Customize for this person only' })).toBeVisible();

    const mobileMetrics = await page.evaluate(() => {
      const body = document.querySelector('.wiki-edit-drawer-body')!;
      const bodyRect = body.getBoundingClientRect();
      const fieldset = document.querySelector('.wiki-pronunciation-fieldset')!;
      const legend = fieldset.querySelector('legend')!;
      const legendRect = legend.getBoundingClientRect();
      const chips = [...document.querySelectorAll<HTMLButtonElement>('[data-pronunciation-token]')].map(
        (btn) => {
          const r = btn.getBoundingClientRect();
          return {
            token: btn.dataset.pronunciationToken ?? '',
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            height: Math.round(r.height),
            inBodyViewport: r.top >= bodyRect.top - 2 && r.bottom <= bodyRect.bottom + 2,
          };
        }
      );
      return {
        pageOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bodyOverflowPx: body.scrollWidth - body.clientWidth,
        legendInBodyViewport: legendRect.top >= bodyRect.top - 2 && legendRect.bottom <= bodyRect.bottom + 2,
        chips,
      };
    });

    expect(mobileMetrics.pageOverflowPx).toBeLessThanOrEqual(0);
    expect(mobileMetrics.bodyOverflowPx).toBeLessThanOrEqual(0);
    expect(mobileMetrics.legendInBodyViewport).toBe(true);
    for (const chip of mobileMetrics.chips) {
      expect(chip.height, `token chip ${chip.token} height >= 44px`).toBeGreaterThanOrEqual(44);
      expect(chip.inBodyViewport, `token chip ${chip.token} visible above the fold`).toBe(true);
    }

    // Tap the given-name token chip ("Mary"), verify IPA-in-Respelling inline hint, and save cleanly
    await drawer.locator('[data-pronunciation-token="Mary"]').click();
    const sharedEditor = drawer.locator('.wiki-pronunciation-shared-editor');
    await expect(sharedEditor).toBeVisible();
    await expect(sharedEditor).toContainText('Shared pronunciation for “Mary”');

    const sharedRespellingInput = sharedEditor.getByLabel('Respelling');
    await sharedRespellingInput.fill('MAIR-ə');
    await expect(sharedEditor).toContainText('Found IPA symbol (ə)');

    await sharedRespellingInput.fill('MAIR-ee');
    await expect(sharedEditor).not.toContainText('Found IPA symbol');
    await sharedEditor.getByRole('button', { name: 'Save for all Mary records' }).click();
    await expect(drawer).toContainText('Saved shared pronunciation for "Mary"');

    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  });

  test('W53-U5/U7: Mobile 360px RevisionDiffView stacks full-width, destructive actions confirm, and Admin blocks self-demotion with Copy Link', async ({
    page,
  }) => {
    await blockExternalMapTiles(page);
    await signInAsAdmin(page, wiki);
    await seedResearchBatch(page, wiki, 'batch_wave53b_mobile_diff');
    await page.setViewportSize({ width: 360, height: 800 });

    // 1. RecentChangesPage stacked mobile diff + Revert confirmation
    await page.goto(`${wiki.baseUrl}/changes`, { waitUntil: 'networkidle' });
    const batchSection = page.locator('section.wiki-batch-group', {
      hasText: 'batch_wave53b_mobile_diff',
    });
    await expect(batchSection).toBeVisible();
    await expect(batchSection).toContainText('Research Field Report:');

    const firstViewDiff = batchSection.getByRole('button', { name: 'View Diff' }).first();
    await expect(firstViewDiff).toHaveAttribute('aria-expanded', 'false');
    await firstViewDiff.click();
    await expect(batchSection.getByRole('button', { name: 'Hide Diff' }).first()).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    const diffWidths = await batchSection
      .locator('.wiki-diff-table td')
      .evaluateAll((cells) => cells.map((c) => Math.round(c.getBoundingClientRect().width)));
    expect(diffWidths.length).toBeGreaterThanOrEqual(2);
    for (const width of diffWidths) {
      expect(width, 'mobile diff cell stacks full-width >= 260px').toBeGreaterThanOrEqual(260);
    }

    await maybeScreenshot(page, 'changes-diff-360x800.png');

    // Revert Entire Batch requires explicit confirmation; Cancel aborts safely
    await batchSection.getByRole('button', { name: 'Revert Entire Batch' }).click();
    await expect(batchSection.getByRole('button', { name: 'Confirm Batch Revert' })).toBeVisible();
    await batchSection.getByRole('button', { name: 'Cancel' }).click();
    await expect(batchSection.getByRole('button', { name: 'Revert Entire Batch' })).toBeVisible();

    // 2. AdminPage self-demotion guard, Copy Link, and Revoke confirmation
    await page.goto(`${wiki.baseUrl}/admin`, { waitUntil: 'networkidle' });
    const selfRow = page.locator('.wiki-admin-row', { hasText: wiki.adminEmail });
    await expect(selfRow).toContainText('You');
    await expect(selfRow.getByRole('button', { name: 'Demote to Editor' })).toBeDisabled();

    // Create invite -> Copy Invite Link & Dismiss visible; active rows also have Copy Link
    await page.getByLabel('Invite label').fill('Wave 53B Cousins');
    await page.getByRole('button', { name: 'Generate Invite Link' }).click();
    const createdBanner = page.locator('output.wiki-status-banner.is-success');
    await expect(createdBanner.getByRole('button', { name: 'Copy Invite Link' })).toBeVisible();
    await expect(createdBanner.getByRole('button', { name: 'Dismiss' })).toBeVisible();

    const inviteRow = page.locator('.wiki-admin-row', { hasText: 'Wave 53B Cousins' });
    await expect(inviteRow.getByRole('button', { name: 'Copy Link' })).toBeVisible();

    // Revoke requires explicit Confirm Revoke click
    await inviteRow.getByRole('button', { name: 'Revoke' }).click();
    await expect(inviteRow.getByRole('button', { name: 'Confirm Revoke' })).toBeVisible();
    await inviteRow.getByRole('button', { name: 'Cancel' }).click();
    await expect(inviteRow.getByRole('button', { name: 'Revoke' })).toBeVisible();

    await maybeScreenshot(page, 'admin-360x800.png');
  });
});
