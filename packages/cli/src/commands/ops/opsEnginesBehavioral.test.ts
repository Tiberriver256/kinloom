import fs from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ArchiveBundle,
  compileArchive,
  type EntityPatch,
  type KinloomSiteConfig,
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
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError, KinloomApiError } from '../../errors.js';
import {
  applyPendingYamlWritesWithRollback,
  buildPendingYamlWrites,
  loadArchiveForMediaDedupe,
  scanStagedPackagesForRetiredMedia,
  verifyDeduplicatedArchive,
  writeFileAtomicUtf8,
} from './mediaDedupe/io.js';
import {
  groupDuplicateMediaByFile,
  mergeDuplicateMediaGroup,
  planDuplicateMediaMerges,
} from './mediaDedupe/merge.js';
import { formatMediaDedupeTextReport, renderMediaDedupeResult } from './mediaDedupe/report.js';
import {
  applyMediaReferenceRewrites,
  collectArchiveMediaReferenceCounts,
  rewriteMediaRefsInExtensionsObject,
} from './mediaDedupe/rewrite.js';
import type { MediaDedupeCommandResult, MediaDedupeExtensionRewrite } from './mediaDedupe/types.js';
import {
  executeD1Command,
  executeD1File,
  inspectD1Schema,
  defaultWranglerExecutor as migrateDefaultWranglerExecutor,
} from './migrate/d1Client.js';
import {
  discoverMigrations,
  resolveD1DatabaseBinding,
  resolveWranglerBin as resolveMigrateWranglerBin,
  resolveMigrationsDir,
} from './migrate/discovery.js';
import {
  buildMissingAlterStatements,
  evaluateMigrationStatus,
  parseMigrationSchemaRequirements,
} from './migrate/sqlParser.js';
import type { D1SchemaSnapshot, DiscoveredMigration, MigrateExecContext } from './migrate/types.js';
import { auditBundlePrivacy, compileAndAuditMergedArchive } from './shared/bundlePrivacy.js';
import { inspectImageBuffer } from './shared/imageHeader.js';
import {
  mergeMediaPatch,
  mergeNarrativesPatch,
  mergePlacesPatch,
  mergeSourcesPatch,
} from './shared/integrateEngine/entities.js';
import {
  validatePatchReferentialIntegrity,
  validateRetirementIntegrity,
} from './shared/integrateEngine/integrity.js';
import {
  detectMediaLayout,
  planScanStaging,
  stagePlannedScans,
  validatePatchMedia,
} from './shared/integrateEngine/media.js';
import { applyPeoplePatch, parseValidDeathEdtf } from './shared/integrateEngine/people.js';
import type { IntegrateExecutionOverlay } from './shared/integrateEngine/types.js';
import {
  detectSyncMediaLayout,
  findMissingRemoteMedia,
  resolveMediaUploadTarget,
  uploadMediaTargets,
} from './sync/media.js';
import {
  buildSanitizedLocalEntries,
  computeSyncPlan,
  indexRemoteSnapshot,
  loadLocalArchive,
  normalizeSyncEntityType,
  parseDeleteTargets,
  parseEntityTypeList,
} from './sync/planner.js';
import {
  fetchRemoteSnapshot,
  purgeCompiledBundleAndRecompile,
  submitPatchChunks,
  verifyLiveEndpoints,
} from './sync/remoteClient.js';
import type {
  LocalArchiveFiles,
  RemoteSnapshotResponse,
  SyncExecutionContext,
  WranglerExecutor,
} from './sync/types.js';
import {
  buildTempTokenCleanupSql,
  buildTempTokenInsertSql,
  cleanupTempTokens,
  DEFAULT_BACKUP_TOKEN_LABEL,
  generateTempToken,
  loadWranglerBindings,
  mintTempTokens,
  resolveWranglerBin as resolveSyncWranglerBin,
  defaultWranglerExecutor as syncDefaultWranglerExecutor,
} from './sync/wrangler.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function makeSiteConfig(): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Oakville Historical Archive',
        familyName: 'Doe',
        gedcomSourceName: 'OAKVILLE_ARCHIVE',
        footerCredit: 'Built with Kinloom',
      },
      theme: { accent: '#7A4612' },
      defaultBranchId: 'doe',
      branches: [
        {
          id: 'doe',
          label: 'Doe Line',
          surnames: ['Doe', 'Roe'],
          lineageGroups: ['ancestor', 'descendant', 'extended'],
          supportsDirectMode: true,
        },
      ],
      lineageSections: [],
      featuredKinshipPairs: [],
      migrationEras: [],
      mapDefaults: { centerLat: 40.0, centerLng: -83.0, zoom: 5, minSpanDeg: 1.2 },
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

function makeDeceasedPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_jane_doe',
    slug: 'jane-doe',
    full_name: 'Jane Doe',
    given_name: 'Jane',
    surname: 'Doe',
    alt_names: [],
    sex: 'F',
    is_living: false,
    lineage_group: 'ancestor',
    branch: 'doe',
    birth_edtf: '1850-04-12',
    death_edtf: '1920-08-03',
    portrait_url: null,
    ...overrides,
  };
}

function makeLivingPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_sam_doe',
    slug: 'sam-doe',
    full_name: 'Sam Doe',
    given_name: 'Sam',
    surname: 'Doe',
    alt_names: ['Sammy'],
    sex: 'M',
    is_living: true,
    lineage_group: 'descendant',
    branch: 'doe',
    birth_edtf: '1992-05-14',
    death_edtf: '',
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: 'plc_oakville',
    slug: 'oakville',
    name: 'Oakville',
    full_name: 'Oakville, River County, Ohio, United States',
    place_type: 'town',
    parent_id: null,
    lat: 40.25,
    lng: -82.75,
    ...overrides,
  };
}

function makeSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: 'src_1880_census',
    citation: '1880 U.S. Census, Oakville, River County, Ohio, Sheet 4A',
    source_type: 'census',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'evt_1880_census',
    title: '1880 Federal Census in Oakville',
    scope: 'family',
    event_kind: 'point_event',
    edtf_date: '1880-06-10',
    place_id: 'plc_oakville',
    summary: 'Jane Doe enumerated in Oakville.',
    participants: [{ person_id: 'per_jane_doe', role: 'head' }],
    sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
    ...overrides,
  };
}

function makeMedia(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'med_census_1',
    kind: 'record_scan',
    source_id: 'src_1880_census',
    event_id: 'evt_1880_census',
    person_id: 'per_jane_doe',
    file: '/media/scans/census_1880.jpg',
    caption: '1880 U.S. Census sheet 4A for Oakville',
    ...overrides,
  };
}

function makeNarrative(overrides: Partial<Narrative> = {}): Narrative {
  return {
    id: 'nar_jane_bio',
    slug: 'jane-doe-biography',
    kind: 'biography',
    subject_person_id: 'per_jane_doe',
    title: 'Jane Doe Biography',
    body_md: 'Jane Doe lived in Oakville[^src_1880_census|med_census_1].',
    person_ids: ['per_jane_doe'],
    place_ids: ['plc_oakville'],
    event_ids: ['evt_1880_census'],
    source_ids: ['src_1880_census'],
    ...overrides,
  };
}

function makeCompiledBundle(): ArchiveBundle {
  return compileArchive({
    siteConfig: makeSiteConfig(),
    people: [makeDeceasedPerson(), makeLivingPerson()],
    places: [makePlace()],
    events: [makeEvent()],
    sources: [makeSource()],
    kinship: [],
    media: [makeMedia()],
    narratives: [makeNarrative()],
    mode: 'private',
  }).bundle;
}

function makeSyncContext(
  repoDir: string,
  overrides: Partial<SyncExecutionContext> = {}
): SyncExecutionContext {
  const defaultExec: WranglerExecutor = async () => ({
    stdout: JSON.stringify([{ success: true, results: [] }]),
    stderr: '',
  });
  const defaultFetch: typeof fetch = async () => new Response('{}', { status: 200 });
  return {
    repoDir,
    mediaLayout: 'media',
    bindings: {
      configPath: path.join(repoDir, 'wrangler.jsonc'),
      dbName: 'oakville-archive-db',
      r2Bucket: 'oakville-archive-media',
      domain: 'archive.example.test',
      baseUrl: 'https://archive.example.test',
    },
    wranglerBin: 'wrangler',
    fetchImpl: defaultFetch,
    execWrangler: defaultExec,
    backupTokenLabel: DEFAULT_BACKUP_TOKEN_LABEL,
    ...overrides,
  };
}

describe('shared/imageHeader.ts', () => {
  it('parses PNG, JPEG (APP/RST/SOF0/SOF2/malformed), WebP (VP8X/VP8/VP8L/unknown), GIF, and rejects invalid buffers', () => {
    // Too short
    expect(inspectImageBuffer(Buffer.from([0x89, 0x50, 0x4e]))).toEqual({
      valid: false,
      format: 'unknown',
      width: null,
      height: null,
      error: 'file too short',
    });

    // Truncated PNG IHDR
    const shortPng = Buffer.alloc(20);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(shortPng, 0);
    expect(inspectImageBuffer(shortPng)).toEqual({
      valid: false,
      format: 'png',
      width: null,
      height: null,
      error: 'truncated PNG IHDR',
    });

    // Valid PNG
    const validPng = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(validPng, 0);
    validPng.writeUInt32BE(640, 16);
    validPng.writeUInt32BE(480, 20);
    expect(inspectImageBuffer(validPng)).toEqual({
      valid: true,
      format: 'png',
      width: 640,
      height: 480,
      error: null,
    });

    // JPEG with APP0 segment, non-0xff byte gap, restart marker (0xd0), TEM (0x01), and SOF2 (0xc2)
    const jpegBuf = Buffer.from([
      0xff,
      0xd8, // SOI
      0xff,
      0xe0,
      0x00,
      0x04,
      0x00,
      0x00, // APP0 segLen=4
      0x12, // non-0xff padding byte to exercise inner scan loop
      0xff,
      0xff,
      0xd0, // RST0 (standalone marker, no length)
      0xff,
      0x01, // TEM (standalone marker)
      0xff,
      0xc2,
      0x00,
      0x0b,
      0x08, // SOF2 segLen=11, precision=8
      0x01,
      0x2c, // height = 300
      0x01,
      0x90, // width = 400
      0x03,
      0x01,
      0x11,
      0x00,
      0xff,
      0xd9, // EOI
    ]);
    expect(inspectImageBuffer(jpegBuf)).toEqual({
      valid: true,
      format: 'jpeg',
      width: 400,
      height: 300,
      error: null,
    });

    // JPEG hitting SOS (0xda) before any SOF
    const jpegSosOnly = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]);
    expect(inspectImageBuffer(jpegSosOnly)).toEqual({
      valid: true,
      format: 'jpeg',
      width: null,
      height: null,
      error: null,
    });

    // JPEG with invalid segLen < 2
    const jpegBadSegLen = Buffer.from([
      0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(inspectImageBuffer(jpegBadSegLen)).toEqual({
      valid: true,
      format: 'jpeg',
      width: null,
      height: null,
      error: null,
    });

    // JPEG ending with trailing 0xff padding and truncated marker length
    const jpegTrailingFf = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);
    expect(inspectImageBuffer(jpegTrailingFf)).toEqual({
      valid: true,
      format: 'jpeg',
      width: null,
      height: null,
      error: null,
    });

    const jpegTruncatedLen = Buffer.from([
      0xff, 0xd8, 0xff, 0xd0, 0xff, 0xd1, 0xff, 0xd2, 0xff, 0xd3, 0xff, 0xe0, 0x00,
    ]);
    expect(inspectImageBuffer(jpegTruncatedLen)).toEqual({
      valid: true,
      format: 'jpeg',
      width: null,
      height: null,
      error: null,
    });

    // WebP VP8X (1024 x 768 -> stored as width-1=1023, height-1=767)
    const vp8x = Buffer.alloc(30);
    vp8x.write('RIFF', 0, 'ascii');
    vp8x.write('WEBP', 8, 'ascii');
    vp8x.write('VP8X', 12, 'ascii');
    const wMinus1 = 1024 - 1;
    const hMinus1 = 768 - 1;
    vp8x[24] = wMinus1 & 0xff;
    vp8x[25] = (wMinus1 >> 8) & 0xff;
    vp8x[26] = (wMinus1 >> 16) & 0xff;
    vp8x[27] = hMinus1 & 0xff;
    vp8x[28] = (hMinus1 >> 8) & 0xff;
    vp8x[29] = (hMinus1 >> 16) & 0xff;
    expect(inspectImageBuffer(vp8x)).toEqual({
      valid: true,
      format: 'webp',
      width: 1024,
      height: 768,
      error: null,
    });

    // WebP VP8 lossy
    const vp8 = Buffer.alloc(30);
    vp8.write('RIFF', 0, 'ascii');
    vp8.write('WEBP', 8, 'ascii');
    vp8.write('VP8 ', 12, 'ascii');
    vp8.writeUInt16LE(800 | 0x4000, 26);
    vp8.writeUInt16LE(600, 28);
    expect(inspectImageBuffer(vp8)).toEqual({
      valid: true,
      format: 'webp',
      width: 800,
      height: 600,
      error: null,
    });

    // WebP VP8L lossless
    const vp8l = Buffer.alloc(25);
    vp8l.write('RIFF', 0, 'ascii');
    vp8l.write('WEBP', 8, 'ascii');
    vp8l.write('VP8L', 12, 'ascii');
    const packed = ((320 - 1) & 0x3fff) | (((240 - 1) & 0x3fff) << 14);
    vp8l.writeUInt32LE(packed >>> 0, 21);
    expect(inspectImageBuffer(vp8l)).toEqual({
      valid: true,
      format: 'webp',
      width: 320,
      height: 240,
      error: null,
    });

    // WebP unknown chunk
    const webpOther = Buffer.alloc(20);
    webpOther.write('RIFF', 0, 'ascii');
    webpOther.write('WEBP', 8, 'ascii');
    webpOther.write('ANIM', 12, 'ascii');
    expect(inspectImageBuffer(webpOther)).toEqual({
      valid: true,
      format: 'webp',
      width: null,
      height: null,
      error: null,
    });

    // GIF89a & GIF87a
    const gif89 = Buffer.alloc(12);
    gif89.write('GIF89a', 0, 'ascii');
    gif89.writeUInt16LE(128, 6);
    gif89.writeUInt16LE(64, 8);
    expect(inspectImageBuffer(gif89)).toEqual({
      valid: true,
      format: 'gif',
      width: 128,
      height: 64,
      error: null,
    });

    const gif87 = Buffer.alloc(12);
    gif87.write('GIF87a', 0, 'ascii');
    gif87.writeUInt16LE(16, 6);
    gif87.writeUInt16LE(32, 8);
    expect(inspectImageBuffer(gif87)).toEqual({
      valid: true,
      format: 'gif',
      width: 16,
      height: 32,
      error: null,
    });

    // Unknown header
    expect(inspectImageBuffer(Buffer.from('NOT_AN_IMAGE_HEADER_1234'))).toEqual({
      valid: false,
      format: 'unknown',
      width: null,
      height: null,
      error: 'unrecognized image magic header',
    });
  });
});

