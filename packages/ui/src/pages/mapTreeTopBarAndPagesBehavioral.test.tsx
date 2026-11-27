/** @vitest-environment jsdom */
import type {
  ArchiveBundle,
  ArchiveDataSource,
  InviteRecord,
  KinloomSiteConfig,
  ReadingsBundle,
  UserRecord,
} from '@kinloom/core';
import { compileArchive, parseKinloomConfig } from '@kinloom/core';
import type React from 'react';
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { FakeMap, mapInstances, projectMock } = vi.hoisted(() => {
  const projectMock = vi.fn(() => ({ x: 8, y: 8 }));
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
      this.canvas.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 800,
          bottom: 600,
          width: 800,
          height: 600,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
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
    setPaintProperty(): void {}
    setFilter(): void {}
    getStyle(): { layers: Array<{ id: string; type: string }> } {
      return { layers: [{ id: 'ohm-road', type: 'line' }] };
    }
    fitBounds(): void {
      this.emit('moveend');
      this.emit('render');
    }
    flyTo(): void {
      this.emit('moveend');
      this.emit('render');
    }
    easeTo(): void {
      this.emit('moveend');
      this.emit('render');
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
      return projectMock();
    }
    getCanvas(): HTMLCanvasElement {
      return this.canvas;
    }
    getContainer(): HTMLElement {
      return this.container;
    }
    queryRenderedFeatures(): Array<{ properties: { id: string } }> {
      return [];
    }
    remove(): void {
      this.listeners.clear();
    }
  }

  return { FakeMap, mapInstances, projectMock };
});

vi.mock('maplibre-gl', () => ({
  Map: FakeMap,
  AttributionControl: class {},
  addProtocol: vi.fn(),
  setWorkerUrl: vi.fn(),
  setWorkerCount: vi.fn(),
  setMaxParallelImageRequests: vi.fn(),
}));

vi.mock('@openhistoricalmap/maplibre-gl-dates', () => ({
  filterByDate: vi.fn(),
}));

import {
  CHUNK_RELOAD_STORAGE_KEY,
  installGlobalErrorHandlers,
  isChunkLoadError,
  reportClientError,
  sanitizeReport,
  sanitizeRoute,
  shouldAttemptChunkReload,
} from '../browser/clientTelemetry.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { createStaticArchiveLoader, useArchiveData } from '../context/ArchiveDataContext.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { createNarrativeAudioPlugin, readNarrativeAudioMeta } from '../plugins/narrativeAudioPlugin.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import { type AdminApiClient, AdminPage } from './AdminPage.js';
import { EvidencePage } from './EvidencePage.js';
import { MapPage } from './MapPage.js';
import { PersonPage } from './PersonPage.js';
import { PlacePage } from './PlacePage.js';
import { TreePage } from './TreePage.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();
if (typeof globalThis.PointerEvent === 'undefined') {
  class PolyfillPointerEvent extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  globalThis.PointerEvent = PolyfillPointerEvent as unknown as typeof PointerEvent;
}

const SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Horizon Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_HORIZON',
  },
  branches: [{ id: 'alder', label: 'Alder Line' }],
});

const SIBLING_PEOPLE = Array.from({ length: 7 }, (_, i) => ({
  id: `per_sib_${i}`,
  slug: `sib-${i}-alder`,
  full_name: `Sibling${i} Alder`,
  given_name: `Sibling${i}`,
  surname: 'Alder',
  alt_names: [],
  sex: (i % 2 === 0 ? 'M' : 'F') as 'M' | 'F',
  is_living: false,
  lineage_group: 'colonial_sibling' as const,
  branch: 'alder',
  birth_edtf: `${1885 + i}`,
  death_edtf: `${1950 + i}`,
  portrait_url: null,
}));

const UNVERIFIED_EVENTS = Array.from({ length: 28 }, (_, i) => ({
  id: `evt_unv_${i}`,
  title: `Uncited Homestead Note ${i}`,
  summary: `Oral tradition note ${i}.`,
  event_kind: 'point_event' as const,
  scope: 'personal' as const,
  edtf_date: `${1890 + (i % 9)}`,
  place_id: 'pl_hud',
  participants: [{ person_id: 'per_henry', role: 'subject' }],
  sources: [],
}));

