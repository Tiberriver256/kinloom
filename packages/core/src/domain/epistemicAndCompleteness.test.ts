import { describe, expect, it } from 'vitest';
import { UNVERIFIED_TREE_SOURCE_ID } from '../gedcom/citations.js';
import type { ArchiveEvent, Person, SourceRecord } from '../schemas/entities.js';
import { computePersonCompleteness } from './completeness.js';
import { EPISTEMIC_TIER_CATALOG, EPISTEMIC_TIER_ORDER, resolveEpistemicTier } from './epistemicTiers.js';

function makePerson(overrides: Partial<Person> = {}): Person {
  return {
    id: 'per_barton_clara',
    slug: 'clara-barton',
    full_name: 'Clara Barton',
    given_name: 'Clara',
    surname: 'Barton',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1821-12-25',
    death_edtf: '1912-04-12',
    birth_year: 1821,
    death_year: 1912,
    event_count: 0,
    primary_place_id: null,
    portrait_url: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ArchiveEvent> = {}): ArchiveEvent {
  return {
    id: 'evt_1870_census',
    title: '1870 U.S. Federal Census',
    scope: 'family',
    event_kind: 'residence_anchor',
    edtf_date: '1870-06-01',
    display_date: 'June 1, 1870',
    year: 1870,
    time_min: 1870,
    time_max: 1870,
    place_id: 'plc_oxford',
    summary: 'Enumerated in Oxford, Massachusetts.',
    participants: [{ person_id: 'per_barton_clara', role: 'subject' }],
    sources: [],
    ...overrides,
  };
}

const SOURCES_BY_ID = new Map<string, SourceRecord>([
  [
    'src_census_1870',
    {
      id: 'src_census_1870',
      citation: '1870 U.S. Federal Census, Worcester County, Massachusetts',
      source_type: 'census',
      has_primary_source: true,
    },
  ],
  [
    'src_county_history',
    {
      id: 'src_county_history',
      citation: 'History of Worcester County (1889)',
      source_type: 'county_history',
      has_primary_source: true,
    },
  ],
  [
    'src_family_memoir',
    {
      id: 'src_family_memoir',
      citation: 'Barton Family Letters',
      source_type: 'family_memoir',
      has_primary_source: false,
    },
  ],
  [
    UNVERIFIED_TREE_SOURCE_ID,
    {
      id: UNVERIFIED_TREE_SOURCE_ID,
      citation: 'Imported family tree entry',
      source_type: 'unverified_tree_entry',
      has_primary_source: false,
    },
  ],
]);

describe('Unified 3-tier epistemic vocabulary', () => {
  it('exposes all three canonical tiers in display order with distinct margin rules and glyphs', () => {
    expect(EPISTEMIC_TIER_ORDER).toEqual(['cited', 'inferred', 'open_question']);
    expect(EPISTEMIC_TIER_CATALOG.cited.label).toBe('Cited');
    expect(EPISTEMIC_TIER_CATALOG.cited.marginRuleStyle).toBe('solid');
    expect(EPISTEMIC_TIER_CATALOG.inferred.label).toBe('Family memory / Inferred');
    expect(EPISTEMIC_TIER_CATALOG.inferred.marginRuleStyle).toBe('dashed');
    expect(EPISTEMIC_TIER_CATALOG.open_question.label).toBe('Discrepancy / Open question');
    expect(EPISTEMIC_TIER_CATALOG.open_question.marginRuleStyle).toBe('dotted');
  });

  it('maps /time entries and conflicts onto unified tiers', () => {
    expect(resolveEpistemicTier({ kind: 'time_entry', tier: 'Confirmed' })).toMatchObject({
      tier: 'cited',
      compactLabel: 'Cited',
      conflictCount: 0,
    });
    expect(resolveEpistemicTier({ kind: 'time_entry', tier: 'Inferred' })).toMatchObject({
      tier: 'inferred',
      compactLabel: 'Inferred',
    });
    expect(resolveEpistemicTier({ kind: 'time_entry', tier: 'Possible' })).toMatchObject({
      tier: 'open_question',
      compactLabel: 'Open question · approx.',
    });
    expect(
      resolveEpistemicTier({ kind: 'time_entry', tier: 'Confirmed', hasConflict: true, conflictCount: 2 })
    ).toMatchObject({
      tier: 'open_question',
      compactLabel: 'Discrepancy (2)',
      conflictCount: 2,
    });
    expect(resolveEpistemicTier({ kind: 'time_entry', tier: 'Confirmed', hasConflict: true })).toMatchObject({
      tier: 'open_question',
      compactLabel: 'Discrepancy',
      conflictCount: 0,
    });
  });

  it('maps events and records by conflicts first, then primary/published vs family/unverified sources', () => {
    expect(
      resolveEpistemicTier({
        kind: 'event',
        sources: [{ source_id: 'src_census_1870' }],
        alternateDatesCount: 1,
        sourcesById: SOURCES_BY_ID,
      })
    ).toMatchObject({
      tier: 'open_question',
      compactLabel: 'Discrepancy (1)',
      conflictCount: 1,
    });

    expect(
      resolveEpistemicTier({
        kind: 'event',
        sources: [{ source_id: 'src_county_history' }],
        sourcesById: SOURCES_BY_ID,
      })
    ).toMatchObject({
      tier: 'cited',
      compactLabel: 'Cited',
    });

    expect(
      resolveEpistemicTier({
        kind: 'event',
        sources: [{ source_id: 'src_family_memoir' }],
        sourcesById: SOURCES_BY_ID,
      })
    ).toMatchObject({
      tier: 'inferred',
      compactLabel: 'Family memory',
    });

    expect(
      resolveEpistemicTier({
        kind: 'event',
        sources: [],
        hasPrimarySource: true,
      })
    ).toMatchObject({
      tier: 'cited',
      compactLabel: 'Cited',
    });

    expect(
      resolveEpistemicTier({
        kind: 'record',
        hasPrimarySource: false,
      })
    ).toMatchObject({
      tier: 'inferred',
      compactLabel: 'Family memory',
    });

    expect(
      resolveEpistemicTier({
        kind: 'record',
        sourceIds: [UNVERIFIED_TREE_SOURCE_ID],
      })
    ).toMatchObject({
      tier: 'inferred',
      compactLabel: 'Family memory',
    });

    expect(
      resolveEpistemicTier({
        kind: 'record',
        sourceIds: ['src_census_1870'],
      })
    ).toMatchObject({
      tier: 'cited',
      compactLabel: 'Cited',
    });

    expect(
      resolveEpistemicTier({
        kind: 'record',
        hasPrimarySource: true,
        hasConflict: true,
        conflictCount: 3,
      })
    ).toMatchObject({
      tier: 'open_question',
      compactLabel: 'Discrepancy (3)',
    });
  });
});

describe('Archival completeness classifier', () => {
  it('returns null for redacted living placeholders', () => {
    const redactedLiving = makePerson({
      id: 'per_living_stub',
      full_name: 'Living',
      is_living: true,
    });
    expect(
      computePersonCompleteness({
        person: redactedLiving,
        personEvents: [],
        biographyCount: 0,
        mediaCount: 0,
        sourcesById: SOURCES_BY_ID,
      })
    ).toBeNull();
  });

  it('classifies named living profiles in private mode normally', () => {
    const namedLiving = makePerson({
      id: 'per_named_living',
      full_name: 'Evelyn Mercer',
      is_living: true,
    });
    const result = computePersonCompleteness({
      person: namedLiving,
      personEvents: [],
      biographyCount: 0,
      mediaCount: 0,
      sourcesById: SOURCES_BY_ID,
    });
    expect(result).toEqual({
      tier: 'oral_seed',
      label: 'Oral Seed',
      pipCount: 1,
      citedEventCount: 0,
      uncitedEventCount: 0,
      biographyCount: 0,
      mediaCount: 0,
      inviteCopy:
        'This profile is an oral seed. If you have a photo, letter, or date for this relative, add a note or citation.',
    });
  });

  it('classifies oral_seed when zero cited personal/family events and zero biographies exist (ignoring local context)', () => {
    const result = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({
          id: 'evt_unverified',
          sources: [{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }],
        }),
        makeEvent({
          id: 'evt_local_context',
          scope: 'local',
          sources: [{ source_id: 'src_census_1870', confidence: 'high' }],
        }),
      ],
      biographyCount: 0,
      mediaCount: 0,
      sourcesById: SOURCES_BY_ID,
    });
    expect(result).toMatchObject({
      tier: 'oral_seed',
      label: 'Oral Seed',
      pipCount: 1,
      citedEventCount: 0,
      uncitedEventCount: 1,
    });
  });

  it('classifies partially_cited with singular/plural uncited invite copy or deepen copy', () => {
    const oneUncited = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({ id: 'evt_1', sources: [{ source_id: 'src_census_1870', confidence: 'high' }] }),
        makeEvent({ id: 'evt_2', sources: [] }),
      ],
      biographyCount: 0,
      mediaCount: 1,
      sourcesById: SOURCES_BY_ID,
    });
    expect(oneUncited).toMatchObject({
      tier: 'partially_cited',
      label: 'Partially Cited',
      pipCount: 2,
      citedEventCount: 1,
      uncitedEventCount: 1,
      inviteCopy: '1 entry still needs a primary source citation.',
    });

    const twoUncited = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({ id: 'evt_1', sources: [{ source_id: 'src_census_1870', confidence: 'high' }] }),
        makeEvent({ id: 'evt_2', sources: [] }),
        makeEvent({ id: 'evt_3', sources: [{ source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' }] }),
      ],
      biographyCount: 1,
      mediaCount: 0,
      sourcesById: SOURCES_BY_ID,
    });
    expect(twoUncited?.inviteCopy).toBe('2 entries still need a primary source citation.');

    const singleCitedNoUncited = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({ id: 'evt_1', sources: [{ source_id: 'src_county_history', confidence: 'high' }] }),
      ],
      biographyCount: 0,
      mediaCount: 0,
      sourcesById: SOURCES_BY_ID,
    });
    expect(singleCitedNoUncited).toMatchObject({
      tier: 'partially_cited',
      label: 'Partially Cited',
      pipCount: 2,
      inviteCopy: 'A primary record is attached, and additional photos or stories can deepen this profile.',
    });
  });

  it('classifies well_documented for >=3 cited with 0 uncited, or >=2 cited with >=1 biography and 0 uncited', () => {
    const threeCited = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({ id: 'evt_1', sources: [{ source_id: 'src_census_1870', confidence: 'high' }] }),
        makeEvent({ id: 'evt_2', sources: [{ source_id: 'src_county_history', confidence: 'high' }] }),
        makeEvent({ id: 'evt_3', sources: [{ source_id: 'src_census_1870', confidence: 'high' }] }),
      ],
      biographyCount: 0,
      mediaCount: 2,
      sourcesById: SOURCES_BY_ID,
    });
    expect(threeCited).toMatchObject({
      tier: 'well_documented',
      label: 'Well-Documented',
      pipCount: 3,
      inviteCopy: null,
    });

    const twoCitedPlusBio = computePersonCompleteness({
      person: makePerson(),
      personEvents: [
        makeEvent({ id: 'evt_1', sources: [{ source_id: 'src_census_1870', confidence: 'high' }] }),
        makeEvent({ id: 'evt_2', sources: [{ source_id: 'src_county_history', confidence: 'high' }] }),
      ],
      biographyCount: 1,
      mediaCount: 0,
      sourcesById: SOURCES_BY_ID,
    });
    expect(twoCitedPlusBio).toMatchObject({
      tier: 'well_documented',
      label: 'Well-Documented',
      pipCount: 3,
      inviteCopy: null,
    });
  });
});
