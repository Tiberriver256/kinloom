import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type MediaItem,
  type Narrative,
  type Place,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseMediaYaml,
  parseNarrativesYaml,
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
import { EXIT_OK, EXIT_USAGE } from '../../errors.js';
import { type OpsIo, runMediaDedupeCommand, runVerifyCommand } from './index.js';

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

function makeSampleSiteConfig(): KinloomSiteConfig {
  return parseKinloomConfigYaml(
    serializeKinloomConfigYaml({
      schemaVersion: 1,
      site: {
        title: 'Alder Historical Archive',
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
      mapDefaults: { centerLat: 39.8, centerLng: -83.0, zoom: 5, minSpanDeg: 1.2 },
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

async function createDuplicateMediaRepo(): Promise<string> {
  const repoDir = await makeTempDir('kinloom-media-dedupe-');
  const dataDir = path.join(repoDir, 'data');
  const mediaScanDir = path.join(repoDir, 'media', 'scans');
  await mkdir(dataDir, { recursive: true });
  await mkdir(mediaScanDir, { recursive: true });
  await writeFile(path.join(mediaScanDir, 'census_1880.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const people: RawPerson[] = [
    {
      id: 'per_arthur_alder',
      slug: 'arthur-alder',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1855-03-10',
      death_edtf: '1922-11-04',
      portrait_url: null,
    },
    {
      id: 'per_helen_maple',
      slug: 'helen-maple',
      full_name: 'Helen Maple',
      given_name: 'Helen',
      surname: 'Maple',
      alt_names: [],
      sex: 'F',
      is_living: false,
      lineage_group: 'ancestor',
      branch: 'alder',
      birth_edtf: '1858-07-12',
      death_edtf: '1930-01-19',
      portrait_url: null,
    },
  ];

  const places: Place[] = [
    {
      id: 'plc_cedar_county',
      slug: 'cedar-county',
      name: 'Cedar County',
      full_name: 'Cedar County, Ohio, United States',
      place_type: 'county',
      parent_id: null,
      lat: 40.1,
      lng: -82.9,
    },
  ];

  const sources: SourceRecord[] = [
    {
      id: 'src_1880_census',
      citation: '1880 U.S. Census, Cedar County, Ohio, Sheet 14B',
      source_type: 'census',
    },
  ];

  const events: RawEvent[] = [
    {
      id: 'evt_1880_census',
      title: '1880 Federal Census household in Cedar County',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1880-06-14',
      place_id: 'plc_cedar_county',
      summary: 'Arthur and Helen enumerated together in Cedar County.',
      participants: [
        { person_id: 'per_arthur_alder', role: 'head' },
        { person_id: 'per_helen_maple', role: 'wife' },
      ],
      sources: [{ source_id: 'src_1880_census', confidence: 'high' }],
      extensions: {
        media_ids: ['med_dup_2'],
      },
    },
  ];

  const media: MediaItem[] = [
    {
      id: 'med_dup_1',
      kind: 'record_scan',
      source_id: 'src_1880_census',
      event_id: 'evt_1880_census',
      person_id: 'per_arthur_alder',
      person_ids: ['per_arthur_alder'],
      file: '/media/scans/census_1880.jpg',
      caption: '1880 U.S. Census sheet 14B for Arthur Alder household',
      date_edtf: '1880-06-14',
      provenance: 'National Archives Roll T9-1001',
      has_primary_source: true,
    },
    {
      id: 'med_dup_2',
      kind: 'record_scan',
      source_id: 'src_1880_census',
      person_id: 'per_helen_maple',
      person_ids: ['per_helen_maple'],
      file: 'media/scans/./census_1880.jpg',
      caption: 'Helen Maple enumeration line on 1880 census',
      provenance: 'FamilySearch film 1255001',
    },
  ];

  const narratives: Narrative[] = [
    {
      id: 'nar_arthur_bio',
      slug: 'arthur-alder-biography',
      kind: 'biography',
      subject_person_id: 'per_arthur_alder',
      title: 'Arthur Alder Biography',
      body_md: [
        'Arthur and Helen appeared together in Cedar County in 1880[^src_1880_census|med_dup_2].',
        '',
        '```markdown',
        'Example syntax that must remain untouched: [^src_1880_census|med_dup_2]',
        '```',
      ].join('\n'),
      person_ids: ['per_arthur_alder', 'per_helen_maple'],
      place_ids: ['plc_cedar_county'],
      event_ids: ['evt_1880_census'],
      source_ids: ['src_1880_census'],
    },
  ];

  await writeFile(
    path.join(repoDir, 'kinloom.config.yaml'),
    serializeKinloomConfigYaml(makeSampleSiteConfig()),
    'utf8'
  );
  await writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people), 'utf8');
  await writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places), 'utf8');
  await writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(sources), 'utf8');
  await writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events), 'utf8');
  await writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8');
  await writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media), 'utf8');
  await writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml(narratives), 'utf8');

  return repoDir;
}

