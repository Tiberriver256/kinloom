// @vitest-environment jsdom
import type {
  ArchiveBundle,
  ArchiveSearchResult,
  KinloomSiteConfig,
  Person,
  ReadingsBundle,
} from '@kinloom/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordRecentlyViewed } from '../browser/recentlyViewed.js';
import { ArchiveDataProvider } from '../context/ArchiveDataContext.js';
import { ArchiveUiProvider, useArchiveUi } from '../context/ArchiveUiContext.js';
import { buildSearchPreviewSlip, findPreviewShortcutAction } from '../lib/searchPreview.js';
import { GlobalSearchModal } from './GlobalSearchModal.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEST_SITE_CONFIG: KinloomSiteConfig = {
  schemaVersion: 1,
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder',
    gedcomSourceName: 'Alder Family Archive',
    description: 'Synthetic test archive',
    footerCredit: 'Alder Archive',
  },
  anchorYears: [{ year: 1860, label: '1860 Homestead' }],
  branches: [],
  lineageSections: [],
  featuredKinshipPairs: [],
  migrationEras: [],
  mapDefaults: { centerLat: 42.96, centerLng: -85.67, zoom: 6, minSpanDeg: 1 },
  privacy: {
    livingCutoffYears: 110,
    privateModeShowsBirthYear: true,
    stripLivingPortraits: true,
    stripLivingResidenceSpans: true,
    markGedcomLivingConfidential: true,
  },
};

function makeBundle(): ArchiveBundle {
  return {
    meta: {
      build_mode: 'public',
      generated_at: '2026-01-01T00:00:00Z',
      counts: {
        people: 2,
        living_redacted: 0,
        places: 1,
        events: 1,
        residence_spans: 0,
        sources: 1,
      },
    },
    people: [
      {
        id: 'per_thomas_alder',
        slug: 'thomas-alder',
        full_name: 'Thomas Alder',
        given_name: 'Thomas',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1835',
        death_edtf: '1902',
        birth_year: 1835,
        death_year: 1902,
        primary_place_id: 'plc_mercer_town',
        event_count: 3,
        portrait_url: '/media/thomas-alder.jpg',
        has_primary_source: true,
      },
      {
        id: 'per_clara_mercer',
        slug: 'clara-mercer',
        full_name: 'Clara Mercer',
        given_name: 'Clara',
        surname: 'Mercer',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'extended',
        birth_edtf: '1840',
        death_edtf: '1918',
        birth_year: 1840,
        death_year: 1918,
        primary_place_id: 'plc_mercer_town',
        event_count: 1,
        portrait_url: null,
        has_primary_source: false,
      },
    ],
    places: [
      {
        id: 'plc_mercer_town',
        slug: 'mercer-town',
        name: 'Mercer Town',
        full_name: 'Mercer Town, Kent County, Michigan',
        place_type: 'town',
        parent_id: null,
        lat: 42.96,
        lng: -85.67,
      },
    ],
    place_ancestors: { plc_mercer_town: [] },
    events: [
      {
        id: 'evt_alder_homestead',
        event_kind: 'point_event',
        scope: 'family',
        title: 'Alder Homestead Deed',
        summary: 'Thomas Alder and Clara Mercer recorded the farm deed in Mercer Town.',
        edtf_date: '1860-05-12',
        display_date: '12 May 1860',
        year: 1860,
        time_min: 1860,
        time_max: 1860,
        place_id: 'plc_mercer_town',
        participants: [
          { person_id: 'per_thomas_alder', role: 'primary' },
          { person_id: 'per_clara_mercer', role: 'spouse' },
        ],
        sources: [{ source_id: 'src_deed_book', confidence: 'high' }],
        severity_rank: 5,
      },
    ],
    residence_spans: [],
    kinship: [],
    sources: [
      {
        id: 'src_deed_book',
        citation: 'Kent County Deed Book, Vol. 2',
        source_type: 'land_deed',
        has_primary_source: true,
      },
    ],
    media: [
      {
        id: 'med_thomas_portrait',
        kind: 'portrait',
        person_id: 'per_thomas_alder',
        file: '/media/thomas-alder.jpg',
        caption: 'Studio portrait of Thomas Alder',
      },
    ],
  };
}

function makeReadings(): ReadingsBundle {
  return {
    version: 1,
    documents: {
      src_deed_book: {
        source_id: 'src_deed_book',
        title: 'Kent County Deed Book',
        author: 'Kent County Clerk',
        provenance: 'Kent County Archives',
        pages: [
          {
            page: 4,
            label: 'Page 4',
            file: 'page-4.txt',
            text: 'On 12 May 1860 Thomas Alder acquired the parcel in Mercer Town.',
          },
        ],
      },
    },
    event_page_map: {
      evt_alder_homestead: { src_deed_book: 4 },
    },
  };
}

