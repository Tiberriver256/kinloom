import { describe, expect, it } from 'vitest';
import {
  buildWebManifest,
  formatDeceasedLifespan,
  renderBrandkitHeadTags,
  resolveBrandSpec,
  resolveRouteOgMetadata,
} from './brandkit.js';
import { renderFaviconSvg, renderIconSvg, renderOgCardSvg } from './brandkitSvg.js';
import {
  isPreviewableCitationImage,
  orderNarrativeSources,
  resolveCitationMedia,
  validateNarrativeCitations,
} from './citations.js';
import {
  applyNarrativeEnrichments,
  buildTimedEvent,
  collectUncitedEntityKeys,
  compareArchiveEvents,
  enrichHouseholdDescriptions,
  mergeEventSources,
  resolvePersonBranch,
} from './compile/enrichment.js';
import { compileAndAttachMedia, compilePeopleSummaries } from './compile/mediaAndStats.js';
import { buildExcerpt, searchArchive } from './domain/archiveSearch.js';
import {
  buildLibrarianCitation,
  classifySourceTier,
  findSourceUsages,
  formatConfidenceLabel,
  formatSourceTypeLabel,
  summarizeEventCitations,
} from './domain/citations.js';
import {
  buildMigrationSegments,
  buildMigrationStops,
  buildPerPersonMigrationSegments,
  classifyMigrationStage,
  computeStopsBounds,
  projectNearbyPlaces,
} from './domain/geoMap.js';
import {
  computeLifeOverlap,
  describeBloodRelation,
  describeKinshipSteps,
  findKinshipPath,
} from './domain/kinshipFinder.js';
import {
  buildPersonThumbMap,
  buildPlacesDirectory,
  resolveCanonicalPlace,
} from './domain/placesDirectory.js';
import {
  computeRadarForEvent,
  findNearestEventForPerson,
  getEventsForPerson,
  getKinshipInfo,
} from './domain/radarEngine.js';
import {
  computeTimeSnapshot,
  getSuggestedSnapshotYears,
  isPersonAliveInYear,
  pickDefaultSnapshotYear,
} from './domain/timeSnapshot.js';
import {
  daysSinceEpoch,
  edtfSortKey,
  edtfToBounds,
  edtfYearBounds,
  formatEdtfDisplay,
  intervalsOverlap,
  parseEdtfInterval,
  parseGedcomDateToEdtf,
} from './edtf.js';
import { UNVERIFIED_TREE_SOURCE_ID } from './gedcom/citations.js';
import {
  type EntityLifecycleState,
  transitionBatchRevertLifecycle,
  transitionEntityLifecycle,
} from './machines/entityLifecycle.js';
import { patchCompiledBundle } from './patchArchive.js';
import {
  collectLivingNameHits,
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  compileLivingNameRegex,
  computeSourceMaxYearById,
  extractEarliestEdtfYear,
  extractLatestEdtfYear,
  resolveNarrativeMaxYear,
} from './privacy/livingNameMatcher.js';
import {
  assertMediaAllowedForPrivacy,
  collectLivingNames,
  isPersonLivingPublic,
  PrivacyViolationError,
  redactCompiledPerson,
  redactSinglePerson,
  resolveEffectiveLiving,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
  scrubLivingNames,
  validateMediaForPrivacy,
} from './privacy/policy.js';
import {
  applyPrivacyFilter,
  filterMediaForPrivacy,
  filterNarrativesForPrivacy,
  redactSingleEvent,
  redactSingleNarrative,
} from './privacy/redaction.js';
import {
  applyEntityPatch,
  buildBatchRevertPayloads,
  buildRevertPayload,
  computeEntityDiff,
} from './revisions.js';
import { parseKinloomConfig } from './schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  MediaItem,
  Narrative,
  Person,
  Place,
  RawEvent,
  RawPerson,
  ReadingsBundle,
  ResidenceSpan,
  SourceRecord,
} from './schemas/entities.js';
import {
  getPlaceQualifierSegments,
  inferCountryCodeFromSegments,
  isBareLexiconEntryCompatibleWithPlace,
} from './schemas/pronunciationGeo.js';
import {
  composeLanguageTag,
  composeProvenance,
  findIpaGlyphsInPhonetic,
  findSurnameTokenSpan,
  hasIpaGlyphsInPhonetic,
  hasPronunciationEntryContent,
  isLexiconEntryCompatibleWithPerson,
  lookupLexiconMatch,
  mergePronunciationEntry,
  mergePronunciationLexicons,
  stripIpaDelimiters,
  tokenizePersonName,
} from './schemas/pronunciationPhonetics.js';
import {
  inspectPersonPronunciationTokens,
  resolvePersonPronunciation,
} from './schemas/pronunciationResolve.js';
import type { RevisionRecord } from './schemas/revisions.js';

function makePerson(overrides: Partial<Person> & Pick<Person, 'id' | 'slug' | 'full_name'>): Person {
  return {
    given_name: '',
    surname: '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'extended',
    birth_edtf: '',
    death_edtf: '',
    portrait_url: null,
    birth_year: null,
    death_year: null,
    event_count: 0,
    media_count: 0,
    primary_place_id: null,
    ...overrides,
  };
}

