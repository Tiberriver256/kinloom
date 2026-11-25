import { describe, expect, it } from 'vitest';
import {
  extractNarrativeCitations,
  isPreviewableCitationImage,
  orderNarrativeSources,
  parseInlineCitationToken,
  resolveCitationMedia,
  validateArchive,
  validateNarrativeCitations,
  type ArchiveEvent,
  type MediaItem,
  type SourceRecord,
} from './index.js';

const DEMO_SOURCES: SourceRecord[] = [
  {
    id: 'src_demo_census_1880',
    citation: '1880 U.S. Federal Census, Riverdale Township, Roll 42, Sheet 9.',
    source_type: 'census',
    repository: 'National Archives (NARA)',
  },
  {
    id: 'src_demo_marriage_1872',
    citation: 'Cedar County Marriage Register, Vol. 3, p. 14 (1872).',
    source_type: 'vital_record',
    repository: 'Cedar County Courthouse',
  },
  {
    id: 'src_demo_diary_1891',
    citation: 'Harriet Aldridge Farm Journal (1891).',
    source_type: 'family_memoir',
    repository: 'Family Archive',
  },
];

const DEMO_MEDIA: MediaItem[] = [
  {
    id: 'med_demo_scan_1',
    kind: 'record_scan',
    source_id: 'src_demo_census_1880',
    person_ids: ['per_other'],
    file: '/media/demo-census-other.jpg',
    caption: '1880 census sheet for neighboring household',
  },
  {
    id: 'med_demo_scan_subject',
    kind: 'record_scan',
    source_id: 'src_demo_census_1880',
    person_ids: ['per_subject'],
    file: '/media/demo-census-subject.jpg',
    caption: '1880 census sheet for subject household',
  },
  {
    id: 'med_demo_explicit_override',
    kind: 'document_scan',
    source_id: 'src_demo_diary_1891',
    person_ids: ['per_subject'],
    file: '/media/demo-diary-page.jpg',
    caption: 'Handwritten 1891 journal page',
  },
  {
    id: 'med_demo_event_photo',
    kind: 'milestone',
    person_ids: ['per_subject'],
    event_id: 'evt_demo_marriage',
    file: '/media/demo-marriage-church.jpg',
    caption: 'Stone chapel where the 1872 ceremony took place',
  },
  {
    id: 'med_demo_audio_only',
    kind: 'audio_oral_history',
    source_id: 'src_demo_audio',
    person_ids: ['per_subject'],
    file: '/media/demo-interview.mp3',
    mime_type: 'audio/mpeg',
    caption: 'Recorded oral history interview',
  },
  {
    id: 'med_demo_living_redacted',
    kind: 'portrait',
    source_id: 'src_demo_redacted',
    person_name: 'Living',
    file: '/media/demo-redacted.jpg',
    caption: 'Redacted portrait',
  },
];

const DEMO_EVENTS: Pick<ArchiveEvent, 'id' | 'participants' | 'sources'>[] = [
  {
    id: 'evt_demo_marriage',
    participants: [{ person_id: 'per_subject', role: 'spouse' }],
    sources: [{ source_id: 'src_demo_marriage_1872', confidence: 'high' }],
  },
];

describe('parseInlineCitationToken', () => {
  it('parses source-only and source-plus-media tokens and rejects malformed syntax', () => {
    expect(parseInlineCitationToken('[^src_demo_census_1880]')).toEqual({
      sourceId: 'src_demo_census_1880',
      mediaId: null,
      raw: '[^src_demo_census_1880]',
    });

    expect(parseInlineCitationToken('[^src_demo_census_1880|med_demo_scan_1]')).toEqual({
      sourceId: 'src_demo_census_1880',
      mediaId: 'med_demo_scan_1',
      raw: '[^src_demo_census_1880|med_demo_scan_1]',
    });

    expect(parseInlineCitationToken('[^]')).toBeNull();
    expect(parseInlineCitationToken('[^src_demo|]')).toBeNull();
    expect(parseInlineCitationToken('[^src with space]')).toBeNull();
    expect(parseInlineCitationToken('[regular link](https://example.org)')).toBeNull();
  });
});

describe('extractNarrativeCitations', () => {
  it('assigns 1-based numbers by first appearance, reuses numbers on repeats, and handles adjacent tokens', () => {
    const markdown = [
      'The household married in 1872[^src_demo_marriage_1872] and farmed near Riverdale.[^src_demo_census_1880][^src_demo_diary_1891]',
      '',
      'A later entry confirmed the census listing[^src_demo_census_1880|med_demo_scan_1] and wedding date.[^src_demo_marriage_1872]',
      '',
      'Literal syntax like `[^src_ignored_in_code]` inside code spans is ignored.',
    ].join('\n');

    const result = extractNarrativeCitations(markdown);

    expect(result.references).toEqual([
      { sourceId: 'src_demo_marriage_1872', number: 1, explicitMediaIds: [] },
      { sourceId: 'src_demo_census_1880', number: 2, explicitMediaIds: ['med_demo_scan_1'] },
      { sourceId: 'src_demo_diary_1891', number: 3, explicitMediaIds: [] },
    ]);
    expect(result.numberBySourceId.get('src_demo_marriage_1872')).toBe(1);
    expect(result.numberBySourceId.get('src_demo_census_1880')).toBe(2);
    expect(result.numberBySourceId.get('src_demo_diary_1891')).toBe(3);
    expect(result.occurrences.map((o) => [o.sourceId, o.mediaId, o.number])).toEqual([
      ['src_demo_marriage_1872', null, 1],
      ['src_demo_census_1880', null, 2],
      ['src_demo_diary_1891', null, 3],
      ['src_demo_census_1880', 'med_demo_scan_1', 2],
      ['src_demo_marriage_1872', null, 1],
    ]);
  });

  it('keeps numbering contiguous when filtering to known source IDs', () => {
    const markdown = 'First[^src_missing] then valid[^src_demo_census_1880] and next[^src_demo_marriage_1872].';
    const known = new Set(['src_demo_census_1880', 'src_demo_marriage_1872']);

    const result = extractNarrativeCitations(markdown, { knownSourceIds: known });

    expect(result.references.map((r) => [r.sourceId, r.number])).toEqual([
      ['src_demo_census_1880', 1],
      ['src_demo_marriage_1872', 2],
    ]);
  });
});