const { bundle: FULL_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_ottawa',
      slug: 'ottawa-county',
      name: 'Ottawa County',
      full_name: 'Ottawa County, Michigan, USA',
      place_type: 'county',
      parent_id: null,
      lat: 42.95,
      lng: -86.0,
    },
    {
      id: 'pl_hud',
      slug: 'hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.87,
      lng: -85.86,
      photo_url: '/media/hudsonville.jpg',
      photo_caption: 'Main Street 1905',
      historical_names: [{ name: 'Georgetown Station', valid_from: '1856', valid_to: '1872' }],
    },
    {
      id: 'pl_zee',
      slug: 'zeeland',
      name: 'Zeeland',
      full_name: 'Zeeland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.81,
      lng: -86.01,
    },
  ],
  sources: [
    {
      id: 'src_1880',
      citation: '1880 Federal Census, Georgetown Township',
      source_type: 'census',
      author: 'US Census Bureau',
      repository: 'NARA',
      has_primary_source: true,
      url: 'https://example.test/census-1880',
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
      branch: 'alder',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: '/media/henry.jpg',
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
      branch: 'alder',
      birth_edtf: '1858-07-22',
      death_edtf: '1938-04-09',
      portrait_url: null,
    },
    {
      id: 'per_arthur',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      branch: 'alder',
      birth_edtf: '1882-05-10',
      death_edtf: '1961-01-20',
      portrait_url: null,
    },
    {
      id: 'per_infant',
      slug: 'thomas-alder-infant',
      full_name: 'Thomas Alder',
      given_name: 'Thomas',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'collateral',
      branch: 'alder',
      birth_edtf: '1883-02-01',
      death_edtf: '1884-06-15',
      portrait_url: null,
    },
    ...SIBLING_PEOPLE,
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Hudsonville Farm',
      summary: 'Settled in Hudsonville.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_hud',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_1895',
      title: '1895 Zeeland Mill Move',
      summary: 'Moved west to Zeeland.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1895-04-10',
      place_id: 'pl_zee',
      participants: [{ person_id: 'per_henry', role: 'head' }],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_local_1884',
      title: '1884 Township Road Grading',
      summary: 'Gravel road completed.',
      event_kind: 'point_event',
      scope: 'local',
      edtf_date: '1884-09-01',
      place_id: 'pl_hud',
      participants: [],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    {
      id: 'evt_local_1904',
      title: '1904 Interurban Depot',
      summary: 'Electric interurban line opened.',
      event_kind: 'point_event',
      scope: 'state',
      edtf_date: '1904-07-12',
      place_id: 'pl_zee',
      participants: [],
      sources: [{ source_id: 'src_1880', confidence: 'high' }],
    },
    ...UNVERIFIED_EVENTS,
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
    { from: 'per_henry', to: 'per_infant', relation: 'parent' },
    { from: 'per_clara', to: 'per_infant', relation: 'parent' },
    ...SIBLING_PEOPLE.flatMap((s) => [
      { from: 'per_henry', to: s.id, relation: 'parent' as const },
      { from: 'per_clara', to: s.id, relation: 'parent' as const },
    ]),
  ],
  media: Array.from({ length: 4 }, (_, i) => ({
    id: `med_${i}`,
    kind: (i % 2 === 0 ? 'portrait' : 'headstone') as 'portrait' | 'headstone',
    file: `/media/item-${i}.jpg`,
    caption: `Alder Media ${i}`,
    date_edtf: `${1885 + i}`,
    person_ids: ['per_henry'],
    source_id: 'src_1880',
  })),
  narratives: [
    {
      id: 'nar_bio',
      slug: 'henry-alder-bio',
      kind: 'biography',
      subject_person_id: 'per_henry',
      title: 'Life of Henry Alder',
      summary: 'Biography with audio.',
      body_md: 'Henry Alder built a timber barn in Hudsonville.',
      person_ids: ['per_henry'],
      place_ids: ['pl_hud'],
      event_ids: ['evt_1880'],
      source_ids: ['src_1880'],
      extensions: {
        narrative_audio: {
          file: '/media/henry-bio.mp3',
          duration_seconds: 120,
          editor_notes_start_seconds: 80,
          story_voice: 'Charon',
          notes_voice: 'Kore',
        },
      },
    },
  ],
});

