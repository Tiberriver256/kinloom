/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveDataSource, KinloomSiteConfig } from '@kinloom/core';
import { parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStatusBanner } from '../components/wiki/AuthStatusBanner.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { buildSynthetic145PersonArchive } from '../lib/tree/largeMultiBranchTree.test.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../../../..');

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Hale Historical Archive',
    familyName: 'Hale',
    gedcomSourceName: 'HALE_POLISH_TEST',
  },
});

const PENDING_DATA_SOURCE: ArchiveDataSource = {
  loadArchive: () => new Promise(() => {}),
  loadReadings: () => new Promise(() => {}),
};

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): HTMLDivElement {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  cleanups.push(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });
  return container;
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  document.documentElement.style.removeProperty('--auth-banner-height');
  window.sessionStorage.clear();
});

describe('Issue #108: full-viewport invite banner offset, Tree minimap/padding, mobile couples, h1 & skeleton', () => {
  it('syncs AuthStatusBanner invite strip height into --auth-banner-height and clears it on dismiss', () => {
    const container = mountEl(
      <ArchiveProvider
        siteConfig={SITE_CONFIG}
        dataSource={PENDING_DATA_SOURCE}
        session={{
          authenticated: true,
          principal_kind: 'invite_viewer',
          inviteLabel: 'Family Preview',
          role: 'viewer',
        }}
      >
        <AuthStatusBanner />
      </ArchiveProvider>
    );

    const banner = container.querySelector<HTMLElement>('.wiki-auth-banner');
    expect(banner).not.toBeNull();

    // Simulate a 38px rendered invite banner and trigger resize sync.
    banner!.getBoundingClientRect = () =>
      ({
        width: 1440,
        height: 38,
        top: 0,
        left: 0,
        right: 1440,
        bottom: 38,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(document.documentElement.style.getPropertyValue('--auth-banner-height')).toBe('38px');

    const dismissBtn = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Dismiss family invite notice"]'
    );
    expect(dismissBtn).not.toBeNull();
    act(() => {
      dismissBtn!.click();
    });

    expect(document.documentElement.style.getPropertyValue('--auth-banner-height')).toBe('0px');
  });

  it('defines --shell-chrome-offset and translucent <= 0.15 alpha minimap fill tokens and lowers main#main-content specificity', () => {
    const tokensCss = readFileSync(join(REPO_ROOT, 'packages/tokens/kinloom.css'), 'utf8');
    expect(tokensCss).toContain('--auth-banner-height: 0px;');
    expect(tokensCss).toContain(
      '--shell-chrome-offset: calc(var(--topbar-height) + var(--auth-banner-height, 0px));'
    );

    const minimapFillMatches = [
      ...tokensCss.matchAll(/--tree-minimap-viewport-fill:\s*rgba\([^,]+,[^,]+,[^,]+,\s*([0-9.]+)\);/g),
    ];
    expect(minimapFillMatches.length).toBeGreaterThanOrEqual(3);
    for (const match of minimapFillMatches) {
      const alpha = Number(match[1]);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThanOrEqual(0.15);
    }

    const archivalCss = readFileSync(join(REPO_ROOT, 'packages/ui/src/styles/archival.css'), 'utf8');
    expect(archivalCss).toContain(':where(main#main-content)');
    expect(archivalCss).toContain('--shell-chrome-offset');

    const mapCss = readFileSync(join(REPO_ROOT, 'packages/ui/src/pages/MapPage.module.css'), 'utf8');
    expect(mapCss).toContain('flex: 1 1 0%;');
    expect(mapCss).toContain('min-height: 0;');

    const treeCss = readFileSync(join(REPO_ROOT, 'packages/ui/src/pages/TreePage.module.css'), 'utf8');
    expect(treeCss).toContain('.tree-shell-diagram .tree-page-diagram');
    expect(treeCss).toContain('var(--shell-chrome-offset, var(--topbar-height))');
  });

  it('renders the large Tree Chart minimap viewport frame as a 1.5px non-scaling translucent outline and reserves safe padding for zoom controls and minimap', () => {
    const { bundle } = buildSynthetic145PersonArchive();
    const container = mountEl(
      <MemoryRouter initialEntries={['/tree?surface=diagram&mode=full']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={bundle}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const viewportRect = container.querySelector<SVGRectElement>('.tree-minimap-viewport');
    expect(viewportRect).not.toBeNull();
    expect(viewportRect!.getAttribute('stroke')).toBe('var(--accent-primary)');
    expect(viewportRect!.getAttribute('stroke-width')).toBe('1.5');
    expect(viewportRect!.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(viewportRect!.getAttribute('fill')).toContain('var(--tree-minimap-viewport-fill');

    // Mock 1440x804 canvas (1440x900 minus 38px invite banner and 58px topbar) with measured controls + minimap.
    const mainEl = container.querySelector<HTMLElement>('main#main-content');
    const controlsEl = container.querySelector<HTMLElement>('.tree-controls');
    const minimapEl = container.querySelector<HTMLElement>('.tree-minimap');
    expect(mainEl).not.toBeNull();
    expect(controlsEl).not.toBeNull();
    expect(minimapEl).not.toBeNull();

    Object.defineProperty(mainEl!, 'clientWidth', { configurable: true, value: 1440 });
    Object.defineProperty(mainEl!, 'clientHeight', { configurable: true, value: 804 });
    controlsEl!.getBoundingClientRect = () =>
      ({
        width: 62,
        height: 220,
        top: 566,
        left: 1360,
        right: 1422,
        bottom: 786,
        x: 1360,
        y: 566,
        toJSON: () => ({}),
      }) as DOMRect;
    minimapEl!.getBoundingClientRect = () =>
      ({
        width: 204,
        height: 156,
        top: 630,
        left: 18,
        right: 222,
        bottom: 786,
        x: 18,
        y: 630,
        toJSON: () => ({}),
      }) as DOMRect;

    const fitBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (btn) => btn.textContent?.trim() === 'Fit'
    );
    expect(fitBtn).not.toBeNull();

    // Trigger reduced-motion immediate fit so transform updates synchronously without rAF delay.
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      act(() => {
        fitBtn!.click();
      });

      const zoom = Number(mainEl!.dataset['zoom']);
      const panX = Number(mainEl!.dataset['panX']);
      const panY = Number(mainEl!.dataset['panY']);
      const stageEl = container.querySelector<HTMLElement>('.tree-stage');
      const stageW = Number.parseFloat(stageEl?.style.width ?? '0');
      const stageH = Number.parseFloat(stageEl?.style.height ?? '0');

      expect(zoom).toBeGreaterThan(0);
      // Fitted content right edge stays clear of zoom controls (width 62 + 36 = 98px reserve).
      expect(panX + stageW * zoom).toBeLessThanOrEqual(1440 - 96);
      // Fitted content bottom edge stays clear of expanded minimap (height 156 + 34 = 190px reserve).
      expect(panY + stageH * zoom).toBeLessThanOrEqual(804 - 188);
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it('stacks mobile /tree List couple cards below 420px so multi-word names do not cramp', () => {
    const rollCss = readFileSync(
      join(REPO_ROOT, 'packages/ui/src/components/tree/TreePedigreeRoll.module.css'),
      'utf8'
    );
    const mobile420Idx = rollCss.indexOf('@media (max-width: 420px)');
    expect(mobile420Idx).toBeGreaterThan(-1);
    const mobile420Block = rollCss.slice(mobile420Idx, mobile420Idx + 700);
    expect(mobile420Block).toContain('.tree-roll-couple-row');
    expect(mobile420Block).toContain('flex-direction: column;');
    expect(mobile420Block).toContain('.tree-roll-partner-pair');
    expect(mobile420Block).toContain('width: 100%;');
    expect(mobile420Block).toContain('max-width: none;');
  });

  it('renders non-clipping accessible h1 landmarks on /tree and /map and replaces the /tree loading spinner with a layout-matched skeleton', () => {
    const canvasPrimitivesCss = readFileSync(
      join(REPO_ROOT, 'packages/ui/src/components/CanvasSurfacePrimitives.module.css'),
      'utf8'
    );
    expect(canvasPrimitivesCss).toContain('.canvas-sr-heading');
    expect(canvasPrimitivesCss).toContain('width: auto;');
    expect(canvasPrimitivesCss).toContain('height: auto;');
    expect(canvasPrimitivesCss).toContain('overflow: visible;');

    const mapPageSrc = readFileSync(join(REPO_ROOT, 'packages/ui/src/pages/MapPage.tsx'), 'utf8');
    expect(mapPageSrc).toContain(
      "<h1 className={cx(canvasSurfaceStyles, 'canvas-sr-heading')}>{pageHeading}</h1>"
    );

    const loadingContainer = mountEl(
      <MemoryRouter initialEntries={['/tree?surface=diagram']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={PENDING_DATA_SOURCE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const loadingH1 = loadingContainer.querySelector('h1');
    expect(loadingH1).not.toBeNull();
    expect(loadingH1!.className).toContain('canvas-sr-heading');
    expect(loadingH1!.className).not.toContain('visually-hidden');

    expect(loadingContainer.querySelector('.archive-loading-spinner')).toBeNull();
    expect(loadingContainer.querySelector('.tree-loading-skeleton')).not.toBeNull();
    expect(loadingContainer.querySelectorAll('.tree-skeleton-card').length).toBeGreaterThanOrEqual(5);
    expect(loadingContainer.querySelector('.tree-skeleton-minimap')).not.toBeNull();
    expect(loadingContainer.querySelector('.tree-skeleton-controls')).not.toBeNull();
    expect(loadingContainer.querySelector('output[aria-live="polite"]')?.textContent).toContain(
      'Loading family tree'
    );
  });
});