function makeRawPerson(
  overrides: Partial<RawPerson> & Pick<RawPerson, 'id' | 'slug' | 'full_name'>
): RawPerson {
  return {
    given_name: '',
    surname: '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'extended',
    birth_edtf: '',
    death_edtf: '',
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> & Pick<Place, 'id' | 'slug' | 'name' | 'full_name'>): Place {
  return {
    place_type: 'town',
    parent_id: null,
    lat: 40.0,
    lng: -82.0,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ArchiveEvent> & Pick<ArchiveEvent, 'id' | 'title'>): ArchiveEvent {
  return {
    scope: 'personal',
    event_kind: 'point_event',
    category: 'life_milestone',
    edtf_date: '',
    place_id: null,
    summary: '',
    participants: [],
    sources: [],
    display_date: '',
    year: null,
    time_min: null,
    time_max: null,
    ...overrides,
  };
}

function makeRawEvent(overrides: Partial<RawEvent> & Pick<RawEvent, 'id' | 'title'>): RawEvent {
  return {
    scope: 'personal',
    event_kind: 'point_event',
    category: 'life_milestone',
    edtf_date: '',
    place_id: null,
    summary: '',
    participants: [],
    sources: [],
    ...overrides,
  };
}

function makeBundle(overrides: Partial<ArchiveBundle> = {}): ArchiveBundle {
  return {
    meta: {
      version: '1.0',
      generated_at: '2026-01-01T00:00:00Z',
      build_mode: 'public',
      counts: {
        people: 0,
        living_redacted: 0,
        events: 0,
        places: 0,
        sources: 0,
        media: 0,
        residence_spans: 0,
      },
    },
    people: [],
    places: [],
    place_ancestors: {},
    events: [],
    residence_spans: [],
    kinship: [],
    sources: [],
    media: [],
    narratives: [],
    ...overrides,
  };
}

describe('domain/timeSnapshot branch coverage', () => {
  it('evaluates isPersonAliveInYear across all birth/death/event-year/living-redacted branches', () => {
    const redacted = makePerson({
      id: 'p1',
      slug: 'p1',
      full_name: 'Living',
      is_living: true,
      birth_year: 1990,
    });
    expect(isPersonAliveInYear(redacted, 2000, [], 2026)).toBe(false);

    const birthOnly = makePerson({ id: 'p2', slug: 'p2', full_name: 'Arthur Alder', birth_year: 1850 });
    expect(isPersonAliveInYear(birthOnly, 1900, [], 2026)).toBe(true);
    expect(isPersonAliveInYear(birthOnly, 1940, [], 2026)).toBe(false);

    const deathOnly = makePerson({ id: 'p3', slug: 'p3', full_name: 'Beatrice Birch', death_year: 1900 });
    expect(isPersonAliveInYear(deathOnly, 1850, [], 2026)).toBe(true);
    expect(isPersonAliveInYear(deathOnly, 1820, [], 2026)).toBe(false);

    const eventOnly = makePerson({ id: 'p4', slug: 'p4', full_name: 'Charles Cedar' });
    expect(isPersonAliveInYear(eventOnly, 1882, [1880], 2026)).toBe(true);
    expect(isPersonAliveInYear(eventOnly, 1890, [1880], 2026)).toBe(false);
    expect(isPersonAliveInYear(eventOnly, 1880, [], 2026)).toBe(false);
  });

  it('computes snapshot across exact, span, nearest-event, unlocated, local, and macro branches', () => {
    const usa = makePlace({
      id: 'plc_usa',
      slug: 'usa',
      name: 'USA',
      full_name: 'USA',
      place_type: 'country',
    });
    const ohio = makePlace({
      id: 'plc_ohio',
      slug: 'ohio',
      name: 'Ohio',
      full_name: 'Ohio, USA',
      place_type: 'state',
      parent_id: 'plc_usa',
    });
    const harbor = makePlace({
      id: 'plc_harbor',
      slug: 'harbor',
      name: 'Harbor',
      full_name: 'Harbor, Ohio, USA',
      place_type: 'town',
      parent_id: 'plc_ohio',
    });
    const cedar = makePlace({
      id: 'plc_cedar',
      slug: 'cedar',
      name: 'Cedar',
      full_name: 'Cedar, Ohio, USA',
      place_type: 'town',
      parent_id: 'plc_ohio',
    });

    const pRedacted = makePerson({
      id: 'p_liv',
      slug: 'liv',
      full_name: 'Living',
      is_living: true,
      birth_year: 1990,
    });
    const pExactLong = makePerson({
      id: 'p_exact',
      slug: 'exact',
      full_name: 'Arthur Alder',
      birth_year: 1850,
      death_year: 1920,
    });
    const pSpanClose = makePerson({
      id: 'p_span_close',
      slug: 'span-close',
      full_name: 'Beatrice Birch',
      birth_year: 1855,
      death_year: 1925,
    });
    const pSpanSameYr = makePerson({
      id: 'p_span_same',
      slug: 'span-same',
      full_name: 'Clara Cedar',
      birth_year: null,
      death_year: 1910,
    });
    const pSpanFar = makePerson({
      id: 'p_span_far',
      slug: 'span-far',
      full_name: 'Dora Dale',
      birth_year: 1860,
      death_year: 1930,
    });
    const pNearInferred = makePerson({
      id: 'p_near_inf',
      slug: 'near-inf',
      full_name: 'Eli Elm',
      birth_year: 1852,
      death_year: 1920,
    });
    const pNearPossibleFuture = makePerson({
      id: 'p_near_pos',
      slug: 'near-pos',
      full_name: 'Faye Fern',
      birth_year: 1852,
      death_year: 1920,
    });
    const pUnlocSameYr = makePerson({
      id: 'p_unloc_1',
      slug: 'unloc-1',
      full_name: 'George Grove',
      birth_year: null,
      death_year: 1910,
    });
    const pUnlocSpan = makePerson({
      id: 'p_unloc_2',
      slug: 'unloc-2',
      full_name: 'Helen Hill',
      birth_year: 1850,
      death_year: 1920,
    });
    const pUnlocBare = makePerson({
      id: 'p_unloc_3',
      slug: 'unloc-3',
      full_name: 'Ivan Ivy',
      birth_year: null,
      death_year: 1910,
    });

    const longSentence =
      'Arthur Alder established the Harbor dockyard and recorded every cargo manifest across the entire western lakefront during the autumn shipping season of eighteen eighty without missing a single ledger entry.';

    const events: ArchiveEvent[] = [
      makeEvent({
        id: 'ev_exact',
        title: 'Arthur Alder established dockyard',
        summary: longSentence,
        year: 1880,
        place_id: 'plc_harbor',
        participants: [{ person_id: 'p_exact', role: 'subject' }],
      }),
      makeEvent({
        id: 'ev_span_undated',
        title: 'Undated note',
        year: null,
        participants: [{ person_id: 'p_span_close', role: 'subject' }],
      }),
      makeEvent({
        id: 'ev_span_1882',
        title: 'Beatrice Birch farm',
        summary: 'Archival residence record places Beatrice in Harbor.',
        display_date: '',
        year: 1882,
        place_id: 'plc_harbor',
        participants: [{ person_id: 'p_span_close', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_span_same_yr_no_place',
        title: 'Clara Cedar ran',
        summary: '',
        year: 1880,
        place_id: null,
        participants: [{ person_id: 'p_span_same', role: 'subject' }],
      }),
      makeEvent({
        id: 'ev_near_past',
        title: '',
        summary: 'Archival residence record places Eli in Harbor.',
        display_date: '1876',
        year: 1876,
        place_id: 'plc_harbor',
        participants: [{ person_id: 'p_near_inf', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_near_same_no_place',
        title: 'Eli Elm census',
        summary: 'Short note.',
        year: 1880,
        place_id: null,
        participants: [{ person_id: 'p_near_inf', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_near_future',
        title: 'Faye Fern moved',
        summary: 'Arrived in Cedar.',
        year: 1890,
        place_id: 'plc_cedar',
        participants: [{ person_id: 'p_near_pos', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_unloc_same',
        title: 'George Grove letter',
        summary: '',
        year: 1880,
        place_id: null,
        participants: [{ person_id: 'p_unloc_1', role: 'subject' }],
      }),
      // Local/state events
      makeEvent({
        id: 'ev_loc_harbor',
        scope: 'local',
        title: 'Harbor Fair',
        year: 1880,
        place_id: 'plc_harbor',
        place_ancestors: ['plc_ohio', 'plc_usa'],
      }),
      makeEvent({
        id: 'ev_loc_ohio_via_anc',
        scope: 'state',
        title: 'Ohio Canal Act',
        year: 1881,
        place_id: 'plc_cedar',
        place_ancestors: ['plc_ohio', 'plc_usa'],
      }),
      makeEvent({
        id: 'ev_loc_country_excluded',
        scope: 'local',
        title: 'Country Level Ignored',
        year: 1880,
        place_id: 'plc_usa',
      }),
      // Macro events
      makeEvent({
        id: 'ev_macro_undated',
        scope: 'national',
        title: 'Undated National',
        year: null,
      }),
      makeEvent({
        id: 'ev_macro_span',
        scope: 'global',
        event_kind: 'context_span',
        title: 'Industrial Era',
        year: 1875,
        time_min: daysSinceEpoch(1875, 1, 1),
        time_max: daysSinceEpoch(1885, 12, 31),
        severity_rank: null,
      }),
      makeEvent({
        id: 'ev_macro_exact_high',
        scope: 'national',
        title: '1880 Census Act',
        year: 1880,
        severity_rank: 2,
      }),
      makeEvent({
        id: 'ev_macro_exact_low',
        scope: 'national',
        title: '1880 Tariff',
        year: 1880,
        severity_rank: 8,
      }),
      makeEvent({
        id: 'ev_macro_adj',
        scope: 'global',
        title: '1881 Treaty',
        year: 1881,
        severity_rank: 1,
      }),
    ];

    const spans: ResidenceSpan[] = [
      {
        id: 'sp1',
        person_id: 'p_span_close',
        place_id: 'plc_harbor',
        time_min: daysSinceEpoch(1870, 1, 1),
        time_max: daysSinceEpoch(1890, 12, 31),
        start_year: 1870,
        end_year: 1890,
        confidence_tier: 'Possible',
        from_event_id: 'ev_span_1882',
        to_event_id: 'ev_span_1882',
      },
      {
        id: 'sp2',
        person_id: 'p_span_close',
        place_id: 'plc_harbor',
        time_min: daysSinceEpoch(1878, 1, 1),
        time_max: daysSinceEpoch(1883, 12, 31),
        start_year: 1878,
        end_year: 1883,
        confidence_tier: 'Confirmed',
        from_event_id: 'ev_span_1882',
        to_event_id: 'ev_span_1882',
      },
      {
        id: 'sp3',
        person_id: 'p_span_close',
        place_id: 'plc_harbor',
        time_min: daysSinceEpoch(1875, 1, 1),
        time_max: daysSinceEpoch(1885, 12, 31),
        start_year: 1875,
        end_year: 1885,
        confidence_tier: 'Confirmed',
        from_event_id: 'ev_span_1882',
        to_event_id: 'ev_span_1882',
      },
      {
        id: 'sp4',
        person_id: 'p_span_same',
        place_id: 'plc_harbor',
        time_min: daysSinceEpoch(1875, 1, 1),
        time_max: daysSinceEpoch(1885, 12, 31),
        start_year: 1875,
        end_year: 1885,
        confidence_tier: 'Inferred',
        from_event_id: 'ev_span_same_yr_no_place',
        to_event_id: 'ev_span_same_yr_no_place',
      },
      {
        id: 'sp5',
        person_id: 'p_span_far',
        place_id: 'plc_harbor',
        time_min: daysSinceEpoch(1870, 1, 1),
        time_max: daysSinceEpoch(1890, 12, 31),
        start_year: 1870,
        end_year: 1890,
        confidence_tier: 'Possible',
        from_event_id: 'ev_span_far_origin',
        to_event_id: 'ev_span_far_origin',
      },
    ];

    const places = [usa, ohio, harbor, cedar];
    const placesById = new Map(places.map((p) => [p.id, p]));
    const bundle = makeBundle({
      people: [
        pRedacted,
        pExactLong,
        pSpanClose,
        pSpanSameYr,
        pSpanFar,
        pNearInferred,
        pNearPossibleFuture,
        pUnlocSameYr,
        pUnlocSpan,
        pUnlocBare,
      ],
      places,
      place_ancestors: {
        plc_harbor: ['plc_ohio', 'plc_usa'],
        plc_cedar: ['plc_ohio', 'plc_usa'],
      },
      events,
      residence_spans: spans,
    });

    const snap = computeTimeSnapshot(bundle, 1880, placesById, 2026);
    expect(snap.totalAlive).toBe(9);
    expect(snap.locatedCount).toBe(6);
    expect(snap.unlocatedCount).toBe(3);

    const harborLane = snap.lanes.find((l) => l.place.id === 'plc_harbor');
    expect(harborLane?.people.map((e) => e.person.id)).toEqual([
      'p_exact',
      'p_near_inf',
      'p_span_same',
      'p_span_close',
      'p_span_far',
    ]);
    expect(harborLane?.people[0]?.activityTitle).toBe('Established dockyard');
    expect(harborLane?.people[0]?.activityNote.endsWith('…')).toBe(true);
    expect(harborLane?.people[3]?.activityNote).toContain('Resided in Harbor');
    expect(harborLane?.people[4]?.nearestEventId).toBe('ev_span_far_origin');
    expect(harborLane?.localEvents.map((e) => e.id)).toEqual(['ev_loc_harbor', 'ev_loc_ohio_via_anc']);

    const cedarLane = snap.lanes.find((l) => l.place.id === 'plc_cedar');
    expect(cedarLane?.people[0]?.tier).toBe('Possible');
    expect(cedarLane?.people[0]?.activityNote).toContain('Recorded in 1890');

    expect(snap.unlocatedPeople.map((u) => u.person.id)).toEqual(['p_unloc_2', 'p_unloc_1', 'p_unloc_3']);
    expect(snap.unlocatedPeople[0]?.activityNote).toContain('1850–1920');
    expect(snap.unlocatedPeople[2]?.activityNote).toContain('No specific town');

    expect(snap.macroEvents.map((e) => e.id)).toEqual([
      'ev_macro_exact_high',
      'ev_macro_exact_low',
      'ev_macro_adj',
      'ev_macro_span',
    ]);

    expect(pickDefaultSnapshotYear(makeBundle(), placesById)).toBe(1900);
    const markers = getSuggestedSnapshotYears(bundle, placesById, [
      { year: 1800, label: 'Early' },
      { year: 1880, label: 'Peak' },
    ]);
    expect(markers).toHaveLength(1);
    expect(pickDefaultSnapshotYear(bundle, placesById, [{ year: 1860, label: 'Pre-modern' }])).toBe(1860);
  });
});

describe('compile/enrichment and compile/mediaAndStats branch coverage', () => {
  it('merges event sources, resolves branches, sorts events, collects uncited keys, and enriches households', () => {
    const merged = mergeEventSources(
      [
        { source_id: '', confidence: 'low' },
        { source_id: 'src_1', confidence: 'low', citation_detail: 'p. 1' },
      ],
      [
        {
          source_id: 'src_1',
          confidence: 'high',
          claimed_date: '1880',
          citation_detail: 'p. 2',
          scan_url: '/scans/1.jpg',
          scan_title: '1880 Census',
        },
        {
          source_id: 'src_1',
          confidence: 'medium',
          claimed_date: '',
          citation_detail: '',
          scan_url: '',
          scan_title: '',
        },
      ]
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      source_id: 'src_1',
      confidence: 'medium',
      claimed_date: '1880',
      citation_detail: 'p. 2',
      scan_url: '/scans/1.jpg',
      scan_title: '1880 Census',
    });

    const config = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_ARCHIVE' },
      branches: [
        { id: 'alder_line', label: 'Alder', surnames: ['Alder'], lineageGroups: ['direct'] },
        { id: 'other', label: 'Other', surnames: [], lineageGroups: [] },
      ],
    });
    expect(
      resolvePersonBranch({ branch: 'custom', surname: 'Birch', lineage_group: 'extended' }, config)
    ).toBe('custom');
    expect(resolvePersonBranch({ surname: 'Birch', lineage_group: 'direct' }, config)).toBe('alder_line');
    expect(resolvePersonBranch({ surname: 'Alder', lineage_group: 'extended' }, config)).toBe('alder_line');
    expect(resolvePersonBranch({ surname: 'Cedar', lineage_group: 'extended' }, config)).toBe('alder_line');

    const sortedEvents = [
      { id: 'b', time_min: null, severity_rank: 5 },
      { id: 'a', time_min: 100, severity_rank: 2 },
      { id: 'c', time_min: 100, severity_rank: 8 },
      { id: 'd', time_min: 100, severity_rank: 8 },
      { id: 'e', time_min: 50, severity_rank: null },
    ].toSorted(compareArchiveEvents);
    expect(sortedEvents.map((e) => e.id)).toEqual(['e', 'c', 'd', 'a', 'b']);

    const timedUndated = buildTimedEvent(makeRawEvent({ id: 'ev_u', title: 'Undated' }), {});
    expect(timedUndated.time_min).toBeNull();
    expect(timedUndated.place_ancestors).toEqual([]);
    const timedDated = buildTimedEvent(
      makeRawEvent({ id: 'ev_d', title: 'Dated', edtf_date: '1880', place_id: 'plc_harbor' }),
      { plc_harbor: ['plc_ohio'] }
    );
    expect(timedDated.year).toBe(1880);
    expect(timedDated.place_ancestors).toEqual(['plc_ohio']);

    expect(
      collectUncitedEntityKeys({
        people: [{ id: 'p1', has_primary_source: false }],
        events: [{ id: 'e1', has_primary_source: true }],
        places: [{ id: 'pl1', has_primary_source: false }],
        sources: [{ id: 's1', has_primary_source: false }],
      })
    ).toEqual(['person:p1', 'place:pl1', 'source:s1']);

    const rawEvents: RawEvent[] = [
      makeRawEvent({
        id: 'ev_1',
        title: 'Original',
        event_kind: 'residence_anchor',
        edtf_date: '1880',
        summary: 'Archival residence record places Arthur in Harbor',
        participants: [{ person_id: 'p1', role: 'resident' }],
      }),
    ];
    applyNarrativeEnrichments(rawEvents, undefined);
    applyNarrativeEnrichments(rawEvents, [
      { override_event_id: 'missing_ev', title: 'Ignored' },
      {
        override_event_id: 'ev_1',
        title: 'Updated Title',
        summary: 'Archival residence record places Arthur in Harbor',
        category: 'homestead',
        severity_rank: 7,
        photo_url: '/photos/1.jpg',
        photo_placeholder_caption: 'Harbor house',
        sources: [{ source_id: 'src_1', confidence: 'high' }],
        alternate_dates: [{ edtf_date: '1881', source_id: 'src_1', note: 'Alt' }],
        alternate_places: [{ place_name: 'Cedar', source_id: 'src_1', note: 'Alt place' }],
        fact_conflicts: [{ claim: '1882', source_id: 'src_1', note: 'Conflict' }],
      },
      makeRawEvent({ id: 'ev_added', title: 'Added Event' }),
    ]);
    expect(rawEvents).toHaveLength(2);
    expect(rawEvents[0]?.title).toBe('Updated Title');
    expect(rawEvents[0]?.fact_conflicts).toHaveLength(1);

    const rawPeople: RawPerson[] = [
      makeRawPerson({ id: 'p1', slug: 'p1', full_name: 'Arthur Alder', gedcom_xref: '@I100@' }),
      makeRawPerson({
        id: 'p2',
        slug: 'p2',
        full_name: 'Living Relative',
        is_living: true,
        gedcom_xref: '@I200@',
      }),
    ];
    const householdEvents: RawEvent[] = [
      rawEvents[0]!,
      makeRawEvent({ id: 'ev_pt', title: 'Point', event_kind: 'point_event' }),
      makeRawEvent({ id: 'ev_nopart', title: 'No part', event_kind: 'residence_anchor' }),
      makeRawEvent({
        id: 'ev_liv',
        title: 'Living',
        event_kind: 'residence_anchor',
        participants: [{ person_id: 'p2', role: 'resident' }],
      }),
      makeRawEvent({
        id: 'ev_undated_resi',
        title: 'Undated',
        event_kind: 'residence_anchor',
        participants: [{ person_id: 'p1', role: 'resident' }],
      }),
      makeRawEvent({
        id: 'ev_other_summary',
        title: 'Other summary',
        event_kind: 'residence_anchor',
        edtf_date: '1880',
        summary: 'Custom prose',
        participants: [{ person_id: 'p1', role: 'resident' }],
      }),
    ];
    expect(enrichHouseholdDescriptions(householdEvents, rawPeople, [])).toBe(0);
    const enrichedCount = enrichHouseholdDescriptions(householdEvents, rawPeople, [
      { personId: '', events: [] },
      {
        personId: '100:tree',
        events: [{ type: 'Residence', date: '1880', description: 'Head of household, Blacksmith' }],
      },
    ]);
    expect(enrichedCount).toBe(1);
    expect(householdEvents[0]?.summary).toContain('Head of household, Blacksmith');
    // Second pass skips duplicate description
    expect(
      enrichHouseholdDescriptions(householdEvents, rawPeople, [
        {
          personId: '100:tree',
          events: [{ type: 'Residence', date: '1880', description: 'Head of household, Blacksmith' }],
        },
      ])
    ).toBe(0);
  });

  it('covers compilePeopleSummaries dedup and compileAndAttachMedia overlay/thumb/privacy paths', () => {
    const rawPeople = [
      makeRawPerson({ id: 'p1', slug: 'p1', full_name: 'Arthur Alder' }),
      makeRawPerson({
        id: 'p2',
        slug: 'p2',
        full_name: 'Living Person',
        is_living: true,
        portrait_url: '/media/liv.jpg',
      }),
    ];
    const events = [
      makeEvent({
        id: 'ev1',
        title: 'Birth',
        place_id: 'plc_harbor',
        participants: [
          { person_id: 'p1', role: 'subject' },
          { person_id: 'p1', role: 'witness' },
        ],
      }),
      makeEvent({
        id: 'ev2',
        title: 'Residence',
        participants: [{ person_id: 'p1', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_liv',
        title: 'Living event',
        participants: [{ person_id: 'p2', role: 'subject' }],
      }),
    ];

    const compiledPeople = compilePeopleSummaries(rawPeople, events);
    expect(compiledPeople[0]?.event_count).toBe(2);

    const media: MediaItem[] = [
      { id: 'm_bad_kind', kind: 'record_scan', file: '', caption: 'Skip', person_id: 'p1' },
      { id: 'm_dup', kind: 'portrait', file: '/media/p1.jpg', caption: 'Dup', person_id: 'p1' },
      { id: 'm_missing', kind: 'portrait', file: '/media/missing.jpg', caption: 'Missing', person_id: 'p1' },
      {
        id: 'm_hero',
        kind: 'family_photo',
        file: '/media/ev2.jpg',
        caption: 'Harbor photo',
        event_id: 'ev2',
        person_id: 'p1',
      },
    ];
    const overlayMedia: MediaItem[] = [
      { id: 'm_dup', kind: 'portrait', file: '/media/p1.jpg', caption: 'Overlay caption', person_id: 'p1' },
      { id: 'm_ov_missing', kind: 'portrait', file: '/media/gone.jpg', caption: 'Gone', person_id: 'p1' },
    ];

    const finalMedia = compileAndAttachMedia({
      compiledPeople,
      sortedEvents: events,
      peopleById: new Map(compiledPeople.map((p) => [p.id, p])),
      eventsById: new Map(events.map((e) => [e.id, e])),
      livingIds: new Set(['p2']),
      stripLivingPortraits: true,
      compiledMediaOverlay: {
        media: overlayMedia,
        people: [{ id: 'p1', portrait_url: '/media/p1.jpg' }],
        events: [{ id: 'ev1', photo_url: '/media/p1.jpg' }],
      },
      media,
      mediaExists: (url) => url !== '/media/missing.jpg' && url !== '/media/gone.jpg',
      resolveThumbUrl: (url) => (url === '/media/p1.jpg' ? '/media/p1_thumb.jpg' : undefined),
    });

    expect(finalMedia.map((m) => m.id)).toEqual(['m_dup', 'm_hero']);
    expect(compiledPeople[0]?.portrait_url).toBe('/media/p1.jpg');
    expect(compiledPeople[0]?.thumb_url).toBe('/media/p1_thumb.jpg');
    expect(compiledPeople[1]?.portrait_url).toBeNull();
    expect(events[0]?.photo_placeholder_caption).toBe('Overlay caption');
    expect(events[1]?.photo_url).toBe('/media/ev2.jpg');
    expect(events[2]?.photo_url).toBeUndefined();
  });
});

describe('domain/radarEngine branch coverage', () => {
  it('computes kinship info, spatial matching variants, radar sorting, and nearest event lookup', () => {
    const usa = makePlace({
      id: 'plc_usa',
      slug: 'usa',
      name: 'USA',
      full_name: 'USA',
      place_type: 'country',
      lat: 39,
      lng: -98,
    });
    const ohio = makePlace({
      id: 'plc_ohio',
      slug: 'ohio',
      name: 'Ohio',
      full_name: 'Ohio',
      place_type: 'state',
      parent_id: 'plc_usa',
      lat: 40,
      lng: -82.5,
    });
    const county = makePlace({
      id: 'plc_cedar_county',
      slug: 'cedar-county',
      name: 'Cedar County',
      full_name: 'Cedar County, Ohio',
      place_type: 'county',
      parent_id: 'plc_ohio',
      lat: 40,
      lng: -82,
    });
    const harbor = makePlace({
      id: 'plc_harbor',
      slug: 'harbor',
      name: 'Harbor',
      full_name: 'Harbor, Cedar County, Ohio',
      place_type: 'town',
      parent_id: 'plc_cedar_county',
      lat: 40.0,
      lng: -82.0,
    });
    const nearby = makePlace({
      id: 'plc_near',
      slug: 'near',
      name: 'Nearville',
      full_name: 'Nearville, Ohio',
      place_type: 'town',
      parent_id: 'plc_ohio',
      lat: 40.05,
      lng: -82.05,
    });
    const sameCountyFar = makePlace({
      id: 'plc_far_county',
      slug: 'far-county',
      name: 'Far Corner',
      full_name: 'Far Corner, Cedar County, Ohio',
      place_type: 'town',
      parent_id: 'plc_cedar_county',
      lat: 41.0,
      lng: -83.0,
    });
    const farState = makePlace({
      id: 'plc_far_state',
      slug: 'far-state',
      name: 'Oregon',
      full_name: 'Oregon',
      place_type: 'state',
      parent_id: 'plc_usa',
      lat: 44,
      lng: -120,
    });

    const pFocus = makePerson({ id: 'p_focus', slug: 'focus', full_name: 'Arthur Alder' });
    const pParent = makePerson({ id: 'p_parent', slug: 'parent', full_name: 'Thomas Alder' });
    const pChild = makePerson({ id: 'p_child', slug: 'child', full_name: 'Henry Alder' });
    const pSibling = makePerson({ id: 'p_sibling', slug: 'sibling', full_name: 'Clara Alder' });
    const pSpouse = makePerson({ id: 'p_spouse', slug: 'spouse', full_name: 'Martha Birch' });
    const pOther = makePerson({ id: 'p_other', slug: 'other', full_name: 'Owen Mercer' });

    const t1880 = daysSinceEpoch(1880, 6, 1);
    const activeEvent = makeEvent({
      id: 'ev_active',
      title: 'Residence',
      place_id: 'plc_harbor',
      place_ancestors: ['plc_cedar_county', 'plc_ohio', 'plc_usa'],
      time_min: t1880,
      time_max: t1880,
      participants: [
        { person_id: 'p_focus', role: 'resident' },
        { person_id: 'p_missing', role: 'witness' },
      ],
    });

    const events: ArchiveEvent[] = [
      activeEvent,
      makeEvent({
        id: 'ev_spouse_inferred',
        title: 'Spouse arrival',
        place_id: 'plc_harbor',
        time_min: t1880 + 100,
        time_max: t1880 + 100,
        participants: [{ person_id: 'p_spouse', role: 'spouse' }],
      }),
      makeEvent({
        id: 'ev_spouse_confirmed',
        title: 'Spouse exact',
        place_id: 'plc_harbor',
        time_min: t1880,
        time_max: t1880,
        participants: [{ person_id: 'p_spouse', role: 'household' }],
      }),
      makeEvent({
        id: 'ev_near',
        title: 'Parent nearby',
        place_id: 'plc_near',
        time_min: t1880,
        time_max: t1880,
        participants: [{ person_id: 'p_parent', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_same_county',
        title: 'Sibling same county',
        place_id: 'plc_far_county',
        place_ancestors: ['plc_cedar_county', 'plc_ohio', 'plc_usa'],
        time_min: t1880,
        time_max: t1880,
        participants: [{ person_id: 'p_sibling', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_far_nomatch',
        title: 'Far away',
        place_id: 'plc_far_state',
        time_min: t1880,
        time_max: t1880,
        participants: [{ person_id: 'p_other', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_undated_focus',
        title: 'Undated',
        time_min: null,
        time_max: null,
        participants: [{ person_id: 'p_focus', role: 'subject' }],
      }),
      makeEvent({
        id: 'ev_local_ok',
        scope: 'local',
        title: 'County Fair',
        place_id: 'plc_cedar_county',
        time_min: t1880,
        time_max: t1880,
        severity_rank: 5,
      }),
      makeEvent({
        id: 'ev_local_anc',
        scope: 'state',
        title: 'State Fair',
        place_id: 'plc_near',
        place_ancestors: ['plc_ohio', 'plc_usa'],
        time_min: t1880,
        time_max: t1880,
        severity_rank: 3,
      }),
      makeEvent({
        id: 'ev_local_noplace',
        scope: 'local',
        title: 'No place',
        place_id: null,
        time_min: t1880,
        time_max: t1880,
      }),
      makeEvent({
        id: 'ev_local_old',
        scope: 'local',
        title: 'Old local',
        place_id: 'plc_cedar_county',
        time_min: t1880 - 2000,
        time_max: t1880 - 2000,
      }),
      makeEvent({
        id: 'ev_macro',
        scope: 'national',
        title: 'Census',
        time_min: t1880,
        time_max: t1880,
        severity_rank: 7,
      }),
    ];

    const spans: ResidenceSpan[] = [
      {
        id: 'sp_child',
        person_id: 'p_child',
        place_id: 'plc_harbor',
        time_min: t1880 - 100,
        time_max: t1880 + 100,
        start_year: 1879,
        end_year: 1881,
        confidence_tier: 'Inferred',
        from_event_id: 'ev_active',
        to_event_id: 'ev_active',
      },
      {
        id: 'sp_nomatch_time',
        person_id: 'p_other',
        place_id: 'plc_harbor',
        time_min: t1880 - 5000,
        time_max: t1880 - 4000,
        start_year: 1865,
        end_year: 1868,
        confidence_tier: 'Possible',
        from_event_id: 'ev_active',
        to_event_id: 'ev_active',
      },
      {
        id: 'sp_nomatch_place',
        person_id: 'p_other',
        place_id: 'plc_far_state',
        time_min: t1880 - 10,
        time_max: t1880 + 10,
        start_year: 1880,
        end_year: 1880,
        confidence_tier: 'Possible',
        from_event_id: 'ev_active',
        to_event_id: 'ev_active',
      },
    ];

    const people = [pFocus, pParent, pChild, pSibling, pSpouse, pOther];
    const places = [usa, ohio, county, harbor, nearby, sameCountyFar, farState];
    const bundle = makeBundle({
      people,
      places,
      place_ancestors: { plc_harbor: ['plc_cedar_county', 'plc_ohio', 'plc_usa'] },
      events,
      residence_spans: spans,
      kinship: [
        { from: 'p_focus', to: 'p_spouse', relation: 'spouse' },
        { from: 'p_focus', to: 'p_child', relation: 'parent' },
        { from: 'p_focus', to: 'p_parent', relation: 'child' },
        { from: 'p_sibling', to: 'p_parent', relation: 'child' },
      ],
    });

    expect(getKinshipInfo(bundle, 'p_focus', 'p_spouse')).toEqual({ label: 'Spouse', rank: 1 });
    expect(getKinshipInfo(bundle, 'p_focus', 'p_child')).toEqual({ label: 'Child', rank: 1 });
    expect(getKinshipInfo(bundle, 'p_focus', 'p_parent')).toEqual({ label: 'Parent', rank: 1 });
    expect(getKinshipInfo(bundle, 'p_focus', 'p_sibling')).toEqual({ label: 'Sibling', rank: 2 });
    expect(getKinshipInfo(bundle, 'p_focus', 'p_other')).toEqual({ label: 'Relative', rank: 3 });

    const peopleById = new Map(people.map((p) => [p.id, p]));
    const placesById = new Map(places.map((p) => [p.id, p]));

    expect(computeRadarForEvent(bundle, null, 'p_focus', peopleById, placesById).coPresenceVisible).toEqual(
      []
    );

    const radar = computeRadarForEvent(bundle, activeEvent, 'p_focus', peopleById, placesById);
    expect(radar.coPresenceVisible.map((c) => c.person.id)).toEqual([
      'p_spouse',
      'p_child',
      'p_parent',
      'p_sibling',
    ]);
    expect(radar.coPresenceVisible[0]?.tier).toBe('Confirmed');
    expect(radar.localVisible.map((e) => e.id)).toEqual(['ev_local_ok', 'ev_local_anc']);
    expect(radar.macroVisible.map((e) => e.id)).toEqual(['ev_macro']);

    expect(getEventsForPerson(bundle, 'p_focus')).toHaveLength(2);
    expect(findNearestEventForPerson(bundle, 'p_nobody', t1880)).toBeNull();
    expect(findNearestEventForPerson(bundle, 'p_focus', null)?.id).toBe('ev_active');
    expect(findNearestEventForPerson(bundle, 'p_focus', t1880 + 10)?.id).toBe('ev_active');
  });
});

describe('edtf branch coverage', () => {
  it('covers parseEdtfInterval, edtfToBounds, edtfYearBounds, formatEdtfDisplay, and parseGedcomDateToEdtf edge cases', () => {
    expect(parseEdtfInterval(123)).toBeNull();
    expect(parseEdtfInterval('   ')).toBeNull();
    expect(parseEdtfInterval('not-a-date')).toBeNull();
    expect(parseEdtfInterval('1880/1890/1900')).toBeNull();
    expect(parseEdtfInterval('/')).toBeNull();
    expect(parseEdtfInterval('../..')).toBeNull();
    expect(parseEdtfInterval('bad/1890')).toBeNull();
    expect(parseEdtfInterval('1880/bad')).toBeNull();
    expect(parseEdtfInterval('1900/1880')).toBeNull();
    expect(parseEdtfInterval('../1890')).toMatchObject({ year: 1890, startMs: Number.NEGATIVE_INFINITY });
    expect(parseEdtfInterval('1880/..')).toMatchObject({ year: 1880, endMs: Number.POSITIVE_INFINITY });
    expect(parseEdtfInterval('189X')).toMatchObject({ year: 1890, precision: 'decade' });
    expect(parseEdtfInterval('1890-05~')).toMatchObject({ year: 1890, month: 5, approximate: true });

    expect(edtfToBounds('   ')).toBeNull();
    expect(edtfToBounds('bad')).toBeNull();
    expect(edtfToBounds('bad/bad')).toBeNull();
    expect(edtfToBounds('/1890')).not.toBeNull();
    expect(edtfToBounds('1880/')).not.toBeNull();
    expect(edtfToBounds('1880-05-12~')).not.toBeNull();
    expect(edtfToBounds('1880-05-12?')).not.toBeNull();
    expect(edtfToBounds('1880-05~')).not.toBeNull();
    expect(edtfToBounds('1880~')).not.toBeNull();

    expect(edtfYearBounds('circa 1875 maybe')).toEqual([1875, 1875]);
    expect(edtfYearBounds('no year at all')).toBeNull();
    expect(edtfSortKey('invalid')).toBe(Number.MAX_SAFE_INTEGER);
    expect(edtfSortKey('1880')).toBe(daysSinceEpoch(1880, 1, 1));

    expect(formatEdtfDisplay('   ')).toBe('Undated');
    expect(formatEdtfDisplay('/1890')).toBe('Bef. 1890');
    expect(formatEdtfDisplay('1890/')).toBe('Aft. 1890');
    expect(formatEdtfDisplay('1880/1890')).toBe('1880–1890');
    expect(formatEdtfDisplay('1880~')).toBe('c. 1880');
    expect(formatEdtfDisplay('1880?')).toBe('est. 1880');
    expect(formatEdtfDisplay('1880-13-01')).toBe('1880-13-01');
    expect(formatEdtfDisplay('1880-13')).toBe('1880-13');
    expect(formatEdtfDisplay('1880-05-12')).toBe('May 12, 1880');
    expect(formatEdtfDisplay('1880-05')).toBe('May 1880');

    expect(parseGedcomDateToEdtf('')).toBe('');
    expect(parseGedcomDateToEdtf('   ')).toBe('');
    expect(parseGedcomDateToEdtf('15 JAN 1620/1')).toBe('1621-01-15');
    expect(parseGedcomDateToEdtf('JAN 1620/1')).toBe('1621-01');
    expect(parseGedcomDateToEdtf('15 FOO 1620/1')).toBe('1620');
    expect(parseGedcomDateToEdtf('15 FOO 1880')).toBe('1880');
    expect(parseGedcomDateToEdtf('MAY 12, 1880')).toBe('1880-05-12');
    expect(parseGedcomDateToEdtf('FOO 12, 1880')).toBe('1880');
    expect(parseGedcomDateToEdtf('FOO 1880')).toBe('1880');
    expect(parseGedcomDateToEdtf('1880-05-12')).toBe('1880-05-12');
    expect(parseGedcomDateToEdtf('unknown')).toBe('');
    expect(parseGedcomDateToEdtf('BET 1880 AND unknown')).toBe('1880');
    expect(parseGedcomDateToEdtf('BET unknown AND 1890')).toBe('1890');
    expect(parseGedcomDateToEdtf('FROM 1880 TO 1890')).toBe('1880/1890');
    expect(parseGedcomDateToEdtf('FROM 1880 TO unknown')).toBe('1880');
    expect(parseGedcomDateToEdtf('FROM unknown TO 1890')).toBe('1890');
    expect(parseGedcomDateToEdtf('ABT unknown')).toBe('');
    expect(parseGedcomDateToEdtf('BEF unknown')).toBe('');
    expect(parseGedcomDateToEdtf('AFT unknown')).toBe('');
    expect(parseGedcomDateToEdtf('1880-1890')).toBe('1880/1890');

    expect(intervalsOverlap(null, 10, 0, 10)).toBe(false);
    expect(intervalsOverlap(1, 5, 6, 10, 0)).toBe(false);
    expect(intervalsOverlap(1, 5, 6, 10, 2)).toBe(true);
  });
});

describe('pronunciation phonetics, geo, and resolve branch coverage', () => {
  it('covers phonetics helpers and geo compatibility filters', () => {
    expect(findIpaGlyphsInPhonetic(null)).toEqual([]);
    expect(findIpaGlyphsInPhonetic('ə ə /test/')).toEqual(['ə', '/.../']);
    expect(hasIpaGlyphsInPhonetic('ALL-der')).toBe(false);

    expect(mergePronunciationLexicons(null, undefined)).toEqual({});
    expect(
      mergePronunciationLexicons({ alder: { phonetic: 'all-der' } }, { Alder: { phonetic: 'ALL-der' } })
    ).toEqual({ Alder: { phonetic: 'ALL-der' } });

    expect(mergePronunciationEntry(undefined, undefined)).toBeNull();
    expect(mergePronunciationEntry(undefined, { phonetic: 'ALL-der' })).toEqual({ phonetic: 'ALL-der' });
    expect(mergePronunciationEntry({ phonetic: 'ALL-der' }, undefined)).toEqual({ phonetic: 'ALL-der' });
    expect(
      mergePronunciationEntry({ phonetic: 'ALL-der', audio_url: '/a.mp3' }, { phonetic: 'AWL-der' })
    ).toEqual({ phonetic: 'AWL-der' });

    expect(hasPronunciationEntryContent(null)).toBe(false);
    expect(hasPronunciationEntryContent({})).toBe(false);
    expect(hasPronunciationEntryContent({ note: 'Local usage' })).toBe(true);
    expect(hasPronunciationEntryContent({ variants: [{ label: 'Alt', ipa: '/a/' }] })).toBe(true);
    expect(hasPronunciationEntryContent({ variants: [{ label: 'Alt', audio_url: '/a.mp3' }] })).toBe(true);
    expect(hasPronunciationEntryContent({ variants: [{ label: 'Alt', note: 'note' }] })).toBe(true);

    expect(lookupLexiconMatch({ Alder: { phonetic: 'ALL-der' } }, '   ')).toBeUndefined();
    expect(lookupLexiconMatch({ Alder: { phonetic: 'ALL-der' } }, 'alder')?.key).toBe('Alder');

    expect(isLexiconEntryCompatibleWithPerson({ match_full_name_contains: 'alder' }, 'clara alder')).toBe(
      true
    );
    expect(isLexiconEntryCompatibleWithPerson({ match_full_name_contains: ['   '] }, '')).toBe(true);
    expect(isLexiconEntryCompatibleWithPerson({ match_full_name_contains: ['birch'] }, 'clara alder')).toBe(
      false
    );

    expect(tokenizePersonName({ full_name: '', given_name: 'Clara', surname: 'Alder' })).toEqual([
      'Clara',
      'Alder',
    ]);
    expect(tokenizePersonName({ full_name: '("only parens")' })).toEqual([]);
    expect(tokenizePersonName({})).toEqual([]);

    expect(stripIpaDelimiters('/a/')).toBe('a');
    expect(stripIpaDelimiters('[b]')).toBe('b');
    expect(stripIpaDelimiters('plain')).toBe('plain');

    expect(composeLanguageTag([])).toBeUndefined();
    expect(composeLanguageTag([{ language: 'en' }, { language: 'en-US' }])).toBe('en-US');
    expect(composeLanguageTag([{ language: 'en' }, { language: 'EN' }])).toBe('en');
    expect(composeLanguageTag([{ language: 'en' }, { language: 'de' }])).toBeUndefined();

    expect(
      composeProvenance([
        { source_label: 'Family', source_url: 'https://a.example', region: 'Ohio' },
        { source_label: 'family', source_url: 'https://a.example', region: 'Ohio' },
      ])
    ).toEqual({ source_label: 'Family', source_url: 'https://a.example', region: 'Ohio' });
    expect(
      composeProvenance([
        { source_url: 'https://a.example', region: 'Ohio' },
        { source_url: 'https://b.example', region: 'Maine' },
      ])
    ).toEqual({});

    expect(findSurnameTokenSpan([], 'Alder')).toBeNull();
    expect(findSurnameTokenSpan(['Arthur', 'Alder', 'Jr.'], 'Alder')).toEqual({ start: 1, end: 2 });
    expect(findSurnameTokenSpan(['Arthur', 'Birch'], 'Alder')).toEqual({ start: 1, end: 2 });
    expect(findSurnameTokenSpan(['Alder'], 'Alder')).toEqual({ start: 0, end: 1 });
    expect(findSurnameTokenSpan(['Mononym'])).toBeNull();

    // pronunciationGeo
    expect(inferCountryCodeFromSegments(['Near Bavaria'])).toBe('DE');
    expect(inferCountryCodeFromSegments(['Northern Ohio'])).toBe('US');
    expect(inferCountryCodeFromSegments(['Unknown Territory'])).toBeNull();
    expect(getPlaceQualifierSegments({ name: 'Harbor', full_name: '' })).toEqual([]);
    expect(getPlaceQualifierSegments({ name: 'Harbor', full_name: 'Cedar, Ohio' })).toEqual([
      'Cedar',
      'Ohio',
    ]);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { match_full_name_contains: 'ohio', region: 'Ohio', language: 'en-US' },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(true);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { match_full_name_contains: ['texas'] },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(false);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { region: 'Bavaria, Germany' },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(false);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { region: 'Mystery Shire' },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(false);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { language: 'nl' },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(false);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { language: 'xx' },
        { name: 'Harbor', full_name: 'Harbor, Ohio, USA' }
      )
    ).toBe(true);
  });

  it('covers person pronunciation resolution and token inspection across all precedence & compositional paths', () => {
    expect(resolvePersonPronunciation({ full_name: 'Living', is_living: true }, {})).toBeNull();
    expect(inspectPersonPronunciationTokens({ full_name: 'Living', is_living: true }, {}).tokens).toEqual([]);
    expect(inspectPersonPronunciationTokens({ full_name: '' }, {}).tokens).toEqual([]);

    expect(
      resolvePersonPronunciation(
        { id: 'p1', full_name: 'Arthur Alder', pronunciation: { phonetic: 'AR-thur ALL-der' } },
        null
      )
    ).toMatchObject({ resolvedFrom: 'person', coverage: 'full' });

    expect(resolvePersonPronunciation({ id: 'p1', full_name: 'Arthur Alder' }, null)).toBeNull();

    const lexicon = {
      p_by_id: { phonetic: 'EX-act EYE-dee' },
      'Exact Name': { phonetic: 'EX-act NAYM' },
      Anna: { phonetic: 'AN-uh', ipa: '/ˈænə/' },
      Mae: { phonetic: 'MAY', ipa: '/meɪ/' },
      Alder: { phonetic: 'ALL-der', ipa: '/ˈɔːldər/' },
      Birch: { ipa: '/bɜːrtʃ/' },
      EmptyNoteOnly: { note: 'No phonetic or ipa' },
    };

    expect(resolvePersonPronunciation({ id: 'p_by_id', full_name: 'Other' }, lexicon)?.resolvedFrom).toBe(
      'lexicon_id'
    );
    expect(resolvePersonPronunciation({ full_name: 'Exact Name' }, lexicon)?.resolvedFrom).toBe(
      'lexicon_full_name'
    );

    const hyphenResolved = resolvePersonPronunciation(
      { full_name: 'Anna-Mae J. Alder Jr.', surname: 'Alder' },
      lexicon
    );
    expect(hyphenResolved).toMatchObject({
      phonetic: 'AN-uh-MAY J. ALL-der Jr.',
      ipa: '/ˈænə-meɪ ˈɔːldər/',
      resolvedFrom: 'composed',
    });

    const ipaOnlyComposed = resolvePersonPronunciation(
      { full_name: 'Anna Birch', surname: 'Birch' },
      lexicon
    );
    expect(ipaOnlyComposed).toMatchObject({ ipa: '/ˈænə bɜːrtʃ/', resolvedFrom: 'composed' });
    expect(ipaOnlyComposed?.phonetic).toBeUndefined();

    // Neither phonetic nor ipa -> composed returns null
    expect(resolvePersonPronunciation({ full_name: 'EmptyNoteOnly EmptyNoteOnly' }, lexicon)).toBeNull();

    // Partial hyphen miss + surname fallback with missingParts
    const surnameFallback = resolvePersonPronunciation(
      { full_name: 'Anna-Unknown Alder', surname: 'Alder' },
      lexicon
    );
    expect(surnameFallback).toMatchObject({
      coverage: 'surname',
      resolvedFrom: 'lexicon_surname',
      missingParts: ['Unknown'],
    });

    const inspection = inspectPersonPronunciationTokens(
      { full_name: 'Anna-Unknown J. Van Der Berg Jr.', surname: 'Van Der Berg' },
      lexicon
    );
    expect(inspection.tokens.some((t) => t.joinWithHyphen === true)).toBe(true);
    expect(inspection.tokens.some((t) => t.kind === 'initial' && t.text === 'J.')).toBe(true);
    expect(inspection.tokens.some((t) => t.kind === 'decoration' && t.text === 'Jr.')).toBe(true);
    expect(inspection.tokens.some((t) => t.role === 'surname' && t.text === 'Van Der Berg')).toBe(true);
  });
});

describe('domain/geoMap and domain/placesDirectory branch coverage', () => {
  it('covers geoMap classification, stops, segments, bounds, and nearby projection', () => {
    const harbor = makePlace({
      id: 'plc_harbor',
      slug: 'harbor',
      name: 'Harbor',
      full_name: 'Harbor, Ohio',
      lat: 40.0,
      lng: -82.0,
    });
    const harborClose = makePlace({
      id: 'plc_harbor2',
      slug: 'harbor2',
      name: 'Harbor East',
      full_name: 'Harbor East, Ohio',
      lat: 40.01,
      lng: -82.01,
    });
    const cedar = makePlace({
      id: 'plc_cedar',
      slug: 'cedar',
      name: 'Cedar',
      full_name: 'Cedar, Maine',
      lat: 44.0,
      lng: -70.0,
    });
    const usa = makePlace({
      id: 'plc_usa',
      slug: 'usa',
      name: 'USA',
      full_name: 'USA',
      place_type: 'country',
      lat: 39,
      lng: -98,
    });

    const customEras = [
      {
        id: 'box',
        label: 'Box',
        minLat: 39,
        maxLat: 41,
        minLng: -83,
        maxLng: -81,
        startYear: 1850,
        endYear: 1900,
      },
      { id: 'fallback', label: 'Fallback' },
    ];
    expect(classifyMigrationStage(harbor, customEras, 1880)).toBe('box');
    expect(
      classifyMigrationStage(
        makePlace({ id: 'lo', slug: 'lo', name: 'Lo', full_name: 'Lo', lat: 30, lng: -82 }),
        customEras,
        1880
      )
    ).toBe('fallback');
    expect(
      classifyMigrationStage(
        makePlace({ id: 'hi', slug: 'hi', name: 'Hi', full_name: 'Hi', lat: 45, lng: -82 }),
        customEras,
        1880
      )
    ).toBe('fallback');
    expect(
      classifyMigrationStage(
        makePlace({ id: 'w', slug: 'w', name: 'W', full_name: 'W', lat: 40, lng: -90 }),
        customEras,
        1880
      )
    ).toBe('fallback');
    expect(
      classifyMigrationStage(
        makePlace({ id: 'e', slug: 'e', name: 'E', full_name: 'E', lat: 40, lng: -70 }),
        customEras,
        1880
      )
    ).toBe('fallback');
    expect(classifyMigrationStage(harbor, customEras, 1800)).toBe('fallback');
    expect(classifyMigrationStage(harbor, customEras, 1950)).toBe('fallback');

    const p1 = makePerson({ id: 'p1', slug: 'p1', full_name: 'Arthur Alder' });
    const p2 = makePerson({ id: 'p2', slug: 'p2', full_name: 'Clara Alder' });
    const pLiv = makePerson({ id: 'p_liv', slug: 'liv', full_name: 'Living', is_living: true });

    const bundle = makeBundle({
      people: [p1, p2, pLiv],
      places: [harbor, harborClose, cedar, usa],
      events: [
        makeEvent({ id: 'e_global', scope: 'global', title: 'Global', year: 1880, place_id: 'plc_harbor' }),
        makeEvent({
          id: 'e_country',
          title: 'Country',
          year: 1880,
          place_id: 'plc_usa',
          participants: [{ person_id: 'p1', role: 'subject' }],
        }),
        makeEvent({
          id: 'e_nodate',
          title: 'No date',
          year: null,
          place_id: 'plc_harbor',
          participants: [{ person_id: 'p1', role: 'subject' }],
        }),
        makeEvent({
          id: 'e_livonly',
          title: 'Living only',
          year: 1880,
          place_id: 'plc_harbor',
          participants: [{ person_id: 'p_liv', role: 'subject' }],
        }),
        makeEvent({
          id: 'e1',
          title: 'Move 1',
          year: 1880,
          time_min: null,
          place_id: 'plc_harbor',
          participants: [{ person_id: 'p1', role: 'resident' }],
        }),
        makeEvent({
          id: 'e2',
          title: 'Merge close',
          year: 1882,
          time_min: null,
          place_id: 'plc_harbor2',
          participants: [
            { person_id: 'p1', role: 'resident' },
            { person_id: 'p2', role: 'resident' },
            { person_id: 'p_liv', role: 'resident' },
            { person_id: 'missing', role: 'resident' },
          ],
        }),
        makeEvent({
          id: 'e3',
          title: 'Move 2',
          year: 1890,
          place_id: 'plc_cedar',
          participants: [
            { person_id: 'p1', role: 'resident' },
            { person_id: 'p2', role: 'resident' },
          ],
        }),
      ],
    });
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));

    const allStops = buildMigrationStops(bundle, placesById, peopleById);
    expect(allStops).toHaveLength(2);
    expect(allStops[0]?.personSlugs).toEqual(['p1', 'p2']);

    const filteredStops = buildMigrationStops(bundle, placesById, peopleById, 'p1');
    expect(filteredStops).toHaveLength(2);

    const optStops = buildMigrationStops(bundle, placesById, peopleById, {
      personIdFilter: 'p1',
      migrationEras: customEras,
    });
    expect(optStops[0]?.lineageStage).toBe('box');

    expect(buildMigrationSegments(allStops, 10_000)).toEqual([]);
    expect(buildMigrationSegments(allStops, 15)).toHaveLength(1);
    expect(buildPerPersonMigrationSegments(allStops, 10_000)).toEqual([]);
    // Both p1 and p2 share the exact same leg -> deduped to 1 segment
    expect(buildPerPersonMigrationSegments(allStops, 15)).toHaveLength(1);

    expect(computeStopsBounds([])).toBeNull();
    expect(computeStopsBounds([], { minSpanDeg: 2, centerLat: 40, centerLng: -82 })).toEqual([
      [-84, 38],
      [-80, 42],
    ]);
    const singleBounds = computeStopsBounds([allStops[0]!], 2);
    expect(singleBounds).toEqual([
      [-83, 39],
      [-81, 41],
    ]);

    const nearbyMarkers = projectNearbyPlaces({
      center: harbor,
      allPlaces: [
        harbor,
        usa,
        makePlace({
          id: 'plc_excl',
          slug: 'excl',
          name: 'Excluded',
          full_name: 'Excluded',
          lat: 40.1,
          lng: -82.1,
        }),
        makePlace({
          id: 'plc_dup1',
          slug: 'dup1',
          name: 'Birchville',
          full_name: 'Birchville',
          lat: 40.1,
          lng: -82.0,
        }),
        makePlace({
          id: 'plc_dup2',
          slug: 'dup2',
          name: 'birchville',
          full_name: 'Birchville 2',
          lat: 40.12,
          lng: -82.0,
        }),
      ],
      width: 400,
      height: 300,
      maxRadiusMiles: 50,
      excludeIds: new Set(['plc_excl']),
    });
    expect(nearbyMarkers).toHaveLength(1);
    expect(nearbyMarkers[0]?.inRadius).toBe(true);
  });

  it('covers placesDirectory canonical place climbing, thumb map priority, and span merging', () => {
    const state = makePlace({
      id: 'plc_oh',
      slug: 'oh',
      name: 'Ohio',
      full_name: 'Ohio',
      place_type: 'state',
    });
    const county = makePlace({
      id: 'plc_co',
      slug: 'co',
      name: 'Cedar County',
      full_name: 'Cedar County, Ohio',
      place_type: 'county',
      parent_id: 'plc_oh',
    });
    const twp = makePlace({
      id: 'plc_twp',
      slug: 'twp',
      name: 'Township 4',
      full_name: 'Township 4, Cedar County, Ohio',
      place_type: 'town',
      parent_id: 'plc_co',
    });
    const orphanTwp = makePlace({
      id: 'plc_otwp',
      slug: 'otwp',
      name: 'District 2',
      full_name: 'District 2',
      place_type: 'town',
      parent_id: null,
    });
    const stateTwp = makePlace({
      id: 'plc_stwp',
      slug: 'stwp',
      name: 'Ward 1',
      full_name: 'Ward 1, Ohio',
      place_type: 'town',
      parent_id: 'plc_oh',
    });
    const shortCo = makePlace({
      id: 'plc_co_short',
      slug: 'co-short',
      name: 'Cedar',
      full_name: 'Cedar, Ohio',
      place_type: 'county',
      parent_id: 'plc_oh',
    });

    const places = [state, county, twp, orphanTwp, stateTwp, shortCo];
    const placesById = new Map(places.map((p) => [p.id, p]));

    expect(resolveCanonicalPlace(undefined, placesById)).toBeNull();
    expect(resolveCanonicalPlace(twp, placesById)?.id).toBe('plc_co');
    expect(resolveCanonicalPlace(orphanTwp, placesById)?.id).toBe('plc_otwp');
    expect(resolveCanonicalPlace(stateTwp, placesById)?.id).toBe('plc_stwp');

    const p1 = makePerson({
      id: 'p1',
      slug: 'p1',
      full_name: 'Arthur Alder',
      portrait_url: '/p1.jpg',
      birth_year: 1850,
    });
    const p2 = makePerson({ id: 'p2', slug: 'p2', full_name: 'Clara Alder' });
    const pLiv = makePerson({ id: 'p_liv', slug: 'liv', full_name: 'Living', is_living: true });

    const bundle = makeBundle({
      people: [p1, p2, pLiv],
      places,
      events: [
        makeEvent({ id: 'e_no_place', title: 'No place', place_id: null }),
        makeEvent({ id: 'e_state', title: 'State', place_id: 'plc_oh' }),
        makeEvent({
          id: 'e1',
          title: 'Undated',
          year: null,
          place_id: 'plc_co_short',
          participants: [
            { person_id: 'p1', role: 'resident' },
            { person_id: 'p_liv', role: 'resident' },
          ],
        }),
        makeEvent({
          id: 'e2',
          title: 'Later',
          year: 1890,
          place_id: 'plc_twp',
          participants: [{ person_id: 'p1', role: 'resident' }],
        }),
        makeEvent({
          id: 'e3',
          title: 'Earlier',
          year: 1875,
          place_id: 'plc_co',
          participants: [{ person_id: 'p1', role: 'resident' }],
        }),
      ],
      residence_spans: [
        {
          id: 'sp_state',
          person_id: 'p1',
          place_id: 'plc_oh',
          time_min: 0,
          time_max: 1,
          start_year: 1870,
          end_year: 1880,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_liv',
          person_id: 'p_liv',
          place_id: 'plc_co',
          time_min: 0,
          time_max: 1,
          start_year: 1990,
          end_year: 2000,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_p1',
          person_id: 'p1',
          place_id: 'plc_co',
          time_min: 0,
          time_max: 1,
          start_year: 1865,
          end_year: 1895,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_p2',
          person_id: 'p2',
          place_id: 'plc_co',
          time_min: 0,
          time_max: 1,
          start_year: null,
          end_year: null,
          confidence_tier: 'Inferred',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
      ],
      media: [
        { id: 'm_vid', kind: 'video_story', file: '/v.mp4', caption: 'Vid', person_id: 'p2' },
        { id: 'm_doc', kind: 'document_scan', file: '/doc.jpg', caption: 'Doc', person_id: 'p2' },
        {
          id: 'm_por',
          kind: 'portrait',
          file: '/por.jpg',
          thumb_file: '/por_t.jpg',
          caption: 'Por',
          person_id: 'p2',
        },
        { id: 'm_p1', kind: 'portrait', file: '/other.jpg', caption: 'Ignored', person_id: 'p1' },
      ],
    });

    const thumbs = buildPersonThumbMap(bundle);
    expect(thumbs.get('p1')).toBe('/p1.jpg');
    expect(thumbs.get('p2')).toBe('/por_t.jpg');

    const dir = buildPlacesDirectory(bundle, placesById, new Map(bundle.people.map((p) => [p.id, p])));
    expect(dir).toHaveLength(1);
    expect(dir[0]?.place.full_name).toBe('Cedar County, Ohio');
    expect(dir[0]?.minYear).toBe(1865);
    expect(dir[0]?.maxYear).toBe(1895);
    expect(dir[0]?.people).toHaveLength(2);
  });
});

describe('privacy policy, redaction, and livingNameMatcher branch coverage', () => {
  it('covers livingNameMatcher edge cases, caps, and date horizons', () => {
    expect(extractLatestEdtfYear(123)).toBeNull();
    expect(extractLatestEdtfYear('invalid')).toBeNull();
    expect(extractEarliestEdtfYear(123)).toBeNull();
    expect(extractEarliestEdtfYear('invalid')).toBeNull();

    const maxYears = computeSourceMaxYearById([
      { edtf_date: '1880', sources: 'not-array' },
      {
        edtf_date: '1880',
        sources: ['src_str', { source_id: '  src_obj ' }, { source_id: 123 }, { source_id: '' }],
      },
      { edtf_date: 'invalid', sources: ['src_obj'] },
    ]);
    expect(maxYears.get('src_str')).toBe(1880);
    expect(maxYears.get('src_obj')).toBeNull();

    expect(
      resolveNarrativeMaxYear({
        personIds: [],
        eventIds: [],
        livingIds: new Set(),
        deathYearByPersonId: new Map(),
        eventMaxYearById: new Map(),
      })
    ).toBeNull();
    expect(
      resolveNarrativeMaxYear({
        subjectPersonId: 'p1',
        personIds: ['p2'],
        eventIds: ['e1'],
        livingIds: new Set(),
        deathYearByPersonId: new Map([
          ['p1', 1850],
          ['p2', 1860],
        ]),
        eventMaxYearById: new Map([['e1', 1995]]),
      })
    ).toBe(1995);

    const matcher = compileLivingNameMatcher(
      [
        { full_name: 'A B C', given_name: 'A B', surname: 'C' }, // derived "A C" < 6 chars
        { full_name: 'Clara Marie Alder', given_name: 'Clara', surname: 'Alder', birth_edtf: '2050' },
        { full_name: 'Clara Louise Alder', given_name: 'Clara Louise', surname: 'Alder', birth_edtf: '1985' },
        { full_name: 'Clara June Alder', given_name: 'Clara June', surname: 'Alder', birth_edtf: '' },
        { full_name: 123, alt_names: [456, '  '] },
      ],
      [{ full_name: 99, alt_names: ['  ', 'Thomas Alder'], given_name: 'Thomas Edward', surname: 'Birch' }],
      { referenceYear: 2026 }
    );
    expect(matcher.derivedRules.some((r) => r.minYear === null)).toBe(true);

    const regex = compileLivingNameRegex(
      [{ full_name: 'Clara Marie Alder', given_name: 'Clara Marie', surname: 'Alder' }],
      []
    );
    expect(collectLivingNameHits(null, [{ location: 'loc', text: 'Clara Alder' }])).toEqual([]);
    const repeatedText = Array.from({ length: 60 }, () => 'Clara Alder').join(' ');
    expect(
      collectLivingNameHits(regex, [
        { location: 'empty', text: '' },
        { location: 'cap', text: repeatedText },
      ])
    ).toHaveLength(50);

    const emptyMatcher = compileLivingNameMatcher([]);
    expect(collectLivingNameHitsWithMatcher(emptyMatcher, [{ location: 'a', text: 'text' }])).toEqual([]);
    expect(
      collectLivingNameHitsWithMatcher(matcher, [
        { location: 'empty', text: '' },
        { location: 'cap', text: repeatedText },
      ])
    ).toHaveLength(50);
  });

  it('covers privacy policy and redaction branches for raw/compiled people, events, media, and narratives', () => {
    const err = new PrivacyViolationError('Blocked');
    expect(err.code).toBe('LIVING_MEDIA_FORBIDDEN');
    expect(err.blockedPersonIds).toEqual([]);

    expect(
      isPersonLivingPublic({
        hasDeathOrBurial: false,
        birthYear: null,
        earliestEventYear: 1990,
        referenceYear: 2026,
      })
    ).toBe(true);
    expect(
      isPersonLivingPublic({
        hasDeathOrBurial: false,
        birthYear: null,
        earliestEventYear: null,
        referenceYear: 2026,
      })
    ).toBe(true);

    expect(() => resolveEffectiveLiving({ is_living: false, birth_edtf: '1990', death_edtf: '' })).toThrow(
      RangeError
    );
    expect(resolveEffectiveLiving({ is_living: false, birth_edtf: '', death_edtf: '' })).toBe(false);

    expect(
      collectLivingNames([
        { is_living: true, full_name: 'Living', alt_names: ['Living', '  ', 'Riley Alder'] },
      ])
    ).toEqual(['Riley Alder']);
    expect(scrubLivingNames('', null)).toBe('');

    const livingCompiled = makePerson({
      id: 'p_liv',
      slug: 'liv',
      full_name: 'Riley Alder',
      birth_edtf: '1990-05-01',
      birth_year: 1990,
      is_living: true,
      portrait_url: '/p.jpg',
      thumb_url: '/t.jpg',
      pronunciation: { phonetic: 'RY-lee' },
      media_count: 2,
    });
    const privNoBirthKeepPortrait = redactCompiledPerson(livingCompiled, 'private', {
      clone: false,
      privacy: { privateModeShowsBirthYear: false, stripLivingPortraits: false },
    });
    expect(privNoBirthKeepPortrait.birth_year).toBeNull();
    expect(privNoBirthKeepPortrait.media_count).toBe(2);

    const deceasedCompiled = makePerson({
      id: 'p_dec',
      slug: 'dec',
      full_name: 'Arthur Alder',
      death_edtf: '1920',
    });
    expect(redactSinglePerson(deceasedCompiled, 'public', { clone: false })).toBe(deceasedCompiled);
    expect(sanitizePersonForWrite(deceasedCompiled).id).toBe('p_dec');
    expect(
      sanitizePersonForWrite(
        makeRawPerson({ id: 'p_r', slug: 'r', full_name: 'Riley', is_living: true, birth_edtf: '1995-02-02' })
      ).birth_edtf
    ).toBe('1995');

    const rawEv = makeRawEvent({
      id: 'e_raw',
      title: 'Note',
      edtf_date: '1995-02-02',
      photo_url: '/photo.jpg',
      participants: [{ person_id: 'p_liv', role: 'subject' }],
    });
    const sanRaw = sanitizeEventForWrite(rawEv, new Set(['p_liv']), {
      privateModeShowsBirthYear: false,
      stripLivingPortraits: false,
    });
    expect(sanRaw.edtf_date).toBe('');
    expect(sanRaw.photo_url).toBe('/photo.jpg');
    expect(sanitizeEventForWrite(rawEv, new Set()).edtf_date).toBe('1995-02-02');

    const compEv = makeEvent({
      id: 'e_comp',
      title: 'Shared with Riley Alder',
      edtf_date: '1995-02-02',
      place_ancestors: ['plc_oh'],
      photo_url: '/photo.jpg',
      alternate_dates: [{ edtf_date: '1995', source_id: 's1', note: 'Riley Alder note' }],
      alternate_places: [{ place_name: 'Harbor', source_id: 's1', note: 'Riley Alder place' }],
      fact_conflicts: [{ claim: '1996', source_id: 's1', note: 'Riley Alder conflict' }],
      participants: [
        { person_id: 'p_liv', role: 'subject' },
        { person_id: 'p_dec', role: 'parent' },
      ],
    });
    expect(sanitizeEventForWrite(compEv, new Set()).place_ancestors).toEqual(['plc_oh']);
    expect(sanitizeEventForWrite(compEv, new Set(['p_liv'])).place_ancestors).toEqual([]);

    const livingPat = /Riley Alder/g;
    const redPublic = redactSingleEvent(compEv, new Set(['p_liv']), livingPat, 'public');
    expect(redPublic?.title).toBe('Shared with Living');
    expect(redPublic?.alternate_dates?.[0]?.note).toBe('Living note');
    expect(redPublic?.alternate_places?.[0]?.note).toBe('Living place');
    expect(redPublic?.fact_conflicts?.[0]?.note).toBe('Living conflict');

    const redPrivate = redactSingleEvent(compEv, new Set(['p_liv']), livingPat, 'private', {
      privacy: { privateModeShowsBirthYear: false, stripLivingPortraits: false },
    });
    expect(redPrivate?.edtf_date).toBe('');
    expect(redPrivate?.photo_url).toBe('/photo.jpg');

    const filterRes = applyPrivacyFilter(
      [
        makePerson({
          id: 'p_short',
          slug: 'short',
          full_name: 'Jo',
          alt_names: ['Riley Alder'],
          is_living: true,
        }),
        deceasedCompiled,
      ],
      [
        makeEvent({
          id: 'e_mention',
          title: 'Riley Alder and Riley Alder',
          summary: 'Mentioned Riley Alder twice: Riley Alder.',
          participants: [{ person_id: 'p_dec', role: 'subject' }],
        }),
      ],
      [
        {
          id: 'sp1',
          person_id: 'p_short',
          place_id: 'plc_h',
          time_min: 0,
          time_max: 1,
          start_year: 1990,
          end_year: 2000,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e1',
        },
      ],
      'public',
      { cloneInputs: false }
    );
    expect(filterRes.reviewFlags).toHaveLength(2);
    expect(filterRes.residenceSpans).toEqual([]);

    const privFilterRes = applyPrivacyFilter(
      [makeRawPerson({ id: 'p_short', slug: 'short', full_name: 'Riley Alder', is_living: true })],
      [],
      [
        {
          id: 'sp1',
          person_id: 'p_short',
          place_id: 'plc_h',
          time_min: 0,
          time_max: 1,
          start_year: 1990,
          end_year: 2000,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e1',
        },
      ],
      'private',
      { privacy: { stripLivingResidenceSpans: false }, cloneInputs: false }
    );
    expect(privFilterRes.residenceSpans).toHaveLength(1);

    const mediaCheck = validateMediaForPrivacy(
      { id: 'm1', event_id: 'e_comp' },
      new Set(['p_liv']),
      new Map([['e_comp', compEv]])
    );
    expect(mediaCheck.ok).toBe(false);
    expect(() => assertMediaAllowedForPrivacy({ id: 'm1', person_id: 'p_liv' }, new Set(['p_liv']))).toThrow(
      PrivacyViolationError
    );

    const filteredMedia = filterMediaForPrivacy(
      [{ id: 'm_ok', kind: 'portrait', file: '/ok.jpg', caption: 'Ok', person_id: 'p_dec' }],
      new Map([['p_dec', deceasedCompiled]]),
      undefined,
      { cloneInputs: false, stripLivingPortraits: false }
    );
    expect(filteredMedia[0]?.person_name).toBe('Arthur Alder');

    const nar: Narrative = {
      id: 'n1',
      slug: 'n1',
      subject_person_id: 'p_liv',
      title: 'Story of Riley Alder',
      summary: 'About Riley Alder',
      body_md: 'Riley Alder visited Harbor.',
      person_ids: ['p_liv', 'p_dec'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
    };
    expect(redactSingleNarrative(nar, new Set(['p_liv']), livingPat, 'private', { clone: false })).toBe(nar);
    const filteredNars = filterNarrativesForPrivacy([nar], new Set(['p_liv']), livingPat, 'public', {
      cloneInputs: false,
    });
    expect(filteredNars[0]?.title).toBe('Story of Living');
    expect(filteredNars[0]?.summary).toBe('About Living');
    expect(filteredNars[0]?.subject_person_id).toBeUndefined();
    expect(filteredNars[0]?.person_ids).toEqual(['p_dec']);
  });
});

describe('domain/archiveSearch, domain/kinshipFinder, domain/citations, and citations branch coverage', () => {
  it('covers archiveSearch scoring, excerpts, scopes, conflicts, routes, and readings', () => {
    expect(buildExcerpt('Hello world from Harbor', '', 10)).toBe('Hello world from Har');
    expect(buildExcerpt('Hello world from Harbor', 'missing', 10)).toBe('Hello world from Har');
    expect(buildExcerpt('Alpha Beta Gamma Delta Harbor Epsilon Zeta Eta Theta', 'harbor', 6)).toBe(
      '…Delta Harbor Epsil…'
    );

    const eastPlace = makePlace({
      id: 'plc_e',
      slug: 'dover',
      name: 'Dover',
      full_name: 'Dover, England',
      lat: 51.1,
      lng: 1.3,
    });
    const westPlace = makePlace({
      id: 'plc_w',
      slug: 'harbor',
      name: 'Harbor',
      full_name: 'Harbor, Ohio',
      lat: 40.0,
      lng: -82.0,
    });
    const pExact = makePerson({
      id: 'p1',
      slug: 'harbor-exact',
      full_name: 'Harbor',
      birth_year: 1850,
      death_year: 1920,
      primary_place_id: 'plc_w',
    });
    const pStart = makePerson({ id: 'p2', slug: 'harbor-start', full_name: 'Harbor Alder', is_living: true });
    const pInc = makePerson({
      id: 'p3',
      slug: 'harbor-inc',
      full_name: 'Clara Harbor',
      birth_year: null,
      death_year: null,
    });
    const pOther = makePerson({ id: 'p4', slug: 'alt', full_name: 'Owen Birch', alt_names: ['Harbor Owen'] });
    const pRed = makePerson({ id: 'p_red', slug: 'living', full_name: 'Living', is_living: true });

    const bundle = makeBundle({
      people: [pExact, pStart, pInc, pOther, pRed],
      places: [eastPlace, westPlace],
      events: [
        makeEvent({ id: 'ev_glob', scope: 'global', title: 'Harbor Global', summary: 'Harbor' }),
        makeEvent({
          id: 'ev_place_only',
          scope: 'local',
          title: 'Local Dock',
          summary: 'Harbor dock note',
          display_date: '1880',
          place_id: 'plc_w',
          alternate_dates: [{ edtf_date: '1881', source_id: 's1', note: 'Alt harbor' }],
          alternate_places: [{ place_name: 'Harbor', source_id: 's1', note: 'Place' }],
          fact_conflicts: [{ claim: 'Harbor claim', source_id: 's1', note: 'Conflict' }],
          severity_rank: 4,
        }),
        makeEvent({
          id: 'ev_unlinked',
          scope: 'personal',
          title: 'Harbor Story',
          summary: 'No place no person',
          display_date: '1882',
        }),
        makeEvent({
          id: 'ev_person',
          scope: 'personal',
          title: 'Harbor Birth',
          summary: 'Born at Harbor',
          display_date: '1850',
          participants: [{ person_id: 'p1', role: 'subject' }],
        }),
      ],
    });

    const readings: ReadingsBundle = {
      version: 1,
      documents: {
        src_1: {
          source_id: 'src_1',
          title: 'Harbor Chronicle',
          author: 'Clerk',
          provenance: 'Archive',
          pages: [
            { page: 1, label: 'p. 1', file: '/p1.txt', text: 'Unrelated page text' },
            { page: 2, label: 'p. 2', file: '/p2.txt', text: 'Harbor ships arrived at Harbor dock.' },
          ],
        },
      },
      event_page_map: {},
    };

    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    expect(searchArchive({ query: 'a', bundle, placesById })).toEqual([]);
    expect(searchArchive({ query: 'harbor', bundle: null, placesById })).toEqual([]);

    const res = searchArchive({ query: 'harbor', bundle, placesById, readings });
    expect(res.filter((r) => r.kind === 'person').map((r) => r.score)).toEqual([120, 105, 92, 70]);
    expect(res.find((r) => r.id === 'person:p2')?.subtitle).toContain('Living');
    expect(res.find((r) => r.id === 'place:plc_w')?.subtitle).toContain('W');
    expect(res.find((r) => r.id === 'event:ev_place_only')?.route).toBe('/place/harbor');
    expect(res.find((r) => r.id === 'event:ev_unlinked')?.route).toBe('/');
    expect(res.find((r) => r.id === 'event:ev_person')?.route).toBe('/person/harbor-exact?event=ev_person');
    expect(res.find((r) => r.kind === 'reading')?.sourceReaderTarget?.page).toBe(2);

    const eastRes = searchArchive({ query: 'dov', bundle, placesById });
    expect(eastRes.find((r) => r.id === 'place:plc_e')?.subtitle).toContain('E');
  });

  it('covers kinshipFinder ordinals, blood/marriage labels, life overlap, and BFS path search', () => {
    expect(describeBloodRelation(0, 0)).toBe('Same person');
    expect(describeBloodRelation(1, 0)).toBe('Child of');
    expect(describeBloodRelation(2, 0)).toBe('Grandchild of');
    expect(describeBloodRelation(3, 0)).toBe('Great-Grandchild of');
    expect(describeBloodRelation(4, 0)).toBe('2nd Great-Grandchild of');
    expect(describeBloodRelation(5, 0)).toBe('3rd Great-Grandchild of');
    expect(describeBloodRelation(6, 0)).toBe('4th Great-Grandchild of');
    expect(describeBloodRelation(13, 0)).toBe('11th Great-Grandchild of');
    expect(describeBloodRelation(14, 0)).toBe('12th Great-Grandchild of');
    expect(describeBloodRelation(15, 0)).toBe('13th Great-Grandchild of');
    expect(describeBloodRelation(23, 0)).toBe('21st Great-Grandchild of');
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
        { fromId: 'a', toId: 'b', relation: 'parent' },
        { fromId: 'b', toId: 'c', relation: 'child' },
      ])
    ).toBe('Connected by 2 genealogical steps');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'spouse' },
        { fromId: 'b', toId: 'c', relation: 'child' },
      ])
    ).toBe('Child-in-Law of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'spouse' },
        { fromId: 'b', toId: 'c', relation: 'child' },
        { fromId: 'c', toId: 'd', relation: 'parent' },
      ])
    ).toBe('Sibling-in-Law of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'spouse' },
        { fromId: 'b', toId: 'c', relation: 'parent' },
      ])
    ).toBe('Spouse of Parent of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'parent' },
        { fromId: 'b', toId: 'c', relation: 'spouse' },
      ])
    ).toBe('Parent-in-Law of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'child' },
        { fromId: 'b', toId: 'c', relation: 'parent' },
        { fromId: 'c', toId: 'd', relation: 'spouse' },
      ])
    ).toBe('Sibling-in-Law of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'parent' },
        { fromId: 'b', toId: 'c', relation: 'parent' },
        { fromId: 'c', toId: 'd', relation: 'spouse' },
      ])
    ).toBe('Grandparent of Spouse of');
    expect(
      describeKinshipSteps([
        { fromId: 'a', toId: 'b', relation: 'parent' },
        { fromId: 'b', toId: 'c', relation: 'spouse' },
        { fromId: 'c', toId: 'd', relation: 'parent' },
      ])
    ).toBe('Related by marriage (3 steps)');

    expect(
      computeLifeOverlap(
        makePerson({ id: 'a', slug: 'a', full_name: 'A', birth_year: null }),
        makePerson({ id: 'b', slug: 'b', full_name: 'B', birth_year: 1900 })
      )
    ).toBeNull();
    expect(
      computeLifeOverlap(
        makePerson({ id: 'a', slug: 'a', full_name: 'A', birth_year: 1800, death_year: 1850 }),
        makePerson({ id: 'b', slug: 'b', full_name: 'B', birth_year: 1900, is_living: true }),
        2026
      )
    ).toBeNull();
    expect(
      computeLifeOverlap(
        makePerson({ id: 'a', slug: 'a', full_name: 'A', birth_year: 1950, is_living: true }),
        makePerson({ id: 'b', slug: 'b', full_name: 'B', birth_year: 1940 }),
        2026
      )
    ).toEqual({ start: 1950, end: 2012, durationYears: 62 });

    const harbor = makePlace({ id: 'plc_h', slug: 'h', name: 'Harbor', full_name: 'Harbor, Ohio' });
    const usa = makePlace({ id: 'plc_u', slug: 'u', name: 'USA', full_name: 'USA', place_type: 'country' });
    const bundle = makeBundle({
      people: [
        makePerson({ id: 'p1', slug: 'p1', full_name: 'A', birth_year: 1850, death_year: 1920 }),
        makePerson({ id: 'p2', slug: 'p2', full_name: 'B', birth_year: 1880, death_year: 1950 }),
        makePerson({ id: 'p3', slug: 'p3', full_name: 'C' }),
      ],
      places: [harbor, usa],
      events: [
        makeEvent({ id: 'e0', title: 'No place', place_id: null }),
        makeEvent({
          id: 'e1',
          title: 'Shared',
          place_id: 'plc_h',
          participants: [
            { person_id: 'p1', role: 's' },
            { person_id: 'p2', role: 's' },
          ],
        }),
        makeEvent({
          id: 'e2',
          title: 'Country',
          place_id: 'plc_u',
          participants: [
            { person_id: 'p1', role: 's' },
            { person_id: 'p2', role: 's' },
          ],
        }),
      ],
      kinship: [
        { from: 'p1', to: 'p2', relation: 'parent' },
        { from: 'p2', to: 'p1', relation: 'child' },
      ],
    });
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    expect(findKinshipPath({ fromId: 'p1', toId: 'p1', bundle, placesById }).relationshipLabel).toBe(
      'Same person'
    );
    expect(findKinshipPath({ fromId: 'p1', toId: 'p3', bundle, placesById }).connected).toBe(false);
    const found = findKinshipPath({ fromId: 'p1', toId: 'p2', bundle, placesById });
    expect(found.connected).toBe(true);
    expect(found.sharedPlaces).toHaveLength(1);
  });

  it('covers domain/citations and inline markdown citations branches', () => {
    expect(classifySourceTier(null)).toBe('unverified');
    expect(classifySourceTier({ id: 's1', citation: 'C', source_type: 'census' })).toBe('primary');
    expect(classifySourceTier({ id: 's2', citation: 'C', source_type: 'newspaper' })).toBe('published');
    expect(classifySourceTier({ id: 's3', citation: 'C', source_type: 'family_memoir' })).toBe('family');
    expect(classifySourceTier({ id: 's4', citation: 'C', source_type: 'memorial' })).toBe('derivative');
    expect(classifySourceTier({ id: 's5', citation: 'C', source_type: 'custom_unknown' })).toBe('derivative');

    expect(formatSourceTypeLabel('')).toBe('Archival record');
    expect(formatSourceTypeLabel('vital__record')).toBe('Vital  Record');
    expect(formatConfidenceLabel('high')).toBe('Direct evidence');
    expect(formatConfidenceLabel('medium')).toBe('Corroborating evidence');
    expect(formatConfidenceLabel('low')).toBe('Unverified / indirect');
    expect(formatConfidenceLabel(undefined)).toBe('Recorded');
    expect(formatConfidenceLabel('high', 'unverified')).toBe('Unverified claim');

    const missingCit = buildLibrarianCitation(undefined, { source_id: 'src_x' });
    expect(missingCit.title).toBe('src_x');
    const fullCit = buildLibrarianCitation(
      {
        id: 's1',
        citation: '1880 Census by Clerk',
        author: 'Clerk',
        publisher: 'Harbor Press',
        repository: '!!!',
        source_type: 'census',
        url: 'not-a-valid-url',
      },
      { source_id: 's1', confidence: 'high', citation_detail: 'Sheet 4' }
    );
    expect(fullCit.author).toBeNull();
    expect(fullCit.urlHost).toBeNull();
    expect(fullCit.bibliographicString).toContain('Harbor Press');

    const sourcesById = new Map<string, SourceRecord>([
      ['s_p', { id: 's_p', citation: 'Census', source_type: 'census' }],
      ['s_pub', { id: 's_pub', citation: 'News', source_type: 'newspaper' }],
      ['s_fam', { id: 's_fam', citation: 'Memoir', source_type: 'family_memoir' }],
      ['s_d1', { id: 's_d1', citation: 'Idx 1', source_type: 'archival_index' }],
      ['s_d2', { id: 's_d2', citation: 'Idx 2', source_type: 'archival_index' }],
      [
        UNVERIFIED_TREE_SOURCE_ID,
        { id: UNVERIFIED_TREE_SOURCE_ID, citation: 'Unv', source_type: 'unverified_tree_entry' },
      ],
    ]);
    expect(summarizeEventCitations([], sourcesById).onlyUnverified).toBe(true);
    expect(
      summarizeEventCitations([{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }], sourcesById)
        .onlyUnverified
    ).toBe(true);
    expect(
      summarizeEventCitations(
        [
          { source_id: 's_p', confidence: 'high' },
          { source_id: 's_pub', confidence: 'medium' },
          { source_id: 's_fam', confidence: 'medium' },
          { source_id: 's_d1', confidence: 'low' },
          { source_id: 's_d2', confidence: 'low' },
          { source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' },
        ],
        sourcesById
      ).label
    ).toBe('6 Sources · 1 Primary, 1 Published, 1 Family, 2 Indexes, 1 Uncited');

    expect(findSourceUsages('', null)).toEqual({ usages: [], linkedMedia: [] });
    const usageBundle = makeBundle({
      people: [makePerson({ id: 'p1', slug: 'p1', full_name: 'Arthur Alder' })],
      events: [
        makeEvent({
          id: 'e1',
          title: 'Undated',
          year: null,
          sources: [{ source_id: 's_p', confidence: 'high' }],
        }),
        makeEvent({
          id: 'e2',
          title: 'Dated',
          year: 1880,
          participants: [{ person_id: 'p1', role: 'subject' }],
          sources: [{ source_id: 's_p', confidence: 'high' }],
        }),
      ],
      media: [{ id: 'm1', kind: 'record_scan', source_id: 's_p', file: '/s.jpg', caption: 'Scan' }],
    });
    const usages = findSourceUsages('s_p', usageBundle);
    expect(usages.usages.map((u) => u.event.id)).toEqual(['e2', 'e1']);
    expect(usages.linkedMedia).toHaveLength(1);

    // Inline markdown citations
    const ordered = orderNarrativeSources(
      'Ref [^s_p] again [^s_p]',
      ['s_p', 's_missing', 's_pub'],
      sourcesById
    );
    expect(ordered.map((o) => [o.source.id, o.footnoteNumber])).toEqual([
      ['s_p', 1],
      ['s_pub', null],
    ]);

    expect(isPreviewableCitationImage({ id: 'm1', kind: 'video_story', file: '/a.jpg', caption: 'c' })).toBe(
      false
    );
    expect(
      isPreviewableCitationImage({
        id: 'm2',
        kind: 'document_scan',
        file: '/a.jpg',
        mime_type: 'application/pdf',
        caption: 'c',
      })
    ).toBe(false);
    expect(
      isPreviewableCitationImage({
        id: 'm3',
        kind: 'portrait',
        file: '/a.jpg',
        person_name: 'Living',
        caption: 'c',
      })
    ).toBe(false);
    expect(
      isPreviewableCitationImage({ id: 'm4', kind: 'document_scan', file: '/a.pdf', caption: 'c' })
    ).toBe(false);

    expect(resolveCitationMedia('s_p', null, [])).toBeNull();
    const mediaList: MediaItem[] = [
      { id: 'm_pdf', kind: 'document_scan', file: '/a.pdf', caption: 'PDF', source_id: 's_p' },
      { id: 'm_ev', kind: 'record_scan', file: '/ev.jpg', caption: 'Ev', event_id: 'e2', person_id: 'p1' },
    ];
    expect(resolveCitationMedia('s_p', 'm_pdf', mediaList, 'p1', usageBundle.events)?.id).toBe('m_ev');
    expect(resolveCitationMedia('s_none', null, mediaList, null, usageBundle.events)).toBeNull();

    const errs = validateNarrativeCitations(
      [{ id: 'n_empty' }, { id: 'n1', body_md: 'Bad [^s_bad|m_bad] repeat [^s_bad|m_bad]' }],
      new Set(['s_p']),
      new Set(['m_ok'])
    );
    expect(errs).toHaveLength(2);
  });
});

