import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseKinloomConfig,
  serializeKinloomConfigYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, type ExecFileFn, type RecordCommandContext } from '../../runtime/index.js';
import {
  type AudioQaSummary,
  buildScriptNamesMap,
  type NarrativeBatchManifest,
  parseBatchSlice,
  runNarrativeAudioCommand,
  type ScaffoldSummary,
} from '../narrative-audio.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'kinloom-na-121-'): Promise<string> {
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

function makeWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function invokeNarrativeAudio(
  args: readonly string[],
  overrides: { [K in keyof RecordCommandContext]?: RecordCommandContext[K] | undefined } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    ...overrides,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    sleepFn: overrides.sleepFn ?? (async () => {}),
    nowMs: overrides.nowMs ?? (() => Date.parse('2026-11-28T12:00:00.000Z')),
  });
  const outcome = await runNarrativeAudioCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

function seedMultiPersonArchive(repoDir: string, options: { includeLivingLeak?: boolean } = {}): void {
  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  const pronunciations: Record<string, { phonetic: string; ipa?: string; language: string }> = {
    'Hendrik van der Meer': {
      phonetic: 'HEN-drik vahn der MAIR',
      ipa: '/ˈɦɛn.drɪk vɑn dɛr meːr/',
      language: 'nl',
    },
    Oakville: {
      phonetic: 'OHK-vil',
      ipa: 'ˈoʊk.vɪl', // deliberately without slashes to verify normalization
      language: 'en-US',
    },
    'Unused Place': {
      phonetic: 'un-YOOZD',
      ipa: '/ʌnˈjuːzd/',
      language: 'en-US',
    },
    'Phonetic Only': {
      phonetic: 'foh-NET-ik',
      language: 'en-US',
    },
  };
  if (options.includeLivingLeak) {
    pronunciations['Taylor SecretLiving'] = {
      phonetic: 'TAY-ler',
      ipa: '/ˈteɪlər/',
      language: 'en-US',
    };
  }

  const config = parseKinloomConfig({
    site: {
      title: 'Synthetic Oakville Archive',
      familyName: 'Van der Meer',
      gedcomSourceName: 'OAKVILLE_121',
    },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
    pronunciations,
  });
  fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

  fs.writeFileSync(
    path.join(repoDir, 'data', 'people.yaml'),
    serializePeopleYaml([
      {
        id: 'per_hendrik',
        slug: 'hendrik-van-der-meer',
        full_name: 'Hendrik van der Meer',
        given_name: 'Hendrik',
        surname: 'van der Meer',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1840',
        death_edtf: '1912',
        portrait_url: null,
      },
      {
        id: 'per_clara',
        slug: 'clara-vance',
        full_name: 'Clara Vance',
        given_name: 'Clara',
        surname: 'Vance',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1848',
        death_edtf: '1920',
        portrait_url: null,
      },
      {
        id: 'per_arthur',
        slug: 'arthur-wells',
        full_name: 'Arthur Wells',
        given_name: 'Arthur',
        surname: 'Wells',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1852',
        death_edtf: '1925',
        portrait_url: null,
      },
      {
        id: 'per_done',
        slug: 'jane-done',
        full_name: 'Jane Done',
        given_name: 'Jane',
        surname: 'Done',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1855',
        death_edtf: '1924',
        portrait_url: null,
      },
      {
        id: 'per_living',
        slug: 'living-descendant',
        full_name: 'Taylor SecretLiving',
        given_name: 'Taylor',
        surname: 'SecretLiving',
        alt_names: [],
        sex: 'U',
        is_living: true,
        lineage_group: 'descendant',
        birth_edtf: '1992',
        death_edtf: '',
        portrait_url: null,
      },
    ]),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'data', 'narratives.yaml'),
    serializeNarrativesYaml([
      {
        id: 'nar_hendrik',
        slug: 'hendrik-van-der-meer',
        kind: 'biography',
        subject_person_id: 'per_hendrik',
        title: 'Hendrik van der Meer',
        summary: 'Millwright in Oakville.',
        date_edtf: '1840/1912',
        person_ids: ['per_hendrik'],
        place_ids: [],
        event_ids: [],
        source_ids: ['src_1'],
        updated_at: '2026-11-28',
        has_primary_source: true,
        body_md: [
          '## Early Years',
          '**Hendrik van der Meer** settled in [Oakville](https://example.test) on 9 May 1866 ([src_1]).',
          '',
          '## Research Notes',
          '- Born ca. 1840 per parish roll [src_1].',
        ].join('\n'),
      },
      {
        id: 'nar_clara',
        slug: 'clara-vance',
        kind: 'biography',
        subject_person_id: 'per_clara',
        title: 'Clara Vance',
        summary: 'Teacher in Oakville.',
        date_edtf: '1848/1920',
        person_ids: ['per_clara'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-28',
        has_primary_source: true,
        body_md: [
          '## Teaching Career',
          'Clara Vance taught in Oakville from 1870 until 1905.',
          '',
          '## Research Notes',
          '- Confirmed by school board minutes.',
        ].join('\n'),
      },
      {
        id: 'nar_arthur',
        slug: 'arthur-wells',
        kind: 'biography',
        subject_person_id: 'per_arthur',
        title: 'Arthur Wells',
        summary: 'Blacksmith.',
        date_edtf: '1852/1925',
        person_ids: ['per_arthur'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-28',
        has_primary_source: false,
        body_md: '## Workshop\nArthur Wells operated the forge.',
      },
      {
        id: 'nar_done',
        slug: 'jane-done',
        kind: 'biography',
        subject_person_id: 'per_done',
        title: 'Jane Done',
        summary: 'Already narrated.',
        date_edtf: '1855/1924',
        person_ids: ['per_done'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-28',
        has_primary_source: false,
        body_md: 'Jane Done kept the general store in Oakville.',
        extensions: {
          narrative_audio: {
            file: '/media/audio-jane-done.mp3',
            duration_seconds: 88,
          },
        },
      },
      {
        id: 'nar_story',
        slug: 'oakville-history',
        kind: 'family_story',
        title: 'Oakville History',
        summary: 'Town sketch.',
        date_edtf: '1840/1930',
        person_ids: [],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-28',
        has_primary_source: false,
        body_md: 'Oakville grew beside the river.',
      },
      {
        id: 'nar_living',
        slug: 'living-bio',
        kind: 'biography',
        subject_person_id: 'per_living',
        title: 'Taylor SecretLiving',
        summary: 'Must never appear.',
        date_edtf: '1992',
        person_ids: ['per_living'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-28',
        has_primary_source: false,
        body_md: 'Taylor SecretLiving is living.',
      },
    ]),
    'utf8'
  );
}

describe('narrative-audio scaffold', () => {
  it('renders root help mentioning scaffold and qa, and scaffold --help', async () => {
    const rootHelp = await invokeNarrativeAudio(['--help']);
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain('scaffold');
    expect(rootHelp.stdout).toContain('qa');

    const scaffoldHelp = await invokeNarrativeAudio(['scaffold', '--help']);
    expect(scaffoldHelp.exitCode).toBe(0);
    expect(scaffoldHelp.stdout).toContain('kinloom narrative-audio scaffold');
  });

  it('generates deterministic .script.txt and lexicon-populated .names.json respecting Living Privacy Rule', async () => {
    const repoDir = await makeTempDir('kinloom-scaffold-repo-');
    const outDir = path.join(repoDir, 'custom-scripts');
    seedMultiPersonArchive(repoDir);

    const res1 = await invokeNarrativeAudio(['scaffold', '--repo', repoDir, '--out', outDir, '--json']);
    expect(res1.exitCode, res1.stderr).toBe(0);
    const summary1 = JSON.parse(res1.stdout) as ScaffoldSummary;
    expect(summary1.ok).toBe(true);
    expect(summary1.mode).toBe('scaffold');
    expect(summary1.scaffolded).toBe(3);
    expect(summary1.already_has_audio).toBe(1);
    expect(summary1.living_skipped).toBe(1);
    expect(summary1.items.map((i) => i.slug)).toEqual([
      'arthur-wells',
      'clara-vance',
      'hendrik-van-der-meer',
    ]);

    expect(fs.existsSync(path.join(outDir, 'living-bio.script.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outDir, 'living-bio.names.json'))).toBe(false);

    const hendrikItem = summary1.items.find((i) => i.slug === 'hendrik-van-der-meer')!;
    const hendrikScript = fs.readFileSync(hendrikItem.script_path, 'utf8');
    const hendrikNames = JSON.parse(fs.readFileSync(hendrikItem.names_path, 'utf8')) as Record<
      string,
      string
    >;
    expect(hendrikScript).toContain('Hendrik van der Meer settled in Oakville on May ninth, 1866.');
    expect(hendrikScript).toContain("# EDITOR'S NOTES");
    expect(hendrikNames).toEqual({
      'Hendrik van der Meer': '/ˈɦɛn.drɪk vɑn dɛr meːr/',
      Oakville: '/ˈoʊk.vɪl/',
    });

    const checkRes = await invokeNarrativeAudio([
      'check',
      hendrikItem.script_path,
      '--names',
      hendrikItem.names_path,
    ]);
    expect(checkRes.exitCode, checkRes.stdout).toBe(0);

    const arthurItem = summary1.items.find((i) => i.slug === 'arthur-wells')!;
    expect(arthurItem.names_count).toBe(0);
    expect(JSON.parse(fs.readFileSync(arthurItem.names_path, 'utf8'))).toEqual({});

    const res2 = await invokeNarrativeAudio(['scaffold', '--repo', repoDir, '--out', outDir, '--json']);
    expect(res2.exitCode).toBe(0);
    expect(fs.readFileSync(hendrikItem.script_path, 'utf8')).toBe(hendrikScript);
    expect(fs.readFileSync(hendrikItem.names_path, 'utf8')).toBe(
      `${JSON.stringify(hendrikNames, null, 2)}\n`
    );
  });

  it('supports cwd default --repo, default --out, text output, --force, --kind "", and blocks living pronunciation leaks', async () => {
    const repoDir = await makeTempDir('kinloom-scaffold-text-');
    seedMultiPersonArchive(repoDir);

    // Omit --repo to exercise cwd '.' fallback
    const textRes = await invokeNarrativeAudio(['scaffold', '--kind', '', '--force'], { cwd: repoDir });
    expect(textRes.exitCode, textRes.stderr).toBe(0);
    expect(textRes.stdout).toContain('Scaffolded 5 narrative script(s)');
    expect(textRes.stdout).toContain('oakville-history');
    expect(textRes.stdout).toContain('jane-done');
    expect(fs.existsSync(path.join(repoDir, 'narrative-audio', 'oakville-history.script.txt'))).toBe(true);

    // Privacy fence blocks living pronunciation leaks
    const leakyRepo = await makeTempDir('kinloom-scaffold-leak-');
    seedMultiPersonArchive(leakyRepo, { includeLivingLeak: true });
    const leakRes = await invokeNarrativeAudio(['scaffold', '--repo', leakyRepo]);
    expect(leakRes.exitCode).toBe(2);
    expect(leakRes.stderr).toContain('Privacy fence blocked');

    // buildScriptNamesMap handles slash normalization and phonetic-only skip
    expect(
      buildScriptNamesMap('Oakville and Phonetic Only', {
        Oakville: { text: 'Oakville', ipa: 'ˈoʊk.vɪl' },
        'Phonetic Only': { text: 'Phonetic Only', phonetic: 'foh-NET-ik' },
      })
    ).toEqual({ Oakville: '/ˈoʊk.vɪl/' });
  });

  it('fails clearly when kinloom.config.yaml or narratives.yaml is missing', async () => {
    const emptyDir = await makeTempDir('kinloom-scaffold-empty-');
    const missingConfig = await invokeNarrativeAudio(['scaffold', '--repo', emptyDir]);
    expect(missingConfig.exitCode).toBe(2);
    expect(missingConfig.stderr).toContain('kinloom.config.yaml');

    fs.writeFileSync(path.join(emptyDir, 'kinloom.config.yaml'), 'site:\n  title: Empty\n', 'utf8');
    const missingNarratives = await invokeNarrativeAudio(['scaffold', '--repo', emptyDir]);
    expect(missingNarratives.exitCode).toBe(2);
    expect(missingNarratives.stderr).toContain('narratives.yaml');
  });
});

describe('narrative-audio batch --slice and --resume', () => {
  it('parses valid slices and rejects invalid slice strings', () => {
    expect(parseBatchSlice('0:2')).toEqual({ start: 0, end: 2 });
    expect(parseBatchSlice('2:')).toEqual({ start: 2, end: undefined });
    expect(parseBatchSlice(':3')).toEqual({ start: 0, end: 3 });
    expect(parseBatchSlice('1:1')).toEqual({ start: 1, end: 1 });

    expect(() => parseBatchSlice('')).toThrow(/Invalid --slice/);
    expect(() => parseBatchSlice(':')).toThrow(/Invalid --slice/);
    expect(() => parseBatchSlice('abc')).toThrow(/Invalid --slice/);
    expect(() => parseBatchSlice('-1:2')).toThrow(/Invalid --slice/);
    expect(() => parseBatchSlice('5:2')).toThrow(/greater than or equal to start/);
    expect(() => parseBatchSlice('999999999999999999999:')).toThrow(/out of range/);
  });

  it('slices candidates cleanly across dry-run, export-manifest, and import-dir with --resume', async () => {
    const repoDir = await makeTempDir('kinloom-batch-slice-');
    seedMultiPersonArchive(repoDir);

    const drySlice = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--slice',
      '0:2',
      '--dry-run',
      '--json',
    ]);
    expect(drySlice.exitCode, drySlice.stderr).toBe(0);
    const dryJson = JSON.parse(drySlice.stdout) as {
      slice: string;
      total_candidates: number;
      items: Array<{ id: string; status: string }>;
    };
    expect(dryJson.slice).toBe('0:2');
    expect(dryJson.total_candidates).toBe(3);
    expect(dryJson.items.map((i) => i.id)).toEqual(['nar_hendrik', 'nar_clara']);

    const mediaDir = path.join(repoDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'audio-hendrik-van-der-meer.mp3'), Buffer.from('ID3-done'));

    const manifestPath = path.join(repoDir, 'out', 'slice-manifest.json');
    const expRes = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--slice',
      '0:2',
      '--resume',
      '--export-manifest',
      manifestPath,
      '--json',
    ]);
    expect(expRes.exitCode, expRes.stderr).toBe(0);
    const expSummary = JSON.parse(expRes.stdout) as {
      narratives: number;
      skipped_existing: number;
      resume: boolean;
      slice: string;
    };
    expect(expSummary.resume).toBe(true);
    expect(expSummary.skipped_existing).toBe(1);
    expect(expSummary.narratives).toBe(1);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as NarrativeBatchManifest;
    expect(manifest.narratives.map((n) => n.id)).toEqual(['nar_clara']);

    const importDir = path.join(repoDir, 'rendered');
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'audio-hendrik-van-der-meer.mp3'), Buffer.from('ID3-new-hendrik'));
    fs.writeFileSync(path.join(importDir, 'audio-clara-vance.mp3'), Buffer.from('ID3-clara'));

    const impRes = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--slice',
      '0:2',
      '--resume',
      '--import-dir',
      importDir,
      '--json',
    ]);
    expect(impRes.exitCode, impRes.stderr).toBe(0);
    const impSummary = JSON.parse(impRes.stdout) as {
      imported: number;
      skipped_existing: number;
      imported_ids: string[];
      skipped_existing_ids: string[];
    };
    expect(impSummary.imported).toBe(1);
    expect(impSummary.imported_ids).toEqual(['nar_clara']);
    expect(impSummary.skipped_existing).toBe(1);
    expect(impSummary.skipped_existing_ids).toEqual(['nar_hendrik']);
    expect(fs.readFileSync(path.join(mediaDir, 'audio-hendrik-van-der-meer.mp3'), 'utf8')).toBe('ID3-done');
  });

  it('executes idempotent chunked live synthesis with --slice and --resume (re-synthesizing 0-byte files)', async () => {
    const repoDir = await makeTempDir('kinloom-batch-resume-');
    seedMultiPersonArchive(repoDir);
    const mediaDir = path.join(repoDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'audio-clara-vance.mp3'), Buffer.alloc(0));

    let fetchCalls = 0;
    const mockFetch: typeof fetch = async () => {
      fetchCalls += 1;
      const wav = makeWav(Buffer.alloc(24000, 0x03), 24000);
      return new Response(new Uint8Array(wav), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    };

    let ffmpegCalls = 0;
    const mockExec: ExecFileFn = async (file, args) => {
      expect(file).toBe('ffmpeg');
      ffmpegCalls += 1;
      fs.writeFileSync(args[args.length - 1]!, Buffer.from('ID3-synthesized'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const run1 = await invokeNarrativeAudio(
      [
        'batch',
        '--repo',
        repoDir,
        '--endpoint',
        'http://127.0.0.1:8080',
        '--slice',
        '0:2',
        '--resume',
        '--json',
      ],
      { fetchImpl: mockFetch, execFileImpl: mockExec }
    );
    expect(run1.exitCode, run1.stderr).toBe(0);
    const s1 = JSON.parse(run1.stdout) as {
      synthesized: number;
      skipped_existing: number;
      synthesized_ids: string[];
      total_candidates: number;
    };
    expect(s1.total_candidates).toBe(3);
    expect(s1.synthesized).toBe(2);
    expect(s1.synthesized_ids).toEqual(['nar_hendrik', 'nar_clara']);
    expect(s1.skipped_existing).toBe(0);
    expect(ffmpegCalls).toBe(2);

    const fetchAfterRun1 = fetchCalls;

    const run2 = await invokeNarrativeAudio(
      ['batch', '--repo', repoDir, '--backend', 'openai-speech', '--slice', '0:2', '--resume', '--json'],
      { fetchImpl: mockFetch, execFileImpl: mockExec }
    );
    expect(run2.exitCode, run2.stderr).toBe(0);
    const s2 = JSON.parse(run2.stdout) as {
      synthesized: number;
      skipped_existing: number;
      skipped_existing_ids: string[];
      resume: boolean;
    };
    expect(s2.resume).toBe(true);
    expect(s2.synthesized).toBe(0);
    expect(s2.skipped_existing).toBe(2);
    expect(s2.skipped_existing_ids).toEqual(['nar_hendrik', 'nar_clara']);
    expect(fetchCalls).toBe(fetchAfterRun1);
    expect(ffmpegCalls).toBe(2);

    const run3 = await invokeNarrativeAudio(
      [
        'batch',
        '--repo',
        repoDir,
        '--endpoint',
        'http://127.0.0.1:8080',
        '--slice',
        '2:',
        '--resume',
        '--json',
      ],
      { fetchImpl: mockFetch, execFileImpl: mockExec }
    );
    expect(run3.exitCode, run3.stderr).toBe(0);
    const s3 = JSON.parse(run3.stdout) as { synthesized_ids: string[] };
    expect(s3.synthesized_ids).toEqual(['nar_arthur']);
    expect(ffmpegCalls).toBe(3);
  });
});

describe('narrative-audio qa', () => {
  function makeMockFfprobe(
    responses: Record<
      string,
      {
        streamStdout?: string;
        streamErr?: unknown;
        astatsStdout?: string;
        astatsErr?: unknown;
      }
    >
  ): ExecFileFn {
    return async (file, args) => {
      expect(file).toBe('ffprobe');
      const isAstats = args.includes('lavfi');
      const key = Object.keys(responses).find((k) =>
        isAstats ? args.some((a) => a.includes(path.basename(k))) : args[args.length - 1] === k
      );
      if (!key) {
        throw new Error(`No mock ffprobe response for args: ${args.join(' ')}`);
      }
      const cfg = responses[key]!;
      if (isAstats) {
        if (cfg.astatsErr !== undefined) throw cfg.astatsErr;
        return { stdout: Buffer.from(cfg.astatsStdout ?? '{}'), stderr: Buffer.alloc(0) };
      }
      if (cfg.streamErr !== undefined) throw cfg.streamErr;
      return { stdout: Buffer.from(cfg.streamStdout ?? '{}'), stderr: Buffer.alloc(0) };
    };
  }

  function okStreamJson(
    overrides: Partial<{
      format_name: string;
      duration: string;
      codec_name: string;
      sample_rate: string;
      channels: number;
    }> = {}
  ): string {
    return JSON.stringify({
      streams: [
        {
          codec_type: 'audio',
          codec_name: overrides.codec_name ?? 'mp3',
          sample_rate: overrides.sample_rate ?? '24000',
          channels: overrides.channels ?? 1,
          duration: overrides.duration ?? '45.2',
        },
      ],
      format: {
        format_name: overrides.format_name ?? 'mp3',
        duration: overrides.duration ?? '45.2',
      },
    });
  }

  function okAstatsJson(
    peak: string | number | null = '-3.2',
    rms: string | number | null = '-18.4'
  ): string {
    return JSON.stringify({
      frames: [
        {
          tags: {
            'lavfi.astats.Overall.Peak_level': peak,
            'lavfi.astats.Overall.RMS_level': rms,
          },
        },
      ],
    });
  }

  it('renders qa --help and passes valid MP3 and WAV files in a directory', async () => {
    const helpRes = await invokeNarrativeAudio(['qa', '--help']);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain('kinloom narrative-audio qa');

    const dir = await makeTempDir('kinloom-qa-ok-');
    const nested = path.join(dir, 'sub');
    fs.mkdirSync(nested, { recursive: true });
    const mp3Path = path.join(dir, 'hendrik.mp3');
    const wavPath = path.join(nested, 'clara.wav');
    const txtPath = path.join(dir, 'ignore.txt');
    await writeFile(mp3Path, Buffer.from('ID3-mock'));
    await writeFile(wavPath, Buffer.from('RIFF-mock'));
    await writeFile(txtPath, 'ignored');

    const mockExec = makeMockFfprobe({
      [mp3Path]: {
        streamStdout: okStreamJson({ format_name: 'mp3', codec_name: 'mp3', duration: '62.5' }),
        astatsStdout: okAstatsJson(-2.5, -19.1), // numeric peak/rms values
      },
      [wavPath]: {
        // omit format.duration to exercise audioStream.duration fallback
        streamStdout: JSON.stringify({
          streams: [
            {
              codec_type: 'audio',
              codec_name: 'pcm_s16le',
              sample_rate: 24000,
              channels: '1',
              duration: '15.0',
            },
          ],
          format: { format_name: 'wav' },
        }),
        astatsStdout: okAstatsJson('-4.0', '-21.0'),
      },
    });

    // Pass directory AND duplicate file to verify deduplication
    const jsonRes = await invokeNarrativeAudio(
      ['qa', dir, mp3Path, '--min-rms-db', '-45', '--max-peak-db', '-0.2', '--json'],
      { execFileImpl: mockExec }
    );
    expect(jsonRes.exitCode, jsonRes.stderr).toBe(0);
    const summary = JSON.parse(jsonRes.stdout) as AudioQaSummary;
    expect(summary.ok).toBe(true);
    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.files[0]?.codec).toBe('mp3');
    expect(summary.files[1]?.codec).toBe('pcm_s16le');

    // Text output mode with default thresholds
    const textRes = await invokeNarrativeAudio(['qa', dir], { execFileImpl: mockExec });
    expect(textRes.exitCode).toBe(0);
    expect(textRes.stdout).toContain('Narrative Audio QA: 2/2 passed (0 failed)');
    expect(textRes.stdout).toContain('PASS');
  });

  it('flags duration bounds, invalid streams/codecs, silence, and clipping', async () => {
    const dir = await makeTempDir('kinloom-qa-fail-');
    const shortMp3 = path.join(dir, '01-short.mp3');
    const longMp3 = path.join(dir, '02-long.mp3');
    const silentMp3 = path.join(dir, '03-silent.mp3');
    const quietMp3 = path.join(dir, '04-quiet.mp3');
    const clipMp3 = path.join(dir, '05-clip.mp3');
    const badCodec = path.join(dir, '06-ogg.mp3');
    const noStream = path.join(dir, '07-nostream.mp3');
    const emptyVals = path.join(dir, '08-emptyvals.mp3');
    for (const p of [shortMp3, longMp3, silentMp3, quietMp3, clipMp3, badCodec, noStream, emptyVals]) {
      await writeFile(p, Buffer.from('mock'));
    }

    const mockExec = makeMockFfprobe({
      [shortMp3]: {
        streamStdout: okStreamJson({ duration: '0.4' }),
        astatsStdout: okAstatsJson('-6.0', '-20.0'),
      },
      [longMp3]: {
        streamStdout: okStreamJson({ duration: '125.0' }),
        astatsStdout: okAstatsJson('-6.0', '-20.0'),
      },
      [silentMp3]: {
        streamStdout: okStreamJson({ duration: '10.0' }),
        astatsStdout: okAstatsJson('-inf', '-inf'),
      },
      [quietMp3]: {
        streamStdout: okStreamJson({ duration: '10.0' }),
        astatsStdout: okAstatsJson('-35.0', '-62.5'),
      },
      [clipMp3]: {
        streamStdout: okStreamJson({ duration: '10.0' }),
        astatsStdout: okAstatsJson('0.0', '-12.0'),
      },
      [badCodec]: {
        streamStdout: JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: 'opus', sample_rate: '', channels: null }],
          format: { format_name: 'ogg', duration: '0' },
        }),
        astatsStdout: JSON.stringify({ frames: [] }),
      },
      [noStream]: {
        streamStdout: JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: '5' } }),
      },
      [emptyVals]: {
        streamStdout: JSON.stringify({
          streams: [{ codec_type: 'audio', codec_name: '', sample_rate: '24000', channels: 1 }],
          format: { format_name: '', duration: '10' },
        }),
        astatsStdout: okAstatsJson('', null),
      },
    });

    const res = await invokeNarrativeAudio(
      ['qa', dir, '--min-duration', '2', '--max-duration', '100', '--json'],
      { execFileImpl: mockExec }
    );
    expect(res.exitCode).toBe(1);
    const summary = JSON.parse(res.stdout) as AudioQaSummary;
    expect(summary.ok).toBe(false);
    expect(summary.failed).toBe(8);

    const byName = new Map(summary.files.map((f) => [path.basename(f.file), f.issues.join(' | ')]));
    expect(byName.get('01-short.mp3')).toContain('below minimum 2s');
    expect(byName.get('02-long.mp3')).toContain('exceeds maximum 100s');
    expect(byName.get('03-silent.mp3')).toContain('completely silent');
    expect(byName.get('04-quiet.mp3')).toContain('near-silent');
    expect(byName.get('05-clip.mp3')).toContain('clipping');
    expect(byName.get('06-ogg.mp3')).toContain('unsupported audio format/codec');
    expect(byName.get('06-ogg.mp3')).toContain('invalid or missing sample_rate');
    expect(byName.get('06-ogg.mp3')).toContain('invalid or missing channels');
    expect(byName.get('06-ogg.mp3')).toContain('missing or non-positive audio duration');
    expect(byName.get('06-ogg.mp3')).toContain('astats returned no audio level metadata');
    expect(byName.get('07-nostream.mp3')).toContain('no audio stream found');
    expect(byName.get('08-emptyvals.mp3')).toContain('format=unknown, codec=unknown');

    const textRes = await invokeNarrativeAudio(
      ['qa', shortMp3, '--min-duration', '2', '--max-duration', '100'],
      { execFileImpl: mockExec }
    );
    expect(textRes.exitCode).toBe(1);
    expect(textRes.stdout).toContain('FAIL');
  });

  it('handles ffprobe errors, invalid JSON, missing ffprobe, and invalid CLI args cleanly', async () => {
    const dir = await makeTempDir('kinloom-qa-err-');
    const f1 = path.join(dir, '01-corrupt.mp3');
    const f2 = path.join(dir, '02-badjson.mp3');
    const f3 = path.join(dir, '03-arrayjson.mp3');
    const f4 = path.join(dir, '04-astatserr.mp3');
    const f5 = path.join(dir, '05-stringerr.mp3');
    for (const p of [f1, f2, f3, f4, f5]) {
      await writeFile(p, Buffer.from('bad'));
    }

    const corruptErr = Object.assign(new Error('exit 1'), {
      stderr: Buffer.from('Invalid data found when processing input'),
    });
    const mockExec = makeMockFfprobe({
      [f1]: { streamErr: corruptErr },
      [f2]: { streamStdout: 'not-json' },
      [f3]: { streamStdout: '[]' },
      [f4]: { streamStdout: okStreamJson(), astatsErr: new Error('lavfi filter failed') },
      [f5]: { streamErr: 'raw-string-error' },
    });

    const res = await invokeNarrativeAudio(['qa', dir, '--json'], { execFileImpl: mockExec });
    expect(res.exitCode).toBe(1);
    const summary = JSON.parse(res.stdout) as AudioQaSummary;
    const byName = new Map(summary.files.map((f) => [path.basename(f.file), f.issues.join(' | ')]));
    expect(byName.get('01-corrupt.mp3')).toContain('Invalid data found');
    expect(byName.get('02-badjson.mp3')).toContain('invalid JSON');
    expect(byName.get('03-arrayjson.mp3')).toContain('non-object JSON');
    expect(byName.get('04-astatserr.mp3')).toContain('silence/clipping probe failed: lavfi filter failed');
    expect(byName.get('05-stringerr.mp3')).toContain('raw-string-error');

    // ENOENT from stream ffprobe and astats ffprobe
    const enoentErr = Object.assign(new Error('spawn ffprobe ENOENT'), { code: 'ENOENT' });
    const enoentRes = await invokeNarrativeAudio(['qa', f1], {
      execFileImpl: makeMockFfprobe({ [f1]: { streamErr: enoentErr } }),
    });
    expect(enoentRes.exitCode).toBe(1);
    expect(enoentRes.stderr).toContain('ffprobe not found on PATH');

    const astatsEnoentRes = await invokeNarrativeAudio(['qa', f1], {
      execFileImpl: makeMockFfprobe({ [f1]: { streamStdout: okStreamJson(), astatsErr: enoentErr } }),
    });
    expect(astatsEnoentRes.exitCode).toBe(1);
    expect(astatsEnoentRes.stderr).toContain('ffprobe not found on PATH');

    // Missing ffprobe on empty PATH when no execFileImpl injected
    const noPathRes = await invokeNarrativeAudio(['qa', f1], { env: { PATH: '' } });
    expect(noPathRes.exitCode).toBe(1);
    expect(noPathRes.stderr).toContain('ffprobe not found on PATH');

    // Invalid min/max duration bounds
    const badBounds = await invokeNarrativeAudio(['qa', f1, '--min-duration', '50', '--max-duration', '10']);
    expect(badBounds.exitCode).toBe(2);
    expect(badBounds.stderr).toContain('--min-duration');

    // Missing path
    const missingPath = await invokeNarrativeAudio(['qa', path.join(dir, 'nope.mp3')]);
    expect(missingPath.exitCode).toBe(2);
    expect(missingPath.stderr).toContain('Audio path not found');

    // Empty directory with no audio files
    const emptyDir = await makeTempDir('kinloom-qa-empty-');
    const emptyRes = await invokeNarrativeAudio(['qa', emptyDir]);
    expect(emptyRes.exitCode).toBe(2);
    expect(emptyRes.stderr).toContain('No .mp3 or .wav files found');
  });
});
