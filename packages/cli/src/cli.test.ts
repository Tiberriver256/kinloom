import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
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
import { runCli, type CliIo } from './cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from './errors.js';

const tempDirs: string[] = [];

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

afterEach(async () => {
  delete process.env.KINLOOM_TELEMETRY_FILE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('unified kinloom CLI dispatch', () => {
  it('prints grouped top-level help covering lifecycle, ops, and record commands', async () => {
    const { io, stdout, stderr } = createCaptureIo();
    const code = await runCli(['--help'], { io });
    expect(code).toBe(EXIT_OK);
    expect(stderr).toEqual([]);

    const output = stdout.join('\n');
    expect(output).toContain('Archive lifecycle:');
    expect(output).toContain('Research & archive ops:');
    expect(output).toContain('Federal & general record archives:');
    expect(output).toContain('State archives:');
    expect(output).toContain('International archives:');
    expect(output).toContain('Research directories & guides:');
    expect(output).toContain('Media, scan prep & OCR:');
    expect(output).toContain('context');
    expect(output).toContain('integrate');
    expect(output).toContain('audit');
    expect(output).toContain('verify');
    expect(output).toContain('sync');
    expect(output).toContain('telemetry');
    expect(output).toContain('nara');
    expect(output).toContain('archive-org');
    expect(output).toContain('prep-scan');
    expect(output).toContain('ocr');
  });

  it('renders SKILL.md guides with kinloom invocations for help <cmd> and <cmd> --help', async () => {
    const tmp = await makeTempDir('kinloom-cli-help-');
    process.env.KINLOOM_TELEMETRY_FILE = path.join(tmp, 'calls.jsonl');

    const helpNara = createCaptureIo();
    expect(await runCli(['help', 'nara'], { io: helpNara.io })).toBe(EXIT_OK);
    expect(helpNara.stdout.join('\n')).toContain('kinloom nara');
    expect(helpNara.stdout.join('\n')).not.toContain('skills/nara-catalog-search/scripts/nara');

    const naraFlag = createCaptureIo();
    expect(await runCli(['nara', '--help'], { io: naraFlag.io })).toBe(EXIT_OK);
    expect(naraFlag.stdout.join('\n')).toContain('kinloom nara');
    expect(naraFlag.stdout.join('\n')).toContain('--script-help');

    const helpIa = createCaptureIo();
    expect(await runCli(['help', 'ia'], { io: helpIa.io })).toBe(EXIT_OK);
    expect(helpIa.stdout.join('\n')).toContain('Aliases: kinloom ia');
    expect(helpIa.stdout.join('\n')).toContain('kinloom archive-org');

    const blm = createCaptureIo();
    expect(await runCli(['blm-glo'], { io: blm.io })).toBe(EXIT_OK);
    expect(blm.stdout.join('\n')).toContain('# BLM GLO Records');
  });

  it('serves help for all ops commands and scan/OCR utilities', async () => {
    const tmp = await makeTempDir('kinloom-cli-ops-help-');
    process.env.KINLOOM_TELEMETRY_FILE = path.join(tmp, 'calls.jsonl');

    const checks: Array<[string[], string]> = [
      [['context', '--help'], 'Usage: kinloom context'],
      [['audit', '--help'], 'Usage: kinloom audit'],
      [['verify', '--help'], 'Usage: kinloom verify'],
      [['integrate', '--help'], 'Usage: kinloom integrate'],
      [['sync', '--help'], '--verify-live'],
      [['telemetry', '--help'], 'Usage: kinloom telemetry report'],
      [['prep-scan', '--help'], '# Scan Preparation'],
      [['ocr', '--help'], '# Cached OCR'],
    ];

    for (const [args, expected] of checks) {
      const cap = createCaptureIo();
      const code = await runCli(args, { io: cap.io });
      expect(code).toBe(EXIT_OK);
      expect(cap.stderr).toEqual([]);
      expect(cap.stdout.join('\n')).toContain(expected);
    }
  });

  it('dispatches telemetry report against a JSONL file', async () => {
    const tmp = await makeTempDir('kinloom-cli-telemetry-');
    const telPath = path.join(tmp, 'calls.jsonl');
    await writeFile(
      telPath,
      `${JSON.stringify({
        ts: '2026-11-25T12:00:00Z',
        cmd: 'kinloom',
        subcmd: 'context',
        person_id: 'per_arthur_alder',
        duration_ms: 42,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 1024,
      })}\n`,
      'utf8'
    );

    const cap = createCaptureIo();
    const code = await runCli(['telemetry', 'report', '--file', telPath, '--json'], { io: cap.io });
    expect(code).toBe(EXIT_OK);
    expect(cap.stderr).toEqual([]);
    const parsed = JSON.parse(cap.stdout.join('\n')) as {
      totalEvents: number;
      rows: Array<{ subcmd: string; count: number }>;
    };
    expect(parsed.totalEvents).toBe(1);
    expect(parsed.rows[0].subcmd).toBe('context');
  });

  it('dispatches verify against a synthetic archive repo and records telemetry', async () => {
    const repoDir = await makeTempDir('kinloom-cli-verify-');
    const telPath = path.join(repoDir, 'telemetry.jsonl');
    process.env.KINLOOM_TELEMETRY_FILE = telPath;

    const dataDir = path.join(repoDir, 'data');
    const mediaDir = path.join(repoDir, 'media');
    await mkdir(dataDir, { recursive: true });
    await mkdir(mediaDir, { recursive: true });
    await writeFile(path.join(mediaDir, 'alder-1880.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]));
    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml({
        schemaVersion: 1,
        site: {
          title: 'Alder Archive',
          familyName: 'Alder',
          gedcomSourceName: 'ALDER',
          footerCredit: 'Built with Kinloom',
        },
        theme: { accent: '#7A4612' },
        defaultBranchId: 'alder',
        branches: [
          {
            id: 'alder',
            label: 'Alder',
            surnames: ['Alder'],
            lineageGroups: ['ancestor'],
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
      }),
      'utf8'
    );
    await Promise.all([
      writeFile(
        path.join(dataDir, 'places.yaml'),
        serializePlacesYaml([
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
        ]),
        'utf8'
      ),
      writeFile(
        path.join(dataDir, 'sources.yaml'),
        serializeSourcesYaml([
          {
            id: 'src_1880_census',
            citation: '1880 U.S. Federal Census, Oak County, Ohio',
            source_type: 'census',
          },
        ]),
        'utf8'
      ),
      writeFile(
        path.join(dataDir, 'people.yaml'),
        serializePeopleYaml([
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
            birth_edtf: '1858-04-12',
            death_edtf: '1932-09-18',
            portrait_url: null,
          },
        ]),
        'utf8'
      ),
      writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml([]), 'utf8'),
      writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8'),
      writeFile(
        path.join(dataDir, 'media.yaml'),
        serializeMediaYaml([
          {
            id: 'med_1880',
            kind: 'document_scan',
            source_id: 'src_1880_census',
            person_id: 'per_arthur_alder',
            file: '/media/alder-1880.png',
            caption: '1880 census scan',
          },
        ]),
        'utf8'
      ),
      writeFile(
        path.join(dataDir, 'narratives.yaml'),
        serializeNarrativesYaml([
          {
            id: 'nar_arthur',
            slug: 'arthur-alder',
            title: 'Arthur Alder',
            person_ids: ['per_arthur_alder'],
            place_ids: ['plc_oak_county_ohio'],
            event_ids: [],
            source_ids: ['src_1880_census'],
            body_md: 'Arthur Alder lived in Oak County.[^src_1880_census|med_1880]',
          },
        ]),
        'utf8'
      ),
    ]);

    const okCap = createCaptureIo();
    const okCode = await runCli(['verify', '--repo', repoDir, '--json'], { io: okCap.io });
    expect(okCode).toBe(EXIT_OK);
    const parsedOk = JSON.parse(okCap.stdout.join('\n')) as { ok: boolean; errors: string[] };
    expect(parsedOk.ok).toBe(true);
    expect(parsedOk.errors).toEqual([]);

    // Remove media file on disk and verify non-zero exit code.
    await rm(path.join(mediaDir, 'alder-1880.png'));
    const failCap = createCaptureIo();
    const failCode = await runCli(['verify', '--repo', repoDir, '--json'], { io: failCap.io });
    expect(failCode).toBe(EXIT_ERROR);
    const parsedFail = JSON.parse(failCap.stdout.join('\n')) as {
      ok: boolean;
      checks: { media: { ok: boolean; missingFiles: Array<{ id: string }> } };
    };
    expect(parsedFail.ok).toBe(false);
    expect(parsedFail.checks.media.ok).toBe(false);
    expect(parsedFail.checks.media.missingFiles[0]?.id).toBe('med_1880');
  });

  it('returns EXIT_USAGE (2) for unknown commands and unknown help targets', async () => {
    const unknownCmd = createCaptureIo();
    expect(await runCli(['nonexistent-command'], { io: unknownCmd.io })).toBe(EXIT_USAGE);
    expect(unknownCmd.stderr.join('\n')).toContain("Unknown command 'nonexistent-command'");

    const unknownHelp = createCaptureIo();
    expect(await runCli(['help', 'nonexistent-command'], { io: unknownHelp.io })).toBe(EXIT_USAGE);
    expect(unknownHelp.stderr.join('\n')).toContain("Unknown command 'nonexistent-command'");
  });
});
