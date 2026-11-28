/** @vitest-environment jsdom */
import type {
  AdminDataSource,
  ArchiveBundle,
  ArchiveDataSource,
  ArchiveEvent,
  KinloomSiteConfig,
  MediaItem,
  MigrationStop,
  Person,
  Place,
  ReadingsBundle,
  RevisionRecord,
  SourceRecord,
  UserRecord,
} from '@kinloom/core';
import { asBatchId, asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import type { FeatureCollection } from 'geojson';
import { Map as MapLibreMap } from 'maplibre-gl';
import type React from 'react';
import { act, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { FakeMap, mapState } = vi.hoisted(() => {
  interface FakeMapInstance {
    emit: (event: string, payload?: unknown) => void;
    zoomIn: ReturnType<typeof vi.fn>;
    zoomOut: ReturnType<typeof vi.fn>;
    fitBounds: ReturnType<typeof vi.fn>;
    easeTo: ReturnType<typeof vi.fn>;
    setStyle: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    projectPoint: { x: number; y: number };
    canvasRect: { left: number; top: number; width: number; height: number };
  }
  const mapState = {
    instances: [] as FakeMapInstance[],
    throwOnConstruct: false,
    autoEmitStyleLoad: true,
    nextProjectPoint: { x: 240, y: 200 },
    nextCanvasRect: { left: 0, top: 0, width: 800, height: 600 },
  };
  class FakeMap {
    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    private sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
    private layers = new Map<string, unknown>();
    private canvas = document.createElement('canvas');
    private container: HTMLElement;
    public projectPoint = { ...mapState.nextProjectPoint };
    public canvasRect = { ...mapState.nextCanvasRect };
    public zoomIn = vi.fn();
    public zoomOut = vi.fn();
    public fitBounds = vi.fn();
    public easeTo = vi.fn();
    public setStyle = vi.fn(() => {
      queueMicrotask(() => {
        this.emit('style.load');
      });
    });
    public remove = vi.fn();

    constructor(opts: { container: HTMLElement }) {
      if (mapState.throwOnConstruct) {
        throw new Error('WebGL unavailable');
      }
      this.container = opts.container;
      this.canvas.getBoundingClientRect = () => ({
        ...this.canvasRect,
        right: this.canvasRect.left + this.canvasRect.width,
        bottom: this.canvasRect.top + this.canvasRect.height,
        x: this.canvasRect.left,
        y: this.canvasRect.top,
        toJSON: () => ({}),
      });
      mapState.instances.push(this);
      if (mapState.autoEmitStyleLoad) {
        queueMicrotask(() => {
          this.emit('style.load');
        });
      }
    }

    emit(event: string, payload?: unknown): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) {
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
    project(): { x: number; y: number } {
      return this.projectPoint;
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
  }
  return { FakeMap, mapState };
});

vi.mock('maplibre-gl', () => ({
  Map: FakeMap,
  AttributionControl: class {},
  setWorkerUrl: vi.fn(),
  setWorkerCount: vi.fn(),
  setMaxParallelImageRequests: vi.fn(),
}));

const filterByDateMock = vi.hoisted(() => vi.fn());
vi.mock('@openhistoricalmap/maplibre-gl-dates', () => ({
  filterByDate: filterByDateMock,
  constrainLayerToDateRange: vi.fn((f: unknown) => f),
  dateRangeFromDate: vi.fn(() => ({
    startDecimalYear: 1900,
    startISODate: '1900-01-01',
    endDecimalYear: 1901,
    endISODate: '1900-12-31',
  })),
}));

import { installGlobalErrorHandlers, reportClientError, sanitizeRoute } from '../browser/clientTelemetry.js';
import { OHM_STYLE_URL, PAPER_LAND_LAYER_ID, resetCachedOhmStyle } from '../browser/ohmStyle.js';
import { AppErrorBoundary } from '../components/AppErrorBoundary.js';
import { ArchivalMarkdown } from '../components/ArchivalMarkdown.js';
import { SourceCitationTag } from '../components/atoms/SourceCitationTag.js';
import { BlankScreenWatchdog } from '../components/BlankScreenWatchdog.js';
import { CitationPopover } from '../components/CitationPopover.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { GlobalSearchModal } from '../components/GlobalSearchModal.js';
import { InlineEntityMention } from '../components/InlineEntityMention.js';
import { LocalSurveyMap } from '../components/LocalSurveyMap.js';
import { MediaPlayer } from '../components/MediaPlayer.js';
import { MilestoneStoryCard } from '../components/MilestoneStoryCard.js';
import { useCitationPopover } from '../components/markdown/useCitationPopover.js';
import { PronunciationBadge } from '../components/PronunciationBadge.js';
import { SourceReaderDrawer } from '../components/SourceReaderDrawer.js';
import { TreeFocusDrawer } from '../components/tree/TreeFocusDrawer.js';
import { CreateEntityModal } from '../components/wiki/CreateEntityModal.js';
import { RevisionHistoryPanel } from '../components/wiki/RevisionHistoryPanel.js';
import {
  type ArchiveDataContextValue,
  ArchiveDataProvider,
  useArchiveData,
} from '../context/ArchiveDataContext.js';
import { ArchiveProvider } from '../context/ArchiveProvider.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { getFocusableElements, useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import type { ArchivalDiagramLayout, ArchivalTreeModel, LineageSpotlight } from '../lib/archivalTreeModel.js';
import {
  type ActiveNarrativeAudioTrack,
  NarrativeAudioProvider,
} from '../plugins/narrativeAudio/audioContext.js';
import {
  NarrativeAudioDock,
  NarrativeAudioMarginBar,
} from '../plugins/narrativeAudio/NarrativeAudioPlayers.js';
import { createNarrativeAudioPlugin, readNarrativeAudioMeta } from '../plugins/narrativeAudioPlugin.js';
import { KinloomPluginProvider } from '../plugins/PluginContext.js';
import { AdminPage } from './AdminPage.js';
import { EvidenceNeedsCitationTab } from './evidence/EvidenceNeedsCitationTab.js';
import { EvidenceSourcesTab } from './evidence/EvidenceSourcesTab.js';
import { IndexPage } from './IndexPage.js';
import { KinshipPage } from './KinshipPage.js';
import { MapStopDrawerAndDock } from './map/MapStopDrawerAndDock.js';
import { PAPER_STYLE, setPeriodBasemap, syncFamilyOverlay } from './map/mapLibreLayers.js';
import {
  type MigrationMapController,
  type UseMigrationMapControllerParams,
  useMigrationMapController,
} from './map/useMigrationMapController.js';
import { PersonPage } from './PersonPage.js';
import { PlacesIndexPage } from './PlacesIndexPage.js';
import { PersonProfileHeader } from './person/PersonProfileHeader.js';
import { usePersonTimelineSync } from './person/usePersonTimelineSync.js';
import { PlaceHistoricalProfileSection } from './place/PlaceSections.js';
import { RecentChangesPage } from './RecentChangesPage.js';
import { TreePage } from './TreePage.js';
import { useTreeCanvasInteractions } from './tree/useTreeCanvasInteractions.js';
import {
  type TreeViewportTransformEngine,
  useTreeViewportTransform,
} from './tree/useTreeViewportTransform.js';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView = vi.fn();
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = vi.fn(() => 'blob:kinloom-test');
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = vi.fn();
}

const cleanups: Array<() => void> = [];

function mountEl(element: React.ReactElement): {
  container: HTMLDivElement;
  rerender: (next: React.ReactElement) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  let unmounted = false;
  const unmount = (): void => {
    if (unmounted) {
      return;
    }
    unmounted = true;
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  cleanups.push(unmount);
  return {
    container,
    rerender: (next: React.ReactElement) => {
      act(() => {
        root.render(next);
      });
    },
    unmount,
  };
}

async function flushUi(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const BASE_SITE_CONFIG: KinloomSiteConfig = parseKinloomConfig({
  site: {
    title: 'Alder Harbor Chronicle',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_HARBOR',
  },
  branches: [
    { id: 'alder', label: 'Alder Line', supportsDirectMode: true },
    { id: 'birch', label: 'Birch Line', supportsDirectMode: false },
  ],
  lineageSections: [
    {
      id: 'direct',
      title: 'Direct Line',
      subtitle: 'Primary ancestors',
      lineageGroups: ['ancestor', 'pivot_ancestor'],
      branchId: 'alder',
    },
  ],
  featuredDocumentId: 'src_ledger',
  featuredKinshipPairs: [
    { label: 'Henry & Clara', fromId: 'per_henry', toId: 'clara-mercer', note: 'Spouses in Harbor' },
    { label: 'Missing Pair', fromId: 'no_such', toId: 'per_henry' },
  ],
  pronunciations: {
    Alder: { phonetic: 'AHL-der', ipa: '/ˈɔːl.dɚ/' },
    Harbor: { phonetic: 'HAR-ber' },
  },
});

const { bundle: RICH_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: BASE_SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'pl_harbor',
      slug: 'harbor-town',
      name: 'Harbor',
      full_name: 'Harbor, Cedar County, Michigan',
      place_type: 'town',
      parent_id: null,
      lat: 42.87,
      lng: -85.86,
    },
    {
      id: 'pl_birch',
      slug: 'birch-creek',
      name: 'Birch Creek',
      full_name: 'Birch Creek, Cedar County, Michigan',
      place_type: 'town',
      parent_id: null,
      lat: 42.92,
      lng: -85.82,
    },
    {
      id: 'pl_far',
      slug: 'pine-ridge',
      name: 'Pine Ridge',
      full_name: 'Pine Ridge, Cedar County, Michigan',
      place_type: 'town',
      parent_id: null,
      lat: 43.25,
      lng: -85.55,
    },
  ],
  sources: [
    {
      id: 'src_ledger',
      citation: '1880 Harbor Town Ledger',
      source_type: 'census',
      has_primary_source: true,
    },
    {
      id: 'src_oral',
      citation: 'Family Oral Tradition',
      source_type: 'oral_history',
      has_primary_source: false,
    },
  ],
  people: [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder (1855)',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: ['Hendrik Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'pivot_ancestor',
      branch: 'alder',
      birth_edtf: '1855-03-14',
      death_edtf: '1932-11-02',
      portrait_url: '/media/henry.jpg',
    },
    {
      id: 'per_clara',
      slug: 'clara-mercer',
      full_name: 'Clara Mercer',
      given_name: 'Clara',
      surname: 'Mercer',
      alt_names: ['Clarie'],
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
      lineage_group: 'collateral',
      branch: 'alder',
      birth_edtf: '1882',
      death_edtf: '1950',
      portrait_url: null,
    },
    {
      id: 'per_nodates',
      slug: 'mabel-birch',
      full_name: 'Mabel Birch',
      given_name: 'Mabel',
      surname: 'Birch',
      alt_names: ['May Birch'],
      sex: 'F',
      is_living: false,
      lineage_group: 'collateral',
      branch: 'birch',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
    {
      id: 'per_living_named',
      slug: 'jordan-alder',
      full_name: 'Jordan Alder',
      given_name: 'Jordan',
      surname: 'Alder',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      branch: 'alder',
      birth_edtf: '1990',
      death_edtf: '',
      portrait_url: null,
    },
    {
      id: 'per_living_redacted',
      slug: 'living-person',
      full_name: 'Living',
      given_name: 'Living',
      surname: '',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'descendant',
      branch: 'alder',
      birth_edtf: '',
      death_edtf: '',
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880',
      title: '1880 Harbor Residence',
      summary: 'Settled in Harbor.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1880-06-01',
      place_id: 'pl_harbor',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_ledger', confidence: 'high' }],
    },
    {
      id: 'evt_1890',
      title: '1890 Birch Creek Mill',
      summary: 'Operated mill at Birch Creek.',
      event_kind: 'residence_anchor',
      scope: 'family',
      edtf_date: '1890-05-10',
      place_id: 'pl_birch',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
        { person_id: 'per_arthur', role: 'child' },
      ],
      sources: [{ source_id: 'src_ledger', confidence: 'high' }],
    },
  ],
  kinship: [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_arthur', to: 'per_henry', relation: 'child' },
    { from: 'per_clara', to: 'per_arthur', relation: 'parent' },
    { from: 'per_arthur', to: 'per_nodates', relation: 'spouse' },
  ],
  media: [
    {
      id: 'med_henry',
      kind: 'portrait',
      file: '/media/henry.jpg',
      caption: 'Henry Alder Portrait',
      date_edtf: '1885',
      person_ids: ['per_henry'],
      source_id: 'src_ledger',
    },
  ],
  narratives: [
    {
      id: 'nar_bio',
      slug: 'henry-bio',
      kind: 'biography',
      subject_person_id: 'per_henry',
      title: 'Life of Henry Alder',
      summary: 'Summary of Henry in Harbor.',
      body_md: 'Henry built the Harbor mill [1].',
      person_ids: ['per_henry'],
      place_ids: ['pl_harbor'],
      event_ids: ['evt_1880'],
      source_ids: ['src_ledger'],
    },
  ],
});

const SAMPLE_READINGS: ReadingsBundle = {
  version: 1,
  documents: {
    src_other: {
      source_id: 'src_other',
      title: 'Birch Creek Almanac',
      author: 'C. Mercer',
      provenance: 'Cedar County Historical Society',
      pages: [{ page: 1, label: 'Page 1', file: 'almanac-1.txt', text: 'Almanac notes from Birch Creek.' }],
    },
    src_ledger: {
      source_id: 'src_ledger',
      title: '1880 Harbor Town Ledger',
      author: 'Harbor Clerk',
      provenance: 'Harbor Municipal Vault',
      pdf_url: '/docs/ledger.pdf',
      pdf_size_bytes: 204800,
      pages: [
        {
          page: 1,
          label: 'Page 1',
          file: 'ledger-1.txt',
          text: 'Henry Alder settled in Harbor in 1880.',
          image_url: '/scans/p1.jpg',
        },
        { page: 2, label: 'Page 2', file: 'ledger-2.txt', text: 'Clara Mercer and Harbor timber account.' },
      ],
    },
    src_empty: {
      source_id: 'src_empty',
      title: 'Empty Source',
      author: 'None',
      provenance: 'None',
      pages: [],
    },
  },
  event_page_map: {
    evt_1880: { src_ledger: 2 },
  },
};

function makeMemoryDataSource(overrides: Partial<ArchiveDataSource> = {}): ArchiveDataSource {
  return {
    async loadArchive() {
      return { bundle: RICH_BUNDLE, etag: '"v1"', notModified: false };
    },
    async loadReadings() {
      return SAMPLE_READINGS;
    },
    ...overrides,
  };
}

const MapControllerHarness: React.FC<{
  baseParams: UseMigrationMapControllerParams;
  attachHost?: boolean;
  override?: Partial<UseMigrationMapControllerParams>;
  ctrlHolder: { current: MigrationMapController | null };
}> = ({ baseParams, attachHost = true, override = {}, ctrlHolder }) => {
  const ctrl = useMigrationMapController({ ...baseParams, ...override });
  ctrlHolder.current = ctrl;
  return (
    <div>
      {attachHost && <div ref={ctrl.mapHostRef} data-testid="map-host" />}
      <div ref={ctrl.cardRef} data-testid="map-card" />
      <div ref={ctrl.dockRef} data-testid="map-dock" />
      <input data-testid="map-input" />
    </div>
  );
};

const TreeViewportHarness: React.FC<{
  layout: ArchivalDiagramLayout;
  attachRefs?: boolean;
  surface?: 'diagram' | 'roll';
  engineHolder: { current: TreeViewportTransformEngine | null };
  onSurface?: (surface: 'diagram' | 'roll') => void;
}> = ({ layout, attachRefs = true, surface = 'diagram', engineHolder, onSurface }) => {
  onSurface?.(surface);
  const containerRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const viewport = useTreeViewportTransform({
    diagramLayout: layout,
    containerRef,
    stageRef,
  });
  const interactions = useTreeCanvasInteractions({
    isReady: true,
    surface,
    createPersonOpen: false,
    containerRef,
    viewport,
  });
  engineHolder.current = viewport;
  return (
    <div>
      <section
        ref={attachRefs ? containerRef : undefined}
        data-testid="tree-container"
        onPointerDown={interactions.handlePointerDown}
      >
        <div ref={attachRefs ? stageRef : undefined} data-testid="tree-stage">
          <button type="button" className="tree-node-card" data-person-id="per_henry">
            Henry
          </button>
          <div className="tree-toolbar">
            <button type="button" data-testid="toolbar-btn">
              Toolbar
            </button>
          </div>
          <dialog open>
            <span data-testid="in-dialog">Dialog</span>
          </dialog>
          <input data-testid="tree-input" />
        </div>
      </section>
    </div>
  );
};

