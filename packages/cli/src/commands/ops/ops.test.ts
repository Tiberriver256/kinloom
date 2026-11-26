import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
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
import { runCli } from '../../cli.js';
import { CliValidationError, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import {
  REDACTED_RELATIVE_LABEL,
  buildSanitizedLocalEntries,
  buildTempTokenCleanupSql,
  buildTempTokenInsertSql,
  computeLifespan,
  computeSyncPlan,
  generateTempToken,
  getTelemetryFilePath,
  indexRemoteSnapshot,
  inspectImageBuffer,
  loadWranglerBindings,
  measureCommand,
  parseAuditEdtf,
  parseDeleteTargets,
  parseEntityTypeList,
  recordTelemetryEvent,
  runAuditBatchCommand,
  runAuditCommand,
  runChronologyCheck,
  runContextCommand,
  runDatesCommand,
  runIntegrateCommand,
  runStatusCommand,
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

  it('includes deceased child and sibling images with --include-family and does not read living relatives', async () => {
    const repoDir = await createSyntheticRepo();
    const peoplePath = path.join(repoDir, 'data', 'people.yaml');
    const kinshipPath = path.join(repoDir, 'data', 'kinship.yaml');
    const people = parsePeopleYaml(await readFile(peoplePath, 'utf8'));
    const extra: RawPerson[] = [
      {
        id: 'per_walter_alder',
        slug: 'walter-alder',
        gedcom_xref: '@I100005@',
        full_name: 'Walter Alder',
        given_name: 'Walter',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1855-02-02',
        death_edtf: '1920-03-03',
        portrait_url: null,
      },
      {
        id: 'per_nora_maple_living',
        slug: 'nora-maple',
        gedcom_xref: '@I100006@',
        full_name: 'Nora Maple',
        given_name: 'Nora',
        surname: 'Maple',
        alt_names: [],
        sex: 'F',
        is_living: true,
        lineage_group: 'ancestor',
        birth_edtf: '1864-04-04',
        death_edtf: '',
        portrait_url: null,
      },
      {
        id: 'per_edwin_alder',
        slug: 'edwin-alder',
        gedcom_xref: '@I100007@',
        full_name: 'Edwin Alder',
        given_name: 'Edwin',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'descendant',
        birth_edtf: '1888-05-05',
        death_edtf: '1914-06-06',
        portrait_url: null,
      },
      {
        id: 'per_iris_alder',
        slug: 'iris-alder',
        gedcom_xref: '@I100008@',
        full_name: 'Iris Alder',
        given_name: 'Iris',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'descendant',
        birth_edtf: '2010-01-01',
        death_edtf: '',
        portrait_url: null,
      },
    ];
    await writeFile(
      peoplePath,
      serializePeopleYaml([...people, ...extra], { sortById: true }),
      'utf8'
    );
    const kinship = parseKinshipYaml(await readFile(kinshipPath, 'utf8'));
    kinship.push(
      { from: 'per_thomas_alder', to: 'per_walter_alder', relation: 'parent' },
      { from: 'per_thomas_alder', to: 'per_nora_maple_living', relation: 'parent' },
      { from: 'per_arthur_alder', to: 'per_edwin_alder', relation: 'parent' },
      { from: 'per_arthur_alder', to: 'per_iris_alder', relation: 'parent' }
    );
    await writeFile(
      kinshipPath,
      serializeKinshipYaml(kinship, { sortDeterministic: true }),
      'utf8'
    );

    const factsDir = await makeTempDir('kinloom-family-facts-');
    const recordImagesDir = path.join(factsDir, 'record_images');
    await mkdir(recordImagesDir, { recursive: true });
    const childImg = path.join(recordImagesDir, '100007_img_child_baptism.png');
    const siblingImg = path.join(recordImagesDir, '100005_img_sibling_deed.png');
    await writeFile(childImg, makeMinimalPng(20, 20));
    await writeFile(siblingImg, makeMinimalPng(20, 20));
    await writeFile(
      path.join(factsDir, '100002.json'),
      JSON.stringify({
        personDbId: '100002',
        fullName: 'Arthur Alder',
        isLiving: false,
      }),
      'utf8'
    );
    await writeFile(
      path.join(factsDir, '100007.json'),
      JSON.stringify({
        personDbId: '100007',
        fullName: 'Edwin Alder',
        isLiving: false,
        sources: [{ Title: '1910 Baptism', RecordImageId: 'img_child_baptism' }],
        recordImages: [{ RecordImageId: 'img_child_baptism', local: childImg, bytes: 42 }],
      }),
      'utf8'
    );
    await writeFile(
      path.join(factsDir, '100005.json'),
      JSON.stringify({
        personDbId: '100005',
        fullName: 'Walter Alder',
        isLiving: false,
        sources: [{ Title: '1890 Land Deed', RecordImageId: 'img_sibling_deed' }],
        recordImages: [{ RecordImageId: 'img_sibling_deed', local: siblingImg, bytes: 42 }],
      }),
      'utf8'
    );
    for (const livingId of ['100004', '100006', '100008']) {
      const livingPath = path.join(factsDir, `${livingId}.json`);
      await writeFile(livingPath, '{LIVING-ANCESTRY-LEAK', 'utf8');
      await chmod(livingPath, 0);
    }

    const closed = await runContextCommand({
      repoDir,
      personId: 'per_arthur_alder',
      ancestryDir: factsDir,
    });
    expect(closed.context.relativeRecordImages).toEqual([]);
    expect(closed.rendered).not.toContain('Walter Alder');
    expect(closed.rendered).not.toContain('LIVING-ANCESTRY-LEAK');
    expect(closed.rendered).not.toContain('Nora Maple');
    expect(closed.rendered).not.toContain('Iris Alder');
    expect(closed.rendered).not.toContain('Clara Maple');

    const opened = await runContextCommand({
      repoDir,
      personId: 'per_arthur_alder',
      ancestryDir: factsDir,
      includeFamily: true,
    });
    expect(
      opened.context.relativeRecordImages.map((img) => ({
        recordImageId: img.recordImageId,
        relation: img.relation,
        relativeId: img.relativeId,
        relativeName: img.relativeName,
      }))
    ).toEqual([
      {
        recordImageId: 'img_child_baptism',
        relation: 'child',
        relativeId: 'per_edwin_alder',
        relativeName: 'Edwin Alder',
      },
      {
        recordImageId: 'img_sibling_deed',
        relation: 'sibling',
        relativeId: 'per_walter_alder',
        relativeName: 'Walter Alder',
      },
    ]);
    expect(opened.context.relatives.children).toEqual([
      REDACTED_RELATIVE_LABEL,
      {
        id: 'per_edwin_alder',
        full_name: 'Edwin Alder',
        lifespan: '1888-05-05 - 1914-06-06',
        gedcom_xref: '@I100007@',
      },
      REDACTED_RELATIVE_LABEL,
    ]);
    expect(opened.rendered).toContain('[child: `per_edwin_alder` Edwin Alder]');
    expect(opened.rendered).toContain('[sibling: `per_walter_alder` Walter Alder]');
    expect(opened.rendered).not.toContain('LIVING-ANCESTRY-LEAK');
    expect(opened.rendered).not.toContain('Nora Maple');
    expect(opened.rendered).not.toContain('Iris Alder');
    expect(opened.rendered).not.toContain('Clara Maple');
  });

  it('lists reusable live archive media for confirmed-deceased relatives only with --include-family', async () => {
    const repoDir = await createSyntheticRepo();
    const peoplePath = path.join(repoDir, 'data', 'people.yaml');
    const kinshipPath = path.join(repoDir, 'data', 'kinship.yaml');
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');

    const people = parsePeopleYaml(await readFile(peoplePath, 'utf8'));
    const extra: RawPerson[] = [
      {
        id: 'per_walter_alder',
        slug: 'walter-alder',
        gedcom_xref: '@I100005@',
        full_name: 'Walter Alder',
        given_name: 'Walter',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1855-02-02',
        death_edtf: '1920-03-03',
        portrait_url: null,
      },
      {
        id: 'per_nora_maple_living',
        slug: 'nora-maple',
        gedcom_xref: '@I100006@',
        full_name: 'Nora Maple',
        given_name: 'Nora',
        surname: 'Maple',
        alt_names: [],
        sex: 'F',
        is_living: true,
        lineage_group: 'ancestor',
        birth_edtf: '1864-04-04',
        death_edtf: '',
        portrait_url: null,
      },
      {
        id: 'per_edwin_alder',
        slug: 'edwin-alder',
        gedcom_xref: '@I100007@',
        full_name: 'Edwin Alder',
        given_name: 'Edwin',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'descendant',
        birth_edtf: '1888-05-05',
        death_edtf: '1914-06-06',
        portrait_url: null,
      },
      {
        id: 'per_iris_alder',
        slug: 'iris-alder',
        gedcom_xref: '@I100008@',
        full_name: 'Iris Alder',
        given_name: 'Iris',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'descendant',
        birth_edtf: '2010-01-01',
        death_edtf: '',
        portrait_url: null,
      },
    ];
    await writeFile(peoplePath, serializePeopleYaml([...people, ...extra], { sortById: true }), 'utf8');

    const kinship = parseKinshipYaml(await readFile(kinshipPath, 'utf8'));
    kinship.push(
      { from: 'per_thomas_alder', to: 'per_walter_alder', relation: 'parent' },
      { from: 'per_thomas_alder', to: 'per_nora_maple_living', relation: 'parent' },
      { from: 'per_arthur_alder', to: 'per_edwin_alder', relation: 'parent' },
      { from: 'per_arthur_alder', to: 'per_iris_alder', relation: 'parent' }
    );
    await writeFile(kinshipPath, serializeKinshipYaml(kinship, { sortDeterministic: true }), 'utf8');

    const events = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    events.push({
      id: 'evt_helen_living_visit',
      title: 'Visit recorded with a living relative',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1956-01-02',
      place_id: 'plc_oak_county_ohio',
      summary: 'A living relative attended.',
      participants: [
        { person_id: 'per_helen_maple', role: 'ancestor' },
        { person_id: 'per_clara_maple_living', role: 'descendant' },
      ],
      sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
    });
    await writeFile(eventsPath, serializeEventsYaml(events, { sortById: true }), 'utf8');

    const media = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    const added: MediaItem[] = [
      {
        id: 'med_thomas_deed',
        kind: 'document_scan',
        person_id: 'per_thomas_alder',
        file: '/media/thomas-deed.png',
        caption: 'Thomas Alder land deed',
      },
      {
        id: 'med_helen_obit',
        kind: 'document_scan',
        person_id: 'per_helen_maple',
        file: '/media/helen-obit.png',
        caption: 'Helen Maple obituary clipping',
      },
      {
        id: 'med_edwin_baptism',
        kind: 'document_scan',
        person_id: 'per_edwin_alder',
        file: '/media/edwin-baptism.png',
        caption: 'Edwin Alder baptism entry',
      },
      {
        id: 'med_walter_deed',
        kind: 'document_scan',
        person_id: 'per_walter_alder',
        file: '/media/walter-deed.png',
        caption: 'Walter Alder land deed',
      },
      {
        id: 'med_arthur_and_helen',
        kind: 'document_scan',
        person_id: 'per_arthur_alder',
        person_ids: ['per_helen_maple'],
        file: '/media/arthur-helen.png',
        caption: 'Arthur Alder and Helen Maple certificate',
      },
      {
        id: 'med_thomas_with_clara',
        kind: 'document_scan',
        person_id: 'per_thomas_alder',
        person_ids: ['per_clara_maple_living'],
        file: '/media/thomas-clara.png',
        caption: 'Thomas Alder with Clara Maple',
      },
      {
        id: 'med_helen_reunion',
        kind: 'document_scan',
        person_id: 'per_helen_maple',
        event_id: 'evt_helen_living_visit',
        file: '/media/helen-reunion.png',
        caption: 'Helen Maple reunion scan',
      },
      {
        id: 'med_nora_portrait',
        kind: 'portrait',
        person_id: 'per_nora_maple_living',
        file: '/media/nora-portrait.png',
        caption: 'Nora Maple portrait',
      },
      {
        id: 'med_iris_card',
        kind: 'document_scan',
        person_id: 'per_iris_alder',
        file: '/media/iris-card.png',
        caption: 'Iris Alder card',
      },
    ];
    await writeFile(mediaPath, serializeMediaYaml([...media, ...added], { sortById: true }), 'utf8');

    const closed = await runContextCommand({ repoDir, personId: 'per_arthur_alder' });
    expect(closed.context.relativeArchiveMedia).toEqual([]);
    expect(closed.rendered).not.toContain('reusable IDs');

    const opened = await runContextCommand({
      repoDir,
      personId: 'per_arthur_alder',
      includeFamily: true,
    });
    expect(opened.context.media.map((item) => item.id)).toContain('med_arthur_and_helen');
    expect(opened.context.relativeArchiveMedia).toEqual([
      {
        id: 'med_edwin_baptism',
        file: '/media/edwin-baptism.png',
        caption: 'Edwin Alder baptism entry',
        relation: 'child',
        relativeId: 'per_edwin_alder',
      },
      {
        id: 'med_helen_obit',
        file: '/media/helen-obit.png',
        caption: 'Helen Maple obituary clipping',
        relation: 'spouse',
        relativeId: 'per_helen_maple',
      },
      {
        id: 'med_thomas_deed',
        file: '/media/thomas-deed.png',
        caption: 'Thomas Alder land deed',
        relation: 'parent',
        relativeId: 'per_thomas_alder',
      },
      {
        id: 'med_walter_deed',
        file: '/media/walter-deed.png',
        caption: 'Walter Alder land deed',
        relation: 'sibling',
        relativeId: 'per_walter_alder',
      },
    ]);
    expect(opened.rendered).toContain(
      '### Existing live archive media on confirmed-deceased relatives (reusable IDs)'
    );
    expect(opened.rendered).toContain(
      '- `med_thomas_deed` file=`/media/thomas-deed.png` caption=Thomas Alder land deed [parent: `per_thomas_alder`]'
    );
    expect(opened.context.relativeArchiveMedia.map((item) => item.id)).not.toContain('med_arthur_and_helen');
    expect(opened.rendered).not.toContain('med_living_photo');
    expect(opened.rendered).not.toContain('med_thomas_with_clara');
    expect(opened.rendered).not.toContain('med_helen_reunion');
    expect(opened.rendered).not.toContain('med_nora_portrait');
    expect(opened.rendered).not.toContain('med_iris_card');
    expect(opened.rendered).not.toContain('Clara Maple');
    expect(opened.rendered).not.toContain('Nora Maple');
    expect(opened.rendered).not.toContain('Iris Alder');
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

  it('replaces a stale participant role on event update instead of keeping both roles', async () => {
    const repoDir = await createSyntheticRepo();
    const packageDir = await writeValidResearchPackage(repoDir);
    const patchPath = path.join(packageDir, 'patch.json');
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const basePatch = JSON.parse(await readFile(patchPath, 'utf8')) as {
      events: Array<Record<string, unknown>>;
    };
    const censusEvent = parseEventsYaml(await readFile(eventsPath, 'utf8')).find(
      (e) => e.id === 'evt_arthur_1880_census'
    )!;
    const applyParticipants = async (participants: Array<{ person_id: string; role: string }>) => {
      const patch = structuredClone(basePatch);
      patch.events.push({ ...structuredClone(censusEvent), participants });
      await writeFile(patchPath, JSON.stringify(patch, null, 2), 'utf8');
      await runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: false });
      return parseEventsYaml(await readFile(eventsPath, 'utf8')).find(
        (e) => e.id === 'evt_arthur_1880_census'
      )?.participants;
    };

    expect(
      await applyParticipants([
        { person_id: 'per_thomas_alder', role: 'witness' },
        { person_id: 'per_helen_maple', role: 'mentioned' },
      ])
    ).toEqual([
      { person_id: 'per_arthur_alder', role: 'principal' },
      { person_id: 'per_thomas_alder', role: 'witness' },
      { person_id: 'per_helen_maple', role: 'mentioned' },
    ]);

    // witness -> grantor replaces the stale role; an explicit double listing keeps both roles.
    expect(
      await applyParticipants([
        { person_id: 'per_thomas_alder', role: 'grantor' },
        { person_id: 'per_arthur_alder', role: 'principal' },
        { person_id: 'per_arthur_alder', role: 'head_of_household' },
      ])
    ).toEqual([
      { person_id: 'per_helen_maple', role: 'mentioned' },
      { person_id: 'per_thomas_alder', role: 'grantor' },
      { person_id: 'per_arthur_alder', role: 'principal' },
      { person_id: 'per_arthur_alder', role: 'head_of_household' },
    ]);
  });

  it('keeps a primary source and merges alternate dates when two people share one event', async () => {
    const repoDir = await createSyntheticRepo();
    const marriageId = 'evt_alder_maple_marriage';
    const countyDate = {
      edtf_date: '1882-06-01',
      source_id: 'src_1880_census',
      note: 'county register',
    };
    const bibleDate = {
      edtf_date: '1882-06-02',
      source_id: 'src_1932_death_cert',
      note: 'family bible',
    };
    const baseEvent = {
      id: marriageId,
      title: 'Marriage of Arthur Alder and Helen Maple',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1882-06-01',
      place_id: 'plc_oak_county_ohio',
      summary: 'Recorded in Oak County.',
      sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
    };

    const arthurDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(arthurDir, { recursive: true });
    await writeFile(
      path.join(arthurDir, 'patch.json'),
      JSON.stringify({
        person_id: 'per_arthur_alder',
        events: [
          {
            ...baseEvent,
            place_precision: 'county',
            has_primary_source: true,
            alternate_dates: [countyDate],
            participants: [{ person_id: 'per_arthur_alder', role: 'groom' }],
          },
        ],
      }),
      'utf8',
    );
    await runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: false });

    const helenDir = path.join(repoDir, 'research', 'people', 'per_helen_maple');
    await mkdir(helenDir, { recursive: true });
    const helenPatch = {
      person_id: 'per_helen_maple',
      events: [
        {
          ...baseEvent,
          has_primary_source: false,
          alternate_dates: [countyDate, bibleDate],
          participants: [{ person_id: 'per_helen_maple', role: 'bride' }],
          sources: [{ source_id: 'src_1932_death_cert', confidence: 'medium' }],
        },
      ],
    };
    await writeFile(path.join(helenDir, 'patch.json'), JSON.stringify(helenPatch), 'utf8');
    await runIntegrateCommand({ repoDir, personId: 'per_helen_maple', dryRun: false });

    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const readMarriage = async () =>
      parseEventsYaml(await readFile(eventsPath, 'utf8')).find((event) => event.id === marriageId);

    const merged = await readMarriage();
    expect(merged?.has_primary_source).toBe(true);
    expect(merged?.place_precision).toBe('county');
    expect(merged?.alternate_dates).toEqual([countyDate, bibleDate]);
    expect(merged?.participants).toEqual([
      { person_id: 'per_arthur_alder', role: 'groom' },
      { person_id: 'per_helen_maple', role: 'bride' },
    ]);

    await writeFile(
      path.join(helenDir, 'patch.json'),
      JSON.stringify({
        person_id: 'per_helen_maple',
        events: [
          {
            ...baseEvent,
            has_primary_source: false,
            participants: [{ person_id: 'per_helen_maple', role: 'bride' }],
            sources: [{ source_id: 'src_1932_death_cert', confidence: 'medium' }],
          },
        ],
      }),
      'utf8',
    );
    const omitRes = await runIntegrateCommand({
      repoDir,
      personId: 'per_helen_maple',
      dryRun: false,
    });
    expect(omitRes.writtenYamlFiles).toEqual([]);
    expect(await readMarriage()).toMatchObject({
      has_primary_source: true,
      place_precision: 'county',
      alternate_dates: [countyDate, bibleDate],
    });
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

describe('ops/status', () => {
  it('ranks the deceased queue sparsest-first and omits living people from text and json', async () => {
    const repoDir = await createSyntheticRepo();
    const dataDir = path.join(repoDir, 'data');

    const people = parsePeopleYaml(await readFile(path.join(dataDir, 'people.yaml'), 'utf8'));
    const clara = people.find((person) => person.id === 'per_clara_maple_living');
    if (!clara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    clara.is_living = false;
    people.push(
      {
        id: 'per_edmund_alder',
        slug: 'edmund-alder',
        gedcom_xref: '@I100010@',
        full_name: 'Edmund Alder',
        given_name: 'Edmund',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1701-01-02',
        death_edtf: '1788-03-03',
        portrait_url: null,
      },
      {
        id: 'per_nora_alder',
        slug: 'nora-alder',
        gedcom_xref: '@I100011@',
        full_name: 'Nora Alder',
        given_name: 'Nora',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1890-01-01',
        death_edtf: '1960-02-02',
        portrait_url: null,
      }
    );

    const places = parsePlacesYaml(await readFile(path.join(dataDir, 'places.yaml'), 'utf8'));
    places.push({
      id: 'plc_null_island',
      slug: 'null-island',
      name: 'Null Island',
      full_name: 'Null Island',
      place_type: 'town',
      parent_id: null,
      lat: 0,
      lng: 0,
      historical_names: [],
    });

    const events = parseEventsYaml(await readFile(path.join(dataDir, 'events.yaml'), 'utf8'));
    events.push({
      id: 'evt_nora_1910',
      title: 'Nora Alder recorded in Oak County',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1910-04-02',
      place_id: 'plc_oak_county_ohio',
      summary: 'Nora Alder appears on a county record.',
      participants: [{ person_id: 'per_nora_alder', role: 'principal' }],
      sources: [{ source_id: 'src_1932_death_cert', confidence: 'medium' }],
    });

    const media = parseMediaYaml(await readFile(path.join(dataDir, 'media.yaml'), 'utf8'));
    media.push({
      id: 'med_nora_scan',
      kind: 'document_scan',
      person_ids: ['per_nora_alder'],
      file: '/media/nora-record.png',
      caption: 'Nora Alder county record',
    });

    const narratives: Narrative[] = [
      {
        id: 'nar_arthur_bio',
        slug: 'arthur-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_arthur_alder',
        title: 'Arthur Alder Biography',
        person_ids: ['per_arthur_alder'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        body_md: 'Arthur Alder farmed in Oak County.',
      },
      {
        id: 'nar_thomas_story',
        slug: 'thomas-alder-story',
        kind: 'family_story',
        subject_person_id: 'per_thomas_alder',
        title: 'Thomas Alder Story',
        person_ids: ['per_thomas_alder'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        body_md: 'Thomas Alder kept a farm.',
      },
    ];

    await mkdir(path.join(repoDir, 'research', 'people', 'per_helen_maple'), { recursive: true });
    await writeFile(path.join(repoDir, 'research', 'people', 'per_helen_maple', 'patch.json'), '{}\n', 'utf8');
    await Promise.all([
      writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
      writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places, { sortById: true }), 'utf8'),
      writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events, { sortById: true }), 'utf8'),
      writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media, { sortById: true }), 'utf8'),
      writeFile(
        path.join(dataDir, 'narratives.yaml'),
        serializeNarrativesYaml(narratives, { sortById: true }),
        'utf8'
      ),
    ]);

    const jsonResult = await runStatusCommand({ repoDir, json: true });
    const parsed = JSON.parse(jsonResult.rendered) as {
      repo: string;
      people: { total: number; deceased: number; living: number };
      events: number;
      places: number;
      zeroCoordPlaces: number;
      sources: number;
      media: number;
      narratives: number;
      biographies: number;
      queue: { done_live: number; staged: number; pending: number };
      deceased: Array<{
        id: string;
        full_name: string;
        status: string;
        events: number;
        sources: number;
        media: number;
      }>;
    };
    expect(parsed.repo).toBe(path.resolve(repoDir));
    expect(parsed.people).toEqual({ total: 6, deceased: 5, living: 1 });
    expect(parsed.events).toBe(3);
    expect(parsed.places).toBe(2);
    expect(parsed.zeroCoordPlaces).toBe(1);
    expect(parsed.sources).toBe(2);
    expect(parsed.media).toBe(2);
    expect(parsed.narratives).toBe(2);
    expect(parsed.biographies).toBe(1);
    expect(parsed.queue).toEqual({ done_live: 1, staged: 1, pending: 3 });
    expect(parsed.deceased).toEqual([
      {
        id: 'per_edmund_alder',
        full_name: 'Edmund Alder',
        birth_edtf: '1701-01-02',
        death_edtf: '1788-03-03',
        events: 0,
        sources: 0,
        media: 0,
        has_biography: false,
        has_staged_patch: false,
        status: 'pending',
      },
      {
        id: 'per_thomas_alder',
        full_name: 'Thomas Alder',
        birth_edtf: '1830-03-10',
        death_edtf: '1902-11-04',
        events: 0,
        sources: 0,
        media: 0,
        has_biography: false,
        has_staged_patch: false,
        status: 'pending',
      },
      {
        id: 'per_nora_alder',
        full_name: 'Nora Alder',
        birth_edtf: '1890-01-01',
        death_edtf: '1960-02-02',
        events: 1,
        sources: 1,
        media: 1,
        has_biography: false,
        has_staged_patch: false,
        status: 'pending',
      },
      {
        id: 'per_helen_maple',
        full_name: 'Helen Maple',
        birth_edtf: '1861-06-20',
        death_edtf: '1940-01-15',
        events: 0,
        sources: 0,
        media: 0,
        has_biography: false,
        has_staged_patch: true,
        status: 'staged',
      },
      {
        id: 'per_arthur_alder',
        full_name: 'Arthur Alder',
        birth_edtf: '1858-04-12',
        death_edtf: '1932-09-18',
        events: 2,
        sources: 1,
        media: 0,
        has_biography: true,
        has_staged_patch: false,
        status: 'done_live',
      },
    ]);

    const textResult = await runStatusCommand({ repoDir });
    const forbidden = ['Clara', 'per_clara', '1954-07-08', 'clara-maple'];
    for (const token of forbidden) {
      expect(jsonResult.rendered.includes(token)).toBe(false);
      expect(textResult.rendered.includes(token)).toBe(false);
    }
    const edmundAt = textResult.rendered.indexOf('Edmund Alder');
    const thomasAt = textResult.rendered.indexOf('Thomas Alder');
    const noraAt = textResult.rendered.indexOf('Nora Alder');
    expect(edmundAt).toBeGreaterThan(-1);
    expect(edmundAt).toBeLessThan(thomasAt);
    expect(thomasAt).toBeLessThan(noraAt);
    expect(textResult.rendered).toContain('Queue: done_live=1 staged=1 pending=3');
    expect(textResult.rendered).toContain('1 living');

    const cli = createCaptureIo();
    expect(await runCli(['status', '--repo', repoDir, '--json'], { io: cli.io })).toBe(EXIT_OK);
    expect(cli.stdout.join('\n')).toContain('"living": 1');
    expect(cli.stderr).toEqual([]);
    const help = createCaptureIo();
    expect(await runCli(['status', '--help'], { io: help.io })).toBe(EXIT_OK);
    expect(help.stdout.join('\n')).toContain('queue.pending');
    expect(help.stdout.join('\n')).toContain('people.living');
    expect(help.stdout.join('\n')).toContain('--limit <N>');
    expect(help.stdout.join('\n')).toContain('--filter <pending|staged|done_live>');
    expect(help.stdout.join('\n')).toContain('JSON ignores --limit and --filter');
  });

  it('limits and filters the text list and rejects invalid flags', async () => {
    const repoDir = await createSyntheticRepo();
    const dataDir = path.join(repoDir, 'data');
    const people = parsePeopleYaml(await readFile(path.join(dataDir, 'people.yaml'), 'utf8'));
    people.push(
      {
        id: 'per_edmund_alder',
        slug: 'edmund-alder',
        gedcom_xref: '@I100010@',
        full_name: 'Edmund Alder',
        given_name: 'Edmund',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1701-01-02',
        death_edtf: '1788-03-03',
        portrait_url: null,
      },
      {
        id: 'per_nora_alder',
        slug: 'nora-alder',
        gedcom_xref: '@I100011@',
        full_name: 'Nora Alder',
        given_name: 'Nora',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1890-01-01',
        death_edtf: '1960-02-02',
        portrait_url: null,
      }
    );
    const narratives: Narrative[] = [
      {
        id: 'nar_arthur_bio',
        slug: 'arthur-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_arthur_alder',
        title: 'Arthur Alder Biography',
        person_ids: ['per_arthur_alder'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        body_md: 'Arthur Alder farmed in Oak County.',
      },
    ];
    await mkdir(path.join(repoDir, 'research', 'people', 'per_helen_maple'), { recursive: true });
    await writeFile(path.join(repoDir, 'research', 'people', 'per_helen_maple', 'patch.json'), '{}\n', 'utf8');
    await Promise.all([
      writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
      writeFile(
        path.join(dataDir, 'narratives.yaml'),
        serializeNarrativesYaml(narratives, { sortById: true }),
        'utf8'
      ),
    ]);

    const allPending = await runStatusCommand({ repoDir, limit: 0 });
    expect(allPending.rendered).toContain('Edmund Alder (per_edmund_alder)');
    expect(allPending.rendered).toContain('Thomas Alder (per_thomas_alder)');
    expect(allPending.rendered).toContain('Nora Alder (per_nora_alder)');
    expect(allPending.rendered).not.toContain('more pending');
    expect(allPending.rendered).not.toContain('Helen Maple');
    expect(allPending.rendered).not.toContain('Clara');

    const twoPending = await runStatusCommand({ repoDir, limit: 2 });
    expect(twoPending.rendered).toContain('Edmund Alder (per_edmund_alder)');
    expect(twoPending.rendered).toContain('Thomas Alder (per_thomas_alder)');
    expect(twoPending.rendered).not.toContain('Nora Alder');
    expect(twoPending.rendered).toContain('... and 1 more pending');

    const staged = await runStatusCommand({ repoDir, filter: 'staged' });
    expect(staged.rendered).toContain('Staged (sparsest first):');
    expect(staged.rendered).toContain('Helen Maple (per_helen_maple)');
    expect(staged.rendered).not.toContain('Edmund Alder');
    expect(staged.rendered).not.toContain('Arthur Alder (per_arthur_alder)');

    const doneLive = await runStatusCommand({ repoDir, filter: 'done_live' });
    expect(doneLive.rendered).toContain('Done live (sparsest first):');
    expect(doneLive.rendered).toContain('Arthur Alder (per_arthur_alder)');
    expect(doneLive.rendered).not.toContain('Helen Maple');
    expect(doneLive.rendered).not.toContain('Edmund Alder');

    const jsonCli = createCaptureIo();
    expect(
      await runCli(['status', '--repo', repoDir, '--json', '--limit', '2', '--filter', 'staged'], {
        io: jsonCli.io,
      })
    ).toBe(EXIT_OK);
    const parsed = JSON.parse(jsonCli.stdout.join('\n')) as {
      sort: string;
      queue: { done_live: number; staged: number; pending: number };
      deceased: Array<{ id: string }>;
    };
    expect(parsed.sort).toBe('sparsest');
    expect(parsed.queue).toEqual({ done_live: 1, staged: 1, pending: 3 });
    expect(parsed.deceased.map((person) => person.id)).toEqual([
      'per_edmund_alder',
      'per_thomas_alder',
      'per_nora_alder',
      'per_helen_maple',
      'per_arthur_alder',
    ]);

    const badFilter = createCaptureIo();
    expect(await runCli(['status', '--filter', 'open'], { io: badFilter.io })).toBe(EXIT_USAGE);
    expect(badFilter.stderr.join('\n')).toBe(
      'Validation error: Option `--filter` must be `pending`, `staged`, or `done_live`.'
    );

    const badLimit = createCaptureIo();
    expect(await runCli(['status', '--limit', '-1'], { io: badLimit.io })).toBe(EXIT_USAGE);
    expect(badLimit.stderr.join('\n')).toContain(
      'Option `--limit` must be an integer greater than or equal to 0.'
    );
  });

  it('sorts pending, staged, and done_live queues by sparsest, richest, and chronological and rejects invalid --sort', async () => {
    const repoDir = await createSyntheticRepo();
    const dataDir = path.join(repoDir, 'data');

    const people: RawPerson[] = [
      {
        id: 'per_pending_rich',
        slug: 'pending-rich',
        gedcom_xref: '@I200001@',
        full_name: 'Martha Alder',
        given_name: 'Martha',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1850-05-01',
        death_edtf: '1930-01-01',
        portrait_url: null,
      },
      {
        id: 'per_pending_mid_a',
        slug: 'pending-mid-a',
        gedcom_xref: '@I200002@',
        full_name: 'Samuel Alder',
        given_name: 'Samuel',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1850-09-12',
        death_edtf: '1910-04-04',
        portrait_url: null,
      },
      {
        id: 'per_pending_sparse_no_birth',
        slug: 'pending-sparse-no-birth',
        gedcom_xref: '@I200003@',
        full_name: 'Grace Maple',
        given_name: 'Grace',
        surname: 'Maple',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '',
        death_edtf: '1895-02-02',
        portrait_url: null,
      },
      {
        id: 'per_pending_sparse_early',
        slug: 'pending-sparse-early',
        gedcom_xref: '@I200004@',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1820~',
        death_edtf: '1888-07-07',
        portrait_url: null,
      },
      {
        id: 'per_staged_sparse',
        slug: 'staged-sparse',
        gedcom_xref: '@I200005@',
        full_name: 'Ruth Maple',
        given_name: 'Ruth',
        surname: 'Maple',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1875-03-03',
        death_edtf: '1945-06-06',
        portrait_url: null,
      },
      {
        id: 'per_staged_rich',
        slug: 'staged-rich',
        gedcom_xref: '@I200006@',
        full_name: 'Daniel Maple',
        given_name: 'Daniel',
        surname: 'Maple',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1840-08-08',
        death_edtf: '1915-09-09',
        portrait_url: null,
      },
      {
        id: 'per_done_sparse',
        slug: 'done-sparse',
        gedcom_xref: '@I200007@',
        full_name: 'Alice Alder',
        given_name: 'Alice',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1865-01-10',
        death_edtf: '1938-11-11',
        portrait_url: null,
      },
      {
        id: 'per_done_rich',
        slug: 'done-rich',
        gedcom_xref: '@I200008@',
        full_name: 'Owen Alder',
        given_name: 'Owen',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1835-12-01',
        death_edtf: '1905-05-05',
        portrait_url: null,
      },
    ];

    const events: RawEvent[] = [
      {
        id: 'evt_rich_1',
        title: 'Martha census 1880',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1880-06-01',
        place_id: 'plc_oak_county_ohio',
        summary: 'Martha Alder recorded.',
        participants: [{ person_id: 'per_pending_rich', role: 'principal' }],
        sources: [
          { source_id: 'src_1880_census', confidence: 'high' },
          { source_id: 'src_1932_death_cert', confidence: 'high' },
        ],
      },
      {
        id: 'evt_rich_2',
        title: 'Martha deed 1890',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1890-06-01',
        place_id: 'plc_oak_county_ohio',
        summary: 'Martha Alder land deed.',
        participants: [{ person_id: 'per_pending_rich', role: 'principal' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      },
      {
        id: 'evt_mid_1',
        title: 'Samuel census 1880',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1880-06-02',
        place_id: 'plc_oak_county_ohio',
        summary: 'Samuel Alder recorded.',
        participants: [{ person_id: 'per_pending_mid_a', role: 'principal' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      },
      {
        id: 'evt_staged_rich_1',
        title: 'Daniel census 1880',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1880-06-03',
        place_id: 'plc_oak_county_ohio',
        summary: 'Daniel Maple recorded.',
        participants: [{ person_id: 'per_staged_rich', role: 'principal' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      },
      {
        id: 'evt_done_rich_1',
        title: 'Owen census 1880',
        scope: 'personal',
        event_kind: 'point_event',
        edtf_date: '1880-06-04',
        place_id: 'plc_oak_county_ohio',
        summary: 'Owen Alder recorded.',
        participants: [{ person_id: 'per_done_rich', role: 'principal' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      },
    ];

    const media: MediaItem[] = [
      {
        id: 'med_rich_photo',
        kind: 'family_photo',
        person_id: 'per_pending_rich',
        file: '/media/martha.png',
        caption: 'Martha Alder portrait',
      },
    ];

    const narratives: Narrative[] = [
      {
        id: 'nar_done_sparse',
        slug: 'alice-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_done_sparse',
        title: 'Alice Alder Biography',
        person_ids: ['per_done_sparse'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        body_md: 'Alice Alder lived in Oak County.',
      },
      {
        id: 'nar_done_rich',
        slug: 'owen-alder-bio',
        kind: 'biography',
        subject_person_id: 'per_done_rich',
        title: 'Owen Alder Biography',
        person_ids: ['per_done_rich'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        body_md: 'Owen Alder farmed in Oak County.',
      },
    ];

    for (const stagedId of ['per_staged_sparse', 'per_staged_rich']) {
      await mkdir(path.join(repoDir, 'research', 'people', stagedId), { recursive: true });
      await writeFile(path.join(repoDir, 'research', 'people', stagedId, 'patch.json'), '{}\n', 'utf8');
    }

    await Promise.all([
      writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
      writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events, { sortById: true }), 'utf8'),
      writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media, { sortById: true }), 'utf8'),
      writeFile(
        path.join(dataDir, 'narratives.yaml'),
        serializeNarrativesYaml(narratives, { sortById: true }),
        'utf8'
      ),
    ]);

    const sparsest = await runStatusCommand({ repoDir, sort: 'sparsest' });
    expect(sparsest.sort).toBe('sparsest');
    expect(sparsest.rendered).toContain('Pending (sparsest first):');
    expect(sparsest.deceased.map((p) => p.id)).toEqual([
      'per_pending_sparse_early',
      'per_pending_sparse_no_birth',
      'per_pending_mid_a',
      'per_pending_rich',
      'per_staged_sparse',
      'per_staged_rich',
      'per_done_sparse',
      'per_done_rich',
    ]);

    const richest = await runStatusCommand({ repoDir, sort: 'richest' });
    expect(richest.sort).toBe('richest');
    expect(richest.rendered).toContain('Pending (richest first):');
    expect(richest.deceased.map((p) => p.id)).toEqual([
      'per_pending_rich',
      'per_pending_mid_a',
      'per_pending_sparse_early',
      'per_pending_sparse_no_birth',
      'per_staged_rich',
      'per_staged_sparse',
      'per_done_rich',
      'per_done_sparse',
    ]);

    const stagedRichest = await runStatusCommand({ repoDir, filter: 'staged', sort: 'richest' });
    expect(stagedRichest.rendered).toContain('Staged (richest first):');
    expect(stagedRichest.rendered.indexOf('per_staged_rich')).toBeLessThan(
      stagedRichest.rendered.indexOf('per_staged_sparse')
    );

    const chronological = await runStatusCommand({ repoDir, sort: 'chronological' });
    expect(chronological.sort).toBe('chronological');
    expect(chronological.rendered).toContain('Pending (chronological):');
    // 1820, then 1850 (death 1910 before death 1930), then null birth last; same within staged & done_live.
    expect(chronological.deceased.map((p) => p.id)).toEqual([
      'per_pending_sparse_early',
      'per_pending_mid_a',
      'per_pending_rich',
      'per_pending_sparse_no_birth',
      'per_staged_rich',
      'per_staged_sparse',
      'per_done_rich',
      'per_done_sparse',
    ]);

    const doneChrono = await runStatusCommand({ repoDir, filter: 'done_live', sort: 'chronological' });
    expect(doneChrono.rendered).toContain('Done live (chronological):');
    expect(doneChrono.rendered.indexOf('per_done_rich')).toBeLessThan(
      doneChrono.rendered.indexOf('per_done_sparse')
    );

    // CLI flag parsing for both `--sort <mode>` and `--sort=<mode>` plus JSON output.
    const cliRichest = createCaptureIo();
    expect(
      await runCli(['status', '--repo', repoDir, '--sort', 'richest', '--json'], { io: cliRichest.io })
    ).toBe(EXIT_OK);
    const parsedRichest = JSON.parse(cliRichest.stdout.join('\n')) as {
      sort: string;
      deceased: Array<{ id: string }>;
    };
    expect(parsedRichest.sort).toBe('richest');
    expect(parsedRichest.deceased.slice(0, 4).map((p) => p.id)).toEqual([
      'per_pending_rich',
      'per_pending_mid_a',
      'per_pending_sparse_early',
      'per_pending_sparse_no_birth',
    ]);

    const cliChronoEq = createCaptureIo();
    expect(
      await runCli(['status', '--repo', repoDir, '--sort=chronological', '--json'], {
        io: cliChronoEq.io,
      })
    ).toBe(EXIT_OK);
    const parsedChrono = JSON.parse(cliChronoEq.stdout.join('\n')) as {
      sort: string;
      deceased: Array<{ id: string }>;
    };
    expect(parsedChrono.sort).toBe('chronological');
    expect(parsedChrono.deceased.slice(0, 4).map((p) => p.id)).toEqual([
      'per_pending_sparse_early',
      'per_pending_mid_a',
      'per_pending_rich',
      'per_pending_sparse_no_birth',
    ]);

    // Invalid --sort is rejected with CliValidationError (exit code 2).
    const badSort = createCaptureIo();
    expect(await runCli(['status', '--repo', repoDir, '--sort', 'newest'], { io: badSort.io })).toBe(
      EXIT_USAGE
    );
    expect(badSort.stderr.join('\n')).toBe(
      'Validation error: Option `--sort` must be `sparsest`, `richest`, or `chronological`.'
    );

    const badSortEq = createCaptureIo();
    expect(await runCli(['status', '--repo', repoDir, '--sort=random'], { io: badSortEq.io })).toBe(
      EXIT_USAGE
    );
    expect(badSortEq.stderr.join('\n')).toBe(
      'Validation error: Option `--sort` must be `sparsest`, `richest`, or `chronological`.'
    );

    await expect(
      runStatusCommand({ repoDir, sort: 'invalid' as unknown as 'sparsest' })
    ).rejects.toBeInstanceOf(CliValidationError);

    const help = createCaptureIo();
    expect(await runCli(['status', '--help'], { io: help.io })).toBe(EXIT_OK);
    expect(help.stdout.join('\n')).toContain('--sort <sparsest|richest|chronological>');
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

    const single = JSON.parse(audit.rendered) as { person_id: string; overlaps?: unknown; people?: unknown };
    expect(single.person_id).toBe('per_arthur_alder');
    expect(single.overlaps).toBeUndefined();
    expect(single.people).toBeUndefined();

    const jpegHeader = inspectImageBuffer(makeMinimalJpeg(320, 240));
    expect(jpegHeader).toEqual({
      valid: true,
      format: 'jpeg',
      width: 320,
      height: 240,
      error: null,
    });
  });

  async function dropArthurLivingVisit(repoDir: string): Promise<void> {
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');
    const filteredEvents = parseEventsYaml(await readFile(eventsPath, 'utf8')).filter(
      (event) => event.id !== 'evt_arthur_living_visit'
    );
    await writeFile(eventsPath, serializeEventsYaml(filteredEvents, { sortById: true }), 'utf8');
  }

  async function writeCitedPackage(options: {
    repoDir: string;
    personId: string;
    fullName: string;
    scanName: string;
    scan: Buffer;
    mediaId: string;
    mediaFile: string;
    eventId: string;
    eventDate: string;
    eventTitle: string;
    placePrecision?: string;
    sourceId?: string;
  }): Promise<void> {
    const packageDir = path.join(options.repoDir, 'research', 'people', options.personId);
    await mkdir(path.join(packageDir, 'scans'), { recursive: true });
    await writeFile(path.join(packageDir, 'scans', options.scanName), options.scan);
    const event: Record<string, unknown> = {
      id: options.eventId,
      title: options.eventTitle,
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: options.eventDate,
      place_id: 'plc_oak_county_ohio',
      summary: 'Recorded in Oak County.',
      participants: [{ person_id: options.personId, role: 'principal' }],
      sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
    };
    if (options.placePrecision) {
      event.place_precision = options.placePrecision;
    }
    const patch: Record<string, unknown> = {
      person_id: options.personId,
      media: [
        {
          id: options.mediaId,
          kind: 'document_scan',
          source_id: 'src_1880_census',
          person_id: options.personId,
          file: options.mediaFile,
          caption: 'Synthetic certificate',
        },
      ],
      events: [event],
      narratives: [
        {
          id: `nar_${options.personId}_bio`,
          slug: `${options.personId}-bio`,
          title: `${options.fullName} biography`,
          person_ids: [options.personId],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: [options.eventId],
          source_ids: ['src_1880_census'],
          body_md: `${options.fullName} resided in Oak County in 1880.[^src_1880_census]`,
        },
      ],
    };
    if (options.sourceId) {
      patch.sources = [
        {
          id: options.sourceId,
          citation: 'Synthetic Oak County register',
          source_type: 'census',
          repository: 'County archive',
        },
      ];
    }
    await writeFile(path.join(packageDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');
  }

  it('audits several staged packages and reports identical and conflicting overlaps', async () => {
    const repoDir = await createSyntheticRepo();
    process.env.KINLOOM_TELEMETRY_FILE = path.join(repoDir, 'telemetry.jsonl');
    await dropArthurLivingVisit(repoDir);
    const sharedScan = makeMinimalPng(640, 480, 12_000);
    await writeCitedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      scanName: 'shared-certificate.png',
      scan: sharedScan,
      mediaId: 'med_shared_certificate',
      mediaFile: '/media/shared-certificate.png',
      eventId: 'evt_shared_move',
      eventDate: '1900-04-01',
      eventTitle: 'Move to Oak County',
      placePrecision: 'county',
      sourceId: 'src_shared_register',
    });
    await writeCitedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      scanName: 'shared-certificate.png',
      scan: sharedScan,
      mediaId: 'med_shared_certificate',
      mediaFile: '/media/shared-certificate.png',
      eventId: 'evt_shared_move',
      eventDate: '1900-04-01',
      eventTitle: 'Move to Oak County',
      placePrecision: 'county',
      sourceId: 'src_shared_register',
    });

    const help = createCaptureIo();
    expect(await runCli(['audit', '--help'], { io: help.io })).toBe(EXIT_OK);
    expect(help.stdout.join('\n')).toContain('--all-staged');
    expect(help.stdout.join('\n')).toContain('--strict');
    expect(help.stdout.join('\n')).toContain(
      'when a staged file already belongs to a different id in data/media.yaml'
    );

    const ordered = createCaptureIo();
    const orderedCode = await runCli(
      ['audit', 'per_helen_maple', 'per_arthur_alder', '--repo', repoDir, '--json'],
      { io: ordered.io }
    );
    expect(orderedCode, `${ordered.stderr.join('\n')}\n${ordered.stdout.join('\n')}`).toBe(EXIT_OK);
    const givenOrder = JSON.parse(ordered.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      people: Array<{ person_id: string }>;
      overlaps: {
        scanFileCollisions: Array<{ basename: string; bytesIdentical: boolean; packages: Array<{ person_id: string; width: number; height: number }> }>;
        mediaFileCollisions: Array<{ file: string; mediaIdsConflict: boolean }>;
        sharedMediaIds: Array<{ id: string }>;
        sharedSourceIds: Array<{ id: string; person_ids: string[] }>;
      };
      summary: { people: number; differingScanCollisions: number; conflictingMediaFileCollisions: number };
    };
    expect(givenOrder.ok).toBe(true);
    expect(givenOrder.strictOk).toBe(true);
    expect(givenOrder.people.map((person) => person.person_id)).toEqual([
      'per_helen_maple',
      'per_arthur_alder',
    ]);
    expect(givenOrder.overlaps.scanFileCollisions).toEqual([
      expect.objectContaining({
        basename: 'shared-certificate.png',
        bytesIdentical: true,
        packages: [
          expect.objectContaining({ person_id: 'per_arthur_alder', width: 640, height: 480 }),
          expect.objectContaining({ person_id: 'per_helen_maple', width: 640, height: 480 }),
        ],
      }),
    ]);
    expect(givenOrder.overlaps.mediaFileCollisions).toEqual([
      expect.objectContaining({ file: 'media/shared-certificate.png', mediaIdsConflict: false }),
    ]);
    expect(givenOrder.overlaps.sharedMediaIds.map((row) => row.id)).toEqual(['med_shared_certificate']);
    expect(givenOrder.overlaps.sharedSourceIds).toEqual([
      { id: 'src_shared_register', person_ids: ['per_arthur_alder', 'per_helen_maple'] },
    ]);
    expect(givenOrder.summary.differingScanCollisions).toBe(0);
    expect(givenOrder.summary.conflictingMediaFileCollisions).toBe(0);

    const staged = createCaptureIo();
    expect(await runCli(['audit', '--all-staged', '--repo', repoDir, '--strict'], { io: staged.io })).toBe(
      EXIT_OK
    );
    expect(staged.stdout.join('\n')).toContain('Batch audit [PASS] strict [PASS] 2 people');
    expect(staged.stdout.join('\n')).toContain('identical bytes');

    const single = createCaptureIo();
    expect(await runCli(['audit', 'per_helen_maple', '--repo', repoDir, '--json'], { io: single.io })).toBe(
      EXIT_OK
    );
    const singleBody = JSON.parse(single.stdout.join('\n')) as { person_id: string; overlaps?: unknown };
    expect(singleBody.person_id).toBe('per_helen_maple');
    expect(singleBody.overlaps).toBeUndefined();

    await writeCitedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      scanName: 'shared-certificate.png',
      scan: makeMinimalPng(320, 200, 13_000),
      mediaId: 'med_arthur_certificate',
      mediaFile: '/media/shared-certificate.png',
      eventId: 'evt_shared_move',
      eventDate: '1901-05-02',
      eventTitle: 'Arthur leaves Oak County',
      placePrecision: 'town',
      sourceId: 'src_shared_register',
    });
    const conflict = await runAuditBatchCommand({
      repoDir,
      personIds: ['per_helen_maple', 'per_arthur_alder'],
      json: true,
    });
    expect(conflict.ok).toBe(true);
    expect(conflict.strictOk).toBe(false);
    expect(conflict.overlaps.scanFileCollisions[0]).toEqual(
      expect.objectContaining({ basename: 'shared-certificate.png', bytesIdentical: false })
    );
    expect(conflict.overlaps.scanFileCollisions[0]?.packages.map((row) => row.person_id)).toEqual([
      'per_arthur_alder',
      'per_helen_maple',
    ]);
    expect(conflict.overlaps.scanFileCollisions[0]?.packages[0]?.width).toBe(320);
    expect(conflict.overlaps.scanFileCollisions[0]?.packages[1]?.width).toBe(640);
    expect(conflict.overlaps.mediaFileCollisions).toEqual([
      expect.objectContaining({
        file: 'media/shared-certificate.png',
        mediaIdsConflict: true,
        entries: [
          expect.objectContaining({ person_id: 'per_arthur_alder', media_id: 'med_arthur_certificate' }),
          expect.objectContaining({ person_id: 'per_helen_maple', media_id: 'med_shared_certificate' }),
        ],
      }),
    ]);
    expect(conflict.overlaps.sharedEventOverlaps).toEqual([
      {
        id: 'evt_shared_move',
        fieldDiffs: ['edtf_date', 'place_precision', 'title'],
        packages: [
          {
            person_id: 'per_arthur_alder',
            edtf_date: '1901-05-02',
            place_id: 'plc_oak_county_ohio',
            place_precision: 'town',
            title: 'Arthur leaves Oak County',
          },
          {
            person_id: 'per_helen_maple',
            edtf_date: '1900-04-01',
            place_id: 'plc_oak_county_ohio',
            place_precision: 'county',
            title: 'Move to Oak County',
          },
        ],
      },
    ]);

    const strictExit = createCaptureIo();
    expect(
      await runCli(['audit', '--all-staged', '--repo', repoDir, '--strict', '--json'], { io: strictExit.io })
    ).toBe(EXIT_ERROR);
    const strictBody = JSON.parse(strictExit.stdout.join('\n')) as { ok: boolean; strictOk: boolean };
    expect(strictBody.ok).toBe(true);
    expect(strictBody.strictOk).toBe(false);

    const looseExit = createCaptureIo();
    expect(await runCli(['audit', '--all-staged', '--repo', repoDir], { io: looseExit.io })).toBe(EXIT_OK);
  });

  it('reports a staged media file that already belongs to another live media id', async () => {
    const repoDir = await createSyntheticRepo();
    process.env.KINLOOM_TELEMETRY_FILE = path.join(repoDir, 'telemetry.jsonl');
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    const media = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    media.push({
      id: 'med_oak_register',
      kind: 'document_scan',
      person_id: 'per_thomas_alder',
      file: '/media/oak-register.png',
      caption: 'Oak County register',
    });
    await writeFile(mediaPath, serializeMediaYaml(media, { sortById: true }), 'utf8');
    await writeCitedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      scanName: 'oak-register.png',
      scan: makeMinimalPng(640, 480, 12_000),
      mediaId: 'med_staged_oak_register',
      mediaFile: '/media/oak-register.png',
      eventId: 'evt_helen_register',
      eventDate: '1884-03-01',
      eventTitle: 'Helen Maple register entry',
    });

    const cap = createCaptureIo();
    const liveCode = await runCli(['audit', '--all-staged', '--repo', repoDir, '--strict', '--json'], {
      io: cap.io,
    });
    expect(liveCode, `${cap.stderr.join('\n')}\n${cap.stdout.join('\n')}`).toBe(EXIT_ERROR);
    const body = JSON.parse(cap.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      overlaps: {
        liveMediaFileCollisions: Array<{ file: string; live_media_id: string; staged: Array<{ media_id: string }> }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.strictOk).toBe(false);
    expect(body.overlaps.liveMediaFileCollisions).toEqual([
      {
        file: 'media/oak-register.png',
        live_media_id: 'med_oak_register',
        staged: [
          {
            person_id: 'per_helen_maple',
            media_id: 'med_staged_oak_register',
            file: '/media/oak-register.png',
          },
        ],
      },
    ]);
  });

  it('fails a single-person strict audit when a new media id reuses a live file', async () => {
    const repoDir = await createSyntheticRepo();
    process.env.KINLOOM_TELEMETRY_FILE = path.join(repoDir, 'telemetry.jsonl');
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    const media = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    media.push({
      id: 'med_oak_register',
      kind: 'document_scan',
      person_id: 'per_thomas_alder',
      file: '/media/oak-register.png',
      caption: 'Oak County register',
    });
    await writeFile(mediaPath, serializeMediaYaml(media, { sortById: true }), 'utf8');
    await writeCitedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      scanName: 'oak-register.png',
      scan: makeMinimalPng(640, 480, 12_000),
      mediaId: 'med_staged_oak_register',
      mediaFile: '/media/oak-register.png',
      eventId: 'evt_helen_register',
      eventDate: '1884-03-01',
      eventTitle: 'Helen Maple register entry',
    });

    const strict = createCaptureIo();
    const strictCode = await runCli(
      ['audit', 'per_helen_maple', '--repo', repoDir, '--strict', '--json'],
      { io: strict.io }
    );
    expect(strictCode, `${strict.stderr.join('\n')}\n${strict.stdout.join('\n')}`).toBe(EXIT_ERROR);
    const strictBody = JSON.parse(strict.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      warnings: string[];
      overlaps?: unknown;
    };
    expect(strictBody.ok).toBe(true);
    expect(strictBody.strictOk).toBe(false);
    expect(strictBody.overlaps).toBeUndefined();
    expect(strictBody.warnings).toEqual([
      "media: file 'media/oak-register.png' already belongs to live media id 'med_oak_register' (staged media id 'med_staged_oak_register')",
    ]);

    const loose = createCaptureIo();
    expect(
      await runCli(['audit', 'per_helen_maple', '--repo', repoDir, '--json'], { io: loose.io })
    ).toBe(EXIT_OK);

    const liveIndex = media.findIndex((item) => item.id === 'med_oak_register');
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    const liveItem = media[liveIndex];
    if (!liveItem) {
      throw new Error('missing med_oak_register');
    }
    media[liveIndex] = { ...liveItem, id: 'med_staged_oak_register' };
    await writeFile(mediaPath, serializeMediaYaml(media, { sortById: true }), 'utf8');
    const sameId = createCaptureIo();
    const sameCode = await runCli(
      ['audit', 'per_helen_maple', '--repo', repoDir, '--strict', '--json'],
      { io: sameId.io }
    );
    expect(sameCode, `${sameId.stderr.join('\n')}\n${sameId.stdout.join('\n')}`).toBe(EXIT_OK);
    const sameBody = JSON.parse(sameId.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      warnings: string[];
    };
    expect(sameBody.ok).toBe(true);
    expect(sameBody.strictOk).toBe(true);
    expect(sameBody.warnings).toEqual([]);
  });

  function chronologyFor(birth: string, death: string, eventDate: string, title = 'Household register') {
    return runChronologyCheck(
      { birth_edtf: birth, death_edtf: death },
      {
        person_id: 'per_alder',
        events: [
          {
            id: 'evt_span',
            title,
            event_kind: 'residence',
            edtf_date: eventDate,
            summary: title,
            participants: [{ person_id: 'per_alder', role: 'principal' }],
          },
        ],
      },
      []
    );
  }

  it('keeps a single EDTF date on one day', () => {
    const parsed = parseAuditEdtf('1885-04-23');
    expect(parsed).toEqual({
      raw: '1885-04-23',
      year: 1885,
      month: 4,
      day: 23,
      precision: 'day',
      approximate: false,
      startMs: Date.UTC(1885, 3, 23),
      endMs: Date.UTC(1885, 3, 23),
    });
  });

  it('accepts a household interval that covers the birth and rejects one that ends before it', () => {
    const covered = chronologyFor('1896-12-17', '1950-01-01', '1885-04-23/1910-01-18');
    expect(covered.checkedEvents).toBe(1);
    expect(covered.errors).toEqual([]);

    const before = chronologyFor('1896-12-17', '1950-01-01', '1880-01-01/1890-12-31');
    expect(before.checkedEvents).toBe(1);
    expect(before.errors).toEqual([
      'Event evt_span (1880-01-01/1890-12-31): predates birth (1896-12-17).',
    ]);
  });

  it('accepts an interval that covers the death and rejects one that starts after it', () => {
    const covered = chronologyFor('1880-01-01', '1920-03-03', '1900-01-01/1925-12-31');
    expect(covered.checkedEvents).toBe(1);
    expect(covered.errors).toEqual([]);

    const after = chronologyFor('1880-01-01', '1920-03-03', '1925-01-01/1930-12-31');
    expect(after.checkedEvents).toBe(1);
    expect(after.errors).toEqual([
      'Event evt_span (1925-01-01/1930-12-31): postdates death (1920-03-03) and is not a burial/probate/obituary/memorial event.',
    ]);
  });

  it('reads open EDTF interval ends as event dates and as birth or death dates', () => {
    const openEndEvent = chronologyFor('1896-12-17', '1950-01-01', '1879-03-03/');
    expect(openEndEvent.checkedEvents).toBe(1);
    expect(openEndEvent.errors).toEqual([]);

    const openEndDots = chronologyFor('1896-12-17', '1950-01-01', '1879-03-03/..');
    expect(openEndDots.checkedEvents).toBe(1);
    expect(openEndDots.errors).toEqual([]);

    const openStartEvent = chronologyFor('1896-12-17', '1950-01-01', '/1890-12-31');
    expect(openStartEvent.errors).toEqual([
      'Event evt_span (/1890-12-31): predates birth (1896-12-17).',
    ]);

    const openStartDots = chronologyFor('1896-12-17', '1950-01-01', '../1890-12-31');
    expect(openStartDots.errors).toEqual([
      'Event evt_span (../1890-12-31): predates birth (1896-12-17).',
    ]);

    const bornOnOrAfter = chronologyFor('1879-03-03/', '1950-01-01', '1870-01-01');
    expect(bornOnOrAfter.errors).toEqual([
      'Event evt_span (1870-01-01): predates birth (1879-03-03/).',
    ]);
    const bornOnOrAfterLater = chronologyFor('1879-03-03/', '1950-01-01', '1880-06-01');
    expect(bornOnOrAfterLater.errors).toEqual([]);

    const diedOnOrBefore = chronologyFor('1850-01-01', '/1890-12-31', '1891-01-01');
    expect(diedOnOrBefore.errors).toEqual([
      'Event evt_span (1891-01-01): postdates death (/1890-12-31) and is not a burial/probate/obituary/memorial event.',
    ]);

    const diedOnOrAfter = chronologyFor('1850-01-01', '1879-03-03/', '1900-01-01');
    expect(diedOnOrAfter.errors).toEqual([]);
    const diedOnOrAfterDots = chronologyFor('1850-01-01', '1879-03-03/..', '1900-01-01');
    expect(diedOnOrAfterDots.errors).toEqual([]);

    const openBirth = computeLifespan(parseAuditEdtf('1879-03-03/'), parseAuditEdtf('1920-03-03'));
    expect(openBirth.exact).toBe(false);
    expect(openBirth.years).toBe(41);
    expect(openBirth.label).toBe('~41 years');

    const openDeath = computeLifespan(parseAuditEdtf('1850-01-01'), parseAuditEdtf('1879-03-03/'));
    expect(openDeath).toEqual({
      exact: false,
      years: null,
      days: null,
      totalDays: null,
      label: null,
    });

    const openStartBirth = computeLifespan(parseAuditEdtf('/1890-12-31'), parseAuditEdtf('1920-03-03'));
    expect(openStartBirth).toEqual({
      exact: false,
      years: null,
      days: null,
      totalDays: null,
      label: null,
    });

    const openStartDeath = computeLifespan(parseAuditEdtf('../1890-12-31'), parseAuditEdtf('1920-03-03'));
    expect(openStartDeath.exact).toBe(false);
    expect(openStartDeath.years).toBeNull();
  });

  it('keeps approximate markers on both ends of an interval', () => {
    const tilde = parseAuditEdtf('1885~/1910~');
    expect(tilde).toEqual({
      raw: '1885~/1910~',
      year: 1885,
      month: null,
      day: null,
      precision: 'year',
      approximate: true,
      startMs: Date.UTC(1885, 0, 1),
      endMs: Date.UTC(1910, 11, 31),
    });

    const uncertain = parseAuditEdtf('1890?/1895');
    expect(uncertain).toEqual({
      raw: '1890?/1895',
      year: 1890,
      month: null,
      day: null,
      precision: 'year',
      approximate: true,
      startMs: Date.UTC(1890, 0, 1),
      endMs: Date.UTC(1895, 11, 31),
    });

    const widenedDeath = chronologyFor('1880-01-01', '1912~/1920~', '1921-06-01');
    expect(widenedDeath.checkedEvents).toBe(1);
    expect(widenedDeath.errors).toEqual([]);

    const singleApproxDeath = chronologyFor('1880-01-01', '1920~', '1921-06-01');
    expect(singleApproxDeath.errors).toEqual([]);
    const afterApproxDeath = chronologyFor('1880-01-01', '1920~', '1922-01-01');
    expect(afterApproxDeath.errors).toEqual([
      'Event evt_span (1922-01-01): postdates death (1920~) and is not a burial/probate/obituary/memorial event.',
    ]);
  });

  it('does not treat a reversed closed interval as a date', () => {
    expect(parseAuditEdtf('1910-01-18/1885-04-23')).toBeNull();
    expect(parseAuditEdtf('1885-04-23/1910-01-18')?.endMs).toBe(Date.UTC(1910, 0, 18));
  });

  it('does not call a long marriage interval an underage marriage', () => {
    const lateEnough = chronologyFor('1896-12-17', '1950-01-01', '1900-01-01/1920-01-01', 'Marriage of Alder');
    expect(lateEnough.errors).toEqual([]);

    const stillYoung = chronologyFor('1896-12-17', '1950-01-01', '1900-01-01/1905-01-01', 'Marriage of Alder');
    expect(stillYoung.errors).toEqual([
      'Event evt_span (1900-01-01/1905-01-01): marriage at implausible age 9 (birth 1896-12-17).',
    ]);
  });

  it('flags a living First Surname with the middle name omitted and skips a deceased namesake', async () => {
    const caughtRepo = await createSyntheticRepo();
    const caughtPeople = parsePeopleYaml(
      await readFile(path.join(caughtRepo, 'data', 'people.yaml'), 'utf8')
    );
    const caughtClara = caughtPeople.find((person) => person.id === 'per_clara_maple_living');
    if (!caughtClara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    caughtClara.full_name = 'Clara Elizabeth Maple';
    caughtClara.given_name = 'Clara Elizabeth';
    caughtClara.surname = 'Maple';
    caughtClara.alt_names = [];
    caughtClara.is_living = false;
    caughtClara.birth_edtf = '1954-07-08';
    caughtClara.death_edtf = '';
    await writeFile(
      path.join(caughtRepo, 'data', 'people.yaml'),
      serializePeopleYaml(caughtPeople, { sortById: true }),
      'utf8'
    );
    const caughtPackage = path.join(caughtRepo, 'research', 'people', 'per_arthur_alder');
    await mkdir(caughtPackage, { recursive: true });
    await writeFile(
      path.join(caughtPackage, 'patch.json'),
      JSON.stringify({
        person_id: 'per_arthur_alder',
        narratives: [
          {
            id: 'nar_name_probe',
            slug: 'name-probe',
            title: 'Name Probe',
            person_ids: ['per_arthur_alder'],
            body_md: 'Clara Elizabeth Maple wrote home. Clara Maple replied later.',
          },
        ],
      }),
      'utf8'
    );
    const caught = await runAuditCommand({ repoDir: caughtRepo, personId: 'per_arthur_alder' });
    expect(caught.checks.privacy.livingNameHits.map((hit) => hit.match)).toEqual([
      'Clara Elizabeth Maple',
      'Clara Maple',
    ]);

    const sparedRepo = await createSyntheticRepo();
    const sparedPeople = parsePeopleYaml(
      await readFile(path.join(sparedRepo, 'data', 'people.yaml'), 'utf8')
    );
    const sparedClara = sparedPeople.find((person) => person.id === 'per_clara_maple_living');
    if (!sparedClara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    sparedClara.full_name = 'Clara Elizabeth Maple';
    sparedClara.given_name = 'Clara Elizabeth';
    sparedClara.surname = 'Maple';
    sparedClara.alt_names = [];
    sparedClara.is_living = false;
    sparedClara.birth_edtf = '1954-07-08';
    sparedClara.death_edtf = '';
    sparedPeople.push({
      id: 'per_clara_maple_1850',
      slug: 'clara-maple-1850',
      gedcom_xref: '@I100012@',
      full_name: 'Clara Maple',
      given_name: 'Clara',
      surname: 'Maple',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1850-02-02',
      death_edtf: '1920-03-03',
      portrait_url: null,
    });
    await writeFile(
      path.join(sparedRepo, 'data', 'people.yaml'),
      serializePeopleYaml(sparedPeople, { sortById: true }),
      'utf8'
    );
    const sparedPackage = path.join(sparedRepo, 'research', 'people', 'per_arthur_alder');
    await mkdir(sparedPackage, { recursive: true });
    await writeFile(
      path.join(sparedPackage, 'patch.json'),
      JSON.stringify({
        person_id: 'per_arthur_alder',
        narratives: [
          {
            id: 'nar_namesake_probe',
            slug: 'namesake-probe',
            title: 'Namesake Probe',
            person_ids: ['per_arthur_alder'],
            body_md: 'Clara Maple kept the letters. Clara Elizabeth Maple wrote them.',
          },
        ],
      }),
      'utf8'
    );
    const spared = await runAuditCommand({ repoDir: sparedRepo, personId: 'per_arthur_alder' });
    expect(spared.checks.privacy.livingNameHits.map((hit) => hit.match)).toEqual([
      'Clara Elizabeth Maple',
    ]);
  });

  it('skips derived First Surname on 1791 patch records while still flagging exact names and 1960/undated derived hits', async () => {
    const repoDir = await createSyntheticRepo();
    const people = parsePeopleYaml(await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    const clara = people.find((person) => person.id === 'per_clara_maple_living');
    if (!clara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    clara.full_name = 'Clara Elizabeth Maple';
    clara.given_name = 'Clara Elizabeth';
    clara.surname = 'Maple';
    clara.alt_names = [];
    clara.is_living = false;
    clara.birth_edtf = '1954-07-08';
    clara.death_edtf = '';
    people.push({
      id: 'per_ezra_maple_1720',
      slug: 'ezra-maple-1720',
      gedcom_xref: '@I100020@',
      full_name: 'Ezra Maple',
      given_name: 'Ezra',
      surname: 'Maple',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1720',
      death_edtf: '1795-11-01',
      portrait_url: null,
    });
    await writeFile(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml(people, { sortById: true }),
      'utf8'
    );

    // Add a live 1789 event so patch media without date_edtf inherits its date from live events.yaml.
    const liveEvents = parseEventsYaml(
      await readFile(path.join(repoDir, 'data', 'events.yaml'), 'utf8')
    );
    liveEvents.push({
      id: 'evt_1789_deed',
      title: 'Ezra Maple land deed',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1789-05-03',
      place_id: 'plc_oak_county_ohio',
      summary: 'Ezra Maple purchased farmland in Oak County.',
      participants: [{ person_id: 'per_ezra_maple_1720', role: 'principal' }],
      sources: [{ source_id: 'src_1880_census', confidence: 'medium' }],
    });
    await writeFile(
      path.join(repoDir, 'data', 'events.yaml'),
      serializeEventsYaml(liveEvents, { sortById: true }),
      'utf8'
    );

    const packageDir = path.join(repoDir, 'research', 'people', 'per_ezra_maple_1720');
    await mkdir(path.join(packageDir, 'scans'), { recursive: true });
    await writeFile(path.join(packageDir, 'scans', 'bond-1791.png'), makeMinimalPng(40, 40));
    await writeFile(path.join(packageDir, 'scans', 'deed-1789.png'), makeMinimalPng(40, 40));
    await writeFile(
      path.join(packageDir, 'dossier.md'),
      '# Ezra Maple (1720-1795)\n\nEzra Maple consented for daughter Clara Maple in 1791.\n',
      'utf8'
    );

    const basePatch = {
      person_id: 'per_ezra_maple_1720',
      person_updates: {
        extensions: {
          research_note: '1791 bond lists daughter Clara Maple.',
        },
      },
      sources: [
        {
          id: 'src_1791_bond',
          citation: 'Oak County Marriage Bond, 14 Feb 1791: Clara Maple married John Roe.',
          source_type: 'vital_record',
          repository: 'County Clerk',
        },
      ],
      events: [
        {
          id: 'evt_1791_marriage',
          title: 'Marriage bond mentioning Clara Maple',
          scope: 'family',
          event_kind: 'point_event',
          edtf_date: '1791-02-14',
          place_id: 'plc_oak_county_ohio',
          summary: 'Ezra Maple consented for daughter Clara Maple.',
          participants: [{ person_id: 'per_ezra_maple_1720', role: 'witness' }],
          sources: [{ source_id: 'src_1791_bond', confidence: 'high' }],
        },
      ],
      media: [
        {
          id: 'med_1791_bond',
          kind: 'document_scan',
          source_id: 'src_1791_bond',
          person_id: 'per_ezra_maple_1720',
          event_id: 'evt_1791_marriage',
          date_edtf: '1791-02-14',
          file: '/media/bond-1791.png',
          caption: '1791 bond for Clara Maple',
        },
        {
          id: 'med_1789_deed',
          kind: 'document_scan',
          source_id: 'src_1880_census',
          person_id: 'per_ezra_maple_1720',
          event_id: 'evt_1789_deed',
          file: '/media/deed-1789.png',
          caption: '1789 deed witnessed by Clara Maple',
        },
      ],
      narratives: [
        {
          id: 'nar_ezra_bio',
          slug: 'ezra-maple-bio',
          kind: 'biography',
          subject_person_id: 'per_ezra_maple_1720',
          title: 'Ezra Maple (1720-1795)',
          person_ids: ['per_ezra_maple_1720'],
          place_ids: ['plc_oak_county_ohio'],
          event_ids: ['evt_1791_marriage'],
          source_ids: ['src_1791_bond'],
          body_md: 'Ezra Maple witnessed Clara Maple marry in 1791.[^src_1791_bond|med_1791_bond]',
        },
      ],
    };

    await writeFile(path.join(packageDir, 'patch.json'), JSON.stringify(basePatch, null, 2), 'utf8');
    const cleanAudit = await runAuditCommand({
      repoDir,
      personId: 'per_ezra_maple_1720',
      json: true,
    });
    expect(cleanAudit.checks.privacy.livingNameHits).toEqual([]);
    expect(cleanAudit.checks.privacy.ok).toBe(true);
    expect(cleanAudit.ok).toBe(true);

    // Exact full name on 1791 text still fails audit.
    const exactLeakPatch = structuredClone(basePatch);
    exactLeakPatch.events[0]!.summary = 'Leaked exact name Clara Elizabeth Maple in 1791 text.';
    await writeFile(
      path.join(packageDir, 'patch.json'),
      JSON.stringify(exactLeakPatch, null, 2),
      'utf8'
    );
    const exactLeakAudit = await runAuditCommand({
      repoDir,
      personId: 'per_ezra_maple_1720',
      json: true,
    });
    expect(exactLeakAudit.ok).toBe(false);
    expect(exactLeakAudit.checks.privacy.ok).toBe(false);
    expect(exactLeakAudit.checks.privacy.livingNameHits).toEqual([
      { location: 'patch.events[0].summary', match: 'Clara Elizabeth Maple' },
    ]);

    // Derived First Surname on a 1960 event and an undated event still fails audit.
    const recentAndUndatedPatch = structuredClone(basePatch);
    recentAndUndatedPatch.events.push(
      {
        id: 'evt_1960_memorial',
        title: 'Memorial attended by Clara Maple',
        scope: 'family',
        event_kind: 'point_event',
        edtf_date: '1960-08-01',
        place_id: 'plc_oak_county_ohio',
        summary: 'Memorial plaque dedicated.',
        participants: [{ person_id: 'per_ezra_maple_1720', role: 'subject' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
      },
      {
        id: 'evt_undated_note',
        title: 'Undated family record mentioning Clara Maple',
        scope: 'family',
        event_kind: 'point_event',
        edtf_date: '',
        place_id: 'plc_oak_county_ohio',
        summary: 'No date recorded.',
        participants: [{ person_id: 'per_ezra_maple_1720', role: 'mentioned' }],
        sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
      }
    );
    await writeFile(
      path.join(packageDir, 'patch.json'),
      JSON.stringify(recentAndUndatedPatch, null, 2),
      'utf8'
    );
    const recentAudit = await runAuditCommand({
      repoDir,
      personId: 'per_ezra_maple_1720',
      json: true,
    });
    expect(recentAudit.ok).toBe(false);
    expect(recentAudit.checks.privacy.ok).toBe(false);
    expect(recentAudit.checks.privacy.livingNameHits).toEqual([
      { location: 'patch.events[1].title', match: 'Clara Maple' },
      { location: 'patch.events[2].title', match: 'Clara Maple' },
    ]);
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

  it('flags a living First Surname in a public narrative and skips a deceased namesake', async () => {
    const caughtRepo = await createSyntheticRepo();
    const caughtPeople = parsePeopleYaml(
      await readFile(path.join(caughtRepo, 'data', 'people.yaml'), 'utf8')
    );
    const caughtClara = caughtPeople.find((person) => person.id === 'per_clara_maple_living');
    if (!caughtClara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    caughtClara.full_name = 'Clara Elizabeth Maple';
    caughtClara.given_name = 'Clara Elizabeth';
    caughtClara.surname = 'Maple';
    caughtClara.alt_names = [];
    caughtClara.is_living = false;
    caughtClara.birth_edtf = '1954-07-08';
    caughtClara.death_edtf = '';
    await writeFile(
      path.join(caughtRepo, 'data', 'people.yaml'),
      serializePeopleYaml(caughtPeople, { sortById: true }),
      'utf8'
    );
    await writeFile(
      path.join(caughtRepo, 'data', 'narratives.yaml'),
      serializeNarrativesYaml(
        [
          {
            id: 'nar_name_probe',
            slug: 'name-probe',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Arthur Alder Biography',
            person_ids: ['per_arthur_alder'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
            body_md: 'Clara Elizabeth Maple wrote home. Clara Maple replied later.',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    const caught = await runVerifyCommand({ repoDir: caughtRepo, json: true });
    expect(caught.checks.livingNames.hits.map((hit) => hit.match)).toEqual([
      'Clara Elizabeth Maple',
      'Clara Maple',
    ]);
    expect(caught.checks.livingNames.hits.map((hit) => hit.location)).toEqual([
      'narrative:nar_name_probe:body_md',
      'narrative:nar_name_probe:body_md',
    ]);
    expect(caught.errors).toContain(
      "living-name: narrative:nar_name_probe:body_md matched 'Clara Maple'"
    );
    expect(caught.checks.livingNames.hits.some((hit) => hit.location.includes('evt_arthur_living_visit'))).toBe(
      false
    );
    expect(caught.checks.livingNames.hits.some((hit) => hit.location.includes('med_living_photo'))).toBe(
      false
    );

    const sparedRepo = await createSyntheticRepo();
    const sparedPeople = parsePeopleYaml(
      await readFile(path.join(sparedRepo, 'data', 'people.yaml'), 'utf8')
    );
    const sparedClara = sparedPeople.find((person) => person.id === 'per_clara_maple_living');
    if (!sparedClara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    sparedClara.full_name = 'Clara Elizabeth Maple';
    sparedClara.given_name = 'Clara Elizabeth';
    sparedClara.surname = 'Maple';
    sparedClara.alt_names = [];
    sparedClara.is_living = false;
    sparedClara.birth_edtf = '1954-07-08';
    sparedClara.death_edtf = '';
    sparedPeople.push({
      id: 'per_clara_maple_1850',
      slug: 'clara-maple-1850',
      gedcom_xref: '@I100012@',
      full_name: 'Clara Maple',
      given_name: 'Clara',
      surname: 'Maple',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1850-02-02',
      death_edtf: '1920-03-03',
      portrait_url: null,
    });
    await writeFile(
      path.join(sparedRepo, 'data', 'people.yaml'),
      serializePeopleYaml(sparedPeople, { sortById: true }),
      'utf8'
    );
    await writeFile(
      path.join(sparedRepo, 'data', 'narratives.yaml'),
      serializeNarrativesYaml(
        [
          {
            id: 'nar_namesake_probe',
            slug: 'namesake-probe',
            kind: 'biography',
            subject_person_id: 'per_arthur_alder',
            title: 'Namesake Probe',
            person_ids: ['per_arthur_alder'],
            place_ids: [],
            event_ids: [],
            source_ids: [],
            body_md: 'Clara Maple kept the letters. Clara Elizabeth Maple wrote them.',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    const spared = await runVerifyCommand({ repoDir: sparedRepo, json: true });
    expect(spared.checks.livingNames.hits.map((hit) => hit.match)).toEqual(['Clara Elizabeth Maple']);
    expect(spared.checks.livingNames.hits.map((hit) => hit.location)).toEqual([
      'narrative:nar_namesake_probe:body_md',
    ]);
  });

  it('skips derived First Surname on records predating the living person while keeping exact matches', async () => {
    const repoDir = await createSyntheticRepo();
    await mkdir(path.join(repoDir, 'media'), { recursive: true });
    await writeFile(path.join(repoDir, 'media', 'bond-1791.png'), makeMinimalPng(40, 40));

    const people = parsePeopleYaml(await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    const clara = people.find((person) => person.id === 'per_clara_maple_living');
    if (!clara) {
      throw new Error('fixture missing per_clara_maple_living');
    }
    clara.full_name = 'Clara Elizabeth Maple';
    clara.given_name = 'Clara Elizabeth';
    clara.surname = 'Maple';
    clara.alt_names = [];
    clara.is_living = false;
    clara.birth_edtf = '1954-07-08';
    clara.death_edtf = '';
    people.push({
      id: 'per_ezra_maple_1720',
      slug: 'ezra-maple-1720',
      gedcom_xref: '@I100020@',
      full_name: 'Ezra Maple',
      given_name: 'Ezra',
      surname: 'Maple',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1720',
      death_edtf: '1795-11-01',
      portrait_url: null,
    });
    await writeFile(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml(people, { sortById: true }),
      'utf8'
    );

    const sources = parseSourcesYaml(
      await readFile(path.join(repoDir, 'data', 'sources.yaml'), 'utf8')
    );
    sources.push({
      id: 'src_1791_bond',
      citation: 'Oak County Marriage Bond, 14 Feb 1791: Clara Maple married John Roe.',
      source_type: 'vital_record',
      repository: 'County Clerk',
    });
    await writeFile(
      path.join(repoDir, 'data', 'sources.yaml'),
      serializeSourcesYaml(sources, { sortById: true }),
      'utf8'
    );

    const events = parseEventsYaml(await readFile(path.join(repoDir, 'data', 'events.yaml'), 'utf8'));
    events.push({
      id: 'evt_1791_marriage',
      title: 'Marriage bond mentioning Clara Maple',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1791-02-14',
      place_id: 'plc_oak_county_ohio',
      summary: 'Ezra Maple consented for daughter Clara Maple.',
      participants: [{ person_id: 'per_ezra_maple_1720', role: 'witness' }],
      sources: [{ source_id: 'src_1791_bond', confidence: 'high' }],
    });
    await writeFile(
      path.join(repoDir, 'data', 'events.yaml'),
      serializeEventsYaml(events, { sortById: true }),
      'utf8'
    );

    await writeFile(
      path.join(repoDir, 'data', 'media.yaml'),
      serializeMediaYaml(
        [
          {
            id: 'med_1791_bond',
            kind: 'document_scan',
            source_id: 'src_1791_bond',
            person_id: 'per_ezra_maple_1720',
            event_id: 'evt_1791_marriage',
            date_edtf: '1791-02-14',
            file: '/media/bond-1791.png',
            caption: '1791 bond for Clara Maple',
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
            id: 'nar_ezra_bio',
            slug: 'ezra-maple-bio',
            kind: 'biography',
            subject_person_id: 'per_ezra_maple_1720',
            title: 'Ezra Maple (1720-1795)',
            person_ids: ['per_ezra_maple_1720'],
            place_ids: ['plc_oak_county_ohio'],
            event_ids: ['evt_1791_marriage'],
            source_ids: ['src_1791_bond'],
            body_md: 'Ezra Maple witnessed Clara Maple marry in 1791.[^src_1791_bond|med_1791_bond]',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    const historicalClean = await runVerifyCommand({ repoDir, json: true });
    expect(historicalClean.checks.livingNames.ok).toBe(true);
    expect(historicalClean.checks.livingNames.hits).toEqual([]);

    // Exact full name still triggers on 1791 text, and derived First Surname still triggers on 1960 text.
    events.push({
      id: 'evt_1960_reunion',
      title: 'Reunion attended by Clara Maple',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1960-08-01',
      place_id: 'plc_oak_county_ohio',
      summary: 'Family gathering.',
      participants: [{ person_id: 'per_arthur_alder', role: 'mentioned' }],
      sources: [{ source_id: 'src_1880_census', confidence: 'low' }],
    });
    const colonialEvent = events.find((event) => event.id === 'evt_1791_marriage');
    if (colonialEvent) {
      colonialEvent.summary = 'Leaked exact name Clara Elizabeth Maple in 1791 text.';
    }
    await writeFile(
      path.join(repoDir, 'data', 'events.yaml'),
      serializeEventsYaml(events, { sortById: true }),
      'utf8'
    );

    const flagged = await runVerifyCommand({ repoDir, json: true });
    expect(flagged.checks.livingNames.ok).toBe(false);
    expect(flagged.checks.livingNames.hits).toEqual([
      { location: 'event:evt_1791_marriage:summary', match: 'Clara Elizabeth Maple' },
      { location: 'event:evt_1960_reunion:title', match: 'Clara Maple' },
    ]);
  });

  it('flags two media records that share one normalized file path', async () => {
    const repoDir = await createSyntheticRepo();
    await mkdir(path.join(repoDir, 'media'), { recursive: true });
    await writeFile(path.join(repoDir, 'media', 'shared-scan.png'), makeMinimalPng(40, 40));
    await writeFile(
      path.join(repoDir, 'data', 'media.yaml'),
      serializeMediaYaml(
        [
          {
            id: 'med_b',
            kind: 'document_scan',
            person_id: 'per_arthur_alder',
            file: 'media/shared-scan.png',
            caption: 'Arthur Alder shared scan',
          },
          {
            id: 'med_a',
            kind: 'document_scan',
            person_id: 'per_arthur_alder',
            file: '/media/shared-scan.png',
            caption: 'Arthur Alder shared scan',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );

    const result = await runVerifyCommand({ repoDir, json: true });
    expect(result.checks.media.duplicateFiles).toEqual([
      { file: 'media/shared-scan.png', mediaIds: ['med_a', 'med_b'] },
    ]);
    expect(result.errors).toContain(
      "media: duplicate file 'media/shared-scan.png' on med_a, med_b"
    );
    expect(result.ok).toBe(false);
  });
});
