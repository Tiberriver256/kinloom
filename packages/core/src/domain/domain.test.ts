import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { parseKinloomConfig } from '../schemas/config.js';
import type { KinshipEdge, Place, RawEvent, RawPerson, SourceRecord } from '../schemas/entities.js';
import { searchArchive } from './archiveSearch.js';
import { deriveArchiveStatus } from './archiveStatus.js';
import { buildLibrarianCitation, classifySourceTier, summarizeEventCitations } from './citations.js';
import {
  buildMigrationSegments,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  classifyMigrationStage,
  computeStopsBounds,
} from './geoMap.js';
import { describeBloodRelation, findKinshipPath } from './kinshipFinder.js';
import {
  journeyNext,
  journeyPlayToggle,
  journeyPrev,
  journeyReset,
  journeyTick,
  MAP_JOURNEY_INITIAL,
} from './mapJourney.js';
import { formatPublicCitation, formatPublicProvenance, formatPublicRepository } from './publicDisplay.js';
import { computeRadarForEvent } from './radarEngine.js';
import { polarPointAvoidingTopLabel } from './radarGeometry.js';
import { buildFullSourceText, buildSourceTextFilename, formatFileSize } from './sourceExport.js';
import {
  buildPersonThumbMap,
  buildPlacesDirectory,
  computeTimeSnapshot,
  pickDefaultSnapshotYear,
  resolveCanonicalPlace,
} from './timeSnapshot.js';
import { resolveTimeYear } from './timeYear.js';

const TEST_CONFIG = parseKinloomConfig({
  site: {
    title: 'Whitman Family Archive',
    familyName: 'Whitman',
    gedcomSourceName: 'WHITMAN_ARCHIVE',
  },
  defaultBranchId: 'whitman_core',
  branches: [{ id: 'whitman_core', label: 'Whitman Core' }],
  migrationEras: [
    { id: 'atlantic', label: 'Atlantic Coast', minLng: -80 },
    { id: 'midwest', label: 'Midwest Valley', minLng: -100, maxLng: -80 },
    { id: 'pacific', label: 'Pacific Coast', maxLng: -100 },
  ],
  mapDefaults: { centerLat: 39, centerLng: -95, zoom: 4, minSpanDeg: 1.5 },
});

const PLACES: Place[] = [
  {
    id: 'plc_usa',
    slug: 'usa',
    name: 'USA',
    full_name: 'USA',
    place_type: 'country',
    parent_id: null,
    lat: 39.8,
    lng: -98.5,
  },
  {
    id: 'plc_boston',
    slug: 'boston-ma',
    name: 'Boston',
    full_name: 'Boston, Suffolk County, Massachusetts, USA',
    place_type: 'town',
    parent_id: 'plc_usa',
    lat: 42.36,
    lng: -71.06,
  },
  {
    id: 'plc_cedar',
    slug: 'cedar-oh',
    name: 'Cedar County',
    full_name: 'Cedar County, Ohio, USA',
    place_type: 'county',
    parent_id: 'plc_usa',
    lat: 40.1,
    lng: -83.1,
  },
  {
    id: 'plc_twp',
    slug: 'twp-1-cedar-oh',
    name: 'Township 1',
    full_name: 'Township 1, Cedar County, Ohio, USA',
    place_type: 'town',
    parent_id: 'plc_cedar',
    lat: 40.12,
    lng: -83.08,
  },
  {
    id: 'plc_portland',
    slug: 'portland-or',
    name: 'Portland',
    full_name: 'Portland, Multnomah County, Oregon, USA',
    place_type: 'town',
    parent_id: 'plc_usa',
    lat: 45.52,
    lng: -122.68,
  },
];

const PEOPLE: RawPerson[] = [
  {
    id: 'per_gparent',
    slug: 'edward-whitman',
    full_name: 'Edward Whitman',
    given_name: 'Edward',
    surname: 'Whitman',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1820',
    death_edtf: '1892',
    portrait_url: null,
  },
  {
    id: 'per_gmother',
    slug: 'hannah-larkin',
    full_name: 'Hannah Larkin',
    given_name: 'Hannah',
    surname: 'Larkin',
    alt_names: ['Hannah Whitman'],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1824',
    death_edtf: '1898',
    portrait_url: null,
  },
  {
    id: 'per_child_a',
    slug: 'thomas-whitman',
    full_name: 'Thomas Whitman',
    given_name: 'Thomas',
    surname: 'Whitman',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'descendant',
    birth_edtf: '1850',
    death_edtf: '1920',
    portrait_url: null,
  },
  {
    id: 'per_child_b',
    slug: 'alice-whitman',
    full_name: 'Alice Whitman',
    given_name: 'Alice',
    surname: 'Whitman',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'descendant',
    birth_edtf: '1853',
    death_edtf: '1925',
    portrait_url: null,
  },
];

