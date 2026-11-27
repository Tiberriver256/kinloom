import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type KinshipEdge,
  type Place,
  parseEventsYaml,
  parseKinloomConfigYaml,
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
import { runCli } from '../../cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import { classifyStagedPackages, isPackagePending, type OpsIo, runIntegrateCommand } from './index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.KINLOOM_TELEMETRY_FILE;
  delete process.env.KINLOOM_TELEMETRY_PARENT;
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
          surnames: ['Alder', 'Maple', 'Birch'],
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
  const repoDir = await makeTempDir('kinloom-batch-integrate-');
  const dataDir = path.join(repoDir, 'data');
  await mkdir(dataDir, { recursive: true });
  process.env.KINLOOM_TELEMETRY_FILE = path.join(repoDir, 'telemetry.jsonl');

  await writeFile(
    path.join(repoDir, 'kinloom.config.yaml'),
    serializeKinloomConfigYaml(makeSampleSiteConfig()),
    'utf8'
  );

  const people: RawPerson[] = [
    {
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      gedcom_xref: '@I1@',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1875-03-14',
      death_edtf: '1942-11-08',
      portrait_url: null,
    },
    {
      id: 'per_helen_maple',
      slug: 'helen-maple',
      gedcom_xref: '@I2@',
      full_name: 'Helen Maple',
      given_name: 'Helen',
      surname: 'Maple',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1878-06-21',
      death_edtf: '1950-02-19',
      portrait_url: null,
    },
    {
      id: 'per_clara_birch',
      slug: 'clara-birch',
      gedcom_xref: '@I3@',
      full_name: 'Clara Birch',
      given_name: 'Clara',
      surname: 'Birch',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1880-09-02',
      death_edtf: '1955-05-11',
      portrait_url: null,
    },
  ];

  const places: Place[] = [
    {
      id: 'plc_oak_county_ohio',
      slug: 'oak-county-ohio',
      name: 'Oak County',
      full_name: 'Oak County, Ohio, USA',
      place_type: 'county',
      parent_id: null,
      lat: 40.12,
      lng: -82.91,
      historical_names: [],
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src_oak_baseline',
      citation: 'Oak County Baseline Register, Ohio Historical Society',
      source_type: 'vital_record',
      repository: 'Ohio Historical Society',
      url: 'https://example.org/oak-baseline',
    },
  ];

  const events: RawEvent[] = [
    {
      id: 'evt_arthur_birth',
      title: 'Birth of Arthur Alder',
      scope: 'personal',
      event_kind: 'point_event',
      edtf_date: '1875-03-14',
      place_id: 'plc_oak_county_ohio',
      summary: 'Arthur Alder was born in Oak County.',
      participants: [{ person_id: 'per_arthur_alder', role: 'principal' }],
      sources: [{ source_id: 'src_oak_baseline', confidence: 'high' }],
    },
  ];

  await Promise.all([
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(sources, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events, { sortById: true }), 'utf8'),
    writeFile(
      path.join(dataDir, 'kinship.yaml'),
      serializeKinshipYaml([], { sortDeterministic: true }),
      'utf8'
    ),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml([], { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml([], { sortById: true }), 'utf8'),
  ]);

  return repoDir;
}

interface PackageFixtureInput {
  repoDir: string;
  packageDirOverride?: string;
  personId: string;
  fullName: string;
  eventId: string;
  eventDate: string;
  eventTitle: string;
  placeId?: string;
  sourceId?: string;
  mediaId?: string;
  scanName?: string;
  scanBytes?: Buffer;
  people?: Array<Record<string, unknown>>;
  places?: Array<Record<string, unknown>>;
  removeEventIds?: string[];
  kinship?: Array<Record<string, unknown>>;
  removeKinship?: Array<Record<string, unknown>>;
  bodyMd?: string;
}

