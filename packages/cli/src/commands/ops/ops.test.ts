import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parseSourcesYaml,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type Place,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError, EXIT_USAGE } from '../../errors.js';
import {
  REDACTED_RELATIVE_LABEL,
  buildSanitizedLocalEntries,
  buildTempTokenCleanupSql,
  buildTempTokenInsertSql,
  computeSyncPlan,
  generateTempToken,
  getTelemetryFilePath,
  indexRemoteSnapshot,
  inspectImageBuffer,
  loadWranglerBindings,
  measureCommand,
  parseDeleteTargets,
  parseEntityTypeList,
  recordTelemetryEvent,
  runAuditCommand,
  runContextCommand,
  runDatesCommand,
  runIntegrateCommand,
  runSyncCommand,
  runTelemetryReportCommand,
  runVerifyCommand,
  scanYamlFilesForSsns,
  stripJsoncCommentsAndTrailingCommas,
  type OpsIo,
  type WranglerExecutor,
} from './index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.KINLOOM_TELEMETRY_FILE;
  delete process.env.KINLOOM_TELEMETRY_PARENT;
  delete process.env.KINLOOM_ANCESTRY_FACTS_DIR;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createCaptureIo(): { io: OpsIo; stdout: string[]; stderr: string[] } {
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

function makeMinimalPng(width: number, height: number, padBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLen = Buffer.alloc(4);
  ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from('IHDR', 'ascii');
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 2;
  const crc = Buffer.alloc(4);
  const pad = padBytes > 0 ? Buffer.alloc(padBytes, 0x20) : Buffer.alloc(0);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, crc, pad]);
}

function makeMinimalJpeg(width: number, height: number): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof0 = Buffer.alloc(11);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(9, 2);
  sof0[4] = 8;
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 1;
  sof0[10] = 0x11;
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof0, eoi]);
}

function makeSampleSiteConfig(): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Alder Maple Archive',
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
          surnames: ['Alder', 'Maple'],
          lineageGroups: ['ancestor', 'descendant', 'extended'],
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

async function createSyntheticRepo(): Promise<string> {
  const repoDir = await makeTempDir('kinloom-ops-repo-');
  const dataDir = path.join(repoDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const config = makeSampleSiteConfig();
  await writeFile(
    path.join(repoDir, 'kinloom.config.yaml'),
    serializeKinloomConfigYaml(config),
    'utf8'
  );

  const places: Place[] = [
    {
      id: 'plc_oak_county_ohio',
      slug: 'oak-county-ohio',
      name: 'Oak County',
      full_name: 'Oak County, Ohio, USA',
      place_type: 'county',
      parent_id: null,
      lat: 40.25,
      lng: -82.85,
      historical_names: [],
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src_1880_census',
      citation: '1880 United States Federal Census, Oak County, Ohio',
      source_type: 'census',
      repository: 'NARA',
    },
    {
      id: 'src_1932_death_cert',
      citation: 'Ohio Certificate of Death, Arthur Alder, 1932',
      source_type: 'vital_record',
      repository: 'State Archives',
    },
  ];

  const people: RawPerson[] = [
    {
      id: 'per_thomas_alder',
      slug: 'thomas-alder',
      gedcom_xref: '@I100001@',
      full_name: 'Thomas Alder',
      given_name: 'Thomas',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1830-03-10',
      death_edtf: '1902-11-04',
      portrait_url: null,
    },
    {
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      gedcom_xref: '@I100002@',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: ['Art Alder'],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1858-04-12',
      death_edtf: '1932-09-18',
      portrait_url: null,
      extensions: {
        note: 'Visited granddaughter Clara Maple before passing.',
      },
    },
    {
      id: 'per_helen_maple',
      slug: 'helen-maple',
      gedcom_xref: '@I100003@',
      full_name: 'Helen Maple',
      given_name: 'Helen',
      surname: 'Maple',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1861-06-20',
      death_edtf: '1940-01-15',
      portrait_url: null,
    },
    {
      id: 'per_clara_maple_living',
      slug: 'clara-maple',
      gedcom_xref: '@I100004@',
      full_name: 'Clara Maple',
      given_name: 'Clara',
      surname: 'Maple',
      alt_names: ['Clara Alder Maple'],
      sex: 'F',
      is_living: true,
      lineage_group: 'descendant',
      birth_edtf: '1954-07-08',
      death_edtf: '',
      portrait_url: null,
    },
  ];

  const events: RawEvent[] = [
    {
      id: 'evt_arthur_1880_census',
      title: '1880 Federal Census household in Oak County',
      scope: 'personal',
      event_kind: 'residence_anchor',
      edtf_date: '1880-06-15',
      place_id: 'plc_oak_county_ohio',
      summary: 'Arthur Alder farmed in Oak County.',
      participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
      sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
    },
    {
      id: 'evt_arthur_living_visit',
      title: 'Family reunion with Clara Maple',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1955-08-19',
      place_id: 'plc_oak_county_ohio',
      summary: 'Exact address recorded with Clara Maple.',
      participants: [
        { person_id: 'per_arthur_alder', role: 'ancestor' },
        { person_id: 'per_clara_maple_living', role: 'descendant' },
      ],
      sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
    },
  ];

  const kinship: KinshipEdge[] = [
    { from: 'per_thomas_alder', to: 'per_arthur_alder', relation: 'parent' },
    { from: 'per_arthur_alder', to: 'per_helen_maple', relation: 'spouse' },
    { from: 'per_arthur_alder', to: 'per_clara_maple_living', relation: 'parent' },
  ];

  const media: MediaItem[] = [
    {
      id: 'med_living_photo',
      kind: 'family_photo',
      person_id: 'per_clara_maple_living',
      file: '/media/clara-photo.png',
      caption: 'Clara Maple portrait',
    },
  ];

  const narratives: Narrative[] = [];

  await Promise.all([
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(sources, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml(kinship, { sortDeterministic: true }), 'utf8'),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml(narratives, { sortById: true }), 'utf8'),
  ]);

  return repoDir;
}

describe('ops/telemetry', () => {
  it('records JSONL events, summarizes percentiles/rates, respects sinceHours, and formats table/JSON', async () => {
    const dir = await makeTempDir('kinloom-telemetry-');
    const telemetryFile = path.join(dir, 'calls.jsonl');
    const nowMs = Date.parse('2026-11-25T18:00:00.000Z');

    recordTelemetryEvent(
      {
        ts: '2026-11-25T17:00:00.000Z',
        subcmd: 'context',
        person_id: 'per_arthur_alder',
        duration_ms: 100,
        cache_hit: true,
        exit_code: 0,
        bytes_out: 1024,
      },
      { filePath: telemetryFile }
    );
    recordTelemetryEvent(
      {
        ts: '2026-11-25T17:10:00.000Z',
        subcmd: 'context',
        person_id: 'per_arthur_alder',
        duration_ms: 300,
        cache_hit: false,
        exit_code: 0,
        bytes_out: 2048,
      },
      { filePath: telemetryFile }
    );
    recordTelemetryEvent(
      {
        ts: '2026-11-25T17:20:00.000Z',
        subcmd: 'audit',
        person_id: 'per_arthur_alder',
        duration_ms: 600,
        cache_hit: null,
        exit_code: 1,
        bytes_out: 512,
      },
      { filePath: telemetryFile }
    );
    // Old event outside 2-hour window.
    recordTelemetryEvent(
      {
        ts: '2026-11-25T10:00:00.000Z',
        subcmd: 'sync',
        duration_ms: 9999,
        exit_code: 0,
      },
      { filePath: telemetryFile }
    );

    const { io, stdout } = createCaptureIo();
    const report = await runTelemetryReportCommand(
      { filePath: telemetryFile, sinceHours: 2, nowMs },
      io
    );

    expect(report.totalEvents).toBe(3);
    expect(report.rows).toEqual([
      {
        subcmd: 'audit',
        count: 1,
        p50_ms: 600,
        p95_ms: 600,
        total_ms: 600,
        cache_hit_pct: null,
        fail_pct: 100,
      },
      {
        subcmd: 'context',
        count: 2,
        p50_ms: 100,
        p95_ms: 300,
        total_ms: 400,
        cache_hit_pct: 50,
        fail_pct: 0,
      },
    ]);
    expect(stdout[0]).toContain('subcmd');
    expect(stdout[0]).toContain('50.0%');
    expect(stdout[0]).toContain('100.0%');

    const jsonReport = await runTelemetryReportCommand({
      filePath: telemetryFile,
      sinceHours: 2,
      json: true,
      nowMs,
    });
    const parsed = JSON.parse(jsonReport.rendered) as { totalEvents: number; rows: unknown[] };
    expect(parsed.totalEvents).toBe(3);
    expect(parsed.rows).toHaveLength(2);
  });

  it('measures command success/error and honors KINLOOM_TELEMETRY_PARENT suppression', async () => {
    const dir = await makeTempDir('kinloom-measure-');
    const telemetryFile = path.join(dir, 'calls.jsonl');
    process.env.KINLOOM_TELEMETRY_FILE = telemetryFile;

    expect(getTelemetryFilePath()).toBe(telemetryFile);

    const value = await measureCommand(
      {
        subcmd: 'context',
        personId: 'per_arthur_alder',
        extractResultMeta: (res) => ({ bytesOut: res.length, cacheHit: true }),
      },
      async () => 'brief-output'
    );
    expect(value).toBe('brief-output');

    await expect(
      measureCommand({ subcmd: 'context', personId: 'per_clara_maple_living' }, async () => {
        throw new CliValidationError('living person refused');
      })
    ).rejects.toThrow('living person refused');

    process.env.KINLOOM_TELEMETRY_PARENT = '1';
    recordTelemetryEvent({ subcmd: 'suppressed_cmd', duration_ms: 50 });

    const lines = (await readFile(telemetryFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]) as { subcmd: string; bytes_out: number; exit_code: number };
    const second = JSON.parse(lines[1]) as { subcmd: string; exit_code: number };
    expect(first.subcmd).toBe('context');
    expect(first.bytes_out).toBe(12);
    expect(first.exit_code).toBe(0);
    expect(second.exit_code).toBe(EXIT_USAGE);
  });
});