describe('migrate/sqlParser.ts', () => {
  it('parses quoted identifiers, comments, escaped quotes, trailing statements, and evaluates status', () => {
    const sql = [
      '/* leading block comment with ; and -- */',
      'CREATE TEMP TABLE IF NOT EXISTS "audit_log" (',
      "  note TEXT DEFAULT 'it''s; -- not a comment /* still text */',",
      '  "quoted;col" TEXT',
      ');',
      '-- line comment with CREATE TABLE ignored (id TEXT);',
      'CREATE UNIQUE INDEX IF NOT EXISTS `idx_audit_log` ON "audit_log" ("quoted;col");',
      'ALTER TABLE [audit_log] ADD COLUMN [source_ref] TEXT;',
      "INSERT INTO \"audit_log\" (note) VALUES ('semi;colon''quoted') -- trailing comment without semicolon",
    ].join('\n');

    const reqs = parseMigrationSchemaRequirements(sql, 2);
    expect(reqs.createdTables).toEqual(['audit_log']);
    expect(reqs.createdIndexes).toEqual(['idx_audit_log']);
    expect(reqs.addedColumns).toEqual([
      {
        table: 'audit_log',
        column: 'source_ref',
        statement: 'ALTER TABLE [audit_log] ADD COLUMN [source_ref] TEXT;',
      },
    ]);
    expect(reqs.isInitialSchema).toBe(false);
    expect(reqs.onlyAlterAddColumns).toBe(false);

    // Initial schema migration missing revisions reports each missing table
    const initialMig: DiscoveredMigration = {
      id: '0001_initial.sql',
      number: 1,
      filePath: '/tmp/0001_initial.sql',
      sql: 'CREATE TABLE revisions (id INT); CREATE TABLE entities (id TEXT);',
      requirements: parseMigrationSchemaRequirements(
        'CREATE TABLE revisions (id INT); CREATE TABLE entities (id TEXT);',
        1
      ),
    };
    const emptySnapshot: D1SchemaSnapshot = {
      tables: new Set(['entities']),
      indexes: new Set(),
      columnsByTable: new Map(),
      trackedMigrations: new Set(),
    };
    expect(evaluateMigrationStatus(initialMig, emptySnapshot)).toEqual({
      id: '0001_initial.sql',
      number: 1,
      filePath: '/tmp/0001_initial.sql',
      status: 'pending',
      satisfiedBy: 'pending',
      missingObjects: ['table:revisions'],
    });

    // Data-only migration with no DDL assertions falls back to d1_migrations tracking
    const dataOnlyMig: DiscoveredMigration = {
      id: '0005_backfill.sql',
      number: 5,
      filePath: '/tmp/0005_backfill.sql',
      sql: "UPDATE entities SET slug = 'oakville' WHERE slug IS NULL",
      requirements: parseMigrationSchemaRequirements(
        "UPDATE entities SET slug = 'oakville' WHERE slug IS NULL",
        5
      ),
    };
    expect(evaluateMigrationStatus(dataOnlyMig, emptySnapshot)).toEqual({
      id: '0005_backfill.sql',
      number: 5,
      filePath: '/tmp/0005_backfill.sql',
      status: 'pending',
      satisfiedBy: 'pending',
      missingObjects: ['migration:0005_backfill.sql'],
    });

    const trackedSnapshot: D1SchemaSnapshot = {
      ...emptySnapshot,
      trackedMigrations: new Set(['0005_backfill.sql']),
    };
    expect(evaluateMigrationStatus(dataOnlyMig, trackedSnapshot).satisfiedBy).toBe('d1_migrations');
    expect(
      evaluateMigrationStatus(dataOnlyMig, trackedSnapshot, new Set(['0005_backfill.sql'])).satisfiedBy
    ).toBe('applied_now');

    // buildMissingAlterStatements returns null when not alter-only or when 0 columns exist
    expect(buildMissingAlterStatements(dataOnlyMig, emptySnapshot)).toBeNull();
    const alterOnlyMig: DiscoveredMigration = {
      id: '0006_cols.sql',
      number: 6,
      filePath: '/tmp/0006_cols.sql',
      sql: 'ALTER TABLE people ADD col_a TEXT; ALTER TABLE people ADD col_b TEXT;',
      requirements: parseMigrationSchemaRequirements(
        'ALTER TABLE people ADD col_a TEXT; ALTER TABLE people ADD col_b TEXT;',
        6
      ),
    };
    expect(buildMissingAlterStatements(alterOnlyMig, emptySnapshot)).toBeNull();
    const partialSnapshot: D1SchemaSnapshot = {
      tables: new Set(['people']),
      indexes: new Set(),
      columnsByTable: new Map([['people', new Set(['col_a'])]]),
      trackedMigrations: new Set(),
    };
    expect(buildMissingAlterStatements(alterOnlyMig, partialSnapshot)).toEqual([
      'ALTER TABLE people ADD col_b TEXT;',
    ]);
  });
});