describe('brandkit and brandkitSvg branch coverage', () => {
  it('renders favicon, icon variants, OG cards, manifests, and route metadata across surfaces and edge cases', () => {
    expect(renderFaviconSvg()).toContain('Kinloom icon');
    expect(
      renderFaviconSvg({ label: 'Alder', accent: '#123456', customMarkInnerSvg: '<circle r="2"/>' })
    ).toContain('<circle r="2"/>');

    expect(renderIconSvg({ size: 192, variant: 'any', transparentBackground: true })).not.toContain('<rect');
    expect(renderIconSvg({ size: 180, variant: 'apple', surface: 'navy' })).toContain('#1B2A41');
    expect(
      renderIconSvg({ size: 512, variant: 'maskable', customMarkInnerSvg: '<path d="M0 0"/>' })
    ).toContain('<path d="M0 0"/>');

    const navyOg = renderOgCardSvg({
      title: 'Alder Chronicles of Harbor County Frontier Settlement',
      subtitle: 'Historical Records of Northern Cedar Township and Surrounding Valleys',
      surface: 'navy',
      kicker: 'ARCHIVE',
      metadataLine: '1820–1940',
      footerCredit: 'Alder Heritage',
      customMarkInnerSvg: '<rect width="4" height="4"/>',
      vignetteDataUri: 'data:image/png;base64,AAAA',
    });
    expect(navyOg).toContain('#1B2A41');
    expect(navyOg).toContain('…');
    expect(navyOg).toContain('kl-vignette-clip');

    const shortOg = renderOgCardSvg({ title: 'Alder', subtitle: 'Short' });
    expect(shortOg).toContain('font-size="92"');
    const medOneLineOg = renderOgCardSvg({ title: 'Alder Chronicles', subtitle: 'Medium' });
    expect(medOneLineOg).toContain('font-size="78"');
    const twoLineShortOg = renderOgCardSvg({ title: 'AlderLineage Settlement', subtitle: 'Two lines' });
    expect(twoLineShortOg).toContain('font-size="86"');
    const emptyTitleOg = renderOgCardSvg({ title: '   ', subtitle: '' });
    expect(emptyTitleOg).toContain('<svg');

    const config = parseKinloomConfig({
      site: { title: 'Supercalifragilistic Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_ARCHIVE' },
      brand: { showFooterCredit: false, surface: 'navy', dynamicOg: true },
    });
    const spec = resolveBrandSpec(config);
    expect(spec.shortName).toBe('Supercalifragili');
    expect(spec.footerCredit).toBeNull();
    expect(buildWebManifest(config).background_color).toBe('#171614');
    expect(buildWebManifest(null).background_color).toBe('#F5EFE2');
    expect(renderBrandkitHeadTags(config, { footerCredit: 'Custom' })).toContain('og:title');

    expect(formatDeceasedLifespan({ birth_edtf: '1850', death_edtf: '1920' })).toBe('1850–1920');
    expect(formatDeceasedLifespan({ birth_edtf: '1850', death_edtf: '' })).toBe('b. 1850');
    expect(formatDeceasedLifespan({ birth_edtf: '', death_edtf: '1920' })).toBe('d. 1920');
    expect(formatDeceasedLifespan({ birth_edtf: '', death_edtf: '' })).toBe('Historical Record');

    expect(resolveRouteOgMetadata({ siteConfig: config }).ogType).toBe('website');
    expect(
      resolveRouteOgMetadata({
        siteConfig: config,
        person: makeRawPerson({
          id: 'p1',
          slug: 'p1',
          full_name: 'Unknown Birth',
          birth_edtf: '1900',
          death_edtf: '',
        }),
      }).redacted
    ).toBe(true);
    const deceasedMeta = resolveRouteOgMetadata({
      siteConfig: config,
      person: makeRawPerson({ id: 'p2', slug: 'p2', full_name: '   ', death_edtf: '1920' }),
      referenceYear: 2026,
    });
    expect(deceasedMeta.ogType).toBe('profile');
    expect(deceasedMeta.title).toContain('Historical Person');
    expect(deceasedMeta.imagePath).toBe('/og/person/p2.svg');
  });
});