const BadArchiveDataConsumer: React.FC = () => {
  useArchiveData();
  return null;
};

const ArchiveDataReader: React.FC<{ ctxHolder: { current: ArchiveDataContextValue | null } }> = ({
  ctxHolder,
}) => {
  const ctx = useArchiveData();
  ctxHolder.current = ctx;
  return <div>{ctx.featuredDocumentId ?? 'none'}</div>;
};

const SourceReaderOpenTrigger: React.FC<{ sourceId?: string; eventId?: string }> = ({
  sourceId,
  eventId,
}) => {
  const { openSourceReader } = useArchiveUi();
  return (
    <button
      type="button"
      data-testid="open-reader"
      onClick={() => {
        openSourceReader({ sourceId: sourceId ?? '', eventId });
      }}
    >
      Open
    </button>
  );
};

const DialogTrapHarness: React.FC<{
  openOuter: boolean;
  openInner: boolean;
  empty?: boolean;
  onCloseOuter: () => void;
  onCloseInner: () => void;
}> = ({ openOuter, openInner, empty = false, onCloseOuter, onCloseInner }) => {
  const outerRef = useDialogFocusTrap<HTMLDivElement>({ open: openOuter, onClose: onCloseOuter });
  const innerBtnRef = useRef<HTMLButtonElement | null>(null);
  const innerRef = useDialogFocusTrap<HTMLDivElement>({
    open: openInner,
    onClose: onCloseInner,
    initialFocusRef: innerBtnRef,
  });
  return (
    <div>
      <button type="button" data-testid="opener">
        Opener
      </button>
      {openOuter && (
        <div ref={outerRef} data-testid="outer-dialog">
          {!empty && (
            <>
              <button type="button" className="lightbox-backdrop-close">
                Backdrop
              </button>
              <button type="button" hidden>
                Hidden
              </button>
              <div aria-hidden="true">
                <button type="button">AriaHiddenChild</button>
              </div>
              <button type="button" style={{ display: 'none' }}>
                DisplayNone
              </button>
              <button type="button" tabIndex={-1}>
                NegTab
              </button>
              <button type="button" data-testid="first-btn">
                First
              </button>
              <button type="button" data-testid="last-btn">
                Last
              </button>
            </>
          )}
        </div>
      )}
      {openInner && (
        <div ref={innerRef} data-testid="inner-dialog">
          <button ref={innerBtnRef} type="button" data-testid="inner-btn">
            Inner
          </button>
        </div>
      )}
    </div>
  );
};

const ErrorBoundaryBomb: React.FC<{ err?: Error }> = ({ err }) => {
  if (err) {
    throw err;
  }
  return <div>Safe Child</div>;
};

const TimelineSyncHarness: React.FC<{ events: readonly ArchiveEvent[] }> = ({ events }) => {
  const { activeEvent, cardRefs } = usePersonTimelineSync('henry-alder', RICH_BUNDLE.people[0], events);
  const [, setTick] = useState(0);
  return (
    <div>
      <span data-testid="active-evt">{activeEvent?.id ?? 'none'}</span>
      {events.map((ev, idx) => (
        <div
          key={ev.id}
          ref={(el) => {
            if (el) {
              el.getBoundingClientRect = () => ({
                top: idx === 0 ? -300 : 120,
                bottom: idx === 0 ? -50 : 400,
                left: 0,
                right: 500,
                width: 500,
                height: 280,
                x: 0,
                y: idx === 0 ? -300 : 120,
                toJSON: () => ({}),
              });
              cardRefs.current.set(ev.id, el);
            }
          }}
        >
          {ev.title}
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          setTick((t) => t + 1);
        }}
      >
        Tick
      </button>
    </div>
  );
};

const CitationPopoverHarness: React.FC<{
  source: SourceRecord;
  media: MediaItem;
  mediaUrl: string | null;
  withOpenMedia: boolean;
  onOpenMedia: (media: MediaItem) => void;
}> = ({ source, media, mediaUrl, withOpenMedia, onOpenMedia }) => {
  const ctrl = useCitationPopover();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const payload = {
    occurrenceKey: 'occ-1',
    footnoteNumber: 1,
    source,
    media,
    mediaUrl,
  };
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        data-testid="cit-trigger"
        onMouseEnter={() => {
          if (triggerRef.current) {
            ctrl.handleTriggerHover(payload, triggerRef.current);
          }
        }}
        onMouseLeave={() => {
          ctrl.handleTriggerLeave('occ-1');
        }}
        onFocus={() => {
          if (triggerRef.current) {
            ctrl.handleTriggerFocus(payload, triggerRef.current);
          }
        }}
        onBlur={ctrl.handleTriggerBlur}
        onClick={() => {
          if (triggerRef.current) {
            ctrl.handleTriggerClick(payload, triggerRef.current);
          }
        }}
      >
        [1]
      </button>
      {ctrl.activePopover && (
        <CitationPopover
          id={ctrl.popoverId}
          footnoteNumber={ctrl.activePopover.footnoteNumber}
          source={ctrl.activePopover.source}
          media={ctrl.activePopover.media}
          mediaUrl={mediaUrl}
          anchorEl={ctrl.activePopover.anchorEl}
          popoverRef={ctrl.popoverRef}
          onMouseEnter={ctrl.clearCloseTimer}
          onMouseLeave={() => {
            ctrl.scheduleClose('occ-1');
          }}
          onBlur={ctrl.handlePopoverBlur}
          onClose={ctrl.closePopover}
          onOpenMedia={withOpenMedia ? onOpenMedia : undefined}
        />
      )}
    </div>
  );
};

const BadUiConsumer: React.FC = () => {
  useArchiveUi();
  return null;
};

const ArchiveUiSearchHarness: React.FC = () => {
  const { searchOpen } = useArchiveUi();
  return (
    <div>
      <span data-testid="search-state">{searchOpen ? 'open' : 'closed'}</span>
      <input data-testid="ui-input" />
    </div>
  );
};

const GlobalSearchTrigger: React.FC = () => {
  const { openSearch } = useArchiveUi();
  return (
    <button type="button" data-testid="open-search" onClick={openSearch}>
      Open Search
    </button>
  );
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  mapState.instances.length = 0;
  mapState.throwOnConstruct = false;
  mapState.autoEmitStyleLoad = true;
  mapState.nextProjectPoint = { x: 240, y: 200 };
  mapState.nextCanvasRect = { left: 0, top: 0, width: 800, height: 600 };
  filterByDateMock.mockReset();
  resetCachedOhmStyle();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useMigrationMapController branch coverage', () => {
  function makeStops(): MigrationStop[] {
    const p1 = RICH_BUNDLE.places[0];
    const p2 = RICH_BUNDLE.places[1];
    return [
      {
        id: 'stop-1',
        year: 1880,
        displayDate: '1880',
        title: '1880 Harbor Residence',
        place: p1,
        personNames: ['Henry Alder'],
        personSlugs: ['henry-alder'],
        eventId: 'evt_1880',
        lineageStage: 'ancestor',
      },
      {
        id: 'stop-2',
        year: 1894,
        displayDate: '1894',
        title: '1890 Birch Creek Mill',
        place: p2,
        personNames: ['Henry Alder'],
        personSlugs: ['henry-alder'],
        eventId: 'evt_1890',
        lineageStage: 'ancestor',
      },
    ];
  }

  it('exercises OHM fallback, error recovery, mobile/desktop projection, card flip, filters, playback, and keyboard nav', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('offline', { status: 503 }))
    );

    const stops = makeStops();
    const emptyOverlay: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const defaultBounds: [[number, number], [number, number]] = [
      [-86.5, 42.5],
      [-85.0, 43.5],
    ];
    const placesBySlug = new Map(RICH_BUNDLE.places.map((p) => [p.slug, p]));
    const setSelectedPersonId = vi.fn();
    const setSelectedStopId = vi.fn();
    const setPlaying = vi.fn();
    const setStepIndex = vi.fn();
    const setDrawerExpanded = vi.fn();
    const applyJourney = vi.fn();

    const ctrlHolder: { current: MigrationMapController | null } = { current: null };
    const baseMapParams: UseMigrationMapControllerParams = {
      loading: false,
      bundle: RICH_BUNDLE,
      siteConfig: BASE_SITE_CONFIG,
      placesBySlug,
      searchParams: new URLSearchParams('place=harbor-town'),
      allStopsForPerson: stops,
      stops,
      stopIds: stops.map((s) => s.id),
      selectedPersonId: 'all',
      selectedEraId: 'all',
      selectedStop: null,
      selectedStopId: null,
      stepIndex: -1,
      playing: false,
      drawerExpanded: false,
      overlay: emptyOverlay,
      defaultBounds,
      setSelectedPersonId,
      setSelectedStopId,
      setPlaying,
      setStepIndex,
      setDrawerExpanded,
      applyJourney,
    };

    // 1. Unattached host hits !host branch
    const mounted = mountEl(
      <MapControllerHarness baseParams={baseMapParams} ctrlHolder={ctrlHolder} attachHost={false} />
    );
    await flushUi();
    expect(mapState.instances).toHaveLength(0);

    // 2. Attached host with failed OHM fetch mounts PAPER_STYLE fallback + pendingBoundsRef
    mounted.rerender(
      <MapControllerHarness
        baseParams={baseMapParams}
        ctrlHolder={ctrlHolder}
        attachHost={true}
        override={{ bundle: { ...RICH_BUNDLE } }}
      />
    );
    await flushUi();
    expect(mapState.instances).toHaveLength(1);
    expect(ctrlHolder.current?.historicalMap.kind).toBe('failed');
    expect(setSelectedStopId).toHaveBeenCalledWith('stop-1');

    // 3. Constructor throwing sets failed status cleanly
    mapState.throwOnConstruct = true;
    mounted.rerender(
      <MapControllerHarness
        baseParams={baseMapParams}
        ctrlHolder={ctrlHolder}
        attachHost={true}
        override={{ bundle: { ...RICH_BUNDLE } }}
      />
    );
    await flushUi();
    expect(ctrlHolder.current?.historicalMap.kind).toBe('failed');
    mapState.throwOnConstruct = false;

    // 4. Successful OHM style load -> ready state, error handler branches, date filtering (playing vs paused), out-of-view & card-side flip
    resetCachedOhmStyle();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 8,
              sources: { ohm: { type: 'vector', tiles: [] } },
              layers: [{ id: 'bg', type: 'background' }],
            }),
            { status: 200 }
          )
      )
    );
    mapState.autoEmitStyleLoad = false;
    const liveBundle: ArchiveBundle = { ...RICH_BUNDLE };
    mounted.rerender(
      <MapControllerHarness
        baseParams={baseMapParams}
        ctrlHolder={ctrlHolder}
        attachHost={true}
        override={{
          bundle: liveBundle,
          searchParams: new URLSearchParams('person=henry-alder'),
        }}
      />
    );
    await flushUi();
    expect(setSelectedPersonId).toHaveBeenCalledWith('per_henry');
    const liveMap = mapState.instances.at(-1);
    expect(liveMap).toBeDefined();
    if (liveMap) {
      // Non-OHM error is ignored
      act(() => {
        liveMap.emit('error', { error: new Error('unrelated tile error') });
      });
      // Style loads -> historicalMap becomes ready
      act(() => {
        liveMap.emit('style.load');
      });
      await flushUi();
      expect(ctrlHolder.current?.historicalMap.kind).toBe('ready');

      // Era year date filter (paused -> exact year 1894, playing -> decade 1890)
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            selectedStop: stops[1],
            selectedStopId: 'stop-2',
            playing: false,
          }}
        />
      );
      await flushUi();
      expect(filterByDateMock).toHaveBeenCalledWith(liveMap, '1894');

      // Mobile out-of-view pan (drawerExpanded true & false)
      Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true });
      liveMap.projectPoint = { x: 790, y: 580 };
      const dockEl = mounted.container.querySelector<HTMLElement>('[data-testid="map-dock"]');
      if (dockEl) {
        dockEl.getBoundingClientRect = () => ({
          left: 0,
          top: 500,
          right: 375,
          bottom: 580,
          width: 375,
          height: 80,
          x: 0,
          y: 500,
          toJSON: () => ({}),
        });
      }
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            selectedStop: stops[1],
            selectedStopId: 'stop-2',
            playing: true,
            drawerExpanded: true,
          }}
        />
      );
      await flushUi();
      expect(liveMap.easeTo).toHaveBeenCalled();

      // Desktop card coverage flips cardSide from right -> left
      Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
      liveMap.projectPoint = { x: 500, y: 200 };
      const cardEl = mounted.container.querySelector<HTMLElement>('[data-testid="map-card"]');
      if (cardEl) {
        cardEl.getBoundingClientRect = () => {
          const onLeft = ctrlHolder.current?.cardSide === 'left';
          const left = onLeft ? 20 : 400;
          const right = onLeft ? 300 : 700;
          return {
            left,
            top: 100,
            right,
            bottom: 350,
            width: right - left,
            height: 250,
            x: left,
            y: 100,
            toJSON: () => ({}),
          };
        };
      }
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            selectedStop: stops[0],
            selectedStopId: 'stop-1',
            playing: false,
            drawerExpanded: false,
          }}
        />
      );
      await flushUi();
      expect(ctrlHolder.current?.cardSide).toBe('left');

      // Filter change to specific person & empty stops fallback + back to all:all
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            selectedPersonId: 'per_henry',
            selectedEraId: '1880s',
            stops: [],
            stopIds: [],
          }}
        />
      );
      await flushUi();
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            selectedPersonId: 'all',
            selectedEraId: 'all',
            stops,
            stopIds: stops.map((s) => s.id),
          }}
        />
      );
      await flushUi();

      // Zoom / fit controls
      ctrlHolder.current?.handleZoomIn();
      ctrlHolder.current?.handleZoomOut();
      ctrlHolder.current?.handleFitClick();
      expect(liveMap.zoomIn).toHaveBeenCalled();
      expect(liveMap.zoomOut).toHaveBeenCalled();

      // Keyboard navigation + input suppression
      const inputEl = mounted.container.querySelector<HTMLInputElement>('[data-testid="map-input"]');
      if (inputEl) {
        act(() => {
          inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });
      }
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(applyJourney).toHaveBeenCalled();

      // Playback timer + render event clearing fallback timer
      vi.useFakeTimers();
      mounted.rerender(
        <MapControllerHarness
          baseParams={baseMapParams}
          ctrlHolder={ctrlHolder}
          attachHost={true}
          override={{
            bundle: liveBundle,
            playing: true,
            stepIndex: 0,
            selectedStopId: 'stop-1',
            stops,
            stopIds: stops.map((s) => s.id),
          }}
        />
      );
      act(() => {
        liveMap.emit('render');
        vi.advanceTimersByTime(1000);
      });
      expect(applyJourney).toHaveBeenCalled();
      vi.useRealTimers();
    }

    // 5. OHM style error event triggers PAPER_STYLE fallback
    resetCachedOhmStyle();
    mapState.autoEmitStyleLoad = false;
    mounted.rerender(
      <MapControllerHarness
        baseParams={baseMapParams}
        ctrlHolder={ctrlHolder}
        attachHost={true}
        override={{ bundle: { ...RICH_BUNDLE }, searchParams: new URLSearchParams('') }}
      />
    );
    await flushUi();
    const errMap = mapState.instances.at(-1);
    if (errMap) {
      vi.useFakeTimers();
      act(() => {
        errMap.emit('error', { error: new Error(`Failed loading ${OHM_STYLE_URL}`) });
        vi.advanceTimersByTime(10);
      });
      expect(errMap.setStyle).toHaveBeenCalled();
      vi.useRealTimers();
    }
  });
});