describe('migrate/discovery.ts and migrate/d1Client.ts', () => {
  it('validates wrangler bindings, TOML hints, migrations dir discovery, and wrangler bin lookup', async () => {
    const emptyRepo = await makeTempDir('kinloom-disc-empty-');
    expect(() => resolveD1DatabaseBinding(emptyRepo)).toThrow(CliValidationError);

    // Invalid JSONC and non-object JSON
    const badJsonRepo = await makeTempDir('kinloom-disc-badjson-');
    await writeFile(path.join(badJsonRepo, 'wrangler.jsonc'), '{ not valid json', 'utf8');
    expect(() => resolveD1DatabaseBinding(badJsonRepo)).toThrow(/Failed to parse/);

    const arrayJsonRepo = await makeTempDir('kinloom-disc-arr-');
    await writeFile(path.join(arrayJsonRepo, 'wrangler.json'), '[]', 'utf8');
    expect(() => resolveD1DatabaseBinding(arrayJsonRepo)).toThrow(/Expected a JSON object/);

    const missingDbJsonRepo = await makeTempDir('kinloom-disc-nodb-');
    await writeFile(path.join(missingDbJsonRepo, 'wrangler.json'), JSON.stringify({ d1_databases: [{}] }));
    expect(() => resolveD1DatabaseBinding(missingDbJsonRepo)).toThrow(/database_name/);

    // TOML missing database_name
    const missingDbTomlRepo = await makeTempDir('kinloom-disc-toml-nodb-');
    await writeFile(path.join(missingDbTomlRepo, 'wrangler.toml'), '[[d1_databases]]\nbinding = "DB"\n');
    expect(() => resolveD1DatabaseBinding(missingDbTomlRepo)).toThrow(/database_name/);

    // TOML with migrations_dir hint + second [[d1_databases]] block ignored once first has dbName
    const tomlHintRepo = await makeTempDir('kinloom-disc-toml-hint-');
    const customMigs = path.join(tomlHintRepo, 'db', 'migs');
    await mkdir(customMigs, { recursive: true });
    await writeFile(path.join(customMigs, '0002_beta.sql'), 'CREATE TABLE b (id INT);', 'utf8');
    await writeFile(path.join(customMigs, '0002_alpha.sql'), 'CREATE TABLE a (id INT);', 'utf8');
    await writeFile(path.join(customMigs, 'README.md'), 'ignored', 'utf8');
    await mkdir(path.join(customMigs, '0003_dir.sql'), { recursive: true });
    await writeFile(
      path.join(tomlHintRepo, 'wrangler.toml'),
      [
        'name = "oakville"',
        '',
        '[[d1_databases]]',
        'binding = "DB"',
        "database_name = 'oakville-primary-db'",
        "migrations_dir = 'db/migs'",
        '',
        '[[d1_databases]]',
        'database_name = "second-db-ignored"',
      ].join('\n'),
      'utf8'
    );

    const binding = resolveD1DatabaseBinding(tomlHintRepo);
    expect(binding.dbName).toBe('oakville-primary-db');
    expect(binding.migrationsDirHint).toBe('db/migs');

    // resolveMigrationsDir uses hint and throws on empty explicit dir
    expect(resolveMigrationsDir(tomlHintRepo, undefined, binding.migrationsDirHint)).toBe(customMigs);
    expect(() => resolveMigrationsDir(tomlHintRepo, 'does-not-exist')).toThrow(CliValidationError);

    // discoverMigrations sorts equal numbers by id, ignores non-sql and directories
    const discovered = discoverMigrations(customMigs);
    expect(discovered.map((m) => m.id)).toEqual(['0002_alpha.sql', '0002_beta.sql']);

    expect(() => discoverMigrations(path.join(tomlHintRepo, 'missing-dir'))).toThrow(CliValidationError);
    const noSqlDir = path.join(tomlHintRepo, 'no-sql');
    await mkdir(noSqlDir, { recursive: true });
    await writeFile(path.join(noSqlDir, 'notes.txt'), 'none', 'utf8');
    expect(() => discoverMigrations(noSqlDir)).toThrow(CliValidationError);

    // resolveWranglerBin explicit, local bin, fallback
    expect(resolveMigrateWranglerBin(tomlHintRepo, '  /custom/wrangler  ')).toBe('/custom/wrangler');
    expect(resolveMigrateWranglerBin(tomlHintRepo)).toBe('wrangler');
    const localBin = path.join(tomlHintRepo, 'node_modules', '.bin', 'wrangler');
    await mkdir(path.dirname(localBin), { recursive: true });
    await writeFile(localBin, '#!/bin/sh\n', 'utf8');
    expect(resolveMigrateWranglerBin(tomlHintRepo)).toBe(localBin);
  });

  it('executes migrate defaultWranglerExecutor, validates D1 output errors, and inspects multi-table schema with d1_migrations', async () => {
    const repoDir = await makeTempDir('kinloom-d1client-');

    // defaultWranglerExecutor real subprocess call using Node itself
    const execRes = await migrateDefaultWranglerExecutor(
      process.execPath,
      ['-e', "process.stdout.write('ok-out'); process.stderr.write('ok-err');"],
      { cwd: repoDir, maxBufferBytes: 1024 * 1024, timeoutMs: 10_000 }
    );
    expect(execRes).toEqual({ stdout: 'ok-out', stderr: 'ok-err' });

    const baseCtx: MigrateExecContext = {
      repoDir,
      binding: {
        configPath: path.join(repoDir, 'wrangler.jsonc'),
        dbName: 'oakville-db',
      },
      target: 'local',
      wranglerBin: 'wrangler',
      execWrangler: async () => ({ stdout: 'no json here', stderr: '' }),
    };

    await expect(executeD1Command(baseCtx, 'SELECT 1;')).rejects.toThrow(/Unexpected wrangler D1 output/);

    const emptyArrCtx: MigrateExecContext = {
      ...baseCtx,
      execWrangler: async () => ({ stdout: '[]', stderr: '' }),
    };
    await expect(executeD1Command(emptyArrCtx, 'SELECT 1;')).rejects.toThrow(/Empty wrangler D1 response/);

    const failedStmtCtx: MigrateExecContext = {
      ...baseCtx,
      execWrangler: async () => ({ stdout: JSON.stringify([{ success: false }]), stderr: '' }),
    };
    await expect(executeD1File(failedStmtCtx, '/tmp/0001.sql')).rejects.toThrow(/D1 statement failed/);

    // inspectD1Schema queries sqlite_master (with empty names + indexes), d1_migrations, and sorted PRAGMA table_info
    const recordedSql: string[] = [];
    const schemaCtx: MigrateExecContext = {
      ...baseCtx,
      execWrangler: async (_bin, args) => {
        const cmd = args[args.indexOf('--command') + 1] ?? '';
        recordedSql.push(cmd);
        if (cmd.includes('sqlite_master')) {
          return {
            stdout: JSON.stringify([
              {
                success: true,
                results: [
                  { type: 'table', name: '' },
                  { type: 'table', name: 'd1_migrations' },
                  { type: 'table', name: 'zeta_table' },
                  { type: 'table', name: 'alpha_table' },
                  { type: 'index', name: 'idx_alpha' },
                ],
              },
            ]),
            stderr: '',
          };
        }
        if (cmd.includes('d1_migrations')) {
          return {
            stdout: JSON.stringify([
              { success: true, results: [{ name: '0001_initial.sql' }, { name: '  ' }] },
            ]),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify([
            { success: true, results: [{ name: 'col_a' }] },
            { success: true, results: [{ name: 'col_z' }] },
          ]),
          stderr: '',
        };
      },
    };

    const migrations: DiscoveredMigration[] = [
      {
        id: '0002_multi.sql',
        number: 2,
        filePath: '/tmp/0002_multi.sql',
        sql: 'ALTER TABLE zeta_table ADD col_z TEXT; ALTER TABLE alpha_table ADD col_a TEXT;',
        requirements: parseMigrationSchemaRequirements(
          'ALTER TABLE zeta_table ADD col_z TEXT; ALTER TABLE alpha_table ADD col_a TEXT;',
          2
        ),
      },
    ];

    const snap = await inspectD1Schema(schemaCtx, migrations);
    expect(snap.tables).toEqual(new Set(['d1_migrations', 'zeta_table', 'alpha_table']));
    expect(snap.indexes).toEqual(new Set(['idx_alpha']));
    expect(snap.trackedMigrations).toEqual(new Set(['0001_initial.sql']));
    expect(snap.columnsByTable.get('alpha_table')).toEqual(new Set(['col_a']));
    expect(snap.columnsByTable.get('zeta_table')).toEqual(new Set(['col_z']));
    expect(recordedSql[2]).toBe('PRAGMA table_info(alpha_table); PRAGMA table_info(zeta_table);');
  });
});

describe('shared/bundlePrivacy.ts', () => {
  it('detects every public and private living-person privacy leak and audits clean archives', () => {
    const baseBundle = makeCompiledBundle();

    // Construct a leaky bundle for public mode
    const leakyPublic: ArchiveBundle = {
      ...structuredClone(baseBundle),
      people: [
        {
          ...baseBundle.people.find((p) => p.id === 'per_sam_doe')!,
          full_name: 'Sam Doe',
          birth_edtf: '1992-05-14',
          alt_names: ['Sammy'],
          primary_place_id: 'plc_oakville',
          portrait_url: '/media/sam.jpg',
          media_count: 2,
        },
      ],
      events: [
        {
          ...baseBundle.events[0],
          id: 'evt_living',
          edtf_date: '2010-06-01',
          place_id: 'plc_oakville',
          photo_url: '/media/living_evt.jpg',
          participants: [{ person_id: 'per_sam_doe', role: 'subject' }],
        },
      ],
      residence_spans: [
        {
          id: 'res_living',
          person_id: 'per_sam_doe',
          place_id: 'plc_oakville',
          time_min: 2000,
          time_max: 2010,
          start_year: 2000,
          end_year: 2010,
          confidence_tier: 'Confirmed',
          from_event_id: 'evt_living',
          to_event_id: 'evt_living',
        },
      ],
      media: [
        {
          id: 'med_living_direct',
          kind: 'family_photo',
          person_id: 'per_sam_doe',
          file: '/media/sam.jpg',
          caption: 'Sam photo',
        },
        {
          id: 'med_living_event',
          kind: 'family_photo',
          event_id: 'evt_living',
          file: '/media/evt.jpg',
          caption: 'Living event photo',
        },
      ],
      narratives: [
        {
          id: 'nar_living',
          slug: 'sam-bio',
          kind: 'biography',
          subject_person_id: 'per_sam_doe',
          title: 'Sam Bio',
          body_md: 'Draft bio.',
          person_ids: ['per_sam_doe'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
    };

    const publicLeaks = auditBundlePrivacy(leakyPublic, 'public');
    expect(publicLeaks).toEqual([
      'public:person:per_sam_doe:full_name',
      'public:person:per_sam_doe:birth_edtf',
      'public:person:per_sam_doe:alt_names',
      'public:person:per_sam_doe:primary_place_id',
      'public:person:per_sam_doe:portrait',
      'public:person:per_sam_doe:media_count=2',
      'public:event:evt_living:place_id',
      'public:event:evt_living:photo_url',
      'public:residence_span:res_living',
      'public:media:med_living_direct',
      'public:media:med_living_event',
      'public:narrative:nar_living:subject_person_id',
      'public:narrative:nar_living',
    ]);

    const privateLeaks = auditBundlePrivacy(leakyPublic, 'private');
    expect(privateLeaks).toContain('private:person:per_sam_doe:birth_edtf=1992-05-14');
    expect(privateLeaks).toContain('private:event:evt_living:edtf_date=2010-06-01');
    expect(privateLeaks).toContain('private:event:evt_living:place_id');
    expect(privateLeaks).toContain('private:event:evt_living:photo_url');

    // Clean archive passes compileAndAuditMergedArchive with 0 leaks
    const audited = compileAndAuditMergedArchive({
      siteConfig: makeSiteConfig(),
      people: [makeDeceasedPerson(), makeLivingPerson()],
      places: [makePlace()],
      events: [makeEvent()],
      sources: [makeSource()],
      kinship: [],
      media: [makeMedia()],
      narratives: [makeNarrative()],
    });
    expect(audited.livingLeaks).toBe(0);
    expect(audited.publicResult.bundle.people.find((p) => p.id === 'per_sam_doe')?.full_name).toBe('Living');
  });
});

describe('shared/integrateEngine/people.ts', () => {
  it('handles person_updates merges, extension source deduplication, slug updates, and rejects conflicts', () => {
    const privacy = { livingCutoffYears: 101, referenceYear: 2026 };
    const jane = makeDeceasedPerson({
      alt_names: ['Janie Doe'],
      extensions: {
        sources: ['src_a', { source_id: 'src_b', page: '1' }, { custom: 1 }],
      },
    });
    const john = makeDeceasedPerson({
      id: 'per_john_doe',
      slug: 'john-doe',
      full_name: 'John Doe',
      given_name: 'John',
      sex: 'M',
    });

    expect(parseValidDeathEdtf('1920-08-03')).toBe('1920-08-03');
    expect(parseValidDeathEdtf('invalid/date/range')).toBeNull();
    expect(parseValidDeathEdtf(null)).toBeNull();

    // Rich merge of bio, summary, research_notes, alt_names, extensions.sources + top-level sources, and slug update
    const merged = applyPeoplePatch(
      [jane, john],
      {
        people: [],
        person_updates: {
          slug: 'jane-doe-oakville',
          bio: 'Settled in Oakville.',
          summary: 'Pioneer resident.',
          research_notes: 'Check 1890 tax list.',
          alt_names: ['Janie Doe', 'Jane Roe'],
          extensions: {
            custom_flag: true,
            sources: [
              null,
              ' src_a ',
              { source_id: 'src_b', page: '2' },
              { source_id: 'src_c', page: '3' },
              { custom: 1 },
              { custom: 2 },
            ],
          },
          sources: ['src_d', { source_id: 'src_c' }],
        },
      },
      'per_jane_doe',
      '/tmp/data',
      privacy
    );

    expect(merged.personUpdated).toBe(true);
    const updatedJane = merged.peopleById.get('per_jane_doe')!;
    expect(updatedJane.slug).toBe('jane-doe-oakville');
    expect(updatedJane.alt_names).toEqual(['Janie Doe', 'Jane Roe']);
    expect(updatedJane.extensions).toEqual({
      custom_flag: true,
      biography: 'Settled in Oakville.',
      summary: 'Pioneer resident.',
      research_notes: 'Check 1890 tax list.',
      sources: [
        'src_a',
        { source_id: 'src_b', page: '1' },
        { custom: 1 },
        { source_id: 'src_c', page: '3' },
        { custom: 2 },
        'src_d',
      ],
    });

    // Rejects conflicting fields and invalid updates
    const invalidCases: Array<[Record<string, unknown>, RegExp]> = [
      [{ id: 'per_other' }, /cannot change person id/],
      [{ is_living: true }, /cannot mark target/],
      [{ living: true }, /cannot mark target/],
      [{ birth_edtf: '1850', birth_date: '1851' }, /conflicting birth_edtf and birth_date/],
      [{ death_edtf: '1920', death_date: '1921' }, /conflicting death_edtf and death_date/],
      [{ bio: 'A', biography: 'B' }, /conflicting bio and biography/],
      [{ alt_names: 'not-array' }, /alt_names must be an array/],
      [{ extensions: 'not-object' }, /extensions must be an object/],
      [{ sources: 'not-array' }, /sources must be an array/],
      [{ slug: 'BAD SLUG!' }, /invalid slug/],
      [{ slug: 'john-doe' }, /Slug collision/],
      [{ birth_edtf: '2000-01-01', death_edtf: '' }, /resolves as living/],
    ];

    for (const [updates, pattern] of invalidCases) {
      expect(() =>
        applyPeoplePatch(
          [jane, john],
          { people: [], person_updates: updates },
          'per_jane_doe',
          '/tmp/data',
          privacy
        )
      ).toThrow(pattern);
    }

    // Missing target person throws
    expect(() =>
      applyPeoplePatch([jane], { people: [], person_updates: null }, 'per_missing', '/tmp/data', privacy)
    ).toThrow(/does not exist/);
  });

  it('validates and merges patch.people entries including extensions.sources and slug collisions', () => {
    const privacy = { livingCutoffYears: 101, referenceYear: 2026 };
    const jane = makeDeceasedPerson({
      extensions: { sources: ['src_existing'], note: 'keep' },
    });
    const john = makeDeceasedPerson({
      id: 'per_john_doe',
      slug: 'john-doe',
      full_name: 'John Doe',
      given_name: 'John',
      sex: 'M',
    });
    const sam = makeLivingPerson();

    // Update existing person via patch.people with new slug and merged extensions.sources
    const res = applyPeoplePatch(
      [jane, john, sam],
      {
        people: [
          {
            ...jane,
            slug: 'jane-doe-updated',
            extensions: {
              sources: ['src_existing', 'src_new'],
              added_key: 'yes',
            },
          },
        ],
        person_updates: null,
      },
      'per_jane_doe',
      '/tmp/data',
      privacy
    );
    expect(res.peopleCounts).toEqual({ added: 0, updated: 1, unchanged: 0 });
    expect(res.peopleById.get('per_jane_doe')?.slug).toBe('jane-doe-updated');
    expect(res.peopleById.get('per_jane_doe')?.extensions).toEqual({
      sources: ['src_existing', 'src_new'],
      note: 'keep',
      added_key: 'yes',
    });

    // Validation errors in patch.people
    expect(() =>
      applyPeoplePatch(
        [jane],
        { people: ['not-an-object'], person_updates: null },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(CliValidationError);

    expect(() =>
      applyPeoplePatch(
        [jane],
        { people: [{ id: 'bad id!', slug: 'bad', full_name: 'Bad' }], person_updates: null },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(/invalid id/);

    expect(() =>
      applyPeoplePatch(
        [jane],
        {
          people: [{ ...jane, id: 'per_new_bad', slug: 'new-bad', full_name: 123 }],
          person_updates: null,
        },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(/Invalid person in patch\.people\[0\]/);

    expect(() =>
      applyPeoplePatch(
        [jane],
        {
          people: [{ ...jane, id: 'per_empty_name', slug: 'empty-name', full_name: '   ' }],
          person_updates: null,
        },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(/non-empty full_name/);

    expect(() =>
      applyPeoplePatch(
        [jane],
        {
          people: [{ ...jane, id: 'per_bad_slug', slug: 'Bad Slug' }],
          person_updates: null,
        },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(/invalid slug/);

    // Slug collision when updating existing person
    expect(() =>
      applyPeoplePatch(
        [jane, john],
        {
          people: [{ ...jane, slug: 'john-doe' }],
          person_updates: null,
        },
        'per_jane_doe',
        '/tmp',
        privacy
      )
    ).toThrow(/Slug collision/);
  });
});

describe('shared/integrateEngine/entities.ts, integrity.ts, and media.ts', () => {
  it('merges places, sources, media, and narratives while enforcing coordinate and removal invariants', () => {
    // Place coordinate validation errors
    expect(() => mergePlacesPatch([], ['not-an-object'])).toThrow(/must be an object/);
    expect(() => mergePlacesPatch([], [{ id: 'plc_x', lat: 40 }])).toThrow(/missing coordinates/);
    expect(() => mergePlacesPatch([], [{ id: 'plc_x', lat: 40, lng: -80, lon: -81 }])).toThrow(
      /conflicting lng/
    );
    expect(() => mergePlacesPatch([], [{ id: 'plc_x', lat: 'nan', lng: -80 }])).toThrow(
      /non-finite coordinates/
    );
    expect(() => mergePlacesPatch([], [{ id: 'plc_x', lat: 95, lng: -80 }])).toThrow(/out of range/);
    expect(() => mergePlacesPatch([], [{ id: 'plc_x', lat: 0, lng: 0 }])).toThrow(/forbidden \(0, 0\)/);

    // Place update merges pronunciation, has_primary_source, sources, and extensions
    const existingPlace = makePlace({
      pronunciation: { ipa: 'ˈoʊkvɪl', phonetic: 'OHK-vil' },
      has_primary_source: true,
      sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      extensions: { county_fips: '39001' },
    });
    const mergedPlaces = mergePlacesPatch(
      [existingPlace],
      [
        {
          ...makePlace({ name: 'Oakville Village' }),
          lon: -82.75,
          lng: undefined,
          pronunciation: { ipa: 'ˈoʊk.vɪl', phonetic: 'OHK-vil' },
          extensions: { settled_year: 1835 },
        },
      ]
    );
    expect(mergedPlaces.counts).toEqual({ added: 0, updated: 1, unchanged: 0 });
    expect(mergedPlaces.items[0].has_primary_source).toBe(true);
    expect(mergedPlaces.items[0].sources).toEqual([{ source_id: 'src_1880_census', confidence: 'high' }]);
    expect(mergedPlaces.items[0].extensions).toEqual({ county_fips: '39001', settled_year: 1835 });

    // Source update preserves optional metadata and rejects simultaneous add+remove
    const existingSource = makeSource({
      has_primary_source: true,
      author: 'County Clerk',
      publisher: 'River County Press',
      repository: 'Oakville Archive',
      url: 'https://archive.example.test/census/1880',
      gedcom_xref: '@S1@',
    });
    const mergedSources = mergeSourcesPatch(
      [existingSource],
      [
        {
          id: 'src_1880_census',
          citation: '1880 U.S. Census, Oakville, Sheet 4A (revised)',
          source_type: 'census',
        },
      ],
      []
    );
    expect(mergedSources.items[0]).toMatchObject({
      author: 'County Clerk',
      publisher: 'River County Press',
      repository: 'Oakville Archive',
      url: 'https://archive.example.test/census/1880',
      gedcom_xref: '@S1@',
      has_primary_source: true,
    });
    expect(() =>
      mergeSourcesPatch(
        [existingSource],
        [{ id: 'src_1880_census', citation: 'Updated', source_type: 'census' }],
        ['src_1880_census']
      )
    ).toThrow(/cannot both add\/update and remove source/);

    // Media update preserves optional keys & extensions, rejects simultaneous add+remove
    const existingMedia = makeMedia({
      has_primary_source: true,
      thumb_file: '/media/thumbs/census_1880.jpg',
      provenance: 'River County Clerk',
      date_edtf: '1880-06-10',
      page: 14,
      mime_type: 'image/jpeg',
      duration_seconds: 0,
      poster_url: '/media/poster.jpg',
      transcript_url: '/media/transcript.txt',
      extensions: { roll: 'T9-100' },
    });
    const mergedMedia = mergeMediaPatch(
      [existingMedia],
      [
        {
          id: 'med_census_1',
          kind: 'record_scan',
          file: '/media/scans/census_1880.jpg',
          caption: 'Updated caption',
          extensions: { frame: 12 },
        },
      ],
      []
    );
    expect(mergedMedia.items[0]).toMatchObject({
      thumb_file: '/media/thumbs/census_1880.jpg',
      provenance: 'River County Clerk',
      date_edtf: '1880-06-10',
      page: 14,
      mime_type: 'image/jpeg',
      poster_url: '/media/poster.jpg',
      transcript_url: '/media/transcript.txt',
      has_primary_source: true,
      extensions: { roll: 'T9-100', frame: 12 },
    });
    expect(() => mergeMediaPatch([existingMedia], [makeMedia()], ['med_census_1'])).toThrow(
      /cannot both add\/update and remove media/
    );

    // Narrative merge preserves updated_at, summary, extensions, and rejects non-object entries
    expect(() => mergeNarrativesPatch([], ['not-an-object'], 'per_jane_doe', new Set(), new Set())).toThrow();
    const existingNar = makeNarrative({
      has_primary_source: true,
      updated_at: '2026-01-15',
      summary: 'Short bio summary',
      extensions: { reviewer: 'editor' },
    });
    const mergedNar = mergeNarrativesPatch(
      [existingNar],
      [
        {
          id: 'nar_jane_bio',
          slug: 'jane-doe-biography',
          title: 'Jane Doe Biography (Revised)',
          body_md: 'Updated text[^src_1880_census|med_census_1].',
          person_ids: ['per_jane_doe'],
          place_ids: ['plc_oakville'],
          event_ids: ['evt_1880_census'],
          source_ids: [],
          extensions: { revised: true },
        },
      ],
      'per_jane_doe',
      new Set(['src_1880_census']),
      new Set(['med_census_1'])
    );
    expect(mergedNar.inlineCitationCount).toBe(1);
    expect(mergedNar.items[0]).toMatchObject({
      updated_at: '2026-01-15',
      summary: 'Short bio summary',
      source_ids: ['src_1880_census'],
      extensions: { reviewer: 'editor', revised: true },
    });
  });

  it('enforces patch referential integrity and retirement integrity checks', () => {
    const jane = makeDeceasedPerson();
    const sam = makeLivingPerson();
    const evt = makeEvent();
    const peopleById = new Map<string, RawPerson>([
      [jane.id, jane],
      [sam.id, sam],
    ]);
    const livingIds = new Set<string>([sam.id]);
    const placeIds = new Set<string>(['plc_oakville']);
    const sourceIds = new Set<string>(['src_1880_census']);
    const eventsById = new Map<string, RawEvent>([[evt.id, evt]]);

    const baseIntegrity = {
      cleanedPatchEvents: [] as unknown[],
      patchKinship: [] as unknown[],
      normalizedPatchNarratives: [] as unknown[],
      peopleById,
      livingIds,
      placeIds,
      sourceIds,
      eventsById,
    };

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        cleanedPatchEvents: [makeEvent({ participants: [{ person_id: 'per_missing', role: 'head' }] })],
      })
    ).toThrow(/missing person_id/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        cleanedPatchEvents: [makeEvent({ participants: [{ person_id: 'per_sam_doe', role: 'head' }] })],
      })
    ).toThrow(/PRIVACY REFUSAL.*living participant/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        patchKinship: [{ from: 'per_missing', to: 'per_jane_doe', relation: 'parent' }],
      })
    ).toThrow(/missing 'from' person/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        patchKinship: [{ from: 'per_jane_doe', to: 'per_missing', relation: 'parent' }],
      })
    ).toThrow(/missing 'to' person/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ subject_person_id: 'per_missing' })],
      })
    ).toThrow(/missing subject_person_id/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ subject_person_id: 'per_sam_doe' })],
      })
    ).toThrow(/living subject_person_id/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ person_ids: ['per_missing'] })],
      })
    ).toThrow(/missing person_id/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ person_ids: ['per_sam_doe'] })],
      })
    ).toThrow(/references living person/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ place_ids: ['plc_missing'] })],
      })
    ).toThrow(/missing place_id/);

    expect(() =>
      validatePatchReferentialIntegrity({
        ...baseIntegrity,
        normalizedPatchNarratives: [makeNarrative({ source_ids: ['src_missing'] })],
      })
    ).toThrow(/missing source_id/);

    // Retirement integrity checks
    const baseRetirement = {
      topLevelRemoveEventIds: new Set<string>(),
      topLevelRemoveMediaIds: new Set<string>(),
      topLevelRemoveSourceIds: new Set<string>(),
      mergedPeople: [jane],
      finalEvents: [evt],
      finalMedia: [makeMedia()],
      finalNarratives: [makeNarrative()],
      sourceIds: new Set<string>(['src_1880_census']),
      mediaIds: new Set<string>(['med_census_1']),
    };

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        finalMedia: [],
        topLevelRemoveEventIds: new Set(['evt_1880_census']),
      })
    ).toThrow(/narrative 'nar_jane_bio' still references it in event_ids/);

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        finalEvents: [],
        finalNarratives: [],
        topLevelRemoveSourceIds: new Set(['src_1880_census']),
      })
    ).toThrow(/media 'med_census_1' still references it/);

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        finalEvents: [],
        finalMedia: [],
        topLevelRemoveSourceIds: new Set(['src_1880_census']),
      })
    ).toThrow(/narrative 'nar_jane_bio' still lists it in source_ids/);

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        finalEvents: [],
        finalMedia: [],
        finalNarratives: [makeNarrative({ source_ids: [] })],
        sourceIds: new Set(),
        topLevelRemoveSourceIds: new Set(['src_1880_census']),
      })
    ).toThrow(/src_1880_census/);

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        mergedPeople: [makeDeceasedPerson({ extensions: { sources: ['src_1880_census'] } })],
        finalEvents: [],
        finalMedia: [],
        finalNarratives: [],
        sourceIds: new Set(),
        topLevelRemoveSourceIds: new Set(['src_1880_census']),
      })
    ).toThrow(/person 'per_jane_doe' still cites it in extensions\.sources/);

    expect(() =>
      validateRetirementIntegrity({
        ...baseRetirement,
        mergedPeople: [makeDeceasedPerson({ extensions: { sources: [{ source_id: 'src_1880_census' }] } })],
        finalEvents: [],
        finalMedia: [],
        finalNarratives: [],
        sourceIds: new Set(),
        topLevelRemoveSourceIds: new Set(['src_1880_census']),
      })
    ).toThrow(/person 'per_jane_doe' still cites it in extensions\.sources/);
  });

  it('detects media layouts, stages scans with dry-run overlay, and validates unsafe/missing media paths', async () => {
    const repoDir = await makeTempDir('kinloom-int-media-');
    const pkgDir = path.join(repoDir, 'research', 'people', 'per_jane_doe');
    const scansDir = path.join(pkgDir, 'scans');
    await mkdir(scansDir, { recursive: true });

    // Default 'media' layout, then 'archive-media' layout
    expect(detectMediaLayout(repoDir).layout).toBe('media');
    await mkdir(path.join(repoDir, 'archive-media'), { recursive: true });
    const archiveLayout = detectMediaLayout(repoDir);
    expect(archiveLayout.layout).toBe('archive-media');
    expect(archiveLayout.scanUrlPrefix).toBe('/media/scans/');

    // Empty scan throws
    const emptyFile = path.join(scansDir, 'empty.jpg');
    await writeFile(emptyFile, Buffer.alloc(0));
    expect(() => planScanStaging(repoDir, pkgDir, archiveLayout)).toThrow(/empty \(0 bytes\)/);
    await rm(emptyFile);

    // Subdirectory inside scans/ throws
    const subDir = path.join(scansDir, 'nested');
    await mkdir(subDir);
    expect(() => planScanStaging(repoDir, pkgDir, archiveLayout)).toThrow(/Unexpected subdirectory/);
    await rm(subDir, { recursive: true });

    // Dangling symlink is skipped (!entry.isFile()), real scan is planned
    await symlink(path.join(scansDir, 'missing_target.jpg'), path.join(scansDir, 'ignored_link.jpg'));
    const scanBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    await writeFile(path.join(scansDir, 'census_1880.jpg'), scanBytes);

    const planned1 = planScanStaging(repoDir, pkgDir, archiveLayout);
    expect(planned1).toHaveLength(1);
    expect(planned1[0].alreadyIdentical).toBe(false);

    // Dry-run staging updates overlay.virtualStagedScans
    const overlay: IntegrateExecutionOverlay = {
      dataDirOverride: path.join(repoDir, 'data'),
      virtualStagedScans: new Map(),
    };
    const dryStaged = stagePlannedScans(planned1, true, overlay);
    expect(dryStaged[0].status).toBe('would_stage');
    expect(overlay.virtualStagedScans.get(planned1[0].destPath)).toBe(planned1[0].sha256);

    // Re-planning against overlay marks it alreadyIdentical
    const plannedViaOverlay = planScanStaging(repoDir, pkgDir, archiveLayout, overlay.virtualStagedScans);
    expect(plannedViaOverlay[0].alreadyIdentical).toBe(true);

    // validatePatchMedia error cases
    const jane = makeDeceasedPerson();
    const evt = makeEvent();
    const baseValidate = {
      repoDir,
      packageDir: pkgDir,
      mediaLayout: archiveLayout,
      plannedScans: [],
      peopleById: new Map([[jane.id, jane]]),
      livingIds: new Set<string>(),
      eventsById: new Map([[evt.id, evt]]),
      sourceIds: new Set(['src_1880_census']),
    };

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ person_id: 'per_missing' })],
      })
    ).toThrow(/missing person_id/);

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ event_id: 'evt_missing' })],
      })
    ).toThrow(/missing event_id/);

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ source_id: 'src_missing' })],
      })
    ).toThrow(/missing source_id/);

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ file: 'http://archive.example.test/x.jpg' })],
      })
    ).toThrow(/must start with '\/media\/'/);

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ file: '/media/../secret.jpg' })],
      })
    ).toThrow(/Unsafe media file URL/);

    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ file: '/media/scans/not_staged.jpg' })],
      })
    ).toThrow(/Missing scan file/);

    // Succeeds when virtualStagedScans contains the file
    expect(() =>
      validatePatchMedia({
        ...baseValidate,
        patchMedia: [makeMedia({ file: '/media/scans/census_1880.jpg' })],
        overlay,
      })
    ).not.toThrow();
  });
});

