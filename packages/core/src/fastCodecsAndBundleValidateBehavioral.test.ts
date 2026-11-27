import fc from 'fast-check';
import { CORE_SCHEMA, load as loadJsYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  ArchiveBundleSchema,
  asRevisionId,
  buildEntityId,
  compileArchive,
  deriveKinshipEdgeId,
  fastLocaleCompare,
  getMediaPersonIds,
  isTrustedArchiveBundle,
  KinloomSiteConfigSchema,
  KinshipEdgeSchema,
  MediaChecklistItemSchema,
  MediaItemSchema,
  NarrativeSchema,
  PlaceSchema,
  parseEventsYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  parseYaml,
  RawEventSchema,
  RawPersonSchema,
  ReadingsBundleSchema,
  resolveDefaultBranchId,
  SourceRecordSchema,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  storedRecordToEntityPayload,
  stringifyYaml,
  toEntityPayload,
  tryValidateArchiveBundle,
  tryValidateMediaChecklistItems,
  tryValidateReadingsBundle,
  yamlStr,
} from './index.js';

function createRichCanonicalBundle() {
  const siteConfig = KinloomSiteConfigSchema.parse({
    site: {
      title: 'Alder & Mercer Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_GEDCOM',
    },
    branches: [
      { id: 'alder', label: 'Alder' },
      { id: 'mercer', label: 'Mercer' },
    ],
    pronunciations: {
      alder: { phonetic: 'AL-der', ipa: '/ˈɔːldər/' },
    },
  });

  const { bundle } = compileArchive({
    siteConfig,
    mode: 'private',
    generatedAt: '2026-11-27T00:00:00.000Z',
    version: '1.2.0',
    maxRevisionId: 42,
    referenceYear: 2026,
    people: [
      {
        id: 'per_alder_1',
        slug: 'clara-alder-1880',
        gedcom_xref: '@I1@',
        full_name: 'Clara Alder',
        given_name: 'Clara',
        surname: 'Alder',
        alt_names: ['Clara M. Alder'],
        sex: 'F',
        is_living: false,
        lineage_group: 'alder',
        branch: 'alder',
        birth_edtf: '1880-04-12',
        death_edtf: '1958-09-03',
        portrait_url: 'media/clara.jpg',
        thumb_url: 'media/clara-thumb.jpg',
        pronunciation: {
          phonetic: 'AL-der',
          ipa: '/ˈɔːldər/',
          language: 'en',
          audio_url: 'audio/alder.mp3',
          note: 'Midwestern pronunciation',
          source_url: 'https://example.org/alder',
          source_label: 'Alder Family Notes',
          region: 'Midwest',
        },
        has_primary_source: true,
        extensions: { custom_tag: 'pioneer' },
      },
      {
        id: 'per_mercer_2',
        slug: 'thomas-mercer-1878',
        full_name: 'Thomas Mercer',
        given_name: 'Thomas',
        surname: 'Mercer',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'mercer',
        birth_edtf: '1878',
        death_edtf: '1950',
        portrait_url: null,
      },
    ],
    events: [
      {
        id: 'evt_birth_1',
        title: 'Birth of Clara Alder',
        scope: 'personal',
        event_kind: 'residence_anchor',
        category: 'vital',
        edtf_date: '1880-04-12',
        alternate_dates: [{ edtf_date: '1880-04-13', source_id: 'src_1', note: 'Parish copy' }],
        place_id: 'plc_hudsonville',
        place_precision: 'town',
        summary: 'Born at the Alder homestead.',
        severity_rank: 1,
        source_url: 'https://example.org/vital/1',
        photo_url: 'media/homestead.jpg',
        photo_placeholder_caption: 'Alder Homestead',
        participants: [{ person_id: 'per_alder_1', role: 'principal' }],
        sources: [
          {
            source_id: 'src_1',
            confidence: 'high',
            claimed_date: '1880-04-12',
            citation_detail: 'Vol. 2, p. 14',
            scan_url: 'media/page14.jpg',
            scan_title: 'Register Page 14',
          },
        ],
        has_primary_source: true,
      },
      {
        id: 'evt_res_2',
        title: 'Residence in Grand Rapids',
        scope: 'family',
        event_kind: 'residence_anchor',
        edtf_date: '1910',
        place_id: 'plc_hudsonville',
        summary: '1910 enumeration.',
        participants: [
          { person_id: 'per_alder_1', role: 'head' },
          { person_id: 'per_mercer_2', role: 'spouse' },
        ],
        sources: [{ source_id: 'src_1', confidence: 'medium' }],
      },
    ],
    places: [
      {
        id: 'plc_mi',
        slug: 'michigan',
        name: 'Michigan',
        full_name: 'Michigan, USA',
        place_type: 'state',
        parent_id: null,
        lat: 44.3148,
        lng: -85.6024,
      },
      {
        id: 'plc_hudsonville',
        slug: 'hudsonville-mi',
        name: 'Hudsonville',
        full_name: 'Hudsonville, Michigan, USA',
        place_type: 'town',
        parent_id: 'plc_mi',
        lat: 42.8709,
        lng: -85.865,
        summary: 'Ottawa County settlement.',
        photo_url: 'media/town.jpg',
        photo_caption: 'Main street',
        pronunciation: { phonetic: 'HUD-sun-vil' },
        has_primary_source: true,
      },
    ],
    sources: [
      {
        id: 'src_1',
        gedcom_xref: '@S1@',
        citation: 'Ottawa County Birth Register, 1880',
        author: 'County Clerk',
        publisher: 'Ottawa County',
        source_type: 'vital_record',
        repository: 'County Archives',
        url: 'https://example.org/registers/1880',
        has_primary_source: true,
      },
    ],
    kinship: [
      {
        from: 'per_alder_1',
        to: 'per_mercer_2',
        relation: 'spouse',
        family_xref: '@F1@',
      },
    ],
    media: [
      {
        id: 'med_1',
        kind: 'audio_oral_history',
        source_id: 'src_1',
        page: 1,
        person_id: 'per_alder_1',
        person_ids: ['per_alder_1', 'per_mercer_2'],
        person_slug: 'clara-alder-1880',
        person_name: 'Clara Alder',
        event_id: 'evt_birth_1',
        file: 'media/oral-history.mp3',
        thumb_file: 'media/oral-thumb.jpg',
        caption: 'Clara Alder oral history recording',
        date_edtf: '1952',
        provenance: 'Mercer family tape archive',
        mime_type: 'audio/mpeg',
        duration_seconds: 185,
        poster_url: 'media/poster.jpg',
        transcript_url: 'media/transcript.vtt',
        has_primary_source: true,
      },
    ],
    narratives: [
      {
        id: 'nar_1',
        slug: 'alder-homestead-story',
        kind: 'family_story',
        subject_person_id: 'per_alder_1',
        title: 'The Alder Homestead Years',
        summary: 'Memories of early Ottawa County.',
        body_md: 'Clara Alder and Thomas Mercer settled near Hudsonville.',
        date_edtf: '1910',
        person_ids: ['per_alder_1'],
        place_ids: ['plc_hudsonville'],
        event_ids: ['evt_birth_1'],
        source_ids: ['src_1'],
        updated_at: '2026-11-27T00:00:00.000Z',
        has_primary_source: true,
      },
    ],
  });
  return JSON.parse(JSON.stringify(bundle)) as Record<string, unknown>;
}