describe('ops/context', () => {
  it('refuses living target person with exit code 2', async () => {
    const repoDir = await createSyntheticRepo();
    let caught: unknown = null;
    try {
      await runContextCommand({ repoDir, personId: 'per_clara_maple_living' });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CliValidationError);
    expect((caught as CliValidationError).exitCode).toBe(2);
    expect((caught as CliValidationError).message).toContain('Privacy fence');
  });

  it('redacts living relatives, scrubs living names, and matches optional external facts dir', async () => {
    const repoDir = await createSyntheticRepo();
    const factsDir = await makeTempDir('kinloom-facts-');
    const recordImagesDir = path.join(factsDir, 'record_images');
    await mkdir(recordImagesDir, { recursive: true });

    const subjectImgPath = path.join(recordImagesDir, '100002_img_census.png');
    const parentImgPath = path.join(recordImagesDir, '100001_img_deed.png');
    const spouseDupImgPath = path.join(recordImagesDir, '100003_img_census.png');
    const spouseUniqueImgPath = path.join(recordImagesDir, '100003_img_obituary.png');
    await writeFile(subjectImgPath, makeMinimalPng(20, 20));
    await writeFile(parentImgPath, makeMinimalPng(20, 20));
    await writeFile(spouseDupImgPath, makeMinimalPng(20, 20));
    await writeFile(spouseUniqueImgPath, makeMinimalPng(20, 20));

    await writeFile(
      path.join(factsDir, '100002.json'),
      JSON.stringify({
        personDbId: '100002',
        fullName: 'Arthur Alder',
        isLiving: false,
        personCard: { FullName: 'Arthur Alder', LifeRange: '1858&ndash;1932' },
        facts: [
          { TypeString: 'Birth', Date: '12 Apr 1858', Place: 'Oak County, Ohio' },
          {
            TypeString: 'Child',
            Date: '1954',
            FactTargetPerson: { Id: '100004', FullName: 'Clara Maple', IsLiving: true },
          },
        ],
        sources: [{ Title: '1880 US Census', RecordImageId: 'img_census' }],
        recordImages: [{ RecordImageId: 'img_census', local: subjectImgPath, bytes: 42 }],
      }),
      'utf8'
    );
    await writeFile(
      path.join(factsDir, '100001.json'),
      JSON.stringify({
        personDbId: '100001',
        fullName: 'Thomas Alder',
        isLiving: false,
        sources: [{ Title: '1875 County Land Deed', RecordImageId: 'img_deed' }],
        recordImages: [{ RecordImageId: 'img_deed', local: parentImgPath, bytes: 42 }],
      }),
      'utf8'
    );
    await writeFile(
      path.join(factsDir, '100003.json'),
      JSON.stringify({
        personDbId: '100003',
        fullName: 'Helen Maple',
        isLiving: false,
        sources: [{ Title: '1940 Obituary', RecordImageId: 'img_obituary' }],
        recordImages: [
          { RecordImageId: 'img_census', local: spouseDupImgPath, bytes: 42 },
          { RecordImageId: 'img_obituary', local: spouseUniqueImgPath, bytes: 42 },
        ],
      }),
      'utf8'
    );

    const result = await runContextCommand({
      repoDir,
      personId: 'per_arthur_alder',
      ancestryDir: factsDir,
    });

    expect(result.context.relatives.parents).toEqual([
      {
        id: 'per_thomas_alder',
        full_name: 'Thomas Alder',
        lifespan: '1830-03-10 - 1902-11-04',
        gedcom_xref: '@I100001@',
      },
    ]);
    expect(result.context.relatives.children).toEqual([REDACTED_RELATIVE_LABEL]);
    expect(result.rendered).not.toContain('Clara Maple');

    const sharedEvent = result.context.events.find((e) => e.id === 'evt_arthur_living_visit');
    expect(sharedEvent?.edtf_date).toBe('1955');
    expect(sharedEvent?.place_id).toBeNull();
    expect(sharedEvent?.participants).toEqual([
      { person_id: 'per_arthur_alder', role: 'ancestor' },
      { person_id: REDACTED_RELATIVE_LABEL, role: 'descendant' },
    ]);

    expect(result.context.ancestry && !result.context.ancestry.redacted).toBe(true);
    if (result.context.ancestry && !result.context.ancestry.redacted) {
      expect(result.context.ancestry.redactedLivingFactsCount).toBe(1);
      expect(result.context.ancestry.facts).toHaveLength(1);
      expect(result.context.ancestry.recordImages.map((i) => i.recordImageId)).toEqual([
        'img_census',
      ]);
    }
    // Duplicate img_census on spouse is deduplicated; parent deed + spouse obituary remain.
    expect(result.context.relativeRecordImages.map((i) => i.recordImageId)).toEqual([
      'img_deed',
      'img_obituary',
    ]);
  });
});