const READINGS: ReadingsBundle = {
  version: 1,
  event_page_map: {},
  documents: {
    src_1880: {
      source_id: 'src_1880',
      title: '1880 Census Schedule',
      author: 'US Census',
      provenance: 'NARA',
      pages: [{ page: 1, label: 'Sheet 4', file: 's4.txt', text: 'Henry Alder household' }],
    },
  },
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

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setFieldValue(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  mapInstances.length = 0;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SeedUiTrail: React.FC = () => {
  const { pushPivot, setActiveYear } = useArchiveUi();
  const { pronunciations } = useArchiveData();
  useEffect(() => {
    setActiveYear(1880);
    pushPivot({ slug: 'henry-alder', name: 'Henry Alder', year: 1880 });
    pushPivot({ slug: 'clara-alder', name: 'Clara Alder', year: 1895 });
  }, [pushPivot, setActiveYear]);
  return <div id="main-content" data-phonetic={pronunciations.alder?.phonetic ?? ''} />;
};

describe('Map, Tree, TopBar, Context, Telemetry, NarrativeAudio, and Pages behavioral suite', () => {
  it('exercises ArchiveDataContext HTTP loading, live pronunciations, ExplorerTopBar menus, and clientTelemetry', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/pronunciations')) {
        return new Response(
          JSON.stringify({
            pronunciations: {
              alder: { phonetic: 'AWL-der', ipa: '/ˈɔːldər/' },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('data/archive.json')) {
        return new Response(JSON.stringify(FULL_BUNDLE), { status: 200 });
      }
      if (url.endsWith('data/readings.json')) {
        return new Response(JSON.stringify(READINGS), { status: 200 });
      }
      if (url.endsWith('data/media-checklist.json')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                person_id: 'per_henry',
                person_name: 'Henry Alder',
                person_slug: 'henry-alder',
                lifespan: '1855–1932',
                obje_xref: '@M1@',
                title: '1890 Homestead Tintype',
                media_type: 'photo',
                form: 'jpg',
                missing: true,
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    // Static loader direct behavioral check
    const staticLoader = createStaticArchiveLoader('/archive');
    const loadedBundle = await staticLoader.loadArchive();
    expect(loadedBundle.people.some((p) => p.id === 'per_henry')).toBe(true);
    expect((await staticLoader.loadReadings())?.documents.src_1880).toBeTruthy();
    expect((await staticLoader.loadMediaChecklist?.())?.length).toBeGreaterThanOrEqual(1);

    let sessionAnonymous = false;
    const logoutSpy = vi.fn(async () => {
      sessionAnonymous = true;
    });
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: FULL_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => READINGS,
      loadMediaChecklist: async () => [],
      logout: logoutSpy,
      getSession: async () =>
        sessionAnonymous
          ? {
              session: { authenticated: false, principal_kind: 'anonymous' },
              capabilities: {
                canEdit: false,
                canUploadMedia: false,
                hasRevisionHistory: false,
                hasTalk: false,
                canManageSite: false,
              },
            }
          : {
              session: {
                authenticated: true,
                principal_kind: 'user',
                email: 'admin@example.test',
                displayName: 'Admin Alder',
                role: 'admin',
              },
              capabilities: {
                canEdit: true,
                canUploadMedia: true,
                hasRevisionHistory: true,
                hasTalk: true,
                canManageSite: true,
              },
              authProviders: { google: true, magicLink: true },
            },
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds}>
          <ExplorerTopBar />
          <SeedUiTrail />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    await flushUi();

    expect(container.querySelector('#main-content')?.getAttribute('data-phonetic')).toBe('AWL-der');
    expect(container.textContent).toContain('Trail:');
    expect(container.textContent).toContain('1880');

    // Skip to content focuses #main-content
    const skipLink = container.querySelector<HTMLAnchorElement>('a[href="#main-content"]');
    act(() => {
      skipLink?.click();
    });
    expect(document.activeElement?.id).toBe('main-content');

    // Account menu open -> Escape closes -> reopen -> outside pointerdown closes -> reopen -> Sign Out
    const accountBtn = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    act(() => {
      accountBtn?.click();
    });
    expect(container.querySelector('[role="menu"]')).toBeTruthy();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      accountBtn?.click();
    });
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();

    act(() => {
      accountBtn?.click();
    });
    const signOutBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Sign Out'
    );
    await act(async () => {
      signOutBtn?.click();
    });
    expect(logoutSpy).toHaveBeenCalled();

    // Invite viewer session in ExplorerTopBar
    const inviteContainer = mountEl(
      <MemoryRouter initialEntries={['/']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={FULL_BUNDLE}
          session={{
            authenticated: false,
            principal_kind: 'invite_viewer',
            role: 'viewer',
            inviteLabel: 'Cousin Reunion',
          }}
        >
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const signInToEditBtn = [...inviteContainer.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Sign in')
    );
    act(() => {
      signInToEditBtn?.click();
    });
    const archiveMenuBtn = inviteContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="Archive menu"]'
    );
    act(() => {
      archiveMenuBtn?.click();
    });
    expect(inviteContainer.textContent).toContain('Invite: Cousin Reunion');

    // clientTelemetry behavioral checks
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module /assets/Map.js'))).toBe(
      true
    );
    expect(isChunkLoadError('regular validation error')).toBe(false);
    expect(sanitizeRoute('/invite/tok_secret_99?person=henry-alder&secret=abc')).toBe(
      '/invite/[redacted]?person=henry-alder'
    );
    const cleaned = sanitizeReport({
      kind: 'react_boundary',
      message: 'Render failure',
      route: '/invite/tok_123?year=1880&token=hidden',
      assetUrl: 'https://example.test/invite/tok_123/chunk.js?sig=1',
    });
    expect(cleaned.route).toBe('/invite/[redacted]?year=1880');
    expect(cleaned.assetUrl).toBe('/invite/[redacted]/chunk.js');

    window.sessionStorage.removeItem(CHUNK_RELOAD_STORAGE_KEY);
    expect(shouldAttemptChunkReload(window.sessionStorage, 100_000)).toBe(true);
    expect(shouldAttemptChunkReload(window.sessionStorage, 110_000)).toBe(false);
    expect(shouldAttemptChunkReload(window.sessionStorage, 170_000)).toBe(true);

    const sendBeaconMock = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeaconMock });
    const uninstall = installGlobalErrorHandlers();
    reportClientError({ kind: 'blank_screen', message: 'Empty mount', route: '/tree' });
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Script boom', error: new Error('Script boom') })
    );
    const preloadEvt = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(preloadEvt);
    uninstall();
    expect(sendBeaconMock).toHaveBeenCalled();
  });

  it('exercises MapPage journey timer ticks, Escape stop clear, mobile easeTo, and OHM style fallback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not found', { status: 500 }))
    );
    projectMock.mockReturnValue({ x: 8, y: 8 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: FULL_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => READINGS,
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/map?person=henry-alder']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={FULL_BUNDLE}>
          <MapPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // Click Play to run journey timer ticks across stops
    const playBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label')?.toLowerCase().includes('play') || b.textContent?.includes('Play')
    );
    if (playBtn) {
      act(() => {
        playBtn.click();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2800);
      });
    }

    // ArrowRight selects/advances stop; Escape clears selected stop
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // Zoom in, zoom out, fit bounds
    for (const label of ['Zoom in', 'Zoom out', 'Fit']) {
      const btn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.getAttribute('aria-label') ?? b.textContent ?? '').includes(label)
      );
      act(() => {
        btn?.click();
      });
    }
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });

  it('exercises TreePage early-loss chips, sibling toggles, search combobox, inertia/pinch, and pedigree roll scroll', async () => {
    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: FULL_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => READINGS,
    };

    const container = mountEl(
      <MemoryRouter initialEntries={['/tree']}>
        <ArchiveProvider siteConfig={SITE_CONFIG} dataSource={ds} initialBundle={FULL_BUNDLE}>
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Early-loss chip click + keyboard Enter/Space
    const earlyChip = container.querySelector<SVGGElement>('[aria-label="Inspect Thomas Alder"]');
    expect(earlyChip).toBeTruthy();
    act(() => {
      earlyChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      earlyChip?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      earlyChip?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      earlyChip?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    });

    // Switch to Direct Line so collateral/colonial siblings collapse behind SiblingToggleItem
    const directLineBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Direct Line')
    );
    act(() => {
      directLineBtn?.click();
    });
    const sibToggle = [...container.querySelectorAll<SVGGElement>('svg [role="button"]')].find(
      (el) => el.getAttribute('aria-expanded') !== null
    );
    expect(sibToggle).toBeTruthy();
    act(() => {
      sibToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      sibToggle?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      sibToggle?.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }));
    });

    // Desktop TreePersonSearch combobox + keyboard navigation + Escape clear
    const combobox = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(combobox).toBeTruthy();
    if (combobox) {
      act(() => {
        combobox.focus();
      });
      setFieldValue(combobox, 'Thomas');
      act(() => {
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      setFieldValue(combobox, 'NoSuchRelative');
      expect(container.textContent).toContain('No matching people');
      act(() => {
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    }

    // Mobile search toggle
    const mobileSearchToggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Find person in tree"]'
    );
    act(() => {
      mobileSearchToggle?.click();
    });
    const closeMobileSearch = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Close person search"]'
    );
    act(() => {
      closeMobileSearch?.click();
    });

    // Pointer drag with velocity + two-finger pinch + keyboard zoom/pan shortcuts on diagram main
    const treeMain = container.querySelector<HTMLElement>('main');
    if (treeMain) {
      act(() => {
        treeMain.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, clientX: 300, clientY: 300 })
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 360, clientY: 340 })
        );
        treeMain.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, clientX: 420, clientY: 380 })
        );
        window.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerId: 2, clientX: 460, clientY: 410 })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, pointerId: 2, clientX: 460, clientY: 410 })
        );
        window.dispatchEvent(
          new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 360, clientY: 340 })
        );
      });
      for (const key of ['+', '-', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        });
      }
      act(() => {
        treeMain.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 240 }));
      });
    }

    // Switch to Pedigree Roll / List surface and select person via search -> scrollRollToPerson
    const listBtn = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) =>
        b.textContent?.includes('List') ||
        b.textContent?.includes('Roll') ||
        b.textContent?.includes('Outline')
    );
    if (listBtn && combobox) {
      act(() => {
        listBtn.click();
      });
      setFieldValue(combobox, 'Arthur');
      act(() => {
        combobox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
    }
  });

  it('exercises PlacePage scopes/decades, PersonPage + NarrativeAudioPlugin, EvidencePage filters/lightbox, and AdminPage', async () => {
    const audioPlugin = createNarrativeAudioPlugin();
    expect(readNarrativeAudioMeta(undefined)).toBeNull();
    expect(readNarrativeAudioMeta(FULL_BUNDLE.narratives?.[0])?.editor_notes_start_seconds).toBe(80);

    const ds: ArchiveDataSource = {
      loadArchive: async () => ({ bundle: FULL_BUNDLE, etag: '"r1"', notModified: false }),
      loadReadings: async () => READINGS,
      loadMediaChecklist: async () => [
        {
          person_id: 'per_henry',
          person_name: 'Henry Alder',
          person_slug: 'henry-alder',
          lifespan: '1855–1932',
          obje_xref: '@M1@',
          title: 'Missing Homestead Photo',
          media_type: 'photo',
          form: 'jpg',
          missing: true,
        },
      ],
      listRevisions: async () => ({ items: [], next_cursor: null }),
      listTalkComments: async () => [],
    };

    // 1. PlacePage: scope buttons, decade filter, edit pronunciation, history & talk tabs
    const placeView = mountEl(
      <MemoryRouter initialEntries={['/place/ottawa-county']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={FULL_BUNDLE}
          capabilities={{ canEdit: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/place/:slug" element={<PlacePage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    for (const label of ['Exact Place', 'Historical County', '15-Mile Radius', '1880s', '1900s']) {
      const btn = [...placeView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(label)
      );
      act(() => {
        btn?.click();
      });
    }

    // 2. PersonPage + NarrativeAudioPlugin: play narration, jump to Editor's notes, dock controls, speed cycle, dismiss
    const personView = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={FULL_BUNDLE}
          plugins={[audioPlugin]}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
          <PluginSlot name="appShell" />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    const listenBtn = personView.querySelector<HTMLButtonElement>(
      '[data-testid="narrative-audio-margin-bar"] button'
    );
    expect(listenBtn).toBeTruthy();
    act(() => {
      listenBtn?.click();
    });
    const dock = personView.querySelector('[data-testid="narrative-audio-dock"]');
    expect(dock).toBeTruthy();

    // Jump to Editor's notes, skip +15s/-15s, cycle speed 4 times, pause/resume, audio events, dismiss
    const jumpNotesBtn = [...personView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes("Editor's notes")
    );
    act(() => {
      jumpNotesBtn?.click();
    });
    expect(personView.textContent).toContain("Editor's Notes");
    act(() => {
      personView.querySelector<HTMLButtonElement>('button[aria-label="Forward 15 seconds"]')?.click();
      personView.querySelector<HTMLButtonElement>('button[aria-label="Rewind 15 seconds"]')?.click();
    });
    for (let i = 0; i < 4; i += 1) {
      const speedBtn = personView.querySelector<HTMLButtonElement>(
        '[data-testid="narrative-audio-dock"] button[aria-label^="Playback speed"]'
      );
      act(() => {
        speedBtn?.click();
      });
    }
    const audioEl = personView.querySelector('audio');
    if (audioEl) {
      Object.defineProperty(audioEl, 'duration', { configurable: true, value: 125 });
      act(() => {
        audioEl.dispatchEvent(new Event('loadedmetadata'));
        audioEl.currentTime = 85;
        audioEl.dispatchEvent(new Event('timeupdate'));
        audioEl.dispatchEvent(new Event('ended'));
      });
    }
    act(() => {
      personView.querySelector<HTMLButtonElement>('button[aria-label="Close audio player"]')?.click();
    });
    expect(personView.querySelector('[data-testid="narrative-audio-dock"]')).toBeNull();

    // 3. EvidencePage: media kind filters, media lightbox navigation, source filter, show all >25 unverified
    const evidenceView = mountEl(
      <MemoryRouter initialEntries={['/evidence']}>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={FULL_BUNDLE}
          initialReadings={READINGS}
        >
          <EvidencePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Show All 28 Entries Needing Citation on Sources tab (or switch tabs)
    for (const tabBtn of evidenceView.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      act(() => {
        tabBtn.click();
      });
      await flushUi();
      const showAllUnv = [...evidenceView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Entries Needing Citation')
      );
      if (showAllUnv) {
        act(() => {
          showAllUnv.click();
        });
      }
      const srcSearch = evidenceView.querySelector<HTMLInputElement>(
        'input[aria-label="Filter archival sources"]'
      );
      if (srcSearch) {
        setFieldValue(srcSearch, 'nonexistent-source');
        const clearBtn = [...evidenceView.querySelectorAll<HTMLButtonElement>('button')].find(
          (b) => b.textContent === 'Clear filter'
        );
        act(() => {
          clearBtn?.click();
        });
      }
      const mediaCard =
        evidenceView
          .querySelector<HTMLButtonElement>('button .person-media-caption')
          ?.closest<HTMLButtonElement>('button') ??
        [...evidenceView.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
          b.textContent?.includes('Alder Media 0')
        );
      if (mediaCard) {
        act(() => {
          mediaCard.click();
        });
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        });
        const closeLb = [...evidenceView.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) =>
          b.textContent?.includes('Close')
        );
        act(() => {
          closeLb?.click();
        });
      }
    }

    // 4. AdminPage: promote/demote, invite create/copy/revoke, agent token create/revoke
    const users: UserRecord[] = [
      {
        email: 'admin@example.test',
        display_name: 'Admin Alder',
        role: 'admin',
        added_by: 'bootstrap',
        added_at: '2026-01-01T00:00:00Z',
        last_login_at: '2026-05-01T00:00:00Z',
      },
      {
        email: 'second@example.test',
        display_name: 'Second Admin',
        role: 'admin',
        added_by: 'admin@example.test',
        added_at: '2026-02-01T00:00:00Z',
        last_login_at: null,
      },
      {
        email: 'editor@example.test',
        display_name: 'Editor Vance',
        role: 'editor',
        added_by: 'admin@example.test',
        added_at: '2026-03-01T00:00:00Z',
        last_login_at: null,
      },
    ];
    const invites: InviteRecord[] = [
      {
        token: 'inv_1',
        label: 'Spring Reunion',
        created_by: 'admin@example.test',
        created_at: '2026-04-01T00:00:00Z',
        expires_at: null,
        revoked_at: null,
        uses: 2,
        last_used_at: null,
      },
    ];
    const adminClient: AdminApiClient = {
      listUsers: async () => users,
      updateUserRole: async (email, { role }) => ({
        ...users.find((u) => u.email === email)!,
        role,
      }),
      listInvites: async () => invites,
      createInvite: async ({ label }) => ({
        invite_url: 'https://example.test/invite/inv_2',
        invite: {
          token: 'inv_2',
          label,
          created_by: 'admin@example.test',
          created_at: '2026-05-01T00:00:00Z',
          expires_at: '2026-06-01T00:00:00Z',
          revoked_at: null,
          uses: 0,
          last_used_at: null,
        },
      }),
      revokeInvite: async () => {},
      listAgentTokens: async () => [
        {
          token_id: 'tok_1',
          label: 'Nightly Backup',
          scope: 'read_backup',
          created_by: 'admin@example.test',
          created_at: '2026-04-01T00:00:00Z',
          revoked_at: null,
        },
      ],
      createAgentToken: async ({ label, scope }) => ({
        token_id: 'tok_2',
        label,
        scope,
        created_by: 'admin@example.test',
        created_at: '2026-05-01T00:00:00Z',
        revoked_at: null,
        plaintext_secret: 'klm_secret_test_value',
      }),
      revokeAgentToken: async () => {},
    };

    const adminView = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={SITE_CONFIG}
          dataSource={ds}
          initialBundle={FULL_BUNDLE}
          session={{
            authenticated: true,
            principal_kind: 'user',
            email: 'admin@example.test',
            displayName: 'Admin Alder',
            role: 'admin',
          }}
          capabilities={{ canManageSite: true }}
        >
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();

    // Demote second admin -> Confirm Demote; Promote editor -> Admin
    const demoteBtn = [...adminView.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Demote to Editor'
    );
    act(() => {
      demoteBtn?.click();
    });
    const confirmDemote = [...adminView.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Confirm Demote'
    );
    await act(async () => {
      confirmDemote?.click();
    });
    const promoteBtn = [...adminView.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Promote to Admin'
    );
    await act(async () => {
      promoteBtn?.click();
    });

    // Create invite + Copy + Dismiss + Revoke existing invite
    const inviteInput = adminView.querySelector<HTMLInputElement>('input[placeholder*="Reunion"]');
    if (inviteInput) {
      setFieldValue(inviteInput, 'Autumn Gathering');
      await act(async () => {
        inviteInput.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }
    act(() => {
      [...adminView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Copy Invite Link')
        ?.click();
      [...adminView.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Dismiss')
        ?.click();
    });

    // Create agent token + Revoke token
    const forms = adminView.querySelectorAll('form');
    const tokenForm = forms[1];
    if (tokenForm) {
      const tokInput = tokenForm.querySelector<HTMLInputElement>('input[type="text"]');
      const tokSelect = tokenForm.querySelector<HTMLSelectElement>('select');
      if (tokInput) {
        setFieldValue(tokInput, 'CLI Research Helper');
      }
      if (tokSelect) {
        setFieldValue(tokSelect, 'read_backup');
      }
      await act(async () => {
        tokenForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
    }
    for (const revokeBtn of [...adminView.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Revoke')
    )) {
      act(() => {
        revokeBtn.click();
      });
    }
    for (const confirmRevoke of [...adminView.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Confirm Revoke')
    )) {
      await act(async () => {
        confirmRevoke.click();
      });
    }
  });
});