describe('Bundle fast-validation behavioral equivalence with Zod schemas', () => {
  it('accepts canonical ArchiveBundles, marks them trusted, and matches ArchiveBundleSchema.parse', () => {
    const raw = createRichCanonicalBundle();
    const fast = tryValidateArchiveBundle(raw);
    expect(fast).not.toBeNull();
    expect(fast && isTrustedArchiveBundle(fast)).toBe(true);
    expect(fast).toEqual(ArchiveBundleSchema.parse(raw));
  });

  it('rejects malformed or exotic ArchiveBundle payloads by returning null without false positives', () => {
    const base = createRichCanonicalBundle();
    const cloneWith = (mutator: (draft: Record<string, any>) => void) => {
      const draft = structuredClone(base) as Record<string, any>;
      mutator(draft);
      return draft;
    };

    const invalidOrFallbackCases: unknown[] = [
      null,
      [],
      { meta: null },
      cloneWith((d) => {
        d.meta.build_mode = 'staging';
      }),
      cloneWith((d) => {
        d.meta.max_revision_id = -1;
      }),
      cloneWith((d) => {
        d.meta.uncited_entity_keys = [123];
      }),
      cloneWith((d) => {
        d.meta.counts.people = -3;
      }),
      cloneWith((d) => {
        d.meta.counts.media = 'bad';
      }),
      cloneWith((d) => {
        d.people = 'not-array';
      }),
      cloneWith((d) => {
        d.place_ancestors = [];
      }),
      cloneWith((d) => {
        d.people[0] = null;
      }),
      cloneWith((d) => {
        d.people[0].id = '';
      }),
      cloneWith((d) => {
        d.people[0].birth_year = 1880.5;
      }),
      cloneWith((d) => {
        d.people[0].pronunciation = 'AL-der';
      }),
      cloneWith((d) => {
        d.people[0].pronunciation = { phonetic: 123 };
      }),
      cloneWith((d) => {
        d.people[0].pronunciation = { phonetic: 'AL-der', variants: [] };
      }),
      cloneWith((d) => {
        d.events[0] = 'bad';
      }),
      cloneWith((d) => {
        d.events[0].scope = 'galactic';
      }),
      cloneWith((d) => {
        d.events[0].alternate_places = [
          { place_name: 'Old Hudsonville', place_id: 'plc_mi', source_id: 'src_1', note: '' },
        ];
      }),
      cloneWith((d) => {
        d.events[0].alternate_dates = 'bad';
      }),
      cloneWith((d) => {
        d.events[0].alternate_dates = [{ edtf_date: '1880', source_id: '', note: '' }];
      }),
      cloneWith((d) => {
        d.events[0].participants = 'bad';
      }),
      cloneWith((d) => {
        d.events[0].participants = [{ person_id: '', role: 'head' }];
      }),
      cloneWith((d) => {
        d.events[0].sources = 'bad';
      }),
      cloneWith((d) => {
        d.events[0].sources = [null];
      }),
      cloneWith((d) => {
        d.events[0].sources = [{ source_id: 'src_1', confidence: 'certain' }];
      }),
      cloneWith((d) => {
        d.events[0].sources = [{ source_id: 'src_1', confidence: 'high', scan_url: 42 }];
      }),
      cloneWith((d) => {
        d.residence_spans = [{ id: '', person_id: 'p', place_id: 'plc', time_min: 1, time_max: 2 }];
      }),
      cloneWith((d) => {
        d.places[0] = null;
      }),
      cloneWith((d) => {
        d.places[0].lat = 120;
      }),
      cloneWith((d) => {
        d.places[0].historical_names = [{ name: 'Old Town' }];
      }),
      cloneWith((d) => {
        d.place_ancestors.plc_hudsonville = [42];
      }),
      cloneWith((d) => {
        d.kinship[0].relation = 'cousin';
      }),
      cloneWith((d) => {
        d.sources[0].url = 99;
      }),
      cloneWith((d) => {
        d.media = 'bad';
      }),
      cloneWith((d) => {
        d.media[0].duration_seconds = -5;
      }),
      cloneWith((d) => {
        d.media[0].person_ids = [''];
      }),
      cloneWith((d) => {
        d.media[0].extensions = { raw: true };
      }),
      cloneWith((d) => {
        d.narratives = 'bad';
      }),
      cloneWith((d) => {
        d.narratives[0].kind = 'poem';
      }),
      cloneWith((d) => {
        d.narratives[0].extensions = { draft: true };
      }),
      cloneWith((d) => {
        d.pronunciations = [];
      }),
      cloneWith((d) => {
        d.pronunciations.alder = null;
      }),
    ];

    for (const candidate of invalidOrFallbackCases) {
      expect(tryValidateArchiveBundle(candidate)).toBeNull();
    }
  });

  it('validates ReadingsBundle and MediaChecklistItem arrays in lockstep with Zod', () => {
    const validReadings = {
      version: 1,
      documents: {
        doc_alder: {
          source_id: 'src_1',
          title: 'Alder Ledger',
          author: 'Clara Alder',
          provenance: 'Family chest',
          pdf_url: 'media/ledger.pdf',
          pdf_size_bytes: 2048,
          pages: [
            {
              page: 1,
              label: 'Cover',
              file: 'pages/1.txt',
              text: 'Alder family record',
              image_url: 'pages/1.jpg',
            },
          ],
        },
      },
      event_page_map: {
        evt_birth_1: { doc_alder: 1 },
      },
    };
    expect(tryValidateReadingsBundle(validReadings)).toEqual(ReadingsBundleSchema.parse(validReadings));
    expect(tryValidateReadingsBundle(null)).toBeNull();
    expect(tryValidateReadingsBundle({ version: 0, documents: {}, event_page_map: {} })).toBeNull();
    expect(tryValidateReadingsBundle({ version: 1, documents: null, event_page_map: {} })).toBeNull();
    expect(
      tryValidateReadingsBundle({
        version: 1,
        documents: { bad: { source_id: '', title: 'T', author: 'A', provenance: 'P', pages: [] } },
        event_page_map: {},
      })
    ).toBeNull();
    expect(
      tryValidateReadingsBundle({
        version: 1,
        documents: {
          bad_page: {
            source_id: 'src_1',
            title: 'T',
            author: 'A',
            provenance: 'P',
            pages: [{ page: 0, label: 'L', file: 'f', text: 't' }],
          },
        },
        event_page_map: {},
      })
    ).toBeNull();
    expect(
      tryValidateReadingsBundle({
        version: 1,
        documents: {},
        event_page_map: { evt_1: 'bad' },
      })
    ).toBeNull();
    expect(
      tryValidateReadingsBundle({
        version: 1,
        documents: {},
        event_page_map: { evt_1: { doc_alder: 1.5 } },
      })
    ).toBeNull();

    const checklist = [
      {
        person_id: 'per_alder_1',
        person_slug: 'clara-alder-1880',
        person_name: 'Clara Alder',
        lifespan: '1880–1958',
        obje_xref: '@M1@',
        title: 'Homestead Portrait',
        media_type: 'photo',
        form: 'jpg',
        status: 'digitized',
        file: 'media/clara.jpg',
      },
      {
        person_id: 'per_mercer_2',
        person_slug: 'thomas-mercer-1878',
        person_name: 'Thomas Mercer',
        lifespan: '1878–1950',
        obje_xref: '@M2@',
        title: 'Deed Scan',
        media_type: 'document',
        form: 'pdf',
        status: 'missing',
      },
    ];
    expect(tryValidateMediaChecklistItems(checklist)).toEqual(
      MediaChecklistItemSchema.array().parse(checklist)
    );
    expect(tryValidateMediaChecklistItems([{ ...checklist[0], status: 'invalid' }])).toBeNull();
    expect(tryValidateMediaChecklistItems([null])).toBeNull();
  });
});

