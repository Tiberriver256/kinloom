/** @vitest-environment jsdom */
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchiveBundle, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildArchivalOhmStyle,
  loadArchivalOhmStyle,
  OVERVIEW_REFERENCE_YEAR,
  PAPER_LAND_LAYER_ID,
  resetCachedOhmStyle,
} from '../browser/ohmStyle.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import {
  computeQuickTogglePreference,
  parseStoredThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  toColorSchemeMetaContent,
} from '../lib/themeModel.js';
import {
  getResolvedThemeColorTokens,
  KINLOOM_COLOR_TOKENS,
  KINLOOM_DARK_COLOR_TOKENS,
} from '../lib/tokens.js';
import {
  applyMapThemeToLayers,
  buildPaperStyle,
  computeSafeFitPadding,
  setPeriodBasemap,
  syncFamilyOverlay,
} from '../pages/map/mapLibreLayers.js';
import {
  applyThemeToDocument,
  readResolvedDarkMode,
  readStoredThemePreference,
  subscribeResolvedDarkMode,
} from './useThemePreference.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

interface MockMediaQueryController {
  setMatches: (next: boolean) => void;
}

function installMatchMediaMock(initialMatches: boolean): MockMediaQueryController {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  const mql = {
    media: '(prefers-color-scheme: dark)',
    get matches() {
      return matches;
    },
    onchange: null,
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === 'function') {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn(() => mql),
  });

  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: '(prefers-color-scheme: dark)' } as MediaQueryListEvent;
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Theme Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_THEME_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  people: [],
  places: [],
  events: [],
  sources: [],
  kinship: [],
});

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

beforeEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
  document.head.querySelectorAll('meta[name="color-scheme"]').forEach((node) => {
    node.remove();
  });
  const meta = document.createElement('meta');
  meta.name = 'color-scheme';
  meta.content = 'light dark';
  document.head.append(meta);
});

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
  vi.restoreAllMocks();
});

describe('themeModel pure state transitions', () => {
  it('parses valid stored preferences and falls back to system for unknown values', () => {
    expect(parseStoredThemePreference('light')).toBe('light');
    expect(parseStoredThemePreference('dark')).toBe('dark');
    expect(parseStoredThemePreference('sepia')).toBe('system');
    expect(parseStoredThemePreference(null)).toBe('system');
    expect(parseStoredThemePreference(undefined)).toBe('system');
  });

  it('resolves effective theme and computes two-state quick toggle without invisible OS pinning', () => {
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');

    // OS is light: toggling from system pins dark; toggling back reverts to system.
    expect(computeQuickTogglePreference('system', false)).toBe('dark');
    expect(computeQuickTogglePreference('dark', false)).toBe('system');

    // OS is dark: toggling from system pins light; toggling back reverts to system.
    expect(computeQuickTogglePreference('system', true)).toBe('light');
    expect(computeQuickTogglePreference('light', true)).toBe('system');

    // Pinned dark while OS later shifted to dark: toggling switches to light (opposite of rendered).
    expect(computeQuickTogglePreference('dark', true)).toBe('light');

    expect(toColorSchemeMetaContent('system')).toBe('light dark');
    expect(toColorSchemeMetaContent('light')).toBe('light');
    expect(toColorSchemeMetaContent('dark')).toBe('dark');
  });
});

