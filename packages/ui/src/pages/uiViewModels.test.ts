import type { ArchiveBundle, ArchiveEvent, MediaItem, MigrationStop, Person, Place } from '@kinloom/core';
import { ENTITY_ID_PREFIX, UNVERIFIED_TREE_SOURCE_ID } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  CREATABLE_KIND_ORDER,
  ENTITY_CREATE_FORM_REGISTRY,
} from '../components/wiki/entityForms/createRegistry.js';
import {
  FALLBACK_EDIT_FORM_ENTRY,
  getEntityEditFormEntry,
} from '../components/wiki/entityForms/editRegistry.js';
import { createInitialEntityDraft } from '../components/wiki/entityForms/fieldTypes.js';
import {
  collectConflictEvents,
  collectEventDiscrepancyClaims,
  collectUnverifiedEvents,
  computeEvidenceCitationMetrics,
  countMediaByKind,
  filterAndSortSources,
  filterMediaItems,
  parseInitialEvidenceTab,
} from './evidence/evidenceViewModel.js';
import { buildFamilyOverlay, computeDefaultMapBounds, routeArc, wantsLabel } from './map/mapOverlayData.js';
import {
  buildImmediateFamily,
  buildPersonSectionJumpItems,
  buildTimelineScrubberTicks,
  collectPersonMedia,
  resolvePortraitLightboxState,
} from './person/personViewModel.js';
import {
  buildPlaceOccupancySummary,
  collectPlaceLocalRecords,
  collectRecordDecades,
  filterLocalRecordsByDecade,
  resolveMatchingPlaceIds,
} from './place/placeViewModel.js';

