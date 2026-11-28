import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KinloomSiteConfigSchema,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  parseEventsYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli/runCli.js';
import { CliValidationError, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import {
  applyPatchYamlWritesWithRollback,
  PATCH_HELP,
  parsePatchDocumentText,
  runPatchCommand,
} from './patch.js';

const tempDirs: string[] = [];

function makeTempRepo(seed?: {
  people?: RawPerson[];
  places?: Place[];
  events?: RawEvent[];
  kinship?: KinshipEdge[];
  sources?: SourceRecord[];
  media?: MediaItem[];
  narratives?: Narrative[];
}): { repoDir: string; dataDir: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-patch-test-'));
  tempDirs.push(repoDir);
  const dataDir = path.join(repoDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const config = KinloomSiteConfigSchema.parse({
    schemaVersion: 1,
    site: {
      title: 'Test Archive',
      familyName: 'Test',
      gedcomSourceName: 'TEST_ARCHIVE',
      footerCredit: 'Test Archive',
    },
    privacy: {
      referenceYear: 2026,
      livingCutoffYears: 100,
    },
  });
  fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

  const people: RawPerson[] = seed?.people ?? [
    {
      id: 'p_john',
      slug: 'john-doe',
      full_name: 'John Doe',
      given_name: 'John',
      surname: 'Doe',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'direct',
      birth_edtf: '1850',
      death_edtf: '1920',
      portrait_url: null,
    },
    {
      id: 'p_living_existing',
      slug: 'pat-doe',
      full_name: 'Pat Doe',
      given_name: 'Pat',
      surname: 'Doe',
      alt_names: [],
      sex: 'U',
      is_living: true,
      lineage_group: 'direct',
      birth_edtf: '1985',
      death_edtf: '',
      portrait_url: null,
    },
  ];
  const places: Place[] = seed?.places ?? [
    {
      id: 'pl_hudsonville',
      slug: 'hudsonville-mi',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.8708,
      lng: -85.865,
    },
  ];
  const sources: SourceRecord[] = seed?.sources ?? [
    {
      id: 'src_census_1900',
      citation: '1900 U.S. Federal Census, Ottawa County, Michigan.',
      source_type: 'census',
    },
  ];
  const events: RawEvent[] = seed?.events ?? [
    {
      id: 'ev_john_birth',
      title: 'Birth of John Doe',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1850',
      place_id: 'pl_hudsonville',
      summary: 'Born in Hudsonville.',
      participants: [{ person_id: 'p_john', role: 'subject' }],
      sources: [{ source_id: 'src_census_1900', confidence: 'high' }],
    },
  ];
  const kinship: KinshipEdge[] = seed?.kinship ?? [];
  const media: MediaItem[] = seed?.media ?? [];
  const narratives: Narrative[] = seed?.narratives ?? [];

  fs.writeFileSync(
    path.join(dataDir, 'people.yaml'),
    serializePeopleYaml(people, { sortById: true }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'places.yaml'),
    serializePlacesYaml(places, { sortById: true }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'sources.yaml'),
    serializeSourcesYaml(sources, { sortById: true }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'events.yaml'),
    serializeEventsYaml(events, { sortById: true }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'kinship.yaml'),
    serializeKinshipYaml(kinship, { sortDeterministic: true }),
    'utf8'
  );
  fs.writeFileSync(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media, { sortById: true }), 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'narratives.yaml'),
    serializeNarrativesYaml(narratives, { sortById: true }),
    'utf8'
  );

  return { repoDir, dataDir };
}