describe('patchArchive, revisions, and entityLifecycle branch coverage', () => {
  it('covers incremental patching across all entity mutators and reconcilers', () => {
    const config = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_ARCHIVE' },
      pronunciations: { Alder: { phonetic: 'ALL-der' } },
    });
    const ohio = makePlace({
      id: 'plc_oh',
      slug: 'oh',
      name: 'Ohio',
      full_name: 'Ohio',
      place_type: 'state',
      lat: 40,
      lng: -82,
    });
    const harbor = makePlace({
      id: 'plc_h',
      slug: 'h',
      name: 'Harbor',
      full_name: 'Harbor, Ohio',
      place_type: 'town',
      parent_id: 'plc_oh',
      lat: 40.0,
      lng: -82.0,
    });
    const p1 = makePerson({
      id: 'p1',
      slug: 'p1',
      full_name: 'Arthur Alder',
      birth_edtf: '1850',
      death_edtf: '1920',
      portrait_url: '/p1.jpg',
      event_count: 1,
      media_count: 1,
    });
    const p2 = makePerson({
      id: 'p2',
      slug: 'p2',
      full_name: 'Clara Birch',
      birth_edtf: '1860',
      death_edtf: '1930',
    });
    const ev1 = makeEvent({
      id: 'ev1',
      title: 'Residence of Arthur Alder',
      event_kind: 'residence_anchor',
      edtf_date: '1880',
      year: 1880,
      time_min: daysSinceEpoch(1880, 1, 1),
      time_max: daysSinceEpoch(1880, 12, 31),
      place_id: 'plc_h',
      place_ancestors: ['plc_oh'],
      photo_url: '/hero1.jpg',
      photo_placeholder_caption: 'Hero 1',
      participants: [{ person_id: 'p1', role: 'resident' }],
    });

    const baseBundle = makeBundle({
      meta: {
        version: '1.0',
        build_mode: 'public',
        generated_at: '2026-01-01T00:00:00Z',
        max_revision_id: 5,
        counts: {
          people: 2,
          living_redacted: 0,
          events: 1,
          residence_spans: 0,
          places: 2,
          sources: 1,
          media: 2,
        },
      },
      people: [p1, p2],
      places: [ohio, harbor],
      place_ancestors: { plc_oh: [], plc_h: ['plc_oh'] },
      events: [ev1],
      kinship: [{ from: 'p1', to: 'p2', relation: 'spouse' }],
      sources: [{ id: 'src_1', citation: 'Census', source_type: 'census' }],
      media: [
        { id: 'med_por', kind: 'portrait', file: '/p1.jpg', caption: 'Portrait', person_id: 'p1' },
        {
          id: 'med_hero',
          kind: 'family_photo',
          file: '/hero1.jpg',
          caption: 'Hero 1',
          event_id: 'ev1',
          person_id: 'p1',
        },
      ],
      narratives: undefined,
    });

    // Empty mutations branch
    const noop = patchCompiledBundle(baseBundle, [], config, 'public', {
      generatedAt: '2026-02-01T00:00:00Z',
    });
    expect(noop.meta.generated_at).toBe('2026-02-01T00:00:00Z');
    expect(noop.pronunciations).toEqual({ Alder: { phonetic: 'ALL-der' } });

    // Multi-mutation patch covering all mutators & reconcilers
    const patched = patchCompiledBundle(
      baseBundle,
      [
        {
          revision_id: 6,
          entity_type: 'source',
          entity_id: 'src_1',
          action: 'update',
          after_json: { id: 'src_1', citation: '', source_type: 'census' },
        },
        {
          revision_id: 7,
          entity_type: 'source',
          entity_id: 'src_missing',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 8,
          entity_type: 'narrative',
          entity_id: 'n_missing',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 9,
          entity_type: 'narrative',
          entity_id: 'n1',
          action: 'create',
          after_json: {
            id: 'n1',
            slug: 'n1',
            title: 'Arthur Story',
            body_md: 'Text',
            subject_person_id: 'p1',
            person_ids: ['p1'],
          },
        },
        {
          revision_id: 10,
          entity_type: 'kinship_edge',
          entity_id: 'p1|p2|spouse',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 11,
          entity_type: 'kinship_edge',
          entity_id: 'missing',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 12,
          entity_type: 'place',
          entity_id: 'plc_missing',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 13,
          entity_type: 'place',
          entity_id: 'plc_h',
          action: 'update',
          after_json: { ...harbor, parent_id: null, lat: 40.02 },
        },
        {
          revision_id: 14,
          entity_type: 'person',
          entity_id: 'p2',
          action: 'update',
          after_json: {
            ...makeRawPerson({
              id: 'p2',
              slug: 'p2-renamed',
              full_name: 'Clara Birch Renamed',
              birth_edtf: '1860',
              death_edtf: '1930',
            }),
          },
        },
        {
          revision_id: 15,
          entity_type: 'person',
          entity_id: 'p1',
          action: 'update',
          after_json: {
            ...makeRawPerson({
              id: 'p1',
              slug: 'p1',
              full_name: 'Arthur Alder',
              is_living: true,
              portrait_url: '/p1.jpg',
            }),
          },
        },
        {
          revision_id: 16,
          entity_type: 'person',
          entity_id: 'p_missing',
          action: 'delete',
          after_json: null,
        },
        {
          revision_id: 17,
          entity_type: 'media',
          entity_id: 'med_liv_blocked',
          action: 'create',
          after_json: {
            id: 'med_liv_blocked',
            kind: 'portrait',
            file: '/bad.jpg',
            caption: 'Blocked',
            person_id: 'p1',
          },
        },
        {
          revision_id: 18,
          entity_type: 'media',
          entity_id: 'med_p2_hero',
          action: 'create',
          after_json: {
            id: 'med_p2_hero',
            kind: 'family_photo',
            file: '/hero2.jpg',
            caption: 'Hero 2',
            event_id: 'ev2',
            person_id: 'p2',
          },
        },
        {
          revision_id: 19,
          entity_type: 'event',
          entity_id: 'ev2',
          action: 'create',
          after_json: makeRawEvent({
            id: 'ev2',
            title: 'Clara Residence',
            event_kind: 'residence_anchor',
            edtf_date: '1885',
            place_id: 'plc_h',
            participants: [{ person_id: 'p2', role: 'resident' }],
          }),
        },
        {
          revision_id: 20,
          entity_type: 'media',
          entity_id: 'med_missing',
          action: 'delete',
          after_json: null,
        },
      ],
      config,
      'public',
      { referenceYear: 2026 }
    );

    expect(patched.meta.max_revision_id).toBe(20);
    // p1 became living -> ev1 (all-living) redacted away, med_por & med_hero dropped, n1 scrubbed
    expect(patched.events.map((e) => e.id)).toEqual(['ev2']);
    expect(patched.events[0]?.photo_url).toBe('/hero2.jpg');
    expect(patched.media?.map((m) => m.id)).toEqual(['med_p2_hero']);
    expect(patched.narratives?.[0]?.subject_person_id).toBeUndefined();

    // Now delete med_p2_hero, transition p1 back to deceased, update ev2 to living-only, and delete n1
    const patched2 = patchCompiledBundle(
      patched,
      [
        {
          revision_id: 21,
          entity_type: 'media',
          entity_id: 'med_p2_hero',
          action: 'delete',
          after_json: null,
        },
        { revision_id: 22, entity_type: 'narrative', entity_id: 'n1', action: 'delete', after_json: null },
        {
          revision_id: 23,
          entity_type: 'person',
          entity_id: 'p1',
          action: 'update',
          after_json: makeRawPerson({
            id: 'p1',
            slug: 'p1',
            full_name: 'Arthur Alder',
            is_living: false,
            death_edtf: '1920',
          }),
        },
        {
          revision_id: 24,
          entity_type: 'event',
          entity_id: 'ev2',
          action: 'update',
          after_json: makeRawEvent({
            id: 'ev2',
            title: 'Clara Residence Updated',
            edtf_date: '1890',
            place_id: 'plc_h',
            participants: [{ person_id: 'p2', role: 'resident' }],
          }),
        },
      ],
      config,
      'public',
      { referenceYear: 2026 }
    );
    expect(patched2.events[0]?.photo_url).toBeUndefined();
    expect(patched2.narratives).toEqual([]);
  });

  it('covers revisions diff/apply/revert and entityLifecycle state machine error & revert paths', () => {
    expect(computeEntityDiff(null, null).hasChanges).toBe(false);
    const diff = computeEntityDiff(
      { id: '1', nested: { a: 1, b: [1, 2] }, extra: 'x', obj: { k1: 1 } },
      { id: '1', nested: { a: 2, b: [1, 3] }, added: 'y', obj: { k2: 1 } }
    );
    expect(diff.addedCount).toBe(2);
    expect(diff.removedCount).toBe(2);
    expect(diff.changedCount).toBe(2);

    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: '2026-01-01T00:00:00Z' },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'create',
          data: { id: '1' },
          summary: 'c',
        }
      )
    ).toThrow(/soft-deleted/);
    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: null },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'create',
          data: { id: '1' },
          summary: 'c',
        }
      )
    ).toThrow(/already exists/);
    expect(() =>
      applyEntityPatch(null, {
        entity_type: 'source',
        entity_id: '1',
        action: 'update',
        merge: true,
        data: { id: '1' },
        summary: 'u',
      })
    ).toThrow(/does not exist/);
    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: null, revisionId: 2 },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'update',
          merge: true,
          parent_revision_id: 1,
          data: { id: '1' },
          summary: 'u',
        }
      )
    ).toThrow(/Optimistic concurrency/);
    const replaceUpdate = applyEntityPatch(
      { data: { id: '1', old: true }, deletedAt: null },
      {
        entity_type: 'source',
        entity_id: '1',
        action: 'update',
        merge: false,
        data: { id: '1' },
        summary: 'u',
      }
    );
    expect(replaceUpdate.after).toEqual({ id: '1' });

    expect(() =>
      applyEntityPatch(null, { entity_type: 'source', entity_id: '1', action: 'delete', summary: 'd' })
    ).toThrow(/already deleted/);
    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: null, revisionId: 2 },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'delete',
          parent_revision_id: 1,
          summary: 'd',
        }
      )
    ).toThrow(/Optimistic concurrency/);
    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: null },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'restore',
          summary: 'r',
        }
      )
    ).toThrow(/not soft-deleted/);
    expect(() =>
      applyEntityPatch(
        { data: { id: '1' }, deletedAt: '2026-01-01T00:00:00Z', revisionId: 2 },
        {
          entity_type: 'source',
          entity_id: '1',
          action: 'restore',
          parent_revision_id: 1,
          summary: 'r',
        }
      )
    ).toThrow(/Optimistic concurrency/);
    const restoredWithData = applyEntityPatch(
      { data: { id: '1', a: 1 }, deletedAt: '2026-01-01T00:00:00Z' },
      { entity_type: 'source', entity_id: '1', action: 'restore', data: { b: 2 }, summary: 'r' }
    );
    expect(restoredWithData.after).toEqual({ id: '1', a: 1, b: 2 });

    const rev1: RevisionRecord = {
      revision_id: 1,
      batch_id: null,
      entity_type: 'source',
      entity_id: 's1',
      action: 'create',
      parent_revision_id: null,
      reverted_revision_id: null,
      author_id: 'usr_1',
      author_name: 'Tester',
      author_type: 'human',
      has_primary_source: true,
      before_json: null,
      after_json: { id: 's1', citation: 'V1' },
      summary: 'Create s1',
      created_at: '2026-01-01T00:00:00Z',
    };
    const rev2: RevisionRecord = {
      ...rev1,
      revision_id: 2,
      action: 'update',
      parent_revision_id: 1,
      before_json: { id: 's1', citation: 'V1' },
      after_json: { id: 's1', citation: 'V2' },
      summary: 'Update s1',
    };

    expect(buildRevertPayload({ id: 's1', citation: 'V2' }, rev2).summary).toContain('Revert revision r2');
    const batchPayloads = buildBatchRevertPayloads(
      new Map([['source:s1', { id: 's1', citation: 'V2' }]]),
      [rev1, rev2],
      { summaryPrefix: 'Undo batch' }
    );
    expect(batchPayloads).toHaveLength(2);
    expect(batchPayloads[1]?.soft_delete).toBe(true);

    // entityLifecycle machine
    const nonExistent: EntityLifecycleState = { kind: 'nonExistent' };
    expect(
      transitionEntityLifecycle(
        nonExistent,
        { type: 'delete', expectedParentRevisionId: 1, summary: 'd', nowIso: '2026-01-01T00:00:00Z' },
        1
      )
    ).toMatchObject({ ok: false, status: 404, code: 'ENTITY_NOT_FOUND' });

    const activeState: EntityLifecycleState = {
      kind: 'active',
      currentRevisionId: 2,
      data: { id: 's1', citation: 'V2' },
    };
    const deletedState: EntityLifecycleState = {
      kind: 'softDeleted',
      currentRevisionId: 3,
      lastData: { id: 's1', citation: 'V2' },
      deletedAt: '2026-01-01T00:00:00Z',
    };

    expect(
      transitionEntityLifecycle(
        activeState,
        { type: 'restore', expectedParentRevisionId: 2, summary: 'r' },
        3
      )
    ).toMatchObject({ ok: false, code: 'ENTITY_ALREADY_ACTIVE' });
    expect(
      transitionEntityLifecycle(
        deletedState,
        { type: 'update', expectedParentRevisionId: 3, data: { id: 's1' }, summary: 'u' },
        4
      )
    ).toMatchObject({ ok: false, code: 'ENTITY_IS_SOFT_DELETED' });
    expect(
      transitionEntityLifecycle(
        deletedState,
        { type: 'restore', expectedParentRevisionId: 3, data: { extra: 1 }, summary: 'r' },
        4
      )
    ).toMatchObject({
      ok: true,
      nextState: { kind: 'active', data: { id: 's1', citation: 'V2', extra: 1 } },
    });
    expect(
      transitionEntityLifecycle(
        deletedState,
        { type: 'revert', targetRevision: rev1, nowIso: '2026-01-01T00:00:00Z' },
        4
      )
    ).toMatchObject({ ok: false, code: 'NO_OP_REVERT' });

    const batchOk = transitionBatchRevertLifecycle(new Map([['source:s1', activeState]]), [rev1, rev2], 10, {
      nowIso: '2026-01-02T00:00:00Z',
      summaryPrefix: 'Rollback',
    });
    expect(batchOk.ok).toBe(true);

    const batchFail = transitionBatchRevertLifecycle(new Map(), [rev1], 10, {
      nowIso: '2026-01-02T00:00:00Z',
    });
    expect(batchFail).toMatchObject({ ok: false, status: 404, failedRevisionId: 1 });
  });
});