async function writeStagedPackage(input: PackageFixtureInput): Promise<string> {
  const pkgDir = input.packageDirOverride ?? path.join(input.repoDir, 'research', 'people', input.personId);
  await mkdir(pkgDir, { recursive: true });

  const sourceId = input.sourceId ?? `src_${input.personId}_census`;
  const placeId = input.placeId ?? 'plc_oak_county_ohio';
  const mediaId = input.mediaId ?? `med_${input.personId}_scan`;
  const scanName = input.scanName ?? `${input.personId}-record.png`;
  const mediaFile = `/media/${scanName}`;

  if (input.scanBytes !== undefined) {
    const scansDir = path.join(pkgDir, 'scans');
    await mkdir(scansDir, { recursive: true });
    await writeFile(path.join(scansDir, scanName), input.scanBytes);
  }

  const patch: Record<string, unknown> = {
    person_id: input.personId,
    person_updates: {
      summary: `${input.fullName} resided in Oak County, Ohio.`,
    },
    ...(input.people ? { people: input.people } : {}),
    ...(input.places ? { places: input.places } : {}),
    sources: [
      {
        id: sourceId,
        citation: `County Register for ${sourceId}, State Archives`,
        source_type: 'vital_record',
        repository: 'State Archives',
        url: `https://example.org/${sourceId}`,
      },
    ],
    events: [
      {
        id: input.eventId,
        title: input.eventTitle,
        scope: 'personal',
        event_kind: 'residence_anchor',
        edtf_date: input.eventDate,
        place_id: placeId,
        summary: `${input.fullName} resided at ${placeId}.`,
        participants: [{ person_id: input.personId, role: 'principal' }],
        sources: [{ source_id: sourceId, confidence: 'high' }],
      },
    ],
    ...(input.removeEventIds ? { remove_event_ids: input.removeEventIds } : {}),
    ...(input.kinship ? { kinship: input.kinship } : {}),
    ...(input.removeKinship ? { remove_kinship: input.removeKinship } : {}),
    media: [
      {
        id: mediaId,
        kind: 'document_scan',
        person_id: input.personId,
        event_id: input.eventId,
        source_id: sourceId,
        file: mediaFile,
        caption: `Document scan for ${input.fullName}`,
      },
    ],
    narratives: [
      {
        id: `nar_${input.personId}_bio`,
        slug: `${input.personId.replaceAll('_', '-')}-biography`,
        kind: 'biography',
        subject_person_id: input.personId,
        title: `${input.fullName} Biography`,
        summary: `Verified life summary for ${input.fullName}.`,
        person_ids: [input.personId],
        place_ids: [placeId],
        event_ids: [input.eventId],
        source_ids: [sourceId],
        body_md:
          input.bodyMd ??
          `${input.fullName} appeared in the county register on ${input.eventDate}.[^${sourceId}|${mediaId}]`,
      },
    ],
  };

  await writeFile(path.join(pkgDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');
  return pkgDir;
}

describe('kinloom batch integrate and --pending-only', () => {
  it('preserves single-person integrate output and supports --package alias and help text', async () => {
    const repoDir = await createSyntheticRepo();
    const customDir = path.join(repoDir, 'custom-pkg', 'arthur');
    await writeStagedPackage({
      repoDir,
      packageDirOverride: customDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_1900',
      eventDate: '1900-06-01',
      eventTitle: 'Arthur Alder 1900 residence',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    const helpIntegrate = createCaptureIo();
    expect(await runCli(['integrate', '--help'], { io: helpIntegrate.io })).toBe(EXIT_OK);
    const helpIntegrateText = helpIntegrate.stdout.join('\n');
    expect(helpIntegrateText).toContain('--all-staged');
    expect(helpIntegrateText).toContain('--pending-only');
    expect(helpIntegrateText).toContain('--package <dir>');
    expect(helpIntegrateText).toContain('rollback');

    const helpAudit = createCaptureIo();
    expect(await runCli(['audit', '--help'], { io: helpAudit.io })).toBe(EXIT_OK);
    expect(helpAudit.stdout.join('\n')).toContain('--pending-only');

    const single = createCaptureIo();
    const code = await runCli(
      ['integrate', 'per_arthur_alder', '--package', customDir, '--repo', repoDir, '--json'],
      { io: single.io }
    );
    expect(code, single.stderr.join('\n')).toBe(EXIT_OK);
    const parsed = JSON.parse(single.stdout.join('\n')) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.personId).toBe('per_arthur_alder');
    expect(parsed.mode).toBeUndefined();
    expect(parsed.dryRun).toBe(false);
    expect(existsSync(path.join(repoDir, 'media', 'per_arthur_alder-record.png'))).toBe(true);
  });

  it('rejects invalid flag combinations with exit code 2', async () => {
    const repoDir = await createSyntheticRepo();
    const badInvocations: string[][] = [
      ['integrate', '--repo', repoDir],
      ['integrate', 'per_arthur_alder', 'per_helen_maple', '--package', '/tmp/x', '--repo', repoDir],
      ['integrate', '--all-staged', '--package-dir', '/tmp/x', '--repo', repoDir],
      ['integrate', 'per_arthur_alder', '--package', '/tmp/a', '--package-dir', '/tmp/b', '--repo', repoDir],
      ['integrate', 'per_arthur_alder', '--pending-only', '--repo', repoDir],
      ['integrate', '--all-staged', 'per_arthur_alder', '--repo', repoDir],
      ['integrate', '--all-staged', '--person', 'per_arthur_alder', '--repo', repoDir],
      ['integrate', '--person', 'per_arthur_alder', 'per_helen_maple', '--repo', repoDir],
      ['integrate', 'per_arthur_alder', 'per_arthur_alder', '--repo', repoDir],
      ['audit', 'per_arthur_alder', '--pending-only', '--repo', repoDir],
      ['audit', '--pending-only', '--repo', repoDir],
    ];

    for (const args of badInvocations) {
      const cap = createCaptureIo();
      const code = await runCli(args, { io: cap.io });
      expect(code, `expected EXIT_USAGE for: ${args.join(' ')}`).toBe(EXIT_USAGE);
      expect(cap.stderr.join('\n')).toContain('Validation error:');
    }
  });

  it('integrates multiple people in one command and allows non-conflicting shared sources and identical scans', async () => {
    const repoDir = await createSyntheticRepo();
    const sharedScan = makeMinimalPng(640, 480, 12_500);

    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_1900',
      eventDate: '1900-06-01',
      eventTitle: 'Helen Maple 1900 residence',
      sourceId: 'src_shared_1900_census',
      mediaId: 'med_shared_1900_page',
      scanName: 'shared-1900.png',
      scanBytes: sharedScan,
    });
    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_1900',
      eventDate: '1900-06-01',
      eventTitle: 'Arthur Alder 1900 residence',
      sourceId: 'src_shared_1900_census',
      mediaId: 'med_shared_1900_page',
      scanName: 'shared-1900.png',
      scanBytes: sharedScan,
    });

    const cap = createCaptureIo();
    const code = await runCli(
      ['integrate', 'per_helen_maple', 'per_arthur_alder', '--repo', repoDir, '--json'],
      { io: cap.io }
    );
    expect(code, cap.stderr.join('\n')).toBe(EXIT_OK);

    const payload = JSON.parse(cap.stdout.join('\n')) as {
      mode: string;
      ok: boolean;
      dryRun: boolean;
      requested: string[];
      integrated: string[];
      skippedAlreadyIntegrated: string[];
      preFlightOverlaps: {
        hasBlockingConflicts: boolean;
        overlaps: { sharedSourceIds: Array<{ id: string }> };
      };
      results: Array<{ personId: string }>;
      totals: {
        personUpdated: number;
        events: { added: number };
        sources: { added: number; unchanged: number };
        narratives: { added: number };
      };
      writtenYamlFiles: string[];
    };

    expect(payload.mode).toBe('batch');
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(false);
    expect(payload.requested).toEqual(['per_helen_maple', 'per_arthur_alder']);
    expect(payload.integrated).toEqual(['per_helen_maple', 'per_arthur_alder']);
    expect(payload.skippedAlreadyIntegrated).toEqual([]);
    expect(payload.preFlightOverlaps.hasBlockingConflicts).toBe(false);
    expect(payload.preFlightOverlaps.overlaps.sharedSourceIds).toEqual([
      { id: 'src_shared_1900_census', person_ids: ['per_arthur_alder', 'per_helen_maple'] },
    ]);
    expect(payload.results.map((r) => r.personId)).toEqual(['per_helen_maple', 'per_arthur_alder']);
    expect(payload.totals.personUpdated).toBe(2);
    expect(payload.totals.events.added).toBe(2);
    expect(payload.totals.sources.added).toBe(1);
    expect(payload.totals.sources.unchanged).toBe(1);
    expect(payload.totals.narratives.added).toBe(2);
    expect(payload.writtenYamlFiles).toContain(path.join(repoDir, 'data', 'events.yaml'));
    expect(payload.writtenYamlFiles).toContain(path.join(repoDir, 'data', 'narratives.yaml'));

    const liveEvents = parseEventsYaml(await readFile(path.join(repoDir, 'data', 'events.yaml'), 'utf8'));
    expect(liveEvents.map((e) => e.id)).toEqual(['evt_arthur_1900', 'evt_arthur_birth', 'evt_helen_1900']);
    const liveNarratives = parseNarrativesYaml(
      await readFile(path.join(repoDir, 'data', 'narratives.yaml'), 'utf8')
    );
    expect(liveNarratives.map((n) => n.id)).toEqual(['nar_per_arthur_alder_bio', 'nar_per_helen_maple_bio']);
    expect(existsSync(path.join(repoDir, 'media', 'shared-1900.png'))).toBe(true);
  });

  it('gives package 2 sequential dry-run visibility of package 1 new person, place, source, and scan without mutating disk', async () => {
    const repoDir = await createSyntheticRepo();
    const scanBytes = makeMinimalPng(640, 480, 12_000);

    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_cedar',
      eventDate: '1905-04-10',
      eventTitle: 'Arthur Alder at Cedar Mill',
      placeId: 'plc_cedar_mill_ohio',
      sourceId: 'src_cedar_mill_ledger',
      mediaId: 'med_cedar_ledger_page',
      scanName: 'cedar-ledger.png',
      scanBytes,
      places: [
        {
          id: 'plc_cedar_mill_ohio',
          slug: 'cedar-mill-ohio',
          name: 'Cedar Mill',
          full_name: 'Cedar Mill, Ohio, USA',
          place_type: 'town',
          parent_id: null,
          lat: 40.35,
          lng: -82.65,
          historical_names: [],
        },
      ],
      people: [
        {
          id: 'per_edward_alder',
          slug: 'edward-alder',
          full_name: 'Edward Alder',
          given_name: 'Edward',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1848-01-12',
          death_edtf: '1918-08-03',
          portrait_url: null,
        },
      ],
    });

    // Package 2 targets per_edward_alder (introduced by package 1) and references
    // package 1's new place, source, and scan without duplicating them.
    const edwardDir = path.join(repoDir, 'research', 'people', 'per_edward_alder');
    await mkdir(edwardDir, { recursive: true });
    await writeFile(
      path.join(edwardDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_edward_alder',
          person_updates: {
            summary: 'Edward Alder operated Cedar Mill.',
          },
          events: [
            {
              id: 'evt_edward_cedar',
              title: 'Edward Alder at Cedar Mill',
              scope: 'personal',
              event_kind: 'residence_anchor',
              edtf_date: '1905-04-10',
              place_id: 'plc_cedar_mill_ohio',
              summary: 'Edward Alder lived at Cedar Mill.',
              participants: [{ person_id: 'per_edward_alder', role: 'principal' }],
              sources: [{ source_id: 'src_cedar_mill_ledger', confidence: 'high' }],
            },
          ],
          media: [
            {
              id: 'med_cedar_ledger_page',
              kind: 'document_scan',
              person_id: 'per_edward_alder',
              event_id: 'evt_edward_cedar',
              source_id: 'src_cedar_mill_ledger',
              file: '/media/cedar-ledger.png',
              caption: 'Cedar Mill ledger entry for Edward Alder',
            },
          ],
          narratives: [
            {
              id: 'nar_per_edward_alder_bio',
              slug: 'edward-alder-biography',
              kind: 'biography',
              subject_person_id: 'per_edward_alder',
              title: 'Edward Alder Biography',
              summary: 'Verified biography of Edward Alder.',
              person_ids: ['per_edward_alder'],
              place_ids: ['plc_cedar_mill_ohio'],
              event_ids: ['evt_edward_cedar'],
              source_ids: ['src_cedar_mill_ledger'],
              body_md:
                'Edward Alder operated Cedar Mill in 1905.[^src_cedar_mill_ledger|med_cedar_ledger_page]',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const beforePeopleYaml = await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8');
    const beforePlacesYaml = await readFile(path.join(repoDir, 'data', 'places.yaml'), 'utf8');

    const dry = createCaptureIo();
    const dryCode = await runCli(
      ['integrate', 'per_arthur_alder', 'per_edward_alder', '--dry-run', '--repo', repoDir, '--json'],
      { io: dry.io }
    );
    expect(dryCode, dry.stderr.join('\n')).toBe(EXIT_OK);

    const dryPayload = JSON.parse(dry.stdout.join('\n')) as {
      mode: string;
      dryRun: boolean;
      integrated: string[];
      wouldWriteYamlFiles: string[];
      writtenYamlFiles: string[];
    };
    expect(dryPayload.mode).toBe('batch');
    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.integrated).toEqual(['per_arthur_alder', 'per_edward_alder']);
    expect(dryPayload.writtenYamlFiles).toEqual([]);
    expect(dryPayload.wouldWriteYamlFiles).toContain(path.join(repoDir, 'data', 'people.yaml'));
    expect(dryPayload.wouldWriteYamlFiles.every((p) => p.startsWith(path.join(repoDir, 'data')))).toBe(true);

    // Disk must remain untouched after dry-run.
    expect(await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8')).toBe(beforePeopleYaml);
    expect(await readFile(path.join(repoDir, 'data', 'places.yaml'), 'utf8')).toBe(beforePlacesYaml);
    expect(existsSync(path.join(repoDir, 'media', 'cedar-ledger.png'))).toBe(false);

    // Apply mode persists both cleanly.
    const apply = createCaptureIo();
    const applyCode = await runCli(['integrate', 'per_arthur_alder', 'per_edward_alder', '--repo', repoDir], {
      io: apply.io,
    });
    expect(applyCode, apply.stderr.join('\n')).toBe(EXIT_OK);
    expect(apply.stdout.join('\n')).toContain('Batch integrate OK: 2 package(s)');

    const livePeople = parsePeopleYaml(await readFile(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    expect(livePeople.map((p) => p.id)).toContain('per_edward_alder');
    const livePlaces = parsePlacesYaml(await readFile(path.join(repoDir, 'data', 'places.yaml'), 'utf8'));
    expect(livePlaces.map((p) => p.id)).toContain('plc_cedar_mill_ohio');
  });

  it('blocks batch integrate during pre-flight on differing scans, conflicting media ids, conflicting patch.people, slug collisions, and live media collisions without writing anything', async () => {
    // Case A: differing scan bytes + conflicting media IDs
    const repoA = await createSyntheticRepo();
    await writeStagedPackage({
      repoDir: repoA,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_conflict',
      eventDate: '1900-01-01',
      eventTitle: 'Arthur event',
      mediaId: 'med_arthur_conflict',
      scanName: 'colliding.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });
    await writeStagedPackage({
      repoDir: repoA,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_conflict',
      eventDate: '1900-01-01',
      eventTitle: 'Helen event',
      mediaId: 'med_helen_conflict',
      scanName: 'colliding.png',
      scanBytes: makeMinimalPng(320, 200, 13_000),
    });

    const beforeEventsA = await readFile(path.join(repoA, 'data', 'events.yaml'), 'utf8');
    const capA = createCaptureIo();
    const codeA = await runCli(['integrate', '--all-staged', '--repo', repoA], { io: capA.io });
    expect(codeA).toBe(EXIT_USAGE);
    expect(capA.stderr.join('\n')).toContain('differingScanCollisions=1');
    expect(capA.stderr.join('\n')).toContain('conflictingMediaFileCollisions=1');
    expect(await readFile(path.join(repoA, 'data', 'events.yaml'), 'utf8')).toBe(beforeEventsA);
    expect(existsSync(path.join(repoA, 'media', 'colliding.png'))).toBe(false);

    // Case B: conflicting patch.people fields + conflicting slug collision
    const repoB = await createSyntheticRepo();
    await writeStagedPackage({
      repoDir: repoB,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_p',
      eventDate: '1900-01-01',
      eventTitle: 'Arthur event',
      scanBytes: makeMinimalPng(640, 480, 12_000),
      people: [
        {
          id: 'per_shared_anc',
          slug: 'shared-anc',
          full_name: 'Samuel Alder',
          given_name: 'Samuel',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1845',
          death_edtf: '1910',
        },
        {
          id: 'per_slug_one',
          slug: 'duplicate-slug',
          full_name: 'John One',
          given_name: 'John',
          surname: 'One',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1840',
          death_edtf: '1905',
        },
      ],
    });
    await writeStagedPackage({
      repoDir: repoB,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_p',
      eventDate: '1900-01-01',
      eventTitle: 'Helen event',
      scanBytes: makeMinimalPng(640, 480, 12_000),
      people: [
        {
          id: 'per_shared_anc',
          slug: 'shared-anc',
          full_name: 'Samuel Alder',
          given_name: 'Samuel',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1849',
          death_edtf: '1910',
        },
        {
          id: 'per_slug_two',
          slug: 'duplicate-slug',
          full_name: 'John Two',
          given_name: 'John',
          surname: 'Two',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'alder',
          birth_edtf: '1842',
          death_edtf: '1908',
        },
      ],
    });

    const beforePeopleB = await readFile(path.join(repoB, 'data', 'people.yaml'), 'utf8');
    const capB = createCaptureIo();
    const codeB = await runCli(['integrate', 'per_arthur_alder', 'per_helen_maple', '--repo', repoB], {
      io: capB.io,
    });
    expect(codeB).toBe(EXIT_USAGE);
    expect(capB.stderr.join('\n')).toContain('conflictingPersonOverlaps=1');
    expect(capB.stderr.join('\n')).toContain('conflictingPersonSlugCollisions=1');
    expect(await readFile(path.join(repoB, 'data', 'people.yaml'), 'utf8')).toBe(beforePeopleB);

    // Case C: liveMediaFileCollisions
    const repoC = await createSyntheticRepo();
    const mediaPathC = path.join(repoC, 'data', 'media.yaml');
    await writeFile(
      mediaPathC,
      serializeMediaYaml(
        [
          {
            id: 'med_existing_live',
            kind: 'document_scan',
            person_id: 'per_clara_birch',
            file: '/media/live-owned.png',
            caption: 'Live owned scan',
          },
        ],
        { sortById: true }
      ),
      'utf8'
    );
    await writeStagedPackage({
      repoDir: repoC,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_live',
      eventDate: '1900-01-01',
      eventTitle: 'Arthur live',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });
    await writeStagedPackage({
      repoDir: repoC,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_live',
      eventDate: '1900-01-01',
      eventTitle: 'Helen live',
      mediaId: 'med_new_stealer',
      scanName: 'live-owned.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    const beforeMediaC = await readFile(mediaPathC, 'utf8');
    const capC = createCaptureIo();
    const codeC = await runCli(['integrate', '--all-staged', '--repo', repoC], { io: capC.io });
    expect(codeC).toBe(EXIT_USAGE);
    expect(capC.stderr.join('\n')).toContain('liveMediaFileCollisions=1');
    expect(await readFile(mediaPathC, 'utf8')).toBe(beforeMediaC);
    expect(existsSync(path.join(repoC, 'media', 'per_arthur_alder-record.png'))).toBe(false);
  });

  it('rolls back all modified YAML files and newly staged scans when package 2 fails mid-batch', async () => {
    const repoDir = await createSyntheticRepo();

    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_ok',
      eventDate: '1902-05-01',
      eventTitle: 'Arthur Alder 1902 residence',
      scanName: 'arthur-1902.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    // Package 2 passes JSON & overlap checks, then fails integrate validation due to missing place_id.
    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_bad',
      eventDate: '1903-05-01',
      eventTitle: 'Helen Maple bad place',
      placeId: 'plc_nonexistent_county',
      scanName: 'helen-1903.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    const yamlNames = [
      'people.yaml',
      'events.yaml',
      'places.yaml',
      'sources.yaml',
      'kinship.yaml',
      'media.yaml',
      'narratives.yaml',
    ];
    const beforeBytes = new Map<string, Buffer>();
    for (const name of yamlNames) {
      beforeBytes.set(name, await readFile(path.join(repoDir, 'data', name)));
    }

    const cap = createCaptureIo();
    const code = await runCli(['integrate', 'per_arthur_alder', 'per_helen_maple', '--repo', repoDir], {
      io: cap.io,
    });
    expect(code).toBe(EXIT_ERROR);
    const errText = cap.stderr.join('\n');
    expect(errText).toContain("Batch integrate failed on 'per_helen_maple'");
    expect(errText).toContain('plc_nonexistent_county');
    expect(errText).toContain('Rollback succeeded:');

    // Every YAML file must match its exact pre-batch bytes.
    for (const name of yamlNames) {
      const after = await readFile(path.join(repoDir, 'data', name));
      expect(after.equals(beforeBytes.get(name)!), `${name} must be rolled back byte-for-byte`).toBe(true);
    }

    // Newly staged scan from package 1 must be unlinked.
    expect(existsSync(path.join(repoDir, 'media', 'arthur-1902.png'))).toBe(false);
    expect(existsSync(path.join(repoDir, 'media', 'helen-1903.png'))).toBe(false);
  });

  it('supports --pending-only for both audit and integrate, keeps broken packages pending, and reports clean 0-pending summaries', async () => {
    const repoDir = await createSyntheticRepo();

    // 1. Stage Arthur and integrate him immediately so he is already integrated.
    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_done',
      eventDate: '1900-06-01',
      eventTitle: 'Arthur Alder 1900 residence',
      scanName: 'arthur-done.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });
    await runIntegrateCommand({ repoDir, personId: 'per_arthur_alder', dryRun: false });

    // 2. Stage Helen (pending valid) and Clara (pending broken: dangling place_id).
    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_pending',
      eventDate: '1901-07-01',
      eventTitle: 'Helen Maple 1901 residence',
      scanName: 'helen-pending.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });
    await writeStagedPackage({
      repoDir,
      personId: 'per_clara_birch',
      fullName: 'Clara Birch',
      eventId: 'evt_clara_broken',
      eventDate: '1902-08-01',
      eventTitle: 'Clara Birch broken place',
      placeId: 'plc_missing_place',
      scanName: 'clara-broken.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    // Shared classification helper checks.
    expect(await isPackagePending(repoDir, 'per_arthur_alder')).toBe(false);
    expect(await isPackagePending(repoDir, 'per_helen_maple')).toBe(true);
    expect(await isPackagePending(repoDir, 'per_clara_birch')).toBe(true);

    const classified = await classifyStagedPackages(repoDir);
    expect(classified.alreadyIntegrated).toEqual(['per_arthur_alder']);
    expect(classified.pending).toEqual(['per_clara_birch', 'per_helen_maple']);
    expect(classified.statuses).toEqual([
      { kind: 'already_integrated', personId: 'per_arthur_alder', reason: 'receipt_match' },
      expect.objectContaining({ kind: 'pending', personId: 'per_clara_birch', reason: 'error' }),
      { kind: 'pending', personId: 'per_helen_maple', reason: 'changes' },
    ]);

    // Audit --all-staged --pending-only skips Arthur but MUST audit broken Clara and pending Helen.
    const auditWithBroken = createCaptureIo();
    const auditBrokenCode = await runCli(
      ['audit', '--all-staged', '--pending-only', '--strict', '--repo', repoDir, '--json'],
      { io: auditWithBroken.io }
    );
    expect(auditBrokenCode).toBe(EXIT_ERROR);
    const auditBrokenJson = JSON.parse(auditWithBroken.stdout.join('\n')) as {
      ok: boolean;
      people: Array<{ person_id: string; ok: boolean }>;
      skippedAlreadyIntegrated: string[];
    };
    expect(auditBrokenJson.ok).toBe(false);
    expect(auditBrokenJson.skippedAlreadyIntegrated).toEqual(['per_arthur_alder']);
    expect(auditBrokenJson.people.map((p) => [p.person_id, p.ok])).toEqual([
      ['per_clara_birch', false],
      ['per_helen_maple', true],
    ]);

    // Fix Clara's package by removing it so only Arthur (integrated) and Helen (pending) remain.
    await rm(path.join(repoDir, 'research', 'people', 'per_clara_birch'), {
      recursive: true,
      force: true,
    });

    // Audit --all-staged --pending-only now passes on Helen alone and skips Arthur.
    const auditPending = createCaptureIo();
    expect(
      await runCli(['audit', '--all-staged', '--pending-only', '--strict', '--repo', repoDir, '--json'], {
        io: auditPending.io,
      })
    ).toBe(EXIT_OK);
    const auditPendingJson = JSON.parse(auditPending.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      people: Array<{ person_id: string }>;
      skippedAlreadyIntegrated: string[];
    };
    expect(auditPendingJson.ok).toBe(true);
    expect(auditPendingJson.strictOk).toBe(true);
    expect(auditPendingJson.people.map((p) => p.person_id)).toEqual(['per_helen_maple']);
    expect(auditPendingJson.skippedAlreadyIntegrated).toEqual(['per_arthur_alder']);

    // Integrate --all-staged --pending-only merges only Helen and skips Arthur.
    const integratePending = createCaptureIo();
    expect(
      await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
        io: integratePending.io,
      })
    ).toBe(EXIT_OK);
    const integratePendingJson = JSON.parse(integratePending.stdout.join('\n')) as {
      mode: string;
      ok: boolean;
      requested: string[];
      integrated: string[];
      skippedAlreadyIntegrated: string[];
      writtenYamlFiles: string[];
    };
    expect(integratePendingJson.mode).toBe('batch');
    expect(integratePendingJson.ok).toBe(true);
    expect(integratePendingJson.requested).toEqual(['per_arthur_alder', 'per_helen_maple']);
    expect(integratePendingJson.integrated).toEqual(['per_helen_maple']);
    expect(integratePendingJson.skippedAlreadyIntegrated).toEqual(['per_arthur_alder']);
    expect(integratePendingJson.writtenYamlFiles.length).toBeGreaterThan(0);

    // Now 0 pending packages remain: both audit and integrate return EXIT_OK with clear 0-pending summaries.
    const auditZeroText = createCaptureIo();
    expect(
      await runCli(['audit', '--all-staged', '--pending-only', '--strict', '--repo', repoDir], {
        io: auditZeroText.io,
      })
    ).toBe(EXIT_OK);
    expect(auditZeroText.stdout.join('\n')).toContain('0 people (2 already integrated skipped)');
    expect(auditZeroText.stdout.join('\n')).toContain('No pending staged packages remain to audit.');

    const auditZeroJson = createCaptureIo();
    expect(
      await runCli(['audit', '--all-staged', '--pending-only', '--strict', '--repo', repoDir, '--json'], {
        io: auditZeroJson.io,
      })
    ).toBe(EXIT_OK);
    const auditZeroParsed = JSON.parse(auditZeroJson.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      people: unknown[];
      skippedAlreadyIntegrated: string[];
    };
    expect(auditZeroParsed.ok).toBe(true);
    expect(auditZeroParsed.strictOk).toBe(true);
    expect(auditZeroParsed.people).toEqual([]);
    expect(auditZeroParsed.skippedAlreadyIntegrated).toEqual(['per_arthur_alder', 'per_helen_maple']);

    const integrateZeroText = createCaptureIo();
    expect(
      await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir], {
        io: integrateZeroText.io,
      })
    ).toBe(EXIT_OK);
    expect(integrateZeroText.stdout.join('\n')).toContain(
      'Batch integrate OK: 0 package(s) (2 already integrated skipped)'
    );
    expect(integrateZeroText.stdout.join('\n')).toContain('No pending staged packages remain to integrate.');

    const integrateZeroJson = createCaptureIo();
    expect(
      await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
        io: integrateZeroJson.io,
      })
    ).toBe(EXIT_OK);
    const integrateZeroParsed = JSON.parse(integrateZeroJson.stdout.join('\n')) as {
      mode: string;
      ok: boolean;
      integrated: string[];
      skippedAlreadyIntegrated: string[];
      writtenYamlFiles: string[];
    };
    expect(integrateZeroParsed.mode).toBe('batch');
    expect(integrateZeroParsed.ok).toBe(true);
    expect(integrateZeroParsed.integrated).toEqual([]);
    expect(integrateZeroParsed.skippedAlreadyIntegrated).toEqual(['per_arthur_alder', 'per_helen_maple']);
    expect(integrateZeroParsed.writtenYamlFiles).toEqual([]);

    // Removing the staged scan on disk marks Arthur pending again even though YAML is unchanged.
    await rm(path.join(repoDir, 'media', 'arthur-done.png'));
    expect(await isPackagePending(repoDir, 'per_arthur_alder')).toBe(true);

    // Verify live YAML still parses cleanly with both people's sources and media.
    const liveSources = parseSourcesYaml(await readFile(path.join(repoDir, 'data', 'sources.yaml'), 'utf8'));
    expect(liveSources.map((s) => s.id)).toContain('src_per_helen_maple_census');
    const liveMedia = parseMediaYaml(await readFile(path.join(repoDir, 'data', 'media.yaml'), 'utf8'));
    expect(liveMedia.map((m) => m.id)).toContain('med_per_helen_maple_scan');
  });

  it('classifies packages with live remove_kinship targets as pending and as already_integrated once removed', async () => {
    const repoDir = await createSyntheticRepo();
    const kinshipPath = path.join(repoDir, 'data', 'kinship.yaml');
    const seededKinship: KinshipEdge[] = [
      { from: 'per_helen_maple', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F1@' },
      { from: 'per_arthur_alder', to: 'per_helen_maple', relation: 'child', family_xref: '@F1@' },
      { from: 'per_arthur_alder', to: 'per_clara_birch', relation: 'spouse', family_xref: '@F2@' },
      { from: 'per_clara_birch', to: 'per_arthur_alder', relation: 'spouse', family_xref: '@F2@' },
    ];
    await writeFile(kinshipPath, serializeKinshipYaml(seededKinship, { sortDeterministic: true }), 'utf8');

    const pkgDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_arthur_alder',
          remove_kinship: [
            { from: 'per_helen_maple', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F1@' },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    expect(await isPackagePending(repoDir, 'per_arthur_alder')).toBe(true);
    const beforeClassify = await classifyStagedPackages(repoDir);
    expect(beforeClassify.pending).toEqual(['per_arthur_alder']);
    expect(beforeClassify.alreadyIntegrated).toEqual([]);

    const cap = createCaptureIo();
    const code = await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
      io: cap.io,
    });
    expect(code, `${cap.stderr.join('\n')}\n${cap.stdout.join('\n')}`).toBe(EXIT_OK);
    const body = JSON.parse(cap.stdout.join('\n')) as {
      integrated: string[];
      totals: { removedKinship: number };
      writtenYamlFiles: string[];
    };
    expect(body.integrated).toEqual(['per_arthur_alder']);
    expect(body.totals.removedKinship).toBe(2);
    expect(body.writtenYamlFiles).toEqual([kinshipPath]);

    const liveAfter = parseKinshipYaml(await readFile(kinshipPath, 'utf8'));
    expect(liveAfter).toEqual([
      { from: 'per_arthur_alder', to: 'per_clara_birch', relation: 'spouse', family_xref: '@F2@' },
      { from: 'per_clara_birch', to: 'per_arthur_alder', relation: 'spouse', family_xref: '@F2@' },
    ]);

    expect(await isPackagePending(repoDir, 'per_arthur_alder')).toBe(false);
    const afterClassify = await classifyStagedPackages(repoDir);
    expect(afterClassify.pending).toEqual([]);
    expect(afterClassify.alreadyIntegrated).toEqual(['per_arthur_alder']);
  });

  it('blocks batch audit --strict and batch integrate when one package adds a kinship edge that another removes', async () => {
    const repoDir = await createSyntheticRepo();
    const kinshipPath = path.join(repoDir, 'data', 'kinship.yaml');
    const beforeKinship = await readFile(kinshipPath, 'utf8');

    // Package A adds (per_arthur_alder -> per_clara_birch, child); Package B removes the reciprocal parent edge (symmetric default).
    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_kin',
      eventDate: '1900-01-01',
      eventTitle: 'Arthur Alder 1900 residence',
      scanName: 'arthur-kin.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
      kinship: [
        { from: 'per_clara_birch', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F5@' },
        { from: 'per_arthur_alder', to: 'per_clara_birch', relation: 'child', family_xref: '@F5@' },
      ],
    });
    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_kin',
      eventDate: '1901-01-01',
      eventTitle: 'Helen Maple 1901 residence',
      scanName: 'helen-kin.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
      removeKinship: [{ from: 'per_clara_birch', to: 'per_arthur_alder', relation: 'parent' }],
    });

    const auditCap = createCaptureIo();
    const auditCode = await runCli(['audit', '--all-staged', '--strict', '--repo', repoDir, '--json'], {
      io: auditCap.io,
    });
    expect(auditCode).toBe(EXIT_ERROR);
    const auditJson = JSON.parse(auditCap.stdout.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      summary: { kinshipAddRemoveConflicts: number };
      overlaps: {
        kinshipAddRemoveConflicts: Array<{
          from: string;
          to: string;
          relation: string;
          addedBy: string[];
          removedBy: string[];
        }>;
      };
    };
    expect(auditJson.ok).toBe(true);
    expect(auditJson.strictOk).toBe(false);
    expect(auditJson.summary.kinshipAddRemoveConflicts).toBe(2);
    expect(auditJson.overlaps.kinshipAddRemoveConflicts).toEqual([
      {
        from: 'per_arthur_alder',
        to: 'per_clara_birch',
        relation: 'child',
        addedBy: ['per_arthur_alder'],
        removedBy: ['per_helen_maple'],
      },
      {
        from: 'per_clara_birch',
        to: 'per_arthur_alder',
        relation: 'parent',
        addedBy: ['per_arthur_alder'],
        removedBy: ['per_helen_maple'],
      },
    ]);

    const integrateCap = createCaptureIo();
    const integrateCode = await runCli(['integrate', '--all-staged', '--repo', repoDir], {
      io: integrateCap.io,
    });
    expect(integrateCode).toBe(EXIT_USAGE);
    expect(integrateCap.stderr.join('\n')).toContain('kinshipAddRemoveConflicts=2');
    expect(await readFile(kinshipPath, 'utf8')).toBe(beforeKinship);
    expect(existsSync(path.join(repoDir, 'media', 'arthur-kin.png'))).toBe(false);
  });

  it('rolls back data/kinship.yaml byte-for-byte when package 1 removes kinship and package 2 fails mid-batch', async () => {
    const repoDir = await createSyntheticRepo();
    const kinshipPath = path.join(repoDir, 'data', 'kinship.yaml');
    const seededKinship: KinshipEdge[] = [
      { from: 'per_arthur_alder', to: 'per_helen_maple', relation: 'child', family_xref: '@F1@' },
      { from: 'per_helen_maple', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F1@' },
    ];
    await writeFile(kinshipPath, serializeKinshipYaml(seededKinship, { sortDeterministic: true }), 'utf8');
    const beforeKinshipBytes = await readFile(kinshipPath);

    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_rb',
      eventDate: '1902-05-01',
      eventTitle: 'Arthur Alder 1902 residence',
      scanName: 'arthur-rb.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
      removeKinship: [
        { from: 'per_helen_maple', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F1@' },
      ],
      kinship: [
        { from: 'per_clara_birch', to: 'per_arthur_alder', relation: 'parent', family_xref: '@F8@' },
        { from: 'per_arthur_alder', to: 'per_clara_birch', relation: 'child', family_xref: '@F8@' },
      ],
    });
    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_rb_fail',
      eventDate: '1903-05-01',
      eventTitle: 'Helen Maple missing place failure',
      placeId: 'plc_missing_rollback_county',
      scanName: 'helen-rb.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    const cap = createCaptureIo();
    const code = await runCli(['integrate', 'per_arthur_alder', 'per_helen_maple', '--repo', repoDir], {
      io: cap.io,
    });
    expect(code).toBe(EXIT_ERROR);
    expect(cap.stderr.join('\n')).toContain('Rollback succeeded:');

    const afterKinshipBytes = await readFile(kinshipPath);
    expect(afterKinshipBytes.equals(beforeKinshipBytes)).toBe(true);
    expect(parseKinshipYaml(afterKinshipBytes.toString('utf8'))).toEqual(seededKinship);
    expect(existsSync(path.join(repoDir, 'media', 'arthur-rb.png'))).toBe(false);
  });

  it('handles forgiving integrate --dry-run flag ordering, --person-id, --package/--patch file paths, and clear missing-target hints', async () => {
    const repoDir = await createSyntheticRepo();
    const pkgDir = await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_order',
      eventDate: '1904-06-01',
      eventTitle: 'Arthur Alder 1904 residence',
      scanName: 'arthur-order.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });
    const patchFile = path.join(pkgDir, 'patch.json');

    const validInvocations: string[][] = [
      ['integrate', '--dry-run', 'per_arthur_alder', '--repo', repoDir, '--json'],
      ['integrate', '--repo', repoDir, '--dry-run', '--json', 'per_arthur_alder'],
      ['integrate', '--dry-run', '--person-id', 'per_arthur_alder', '--repo', repoDir, '--json'],
      ['integrate', '--dry-run', '--package', patchFile, '--repo', repoDir, '--json'],
      ['integrate', '--dry-run', '--patch', pkgDir, '--repo', repoDir, '--json'],
      ['integrate', '--dry-run', pkgDir, '--repo', repoDir, '--json'],
      ['integrate', '--dry-run', patchFile, '--repo', repoDir, '--json'],
    ];

    for (const args of validInvocations) {
      const cap = createCaptureIo();
      const code = await runCli(args, { io: cap.io });
      expect(code, `args=${args.join(' ')} stderr=${cap.stderr.join('\n')}`).toBe(EXIT_OK);
      const body = JSON.parse(cap.stdout.join('\n')) as { ok: boolean; dryRun: boolean; personId: string };
      expect(body.ok).toBe(true);
      expect(body.dryRun).toBe(true);
      expect(body.personId).toBe('per_arthur_alder');
    }

    // Also works when cwd is the archive repo root and --repo is omitted.
    const cwdCap = createCaptureIo();
    const cwdCode = await runCli(['integrate', '--dry-run', 'research/people/per_arthur_alder', '--json'], {
      io: cwdCap.io,
      cwd: repoDir,
    });
    expect(cwdCode, cwdCap.stderr.join('\n')).toBe(EXIT_OK);
    expect(JSON.parse(cwdCap.stdout.join('\n')).personId).toBe('per_arthur_alder');

    // Missing target with --dry-run exits 2 with a clear hint mentioning <person_id> and --all-staged.
    const missingCap = createCaptureIo();
    const missingCode = await runCli(['integrate', '--dry-run', '--repo', repoDir], { io: missingCap.io });
    expect(missingCode).toBe(EXIT_USAGE);
    const errText = missingCap.stderr.join('\n');
    expect(errText).toContain('<person_id>');
    expect(errText).toContain('--all-staged');
  });

  it('writes .integrated.json receipts, skips receipt-matched packages after live YAML mutations, re-queues modified patches, classifies legacy drifted packages, and rolls back receipts on failure', async () => {
    const repoDir = await createSyntheticRepo();

    await writeStagedPackage({
      repoDir,
      personId: 'per_arthur_alder',
      fullName: 'Arthur Alder',
      eventId: 'evt_arthur_receipt',
      eventDate: '1900-06-01',
      eventTitle: 'Arthur Alder 1900 census',
      scanName: 'arthur-receipt.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    // 1. Integrate package -> verify .integrated.json receipt is written with matching patch_sha256 & scans_sha256.
    const intCap = createCaptureIo();
    expect(
      await runCli(['integrate', 'per_arthur_alder', '--repo', repoDir, '--json'], {
        io: intCap.io,
      })
    ).toBe(EXIT_OK);

    const pkgDir = path.join(repoDir, 'research', 'people', 'per_arthur_alder');
    const receiptPath = path.join(pkgDir, '.integrated.json');
    expect(existsSync(receiptPath)).toBe(true);
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      schema_version: number;
      person_id: string;
      patch_sha256: string;
      scans_sha256: Record<string, string>;
      integrated_entity_ids: { people: string[]; events: string[]; narratives: string[] };
    };
    expect(receipt.schema_version).toBe(1);
    expect(receipt.person_id).toBe('per_arthur_alder');
    expect(receipt.patch_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.scans_sha256['arthur-receipt.png']).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.integrated_entity_ids.people).toContain('per_arthur_alder');
    expect(receipt.integrated_entity_ids.events).toContain('evt_arthur_receipt');

    // 2. Mutate live data/narratives.yaml to add has_primary_source: true and an updated prose sentence.
    const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');
    const liveNarratives = parseNarrativesYaml(await readFile(narrativesPath, 'utf8'));
    const updatedNarratives = liveNarratives.map((nar) =>
      nar.subject_person_id === 'per_arthur_alder'
        ? {
            ...nar,
            has_primary_source: true,
            body_md: `${nar.body_md}\n\nLater live editorial polish kept intact.`,
          }
        : nar
    );
    await writeFile(narrativesPath, serializeNarrativesYaml(updatedNarratives, { sortById: true }), 'utf8');

    const classifiedAfterLiveEdit = await classifyStagedPackages(repoDir);
    expect(classifiedAfterLiveEdit.alreadyIntegrated).toEqual(['per_arthur_alder']);
    expect(classifiedAfterLiveEdit.pending).toEqual([]);
    expect(classifiedAfterLiveEdit.statuses).toEqual([
      { kind: 'already_integrated', personId: 'per_arthur_alder', reason: 'receipt_match' },
    ]);

    const integratePendingCap = createCaptureIo();
    expect(
      await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
        io: integratePendingCap.io,
      })
    ).toBe(EXIT_OK);
    const integratePendingBody = JSON.parse(integratePendingCap.stdout.join('\n')) as {
      integrated: string[];
      skippedAlreadyIntegrated: string[];
      writtenYamlFiles: string[];
    };
    expect(integratePendingBody.integrated).toEqual([]);
    expect(integratePendingBody.skippedAlreadyIntegrated).toEqual(['per_arthur_alder']);
    expect(integratePendingBody.writtenYamlFiles).toEqual([]);

    const auditPendingCap = createCaptureIo();
    expect(
      await runCli(['audit', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
        io: auditPendingCap.io,
      })
    ).toBe(EXIT_OK);
    const auditPendingBody = JSON.parse(auditPendingCap.stdout.join('\n')) as {
      people: unknown[];
      skippedAlreadyIntegrated: string[];
    };
    expect(auditPendingBody.people).toEqual([]);
    expect(auditPendingBody.skippedAlreadyIntegrated).toEqual(['per_arthur_alder']);

    // Verify the live edit is untouched.
    const liveNarrativeText = await readFile(narrativesPath, 'utf8');
    expect(liveNarrativeText).toContain('Later live editorial polish kept intact.');
    expect(liveNarrativeText).toContain('has_primary_source: true');

    // 3. Delete .integrated.json (legacy pre-receipt archive simulation) after live mutation ->
    //    classifyStagedPackages marks it already_integrated_drifted (live_superseded) and skips overwriting live YAML.
    await rm(receiptPath);
    const classifiedLegacyDrifted = await classifyStagedPackages(repoDir);
    expect(classifiedLegacyDrifted.pending).toEqual([]);
    expect(classifiedLegacyDrifted.alreadyIntegratedDrifted).toEqual(['per_arthur_alder']);
    expect(classifiedLegacyDrifted.statuses).toEqual([
      { kind: 'already_integrated_drifted', personId: 'per_arthur_alder', reason: 'live_superseded' },
    ]);

    const driftedRunCap = createCaptureIo();
    expect(
      await runCli(['integrate', '--all-staged', '--pending-only', '--repo', repoDir, '--json'], {
        io: driftedRunCap.io,
      })
    ).toBe(EXIT_OK);
    const driftedBody = JSON.parse(driftedRunCap.stdout.join('\n')) as {
      integrated: string[];
      skippedDrifted: string[];
      writtenYamlFiles: string[];
    };
    expect(driftedBody.integrated).toEqual([]);
    expect(driftedBody.skippedDrifted).toEqual(['per_arthur_alder']);
    expect(driftedBody.writtenYamlFiles).toEqual([]);
    expect(await readFile(narrativesPath, 'utf8')).toContain('Later live editorial polish kept intact.');

    // --mark-integrated backfills .integrated.json without touching live YAML.
    const markCap = createCaptureIo();
    expect(
      await runCli(
        ['integrate', '--all-staged', '--pending-only', '--mark-integrated', '--repo', repoDir, '--json'],
        { io: markCap.io }
      )
    ).toBe(EXIT_OK);
    expect(existsSync(receiptPath)).toBe(true);
    expect(JSON.parse(markCap.stdout.join('\n')).markedIntegrated).toEqual(['per_arthur_alder']);

    // 4. Edit patch.json -> classifyStagedPackages marks it pending (reason: 'package_modified').
    const patchPath = path.join(pkgDir, 'patch.json');
    const rawPatch = JSON.parse(await readFile(patchPath, 'utf8')) as Record<string, unknown>;
    rawPatch.person_updates = { alt_names: ['Artie Alder'] };
    await writeFile(patchPath, JSON.stringify(rawPatch, null, 2), 'utf8');

    const classifiedModified = await classifyStagedPackages(repoDir);
    expect(classifiedModified.pending).toEqual(['per_arthur_alder']);
    expect(classifiedModified.statuses).toEqual([
      { kind: 'pending', personId: 'per_arthur_alder', reason: 'package_modified' },
    ]);

    // 5. Batch rollback restores .integrated.json receipts alongside data/*.yaml when a later package fails.
    const prevReceiptBytes = await readFile(receiptPath);
    await writeStagedPackage({
      repoDir,
      personId: 'per_helen_maple',
      fullName: 'Helen Maple',
      eventId: 'evt_helen_fail_receipt_rb',
      eventDate: '1903-05-01',
      eventTitle: 'Helen Maple missing place failure',
      placeId: 'plc_missing_receipt_rb',
      scanName: 'helen-rb-receipt.png',
      scanBytes: makeMinimalPng(640, 480, 12_000),
    });

    const rbCap = createCaptureIo();
    const rbCode = await runCli(['integrate', 'per_arthur_alder', 'per_helen_maple', '--repo', repoDir], {
      io: rbCap.io,
    });
    expect(rbCode).toBe(EXIT_ERROR);
    expect(rbCap.stderr.join('\n')).toContain('Rollback succeeded:');
    expect((await readFile(receiptPath)).equals(prevReceiptBytes)).toBe(true);
    expect(existsSync(path.join(repoDir, 'research', 'people', 'per_helen_maple', '.integrated.json'))).toBe(
      false
    );
  });
});