describe('ops/integrate', () => {
  async function writeValidResearchPackage(repoDir: string): Promise<string> {
    const packageDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    const scansDir = path.join(packageDir, 'scans');
    await mkdir(scansDir, { recursive: true });
    await writeFile(path.join(scansDir, 'arthur-1932-death.png'), makeMinimalPng(800, 600, 12_000));

    const patch = {
      person_id: 'per_arthur_alder',
      person_updates: {
        alt_names: ['Arthur J. Alder'],
        summary: 'Ohio farmer documented in 1880 census and 1932 death record.',
      },
      places: [
        {
          id: 'plc_pine_township_ohio',
          slug: 'pine-township-ohio',
          name: 'Pine Township',
          full_name: 'Pine Township, Oak County, Ohio, USA',
          place_type: 'town',
          parent_id: 'plc_oak_county_ohio',
          lat: 40.28,
          lng: -82.81,
        },
      ],
      sources: [
        {
          id: 'src_1932_burial_log',
          citation: 'Oak Cemetery Burial Register, Book 4, p. 19',
          source_type: 'cemetery',
          repository: 'Oak County Historical Society',
        },
      ],
      media: [
        {
          id: 'med_arthur_death_scan',
          kind: 'document_scan',
          source_id: 'src_1932_death_cert',
          person_id: 'per_arthur_alder',
          file: '/media/arthur-1932-death.png',
          caption: '1932 death certificate scan for Arthur Alder',
        },
      ],
      events: [
        {
          id: 'evt_arthur_burial_1932',
          title: 'Burial of Arthur Alder at Oak Cemetery',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1932-09-21',
          place_id: 'plc_pine_township_ohio',
          summary: 'Interred three days after death in Pine Township.',
          participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
          sources: [{ source_id: 'src_1932_burial_log', confidence: 'high' }],
        },
      ],
      narratives: [
        {
          id: 'nar_arthur_alder_bio',
          slug: 'arthur-alder-biography',
          title: 'Arthur Alder (1858-1932)',
          summary: 'Archival biography of Arthur Alder.',
          person_ids: ['per_arthur_alder'],
          place_ids: ['plc_pine_township_ohio'],
          event_ids: ['evt_arthur_burial_1932'],
          source_ids: [],
          body_md:
            'Arthur Alder farmed in Oak County in 1880.[^src_1880_census] His death was recorded in 1932.[^src_1932_death_cert|med_arthur_death_scan]',
        },
      ],
    };

    await writeFile(path.join(packageDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');
    await writeFile(
      path.join(packageDir, 'dossier.md'),
      '# Arthur Alder Dossier\n\nClean synthetic notes with no private names.\n',
      'utf8'
    );
    return packageDir;
  }

  it('validates in dry-run without writing, then applies cleanly and auto-stamps narrative metadata', async () => {
    const repoDir = await createSyntheticRepo();
    await writeValidResearchPackage(repoDir);

    const dryRes = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: true,
    });
    expect(dryRes.ok).toBe(true);
    expect(dryRes.dryRun).toBe(true);
    expect(dryRes.inlineCitationCount).toBe(2);
    expect(dryRes.writtenYamlFiles).toEqual([]);
    expect(dryRes.stagedScans[0]?.status).toBe('would_stage');
    expect(dryRes.validation.livingLeaks).toBe(0);

    const applyRes = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: false,
    });
    expect(applyRes.writtenYamlFiles.length).toBeGreaterThanOrEqual(5);
    expect(applyRes.stagedScans[0]?.status).toBe('staged');

    const writtenNarratives = parseNarrativesYaml(
      await readFile(path.join(repoDir, 'data', 'narratives.yaml'), 'utf8')
    );
    expect(writtenNarratives).toHaveLength(1);
    expect(writtenNarratives[0].kind).toBe('biography');
    expect(writtenNarratives[0].subject_person_id).toBe('per_arthur_alder');
    expect(writtenNarratives[0].source_ids).toEqual(['src_1880_census', 'src_1932_death_cert']);

    const writtenPeople = parsePeopleYaml(
      await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8')
    );
    const arthur = writtenPeople.find((p) => p.id === 'per_arthur_alder');
    expect(arthur?.alt_names).toEqual(['Art Alder', 'Arthur J. Alder']);

    const writtenEvents = parseEventsYaml(
      await readFile(path.join(repoDir, 'data', 'events.yaml'), 'utf8')
    );
    expect(writtenEvents.some((e) => e.id === 'evt_arthur_burial_1932')).toBe(true);

    // Re-running apply is idempotent.
    const secondRes = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: false,
    });
    expect(secondRes.writtenYamlFiles).toEqual([]);
    expect(secondRes.stagedScans[0]?.status).toBe('unchanged');
  });

  it('rejects dangling inline citations and (0, 0) coordinates', async () => {
    const repoDir = await createSyntheticRepo();
    const packageDir = await writeValidResearchPackage(repoDir);
    const patchPath = path.join(packageDir, 'patch.json');

    const basePatch = JSON.parse(await readFile(patchPath, 'utf8')) as {
      narratives: Array<{ body_md: string }>;
      places: Array<{ lat: number; lng: number }>;
    };

    const badCitationPatch = structuredClone(basePatch);
    badCitationPatch.narratives[0].body_md = 'Uncited claim.[^src_does_not_exist]';
    await writeFile(patchPath, JSON.stringify(badCitationPatch, null, 2), 'utf8');
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("unknown inline source_id 'src_does_not_exist'");

    const badZeroPlacePatch = structuredClone(basePatch);
    badZeroPlacePatch.places[0].lat = 0;
    badZeroPlacePatch.places[0].lng = 0;
    await writeFile(patchPath, JSON.stringify(badZeroPlacePatch, null, 2), 'utf8');
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow('forbidden (0, 0) coordinates');
  });

  it('retires superseded source stubs via per-event and top-level remove_source_ids without breaking citations', async () => {
    const repoDir = await createSyntheticRepo();
    const sourcesPath = path.join(repoDir, 'data', 'sources.yaml');
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');

    // Add a synthetic GEDCOM stub source attached to Arthur's 1880 census event.
    const baseSources = parseSourcesYaml(await readFile(sourcesPath, 'utf8'));
    baseSources.push({
      id: 'src_ged_stub_1880',
      citation: 'Unsourced GEDCOM import stub',
      source_type: 'other',
    });
    await writeFile(sourcesPath, serializeSourcesYaml(baseSources, { sortById: true }), 'utf8');

    const baseEvents = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    const censusEvent = baseEvents.find((e) => e.id === 'evt_arthur_1880_census');
    expect(censusEvent).toBeDefined();
    censusEvent!.sources = [
      { source_id: 'src_ged_stub_1880', confidence: 'low' },
      { source_id: 'src_1880_census', confidence: 'high' },
    ];
    await writeFile(eventsPath, serializeEventsYaml(baseEvents, { sortById: true }), 'utf8');

    const packageDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(packageDir, { recursive: true });
    const patchPath = path.join(packageDir, 'patch.json');

    // 1. Dry-run and apply: retire src_ged_stub_1880 from event AND remove unreferenced stub from sources.yaml.
    const retirePatch = {
      person_id: 'per_arthur_alder',
      sources: [
        {
          id: 'src_1880_census_schedule',
          citation: '1880 U.S. Federal Census Schedule 1, Oak County, Ohio, ED 4, Sheet 9',
          source_type: 'census',
          repository: 'NARA',
        },
      ],
      remove_source_ids: ['src_ged_stub_1880'],
      events: [
        {
          id: 'evt_arthur_1880_census',
          title: '1880 Federal Census household in Oak County',
          scope: 'personal',
          event_kind: 'residence_anchor',
          edtf_date: '1880-06-15',
          place_id: 'plc_oak_county_ohio',
          summary: 'Arthur Alder farmed in Oak County.',
          participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
          sources: [{ source_id: 'src_1880_census_schedule', confidence: 'high' }],
          remove_source_ids: ['src_ged_stub_1880'],
        },
      ],
    };
    await writeFile(patchPath, JSON.stringify(retirePatch, null, 2), 'utf8');

    const dryRun = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: true,
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.removedSourceIds).toEqual(['src_ged_stub_1880']);
    expect(dryRun.writtenYamlFiles).toEqual([]);

    // Audit also accepts remove_source_ids cleanly.
    const eventsAfterDry = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    expect(
      eventsAfterDry
        .find((e) => e.id === 'evt_arthur_1880_census')
        ?.sources.map((s) => s.source_id)
    ).toEqual(['src_ged_stub_1880', 'src_1880_census']);

    const applied = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: false,
    });
    expect(applied.ok).toBe(true);
    expect(applied.removedSourceIds).toEqual(['src_ged_stub_1880']);

    const updatedEvents = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    expect(
      updatedEvents
        .find((e) => e.id === 'evt_arthur_1880_census')
        ?.sources.map((s) => s.source_id)
    ).toEqual(['src_1880_census', 'src_1880_census_schedule']);

    const updatedSources = parseSourcesYaml(await readFile(sourcesPath, 'utf8'));
    expect(updatedSources.some((s) => s.id === 'src_ged_stub_1880')).toBe(false);
    expect(updatedSources.some((s) => s.id === 'src_1880_census_schedule')).toBe(true);

    // 2. Reject top-level removal of a source still cited by an event or narrative.
    const brokenRemovePatch = {
      person_id: 'per_arthur_alder',
      remove_source_ids: ['src_1880_census'],
    };
    await writeFile(patchPath, JSON.stringify(brokenRemovePatch, null, 2), 'utf8');
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("Cannot remove source 'src_1880_census'");

    // 3. Reject conflicting add + remove on the same event.
    const conflictingEventPatch = {
      person_id: 'per_arthur_alder',
      events: [
        {
          id: 'evt_arthur_1880_census',
          title: '1880 Federal Census household in Oak County',
          scope: 'personal',
          event_kind: 'residence_anchor',
          edtf_date: '1880-06-15',
          place_id: 'plc_oak_county_ohio',
          summary: 'Arthur Alder farmed in Oak County.',
          participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
          sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
          remove_source_ids: ['src_1880_census'],
        },
      ],
    };
    await writeFile(patchPath, JSON.stringify(conflictingEventPatch, null, 2), 'utf8');
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("cannot both attach and remove source 'src_1880_census'");
  });

  it('retires duplicate events and legacy media via remove_event_ids and remove_media_ids with dangling-ref guards', async () => {
    const repoDir = await createSyntheticRepo();
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');

    // Seed a duplicate event stub, a legacy media record linked to it, and a narrative citing both.
    const baseEvents = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    baseEvents.push({
      id: 'evt_arthur_1880_dup',
      title: 'Duplicate 1880 census stub',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1880',
      place_id: 'plc_oak_county_ohio',
      summary: 'Duplicate GEDCOM stub to retire.',
      participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
      sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
    });
    await writeFile(eventsPath, serializeEventsYaml(baseEvents, { sortById: true }), 'utf8');

    const baseMedia = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    baseMedia.push({
      id: 'med_legacy_uncropped',
      kind: 'document_scan',
      source_id: 'src_1880_census',
      person_id: 'per_arthur_alder',
      event_id: 'evt_arthur_1880_dup',
      file: '/media/legacy-uncropped.png',
      caption: 'Legacy uncropped scan',
    });
    await writeFile(mediaPath, serializeMediaYaml(baseMedia, { sortById: true }), 'utf8');

    const baseNarratives: Narrative[] = [
      {
        id: 'nar_arthur_bio',
        slug: 'arthur-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_arthur_alder',
        title: 'Arthur Alder Biography',
        person_ids: ['per_arthur_alder'],
        place_ids: ['plc_oak_county_ohio'],
        event_ids: ['evt_arthur_1880_census', 'evt_arthur_1880_dup'],
        source_ids: ['src_1880_census'],
        body_md: 'Arthur Alder farmed in Oak County.[^src_1880_census|med_legacy_uncropped]',
      },
    ];
    await writeFile(
      narrativesPath,
      serializeNarrativesYaml(baseNarratives, { sortById: true }),
      'utf8'
    );

    const packageDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(packageDir, { recursive: true });
    const patchPath = path.join(packageDir, 'patch.json');

    // 1. Refuse conflicting add/update + remove in the same patch.
    await writeFile(
      patchPath,
      JSON.stringify({
        person_id: 'per_arthur_alder',
        events: [
          {
            id: 'evt_arthur_1880_dup',
            title: 'Duplicate 1880 census stub',
            scope: 'personal',
            event_kind: 'point_event',
            edtf_date: '1880',
            place_id: 'plc_oak_county_ohio',
            summary: 'Updated stub.',
            participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
            sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
          },
        ],
        remove_event_ids: ['evt_arthur_1880_dup'],
      }),
      'utf8'
    );
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("cannot both add/update and remove event 'evt_arthur_1880_dup'");

    await writeFile(
      patchPath,
      JSON.stringify({
        person_id: 'per_arthur_alder',
        media: [
          {
            id: 'med_legacy_uncropped',
            kind: 'document_scan',
            source_id: 'src_1880_census',
            person_id: 'per_arthur_alder',
            file: '/media/legacy-uncropped.png',
            caption: 'Legacy scan',
          },
        ],
        remove_media_ids: ['med_legacy_uncropped'],
      }),
      'utf8'
    );
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("cannot both add/update and remove media 'med_legacy_uncropped'");

    // 2. Refuse removing an event still referenced by surviving media.event_id.
    await writeFile(
      patchPath,
      JSON.stringify({
        person_id: 'per_arthur_alder',
        remove_event_ids: ['evt_arthur_1880_dup'],
      }),
      'utf8'
    );
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("Cannot remove event 'evt_arthur_1880_dup': media 'med_legacy_uncropped' still references it");

    // 3. Refuse removing a media item still cited inline by a surviving narrative.
    await writeFile(
      patchPath,
      JSON.stringify({
        person_id: 'per_arthur_alder',
        remove_media_ids: ['med_legacy_uncropped'],
      }),
      'utf8'
    );
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("Cannot remove media 'med_legacy_uncropped': narrative 'nar_arthur_bio' still cites it inline");

    // 4. Refuse removing an event still listed in surviving narrative.event_ids (even after removing media & updating inline citation).
    await writeFile(
      patchPath,
      JSON.stringify({
        person_id: 'per_arthur_alder',
        remove_event_ids: ['evt_arthur_1880_dup'],
        remove_media_ids: ['med_legacy_uncropped'],
        narratives: [
          {
            id: 'nar_arthur_bio',
            slug: 'arthur-alder-bio',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Arthur Alder Biography',
            person_ids: ['per_arthur_alder'],
            place_ids: ['plc_oak_county_ohio'],
            event_ids: ['evt_arthur_1880_census', 'evt_arthur_1880_dup'],
            source_ids: ['src_1880_census'],
            body_md: 'Arthur Alder farmed in Oak County.[^src_1880_census]',
          },
        ],
      }),
      'utf8'
    );
    await expect(
      runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: true })
    ).rejects.toThrow("Narrative 'nar_arthur_bio' references missing event_id 'evt_arthur_1880_dup'");

    // 5. Dry-run and apply succeed once narrative drops the retired event and media references.
    const cleanRetirePatch = {
      person_id: 'per_arthur_alder',
      remove_event_ids: ['evt_arthur_1880_dup'],
      remove_media_ids: ['med_legacy_uncropped'],
      narratives: [
        {
          id: 'nar_arthur_bio',
          slug: 'arthur-alder-bio',
          kind: 'biography',
          subject_person_id: 'per_arthur_alder',
          title: 'Arthur Alder Biography',
          person_ids: ['per_arthur_alder'],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: ['evt_arthur_1880_census'],
          source_ids: ['src_1880_census'],
          body_md: 'Arthur Alder farmed in Oak County.[^src_1880_census]',
        },
      ],
    };
    await writeFile(patchPath, JSON.stringify(cleanRetirePatch, null, 2), 'utf8');

    const dryRes = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: true,
      json: true,
    });
    expect(dryRes.ok).toBe(true);
    expect(dryRes.removedEvents).toBe(1);
    expect(dryRes.removedMedia).toBe(1);
    expect(dryRes.removedEventIds).toEqual(['evt_arthur_1880_dup']);
    expect(dryRes.removedMediaIds).toEqual(['med_legacy_uncropped']);
    expect(dryRes.writtenYamlFiles).toEqual([]);

    // Files on disk are untouched after dry-run.
    expect(
      parseEventsYaml(await readFile(eventsPath, 'utf8')).some(
        (e) => e.id === 'evt_arthur_1880_dup'
      )
    ).toBe(true);
    expect(
      parseMediaYaml(await readFile(mediaPath, 'utf8')).some(
        (m) => m.id === 'med_legacy_uncropped'
      )
    ).toBe(true);

    const applied = await runIntegrateCommand({
      repoDir,
      personId: 'per_arthur_alder',
      dryRun: false,
      json: true,
    });
    expect(applied.ok).toBe(true);
    expect(applied.removedEvents).toBe(1);
    expect(applied.removedMedia).toBe(1);
    expect(applied.writtenYamlFiles.some((f) => f.endsWith('events.yaml'))).toBe(true);
    expect(applied.writtenYamlFiles.some((f) => f.endsWith('media.yaml'))).toBe(true);

    const finalEvents = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    expect(finalEvents.some((e) => e.id === 'evt_arthur_1880_dup')).toBe(false);
    expect(finalEvents.some((e) => e.id === 'evt_arthur_1880_census')).toBe(true);

    const finalMedia = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    expect(finalMedia.some((m) => m.id === 'med_legacy_uncropped')).toBe(false);
    expect(finalMedia.some((m) => m.id === 'med_living_photo')).toBe(true);
  });
});