const LocationReadout: React.FC = () => {
  const loc = useLocation();
  const { sourceReader } = useArchiveUi();
  return (
    <div>
      <output data-testid="current-location">{`${loc.pathname}${loc.search}`}</output>
      <output data-testid="active-reader">
        {sourceReader ? `${sourceReader.sourceId}:${sourceReader.page ?? ''}` : ''}
      </output>
    </div>
  );
};

describe('buildSearchPreviewSlip & findPreviewShortcutAction', () => {
  const bundle = makeBundle();
  const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
  const placesById = new Map(bundle.places.map((pl) => [pl.id, pl]));
  const eventsById = new Map(bundle.events.map((ev) => [ev.id, ev]));

  it('builds a full person preview slip with lifespan, primary place, citations/media summary, and 1-key jumps', () => {
    const item: ArchiveSearchResult = {
      id: 'person:per_thomas_alder',
      kind: 'person',
      title: 'Thomas Alder',
      subtitle: '1835–1902 · Mercer Town, Kent County, Michigan',
      score: 120,
      route: '/person/thomas-alder',
    };
    const slip = buildSearchPreviewSlip({ item, bundle, peopleById, placesById, eventsById });
    expect(slip).not.toBeNull();
    expect(slip?.lifespan).toBe('1835–1902');
    expect(slip?.primaryPlace).toBe('Mercer Town, Kent County, Michigan');
    expect(slip?.portraitUrl).toBe('/media/thomas-alder.jpg');
    expect(slip?.summaryLines.join(' ')).toContain('3 events');
    expect(slip?.summaryLines.join(' ')).toContain('1 cited source');
    expect(slip?.summaryLines.join(' ')).toContain('1 archival media item');
    expect(slip?.actions.map((a) => `${a.key}:${a.route}`)).toEqual([
      'Enter:/person/thomas-alder',
      'T:/tree?focus=thomas-alder',
      'M:/map?person=thomas-alder',
      'K:/kinship?from=thomas-alder',
    ]);
    expect(findPreviewShortcutAction(slip, 't')?.route).toBe('/tree?focus=thomas-alder');
    expect(findPreviewShortcutAction(slip, 'M')?.route).toBe('/map?person=thomas-alder');
    expect(findPreviewShortcutAction(slip, 'k')?.route).toBe('/kinship?from=thomas-alder');
    expect(findPreviewShortcutAction(slip, 'x')).toBeUndefined();
  });

  it('builds preview slips for place, event, reading, and fallback/undefined results', () => {
    expect(
      buildSearchPreviewSlip({ item: undefined, bundle, peopleById, placesById, eventsById })
    ).toBeNull();
    expect(findPreviewShortcutAction(null, 'T')).toBeUndefined();

    const placeSlip = buildSearchPreviewSlip({
      item: {
        id: 'place:plc_mercer_town',
        kind: 'place',
        title: 'Mercer Town, Kent County, Michigan',
        subtitle: 'TOWN',
        score: 100,
        route: '/place/mercer-town',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(placeSlip?.eyebrow).toBe('TOWN');
    expect(placeSlip?.actions.map((a) => a.key)).toEqual(['Enter', 'M']);

    const eventSlip = buildSearchPreviewSlip({
      item: {
        id: 'event:evt_alder_homestead',
        kind: 'event',
        title: 'Alder Homestead Deed',
        subtitle: '12 May 1860',
        snippet: 'Recorded the farm deed',
        score: 90,
        route: '/person/thomas-alder?event=evt_alder_homestead',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(eventSlip?.primaryPlace).toBe('Mercer Town, Kent County, Michigan');
    expect(eventSlip?.actions.map((a) => a.key)).toEqual(['Enter', 'T', 'M', 'K']);

    const readingSlip = buildSearchPreviewSlip({
      item: {
        id: 'reading:src_deed_book:4',
        kind: 'reading',
        title: 'Kent County Deed Book',
        subtitle: 'Page 4',
        snippet: 'Thomas Alder acquired the parcel',
        score: 80,
        sourceReaderTarget: { sourceId: 'src_deed_book', page: 4, query: 'Alder' },
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(readingSlip?.eyebrow).toBe('Primary Source');
    expect(readingSlip?.actions[0]?.sourceReaderTarget?.sourceId).toBe('src_deed_book');

    // Missing entity fallbacks
    const missingPerson = buildSearchPreviewSlip({
      item: {
        id: 'person:unknown',
        kind: 'person',
        title: 'Unknown Person',
        subtitle: '?–?',
        score: 50,
        route: '/person/unknown',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(missingPerson?.actions).toHaveLength(1);

    const missingPlace = buildSearchPreviewSlip({
      item: {
        id: 'place:unknown',
        kind: 'place',
        title: 'Unknown Place',
        subtitle: 'TOWN',
        score: 50,
        route: '/place/unknown',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(missingPlace?.actions).toHaveLength(1);

    const missingEvent = buildSearchPreviewSlip({
      item: {
        id: 'event:unknown',
        kind: 'event',
        title: 'Unknown Event',
        subtitle: '1860',
        score: 50,
        route: '/',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(missingEvent?.actions).toHaveLength(1);

    // Person with no media linked
    const claraSlip = buildSearchPreviewSlip({
      item: {
        id: 'person:per_clara_mercer',
        kind: 'person',
        title: 'Clara Mercer',
        subtitle: '1840–1918',
        score: 90,
        route: '/person/clara-mercer',
      },
      bundle,
      peopleById,
      placesById,
      eventsById,
    });
    expect(claraSlip?.summaryLines.join(' ')).toContain('No archival media linked yet');
  });

  it('covers edge-case branches in buildSearchPreviewSlip (living/unknown years, portrait-only, E longitude, null bundle, unprefixed IDs)', () => {
    const livingPerson = {
      ...bundle.people[0]!,
      id: 'per_living_hale',
      slug: 'sam-hale',
      full_name: 'Sam Hale',
      is_living: true,
      birth_year: null,
      death_year: null,
      primary_place_id: null,
      portrait_url: '/media/sam.jpg',
    };
    const unknownPerson = {
      ...bundle.people[1]!,
      id: 'per_unknown_dates',
      slug: 'pat-bramwell',
      full_name: 'Pat Bramwell',
      is_living: false,
      birth_year: null,
      death_year: null,
      primary_place_id: null,
      portrait_url: null,
    };
    const eastPlace = {
      ...bundle.places[0]!,
      id: 'plc_east_harbor',
      slug: 'east-harbor',
      lng: 12.34,
    };
    const minimalEvent = {
      ...bundle.events[0]!,
      id: 'evt_minimal',
      place_id: null,
      summary: '',
      participants: [{ person_id: 'per_redacted_living', role: 'primary' }],
    };
    const redactedLiving = {
      ...livingPerson,
      id: 'per_redacted_living',
      full_name: 'Living',
    };
    const edgePeople = new Map<string, Person>([
      [livingPerson.id, livingPerson],
      [unknownPerson.id, unknownPerson],
      [redactedLiving.id, redactedLiving],
    ]);
    const edgePlaces = new Map([[eastPlace.id, eastPlace]]);
    const edgeEvents = new Map([[minimalEvent.id, minimalEvent]]);
    const mediaOnlyByPersonIds = {
      ...bundle,
      media: [
        {
          id: 'med_group',
          kind: 'family_photo' as const,
          person_ids: [unknownPerson.id],
          file: '/media/group.jpg',
          caption: 'Group photo',
        },
      ],
    };

    const livingSlip = buildSearchPreviewSlip({
      item: { id: 'per_living_hale', kind: 'person', title: 'Sam Hale', subtitle: '', score: 50 },
      bundle: null,
      peopleById: edgePeople,
      placesById: edgePlaces,
      eventsById: edgeEvents,
    });
    expect(livingSlip?.lifespan).toBe('?–Living');
    expect(livingSlip?.summaryLines.join(' ')).toContain('Archival portrait on file');

    const unknownSlip = buildSearchPreviewSlip({
      item: {
        id: 'person:per_unknown_dates',
        kind: 'person',
        title: 'Pat Bramwell',
        subtitle: '',
        score: 50,
      },
      bundle: mediaOnlyByPersonIds,
      peopleById: edgePeople,
      placesById: edgePlaces,
      eventsById: edgeEvents,
    });
    expect(unknownSlip?.lifespan).toBe('?–?');
    expect(unknownSlip?.summaryLines.join(' ')).toContain('1 archival media item');

    const eastPlaceSlip = buildSearchPreviewSlip({
      item: { id: 'plc_east_harbor', kind: 'place', title: 'East Harbor', subtitle: '', score: 50 },
      bundle: null,
      peopleById: edgePeople,
      placesById: edgePlaces,
      eventsById: edgeEvents,
    });
    expect(eastPlaceSlip?.lifespan).toContain('°E');

    const minimalEventSlip = buildSearchPreviewSlip({
      item: {
        id: 'evt_minimal',
        kind: 'event',
        title: 'Minimal Event',
        subtitle: '1860',
        snippet: 'Fallback snippet',
        score: 50,
      },
      bundle: null,
      peopleById: edgePeople,
      placesById: edgePlaces,
      eventsById: edgeEvents,
    });
    expect(minimalEventSlip?.excerpt).toBe('Fallback snippet');
    expect(minimalEventSlip?.actions).toEqual([]);

    expect(
      buildSearchPreviewSlip({
        item: { id: 'person:missing', kind: 'person', title: 'Missing', subtitle: '', score: 1 },
        bundle: null,
        peopleById: edgePeople,
        placesById: edgePlaces,
        eventsById: edgeEvents,
      })?.actions
    ).toEqual([]);
    expect(
      buildSearchPreviewSlip({
        item: { id: 'place:missing', kind: 'place', title: 'Missing', subtitle: '', score: 1 },
        bundle: null,
        peopleById: edgePeople,
        placesById: edgePlaces,
        eventsById: edgeEvents,
      })?.actions
    ).toEqual([]);
    expect(
      buildSearchPreviewSlip({
        item: { id: 'event:missing', kind: 'event', title: 'Missing', subtitle: '', score: 1 },
        bundle: null,
        peopleById: edgePeople,
        placesById: edgePlaces,
        eventsById: edgeEvents,
      })?.actions
    ).toEqual([]);
  });
});

describe('GlobalSearchModal Archival Command Bar (#71)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderCommandBar() {
    const bundle = makeBundle();
    const readings = makeReadings();
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <ArchiveDataProvider
            siteConfig={TEST_SITE_CONFIG}
            initialBundle={bundle}
            initialReadings={readings}
          >
            <ArchiveUiProvider>
              <LocationReadout />
              <GlobalSearchModal />
            </ArchiveUiProvider>
          </ArchiveDataProvider>
        </MemoryRouter>
      );
    });
  }

  function setInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('opens on Cmd/Ctrl+K and / and shows Recently viewed, Quick actions, and suggestion chips when empty', () => {
    recordRecentlyViewed({ kind: 'person', slug: 'thomas-alder', label: 'Thomas Alder', meta: '1835–1902' });
    renderCommandBar();

    // Open with Ctrl+K
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });

    const dialog = container.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Recently viewed');
    expect(dialog?.textContent).toContain('Thomas Alder (1835–1902)');
    expect(dialog?.textContent).toContain('Quick actions');
    expect(dialog?.textContent).toContain('Go to Tree');
    expect(dialog?.textContent).toContain('Go to Map');
    expect(dialog?.textContent).toContain('Trace Kinship');
    expect(dialog?.textContent).toContain('Evidence');

    // Click Go to Tree quick action
    const treeBtn = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find((b) =>
      b.textContent?.includes('Go to Tree')
    );
    expect(treeBtn).toBeDefined();
    act(() => {
      treeBtn?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe('/tree');

    // Re-open with /
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(container.querySelector('dialog')).not.toBeNull();
  });

  it('updates the live preview slip on ArrowDown and supports Alt+T/M/K and bare T/M/K shortcuts without hijacking typing', () => {
    renderCommandBar();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(input).not.toBeNull();
    setInputValue(input!, 'Mercer');

    // Combobox semantics intact
    expect(input?.getAttribute('aria-expanded')).toBe('true');
    const firstOptionId = input?.getAttribute('aria-activedescendant');
    expect(firstOptionId).toBeTruthy();

    const preview = container.querySelector('aside[aria-label="Selected result preview"]');
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain('Clara Mercer');
    expect(preview?.textContent).toContain('1840–1918');
    expect(preview?.textContent).toContain('Mercer Town, Kent County, Michigan');

    // Bare "t" while focused in input must NOT close/navigate
    act(() => {
      input?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    });
    expect(container.querySelector('dialog')).not.toBeNull();
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe('/');

    // ArrowDown moves to the next matching result (Thomas Alder) and updates the preview slip instantaneously
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(input?.getAttribute('aria-activedescendant')).not.toBe(firstOptionId);
    expect(preview?.textContent).toContain('Thomas Alder');
    expect(preview?.textContent).toContain('1835–1902');

    // ArrowUp returns to Clara Mercer, then Alt+K jumps to Kinship
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(preview?.textContent).toContain('Clara Mercer');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', altKey: true, bubbles: true }));
    });
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe(
      '/kinship?from=clara-mercer'
    );
  });

  it('triggers bare T jump when focus is outside the search input and opens Reading Room from preview action', () => {
    renderCommandBar();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    setInputValue(input!, 'Thomas Alder');

    // Move focus to the first option button, then press bare T
    const firstOption = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(firstOption).not.toBeNull();
    act(() => {
      firstOption?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    });
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe(
      '/tree?focus=thomas-alder'
    );

    // Re-open, search for Deed Book transcription, and click Reading Room action in preview slip
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input2 = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    setInputValue(input2!, 'parcel');

    const readingBtn = [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) =>
      b.textContent?.includes('Reading Room')
    );
    expect(readingBtn).toBeDefined();
    act(() => {
      readingBtn?.click();
    });
    expect(container.querySelector('[data-testid="active-reader"]')?.textContent).toBe('src_deed_book:4');
  });

  it('covers empty-state results, suggestion chips, hover preview switching, Enter navigation, and place recently-viewed chips', () => {
    recordRecentlyViewed({ kind: 'place', slug: 'mercer-town', label: 'Mercer Town' });
    const bundle = makeBundle();
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <ArchiveDataProvider siteConfig={TEST_SITE_CONFIG} initialBundle={bundle} initialReadings={null}>
            <ArchiveUiProvider>
              <LocationReadout />
              <GlobalSearchModal />
            </ArchiveUiProvider>
          </ArchiveDataProvider>
        </MemoryRouter>
      );
    });

    // Open with /
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(container.querySelector('dialog')?.textContent).toContain('Archive ready');

    // Click a suggestion chip to populate query
    const suggestionBtn = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Thomas Alder'
    );
    expect(suggestionBtn).toBeDefined();
    act(() => {
      suggestionBtn?.click();
    });
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(input?.value).toBe('Thomas Alder');

    // Press Enter while input is focused -> navigates to Thomas Alder profile
    act(() => {
      input?.focus();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe(
      '/person/thomas-alder'
    );

    // Re-open, click Recently viewed place chip
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const placeRecentBtn = [...container.querySelectorAll<HTMLButtonElement>('dialog button')].find(
      (b) => b.textContent === 'Mercer Town'
    );
    expect(placeRecentBtn).toBeDefined();
    act(() => {
      placeRecentBtn?.click();
    });
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe(
      '/place/mercer-town'
    );

    // Re-open, type unmatched query -> shows zero-results message, then match Mercer and hover + click preview Profile button
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input2 = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    setInputValue(input2!, 'zzzz-no-match');
    expect(container.querySelector('dialog')?.textContent).toContain('zzzz-no-match');

    setInputValue(input2!, 'Mercer');
    const options = container.querySelectorAll<HTMLButtonElement>('[role="option"]');
    expect(options.length).toBeGreaterThan(1);
    act(() => {
      options[1]?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const profileAction = [...container.querySelectorAll<HTMLButtonElement>('aside button')].find((b) =>
      b.textContent?.includes('Profile')
    );
    expect(profileAction).toBeDefined();
    act(() => {
      profileAction?.click();
    });
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toContain('/person/');
  });

  it('handles duplicate/blank suggestion labels, option click activation, and ignored modifier keys cleanly', () => {
    const base = makeBundle();
    const bundle = {
      ...base,
      places: [
        ...base.places,
        { ...base.places[0]!, id: 'plc_blank', slug: 'blank-place', name: '   ', full_name: 'Blank Place' },
        {
          ...base.places[0]!,
          id: 'plc_dup',
          slug: 'dup-place',
          name: 'Thomas Alder',
          full_name: 'Thomas Alder Township',
        },
      ],
    };
    const dupConfig = {
      ...TEST_SITE_CONFIG,
      anchorYears: [{ year: 1860, label: 'Thomas Alder' }],
    };
    act(() => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <ArchiveDataProvider siteConfig={dupConfig} initialBundle={bundle} initialReadings={makeReadings()}>
            <ArchiveUiProvider>
              <LocationReadout />
              <GlobalSearchModal />
            </ArchiveUiProvider>
          </ArchiveDataProvider>
        </MemoryRouter>
      );
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    setInputValue(input!, 'Thomas Alder');

    // Ctrl+T and Alt+Z should not trigger navigation
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', altKey: true, bubbles: true }));
    });
    expect(container.querySelector('dialog')).not.toBeNull();

    // Direct option click activates result
    const firstOpt = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(firstOpt).not.toBeNull();
    act(() => {
      firstOpt?.click();
    });
    expect(container.querySelector('dialog')).toBeNull();
    expect(container.querySelector('[data-testid="current-location"]')?.textContent).toBe(
      '/person/thomas-alder'
    );
  });
});
