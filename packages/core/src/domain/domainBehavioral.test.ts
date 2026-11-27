import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { parseKinloomConfig } from '../schemas/config.js';
import type {
  KinshipEdge,
  MediaItem,
  Place,
  RawEvent,
  RawPerson,
  ReadingsBundle,
  SourceRecord,
} from '../schemas/entities.js';
import { buildExcerpt, searchArchive } from './archiveSearch.js';
import {
  buildLibrarianCitation,
  classifySourceTier,
  formatConfidenceLabel,
  formatSourceTypeLabel,
  summarizeEventCitations,
} from './citations.js';
import {
  buildMigrationSegments,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  classifyMigrationStage,
  computeStopsBounds,
  projectLatLng,
  projectNearbyPlaces,
} from './geoMap.js';
import {
  computeLifeOverlap,
  describeBloodRelation,
  describeKinshipSteps,
  findKinshipPath,
} from './kinshipFinder.js';
import {
  journeyNext,
  journeyPlayToggle,
  journeyPrev,
  journeyReset,
  journeyScrub,
  journeySelectStop,
  journeyTick,
  MAP_JOURNEY_INITIAL,
} from './mapJourney.js';
import { formatPublicCitation, formatPublicProvenance, formatPublicRepository } from './publicDisplay.js';
import {
  computeRadarForEvent,
  findNearestEventForPerson,
  getEventsForPerson,
  getKinshipInfo,
} from './radarEngine.js';
import { polarPointAvoidingTopLabel } from './radarGeometry.js';
import {
  buildAllSourcesText,
  buildFullSourceText,
  buildSourceTextFilename,
  formatFileSize,
} from './sourceExport.js';
import {
  buildPersonThumbMap,
  buildPlacesDirectory,
  classifyPlaceStage,
  compareTimeLanes,
  computeTimeSnapshot,
  isPersonAliveInYear,
  resolveCanonicalPlace,
} from './timeSnapshot.js';
import { parseTimeYearParam, resolveTimeYear } from './timeYear.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Valley Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [{ id: 'alder_main', label: 'Alder Main' }],
  migrationEras: [
    { id: 'east', label: 'Eastern', minLng: -80, startYear: 1700, endYear: 1900 },
    { id: 'midwest', label: 'Midwest', minLng: -95, maxLng: -80, minLat: 36, maxLat: 46 },
    { id: 'west', label: 'West', maxLng: -95 },
  ],
  mapDefaults: { centerLat: 40, centerLng: -84, zoom: 5, minSpanDeg: 1.5 },
});