describe('ops/dates', () => {
  it('computes exact historical weekdays across 1600-2100 including leap days', () => {
    const cases: Array<[string, string, string, boolean]> = [
      ['1600-02-29', 'Tuesday', 'Tuesday, 29 February 1600', true],
      ['1776-07-04', 'Thursday', 'Thursday, 4 July 1776', true],
      ['1898-02-07', 'Monday', 'Monday, 7 February 1898', false],
      ['1904-02-29', 'Monday', 'Monday, 29 February 1904', true],
      ['1980-11-05', 'Wednesday', 'Wednesday, 5 November 1980', true],
      ['2000-02-29', 'Tuesday', 'Tuesday, 29 February 2000', true],
      ['2026-11-25', 'Wednesday', 'Wednesday, 25 November 2026', false],
      ['2100-03-01', 'Monday', 'Monday, 1 March 2100', false],
    ];

    for (const [date, weekday, formatted, leap] of cases) {
      const res = runDatesCommand({ subcommand: 'weekday', date });
      expect(res.subcommand).toBe('weekday');
      if (res.subcommand === 'weekday') {
        expect(res.weekday).toBe(weekday);
        expect(res.formatted).toBe(formatted);
        expect(res.isLeapYear).toBe(leap);
        expect(res.rendered).toBe(formatted);
      }
    }

    // Century non-leap years must reject Feb 29.
    expect(() => runDatesCommand({ subcommand: 'weekday', date: '1900-02-29' })).toThrow(
      CliValidationError
    );
    expect(() => runDatesCommand({ subcommand: 'weekday', date: '2100-02-29' })).toThrow(
      CliValidationError
    );
  });

  it('computes exact forward, reversed, same-day, and leap-day boundary diffs', () => {
    const forward = runDatesCommand({
      subcommand: 'diff',
      startDate: '1898-02-07',
      endDate: '1980-11-05',
      json: true,
    });
    expect(forward.subcommand).toBe('diff');
    if (forward.subcommand === 'diff') {
      expect(forward.totalDays).toBe(30221);
      expect(forward.absDays).toBe(30221);
      expect(forward.years).toBe(82);
      expect(forward.remainingDays).toBe(272);
      expect(forward.yearsMonthsDays).toEqual({ years: 82, months: 8, days: 29 });
      expect(forward.startWeekday).toBe('Monday');
      expect(forward.endWeekday).toBe('Wednesday');
      expect(forward.direction).toBe('forward');
      expect(forward.reversed).toBe(false);
    }

    const reversed = runDatesCommand({
      subcommand: 'diff',
      startDate: '1980-11-05',
      endDate: '1898-02-07',
    });
    expect(reversed.subcommand).toBe('diff');
    if (reversed.subcommand === 'diff') {
      expect(reversed.totalDays).toBe(-30221);
      expect(reversed.absDays).toBe(30221);
      expect(reversed.years).toBe(82);
      expect(reversed.remainingDays).toBe(272);
      expect(reversed.yearsMonthsDays).toEqual({ years: 82, months: 8, days: 29 });
      expect(reversed.direction).toBe('reversed');
      expect(reversed.reversed).toBe(true);
      expect(reversed.rendered.startsWith('-82 years, 272 days (-30221 total days;')).toBe(true);
    }

    const leapBefore = runDatesCommand({
      subcommand: 'diff',
      startDate: '1904-02-29',
      endDate: '1905-02-28',
    });
    if (leapBefore.subcommand === 'diff') {
      expect(leapBefore.totalDays).toBe(365);
      expect(leapBefore.years).toBe(0);
      expect(leapBefore.remainingDays).toBe(365);
      expect(leapBefore.yearsMonthsDays).toEqual({ years: 0, months: 11, days: 30 });
    }

    const leapAfter = runDatesCommand({
      subcommand: 'diff',
      startDate: '1904-02-29',
      endDate: '1905-03-01',
    });
    if (leapAfter.subcommand === 'diff') {
      expect(leapAfter.totalDays).toBe(366);
      expect(leapAfter.years).toBe(1);
      expect(leapAfter.remainingDays).toBe(0);
      expect(leapAfter.yearsMonthsDays).toEqual({ years: 1, months: 0, days: 0 });
    }

    const leapQuad = runDatesCommand({
      subcommand: 'diff',
      startDate: '1904-02-29',
      endDate: '1908-02-29',
    });
    if (leapQuad.subcommand === 'diff') {
      expect(leapQuad.totalDays).toBe(1461);
      expect(leapQuad.years).toBe(4);
      expect(leapQuad.remainingDays).toBe(0);
      expect(leapQuad.yearsMonthsDays).toEqual({ years: 4, months: 0, days: 0 });
    }

    const jan31ToMar1 = runDatesCommand({
      subcommand: 'diff',
      startDate: '2024-01-31',
      endDate: '2024-03-01',
    });
    if (jan31ToMar1.subcommand === 'diff') {
      expect(jan31ToMar1.totalDays).toBe(30);
      expect(jan31ToMar1.yearsMonthsDays).toEqual({ years: 0, months: 1, days: 1 });
    }
  });

  it('computes completed ages for one or multiple event dates including pre-birth dates', () => {
    const res = runDatesCommand({
      subcommand: 'age',
      birthDate: '1898-02-07',
      atDates: ['1920-01-01', '1940-04-01', '1980-11-05', '1897-02-07'],
      json: true,
    });
    expect(res.subcommand).toBe('age');
    if (res.subcommand === 'age') {
      expect(res.birthWeekday).toBe('Monday');
      expect(res.ages).toHaveLength(4);
      expect(res.ages[0]).toMatchObject({
        at: '1920-01-01',
        years: 21,
        remainingDays: 328,
        totalDays: 7997,
        beforeBirth: false,
      });
      expect(res.ages[1]).toMatchObject({
        at: '1940-04-01',
        years: 42,
        remainingDays: 54,
        totalDays: 15393,
        beforeBirth: false,
      });
      expect(res.ages[2]).toMatchObject({
        at: '1980-11-05',
        years: 82,
        remainingDays: 272,
        totalDays: 30221,
        beforeBirth: false,
      });
      expect(res.ages[3]).toMatchObject({
        at: '1897-02-07',
        years: -1,
        totalDays: -365,
        beforeBirth: true,
      });
    }
  });
});

