/** @vitest-environment jsdom */
import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig } from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

import { installGlobalErrorHandlers, reportClientError } from '../browser/clientTelemetry.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { EvidencePage } from './EvidencePage.js';
import { MapPage } from './MapPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { TimePage } from './TimePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Deep Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_DEEP_TEST',
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
  ],
  events: [
    {
      id: 'evt_1850',
      title: 'Childhood in Albany',
      summary: 'Lived in Albany.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1850-06-01',
      place_id: 'pl_ny',
      participants: [{ person_id: 'per_henry', role: 'child' }],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
    {
      id: 'evt_1880',
      title: 'Homestead in Hudsonville',
      summary: 'Settled in Ottawa County.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
    {
      id: 'evt_world',
      title: '1880 Federal Census Day',
      summary: 'National enumeration across the United States.',
      event_kind: 'point_event',
      scope: 'national',
      edtf_date: '1880-06-01',
      place_id: null,
      participants: [],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
    },
  ],
  kinship: [],
  media: [
    {
      id: 'med_1',
      kind: 'family_photo',
      file: '/media/homestead.jpg',
      caption: 'Homestead 1880',
      date_edtf: '1880',
      person_ids: ['per_henry'],
    },
  ],
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

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const ContextExerciser: React.FC = () => {
  const { reloadArchive, refreshSession, setPronunciations } = useArchiveData();
  return (
    <div>
      <button type="button" onClick={() => reloadArchive()}>
        Reload
      </button>
      <button type="button" onClick={() => void refreshSession()}>
        RefreshSession
      </button>
      <button
        type="button"
        onClick={() =>
          setPronunciations({
            'person:per_henry': { ipa: 'ˈhɛnri ˈɔːldər', phonetic: 'HEN-ree AWL-der' },
          })
        }
      >
        SetPron
      </button>
    </div>
  );
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  mapInstances.length = 0;
  vi.restoreAllMocks();
});

describe('Deep behavioral interactions across MapPage, TimePage, PersonPage, PlacePage, EvidencePage, and ArchiveDataContext', () => {
  it('handles MapPage URL params, keyboard navigation, era filters, mobile controls, and map error fallback', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const container = mountEl(
      <MemoryRouter initialEntries={['/map?person=per_henry&place=hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <MapPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Era buttons & mobile era select
    const eraBtns = Array.from(container.querySelectorAll('fieldset[aria-label*="era" i] button'));
    for (const btn of eraBtns) {
      act(() => {
        (btn as HTMLElement).click();
      });
      await flushUi();
    }
    const mobileEraSelect = container.querySelector(
      'select[aria-label*="era" i]'
    ) as HTMLSelectElement | null;
    if (mobileEraSelect) {
      setInputValue(mobileEraSelect, 'all');
      await flushUi();
    }

    // Keyboard shortcuts on map (ArrowRight, ArrowLeft, Space, Escape)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await flushUi();

    // Emit map error to hit fallback paper style path
    const map = mapInstances.at(-1);
    if (map) {
      act(() => {
        map.emit('error', { error: new Error('Tile 404') });
      });
      await flushUi();
    }

    expect(container.textContent).toContain('Showing offline paper basemap');
  });

  it('exercises TimePage slider, milestone buttons, prev/next year, and EvidencePage search empty state', async () => {
    const timeEl = mountEl(
      <MemoryRouter initialEntries={['/time?year=1880']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <TimePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    expect(timeEl.textContent).toContain('1880');
    const slider = timeEl.querySelector('input[type="range"]') as HTMLInputElement | null;
    if (slider) {
      setInputValue(slider, '1850');
      await flushUi();
      setInputValue(slider, '1880');
      await flushUi();
    }
    for (const btn of Array.from(timeEl.querySelectorAll('button')).slice(0, 8)) {
      act(() => {
        btn.click();
      });
      await flushUi();
    }

    // EvidencePage media tab search -> empty -> clear filters
    const evEl = mountEl(
      <MemoryRouter initialEntries={['/evidence?tab=media']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE}>
          <EvidencePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const searchInput = evEl.querySelector('input[type="search"]') as HTMLInputElement | null;
    if (searchInput) {
      setInputValue(searchInput, 'NoSuchPhotoXYZ');
      await flushUi();
      const clearBtn = Array.from(evEl.querySelectorAll('button')).find((b) =>
        /clear|show all|reset/i.test(b.textContent || '')
      );
      act(() => {
        clearBtn?.click();
      });
      await flushUi();
    }
  });

  it('exercises PersonPage scroll sync, PlacePage wiki tabs, ArchiveDataContext reload/notModified, and clientTelemetry sendBeacon/unhandledrejection', async () => {
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(performance.now());
      return 1;
    });

    const editorDs: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => ({ version: 1, event_page_map: {}, documents: {} }),
      loadMediaChecklist: async () => [],
      getSession: async () => ({
        session: {
          authenticated: true,
          principal_kind: 'user',
          email: 'editor@example.test',
          displayName: 'Editor Alder',
          role: 'admin',
        },
        capabilities: {
          canEdit: true,
          canUploadMedia: true,
          hasRevisionHistory: true,
          hasTalk: true,
          canManageSite: true,
        },
      }),
      listRevisions: async () => ({ items: [], next_cursor: null }),
    };

    const personEl = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder?event=evt_1880']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={editorDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    // Trigger window scroll to exercise usePersonTimelineSync
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    await flushUi();

    // Click "+ Add" relative button in PersonProfileHeader if present
    const addRelBtn = Array.from(personEl.querySelectorAll('button')).find((b) =>
      /\+\s*add/i.test(b.textContent || '')
    );
    if (addRelBtn) {
      act(() => {
        addRelBtn.click();
      });
      await flushUi();
    }

    // PlacePage wiki tabs (Edit / History / Family Notes)
    const placeEl = mountEl(
      <MemoryRouter initialEntries={['/place/hudsonville']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} initialBundle={SAMPLE_BUNDLE} dataSource={editorDs}>
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    for (const pattern of [/history/i, /family notes/i, /back to profile/i, /edit page/i]) {
      const btn = Array.from(placeEl.querySelectorAll('button')).find((b) =>
        pattern.test(b.textContent || '')
      );
      if (btn) {
        act(() => {
          btn.click();
        });
        await flushUi();
      }
    }

    // ArchiveDataContext reloadArchive (with notModified), refreshSession, setPronunciations
    let loadCalls = 0;
    const reloadDs: ArchiveDataSource = {
      ...editorDs,
      loadArchive: async () => {
        loadCalls += 1;
        if (loadCalls > 1) {
          return { bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: true };
        }
        return { bundle: SAMPLE_BUNDLE, etag: '"r1"', notModified: false };
      },
    };
    const ctxEl = mountEl(
      <MemoryRouter>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={reloadDs}>
          <ContextExerciser />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();
    for (const btn of Array.from(ctxEl.querySelectorAll('button'))) {
      act(() => {
        btn.click();
      });
      await flushUi();
    }

    // clientTelemetry sendBeacon + unhandledrejection
    const beaconSpy = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beaconSpy, configurable: true });
    const uninstall = installGlobalErrorHandlers({ endpoint: 'https://telemetry.example.test/errors' });
    reportClientError({ kind: 'blank_screen', message: 'Beacon test report', route: '/map' });
    const rejEvent = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejEvent.reason = new Error('Unhandled promise test');
    window.dispatchEvent(rejEvent);
    uninstall();
    expect(beaconSpy).toHaveBeenCalled();
    rafSpy.mockRestore();
  });
});