describe('kinloom media dedupe', () => {
  it('previews duplicate merges in dry-run default mode, writes nothing, applies atomically with citation/extension rewrites, verifies clean, and is idempotent', async () => {
    const repoDir = await createDuplicateMediaRepo();
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');

    // Add a staged patch referencing the soon-to-be-retired ID to verify read-only staged warning.
    const stagedDir = path.join(repoDir, 'research', 'people', 'per_helen_maple');
    await mkdir(stagedDir, { recursive: true });
    const stagedPatchPath = path.join(stagedDir, 'patch.json');
    const stagedPatchOriginal = JSON.stringify({ person_id: 'per_helen_maple', note: 'med_dup_1' });
    await writeFile(stagedPatchPath, stagedPatchOriginal, 'utf8');

    // Verify fails before dedupe with actionable remediation hint.
    const verifyBefore = await runVerifyCommand({ repoDir, json: true });
    expect(verifyBefore.ok).toBe(false);
    expect(
      verifyBefore.errors.some(
        (e) =>
          e.includes("duplicate file 'media/scans/census_1880.jpg'") &&
          e.includes("Run 'kinloom media dedupe'")
      )
    ).toBe(true);

    const beforeMediaRaw = await readFile(mediaPath, 'utf8');
    const beforeNarrativesRaw = await readFile(narrativesPath, 'utf8');
    const beforeEventsRaw = await readFile(eventsPath, 'utf8');

    // 1. Dry-run by default: 0 files modified on disk, canonical selected deterministically.
    // Note: med_dup_2 has 2 references (narrative citation + event extensions.media_ids) vs 0 for med_dup_1 ->
    // or pass --prefer med_dup_1 to test explicit survivor selection too! First check default dry-run.
    const dryCap = createCaptureIo();
    expect(await runCli(['media', 'dedupe', '--repo', repoDir, '--json'], { io: dryCap.io })).toBe(EXIT_OK);
    const dryBody = JSON.parse(dryCap.stdout.join('\n')) as {
      ok: boolean;
      apply: boolean;
      dryRun: boolean;
      duplicateGroupCount: number;
      retiredCount: number;
      groups: Array<{ canonicalId: string; retiredIds: string[]; mergedPersonIds: string[] }>;
      writtenYamlFiles: string[];
      stagedPackageWarnings: Array<{ personId: string; retiredMediaIds: string[] }>;
    };
    expect(dryBody.ok).toBe(true);
    expect(dryBody.apply).toBe(false);
    expect(dryBody.dryRun).toBe(true);
    expect(dryBody.duplicateGroupCount).toBe(1);
    expect(dryBody.retiredCount).toBe(1);
    expect(dryBody.groups[0].canonicalId).toBe('med_dup_2');
    expect(dryBody.groups[0].retiredIds).toEqual(['med_dup_1']);
    expect(dryBody.groups[0].mergedPersonIds).toEqual(['per_helen_maple', 'per_arthur_alder']);
    expect(dryBody.writtenYamlFiles).toEqual([]);
    expect(dryBody.stagedPackageWarnings).toEqual([
      expect.objectContaining({ personId: 'per_helen_maple', retiredMediaIds: ['med_dup_1'] }),
    ]);

    // Zero files modified in dry-run mode.
    expect(await readFile(mediaPath, 'utf8')).toBe(beforeMediaRaw);
    expect(await readFile(narrativesPath, 'utf8')).toBe(beforeNarrativesRaw);
    expect(await readFile(eventsPath, 'utf8')).toBe(beforeEventsRaw);

    // Conflicting --prefer flags targeting both IDs in one group exit 2.
    const conflictCap = createCaptureIo();
    expect(
      await runCli(['media', 'dedupe', '--repo', repoDir, '--prefer', 'med_dup_1', '--prefer', 'med_dup_2'], {
        io: conflictCap.io,
      })
    ).toBe(EXIT_USAGE);
    expect(conflictCap.stderr.join('\n')).toContain('Conflicting `--prefer` flags');

    // 2. Apply with --prefer med_dup_1 so med_dup_2 is retired and rewritten in narratives.yaml + events.yaml!
    const applyCap = createCaptureIo();
    expect(
      await runCli(['media', 'dedupe', '--repo', repoDir, '--prefer', 'med_dup_1', '--apply', '--json'], {
        io: applyCap.io,
      })
    ).toBe(EXIT_OK);
    const applyBody = JSON.parse(applyCap.stdout.join('\n')) as {
      ok: boolean;
      apply: boolean;
      duplicateGroupCount: number;
      retiredCount: number;
      citationRewrites: Array<{ narrativeId: string; fromMediaId: string; toMediaId: string }>;
      extensionRewrites: Array<{ file: string; entityId: string; fromMediaId: string; toMediaId: string }>;
      writtenYamlFiles: string[];
    };
    expect(applyBody.ok).toBe(true);
    expect(applyBody.apply).toBe(true);
    expect(applyBody.duplicateGroupCount).toBe(1);
    expect(applyBody.retiredCount).toBe(1);
    expect(applyBody.citationRewrites).toEqual([
      {
        narrativeId: 'nar_arthur_bio',
        sourceId: 'src_1880_census',
        fromMediaId: 'med_dup_2',
        toMediaId: 'med_dup_1',
      },
    ]);
    expect(applyBody.extensionRewrites).toEqual([
      {
        file: 'events.yaml',
        entityId: 'evt_1880_census',
        fieldPath: 'extensions.media_ids',
        fromMediaId: 'med_dup_2',
        toMediaId: 'med_dup_1',
      },
    ]);
    expect(applyBody.writtenYamlFiles.length).toBe(3);

    // Check merged media record preserves all person_ids, captions, provenance, and merged_from_media_ids.
    const afterMedia = parseMediaYaml(await readFile(mediaPath, 'utf8'));
    expect(afterMedia).toHaveLength(1);
    expect(afterMedia[0].id).toBe('med_dup_1');
    expect(afterMedia[0].person_ids).toEqual(['per_arthur_alder', 'per_helen_maple']);
    expect(afterMedia[0].caption).toBe('1880 U.S. Census sheet 14B for Arthur Alder household');
    expect(afterMedia[0].provenance).toBe('National Archives Roll T9-1001');
    expect(afterMedia[0].has_primary_source).toBe(true);
    expect(afterMedia[0].extensions).toEqual(
      expect.objectContaining({
        alternate_captions: ['Helen Maple enumeration line on 1880 census'],
        alternate_provenance: ['FamilySearch film 1255001'],
        merged_from_media_ids: ['med_dup_2'],
      })
    );

    // Check inline citation rewritten outside code fence, untouched inside fenced code block.
    const afterNarratives = parseNarrativesYaml(await readFile(narrativesPath, 'utf8'));
    expect(afterNarratives[0].body_md).toContain('in 1880[^src_1880_census|med_dup_1].');
    expect(afterNarratives[0].body_md).toContain(
      'Example syntax that must remain untouched: [^src_1880_census|med_dup_2]'
    );

    // Check extensions.media_ids rewritten in events.yaml.
    const afterEvents = parseEventsYaml(await readFile(eventsPath, 'utf8'));
    expect(afterEvents[0].extensions?.media_ids).toEqual(['med_dup_1']);

    // Staged research/ file was NEVER mutated.
    expect(await readFile(stagedPatchPath, 'utf8')).toBe(stagedPatchOriginal);

    // kinloom verify now passes with 0 duplicate media errors and 0 dangling citations.
    const verifyAfter = await runVerifyCommand({ repoDir, json: true });
    expect(verifyAfter.ok, verifyAfter.errors.join('\n')).toBe(true);
    expect(verifyAfter.checks.media.duplicateFiles).toEqual([]);
    expect(verifyAfter.checks.citations.errors).toEqual([]);

    // 3. Idempotence: re-running --apply writes 0 files and reports 0 duplicate groups.
    const secondCap = createCaptureIo();
    expect(
      await runCli(['media', 'dedupe', '--repo', repoDir, '--apply', '--json'], {
        io: secondCap.io,
      })
    ).toBe(EXIT_OK);
    const secondBody = JSON.parse(secondCap.stdout.join('\n')) as {
      duplicateGroupCount: number;
      writtenYamlFiles: string[];
    };
    expect(secondBody.duplicateGroupCount).toBe(0);
    expect(secondBody.writtenYamlFiles).toEqual([]);
  });

  it('rolls back data/media.yaml and data/narratives.yaml byte-for-byte if a write fails mid-apply', async () => {
    const repoDir = await createDuplicateMediaRepo();
    const mediaPath = path.join(repoDir, 'data', 'media.yaml');
    const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');
    const eventsPath = path.join(repoDir, 'data', 'events.yaml');

    const beforeMediaBytes = await readFile(mediaPath);
    const beforeNarrativesBytes = await readFile(narrativesPath);
    const beforeEventsBytes = await readFile(eventsPath);

    let callCount = 0;
    await expect(
      runMediaDedupeCommand({
        repoDir,
        preferIds: ['med_dup_1'],
        apply: true,
        writeFileImpl: (filePath, content) => {
          callCount += 1;
          if (callCount === 2) {
            throw new Error('Simulated disk full on second YAML write');
          }
          // Mutate first file so rollback must actually restore it.
          writeFileSync(filePath, content, 'utf8');
        },
      })
    ).rejects.toThrow(/Rollback succeeded:/);

    expect((await readFile(mediaPath)).equals(beforeMediaBytes)).toBe(true);
    expect((await readFile(narrativesPath)).equals(beforeNarrativesBytes)).toBe(true);
    expect((await readFile(eventsPath)).equals(beforeEventsBytes)).toBe(true);
  });
});