describe('ExplorerTopBar theme toggle, persistence, OS tracking, and cross-tab sync', () => {
  it('toggles light/dark via quick button, preserves pin across OS changes, and reverts to system on undo', () => {
    const media = installMatchMediaMock(false);
    const container = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const meta = document.head.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(meta?.content).toBe('light dark');

    const quickBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to dark theme"]');
    expect(quickBtn).not.toBeNull();

    // 1. User switches to dark while OS is light -> pinned 'dark'
    act(() => {
      quickBtn?.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(meta?.content).toBe('dark');
    expect(container.querySelector('button[aria-label="Switch to light theme"]')).not.toBeNull();

    // 2. OS changes to dark, then back to light -> stored pin must NOT be deleted retroactively
    act(() => {
      media.setMatches(true);
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');

    act(() => {
      media.setMatches(false);
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');

    // 3. User clicks quick toggle again while OS is light -> reverts to system (storage cleared)
    const lightBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to light theme"]');
    act(() => {
      lightBtn?.click();
    });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement.dataset['theme']).toBeUndefined();
    expect(meta?.content).toBe('light dark');
  });

  it('exposes accessible 3-state radio controls in the Archive menu and syncs across tabs', () => {
    installMatchMediaMock(true);
    const container = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );

    const menuBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Archive menu"]');
    act(() => {
      menuBtn?.click();
    });

    const lightOption = container.querySelector<HTMLButtonElement>(
      '[role="radio"][aria-label="Light theme"]'
    );
    const darkOption = container.querySelector<HTMLButtonElement>('[role="radio"][aria-label="Dark theme"]');
    const systemOption = container.querySelector<HTMLButtonElement>(
      '[role="radio"][aria-label="System theme (currently dark)"]'
    );
    expect(lightOption?.getAttribute('aria-checked')).toBe('false');
    expect(darkOption?.getAttribute('aria-checked')).toBe('false');
    expect(systemOption?.getAttribute('aria-checked')).toBe('true');

    act(() => {
      lightOption?.click();
    });
    expect(lightOption?.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    // Cross-tab storage event updates theme state and DOM immediately
    act(() => {
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: 'unrelated-key',
          newValue: 'light',
        })
      );
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: THEME_STORAGE_KEY,
          newValue: 'dark',
        })
      );
    });
    expect(darkOption?.getAttribute('aria-checked')).toBe('true');
    expect(document.documentElement.dataset['theme']).toBe('dark');

    // Storage clear (key === null) and malformed same-tab event reset cleanly to system
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    });
    expect(systemOption?.getAttribute('aria-checked')).toBe('true');
    act(() => {
      window.dispatchEvent(new Event('kinloom-theme-change'));
    });
    expect(systemOption?.getAttribute('aria-checked')).toBe('true');
  });

  it('handles pre-existing localStorage values, invalid storage strings, missing color-scheme meta, and missing matchMedia', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(readStoredThemePreference()).toBe('light');

    window.localStorage.setItem(THEME_STORAGE_KEY, 'invalid');
    expect(readStoredThemePreference()).toBe('system');

    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.dataset['theme'] = 'light';
    expect(readStoredThemePreference()).toBe('light');
    expect(readResolvedDarkMode()).toBe(false);

    document.head.querySelectorAll('meta[name="color-scheme"]').forEach((node) => {
      node.remove();
    });
    applyThemeToDocument('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    delete document.documentElement.dataset['theme'];
    expect(readResolvedDarkMode()).toBe(false);
  });

  it('still applies DOM theme when localStorage throws SecurityError', () => {
    installMatchMediaMock(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });

    const container = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );

    expect(readStoredThemePreference()).toBe('system');
    const toggleBtn = container.querySelector<HTMLButtonElement>('button[aria-label="Switch to dark theme"]');
    act(() => {
      toggleBtn?.click();
    });
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(readStoredThemePreference()).toBe('dark');
    expect(readResolvedDarkMode()).toBe(true);
  });
});