function captureIo(): {
  io: { stdout: (line: string) => void; stderr: (line: string) => void };
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('kinloom patch command', () => {
  it('applies a valid multi-entity JSON patch spanning all 7 entity types with deterministic sorted YAML', async () => {
    const { repoDir, dataDir } = makeTempRepo();
    const patchPath = path.join(repoDir, 'multi-entity-patch.json');
    const patchDoc = {
      people: [
        {
          id: 'p_anna',
          slug: 'anna-doe',
          full_name: 'Anna Doe',
          given_name: 'Anna',
          surname: 'Doe',
          sex: 'F',
          is_living: false,
          birth_edtf: '1855-03-10',
          death_edtf: '1930-07-04',
        },
      ],
      places: [
        {
          id: 'pl_allendale',
          slug: 'allendale-mi',
          name: 'Allendale',
          full_name: 'Allendale, Ottawa County, Michigan, USA',
          place_type: 'town',
          parent_id: null,
          lat: 42.9722,
          lng: -85.9536,
        },
      ],
      sources: [
        {
          id: 'src_marriage_1875',
          citation: 'Michigan Marriage Register, 1875, Ottawa County.',
          source_type: 'vital_record',
        },
      ],
      events: [
        {
          id: 'ev_marriage_1875',
          title: 'Marriage of John Doe and Anna Doe',
          scope: 'family',
          event_kind: 'point_event',
          edtf_date: '1875-06-15',
          place_id: 'pl_allendale',
          summary: 'Married in Allendale.',
          participants: [
            { person_id: 'p_john', role: 'groom' },
            { person_id: 'p_anna', role: 'bride' },
          ],
          sources: [{ source_id: 'src_marriage_1875', confidence: 'high' }],
        },
      ],
      kinship: [
        { from: 'p_john', to: 'p_anna', relation: 'spouse' },
        { from: 'p_anna', to: 'p_john', relation: 'spouse' },
      ],
      media: [
        {
          id: 'med_marriage_cert',
          kind: 'document_scan',
          source_id: 'src_marriage_1875',
          person_id: 'p_anna',
          event_id: 'ev_marriage_1875',
          file: 'media/marriage-1875.jpg',
          caption: '1875 Marriage Certificate',
        },
      ],
      narratives: [
        {
          id: 'nar_anna_bio',
          slug: 'anna-doe-biography',
          kind: 'biography',
          subject_person_id: 'p_anna',
          title: 'Anna Doe',
          summary: 'Life of Anna Doe.',
          body_md: 'Anna married John in 1875 [^src_marriage_1875|med_marriage_cert].',
          person_ids: ['p_anna', 'p_john'],
          place_ids: ['pl_allendale'],
          event_ids: ['ev_marriage_1875'],
          source_ids: [],
        },
      ],
    };
    fs.writeFileSync(patchPath, JSON.stringify(patchDoc, null, 2), 'utf8');

    const result = await runPatchCommand({
      repoDir,
      patchFile: patchPath,
      json: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.allowLiving).toBe(false);
    expect(result.livingPeopleTouched).toBe(0);
    expect(result.counts).toEqual({
      people: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      places: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      events: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      kinship: { added: 2, updated: 0, unchanged: 0, removed: 0 },
      sources: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      media: { added: 1, updated: 0, unchanged: 0, removed: 0 },
      narratives: { added: 1, updated: 0, unchanged: 0, removed: 0 },
    });
    expect(result.writtenYamlFiles).toHaveLength(7);
    expect(result.validation.livingLeaks).toBe(0);

    // Verify deterministic sorted YAML formatting matches @kinloom/core serializers.
    const peopleYaml = fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8');
    const peopleParsed = parsePeopleYaml(peopleYaml);
    expect(peopleParsed.map((p) => p.id)).toEqual(['p_anna', 'p_john', 'p_living_existing']);
    expect(peopleYaml).toBe(serializePeopleYaml(peopleParsed, { sortById: true }));

    const placesYaml = fs.readFileSync(path.join(dataDir, 'places.yaml'), 'utf8');
    expect(parsePlacesYaml(placesYaml).map((p) => p.id)).toEqual(['pl_allendale', 'pl_hudsonville']);

    const kinshipYaml = fs.readFileSync(path.join(dataDir, 'kinship.yaml'), 'utf8');
    const kinshipParsed = parseKinshipYaml(kinshipYaml);
    expect(kinshipParsed[0]?.from).toBe('p_anna');
    expect(kinshipYaml).toBe(serializeKinshipYaml(kinshipParsed, { sortDeterministic: true }));

    const narrativesParsed = parseNarrativesYaml(
      fs.readFileSync(path.join(dataDir, 'narratives.yaml'), 'utf8')
    );
    expect(narrativesParsed[0]?.source_ids).toEqual(['src_marriage_1875']);

    // Idempotent re-run writes 0 files.
    const rerun = await runPatchCommand({ repoDir, patchFile: patchPath });
    expect(rerun.writtenYamlFiles).toEqual([]);
    expect(rerun.wouldWriteYamlFiles).toEqual([]);
    expect(rerun.counts.people.unchanged).toBe(1);
    expect(rerun.rendered).toContain('Patch OK:');
    expect(rerun.rendered).toContain('written=0');
  });

  it('supports YAML file input, partial person updates, and removals across entities', async () => {
    const { repoDir, dataDir } = makeTempRepo({
      narratives: [
        {
          id: 'nar_old',
          slug: 'old-note',
          kind: 'research_note',
          title: 'Old Note',
          body_md: 'Retire me.',
          person_ids: ['p_john'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
      kinship: [
        { from: 'p_john', to: 'p_living_existing', relation: 'parent' },
        { from: 'p_living_existing', to: 'p_john', relation: 'child' },
      ],
    });

    const yamlPath = path.join(repoDir, 'update.yaml');
    fs.writeFileSync(
      yamlPath,
      [
        'people:',
        '  - id: p_john',
        '    slug: john-doe-sr',
        '    full_name: John Doe Sr.',
        '    given_name: John',
        '    surname: Doe',
        '    alt_names:',
        '      - Johnny Doe',
        '    extensions:',
        '      note: updated via yaml',
        'remove_narrative_ids:',
        '  - nar_old',
        'remove_kinship:',
        '  - from: p_john',
        '    to: p_living_existing',
        '    relation: parent',
      ].join('\n'),
      'utf8'
    );

    const res = await runPatchCommand({ repoDir, patchFile: yamlPath });
    expect(res.counts.people.updated).toBe(1);
    expect(res.counts.narratives.removed).toBe(1);
    expect(res.counts.kinship.removed).toBe(2);

    const updatedJohn = parsePeopleYaml(fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8')).find(
      (p) => p.id === 'p_john'
    );
    expect(updatedJohn?.slug).toBe('john-doe-sr');
    expect(updatedJohn?.alt_names).toEqual(['Johnny Doe']);
    expect(updatedJohn?.extensions).toEqual({ note: 'updated via yaml' });
    expect(parseNarrativesYaml(fs.readFileSync(path.join(dataDir, 'narratives.yaml'), 'utf8'))).toEqual([]);
    expect(parseKinshipYaml(fs.readFileSync(path.join(dataDir, 'kinship.yaml'), 'utf8'))).toEqual([]);
  });

  it('supports --dry-run diff summary without mutating any YAML files', async () => {
    const { repoDir, dataDir } = makeTempRepo();
    const beforePeople = fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8');
    const beforePlaces = fs.readFileSync(path.join(dataDir, 'places.yaml'), 'utf8');

    const result = await runPatchCommand({
      repoDir,
      patchContent: JSON.stringify({
        people: [
          {
            id: 'p_mary',
            slug: 'mary-doe',
            full_name: 'Mary Doe',
            given_name: 'Mary',
            surname: 'Doe',
            is_living: false,
            birth_edtf: '1860',
            death_edtf: '1935',
          },
        ],
      }),
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.counts.people.added).toBe(1);
    expect(result.wouldWriteYamlFiles).toEqual([path.join(dataDir, 'people.yaml')]);
    expect(result.writtenYamlFiles).toEqual([]);
    expect(result.rendered).toContain('Patch dry-run OK:');
    expect(result.rendered).toContain('wouldWrite=1');

    expect(fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8')).toBe(beforePeople);
    expect(fs.readFileSync(path.join(dataDir, 'places.yaml'), 'utf8')).toBe(beforePlaces);
  });

  it('reads patch documents from stdin via "-"', async () => {
    const { repoDir, dataDir } = makeTempRepo();
    const stdinPayload = JSON.stringify({
      sources: [
        {
          id: 'src_diary',
          citation: 'Family Diary, 1890.',
          source_type: 'manuscript',
        },
      ],
    });

    const result = await runPatchCommand({
      repoDir,
      patchFile: '-',
      readStdin: () => stdinPayload,
    });

    expect(result.inputSource).toBe('<stdin>');
    expect(result.counts.sources.added).toBe(1);
    expect(
      parseSourcesYaml(fs.readFileSync(path.join(dataDir, 'sources.yaml'), 'utf8')).map((s) => s.id)
    ).toContain('src_diary');
  });

  it('defaults --allow-living to false and rejects living people, events, media, and narratives with zero writes', async () => {
    const { repoDir, dataDir } = makeTempRepo();
    const origPeople = fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8');

    // 1. New living person (is_living: true)
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_new',
              slug: 'sam-doe',
              full_name: 'Sam Doe',
              given_name: 'Sam',
              surname: 'Doe',
              is_living: true,
              birth_edtf: '1995',
              death_edtf: '',
              portrait_url: null,
            },
          ],
        }),
      })
    ).rejects.toThrow(/PRIVACY REFUSAL.*--allow-living/);

    // 2. Effective-living person (recent birth year, is_living: false)
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_young',
              slug: 'young-doe',
              full_name: 'Young Doe',
              given_name: 'Young',
              surname: 'Doe',
              is_living: false,
              birth_edtf: '1990',
              death_edtf: '',
            },
          ],
        }),
      })
    ).rejects.toThrow(/PRIVACY REFUSAL.*--allow-living/);

    // 3. Updating existing living person without --allow-living
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_existing',
              slug: 'pat-doe',
              full_name: 'Pat A. Doe',
              given_name: 'Pat',
              surname: 'Doe',
              is_living: true,
              birth_edtf: '1985',
            },
          ],
        }),
      })
    ).rejects.toThrow(/PRIVACY REFUSAL.*--allow-living/);

    // 4. Event involving existing living person without --allow-living
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          events: [
            {
              id: 'ev_living_birth',
              title: 'Birth of Pat Doe',
              scope: 'personal',
              event_kind: 'point_event',
              edtf_date: '1985',
              place_id: null,
              participants: [{ person_id: 'p_living_existing', role: 'subject' }],
              sources: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/PRIVACY REFUSAL.*--allow-living/);

    expect(fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8')).toBe(origPeople);
  });

  it('enforces strict living-person privacy invariants when --allow-living is enabled', async () => {
    const { repoDir, dataDir } = makeTempRepo();

    // Valid privacy-compliant living person + kinship + year-only non-residence event succeeds.
    const okResult = await runPatchCommand({
      repoDir,
      allowLiving: true,
      patchContent: JSON.stringify({
        people: [
          {
            id: 'p_living_child',
            slug: 'casey-doe',
            full_name: 'Casey Doe',
            given_name: 'Casey',
            surname: 'Doe',
            is_living: true,
            birth_edtf: '2012',
            death_edtf: '',
            portrait_url: null,
          },
        ],
        kinship: [
          { from: 'p_living_existing', to: 'p_living_child', relation: 'parent' },
          { from: 'p_living_child', to: 'p_living_existing', relation: 'child' },
        ],
        events: [
          {
            id: 'ev_casey_birth',
            title: 'Birth of Casey Doe',
            scope: 'personal',
            event_kind: 'point_event',
            edtf_date: '2012',
            place_id: null,
            participants: [{ person_id: 'p_living_child', role: 'subject' }],
            sources: [],
          },
        ],
      }),
    });
    expect(okResult.ok).toBe(true);
    expect(okResult.allowLiving).toBe(true);
    expect(okResult.livingPeopleTouched).toBe(1);
    expect(okResult.validation.livingLeaks).toBe(0);
    expect(okResult.rendered).toContain('livingTouched=1');

    const snapshotPeople = fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8');
    const snapshotEvents = fs.readFileSync(path.join(dataDir, 'events.yaml'), 'utf8');
    const snapshotMedia = fs.readFileSync(path.join(dataDir, 'media.yaml'), 'utf8');

    // Violation 1: effective-living without explicit is_living: true
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_bad_flag',
              slug: 'bad-flag',
              full_name: 'Bad Flag',
              given_name: 'Bad',
              surname: 'Flag',
              is_living: false,
              birth_edtf: '2001',
              death_edtf: '',
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*is_living: true/);

    // Violation 2: full YYYY-MM-DD DOB
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_bad_dob',
              slug: 'bad-dob',
              full_name: 'Bad Dob',
              given_name: 'Bad',
              surname: 'Dob',
              is_living: true,
              birth_edtf: '1999-04-12',
              death_edtf: '',
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*YYYY-MM-DD/);

    // Violation 3: portrait_url and thumb_url on living person
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_portrait',
              slug: 'bad-portrait',
              full_name: 'Bad Portrait',
              given_name: 'Bad',
              surname: 'Portrait',
              is_living: true,
              birth_edtf: '1998',
              portrait_url: '/media/portrait.jpg',
              thumb_url: '/media/portrait-thumb.jpg',
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*portrait_url.*thumb_url/);

    // Violation 4: pronunciation override on living person
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_living_pron',
              slug: 'bad-pron',
              full_name: 'Bad Pron',
              given_name: 'Bad',
              surname: 'Pron',
              is_living: true,
              birth_edtf: '1998',
              pronunciation: { phonetic: 'bad pron' },
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*pronunciation/);

    // Violation 5: residence_anchor event / place_id / photo_url / full date on living person
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          events: [
            {
              id: 'ev_living_res',
              title: 'Residence of Pat',
              scope: 'personal',
              event_kind: 'residence_anchor',
              edtf_date: '2020-05-01',
              place_id: 'pl_hudsonville',
              photo_url: '/media/house.jpg',
              participants: [{ person_id: 'p_living_existing', role: 'resident' }],
              sources: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*residence_anchor.*place_id.*photo_url.*YYYY-MM-DD/);

    // Violation 6: media linked to living person or living event
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          media: [
            {
              id: 'med_living_photo',
              kind: 'portrait',
              person_id: 'p_living_existing',
              file: 'media/pat.jpg',
              caption: 'Pat portrait',
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*media 'med_living_photo'/);

    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          media: [
            {
              id: 'med_living_event_photo',
              kind: 'family_photo',
              event_id: 'ev_casey_birth',
              file: 'media/casey-event.jpg',
              caption: 'Event photo',
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*event 'ev_casey_birth'/);

    // Violation 7: narrative targeting or listing a living person
    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          narratives: [
            {
              id: 'nar_living_sub',
              slug: 'pat-bio',
              kind: 'biography',
              subject_person_id: 'p_living_existing',
              title: 'Pat',
              body_md: 'Bio text.',
              person_ids: [],
              place_ids: [],
              event_ids: [],
              source_ids: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*subject_person_id/);

    await expect(
      runPatchCommand({
        repoDir,
        allowLiving: true,
        patchContent: JSON.stringify({
          narratives: [
            {
              id: 'nar_living_list',
              slug: 'family-note',
              kind: 'family_story',
              title: 'Family Note',
              body_md: 'Story.',
              person_ids: ['p_living_existing'],
              place_ids: [],
              event_ids: [],
              source_ids: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/LIVING PRIVACY VIOLATION.*person_ids/);

    // Verify ZERO partial file writes occurred during any violation.
    expect(fs.readFileSync(path.join(dataDir, 'people.yaml'), 'utf8')).toBe(snapshotPeople);
    expect(fs.readFileSync(path.join(dataDir, 'events.yaml'), 'utf8')).toBe(snapshotEvents);
    expect(fs.readFileSync(path.join(dataDir, 'media.yaml'), 'utf8')).toBe(snapshotMedia);
  });

  it('rolls back all modified and newly created YAML files atomically on mid-write failure', async () => {
    const { repoDir, dataDir } = makeTempRepo();
    // Remove narratives.yaml so we also exercise rollback unlinking a newly created file.
    const narrativesPath = path.join(dataDir, 'narratives.yaml');
    fs.unlinkSync(narrativesPath);
    const origPeopleBytes = fs.readFileSync(path.join(dataDir, 'people.yaml'));
    const origPlacesBytes = fs.readFileSync(path.join(dataDir, 'places.yaml'));

    let writeCall = 0;
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_rollback_test',
              slug: 'rollback-test',
              full_name: 'Rollback Test',
              given_name: 'Rollback',
              surname: 'Test',
              is_living: false,
              birth_edtf: '1840',
              death_edtf: '1900',
            },
          ],
          places: [
            {
              id: 'pl_rollback',
              slug: 'rollback-place',
              name: 'Rollback Town',
              full_name: 'Rollback Town, Michigan',
              place_type: 'town',
              parent_id: null,
              lat: 42.5,
              lng: -85.5,
            },
          ],
          narratives: [
            {
              id: 'nar_rollback',
              slug: 'rollback-note',
              kind: 'research_note',
              title: 'Rollback Note',
              body_md: 'Should never survive.',
              person_ids: ['p_john'],
              place_ids: [],
              event_ids: [],
              source_ids: [],
            },
          ],
        }),
        writeFileImpl: (filePath, content) => {
          writeCall += 1;
          if (writeCall === 3) {
            throw new Error('Simulated disk full on 3rd YAML file');
          }
          fs.writeFileSync(filePath, content, 'utf8');
        },
      })
    ).rejects.toThrow(/Patch write failed: Simulated disk full.*Rollback succeeded/);

    expect(fs.readFileSync(path.join(dataDir, 'people.yaml')).equals(origPeopleBytes)).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'places.yaml')).equals(origPlacesBytes)).toBe(true);
    expect(fs.existsSync(narrativesPath)).toBe(false);

    // Direct test of rollback unlinking a newly created file that succeeded before a later write threw.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-patch-rb-'));
    tempDirs.push(tmpDir);
    const newFile = path.join(tmpDir, 'new.yaml');
    const secondFile = path.join(tmpDir, 'second.yaml');
    expect(() =>
      applyPatchYamlWritesWithRollback(
        [
          { fileName: 'new.yaml', fullPath: newFile, content: '- id: a\n' },
          { fileName: 'second.yaml', fullPath: secondFile, content: '- id: b\n' },
        ],
        (filePath, content) => {
          if (filePath === secondFile) {
            throw new Error('boom');
          }
          fs.writeFileSync(filePath, content, 'utf8');
        }
      )
    ).toThrow(/Rollback succeeded: 1 YAML file\(s\) restored byte-for-byte/);
    expect(fs.existsSync(newFile)).toBe(false);
  });

  it('rejects invalid documents, schemas, duplicates, slug collisions, and dangling references', async () => {
    const { repoDir } = makeTempRepo();

    // Parse errors
    expect(() => parsePatchDocumentText('   ')).toThrow(CliValidationError);
    expect(() => parsePatchDocumentText('{ bad json', 'json')).toThrow(/Invalid JSON patch document/);
    expect(() => parsePatchDocumentText(':\n  - [unclosed', 'yaml')).toThrow(
      /Invalid YAML\/JSON patch document/
    );
    // Flow-style YAML starting with '{' falls back cleanly to YAML parser
    expect(parsePatchDocumentText('{ people: [] }', 'auto')).toEqual({ people: [] });

    // Missing repo / data / config / patch file
    await expect(
      runPatchCommand({ repoDir: path.join(repoDir, 'nope'), patchContent: '{}' })
    ).rejects.toThrow(/Repository directory does not exist/);
    await expect(runPatchCommand({ repoDir })).rejects.toThrow(/Missing patch input/);
    await expect(runPatchCommand({ repoDir, patchFile: path.join(repoDir, 'missing.json') })).rejects.toThrow(
      /Patch file does not exist/
    );

    // Root / key / array validation
    await expect(runPatchCommand({ repoDir, patchContent: '[]' })).rejects.toThrow(
      /must be a JSON or YAML object/
    );
    await expect(runPatchCommand({ repoDir, patchContent: JSON.stringify({ bogus: [] }) })).rejects.toThrow(
      /Unknown top-level key 'bogus'/
    );
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ people: 'not-array' }) })
    ).rejects.toThrow(/Patch field 'people' must be an array/);
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ remove_event_ids: [123] }) })
    ).rejects.toThrow(CliValidationError);

    // Person validation: non-object, invalid id, duplicate id, schema error, empty full_name, invalid slug, slug collision
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ people: ['x'] }) })
    ).rejects.toThrow(/must be an object/);
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ people: [{ id: 'bad id!' }] }) })
    ).rejects.toThrow(/invalid id/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            { id: 'p_dup', slug: 'dup-1', full_name: 'A', given_name: 'A', surname: 'B', death_edtf: '1900' },
            { id: 'p_dup', slug: 'dup-2', full_name: 'A', given_name: 'A', surname: 'B', death_edtf: '1900' },
          ],
        }),
      })
    ).rejects.toThrow(/Duplicate person id/);
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ people: [{ id: 'p_bad_schema' }] }) })
    ).rejects.toThrow(/Invalid person in patch\.people\[0\]/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_empty',
              slug: 'empty-name',
              full_name: '   ',
              given_name: '',
              surname: '',
              death_edtf: '1900',
            },
          ],
        }),
      })
    ).rejects.toThrow(/non-empty full_name/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_badslug',
              slug: 'Bad Slug!',
              full_name: 'X',
              given_name: 'X',
              surname: 'Y',
              death_edtf: '1900',
            },
          ],
        }),
      })
    ).rejects.toThrow(/invalid slug/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          people: [
            {
              id: 'p_collide',
              slug: 'john-doe',
              full_name: 'Other',
              given_name: 'O',
              surname: 'D',
              death_edtf: '1900',
            },
          ],
        }),
      })
    ).rejects.toThrow(/Slug collision/);

    // Invalid place coordinates (0, 0)
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          places: [
            {
              id: 'pl_zero',
              slug: 'zero-island',
              name: 'Zero',
              full_name: 'Zero Island',
              place_type: 'town',
              parent_id: null,
              lat: 0,
              lng: 0,
            },
          ],
        }),
      })
    ).rejects.toThrow(/forbidden \(0, 0\) coordinates/);

    // Dangling event place / person / source references
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          events: [
            {
              id: 'ev_bad_place',
              title: 'T',
              scope: 'personal',
              event_kind: 'point_event',
              place_id: 'pl_missing',
              participants: [{ person_id: 'p_john', role: 'subject' }],
              sources: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing place_id 'pl_missing'/);

    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          events: [
            {
              id: 'ev_bad_person',
              title: 'T',
              scope: 'personal',
              event_kind: 'point_event',
              place_id: null,
              participants: [{ person_id: 'p_missing', role: 'subject' }],
              sources: [],
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing person_id 'p_missing'/);

    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          events: [
            {
              id: 'ev_bad_src',
              title: 'T',
              scope: 'personal',
              event_kind: 'point_event',
              place_id: null,
              participants: [{ person_id: 'p_john', role: 'subject' }],
              sources: [{ source_id: 'src_missing', confidence: 'high' }],
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing source_id 'src_missing'/);

    // Dangling kinship
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          kinship: [{ from: 'p_missing', to: 'p_john', relation: 'parent' }],
        }),
      })
    ).rejects.toThrow(/missing 'from' person/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          kinship: [{ from: 'p_john', to: 'p_missing', relation: 'parent' }],
        }),
      })
    ).rejects.toThrow(/missing 'to' person/);

    // Dangling media & duplicate media file path
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          media: [
            {
              id: 'med_bad_p',
              kind: 'document_scan',
              person_id: 'p_missing',
              file: 'media/a.jpg',
              caption: 'A',
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing person_id 'p_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          media: [
            {
              id: 'med_bad_ev',
              kind: 'document_scan',
              event_id: 'ev_missing',
              file: 'media/a.jpg',
              caption: 'A',
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing event_id 'ev_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          media: [
            {
              id: 'med_bad_src',
              kind: 'document_scan',
              source_id: 'src_missing',
              file: 'media/a.jpg',
              caption: 'A',
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing source_id 'src_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          media: [
            { id: 'med_1', kind: 'document_scan', file: 'media/dup.jpg', caption: 'A' },
            { id: 'med_2', kind: 'document_scan', file: './media/dup.jpg', caption: 'B' },
          ],
        }),
      })
    ).rejects.toThrow(/Duplicate media file path/);

    // Dangling narrative refs & inline citations & add+remove conflict
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [
            {
              id: 'nar_bad_cite',
              slug: 'bad-cite',
              title: 'Bad',
              body_md: 'See [^src_nope].',
            },
          ],
        }),
      })
    ).rejects.toThrow(/src_nope/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [
            {
              id: 'nar_bad_place',
              slug: 'bad-place',
              title: 'Bad',
              body_md: 'Text.',
              place_ids: ['pl_missing'],
            },
          ],
        }),
      })
    ).rejects.toThrow(/missing place_id 'pl_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [{ id: 'nar_conflict', slug: 'c', title: 'C', body_md: 'C' }],
          remove_narrative_ids: ['nar_conflict'],
        }),
      })
    ).rejects.toThrow(/cannot both add\/update and remove narrative/);

    // Retirement integrity: cannot remove source still cited by event
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          remove_source_ids: ['src_census_1900'],
        }),
      })
    ).rejects.toThrow(/Cannot remove source 'src_census_1900'/);
  });

  it('wires kinloom patch through runCli with --help, --dry-run, --json, stdin, and usage errors', async () => {
    const { repoDir, dataDir } = makeTempRepo();

    // --help
    const helpIo = captureIo();
    expect(await runCli(['patch', '--help'], { io: helpIo.io })).toBe(EXIT_OK);
    expect(helpIo.stdout.join('\n')).toContain(PATCH_HELP);

    // stdin via runCli with --dry-run --json
    const dryIo = captureIo();
    const stdinYaml = [
      'places:',
      '  - id: pl_jenison',
      '    slug: jenison-mi',
      '    name: Jenison',
      '    full_name: Jenison, Ottawa County, Michigan, USA',
      '    place_type: town',
      '    parent_id: null',
      '    lat: 42.9072',
      '    lng: -85.792',
    ].join('\n');
    const dryCode = await runCli(['patch', '-', '--repo', repoDir, '--dry-run', '--json'], {
      io: dryIo.io,
      stdin: stdinYaml,
    });
    expect(dryCode).toBe(EXIT_OK);
    const parsedDry = JSON.parse(dryIo.stdout.join('\n')) as {
      ok: boolean;
      dryRun: boolean;
      counts: { places: { added: number } };
      writtenYamlFiles: string[];
    };
    expect(parsedDry.ok).toBe(true);
    expect(parsedDry.dryRun).toBe(true);
    expect(parsedDry.counts.places.added).toBe(1);
    expect(parsedDry.writtenYamlFiles).toEqual([]);

    // Apply via --file alias
    const filePath = path.join(repoDir, 'place.yaml');
    fs.writeFileSync(filePath, stdinYaml, 'utf8');
    const applyIo = captureIo();
    const applyCode = await runCli(['patch', '--file', filePath, '--repo', repoDir], { io: applyIo.io });
    expect(applyCode).toBe(EXIT_OK);
    expect(applyIo.stdout.join('\n')).toContain('Patch OK:');
    expect(
      parsePlacesYaml(fs.readFileSync(path.join(dataDir, 'places.yaml'), 'utf8')).map((p) => p.id)
    ).toContain('pl_jenison');

    // Usage errors (too many positionals, both positional and --file)
    const errIo1 = captureIo();
    expect(await runCli(['patch', 'a.json', 'b.json'], { io: errIo1.io })).toBe(EXIT_USAGE);
    const errIo2 = captureIo();
    expect(await runCli(['patch', 'a.json', '--file', 'b.json'], { io: errIo2.io })).toBe(EXIT_USAGE);

    // Verify events.yaml wasn't unexpectedly modified
    expect(parseEventsYaml(fs.readFileSync(path.join(dataDir, 'events.yaml'), 'utf8'))).toHaveLength(1);
    expect(parseMediaYaml(fs.readFileSync(path.join(dataDir, 'media.yaml'), 'utf8'))).toHaveLength(0);
  });

  it('covers missing archive files, narrative merges/dangling refs, Zod errors, auto format, and living updates', async () => {
    const { repoDir, dataDir } = makeTempRepo({
      narratives: [
        {
          id: 'nar_existing',
          slug: 'existing-bio',
          kind: 'biography',
          subject_person_id: 'p_john',
          title: 'John Doe',
          summary: 'Original summary.',
          body_md: 'Initial text.',
          person_ids: ['p_john'],
          place_ids: ['pl_hudsonville'],
          event_ids: ['ev_john_birth'],
          source_ids: ['src_census_1900'],
          updated_at: '2025-01-01T00:00:00Z',
          has_primary_source: true,
          extensions: { origin: 'seed' },
        },
      ],
    });

    // Missing people.yaml and missing kinloom.config.yaml
    const noPeopleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-patch-nopeople-'));
    tempDirs.push(noPeopleDir);
    await expect(runPatchCommand({ repoDir: noPeopleDir, patchContent: '{}' })).rejects.toThrow(
      /people\.yaml/
    );

    fs.mkdirSync(path.join(noPeopleDir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(noPeopleDir, 'data', 'people.yaml'), '[]\n', 'utf8');
    await expect(runPatchCommand({ repoDir: noPeopleDir, patchContent: '{}' })).rejects.toThrow(
      /kinloom\.config\.yaml/
    );

    // Auto format hint (.txt file) + updating existing narrative preserves updated_at, summary, has_primary_source, extensions
    const txtPatch = path.join(repoDir, 'patch.txt');
    fs.writeFileSync(
      txtPatch,
      JSON.stringify({
        narratives: [
          {
            id: 'nar_existing',
            slug: 'existing-bio',
            kind: 'biography',
            subject_person_id: 'p_john',
            title: 'John Doe (Revised)',
            body_md: 'Updated text [^src_census_1900].',
            person_ids: ['p_john'],
            place_ids: ['pl_hudsonville'],
            event_ids: ['ev_john_birth'],
            source_ids: [],
            extensions: { editor: 'tester' },
          },
        ],
      }),
      'utf8'
    );
    const narUpdate = await runPatchCommand({ repoDir, patchFile: txtPatch });
    expect(narUpdate.counts.narratives.updated).toBe(1);
    const updatedNar = parseNarrativesYaml(fs.readFileSync(path.join(dataDir, 'narratives.yaml'), 'utf8'))[0];
    expect(updatedNar?.summary).toBe('Original summary.');
    expect(updatedNar?.updated_at).toBe('2025-01-01T00:00:00Z');
    expect(updatedNar?.has_primary_source).toBe(true);
    expect(updatedNar?.extensions).toEqual({ origin: 'seed', editor: 'tester' });

    // Updating existing living person with --allow-living increments livingPeopleTouched
    const livingUpdate = await runPatchCommand({
      repoDir,
      allowLiving: true,
      patchContent: JSON.stringify({
        people: [
          {
            id: 'p_living_existing',
            slug: 'pat-doe',
            full_name: 'Pat A. Doe',
            given_name: 'Pat',
            surname: 'Doe',
            is_living: true,
            birth_edtf: '1985',
            death_edtf: '',
            portrait_url: null,
          },
        ],
      }),
    });
    expect(livingUpdate.counts.people.updated).toBe(1);
    expect(livingUpdate.livingPeopleTouched).toBe(1);

    // Zod schema errors on events & narratives
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ events: [{ id: 'ev_bad' }] }) })
    ).rejects.toThrow(/Invalid patch\.events/);
    await expect(
      runPatchCommand({ repoDir, patchContent: JSON.stringify({ narratives: ['not-an-object'] }) })
    ).rejects.toThrow(/Invalid patch\.narratives/);

    // Dangling narrative subject_person_id, person_ids, event_ids, source_ids
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [{ id: 'n1', slug: 'n1', title: 'N1', body_md: 'T', subject_person_id: 'p_missing' }],
        }),
      })
    ).rejects.toThrow(/missing subject_person_id 'p_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [{ id: 'n2', slug: 'n2', title: 'N2', body_md: 'T', person_ids: ['p_missing'] }],
        }),
      })
    ).rejects.toThrow(/missing person_id 'p_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [{ id: 'n3', slug: 'n3', title: 'N3', body_md: 'T', event_ids: ['ev_missing'] }],
        }),
      })
    ).rejects.toThrow(/missing event_id 'ev_missing'/);
    await expect(
      runPatchCommand({
        repoDir,
        patchContent: JSON.stringify({
          narratives: [{ id: 'n4', slug: 'n4', title: 'N4', body_md: 'T', source_ids: ['src_missing'] }],
        }),
      })
    ).rejects.toThrow(/missing source_id 'src_missing'/);

    // TTY stdin guard when patchFile === '-' and process.stdin.isTTY is true
    const origIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await expect(runPatchCommand({ repoDir, patchFile: '-' })).rejects.toThrow(
        /Missing patch input on stdin/
      );
    } finally {
      if (origIsTty) {
        Object.defineProperty(process.stdin, 'isTTY', origIsTty);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });
});