describe('ops/audit', () => {
  it('passes all 5 checks in-process on a valid synthetic package', async () => {
    const repoDir = await createSyntheticRepo();
    const packageDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    const scansDir = path.join(packageDir, 'scans');
    await mkdir(scansDir, { recursive: true });
    await writeFile(path.join(scansDir, 'arthur-1932-death.png'), makeMinimalPng(640, 480, 12_000));

    // Remove the synthetic 1955 living visit event so chronology has no post-death non-burial event.
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const filteredEvents = parseEventsYaml(await readFile(eventsPath, 'utf8')).filter(
      (e) => e.id !== 'evt_arthur_living_visit'
    );
    await writeFile(eventsPath, serializeEventsYaml(filteredEvents, { sortById: true }), 'utf8');

    const patch = {
      person_id: 'per_arthur_alder',
      media: [
        {
          id: 'med_arthur_death_scan',
          kind: 'document_scan',
          source_id: 'src_1932_death_cert',
          person_id: 'per_arthur_alder',
          file: '/media/arthur-1932-death.png',
          caption: '1932 death certificate scan',
        },
      ],
      events: [
        {
          id: 'evt_arthur_burial',
          title: 'Burial of Arthur Alder',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1932-09-21',
          place_id: 'plc_oak_county_ohio',
          summary: 'Buried in Oak County cemetery.',
          participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
          sources: [{ source_id: 'src_1932_death_cert', confidence: 'high' }],
        },
      ],
      narratives: [
        {
          id: 'nar_arthur_bio',
          slug: 'arthur-alder-bio',
          title: 'Arthur Alder Biography',
          person_ids: ['per_arthur_alder'],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: ['evt_arthur_burial'],
          source_ids: ['src_1880_census', 'src_1932_death_cert'],
          body_md:
            '## Overview\n\nArthur Alder resided in Oak County in 1880.[^src_1880_census] He died on September 18, 1932, and was buried three days later.[^src_1932_death_cert|med_arthur_death_scan]',
        },
      ],
    };
    await writeFile(path.join(packageDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');

    const audit = await runAuditCommand({ repoDir, personId: 'per_arthur_alder' });
    expect(audit.ok).toBe(true);
    expect(audit.strictOk).toBe(true);
    expect(audit.checks.chronology.ok).toBe(true);
    expect(audit.checks.chronology.lifespan.years).toBe(74);
    expect(audit.checks.privacy.ok).toBe(true);
    expect(audit.checks.citations.ok).toBe(true);
    expect(audit.checks.citations.citedSentences).toBe(2);
    expect(audit.checks.scans.ok).toBe(true);
    expect(audit.checks.scans.files[0]?.width).toBe(640);
    expect(audit.checks.scans.files[0]?.height).toBe(480);
    expect(audit.checks.dryRun.ok).toBe(true);
    expect(audit.checks.dryRun.inlineCitationCount).toBe(2);
  });

  it('catches chronology, privacy/style, uncited prose, bad scan headers, and dry-run failures', async () => {
    const repoDir = await createSyntheticRepo();
    const packageDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    const scansDir = path.join(packageDir, 'scans');
    await mkdir(scansDir, { recursive: true });
    await writeFile(path.join(scansDir, 'corrupt.png'), Buffer.from('not-a-real-image-file-bytes'));

    const patch = {
      person_id: 'per_arthur_alder',
      media: [
        {
          id: 'med_bad_scan',
          kind: 'document_scan',
          source_id: 'src_1880_census',
          person_id: 'per_arthur_alder',
          file: '/media/corrupt.png',
          caption: 'Corrupt scan',
        },
      ],
      events: [
        {
          id: 'evt_impossible_marriage',
          title: 'Marriage of Arthur Alder',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1865-05-01',
          place_id: 'plc_oak_county_ohio',
          summary: 'Impossible marriage at age 7.',
          participants: [{ person_id: 'per_arthur_alder', role: 'groom' }],
          sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
        },
        {
          id: 'evt_prebirth_work',
          title: 'Farm labor in Oak County',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1850-01-01',
          place_id: 'plc_oak_county_ohio',
          summary: 'Predates birth.',
          participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
          sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
        },
      ],
      narratives: [
        {
          id: 'nar_broken',
          slug: 'broken-bio',
          title: 'Broken Bio',
          person_ids: ['per_arthur_alder'],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: [],
          source_ids: ['src_1880_census'],
          body_md:
            'Arthur Alder met Clara Maple \u2014 call (555) 234-5678 or SSN 123-45-6789 for notes. This sentence has no citation at all. Broken ref.[^src_missing]',
        },
      ],
    };

    await writeFile(path.join(packageDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');

    const audit = await runAuditCommand({ repoDir, personId: 'per_arthur_alder', json: true });
    expect(audit.ok).toBe(false);
    expect(audit.strictOk).toBe(false);
    expect(audit.checks.chronology.ok).toBe(false);
    expect(audit.checks.chronology.errors.some((e) => e.includes('implausible age'))).toBe(true);
    expect(audit.checks.chronology.errors.some((e) => e.includes('predates birth'))).toBe(true);
    expect(audit.checks.privacy.ok).toBe(false);
    expect(audit.checks.privacy.livingNameHits.length).toBeGreaterThan(0);
    expect(audit.checks.privacy.ssnHits).toHaveLength(1);
    expect(audit.checks.privacy.phoneHits).toHaveLength(1);
    expect(audit.checks.privacy.emDashCount).toBe(1);
    expect(audit.checks.citations.ok).toBe(false);
    expect(audit.checks.citations.uncitedCount).toBe(2);
    expect(audit.checks.scans.ok).toBe(false);
    expect(audit.checks.dryRun.ok).toBe(false);
    expect(audit.checks.dryRun.error).toContain("unknown inline source_id 'src_missing'");

    const jpegHeader = inspectImageBuffer(makeMinimalJpeg(320, 240));
    expect(jpegHeader).toEqual({
      valid: true,
      format: 'jpeg',
      width: 320,
      height: 240,
      error: null,
    });
  });
});

describe('ops/sync', () => {
  it('parses wrangler.jsonc with comments/trailing commas and validates safe temp-token cleanup SQL', async () => {
    const dir = await makeTempDir('kinloom-wrangler-');
    const jsonc = `{
      // Synthetic archive worker config
      "name": "alder-archive",
      "d1_databases": [
        { "binding": "DB", "database_name": "alder-archive-db", },
      ],
      /* R2 bucket for media + compiled cache */
      "r2_buckets": [
        { "binding": "MEDIA", "bucket_name": "alder-archive-media", },
      ],
      "routes": [
        { "pattern": "alder.example.org/*", "custom_domain": true, },
      ],
    }`;
    await writeFile(path.join(dir, 'wrangler.jsonc'), jsonc, 'utf8');

    expect(() => JSON.parse(stripJsoncCommentsAndTrailingCommas(jsonc))).not.toThrow();

    const bindings = loadWranglerBindings(dir);
    expect(bindings.dbName).toBe('alder-archive-db');
    expect(bindings.r2Bucket).toBe('alder-archive-media');
    expect(bindings.baseUrl).toBe('https://alder.example.org');

    const overridden = loadWranglerBindings(dir, 'https://staging.example.org/');
    expect(overridden.baseUrl).toBe('https://staging.example.org');

    const readTok = generateTempToken('read_backup');
    const writeTok = generateTempToken('write_batch');
    expect(readTok.tokenId.startsWith('tmp_sync_read_')).toBe(true);
    expect(writeTok.tokenId.startsWith('tmp_sync_')).toBe(true);

    const insertSql = buildTempTokenInsertSql([readTok, writeTok], '2026-11-25T18:00:00.000Z');
    expect(insertSql).toContain(readTok.tokenId);
    expect(insertSql).not.toContain(readTok.rawToken);

    const cleanupSql = buildTempTokenCleanupSql([readTok.tokenId, writeTok.tokenId]);
    expect(cleanupSql).toContain(`DELETE FROM agent_tokens WHERE token_id = '${readTok.tokenId}';`);
    expect(cleanupSql).toContain(`DELETE FROM agent_tokens WHERE token_id = '${writeTok.tokenId}';`);
    expect(cleanupSql).toContain("label = 'github-actions-nightly-backup'");

    // Must refuse to delete any permanent/non-temp token ID.
    expect(() => buildTempTokenCleanupSql(['tok_permanent_backup'])).toThrow('SAFETY REFUSAL');

    expect(parseEntityTypeList('narratives,places,people')).toEqual(['place', 'person', 'narrative']);
    expect(parseDeleteTargets('narrative:nar_old,event:evt_stale')).toEqual([
      { entity_type: 'narrative', entity_id: 'nar_old' },
      { entity_type: 'event', entity_id: 'evt_stale' },
    ]);
  });

  it('computes entity diff plan and executes end-to-end sync with guaranteed temp-token cleanup', async () => {
    const repoDir = await createSyntheticRepo();
    await mkdir(path.join(repoDir, 'media'), { recursive: true });
    await writeFile(path.join(repoDir, 'media', 'arthur-scan.png'), makeMinimalPng(100, 100));

    // Add a non-living media item so sync-missing-media can upload it.
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    await writeFile(
      mediaPath,
      serializeMediaYaml(
        [
          {
            id: 'med_arthur_scan',
            kind: 'document_scan',
            person_id: 'per_arthur_alder',
            file: '/media/arthur-scan.png',
            caption: 'Arthur census scan',
          },
          {
            id: 'med_living_photo',
            kind: 'family_photo',
            person_id: 'per_clara_maple_living',
            file: '/media/clara-photo.png',
            caption: 'Clara living photo',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [{ database_name: 'alder-db' }],
        r2_buckets: [{ bucket_name: 'alder-media' }],
        routes: [{ pattern: 'alder.example.org/*' }],
      }),
      'utf8'
    );

    const wranglerCalls: string[][] = [];
    const execWrangler: WranglerExecutor = async (_bin, args) => {
      wranglerCalls.push([...args]);
      if (args[0] === 'd1') {
        const sql = args[args.indexOf('--command') + 1] ?? '';
        if (sql.includes('DELETE FROM agent_tokens')) {
          return {
            stdout: JSON.stringify([
              { success: true, results: [] },
              { success: true, results: [] },
              { success: true, results: [{ count: 1 }] },
              { success: true, results: [{ count: 0 }] },
            ]),
            stderr: '',
          };
        }
        return {
          stdout: JSON.stringify([
            { success: true, results: [] },
            { success: true, results: [] },
          ]),
          stderr: '',
        };
      }
      return { stdout: 'ok', stderr: '' };
    };

    const postedBatches: unknown[] = [];
    const seenAuthHeaders: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const auth =
        init?.headers && !Array.isArray(init.headers) && !(init.headers instanceof Headers)
          ? (init.headers as Record<string, string>).Authorization
          : undefined;
      if (auth) {
        seenAuthHeaders.push(auth);
      }

      if (url.endsWith('/api/export/snapshot')) {
        return new Response(
          JSON.stringify({
            head_revision_id: 5,
            entities: [
              {
                entity_type: 'place',
                entity_id: 'plc_oak_county_ohio',
                current_revision_id: 2,
                has_primary_source: true,
                deleted_at: null,
                data: {
                  id: 'plc_oak_county_ohio',
                  slug: 'oak-county-ohio',
                  name: 'Oak County Old Name',
                  full_name: 'Oak County, Ohio, USA',
                  place_type: 'county',
                  parent_id: null,
                  lat: 40.25,
                  lng: -82.85,
                  historical_names: [],
                },
              },
            ],
            kinship: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', etag: '"rev-5"' } }
        );
      }

      if (url.includes('/media/arthur-scan.png')) {
        return new Response(null, { status: 404 });
      }

      if (url.endsWith('/api/batches')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { batch_id: string; patches: unknown[] };
        postedBatches.push(body);
        return new Response(
          JSON.stringify({
            batch_id: body.batch_id,
            head_revision_id: 6,
            etag: '"rev-6"',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/bundle')) {
        return new Response(
          JSON.stringify({
            meta: {
              max_revision_id: 6,
              counts: { people: 4, living_redacted: 1, events: 2, residence_spans: 0, places: 1, sources: 2 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', etag: '"rev-6-compiled"' } }
        );
      }

      return new Response('not found', { status: 404 });
    };

    const result = await runSyncCommand({
      repoDir,
      syncMissingMedia: true,
      chunkSize: 10,
      fetchImpl,
      execWrangler,
    });

    expect(result.baseUrl).toBe('https://alder.example.org');
    expect(result.countsByType.place?.update).toBe(1);
    expect(result.countsByType.person?.skippedLiving).toBe(1);
    expect(result.filteredOutLivingMedia).toBe(1);
    expect(result.media.uploadedKeys).toEqual(['media/arthur-scan.png']);
    expect(result.totalPatches).toBe(12);
    expect(result.plannedBatches).toBe(2);
    expect(postedBatches).toHaveLength(2);
    expect(result.recompile?.etag).toBe('"rev-6-compiled"');
    expect(result.cleanup?.remainingTmpCount).toBe(0);
    expect(result.cleanup?.backupCount).toBe(1);
    expect(result.cleanup?.deletedTokenIds).toHaveLength(2);

    // Verify R2 compiled bundle was purged and raw tokens never appear in output.
    expect(
      wranglerCalls.some((c) => c[0] === 'r2' && c[2] === 'delete' && c[3] === 'alder-media/compiled/archive.json')
    ).toBe(true);
    const serialized = JSON.stringify(result);
    for (const authHeader of seenAuthHeaders) {
      const rawToken = authHeader.replace(/^Bearer\s+/, '');
      expect(serialized).not.toContain(rawToken);
      expect(result.rendered).not.toContain(rawToken);
    }

    // Also verify direct diff engine helper handles explicitDeletes cleanly.
    const localEntries = buildSanitizedLocalEntries({
      siteConfig: makeSampleSiteConfig(),
      places: [],
      sources: [],
      people: [],
      events: [],
      kinship: [],
      media: [],
      narratives: [],
    });
    const remoteByType = indexRemoteSnapshot({
      head_revision_id: 9,
      entities: [
        {
          entity_type: 'narrative',
          entity_id: 'nar_obsolete',
          current_revision_id: 9,
          deleted_at: null,
          data: {
            id: 'nar_obsolete',
            slug: 'obsolete',
            title: 'Obsolete',
            body_md: 'Old text.',
            person_ids: [],
            place_ids: [],
            event_ids: [],
            source_ids: [],
          },
        },
      ],
      kinship: [],
    });
    const plan = computeSyncPlan({
      selectedTypes: ['narrative'],
      localByType: localEntries.byType,
      remoteByType,
      includeLiving: false,
      allowDeletes: false,
      explicitDeletes: [{ entity_type: 'narrative', entity_id: 'nar_obsolete' }],
    });
    expect(plan.patches).toEqual([
      {
        action: 'delete',
        entity_type: 'narrative',
        entity_id: 'nar_obsolete',
        parent_revision_id: 9,
      },
    ]);
  });

  it('always cleans up temp tokens in finally even when snapshot fetch fails', async () => {
    const repoDir = await createSyntheticRepo();
    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [{ database_name: 'alder-db' }],
        r2_buckets: [{ bucket_name: 'alder-media' }],
        routes: [{ pattern: 'alder.example.org/*' }],
      }),
      'utf8'
    );

    let sawCleanupDelete = false;
    const execWrangler: WranglerExecutor = async (_bin, args) => {
      const sql = args[args.indexOf('--command') + 1] ?? '';
      if (sql.includes('DELETE FROM agent_tokens')) {
        sawCleanupDelete = true;
        return {
          stdout: JSON.stringify([
            { success: true, results: [] },
            { success: true, results: [] },
            { success: true, results: [{ count: 1 }] },
            { success: true, results: [{ count: 0 }] },
          ]),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify([
          { success: true, results: [] },
          { success: true, results: [] },
        ]),
        stderr: '',
      };
    };

    const failingFetch: typeof fetch = async () =>
      new Response('upstream failure', { status: 500 });

    await expect(
      runSyncCommand({ repoDir, fetchImpl: failingFetch, execWrangler })
    ).rejects.toThrow('GET /api/export/snapshot failed with HTTP 500');
    expect(sawCleanupDelete).toBe(true);
  });

  it('supports --verify-live for both passing and failing probes while always revoking temp tokens', async () => {
    const repoDir = await createSyntheticRepo();
    await mkdir(path.join(repoDir, 'media'), { recursive: true });
    await writeFile(path.join(repoDir, 'media', 'arthur-scan.png'), makeMinimalPng(100, 100));
    await writeFile(
      path.join(repoDir, 'data', 'media.yaml'),
      serializeMediaYaml(
        [
          {
            id: 'med_arthur_scan',
            kind: 'document_scan',
            person_id: 'per_arthur_alder',
            file: '/media/arthur-scan.png',
            caption: 'Arthur census scan',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({
        d1_databases: [{ database_name: 'alder-db' }],
        r2_buckets: [{ bucket_name: 'alder-media' }],
        routes: [{ pattern: 'alder.example.org/*' }],
      }),
      'utf8'
    );

    const makeWranglerMock = () => {
      const events: string[] = [];
      const execWrangler: WranglerExecutor = async (_bin, args) => {
        if (args[0] === 'd1') {
          const sql = args[args.indexOf('--command') + 1] ?? '';
          if (sql.includes('DELETE FROM agent_tokens')) {
            events.push('cleanup');
            return {
              stdout: JSON.stringify([
                { success: true, results: [] },
                { success: true, results: [] },
                { success: true, results: [{ count: 1 }] },
                { success: true, results: [{ count: 0 }] },
              ]),
              stderr: '',
            };
          }
          events.push('mint');
          return {
            stdout: JSON.stringify([
              { success: true, results: [] },
              { success: true, results: [] },
            ]),
            stderr: '',
          };
        }
        events.push(`r2:${args[2]}`);
        return { stdout: 'ok', stderr: '' };
      };
      return { events, execWrangler };
    };

    // 1. Passing --verify-live probes /api/bundle and uploaded R2 key BEFORE temp token cleanup.
    const passMock = makeWranglerMock();
    let mediaProbeCalls = 0;
    const passFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/export/snapshot')) {
        return new Response(
          JSON.stringify({
            head_revision_id: 5,
            snapshot: { head_revision_id: 5, entities: [], kinship: [] },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', etag: '"rev-5"' } }
        );
      }
      if (url.endsWith('/api/batches')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { batch_id: string };
        return new Response(
          JSON.stringify({ batch_id: body.batch_id, head_revision_id: 6, etag: '"rev-6"' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/bundle')) {
        passMock.events.push('probe:bundle');
        return new Response(
          JSON.stringify({
            meta: {
              max_revision_id: 6,
              counts: { people: 4, living_redacted: 1, events: 2, residence_spans: 0, places: 1, sources: 2 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', etag: '"rev-6"' } }
        );
      }
      if (url.endsWith('/media/arthur-scan.png')) {
        mediaProbeCalls += 1;
        // First call is --sync-missing-media check (404); second call is --verify-live check (200 non-empty).
        if (mediaProbeCalls === 1) {
          return new Response(null, { status: 404 });
        }
        passMock.events.push('probe:media');
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': '4' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const passRes = await runSyncCommand({
      repoDir,
      syncMissingMedia: true,
      verifyLive: true,
      json: true,
      fetchImpl: passFetch,
      execWrangler: passMock.execWrangler,
    });
    expect(passRes.liveVerification).toEqual({
      ok: true,
      bundleStatus: 200,
      bundleRevision: 6,
      expectedRevision: 6,
      mediaChecked: 1,
      mediaFailed: 0,
      failures: [],
    });
    expect(passRes.cleanup?.remainingTmpCount).toBe(0);
    expect(passRes.cleanup?.backupCount).toBe(1);
    expect(passMock.events.indexOf('probe:media')).toBeLessThan(passMock.events.indexOf('cleanup'));

    // 2. Failing --verify-live (stale bundle rev + empty R2 response) reports failures AND cleans up temp tokens.
    const failMock = makeWranglerMock();
    let failMediaCalls = 0;
    const failFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/api/export/snapshot')) {
        return new Response(
          JSON.stringify({ head_revision_id: 5, entities: [], kinship: [] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/batches')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { batch_id: string };
        return new Response(
          JSON.stringify({ batch_id: body.batch_id, head_revision_id: 6, etag: '"rev-6"' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/api/bundle')) {
        return new Response(
          JSON.stringify({
            meta: {
              max_revision_id: 5,
              counts: { people: 4, living_redacted: 1, events: 2, residence_spans: 0, places: 1, sources: 2 },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/media/arthur-scan.png')) {
        failMediaCalls += 1;
        if (failMediaCalls === 1) {
          return new Response(null, { status: 404 });
        }
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'Content-Type': 'image/png', 'Content-Length': '0' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const failRes = await runSyncCommand({
      repoDir,
      syncMissingMedia: true,
      verifyLive: true,
      json: true,
      fetchImpl: failFetch,
      execWrangler: failMock.execWrangler,
    });
    expect(failRes.liveVerification?.ok).toBe(false);
    expect(failRes.liveVerification?.bundleRevision).toBe(5);
    expect(failRes.liveVerification?.expectedRevision).toBe(6);
    expect(failRes.liveVerification?.mediaChecked).toBe(1);
    expect(failRes.liveVerification?.mediaFailed).toBe(1);
    expect(failRes.liveVerification?.failures).toHaveLength(2);
    expect(failRes.cleanup?.remainingTmpCount).toBe(0);
    expect(failRes.cleanup?.backupCount).toBe(1);
    expect(failMock.events).toContain('cleanup');
  });
});

describe('ops/verify', () => {
  it('passes all 5 invariants on a valid synthetic archive and flags violations', async () => {
    const repoDir = await createSyntheticRepo();
    await mkdir(path.join(repoDir, 'media'), { recursive: true });
    await writeFile(path.join(repoDir, 'media', 'clara-photo.png'), makeMinimalPng(40, 40));
    await writeFile(path.join(repoDir, 'media', 'arthur-census.png'), makeMinimalPng(40, 40));

    await writeFile(
      path.join(repoDir, 'data', 'media.yaml'),
      serializeMediaYaml(
        [
          {
            id: 'med_arthur_census',
            kind: 'document_scan',
            source_id: 'src_1880_census',
            person_id: 'per_arthur_alder',
            file: '/media/arthur-census.png',
            caption: 'Arthur Alder 1880 census scan',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'data', 'narratives.yaml'),
      serializeNarrativesYaml(
        [
          {
            id: 'nar_arthur_bio',
            slug: 'arthur-alder-bio',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Arthur Alder Biography',
            person_ids: ['per_arthur_alder'],
            place_ids: ['plc_oak_county_ohio'],
            event_ids: ['evt_arthur_1880_census'],
            source_ids: ['src_1880_census'],
            body_md: 'Arthur Alder farmed in Oak County.[^src_1880_census|med_arthur_census]',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    const clean = await runVerifyCommand({ repoDir, json: true });
    expect(clean.ok).toBe(true);
    expect(clean.checks.citations.ok).toBe(true);
    expect(clean.checks.places.ok).toBe(true);
    expect(clean.checks.ssn.ok).toBe(true);
    expect(clean.checks.compile.ok).toBe(true);
    expect(clean.checks.compile.publicCounts.living_redacted).toBe(1);
    expect(clean.checks.media.ok).toBe(true);
    expect(clean.checks.media.checkedCount).toBe(1);
    expect(clean.errors).toEqual([]);

    // Confirm SSN scanner ignores URLs and YAML id/url keys while catching real SSNs.
    const ssnScan = scanYamlFilesForSsns([
      {
        name: 'data/sources.yaml',
        content: [
          '- id: src_123-45-6789',
          '  url: https://example.org/record/123-45-6789/page',
          '  citation: Clean citation with https://example.org/987-65-4321 and id foo_111-22-3333',
          '  note: Contains real SSN 123-45-6789 in prose.',
        ].join('\n'),
      },
    ]);
    expect(ssnScan.ok).toBe(false);
    expect(ssnScan.hits).toEqual([
      { file: 'data/sources.yaml', line: 4, match: '123-45-6789' },
    ]);

    // Introduce 4 simultaneous violations: dangling citation, (0, 0) place, SSN in YAML, missing media file.
    await writeFile(
      path.join(repoDir, 'data', 'places.yaml'),
      serializePlacesYaml([
        {
          id: 'plc_oak_county_ohio',
          slug: 'oak-county-ohio',
          name: 'Oak County',
          full_name: 'Oak County, Ohio, USA',
          place_type: 'county',
          parent_id: null,
          lat: 0,
          lng: 0,
          historical_names: [],
        },
      ]),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'data', 'narratives.yaml'),
      serializeNarrativesYaml([
        {
          id: 'nar_arthur_bio',
          slug: 'arthur-alder-bio',
          kind: 'biography',
          subject_person_id: 'per_arthur_alder',
          title: 'Arthur Alder Biography',
          person_ids: ['per_arthur_alder'],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: ['evt_arthur_1880_census'],
          source_ids: ['src_1880_census'],
          body_md: 'Broken ref.[^src_missing_stub|med_missing] SSN 123-45-6789.',
        },
      ]),
      'utf8'
    );
    await rm(path.join(repoDir, 'media', 'arthur-census.png'));

    const broken = await runVerifyCommand({ repoDir });
    expect(broken.ok).toBe(false);
    expect(broken.checks.citations.ok).toBe(false);
    expect(broken.checks.citations.errors).toHaveLength(2);
    expect(broken.checks.places.ok).toBe(false);
    expect(broken.checks.places.invalidPlaces[0]?.reason).toContain('(0, 0)');
    expect(broken.checks.ssn.ok).toBe(false);
    expect(broken.checks.ssn.hits[0]?.match).toBe('123-45-6789');
    expect(broken.checks.media.ok).toBe(false);
    expect(broken.checks.media.missingFiles[0]?.id).toBe('med_arthur_census');
  });
});