describe('mediaDedupe/merge.ts, rewrite.ts, report.ts, and io.ts', () => {
  it('selects canonical survivor via completeness score & caption length, merges conflicts/scalars/extensions across 3-way groups', () => {
    // Group multiple duplicate files and ignore unnormalizable file paths
    const mediaList: MediaItem[] = [
      makeMedia({ id: 'med_b1', file: '/media/scans/b.jpg' }),
      makeMedia({ id: 'med_b2', file: '/media/scans/./b.jpg' }),
      makeMedia({ id: 'med_a1', file: '/media/scans/a.jpg' }),
      makeMedia({ id: 'med_a2', file: 'media/scans/a.jpg' }),
      makeMedia({ id: 'med_skip', file: '   ' }),
    ];
    const grouped = groupDuplicateMediaByFile(mediaList);
    expect(grouped.map(([file]) => file)).toEqual(['media/scans/a.jpg', 'media/scans/b.jpg']);

    // Completeness score tie-breaking when refCounts are tied
    const rich: MediaItem = {
      id: 'med_rich',
      kind: 'record_scan',
      source_id: 'src_a',
      event_id: 'evt_a',
      person_id: 'per_jane_doe',
      file: '/media/scans/doc.jpg',
      caption: 'Short',
      date_edtf: '1880',
      provenance: 'Archive A',
    };
    const sparse: MediaItem = {
      id: 'med_sparse',
      kind: 'record_scan',
      file: '/media/scans/doc.jpg',
      caption: 'Much longer caption on sparse item',
    };
    const scorePlan = mergeDuplicateMediaGroup([sparse, rich], new Map(), new Set(), 'media/scans/doc.jpg');
    expect(scorePlan.canonicalId).toBe('med_rich');

    // Equal completeness score breaks tie by caption length, then id
    const capLong: MediaItem = {
      id: 'med_z',
      kind: 'record_scan',
      file: '/media/scans/tie.jpg',
      caption: 'Detailed 1880 Oakville deed record',
    };
    const capShort: MediaItem = {
      id: 'med_a',
      kind: 'record_scan',
      file: '/media/scans/tie.jpg',
      caption: 'Deed',
    };
    expect(
      mergeDuplicateMediaGroup([capShort, capLong], new Map(), new Set(), 'media/scans/tie.jpg').canonicalId
    ).toBe('med_z');

    const idTieA: MediaItem = {
      id: 'med_1',
      kind: 'family_photo',
      file: '/media/scans/idtie.jpg',
      caption: 'Same',
    };
    const idTieB: MediaItem = {
      id: 'med_2',
      kind: 'family_photo',
      file: '/media/scans/idtie.jpg',
      caption: 'Same',
    };
    expect(
      mergeDuplicateMediaGroup([idTieB, idTieA], new Map(), new Set(), 'media/scans/idtie.jpg').canonicalId
    ).toBe('med_1');

    // 3-way merge where preferred canonical is missing person_id, caption, provenance, source_id, event_id, and scalars
    const preferredEmpty: MediaItem = {
      id: 'med_pref',
      kind: 'record_scan',
      file: '/media/scans/tri.jpg',
      caption: '   ',
      extensions: {
        alternate_captions: ['Old alt caption'],
        alternate_provenance: ['Old alt prov'],
        additional_source_ids: ['src_prev'],
        additional_event_ids: ['evt_prev'],
        merged_from_media_ids: ['med_ancient'],
        canonical_wins: 'from-canonical',
      },
    };
    const retired1: MediaItem = {
      id: 'med_ret_b',
      kind: 'record_scan',
      person_id: 'per_jane_doe',
      source_id: 'src_1',
      event_id: 'evt_1',
      file: '/media/scans/tri.jpg',
      caption: 'Primary retired caption',
      provenance: 'Prov One',
      date_edtf: '1880-06-10',
      page: 12,
      thumb_file: '/media/thumbs/tri.jpg',
      mime_type: 'image/jpeg',
      has_primary_source: true,
      extensions: { canonical_wins: 'from-retired', retired_only: 'kept' },
    };
    const retired2: MediaItem = {
      id: 'med_ret_a',
      kind: 'record_scan',
      person_ids: ['per_john_doe'],
      source_id: 'src_2',
      event_id: 'evt_2',
      file: '/media/scans/tri.jpg',
      caption: 'Secondary distinct caption',
      provenance: 'Prov Two',
    };

    const triPlan = planDuplicateMediaMerges({
      media: [preferredEmpty, retired1, retired2],
      duplicateEntries: [['media/scans/tri.jpg', [preferredEmpty, retired1, retired2]]],
      refCounts: new Map(),
      preferSet: new Set(['med_pref']),
    });
    expect(triPlan.mergedMedia).toHaveLength(1);
    const rec = triPlan.mergedMedia[0];
    expect(rec.id).toBe('med_pref');
    expect(rec.person_id).toBe('per_jane_doe');
    expect(rec.person_ids).toEqual(['per_jane_doe', 'per_john_doe']);
    expect(rec.caption).toBe('Secondary distinct caption');
    expect(rec.provenance).toBe('Prov One');
    expect(rec.source_id).toBe('src_1');
    expect(rec.event_id).toBe('evt_1');
    expect(rec.date_edtf).toBe('1880-06-10');
    expect(rec.page).toBe(12);
    expect(rec.has_primary_source).toBe(true);
    expect(rec.extensions).toEqual({
      canonical_wins: 'from-canonical',
      retired_only: 'kept',
      alternate_captions: ['Old alt caption', 'Primary retired caption'],
      alternate_provenance: ['Old alt prov', 'Prov Two'],
      additional_source_ids: ['src_prev', 'src_2'],
      additional_event_ids: ['evt_prev', 'evt_2'],
      merged_from_media_ids: ['med_ancient', 'med_ret_a', 'med_ret_b'],
    });
    expect(triPlan.warnings).toHaveLength(2);
    expect(triPlan.warnings[0]).toContain('Conflicting source_id');
    expect(triPlan.warnings[1]).toContain('Conflicting event_id');
  });

  it('counts and rewrites nested extension media references across people, places, events, narratives, and enrichments', () => {
    const people: RawPerson[] = [
      makeDeceasedPerson({
        extensions: {
          gallery: [{ media_ids: ['med_old', 'med_keep', 'med_old', 42] }],
        },
      }),
    ];
    const places: Place[] = [
      makePlace({
        extensions: {
          nested: { media_refs: ['med_old'] },
        },
      }),
    ];
    const events: RawEvent[] = [makeEvent({ extensions: { media_ids: ['med_keep'] } })];
    const narratives: Narrative[] = [
      makeNarrative({
        body_md: 'No inline media rewrite here.',
        extensions: { media_refs: ['med_old'] },
      }),
    ];
    const enrichments = [
      makeEvent({
        id: 'evt_enrichment_note',
        extensions: { media_ids: ['med_old'] },
      }),
    ];

    const counts = collectArchiveMediaReferenceCounts({
      narratives,
      people,
      places,
      events,
      enrichments,
    });
    expect(counts.get('med_old')).toBe(5);
    expect(counts.get('med_keep')).toBe(2);

    // Direct test on non-record primitive returns false
    const dummyRewrites: MediaDedupeExtensionRewrite[] = [];
    expect(
      rewriteMediaRefsInExtensionsObject(
        'primitive',
        new Map([['med_old', 'med_keep']]),
        'people.yaml',
        'per_jane_doe',
        'extensions',
        dummyRewrites
      )
    ).toBe(false);

    const rewritten = applyMediaReferenceRewrites({
      narratives,
      people,
      places,
      events,
      retiredToCanonical: new Map([['med_old', 'med_keep']]),
    });

    expect(rewritten.peopleChanged).toBe(true);
    expect(rewritten.placesChanged).toBe(true);
    expect(rewritten.eventsChanged).toBe(false);
    expect(rewritten.narrativesChanged).toBe(true);
    expect(rewritten.nextPeople[0].extensions).toEqual({
      gallery: [{ media_ids: ['med_keep', 42] }],
    });
    expect(rewritten.nextPlaces[0].extensions).toEqual({
      nested: { media_refs: ['med_keep'] },
    });
    expect(rewritten.nextNarratives[0].extensions).toEqual({
      media_refs: ['med_keep'],
    });
  });

  it('formats media dedupe text and JSON reports for empty, dry-run, and apply modes', () => {
    const emptyBase: Omit<MediaDedupeCommandResult, 'rendered'> = {
      ok: true,
      apply: false,
      dryRun: true,
      repo: '/tmp/oakville',
      duplicateGroupCount: 0,
      retiredCount: 0,
      groups: [],
      citationRewrites: [],
      extensionRewrites: [],
      warnings: [],
      stagedPackageWarnings: [],
      wouldWriteYamlFiles: [],
      writtenYamlFiles: [],
    };
    expect(formatMediaDedupeTextReport(emptyBase)).toBe(
      'Media dedupe (dry-run) OK: 0 duplicate file groups found.\n  Repo: /tmp/oakville'
    );

    const fullDryBase: Omit<MediaDedupeCommandResult, 'rendered'> = {
      ok: true,
      apply: false,
      dryRun: true,
      repo: '/tmp/oakville',
      duplicateGroupCount: 2,
      retiredCount: 2,
      groups: [
        {
          normalizedFile: 'media/scans/a.jpg',
          canonicalId: 'med_a1',
          retiredIds: ['med_a2'],
          mergedPersonIds: ['per_jane_doe'],
          warnings: [],
          mergedRecord: makeMedia({ id: 'med_a1' }),
        },
        {
          normalizedFile: 'media/scans/b.jpg',
          canonicalId: 'med_b1',
          retiredIds: ['med_b2'],
          mergedPersonIds: [],
          warnings: [],
          mergedRecord: makeMedia({ id: 'med_b1' }),
        },
      ],
      citationRewrites: [
        {
          narrativeId: 'nar_jane_bio',
          sourceId: 'src_1880_census',
          fromMediaId: 'med_a2',
          toMediaId: 'med_a1',
        },
      ],
      extensionRewrites: [],
      warnings: ['Conflicting source_id on media/scans/a.jpg'],
      stagedPackageWarnings: [
        {
          personId: 'per_jane_doe',
          retiredMediaIds: ['med_a2', 'med_b2'],
          canonicalByRetired: { med_a2: 'med_a1', med_b2: 'med_b1' },
        },
      ],
      wouldWriteYamlFiles: ['/tmp/oakville/data/media.yaml'],
      writtenYamlFiles: [],
    };

    const dryRendered = renderMediaDedupeResult(fullDryBase, false);
    expect(dryRendered.rendered).toContain(
      'Media dedupe (dry-run) OK: 2 duplicate file group(s), 2 retired record(s)'
    );
    expect(dryRendered.rendered).toContain('(people: per_jane_doe)');
    expect(dryRendered.rendered).toContain('File media/scans/b.jpg: keep med_b1, retire [med_b2]');
    expect(dryRendered.rendered).toContain('Warnings:\n    - Conflicting source_id');
    expect(dryRendered.rendered).toContain('med_a2 -> med_a1, med_b2 -> med_b1');
    expect(dryRendered.rendered).toContain(
      "Dry-run only: 0 files written (1 file(s) would be updated; pass '--apply' to write)."
    );

    const applyRendered = renderMediaDedupeResult(
      {
        ...fullDryBase,
        apply: true,
        dryRun: false,
        writtenYamlFiles: ['/tmp/oakville/data/media.yaml'],
      },
      false
    );
    expect(applyRendered.rendered).toContain('Media dedupe (apply) OK:');
    expect(applyRendered.rendered).toContain('Written YAML files (1): /tmp/oakville/data/media.yaml');

    const jsonRendered = renderMediaDedupeResult(fullDryBase, true);
    expect(JSON.parse(jsonRendered.rendered)).toEqual(fullDryBase);
  });

  it('exercises mediaDedupe/io validation, staged scan sorting, pending writes, and rollback of newly created files', async () => {
    const repoDir = await makeTempDir('kinloom-dedupe-io-');
    expect(() => loadArchiveForMediaDedupe(repoDir)).toThrow(CliValidationError);

    // verifyDeduplicatedArchive catches remaining duplicates and dangling citations
    const config = makeSiteConfig();
    expect(() =>
      verifyDeduplicatedArchive({
        config,
        people: [makeDeceasedPerson()],
        places: [makePlace()],
        events: [makeEvent()],
        sources: [makeSource()],
        kinship: [],
        media: [
          makeMedia({ id: 'med_1', file: '/media/scans/same.jpg' }),
          makeMedia({ id: 'med_2', file: '/media/scans/same.jpg' }),
        ],
        narratives: [],
        enrichments: [],
      })
    ).toThrow(/duplicate media file/);

    expect(() =>
      verifyDeduplicatedArchive({
        config,
        people: [makeDeceasedPerson()],
        places: [makePlace()],
        events: [makeEvent()],
        sources: [makeSource()],
        kinship: [],
        media: [makeMedia({ id: 'med_1' })],
        narratives: [makeNarrative({ body_md: 'Dangling[^src_1880_census|med_missing].' })],
        enrichments: [],
      })
    ).toThrow(/citation verification failed/);

    // scanStagedPackagesForRetiredMedia empty map and multiple sorted retired IDs
    expect(scanStagedPackagesForRetiredMedia(repoDir, new Map())).toEqual([]);
    const stagedDir = path.join(repoDir, 'research', 'people', 'per_jane_doe');
    await mkdir(stagedDir, { recursive: true });
    await writeFile(path.join(stagedDir, 'patch.json'), JSON.stringify({ refs: ['med_z', 'med_a'] }), 'utf8');
    const stagedWarnings = scanStagedPackagesForRetiredMedia(
      repoDir,
      new Map([
        ['med_z', 'med_canon'],
        ['med_a', 'med_canon'],
      ])
    );
    expect(stagedWarnings).toEqual([
      {
        personId: 'per_jane_doe',
        retiredMediaIds: ['med_a', 'med_z'],
        canonicalByRetired: { med_z: 'med_canon', med_a: 'med_canon' },
      },
    ]);

    // buildPendingYamlWrites includes people.yaml & places.yaml when changed
    const dataDir = path.join(repoDir, 'data');
    const pending = buildPendingYamlWrites({
      paths: {
        peoplePath: path.join(dataDir, 'people.yaml'),
        placesPath: path.join(dataDir, 'places.yaml'),
        eventsPath: path.join(dataDir, 'events.yaml'),
        sourcesPath: path.join(dataDir, 'sources.yaml'),
        kinshipPath: path.join(dataDir, 'kinship.yaml'),
        mediaPath: path.join(dataDir, 'media.yaml'),
        narrativesPath: path.join(dataDir, 'narratives.yaml'),
        enrichmentsPath: path.join(dataDir, 'narrative_enrichments.yaml'),
      },
      mergedMedia: [makeMedia()],
      nextNarratives: [makeNarrative()],
      nextPeople: [makeDeceasedPerson()],
      nextPlaces: [makePlace()],
      nextEvents: [makeEvent()],
      narrativesChanged: false,
      peopleChanged: true,
      placesChanged: true,
      eventsChanged: false,
    });
    expect(pending.map((p) => path.basename(p.fullPath))).toEqual([
      'media.yaml',
      'people.yaml',
      'places.yaml',
    ]);

    // Rollback deletes newly created file (origBytes === null) when subsequent write fails
    const newFile = path.join(dataDir, 'new_file.yaml');
    const secondFile = path.join(dataDir, 'second_file.yaml');
    expect(() =>
      applyPendingYamlWritesWithRollback(
        [
          { fullPath: newFile, content: 'created: true\n' },
          { fullPath: secondFile, content: 'fail: true\n' },
        ],
        (filePath, content) => {
          if (filePath === secondFile) {
            throw new Error('disk full');
          }
          writeFileAtomicUtf8(filePath, content);
        }
      )
    ).toThrow(/Rollback succeeded: 1 YAML file\(s\) restored/);
    expect(fs.existsSync(newFile)).toBe(false);
  });
});

