import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseKinloomConfig,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { INTEGRATE_YAML_FILES, INTEGRATION_RECEIPT_FILENAME, runIntegrateCommand } from './integrate.js';
import { runIntegrateBatchCommand } from './integrate-batch.js';

const INTEGRATE_PROP_SEED = 20261129;

const tempDirs: string[] = [];

function createTempArchive(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-integrate-prop-'));
  tempDirs.push(dir);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'research', 'people'), { recursive: true });

  const config = parseKinloomConfig({
    site: {
      title: 'Alder Valley Test Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER_TEST',
    },
    defaultBranchId: 'alder_main',
    branches: [
      {
        id: 'alder_main',
        label: 'Alder Main',
        surnames: ['Alder'],
        lineageGroups: ['ancestor', 'descendant'],
      },
    ],
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
      privateModeShowsBirthYear: true,
      stripLivingPortraits: true,
      stripLivingResidenceSpans: true,
    },
  });

  fs.writeFileSync(path.join(dir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');
  fs.writeFileSync(
    path.join(dataDir, 'people.yaml'),
    serializePeopleYaml([
      {
        id: 'per_alder_1',
        slug: 'henry-alder',
        full_name: 'Henry Alder',
        given_name: 'Henry',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1855',
        death_edtf: '1930',
        portrait_url: null,
      },
      {
        id: 'per_alder_2',
        slug: 'clara-alder',
        full_name: 'Clara Alder',
        given_name: 'Clara',
        surname: 'Alder',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        branch: 'alder_main',
        birth_edtf: '1858',
        death_edtf: '1936',
        portrait_url: null,
      },
      {
        id: 'per_alder_living',
        slug: 'sam-alder',
        full_name: 'Sam Alder',
        given_name: 'Sam',
        surname: 'Alder',
        alt_names: [],
        sex: 'M',
        is_living: true,
        lineage_group: 'descendant',
        branch: 'alder_main',
        birth_edtf: '1988',
        death_edtf: '',
        portrait_url: null,
      },
    ]),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'places.yaml'),
    serializePlacesYaml([
      {
        id: 'plc_oakton',
        slug: 'oakton-ohio',
        name: 'Oakton',
        full_name: 'Oakton, Ohio, USA',
        place_type: 'town',
        parent_id: null,
        lat: 40.15,
        lng: -83.12,
      },
    ]),
    'utf8'
  );
  fs.writeFileSync(
    path.join(dataDir, 'sources.yaml'),
    serializeSourcesYaml([
      {
        id: 'src_1880',
        citation: '1880 US Federal Census, Cedar County, Ohio',
        source_type: 'census',
      },
    ]),
    'utf8'
  );
  fs.writeFileSync(path.join(dataDir, 'events.yaml'), serializeEventsYaml([]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'media.yaml'), serializeMediaYaml([]), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml([]), 'utf8');
  return dir;
}

function snapshotDataYaml(repoDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of INTEGRATE_YAML_FILES) {
    const p = path.join(repoDir, 'data', name);
    out[name] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  }
  return out;
}