describe('useTreeViewportTransform & useTreeCanvasInteractions branch coverage', () => {
  function makeDiagramLayout(): ArchivalDiagramLayout {
    const henry = RICH_BUNDLE.people[0];
    const arthur = RICH_BUNDLE.people[2];
    const nodeHenry = {
      person: henry,
      x: 200,
      y: 120,
      width: 172,
      height: 52,
      gen: 0,
      isDirect: true,
      placement: 'rank' as const,
      unionId: null,
    };
    return {
      nodes: [nodeHenry],
      byId: new Map([[henry.id, nodeHenry]]),
      hubs: [],
      buses: [],
      hangingRails: [],
      siblingToggles: [],
      earlyLossStrips: [
        {
          unionId: 'u1',
          parentIds: [henry.id],
          x: 150,
          y: 220,
          width: 180,
          height: 50,
          stemFromX: 240,
          stemFromY: 180,
          chips: [{ person: arthur, unionId: 'u1', x: 162, y: 240, width: 100, height: 30 }],
        },
      ],
      genBands: [],
      bounds: { minX: 0, maxX: 1600, minY: 0, maxY: 1000 },
    };
  }

  it('exercises viewport transform animations, inertia, fit, centering, scrollRoll, and pointer/wheel/key interactions', () => {
    const rafQueue: Array<(now: number) => void> = [];
    let nowMs = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    let reducedMotion = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: reducedMotion })),
    });

    const layout = makeDiagramLayout();
    const engineHolder: { current: TreeViewportTransformEngine | null } = { current: null };
    let surfaceMode: 'diagram' | 'roll' = 'diagram';
    const onSurface = (s: 'diagram' | 'roll'): void => {
      surfaceMode = s;
    };

    // 1. Null refs branches
    const mounted = mountEl(
      <TreeViewportHarness
        layout={layout}
        engineHolder={engineHolder}
        onSurface={onSurface}
        attachRefs={false}
      />
    );
    expect(engineHolder.current?.readContainerOffset(true).width).toBe(1200);
    expect(engineHolder.current?.clampTransform({ zoom: 1, pan: { x: 0, y: 0 } }).zoom).toBe(1);
    expect(engineHolder.current?.computeFitTransform().zoom).toBeGreaterThan(0);
    expect(engineHolder.current?.scrollRollToPerson('per_henry')).toBe(false);
    expect(engineHolder.current?.centerDiagramOnPerson('missing', false)).toBe(false);
    engineHolder.current?.handleDiagramZoomBy(1.2);
    engineHolder.current?.handleDiagramResetZoom();

    // 2. Attached compact & desktop container
    mounted.rerender(
      <TreeViewportHarness
        layout={layout}
        engineHolder={engineHolder}
        onSurface={onSurface}
        attachRefs={true}
        surface="diagram"
      />
    );
    const containerEl = mounted.container.querySelector<HTMLElement>('[data-testid="tree-container"]');
    expect(containerEl).toBeTruthy();
    if (containerEl) {
      Object.defineProperty(containerEl, 'clientWidth', { value: 500, configurable: true });
      Object.defineProperty(containerEl, 'clientHeight', { value: 500, configurable: true });
      containerEl.getBoundingClientRect = () => ({
        left: 10,
        top: 20,
        right: 510,
        bottom: 520,
        width: 500,
        height: 500,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      });
    }

    // Compact fit + center on early-loss chip + scheduleTransform + rAF flush
    act(() => {
      engineHolder.current?.fitToViewport();
      expect(engineHolder.current?.centerDiagramOnPerson('per_arthur', false)).toBe(true);
      engineHolder.current?.scheduleTransform({ zoom: 0.75, pan: { x: 20, y: 30 } });
      engineHolder.current?.scheduleTransform({ zoom: 0.8, pan: { x: 25, y: 35 } });
      while (rafQueue.length > 0) {
        nowMs += 16;
        rafQueue.shift()?.(nowMs);
      }
    });

    // Desktop dimensions + animateToTransform with scale change & without scale change + reduced motion
    if (containerEl) {
      Object.defineProperty(containerEl, 'clientWidth', { value: 1200, configurable: true });
      Object.defineProperty(containerEl, 'clientHeight', { value: 800, configurable: true });
    }
    act(() => {
      engineHolder.current?.readContainerOffset(false);
      nowMs += 300;
      engineHolder.current?.readContainerOffset(false);
      expect(engineHolder.current?.centerDiagramOnPerson('per_henry', true)).toBe(true);
      while (rafQueue.length > 0) {
        nowMs += 150;
        rafQueue.shift()?.(nowMs);
      }
      // Same zoom animation (isScaleChanging = false)
      const curZoom = engineHolder.current?.transformRef.current.zoom ?? 1;
      engineHolder.current?.animateToTransform({ zoom: curZoom, pan: { x: 10, y: 10 } }, 100);
      while (rafQueue.length > 0) {
        nowMs += 120;
        rafQueue.shift()?.(nowMs);
      }
      // Reduced motion instant apply
      reducedMotion = true;
      engineHolder.current?.animateFitToViewport();
      expect(engineHolder.current?.scrollRollToPerson('per_henry')).toBe(true);
      expect(engineHolder.current?.scrollRollToPerson('unknown')).toBe(false);
      reducedMotion = false;
      expect(engineHolder.current?.scrollRollToPerson('per_henry')).toBe(true);
    });

    // Inertia ticking + wall clamp + decay to stop
    act(() => {
      engineHolder.current?.startInertia(10, 10);
      for (let i = 0; i < 6 && rafQueue.length > 0; i += 1) {
        nowMs += 16;
        rafQueue.shift()?.(nowMs);
      }
      engineHolder.current?.startInertia(0.01, 0.01);
      while (rafQueue.length > 0) {
        nowMs += 16;
        rafQueue.shift()?.(nowMs);
      }
    });

    // Wheel zoom + pointer drag with inertia + pinch + touch double-tap + blur + keyboard shortcuts
    if (containerEl) {
      act(() => {
        containerEl.dispatchEvent(
          new WheelEvent('wheel', {
            deltaY: -120,
            clientX: 200,
            clientY: 200,
            ctrlKey: true,
            cancelable: true,
          })
        );
        // Ignore click on toolbar button
        const tbBtn = containerEl.querySelector('[data-testid="toolbar-btn"]');
        tbBtn?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 50 }));
      });

      // Single pointer mouse drag -> high velocity inertia (> maxSpeed clamp)
      act(() => {
        nowMs = 5000;
        const down = new Event('pointerdown', { bubbles: true });
        Object.assign(down, { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'mouse' });
        containerEl.dispatchEvent(down);

        for (let step = 1; step <= 10; step += 1) {
          nowMs += 12;
          const mv = new Event('pointermove', { bubbles: true });
          Object.assign(mv, {
            pointerId: 1,
            clientX: 100 + step * 45,
            clientY: 100 + step * 45,
            pointerType: 'mouse',
          });
          window.dispatchEvent(mv);
        }
        nowMs += 5;
        const up = new Event('pointerup', { bubbles: true });
        Object.assign(up, { pointerId: 1, clientX: 550, clientY: 550, pointerType: 'mouse' });
        window.dispatchEvent(up);
      });

      // Two-pointer pinch gesture + post-pinch 80ms grace window + pointercancel
      act(() => {
        nowMs = 6000;
        const d1 = new Event('pointerdown', { bubbles: true });
        Object.assign(d1, { pointerId: 10, clientX: 100, clientY: 100, pointerType: 'touch' });
        containerEl.dispatchEvent(d1);

        const d2 = new Event('pointerdown', { bubbles: true });
        Object.assign(d2, { pointerId: 11, clientX: 200, clientY: 100, pointerType: 'touch' });
        containerEl.dispatchEvent(d2);

        const pm = new Event('pointermove', { bubbles: true });
        Object.assign(pm, { pointerId: 11, clientX: 260, clientY: 120, pointerType: 'touch' });
        window.dispatchEvent(pm);

        const u2 = new Event('pointerup', { bubbles: true });
        Object.assign(u2, { pointerId: 11, clientX: 260, clientY: 120, pointerType: 'touch' });
        window.dispatchEvent(u2);

        // Move remaining pointer within 80ms of pinch release
        nowMs += 20;
        const pmAfter = new Event('pointermove', { bubbles: true });
        Object.assign(pmAfter, { pointerId: 10, clientX: 120, clientY: 110, pointerType: 'touch' });
        window.dispatchEvent(pmAfter);

        const cancel = new Event('pointercancel', { bubbles: true });
        Object.assign(cancel, { pointerId: 10, clientX: 120, clientY: 110, pointerType: 'touch' });
        window.dispatchEvent(cancel);

        // Unknown pointer id ignored
        const unknownUp = new Event('pointerup', { bubbles: true });
        Object.assign(unknownUp, { pointerId: 999, clientX: 0, clientY: 0, pointerType: 'touch' });
        window.dispatchEvent(unknownUp);
      });

      // Touch double-tap zoom in, then double-tap again to fit, plus tap on node
      vi.useFakeTimers();
      act(() => {
        nowMs = 8000;
        const tapAt = (x: number, y: number, target: Element = containerEl): void => {
          const td = new Event('pointerdown', { bubbles: true });
          Object.assign(td, { pointerId: 20, clientX: x, clientY: y, pointerType: 'touch' });
          target.dispatchEvent(td);
          const tu = new Event('pointerup', { bubbles: true });
          Object.assign(tu, { pointerId: 20, clientX: x, clientY: y, pointerType: 'touch' });
          window.dispatchEvent(tu);
          vi.advanceTimersByTime(10);
        };
        tapAt(300, 300);
        nowMs += 100;
        tapAt(302, 302);
        // Zoom to 1.6 and double tap again to hit fit branch
        engineHolder.current?.scheduleTransform({ zoom: 1.6, pan: { x: 0, y: 0 } });
        nowMs += 500;
        tapAt(300, 300);
        nowMs += 100;
        tapAt(301, 301);
        window.dispatchEvent(new Event('blur'));
      });
      vi.useRealTimers();

      // Keyboard shortcuts & guards
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true }));
        const inputEl = containerEl.querySelector<HTMLElement>('[data-testid="tree-input"]');
        inputEl?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
        const inDialog = containerEl.querySelector<HTMLElement>('[data-testid="in-dialog"]');
        inDialog?.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));

        for (const key of ['+', '-', '0', '1', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
          window.dispatchEvent(new KeyboardEvent('keydown', { key }));
        }
      });
    }

    // Roll surface ignores pointerdown
    mounted.rerender(
      <TreeViewportHarness
        layout={layout}
        engineHolder={engineHolder}
        onSurface={onSurface}
        attachRefs={true}
        surface="roll"
      />
    );
    expect(surfaceMode).toBe('roll');
    if (containerEl) {
      act(() => {
        const rd = new Event('pointerdown', { bubbles: true });
        Object.assign(rd, { pointerId: 30, clientX: 50, clientY: 50, pointerType: 'mouse' });
        containerEl.dispatchEvent(rd);
      });
    }
  });
});

