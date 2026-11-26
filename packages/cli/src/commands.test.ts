import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  asRevisionId,
  compileArchive,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  type ArchiveRawSnapshot,
  type BatchSubmission,
  type EntityPayload,
  type EntityType,
  type KinloomSiteConfig,
  type Place,
  type RawEvent,
  type RawPerson,
  type RevisionRecord,
  type SourceRecord,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli.js';
import { ARCHIVE_YAML_FILE_NAMES, serializeSnapshotToYamlFiles } from './commands/dataFiles.js';
import { EXIT_CONFLICT, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from './errors.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
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

function makeSampleSiteConfig(): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Alder Family Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
        footerCredit: 'Built with Kinloom',
      },
      theme: { accent: '#7A4612' },
      defaultBranchId: 'alder',
      branches: [
        {
          id: 'alder',
          label: 'Alder Line',
          surnames: ['Alder'],
          lineageGroups: ['pivot_ancestor', 'ancestor', 'descendant'],
          supportsDirectMode: true,
        },
      ],
      lineageSections: [],
      featuredKinshipPairs: [],
      migrationEras: [],
      mapDefaults: {
        centerLat: 39.8,
        centerLng: -83.0,
        zoom: 5,
        minSpanDeg: 1.2,
      },
      privacy: {
        livingCutoffYears: 101,
        referenceYear: 2026,
        privateModeShowsBirthYear: true,
        stripLivingPortraits: true,
        stripLivingResidenceSpans: true,
        markGedcomLivingConfidential: true,
      },
    })
  );
}

