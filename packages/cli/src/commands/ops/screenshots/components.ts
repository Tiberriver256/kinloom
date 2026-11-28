import type {
  BundleDiscoveryResult,
  ComponentCaptureTarget,
  ScreenshotLocatorHandle,
  ScreenshotPageHandle,
  ViewportSpec,
} from './types.js';

export type PreparedComponentCapture =
  | {
      readonly kind: 'element';
      readonly locator: ScreenshotLocatorHandle;
    }
  | {
      readonly kind: 'viewport';
      readonly fullPage: boolean;
    }
  | {
      readonly kind: 'skip';
      readonly reason: string;
    };

export interface ComponentPrepareContext {
  readonly viewport: ViewportSpec;
  readonly searchQuery: string;
  readonly actionTimeoutMs: number;
  readonly settleMs: number;
}

export function buildComponentCaptureTargets(
  discovery: BundleDiscoveryResult
): readonly ComponentCaptureTarget[] {
  const samplePerson = discovery.people[0];
  const samplePlace = discovery.places[0];
  const personRoute = samplePerson ? `/person/${samplePerson.slug}` : '/';
  const pronunciationRoute = samplePerson
    ? `/person/${samplePerson.slug}`
    : samplePlace
      ? `/place/${samplePlace.slug}`
      : '/';

  const spec = (
    slug: string,
    state: string,
    label: string,
    route: string,
    recipeId: ComponentCaptureTarget['recipeId'],
    extra?: { readonly viewportFilter?: readonly string[]; readonly fullPage?: boolean }
  ): ComponentCaptureTarget => ({
    category: 'component',
    id: `component:${slug}:${state}`,
    slug,
    state,
    label,
    route,
    recipeId,
    ...extra,
  });

  return [
    spec('topbar', 'default', 'Top Bar Navigation', '/', 'topbar-default'),
    spec('topbar', 'mobile-menu-open', 'Top Bar Mobile Menu', '/', 'topbar-mobile-menu', {
      viewportFilter: ['mobile'],
      fullPage: false,
    }),
    spec('global-search', 'open', 'Global Search Modal', '/', 'global-search-open', { fullPage: false }),
    spec('global-search', 'results', 'Global Search Results', '/', 'global-search-results', {
      fullPage: false,
    }),
    spec('theme-toggle', 'toggled', 'Theme Toggle Control', '/', 'theme-toggle'),
    spec(
      'pronunciation-badge',
      'default',
      'Pronunciation Badge',
      pronunciationRoute,
      'pronunciation-badge-default'
    ),
    spec(
      'pronunciation-badge',
      'variant',
      'Pronunciation Badge Variant / Detail',
      pronunciationRoute,
      'pronunciation-badge-variant'
    ),
    spec('source-reader', 'open', 'Source Reader Drawer', '/', 'source-reader-open', { fullPage: false }),
    spec('media-lightbox', 'open', 'Media Lightbox', personRoute, 'media-lightbox-open', { fullPage: false }),
    spec('tree-controls', 'default', 'Family Tree Controls', '/tree', 'tree-controls'),
    spec('tree-focus-card', 'open', 'Family Tree Focus Card', '/tree', 'tree-focus-card', {
      fullPage: false,
    }),
    spec('map-controls', 'default', 'Map Controls & Legend', '/map', 'map-controls', { fullPage: false }),
    spec('map-stop-card', 'open', 'Map Stop Card', '/map', 'map-stop-card', { fullPage: false }),
    spec('auth-sign-in', 'open', 'Sign-In Modal / Auth Banner', '/', 'auth-sign-in-modal', {
      fullPage: false,
    }),
    spec('narrative-audio', 'player-bar', 'Narrative Audio Player Bar', personRoute, 'narrative-audio-bar'),
    spec('footer', 'default', 'Archive Footer', '/', 'footer-default'),
  ];
}