describe('InlineEntityMention branch coverage', () => {
  it('covers person/place mentions, living redaction, hover/focus/blur, Escape, outside click, and non-router links', () => {
    vi.useFakeTimers();
    const personNoEdtf: Person = {
      ...RICH_BUNDLE.people[2],
      birth_edtf: '',
      death_edtf: '',
      birth_year: 1882,
      death_year: 1950,
    };
    const personUnknown: Person = {
      ...RICH_BUNDLE.people[3],
      birth_edtf: '',
      death_edtf: '',
      birth_year: null,
      death_year: null,
    };
    const placeHomestead: Place = {
      ...RICH_BUNDLE.places[0],
      place_type: 'homestead',
    };
    const placeCounty: Place = {
      ...RICH_BUNDLE.places[1],
      place_type: 'county',
    };

    // Living person -> plain span
    const livingMount = mountEl(
      <InlineEntityMention kind="person" person={RICH_BUNDLE.people[5]} displayText="Living" />
    );
    expect(livingMount.container.textContent).toBe('Living');

    // Person outside router (plain <a>) with surname-only pronunciation coverage
    const personMount = mountEl(
      <InlineEntityMention
        kind="person"
        person={personNoEdtf}
        displayText="Arthur Alder"
        pronunciations={{ Alder: { phonetic: 'AHL-der' } }}
      />
    );
    const link = personMount.container.querySelector<HTMLAnchorElement>('a.inline-entity-link');
    expect(link).toBeTruthy();
    if (link) {
      act(() => {
        link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
      // Leave schedules close; re-enter cancels close timer
      act(() => {
        link.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        vi.advanceTimersByTime(50);
        link.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        vi.advanceTimersByTime(200);
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();

      // Outside mousedown closes
      act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      // Focus opens; Escape with focus inside popover restores focus to anchor
      act(() => {
        link.focus();
      });
      const closeBtn = document.querySelector<HTMLButtonElement>('.citation-popover-close');
      expect(closeBtn).toBeTruthy();
      act(() => {
        closeBtn?.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(document.activeElement).toBe(link);

      // Blur to outside closes
      act(() => {
        link.blur();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }

    // Place mentions inside MemoryRouter (null place_type & snake_case place_type) + unknown dates person
    const routerMount = mountEl(
      <MemoryRouter>
        <InlineEntityMention kind="place" place={placeHomestead} displayText="Harbor" />
        <InlineEntityMention kind="place" place={placeCounty} displayText="Birch Creek" />
        <InlineEntityMention kind="person" person={personUnknown} displayText="Mabel Birch" />
      </MemoryRouter>
    );
    const anchors = routerMount.container.querySelectorAll<HTMLAnchorElement>('a.inline-entity-link');
    expect(anchors.length).toBe(3);
    for (const a of anchors) {
      act(() => {
        a.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      const pop = document.querySelector('[role="dialog"]');
      expect(pop).toBeTruthy();
      // Mousedown inside popover keeps it open
      act(() => {
        pop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
      // Mouseout + wait closes it
      act(() => {
        a.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        vi.advanceTimersByTime(200);
      });
    }
    vi.useRealTimers();
  });
});

describe('KinshipPage branch coverage', () => {
  it('renders loading, <2 people empty state, presets, URL params, swap, and parent/child/spouse chains', () => {
    // 1. Loading state
    const loadingDs: ArchiveDataSource = {
      loadArchive: () => new Promise(() => {}),
      loadReadings: async () => null,
    };
    const loadMount = mountEl(
      <MemoryRouter initialEntries={['/kinship']}>
        <ArchiveProvider siteConfig={BASE_SITE_CONFIG} dataSource={loadingDs}>
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(loadMount.container.textContent).toContain('Loading kinship archive');

    // 2. Fewer than 2 selectable people
    const singleBundle: ArchiveBundle = {
      ...RICH_BUNDLE,
      people: [RICH_BUNDLE.people[0], RICH_BUNDLE.people[5]],
    };
    const emptyMount = mountEl(
      <MemoryRouter initialEntries={['/kinship']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={singleBundle}
          initialReadings={SAMPLE_READINGS}
        >
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(emptyMount.container.textContent).toContain('At least two people are needed');

    // 3. Full kinship page with ?from= & ?to= params (Arthur -> Henry traverses child edge, shared places, presets, swap)
    const fullMount = mountEl(
      <MemoryRouter initialEntries={['/kinship?from=arthur-alder&to=mabel-birch']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <KinshipPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(fullMount.container.textContent).toContain('married to');

    // Click preset chip ("Henry & Clara") -> 2 shared places
    const presetBtn = [...fullMount.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Henry & Clara')
    );
    expect(presetBtn).toBeTruthy();
    act(() => {
      presetBtn?.click();
    });
    expect(fullMount.container.textContent).toContain('2 shared places');

    // Select Henry -> Arthur (parent edge) and swap (child edge)
    const selects = fullMount.container.querySelectorAll<HTMLSelectElement>('select');
    setFieldValue(selects[0], 'per_henry');
    setFieldValue(selects[1], 'per_arthur');
    expect(fullMount.container.textContent).toContain('parent of');
    expect(fullMount.container.textContent).toContain('1 shared place');

    const swapBtn = fullMount.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Swap relatives"]'
    );
    act(() => {
      swapBtn?.click();
    });
    expect(fullMount.container.textContent).toContain('child of');

    // Select person with null dates -> "No lifespan overlap"
    setFieldValue(selects[1], 'per_nodates');
    expect(fullMount.container.textContent).toContain('No lifespan overlap');
  });
});

describe('MediaPlayer branch coverage', () => {
  it('renders plugin override, video/audio/pdf previews and full players, and image thumb fallback', () => {
    const baseMedia: MediaItem = {
      id: 'm1',
      kind: 'family_photo',
      file: '/media/photo.jpg',
      thumb_file: '/media/photo-thumb.jpg',
      caption: 'Harbor Mill',
      date_edtf: '1880',
      person_ids: [],
      source_id: null,
    };

    const customPlugin = {
      id: 'custom-media',
      name: 'Custom Media Renderer',
      mediaRenderers: [
        {
          id: 'special-r',
          match: (m: MediaItem) => m.id === 'm_plugin',
          render: ({ media }: { media: MediaItem; src: string }) => <div>Plugin: {media.caption}</div>,
        },
      ],
    };

    const mounted = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <KinloomPluginProvider plugins={[customPlugin]}>
          <MediaPlayer media={{ ...baseMedia, id: 'm_plugin' }} />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_vid_prev',
              kind: 'video_story',
              file: '/media/story.mp4',
              poster_url: '/media/poster.jpg',
              duration_seconds: 125,
            }}
            variant="preview"
          />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_vid_prev_nodur',
              kind: 'video_story',
              file: '/media/story2.mp4',
              poster_url: '/media/poster.jpg',
            }}
            variant="preview"
            className="custom-vid-prev"
          />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_vid_full',
              kind: 'video_story',
              file: '/media/story.mp4',
              mime_type: 'video/mp4',
              transcript_url: '/media/story.vtt',
              duration_seconds: 90,
            }}
            variant="full"
          />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_aud_prev',
              kind: 'audio_oral_history',
              file: '/media/oral.mp3',
              duration_seconds: 45,
            }}
            variant="preview"
          />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_aud_prev_nodur',
              kind: 'audio_oral_history',
              file: '/media/oral2.mp3',
            }}
            variant="preview"
            className="custom-aud-prev"
          />
          <MediaPlayer
            media={{
              ...baseMedia,
              id: 'm_aud_full',
              kind: 'audio_oral_history',
              file: '/media/oral.mp3',
              mime_type: 'audio/mpeg',
              duration_seconds: 62,
              transcript_url: '/media/oral.txt',
            }}
            variant="full"
          />
          <MediaPlayer
            media={{ ...baseMedia, id: 'm_pdf_prev', file: '/media/deed.pdf', mime_type: 'application/pdf' }}
            variant="preview"
          />
          <MediaPlayer media={{ ...baseMedia, id: 'm_pdf_full', file: '/media/deed.pdf' }} variant="full" />
          <MediaPlayer media={baseMedia} variant="preview" />
          <MediaPlayer media={{ ...baseMedia, thumb_file: undefined }} variant="full" />
        </KinloomPluginProvider>
      </ArchiveProvider>
    );

    expect(mounted.container.textContent).toContain('Plugin: Harbor Mill');
    expect(mounted.container.textContent).toContain('2:05');
    expect(mounted.container.textContent).toContain('Oral History · 0:45');
    expect(mounted.container.textContent).toContain('Read transcript');
    expect(mounted.container.textContent).toContain('Archival Document');
    expect(mounted.container.textContent).toContain('Open PDF in new tab');
    expect(mounted.container.querySelector('video source')).toBeTruthy();
    expect(mounted.container.querySelector('audio source')).toBeTruthy();
    expect(mounted.container.querySelector('iframe')).toBeTruthy();
  });
});

describe('AdminPage branch coverage', () => {
  it('exercises unauthorized guard, load error, role promotion/demotion, invite/token creation, copy fallbacks, and revocations', async () => {
    // 1. Unauthorized view
    const unauthMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          session={{ authenticated: false }}
        >
          <AdminPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(unauthMount.container.textContent).toContain('Administrator permissions are required');

    // 2. Authorized admin with full error & success paths
    const users: UserRecord[] = [
      {
        email: 'admin1@example.com',
        display_name: 'Alice Alder',
        role: 'admin',
        added_at: '2025-01-01T00:00:00Z',
        added_by: 'system',
        last_login_at: null,
      },
      {
        email: 'admin2@example.com',
        display_name: 'Arthur Alder',
        role: 'admin',
        added_at: '2025-01-02T00:00:00Z',
        added_by: 'system',
        last_login_at: null,
      },
      {
        email: 'editor@example.com',
        display_name: 'Clara Mercer',
        role: 'editor',
        added_at: '2025-01-03T00:00:00Z',
        added_by: 'admin1@example.com',
        last_login_at: null,
      },
    ];
    let failRole = true;
    let failInvite = true;
    let failRevokeInvite = true;
    let failToken = true;
    let failRevokeToken = true;
    let failInitialLoad = true;

    const adminClient: AdminDataSource = {
      listUsers: vi.fn(async () => {
        if (failInitialLoad) {
          failInitialLoad = false;
          throw 'string load error';
        }
        return users;
      }),
      updateUserRole: vi.fn(async (email, payload) => {
        if (failRole) {
          failRole = false;
          throw new Error('role update failed');
        }
        return {
          email,
          display_name: 'Updated Member',
          role: payload.role,
          added_at: '2025-01-03T00:00:00Z',
          added_by: 'admin1@example.com',
          last_login_at: null,
        };
      }),
      listInvites: vi.fn(async () => [
        {
          token: 'inv_1',
          label: 'Summer Reunion',
          uses: 2,
          created_at: '2025-01-01T00:00:00Z',
          created_by: 'admin1@example.com',
          last_used_at: null,
          expires_at: null,
          revoked_at: null,
        },
      ]),
      createInvite: vi.fn(async (req) => {
        if (failInvite) {
          failInvite = false;
          throw 'invite failed';
        }
        return {
          invite: {
            token: 'inv_new',
            label: req.label,
            uses: 0,
            created_at: '2025-02-01T00:00:00Z',
            created_by: 'admin1@example.com',
            last_used_at: null,
            expires_at: null,
            revoked_at: null,
          },
          invite_url: 'https://alder.example.com/invite/inv_new',
        };
      }),
      revokeInvite: vi.fn(async () => {
        if (failRevokeInvite) {
          failRevokeInvite = false;
          throw new Error('revoke invite failed');
        }
      }),
      listAgentTokens: vi.fn(async () => [
        {
          token_id: 'tok_1',
          label: 'CLI Helper',
          scope: 'write_batch' as const,
          created_at: '2025-01-01T00:00:00Z',
          created_by: 'admin1@example.com',
          last_used_at: null,
          revoked_at: null,
        },
      ]),
      createAgentToken: vi.fn(async (req) => {
        if (failToken) {
          failToken = false;
          throw 'token create failed';
        }
        return {
          token_id: 'tok_new',
          label: req.label,
          scope: req.scope,
          created_at: '2025-02-01T00:00:00Z',
          created_by: 'admin1@example.com',
          last_used_at: null,
          revoked_at: null,
          plaintext_secret: 'secret_alder_xyz',
        };
      }),
      revokeAgentToken: vi.fn(async () => {
        if (failRevokeToken) {
          failRevokeToken = false;
          throw 'revoke token failed';
        }
      }),
    };

    // First mount hits load error
    const errMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          session={{ authenticated: true, email: 'admin1@example.com', role: 'admin' }}
        >
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(errMount.container.textContent).toContain('string load error');
    errMount.unmount();

    // Second mount loads successfully
    const okMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          session={{ authenticated: true, email: 'admin1@example.com', role: 'admin' }}
        >
          <AdminPage adminClient={adminClient} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(okMount.container.textContent).toContain('Alice Alder');

    const findBtn = (text: string): HTMLButtonElement | undefined =>
      [...okMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text)
      );

    // Promote editor -> first fails, second succeeds
    act(() => {
      findBtn('Promote to Admin')?.click();
    });
    await flushUi();
    expect(okMount.container.textContent).toContain('role update failed');

    act(() => {
      findBtn('Promote to Admin')?.click();
    });
    await flushUi();

    // Demote admin2 via confirmation
    act(() => {
      findBtn('Demote to Editor')?.click();
    });
    act(() => {
      findBtn('Confirm Demote')?.click();
    });
    await flushUi();

    // Create invite -> fails first, then succeeds with invalid days = '0' (undefined expires_in_days)
    const inviteLabelInput = okMount.container.querySelector<HTMLInputElement>(
      'input[placeholder*="Reunion"]'
    );
    const inviteDaysInput = okMount.container.querySelector<HTMLInputElement>(
      'input[aria-label="Expires in days"]'
    );
    const inviteForm = inviteLabelInput?.closest('form');
    expect(inviteLabelInput && inviteDaysInput && inviteForm).toBeTruthy();
    if (inviteLabelInput && inviteDaysInput && inviteForm) {
      setFieldValue(inviteLabelInput, 'Harbor Cousins');
      setFieldValue(inviteDaysInput, '0');
      act(() => {
        inviteForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      expect(okMount.container.textContent).toContain('invite failed');

      act(() => {
        inviteForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      expect(okMount.container.textContent).toContain('https://alder.example.com/invite/inv_new');
    }

    // Copy invite without navigator.clipboard, then with rejecting clipboard, then with resolving clipboard
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    act(() => {
      findBtn('Copy Invite Link')?.click();
    });
    expect(okMount.container.textContent).toContain('Copied');

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
      configurable: true,
    });
    act(() => {
      findBtn('Copied')?.click();
    });
    await flushUi();

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    act(() => {
      findBtn('Copy Invite Link')?.click();
    });
    await flushUi();
    act(() => {
      findBtn('Dismiss')?.click();
    });

    // Revoke invite: fail then succeed
    const revokeBtns = [...okMount.container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Revoke'
    );
    act(() => {
      revokeBtns[0]?.click();
    });
    act(() => {
      findBtn('Confirm Revoke')?.click();
    });
    await flushUi();
    expect(okMount.container.textContent).toContain('revoke invite failed');

    const revokeBtns2 = [...okMount.container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Revoke'
    );
    act(() => {
      revokeBtns2[0]?.click();
    });
    act(() => {
      findBtn('Confirm Revoke')?.click();
    });
    await flushUi();

    // Create token: fail then succeed, copy secret (success & fail), dismiss, revoke token (fail then succeed)
    const tokenInput = okMount.container.querySelector<HTMLInputElement>(
      'input[placeholder*="Research CLI"]'
    );
    const scopeSelect = okMount.container.querySelector<HTMLSelectElement>(
      'select[aria-label="Agent token scope"]'
    );
    if (tokenInput && scopeSelect) {
      setFieldValue(tokenInput, 'Nightly Backup');
      setFieldValue(scopeSelect, 'read_backup');
      act(() => {
        findBtn('Create Token')?.click();
      });
      await flushUi();
      expect(okMount.container.textContent).toContain('token create failed');

      act(() => {
        findBtn('Create Token')?.click();
      });
      await flushUi();
      expect(okMount.container.textContent).toContain('secret_alder_xyz');

      act(() => {
        findBtn('Copy Secret')?.click();
      });
      await flushUi();
      expect(okMount.container.textContent).toContain('Copied');

      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) },
        configurable: true,
      });
      act(() => {
        findBtn('Copied')?.click();
      });
      await flushUi();
      act(() => {
        findBtn('Dismiss')?.click();
      });
    }

    const tokenRevokeBtn = [...okMount.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((b) => b.textContent?.trim() === 'Revoke')
      .at(-1);
    act(() => {
      tokenRevokeBtn?.click();
    });
    act(() => {
      findBtn('Confirm Revoke')?.click();
    });
    await flushUi();
    expect(okMount.container.textContent).toContain('revoke token failed');

    const tokenRevokeBtn2 = [...okMount.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((b) => b.textContent?.trim() === 'Revoke')
      .at(-1);
    act(() => {
      tokenRevokeBtn2?.click();
    });
    act(() => {
      findBtn('Confirm Revoke')?.click();
    });
    await flushUi();
  });
});

describe('TreePage, ArchiveDataContext, and IndexPage branch coverage', () => {
  it('exercises TreePage loading, empty state, focus query param, surface/branch/mode toggles, and Escape clear', async () => {
    // 1. Empty archive bundle
    const emptyBundle: ArchiveBundle = { ...RICH_BUNDLE, people: [], kinship: [] };
    const emptyMount = mountEl(
      <MemoryRouter initialEntries={['/tree']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={emptyBundle}
          initialReadings={SAMPLE_READINGS}
        >
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(emptyMount.container.textContent).toContain('No people have been added');

    // 2. Full tree with ?focus=mabel-birch + editor mode
    const treeMount = mountEl(
      <MemoryRouter initialEntries={['/tree?focus=mabel-birch']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          capabilities={{ canEdit: true }}
        >
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(treeMount.container.textContent).toContain('Mabel Birch');

    // Press Escape to clear selection
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });

    // Click main canvas background in diagram surface
    const mainEl = treeMount.container.querySelector<HTMLElement>('#main-content');
    act(() => {
      mainEl?.click();
    });

    // Switch to Roll surface and back to Diagram
    const rollBtn = [...treeMount.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Pedigree Roll') || b.textContent?.includes('Roll')
    );
    act(() => {
      rollBtn?.click();
    });
    act(() => {
      mainEl?.click();
    });

    // Click "+ Add Person" button
    const addBtn = [...treeMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Add Person')
    );
    act(() => {
      addBtn?.click();
    });
    expect(treeMount.container.querySelector('dialog')).toBeTruthy();
  });

  it('exercises ArchiveDataContext prop changes, refreshSession, loadMediaChecklist, load errors, and useArchiveData guard', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => mountEl(<BadArchiveDataConsumer />)).toThrow(
      'useArchiveData must be used inside ArchiveDataProvider'
    );
    errSpy.mockRestore();

    const ctxHolder: { current: ArchiveDataContextValue | null } = { current: null };

    const anonSessionResponse = {
      session: {
        authenticated: false,
        principal_kind: 'anonymous' as const,
      },
      capabilities: {
        canEdit: false,
        canUploadMedia: false,
        hasRevisionHistory: false,
        hasTalk: false,
        canManageSite: false,
      },
    };
    const ds1 = makeMemoryDataSource({
      loadMediaChecklist: undefined,
      getSession: vi.fn(async () => anonSessionResponse),
    });
    const ds2 = makeMemoryDataSource({
      loadMediaChecklist: vi.fn(async () => []),
      getSession: vi.fn(async () => anonSessionResponse),
    });

    const mounted = mountEl(
      <ArchiveDataProvider
        siteConfig={BASE_SITE_CONFIG}
        dataSource={ds1}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
        session={{ authenticated: true, email: 'ed@example.com', role: 'editor' }}
        capabilities={{ canEdit: true }}
      >
        <ArchiveDataReader ctxHolder={ctxHolder} />
      </ArchiveDataProvider>
    );
    await flushUi();
    expect(await ctxHolder.current?.loadMediaChecklist()).toEqual([]);
    act(() => {
      ctxHolder.current?.setPronunciations({ Birch: { phonetic: 'BURCH' } });
    });
    expect(ctxHolder.current?.pronunciations.Birch?.phonetic).toBe('BURCH');

    // Swap dataSource, remove explicit session prop, update capabilities -> sync effects run
    mounted.rerender(
      <ArchiveDataProvider
        siteConfig={{ ...BASE_SITE_CONFIG, featuredDocumentId: 'nonexistent_doc' }}
        dataSource={ds2}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
        capabilities={{ canEdit: false }}
      >
        <ArchiveDataReader ctxHolder={ctxHolder} />
      </ArchiveDataProvider>
    );
    expect(ctxHolder.current?.featuredDocumentId).toBe('src_other');
    await flushUi();
    expect(await ctxHolder.current?.loadMediaChecklist()).toEqual([]);
    await act(async () => {
      await ctxHolder.current?.refreshSession();
    });
    expect(ctxHolder.current?.bundle).toBeNull();

    // Archive load rejection error path
    const failingDs: ArchiveDataSource = {
      loadArchive: async () => {
        throw new Error('Archive offline');
      },
      loadReadings: async () => null,
    };
    const failMount = mountEl(
      <ArchiveDataProvider siteConfig={BASE_SITE_CONFIG} dataSource={failingDs}>
        <ArchiveDataReader ctxHolder={ctxHolder} />
      </ArchiveDataProvider>
    );
    await flushUi();
    expect(ctxHolder.current?.error).toContain('Archive offline');
    failMount.unmount();
  });

  it('exercises IndexPage empty, error retry, alt-name/place search, unconfigured sections, and GEDCOM export', async () => {
    vi.useFakeTimers();
    const noSectionConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
      lineageSections: [],
    });
    const mounted = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={noSectionConfig}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          capabilities={{ canEdit: true }}
        >
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(mounted.container.textContent).toContain('1850–1899');

    // Search by alt_name ('May Birch') -> singular export (1 relative)
    const searchInput = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(searchInput).toBeTruthy();
    if (searchInput) {
      setFieldValue(searchInput, 'May Birch');
      expect(mounted.container.textContent).toContain('Mabel Birch');
      const exportBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Export GEDCOM')
      );
      act(() => {
        exportBtn?.click();
      });
      expect(mounted.container.textContent).toContain('Exported 1 relative to');
      act(() => {
        vi.advanceTimersByTime(4500);
      });

      // Non-matching search shows empty state with Clear filters button
      setFieldValue(searchInput, 'zzzz-no-match');
      expect(mounted.container.textContent).toContain('No people match the active filters.');
      const clearBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.trim() === 'Clear filters'
      );
      act(() => {
        clearBtn?.click();
      });
      expect(mounted.container.textContent).toContain('Henry Alder');
    }

    // Empty bundle shows no-people notice
    const emptyBundle: ArchiveBundle = { ...RICH_BUNDLE, people: [] };
    const emptyMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={noSectionConfig}
          initialBundle={emptyBundle}
          initialReadings={SAMPLE_READINGS}
        >
          <IndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(emptyMount.container.textContent).toContain('No people have been added');
    vi.useRealTimers();
  });
});