function makeSyntheticSnapshot(): ArchiveRawSnapshot {
  const place: Place = {
    id: 'plc_oak_county_ohio_usa',
    slug: 'oak-county-ohio-usa',
    name: 'Oak County',
    full_name: 'Oak County, Ohio, USA',
    place_type: 'county',
    parent_id: null,
    lat: 40.2,
    lng: -82.8,
    historical_names: [],
  };
  const source: SourceRecord = {
    id: 'src_1880_census',
    citation: '1880 United States Federal Census, Oak County, Ohio',
    source_type: 'census',
    repository: 'NARA',
  };
  const person: RawPerson = {
    id: 'per_arthur_alder',
    slug: 'arthur-alder',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'pivot_ancestor',
    branch: 'alder',
    birth_edtf: '1842-05-14',
    death_edtf: '1918-11-02',
    portrait_url: null,
  };
  const event: RawEvent = {
    id: 'evt_birth_arthur',
    title: 'Birth of Arthur Alder',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1842-05-14',
    place_id: place.id,
    summary: 'Born in Oak County, Ohio.',
    participants: [{ person_id: person.id, role: 'birth_subject' }],
    sources: [{ source_id: source.id, confidence: 'high' }],
  };

  return {
    head_revision_id: asRevisionId(4),
    entities: [
      {
        entity_type: 'place',
        entity_id: place.id,
        slug: place.slug,
        data: place,
        current_revision_id: asRevisionId(1),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'source',
        entity_id: source.id,
        slug: null,
        data: source,
        current_revision_id: asRevisionId(2),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'person',
        entity_id: person.id,
        slug: person.slug,
        data: person,
        current_revision_id: asRevisionId(3),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'event',
        entity_id: event.id,
        slug: null,
        data: event,
        current_revision_id: asRevisionId(4),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    kinship: [],
  };
}

const SYNTHETIC_GEDCOM = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 5.5.1',
  '0 @S1@ SOUR',
  '1 TITL 1880 United States Federal Census',
  '0 @I1@ INDI',
  '1 NAME Thomas /Alder/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 10 MAR 1815',
  '2 PLAC Oak County, Ohio, USA',
  '2 SOUR @S1@',
  '1 DEAT',
  '2 DATE 4 NOV 1890',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Clara /Bramwell/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1818',
  '1 DEAT',
  '2 DATE 1895',
  '1 FAMC @F_UPSTREAM@',
  '1 FAMS @F1@',
  '0 @I99@ INDI',
  '1 NAME Henry /Bramwell/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1790',
  '1 DEAT',
  '2 DATE 1862',
  '1 FAMS @F_UPSTREAM@',
  '0 @I3@ INDI',
  '1 NAME Arthur /Alder/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 14 MAY 1842',
  '2 PLAC Oak County, Ohio, USA',
  '1 DEAT',
  '2 DATE 2 NOV 1918',
  '1 FAMC @F1@',
  '1 FAMS @F2@',
  '0 @I4@ INDI',
  '1 NAME Martha /Alder/',
  '2 TYPE maiden',
  '1 NAME Martha /Corwin/',
  '2 TYPE married',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1845',
  '1 DEAT',
  '2 DATE 1922',
  '1 FAMC @F1@',
  '0 @I5@ INDI',
  '1 NAME Eleanor (Hollis) /Alder/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1846',
  '1 DEAT',
  '2 DATE 1924',
  '1 FAMS @F2@',
  '0 @I6@ INDI',
  '1 NAME Samuel /Alder/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1872',
  '1 DEAT',
  '2 DATE 1948',
  '1 FAMC @F2@',
  '0 @F_UPSTREAM@ FAM',
  '1 HUSB @I99@',
  '1 CHIL @I2@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 CHIL @I3@',
  '1 CHIL @I4@',
  '0 @F2@ FAM',
  '1 HUSB @I3@',
  '1 WIFE @I5@',
  '1 CHIL @I6@',
  '0 TRLR',
].join('\n');

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('kinloom CLI commands', () => {
  it('prints root help and rejects unknown commands with exit code 2', async () => {
    const cap1 = createCaptureIo();
    const code1 = await runCli(['--help'], { io: cap1.io });
    expect(code1).toBe(EXIT_OK);
    expect(cap1.stdout.join('\n')).toContain('Usage: kinloom <command>');
    expect(cap1.stdout.join('\n')).toContain('reconcile');

    const cap2 = createCaptureIo();
    const code2 = await runCli(['unknown-cmd'], { io: cap2.io });
    expect(code2).toBe(EXIT_USAGE);
    expect(cap2.stderr.join('\n')).toContain("Unknown command 'unknown-cmd'");
  });

  it('init scaffolds valid config, starter YAML files, workflows, extensions guide, and stays idempotent', async () => {
    const baseDir = await makeTempDir('kinloom-init-');
    const targetDir = path.join(baseDir, 'alder-archive');

    const cap = createCaptureIo();
    const exitCode = await runCli(
      ['init', targetDir, '--family', 'Alder', '--title', 'Alder Family Archive', '--accent', '#2F5245'],
      { io: cap.io }
    );
    expect(exitCode).toBe(EXIT_OK);
    expect(cap.stdout[0]).toContain('12 created, 0 skipped');

    const configYaml = await readFile(path.join(targetDir, 'kinloom.config.yaml'), 'utf8');
    const parsedConfig = parseKinloomConfigYaml(configYaml);
    expect(parsedConfig.site.familyName).toBe('Alder');
    expect(parsedConfig.site.title).toBe('Alder Family Archive');
    expect(parsedConfig.site.gedcomSourceName).toBe('ALDER_ARCHIVE');
    expect(parsedConfig.theme?.accent).toBe('#2F5245');
    expect(parsedConfig.defaultBranchId).toBe('alder');

    for (const fileName of ARCHIVE_YAML_FILE_NAMES) {
      const content = await readFile(path.join(targetDir, 'data', fileName), 'utf8');
      expect(content).toBe('[]\n');
    }

    const backupWorkflow = await readFile(
      path.join(targetDir, '.github', 'workflows', 'backup.yml'),
      'utf8'
    );
    expect(backupWorkflow).toContain('workflow_dispatch:');
    expect(backupWorkflow).toContain('export-yaml');

    const reconcileWorkflow = await readFile(
      path.join(targetDir, '.github', 'workflows', 'reconcile.yml'),
      'utf8'
    );
    expect(reconcileWorkflow).toContain('reconcile');

    const extReadme = await readFile(path.join(targetDir, 'extensions', 'README.md'), 'utf8');
    expect(extReadme).toContain('KinloomUiPlugin');

    const gitignore = await readFile(path.join(targetDir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('raw-gedcom/');

    // Re-running init without --force skips all existing files.
    const cap2 = createCaptureIo();
    const secondCode = await runCli(
      ['init', targetDir, '--family', 'Alder', '--title', 'Alder Family Archive'],
      { io: cap2.io }
    );
    expect(secondCode).toBe(EXIT_OK);
    expect(cap2.stdout[0]).toContain('0 created, 12 skipped');

    // Invalid hex accent fails at CLI boundary with exit code 2.
    const cap3 = createCaptureIo();
    const badCode = await runCli(
      ['init', path.join(baseDir, 'bad'), '--family', 'Alder', '--title', 'Bad', '--accent', 'orange'],
      { io: cap3.io }
    );
    expect(badCode).toBe(EXIT_USAGE);
  });

  it('slice-gedcom extracts maiden-primary names, complete siblings, and deterministic YAML', async () => {
    const dir = await makeTempDir('kinloom-slice-');
    const gedPath = path.join(dir, 'combined.ged');
    const outDir = path.join(dir, 'data');
    const outUpstreamDir = path.join(dir, 'data-upstream');
    await writeFile(gedPath, SYNTHETIC_GEDCOM, 'utf8');

    const cap = createCaptureIo();
    const code = await runCli(
      ['slice-gedcom', '--input', gedPath, '--out', outDir, '--root', '@I3@', '--surname', 'Alder'],
      { io: cap.io }
    );
    expect(code).toBe(EXIT_OK);

    const peopleYaml = await readFile(path.join(outDir, 'people.yaml'), 'utf8');
    const people = parsePeopleYaml(peopleYaml);
    expect(peopleYaml).toBe(serializePeopleYaml(people, { sortById: true }));

    // Upstream married-in spouse parent Henry Bramwell (@I99@) is excluded by default.
    expect(people.map((p) => p.gedcom_xref)).not.toContain('@I99@');

    // Complete ancestor sibling Martha Alder is included with maiden name primary and married name in alt_names.
    const martha = people.find((p) => p.gedcom_xref === '@I4@');
    expect(martha?.full_name).toBe('Martha Alder');
    expect(martha?.alt_names).toContain('Martha Corwin');

    // Parenthetical maiden name "Eleanor (Hollis) Alder" is normalized to primary "Eleanor Hollis".
    const eleanor = people.find((p) => p.gedcom_xref === '@I5@');
    expect(eleanor?.full_name).toBe('Eleanor Hollis');
    expect(eleanor?.alt_names).toContain('Eleanor Alder');

    // All 7 YAML files exist and parse cleanly through @kinloom/core.
    expect(parseEventsYaml(await readFile(path.join(outDir, 'events.yaml'), 'utf8')).length).toBeGreaterThan(0);
    expect(parsePlacesYaml(await readFile(path.join(outDir, 'places.yaml'), 'utf8')).length).toBeGreaterThan(0);
    expect(parseSourcesYaml(await readFile(path.join(outDir, 'sources.yaml'), 'utf8')).length).toBeGreaterThan(0);
    expect(parseKinshipYaml(await readFile(path.join(outDir, 'kinship.yaml'), 'utf8')).length).toBeGreaterThan(0);
    expect(parseMediaYaml(await readFile(path.join(outDir, 'media.yaml'), 'utf8'))).toEqual([]);
    expect(parseNarrativesYaml(await readFile(path.join(outDir, 'narratives.yaml'), 'utf8'))).toEqual([]);

    // With --include-upstream-spouses, Henry Bramwell (@I99@) is included.
    const cap2 = createCaptureIo();
    const code2 = await runCli(
      [
        'slice-gedcom',
        '--input',
        gedPath,
        '--out',
        outUpstreamDir,
        '--root',
        'Arthur Alder',
        '--surname',
        'Alder',
        '--include-upstream-spouses',
      ],
      { io: cap2.io }
    );
    expect(code2).toBe(EXIT_OK);
    const upstreamPeople = parsePeopleYaml(await readFile(path.join(outUpstreamDir, 'people.yaml'), 'utf8'));
    expect(upstreamPeople.map((p) => p.gedcom_xref)).toContain('@I99@');
  });

  it('seed supports --dry-run and idempotent create/update/skip convergence', async () => {
    const dir = await makeTempDir('kinloom-seed-');
    const dataDir = path.join(dir, 'data');
    const configPath = path.join(dir, 'kinloom.config.yaml');
    const snapshot = makeSyntheticSnapshot();
    const config = makeSampleSiteConfig();

    await writeFile(configPath, serializeKinloomConfigYaml(config), 'utf8');
    const yamlFiles = serializeSnapshotToYamlFiles(snapshot);
    await runCli(['init', dir, '--family', 'Alder', '--title', 'Alder Family Archive'], {
      io: createCaptureIo().io,
    });
    for (const [name, content] of Object.entries(yamlFiles)) {
      await writeFile(path.join(dataDir, name), content, 'utf8');
    }

    let fetchCalls = 0;
    const dryCap = createCaptureIo();
    const dryCode = await runCli(
      ['seed', '--data', dataDir, '--config', configPath, '--dry-run'],
      {
        io: dryCap.io,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response('{}', { status: 200 });
        },
      }
    );
    expect(dryCode).toBe(EXIT_OK);
    expect(fetchCalls).toBe(0);
    expect(dryCap.stdout[0]).toContain('4 entities ready');

    // Stateful mock server supporting GET /api/export/snapshot and POST /api/batches
    const store = new Map<string, { type: Exclude<EntityType, 'kinship_edge'>; id: string; data: EntityPayload; rev: number }>();
    let headRev = 0;
    const submittedBatches: BatchSubmission[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/export/snapshot')) {
        return new Response(
          JSON.stringify({
            head_revision_id: headRev,
            entities: [...store.values()].map((row) => ({
              entity_type: row.type,
              entity_id: row.id,
              slug: typeof row.data.slug === 'string' ? row.data.slug : null,
              data: row.data,
              current_revision_id: row.rev,
              has_primary_source: true,
              deleted_at: null,
              updated_at: '2026-01-01T00:00:00.000Z',
            })),
            kinship: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/batches') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as BatchSubmission;
        submittedBatches.push(body);
        const revisions: RevisionRecord[] = [];
        for (const patch of body.patches) {
          headRev += 1;
          if (patch.action === 'create' || patch.action === 'update') {
            if (patch.entity_type !== 'kinship_edge') {
              store.set(`${patch.entity_type}:${patch.entity_id}`, {
                type: patch.entity_type,
                id: patch.entity_id,
                data: patch.data,
                rev: headRev,
              });
            }
          }
          revisions.push({
            revision_id: headRev,
            batch_id: body.batch_id,
            entity_type: patch.entity_type,
            entity_id: patch.entity_id,
            parent_revision_id: patch.action === 'update' ? (patch.parent_revision_id ?? null) : null,
            action: patch.action,
            reverted_revision_id: null,
            author_id: 'system',
            author_name: 'Seeder',
            author_type: body.author_type,
            summary: body.summary,
            has_primary_source: body.has_primary_source,
            before_json: null,
            after_json: patch.action === 'create' || patch.action === 'update' ? patch.data : null,
            created_at: '2026-01-01T00:00:00.000Z',
          });
        }
        return new Response(
          JSON.stringify({
            batch_id: body.batch_id,
            revisions,
            head_revision_id: headRev,
            etag: `"r${headRev}"`,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response('Not Found', { status: 404 });
    };

    // First live seed creates all 4 entities.
    const seed1Cap = createCaptureIo();
    const seed1Code = await runCli(
      ['seed', '--data', dataDir, '--config', configPath, '--site', 'https://alder.example.test', '--token', 'tok'],
      { io: seed1Cap.io, fetchImpl: mockFetch }
    );
    expect(seed1Code).toBe(EXIT_OK);
    expect(seed1Cap.stdout[0]).toContain('4 created, 0 updated, 0 unchanged');
    expect(submittedBatches).toHaveLength(1);
    expect(submittedBatches[0].author_type).toBe('system_seed');

    // Second live seed with unchanged YAML submits zero batches.
    const seed2Cap = createCaptureIo();
    const seed2Code = await runCli(
      ['seed', '--data', dataDir, '--config', configPath, '--site', 'https://alder.example.test', '--token', 'tok'],
      { io: seed2Cap.io, fetchImpl: mockFetch }
    );
    expect(seed2Code).toBe(EXIT_OK);
    expect(seed2Cap.stdout[0]).toContain('4 unchanged, 0 created, 0 updated');
    expect(submittedBatches).toHaveLength(1);

    // Modifying one person causes only 1 update patch on the third seed.
    const updatedPeople = parsePeopleYaml(await readFile(path.join(dataDir, 'people.yaml'), 'utf8'));
    updatedPeople[0].alt_names = ['A. Alder'];
    await writeFile(
      path.join(dataDir, 'people.yaml'),
      serializePeopleYaml(updatedPeople, { sortById: true }),
      'utf8'
    );
    const seed3Cap = createCaptureIo();
    const seed3Code = await runCli(
      ['seed', '--data', dataDir, '--config', configPath, '--site', 'https://alder.example.test', '--token', 'tok'],
      { io: seed3Cap.io, fetchImpl: mockFetch }
    );
    expect(seed3Code).toBe(EXIT_OK);
    expect(seed3Cap.stdout[0]).toContain('0 created, 1 updated, 3 unchanged');
    expect(submittedBatches).toHaveLength(2);
    expect(submittedBatches[1].patches[0].action).toBe('update');
  });

  it('submit-batch validates at boundary before HTTP, commits valid batches, and exits 3 on 409 Conflict', async () => {
    const dir = await makeTempDir('kinloom-batch-');

    // 1. Invalid entity payload fails locally before any network call.
    const invalidPath = path.join(dir, 'invalid.json');
    await writeFile(
      invalidPath,
      JSON.stringify({
        batch_id: 'batch_bad_1',
        summary: 'Missing required person fields',
        patches: [
          {
            action: 'create',
            entity_type: 'person',
            entity_id: 'per_broken',
            data: { id: 'per_broken' },
          },
        ],
      }),
      'utf8'
    );

    let networkCalled = false;
    const badCap = createCaptureIo();
    const badCode = await runCli(
      ['submit-batch', '--file', invalidPath, '--site', 'https://alder.example.test'],
      {
        io: badCap.io,
        fetchImpl: async () => {
          networkCalled = true;
          return new Response('{}', { status: 201 });
        },
      }
    );
    expect(badCode).toBe(EXIT_USAGE);
    expect(networkCalled).toBe(false);
    expect(badCap.stderr.join('\n')).toContain('patches[0]');

    // 2. Valid batch succeeds and prints revision range + etag.
    const validPath = path.join(dir, 'valid.yaml');
    await writeFile(
      validPath,
      [
        'batch_id: batch_research_42',
        'author_type: agent',
        'summary: Add 1880 census source and update Arthur Alder',
        'has_primary_source: true',
        'patches:',
        '  - action: create',
        '    entity_type: source',
        '    entity_id: src_1880_ohio',
        '    data:',
        '      id: src_1880_ohio',
        '      citation: 1880 Federal Census, Oak County, Ohio',
        '      source_type: census',
        '  - action: update',
        '    entity_type: person',
        '    entity_id: per_arthur_alder',
        '    parent_revision_id: 3',
        '    merge: true',
        '    data:',
        '      alt_names:',
        '        - Art Alder',
      ].join('\n'),
      'utf8'
    );

    const okCap = createCaptureIo();
    const okCode = await runCli(
      ['submit-batch', '--file', validPath, '--site', 'https://alder.example.test', '--token', 'tok_agent'],
      {
        io: okCap.io,
        fetchImpl: async (_url, init) => {
          const authHeader = new Headers(init?.headers).get('authorization');
          expect(authHeader).toBe('Bearer tok_agent');
          return new Response(
            JSON.stringify({
              batch_id: 'batch_research_42',
              head_revision_id: 11,
              etag: '"r11"',
              revisions: [
                {
                  revision_id: 10,
                  batch_id: 'batch_research_42',
                  entity_type: 'source',
                  entity_id: 'src_1880_ohio',
                  parent_revision_id: null,
                  action: 'create',
                  reverted_revision_id: null,
                  author_id: 'agent_1',
                  author_name: 'Research Bot',
                  author_type: 'agent',
                  summary: 'Add 1880 census source',
                  has_primary_source: true,
                  before_json: null,
                  after_json: { id: 'src_1880_ohio' },
                  created_at: '2026-01-03T00:00:00.000Z',
                },
                {
                  revision_id: 11,
                  batch_id: 'batch_research_42',
                  entity_type: 'person',
                  entity_id: 'per_arthur_alder',
                  parent_revision_id: 3,
                  action: 'update',
                  reverted_revision_id: null,
                  author_id: 'agent_1',
                  author_name: 'Research Bot',
                  author_type: 'agent',
                  summary: 'Update Arthur Alder',
                  has_primary_source: true,
                  before_json: { alt_names: [] },
                  after_json: { alt_names: ['Art Alder'] },
                  created_at: '2026-01-03T00:00:00.000Z',
                },
              ],
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          );
        },
      }
    );
    expect(okCode).toBe(EXIT_OK);
    expect(okCap.stdout[0]).toContain('Committed batch batch_research_42: 2 revision(s) (r10..r11)');
    expect(okCap.stdout[0]).toContain('etag "r11"');

    // 3. 409 Conflict prints field diff details and exits with code 3.
    const conflictCap = createCaptureIo();
    const conflictCode = await runCli(
      ['submit-batch', '--file', validPath, '--site', 'https://alder.example.test'],
      {
        io: conflictCap.io,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'OPTIMISTIC_CONFLICT',
                message: 'Entity person/per_arthur_alder modified by another editor.',
                details: {
                  kind: 'conflict',
                  entity_type: 'person',
                  entity_id: 'per_arthur_alder',
                  expected_parent_revision_id: 3,
                  server_revision_id: 7,
                  server_entity: { id: 'per_arthur_alder', alt_names: ['A. Alder'] },
                  server_deleted_at: null,
                  last_author_name: 'Jane Archivist',
                  last_updated_at: '2026-01-03T01:00:00.000Z',
                  diff: {
                    fields: [
                      {
                        path: 'alt_names',
                        kind: 'changed',
                        before: ['A. Alder'],
                        after: ['Art Alder'],
                      },
                    ],
                    addedCount: 0,
                    removedCount: 0,
                    changedCount: 1,
                    hasChanges: true,
                  },
                },
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } }
          ),
      }
    );
    expect(conflictCode).toBe(EXIT_CONFLICT);
    expect(conflictCap.stderr.join('\n')).toContain('Conflict on person/per_arthur_alder:');
    expect(conflictCap.stderr.join('\n')).toContain('~ alt_names:');
  });

  it('export-yaml writes sorted YAML on 200, skips untouched on 304, and falls back to /api/export/snapshot', async () => {
    const dir = await makeTempDir('kinloom-export-');
    const outDir = path.join(dir, 'data');
    const stateFile = path.join(outDir, '.last-backup-revision');
    const snapshot = makeSyntheticSnapshot();
    const expectedFiles = serializeSnapshotToYamlFiles(snapshot);

    const seenIfNoneMatch: Array<string | null> = [];
    const mockFetchYaml: typeof fetch = async (_url, init) => {
      const inm = new Headers(init?.headers).get('if-none-match');
      seenIfNoneMatch.push(inm);
      if (inm === '"r4"') {
        return new Response(null, { status: 304, headers: { etag: '"r4"' } });
      }
      return new Response(
        JSON.stringify({
          head_revision_id: 4,
          exported_at: '2026-01-01T00:00:00.000Z',
          files: expectedFiles,
        }),
        { status: 200, headers: { 'content-type': 'application/json', etag: '"r4"' } }
      );
    };

    const cap1 = createCaptureIo();
    const code1 = await runCli(
      ['export-yaml', '--site', 'https://alder.example.test', '--out', outDir, '--state-file', stateFile],
      { io: cap1.io, fetchImpl: mockFetchYaml }
    );
    expect(code1).toBe(EXIT_OK);
    expect(seenIfNoneMatch).toEqual([null]);
    expect((await readFile(stateFile, 'utf8')).trim()).toBe('4');
    expect(await readFile(path.join(outDir, 'people.yaml'), 'utf8')).toBe(expectedFiles['people.yaml']);

    // Pin people.yaml mtime to the past so we can prove 304 does not touch the file.
    const pastDate = new Date('2020-01-01T00:00:00.000Z');
    await utimes(path.join(outDir, 'people.yaml'), pastDate, pastDate);

    const cap2 = createCaptureIo();
    const code2 = await runCli(
      ['export-yaml', '--site', 'https://alder.example.test', '--out', outDir, '--state-file', stateFile],
      { io: cap2.io, fetchImpl: mockFetchYaml }
    );
    expect(code2).toBe(EXIT_OK);
    expect(seenIfNoneMatch).toEqual([null, '"r4"']);
    expect(cap2.stdout[0]).toContain('Not modified (304)');
    const statsAfter = await stat(path.join(outDir, 'people.yaml'));
    expect(statsAfter.mtimeMs).toBe(pastDate.getTime());

    // Fallback to GET /api/export/snapshot when GET /api/export/yaml returns 404.
    const fallbackOut = path.join(dir, 'fallback-data');
    const fallbackCap = createCaptureIo();
    const fallbackCode = await runCli(
      ['export-yaml', '--site', 'https://alder.example.test', '--out', fallbackOut],
      {
        io: fallbackCap.io,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/export/yaml')) {
            return new Response(
              JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not implemented' } }),
              { status: 404, headers: { 'content-type': 'application/json' } }
            );
          }
          return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"r4"' },
          });
        },
      }
    );
    expect(fallbackCode).toBe(EXIT_OK);
    expect(fallbackCap.stdout[0]).toContain('via snapshot_fallback');
    expect(await readFile(path.join(fallbackOut, 'events.yaml'), 'utf8')).toBe(
      expectedFiles['events.yaml']
    );
  });

  it('upload-media validates MIME/size locally and sends multipart FormData', async () => {
    const dir = await makeTempDir('kinloom-upload-');

    // Valid PNG magic header bytes.
    const pngPath = path.join(dir, 'census.png');
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    await writeFile(pngPath, pngBytes);

    // Unsupported binary file fails locally before network.
    const exePath = path.join(dir, 'bad.bin');
    await writeFile(exePath, Uint8Array.from([0x4d, 0x5a, 0x90, 0x00]));

    let uploadCalled = false;
    const badCap = createCaptureIo();
    const badCode = await runCli(
      [
        'upload-media',
        '--file',
        exePath,
        '--metadata',
        JSON.stringify({ id: 'med_bad', kind: 'document_scan', caption: 'Bad file' }),
        '--summary',
        'Attempt invalid upload',
        '--site',
        'https://alder.example.test',
      ],
      {
        io: badCap.io,
        fetchImpl: async () => {
          uploadCalled = true;
          return new Response('{}', { status: 201 });
        },
      }
    );
    expect(badCode).toBe(EXIT_USAGE);
    expect(uploadCalled).toBe(false);
    expect(badCap.stderr.join('\n')).toContain('unsupported_mime');

    // Valid upload sends multipart FormData with file, metadata, and summary.
    let receivedSummary: ReturnType<FormData['get']> = null;
    let receivedMetadata: ReturnType<FormData['get']> = null;
    let receivedFileType = '';
    const okCap = createCaptureIo();
    const okCode = await runCli(
      [
        'upload-media',
        '--file',
        pngPath,
        '--metadata',
        JSON.stringify({
          id: 'med_1880_scan',
          kind: 'document_scan',
          person_ids: ['per_arthur_alder'],
          caption: '1880 census page scan',
        }),
        '--summary',
        'Upload 1880 census scan',
        '--site',
        'https://alder.example.test',
        '--token',
        'tok_upload',
      ],
      {
        io: okCap.io,
        fetchImpl: async (_url, init) => {
          const form = init?.body as FormData;
          receivedSummary = form.get('summary');
          receivedMetadata = form.get('metadata');
          const fileEntry = form.get('file') as File;
          receivedFileType = fileEntry.type;
          return new Response(
            JSON.stringify({
              media: {
                id: 'med_1880_scan',
                kind: 'document_scan',
                person_ids: ['per_arthur_alder'],
                file: '/media/abcdef123456.png',
                caption: '1880 census page scan',
              },
              url: '/media/abcdef123456.png',
              revision: {
                revision_id: 9,
                batch_id: null,
                entity_type: 'media',
                entity_id: 'med_1880_scan',
                parent_revision_id: null,
                action: 'create',
                reverted_revision_id: null,
                author_id: 'agent_1',
                author_name: 'Research Bot',
                author_type: 'agent',
                summary: 'Upload 1880 census scan',
                has_primary_source: true,
                before_json: null,
                after_json: { id: 'med_1880_scan' },
                created_at: '2026-01-04T00:00:00.000Z',
              },
              etag: '"r9"',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          );
        },
      }
    );
    expect(okCode).toBe(EXIT_OK);
    expect(receivedSummary).toBe('Upload 1880 census scan');
    expect(receivedFileType).toBe('image/png');
    expect(JSON.parse(String(receivedMetadata))).toMatchObject({
      id: 'med_1880_scan',
      kind: 'document_scan',
    });
    expect(okCap.stdout[0]).toContain('Uploaded med_1880_scan -> /media/abcdef123456.png');
  });

  it('reconcile returns 0 when cached bundle matches compileArchive and 1 when drift exists', async () => {
    const dir = await makeTempDir('kinloom-reconcile-');
    const configPath = path.join(dir, 'kinloom.config.yaml');
    const siteConfig = makeSampleSiteConfig();
    await writeFile(configPath, serializeKinloomConfigYaml(siteConfig), 'utf8');

    const snapshot = makeSyntheticSnapshot();
    const compiled = compileArchive({
      places: [snapshot.entities[0].data as Place],
      sources: [snapshot.entities[1].data as SourceRecord],
      people: [snapshot.entities[2].data as RawPerson],
      events: [snapshot.entities[3].data as RawEvent],
      kinship: [],
      media: [],
      siteConfig,
      mode: 'private',
      generatedAt: '2026-01-05T00:00:00.000Z',
      maxRevisionId: 4,
    }).bundle;

    // 1. Exact match exits 0.
    const cleanCap = createCaptureIo();
    const cleanCode = await runCli(
      ['reconcile', '--site', 'https://alder.example.test', '--config', configPath],
      {
        io: cleanCap.io,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/bundle')) {
            return new Response(JSON.stringify(compiled), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"r4"' },
            });
          }
          return new Response(
            JSON.stringify({
              head_revision_id: snapshot.head_revision_id,
              exported_at: '2026-01-05T00:00:00.000Z',
              snapshot,
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"r4"' },
            }
          );
        },
      }
    );
    expect(cleanCode).toBe(EXIT_OK);
    expect(cleanCap.stdout[0]).toContain('Reconcile OK');

    // 2. Drifted cached bundle exits 1 and reports exact drifted path.
    const drifted = structuredClone(compiled);
    drifted.people[0].full_name = 'Arthur Alder (Stale Cache)';
    const driftCap = createCaptureIo();
    const driftCode = await runCli(
      ['reconcile', '--site', 'https://alder.example.test', '--config', configPath],
      {
        io: driftCap.io,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/bundle')) {
            return new Response(JSON.stringify(drifted), {
              status: 200,
              headers: { 'content-type': 'application/json', etag: '"r4"' },
            });
          }
          return new Response(JSON.stringify(snapshot), {
            status: 200,
            headers: { 'content-type': 'application/json', etag: '"r4"' },
          });
        },
      }
    );
    expect(driftCode).toBe(EXIT_ERROR);
    expect(driftCap.stderr.join('\n')).toContain('Reconcile DRIFT detected');
    expect(driftCap.stderr.join('\n')).toContain('people');
  });

  it('seed falls back cleanly when /api/export/snapshot returns 403 for write_batch tokens', async () => {
    const dir = await makeTempDir('kinloom-seed-403-');
    const dataDir = path.join(dir, 'data');
    const configPath = path.join(dir, 'kinloom.config.yaml');
    const snapshot = makeSyntheticSnapshot();

    await runCli(['init', dir, '--family', 'Alder', '--title', 'Alder Family Archive'], {
      io: createCaptureIo().io,
    });
    const yamlFiles = serializeSnapshotToYamlFiles(snapshot);
    for (const [name, content] of Object.entries(yamlFiles)) {
      await writeFile(path.join(dataDir, name), content, 'utf8');
    }

    let postedCount = 0;
    const cap = createCaptureIo();
    const code = await runCli(
      ['seed', '--data', dataDir, '--config', configPath, '--site', 'https://alder.example.test', '--token', 'write_tok'],
      {
        io: cap.io,
        fetchImpl: async (input, init) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/export/snapshot')) {
            return new Response(
              JSON.stringify({ error: { code: 'FORBIDDEN', message: 'read_backup scope required' } }),
              { status: 403, headers: { 'content-type': 'application/json' } }
            );
          }
          const body = JSON.parse(String(init?.body)) as BatchSubmission;
          postedCount = body.patches.length;
          return new Response(
            JSON.stringify({
              batch_id: body.batch_id,
              revisions: [],
              head_revision_id: 4,
              etag: '"r4"',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } }
          );
        },
      }
    );
    expect(code).toBe(EXIT_OK);
    expect(postedCount).toBe(4);
    expect(cap.stdout[0]).toContain('4 created, 0 updated, 0 unchanged');
  });

  it('upload-media enforces size limit locally and supports --dry-run', async () => {
    const dir = await makeTempDir('kinloom-upload-size-');
    const pngPath = path.join(dir, 'large.png');
    const pngBytes = new Uint8Array(2048);
    pngBytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    await writeFile(pngPath, pngBytes);

    let called = false;
    const overCap = createCaptureIo();
    const overCode = await runCli(
      [
        'upload-media',
        '--file',
        pngPath,
        '--metadata',
        JSON.stringify({ id: 'med_large', kind: 'portrait', caption: 'Large portrait' }),
        '--summary',
        'Upload oversized portrait',
        '--site',
        'https://alder.example.test',
        '--max-bytes',
        '512',
      ],
      {
        io: overCap.io,
        fetchImpl: async () => {
          called = true;
          return new Response('{}', { status: 201 });
        },
      }
    );
    expect(overCode).toBe(EXIT_USAGE);
    expect(called).toBe(false);
    expect(overCap.stderr.join('\n')).toContain('file_too_large');

    const dryCap = createCaptureIo();
    const dryCode = await runCli(
      [
        'upload-media',
        '--file',
        pngPath,
        '--metadata',
        JSON.stringify({ id: 'med_ok', kind: 'portrait', caption: 'Portrait' }),
        '--summary',
        'Validate portrait locally',
        '--dry-run',
      ],
      { io: dryCap.io }
    );
    expect(dryCode).toBe(EXIT_OK);
    expect(dryCap.stdout[0]).toContain('Dry-run OK: large.png (image/png, 2048 bytes)');
  });
});
