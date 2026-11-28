import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  type ArchiveRawSnapshot,
  asRevisionId,
  type BatchSubmission,
  compileArchive,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  parseKinloomConfigYaml,
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
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli.js';
import { KinloomApiClient } from './client.js';
import { encodeIcoFromPngs, runBrandkitCommand } from './commands/brandkit.js';
import {
  loadArchiveDataDir,
  loadLocalArchiveRepo,
  loadLocalArchiveRepoSync,
  snapshotToArchiveData,
} from './commands/dataFiles.js';
import { runExportYamlCommand } from './commands/exportYaml.js';
import { runReconcileCommand } from './commands/reconcile.js';
import { runSeedCommand } from './commands/seed.js';
import { runSliceGedcomCommand } from './commands/sliceGedcom.js';
import { runSubmitBatchCommand, validateBatchSubmission } from './commands/submitBatch.js';
import { detectMimeType, runUploadMediaCommand } from './commands/uploadMedia.js';
import { CliValidationError, EXIT_ERROR, EXIT_OK, EXIT_USAGE, KinloomApiError } from './errors.js';
import {
  discoverFirstMediaPathFromBundle,
  formatSyntheticProbeReport,
  normalizeProbeBaseUrl,
  parseServerTimingHeader,
  roundDurationMs,
} from './plugins/syntheticProbeParsing.js';
import { runSyntheticProbe } from './plugins/syntheticProbeRunner.js';
import type { SyntheticProbeClock, SyntheticProbeReport } from './plugins/syntheticProbeTypes.js';
import { discoverSiteCliPlugins, formatPluginCommandsHelp, type KinloomCliPlugin } from './plugins.js';

const tempDirs: string[] = [];
const openServers: http.Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
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

async function startLocalServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function makeSiteConfig(overrides?: {
  plugins?: string[];
  pronunciations?: Record<
    string,
    { phonetic?: string; ipa?: string; source_label?: string; source_url?: string }
  >;
}): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Oakville Archive',
        familyName: 'Smith',
        gedcomSourceName: 'OAKVILLE_ARCHIVE',
        footerCredit: 'Built with Kinloom',
      },
      theme: { accent: '#7A4612' },
      defaultBranchId: 'smith',
      branches: [
        {
          id: 'smith',
          label: 'Smith Line',
          surnames: ['Smith'],
          lineageGroups: ['pivot_ancestor', 'ancestor', 'descendant'],
          supportsDirectMode: true,
        },
      ],
      lineageSections: [],
      featuredKinshipPairs: [],
      migrationEras: [],
      mapDefaults: { centerLat: 40.0, centerLng: -83.0, zoom: 5, minSpanDeg: 1.0 },
      privacy: {
        livingCutoffYears: 101,
        referenceYear: 2026,
        privateModeShowsBirthYear: true,
        stripLivingPortraits: true,
        stripLivingResidenceSpans: true,
        markGedcomLivingConfidential: true,
      },
      ...(overrides?.plugins ? { plugins: overrides.plugins } : {}),
      ...(overrides?.pronunciations ? { pronunciations: overrides.pronunciations } : {}),
    })
  );
}

function makeRichArchiveFixtures(): {
  place: Place;
  source: SourceRecord;
  john: RawPerson;
  jane: RawPerson;
  event: RawEvent;
  kinship: KinshipEdge;
  media: MediaItem;
  narrative: Narrative;
  snapshot: ArchiveRawSnapshot;
} {
  const place: Place = {
    id: 'plc_oakville_ohio',
    slug: 'oakville-ohio',
    name: 'Oakville',
    full_name: 'Oakville, Ohio, USA',
    place_type: 'town',
    parent_id: null,
    lat: 40.2,
    lng: -82.8,
    historical_names: [],
  };
  const source: SourceRecord = {
    id: 'src_1880_oakville',
    citation: '1880 United States Federal Census, Oakville, Ohio',
    source_type: 'census',
    repository: 'NARA',
  };
  const john: RawPerson = {
    id: 'per_john_smith',
    slug: 'john-smith',
    full_name: 'John Smith',
    given_name: 'John',
    surname: 'Smith',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'pivot_ancestor',
    branch: 'smith',
    birth_edtf: '1842-05-14',
    death_edtf: '1918-11-02',
    portrait_url: null,
  };
  const jane: RawPerson = {
    id: 'per_jane_doe',
    slug: 'jane-doe',
    full_name: 'Jane Doe',
    given_name: 'Jane',
    surname: 'Doe',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    branch: 'smith',
    birth_edtf: '1845-03-10',
    death_edtf: '1920-07-08',
    portrait_url: null,
  };
  const event: RawEvent = {
    id: 'evt_birth_john',
    title: 'Birth of John Smith',
    scope: 'personal',
    event_kind: 'point_event',
    edtf_date: '1842-05-14',
    place_id: place.id,
    summary: 'Born in Oakville, Ohio.',
    participants: [{ person_id: john.id, role: 'birth_subject' }],
    sources: [{ source_id: source.id, confidence: 'high' }],
  };
  const kinship: KinshipEdge = {
    from: john.id,
    to: jane.id,
    relation: 'spouse',
    family_xref: '@F1@',
  };
  const media: MediaItem = {
    id: 'med_oakville_census',
    kind: 'document_scan',
    source_id: source.id,
    person_id: john.id,
    file: '/media/oakville-1880.png',
    caption: 'Oakville 1880 census scan',
  };
  const narrative: Narrative = {
    id: 'nar_john_smith',
    slug: 'john-smith-story',
    title: 'John Smith of Oakville',
    person_ids: [john.id],
    place_ids: [place.id],
    event_ids: [event.id],
    source_ids: [source.id],
    body_md: 'John Smith settled in Oakville.[^src_1880_oakville|med_oakville_census]',
  };

  const snapshot: ArchiveRawSnapshot = {
    head_revision_id: asRevisionId(8),
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
        entity_id: john.id,
        slug: john.slug,
        data: john,
        current_revision_id: asRevisionId(3),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'person',
        entity_id: jane.id,
        slug: jane.slug,
        data: jane,
        current_revision_id: asRevisionId(4),
        has_primary_source: false,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'event',
        entity_id: event.id,
        slug: null,
        data: event,
        current_revision_id: asRevisionId(5),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'media',
        entity_id: media.id,
        slug: null,
        data: media,
        current_revision_id: asRevisionId(6),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'narrative',
        entity_id: narrative.id,
        slug: narrative.slug,
        data: narrative,
        current_revision_id: asRevisionId(7),
        has_primary_source: true,
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        entity_type: 'person',
        entity_id: 'per_deleted_old',
        slug: 'deleted-old',
        data: { ...john, id: 'per_deleted_old', slug: 'deleted-old' },
        current_revision_id: asRevisionId(8),
        has_primary_source: true,
        deleted_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ],
    kinship: [
      {
        edge_id: 'kin_john_jane',
        edge: kinship,
        current_revision_id: asRevisionId(8),
        deleted_at: null,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        edge_id: 'kin_deleted_edge',
        edge: kinship,
        current_revision_id: asRevisionId(8),
        deleted_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
      },
    ],
  };

  return { place, source, john, jane, event, kinship, media, narrative, snapshot };
}

async function writeArchiveRepo(
  repoDir: string,
  options?: {
    config?: KinloomSiteConfig;
    people?: RawPerson[];
    events?: RawEvent[];
    places?: Place[];
    sources?: SourceRecord[];
    kinship?: KinshipEdge[];
    media?: MediaItem[];
    narratives?: Narrative[];
  }
): Promise<string> {
  const dataDir = path.join(repoDir, 'data');
  await mkdir(dataDir, { recursive: true });
  const config = options?.config ?? makeSiteConfig();
  await Promise.all([
    writeFile(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8'),
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(options?.people ?? []), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(options?.events ?? []), 'utf8'),
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(options?.places ?? []), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(options?.sources ?? []), 'utf8'),
    writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml(options?.kinship ?? []), 'utf8'),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(options?.media ?? []), 'utf8'),
    writeFile(
      path.join(dataDir, 'narratives.yaml'),
      serializeNarrativesYaml(options?.narratives ?? []),
      'utf8'
    ),
  ]);
  return dataDir;
}

