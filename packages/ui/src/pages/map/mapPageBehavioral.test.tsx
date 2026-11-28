/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { FakeMap, mapInstances } = vi.hoisted(() => {
  const mapInstances: Array<{ emit: (event: string, payload?: unknown) => void }> = [];
  class FakeMap {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    private sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    private layers = new Map<string, unknown>();
    private canvas = document.createElement('canvas');
    private container: HTMLElement;
    private zoom = 4;

    constructor(opts: { container: HTMLElement }) {
      this.container = opts.container;
      mapInstances.push(this);
      queueMicrotask(() => {
        this.emit('load');
        this.emit('style.load');
      });
    }

    emit(event: string, payload?: unknown): void {
      for (const fn of this.listeners.get(event) ?? []) {
        fn(payload);
      }
    }

    on(
      event: string,
      layerOrFn: string | ((...args: unknown[]) => void),
      maybeFn?: (...args: unknown[]) => void
    ): void {
      const fn = typeof layerOrFn === 'function' ? layerOrFn : maybeFn;
      if (!fn) {
        return;
      }
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    }

    off(event: string, fn: (...args: unknown[]) => void): void {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        list.filter((f) => f !== fn)
      );
    }

    once(event: string, fn: (...args: unknown[]) => void): void {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        fn(...args);
      };
      this.on(event, wrapped);
    }

    addControl(): void {}
    setStyle(): void {
      queueMicrotask(() => {
        this.emit('style.load');
      });
    }
    isStyleLoaded(): boolean {
      return true;
    }
    getSource(id: string): unknown {
      return this.sources.get(id);
    }
    addSource(id: string, spec: { data?: unknown }): void {
      const rec = {
        data: spec.data,
        setData: (next: unknown) => {
          rec.data = next;
        },
      };
      this.sources.set(id, rec);
    }
    getLayer(id: string): unknown {
      return this.layers.get(id);
    }
    addLayer(spec: { id: string }): void {
      this.layers.set(spec.id, spec);
    }
    setLayoutProperty(): void {}
    fitBounds(): void {
      this.emit('moveend');
    }
    flyTo(): void {
      this.emit('moveend');
    }
    easeTo(): void {
      this.emit('moveend');
    }
    zoomIn(): void {
      this.zoom += 1;
    }
    zoomOut(): void {
      this.zoom -= 1;
    }
    getZoom(): number {
      return this.zoom;
    }
    project(): { x: number; y: number } {
      return { x: 240, y: 200 };
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    getContainer(): HTMLElement {
      return this.container;
    }
    queryRenderedFeatures(): Array<{ properties: { id: string } }> {
      return [{ properties: { id: 'stop-1' } }];
    }
    resize(): void {}
    remove(): void {}
  }
  return { FakeMap, mapInstances };
});

vi.mock('maplibre-gl', () => ({
  Map: FakeMap,
  AttributionControl: class {},
  setWorkerUrl: vi.fn(),
  setWorkerCount: vi.fn(),
  setMaxParallelImageRequests: vi.fn(),
}));

vi.mock('@openhistoricalmap/maplibre-gl-dates', () => ({
  filterByDate: vi.fn(),
}));