describe('MapLibre and token dark-mode parity', () => {
  it('builds dark archival OHM styles, caches dark default loads, builds dark paper basemaps, and dynamically repaints existing layers', async () => {
    const lightTokens = getResolvedThemeColorTokens(false);
    const darkTokens = getResolvedThemeColorTokens(true);
    expect(lightTokens.land).toBe(KINLOOM_COLOR_TOKENS.warmLinen);
    expect(darkTokens.land).toBe(KINLOOM_DARK_COLOR_TOKENS.smokedLinen);
    expect(darkTokens.water).toBe(KINLOOM_DARK_COLOR_TOKENS.nightWater);
    expect(darkTokens.route).toBe(KINLOOM_DARK_COLOR_TOKENS.warmBrass);
    expect(darkTokens.routeLatest).toBe(KINLOOM_DARK_COLOR_TOKENS.vermilionTint);

    const lightPaper = buildPaperStyle(false);
    const darkPaper = buildPaperStyle(true);
    expect(lightPaper.layers[0]).toMatchObject({
      id: 'paper',
      type: 'background',
      paint: { 'background-color': '#D4E1E8' },
    });
    expect(darkPaper.layers[0]).toMatchObject({
      id: 'paper',
      type: 'background',
      paint: { 'background-color': '#131F2B' },
    });
    const darkLandLayer = darkPaper.layers.find((layer) => layer.id === 'kinloom-offline-land-fill');
    const darkCoastLayer = darkPaper.layers.find((layer) => layer.id === 'kinloom-offline-coastline');
    expect(darkLandLayer && 'paint' in darkLandLayer ? darkLandLayer.paint : null).toEqual({
      'fill-color': '#312D27',
    });
    expect(darkCoastLayer && 'paint' in darkCoastLayer ? darkCoastLayer.paint : null).toMatchObject({
      'line-color': '#655D50',
    });

    // Offline archival style dynamically repaints water, land, coastline, and graticule layers on theme toggle
    const offlinePainted: Array<[string, string, unknown]> = [];
    const offlineLayerIds = new Set(darkPaper.layers.map((layer) => layer.id));
    const fakeOfflineMap = {
      getLayer: (id: string) => (offlineLayerIds.has(id) ? { id } : undefined),
      getStyle: () => ({ layers: darkPaper.layers }),
      setPaintProperty: (id: string, prop: string, val: unknown) => {
        offlinePainted.push([id, prop, val]);
      },
    } as unknown as MapLibreMap;
    applyMapThemeToLayers(fakeOfflineMap, true);
    expect(offlinePainted).toContainEqual(['paper', 'background-color', '#131F2B']);
    expect(offlinePainted).toContainEqual(['kinloom-offline-land-fill', 'fill-color', '#312D27']);
    expect(offlinePainted).toContainEqual(['kinloom-offline-coastline', 'line-color', '#655D50']);
    applyMapThemeToLayers(fakeOfflineMap, false);
    expect(offlinePainted).toContainEqual(['paper', 'background-color', '#D4E1E8']);
    expect(offlinePainted).toContainEqual(['kinloom-offline-land-fill', 'fill-color', '#EAE1CE']);

    const rawOhm: StyleSpecification = {
      version: 8,
      sources: {
        osm_land: { type: 'vector', url: 'https://example.test/land.json' },
        ohm: { type: 'vector', url: 'https://example.test/ohm.json' },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#F5EFE2' } },
        { id: 'land', type: 'fill', source: 'osm_land', 'source-layer': 'land', paint: {} },
        {
          id: 'water_areas_ne',
          type: 'fill',
          source: 'ohm',
          'source-layer': 'water_areas',
          paint: { 'fill-color': '#B8D4E3' },
        },
      ],
    };

    const lightOhm = buildArchivalOhmStyle(rawOhm, '1900', false);
    expect(lightOhm.layers.find((l) => l.id === 'bg')).toEqual(rawOhm.layers[0]);

    resetCachedOhmStyle();
    const fetchOhm = vi.fn(
      async () =>
        new Response(JSON.stringify(rawOhm), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const loadedDark1 = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchOhm, true);
    const loadedDark2 = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchOhm, true);
    expect(loadedDark2).toBe(loadedDark1);
    expect(fetchOhm).toHaveBeenCalledTimes(1);
    resetCachedOhmStyle();

    const darkOhm = buildArchivalOhmStyle(rawOhm, '1900', true);
    const landLayer = darkOhm.layers.find((l) => l.id === PAPER_LAND_LAYER_ID);
    const waterLayer = darkOhm.layers.find((l) => l.id === 'water_areas_ne');
    expect(landLayer && 'paint' in landLayer ? landLayer.paint : null).toEqual({
      'fill-color': '#2A2723',
    });
    expect(waterLayer && 'paint' in waterLayer ? waterLayer.paint : null).toEqual({
      'fill-color': '#17222D',
    });

    // Dynamic repaint helper updates paint properties on active MapLibre layers (both dark and light)
    const painted: Array<[string, string, unknown]> = [];
    const layerIds = new Set([
      'bg',
      'paper',
      PAPER_LAND_LAYER_ID,
      'water_areas_ne',
      'migration-route',
      'migration-route-latest',
      'migration-labels',
      'migration-label-selected',
    ]);
    const fakeMap = {
      getLayer: (id: string) => (layerIds.has(id) ? { id } : undefined),
      getSource: () => undefined,
      getStyle: () => ({ layers: darkOhm.layers }),
      setLayoutProperty: () => {},
      setPaintProperty: (id: string, prop: string, val: unknown) => {
        painted.push([id, prop, val]);
      },
    } as unknown as MapLibreMap;

    setPeriodBasemap(fakeMap, true);
    applyMapThemeToLayers(fakeMap, true);
    expect(painted).toContainEqual(['paper', 'background-color', '#2A2723']);
    expect(painted).toContainEqual([PAPER_LAND_LAYER_ID, 'fill-color', '#2A2723']);
    expect(painted).toContainEqual(['water_areas_ne', 'fill-color', '#17222D']);
    expect(painted).toContainEqual(['migration-route', 'line-color', '#F6D191']);
    expect(painted).toContainEqual(['migration-route-latest', 'line-color', '#F39287']);
    expect(painted).toContainEqual(['migration-labels', 'text-color', '#E4DDD0']);
    expect(painted).toContainEqual(['migration-labels', 'text-halo-color', '#171614']);

    applyMapThemeToLayers(fakeMap, false);
    expect(painted).toContainEqual(['migration-route', 'line-color', '#562E07']);
    expect(painted).toContainEqual(['migration-labels', 'text-halo-width', 1.4]);

    // Defensive no-op when map stub lacks setPaintProperty or style layers
    applyMapThemeToLayers({} as unknown as MapLibreMap, true);
    applyMapThemeToLayers(
      {
        getLayer: () => undefined,
        getStyle: () => undefined,
        setPaintProperty: vi.fn(),
      } as unknown as MapLibreMap,
      false
    );
    applyMapThemeToLayers(
      {
        getLayer: () => undefined,
        setPaintProperty: vi.fn(),
      } as unknown as MapLibreMap,
      true
    );

    // setPeriodBasemap handles existing paper-land without setPaintProperty and adding paper-land without water_areas_ne
    const addedLayers: Array<{ id: string; beforeId?: string }> = [];
    setPeriodBasemap(
      {
        getLayer: (id: string) => (id === PAPER_LAND_LAYER_ID ? { id } : undefined),
        getSource: () => undefined,
        setLayoutProperty: vi.fn(),
      } as unknown as MapLibreMap,
      true
    );
    setPeriodBasemap(
      {
        getLayer: () => undefined,
        getSource: (id: string) => (id === 'osm_land' ? { type: 'vector' } : undefined),
        setLayoutProperty: vi.fn(),
        addLayer: (layer: { id: string }, beforeId?: string) => {
          addedLayers.push({ id: layer.id, ...(beforeId !== undefined ? { beforeId } : {}) });
        },
      } as unknown as MapLibreMap,
      true
    );
    expect(addedLayers).toEqual([{ id: PAPER_LAND_LAYER_ID, beforeId: undefined }]);

    // syncFamilyOverlay initializes dark-mode layers, binds click handlers, and updates existing GeoJSON sources
    const clickHandlers: Array<(ev: { point: [number, number] }) => void> = [];
    let stopLayerExists = true;
    let queryFeatureId: unknown = 42;
    const setDataSpy = vi.fn();
    let hasGeoJsonSource = false;
    const overlayLayers: Array<Record<string, unknown>> = [];
    const overlayMap = {
      getSource: () => (hasGeoJsonSource ? { type: 'geojson', setData: setDataSpy } : undefined),
      addSource: () => {
        hasGeoJsonSource = true;
      },
      addLayer: (layer: Record<string, unknown>) => {
        overlayLayers.push(layer);
      },
      getCanvas: () => ({ style: { cursor: '' } }),
      getLayer: (id: string) => (id === 'migration-stops' && stopLayerExists ? { id } : undefined),
      queryRenderedFeatures: () => [{ properties: { id: queryFeatureId } }],
      on: (event: string, arg2: unknown, arg3?: unknown) => {
        if (event === 'click' && typeof arg2 === 'function') {
          clickHandlers.push(arg2 as (ev: { point: [number, number] }) => void);
        } else if (typeof arg3 === 'function') {
          (arg3 as () => void)();
        }
      },
    } as unknown as MapLibreMap;

    const selectedStops: Array<string | null> = [];
    const emptyCollection = { type: 'FeatureCollection' as const, features: [] };
    syncFamilyOverlay(overlayMap, emptyCollection, (id) => selectedStops.push(id), true);
    const labelLayer = overlayLayers.find((l) => l['id'] === 'migration-labels');
    const labelPaint = labelLayer?.['paint'] as Record<string, unknown> | undefined;
    expect(labelPaint?.['text-halo-width']).toBe(1.6);

    clickHandlers[0]?.({ point: [10, 10] });
    stopLayerExists = false;
    clickHandlers[0]?.({ point: [10, 10] });
    stopLayerExists = true;
    queryFeatureId = 'stop-1';
    clickHandlers[0]?.({ point: [10, 10] });
    expect(selectedStops).toEqual([null, null, 'stop-1']);

    syncFamilyOverlay(overlayMap, emptyCollection, () => {}, true);
    expect(setDataSpy).toHaveBeenCalledWith(emptyCollection);

    // computeSafeFitPadding clamps mobile padding when viewport is tight
    const tightMobile = computeSafeFitPadding({
      viewportWidth: 320,
      viewportHeight: 300,
      toolbarHeight: 90,
      bottomDockHeight: 110,
      hasSelectedStop: false,
    });
    expect(tightMobile.top + tightMobile.bottom).toBeLessThanOrEqual(180);
    expect(tightMobile.left + tightMobile.right).toBeLessThanOrEqual(200);
    const noViewportHeight = computeSafeFitPadding({
      viewportWidth: 0,
      hasSelectedStop: false,
    });
    expect(noViewportHeight).toEqual({ top: 76, right: 32, bottom: 124, left: 28 });

    // buildArchivalOhmStyle drops layers without a source string and supports non-default year loads
    const styleWithNoSource: StyleSpecification = {
      ...rawOhm,
      layers: [
        ...rawOhm.layers,
        {
          id: 'custom-no-source',
          type: 'fill',
          paint: {},
        } as unknown as StyleSpecification['layers'][number],
      ],
    };
    const pruned = buildArchivalOhmStyle(styleWithNoSource, 'not-a-year', false);
    expect(pruned.layers.some((l) => l.id === 'custom-no-source')).toBe(false);
    expect(pruned.state).toEqual({});

    resetCachedOhmStyle();
    const fetchLightAndYear = vi.fn(
      async () =>
        new Response(JSON.stringify(rawOhm), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    ) as unknown as typeof fetch;
    const cachedLight1 = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchLightAndYear, false);
    const cachedLight2 = await loadArchivalOhmStyle(OVERVIEW_REFERENCE_YEAR, fetchLightAndYear, false);
    const year1850 = await loadArchivalOhmStyle('1850', fetchLightAndYear, true);
    expect(cachedLight2).toBe(cachedLight1);
    expect(year1850.state?.['maplibre_gl_dates__startDecimalYear']).toEqual({ default: 1850 });
    expect(fetchLightAndYear).toHaveBeenCalledTimes(1);
    resetCachedOhmStyle();

    // subscribeResolvedDarkMode reacts to document data-theme and OS preference changes without duplicates
    const media = installMatchMediaMock(false);
    const observed: boolean[] = [];
    const unsubscribe = subscribeResolvedDarkMode((isDark) => {
      observed.push(isDark);
    });
    applyThemeToDocument('dark');
    window.dispatchEvent(new CustomEvent('kinloom-theme-change', { detail: 'dark' }));
    window.dispatchEvent(new CustomEvent('kinloom-theme-change', { detail: 'dark' }));
    applyThemeToDocument('system');
    media.setMatches(false);
    media.setMatches(true);
    unsubscribe();
    expect(observed).toEqual([true, false, true]);
  });

  it('passes all 48 light and dark WCAG contrast checks and kinloom.css parity checks', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(here, '../../../../scripts/check-contrast.mjs');
    const stdout = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    const lightPasses = stdout.match(/^PASS \[light\]/gm) ?? [];
    const darkPasses = stdout.match(/^PASS \[dark\]/gm) ?? [];
    const apcaPasses = stdout.match(/^PASS \[apca-(?:light|dark)\]/gm) ?? [];
    expect(lightPasses).toHaveLength(34);
    expect(darkPasses).toHaveLength(34);
    expect(apcaPasses).toHaveLength(19);
    expect(stdout).toContain('All 68 Kinloom WCAG contrast checks (34 light + 34 dark), 19 APCA checks');
    expect(stdout).not.toContain('FAIL');
  });
});