function buildRichArchiveFixture() {
  const places: Place[] = [
    {
      id: 'plc_usa',
      slug: 'usa',
      name: 'United States',
      full_name: 'United States',
      place_type: 'country',
      parent_id: null,
      lat: 39.8,
      lng: -98.5,
    },
    {
      id: 'plc_ohio',
      slug: 'ohio',
      name: 'Ohio',
      full_name: 'Ohio, United States',
      place_type: 'state',
      parent_id: 'plc_usa',
      lat: 40.4,
      lng: -82.9,
    },
    {
      id: 'plc_cedar_county',
      slug: 'cedar-county',
      name: 'Cedar County',
      full_name: 'Cedar County, Ohio, United States',
      place_type: 'county',
      parent_id: 'plc_ohio',
      lat: 40.1,
      lng: -83.1,
    },
    {
      id: 'plc_riverdale',
      slug: 'riverdale',
      name: 'Riverdale',
      full_name: 'Riverdale, Cedar County, Ohio, United States',
      place_type: 'town',
      parent_id: 'plc_cedar_county',
      lat: 40.1,
      lng: -83.1,
    },
    {
      id: 'plc_oakton',
      slug: 'oakton',
      name: 'Oakton',
      full_name: 'Oakton, Cedar County, Ohio, United States',
      place_type: 'town',
      parent_id: 'plc_cedar_county',
      lat: 40.18,
      lng: -83.15,
    },
    {
      id: 'plc_twp4',
      slug: 'twp-4',
      name: 'Township 4',
      full_name: 'Township 4, Cedar County, Ohio, United States',
      place_type: 'town',
      parent_id: 'plc_cedar_county',
      lat: 40.12,
      lng: -83.11,
    },
    {
      id: 'plc_portland',
      slug: 'portland',
      name: 'Portland',
      full_name: 'Portland, Oregon, United States',
      place_type: 'town',
      parent_id: 'plc_usa',
      lat: 45.52,
      lng: -122.67,
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src_census',
      citation: '1880 United States Federal Census, Cedar County, Ohio',
      author: 'U.S. Census Bureau',
      repository: 'National Archives and Records Administration (NARA)',
      source_type: 'census',
      url: 'https://www.archives.gov/research/census/1880',
    },
    {
      id: 'src_history',
      citation: 'History of Cedar County, 1895',
      publisher: 'Valley Press',
      source_type: 'county_history',
    },
    {
      id: 'src_memoir',
      citation: 'Alder Family Memoir',
      source_type: 'family_memoir',
    },
    {
      id: 'src_index',
      citation: 'Ohio Memorial Index',
      source_type: 'memorial',
    },
    {
      id: 'src_unverified_tree_entry',
      citation: 'Imported family tree entry',
      source_type: 'unverified_tree_entry',
    },
  ];

  const people: RawPerson[] = [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: ['Hank Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder_main',
      birth_edtf: '1850',
      death_edtf: '1925',
      portrait_url: null,
    },
    {
      id: 'per_clara',
      slug: 'clara-mercer',
      full_name: 'Clara Mercer',
      given_name: 'Clara',
      surname: 'Mercer',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder_main',
      birth_edtf: '1854',
      death_edtf: '1932',
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
      lineage_group: 'descendant',
      branch: 'alder_main',
      birth_edtf: '1878',
      death_edtf: '1950',
      portrait_url: null,
    },
    {
      id: 'per_martha',
      slug: 'martha-alder',
      full_name: 'Martha Alder',
      given_name: 'Martha',
      surname: 'Alder',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'descendant',
      branch: 'alder_main',
      birth_edtf: '1880',
      death_edtf: '1962',
      portrait_url: null,
    },
    {
      id: 'per_isolated',
      slug: 'isolated-neighbor',
      full_name: 'Jonas Reed',
      given_name: 'Jonas',
      surname: 'Reed',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'collateral',
      branch: 'alder_main',
      birth_edtf: '1852',
      death_edtf: '',
      portrait_url: null,
    },
  ];

  const kinship: KinshipEdge[] = [
    { from: 'per_henry', to: 'per_clara', relation: 'spouse' },
    { from: 'per_clara', to: 'per_henry', relation: 'spouse' },
    { from: 'per_henry', to: 'per_arthur', relation: 'parent' },
    { from: 'per_arthur', to: 'per_henry', relation: 'child' },
    { from: 'per_henry', to: 'per_martha', relation: 'parent' },
    { from: 'per_martha', to: 'per_henry', relation: 'child' },
  ];

  const events: RawEvent[] = [
    {
      id: 'evt_1880',
      title: 'Henry Alder 1880 Census in Riverdale',
      scope: 'family',
      event_kind: 'residence_anchor',
      edtf_date: '1880-06-01',
      place_id: 'plc_riverdale',
      summary: 'Archival residence record places Henry Alder and Clara Mercer in Riverdale.',
      severity_rank: 5,
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
      sources: [{ source_id: 'src_census', confidence: 'high', citation_detail: 'Sheet 12A' }],
      alternate_dates: [{ edtf_date: '1880-06-02', source_id: 'src_history', note: 'County chronicle date' }],
      alternate_places: [{ place_name: 'Oakton', source_id: 'src_memoir', note: 'Family note' }],
      fact_conflicts: [{ claim: 'Listed as miller', source_id: 'src_index', note: 'Index note' }],
    },
    {
      id: 'evt_1880_nearby',
      title: 'Oakton Mill Listing',
      scope: 'personal',
      event_kind: 'residence_anchor',
      edtf_date: '1880-07-01',
      place_id: 'plc_oakton',
      summary: 'Arthur Alder recorded near Oakton.',
      participants: [
        { person_id: 'per_arthur', role: 'subject' },
        { person_id: 'per_martha', role: 'household' },
      ],
      sources: [{ source_id: 'src_history', confidence: 'medium' }],
    },
    {
      id: 'evt_1895_west',
      title: 'Relocation to Portland',
      scope: 'personal',
      event_kind: 'residence_anchor',
      edtf_date: '1895-09-01',
      place_id: 'plc_portland',
      summary: 'Henry Alder moved west to Portland, Oregon.',
      participants: [{ person_id: 'per_henry', role: 'subject' }],
      sources: [{ source_id: 'src_memoir', confidence: 'medium' }],
    },
    {
      id: 'evt_1880_local',
      title: 'Cedar County Flood',
      scope: 'local',
      event_kind: 'point_event',
      edtf_date: '1880-05-15',
      place_id: 'plc_cedar_county',
      summary: 'Spring river flooding across Cedar County.',
      severity_rank: 7,
      participants: [],
      sources: [{ source_id: 'src_history', confidence: 'high' }],
    },
    {
      id: 'evt_1880_national',
      title: '1880 National Industrial Exposition',
      scope: 'national',
      event_kind: 'context_span',
      edtf_date: '1880-06-01',
      place_id: 'plc_usa',
      summary: 'National context event.',
      severity_rank: 8,
      participants: [],
      sources: [{ source_id: 'src_history', confidence: 'high' }],
    },
  ];

  const media: MediaItem[] = [
    {
      id: 'med_henry_portrait',
      kind: 'portrait',
      person_id: 'per_henry',
      file: '/media/henry.jpg',
      thumb_file: '/media/henry-thumb.jpg',
      caption: 'Henry Alder studio portrait',
    },
    {
      id: 'med_clara_doc',
      kind: 'document_scan',
      person_ids: ['per_clara', 'per_arthur'],
      file: '/media/doc.jpg',
      caption: 'Family deed',
    },
  ];

  const { bundle } = compileArchive({
    people,
    events,
    places,
    sources,
    kinship,
    media,
    siteConfig: SITE_CONFIG,
    mode: 'private',
    generatedAt: '2026-11-26T00:00:00.000Z',
  });

  const placesById = new Map(bundle.places.map((p) => [p.id, p]));
  const peopleById = new Map(bundle.people.map((p) => [p.id, p]));
  const sourcesById = new Map(bundle.sources.map((s) => [s.id, s]));

  return { bundle, placesById, peopleById, sourcesById };
}

