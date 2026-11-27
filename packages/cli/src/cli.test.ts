import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
import { type CliIo, runCli } from './cli.js';
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
    expect(output).toContain('dates');
    expect(output).toContain('telemetry');
    expect(output).toContain('nara');
    expect(output).toContain('archive-org');
    expect(output).toContain('prep-scan');
    expect(output).toContain('ocr');
  });

  it('renders embedded guides with kinloom invocations for help <cmd> and <cmd> --help', async () => {
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
      [['dates', '--help'], 'Usage: kinloom dates'],
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

  it('dispatches dates weekday, diff, and age and logs clean telemetry without date arguments', async () => {
    const tmp = await makeTempDir('kinloom-cli-dates-');
    const telPath = path.join(tmp, 'calls.jsonl');
    process.env.KINLOOM_TELEMETRY_FILE = telPath;

    const wkCap = createCaptureIo();
    expect(await runCli(['dates', 'weekday', '1898-02-07'], { io: wkCap.io })).toBe(EXIT_OK);
    expect(wkCap.stdout).toEqual(['Monday, 7 February 1898']);

    const diffCap = createCaptureIo();
    expect(await runCli(['dates', 'diff', '1898-02-07', '1980-11-05', '--json'], { io: diffCap.io })).toBe(
      EXIT_OK
    );
    const diffJson = JSON.parse(diffCap.stdout.join('\n')) as {
      totalDays: number;
      years: number;
      remainingDays: number;
      yearsMonthsDays: { years: number; months: number; days: number };
      startWeekday: string;
      endWeekday: string;
    };
    expect(diffJson.totalDays).toBe(30221);
    expect(diffJson.years).toBe(82);
    expect(diffJson.remainingDays).toBe(272);
    expect(diffJson.yearsMonthsDays).toEqual({ years: 82, months: 8, days: 29 });
    expect(diffJson.startWeekday).toBe('Monday');
    expect(diffJson.endWeekday).toBe('Wednesday');

    // Positional event date when --at is omitted.
    const agePosCap = createCaptureIo();
    expect(await runCli(['dates', 'age', '1898-02-07', '1980-11-05', '--json'], { io: agePosCap.io })).toBe(
      EXIT_OK
    );
    const agePosJson = JSON.parse(agePosCap.stdout.join('\n')) as {
      ages: Array<{ at: string; years: number; remainingDays: number; totalDays: number }>;
    };
    expect(agePosJson.ages).toHaveLength(1);
    expect(agePosJson.ages[0]).toMatchObject({
      at: '1980-11-05',
      years: 82,
      remainingDays: 272,
      totalDays: 30221,
    });

    // Repeatable --at flags.
    const ageMultiCap = createCaptureIo();
    expect(
      await runCli(['dates', 'age', '1898-02-07', '--at', '1920-01-01', '--at', '1940-04-01'], {
        io: ageMultiCap.io,
      })
    ).toBe(EXIT_OK);
    expect(ageMultiCap.stdout.join('\n')).toContain('1920-01-01 (Thursday): 21 years, 328 days');
    expect(ageMultiCap.stdout.join('\n')).toContain('1940-04-01 (Monday): 42 years, 54 days');

    // Unknown subcommand fails with EXIT_USAGE and is not recorded into telemetry.
    const badSubCap = createCaptureIo();
    expect(await runCli(['dates', 'secret-token'], { io: badSubCap.io })).toBe(EXIT_USAGE);

    const rawTelemetry = await readFile(telPath, 'utf8');
    expect(rawTelemetry).not.toContain('1898-02-07');
    expect(rawTelemetry).not.toContain('secret-token');
    const subcmds = rawTelemetry
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { subcmd: string }).subcmd);
    expect(subcmds).toEqual(['dates weekday', 'dates diff', 'dates age', 'dates age']);
  });

  it('documents seed --chunk-size, supports audit/sync aliases, honors programmatic cwd, and keeps pronounce docs aligned', async () => {
    const tmp = await makeTempDir('kinloom-cli-wave52b-');
    process.env.KINLOOM_TELEMETRY_FILE = path.join(tmp, 'calls.jsonl');

    // 1. seed --help documents --chunk-size
    const seedHelp = createCaptureIo();
    expect(await runCli(['seed', '--help'], { io: seedHelp.io })).toBe(EXIT_OK);
    expect(seedHelp.stdout.join('\n')).toContain('--chunk-size');

    // 2. pronounce --help documents --strict, full-name coverage, 0 living leaks, and cache env var
    const pronounceHelp = createCaptureIo();
    expect(await runCli(['pronounce', '--help'], { io: pronounceHelp.io })).toBe(EXIT_OK);
    const pronounceText = pronounceHelp.stdout.join('\n');
    expect(pronounceText).toContain('--strict');
    expect(pronounceText).toContain('full-name coverage');
    expect(pronounceText).toContain('0 living people');
    expect(pronounceText).toContain('KINLOOM_PRONOUNCE_CACHE_DIR');

    // 3. Minimal synthetic archive under tmp to verify programmatic cwd + audit/sync flag aliases
    const dataDir = path.join(tmp, 'data');
    const pkgDir = path.join(tmp, 'research', 'people', 'per_synth_1');
    await mkdir(dataDir, { recursive: true });
    await mkdir(pkgDir, { recursive: true });

    await writeFile(
      path.join(tmp, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml({
        schemaVersion: 1,
        site: {
          title: 'Synthetic Archive',
          familyName: 'Mercer',
          gedcomSourceName: 'SYNTHETIC_TREE',
          footerCredit: 'Built with Kinloom',
        },
        theme: { accent: '#7A4612' },
        defaultBranchId: 'mercer',
        branches: [
          {
            id: 'mercer',
            label: 'Mercer Line',
            surnames: ['Mercer'],
            lineageGroups: ['ancestor'],
            supportsDirectMode: true,
          },
        ],
        lineageSections: [],
        featuredKinshipPairs: [],
        migrationEras: [],
        mapDefaults: { centerLat: 40.0, centerLng: -83.0, zoom: 5, minSpanDeg: 1.0 },
        privacy: {
          referenceYear: 2026,
          livingCutoffYears: 101,
          privateModeShowsBirthYear: true,
          stripLivingPortraits: true,
          stripLivingResidenceSpans: true,
          markGedcomLivingConfidential: true,
        },
      }),
      'utf8'
    );
    await writeFile(
      path.join(dataDir, 'people.yaml'),
      serializePeopleYaml([
        {
          id: 'per_synth_1',
          slug: 'thomas-mercer-1810',
          full_name: 'Thomas Mercer',
          given_name: 'Thomas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          birth_edtf: '1810',
          death_edtf: '1875',
          is_living: false,
          lineage_group: 'ancestor',
          branch: 'mercer',
          portrait_url: null,
        },
      ]),
      'utf8'
    );
    await writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml([]), 'utf8');
    await writeFile(path.join(dataDir, 'narratives.yaml'), serializeNarrativesYaml([]), 'utf8');
    await writeFile(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify({ person_id: 'per_synth_1', sources: [], events: [] }, null, 2),
      'utf8'
    );

    // Programmatic cwd honored by status, verify, context, and audit (without --repo)
    const statusCap = createCaptureIo();
    expect(
      await runCli(['status', '--json'], { io: statusCap.io, cwd: tmp }),
      statusCap.stderr.join('\n')
    ).toBe(EXIT_OK);
    expect(JSON.parse(statusCap.stdout.join('\n')).repo).toBe(path.resolve(tmp));

    const verifyCap = createCaptureIo();
    expect(
      await runCli(['verify', '--json'], { io: verifyCap.io, cwd: tmp }),
      verifyCap.stderr.join('\n')
    ).toBe(EXIT_OK);

    const contextCap = createCaptureIo();
    expect(
      await runCli(['context', 'per_synth_1', '--json'], { io: contextCap.io, cwd: tmp }),
      contextCap.stderr.join('\n')
    ).toBe(EXIT_OK);
    expect(contextCap.stdout.join('\n')).toContain('Thomas Mercer');

    // audit accepts --package, --person-id, and --patch without unknown-option errors
    for (const auditArgs of [
      ['audit', '--package', pkgDir, '--json'],
      ['audit', '--person-id', 'per_synth_1', '--json'],
      ['audit', '--patch', path.join(pkgDir, 'patch.json'), '--json'],
    ]) {
      const cap = createCaptureIo();
      const code = await runCli(auditArgs, { io: cap.io, cwd: tmp });
      expect(code, `${auditArgs.join(' ')}: ${cap.stderr.join('\n')}`).toBe(EXIT_OK);
    }

    // sync accepts --site alias and honors cwd (reaches wrangler config check instead of unknown option error)
    const syncCap = createCaptureIo();
    const syncCode = await runCli(['sync', '--site', 'https://example.org', '--dry-run'], {
      io: syncCap.io,
      cwd: tmp,
    });
    expect(syncCode).toBe(EXIT_USAGE);
    expect(syncCap.stderr.join('\n')).toContain('wrangler');
    expect(syncCap.stderr.join('\n')).not.toContain('Unknown option');
  });
});