function writePatch(repoDir: string, personId: string, patch: Record<string, unknown>): string {
  const pkgDir = path.join(repoDir, 'research', 'people', personId);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'patch.json'), JSON.stringify(patch, null, 2), 'utf8');
  return pkgDir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('Property-based batch integrate & rollback atomicity (deterministic seed)', () => {
  it('rolls back ALL YAML writes and receipts byte-for-byte when a later package in a batch fails validation', async () => {
    const failureModeArb = fc.constantFrom<'missing_place' | 'missing_source' | 'living_media'>(
      'missing_place',
      'missing_source',
      'living_media'
    );
    const samples = fc.sample(
      fc.record({
        birthYear: fc.integer({ min: 1850, max: 1870 }),
        eventYear: fc.integer({ min: 1880, max: 1920 }),
        failureMode: failureModeArb,
      }),
      { seed: INTEGRATE_PROP_SEED, numRuns: 9 }
    );

    for (const [idx, sample] of samples.entries()) {
      const repoDir = createTempArchive();
      const beforeSnapshot = snapshotDataYaml(repoDir);

      // Package 1: valid patch for per_alder_1
      const pkg1Dir = writePatch(repoDir, 'per_alder_1', {
        person_id: 'per_alder_1',
        person_updates: { birth_edtf: `${sample.birthYear}-03-15` },
        sources: [
          {
            id: `src_pkg1_${idx}`,
            citation: `Cedar County Probate Record ${sample.eventYear}`,
            source_type: 'vital_record',
          },
        ],
        events: [
          {
            id: `evt_pkg1_${idx}`,
            title: `Homestead Record ${sample.eventYear}`,
            scope: 'personal',
            event_kind: 'point_event',
            edtf_date: `${sample.eventYear}`,
            place_id: 'plc_oakton',
            summary: 'Verified county land record.',
            participants: [{ person_id: 'per_alder_1', role: 'subject' }],
            sources: [{ source_id: `src_pkg1_${idx}`, confidence: 'high' }],
          },
        ],
      });

      // Package 2: intentionally invalid patch for per_alder_2
      let badPatch: Record<string, unknown>;
      if (sample.failureMode === 'missing_place') {
        badPatch = {
          person_id: 'per_alder_2',
          events: [
            {
              id: `evt_bad_${idx}`,
              title: 'Invalid Place Event',
              scope: 'personal',
              event_kind: 'point_event',
              edtf_date: '1905',
              place_id: 'plc_nonexistent_xyz',
              summary: 'Should trigger rollback.',
              participants: [{ person_id: 'per_alder_2', role: 'subject' }],
              sources: [{ source_id: 'src_1880', confidence: 'high' }],
            },
          ],
        };
      } else if (sample.failureMode === 'missing_source') {
        badPatch = {
          person_id: 'per_alder_2',
          events: [
            {
              id: `evt_bad_${idx}`,
              title: 'Invalid Source Event',
              scope: 'personal',
              event_kind: 'point_event',
              edtf_date: '1905',
              place_id: 'plc_oakton',
              summary: 'Should trigger rollback.',
              participants: [{ person_id: 'per_alder_2', role: 'subject' }],
              sources: [{ source_id: 'src_missing_xyz', confidence: 'high' }],
            },
          ],
        };
      } else {
        badPatch = {
          person_id: 'per_alder_2',
          media: [
            {
              id: `med_living_leak_${idx}`,
              kind: 'portrait',
              person_id: 'per_alder_living',
              file: '/media/blocked-living.jpg',
              caption: 'Must be rejected by privacy audit',
            },
          ],
        };
      }
      const pkg2Dir = writePatch(repoDir, 'per_alder_2', badPatch);

      await expect(
        runIntegrateBatchCommand({
          repoDir,
          personIds: ['per_alder_1', 'per_alder_2'],
        })
      ).rejects.toThrow();

      // Strict atomicity: every YAML file must be byte-for-byte identical to beforeSnapshot
      expect(snapshotDataYaml(repoDir)).toEqual(beforeSnapshot);
      // Neither package may have a lingering integration receipt
      expect(fs.existsSync(path.join(pkg1Dir, INTEGRATION_RECEIPT_FILENAME))).toBe(false);
      expect(fs.existsSync(path.join(pkg2Dir, INTEGRATION_RECEIPT_FILENAME))).toBe(false);
    }
  });

  it('produces deterministic golden YAML and skips already-integrated packages on idempotent re-run', async () => {
    const repoDir = createTempArchive();
    writePatch(repoDir, 'per_alder_1', {
      person_id: 'per_alder_1',
      person_updates: { birth_edtf: '1855-05-01' },
      places: [
        {
          id: 'plc_riverdale',
          slug: 'riverdale-ohio',
          name: 'Riverdale',
          full_name: 'Riverdale, Ohio, USA',
          place_type: 'town',
          parent_id: null,
          lat: 40.1,
          lng: -83.1,
        },
      ],
      sources: [
        {
          id: 'src_1890',
          citation: '1890 Cedar County Directory',
          source_type: 'directory',
        },
      ],
      events: [
        {
          id: 'evt_1890_dir',
          title: '1890 Cedar County Directory Listing',
          scope: 'personal',
          event_kind: 'residence_anchor',
          edtf_date: '1890',
          place_id: 'plc_riverdale',
          summary: 'Henry Alder listed as carpenter in Riverdale.',
          participants: [{ person_id: 'per_alder_1', role: 'subject' }],
          sources: [{ source_id: 'src_1890', confidence: 'high' }],
        },
      ],
      kinship: [{ from: 'per_alder_1', to: 'per_alder_2', relation: 'spouse' }],
    });

    // Dry-run must leave data/ completely untouched
    const beforeDryRun = snapshotDataYaml(repoDir);
    const dryRes = await runIntegrateCommand({ repoDir, personId: 'per_alder_1', dryRun: true });
    expect(dryRes.ok).toBe(true);
    expect(dryRes.dryRun).toBe(true);
    expect(snapshotDataYaml(repoDir)).toEqual(beforeDryRun);

    // Live apply and verify deterministic golden YAML structure
    const liveRes = await runIntegrateCommand({ repoDir, personId: 'per_alder_1' });
    expect(liveRes.ok).toBe(true);
    expect(liveRes.rendered).toContain('Integrate OK for per_alder_1:');
    expect(liveRes.rendered).toContain('events=+1/~0');
    expect(liveRes.rendered).toContain('places=+1/~0');
    expect(liveRes.rendered).toContain('sources=+1/~0');
    expect(liveRes.rendered).toContain('kinship=+1/~0');

    const goldenEventsYaml = fs.readFileSync(path.join(repoDir, 'data', 'events.yaml'), 'utf8');
    expect(goldenEventsYaml).toBe(
      [
        '- id: evt_1890_dir',
        '  title: 1890 Cedar County Directory Listing',
        '  scope: personal',
        '  event_kind: residence_anchor',
        '  edtf_date: "1890"',
        '  place_id: plc_riverdale',
        '  summary: Henry Alder listed as carpenter in Riverdale.',
        '  participants:',
        '    - person_id: per_alder_1',
        '      role: subject',
        '  sources:',
        '    - confidence: high',
        '      source_id: src_1890',
        '',
      ].join('\n')
    );

    // Re-running batch with --all-staged --pending-only skips already-integrated package
    const batchSkip = await runIntegrateBatchCommand({
      repoDir,
      allStaged: true,
      pendingOnly: true,
    });
    expect(batchSkip.integrated).toEqual([]);
    expect(batchSkip.skippedAlreadyIntegrated).toEqual(['per_alder_1']);
  });
});