describe('Archive search & excerpt behavior', () => {
  it('ranks exact, prefix, and substring matches across people, places, events, and primary source readings', () => {
    const { bundle, placesById } = buildRichArchiveFixture();
    const readings: ReadingsBundle = {
      documents: {
        src_history: {
          source_id: 'src_history',
          title: 'History of Cedar County',
          author: 'Valley Historical Society',
          pages: [
            {
              page: 1,
              label: 'Page 1',
              text: 'In the spring of 1880, Henry Alder built a sawmill along the river in Riverdale, Cedar County.',
            },
          ],
        },
      },
    };

    expect(searchArchive({ query: 'a', bundle, placesById })).toEqual([]);
    expect(searchArchive({ query: 'Henry', bundle: null, placesById })).toEqual([]);

    const exactPerson = searchArchive({ query: 'Henry Alder', bundle, placesById, readings });
    expect(exactPerson.some((r) => r.kind === 'person' && r.title === 'Henry Alder' && r.score === 120)).toBe(
      true
    );
    expect(
      exactPerson.some((r) => r.kind === 'reading' && r.sourceReaderTarget?.sourceId === 'src_history')
    ).toBe(true);

    // Conflict text and place-only local events are searchable
    const conflictSearch = searchArchive({ query: 'miller', bundle, placesById });
    expect(conflictSearch.some((r) => r.kind === 'event' && r.id === 'event:evt_1880')).toBe(true);

    const localSearch = searchArchive({ query: 'Flood', bundle, placesById });
    expect(localSearch.some((r) => r.kind === 'event' && r.route === '/place/cedar-county')).toBe(true);

    // National context events are excluded from personal/family/local/state event search
    const nationalSearch = searchArchive({ query: 'Exposition', bundle, placesById });
    expect(nationalSearch.some((r) => r.id === 'event:evt_1880_national')).toBe(false);

    // Excerpt handles empty query, missing query, and centered ellipsis clipping
    const longText = `${'A'.repeat(100)}Riverdale${'B'.repeat(100)}`;
    expect(buildExcerpt(longText, '', 20).length).toBeLessThanOrEqual(40);
    expect(buildExcerpt(longText, 'notfound', 20).length).toBeLessThanOrEqual(40);
    const centered = buildExcerpt(longText, 'Riverdale', 15);
    expect(centered.startsWith('…')).toBe(true);
    expect(centered.endsWith('…')).toBe(true);
    expect(centered).toContain('Riverdale');
  });
});