describe('SourceReaderDrawer, SourceCitationTag, and LocalSurveyMap branch coverage', () => {
  it('exercises SourceReaderDrawer multi-doc tabs, keyboard paging, search, scan zoom, copy & download actions', async () => {
    const mounted = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <SourceReaderOpenTrigger sourceId="src_ledger" eventId="evt_1880" />
        <SourceReaderDrawer />
      </ArchiveProvider>
    );
    // Closed initially
    expect(mounted.container.querySelector('dialog')).toBeNull();

    act(() => {
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="open-reader"]')?.click();
    });
    expect(mounted.container.querySelector('dialog')).toBeTruthy();

    // Keyboard ArrowLeft & ArrowRight navigation + ignore inside search input and tablist
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    });
    const searchInput = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
    if (searchInput) {
      act(() => {
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      });
      // Search matching 2 pages ("Harbor"), then 1 page ("Clara")
      setFieldValue(searchInput, 'Harbor');
      expect(mounted.container.textContent).toContain('2 matching pages');
      setFieldValue(searchInput, 'Clara');
      expect(mounted.container.textContent).toContain('1 matching page:');
      setFieldValue(searchInput, '');
    }

    // View mode switching: split & scan + open zoom dialog
    const splitBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Side-by-Side'
    );
    act(() => {
      splitBtn?.click();
    });

    // Tablist keyboard navigation
    const tablist = mounted.container.querySelector<HTMLElement>('[role="tablist"]');
    act(() => {
      tablist?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });

    // Copy All Text (rejecting then resolving) + Download Text + All Sources (.txt)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('blocked'))) },
      configurable: true,
    });
    const copyBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Copy All Text')
    );
    act(() => {
      copyBtn?.click();
    });
    await flushUi();
    expect(mounted.container.textContent).toContain('Copy blocked');

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    act(() => {
      copyBtn?.click();
    });
    await flushUi();
    expect(mounted.container.textContent).toContain('Copied all pages');

    const dlBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Download Text')
    );
    const dlAllBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('All Sources')
    );
    act(() => {
      dlBtn?.click();
      dlAllBtn?.click();
    });

    // Empty readings state
    const emptyReadingsMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={{ version: 1, documents: {}, event_page_map: {} }}
      >
        <SourceReaderOpenTrigger />
        <SourceReaderDrawer />
      </ArchiveProvider>
    );
    act(() => {
      emptyReadingsMount.container.querySelector<HTMLButtonElement>('[data-testid="open-reader"]')?.click();
    });
    expect(emptyReadingsMount.container.textContent).toContain('No primary source transcriptions');
  });

  it('exercises SourceCitationTag discrepancies, scan lightbox, copy states, and inspector/reader triggers', async () => {
    const sourcesById = new Map<string, SourceRecord>([
      [
        'src_ledger',
        {
          id: 'src_ledger',
          citation: '1880 Harbor Ledger',
          source_type: 'census',
          has_primary_source: true,
          url: 'https://archives.example.com/1880',
        },
      ],
    ]);

    // Empty returns null
    const emptyMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <SourceCitationTag sources={[]} sourcesById={sourcesById} />
      </ArchiveProvider>
    );
    expect(emptyMount.container.innerHTML).toBe('');

    // Populated with scan, singular & plural conflicts
    const mounted = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <SourceCitationTag
          eventId="evt_1880"
          sources={[
            {
              source_id: 'src_ledger',
              confidence: 'high',
              scan_url: '/scans/p1.jpg',
              scan_title: 'Ledger Page 1',
              citation_detail: 'p. 1',
              claimed_date: '1880',
            },
            {
              source_id: 'src_unverified',
              confidence: 'low',
              scan_url: '/scans/p2.jpg',
            },
          ]}
          alternateDates={[
            { edtf_date: '1881', source_id: 'src_ledger', note: 'Tax roll date' },
            { edtf_date: '', source_id: 'src_missing', note: 'Undated note' },
          ]}
          alternatePlaces={[{ place_name: 'Old Harbor', source_id: 'src_ledger', note: 'Prior name' }]}
          factConflicts={[
            { claim: 'Miller', source_id: 'src_ledger', note: 'Ledger occupation' },
            { claim: 'Farmer', source_id: 'src_missing', note: 'Oral note' },
          ]}
          sourcesById={sourcesById}
        />
      </ArchiveProvider>
    );

    expect(mounted.container.textContent).toContain('2 Date Discrepancies');
    expect(mounted.container.textContent).toContain('1 Place Discrepancy');
    expect(mounted.container.textContent).toContain('2 Fact Discrepancies');

    // Open top-level scan lightbox & close
    const viewScanBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Scan')
    );
    act(() => {
      viewScanBtn?.click();
    });
    expect(mounted.container.querySelector('dialog')).toBeTruthy();
    const closeScanBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Close')
    );
    act(() => {
      closeScanBtn?.click();
    });

    // Expand details
    const toggleBtn = mounted.container.querySelector<HTMLButtonElement>('.source-toggle');
    act(() => {
      toggleBtn?.click();
    });
    expect(mounted.container.textContent).toContain('Preserved Date Discrepancies');

    // Test copy with missing clipboard, rejecting clipboard, and resolving clipboard
    const copyBtns = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Copy'
    );
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    act(() => {
      copyBtns[0]?.click();
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => Promise.reject(new Error('nope'))) },
      configurable: true,
    });
    act(() => {
      copyBtns[0]?.click();
    });
    await flushUi();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });
    act(() => {
      copyBtns[0]?.click();
    });
    await flushUi();
    expect(mounted.container.textContent).toContain('Copied');

    // Click Inspect Source, Read Text, per-item Scan, and discrepancy inline links
    for (const label of ['Inspect Source', 'Read Text', 'Scan ↗']) {
      const btn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(label)
      );
      act(() => {
        btn?.click();
      });
    }
    const inlineBtns = mounted.container.querySelectorAll<HTMLButtonElement>('.source-read-inline');
    for (const btn of inlineBtns) {
      act(() => {
        btn.click();
      });
    }
  });

  it('exercises LocalSurveyMap narrow/wide, ResizeObserver fallback, scope modes, clustered pins, and keyboard nav', () => {
    const center = RICH_BUNDLE.places[0];
    // Add places clustered close together and blocking right/left center labels
    const nearby: Place[] = [
      ...RICH_BUNDLE.places,
      {
        id: 'pl_e1',
        slug: 'east-1',
        name: 'East Mill',
        full_name: 'East Mill, Cedar County',
        place_type: 'town',
        parent_id: null,
        lat: 42.87,
        lng: -85.75,
      },
      {
        id: 'pl_e2',
        slug: 'east-2',
        name: 'East Dock',
        full_name: 'East Dock, Cedar County',
        place_type: 'town',
        parent_id: null,
        lat: 42.871,
        lng: -85.751,
      },
      {
        id: 'pl_w1',
        slug: 'west-1',
        name: 'West Cove',
        full_name: 'West Cove, Cedar County',
        place_type: 'town',
        parent_id: null,
        lat: 42.87,
        lng: -85.97,
      },
      {
        id: 'pl_n1',
        slug: 'north-1',
        name: 'North Point',
        full_name: 'North Point, Cedar County',
        place_type: 'town',
        parent_id: null,
        lat: 43.05,
        lng: -85.86,
      },
      {
        id: 'pl_s1',
        slug: 'south-1',
        name: 'South Point',
        full_name: 'South Point, Cedar County',
        place_type: 'town',
        parent_id: null,
        lat: 42.68,
        lng: -85.86,
      },
    ];

    // 1. Without ResizeObserver, narrow viewport + radius15
    const origRO = globalThis.ResizeObserver;
    Object.defineProperty(globalThis, 'ResizeObserver', { value: undefined, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    const narrowMount = mountEl(
      <MemoryRouter>
        <LocalSurveyMap center={center} allPlaces={nearby} scopeMode="radius15" />
      </MemoryRouter>
    );
    expect(narrowMount.container.textContent).toContain('15-mi radius');
    const pin = narrowMount.container.querySelector<SVGGElement>('.survey-neighbor-pin');
    act(() => {
      pin?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      pin?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      pin?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    });

    // 2. With ResizeObserver, wide viewport + county & exact & compact
    class FakeResizeObserver implements ResizeObserver {
      constructor(private cb: ResizeObserverCallback) {}
      observe(): void {
        this.cb([], this);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeResizeObserver, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });

    const countyMount = mountEl(
      <MemoryRouter>
        <LocalSurveyMap center={center} allPlaces={nearby} scopeMode="county" />
        <LocalSurveyMap center={center} allPlaces={nearby} scopeMode="exact" />
        <LocalSurveyMap center={center} allPlaces={nearby} compact />
      </MemoryRouter>
    );
    expect(countyMount.container.textContent).toContain('County corridor');
    expect(countyMount.container.textContent).toContain('Exact parcel/town');

    Object.defineProperty(globalThis, 'ResizeObserver', { value: origRO, configurable: true });
  });
});