async function installStubWrangler(repoDir: string, scriptBody: string): Promise<string> {
  const binDir = path.join(repoDir, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  const binPath = path.join(binDir, 'wrangler');
  await writeFile(binPath, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  await chmod(binPath, 0o755);
  return binPath;
}

afterEach(async () => {
  delete process.env['KINLOOM_TELEMETRY_FILE'];
  delete process.env['KINLOOM_PRONOUNCE_CACHE_DIR'];
  delete process.env['FORVO_API_KEY'];
  while (openServers.length > 0) {
    const srv = openServers.pop();
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('liveAndUtilityCommands: sync, migrate, dates, pronounce, telemetry', () => {
  it('validates all sync flag parsing edge cases and executes sync dry-run and live verification', async () => {
    const repoDir = await makeTempDir('kinloom-sync-cli-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(repoDir, 'telemetry.jsonl');

    const { john, place } = makeRichArchiveFixtures();
    await writeArchiveRepo(repoDir, { people: [john], places: [place] });
    const mediaDir = path.join(repoDir, 'media');
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, 'sample-a.png'), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(mediaDir, 'sample-b.png'), Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'oakville-archive',
        d1_databases: [{ binding: 'DB', database_name: 'oakville-db' }],
        r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'oakville-media' }],
        routes: [{ pattern: 'archive.example.test/*' }],
      }),
      'utf8'
    );

    await installStubWrangler(
      repoDir,
      `
const args = process.argv.slice(2);
const cmdIdx = args.indexOf('--command');
const sql = cmdIdx >= 0 ? args[cmdIdx + 1] : '';
if (sql.includes('DELETE FROM agent_tokens')) {
  process.stdout.write(JSON.stringify([
    { success: true, results: [] },
    { success: true, results: [] },
    { success: true, results: [{ count: 1 }] },
    { success: true, results: [{ count: 0 }] },
  ]));
} else {
  process.stdout.write(JSON.stringify([{ success: true, results: [] }]));
}
`
    );

    // 1. Flag validation errors in parseSyncArgs
    const badSyncCases: Array<[string[], string]> = [
      [['sync', '--repo='], 'Option `--repo` requires a value.'],
      [['sync', '--repo', '--dry-run'], 'Option `--repo` requires a value.'],
      [['sync', '--upload-media='], 'Option `--upload-media` requires at least one file path.'],
      [['sync', '--upload-media', '--dry-run'], 'Option `--upload-media` requires at least one file path.'],
      [['sync', 'unexpected-positional'], "Unknown argument 'unexpected-positional' for `kinloom sync`."],
    ];
    for (const [args, expectedErr] of badSyncCases) {
      const cap = createCaptureIo();
      expect(await runCli(args, { io: cap.io, cwd: repoDir })).toBe(EXIT_USAGE);
      expect(cap.stderr.join('\n')).toContain(expectedErr);
    }

    // 2. Full flag matrix on dry-run sync (all sync flags including multi-arg --upload-media and repeated --types)
    const emptySnapshotFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/export/snapshot')) {
        return new Response(JSON.stringify({ head_revision_id: 2, entities: [], kinship: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"r2"' },
        });
      }
      return new Response('Not Found', { status: 404 });
    };

    const dryCap = createCaptureIo();
    const dryCode = await runCli(
      [
        'sync',
        `--repo=${repoDir}`,
        '--site-url=https://archive.example.test',
        '--types',
        'place',
        '--types=person',
        '--sync-missing-media',
        '--upload-media',
        'media/sample-a.png',
        'media/sample-b.png',
        '--upload-media=media/sample-a.png',
        '--concurrency=2',
        '--chunk-size',
        '10',
        '--summary=Sync Oakville archive',
        '--allow-deletes',
        '--delete=person:per_removed',
        '--include-living',
        '--dry-run',
        '--json',
      ],
      { io: dryCap.io, fetchImpl: emptySnapshotFetch }
    );
    expect(dryCode, dryCap.stderr.join('\n')).toBe(EXIT_OK);
    const dryJson = JSON.parse(dryCap.stdout.join('\n')) as {
      dryRun: boolean;
      selectedTypes: string[];
      totalPatches: number;
      chunkSize: number;
      media: { plannedUploads: string[]; concurrency: number };
    };
    expect(dryJson.dryRun).toBe(true);
    expect(dryJson.selectedTypes).toEqual(['place', 'person']);
    expect(dryJson.chunkSize).toBe(10);
    expect(dryJson.media.concurrency).toBe(2);
    expect(dryJson.media.plannedUploads).toEqual(['media/sample-a.png', 'media/sample-b.png']);

    // 3. Live sync with --verify-live where bundle verification fails -> EXIT_ERROR (1)
    const verifyFailFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/export/snapshot')) {
        return new Response(
          JSON.stringify({
            head_revision_id: 2,
            entities: [
              {
                entity_type: 'place',
                entity_id: place.id,
                slug: place.slug,
                data: place,
                current_revision_id: 1,
                has_primary_source: true,
                deleted_at: null,
                updated_at: '2026-01-01T00:00:00.000Z',
              },
              {
                entity_type: 'person',
                entity_id: john.id,
                slug: john.slug,
                data: john,
                current_revision_id: 2,
                has_primary_source: true,
                deleted_at: null,
                updated_at: '2026-01-01T00:00:00.000Z',
              },
            ],
            kinship: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json', etag: '"r2"' } }
        );
      }
      if (url.endsWith('/api/bundle')) {
        return new Response('Service Unavailable', { status: 503 });
      }
      return new Response('Not Found', { status: 404 });
    };

    const failVerifyCap = createCaptureIo();
    const failVerifyCode = await runCli(
      ['sync', '--repo', repoDir, '--site', 'https://archive.example.test', '--verify-live', '--json'],
      { io: failVerifyCap.io, fetchImpl: verifyFailFetch }
    );
    expect(failVerifyCode).toBe(EXIT_ERROR);
    const failVerifyJson = JSON.parse(failVerifyCap.stdout.join('\n')) as {
      liveVerification: { ok: boolean; bundleStatus: number };
    };
    expect(failVerifyJson.liveVerification.ok).toBe(false);
    expect(failVerifyJson.liveVerification.bundleStatus).toBe(503);
  });

  it('dispatches migrate --local --dry-run, rejects conflicting flags, and exits 1 when verification fails', async () => {
    const repoDir = await makeTempDir('kinloom-migrate-cli-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(repoDir, 'telemetry.jsonl');

    const migrationsDir = path.join(repoDir, 'migrations');
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      path.join(migrationsDir, '0001_init.sql'),
      'CREATE TABLE sample_entities (id TEXT PRIMARY KEY);\n',
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        name: 'oakville-archive',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'oakville-db',
            migrations_dir: 'migrations',
          },
        ],
      }),
      'utf8'
    );

    // Reject both --remote and --local
    const conflictCap = createCaptureIo();
    expect(await runCli(['migrate', '--repo', repoDir, '--remote', '--local'], { io: conflictCap.io })).toBe(
      EXIT_USAGE
    );
    expect(conflictCap.stderr.join('\n')).toContain('Specify either `--remote` or `--local`, not both.');

    // Stub wrangler reporting table already exists -> dry-run ok
    await installStubWrangler(
      repoDir,
      `
const args = process.argv.slice(2);
const cmdIdx = args.indexOf('--command');
const sql = cmdIdx >= 0 ? args[cmdIdx + 1] : '';
if (sql.includes('sqlite_master')) {
  process.stdout.write(JSON.stringify([{ success: true, results: [{ type: 'table', name: 'sample_entities' }] }]));
} else {
  process.stdout.write(JSON.stringify([{ success: true, results: [{ name: 'id' }] }]));
}
`
    );

    const dryCap = createCaptureIo();
    const dryCode = await runCli(['migrate', '--repo', repoDir, '--local', '--dry-run', '--json'], {
      io: dryCap.io,
    });
    expect(dryCode, dryCap.stderr.join('\n')).toBe(EXIT_OK);
    const dryReport = JSON.parse(dryCap.stdout.join('\n')) as {
      ok: boolean;
      target: string;
      dryRun: boolean;
      verified: boolean;
    };
    expect(dryReport).toMatchObject({ ok: true, target: 'local', dryRun: true, verified: true });

    // Stub wrangler where table stays absent after execution -> verification fails (EXIT_ERROR)
    await installStubWrangler(
      repoDir,
      `
process.stdout.write(JSON.stringify([{ success: true, results: [] }]));
`
    );

    const failCap = createCaptureIo();
    const failCode = await runCli(['migrate', '--repo', repoDir, '--remote'], { io: failCap.io });
    expect(failCode).toBe(EXIT_ERROR);
    expect(failCap.stdout.join('\n')).toContain('0001_init.sql');
  });

  it('validates dates subcommand errors and argument constraints', async () => {
    const tmp = await makeTempDir('kinloom-dates-err-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'telemetry.jsonl');

    const cases: Array<[string[], string]> = [
      [['dates'], 'Missing dates subcommand.'],
      [
        ['dates', 'weekday', '1900-01-01', '--at', '1920-01-01'],
        'Option `--at` is only valid with `kinloom dates age`.',
      ],
      [['dates', 'weekday'], 'Usage: kinloom dates weekday <YYYY-MM-DD> [--json]'],
      [
        ['dates', 'diff', '1900-01-01', '1920-01-01', '--at', '1930-01-01'],
        'Option `--at` is only valid with `kinloom dates age`.',
      ],
      [
        ['dates', 'diff', '1900-01-01'],
        'Usage: kinloom dates diff <start-YYYY-MM-DD> <end-YYYY-MM-DD> [--json]',
      ],
      [['dates', 'age'], 'Usage: kinloom dates age <birth-YYYY-MM-DD> --at <YYYY-MM-DD>'],
    ];

    for (const [args, expected] of cases) {
      const cap = createCaptureIo();
      expect(await runCli(args, { io: cap.io })).toBe(EXIT_USAGE);
      expect(cap.stderr.join('\n')).toContain(expected);
    }
  });

  it('dispatches pronounce lookup, deduplicate, audit, and telemetry shorthand flags', async () => {
    const repoDir = await makeTempDir('kinloom-pronounce-cli-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(repoDir, 'telemetry.jsonl');
    process.env['KINLOOM_PRONOUNCE_CACHE_DIR'] = path.join(repoDir, 'pronounce-cache');

    const { john, place } = makeRichArchiveFixtures();
    await writeArchiveRepo(repoDir, {
      config: makeSiteConfig({
        pronunciations: {
          'John Smith': {
            phonetic: 'JON SMITH',
            ipa: '/dʒɒn smɪθ/',
            source_label: 'Synthetic fixture',
          },
          Oakville: {
            phonetic: 'OHK-vil',
            ipa: '/ˈoʊkvɪl/',
            source_label: 'Synthetic fixture',
          },
        },
      }),
      people: [john],
      places: [place],
    });

    // Validation errors
    const missingSub = createCaptureIo();
    expect(await runCli(['pronounce'], { io: missingSub.io })).toBe(EXIT_USAGE);
    expect(missingSub.stderr.join('\n')).toContain('Missing pronounce subcommand');

    const unknownSub = createCaptureIo();
    expect(await runCli(['pronounce', 'invalid-sub'], { io: unknownSub.io })).toBe(EXIT_USAGE);
    expect(unknownSub.stderr.join('\n')).toContain("Unknown pronounce subcommand 'invalid-sub'");

    const missingTerm = createCaptureIo();
    expect(await runCli(['pronounce', 'lookup'], { io: missingTerm.io })).toBe(EXIT_USAGE);
    expect(missingTerm.stderr.join('\n')).toContain('Usage: kinloom pronounce lookup');

    // pronounce lookup via mock fetchImpl (zero real network)
    const mockWikiFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'Oakville',
                revisions: [
                  {
                    slots: {
                      main: {
                        content: '==English==\n===Pronunciation===\n* {{IPA|en|/ˈoʊkvɪl/}}',
                      },
                    },
                  },
                ],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );

    const lookupCap = createCaptureIo();
    expect(
      await runCli(['pronounce', 'lookup', 'Oakville', '--lang', 'en', '--refresh', '--json'], {
        io: lookupCap.io,
        fetchImpl: mockWikiFetch,
      })
    ).toBe(EXIT_OK);
    const lookupJson = JSON.parse(lookupCap.stdout.join('\n')) as {
      term: string;
      lang: string;
      ipa: string[];
      cache_hit: boolean;
    };
    expect(lookupJson.term).toBe('Oakville');
    expect(lookupJson.lang).toBe('en');
    expect(lookupJson.ipa).toContain('/ˈoʊkvɪl/');
    expect(lookupJson.cache_hit).toBe(false);

    // pronounce deduplicate
    const dedupCap = createCaptureIo();
    expect(
      await runCli(['pronounce', 'deduplicate', '--repo', repoDir, '--json'], {
        io: dedupCap.io,
      })
    ).toBe(EXIT_OK);
    expect(JSON.parse(dedupCap.stdout.join('\n'))).toMatchObject({ applied: false });

    // pronounce audit (pass)
    const auditOkCap = createCaptureIo();
    expect(await runCli(['pronounce', 'audit', '--repo', repoDir, '--json'], { io: auditOkCap.io })).toBe(
      EXIT_OK
    );
    expect(JSON.parse(auditOkCap.stdout.join('\n'))).toMatchObject({ ok: true });

    // pronounce audit --strict fails when a deceased person lacks pronunciation
    const unpronouncedRepo = await makeTempDir('kinloom-pronounce-strict-');
    await writeArchiveRepo(unpronouncedRepo, { people: [john], places: [place] });
    const auditStrictCap = createCaptureIo();
    expect(
      await runCli(['pronounce', 'audit', '--repo', unpronouncedRepo, '--strict', '--json'], {
        io: auditStrictCap.io,
      })
    ).toBe(EXIT_ERROR);
    expect(JSON.parse(auditStrictCap.stdout.join('\n'))).toMatchObject({ ok: false });

    // telemetry unknown subcommand and shorthand invocation (without `report`)
    const badTelCap = createCaptureIo();
    expect(await runCli(['telemetry', 'bogus'], { io: badTelCap.io })).toBe(EXIT_USAGE);
    expect(badTelCap.stderr.join('\n')).toContain("Unknown telemetry subcommand 'bogus'");

    const telPath = path.join(repoDir, 'telemetry.jsonl');
    const shortTelCap = createCaptureIo();
    expect(
      await runCli(['telemetry', '--file', telPath, '--since-hours', '24', '--json'], {
        io: shortTelCap.io,
      })
    ).toBe(EXIT_OK);
    const telParsed = JSON.parse(shortTelCap.stdout.join('\n')) as { totalEvents: number };
    expect(telParsed.totalEvents).toBeGreaterThanOrEqual(2);
  });
});