describe('Evidence citations & public display behavior', () => {
  it('classifies all five evidence tiers, builds bibliographic citations, and formats public provenance safely', () => {
    const { sourcesById } = buildRichArchiveFixture();
    expect(classifySourceTier(sourcesById.get('src_census'))).toBe('primary');
    expect(classifySourceTier(sourcesById.get('src_history'))).toBe('published');
    expect(classifySourceTier(sourcesById.get('src_memoir'))).toBe('family');
    expect(classifySourceTier(sourcesById.get('src_index'))).toBe('derivative');
    expect(classifySourceTier(sourcesById.get('src_unverified_tree_entry'))).toBe('unverified');
    expect(classifySourceTier(undefined)).toBe('unverified');

    expect(formatSourceTypeLabel()).toBe('Archival record');
    expect(formatSourceTypeLabel('vital_record')).toBe('Vital Record');
    expect(formatConfidenceLabel('high', 'primary')).toBe('Direct evidence');
    expect(formatConfidenceLabel('medium', 'published')).toBe('Corroborating evidence');
    expect(formatConfidenceLabel('low', 'derivative')).toBe('Unverified / indirect');
    expect(formatConfidenceLabel(undefined, 'unverified')).toBe('Unverified claim');
    expect(formatConfidenceLabel(undefined, 'primary')).toBe('Recorded');

    const cited = buildLibrarianCitation(sourcesById.get('src_census'), {
      source_id: 'src_census',
      confidence: 'high',
      citation_detail: 'Sheet 12A',
    });
    expect(cited.urlHost).toBe('archives.gov');
    expect(cited.bibliographicString).toContain('Sheet 12A');
    expect(cited.bibliographicString).toContain('National Archives');

    const fallbackCited = buildLibrarianCitation(undefined, { source_id: 'src_missing' });
    expect(fallbackCited.tier).toBe('unverified');
    expect(fallbackCited.title).toBe('src_missing');

    expect(summarizeEventCitations([], sourcesById).onlyUnverified).toBe(true);
    expect(
      summarizeEventCitations([{ source_id: 'src_unverified_tree_entry', confidence: 'low' }], sourcesById)
        .onlyUnverified
    ).toBe(true);
    const mixedSummary = summarizeEventCitations(
      [
        { source_id: 'src_census', confidence: 'high' },
        { source_id: 'src_history', confidence: 'medium' },
        { source_id: 'src_memoir', confidence: 'medium' },
      ],
      sourcesById
    );
    expect(mixedSummary.primaryCount).toBe(1);
    expect(mixedSummary.onlyUnverified).toBe(false);
    expect(mixedSummary.label).toContain('3 Sources');

    // Public display sanitization strips local sources/ paths
    expect(formatPublicProvenance('')).toBe('Family Archive');
    expect(formatPublicProvenance('sources/ancestry/1880.jpg')).toBe('Ancestry Family Archive');
    expect(formatPublicProvenance('sources/local/photo.jpg')).toBe('Family Archive');
    expect(formatPublicProvenance('County Museum')).toBe('County Museum');
    expect(formatPublicCitation('1880 Census, sources/scans/p1.jpg (sources/extra)')).toBe('1880 Census');
    expect(formatPublicRepository('')).toBe('');
    expect(formatPublicRepository('Repository archive (sources/)')).toBe('Family Archive');
    expect(formatPublicRepository('County Courthouse (sources/deeds)')).toBe('County Courthouse');
  });
});