describe('orderNarrativeSources', () => {
  it('places inline-cited sources first in footnote order and appends uncited source_ids', () => {
    const sourcesById = new Map(DEMO_SOURCES.map((s) => [s.id, s]));
    const markdown = 'Recorded in the diary[^src_demo_diary_1891] and census.[^src_demo_census_1880]';

    const ordered = orderNarrativeSources(
      markdown,
      ['src_demo_marriage_1872', 'src_demo_census_1880', 'src_demo_diary_1891'],
      sourcesById,
    );

    expect(ordered.map((entry) => [entry.source.id, entry.footnoteNumber])).toEqual([
      ['src_demo_diary_1891', 1],
      ['src_demo_census_1880', 2],
      ['src_demo_marriage_1872', null],
    ]);
  });
});

describe('resolveCitationMedia', () => {
  it('uses explicit media override when provided and previewable', () => {
    const picked = resolveCitationMedia(
      'src_demo_census_1880',
      'med_demo_explicit_override',
      DEMO_MEDIA,
      'per_subject',
      DEMO_EVENTS,
    );
    expect(picked?.id).toBe('med_demo_explicit_override');
  });

  it('prefers direct source_id media linked to subjectPersonId before other source media', () => {
    const forSubject = resolveCitationMedia(
      'src_demo_census_1880',
      null,
      DEMO_MEDIA,
      'per_subject',
      DEMO_EVENTS,
    );
    expect(forSubject?.id).toBe('med_demo_scan_subject');

    const withoutSubject = resolveCitationMedia(
      'src_demo_census_1880',
      null,
      DEMO_MEDIA,
      null,
      DEMO_EVENTS,
    );
    expect(withoutSubject?.id).toBe('med_demo_scan_1');
  });

  it('falls back to event-linked image media when no media carries source_id directly', () => {
    const picked = resolveCitationMedia(
      'src_demo_marriage_1872',
      null,
      DEMO_MEDIA,
      'per_subject',
      DEMO_EVENTS,
    );
    expect(picked?.id).toBe('med_demo_event_photo');
  });

  it('supports extended event_ids arrays on media items during event fallback', () => {
    const multiEventMedia = [
      {
        id: 'med_demo_multi_evt',
        kind: 'milestone' as const,
        event_ids: ['evt_demo_marriage'],
        file: '/media/demo-multi.jpg',
        caption: 'Multi-event linked photo',
      },
    ];
    const picked = resolveCitationMedia(
      'src_demo_marriage_1872',
      null,
      multiEventMedia,
      'per_subject',
      DEMO_EVENTS,
    );
    expect(picked?.id).toBe('med_demo_multi_evt');
  });

  it('excludes non-image and living-redacted media and returns null when no image exists', () => {
    expect(isPreviewableCitationImage(DEMO_MEDIA[4])).toBe(false);
    expect(isPreviewableCitationImage(DEMO_MEDIA[5])).toBe(false);

    expect(
      resolveCitationMedia('src_demo_audio', null, DEMO_MEDIA, 'per_subject', DEMO_EVENTS),
    ).toBeNull();
    expect(
      resolveCitationMedia('src_demo_redacted', null, DEMO_MEDIA, 'per_subject', DEMO_EVENTS),
    ).toBeNull();
    expect(
      resolveCitationMedia('src_no_media_at_all', null, DEMO_MEDIA, 'per_subject', DEMO_EVENTS),
    ).toBeNull();
  });
});

describe('validateNarrativeCitations and validateArchive integration', () => {
  it('flags dangling inline source IDs and unknown explicit media IDs', () => {
    const errors = validateNarrativeCitations(
      [
        {
          id: 'nar_demo_bio',
          body_md:
            'Valid[^src_demo_census_1880] and missing[^src_demo_missing] plus bad media[^src_demo_census_1880|med_missing].',
        },
      ],
      new Set(['src_demo_census_1880']),
      new Set(['med_demo_scan_1']),
    );

    expect(errors).toEqual([
      "Narrative 'nar_demo_bio' cites unknown inline source_id 'src_demo_missing'.",
      "Narrative 'nar_demo_bio' cites unknown inline media_id 'med_missing' for source 'src_demo_census_1880'.",
    ]);

    const archiveCheck = validateArchive({
      people: [{ id: 'per_subject' }],
      sources: [{ id: 'src_demo_census_1880' }],
      media: [{ id: 'med_demo_scan_1', person_ids: ['per_subject'], source_id: 'src_demo_census_1880' }],
      narratives: [
        {
          id: 'nar_demo_bio',
          kind: 'biography',
          subject_person_id: 'per_subject',
          person_ids: ['per_subject'],
          place_ids: [],
          event_ids: [],
          source_ids: ['src_demo_census_1880'],
          body_md: 'Fact with dangling footnote[^src_unknown_token].',
        },
      ],
    });

    expect(archiveCheck.ok).toBe(false);
    expect(archiveCheck.errors).toEqual([
      "Narrative 'nar_demo_bio' cites unknown inline source_id 'src_unknown_token'.",
    ]);
  });
});