describe('sync/wrangler.ts', () => {
  it('parses wrangler.toml and wrangler.jsonc bindings, validates errors, runs defaultWranglerExecutor, and manages temp tokens', async () => {
    const emptyDir = await makeTempDir('kinloom-sync-w-empty-');
    expect(() => loadWranglerBindings(emptyDir)).toThrow(CliValidationError);

    // TOML parsing with comments, unrelated section, d1/r2/routes
    const tomlDir = await makeTempDir('kinloom-sync-w-toml-');
    await writeFile(
      path.join(tomlDir, 'wrangler.toml'),
      [
        'name = "oakville-worker"',
        '# Comment line',
        '[vars]',
        'ENVIRONMENT = "prod"',
        '[[d1_databases]]',
        'binding = "DB"',
        'database_name = "oakville-d1" # inline comment',
        'non_string_val = 42',
        '[[r2_buckets]]',
        'binding = "MEDIA"',
        'bucket_name = "oakville-r2"',
        '[[routes]]',
        'pattern = "archive.example.test/*"',
      ].join('\n'),
      'utf8'
    );
    expect(loadWranglerBindings(tomlDir)).toEqual({
      configPath: path.join(tomlDir, 'wrangler.toml'),
      dbName: 'oakville-d1',
      r2Bucket: 'oakville-r2',
      domain: 'archive.example.test',
      baseUrl: 'https://archive.example.test',
    });

    // URL override normalization and validation
    expect(loadWranglerBindings(tomlDir, 'custom.example.test/sub/').baseUrl).toBe(
      'https://custom.example.test/sub'
    );
    expect(() => loadWranglerBindings(tomlDir, 'http://[bad')).toThrow(/Invalid site URL/);

    // JSONC error cases: invalid JSON, non-object, missing dbName, missing r2Bucket, bad route, missing route
    const jsonErrDir = await makeTempDir('kinloom-sync-w-jerr-');
    const jsoncPath = path.join(jsonErrDir, 'wrangler.jsonc');

    await writeFile(jsoncPath, '{ invalid', 'utf8');
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/Failed to parse/);

    await writeFile(jsoncPath, '[]', 'utf8');
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/Expected a JSON object/);

    await writeFile(jsoncPath, JSON.stringify({ d1_databases: [], r2_buckets: [{ bucket_name: 'b' }] }));
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/database_name/);

    await writeFile(jsoncPath, JSON.stringify({ d1_databases: [{ database_name: 'd' }], r2_buckets: [] }));
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/bucket_name/);

    await writeFile(
      jsoncPath,
      JSON.stringify({
        d1_databases: [{ database_name: 'd' }],
        r2_buckets: [{ bucket_name: 'b' }],
        routes: ['/path-only'],
      })
    );
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/Could not derive a site URL/);

    await writeFile(
      jsoncPath,
      JSON.stringify({
        d1_databases: [{ database_name: 'd' }],
        r2_buckets: [{ bucket_name: 'b' }],
      })
    );
    expect(() => loadWranglerBindings(jsonErrDir)).toThrow(/No --site-url provided/);

    // resolveWranglerBin
    expect(resolveSyncWranglerBin(tomlDir, '  /bin/wrangler  ')).toBe('/bin/wrangler');
    expect(resolveSyncWranglerBin(tomlDir)).toBe('wrangler');
    const localWrangler = path.join(tomlDir, 'node_modules', '.bin', 'wrangler');
    await mkdir(path.dirname(localWrangler), { recursive: true });
    await writeFile(localWrangler, '#!/bin/sh\n', 'utf8');
    expect(resolveSyncWranglerBin(tomlDir)).toBe(localWrangler);

    // defaultWranglerExecutor via node binary
    const subRes = await syncDefaultWranglerExecutor(
      process.execPath,
      ['-e', "process.stdout.write('sync-ok')"],
      { cwd: tomlDir, maxBufferBytes: 1024 * 1024, timeoutMs: 10_000 }
    );
    expect(subRes.stdout).toBe('sync-ok');

    // Temp token SQL guards
    expect(() =>
      buildTempTokenInsertSql(
        [{ tokenId: 'bad_id', tokenHash: 'abc', scope: 'read_backup' }],
        '2026-01-01T00:00:00Z'
      )
    ).toThrow(/Refusing to mint temp token/);
    expect(() => buildTempTokenCleanupSql([])).toThrow(/empty tokenIds/);
    expect(() => buildTempTokenCleanupSql(['perm_token_1'])).toThrow(/SAFETY REFUSAL/);

    const readTok = generateTempToken('read_backup');
    expect(readTok.tokenId.startsWith('tmp_sync_read_')).toBe(true);

    // D1 output validation in mintTempTokens / cleanupTempTokens
    const badOutCtx = makeSyncContext(tomlDir, {
      execWrangler: async () => ({ stdout: 'no array', stderr: '' }),
    });
    await expect(mintTempTokens(badOutCtx)).rejects.toThrow(/Unexpected wrangler D1 output/);

    const emptyOutCtx = makeSyncContext(tomlDir, {
      execWrangler: async () => ({ stdout: '[]', stderr: '' }),
    });
    await expect(mintTempTokens(emptyOutCtx)).rejects.toThrow(/Empty wrangler D1 response/);

    const failStmtCtx = makeSyncContext(tomlDir, {
      execWrangler: async () => ({ stdout: JSON.stringify([{ success: false }]), stderr: '' }),
    });
    await expect(mintTempTokens(failStmtCtx)).rejects.toThrow(/D1 statement failed/);

    const leftoverCleanupCtx = makeSyncContext(tomlDir, {
      execWrangler: async () => ({
        stdout: JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [{ count: 1 }] },
          { success: true, results: [{ count: 1 }] },
        ]),
        stderr: '',
      }),
    });
    await expect(cleanupTempTokens(leftoverCleanupCtx, [readTok.tokenId])).rejects.toThrow(
      /1 temp token\(s\) still present/
    );
  });
});