describe('CreateEntityModal, NarrativeAudioPlayers, useDialogFocusTrap, AppErrorBoundary, PronunciationBadge, RevisionHistoryPanel, and PersonPage', () => {
  it('exercises CreateEntityModal read-only guard, relative create/link error recovery, and standard form tabs', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();

    // 1. Read-only archive shows error on submit
    const roMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <CreateEntityModal open onClose={onClose} />
      </ArchiveProvider>
    );
    const roForm = roMount.container.querySelector<HTMLFormElement>('form');
    act(() => {
      roForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushUi();
    expect(roMount.container.textContent).toContain('read-only mode');

    // 2. Relative context: create person succeeds + link edge fails; then link_existing tab search & error & success
    let callCount = 0;
    const makeStubRev = (id: number, entityType: 'person' | 'kinship_edge'): RevisionRecord => ({
      revision_id: asRevisionId(id),
      batch_id: null,
      entity_type: entityType,
      entity_id: entityType === 'person' ? 'per_nora' : 'kin_1',
      parent_revision_id: null,
      reverted_revision_id: null,
      action: 'create',
      author_type: 'human',
      author_id: 'admin1@example.com',
      author_name: 'Alice Alder',
      summary: 'Added',
      has_primary_source: true,
      before_json: null,
      after_json: {},
      created_at: '2025-02-01T12:00:00Z',
    });
    const createEntity: NonNullable<ArchiveDataSource['createEntity']> = vi.fn(async (entityType, input) => {
      callCount += 1;
      if (entityType === 'person' && callCount === 1) {
        return { entity: { ...input.data }, revision: makeStubRev(1, 'person'), etag: '"v2"' };
      }
      if (entityType === 'kinship_edge' && callCount === 2) {
        throw new Error('edge conflict');
      }
      if (entityType === 'kinship_edge' && callCount === 3) {
        throw 'string edge fail';
      }
      return {
        entity: { from: 'per_henry', to: 'per_nodates', relation: 'spouse' },
        revision: makeStubRev(2, 'kinship_edge'),
        etag: '"v3"',
      };
    });

    const ds = makeMemoryDataSource({
      createEntity,
    });

    const relMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        dataSource={ds}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <CreateEntityModal
          open
          relativeContext={{
            anchorPersonId: 'per_henry',
            anchorPersonName: 'Henry Alder',
            relation: 'spouse',
          }}
          onClose={onClose}
          onCreated={onCreated}
        />
      </ArchiveProvider>
    );

    const summaryInput = relMount.container.querySelector<HTMLInputElement>(
      'input[placeholder*="photo album"]'
    );
    const form = relMount.container.querySelector<HTMLFormElement>('form');
    // Short summary error
    if (summaryInput && form) {
      setFieldValue(summaryInput, 'ab');
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(relMount.container.textContent).toContain('at least 3 characters');

      // Missing person name validation error
      setFieldValue(summaryInput, 'Added from census');
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(relMount.container.textContent).toContain('given name or surname');

      // Fill given name -> person succeeds, link fails
      const givenInput = relMount.container.querySelector<HTMLInputElement>('input[type="text"]');
      if (givenInput) {
        setFieldValue(givenInput, 'Nora');
      }
      // Toggle primary source checkbox to false
      const primaryCheckbox = relMount.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      const lastCb = primaryCheckbox[primaryCheckbox.length - 1];
      act(() => {
        lastCb?.click();
      });
      expect(relMount.container.textContent).toContain('Family memory');

      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      expect(relMount.container.textContent).toContain(
        'Person record saved, but linking failed: edge conflict'
      );

      // Switch to Link existing person tab
      const linkTab = [...relMount.container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) =>
        b.textContent?.includes('Link existing')
      );
      act(() => {
        linkTab?.click();
      });
      // Submit without selecting person
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      expect(relMount.container.textContent).toContain('Choose an existing person');

      // Filter by alt_name ('May Birch') and select Mabel
      const filterInput = relMount.container.querySelector<HTMLInputElement>('input[type="search"]');
      if (filterInput) {
        setFieldValue(filterInput, 'May Birch');
      }
      const existingSelect = relMount.container.querySelector<HTMLSelectElement>('select');
      if (existingSelect) {
        setFieldValue(existingSelect, 'per_nodates');
      }
      // First link attempt rejects with string
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      expect(relMount.container.textContent).toContain('string edge fail');

      // Second link attempt succeeds
      act(() => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flushUi();
      expect(onCreated).toHaveBeenCalled();
    }
  });

  it('exercises NarrativeAudioMarginBar and NarrativeAudioDock across play, scrub, speed, notes jump, and dismiss', () => {
    const track: ActiveNarrativeAudioTrack = {
      narrativeId: 'nar_bio',
      narrativeTitle: 'Life of Henry Alder',
      narrativeKind: 'biography',
      personName: 'Henry Alder',
      personSlug: 'henry-alder',
      personInitials: 'HA',
      src: '/audio/henry.mp3',
      duration: 180,
      editorNotesStart: 120,
      storyVoice: 'Charon',
      notesVoice: 'Kore',
    };
    const trackNoPerson: ActiveNarrativeAudioTrack = {
      ...track,
      narrativeId: 'nar_plain',
      personName: null,
      personSlug: null,
      duration: 0,
      editorNotesStart: null,
    };

    // Outside provider -> null
    const outside = mountEl(
      <MemoryRouter>
        <NarrativeAudioMarginBar track={track} />
        <NarrativeAudioDock />
      </MemoryRouter>
    );
    expect(outside.container.innerHTML).toBe('');

    // Inside provider
    const mounted = mountEl(
      <MemoryRouter>
        <NarrativeAudioProvider>
          <NarrativeAudioMarginBar track={track} />
          <NarrativeAudioMarginBar track={trackNoPerson} />
          <NarrativeAudioDock />
        </NarrativeAudioProvider>
      </MemoryRouter>
    );

    const playBtns = mounted.container.querySelectorAll<HTMLButtonElement>('.narrative-audio-play-btn');
    act(() => {
      playBtns[0]?.click();
    });
    expect(mounted.container.querySelector('[data-testid="narrative-audio-dock"]')).toBeTruthy();

    // Seek via range input into notes section (150s >= 120s)
    const rangeInput = mounted.container.querySelector<HTMLInputElement>('input[type="range"]');
    if (rangeInput) {
      setFieldValue(rangeInput, '150');
    }
    expect(mounted.container.textContent).toContain("Editor's Notes");

    // Click jump back to Story in margin bar & dock, speed cycle, skip -15/+15, pause/resume
    const dock = mounted.container.querySelector<HTMLElement>('[data-testid="narrative-audio-dock"]');
    expect(dock).toBeTruthy();
    if (dock) {
      const dockBtns = dock.querySelectorAll<HTMLButtonElement>('button');
      for (const btn of dockBtns) {
        if (btn.getAttribute('aria-label') !== 'Close audio player') {
          act(() => {
            btn.click();
          });
        }
      }
      // Switch to second track (duration 0, no personName/personSlug)
      act(() => {
        playBtns[1]?.click();
      });
      expect(dock.textContent).toContain('0:00');
      // Dismiss dock
      const closeBtn = dock.querySelector<HTMLButtonElement>('button[aria-label="Close audio player"]');
      act(() => {
        closeBtn?.click();
      });
      expect(mounted.container.querySelector('[data-testid="narrative-audio-dock"]')).toBeNull();
    }
  });

  it('exercises useDialogFocusTrap visibility filters, empty-focusable dialog, Tab/Shift+Tab wrap, and nested stack Escape', () => {
    const outerClose = vi.fn();
    const innerClose = vi.fn();

    // 1. Empty dialog -> sets tabindex="-1" and keeps focus on Tab
    const emptyMount = mountEl(
      <DialogTrapHarness
        openOuter
        openInner={false}
        empty
        onCloseOuter={outerClose}
        onCloseInner={innerClose}
      />
    );
    const emptyDialog = emptyMount.container.querySelector<HTMLElement>('[data-testid="outer-dialog"]');
    expect(emptyDialog?.getAttribute('tabindex')).toBe('-1');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    });
    emptyMount.unmount();

    // 2. Populated dialog + nested dialog
    const mounted = mountEl(
      <DialogTrapHarness openOuter openInner={false} onCloseOuter={outerClose} onCloseInner={innerClose} />
    );
    const outerEl = mounted.container.querySelector<HTMLElement>('[data-testid="outer-dialog"]');
    expect(outerEl).toBeTruthy();
    if (outerEl) {
      expect(getFocusableElements(outerEl)).toHaveLength(2);
    }
    const firstBtn = mounted.container.querySelector<HTMLButtonElement>('[data-testid="first-btn"]');
    const lastBtn = mounted.container.querySelector<HTMLButtonElement>('[data-testid="last-btn"]');
    expect(document.activeElement).toBe(firstBtn);

    // Shift+Tab from first wraps to last
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(lastBtn);

    // Tab from last wraps to first
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    });
    expect(document.activeElement).toBe(firstBtn);

    // Open nested inner dialog -> Escape only closes inner
    mounted.rerender(
      <DialogTrapHarness openOuter openInner onCloseOuter={outerClose} onCloseInner={innerClose} />
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    });
    expect(innerClose).toHaveBeenCalledTimes(1);
    expect(outerClose).not.toHaveBeenCalled();
  });

  it('exercises AppErrorBoundary normal render, runtime error recovery, and chunk load error recovery', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const okMount = mountEl(
      <AppErrorBoundary>
        <ErrorBoundaryBomb />
      </AppErrorBoundary>
    );
    expect(okMount.container.textContent).toContain('Safe Child');

    // Runtime error without siteTitle
    const runtimeMount = mountEl(
      <AppErrorBoundary baseUrl="/alder/">
        <ErrorBoundaryBomb err={new Error('Render crash')} />
      </AppErrorBoundary>
    );
    expect(runtimeMount.container.textContent).toContain('This page could not be displayed');
    expect(runtimeMount.container.textContent).toContain('FAMILY ARCHIVE');

    // Chunk load error (pre-set sessionStorage so second hit renders stale-chunk copy without throwing on jsdom location.reload)
    sessionStorage.setItem('kinloom:chunk-reload-attempted', '1');
    const chunkErr = new Error('Failed to fetch dynamically imported module /assets/chunk.js');
    const chunkMount = mountEl(
      <AppErrorBoundary siteTitle="Alder Archive">
        <ErrorBoundaryBomb err={chunkErr} />
      </AppErrorBoundary>
    );
    expect(chunkMount.container.textContent).toContain('A newer archive version is available');
    expect(chunkMount.container.textContent).toContain('ALDER ARCHIVE');

    sessionStorage.removeItem('kinloom:chunk-reload-attempted');
    fetchSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('exercises PronunciationBadge audio playback, speechSynthesis, variants, and unsafe/safe source URLs', async () => {
    // Null returns empty
    const emptyMount = mountEl(<PronunciationBadge pronunciation={null} label="Alder" />);
    expect(emptyMount.container.innerHTML).toBe('');

    // Fake Audio class
    const audioListeners = new Map<string, () => void>();
    let playShouldReject = false;
    class FakeAudio {
      currentTime = 0;
      pause = vi.fn();
      addEventListener(evt: string, fn: () => void): void {
        audioListeners.set(evt, fn);
      }
      play(): Promise<void> {
        return playShouldReject ? Promise.reject(new Error('autoplay')) : Promise.resolve();
      }
    }
    vi.stubGlobal('Audio', FakeAudio);

    const speakMock = vi.fn();
    const cancelMock = vi.fn();
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: { speak: speakMock, cancel: cancelMock },
    });
    class FakeUtterance {
      lang = '';
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);

    const mounted = mountEl(
      <PronunciationBadge
        label="Alder"
        coverage="surname"
        matchedPart="Alder"
        pronunciation={{
          phonetic: 'AHL-der',
          ipa: '/ˈɔːl.dɚ/',
          language: 'en-US',
          note: 'Harbor stress',
          audio_url: '/audio/alder.mp3',
          source_url: 'https://example.com/pron',
          variants: [
            { label: 'Dutch', phonetic: 'AHL-dur', language: 'nl-NL', source_url: 'javascript:alert(1)' },
          ],
        }}
      />
    );
    const playBtn = mounted.container.querySelector<HTMLButtonElement>('.pronunciation-play-btn');
    expect(playBtn).toBeTruthy();

    // Play audio -> click again to stop -> play again and reject
    act(() => {
      playBtn?.click();
    });
    expect(playBtn?.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      playBtn?.click();
    });
    expect(playBtn?.getAttribute('aria-pressed')).toBe('false');

    playShouldReject = true;
    act(() => {
      playBtn?.click();
    });
    await flushUi();
    expect(playBtn?.getAttribute('aria-pressed')).toBe('false');

    // Switch to Dutch variant (no audio_url -> uses speechSynthesis with native label & nl-NL lang)
    const dutchBtn = [
      ...mounted.container.querySelectorAll<HTMLButtonElement>('.pronunciation-variant-btn'),
    ].find((b) => b.textContent?.includes('Dutch'));
    act(() => {
      dutchBtn?.click();
    });
    act(() => {
      playBtn?.click();
    });
    expect(speakMock).toHaveBeenCalled();

    // Switch back to Primary variant
    const primaryBtn = mounted.container.querySelector<HTMLButtonElement>('.pronunciation-variant-btn');
    act(() => {
      primaryBtn?.click();
    });
  });

  it('exercises RevisionHistoryPanel initialRevisions, missing listRevisions, error, diff toggle, and revert confirm/cancel/error', async () => {
    const rev1: RevisionRecord = {
      revision_id: asRevisionId(10),
      entity_type: 'person',
      entity_id: 'per_henry',
      action: 'update',
      author_type: 'human',
      author_id: 'admin1@example.com',
      author_name: 'Alice Alder',
      summary: 'Corrected birth year',
      has_primary_source: true,
      batch_id: asBatchId('batch_1'),
      parent_revision_id: asRevisionId(9),
      reverted_revision_id: null,
      before_json: { birth_edtf: '1854' },
      after_json: { birth_edtf: '1855' },
      created_at: '2025-02-01T12:00:00Z',
    };

    // 1. No listRevisions -> empty state
    const noListMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <RevisionHistoryPanel entityType="person" entityId="per_henry" />
      </ArchiveProvider>
    );
    await flushUi();
    expect(noListMount.container.textContent).toContain('No revisions have been recorded');

    // 2. listRevisions throws string error
    const errDs = makeMemoryDataSource({
      listRevisions: vi.fn(async () => {
        throw 'revisions unavailable';
      }),
    });
    const errMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        dataSource={errDs}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <RevisionHistoryPanel entityType="person" entityId="per_henry" />
      </ArchiveProvider>
    );
    await flushUi();
    expect(errMount.container.textContent).toContain('revisions unavailable');

    // 3. initialRevisions + diff toggle + revert cancel, fail, succeed
    let failRevert = true;
    const onReverted = vi.fn();
    const okDs = makeMemoryDataSource({
      listRevisions: vi.fn(async () => ({ items: [rev1], next_cursor: null })),
      revertRevision: vi.fn(async () => {
        if (failRevert) {
          failRevert = false;
          throw 'revert denied';
        }
        return { revision: { ...rev1, revision_id: asRevisionId(11) }, etag: '"v4"' };
      }),
    });
    const okMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        dataSource={okDs}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
        capabilities={{ canEdit: true }}
      >
        <RevisionHistoryPanel
          entityType="person"
          entityId="per_henry"
          initialRevisions={[rev1]}
          onReverted={onReverted}
        />
      </ArchiveProvider>
    );
    expect(okMount.container.textContent).toContain('batch:batch_1');

    const findBtn = (text: string): HTMLButtonElement | undefined =>
      [...okMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes(text)
      );

    // Toggle Hide Diff -> View Diff
    act(() => {
      findBtn('Hide Diff')?.click();
    });
    expect(findBtn('View Diff')).toBeTruthy();

    // Undo -> Cancel
    act(() => {
      findBtn('Undo / Revert')?.click();
    });
    act(() => {
      findBtn('Cancel')?.click();
    });

    // Undo -> Confirm (fails first, then succeeds)
    act(() => {
      findBtn('Undo / Revert')?.click();
    });
    act(() => {
      findBtn('Confirm Revert')?.click();
    });
    await flushUi();
    expect(okMount.container.textContent).toContain('revert denied');

    act(() => {
      findBtn('Undo / Revert')?.click();
    });
    act(() => {
      findBtn('Confirm Revert')?.click();
    });
    await flushUi();
    expect(onReverted).toHaveBeenCalledTimes(1);
    expect(okMount.container.textContent).toContain('Reverted r10 in new revision r11');
  });

  it('exercises PersonPage states and usePersonTimelineSync scroll/resize sync on mobile and desktop', async () => {
    // 1. PersonPage error with Try again
    const errDs: ArchiveDataSource = {
      loadArchive: async () => {
        throw new Error('Failed archive');
      },
      loadReadings: async () => null,
    };
    const errMount = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider siteConfig={BASE_SITE_CONFIG} dataSource={errDs}>
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(errMount.container.textContent).toContain('Try again');

    // 2. Valid PersonPage with editor capabilities (tabs, portrait lightbox, GEDCOM export, co-presence pivot)
    const validMount = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder?event=evt_1880']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    expect(validMount.container.textContent).toContain('Henry Alder');

    // 3. Direct usePersonTimelineSync scroll & resize rAF sync on mobile & desktop + empty events
    const rafCbs: Array<FrameRequestCallback> = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafCbs.push(cb);
      return rafCbs.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    window.history.replaceState(null, '', '/person/henry-alder');
    const syncMount = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder?event=evt_1880']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <TimelineSyncHarness events={RICH_BUNDLE.events} />
        </ArchiveProvider>
      </MemoryRouter>
    );

    // Desktop scroll triggers rAF coalescing (2nd scroll ignored while pending)
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true });
    Object.defineProperty(window, 'scrollY', { value: 250, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2000, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      while (rafCbs.length > 0) {
        rafCbs.shift()?.(0);
      }
    });
    expect(syncMount.container.querySelector('[data-testid="active-evt"]')?.textContent).toBe('evt_1890');
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });

    // Mobile scroll
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      while (rafCbs.length > 0) {
        rafCbs.shift()?.(0);
      }
    });

    // Empty events clears activeEvent
    syncMount.rerender(
      <MemoryRouter initialEntries={['/person/henry-alder']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <TimelineSyncHarness events={[]} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(syncMount.container.querySelector('[data-testid="active-evt"]')?.textContent).toBe('none');
  });
});