describe('Geo map, migration stops, and map journey state machine behavior', () => {
  it('classifies migration eras, builds stops/segments, projects nearby places, and steps through journeys', () => {
    const { bundle, placesById, peopleById } = buildRichArchiveFixture();
    const riverdale = placesById.get('plc_riverdale')!;
    const portland = placesById.get('plc_portland')!;

    expect(classifyMigrationStage(riverdale, SITE_CONFIG.migrationEras, 1880)).toBe('midwest');
    expect(classifyMigrationStage(portland, SITE_CONFIG.migrationEras, 1895)).toBe('west');
    expect(classifyPlaceStage(riverdale, SITE_CONFIG.migrationEras)).toBe('midwest');

    const stops = buildMigrationStops(bundle, placesById, peopleById, {
      migrationEras: SITE_CONFIG.migrationEras,
    });
    expect(stops.length).toBeGreaterThanOrEqual(2);
    const segments = buildMigrationSegments(stops, 15);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const perPerson = buildPerPersonMigrationSegments(stops, 15);
    expect(perPerson.length).toBeGreaterThanOrEqual(1);

    const bounds = computeStopsBounds(stops, SITE_CONFIG.mapDefaults);
    expect(bounds).not.toBeNull();
    const emptyDefaultBounds = computeStopsBounds([], SITE_CONFIG.mapDefaults);
    expect(emptyDefaultBounds).not.toBeNull();
    expect(computeStopsBounds([], 1.2)).toBeNull();

    const pt = projectLatLng(40.1, -83.1, { minLat: 39, maxLat: 46, minLng: -123, maxLng: -80 }, 400, 300);
    expect(Number.isFinite(pt.x)).toBe(true);
    expect(Number.isFinite(pt.y)).toBe(true);

    const nearby = projectNearbyPlaces({
      center: riverdale,
      allPlaces: bundle.places,
      width: 300,
      height: 200,
      maxRadiusMiles: 50,
    });
    expect(nearby.some((m) => m.place.id === 'plc_oakton' && m.inRadius)).toBe(true);

    // Map journey state transitions
    const ids = stops.map((s) => s.id);
    expect(journeyNext(MAP_JOURNEY_INITIAL, []).selectedStopId).toBeNull();
    expect(journeyPrev(MAP_JOURNEY_INITIAL, []).selectedStopId).toBeNull();
    expect(journeyTick(MAP_JOURNEY_INITIAL, []).playing).toBe(false);
    expect(journeyScrub(MAP_JOURNEY_INITIAL, 0, []).selectedStopId).toBeNull();
    expect(journeyPlayToggle(MAP_JOURNEY_INITIAL, []).playing).toBe(false);

    let state = journeyPlayToggle(MAP_JOURNEY_INITIAL, ids);
    expect(state.playing).toBe(true);
    expect(state.stepIndex).toBe(0);
    state = journeyTick(state, ids);
    expect(state.stepIndex).toBe(1);
    state = journeyScrub(state, 99, ids);
    expect(state.stepIndex).toBe(ids.length - 1);
    expect(journeyTick(state, ids).playing).toBe(false);
    state = journeyPrev(state, ids);
    expect(state.stepIndex).toBe(ids.length - 2);
    state = journeySelectStop(state, ids[0], ids);
    expect(state.selectedStopId).toBe(ids[0]);
    expect(journeySelectStop(state, 'nonexistent', ids)).toEqual(state);
    expect(journeyReset(state)).toEqual(MAP_JOURNEY_INITIAL);
  });
});