describe('sync/planner.ts', () => {
  it('validates CLI parsers, builds sanitized local entries, indexes snapshots, and computes create/update/unchanged/delete plans', async () => {
    expect(normalizeSyncEntityType('people')).toBe('person');
    expect(normalizeSyncEntityType('kinship')).toBe('kinship_edge');
    expect(() => normalizeSyncEntityType('invalid_kind')).toThrow(CliValidationError);

    expect(parseEntityTypeList('narrative, place, person')).toEqual(['place', 'person', 'narrative']);
    expect(() => parseEntityTypeList(' , , ')).toThrow(CliValidationError);

    expect(parseDeleteTargets('places:plc_1, person:per_2')).toEqual([
      { entity_type: 'place', entity_id: 'plc_1' },
      { entity_type: 'person', entity_id: 'per_2' },
    ]);
    expect(() => parseDeleteTargets('bad_format')).toThrow(CliValidationError);
    expect(() => parseDeleteTargets('person:')).toThrow(CliValidationError);

    const emptyRepo = await makeTempDir('kinloom-planner-empty-');
    await expect(loadLocalArchive(emptyRepo)).rejects.toThrow(CliValidationError);

    // Build sanitized local entries including narratives, kinship, living person, and living media filtered out
    const local: LocalArchiveFiles = {
      siteConfig: makeSiteConfig(),
      places: [makePlace()],
      sources: [makeSource()],
      people: [makeDeceasedPerson(), makeLivingPerson()],
      events: [makeEvent()],
      kinship: [{ from: 'per_jane_doe', to: 'per_sam_doe', relation: 'parent' }],
      media: [
        makeMedia(),
        makeMedia({
          id: 'med_living_sam',
          person_id: 'per_sam_doe',
          event_id: undefined,
          file: '/media/scans/sam.jpg',
          caption: 'Living photo filtered out',
        }),
      ],
      narratives: [makeNarrative()],
    };
    const sanitized = buildSanitizedLocalEntries(local);
    expect(sanitized.livingIds).toEqual(new Set(['per_sam_doe']));
    expect(sanitized.filteredOutMediaCount).toBe(1);
    expect(sanitized.byType.narrative).toHaveLength(1);
    expect(sanitized.byType.kinship_edge).toHaveLength(1);

    const kinshipId = sanitized.byType.kinship_edge[0].entity_id;

    // Index remote snapshot skipping deleted rows and preserving active kinship
    const snapshot: RemoteSnapshotResponse = {
      head_revision_id: 10,
      entities: [
        {
          entity_type: 'place',
          entity_id: 'plc_oakville',
          data: makePlace(),
          current_revision_id: 5,
          has_primary_source: true,
          deleted_at: null,
        },
        {
          entity_type: 'place',
          entity_id: 'plc_deleted_remote',
          data: makePlace({ id: 'plc_deleted_remote', slug: 'deleted-remote' }),
          current_revision_id: 4,
          deleted_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'place',
          entity_id: 'plc_extra_remote',
          data: makePlace({ id: 'plc_extra_remote', slug: 'extra-remote' }),
          current_revision_id: 6,
          deleted_at: null,
        },
        {
          entity_type: 'source',
          entity_id: 'src_explicit_del',
          data: makeSource({ id: 'src_explicit_del' }),
          current_revision_id: 7,
          has_primary_source: false,
          deleted_at: null,
        },
      ],
      kinship: [
        {
          edge_id: kinshipId,
          edge: { from: 'per_jane_doe', to: 'per_sam_doe', relation: 'parent' },
          current_revision_id: 8,
          deleted_at: null,
        },
        {
          edge_id: 'kin_deleted',
          edge: { from: 'per_sam_doe', to: 'per_jane_doe', relation: 'child' },
          current_revision_id: 3,
          deleted_at: '2026-01-02T00:00:00Z',
        },
      ],
    };

    const remoteByType = indexRemoteSnapshot(snapshot);
    expect(remoteByType.place.has('plc_deleted_remote')).toBe(false);
    expect(remoteByType.kinship_edge.has('kin_deleted')).toBe(false);
    expect(remoteByType.kinship_edge.has(kinshipId)).toBe(true);
    expect(remoteByType.source.get('src_explicit_del')?.has_primary_source).toBe(false);

    const plan = computeSyncPlan({
      selectedTypes: ['place', 'person', 'kinship_edge'],
      localByType: sanitized.byType,
      remoteByType,
      includeLiving: false,
      allowDeletes: true,
      explicitDeletes: [
        { entity_type: 'place', entity_id: 'plc_extra_remote' }, // already planned by allowDeletes
        { entity_type: 'source', entity_id: 'src_nonexistent' }, // missing on remote -> skipped
        { entity_type: 'source', entity_id: 'src_explicit_del' }, // type not in selectedTypes -> creates counts entry
      ],
    });

    expect(plan.countsByType.place).toEqual({
      local: 1,
      remote: 2,
      create: 0,
      update: 0,
      delete: 1,
      unchanged: 1,
      skippedLiving: 0,
    });
    expect(plan.countsByType.kinship_edge?.unchanged).toBe(1);
    expect(plan.countsByType.person?.skippedLiving).toBe(1);
    expect(plan.countsByType.source?.delete).toBe(1);
    expect(plan.patches.filter((p) => p.action === 'delete').map((p) => p.entity_id)).toEqual([
      'plc_extra_remote',
      'src_explicit_del',
    ]);
  });
});

