import { describe, expect, it } from 'vitest';
import {
  compileArchive,
  type Narrative,
  NarrativeKindSchema,
  NarrativeSchema,
  parseKinloomConfig,
  parseNarrativesYaml,
  partitionPersonNarratives,
  patchCompiledBundle,
  type RawPerson,
  serializeNarrativesYaml,
  validateArchive,
} from '../index.js';

const TEST_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Test Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_TEST',
  },
});

const TEST_PEOPLE: RawPerson[] = [
  {
    id: 'per_alice',
    slug: 'alice-alder',
    full_name: 'Alice Alder',
    given_name: 'Alice',
    surname: 'Alder',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1840',
    death_edtf: '1910',
    portrait_url: null,
  },
  {
    id: 'per_bob',
    slug: 'bob-alder',
    full_name: 'Bob Alder',
    given_name: 'Bob',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1865',
    death_edtf: '1935',
    portrait_url: null,
  },
  {
    id: 'per_living_descendant',
    slug: 'casey-alder',
    full_name: 'Casey Alder',
    given_name: 'Casey',
    surname: 'Alder',
    alt_names: [],
    sex: 'U',
    is_living: true,
    lineage_group: 'descendant',
    birth_edtf: '1992-04-11',
    death_edtf: '',
    portrait_url: null,
  },
];

describe('Narrative schema, validation, privacy redaction, and person partitioning', () => {
  it('parses kind and subject_person_id and round-trips through YAML deterministically', () => {
    expect(NarrativeKindSchema.options).toEqual(['biography', 'family_story', 'research_note', 'memoir']);

    const parsed = NarrativeSchema.parse({
      id: 'nar_alice_life',
      slug: 'alice-life',
      kind: 'biography',
      subject_person_id: 'per_alice',
      title: 'Alice Alder Biography',
      summary: 'Life of Alice Alder.',
      date_edtf: '1840/1910',
      person_ids: ['per_alice', 'per_bob'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
      body_md: 'Alice lived in Riverdale.',
    });

    expect(parsed.kind).toBe('biography');
    expect(parsed.subject_person_id).toBe('per_alice');

    const yaml = serializeNarrativesYaml([parsed]);
    expect(parseNarrativesYaml(yaml)).toEqual([parsed]);
  });

  it('partitions personal biographies and shared family stories without relying on ID prefixes', () => {
    const narratives: Narrative[] = [
      {
        id: 'nar_explicit_bio_without_prefix',
        slug: 'alice-biography',
        kind: 'biography',
        subject_person_id: 'per_alice',
        title: 'Alice Alder: Full Life',
        body_md: 'Alice raised Bob in Riverdale.',
        person_ids: ['per_alice', 'per_bob'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
      },
      {
        id: 'nar_legacy_single_person',
        slug: 'bob-notes',
        title: 'Bob Early Notes',
        body_md: 'Single-person legacy narrative.',
        person_ids: ['per_bob'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
      },
      {
        id: 'nar_riverdale_lineage',
        slug: 'riverdale-lineage',
        kind: 'family_story',
        title: 'The Riverdale Homestead',
        body_md: 'Shared essay covering Alice and Bob.',
        person_ids: ['per_alice', 'per_bob'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
      },
      {
        id: 'nar_bio_missing_subject',
        slug: 'unassigned-bio',
        kind: 'biography',
        title: 'Unassigned Biography',
        body_md: 'Marked biography without subject_person_id.',
        person_ids: ['per_alice', 'per_bob'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
      },
    ];

    const aliceGroups = partitionPersonNarratives(narratives, 'per_alice');
    expect(aliceGroups.biographies.map((n) => n.id)).toEqual(['nar_explicit_bio_without_prefix']);
    expect(aliceGroups.familyStories.map((n) => n.id)).toEqual(['nar_riverdale_lineage']);

    const bobGroups = partitionPersonNarratives(narratives, 'per_bob');
    expect(bobGroups.biographies.map((n) => n.id)).toEqual(['nar_legacy_single_person']);
    expect(bobGroups.familyStories.map((n) => n.id)).toEqual(['nar_riverdale_lineage']);
  });

  it('validates subject_person_id referential integrity in validateArchive and flags unknown subjects in compileArchive', () => {
    const badNarrative: Narrative = {
      id: 'nar_broken_subject',
      slug: 'broken-subject',
      kind: 'biography',
      subject_person_id: 'per_missing',
      title: 'Missing Subject Bio',
      body_md: 'References a missing subject.',
      person_ids: ['per_alice'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
    };

    const validation = validateArchive({
      people: TEST_PEOPLE,
      narratives: [badNarrative],
    });
    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual([
      "Narrative 'nar_broken_subject' references missing subject_person_id 'per_missing'.",
    ]);

    const compiled = compileArchive({
      siteConfig: TEST_CONFIG,
      mode: 'private',
      people: TEST_PEOPLE,
      places: [],
      events: [],
      sources: [],
      kinship: [],
      narratives: [badNarrative],
    });
    expect(compiled.reviewFlags).toContain(
      "[nar_broken_subject] references unknown subject_person_id 'per_missing'."
    );
  });

  it('strips living subject_person_id and living person_ids in public mode across compileArchive and patchCompiledBundle', () => {
    const livingNarrative: Narrative = {
      id: 'nar_living_ref',
      slug: 'living-ref',
      kind: 'biography',
      subject_person_id: 'per_living_descendant',
      title: 'Story of Casey Alder',
      summary: 'Notes about Casey Alder.',
      body_md: 'Casey Alder visited Alice Alder.',
      person_ids: ['per_living_descendant', 'per_alice'],
      place_ids: [],
      event_ids: [],
      source_ids: [],
    };

    const compiledPublic = compileArchive({
      siteConfig: TEST_CONFIG,
      mode: 'public',
      people: TEST_PEOPLE,
      places: [],
      events: [],
      sources: [],
      kinship: [],
      narratives: [livingNarrative],
    });

    expect(compiledPublic.bundle.narratives?.[0]?.subject_person_id).toBeUndefined();
    expect(compiledPublic.bundle.narratives?.[0]?.person_ids).toEqual(['per_alice']);
    expect(compiledPublic.bundle.narratives?.[0]?.title).toBe('Story of Living');
    expect(compiledPublic.bundle.narratives?.[0]?.body_md).toBe('Living visited Alice Alder.');

    const basePublic = compileArchive({
      siteConfig: TEST_CONFIG,
      mode: 'public',
      people: TEST_PEOPLE,
      places: [],
      events: [],
      sources: [],
      kinship: [],
      narratives: [],
    }).bundle;

    const patchedPublic = patchCompiledBundle(
      basePublic,
      [
        {
          revision_id: 2,
          entity_type: 'narrative',
          entity_id: 'nar_living_ref',
          action: 'create',
          after_json: livingNarrative,
        },
      ],
      TEST_CONFIG,
      'public'
    );

    expect(patchedPublic.narratives?.[0]?.subject_person_id).toBeUndefined();
    expect(patchedPublic.narratives?.[0]?.person_ids).toEqual(['per_alice']);
  });
});