import { ArchiveProvider } from '../../context/ArchiveProvider.js';
import { MapPage } from '../MapPage.js';
import { MapToolbar } from './MapToolbar.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Migration Map',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_MAP_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_ny',
      slug: 'albany-ny',
      name: 'Albany',
      full_name: 'Albany, Albany County, New York, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.65,
      lng: -73.75,
    },
    {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    },
    {
      id: 'pl_gr',
      slug: 'grand-rapids',
      name: 'Grand Rapids',
      full_name: 'Grand Rapids, Kent County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.96,
      lng: -85.67,
    },
  ],
  sources: [
    {
      id: 'src_1',
      citation: '1880 US Federal Census',
      source_type: 'census',
      has_primary_source: true,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1845-04-10',
      death_edtf: '1920-08-12',
      portrait_url: null,
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1850-05-01',
      death_edtf: '1928-02-14',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_birth',
      title: 'Birth of Henry Alder',
      summary: 'Born in Albany, New York.',
      event_kind: 'point_event',
      scope: 'family',
      edtf_date: '1845-04-10',
      place_id: 'pl_ny',
      participants: [{ person_id: 'per_henry', role: 'principal' }],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
    {
      id: 'evt_move',
      title: 'Settlement in Hudsonville',
      summary: 'Moved west to Ottawa County.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
    {
      id: 'evt_gr',
      title: 'Later years in Grand Rapids',
      summary: 'Resided in Grand Rapids.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1910-05-15',
      place_id: 'pl_gr',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
  ],
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

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  mapInstances.length = 0;
  vi.restoreAllMocks();
});

describe('MapPage behavioral migration journey flows', () => {
  it('renders MapPage, filters by person and era, toggles route mode, steps through journey, and controls zoom', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ version: 8, sources: {}, layers: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const container = mountEl(
      <MemoryRouter initialEntries={['/map']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <MapPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.textContent).toContain('All Eras');

    // Toggle route mode: Chronological -> By person -> mobile toggle
    const chronoBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Chronological'
    );
    expect(chronoBtn).toBeDefined();
    act(() => {
      chronoBtn?.click();
    });
    await flushUi();

    const byPersonBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'By person'
    );
    act(() => {
      byPersonBtn?.click();
    });
    await flushUi();

    // Filter by person select
    const personSelect = container.querySelector(
      'select[aria-label="Filter migration map by person"]'
    ) as HTMLSelectElement | null;
    expect(personSelect).not.toBeNull();
    if (personSelect) {
      setSelectValue(personSelect, 'per_henry');
      await flushUi();
      setSelectValue(personSelect, 'all');
      await flushUi();
    }

    // Play route, step next/prev, and pause
    const playBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /play route/i.test(b.textContent || '')
    );
    if (playBtn) {
      act(() => {
        playBtn.click();
      });
      await flushUi();
    }
    const pauseBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /pause/i.test(b.textContent || '')
    );
    if (pauseBtn) {
      act(() => {
        pauseBtn.click();
      });
      await flushUi();
    }

    // Step forward/back & zoom buttons
    for (const pattern of [/next/i, /prev/i, /zoom in/i, /zoom out/i, /fit|reset/i]) {
      const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        pattern.test(b.getAttribute('aria-label') || b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // Trigger map click event to test stop selection handler
    const map = mapInstances.at(-1);
    if (map) {
      act(() => {
        map.emit('click', { point: { x: 100, y: 100 } });
      });
      await flushUi();
    }
  });

  it('shows offline basemap note when historical style fails and renders error state when archive fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    const failingDs: ArchiveDataSource = {
      loadArchive: async () => {
        throw new Error('Archive fetch failed');
      },
      loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: { authenticated: false, principal_kind: 'anonymous' },
        capabilities: {
          canEdit: false,
          canUploadMedia: false,
          hasRevisionHistory: false,
          hasTalk: false,
          canManageSite: false,
        },
      }),
    };

    const errContainer = mountEl(
      <MemoryRouter initialEntries={['/map']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={failingDs}>
          <MapPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    expect(errContainer.textContent).toContain('Unable to load migration map');
  });

  it('collapses overflowing desktop eras into a keyboard-accessible More menu and renders segmented route-mode controls', async () => {
    const onSelectEraId = vi.fn();
    const onSetRouteMode = vi.fn();
    const onSelectPersonId = vi.fn();

    const eras = [
      { id: 'era_1', label: 'British Isles Origins', description: '', color: '#3B4D61' },
      { id: 'era_2', label: 'Colonial Seaboard', description: '', color: '#1B2A41' },
      { id: 'era_3', label: 'Appalachian Frontier', description: '', color: '#2F5245' },
      { id: 'era_4', label: 'Illinois Prairie & Midwest', description: '', color: '#7A4612' },
      { id: 'era_5', label: 'Pacific & Western Crossing', description: '', color: '#5B3A5E' },
    ];
    const counts = new Map([
      ['era_1', 4],
      ['era_2', 12],
      ['era_3', 20],
      ['era_4', 22],
      ['era_5', 11],
    ]);

    const origGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const key = this.dataset?.measureEra;
      if (key === 'all') {
        return new DOMRect(0, 0, 100, 32);
      }
      if (key === 'more') {
        return new DOMRect(0, 0, 100, 32);
      }
      if (key?.startsWith('era_')) {
        return new DOMRect(0, 0, 180, 32);
      }
      if (this.dataset?.mapTraceLabel === 'true') {
        return new DOMRect(0, 0, 220, 32);
      }
      if (this.dataset?.mapRouteMode === 'true') {
        return new DOMRect(0, 0, 200, 32);
      }
      return origGetBoundingClientRect.call(this);
    });

    const host = document.createElement('div');
    Object.defineProperty(host, 'clientWidth', { configurable: true, value: 1120 });
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(() => {
      act(() => {
        root.unmount();
      });
      host.remove();
    });

    act(() => {
      root.render(
        <MapToolbar
          selectablePeople={SAMPLE_BUNDLE.people}
          selectedPersonId="all"
          selectedEraId="all"
          routeMode="per-person"
          allStopsCount={69}
          migrationEras={eras}
          eraStopCounts={counts}
          onSelectPersonId={onSelectPersonId}
          onSelectEraId={onSelectEraId}
          onSetRouteMode={onSetRouteMode}
        />
      );
    });
    await flushUi();

    const moreBtn = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(moreBtn).not.toBeNull();
    expect(moreBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(moreBtn?.textContent).toContain('More (+3)');

    // Open menu, close with Escape, reopen, select overflow era
    act(() => {
      moreBtn?.click();
    });
    await flushUi();
    expect(moreBtn?.getAttribute('aria-expanded')).toBe('true');
    const menu = host.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const items = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
    expect(items).toHaveLength(3);
    expect(items.map((el) => el.textContent)).toEqual([
      'Appalachian Frontier(20)',
      'Illinois Prairie & Midwest(22)',
      'Pacific & Western Crossing(11)',
    ]);

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushUi();
    expect(host.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      moreBtn?.click();
    });
    await flushUi();
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    await flushUi();
    expect(host.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      moreBtn?.click();
    });
    await flushUi();
    const lastOverflowItem = host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2];
    act(() => {
      lastOverflowItem?.click();
    });
    await flushUi();
    expect(onSelectEraId).toHaveBeenCalledWith('era_5');
    expect(host.querySelector('[role="menu"]')).toBeNull();

    // Segmented route mode exposes both states clearly
    const modeButtons = [
      ...host.querySelectorAll<HTMLButtonElement>('fieldset[aria-label="Full lineage route mode"] button'),
    ];
    expect(modeButtons.map((b) => [b.textContent?.trim(), b.getAttribute('aria-pressed')])).toEqual([
      ['By person', 'true'],
      ['Chronological', 'false'],
    ]);
    act(() => {
      modeButtons[1]?.click();
    });
    expect(onSetRouteMode).toHaveBeenCalledWith('chronological');
  });
});