describe('sync/remoteClient.ts', () => {
  it('handles snapshot, batch chunking, purge/recompile, and live endpoint verification across success and failure modes', async () => {
    const repoDir = await makeTempDir('kinloom-remote-client-');

    // 1. fetchRemoteSnapshot: 304, HTTP 500, invalid JSON, network error
    await expect(
      fetchRemoteSnapshot(
        makeSyncContext(repoDir, { fetchImpl: async () => new Response(null, { status: 304 }) }),
        'tok'
      )
    ).rejects.toThrow(/unexpected 304/);

    await expect(
      fetchRemoteSnapshot(
        makeSyncContext(repoDir, {
          fetchImpl: async () => new Response('server boom', { status: 500 }),
        }),
        'tok'
      )
    ).rejects.toThrow(/GET \/api\/export\/snapshot failed with HTTP 500/);

    await expect(
      fetchRemoteSnapshot(
        makeSyncContext(repoDir, {
          fetchImpl: async () => new Response('not-json', { status: 200 }),
        }),
        'tok'
      )
    ).rejects.toThrow(KinloomApiError);

    await expect(
      fetchRemoteSnapshot(
        makeSyncContext(repoDir, {
          fetchImpl: async () => {
            throw new Error('socket hang up');
          },
        }),
        'tok'
      )
    ).rejects.toThrow(/socket hang up/);

    // 2. submitPatchChunks: multi-chunk success + HTTP error + validation error + network error
    const patches: EntityPatch[] = [
      { action: 'create', entity_type: 'place', entity_id: 'plc_1', data: makePlace({ id: 'plc_1' }) },
      { action: 'create', entity_type: 'place', entity_id: 'plc_2', data: makePlace({ id: 'plc_2' }) },
    ];

    const seenBatchIds: string[] = [];
    const okBatches = await submitPatchChunks({
      ctx: makeSyncContext(repoDir, {
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as { batch_id: string };
          seenBatchIds.push(body.batch_id);
          return new Response(
            JSON.stringify({
              batch_id: body.batch_id,
              revisions: [],
              head_revision_id: seenBatchIds.length,
              etag: `"r${seenBatchIds.length}"`,
            }),
            { status: 200 }
          );
        },
      }),
      writeToken: 'tok',
      batchLabel: 'Oakville Archive!',
      summary: 'Sync places',
      patches,
      chunkSize: 1,
    });
    expect(okBatches).toHaveLength(2);
    expect(seenBatchIds[0]).toMatch(/-p1$/);
    expect(seenBatchIds[1]).toMatch(/-p2$/);

    await expect(
      submitPatchChunks({
        ctx: makeSyncContext(repoDir, {
          fetchImpl: async () => new Response('bad batch', { status: 422 }),
        }),
        writeToken: 'tok',
        batchLabel: 'test',
        summary: 'Sync',
        patches: [patches[0]],
        chunkSize: 1,
      })
    ).rejects.toThrow(/POST \/api\/batches.*failed with HTTP 422/);

    await expect(
      submitPatchChunks({
        ctx: makeSyncContext(repoDir, {
          fetchImpl: async () => new Response('{broken', { status: 200 }),
        }),
        writeToken: 'tok',
        batchLabel: 'test',
        summary: 'Sync',
        patches: [patches[0]],
        chunkSize: 1,
      })
    ).rejects.toThrow(KinloomApiError);

    await expect(
      submitPatchChunks({
        ctx: makeSyncContext(repoDir, {
          fetchImpl: async () => {
            throw new Error('network reset');
          },
        }),
        writeToken: 'tok',
        batchLabel: 'test',
        summary: 'Sync',
        patches: [patches[0]],
        chunkSize: 1,
      })
    ).rejects.toThrow(/network reset/);

    // 3. purgeCompiledBundleAndRecompile: 304, HTTP 502, invalid JSON, network error
    await expect(
      purgeCompiledBundleAndRecompile(
        makeSyncContext(repoDir, { fetchImpl: async () => new Response(null, { status: 304 }) }),
        'tok'
      )
    ).rejects.toThrow(/unexpected 304/);

    await expect(
      purgeCompiledBundleAndRecompile(
        makeSyncContext(repoDir, { fetchImpl: async () => new Response('bad gw', { status: 502 }) }),
        'tok'
      )
    ).rejects.toThrow(/Post-purge GET \/api\/bundle failed with HTTP 502/);

    await expect(
      purgeCompiledBundleAndRecompile(
        makeSyncContext(repoDir, { fetchImpl: async () => new Response('bad-json', { status: 200 }) }),
        'tok'
      )
    ).rejects.toThrow(KinloomApiError);

    await expect(
      purgeCompiledBundleAndRecompile(
        makeSyncContext(repoDir, {
          fetchImpl: async () => {
            throw new Error('timeout');
          },
        }),
        'tok'
      )
    ).rejects.toThrow(/timeout/);

    // 4. verifyLiveEndpoints: bundle errors + all media probe outcomes
    const bundle = makeCompiledBundle();

    // Bundle 304
    const v304 = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, { fetchImpl: async () => new Response(null, { status: 304 }) }),
      writeToken: 'tok',
      expectedRevision: 5,
      uploadedKeys: [],
      concurrency: 2,
    });
    expect(v304.ok).toBe(false);
    expect(v304.bundleStatus).toBe(304);

    // Bundle invalid JSON
    const vBadJson = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, { fetchImpl: async () => new Response('not-json', { status: 200 }) }),
      writeToken: 'tok',
      expectedRevision: 5,
      uploadedKeys: [],
      concurrency: 2,
    });
    expect(vBadJson.failures[0].reason).toContain('Invalid JSON from /api/bundle');

    // Bundle invalid schema
    const vBadSchema = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, {
        fetchImpl: async () => new Response(JSON.stringify({ wrong: true }), { status: 200 }),
      }),
      writeToken: 'tok',
      expectedRevision: 5,
      uploadedKeys: [],
      concurrency: 2,
    });
    expect(vBadSchema.failures[0].reason).toContain('Unexpected response shape');

    // Bundle HTTP 503
    const v503 = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, { fetchImpl: async () => new Response('down', { status: 503 }) }),
      writeToken: 'tok',
      expectedRevision: 5,
      uploadedKeys: [],
      concurrency: 2,
    });
    expect(v503.failures[0].reason).toContain('got HTTP 503: down');

    // Bundle network error
    const vNet = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, {
        fetchImpl: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
      writeToken: 'tok',
      expectedRevision: 5,
      uploadedKeys: [],
      concurrency: 2,
    });
    expect(vNet.failures[0].reason).toBe('ECONNREFUSED');

    // Bundle revision mismatch + media probes (200 ok, 404, content-length: 0, empty stream, empty null-body, fetch error)
    const bundleWithRev: ArchiveBundle = {
      ...bundle,
      meta: { ...bundle.meta, max_revision_id: 9 },
    };
    const vMixed = await verifyLiveEndpoints({
      ctx: makeSyncContext(repoDir, {
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.endsWith('/api/bundle')) {
            return new Response(JSON.stringify(bundleWithRev), { status: 200 });
          }
          if (url.endsWith('/media/ok.jpg')) {
            return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
          }
          if (url.endsWith('/media/notfound.jpg')) {
            return new Response('missing', { status: 404 });
          }
          if (url.endsWith('/media/zeroheader.jpg')) {
            return new Response('x', { status: 200, headers: { 'content-length': '0' } });
          }
          if (url.endsWith('/media/emptystream.jpg')) {
            const emptyStream = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            });
            return new Response(emptyStream, { status: 200 });
          }
          if (url.endsWith('/media/nullbody.jpg')) {
            return new Response(null, { status: 200 });
          }
          throw new Error('media probe failed');
        },
      }),
      writeToken: 'tok',
      expectedRevision: 10,
      uploadedKeys: [
        'media/ok.jpg',
        'media/notfound.jpg',
        'media/zeroheader.jpg',
        'media/emptystream.jpg',
        'media/nullbody.jpg',
        'media/throws.jpg',
      ],
      concurrency: 4,
    });
    expect(vMixed.ok).toBe(false);
    expect(vMixed.bundleRevision).toBe(9);
    expect(vMixed.mediaChecked).toBe(6);
    expect(vMixed.mediaFailed).toBe(5);
    expect(vMixed.failures.map((f) => [f.target, f.reason])).toEqual([
      ['bundle', 'Bundle revision mismatch: expected r10, got r9'],
      ['media/notfound.jpg', 'Expected HTTP 200, got HTTP 404'],
      ['media/zeroheader.jpg', 'Empty response (content-length: 0)'],
      ['media/emptystream.jpg', 'Empty response body (0 bytes)'],
      ['media/nullbody.jpg', 'Empty response body (0 bytes)'],
      ['media/throws.jpg', 'media probe failed'],
    ]);
  });
});