describe('plugins.ts discovery, validation, import resolution, and help formatting', () => {
  it('handles malformed plugin exports, failing imports, non-dir entries, broken symlinks, deduplication, and package specifiers', async () => {
    const siteDir = await makeTempDir('kinloom-plugins-edge-');
    const extDir = path.join(siteDir, 'extensions');
    const pkgDir = path.join(siteDir, 'node_modules', 'fake-kinloom-plugin');
    await mkdir(path.join(extDir, 'alpha-valid'), { recursive: true });
    await mkdir(path.join(extDir, 'beta-no-entry'), { recursive: true });
    await mkdir(path.join(extDir, 'gamma-invalid-exports'), { recursive: true });
    await mkdir(path.join(extDir, 'delta-bad-cmds'), { recursive: true });
    await mkdir(path.join(extDir, 'epsilon-bad-audit'), { recursive: true });
    await mkdir(path.join(extDir, 'zeta-bad-verify'), { recursive: true });
    await mkdir(path.join(extDir, 'eta-empty-plugin'), { recursive: true });
    await mkdir(path.join(extDir, 'theta-throws'), { recursive: true });
    await mkdir(pkgDir, { recursive: true });

    // Regular file inside extensions/ (skipped) and broken symlink (skipped)
    await writeFile(path.join(extDir, 'README.md'), '# ignored file\n', 'utf8');
    await symlink(path.join(siteDir, 'does-not-exist-target'), path.join(extDir, 'broken-link'));

    // Valid plugin with long command name (>= 18 chars)
    const alphaFile = path.join(extDir, 'alpha-valid', 'cli.mjs');
    await writeFile(
      alphaFile,
      `export default {
  id: 'alpha-valid',
  name: 'Alpha Valid',
  commands: [
    {
      name: 'very-long-custom-command',
      summary: 'Long command summary',
      help: 'Usage: kinloom very-long-custom-command',
      run: () => 0,
    },
  ],
};
`,
      'utf8'
    );

    // Invalid exports covering every guard branch in isKinloomCliPlugin / isKinloomCliCommand / isKinloomCheck
    await writeFile(path.join(extDir, 'gamma-invalid-exports', 'cli.mjs'), 'export default null;\n', 'utf8');
    await writeFile(
      path.join(extDir, 'delta-bad-cmds', 'cli.mjs'),
      `export default { id: 'bad-cmds', name: 'Bad Cmds', commands: [null] };\n`,
      'utf8'
    );
    await writeFile(
      path.join(extDir, 'epsilon-bad-audit', 'cli.mjs'),
      `export default { id: 'bad-audit', name: 'Bad Audit', auditChecks: [null] };\n`,
      'utf8'
    );
    await writeFile(
      path.join(extDir, 'zeta-bad-verify', 'cli.mjs'),
      `export default { id: 'bad-verify', name: 'Bad Verify', verifyChecks: [{ id: 'x', name: 'y', run: 'not-fn' }] };\n`,
      'utf8'
    );
    await writeFile(
      path.join(extDir, 'eta-empty-plugin', 'cli.mjs'),
      `export default { id: 'empty-p', name: 'Empty' };\n`,
      'utf8'
    );
    await writeFile(
      path.join(extDir, 'theta-throws', 'cli.mjs'),
      `throw new Error('broken plugin import');\n`,
      'utf8'
    );

    // Bare package in node_modules resolved via createRequire
    await writeFile(
      path.join(siteDir, 'package.json'),
      JSON.stringify({ name: 'test-site', private: true }),
      'utf8'
    );
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'fake-kinloom-plugin', main: 'index.mjs' }),
      'utf8'
    );
    await writeFile(
      path.join(pkgDir, 'index.mjs'),
      `export const cliPlugin = {
  id: 'pkg-plugin',
  name: 'Package Plugin',
  commands: [{ name: 'pkg-cmd', summary: 'From pkg', help: 'Usage: kinloom pkg-cmd', run: () => 0 }],
};
`,
      'utf8'
    );

    // Explicit file:// plugin with bad id/name
    const badIdFile = path.join(siteDir, 'bad-id-plugin.mjs');
    await writeFile(badIdFile, `export default { id: '', name: 'No Id', commands: [] };\n`, 'utf8');

    // Configure: directory specifier (deduplicated against extensions/alpha-valid), file:// URL, bare pkg, missing bare pkg
    await writeFile(
      path.join(siteDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(
        makeSiteConfig({
          plugins: [
            './extensions/alpha-valid',
            `file://${badIdFile}`,
            'fake-kinloom-plugin',
            'nonexistent-bare-kinloom-plugin-xyz',
          ],
        })
      ),
      'utf8'
    );

    const discovered = await discoverSiteCliPlugins(siteDir);
    expect(discovered.plugins.map((p) => p.id)).toEqual(['alpha-valid', 'pkg-plugin']);
    expect(discovered.warnings.some((w) => w.includes('gamma-invalid-exports'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('delta-bad-cmds'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('epsilon-bad-audit'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('zeta-bad-verify'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('eta-empty-plugin'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('broken plugin import'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('nonexistent-bare-kinloom-plugin-xyz'))).toBe(true);
    expect(discovered.warnings.some((w) => w.includes('bad-id-plugin.mjs'))).toBe(true);

    // Help formatting for empty vs long command names
    expect(formatPluginCommandsHelp([])).toBe('');
    const renderedHelp = formatPluginCommandsHelp(discovered.plugins);
    expect(renderedHelp).toContain('  very-long-custom-command  Long command summary');
    expect(renderedHelp).toContain('  pkg-cmd            From pkg');
  });
});

describe('pluginAndGuideCommands and cli.ts top-level error/help/guide dispatch', () => {
  it('handles help <builtin>, --guide resolution/fallback/unknown, unknown --help, and unexpected plugin exceptions', async () => {
    const emptyDir = await makeTempDir('kinloom-guide-dispatch-');

    // `kinloom help verify` -> COMMAND_HELP branch
    const helpBuiltin = createCaptureIo();
    expect(await runCli(['help', 'verify'], { cwd: emptyDir, io: helpBuiltin.io })).toBe(EXIT_OK);
    expect(helpBuiltin.stdout.join('\n')).toContain('Usage: kinloom verify');

    // `kinloom pronounce --guide` -> embedded guide exists
    const embeddedGuide = createCaptureIo();
    expect(await runCli(['pronounce', '--guide'], { cwd: emptyDir, io: embeddedGuide.io })).toBe(EXIT_OK);
    expect(embeddedGuide.stdout.join('\n')).toContain('Pronunciation');

    // `kinloom init --guide` -> falls back to COMMAND_HELP when no dedicated embedded guide
    const fallbackGuide = createCaptureIo();
    expect(await runCli(['init', '--guide'], { cwd: emptyDir, io: fallbackGuide.io })).toBe(EXIT_OK);
    expect(fallbackGuide.stdout.join('\n')).toContain('Usage: kinloom init');

    // `kinloom nonexistent-cmd --guide` -> EXIT_USAGE
    const missingGuide = createCaptureIo();
    expect(await runCli(['nonexistent-cmd', '--guide'], { cwd: emptyDir, io: missingGuide.io })).toBe(
      EXIT_USAGE
    );
    expect(missingGuide.stderr.join('\n')).toContain("No embedded guide found for 'nonexistent-cmd'");

    // `kinloom nonexistent-cmd --help` -> EXIT_USAGE
    const missingHelp = createCaptureIo();
    expect(await runCli(['nonexistent-cmd', '--help'], { cwd: emptyDir, io: missingHelp.io })).toBe(
      EXIT_USAGE
    );
    expect(missingHelp.stderr.join('\n')).toContain("Unknown command 'nonexistent-cmd'");

    // Unexpected Error and non-Error thrown by a plugin command -> caught in runCli with EXIT_ERROR
    const crashPlugin: KinloomCliPlugin = {
      id: 'crash-plugin',
      name: 'Crash Plugin',
      commands: [
        {
          name: 'crash-err',
          summary: 'Throw Error',
          help: 'Usage: kinloom crash-err',
          run() {
            throw new Error('boom-from-plugin');
          },
        },
        {
          name: 'crash-str',
          summary: 'Throw string',
          help: 'Usage: kinloom crash-str',
          run() {
            throw 'raw-string-failure';
          },
        },
      ],
    };

    const crashErrCap = createCaptureIo();
    expect(await runCli(['crash-err'], { cwd: emptyDir, io: crashErrCap.io, plugins: [crashPlugin] })).toBe(
      EXIT_ERROR
    );
    expect(crashErrCap.stderr).toEqual(['Error: boom-from-plugin']);

    const crashStrCap = createCaptureIo();
    expect(await runCli(['crash-str'], { cwd: emptyDir, io: crashStrCap.io, plugins: [crashPlugin] })).toBe(
      EXIT_ERROR
    );
    expect(crashStrCap.stderr).toEqual(['Error: raw-string-failure']);
  });
});

describe('commands/seed.ts full entity types, chunked submission, snapshot diffing, and validation', () => {
  it('seeds kinship, media, and narratives in chunks, skips deleted remote rows, and validates inputs', async () => {
    const repoDir = await makeTempDir('kinloom-seed-full-');
    const fixtures = makeRichArchiveFixtures();
    const dataDir = await writeArchiveRepo(repoDir, {
      places: [fixtures.place],
      sources: [fixtures.source],
      people: [fixtures.john, fixtures.jane],
      events: [fixtures.event],
      kinship: [fixtures.kinship],
      media: [fixtures.media],
      narratives: [fixtures.narrative],
    });
    const configPath = path.join(repoDir, 'kinloom.config.yaml');

    // Validation error branches
    await expect(
      runSeedCommand({ dataDir: '  ', configPath, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(CliValidationError);
    await expect(
      runSeedCommand({ dataDir, configPath: '  ', siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(CliValidationError);

    const badConfigPath = path.join(repoDir, 'bad.config.yaml');
    await writeFile(badConfigPath, 'site:\n  title: [unclosed', 'utf8');
    await expect(
      runSeedCommand({ dataDir, configPath: badConfigPath, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/Invalid config/);

    const badDataDir = path.join(repoDir, 'bad-data');
    await mkdir(badDataDir, { recursive: true });
    await writeFile(path.join(badDataDir, 'people.yaml'), '- id: [broken', 'utf8');
    await expect(
      runSeedCommand({ dataDir: badDataDir, configPath, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/Invalid archive YAML/);

    // Non-403/404 snapshot error rethrows
    await expect(
      runSeedCommand({
        dataDir,
        configPath,
        siteUrl: 'https://archive.example.test',
        fetchImpl: async () => new Response('Internal error', { status: 500 }),
      })
    ).rejects.toThrow(KinloomApiError);

    // Invalid chunkSize throws CliValidationError
    await expect(
      runSeedCommand({
        dataDir,
        configPath,
        siteUrl: 'https://archive.example.test',
        chunkSize: 0,
        fetchImpl: async () =>
          new Response(JSON.stringify({ head_revision_id: 0, entities: [], kinship: [] }), { status: 200 }),
      })
    ).rejects.toThrow(/--chunk-size/);

    // Chunked submission (8 entities with chunkSize 3 -> 3 chunks) with remote snapshot containing deleted entity + active/deleted kinship
    const postedBatches: BatchSubmission[] = [];
    const chunkResult = await runSeedCommand({
      dataDir,
      configPath,
      siteUrl: 'https://archive.example.test',
      token: 'tok_seed',
      batchId: 'seed-oakville',
      chunkSize: 3,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/export/snapshot')) {
          return new Response(
            JSON.stringify({
              head_revision_id: 2,
              entities: [
                {
                  entity_type: 'place',
                  entity_id: fixtures.place.id,
                  slug: fixtures.place.slug,
                  data: fixtures.place,
                  current_revision_id: 1,
                  has_primary_source: true,
                  deleted_at: '2026-01-01T00:00:00.000Z',
                  updated_at: '2026-01-01T00:00:00.000Z',
                },
              ],
              kinship: [
                {
                  edge_id: 'kin_deleted',
                  edge: fixtures.kinship,
                  current_revision_id: 1,
                  deleted_at: '2026-01-01T00:00:00.000Z',
                  updated_at: '2026-01-01T00:00:00.000Z',
                },
                {
                  edge_id: 'kin_other_active',
                  edge: fixtures.kinship,
                  current_revision_id: 2,
                  deleted_at: null,
                  updated_at: '2026-01-01T00:00:00.000Z',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        const body = JSON.parse(String(init?.body)) as BatchSubmission;
        postedBatches.push(body);
        return new Response(
          JSON.stringify({
            batch_id: body.batch_id,
            revisions: [],
            head_revision_id: postedBatches.length,
            etag: `"r${postedBatches.length}"`,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } }
        );
      },
    });

    expect(chunkResult.dryRun).toBe(false);
    expect(chunkResult.totalEntities).toBe(8);
    expect(chunkResult.createdCount).toBe(8);
    expect(chunkResult.chunksSubmitted).toBe(3);
    expect(chunkResult.batchId).toBe('seed-oakville');
    expect(postedBatches.map((b) => b.batch_id)).toEqual([
      'seed-oakville-p1',
      'seed-oakville-p2',
      'seed-oakville-p3',
    ]);
    expect(postedBatches[0]!.summary).toContain('(part 1/3)');
    expect(postedBatches[2]!.patches).toHaveLength(2);
  });
});

describe('commands/submitBatch.ts validation branches and dry-run CLI path', () => {
  it('validates envelope, empty update, merge vs full update, delete, restore, and file parse errors', async () => {
    const dir = await makeTempDir('kinloom-submit-edge-');

    // Envelope failure
    expect(() => validateBatchSubmission({ summary: 'missing patches and batch_id' })).toThrow(
      CliValidationError
    );

    // Update with empty data object
    let emptyUpdateErr: unknown;
    try {
      validateBatchSubmission({
        batch_id: 'b_empty_upd',
        summary: 'Empty update payload',
        patches: [{ action: 'update', entity_type: 'person', entity_id: 'per_1', data: {} }],
      });
    } catch (err: unknown) {
      emptyUpdateErr = err;
    }
    expect(emptyUpdateErr).toBeInstanceOf(CliValidationError);
    if (emptyUpdateErr instanceof CliValidationError) {
      expect(emptyUpdateErr.issues[0]).toContain('must contain at least one field');
    }

    // Update with merge: false failing full schema validation
    expect(() =>
      validateBatchSubmission({
        batch_id: 'b_full_upd_bad',
        summary: 'Bad full update',
        patches: [
          {
            action: 'update',
            entity_type: 'person',
            entity_id: 'per_1',
            merge: false,
            data: { id: 'per_1' },
          },
        ],
      })
    ).toThrow(/payload validation error/);

    // Restore with invalid partial data
    expect(() =>
      validateBatchSubmission({
        batch_id: 'b_restore_bad',
        summary: 'Bad restore payload',
        patches: [
          {
            action: 'restore',
            entity_type: 'person',
            entity_id: 'per_1',
            data: { alt_names: 'not-an-array' },
          },
        ],
      })
    ).toThrow(/payload validation error/);

    // Valid batch with delete + restore (with and without data)
    const validBatch = validateBatchSubmission({
      batch_id: 'b_del_restore',
      summary: 'Delete and restore patches',
      patches: [
        { action: 'delete', entity_type: 'source', entity_id: 'src_old' },
        {
          action: 'restore',
          entity_type: 'person',
          entity_id: 'per_john_smith',
          data: { alt_names: ['J. Smith'] },
        },
        { action: 'restore', entity_type: 'place', entity_id: 'plc_oakville' },
      ],
    });
    expect(validBatch.patches).toHaveLength(3);

    // Empty filePath error
    await expect(
      runSubmitBatchCommand({ filePath: '   ', siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/--file/);

    // Empty file, invalid JSON, invalid YAML
    const emptyFile = path.join(dir, 'empty.yaml');
    await writeFile(emptyFile, '   \n', 'utf8');
    await expect(
      runSubmitBatchCommand({ filePath: emptyFile, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/is empty/);

    const badJsonFile = path.join(dir, 'bad.json');
    await writeFile(badJsonFile, '{ not valid json', 'utf8');
    await expect(
      runSubmitBatchCommand({ filePath: badJsonFile, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/Failed to parse JSON/);

    const badYamlFile = path.join(dir, 'bad.yaml');
    await writeFile(badYamlFile, 'patches:\n  - [unclosed', 'utf8');
    await expect(
      runSubmitBatchCommand({ filePath: badYamlFile, siteUrl: 'https://archive.example.test' })
    ).rejects.toThrow(/Failed to parse YAML\/JSON/);

    // Dry-run via CLI using positional file argument (covers coreCommands.ts lines 198-199 + submitBatch.ts dryRun)
    const dryBatchFile = path.join(dir, 'dry.json');
    await writeFile(dryBatchFile, JSON.stringify(validBatch), 'utf8');
    const dryCap = createCaptureIo();
    expect(await runCli(['submit-batch', dryBatchFile, '--dry-run'], { io: dryCap.io })).toBe(EXIT_OK);
    expect(dryCap.stdout).toEqual(['Dry-run OK: batch b_del_restore (3 patch(es)) passed validation.']);
  });
});

describe('commands/uploadMedia.ts MIME detection and metadata parsing', () => {
  it('detects all magic-byte MIME types, falls back to extension, and validates metadata/options', async () => {
    expect(detectMimeType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]), 'a.bin')).toBe('image/jpeg');
    expect(
      detectMimeType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), 'a.bin')
    ).toBe('image/webp');
    expect(detectMimeType(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]), 'a.bin')).toBe('application/pdf');
    expect(
      detectMimeType(
        Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
        'a.bin'
      )
    ).toBe('video/mp4');
    expect(detectMimeType(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 'a.bin')).toBe('video/webm');
    expect(detectMimeType(Uint8Array.from([0x4f, 0x67, 0x67, 0x53]), 'a.bin')).toBe('audio/ogg');
    expect(
      detectMimeType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]), 'a.bin')
    ).toBe('audio/wav');
    expect(detectMimeType(Uint8Array.from([0x49, 0x44, 0x33, 0x04]), 'a.bin')).toBe('audio/mpeg');
    expect(detectMimeType(Uint8Array.from([0x01, 0x02]), 'photo.jpg')).toBe('image/jpeg');
    expect(detectMimeType(Uint8Array.from([0x01, 0x02]), 'unknown.xyz')).toBeNull();

    const dir = await makeTempDir('kinloom-upload-edge-');
    const jpgPath = path.join(dir, 'portrait.jpg');
    await writeFile(jpgPath, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

    // Empty filePath & short summary
    await expect(
      runUploadMediaCommand({
        filePath: '  ',
        metadataInput: '{}',
        summary: 'Valid summary',
        siteUrl: 'https://archive.example.test',
      })
    ).rejects.toThrow(/--file/);
    await expect(
      runUploadMediaCommand({
        filePath: jpgPath,
        metadataInput: '{}',
        summary: 'ab',
        siteUrl: 'https://archive.example.test',
      })
    ).rejects.toThrow(/at least 3 characters/);

    // Empty metadata, invalid JSON, schema failure
    await expect(
      runUploadMediaCommand({
        filePath: jpgPath,
        metadataInput: '  ',
        summary: 'Upload test',
        siteUrl: 'https://archive.example.test',
      })
    ).rejects.toThrow(/--metadata/);
    await expect(
      runUploadMediaCommand({
        filePath: jpgPath,
        metadataInput: '{bad json',
        summary: 'Upload test',
        siteUrl: 'https://archive.example.test',
      })
    ).rejects.toThrow(/Invalid JSON/);
    await expect(
      runUploadMediaCommand({
        filePath: jpgPath,
        metadataInput: JSON.stringify({ kind: 'not_a_real_kind' }),
        summary: 'Upload test',
        siteUrl: 'https://archive.example.test',
      })
    ).rejects.toThrow(/Media metadata failed validation/);

    // Metadata loaded from @file and bare file path
    const metaPath = path.join(dir, 'meta.json');
    await writeFile(
      metaPath,
      JSON.stringify({ id: 'med_oak_1', kind: 'portrait', caption: 'John Smith portrait' }),
      'utf8'
    );
    const atRes = await runUploadMediaCommand({
      filePath: jpgPath,
      metadataInput: `@${metaPath}`,
      summary: 'Dry run via @file',
      siteUrl: 'https://archive.example.test',
      dryRun: true,
    });
    expect(atRes).toEqual({ dryRun: true, fileName: 'portrait.jpg', mimeType: 'image/jpeg', sizeBytes: 6 });

    const bareRes = await runUploadMediaCommand({
      filePath: jpgPath,
      metadataInput: metaPath,
      summary: 'Dry run via path',
      siteUrl: 'https://archive.example.test',
      dryRun: true,
    });
    expect(bareRes).toEqual({ dryRun: true, fileName: 'portrait.jpg', mimeType: 'image/jpeg', sizeBytes: 6 });
  });
});

describe('commands/dataFiles.ts repo loading, sync yamlTexts, and snapshot conversion', () => {
  it('validates missing paths, loads sync yamlTexts/enrichments, rethrows non-ENOENT errors, and converts full snapshots', async () => {
    const dir = await makeTempDir('kinloom-datafiles-');

    // Missing repo directory
    await expect(loadLocalArchiveRepo(path.join(dir, 'nope'))).rejects.toThrow(
      /Repository directory does not exist/
    );

    // Missing data/ directory
    const noDataDir = path.join(dir, 'no-data');
    await mkdir(noDataDir, { recursive: true });
    await expect(loadLocalArchiveRepo(noDataDir)).rejects.toThrow(/Missing data\/ directory/);

    // Missing kinloom.config.yaml
    const noConfigDir = path.join(dir, 'no-config');
    await mkdir(path.join(noConfigDir, 'data'), { recursive: true });
    await expect(loadLocalArchiveRepo(noConfigDir)).rejects.toThrow(/Missing kinloom\.config\.yaml/);

    // requirePeopleFile when people.yaml missing
    await writeFile(
      path.join(noConfigDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(makeSiteConfig()),
      'utf8'
    );
    await expect(loadLocalArchiveRepo(noConfigDir, { requirePeopleFile: true })).rejects.toThrow(
      /people\.yaml/
    );

    // Non-ENOENT error (EISDIR when people.yaml is a directory)
    const dirAsFileRepo = path.join(dir, 'eisdir-data');
    await mkdir(path.join(dirAsFileRepo, 'people.yaml'), { recursive: true });
    await expect(loadArchiveDataDir(dirAsFileRepo)).rejects.toThrow(/EISDIR/);

    // loadLocalArchiveRepoSync with includeYamlTexts and includeEnrichments
    const syncRepo = path.join(dir, 'sync-repo');
    const fixtures = makeRichArchiveFixtures();
    const syncDataDir = await writeArchiveRepo(syncRepo, {
      people: [fixtures.john],
      places: [fixtures.place],
      sources: [fixtures.source],
    });
    await writeFile(path.join(syncDataDir, 'narrative_enrichments.yaml'), '[]\n', 'utf8');

    const loadedSync = loadLocalArchiveRepoSync(syncRepo, {
      includeYamlTexts: true,
      includeEnrichments: true,
    });
    expect(loadedSync.people).toHaveLength(1);
    expect(loadedSync.enrichments).toEqual([]);
    expect(loadedSync.yamlTexts.map((f) => f.name)).toContain('data/people.yaml');
    expect(loadedSync.yamlTexts.map((f) => f.name)).toContain('data/narrative_enrichments.yaml');

    // snapshotToArchiveData covering media, narrative, kinship, deleted skipping, and has_primary_source: false propagation
    const converted = snapshotToArchiveData(fixtures.snapshot);
    expect(converted.places).toHaveLength(1);
    expect(converted.sources).toHaveLength(1);
    expect(converted.people).toHaveLength(2);
    expect(converted.people.find((p) => p.id === 'per_jane_doe')?.has_primary_source).toBe(false);
    expect(converted.events).toHaveLength(1);
    expect(converted.media).toHaveLength(1);
    expect(converted.narratives).toHaveLength(1);
    expect(converted.kinship).toHaveLength(1);
  });
});

describe('commands/brandkit.ts custom SVG marks, ICO edge cases, and validation', () => {
  it('validates inputs, encodes 256px ICO frames, supports custom SVG marks, and rejects invalid SVG/config', async () => {
    expect(() => encodeIcoFromPngs([])).toThrow(RangeError);
    const png256 = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 27, g: 42, b: 65, alpha: 1 } },
    })
      .png()
      .toBuffer();
    const ico256 = encodeIcoFromPngs([{ size: 256, png: png256 }]);
    expect(ico256.readUInt8(6)).toBe(0); // 256 encoded as 0 per ICO spec

    const dir = await makeTempDir('kinloom-brandkit-edge-');
    const outDir = path.join(dir, 'public');

    // Validation errors in runBrandkitCommand
    await expect(runBrandkitCommand({ outDir: '   ', cwd: dir })).rejects.toThrow(/--out/);
    await expect(runBrandkitCommand({ outDir, accent: 'not-hex', cwd: dir })).rejects.toThrow(/--accent/);
    await expect(runBrandkitCommand({ outDir, surface: 'invalid' as 'parchment', cwd: dir })).rejects.toThrow(
      /--surface/
    );

    // CLI --surface validation in coreCommands.ts
    const badSurfCap = createCaptureIo();
    expect(
      await runCli(['brandkit', '--surface', 'slate', '--out', outDir], { io: badSurfCap.io, cwd: dir })
    ).toBe(EXIT_USAGE);
    expect(badSurfCap.stderr.join('\n')).toContain("Option `--surface` must be 'parchment' or 'navy'.");

    // Invalid kinloom.config.yaml
    const badCfg = path.join(dir, 'bad.config.yaml');
    await writeFile(badCfg, 'site:\n  title: [unclosed', 'utf8');
    await expect(runBrandkitCommand({ outDir, configPath: badCfg, cwd: dir })).rejects.toThrow(
      /Invalid kinloom\.config\.yaml/
    );

    // Invalid custom mark SVG
    const badMark = path.join(dir, 'bad-mark.svg');
    await writeFile(badMark, '<div>not an svg</div>', 'utf8');
    await expect(runBrandkitCommand({ outDir, markSvgPath: badMark, cwd: dir })).rejects.toThrow(
      /valid <svg>/
    );

    // Valid custom mark SVG
    const validMark = path.join(dir, 'mark.svg');
    await writeFile(
      validMark,
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="20" fill="currentColor"/></svg>',
      'utf8'
    );
    const customRes = await runBrandkitCommand({ outDir, markSvgPath: validMark, cwd: dir });
    expect(customRes.files).toHaveLength(12);
    const generatedSvg = await readFile(path.join(outDir, 'favicon.svg'), 'utf8');
    expect(generatedSvg).toContain('<circle cx="32" cy="32" r="20" fill="currentColor"/>');
  });
});

describe('syntheticProbeRunner & syntheticProbeParsing edge cases and failure modes', () => {
  it('covers pure parser edge cases and skipped report formatting', () => {
    expect(roundDurationMs(Number.NaN)).toBe(0);
    expect(roundDurationMs(-4)).toBe(0);
    expect(() => normalizeProbeBaseUrl('   ')).toThrow(/Missing required target URL/);
    expect(normalizeProbeBaseUrl('https://archive.example.test/subpath///').pathname).toBe('/subpath');
    expect(parseServerTimingHeader('bad!metric;dur=2, valid_m;dur=3.5').allSpansMs).toEqual({
      valid_m: 3.5,
    });
    expect(discoverFirstMediaPathFromBundle({ media: 'not-an-array' })).toBeNull();
    expect(
      discoverFirstMediaPathFromBundle({
        media: [null, { file: 42 }, { file: 'media/relative.jpg' }],
      })
    ).toBe('/media/relative.jpg');

    const skippedReport: SyntheticProbeReport = {
      ok: true,
      targetUrl: 'https://archive.example.test',
      timestamp: '2026-06-15T12:00:00.000Z',
      durationMs: 12,
      budgets: {
        maxHtmlTtfbMs: 800,
        maxBundleColdMs: 1500,
        maxBundleWarmMs: 400,
        maxMediaRangeMs: 1000,
        require304: false,
        require206: false,
        requireSecurityHeaders: false,
      },
      html: {
        status: 'pass',
        url: 'https://archive.example.test/',
        httpStatus: 200,
        ttfbMs: 5,
        totalMs: 6,
        bytes: 12,
        securityHeaders: { required: [], present: [], missing: [], ok: true },
        violations: [],
      },
      bundle: {
        status: 'pass',
        url: 'https://archive.example.test/api/bundle',
        cold: {
          httpStatus: 200,
          durationMs: 4,
          bytes: 2,
          etag: null,
          cacheControl: null,
          serverTiming: { raw: null, spansMs: {}, allSpansMs: {} },
        },
        warm: {
          status: 'skipped',
          reason: 'Cold /api/bundle response omitted ETag header.',
          httpStatus: null,
          durationMs: null,
          etag: null,
          cacheControl: null,
          serverTiming: { raw: null, spansMs: {}, allSpansMs: {} },
        },
        violations: [],
      },
      mediaRange: {
        status: 'skipped',
        reason: 'No media path provided or discovered in /api/bundle.',
        violations: [],
      },
      violations: [],
    };
    const formatted = formatSyntheticProbeReport(skippedReport);
    expect(formatted).toContain(
      '3. Bundle warm (If-None-Match): SKIPPED | Cold /api/bundle response omitted ETag header.'
    );
    expect(formatted).toContain(
      '4. Media range (206): SKIPPED | No media path provided or discovered in /api/bundle.'
    );
  });

  it('handles HTTP error statuses, missing ETag (required vs skipped), non-relative media path, network throws, and timeout abort', async () => {
    const fixedClock: SyntheticProbeClock = {
      now: () => 100,
      nowIso: () => '2026-06-15T12:00:00.000Z',
    };

    // 1. HTML 500, bundle 503 (no ETag) with require304=true, and non-relative mediaPath skipped
    const reportFail = await runSyntheticProbe({
      targetUrl: 'https://archive.example.test',
      mediaPath: 'https://external.example.test/photo.jpg',
      clock: fixedClock,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/bundle')) {
          return new Response('down', { status: 503 });
        }
        return new Response('error', { status: 500 });
      },
    });
    expect(reportFail.ok).toBe(false);
    expect(reportFail.html.violations[0]).toContain('HTML root returned HTTP 500');
    expect(reportFail.bundle.violations).toContain(
      '/api/bundle cold request returned HTTP 503 (expected 2xx).'
    );
    expect(reportFail.bundle.violations).toContain(
      '/api/bundle cold response omitted ETag header; cannot verify 304 Not Modified.'
    );
    expect(reportFail.bundle.warm.status).toBe('fail');
    expect(reportFail.mediaRange).toEqual({
      status: 'skipped',
      reason: "Ignoring non-relative media path 'https://external.example.test/photo.jpg'.",
      violations: [],
    });

    // 2. Missing ETag with require304=false -> warm skipped; non-JSON bundle 200; media 404 with require206=false
    const reportRelaxed = await runSyntheticProbe({
      targetUrl: 'http://archive.example.test',
      mediaPath: '/media/missing.jpg',
      budgets: { require304: false, require206: false, requireSecurityHeaders: false },
      clock: fixedClock,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/bundle')) {
          return new Response('not-json', { status: 200 });
        }
        if (url.endsWith('/media/missing.jpg')) {
          return new Response('missing', { status: 404 });
        }
        return new Response('<html>ok</html>', { status: 200 });
      },
    });
    expect(reportRelaxed.bundle.warm.status).toBe('skipped');
    expect(reportRelaxed.mediaRange.status).toBe('fail');
    expect(reportRelaxed.mediaRange.violations).toEqual([
      'Media range request returned HTTP 404 (expected 206 or 200).',
    ]);

    // 3. Relaxed require304=false where warm returns 500
    const reportWarm500 = await runSyntheticProbe({
      targetUrl: 'http://archive.example.test',
      budgets: { require304: false, require206: false, requireSecurityHeaders: false },
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers = new Headers(init?.headers);
        if (url.endsWith('/api/bundle')) {
          if (headers.get('if-none-match')) {
            return new Response('err', { status: 500 });
          }
          return new Response('{}', { status: 200, headers: { etag: '"r1"' } });
        }
        return new Response('<html>ok</html>', { status: 200 });
      },
    });
    expect(reportWarm500.bundle.warm.status).toBe('fail');
    expect(reportWarm500.bundle.violations).toContain(
      '/api/bundle conditional request returned HTTP 500 (expected 304 or 200).'
    );

    // 4. Network throws on HTML, bundle cold, bundle warm, and media range
    const reportThrows = await runSyntheticProbe({
      targetUrl: 'http://archive.example.test',
      mediaPath: '/media/test.jpg',
      clock: fixedClock,
      fetchImpl: async () => {
        throw new Error('simulated ECONNREFUSED');
      },
    });
    expect(reportThrows.ok).toBe(false);
    expect(reportThrows.html.error).toBe('simulated ECONNREFUSED');
    expect(reportThrows.bundle.cold.error).toBe('simulated ECONNREFUSED');
    expect(reportThrows.mediaRange.status).toBe('fail');
    if (reportThrows.mediaRange.status !== 'skipped') {
      expect(reportThrows.mediaRange.error).toBe('simulated ECONNREFUSED');
    }

    // 5. Warm throws + fetchWithTimeout aborts via AbortController timer
    const reportWarmThrowAndAbort = await runSyntheticProbe({
      targetUrl: 'http://archive.example.test',
      timeoutMs: 15,
      budgets: { requireSecurityHeaders: false },
      clock: fixedClock,
      fetchImpl: async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        const headers = new Headers(init?.headers);
        if (url.endsWith('/api/bundle')) {
          if (headers.get('if-none-match')) {
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted-by-timeout')));
            });
          }
          return new Response('{}', { status: 200, headers: { etag: '"r2"' } });
        }
        return new Response('<html>ok</html>', { status: 200 });
      },
    });
    expect(reportWarmThrowAndAbort.bundle.warm.status).toBe('fail');
    expect(reportWarmThrowAndAbort.bundle.violations[0]).toContain('aborted-by-timeout');
  });
});

describe('client.ts, exportYaml.ts, reconcile.ts, sliceGedcom.ts, and coreCommands.ts edge paths', () => {
  it('covers KinloomApiClient URL validation, non-JSON/invalid-schema responses, 304, custom headers, and HTTP errors', async () => {
    expect(() => new KinloomApiClient({ baseUrl: 'not-a-url' })).toThrow(/Invalid site URL/);
    expect(() => new KinloomApiClient({ baseUrl: 'ftp://archive.example.test' })).toThrow(
      /Unsupported site URL protocol/
    );

    const serverUrl = await startLocalServer((req, res) => {
      if (req.url === '/api/export/snapshot') {
        if (req.headers['if-none-match'] === '"r8"') {
          res.writeHead(304, { etag: '"r8"' });
          res.end();
          return;
        }
        const fixtures = makeRichArchiveFixtures();
        res.writeHead(200, { 'content-type': 'application/json', etag: '"r8"' });
        res.end(JSON.stringify(fixtures.snapshot));
        return;
      }
      if (req.url === '/api/bundle') {
        if (req.headers['if-none-match'] === '"r8"') {
          res.writeHead(304, { etag: '"r8"' });
          res.end();
          return;
        }
        if (req.headers['x-force-error'] === 'plain') {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Bad Gateway upstream');
          return;
        }
        if (req.headers['x-force-error'] === 'bad-json') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{not json');
          return;
        }
        if (req.headers['x-force-error'] === 'bad-schema') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ wrong: true }));
          return;
        }
      }
      if (req.url === '/api/media/upload') {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new KinloomApiClient({ baseUrl: serverUrl, token: 'tok_client' });

    const snapOk = await client.exportSnapshot();
    expect(snapOk.status).toBe('ok');
    if (snapOk.status === 'ok') {
      expect(snapOk.snapshot.kinship.map((row) => row.edge_id)).toEqual([
        'kin_john_jane',
        'kin_deleted_edge',
      ]);
    }
    const snap304 = await client.exportSnapshot({ ifNoneMatch: '"r8"' });
    expect(snap304).toEqual({ status: 'not_modified', etag: '"r8"' });

    const bundle304 = await client.getBundle({
      ifNoneMatch: '"r8"',
      cacheControl: 'no-cache',
      headers: { 'x-trace': 'synthetic' },
    });
    expect(bundle304).toEqual({ status: 'not_modified', etag: '"r8"' });

    await expect(client.getBundle({ headers: { 'x-force-error': 'plain' } })).rejects.toThrow(
      /Bad Gateway upstream/
    );
    await expect(client.getBundle({ headers: { 'x-force-error': 'bad-json' } })).rejects.toThrow(
      /Server returned invalid JSON/
    );
    await expect(client.getBundle({ headers: { 'x-force-error': 'bad-schema' } })).rejects.toThrow(
      /Unexpected response shape/
    );
    await expect(
      client.uploadMedia({
        fileBytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
        fileName: 'a.png',
        mimeType: 'image/png',
        metadata: { kind: 'portrait' },
        summary: 'Test upload error',
      })
    ).rejects.toThrow(/HTTP 400/);
  });

  it('covers exportYaml, reconcile, sliceGedcom, and coreCommands edge cases', async () => {
    const dir = await makeTempDir('kinloom-core-edges-');

    // exportYaml validation and error paths
    await expect(
      runExportYamlCommand({ siteUrl: 'https://archive.example.test', outDir: '   ' })
    ).rejects.toThrow(/--out/);

    const outDir = path.join(dir, 'export-out');
    await mkdir(outDir, { recursive: true });
    const emptyStateFile = path.join(dir, 'empty.state');
    await writeFile(emptyStateFile, '   \n', 'utf8');

    // Empty state file -> treated as null revision; unsafe filename rejected
    await expect(
      runExportYamlCommand({
        siteUrl: 'https://archive.example.test',
        outDir,
        stateFile: emptyStateFile,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              head_revision_id: 1,
              exported_at: '2026-01-01T00:00:00.000Z',
              files: { '../escape.yaml': '[]\n' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
      })
    ).rejects.toThrow(/Unsafe export filename/);

    // Invalid state file content
    const badStateFile = path.join(dir, 'bad.state');
    await writeFile(badStateFile, 'not-a-number\n', 'utf8');
    await expect(
      runExportYamlCommand({ siteUrl: 'https://archive.example.test', outDir, stateFile: badStateFile })
    ).rejects.toThrow(/Invalid revision state/);

    // Non-ENOENT error on stateFile (directory path)
    const dirStatePath = path.join(dir, 'dir-state');
    await mkdir(dirStatePath, { recursive: true });
    await expect(
      runExportYamlCommand({ siteUrl: 'https://archive.example.test', outDir, stateFile: dirStatePath })
    ).rejects.toThrow(/EISDIR/);

    // Non-404 error from /api/export/yaml rethrows
    await expect(
      runExportYamlCommand({
        siteUrl: 'https://archive.example.test',
        outDir,
        stateFile: emptyStateFile,
        fetchImpl: async () => new Response('Server error', { status: 500 }),
      })
    ).rejects.toThrow(KinloomApiError);

    // /api/export/yaml 404 -> /api/export/snapshot 304
    const validStateFile = path.join(dir, 'valid.state');
    await writeFile(validStateFile, '5\n', 'utf8');
    const fallback304 = await runExportYamlCommand({
      siteUrl: 'https://archive.example.test',
      outDir,
      stateFile: validStateFile,
      fetchImpl: async (input) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/api/export/yaml')) {
          return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not found' } }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(null, { status: 304, headers: { etag: '"r5"' } });
      },
    });
    expect(fallback304).toEqual({
      status: 'not_modified',
      revisionId: 5,
      etag: '"r5"',
      writtenFiles: [],
    });

    // reconcile validation and 304 errors + CLI --mode invalid & --mode public
    await expect(
      runReconcileCommand({ siteUrl: 'https://archive.example.test', configPath: '  ' })
    ).rejects.toThrow(/--config/);

    const badCfgPath = path.join(dir, 'bad-reconcile.yaml');
    await writeFile(badCfgPath, 'site:\n  title: [unclosed', 'utf8');
    await expect(
      runReconcileCommand({ siteUrl: 'https://archive.example.test', configPath: badCfgPath })
    ).rejects.toThrow(/Invalid config/);

    const goodCfgPath = path.join(dir, 'good.config.yaml');
    const siteConfig = makeSiteConfig();
    await writeFile(goodCfgPath, serializeKinloomConfigYaml(siteConfig), 'utf8');

    await expect(
      runReconcileCommand({
        siteUrl: 'https://archive.example.test',
        configPath: goodCfgPath,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/bundle')) {
            return new Response(null, { status: 304 });
          }
          return new Response(JSON.stringify({ head_revision_id: 0, entities: [], kinship: [] }), {
            status: 200,
          });
        },
      })
    ).rejects.toThrow(/Expected 200 OK from GET \/api\/bundle/);

    await expect(
      runReconcileCommand({
        siteUrl: 'https://archive.example.test',
        configPath: goodCfgPath,
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/api/export/snapshot')) {
            return new Response(null, { status: 304 });
          }
          const emptyBundle = compileArchive({
            people: [],
            events: [],
            places: [],
            sources: [],
            kinship: [],
            media: [],
            siteConfig,
            mode: 'public',
            maxRevisionId: 0,
          }).bundle;
          return new Response(JSON.stringify(emptyBundle), { status: 200 });
        },
      })
    ).rejects.toThrow(/Expected 200 OK from GET \/api\/export\/snapshot/);

    const badModeCap = createCaptureIo();
    expect(
      await runCli(
        ['reconcile', '--site', 'https://archive.example.test', '--config', goodCfgPath, '--mode', 'draft'],
        { io: badModeCap.io }
      )
    ).toBe(EXIT_USAGE);
    expect(badModeCap.stderr.join('\n')).toContain("Invalid `--mode` 'draft'");

    // Valid --mode public through runCli
    const publicBundle = compileArchive({
      people: [],
      events: [],
      places: [],
      sources: [],
      kinship: [],
      media: [],
      siteConfig,
      mode: 'public',
      maxRevisionId: 0,
    }).bundle;
    const pubRecCap = createCaptureIo();
    expect(
      await runCli(
        ['reconcile', '--site', 'https://archive.example.test', '--config', goodCfgPath, '--mode', 'public'],
        {
          io: pubRecCap.io,
          fetchImpl: async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.endsWith('/api/bundle')) {
              return new Response(JSON.stringify(publicBundle), { status: 200 });
            }
            return new Response(JSON.stringify({ head_revision_id: 0, entities: [], kinship: [] }), {
              status: 200,
            });
          },
        }
      )
    ).toBe(EXIT_OK);
    expect(pubRecCap.stdout[0]).toContain('(public mode)');

    // init missing positional <dir>
    const initNoDir = createCaptureIo();
    expect(await runCli(['init', '--family', 'Smith', '--title', 'Oakville'], { io: initNoDir.io })).toBe(
      EXIT_USAGE
    );
    expect(initNoDir.stderr.join('\n')).toContain('Missing required positional argument `<dir>`.');

    // slice-gedcom validation errors and anomaly reporting via CLI
    await expect(runSliceGedcomCommand({ inputPath: ' ', outDir, root: '@I1@' })).rejects.toThrow(/--input/);
    await expect(runSliceGedcomCommand({ inputPath: 'file.ged', outDir: ' ', root: '@I1@' })).rejects.toThrow(
      /--out/
    );
    await expect(runSliceGedcomCommand({ inputPath: 'file.ged', outDir, root: ' ' })).rejects.toThrow(
      /--root/
    );

    const anomalyGedPath = path.join(dir, 'anomaly.ged');
    await writeFile(
      anomalyGedPath,
      [
        '0 HEAD',
        '1 GEDC',
        '2 VERS 5.5.1',
        '0 @I1@ INDI',
        '1 NAME John /Smith/',
        '1 SEX M',
        '1 BIRT',
        '2 DATE 1920',
        '1 DEAT',
        '2 DATE 1900',
        '0 TRLR',
      ].join('\n'),
      'utf8'
    );

    // Unknown root throws CliValidationError
    await expect(
      runSliceGedcomCommand({ inputPath: anomalyGedPath, outDir: path.join(dir, 's1'), root: '@I999@' })
    ).rejects.toThrow(CliValidationError);

    // Run via CLI with death-before-birth anomaly (or verify clean CLI output)
    const sliceCap = createCaptureIo();
    expect(
      await runCli(
        ['slice-gedcom', '--input', anomalyGedPath, '--out', path.join(dir, 's2'), '--root', '@I1@'],
        { io: sliceCap.io }
      )
    ).toBe(EXIT_OK);
    expect(sliceCap.stdout[0]).toContain('Sliced GEDCOM from @I1@');
  });
});