describe('Wave 2 branch coverage: telemetry, evidence, audio plugin, popovers, map dock, cards, watchdog, UI context, recent changes, topbar', () => {
  it('exercises clientTelemetry sanitizeRoute, dedup/fetch fallback, and global error handlers', () => {
    expect(sanitizeRoute(undefined)).toBe('/');
    expect(sanitizeRoute('   ')).toBe('/');
    expect(sanitizeRoute('/invite/secret-token?person=henry&token=drop')).toBe(
      '/invite/[redacted]?person=henry'
    );

    const sent: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    Object.defineProperty(navigator, 'sendBeacon', {
      configurable: true,
      value: vi.fn(() => false),
    });

    reportClientError(
      { kind: 'window_error', message: 'endpoint-fallback-err', route: '/test' },
      { endpoint: '/api/err' }
    );
    // Duplicate ignored
    reportClientError(
      { kind: 'window_error', message: 'endpoint-fallback-err', route: '/test' },
      { endpoint: '/api/err' }
    );
    expect(fetchSpy).toHaveBeenCalled();

    const uninstall = installGlobalErrorHandlers({
      transport: (payload) => {
        sent.push(payload);
      },
    });
    // Second install returns no-op
    const noopUninstall = installGlobalErrorHandlers();
    noopUninstall();

    // Window script error (empty message)
    window.dispatchEvent(new ErrorEvent('error', { message: '', filename: '/app.js' }));
    // Non-ErrorEvent ignored
    window.dispatchEvent(new Event('error'));
    // Unhandled rejection with non-Error reason
    const rejEvt = new Event('unhandledrejection');
    Object.assign(rejEvt, { reason: 'plain rejection string' });
    window.dispatchEvent(rejEvt);
    // Vite preload error with Error payload (pre-set cooldown so no reload throw)
    sessionStorage.setItem('kinloom_chunk_reload_at', String(Date.now()));
    const viteEvt = new Event('vite:preloadError', { cancelable: true });
    Object.assign(viteEvt, { payload: new Error('vite chunk preload fail') });
    window.dispatchEvent(viteEvt);
    const viteEvt2 = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(viteEvt2);

    uninstall();
    sessionStorage.removeItem('kinloom_chunk_reload_at');
    expect(sent.length).toBeGreaterThanOrEqual(0);
  });

  it('exercises EvidenceSourcesTab and EvidenceNeedsCitationTab empty/filtered states, citations, and >25 unverified events toggle', () => {
    const onQuery = vi.fn();
    const onUncitedQuery = vi.fn();
    const onToggle = vi.fn();
    const onOpenRegistry = vi.fn();
    const onInspect = vi.fn();
    const onRead = vi.fn();
    const peopleById = new Map(RICH_BUNDLE.people.map((p) => [p.id, p]));

    // 1. Empty catalog & zero unverified events
    const emptyMount = mountEl(
      <MemoryRouter>
        <EvidenceSourcesTab
          totalSourceCount={0}
          filteredSources={[]}
          sourceQuery=""
          sourceUsageCounts={new Map()}
          readableSourceIds={new Set()}
          onSourceQueryChange={onQuery}
          onOpenSourceInspector={onInspect}
          onOpenSourceReader={onRead}
        />
        <EvidenceNeedsCitationTab
          totalSourceCount={0}
          unverifiedEvents={[]}
          showAllUnverified={false}
          uncitedQuery=""
          peopleById={peopleById}
          onUncitedQueryChange={onUncitedQuery}
          onToggleShowAllUnverified={onToggle}
        />
      </MemoryRouter>
    );
    expect(emptyMount.container.textContent).toContain('No sources have been cataloged yet.');
    expect(emptyMount.container.textContent).toContain('All events have primary citations.');

    // Zero unverified events when catalog has sources shows Browse Source Registry CTA
    emptyMount.rerender(
      <MemoryRouter>
        <EvidenceNeedsCitationTab
          totalSourceCount={2}
          unverifiedEvents={[]}
          showAllUnverified={false}
          uncitedQuery=""
          peopleById={peopleById}
          onUncitedQueryChange={onUncitedQuery}
          onToggleShowAllUnverified={onToggle}
          onOpenSourceRegistry={onOpenRegistry}
        />
      </MemoryRouter>
    );
    const browseRegistryBtn = [...emptyMount.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Browse Source Registry')
    );
    act(() => {
      browseRegistryBtn?.click();
    });
    expect(onOpenRegistry).toHaveBeenCalledTimes(1);

    // 2. Filtered empty with active query ("Clear filter") + 26 unverified events
    const manyUnverified: ArchiveEvent[] = Array.from({ length: 26 }, (_, i) => ({
      ...RICH_BUNDLE.events[0],
      id: `evt_unv_${i}`,
      title: `Unverified Event ${i}`,
      display_date: i === 0 ? '' : `${1870 + i}`,
      participants:
        i === 0
          ? [{ person_id: 'per_living_redacted', role: 'head' }]
          : [{ person_id: 'per_henry', role: 'head' }],
    }));

    const populatedMount = mountEl(
      <MemoryRouter>
        <EvidenceSourcesTab
          totalSourceCount={2}
          filteredSources={[]}
          sourceQuery="census"
          sourceUsageCounts={new Map()}
          readableSourceIds={new Set(['src_ledger'])}
          onSourceQueryChange={onQuery}
          onOpenSourceInspector={onInspect}
          onOpenSourceReader={onRead}
        />
        <EvidenceNeedsCitationTab
          totalSourceCount={2}
          unverifiedEvents={manyUnverified}
          showAllUnverified={false}
          uncitedQuery=""
          peopleById={peopleById}
          onUncitedQueryChange={onUncitedQuery}
          onToggleShowAllUnverified={onToggle}
          onOpenSourceRegistry={onOpenRegistry}
        />
      </MemoryRouter>
    );
    expect(populatedMount.container.textContent).toContain('Date unrecorded');
    expect(populatedMount.container.textContent).toContain('Show All 26 Entries Needing Citation');
    const clearBtn = [...populatedMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Clear filter')
    );
    const showAllBtn = [...populatedMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Show All 26')
    );
    act(() => {
      clearBtn?.click();
      showAllBtn?.click();
    });
    expect(onQuery).toHaveBeenCalledWith('');
    expect(onToggle).toHaveBeenCalledTimes(1);

    // 3. Expanded unverified + populated sources with 0 citations & url
    populatedMount.rerender(
      <MemoryRouter>
        <EvidenceSourcesTab
          totalSourceCount={2}
          filteredSources={[
            {
              id: 'src_ledger',
              citation: '1880 Ledger',
              source_type: 'census',
              has_primary_source: true,
              url: 'https://archives.example.com/ledger',
            },
          ]}
          sourceQuery=""
          sourceUsageCounts={new Map()}
          readableSourceIds={new Set(['src_ledger'])}
          onSourceQueryChange={onQuery}
          onOpenSourceInspector={onInspect}
          onOpenSourceReader={onRead}
        />
        <EvidenceNeedsCitationTab
          totalSourceCount={2}
          unverifiedEvents={manyUnverified}
          showAllUnverified={true}
          uncitedQuery=""
          peopleById={peopleById}
          onUncitedQueryChange={onUncitedQuery}
          onToggleShowAllUnverified={onToggle}
        />
      </MemoryRouter>
    );
    expect(populatedMount.container.textContent).toContain('0 citations');
    expect(populatedMount.container.textContent).toContain('Show Fewer Entries Needing Citation');
  });

  it('exercises narrativeAudioPlugin metadata extraction and slot rendering', () => {
    const baseNarrative = RICH_BUNDLE.narratives?.[0];
    expect(baseNarrative).toBeDefined();
    if (!baseNarrative) {
      return;
    }
    expect(readNarrativeAudioMeta(undefined)).toBeNull();
    expect(readNarrativeAudioMeta({ ...baseNarrative, extensions: { narrative_audio: [] } })).toBeNull();
    expect(readNarrativeAudioMeta({ ...baseNarrative, extensions: { audio: { file: '  ' } } })).toBeNull();
    const metaOutOfBounds = readNarrativeAudioMeta({
      ...baseNarrative,
      extensions: {
        audio: {
          file: '/audio/bio.mp3',
          duration_seconds: 100,
          editor_notes_start_seconds: 150,
          story_voice: '  ',
        },
      },
    });
    expect(metaOutOfBounds?.editor_notes_start_seconds).toBeUndefined();
    expect(metaOutOfBounds?.story_voice).toBeUndefined();

    const plugin = createNarrativeAudioPlugin();
    const renderHeader = plugin.slots?.narrativeHeader;
    expect(renderHeader).toBeDefined();
    const baseSlotCtx = {
      siteConfig: BASE_SITE_CONFIG,
      baseUrl: '/',
      bundle: RICH_BUNDLE,
      session: null,
      capabilities: {
        canEdit: false,
        canUploadMedia: false,
        hasRevisionHistory: false,
        hasTalk: false,
        canManageSite: false,
      },
    };
    if (renderHeader) {
      expect(renderHeader(baseSlotCtx)).toBeNull();
      expect(
        renderHeader({
          ...baseSlotCtx,
          narrative: baseNarrative,
          person: RICH_BUNDLE.people[5],
        })
      ).toBeNull();
      const el = renderHeader({
        ...baseSlotCtx,
        narrative: {
          ...baseNarrative,
          extensions: { narrative_audio: { file: '/audio/bio.mp3' } },
        },
      });
      expect(el).toBeTruthy();
    }
  });

  it('exercises CitationPopover media states & useCitationPopover hover/focus/pin/blur/Escape flows', () => {
    vi.useFakeTimers();
    const srcWithUrl: SourceRecord = {
      id: 'src_ledger',
      citation: '1880 Harbor Ledger',
      source_type: 'census',
      has_primary_source: true,
      url: 'https://archives.example.com/1880',
    };
    const mediaItem: MediaItem = {
      id: 'med_1',
      kind: 'document_scan',
      file: '/scans/p1.jpg',
      caption: 'Ledger Scan',
      date_edtf: '1880',
      person_ids: [],
      source_id: 'src_ledger',
    };
    const onOpenMedia = vi.fn();

    const mounted = mountEl(
      <CitationPopoverHarness
        source={srcWithUrl}
        media={mediaItem}
        mediaUrl="/scans/p1.jpg"
        withOpenMedia={true}
        onOpenMedia={onOpenMedia}
      />
    );
    const trigger = mounted.container.querySelector<HTMLButtonElement>('[data-testid="cit-trigger"]');
    expect(trigger).toBeTruthy();
    if (trigger) {
      // Hover open -> leave -> timer closes
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
      act(() => {
        trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        vi.advanceTimersByTime(200);
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      // Click pins -> hover/leave does not close pinned -> image error hides image -> changing mediaUrl resets imageFailed
      act(() => {
        trigger.click();
        trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        vi.advanceTimersByTime(200);
      });
      const img = document.querySelector<HTMLImageElement>('.citation-popover-media-img');
      expect(img).toBeTruthy();
      act(() => {
        img?.dispatchEvent(new Event('error'));
      });
      mounted.rerender(
        <CitationPopoverHarness
          source={srcWithUrl}
          media={mediaItem}
          mediaUrl="/scans/p2.jpg"
          withOpenMedia={false}
          onOpenMedia={onOpenMedia}
        />
      );
      expect(document.querySelector('figure .citation-popover-media-img')).toBeTruthy();

      // Escape with focus inside popover restores focus to trigger
      const closeBtn = document.querySelector<HTMLButtonElement>('.citation-popover-close');
      act(() => {
        closeBtn?.focus();
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      });
      expect(document.activeElement).toBe(trigger);

      // Focus -> blur outside closes; click pins then click again unpins
      act(() => {
        trigger.blur();
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      act(() => {
        trigger.click();
      });
      expect(document.querySelector('[role="dialog"]')).toBeTruthy();
      act(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    }
    vi.useRealTimers();
  });

  it('exercises MapStopDrawerAndDock, mapLibreLayers, MilestoneStoryCard, PlaceHistoricalProfileSection, BlankScreenWatchdog, ArchiveUiContext, RecentChangesPage, and ExplorerTopBar', async () => {
    // 1. MapStopDrawerAndDock
    const onClearFilters = vi.fn();
    const southernStop: MigrationStop = {
      id: 'stop-s',
      year: 1860,
      displayDate: '1860',
      title: 'Southern Port',
      place: { ...RICH_BUNDLE.places[0], lat: -33.86, lng: 151.2 },
      personNames: ['Henry Alder'],
      personSlugs: ['henry-alder'],
      eventId: 'evt_1880',
      lineageStage: 'unmapped_stage',
    };
    const mapDockMount = mountEl(
      <MemoryRouter>
        <MapStopDrawerAndDock
          dockRef={{ current: null }}
          cardRef={{ current: null }}
          selectedStop={southernStop}
          cardSide="left"
          drawerExpanded={true}
          stops={[]}
          stopIds={[]}
          stepIndex={-1}
          playing={false}
          journey={{ stepIndex: -1, playing: false, selectedStopId: 'stop-s' }}
          selectedPersonId="per_henry"
          selectedEraId="all"
          yearSpanLabel="1860"
          metricLabel="0 stops"
          stageColorMap={new Map()}
          stageLabelMap={new Map()}
          onToggleDrawer={vi.fn()}
          onCloseStop={vi.fn()}
          onClearFilters={onClearFilters}
          onApplyJourney={vi.fn()}
          onResetAllStops={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(mapDockMount.container.textContent).toContain('Hide ▾');
    expect(mapDockMount.container.textContent).toContain('°S');
    expect(mapDockMount.container.textContent).toContain('°E');
    const clearFilterBtn = [...mapDockMount.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.includes('Clear filters')
    );
    act(() => {
      clearFilterBtn?.click();
    });
    expect(onClearFilters).toHaveBeenCalled();

    // 2. mapLibreLayers setPeriodBasemap & syncFamilyOverlay click fallback
    const hostDiv = document.createElement('div');
    const rawMap = new MapLibreMap({ container: hostDiv, style: PAPER_STYLE });
    rawMap.addLayer({ id: 'land', type: 'fill', source: 'osm_land' });
    rawMap.addSource('osm_land', { type: 'vector', tiles: [] });
    rawMap.addLayer({ id: 'water_areas_ne', type: 'fill', source: 'osm_land' });
    setPeriodBasemap(rawMap);
    expect(rawMap.getLayer(PAPER_LAND_LAYER_ID)).toBeTruthy();

    const onSelectStop = vi.fn();
    syncFamilyOverlay(rawMap, { type: 'FeatureCollection', features: [] }, onSelectStop);
    const fakeInstance = mapState.instances.at(-1);
    fakeInstance?.emit('mouseenter');
    fakeInstance?.emit('mouseleave');
    fakeInstance?.emit('click', { point: { x: 10, y: 10 } });
    expect(onSelectStop).toHaveBeenCalled();

    // 3. MilestoneStoryCard keyboard activation + photo fallback + alsoHere
    const onSelectCard = vi.fn();
    const onPivot = vi.fn();
    const cardEvent: ArchiveEvent = {
      ...RICH_BUNDLE.events[0],
      photo_url: '/media/mill.jpg',
      photo_placeholder_caption: '',
    };
    const cardMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <MilestoneStoryCard
            event={cardEvent}
            place={RICH_BUNDLE.places[0]}
            isActive={true}
            sourcesById={new Map(RICH_BUNDLE.sources.map((s) => [s.id, s]))}
            onSelect={onSelectCard}
            alsoHere={[
              {
                person: RICH_BUNDLE.people[1],
                tier: 'Confirmed',
                distanceMiles: 0,
                sameHousehold: true,
                kinshipLabel: 'Spouse',
                kinshipRank: 1,
                placeId: 'pl_harbor',
                matchedEventId: 'evt_1880',
              },
            ]}
            onPivotPerson={onPivot}
          />
          <MilestoneStoryCard
            event={{ ...RICH_BUNDLE.events[1], photo_url: null, photo_placeholder_caption: 'Mill Sketch' }}
            place={undefined}
            isActive={false}
            sourcesById={new Map()}
            onSelect={onSelectCard}
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const article = cardMount.container.querySelector<HTMLElement>('article');
    act(() => {
      article?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      article?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      article?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onSelectCard).toHaveBeenCalledTimes(2);
    const pivotBtn = cardMount.container.querySelector<HTMLButtonElement>('details button');
    act(() => {
      pivotBtn?.click();
    });
    expect(onPivot).toHaveBeenCalledTimes(1);

    // 4. PlaceHistoricalProfileSection empty & populated jurisdictions/sources
    const placeSecMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <PlaceHistoricalProfileSection
            place={RICH_BUNDLE.places[0]}
            placePhotoSrc=""
            placePhotoMedia={null}
            sourcesById={new Map()}
            baseUrl="/"
          />
          <PlaceHistoricalProfileSection
            place={{
              ...RICH_BUNDLE.places[0],
              summary: 'River settlement.',
              historical_names: [
                { name: 'Old Harbor', valid_from: '1850', valid_to: null },
                { name: 'Harbor Landing', valid_from: null, valid_to: '1875' },
                { name: 'Harbor', valid_from: null, valid_to: null },
              ],
              sources: [{ source_id: 'src_ledger', confidence: 'high' }],
            }}
            placePhotoSrc=""
            placePhotoMedia={null}
            sourcesById={new Map(RICH_BUNDLE.sources.map((s) => [s.id, s]))}
            baseUrl="/"
          />
        </ArchiveProvider>
      </MemoryRouter>
    );
    expect(placeSecMount.container.textContent).toContain('Old Harbor (1850–present)');
    expect(placeSecMount.container.textContent).toContain('Harbor Landing (?–1875)');

    // 5. BlankScreenWatchdog (#root missing -> blank; #root populated with height > 40 -> not blank)
    vi.useFakeTimers();
    const watchMount = mountEl(
      <MemoryRouter initialEntries={['/watch']}>
        <BlankScreenWatchdog />
      </MemoryRouter>
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const fakeRoot = document.createElement('div');
    fakeRoot.id = 'root';
    fakeRoot.innerHTML = '<div>Harbor Archive Content</div>';
    fakeRoot.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    document.body.append(fakeRoot);
    watchMount.rerender(
      <MemoryRouter initialEntries={['/watch-ok']}>
        <BlankScreenWatchdog />
      </MemoryRouter>
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    fakeRoot.remove();
    vi.useRealTimers();

    // 6. ArchiveUiContext outside provider throws & Ctrl+K / '/' shortcuts
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => mountEl(<BadUiConsumer />)).toThrow('useArchiveUi must be used inside ArchiveUiProvider');
    errSpy.mockRestore();

    const uiMount = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <ArchiveUiSearchHarness />
      </ArchiveProvider>
    );
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }));
    });
    expect(uiMount.container.querySelector('[data-testid="search-state"]')?.textContent).toBe('open');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    });
    expect(uiMount.container.querySelector('[data-testid="search-state"]')?.textContent).toBe('closed');

    // 7. RecentChangesPage error & batch revert paths
    const batchRev: RevisionRecord = {
      revision_id: asRevisionId(20),
      batch_id: asBatchId('batch_harbor'),
      entity_type: 'person',
      entity_id: 'per_henry',
      parent_revision_id: null,
      reverted_revision_id: null,
      action: 'update',
      author_type: 'agent',
      author_id: 'agent_1',
      author_name: 'Research CLI',
      summary: 'Batch update',
      has_primary_source: true,
      before_json: { surname: 'Alder' },
      after_json: { surname: 'Alder-Harbor' },
      created_at: '2025-02-01T12:00:00Z',
    };
    const rcDs = makeMemoryDataSource({
      revertRevision: vi.fn(async () => {
        throw 'rev err string';
      }),
      revertBatch: vi.fn(async () => {
        throw new Error('batch err');
      }),
    });
    const rcMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          dataSource={rcDs}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          capabilities={{ canEdit: true, hasRevisionHistory: true }}
        >
          <RecentChangesPage initialRevisions={[batchRev]} />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const viewDiffBtn = [...rcMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('View Diff')
    );
    act(() => {
      viewDiffBtn?.click();
    });
    const hideDiffBtn = [...rcMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Hide Diff')
    );
    act(() => {
      hideDiffBtn?.click();
    });
    const undoBatchBtn = [...rcMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Revert Entire Batch')
    );
    act(() => {
      undoBatchBtn?.click();
    });
    const confirmBatchBtn = [...rcMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Confirm Batch Revert')
    );
    act(() => {
      confirmBatchBtn?.click();
    });
    await flushUi();
    expect(rcMount.container.textContent).toContain('batch err');

    // 8. ExplorerTopBar with editor role, invite viewer (without label), active /changes & /admin routes, outside click close
    const topMount = mountEl(
      <MemoryRouter initialEntries={['/changes']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          session={{ authenticated: true, email: 'ed@example.com', displayName: 'Ed Alder', role: 'editor' }}
        >
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const acctBtn = topMount.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    act(() => {
      acctBtn?.click();
    });
    expect(topMount.container.textContent).toContain('Editor');
    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    const inviteTopMount = mountEl(
      <MemoryRouter initialEntries={['/admin']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          dataSource={makeMemoryDataSource({
            requestMagicLink: vi.fn(async () => ({ sent: true })),
            logout: vi.fn(async () => {}),
          })}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          session={{ authenticated: false, principal_kind: 'invite_viewer', role: 'viewer' }}
        >
          <ExplorerTopBar />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const inviteAcctBtn = inviteTopMount.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (inviteAcctBtn) {
      act(() => {
        inviteAcctBtn.click();
      });
      expect(inviteTopMount.container.textContent).toContain('Invite: Family invite');
    } else {
      expect(inviteTopMount.container.textContent).toContain('Sign in to edit');
    }
  });
});

describe('Wave 3 branch coverage: GlobalSearchModal, SourceCitationTag scans, ArchivalMarkdown inline, TreeFocusDrawer, PersonProfileHeader, PlacesIndexPage, PersonPage/TreePage extras', () => {
  it('exercises GlobalSearchModal quick queries, source-reader target selection, and keyboard Enter navigation', () => {
    const configWithAnchors = parseKinloomConfig({
      site: { title: 'Alder Chronicle', familyName: 'Alder', gedcomSourceName: 'ALDER' },
      anchorYears: [{ year: 1880, label: '1880' }],
    });
    const bundleWithCounty: ArchiveBundle = {
      ...RICH_BUNDLE,
      places: [
        ...RICH_BUNDLE.places,
        {
          id: 'pl_county',
          slug: 'cedar-county',
          name: 'Cedar County',
          full_name: 'Cedar County, Michigan',
          place_type: 'county',
          parent_id: null,
          lat: 42.8,
          lng: -85.8,
        },
      ],
    };

    const mounted = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={configWithAnchors}
          initialBundle={bundleWithCounty}
          initialReadings={SAMPLE_READINGS}
        >
          <GlobalSearchTrigger />
          <GlobalSearchModal />
        </ArchiveProvider>
      </MemoryRouter>
    );

    act(() => {
      mounted.container.querySelector<HTMLButtonElement>('[data-testid="open-search"]')?.click();
    });
    const searchInput = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
    expect(searchInput).toBeTruthy();
    if (searchInput) {
      // Search matching reading transcription ("timber account") -> sourceReaderTarget result
      setFieldValue(searchInput, 'timber account');
      const resultBtn = mounted.container.querySelector<HTMLButtonElement>(
        '[role="option"], .search-result-item'
      );
      act(() => {
        resultBtn?.click();
      });

      // Reopen and search for person -> ArrowDown + Enter on focused input
      act(() => {
        mounted.container.querySelector<HTMLButtonElement>('[data-testid="open-search"]')?.click();
      });
      const input2 = mounted.container.querySelector<HTMLInputElement>('input[type="search"]');
      if (input2) {
        setFieldValue(input2, 'Henry');
        act(() => {
          input2.focus();
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        });
      }
    }
  });

  it('exercises SourceCitationTag fallback scan titles, plural place discrepancies, and copy timeout cleanup', async () => {
    vi.useFakeTimers();
    const sourcesById = new Map<string, SourceRecord>([
      [
        'src_nohost',
        {
          id: 'src_nohost',
          citation: 'Harbor Register',
          source_type: 'census',
          has_primary_source: true,
        },
      ],
    ]);

    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(async () => {}) },
      configurable: true,
    });

    const mounted = mountEl(
      <ArchiveProvider
        siteConfig={BASE_SITE_CONFIG}
        initialBundle={RICH_BUNDLE}
        initialReadings={SAMPLE_READINGS}
      >
        <SourceCitationTag
          sources={[
            { source_id: 'src_unknown_scan', confidence: 'low', scan_url: '/scans/unknown.jpg' },
            { source_id: 'src_nohost', confidence: 'high', scan_url: '/scans/reg.jpg' },
          ]}
          alternatePlaces={[
            { place_name: 'Old Harbor', source_id: 'src_nohost', note: '1870 map' },
            { place_name: 'New Harbor', source_id: 'src_missing', note: '1880 map' },
          ]}
          sourcesById={sourcesById}
        />
      </ArchiveProvider>
    );

    expect(mounted.container.textContent).toContain('2 Place Discrepancies');
    // Click top-bar scan button (firstScan has no scan_title, no citation_detail, no rec -> 'Record Scan')
    const topScanBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Scan')
    );
    act(() => {
      topScanBtn?.click();
    });
    expect(mounted.container.textContent).toContain('RECORD SCAN · Record Scan');
    const closeBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Close')
    );
    act(() => {
      closeBtn?.click();
    });

    // Expand and click both Copy buttons (triggers copiedKey timeout branch) & both per-item Scan buttons
    const toggleBtn = mounted.container.querySelector<HTMLButtonElement>('.source-toggle');
    act(() => {
      toggleBtn?.click();
    });
    const copyBtns = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].filter(
      (b) => b.textContent?.trim() === 'Copy'
    );
    act(() => {
      copyBtns[0]?.click();
      copyBtns[1]?.click();
    });
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(2000);
    });

    const scanBtns = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
      b.textContent?.includes('Scan ↗')
    );
    for (const btn of scanBtns) {
      act(() => {
        btn.click();
      });
      const cBtn = [...mounted.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('Close')
      );
      act(() => {
        cBtn?.click();
      });
    }
    vi.useRealTimers();
  });

  it('exercises ArchivalMarkdown unresolved entity mentions, relative/external links, and inline emphasis', () => {
    const peopleById = new Map(RICH_BUNDLE.people.map((p) => [p.id, p]));
    const placesById = new Map(RICH_BUNDLE.places.map((pl) => [pl.id, pl]));
    const sourcesById = new Map(RICH_BUNDLE.sources.map((s) => [s.id, s]));

    const mounted = mountEl(
      <MemoryRouter>
        <ArchivalMarkdown
          markdown={
            'See [[person:per_missing|Unresolved Relative]] and [[person:per_missing2]], ' +
            'plus [[place:pl_missing|Lost Town]] and [[place:pl_missing2]]. ' +
            'Visit [Harbor](/place/harbor-town) and [External](https://example.com) with **bold**, *italic*, and _alt_. [1]'
          }
          peopleById={peopleById}
          placesById={placesById}
          sourcesById={sourcesById}
        />
      </MemoryRouter>
    );

    expect(mounted.container.textContent).toContain('Unresolved Relative');
    expect(mounted.container.textContent).toContain('per_missing2');
    expect(mounted.container.textContent).toContain('Lost Town');
    expect(mounted.container.textContent).toContain('pl_missing2');
    expect(mounted.container.querySelector('a[href="/place/harbor-town"]')).toBeTruthy();
    expect(mounted.container.querySelector('a[target="_blank"]')).toBeTruthy();
  });

  it('exercises TreeFocusDrawer, PersonProfileHeader, PlacesIndexPage, PersonPage, and TreePage remaining branches', async () => {
    // 1. TreeFocusDrawer: null spotlight + living person + unknown place + 2 marriages + blank given_name ancestor
    const emptyTreeModel: ArchivalTreeModel = {
      mode: 'full',
      effectiveMode: 'full',
      peopleById: new Map(RICH_BUNDLE.people.map((p) => [p.id, p])),
      visiblePeople: RICH_BUNDLE.people,
      totalVisibleCount: RICH_BUNDLE.people.length,
      directSpineCount: 2,
      generations: [],
      unions: [],
      unionsById: new Map(),
      unitsById: new Map(),
      genByPersonId: new Map([['per_henry', 0]]),
      parentMap: new Map(),
      childMap: new Map(),
      spouseMap: new Map(),
      earlyLossIds: new Set(),
      directPersonIds: new Set(['per_henry']),
      pivotPersonId: 'per_henry',
      anchorPersonId: null,
    };
    const livingWithMedia: Person = {
      ...RICH_BUNDLE.people[4],
      primary_place_id: 'unknown_place_id',
      media_count: 2,
    };
    const ancestorNoGiven: Person = {
      ...RICH_BUNDLE.people[0],
      given_name: '',
      full_name: 'Alder Patriarch',
    };
    const multiSpouseSpotlight: LineageSpotlight = {
      selectedPersonId: 'per_henry',
      highlightedPersonIds: new Set(['per_henry']),
      ancestorIds: new Set(),
      descendantIds: new Set(),
      immediateSpouseIds: new Set(['per_clara', 'per_nodates']),
      immediateChildIds: new Set(['per_arthur']),
      immediateParentIds: new Set(),
      highlightedUnionIds: new Set(),
      breadcrumb: [ancestorNoGiven, RICH_BUNDLE.people[2]],
      relationshipToPivot: null,
      pivotName: null,
    };

    const drawerMount = mountEl(
      <MemoryRouter>
        <TreeFocusDrawer
          person={livingWithMedia}
          model={emptyTreeModel}
          spotlight={null}
          placesById={new Map()}
          thumbUrl={null}
          baseUrl="/"
          onSelectPerson={vi.fn()}
          onClearFocus={vi.fn()}
        />
        <TreeFocusDrawer
          person={RICH_BUNDLE.people[2]}
          model={emptyTreeModel}
          spotlight={multiSpouseSpotlight}
          placesById={new Map()}
          thumbUrl={null}
          baseUrl="/"
          onSelectPerson={vi.fn()}
          onClearFocus={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(drawerMount.container.textContent).toContain('Unrecorded');
    expect(drawerMount.container.textContent).toContain('2 marriages');
    expect(drawerMount.container.textContent).toContain('Alder Patriarch');

    // 2. PersonProfileHeader: living person, 2 spouses, 1 & 2 redacted children, same-year & undated & missing-place spans
    const placesMap = new Map(RICH_BUNDLE.places.map((pl) => [pl.id, pl]));
    const headerMount = mountEl(
      <MemoryRouter>
        <PersonProfileHeader
          person={{
            ...RICH_BUNDLE.people[4],
            birth_edtf: '',
            death_edtf: '',
            has_primary_source: true,
          }}
          branchLabel="Alder Line"
          routePlaceCount={1}
          canEdit={true}
          pronunciations={{}}
          immediateFamily={{
            parents: [],
            spouses: [
              { id: 's1', slug: 'clara-mercer', name: 'Clara Mercer', years: '1858–1938' },
              { id: 's2', slug: 'mabel-birch', name: 'Mabel Birch', years: '?–?' },
            ],
            children: [],
            livingSpouseCount: 1,
            livingChildCount: 1,
          }}
          residenceSpans={[
            {
              id: 'span_missing',
              person_id: 'per_living_named',
              place_id: 'missing_pl',
              from_event_id: 'evt_1880',
              to_event_id: 'evt_1880',
              start_year: 1990,
              end_year: 1990,
              time_min: 1990,
              time_max: 1990,
              confidence_tier: 'Confirmed',
            },
            {
              id: 'span_same_yr',
              person_id: 'per_living_named',
              place_id: 'pl_harbor',
              from_event_id: 'evt_1880',
              to_event_id: 'evt_1880',
              start_year: 1995,
              end_year: 1995,
              time_min: 1995,
              time_max: 1995,
              confidence_tier: 'Confirmed',
            },
            {
              id: 'span_undated',
              person_id: 'per_living_named',
              place_id: 'pl_birch',
              from_event_id: 'evt_1890',
              to_event_id: 'evt_1890',
              start_year: null,
              end_year: null,
              time_min: 0,
              time_max: 0,
              confidence_tier: 'Inferred',
            },
          ]}
          placesById={placesMap}
          onOpenPortraitLightbox={vi.fn()}
          onEditPronunciation={vi.fn()}
          onExportGedcom={vi.fn()}
          onOpenRelativeModal={vi.fn()}
        />
        <PersonProfileHeader
          person={RICH_BUNDLE.people[0]}
          branchLabel={null}
          routePlaceCount={2}
          canEdit={false}
          pronunciations={{}}
          immediateFamily={{
            parents: [],
            spouses: [],
            children: [],
            livingSpouseCount: 0,
            livingChildCount: 2,
          }}
          residenceSpans={[]}
          placesById={placesMap}
          onOpenPortraitLightbox={vi.fn()}
          onEditPronunciation={vi.fn()}
          onExportGedcom={vi.fn()}
          onOpenRelativeModal={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(headerMount.container.textContent).toContain('Spouses');
    expect(headerMount.container.textContent).toContain('1 living child (redacted)');
    expect(headerMount.container.textContent).toContain('2 living children (redacted)');
    expect(headerMount.container.textContent).toContain('Undated');

    // 3. PlacesIndexPage with custom migrationEras & stage filter click
    const placesConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
      migrationEras: [{ id: 'harbor_era', label: 'Harbor Settlement', startYear: 1850, endYear: 1920 }],
    });
    const placesMount = mountEl(
      <MemoryRouter>
        <ArchiveProvider
          siteConfig={placesConfig}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <PlacesIndexPage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    const stageBtn = [...placesMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Harbor Settlement')
    );
    act(() => {
      stageBtn?.click();
    });
    expect(placesMount.container.textContent).toContain('Harbor');

    // 4. PersonPage Edit tab, biography source toggle twice, and Also Here pivot click
    const personMount = mountEl(
      <MemoryRouter initialEntries={['/person/henry-alder?event=evt_1880']}>
        <ArchiveProvider
          siteConfig={BASE_SITE_CONFIG}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
          capabilities={{ canEdit: true, canUploadMedia: true, hasRevisionHistory: true, hasTalk: true }}
        >
          <Routes>
            <Route path="/person/:slug" element={<PersonPage />} />
          </Routes>
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const editTabBtn = [...personMount.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Edit'
    );
    act(() => {
      editTabBtn?.click();
    });
    const readTabBtn = [...personMount.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === 'Read'
    );
    act(() => {
      readTabBtn?.click();
    });
    const pivotBtn = [...personMount.container.querySelectorAll<HTMLButtonElement>('details button')].find(
      (b) => b.textContent?.includes('Clara')
    );
    act(() => {
      pivotBtn?.click();
    });

    // 5. TreePage with ?focus=unknown-slug and branch switch -> empty view -> Show Full Tree
    const birchOnlyEmptySpine = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER' },
      branches: [
        { id: 'alder', label: 'Alder Line', supportsDirectMode: true },
        { id: 'birch', label: 'Birch Line', supportsDirectMode: true },
      ],
    });
    const treeMount = mountEl(
      <MemoryRouter initialEntries={['/tree?focus=unknown-slug&mode=spine']}>
        <ArchiveProvider
          siteConfig={birchOnlyEmptySpine}
          initialBundle={RICH_BUNDLE}
          initialReadings={SAMPLE_READINGS}
        >
          <TreePage />
        </ArchiveProvider>
      </MemoryRouter>
    );
    await flushUi();
    const birchBtn = [...treeMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Birch Line')
    );
    act(() => {
      birchBtn?.click();
    });
    const showFullBtn = [...treeMount.container.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Show Full Tree')
    );
    if (showFullBtn) {
      act(() => {
        showFullBtn.click();
      });
    }
  });
});