describe('Kinship pathfinding, radar co-presence, and time snapshot behavior', () => {
  it('describes blood & in-law kinship relations and resolves shortest paths, overlaps, and shared places', () => {
    const { bundle, placesById } = buildRichArchiveFixture();

    expect(describeBloodRelation(0, 0)).toBe('Same person');
    expect(describeBloodRelation(1, 0)).toBe('Child of');
    expect(describeBloodRelation(2, 0)).toBe('Grandchild of');
    expect(describeBloodRelation(3, 0)).toBe('Great-Grandchild of');
    expect(describeBloodRelation(4, 0)).toBe('2nd Great-Grandchild of');
    expect(describeBloodRelation(0, 1)).toBe('Parent of');
    expect(describeBloodRelation(0, 2)).toBe('Grandparent of');
    expect(describeBloodRelation(0, 3)).toBe('Great-Grandparent of');
    expect(describeBloodRelation(0, 4)).toBe('2nd Great-Grandparent of');
    expect(describeBloodRelation(1, 1)).toBe('Sibling of');
    expect(describeBloodRelation(1, 2)).toBe('Aunt / Uncle of');
    expect(describeBloodRelation(2, 1)).toBe('Niece / Nephew of');
    expect(describeBloodRelation(1, 3)).toBe('Great-Aunt / Great-Uncle of');
    expect(describeBloodRelation(1, 4)).toBe('2nd Great-Aunt / Uncle of');
    expect(describeBloodRelation(3, 1)).toBe('Great-Niece / Great-Nephew of');
    expect(describeBloodRelation(4, 1)).toBe('2nd Great-Niece / Nephew of');
    expect(describeBloodRelation(2, 2)).toBe('1st Cousin of');
    expect(describeBloodRelation(2, 3)).toBe('1st Cousin once removed of');
    expect(describeBloodRelation(2, 4)).toBe('1st Cousin twice removed of');
    expect(describeBloodRelation(2, 5)).toBe('1st Cousin 3x removed of');

    expect(describeKinshipSteps([])).toBe('Same person');
    expect(describeKinshipSteps([{ fromId: 'a', toId: 'b', relation: 'spouse' }])).toBe('Spouse of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'spouse' },
        { fromId: 'b', toId: 'c', relation: 'child' },
      ])
    ).toBe('Child-in-Law of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'parent' },
        { fromId: 'b', toId: 'c', relation: 'spouse' },
      ])
    ).toBe('Parent-in-Law of');

    const same = findKinshipPath({ fromId: 'per_henry', toId: 'per_henry', bundle, placesById });
    expect(same.connected).toBe(true);
    expect(same.relationshipLabel).toBe('Same person');

    const spousePath = findKinshipPath({ fromId: 'per_henry', toId: 'per_clara', bundle, placesById });
    expect(spousePath.connected).toBe(true);
    expect(spousePath.relationshipLabel).toBe('Spouse of');
    expect(spousePath.overlapYears?.durationYears).toBeGreaterThan(50);
    expect(spousePath.sharedPlaces.some((p) => p.place.id === 'plc_riverdale')).toBe(true);

    const disconnected = findKinshipPath({ fromId: 'per_henry', toId: 'per_isolated', bundle, placesById });
    expect(disconnected.connected).toBe(false);

    const henry = bundle.people.find((p) => p.id === 'per_henry')!;
    const isolated = bundle.people.find((p) => p.id === 'per_isolated')!;
    expect(computeLifeOverlap(henry, isolated, 2026)).not.toBeNull();
  });

  it('computes radar co-presence rings, local/macro context, and polar ring geometry', () => {
    const { bundle, placesById, peopleById } = buildRichArchiveFixture();
    expect(getKinshipInfo(bundle, 'per_henry', 'per_clara').label).toBe('Spouse');
    expect(getKinshipInfo(bundle, 'per_henry', 'per_arthur').label).toBe('Child');
    expect(getKinshipInfo(bundle, 'per_arthur', 'per_henry').label).toBe('Parent');
    expect(getKinshipInfo(bundle, 'per_arthur', 'per_martha').label).toBe('Sibling');
    expect(getKinshipInfo(bundle, 'per_henry', 'per_isolated').label).toBe('Relative');

    expect(computeRadarForEvent(bundle, null, 'per_henry', peopleById, placesById).coPresenceVisible).toEqual(
      []
    );

    const activeEvent = bundle.events.find((e) => e.id === 'evt_1880')!;
    const radar = computeRadarForEvent(bundle, activeEvent, 'per_henry', peopleById, placesById);
    expect(radar.coPresenceVisible.some((c) => c.person.id === 'per_clara' && c.sameHousehold)).toBe(true);
    expect(radar.coPresenceVisible.some((c) => c.person.id === 'per_arthur')).toBe(true);
    expect(radar.localVisible.some((e) => e.id === 'evt_1880_local')).toBe(true);
    expect(radar.macroVisible.some((e) => e.id === 'evt_1880_national')).toBe(true);

    expect(getEventsForPerson(bundle, 'per_henry').length).toBeGreaterThanOrEqual(2);
    expect(findNearestEventForPerson(bundle, 'per_henry', activeEvent.time_min)?.id).toBe('evt_1880');
    expect(findNearestEventForPerson(bundle, 'per_henry', null)).not.toBeNull();
    expect(findNearestEventForPerson(bundle, 'per_isolated', 0)).toBeNull();

    // Polar geometry across all 3 radius bands
    for (const r of [50, 90, 140]) {
      const single = polarPointAvoidingTopLabel(200, 200, r, 0, 1, 0);
      const multi = polarPointAvoidingTopLabel(200, 200, r, 1, 4, 1);
      expect(Number.isFinite(single.x)).toBe(true);
      expect(Number.isFinite(multi.y)).toBe(true);
    }
  });

  it('resolves canonical places, builds time snapshots, place directories, and source text exports', () => {
    const { bundle, placesById, peopleById } = buildRichArchiveFixture();

    // Census artifact "Township 4" resolves up to parent Cedar County
    const canonical = resolveCanonicalPlace(placesById.get('plc_twp4'), placesById);
    expect(canonical?.id).toBe('plc_cedar_county');
    expect(resolveCanonicalPlace(undefined, placesById)).toBeNull();

    const thumbs = buildPersonThumbMap(bundle);
    expect(thumbs.get('per_henry')).toBe('/media/henry.jpg');
    expect(thumbs.get('per_clara')).toBe('/media/doc.jpg');

    const henry = peopleById.get('per_henry')!;
    const isolated = peopleById.get('per_isolated')!;
    expect(isPersonAliveInYear(henry, 1880, [], 2026)).toBe(true);
    expect(isPersonAliveInYear(henry, 1940, [], 2026)).toBe(false);
    expect(isPersonAliveInYear(isolated, 1880, [], 2026)).toBe(true);

    const snapshot = computeTimeSnapshot(bundle, 1880, placesById, 2026);
    expect(snapshot.totalAlive).toBeGreaterThanOrEqual(4);
    expect(snapshot.locatedCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.macroEvents.some((e) => e.id === 'evt_1880_national')).toBe(true);
    if (snapshot.lanes.length >= 2) {
      expect(typeof compareTimeLanes(snapshot.lanes[0], snapshot.lanes[1])).toBe('number');
    }

    const dir = buildPlacesDirectory(bundle, placesById, peopleById, SITE_CONFIG.migrationEras);
    expect(dir.some((entry) => entry.place.id === 'plc_riverdale')).toBe(true);

    // Time year URL param parsing
    expect(parseTimeYearParam(null)).toBeNull();
    expect(parseTimeYearParam('not-a-year')).toBeNull();
    expect(parseTimeYearParam('1500')).toBeNull();
    expect(parseTimeYearParam('1880')).toBe(1880);
    expect(resolveTimeYear('1880', 1900)).toBe(1880);
    expect(resolveTimeYear('bad', 1900)).toBe(1900);

    // Source text export helpers
    expect(formatFileSize(0)).toBe('');
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(4096)).toBe('4 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB');

    const doc = {
      source_id: 'src_history',
      title: 'Cedar County History!',
      author: 'Valley Society',
      pages: [{ page: 1, label: 'Page 1', text: 'Chapter One text.' }],
    };
    expect(buildSourceTextFilename(doc)).toBe('cedar-county-history.txt');
    expect(buildFullSourceText(doc)).toContain('Chapter One text.');
    expect(buildAllSourcesText([doc, doc])).toContain(
      '========================================================================'
    );
  });
});