describe('YAML fast reader, canonical emitter, and fast entity parsers', () => {
  it('matches js-yaml CORE_SCHEMA across block YAML edge cases, scalars, and fallback constructs', () => {
    expect(parseYaml('')).toBeNull();
    expect(parseYaml('   \n  ')).toBeNull();
    expect(parseYaml('# comment only\n')).toBeNull();
    expect(parseYaml('-0.0\n')).toBe(0);

    const samples = [
      '\uFEFF# comment with BOM\n[]\n',
      '{}\r\n',
      'true\n',
      'False\n',
      '~\n',
      'NULL\n',
      '0\n',
      '-42\n',
      '9007199254740991\n',
      '999999999999999999999\n',
      '3.14159\n',
      '1.5e4\n',
      '0x1f\n',
      '0o17\n',
      '.nan\n',
      '.inf\n',
      '"+escaped\\nline\\"quote"\n',
      "'single quoted scalar'\n",
      '---\nid: per_alder_1\n...\n',
      '%YAML 1.2\n---\nid: per_alder_1\n',
      'items:\n  -\n  -\n    - nested_a\n    - nested_b\n  - "quoted:key": "value with # hash"\n    "escaped\\"k": []\n    empty_map: {}\n    null_trailing:\n',
      'block: |\n  line one\n  line two\n',
      'defaults: &def\n  role: witness\nentry: *def\n',
    ];

    for (const yamlText of samples) {
      const expected = loadJsYaml(yamlText, { schema: CORE_SCHEMA }) ?? null;
      const actual = parseYaml(yamlText);
      if (typeof expected === 'number' && Number.isNaN(expected)) {
        expect(Number.isNaN(actual as number)).toBe(true);
      } else {
        expect(actual).toEqual(expected);
      }
    }
  });

  it('round-trips canonical and fallback values through stringifyYaml and parseYaml', () => {
    const complexValue = {
      id: 'per_bramwell_1',
      true: 'keyword-key',
      'key:with:colon': '12345',
      numeric_prose: '1890 Bramwell County Directory',
      empty_str: '',
      special_chars: 'hello: world # note',
      nested_empty: {},
      empty_list: [],
      matrix: [[], ['a', 0, false, null]],
      undefined_skipped: undefined,
    };
    const emitted = stringifyYaml(complexValue, { preferredKeyOrder: ['id'] });
    expect(parseYaml(emitted)).toEqual({
      id: 'per_bramwell_1',
      true: 'keyword-key',
      'key:with:colon': '12345',
      numeric_prose: '1890 Bramwell County Directory',
      empty_str: '',
      special_chars: 'hello: world # note',
      nested_empty: {},
      empty_list: [],
      matrix: [[], ['a', 0, false, null]],
    });

    expect(parseYaml(stringifyYaml(null))).toBeNull();
    expect(parseYaml(stringifyYaml(true))).toBe(true);
    expect(parseYaml(stringifyYaml(42))).toBe(42);
    expect(parseYaml(stringifyYaml('plain-token'))).toBe('plain-token');
    expect(stringifyYaml({ negZero: -0 })).toContain('negZero');
    expect(stringifyYaml([-0])).toContain('-');
    expect(yamlStr('')).toBe('""');
    expect(yamlStr('plain_value')).toBe('plain_value');
    expect(yamlStr('needs: quoting')).toBe('"needs: quoting"');

    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.stringMatching(/^per_[a-z]{3,8}$/),
            note: fc.string({ maxLength: 60 }),
            count: fc.integer({ min: -500, max: 500 }),
            active: fc.boolean(),
            tags: fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }),
          }),
          { maxLength: 8 }
        ),
        (records) => {
          const text = stringifyYaml(records, { preferredKeyOrder: ['id', 'count'] });
          expect(parseYaml(text)).toEqual(records);
        }
      ),
      { numRuns: 40 }
    );
  });

  it('parses and deterministically serializes all 7 archive entity YAML families across fast and Zod-fallback paths', () => {
    expect(parsePeopleYaml('')).toEqual([]);
    expect(parsePeopleYaml('# empty comment\n')).toEqual([]);

    const peopleYaml = stringifyYaml([
      {
        id: 'per_vance_2',
        slug: 'edith-vance-1892',
        gedcom_xref: '@I2@',
        full_name: 'Edith Vance',
        given_name: 'Edith',
        surname: 'Vance',
        branch: 'vance',
        birth_edtf: 1892,
        death_edtf: null,
        thumb_url: 'media/edith-thumb.jpg',
        pronunciation: { phonetic: 'VANS' },
        has_primary_source: true,
        extensions: { note: 'teacher' },
      },
      {
        id: 'per_alder_1',
        slug: 'arthur-alder-1890',
        full_name: 'Arthur Alder',
        given_name: 'Arthur',
        surname: 'Alder',
        pronunciation: {
          phonetic: 'AL-der',
          variants: [{ label: 'Midwest', region: 'Midwest', phonetic: 'AHL-der' }],
        },
      },
    ]);
    const parsedPeople = parsePeopleYaml(peopleYaml);
    expect(parsedPeople).toEqual(
      RawPersonSchema.array().parse(loadJsYaml(peopleYaml, { schema: CORE_SCHEMA }))
    );
    const sortedPeopleYaml = serializePeopleYaml(parsedPeople, { sortById: true });
    expect(parsePeopleYaml(sortedPeopleYaml).map((p) => p.id)).toEqual(['per_alder_1', 'per_vance_2']);
    expect(serializePeopleYaml(parsePeopleYaml(sortedPeopleYaml), { sortById: true })).toBe(sortedPeopleYaml);

    const eventsYaml = stringifyYaml([
      {
        id: 'evt_2',
        title: 'Census',
        scope: 'personal',
        event_kind: 'point_event',
        category: 'census',
        edtf_date: 1920,
        alternate_dates: [{ edtf_date: 1921, source_id: 'src_1', note: null }],
        place_precision: 'town',
        severity_rank: 2,
        source_url: 'https://example.org/c',
        photo_url: 'media/c.jpg',
        photo_placeholder_caption: 'Caption',
        participants: [{ person_id: 'per_alder_1', role: 'head' }],
        sources: [
          {
            source_id: 'src_1',
            confidence: 'high',
            claimed_date: 1920,
            citation_detail: 'Sheet 4B',
            scan_url: 'media/s4.jpg',
            scan_title: 'Sheet 4B',
          },
        ],
        has_primary_source: true,
        extensions: { sheet: '4B' },
      },
      {
        id: 'evt_1',
        title: 'Fallback Event',
        scope: 'local',
        event_kind: 'context_span',
        edtf_date: '1918',
        alternate_places: [
          { place_name: 'Old Hudsonville', place_id: 'plc_1', source_id: 'src_1', note: 'Alt' },
        ],
      },
    ]);
    const parsedEvents = parseEventsYaml(eventsYaml);
    expect(parsedEvents).toEqual(
      RawEventSchema.array().parse(loadJsYaml(eventsYaml, { schema: CORE_SCHEMA }))
    );
    expect(parseEventsYaml(serializeEventsYaml(parsedEvents, { sortById: true })).map((e) => e.id)).toEqual([
      'evt_1',
      'evt_2',
    ]);

    const placesYaml = stringifyYaml([
      {
        id: 'plc_2',
        slug: 'linden-township',
        name: 'Linden',
        full_name: 'Linden Township, MI',
        place_type: 'town',
        parent_id: null,
        lat: 42.8,
        lng: -85.8,
        summary: 'Township',
        photo_url: 'media/linden.jpg',
        photo_caption: 'Linden Hall',
        pronunciation: { phonetic: 'LIN-den' },
        has_primary_source: true,
        extensions: { county: 'Ottawa' },
      },
      {
        id: 'plc_1',
        slug: 'hale-homestead',
        name: 'Hale Homestead',
        full_name: 'Hale Homestead, MI',
        place_type: 'homestead',
        parent_id: 'plc_2',
        lat: 42.81,
        lng: -85.81,
        historical_names: [{ name: 'Old Hale Farm' }],
      },
    ]);
    const parsedPlaces = parsePlacesYaml(placesYaml);
    expect(parsedPlaces).toEqual(PlaceSchema.array().parse(loadJsYaml(placesYaml, { schema: CORE_SCHEMA })));
    expect(parsePlacesYaml(serializePlacesYaml(parsedPlaces, { sortById: true })).map((p) => p.id)).toEqual([
      'plc_1',
      'plc_2',
    ]);

    const sourcesYaml = stringifyYaml([
      {
        id: 'src_2',
        gedcom_xref: '@S2@',
        citation: 'Bramwell Parish Register',
        author: 'Clerk',
        publisher: 'Parish',
        source_type: 'church_record',
        repository: 'Archive',
        url: 'https://example.org/s2',
        has_primary_source: true,
      },
      {
        id: 'src_1',
        citation: 'Alder Bible',
        source_type: 'family_bible',
      },
    ]);
    const parsedSources = parseSourcesYaml(sourcesYaml);
    expect(parsedSources).toEqual(
      SourceRecordSchema.array().parse(loadJsYaml(sourcesYaml, { schema: CORE_SCHEMA }))
    );
    expect(
      parseSourcesYaml(serializeSourcesYaml(parsedSources, { sortById: true })).map((s) => s.id)
    ).toEqual(['src_1', 'src_2']);

    const kinshipYaml = stringifyYaml([
      { from: 'per_vance_2', to: 'per_alder_1', relation: 'spouse', family_xref: '@F9@' },
      { from: 'per_alder_1', to: 'per_vance_2', relation: 'spouse' },
    ]);
    const parsedKinship = parseKinshipYaml(kinshipYaml);
    expect(parsedKinship).toEqual(
      KinshipEdgeSchema.array().parse(loadJsYaml(kinshipYaml, { schema: CORE_SCHEMA }))
    );
    const sortedKinshipYaml = serializeKinshipYaml(parsedKinship, { sortDeterministic: true });
    expect(parseKinshipYaml(sortedKinshipYaml)[0].from).toBe('per_alder_1');
    expect(serializeKinshipYaml(parseKinshipYaml(sortedKinshipYaml), { sortDeterministic: true })).toBe(
      sortedKinshipYaml
    );

    const mediaYaml = stringifyYaml([
      {
        id: 'med_2',
        kind: 'portrait',
        source_id: 'src_1',
        page: 2,
        person_id: 'per_alder_1',
        person_ids: ['per_alder_1'],
        person_slug: 'arthur-alder-1890',
        person_name: 'Arthur Alder',
        event_id: 'evt_1',
        file: 'media/arthur.jpg',
        thumb_file: 'media/arthur-t.jpg',
        caption: 'Arthur Alder',
        date_edtf: 1925,
        provenance: 'Album',
        mime_type: 'image/jpeg',
        duration_seconds: 0,
        poster_url: 'media/p.jpg',
        transcript_url: 'media/t.vtt',
        has_primary_source: true,
        extensions: { plate: 'glass' },
      },
      {
        id: 'med_1',
        kind: 'document_scan',
        file: 'media/deed.jpg',
        caption: 'Deed',
      },
    ]);
    const parsedMedia = parseMediaYaml(mediaYaml);
    expect(parsedMedia).toEqual(
      MediaItemSchema.array().parse(loadJsYaml(mediaYaml, { schema: CORE_SCHEMA }))
    );
    expect(parseMediaYaml(serializeMediaYaml(parsedMedia, { sortById: true })).map((m) => m.id)).toEqual([
      'med_1',
      'med_2',
    ]);

    const narrativesYaml = stringifyYaml([
      {
        id: 'nar_2',
        slug: 'vance-memoir',
        kind: 'memoir',
        subject_person_id: 'per_vance_2',
        title: 'Vance Memoir',
        summary: 'Recollections',
        body_md: 'Memoir text.',
        date_edtf: 1945,
        person_ids: ['per_vance_2'],
        place_ids: ['plc_1'],
        event_ids: ['evt_1'],
        source_ids: ['src_1'],
        updated_at: '2026-11-27T00:00:00.000Z',
        has_primary_source: true,
        extensions: { chapter: 1 },
      },
      {
        id: 'nar_1',
        slug: 'alder-bio',
        title: 'Alder Bio',
        body_md: 'Biography text.',
      },
    ]);
    const parsedNarratives = parseNarrativesYaml(narrativesYaml);
    expect(parsedNarratives).toEqual(
      NarrativeSchema.array().parse(loadJsYaml(narrativesYaml, { schema: CORE_SCHEMA }))
    );
    expect(
      parseNarrativesYaml(serializeNarrativesYaml(parsedNarratives, { sortById: true })).map((n) => n.id)
    ).toEqual(['nar_1', 'nar_2']);

    expect(() => parsePeopleYaml('not_an_array: true\n')).toThrow();
    expect(() => parsePeopleYaml('- 42\n')).toThrow();
    expect(() =>
      parsePeopleYaml(
        '- id: per_1\n  slug: s\n  full_name: A\n  given_name: A\n  surname: B\n  alt_names: [12]\n'
      )
    ).toThrow();
    expect(() => parseEventsYaml('- 42\n')).toThrow();
    expect(() => parseEventsYaml('- id: ""\n')).toThrow();
    expect(() =>
      parseEventsYaml(
        '- id: evt_1\n  title: T\n  scope: personal\n  event_kind: point_event\n  participants: [42]\n'
      )
    ).toThrow();
    expect(() =>
      parseEventsYaml(
        '- id: evt_1\n  title: T\n  scope: personal\n  event_kind: point_event\n  sources: [{ source_id: s, confidence: bad }]\n'
      )
    ).toThrow();
    expect(() => parsePlacesYaml('- 42\n')).toThrow();
    expect(() => parsePlacesYaml('- id: plc_bad\n  lat: 999\n')).toThrow();
    expect(() => parseSourcesYaml('- 42\n')).toThrow();
    expect(() => parseSourcesYaml('- id: ""\n')).toThrow();
    expect(() => parseKinshipYaml('- 42\n')).toThrow();
    expect(() => parseKinshipYaml('- from: a\n  to: b\n  relation: invalid\n')).toThrow();
    expect(() => parseMediaYaml('- 42\n')).toThrow();
    expect(() => parseMediaYaml('- id: med_bad\n  kind: unknown\n')).toThrow();
    expect(() =>
      parseMediaYaml('- id: med_bad\n  kind: portrait\n  file: f.jpg\n  caption: c\n  person_ids: [""]\n')
    ).toThrow();
    expect(() => parseNarrativesYaml('- 42\n')).toThrow();
    expect(() => parseNarrativesYaml('- id: nar_bad\n  person_ids: [""]\n')).toThrow();
  });

  it('preserves pure helper contracts for branch resolution, media links, entity IDs, and comparators', () => {
    expect(resolveDefaultBranchId(null)).toBe('primary');
    expect(resolveDefaultBranchId({ branches: [] })).toBe('primary');
    expect(resolveDefaultBranchId({ branches: [{ id: 'alder' }] })).toBe('alder');
    expect(resolveDefaultBranchId({ defaultBranchId: 'mercer', branches: [{ id: 'alder' }] })).toBe('mercer');

    expect(getMediaPersonIds({})).toEqual([]);
    expect(getMediaPersonIds({ person_id: 'per_alder_1' })).toEqual(['per_alder_1']);
    expect(getMediaPersonIds({ person_ids: ['per_alder_1'] })).toEqual(['per_alder_1']);
    expect(getMediaPersonIds({ person_id: 'per_alder_1', person_ids: ['per_alder_1'] })).toEqual([
      'per_alder_1',
    ]);
    expect(
      getMediaPersonIds({
        person_id: 'per_alder_1',
        person_ids: ['per_alder_1', 'per_mercer_2'],
      })
    ).toEqual(['per_alder_1', 'per_mercer_2']);

    expect(buildEntityId('person', 'alder_1')).toBe('per_alder_1');
    expect(buildEntityId('narrative', 'story_1')).toBe('nar_story_1');
    expect(deriveKinshipEdgeId({ from: 'per_a', relation: 'parent', to: 'per_b' })).toBe(
      'per_a:parent:per_b'
    );
    expect(toEntityPayload({ id: 'per_a' })).toEqual({ id: 'per_a' });

    expect(
      storedRecordToEntityPayload({
        edge_id: 'per_a:parent:per_b',
        edge: { from: 'per_a', relation: 'parent', to: 'per_b' },
        current_revision_id: asRevisionId(1),
        deleted_at: null,
        updated_at: '2026-11-27T00:00:00.000Z',
      })
    ).toEqual({ from: 'per_a', relation: 'parent', to: 'per_b' });

    expect(fastLocaleCompare('alder', 'alder')).toBe(0);
    expect(fastLocaleCompare('alder', 'mercer')).toBeLessThan(0);
    expect(fastLocaleCompare('mercer', 'alder')).toBeGreaterThan(0);
    expect(fastLocaleCompare('Édith', 'Edith')).not.toBe(0);
  });
});