function makePerson(overrides: Partial<Person> & { id: string; slug: string; full_name: string }): Person {
  return {
    given_name: overrides.full_name.split(' ')[0] ?? '',
    surname: overrides.full_name.split(' ').slice(1).join(' '),
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '',
    death_edtf: '',
    birth_year: null,
    death_year: null,
    event_count: 0,
    primary_place_id: null,
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> & { id: string; slug: string; name: string }): Place {
  return {
    full_name: overrides.name,
    place_type: 'town',
    parent_id: null,
    lat: 39.78,
    lng: -89.65,
    ...overrides,
  };
}

function makeBundle(): ArchiveBundle {
  const parent = makePerson({
    id: 'per_parent',
    slug: 'parent-one',
    full_name: 'Clara Vance',
    birth_year: 1850,
    death_year: 1920,
  });
  const subject = makePerson({
    id: 'per_subject',
    slug: 'subject-one',
    full_name: 'Arthur Vance',
    birth_year: 1875,
    death_year: 1945,
    portrait_url: 'media/arthur.jpg',
  });
  const livingChild = makePerson({
    id: 'per_living',
    slug: 'living-one',
    full_name: 'Living',
    is_living: true,
  });
  const deceasedChild = makePerson({
    id: 'per_child',
    slug: 'child-one',
    full_name: 'Mabel Vance',
    birth_year: 1902,
    death_year: 1988,
  });

  const events: ArchiveEvent[] = [
    {
      id: 'evt_conflict',
      title: 'Birth of Arthur',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1875-03-10',
      display_date: '10 Mar 1875',
      year: 1875,
      time_min: 18750310,
      time_max: 18750310,
      place_id: 'pl_springfield',
      summary: 'Recorded in parish and census.',
      participants: [{ person_id: 'per_subject', role: 'principal' }],
      sources: [
        { source_id: 'src_census', confidence: 'high', citation_detail: 'p. 4', scan_url: 'scans/p4.jpg' },
      ],
      alternate_dates: [{ edtf_date: '1876', source_id: 'src_census', note: '1880 census age' }],
    },
    {
      id: 'evt_unverified',
      title: 'Move to Illinois',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1882',
      display_date: '1882',
      year: 1882,
      time_min: 18820101,
      time_max: 18821231,
      place_id: null,
      summary: 'Uncited move.',
      participants: [{ person_id: 'per_subject', role: 'principal' }],
      sources: [{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }],
    },
  ];

  const media: MediaItem[] = [
    {
      id: 'med_doc',
      kind: 'document_scan',
      file: 'media/doc.jpg',
      caption: 'Deed scan',
      person_id: 'per_subject',
    },
    {
      id: 'med_portrait',
      kind: 'portrait',
      file: 'media/arthur.jpg',
      caption: 'Arthur studio portrait',
      person_id: 'per_subject',
    },
  ];

  return {
    meta: {
      version: '1.0',
      generated_at: '2026-01-01T00:00:00Z',
      build_mode: 'public',
      counts: {
        people: 4,
        living_redacted: 1,
        events: events.length,
        residence_spans: 0,
        places: 1,
        sources: 2,
        media: media.length,
        narratives: 0,
      },
    },
    people: [parent, subject, livingChild, deceasedChild],
    kinship: [
      { from: 'per_parent', to: 'per_subject', relation: 'parent' },
      { from: 'per_subject', to: 'per_living', relation: 'parent' },
      { from: 'per_subject', to: 'per_child', relation: 'parent' },
    ],
    places: [makePlace({ id: 'pl_springfield', slug: 'springfield', name: 'Springfield' })],
    place_ancestors: {},
    events,
    residence_spans: [],
    sources: [
      {
        id: 'src_census',
        citation: '1880 U.S. Federal Census, Sangamon County',
        source_type: 'census',
        repository: 'NARA',
      },
      {
        id: 'src_bible',
        citation: 'Vance Family Bible',
        source_type: 'family_record',
      },
    ],
    media,
    narratives: [],
  };
}

describe('personViewModel', () => {
  it('sorts person media by kind priority, builds redacted immediate family, and resolves portrait lightbox', () => {
    const bundle = makeBundle();
    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
    const subject = peopleById.get('per_subject');
    if (!subject) throw new Error('missing subject');

    const sortedMedia = collectPersonMedia(bundle, subject.id);
    expect(sortedMedia.map((m) => m.id)).toEqual(['med_portrait', 'med_doc']);

    const family = buildImmediateFamily(bundle, subject.id, peopleById);
    expect(family.parents.map((p) => p.name)).toEqual(['Clara Vance']);
    expect(family.children.map((p) => p.name)).toEqual(['Mabel Vance']);
    expect(family.livingChildCount).toBe(1);

    expect(resolvePortraitLightboxState(subject, sortedMedia)).toEqual({ kind: 'gallery', index: 0 });
    expect(buildTimelineScrubberTicks(bundle.events)).toEqual([
      { decade: 1870, eventId: 'evt_conflict' },
      { decade: 1880, eventId: 'evt_unverified' },
    ]);
    expect(
      buildPersonSectionJumpItems({ biographyCount: 1, familyStoryCount: 0, mediaCount: 2, eventCount: 2 })
    ).toHaveLength(3);
  });
});

describe('evidenceViewModel', () => {
  it('derives conflicts, unverified events, citation metrics, and filtered media cleanly', () => {
    const bundle = makeBundle();

    expect(parseInitialEvidenceTab('media')).toBe('media');
    expect(parseInitialEvidenceTab('invalid')).toBe('conflicts');

    const conflicts = collectConflictEvents(bundle);
    expect(conflicts.map((e) => e.id)).toEqual(['evt_conflict']);
    expect(collectEventDiscrepancyClaims(conflicts[0])).toHaveLength(1);

    const unverified = collectUnverifiedEvents(bundle);
    expect(unverified.map((e) => e.id)).toEqual(['evt_unverified']);

    const metrics = computeEvidenceCitationMetrics(bundle);
    expect(metrics.detailedCitationCount).toBe(1);
    expect(metrics.linkedRecordScanCount).toBe(1);
    expect(metrics.sourceUsageCounts.get('src_census')).toBe(1);

    const filteredSources = filterAndSortSources(bundle, 'nara', metrics.sourceUsageCounts);
    expect(filteredSources.map((s) => s.id)).toEqual(['src_census']);

    const counts = countMediaByKind(bundle.media ?? []);
    expect(counts).toEqual({ document_scan: 1, portrait: 1 });
    expect(filterMediaItems(bundle.media ?? [], 'portrait', 'arthur')).toHaveLength(1);
  });
});

describe('mapOverlayData', () => {
  it('builds GeoJSON features for stepping routes, dashed ocean crossings, and stop labels', () => {
    const startPlace = makePlace({ id: 'pl_a', slug: 'a', name: 'Rotterdam', lat: 51.92, lng: 4.48 });
    const endPlace = makePlace({ id: 'pl_b', slug: 'b', name: 'New York', lat: 40.71, lng: -74.0 });
    expect(routeArc(startPlace, endPlace)).toHaveLength(33);
    expect(wantsLabel(0, 3, 'stop_1', null, 'all')).toBe(true);
    expect(wantsLabel(1, 3, 'stop_2', null, 'all')).toBe(false);
    expect(wantsLabel(1, 3, 'stop_2', 'stop_2', 'all')).toBe(true);

    const stops: MigrationStop[] = [
      {
        id: 'stop_1',
        eventId: 'evt_1',
        year: 1850,
        displayDate: '1850',
        title: 'Departure',
        place: startPlace,
        lineageStage: 'europe',
        personNames: ['Clara Vance'],
        personSlugs: ['clara-vance'],
      },
      {
        id: 'stop_2',
        eventId: 'evt_2',
        year: 1851,
        displayDate: '1851',
        title: 'Arrival',
        place: endPlace,
        lineageStage: 'america',
        personNames: ['Clara Vance'],
        personSlugs: ['clara-vance'],
      },
    ];
    const seg = { from: stops[0], to: stops[1], distanceMiles: 3650 };
    const overlay = buildFamilyOverlay({
      stops,
      visibleStops: stops,
      segments: [seg],
      allSegments: [seg],
      stepIndex: 1,
      selectedStopId: 'stop_2',
      personFilter: 'all',
      stageColors: new Map([
        ['europe', '#1B2A41'],
        ['america', '#7A4612'],
      ]),
    });

    const routeFeature = overlay.features.find((f) => f.properties?.kind === 'route');
    expect(routeFeature?.properties?.dashed).toBe(true);
    expect(routeFeature?.properties?.latest).toBe(true);

    const fallbackBounds = computeDefaultMapBounds([], {
      centerLng: -90,
      centerLat: 40,
      zoom: 5,
      minSpanDeg: 1.5,
    });
    expect(fallbackBounds).toEqual([
      [-91.5, 38.5],
      [-88.5, 41.5],
    ]);
  });
});

describe('entityForms registry seam', () => {
  it('resolves edit form entries and prepares pronunciation drafts cleanly', () => {
    const personEntry = getEntityEditFormEntry('person');
    expect(personEntry).not.toBe(FALLBACK_EDIT_FORM_ENTRY);
    expect(personEntry.supportsPronunciation?.({ is_living: false, full_name: 'Arthur Vance' })).toBe(true);
    expect(personEntry.supportsPronunciation?.({ is_living: true, full_name: 'Living' })).toBe(false);
    expect(
      personEntry.prepareSubmitDraft?.({ is_living: true, pronunciation: { phonetic: 'AR-ther' } })
    ).toEqual({ is_living: true, pronunciation: null });

    expect(getEntityEditFormEntry('source')).toBe(FALLBACK_EDIT_FORM_ENTRY);
  });

  it('validates and builds create payloads via ENTITY_CREATE_FORM_REGISTRY', () => {
    expect(CREATABLE_KIND_ORDER).toEqual(['person', 'event', 'place', 'kinship_edge']);
    const draft = createInitialEntityDraft('per_a', null);
    draft.givenName = 'Clara';
    draft.surname = 'Vance';

    const built = ENTITY_CREATE_FORM_REGISTRY.person.validateAndBuild(draft, {
      people: [],
      hasPrimarySource: true,
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.entityId).toBe('per_clara_vance');
      expect(built.payload.full_name).toBe('Clara Vance');
    }

    const emptyEvent = ENTITY_CREATE_FORM_REGISTRY.event.validateAndBuild(draft, {
      people: [],
      hasPrimarySource: true,
    });
    expect(emptyEvent).toEqual({ ok: false, error: 'Enter an event title.' });

    const placeDraft = createInitialEntityDraft('per_a', null);
    placeDraft.placeName = 'Springfield';
    placeDraft.placeFullName = 'Springfield, Illinois';
    placeDraft.placeLat = '39.7817';
    placeDraft.placeLng = '-89.6501';
    const builtPlace = ENTITY_CREATE_FORM_REGISTRY.place.validateAndBuild(placeDraft, {
      people: [],
      hasPrimarySource: true,
    });
    expect(builtPlace.ok).toBe(true);
    if (builtPlace.ok) {
      expect(builtPlace.entityId.startsWith(ENTITY_ID_PREFIX.place)).toBe(true);
      expect(builtPlace.entityId).toBe('plc_springfield_illinois');
    }
  });
});

describe('placeViewModel', () => {
  it('resolves place scope matching, occupancy summary, and local record decade filters cleanly', () => {
    const bundle = makeBundle();
    const nearbyPlace = makePlace({
      id: 'plc_chatham',
      slug: 'chatham',
      name: 'Chatham',
      lat: 39.68,
      lng: -89.7,
    });
    const localRecord: ArchiveEvent = {
      id: 'evt_local_1884',
      title: 'County Courthouse Dedication',
      scope: 'local',
      event_kind: 'point_event',
      edtf_date: '1884-06-01',
      display_date: '1 Jun 1884',
      year: 1884,
      time_min: 18840601,
      time_max: 18840601,
      place_id: 'plc_chatham',
      summary: 'Town gathering.',
      participants: [],
      sources: [],
    };
    const extendedBundle: ArchiveBundle = {
      ...bundle,
      places: [...bundle.places, nearbyPlace],
      events: [...bundle.events, localRecord],
    };
    const placesById = new Map(extendedBundle.places.map((p) => [p.id, p]));
    const peopleById = new Map(extendedBundle.people.map((p) => [p.id, p]));
    const springfield = extendedBundle.places[0];

    const exactIds = resolveMatchingPlaceIds(extendedBundle, springfield, 'exact', placesById);
    expect([...exactIds]).toEqual(['pl_springfield']);

    const radiusIds = resolveMatchingPlaceIds(extendedBundle, springfield, 'radius15', placesById);
    expect(radiusIds.has('pl_springfield')).toBe(true);
    expect(radiusIds.has('plc_chatham')).toBe(true);

    const occupancy = buildPlaceOccupancySummary(extendedBundle, radiusIds, peopleById);
    expect(occupancy.rows.map((r) => r.person.id)).toEqual(['per_subject']);
    expect(occupancy.rows[0]?.startYear).toBe(1875);

    const localRecords = collectPlaceLocalRecords(extendedBundle, radiusIds);
    expect(localRecords.map((r) => r.id)).toEqual(['evt_local_1884']);
    expect(collectRecordDecades(localRecords)).toEqual([1880]);
    expect(filterLocalRecordsByDecade(localRecords, '1880')).toHaveLength(1);
    expect(filterLocalRecordsByDecade(localRecords, '1870')).toHaveLength(0);
  });
});
