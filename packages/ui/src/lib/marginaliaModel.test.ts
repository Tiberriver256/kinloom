import type { MediaItem, SourceRecord } from '@kinloom/core';
import { extractNarrativeCitations } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { parseMarkdownBlocks } from '../components/markdown/archivalMarkdownParser.js';
import { buildEventMarginaliaItems, partitionMarkdownBlockMarginalia } from './marginaliaModel.js';

const SOURCES: readonly SourceRecord[] = [
  {
    id: 'src_census_1880',
    citation: '1880 U.S. Federal Census, Sangamon County, Illinois, ED 201, Sheet 14.',
    source_type: 'census',
    repository: 'National Archives (NARA)',
  },
  {
    id: 'src_diary_1884',
    citation: 'Clara Barton Field Diary, 1884.',
    source_type: 'family_memoir',
    repository: 'Library of Congress',
  },
  {
    id: 'src_county_history',
    citation: 'History of Sangamon County (1881), p. 412.',
    source_type: 'county_history',
    repository: 'Illinois State Archives',
  },
];

const SOURCES_BY_ID = new Map<string, SourceRecord>(SOURCES.map((s) => [s.id, s]));

describe('marginaliaModel (#70)', () => {
  it('assigns citations to their first-appearance Markdown block, deduplicates repeats, ignores code spans, and appends uncited trailing sources', () => {
    const markdown = [
      '### Early Years',
      '',
      'Clara enumerated in 1880[^src_census_1880] while keeping notes `[^src_county_history]`.',
      '',
      '> She repeated the census observation[^src_census_1880] and wrote her 1884 journal.[^src_diary_1884]',
      '',
      '- Confirmed again in the diary.[^src_diary_1884]',
    ].join('\n');

    const blocks = parseMarkdownBlocks(markdown);
    const extractedCitations = extractNarrativeCitations(markdown, { knownSourceIds: SOURCES_BY_ID });
    const mediaItems: MediaItem[] = [
      {
        id: 'med_census',
        kind: 'record_scan',
        source_id: 'src_census_1880',
        person_ids: ['per_clara'],
        file: '/media/census-1880.jpg',
        caption: '1880 Census Sheet 14',
      },
    ];

    const result = partitionMarkdownBlockMarginalia({
      blocks,
      extractedCitations,
      narrativeSourceIds: ['src_census_1880', 'src_county_history', 'src_county_history', 'src_missing'],
      sourcesById: SOURCES_BY_ID,
      readableSourceIds: new Set(['src_diary_1884']),
      mediaItems,
      subjectPersonId: 'per_clara',
      resolveScanUrl: (media) => `https://archive.example${media.file}`,
    });

    // Block 0: heading -> no citations
    expect(result.byBlockIndex[0]).toEqual([]);

    // Block 1: paragraph -> first appearance of [1] src_census_1880 (code span ignored)
    expect(result.byBlockIndex[1]).toHaveLength(1);
    expect(result.byBlockIndex[1][0]).toMatchObject({
      kind: 'citation',
      footnoteNumber: 1,
      sourceId: 'src_census_1880',
      tierLabel: 'Primary Record',
      repository: 'National Archives (NARA)',
      isReadable: false,
      scanUrl: 'https://archive.example/media/census-1880.jpg',
      scanTitle: '1880 Census Sheet 14',
    });

    // Block 2: blockquote -> src_census_1880 is deduplicated; only first appearance of [2] src_diary_1884 appears
    expect(result.byBlockIndex[2]).toHaveLength(1);
    expect(result.byBlockIndex[2][0]).toMatchObject({
      kind: 'citation',
      footnoteNumber: 2,
      sourceId: 'src_diary_1884',
      tierLabel: 'Family Account',
      isReadable: true,
      scanUrl: null,
    });

    // Block 3: list -> repeat of src_diary_1884 deduplicated
    expect(result.byBlockIndex[3]).toEqual([]);

    // Trailing uncited narrativeSourceIds: src_county_history once with footnoteNumber null, unknown skipped
    expect(result.trailingCitations).toHaveLength(1);
    expect(result.trailingCitations[0]).toMatchObject({
      kind: 'citation',
      footnoteNumber: null,
      sourceId: 'src_county_history',
      tierLabel: 'Published / Archival History',
    });
  });

  it('builds numbered citations and sequential date, place, and fact discrepancy glosses for events', () => {
    const items = buildEventMarginaliaItems({
      sources: [
        {
          source_id: 'src_census_1880',
          citation_detail: 'Roll 42, Line 18',
          confidence: 'high',
          scan_url: '/scans/roll42.jpg',
          scan_title: 'Roll 42 Scan',
        },
        {
          source_id: 'src_census_1880',
          citation_detail: 'Roll 42, Line 18',
          confidence: 'high',
          scan_url: '/scans/roll42.jpg',
          scan_title: 'Roll 42 Scan',
        },
        {
          source_id: 'src_diary_1884',
          confidence: 'medium',
        },
      ],
      alternateDates: [
        {
          edtf_date: '1880-06-04',
          source_id: 'src_diary_1884',
          note: 'Diary places enumeration three days later.',
        },
      ],
      alternatePlaces: [
        {
          place_name: 'Chatham Township',
          source_id: 'src_county_history',
          note: 'County atlas lists southern precinct.',
        },
      ],
      factConflicts: [
        {
          claim: 'Occupation recorded as miller',
          source_id: 'src_census_1880',
          note: 'Other ledger records carpenter.',
        },
      ],
      sourcesById: SOURCES_BY_ID,
      readableSourceIds: new Set(['src_diary_1884']),
    });

    expect(items).toHaveLength(5);

    expect(items[0]).toMatchObject({
      kind: 'citation',
      footnoteNumber: 1,
      sourceId: 'src_census_1880',
      callNumberOrDetail: 'Roll 42, Line 18',
      scanUrl: '/scans/roll42.jpg',
      scanTitle: 'Roll 42 Scan',
      isReadable: false,
    });
    expect(items[1]).toMatchObject({
      kind: 'citation',
      footnoteNumber: 2,
      sourceId: 'src_diary_1884',
      isReadable: true,
    });
    expect(items[2]).toMatchObject({
      kind: 'discrepancy',
      indexNumber: 1,
      category: 'date',
      claim: '1880-06-04',
      note: 'Diary places enumeration three days later.',
      sourceId: 'src_diary_1884',
    });
    expect(items[3]).toMatchObject({
      kind: 'discrepancy',
      indexNumber: 2,
      category: 'place',
      claim: 'Chatham Township',
      sourceId: 'src_county_history',
    });
    expect(items[4]).toMatchObject({
      kind: 'discrepancy',
      indexNumber: 3,
      category: 'fact',
      claim: 'Occupation recorded as miller',
      sourceId: 'src_census_1880',
    });
  });

  it('covers default media scan resolution, missing caption fallback, empty alternate dates, and unknown discrepancy sources', () => {
    const markdown = 'Referenced census[^src_census_1880] and diary.[^src_diary_1884]';
    const blocks = parseMarkdownBlocks(markdown);
    const extractedCitations = extractNarrativeCitations(markdown, { knownSourceIds: SOURCES_BY_ID });
    const mediaItems: MediaItem[] = [
      {
        id: 'med_census_no_caption',
        kind: 'record_scan',
        source_id: 'src_census_1880',
        person_ids: ['per_clara'],
        file: '/media/census-full.jpg',
        thumb_file: '/media/census-thumb.jpg',
        caption: '',
      },
      {
        id: 'med_diary_file_only',
        kind: 'record_scan',
        source_id: 'src_diary_1884',
        person_ids: ['per_clara'],
        file: '/media/diary-full.jpg',
        caption: '',
      },
    ];

    const partitioned = partitionMarkdownBlockMarginalia({
      blocks,
      extractedCitations,
      narrativeSourceIds: [],
      sourcesById: SOURCES_BY_ID,
      readableSourceIds: new Set(),
      mediaItems,
      subjectPersonId: 'per_clara',
    });
    expect(partitioned.byBlockIndex[0]?.[0]).toMatchObject({
      scanUrl: '/media/census-thumb.jpg',
      scanTitle: '1880 U.S. Federal Census, Sangamon County, Illinois, ED 201, Sheet 14.',
    });
    expect(partitioned.byBlockIndex[0]?.[1]).toMatchObject({
      scanUrl: '/media/diary-full.jpg',
    });

    const items = buildEventMarginaliaItems({
      sources: [
        {
          source_id: 'src_census_1880',
          claimed_date: '1880-06-01',
          confidence: 'high',
        },
      ],
      alternateDates: [{ edtf_date: '', source_id: 'src_unknown', note: 'Uncertain date.' }],
      alternatePlaces: [{ place_name: 'Unknown Twp', source_id: 'src_unknown', note: 'Uncertain place.' }],
      factConflicts: [{ claim: 'Other claim', source_id: 'src_unknown', note: 'Uncertain fact.' }],
      sourcesById: SOURCES_BY_ID,
      readableSourceIds: new Set(),
    });
    expect(items[0]).toMatchObject({ claimedDate: '1880-06-01', scanUrl: null, scanTitle: null });
    expect(items[1]).toMatchObject({ claim: 'Alternate date', sourceLabel: null });
    expect(items[2]).toMatchObject({ sourceLabel: null });
    expect(items[3]).toMatchObject({ sourceLabel: null });
  });
});