describe('parseYaml extra block-sequence and js-yaml fallback invariants', () => {
  it('matches js-yaml CORE_SCHEMA on trailing bare dashes, spaced sequence scalars, and malformed indentation fallbacks', () => {
    const edgeCases = [
      '-\n',
      '-   spaced_scalar\n- second_scalar\n',
      'a: 1\n"__proto__": 2\n',
      '- item_one\n  - over_indented_sublist\n',
      '- scalar_parent\n  nested_under_scalar: invalid_fast_path\n',
    ];
    for (const sample of edgeCases) {
      let expectedOk = false;
      let expectedVal: unknown;
      try {
        expectedVal = loadJsYaml(sample, { schema: CORE_SCHEMA }) ?? null;
        expectedOk = true;
      } catch {
        expectedOk = false;
      }
      if (expectedOk) {
        expect(parseYaml(sample)).toEqual(expectedVal);
      } else {
        expect(() => parseYaml(sample)).toThrow();
      }
    }
  });
});

describe('parseYaml quoted escapes, special numbers, and mapping fallback parity', () => {
  it('matches js-yaml CORE_SCHEMA across double-quoted escape sequences, special numbers, and duplicate/malformed mappings', () => {
    const samples = [
      'escaped: "line1\\nline2\\t\\r\\b\\f\\\\\\/\\"\\u0041"\n',
      'bad_escape: "\\x41"\n',
      'bad_unicode: "\\uZZZZ"\n',
      'neg_inf: -.inf\npos_inf: +.inf\nsci: -2.5e-3\nneg_int: -9007199254740991\n',
      'dup: 1\ndup: 2\n',
      'parent:\n  child: ok\n   overindented: bad\n',
      'flow_val: { a: 1, b: [2, 3] }\n',
      'multi_quoted: "hello \\"world\\""\n',
    ];
    for (const sample of samples) {
      let expectedOk = false;
      let expectedVal: unknown;
      try {
        expectedVal = loadJsYaml(sample, { schema: CORE_SCHEMA }) ?? null;
        expectedOk = true;
      } catch {
        expectedOk = false;
      }
      if (expectedOk) {
        expect(parseYaml(sample)).toEqual(expectedVal);
      } else {
        expect(() => parseYaml(sample)).toThrow();
      }
    }
  });
});
