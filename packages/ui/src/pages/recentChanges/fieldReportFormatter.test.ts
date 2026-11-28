import type { ArchiveBundle, RevisionRecord } from '@kinloom/core';
import { asRevisionId, compileArchive, parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { formatFieldLabel, formatRevisionDiffValue } from '../../lib/revisionFieldFormat.js';
import {
  detectDuplicateEventWarnings,
  formatBatchReportSummary,
  formatRevisionHeadline,
} from './fieldReportFormatter.js';
import {
  buildEntityLinkMap,
  getEmptyRevisionFeedMessage,
  groupRevisionsByBatch,
  isFeedGroupReviewed,
} from './recentChangesViewModel.js';

const SITE_CONFIG = parseKinloomConfig({
  site: {
    title: 'Barton Historical Archive',
    familyName: 'Barton',
    gedcomSourceName: 'BARTON_TEST',
  },
});

const { bundle: SAMPLE_BUNDLE }: { bundle: ArchiveBundle } = compileArchive({
  siteConfig: SITE_CONFIG,
  mode: 'public',
  places: [
    {
      id: 'plc_oxford',
      slug: 'oxford-ma',
      name: 'Oxford',
      full_name: 'Oxford, Worcester County, Massachusetts',
      place_type: 'town',
      parent_id: null,
      lat: 42.11,
      lng: -71.86,
    },
  ],
  sources: [
    {
      id: 'src_census_1880',
      citation: '1880 U.S. Federal Census, Worcester County, MA',
      source_type: 'census',
      has_primary_source: true,
    },
  ],
  people: [
    {
      id: 'per_clara',
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
      portrait_url: null,
    },
  ],
  events: [
    {
      id: 'evt_1880_census_a',
      title: '1880 U.S. Federal Census',
      category: 'census',
      scope: 'family',
      event_kind: 'residence_anchor',
      edtf_date: '1880-06-01',
      place_id: 'plc_oxford',
      summary: 'Enumerated in Oxford.',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
      sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
    },
    {
      id: 'evt_1880_census_b',
      title: '1880 Census Household',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1880-06-15',
      place_id: 'plc_oxford',
      summary: 'Duplicate household listing.',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
      sources: [{ source_id: 'src_census_1880', confidence: 'medium' }],
    },
    {
      id: 'evt_1880_deed',
      title: '1880 Land Deed Transfer',
      category: 'property',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1880-09-10',
      place_id: 'plc_oxford',
      summary: 'Purchased parcel in Oxford.',
      participants: [{ person_id: 'per_clara', role: 'buyer' }],
      sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
    },
  ],
  kinship: [],
  media: [],
});

function makeRevision(overrides: Partial<RevisionRecord> = {}): RevisionRecord {
  return {
    revision_id: asRevisionId(10),
    batch_id: null,
    entity_type: 'person',
    entity_id: 'per_clara',
    parent_revision_id: asRevisionId(9),
    action: 'update',
    reverted_revision_id: null,
    author_id: 'steward@example.test',
    author_name: 'Archive Steward',
    author_type: 'human',
    summary: 'Verified birth date from vital register',
    has_primary_source: true,
    before_json: { birth_edtf: '1821' },
    after_json: { birth_edtf: '1821-12-25', sources: [{ source_id: 'src_census_1880', confidence: 'high' }] },
    created_at: '2026-06-01T12:00:00Z',
    ...overrides,
  };
}

describe('Research Field Report formatting, diff readability, empty states, and duplicate-event warnings', () => {
  it('maps internal field paths and structured values to plain English and raw JSON', () => {
    const peopleById = new Map(SAMPLE_BUNDLE.people.map((p) => [p.id, p]));
    const sourcesById = new Map(SAMPLE_BUNDLE.sources.map((s) => [s.id, s]));

    expect(formatFieldLabel('birth_edtf')).toBe('Birth date');
    expect(formatFieldLabel('fact_conflicts')).toBe('Fact discrepancies');
    expect(formatFieldLabel('custom_archival_note')).toBe('Custom archival note');
    expect(formatFieldLabel('nested.birth_edtf')).toBe('Nested: Birth date');

    expect(
      formatRevisionDiffValue(
        'sources',
        [{ source_id: 'src_census_1880', confidence: 'high', citation_detail: 'Sheet 4B' }],
        'readable',
        { sourcesById }
      )
    ).toBe('• 1880 U.S. Federal Census, Worcester County, MA · high confidence · Sheet 4B');

    expect(
      formatRevisionDiffValue('participants', [{ person_id: 'per_clara', role: 'subject' }], 'readable', {
        peopleById,
      })
    ).toBe('• Clara Barton (subject)');

    expect(
      formatRevisionDiffValue(
        'alternate_dates',
        [{ edtf_date: '1822', note: 'Tombstone inscription', source_id: 'src_census_1880' }],
        'readable',
        { sourcesById }
      )
    ).toBe('• 1822 — Tombstone inscription (1880 U.S. Federal Census, Worcester County, MA)');

    const longBody = `${'Clara Barton organized relief supplies across Maryland and Virginia. '.repeat(6)}\n\nSecond paragraph of biography.`;
    const formattedBody = formatRevisionDiffValue('body_md', longBody, 'readable');
    expect(formattedBody).toContain('paragraphs]');
    expect(formattedBody).toContain('…');

    expect(formatRevisionDiffValue('is_living', false, 'readable')).toBe('No');
    expect(formatRevisionDiffValue('is_living', true, 'readable')).toBe('Yes');
    expect(formatRevisionDiffValue('is_living', false, 'raw')).toBe('false');
    expect(formatRevisionDiffValue('birth_edtf', undefined, 'readable')).toBe('—');
    expect(formatRevisionDiffValue('birth_edtf', null, 'readable')).toBe('None');
    expect(formatRevisionDiffValue('birth_edtf', null, 'raw')).toBe('null');
    expect(formatRevisionDiffValue('birth_edtf', '', 'readable')).toBe('(empty)');
    expect(formatRevisionDiffValue('birth_edtf', '1821', 'raw')).toBe('1821');
    expect(formatRevisionDiffValue('year', 1880, 'readable')).toBe('1880');
    expect(formatRevisionDiffValue('alt_names', [], 'readable')).toBe('None');
    expect(formatRevisionDiffValue('alt_names', ['Clarissa', 'Clara'], 'readable')).toBe('Clarissa, Clara');
    expect(
      formatRevisionDiffValue('source_ids', ['src_census_1880', 'src_unknown'], 'readable', { sourcesById })
    ).toBe('• 1880 U.S. Federal Census, Worcester County, MA (src_census_1880)\n• src_unknown');
    expect(formatRevisionDiffValue('sources', [42, {}], 'readable', { sourcesById })).toBe(
      '• 42\n• Unknown source'
    );
    expect(
      formatRevisionDiffValue('participants', [42, { person_id: 'per_unknown' }], 'readable', { peopleById })
    ).toBe('• 42\n• per_unknown');
    expect(
      formatRevisionDiffValue(
        'alternate_places',
        [
          { place_name: 'North Oxford', source_id: 'src_unknown' },
          { claim: 'Nurse', note: 'Memoir' },
          {},
          99,
        ],
        'readable',
        { sourcesById }
      )
    ).toBe('• North Oxford (src_unknown)\n• Nurse — Memoir\n• Alternate claim\n• 99');
    expect(formatRevisionDiffValue('body_md', 'Short bio.', 'readable')).toBe('Short bio.');
    expect(formatRevisionDiffValue('extensions', { custom: true }, 'readable')).toContain('"custom": true');
    expect(formatRevisionDiffValue('nested', [{ a: 1 }], 'readable')).toContain('"a": 1');
    expect(formatFieldLabel('___')).toBe('___');
    expect(formatRevisionDiffValue('sources', [{ source_id: 'src_census_1880' }], 'raw')).toContain(
      '"source_id": "src_census_1880"'
    );
  });

  it('produces plain-English headlines for create, update, delete, restore, and revert revisions', () => {
    const linkMap = buildEntityLinkMap(SAMPLE_BUNDLE);
    expect(buildEntityLinkMap(null).size).toBe(0);

    expect(formatRevisionHeadline(makeRevision(), linkMap)).toBe(
      'Updated birth date and sources for Clara Barton'
    );
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: { birth_edtf: '1821' },
          after_json: { birth_edtf: '1821' },
        }),
        linkMap
      )
    ).toBe('Updated Clara Barton');
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: { birth_edtf: '1821' },
          after_json: { birth_edtf: '1821-12-25' },
        }),
        linkMap
      )
    ).toBe('Updated birth date for Clara Barton');
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: {},
          after_json: { birth_edtf: '1821', death_edtf: '1912', full_name: 'Clara Barton' },
        }),
        linkMap
      )
    ).toBe('Updated birth date, death date, and full name for Clara Barton');
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: {},
          after_json: {
            birth_edtf: '1821',
            death_edtf: '1912',
            full_name: 'Clara Barton',
            surname: 'Barton',
          },
        }),
        linkMap
      )
    ).toBe('Updated birth date, death date, and 2 other fields for Clara Barton');
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: null,
          after_json: null,
          action: 'delete',
          entity_type: 'kinship_edge',
          entity_id: 'kin_99',
        }),
        linkMap
      )
    ).toBe('Removed family link: family link (kin_99)');
    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'create',
          entity_type: 'event',
          entity_id: 'evt_no_part',
          before_json: null,
          after_json: {
            title: 'Oxford Town Meeting',
            participants: ['bad', { person_id: 123 }, { person_id: 'per_missing' }],
          },
        }),
        linkMap
      )
    ).toBe('Added event: Oxford Town Meeting');

    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'create',
          entity_type: 'event',
          entity_id: 'evt_1870',
          before_json: null,
          after_json: {
            title: '1870 U.S. Census',
            participants: [{ person_id: 'per_clara', role: 'subject' }],
          },
        }),
        linkMap
      )
    ).toBe('Added event: 1870 U.S. Census for Clara Barton');

    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'delete',
          entity_type: 'event',
          entity_id: 'evt_dup',
          before_json: { title: 'Duplicate 1880 Census entry' },
          after_json: null,
        }),
        linkMap
      )
    ).toBe('Removed event: Duplicate 1880 Census entry');

    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'revert',
          entity_type: 'person',
          entity_id: 'per_clara',
        }),
        linkMap
      )
    ).toBe('Reverted an earlier edit on Clara Barton');

    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'restore',
          entity_type: 'place',
          entity_id: 'plc_oxford',
        }),
        linkMap
      )
    ).toBe('Restored place: Oxford, Worcester County, Massachusetts');
  });

  it('aggregates batch field reports with touched record links and steward review stamps', () => {
    const linkMap = buildEntityLinkMap(SAMPLE_BUNDLE);
    const batchStamp = {
      target_kind: 'batch' as const,
      target_id: 'batch_census_1880',
      reviewer_id: 'steward@example.test',
      reviewer_name: 'Archive Steward',
      note: 'Checked against NARA roll',
      reviewed_at: '2026-06-02T14:00:00Z',
    };
    const batchRevs: RevisionRecord[] = [
      makeRevision({
        revision_id: asRevisionId(20),
        batch_id: 'batch_census_1880',
        action: 'create',
        entity_type: 'event',
        entity_id: 'evt_1880_census_a',
        review: batchStamp,
      }),
      makeRevision({
        revision_id: asRevisionId(21),
        batch_id: 'batch_census_1880',
        action: 'update',
        entity_type: 'person',
        entity_id: 'per_clara',
        review: batchStamp,
      }),
      makeRevision({
        revision_id: asRevisionId(22),
        batch_id: 'batch_census_1880',
        action: 'create',
        entity_type: 'source',
        entity_id: 'src_census_1880',
        review: batchStamp,
      }),
    ];

    const summary = formatBatchReportSummary(batchRevs, linkMap);
    expect(summary.headline).toBe('Research Field Report: 1 event added, 1 person updated, 1 source linked');
    expect(summary.touchedRecords[0]).toEqual({
      key: 'person:per_clara',
      label: 'Clara Barton',
      to: '/person/clara-barton',
    });
    expect(summary.batchReview).toEqual(batchStamp);

    const groups = groupRevisionsByBatch(batchRevs);
    expect(isFeedGroupReviewed(groups[0])).toBe(true);

    const emptyBatchSummary = formatBatchReportSummary([], linkMap);
    expect(emptyBatchSummary.headline).toBe('Research Field Report: 0 changes');
    expect(emptyBatchSummary.batchReview).toBeNull();

    const mixedVerbs = formatBatchReportSummary(
      [
        makeRevision({
          revision_id: asRevisionId(25),
          batch_id: 'batch_mixed',
          action: 'delete',
          entity_type: 'event',
          entity_id: 'evt_del_1',
          before_json: { title: 'Duplicate event' },
          after_json: null,
        }),
        makeRevision({
          revision_id: asRevisionId(26),
          batch_id: 'batch_mixed',
          action: 'restore',
          entity_type: 'place',
          entity_id: 'plc_oxford',
        }),
        makeRevision({
          revision_id: asRevisionId(27),
          batch_id: 'batch_mixed',
          action: 'revert',
          entity_type: 'narrative',
          entity_id: 'nar_1',
          after_json: { title: 'Oxford Bio' },
        }),
        makeRevision({
          revision_id: asRevisionId(28),
          batch_id: 'batch_mixed',
          action: 'create',
          entity_type: 'media',
          entity_id: 'med_1',
          after_json: { caption: 'Homestead Photo' },
        }),
        makeRevision({
          revision_id: asRevisionId(29),
          batch_id: 'batch_mixed',
          action: 'update',
          entity_type: 'person',
          entity_id: 'per_clara',
        }),
      ],
      linkMap
    );
    expect(mixedVerbs.headline).toContain('1 event removed');
    expect(mixedVerbs.headline).toContain('1 place restored');
    expect(mixedVerbs.headline).toContain('1 narrative reverted');
    expect(mixedVerbs.touchedRecords).toHaveLength(4);
    expect(mixedVerbs.totalTouchedCount).toBe(5);
  });

  it('detects same-year duplicate events for a person and ignores unrelated same-year events', () => {
    const revCensus = makeRevision({
      revision_id: asRevisionId(30),
      batch_id: 'batch_dup_test',
      action: 'create',
      entity_type: 'event',
      entity_id: 'evt_1880_census_b',
      after_json: {
        title: '1880 Census Household',
        edtf_date: '1880-06-15',
        scope: 'family',
        participants: [{ person_id: 'per_clara', role: 'subject' }],
      },
    });
    const revDeed = makeRevision({
      revision_id: asRevisionId(31),
      batch_id: null,
      action: 'create',
      entity_type: 'event',
      entity_id: 'evt_1880_deed',
      after_json: {
        title: '1880 Land Deed Transfer',
        category: 'property',
        edtf_date: '1880-09-10',
        scope: 'personal',
        participants: [{ person_id: 'per_clara', role: 'buyer' }],
      },
    });
    const revJaccardA = makeRevision({
      revision_id: asRevisionId(32),
      batch_id: 'batch_jaccard',
      action: 'create',
      entity_type: 'event',
      entity_id: 'evt_1892_farm_a',
      after_json: {
        title: 'Oxford Homestead Orchard Harvest',
        edtf_date: '1892',
        scope: 'family',
        participants: [{ person_id: 'per_clara', role: 'subject' }],
      },
    });
    const revJaccardB = makeRevision({
      revision_id: asRevisionId(33),
      batch_id: 'batch_jaccard',
      action: 'create',
      entity_type: 'event',
      entity_id: 'evt_1892_farm_b',
      after_json: {
        title: 'Oxford Homestead Orchard Harvest Record',
        edtf_date: '1892-10-01',
        scope: 'family',
        participants: [{ person_id: 'per_clara', role: 'subject' }],
      },
    });
    const revIgnoredLocal = makeRevision({
      revision_id: asRevisionId(34),
      batch_id: 'batch_jaccard',
      action: 'create',
      entity_type: 'event',
      entity_id: 'evt_local_storm',
      after_json: {
        title: 'Blizzard',
        year: 1892,
        scope: 'local',
        participants: [{ person_id: 'per_clara', role: 'witness' }],
      },
    });
    const revNoYear = makeRevision({
      revision_id: asRevisionId(35),
      batch_id: 'batch_jaccard',
      action: 'update',
      entity_type: 'event',
      entity_id: 'evt_undated',
      after_json: {
        title: 'Undated note',
        edtf_date: 'unknown',
        scope: 'personal',
        participants: [],
      },
    });

    const groups = groupRevisionsByBatch([
      revCensus,
      revDeed,
      revJaccardA,
      revJaccardB,
      revIgnoredLocal,
      revNoYear,
    ]);
    const warnings = detectDuplicateEventWarnings(groups, SAMPLE_BUNDLE);

    const batchWarnings = warnings.get('batch:batch_dup_test') ?? [];
    expect(batchWarnings).toHaveLength(1);
    expect(batchWarnings[0]).toMatchObject({
      year: 1880,
      personId: 'per_clara',
      personName: 'Clara Barton',
      personSlug: 'clara-barton',
      firstEventId: 'evt_1880_census_a',
      secondEventId: 'evt_1880_census_b',
    });
    expect(warnings.get('rev:31')).toBeUndefined();
    expect(warnings.get('batch:batch_jaccard')).toHaveLength(1);
    expect(detectDuplicateEventWarnings(groups, null).get('batch:batch_jaccard')).toHaveLength(1);
  });

  it('returns accurate empty-state copy for every author filter and unreviewed filter state', () => {
    expect(getEmptyRevisionFeedMessage('all', false)).toContain('No archival changes have been recorded yet');
    expect(getEmptyRevisionFeedMessage('human', false)).toBe(
      'No family editor revisions have been recorded yet.'
    );
    expect(getEmptyRevisionFeedMessage('agent', false)).toBe(
      'No research agent batches have been submitted yet.'
    );
    expect(getEmptyRevisionFeedMessage('system_seed', false)).toBe(
      'No initial archive seed revisions are recorded.'
    );
    expect(getEmptyRevisionFeedMessage('all', true)).toBe(
      'Every recorded change has been marked reviewed by a steward.'
    );
    expect(getEmptyRevisionFeedMessage('agent', true)).toBe(
      'No unreviewed changes match the active author tab.'
    );
  });

  it('covers narratives, media, fallbacks, same-category duplicates, and plural batch counts', () => {
    const { bundle: extendedBundle } = compileArchive({
      siteConfig: SITE_CONFIG,
      mode: 'private',
      places: [
        {
          id: 'plc_short',
          slug: 'short-town',
          name: 'Short Town',
          full_name: '',
          place_type: 'town',
          parent_id: null,
          lat: 42.1,
          lng: -71.8,
        },
      ],
      sources: [],
      people: [
        {
          id: 'per_clara',
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
          portrait_url: null,
        },
        {
          id: 'per_living',
          slug: 'living-descendant',
          full_name: 'Living',
          given_name: 'Living',
          surname: '',
          alt_names: [],
          sex: 'U',
          is_living: true,
          lineage_group: 'descendant',
          birth_edtf: '',
          death_edtf: '',
          portrait_url: null,
        },
      ],
      events: [
        {
          id: 'evt_local_ignored',
          title: 'Town Fair',
          category: 'civic',
          scope: 'local',
          event_kind: 'point_event',
          edtf_date: '1880-07-04',
          place_id: 'plc_short',
          summary: 'Local civic fair.',
          participants: [],
          sources: [],
        },
        {
          id: 'evt_no_subject',
          title: '',
          category: 'life',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1885',
          place_id: 'plc_short',
          summary: 'No participants.',
          participants: [],
          sources: [],
        },
        {
          id: 'evt_cat_a',
          title: 'Autumn Letter A',
          category: 'correspondence',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1888-03-01',
          place_id: 'plc_short',
          summary: 'First letter.',
          participants: [{ person_id: 'per_clara', role: 'author' }],
          sources: [],
        },
        {
          id: 'evt_cat_b',
          title: 'Winter Dispatch B',
          category: 'correspondence',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1888-11-01',
          place_id: 'plc_short',
          summary: 'Second letter.',
          participants: [{ person_id: 'per_clara', role: 'author' }],
          sources: [],
        },
        {
          id: 'evt_cat_c',
          title: 'Spring Note C',
          category: 'correspondence',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1888-04-01',
          place_id: 'plc_short',
          summary: 'Third letter.',
          participants: [{ person_id: 'per_clara', role: 'author' }],
          sources: [],
        },
      ],
      kinship: [],
      media: [
        {
          id: 'med_captioned',
          kind: 'portrait',
          file: 'media/homestead.jpg',
          caption: 'Oxford Homestead',
          person_ids: ['per_clara'],
        },
        {
          id: 'med_uncaptioned',
          kind: 'document_scan',
          file: 'media/letter.jpg',
          caption: '',
        },
      ],
      narratives: [
        {
          id: 'nar_linked',
          slug: 'clara-relief-work',
          title: 'Relief Work Years',
          body_md: 'Field hospital notes.',
          person_ids: ['per_clara'],
          place_ids: ['plc_short'],
          event_ids: [],
          source_ids: [],
        },
        {
          id: 'nar_unlinked',
          slug: 'untitled-note',
          title: '',
          body_md: 'General overview.',
          person_ids: ['per_living'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
    });

    const linkMap = buildEntityLinkMap(extendedBundle);
    expect(linkMap.get('place:plc_short')?.label).toBe('Short Town');
    expect(linkMap.get('event:evt_no_subject')).toEqual({ label: 'evt_no_subject', to: null });
    expect(linkMap.get('narrative:nar_linked')).toEqual({
      label: 'Relief Work Years',
      to: '/person/clara-barton',
    });
    expect(linkMap.get('narrative:nar_unlinked')).toEqual({ label: 'nar_unlinked', to: null });
    expect(linkMap.get('media:med_captioned')).toEqual({
      label: 'Oxford Homestead',
      to: '/evidence?tab=media',
    });
    expect(linkMap.get('media:med_uncaptioned')).toEqual({
      label: 'med_uncaptioned',
      to: '/evidence?tab=media',
    });

    // Update headline with 1 extra field (singular 'field') and event already naming subject
    expect(
      formatRevisionHeadline(
        makeRevision({
          before_json: {},
          after_json: {
            birth_edtf: '1821',
            death_edtf: '1912',
            full_name: 'Clara Barton',
          },
        }),
        linkMap
      )
    ).toBe('Updated birth date, death date, and full name for Clara Barton');
    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'create',
          entity_type: 'event',
          entity_id: 'evt_named',
          before_json: null,
          after_json: {
            title: 'Clara Barton School Opening',
            participants: [{ person_id: 'per_clara', role: 'subject' }],
          },
        }),
        linkMap
      )
    ).toBe('Added event: Clara Barton School Opening');
    expect(
      formatRevisionHeadline(
        makeRevision({
          action: 'create',
          entity_type: 'event',
          entity_id: 'evt_living',
          before_json: null,
          after_json: {
            title: 'Family Gathering',
            participants: [{ person_id: 'per_living', role: 'subject' }],
          },
        }),
        linkMap
      )
    ).toBe('Added event: Family Gathering');

    // Plural counts and individually-reviewed batch stamp fallback
    const revStamp = {
      target_kind: 'revision' as const,
      target_id: '41',
      reviewer_id: 'steward@example.test',
      reviewer_name: 'Archive Steward',
      note: null,
      reviewed_at: '2026-06-05T10:00:00Z',
    };
    const pluralBatch = formatBatchReportSummary(
      [
        makeRevision({
          revision_id: asRevisionId(41),
          batch_id: 'batch_plural',
          action: 'update',
          entity_type: 'person',
          entity_id: 'per_clara',
          review: revStamp,
        }),
        makeRevision({
          revision_id: asRevisionId(42),
          batch_id: 'batch_plural',
          action: 'update',
          entity_type: 'person',
          entity_id: 'per_living',
          review: { ...revStamp, target_id: '42' },
        }),
      ],
      linkMap
    );
    expect(pluralBatch.headline).toBe('Research Field Report: 2 people updated');
    expect(pluralBatch.batchReview).toEqual(revStamp);

    expect(isFeedGroupReviewed({ key: 'empty', batchId: null, revisions: [] })).toBe(false);

    // Same-category 3-way duplicate bucket + delete/null-after/empty-token/numeric-year revisions
    const groups = groupRevisionsByBatch([
      makeRevision({
        revision_id: asRevisionId(50),
        batch_id: 'batch_cat',
        action: 'update',
        entity_type: 'event',
        entity_id: 'evt_cat_a',
        after_json: { title: 'Autumn Letter A', category: 'correspondence', year: 1888 },
      }),
      makeRevision({
        revision_id: asRevisionId(51),
        batch_id: 'batch_cat',
        action: 'delete',
        entity_type: 'event',
        entity_id: 'evt_cat_b',
        after_json: null,
      }),
      makeRevision({
        revision_id: asRevisionId(52),
        batch_id: 'batch_cat',
        action: 'create',
        entity_type: 'event',
        entity_id: 'evt_num_year_1',
        after_json: {
          title: 'a of in',
          year: 1899,
          scope: 'personal',
          participants: [{ person_id: 'per_clara', role: 'subject' }],
        },
      }),
      makeRevision({
        revision_id: asRevisionId(53),
        batch_id: 'batch_cat',
        action: 'create',
        entity_type: 'event',
        entity_id: 'evt_num_year_2',
        after_json: {
          title: '',
          year: 1899,
          scope: 'personal',
          participants: [{ person_id: 'per_clara', role: 'subject' }],
        },
      }),
    ]);
    const catWarnings = detectDuplicateEventWarnings(groups, extendedBundle).get('batch:batch_cat') ?? [];
    expect(catWarnings.length).toBeGreaterThanOrEqual(2);
  });
});