const KINSHIP: KinshipEdge[] = [
  { from: 'per_gparent', to: 'per_gmother', relation: 'spouse' },
  { from: 'per_gmother', to: 'per_gparent', relation: 'spouse' },
  { from: 'per_gparent', to: 'per_child_a', relation: 'parent' },
  { from: 'per_child_a', to: 'per_gparent', relation: 'child' },
  { from: 'per_gmother', to: 'per_child_a', relation: 'parent' },
  { from: 'per_child_a', to: 'per_gmother', relation: 'child' },
  { from: 'per_gparent', to: 'per_child_b', relation: 'parent' },
  { from: 'per_child_b', to: 'per_gparent', relation: 'child' },
  { from: 'per_gmother', to: 'per_child_b', relation: 'parent' },
  { from: 'per_child_b', to: 'per_gmother', relation: 'child' },
];

const SOURCES: SourceRecord[] = [
  {
    id: 'src_census_1880',
    citation: '1880 Federal Census, sources/raw/census.pdf',
    source_type: 'census',
    repository: 'Repository archive (sources/)',
  },
];

const EVENTS: RawEvent[] = [
  {
    id: 'evt_birt_edward',
    title: 'Birth of Edward Whitman',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1820',
    place_id: 'plc_boston',
    summary: 'Edward Whitman was born in Boston.',
    participants: [{ person_id: 'per_gparent', role: 'birth_subject' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
  },
  {
    id: 'evt_resi_thomas_1880',
    title: 'Thomas Whitman resided in Cedar County',
    scope: 'personal',
    event_kind: 'residence_anchor',
    edtf_date: '1880',
    place_id: 'plc_twp',
    summary: 'Thomas Whitman enumerated in 1880.',
    participants: [{ person_id: 'per_child_a', role: 'resident' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
  },
  {
    id: 'evt_resi_alice_1880',
    title: 'Alice Whitman resided in Cedar County',
    scope: 'personal',
    event_kind: 'residence_anchor',
    edtf_date: '1880',
    place_id: 'plc_cedar',
    summary: 'Alice Whitman enumerated in 1880.',
    participants: [{ person_id: 'per_child_b', role: 'resident' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
  },
  {
    id: 'evt_resi_thomas_1900',
    title: 'Thomas Whitman resided in Portland',
    scope: 'personal',
    event_kind: 'residence_anchor',
    edtf_date: '1900',
    place_id: 'plc_portland',
    summary: 'Thomas Whitman moved west to Portland.',
    participants: [{ person_id: 'per_child_a', role: 'resident' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
  },
];

const { bundle } = compileArchive({
  people: PEOPLE,
  events: EVENTS,
  places: PLACES,
  sources: SOURCES,
  kinship: KINSHIP,
  media: [
    {
      id: 'med_stone',
      kind: 'headstone',
      person_ids: ['per_gparent', 'per_gmother'],
      file: '/media/photos/whitman-stone.jpg',
      caption: 'Joint headstone',
    },
  ],
  siteConfig: TEST_CONFIG,
  mode: 'public',
  generatedAt: '2026-11-24T00:00:00.000Z',
});

const placesById = new Map(bundle.places.map((p) => [p.id, p]));
const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
const sourcesById = new Map(bundle.sources.map((s) => [s.id, s]));

describe('decoupled core domain algorithms', () => {
  it('finds shortest kinship path, overlap years, and shared places', () => {
    const sib = findKinshipPath({
      fromId: 'per_child_a',
      toId: 'per_child_b',
      bundle,
      placesById,
    });
    expect(sib.connected).toBe(true);
    expect(sib.relationshipLabel).toBe('Sibling of');
    expect(sib.overlapYears).toEqual({ start: 1853, end: 1920, durationYears: 67 });

    const parent = findKinshipPath({
      fromId: 'per_gparent',
      toId: 'per_child_a',
      bundle,
      placesById,
    });
    expect(parent.relationshipLabel).toBe('Parent of');
    expect(describeBloodRelation(2, 2)).toBe('1st Cousin of');
  });

  it('searches people, places, and events cleanly', () => {
    const res = searchArchive({ query: 'Portland', bundle, placesById });
    expect(res.some((r) => r.kind === 'place' && r.id === 'place:plc_portland')).toBe(true);
    expect(res.some((r) => r.kind === 'event' && r.id === 'event:evt_resi_thomas_1900')).toBe(true);
  });

  it('classifies citations, formats public provenance, and builds source text exports', () => {
    expect(classifySourceTier(sourcesById.get('src_census_1880'))).toBe('primary');
    expect(formatPublicCitation('1880 Federal Census, sources/raw/census.pdf')).toBe('1880 Federal Census');
    expect(formatPublicRepository('Repository archive (sources/)')).toBe('Family Archive');
    expect(formatPublicProvenance('sources/ancestry/a.jpg')).toBe('Ancestry Family Archive');

    const lib = buildLibrarianCitation(sourcesById.get('src_census_1880'), { confidence: 'high' });
    expect(lib.tier).toBe('primary');
    expect(lib.evidenceBasis).toBe('Direct evidence');

    const sum = summarizeEventCitations([{ source_id: 'src_census_1880', confidence: 'high' }], sourcesById);
    expect(sum.label).toBe('1 Source · 1 Primary');
    expect(sum.primaryCount).toBe(1);

    expect(formatFileSize(2048)).toBe('2 KB');
    expect(
      buildSourceTextFilename({
        source_id: 'src_1',
        title: 'Pioneer Diary 1880',
        author: 'E. Whitman',
        provenance: 'Family',
        pages: [{ page: 1, label: 'Page 1', file: 'p1.txt', text: 'April 10.' }],
      })
    ).toBe('pioneer-diary-1880.txt');
    expect(
      buildFullSourceText({
        source_id: 'src_1',
        title: 'Pioneer Diary 1880',
        author: 'E. Whitman',
        provenance: 'Family',
        pages: [{ page: 1, label: 'Page 1', file: 'p1.txt', text: 'April 10.' }],
      })
    ).toContain('=== Page 1 ===');
  });

  it('uses siteConfig migrationEras and mapDefaults in geoMap and timeSnapshot', () => {
    expect(classifyMigrationStage(placesById.get('plc_boston')!, TEST_CONFIG.migrationEras)).toBe('atlantic');
    expect(classifyMigrationStage(placesById.get('plc_portland')!, TEST_CONFIG.migrationEras)).toBe(
      'pacific'
    );

    const stops = buildMigrationStops(bundle, placesById, peopleById, {
      migrationEras: TEST_CONFIG.migrationEras,
    });
    expect(stops.map((s) => s.lineageStage)).toEqual(['atlantic', 'midwest', 'pacific']);
    expect(buildMigrationSegments(stops).length).toBe(2);
    expect(buildPerPersonMigrationSegments(stops).length).toBe(1);
    expect(computeStopsBounds([], TEST_CONFIG.mapDefaults)).not.toBeNull();

    // Census artifact Township 1 rolls up to Cedar County
    expect(resolveCanonicalPlace(placesById.get('plc_twp'), placesById)?.id).toBe('plc_cedar');

    // Multi-person headstone populates thumbs for both Edward and Hannah
    const thumbs = buildPersonThumbMap(bundle);
    expect(thumbs.get('per_gparent')).toBe('/media/photos/whitman-stone.jpg');
    expect(thumbs.get('per_gmother')).toBe('/media/photos/whitman-stone.jpg');

    const snap = computeTimeSnapshot(bundle, 1880, placesById);
    expect(snap.locatedCount).toBe(2);
    expect(pickDefaultSnapshotYear(bundle, placesById)).toBe(1880);

    const dir = buildPlacesDirectory(bundle, placesById, peopleById, TEST_CONFIG.migrationEras);
    expect(dir.some((d) => d.place.id === 'plc_cedar' && d.stage === 'midwest')).toBe(true);
  });

  it('computes radar co-presence, geometry, journey state machine, archiveStatus, and timeYear', () => {
    const thomasEv = bundle.events.find((e) => e.id === 'evt_resi_thomas_1880')!;
    const radar = computeRadarForEvent(bundle, thomasEv, 'per_child_a', peopleById, placesById);
    expect(radar.coPresenceVisible.some((c) => c.person.id === 'per_child_b')).toBe(true);

    const pt = polarPointAvoidingTopLabel(100, 100, 80, 0, 4, 0);
    expect(Math.hypot(pt.x - 100, pt.y - 100)).toBeCloseTo(80, 5);

    const stopIds = ['s1', 's2'];
    const s1 = journeyNext(MAP_JOURNEY_INITIAL, stopIds);
    expect(s1.selectedStopId).toBe('s1');
    const s2 = journeyPlayToggle(s1, stopIds);
    expect(s2.playing).toBe(true);
    const s3 = journeyTick(s2, stopIds);
    expect(s3.selectedStopId).toBe('s2');
    expect(journeyPrev(s3, stopIds).selectedStopId).toBe('s1');
    expect(journeyReset(s3).stepIndex).toBe(-1);

    expect(deriveArchiveStatus({ loading: true, error: null, bundle: null })).toBe('loading');
    expect(deriveArchiveStatus({ loading: false, error: 'boom', bundle })).toBe('error');
    expect(deriveArchiveStatus({ loading: false, error: null, bundle })).toBe('ready');
    expect(resolveTimeYear('1880', 1900)).toBe(1880);
    expect(resolveTimeYear('9999', 1900)).toBe(1900);
  });

  it('property: kinshipFinder connectivity is symmetric across undirected edges', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...bundle.people.map((p) => p.id)),
        fc.constantFrom(...bundle.people.map((p) => p.id)),
        (a, b) => {
          const ab = findKinshipPath({ fromId: a, toId: b, bundle, placesById });
          const ba = findKinshipPath({ fromId: b, toId: a, bundle, placesById });
          expect(ab.connected).toBe(ba.connected);
          expect(ab.steps.length).toBe(ba.steps.length);
        }
      ),
      { numRuns: 30 }
    );
  });
});