async function findFirstVisible(
  page: ScreenshotPageHandle,
  selectors: readonly string[],
  options?: { readonly requireEnabled?: boolean }
): Promise<ScreenshotLocatorHandle | null> {
  const requireEnabled = options?.requireEnabled ?? false;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const total = await locator.count();
    const limit = Math.min(total, 6);
    for (let i = 0; i < limit; i += 1) {
      const candidate = locator.nth(i);
      try {
        if (await candidate.isVisible()) {
          if (requireEnabled && candidate.isDisabled && (await candidate.isDisabled())) {
            continue;
          }
          const box = await candidate.boundingBox();
          if (box && box.width > 1 && box.height > 1) {
            return candidate;
          }
        }
      } catch {
        // Ignore detached or transient element checks.
      }
    }
  }
  return null;
}

async function openGlobalSearchModal(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<ScreenshotLocatorHandle | null> {
  const trigger = await findFirstVisible(page, [
    'button[aria-label="Search archive"]',
    'button[aria-label*="Search" i]',
    'header button:has-text("Search")',
  ]);
  if (trigger) {
    await trigger.click({ timeout: ctx.actionTimeoutMs });
  } else {
    await page.keyboard.press('/');
  }
  await page.waitForTimeout(Math.min(ctx.settleMs, 250));
  return findFirstVisible(page, [
    'dialog[open][aria-label*="Search" i]',
    'dialog[open] input[type="search"]',
    '[role="dialog"] input[type="search"]',
  ]);
}

async function prepareTopbarMobileMenu(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const menuButton = await findFirstVisible(page, [
    'button[aria-label="Archive menu"]',
    'button[aria-label*="Account menu" i]',
    'header button[aria-haspopup="menu"]',
    'header button[aria-expanded]',
  ]);
  if (!menuButton) {
    return { kind: 'skip', reason: 'Mobile menu trigger not visible at this viewport' };
  }
  await menuButton.click({ timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(Math.min(ctx.settleMs, 250));
  const menu = await findFirstVisible(page, ['[role="menu"]', '[aria-label="Archive menu"][role="menu"]']);
  if (!menu) {
    return { kind: 'skip', reason: 'Mobile menu panel did not open after clicking trigger' };
  }
  return { kind: 'viewport', fullPage: false };
}

async function prepareGlobalSearchResults(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const opened = await openGlobalSearchModal(page, ctx);
  if (!opened) {
    return { kind: 'skip', reason: 'Global search dialog not available on target page' };
  }
  const input = await findFirstVisible(page, [
    'dialog[open] input[type="search"]',
    '[role="dialog"] input[type="search"]',
    'input[aria-label*="Search" i]',
  ]);
  if (!input) {
    return { kind: 'skip', reason: 'Global search input not visible inside search dialog' };
  }
  await input.fill(ctx.searchQuery, { timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(ctx.settleMs);
  return { kind: 'viewport', fullPage: false };
}

async function preparePronunciationVariant(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const variantButtons = page.locator(
    '[role="group"][aria-label*="Pronunciation" i] button, button[aria-expanded][aria-label*="pronunciation" i]'
  );
  const count = await variantButtons.count();
  if (count === 0) {
    return { kind: 'skip', reason: 'No expandable pronunciation variant or detail trigger present' };
  }
  const targetIdx = count > 1 ? 1 : 0;
  const button = variantButtons.nth(targetIdx);
  if (!(await button.isVisible())) {
    return { kind: 'skip', reason: 'Pronunciation variant control is hidden' };
  }
  await button.click({ timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(Math.min(ctx.settleMs, 200));
  const badge = await findFirstVisible(page, ['[class*="pronunciation-badge"]', '[data-coverage]']);
  if (!badge) {
    return { kind: 'viewport', fullPage: false };
  }
  return { kind: 'element', locator: badge };
}

async function prepareSourceReaderOpen(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const trigger = await findFirstVisible(page, [
    'header button:has-text("Sources")',
    'button:has-text("Read Source")',
    'button:has-text("Open Source Reader")',
  ]);
  if (!trigger) {
    return { kind: 'skip', reason: 'No visible Sources reader trigger on current viewport' };
  }
  await trigger.click({ timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(ctx.settleMs);
  const dialog = await findFirstVisible(page, [
    'dialog[open][aria-label*="Source" i]',
    '[role="dialog"][aria-label*="Source" i]',
  ]);
  if (!dialog) {
    return { kind: 'skip', reason: 'Source reader drawer did not open' };
  }
  return { kind: 'viewport', fullPage: false };
}

async function prepareMediaLightboxOpen(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const thumbBtn = await findFirstVisible(page, [
    '#person-media button[class*="person-media-card"]',
    '#person-media button',
    'main button[class*="media-card"]',
  ]);
  if (!thumbBtn) {
    return { kind: 'skip', reason: 'No media thumbnail available to open lightbox' };
  }
  await thumbBtn.click({ timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(ctx.settleMs);
  const dialog = await findFirstVisible(page, [
    'dialog[open][aria-label*="lightbox" i]',
    'dialog[open]',
    '[role="dialog"]',
  ]);
  if (!dialog) {
    return { kind: 'skip', reason: 'Media lightbox dialog did not open' };
  }
  return { kind: 'viewport', fullPage: false };
}

async function prepareTreeFocusCard(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const nodeButton = await findFirstVisible(page, [
    '[class*="tree-node"] button',
    '[data-person-id]',
    'main [role="button"]',
  ]);
  if (!nodeButton) {
    return { kind: 'skip', reason: 'No interactive family tree person node found to focus' };
  }
  await nodeButton.click({ timeout: ctx.actionTimeoutMs });
  await page.waitForTimeout(ctx.settleMs);
  const focusDrawer = await findFirstVisible(page, [
    'aside[aria-label*="Focus" i]',
    '[class*="tree-focus"]',
    'button:has-text("Clear focus")',
  ]);
  if (!focusDrawer) {
    return { kind: 'skip', reason: 'Tree focus card did not open after clicking node' };
  }
  return { kind: 'viewport', fullPage: false };
}

async function prepareMapStopCard(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const alreadyOpen = await findFirstVisible(page, [
    'section[aria-label="Selected stop details"]',
    '[class*="map-stop-popover"]',
  ]);
  if (alreadyOpen) {
    return { kind: 'viewport', fullPage: false };
  }

  // Target the deterministic Next step button instead of generic dock buttons
  // (the first dock button is Play Route, which triggers continuous animation).
  const nextOrStopBtn = await findFirstVisible(
    page,
    [
      'button[aria-label*="Next stop" i]',
      'button[aria-label*="Next" i]',
      '[data-map-playback-bar="true"] button:has-text("Next")',
      '[class*="map-bottom-dock"] button:has-text("Next")',
      'button:has-text("Next →")',
    ],
    { requireEnabled: true }
  );
  if (!nextOrStopBtn) {
    return { kind: 'skip', reason: 'No enabled interactive map stop control found' };
  }
  await nextOrStopBtn.click({ timeout: ctx.actionTimeoutMs });
  try {
    await page.waitForSelector(
      'section[aria-label="Selected stop details"], [class*="map-stop-popover"], #stopCard',
      {
        state: 'visible',
        timeout: Math.min(ctx.actionTimeoutMs, 2_000),
      }
    );
  } catch {
    // Allow synthetic or minimal map docks to settle without failing if selector differs.
  }
  await page.waitForTimeout(Math.min(ctx.settleMs, 400));
  return { kind: 'viewport', fullPage: false };
}

async function prepareAuthSignInModal(
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  const signInBtn = await findFirstVisible(page, [
    'button:has-text("Sign in to edit")',
    'button:has-text("Sign in")',
  ]);
  if (signInBtn) {
    await signInBtn.click({ timeout: ctx.actionTimeoutMs });
    await page.waitForTimeout(Math.min(ctx.settleMs, 250));
    const dialog = await findFirstVisible(page, ['dialog[open][aria-label*="Sign in" i]', 'dialog[open]']);
    if (dialog) {
      return { kind: 'viewport', fullPage: false };
    }
  }
  const banner = await findFirstVisible(page, [
    '[role="region"][aria-label="Invite access notice"]',
    '[class*="wiki-auth-banner"]',
  ]);
  if (banner) {
    return { kind: 'element', locator: banner };
  }
  return { kind: 'skip', reason: 'No sign-in modal or auth status banner present on target site' };
}

export async function prepareComponentCapture(
  target: ComponentCaptureTarget,
  page: ScreenshotPageHandle,
  ctx: ComponentPrepareContext
): Promise<PreparedComponentCapture> {
  if (target.viewportFilter && !target.viewportFilter.includes(ctx.viewport.name)) {
    return {
      kind: 'skip',
      reason: `Only applicable to viewports: ${target.viewportFilter.join(', ')}`,
    };
  }

  switch (target.recipeId) {
    case 'topbar-default': {
      const header = await findFirstVisible(page, ['header', '[role="banner"]']);
      return header
        ? { kind: 'element', locator: header }
        : { kind: 'skip', reason: 'Header element not found on page' };
    }
    case 'topbar-mobile-menu':
      return prepareTopbarMobileMenu(page, ctx);
    case 'global-search-open': {
      const opened = await openGlobalSearchModal(page, ctx);
      return opened
        ? { kind: 'viewport', fullPage: false }
        : { kind: 'skip', reason: 'Global search dialog not available on target page' };
    }
    case 'global-search-results':
      return prepareGlobalSearchResults(page, ctx);
    case 'theme-toggle': {
      const toggle = await findFirstVisible(
        page,
        [
          '[data-testid="theme-toggle"]',
          'button[aria-label*="theme" i]',
          'button[aria-label*="dark mode" i]',
          'button[aria-label*="light mode" i]',
        ],
        { requireEnabled: true }
      );
      if (!toggle) {
        return { kind: 'skip', reason: 'No theme toggle control found on page' };
      }
      await toggle.click({ timeout: ctx.actionTimeoutMs });
      await page.waitForTimeout(Math.min(ctx.settleMs, 200));
      return { kind: 'element', locator: toggle };
    }
    case 'pronunciation-badge-default': {
      const badge = await findFirstVisible(page, [
        '[class*="pronunciation-badge"]',
        'button[aria-label^="Listen to pronunciation"]',
      ]);
      return badge
        ? { kind: 'element', locator: badge }
        : { kind: 'skip', reason: 'No pronunciation badge rendered on sampled profile' };
    }
    case 'pronunciation-badge-variant':
      return preparePronunciationVariant(page, ctx);
    case 'source-reader-open':
      return prepareSourceReaderOpen(page, ctx);
    case 'media-lightbox-open':
      return prepareMediaLightboxOpen(page, ctx);
    case 'tree-controls': {
      const toolbar = await findFirstVisible(page, [
        '[role="toolbar"][aria-label*="Family tree" i]',
        '[class*="tree-toolbar"]',
      ]);
      return toolbar
        ? { kind: 'element', locator: toolbar }
        : { kind: 'skip', reason: 'Family tree toolbar not rendered on /tree' };
    }
    case 'tree-focus-card':
      return prepareTreeFocusCard(page, ctx);
    case 'map-controls': {
      const overlay = await findFirstVisible(page, [
        'aside[aria-label="Migration stage color legend"]',
        '[class*="map-toolbar"]',
        '[class*="map-bottom-dock"]',
      ]);
      return overlay
        ? { kind: 'viewport', fullPage: false }
        : { kind: 'skip', reason: 'Map overlay controls not rendered on /map' };
    }
    case 'map-stop-card':
      return prepareMapStopCard(page, ctx);
    case 'auth-sign-in-modal':
      return prepareAuthSignInModal(page, ctx);
    case 'narrative-audio-bar': {
      const player = await findFirstVisible(page, [
        '[data-testid="narrative-audio-margin-bar"]',
        '[role="region"][aria-label^="Audio narration"]',
      ]);
      return player
        ? { kind: 'element', locator: player }
        : { kind: 'skip', reason: 'No narrative audio player rendered on sampled biography' };
    }
    case 'footer-default': {
      const footer = await findFirstVisible(page, ['footer', '[role="contentinfo"]']);
      return footer
        ? { kind: 'element', locator: footer }
        : { kind: 'skip', reason: 'Footer element not found on page' };
    }
    default: {
      const _exhaustive: never = target.recipeId;
      return _exhaustive;
    }
  }
}