describe('sync/media.ts', () => {
  it('resolves upload targets across layouts, probes missing remote media, and uploads via wrangler', async () => {
    const repoDir = await makeTempDir('kinloom-sync-media-');
    expect(detectSyncMediaLayout(repoDir)).toBe('media');

    const mediaScanDir = path.join(repoDir, 'media', 'scans');
    const archiveMediaDir = path.join(repoDir, 'archive-media', 'media', 'scans');
    const externalDir = path.join(repoDir, 'staging');
    await mkdir(mediaScanDir, { recursive: true });
    await mkdir(archiveMediaDir, { recursive: true });
    await mkdir(externalDir, { recursive: true });

    const localScan = path.join(mediaScanDir, 'doc.pdf');
    const archiveScan = path.join(archiveMediaDir, 'photo.webp');
    const externalBin = path.join(externalDir, 'raw.unknownext');
    await writeFile(localScan, 'pdf-bytes', 'utf8');
    await writeFile(archiveScan, 'webp-bytes', 'utf8');
    await writeFile(externalBin, 'bin-bytes', 'utf8');

    expect(detectSyncMediaLayout(repoDir)).toBe('archive-media');

    // /media/... input under media layout
    expect(resolveMediaUploadTarget(repoDir, 'media', '/media/scans/doc.pdf')).toEqual({
      localPath: localScan,
      r2Key: 'media/scans/doc.pdf',
      contentType: 'application/pdf',
    });

    // Path inside archive-media/ under archive-media layout
    expect(resolveMediaUploadTarget(repoDir, 'archive-media', archiveScan)).toEqual({
      localPath: archiveScan,
      r2Key: 'media/scans/photo.webp',
      contentType: 'image/webp',
    });

    // Path inside repoDir/media/ under media layout
    expect(resolveMediaUploadTarget(repoDir, 'media', 'media/scans/doc.pdf')).toEqual({
      localPath: localScan,
      r2Key: 'media/scans/doc.pdf',
      contentType: 'application/pdf',
    });
    expect(resolveMediaUploadTarget(repoDir, 'media', localScan)).toEqual({
      localPath: localScan,
      r2Key: 'media/scans/doc.pdf',
      contentType: 'application/pdf',
    });

    // External path falls back to layout prefix and unknown MIME -> application/octet-stream
    expect(resolveMediaUploadTarget(repoDir, 'archive-media', externalBin)).toEqual({
      localPath: externalBin,
      r2Key: 'media/scans/raw.unknownext',
      contentType: 'application/octet-stream',
    });
    expect(resolveMediaUploadTarget(repoDir, 'media', externalBin)).toEqual({
      localPath: externalBin,
      r2Key: 'media/raw.unknownext',
      contentType: 'application/octet-stream',
    });

    // Missing file throws CliValidationError
    expect(() => resolveMediaUploadTarget(repoDir, 'media', '/media/scans/missing.jpg')).toThrow(
      CliValidationError
    );

    // findMissingRemoteMedia skips non-/media/, duplicates, missing local files, and checks remote status
    const ctx = makeSyncContext(repoDir, {
      mediaLayout: 'archive-media',
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith('/media/scans/photo.webp')) {
          return new Response('x', { status: 404 });
        }
        return new Response('x', { status: 206 });
      },
    });
    const probe = await findMissingRemoteMedia(ctx, 'tok', [
      {
        entity_type: 'media',
        entity_id: 'm1',
        data: makeMedia({ id: 'm1', file: 'https://external.example.test/skip.jpg' }),
        has_primary_source: true,
        isLiving: false,
      },
      {
        entity_type: 'media',
        entity_id: 'm2',
        data: makeMedia({ id: 'm2', file: '/media/scans/photo.webp', mime_type: 'image/webp' }),
        has_primary_source: true,
        isLiving: false,
      },
      {
        entity_type: 'media',
        entity_id: 'm2_dup',
        data: makeMedia({ id: 'm2_dup', file: '/media/scans/photo.webp' }),
        has_primary_source: true,
        isLiving: false,
      },
      {
        entity_type: 'media',
        entity_id: 'm_missing_disk',
        data: makeMedia({ id: 'm_missing_disk', file: '/media/scans/not_on_disk.jpg' }),
        has_primary_source: true,
        isLiving: false,
      },
    ]);
    expect(probe.checkedCount).toBe(1);
    expect(probe.missing).toEqual([
      {
        localPath: archiveScan,
        r2Key: 'media/scans/photo.webp',
        contentType: 'image/webp',
      },
    ]);

    // uploadMediaTargets empty returns [] and non-empty invokes wrangler put
    expect(await uploadMediaTargets(ctx, [], 4)).toEqual([]);
    const putArgs: string[][] = [];
    const uploadCtx = makeSyncContext(repoDir, {
      execWrangler: async (_bin, args) => {
        putArgs.push([...args]);
        return { stdout: '', stderr: '' };
      },
    });
    const uploaded = await uploadMediaTargets(uploadCtx, probe.missing, 2);
    expect(uploaded).toEqual(['media/scans/photo.webp']);
    expect(putArgs[0]).toContain('oakville-archive-media/media/scans/photo.webp');
    expect(putArgs[0]).toContain('image/webp');
  });
});

// Sanity helper verification: serialize + write archive roundtrip for loadArchiveForMediaDedupe
describe('mediaDedupe/io.ts loadArchiveForMediaDedupe happy path', () => {
  it('loads valid local archive repo for media dedupe', async () => {
    const repoDir = await makeTempDir('kinloom-dedupe-load-');
    const dataDir = path.join(repoDir, 'data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(makeSiteConfig()),
      'utf8'
    );
    await writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml([makeDeceasedPerson()]), 'utf8');
    await writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml([makePlace()]), 'utf8');
    await writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml([makeSource()]), 'utf8');
    await writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml([makeEvent()]), 'utf8');
    await writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml([makeMedia()]), 'utf8');
    await writeFile(
      path.join(dataDir, 'narratives.yaml'),
      serializeNarrativesYaml([makeNarrative()]),
      'utf8'
    );

    const loaded = loadArchiveForMediaDedupe(repoDir);
    expect(loaded.people).toHaveLength(1);
    expect(loaded.media).toHaveLength(1);
    expect(await readFile(loaded.paths.mediaPath, 'utf8')).toContain('med_census_1');
  });
});
