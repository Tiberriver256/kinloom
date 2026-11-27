import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseNarrativesYaml as parseCoreNarrativesYaml,
  parseKinloomConfig,
  serializeKinloomConfigYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRecordContext, type ExecFileFn, type RecordCommandContext } from '../../runtime/index.js';
import {
  type NarrativeBatchManifest,
  narrativeMarkdownToSpokenScript,
  runNarrativeAudioCommand,
} from '../narrative-audio.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'kinloom-na-batch-'): Promise<string> {
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
  overrides: Partial<RecordCommandContext> = {}
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
    nowMs: overrides.nowMs ?? (() => Date.parse('2026-11-27T12:00:00.000Z')),
  });
  const outcome = await runNarrativeAudioCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

function seedSyntheticArchive(repoDir: string): void {
  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  const config = parseKinloomConfig({
    site: {
      title: 'Synthetic Oakville Archive',
      familyName: 'Van der Meer',
      gedcomSourceName: 'OAKVILLE_NA',
    },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
    pronunciations: {
      'Hendrik van der Meer': {
        phonetic: 'HEN-drik vahn der MAIR',
        ipa: '/ˈɦɛn.drɪk vɑn dɛr meːr/',
        language: 'nl',
      },
      Oakville: {
        phonetic: 'OHK-vil',
        ipa: '/ˈoʊk.vɪl/',
        language: 'en-US',
      },
    },
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
        id: 'per_jane',
        slug: 'jane-doe',
        full_name: 'Jane Doe',
        given_name: 'Jane',
        surname: 'Doe',
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
        updated_at: '2026-11-27',
        has_primary_source: true,
        body_md: [
          '## Early Years',
          '**Hendrik van der Meer** settled in [Oakville](https://example.test) on 9 May 1866 ([src_1], [med_1]).',
          '',
          '## Research Notes',
          '- Born ca. 1840 per parish roll [src_1].',
        ].join('\n'),
      },
      {
        id: 'nar_jane_done',
        slug: 'jane-doe',
        kind: 'biography',
        subject_person_id: 'per_jane',
        title: 'Jane Doe',
        summary: 'Already has narration audio.',
        date_edtf: '1855/1924',
        person_ids: ['per_jane'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-27',
        has_primary_source: false,
        body_md: 'Jane Doe taught school in Oakville.',
        extensions: {
          narrative_audio: {
            file: '/media/audio-jane-doe.mp3',
            duration_seconds: 95,
          },
        },
      },
      {
        id: 'nar_living_bio',
        slug: 'living-bio',
        kind: 'biography',
        subject_person_id: 'per_living',
        title: 'Taylor SecretLiving',
        summary: 'Must never appear in audio output.',
        date_edtf: '1992',
        person_ids: ['per_living'],
        place_ids: [],
        event_ids: [],
        source_ids: [],
        updated_at: '2026-11-27',
        has_primary_source: false,
        body_md: 'Taylor SecretLiving is living.',
      },
    ]),
    'utf8'
  );
}

describe('narrative-audio openai-speech backend', () => {
  it('supports synth --backend openai-speech dry-run with ipa, arpabet, and plain phoneme modes', async () => {
    const tmp = await makeTempDir();
    const scriptPath = path.join(tmp, 'hendrik.script.txt');
    const namesPath = path.join(tmp, 'hendrik.names.json');
    await writeFile(
      scriptPath,
      [
        '## Oakville Arrival',
        'Hendrik van der Meer reached Oakville on 9 May 1866.',
        '',
        "# EDITOR'S NOTES",
        '- Recorded in the Oakville ledger.',
      ].join('\n')
    );
    await writeFile(
      namesPath,
      JSON.stringify({
        Oakville: '/ˈoʊk.vɪl/',
        'Hendrik van der Meer': '/ˈɦɛn.drɪk vɑn dɛr meːr/',
      })
    );

    const ipaDry = await invokeNarrativeAudio([
      'synth',
      scriptPath,
      '--names',
      namesPath,
      '--backend',
      'openai-speech',
      '--phoneme-mode',
      'ipa',
      '--dry-run',
    ]);
    expect(ipaDry.exitCode, ipaDry.stderr).toBe(0);
    expect(ipaDry.stdout).toContain('openai-speech · fishaudio/drama-3:Charon · phonemes:ipa');
    expect(ipaDry.stdout).toContain('<|phoneme_start|>ˈoʊk.vɪl<|phoneme_end|>');

    const arpaDry = await invokeNarrativeAudio([
      'synth',
      scriptPath,
      '--names',
      namesPath,
      '--backend',
      'openai-speech',
      '--phoneme-mode',
      'arpabet',
      '--dry-run',
    ]);
    expect(arpaDry.exitCode, arpaDry.stderr).toBe(0);
    expect(arpaDry.stdout).toContain('<|phoneme_start|>OW1 K V IH0 L<|phoneme_end|>');

    const plainDry = await invokeNarrativeAudio([
      'synth',
      scriptPath,
      '--names',
      namesPath,
      '--backend',
      'openai-speech',
      '--phoneme-mode',
      'plain',
      '--dry-run',
    ]);
    expect(plainDry.exitCode, plainDry.stderr).toBe(0);
    expect(plainDry.stdout).toContain('reached Oakville on May ninth, 1866.');
    expect(plainDry.stdout).not.toContain('<|phoneme_start|>');
  });

  it('synthesizes via openai-speech without seed, sends story/notes clone refs, strips WAV headers, and computes exact timings', async () => {
    const tmp = await makeTempDir();
    const scriptPath = path.join(tmp, 'story.txt');
    const storyRefPath = path.join(tmp, 'story-ref.wav');
    const notesRefPath = path.join(tmp, 'notes-ref.wav');
    const outPath = path.join(tmp, 'story.mp3');

    await writeFile(
      scriptPath,
      [
        '## Story',
        'Jane Doe built a schoolhouse in Oakville.',
        '',
        "# EDITOR'S NOTES",
        '- Schoolhouse opened in 1882.',
      ].join('\n')
    );
    await writeFile(storyRefPath, Buffer.from('RIFF-story-ref'));
    await writeFile(notesRefPath, Buffer.from('RIFF-notes-ref'));

    // 0.5s at 24kHz mono 16-bit = 24000 bytes
    const wavChunk = makeWav(Buffer.alloc(24000, 0x09), 24000);
    const payloads: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:8000/v1/audio/speech');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer colab-secret');
      payloads.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(wavChunk, { status: 200, headers: { 'content-type': 'audio/wav' } });
    });

    let capturedPcmBytes = 0;
    const mockExec: ExecFileFn = async (file, args) => {
      expect(file).toBe('ffmpeg');
      const inputIdx = args.indexOf('-i');
      capturedPcmBytes = fs.statSync(args[inputIdx + 1]).size;
      fs.writeFileSync(args[args.length - 1], Buffer.from('ID3-openai-mp3'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const res = await invokeNarrativeAudio(
      [
        'synth',
        scriptPath,
        '--backend',
        'openai-speech',
        '--endpoint',
        'http://127.0.0.1:8000',
        '--api-key',
        'colab-secret',
        '--story-ref-audio',
        storyRefPath,
        '--story-ref-text',
        'Story sample.',
        '--notes-ref-audio',
        notesRefPath,
        '--notes-ref-text',
        'Notes sample.',
        '--notes-pause',
        '1.0',
        '-o',
        outPath,
      ],
      {
        fetchImpl: mockFetch,
        execFileImpl: mockExec,
      }
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(payloads).toHaveLength(2);
    for (const body of payloads) {
      expect('seed' in body).toBe(false);
      expect(body.model).toBe('fishaudio/drama-3');
      expect(body.response_format).toBe('wav');
    }
    expect(payloads[0]?.references).toEqual([
      { audio: Buffer.from('RIFF-story-ref').toString('base64'), text: 'Story sample.' },
    ]);
    expect(payloads[1]?.references).toEqual([
      { audio: Buffer.from('RIFF-notes-ref').toString('base64'), text: 'Notes sample.' },
    ]);
    // 0.5s story + 1.0s silence + 0.5s notes = 2.0s = 96000 bytes
    expect(capturedPcmBytes).toBe(96000);
    expect(res.stdout).toContain('duration_seconds: 2');
    expect(res.stdout).toContain('editor_notes_start_seconds: 2');
  });
});

describe('narrative-audio markdown prep and archive batch mode', () => {
  it('converts markdown biographies into spoken scripts with notes split and citations stripped', () => {
    const md = [
      '## Early Life',
      '**Jane Doe** Jr. lived in [Oakville](https://example.test) on 9 May 1866 ([src_1], [med_2]).',
      'She served with Capt. Hendrik van der Meer (b. 1840, d. 1912) among 1,200 settlers.',
      '',
      '## Research Notes',
      '- Birth year ca. 1855 from ledger [src_1].',
    ].join('\n');

    const spoken = narrativeMarkdownToSpokenScript(md, 'Jane Doe');
    expect(spoken).toContain('## Early Life');
    expect(spoken).toContain('Jane Doe Junior lived in Oakville on May ninth, 1866.');
    expect(spoken).toContain(
      'Captain Hendrik van der Meer (born 1840, died 1912) among one thousand two hundred settlers.'
    );
    expect(spoken).toContain("# EDITOR'S NOTES\n- Birth year about 1855 from ledger.");
    expect(spoken).not.toContain('src_1');
    expect(spoken).not.toContain('med_2');
  });

  it('exports privacy-filtered batch manifests, imports rendered MP3s + metadata, and updates data/narratives.yaml', async () => {
    const repoDir = await makeTempDir();
    seedSyntheticArchive(repoDir);
    const manifestPath = path.join(repoDir, 'tmp', 'narratives-manifest.json');

    // Also verifies --all-missing alias delegates cleanly to batch!
    const expRes = await invokeNarrativeAudio([
      'synth',
      '--all-missing',
      '--repo',
      repoDir,
      '--backend',
      'openai-speech',
      '--export-manifest',
      manifestPath,
      '--json',
    ]);
    expect(expRes.exitCode, expRes.stderr).toBe(0);
    const expJson = JSON.parse(expRes.stdout) as {
      mode: string;
      narratives: number;
      already_has_audio: number;
      living_skipped: number;
    };
    expect(expJson.mode).toBe('export_manifest');
    expect(expJson.narratives).toBe(1);
    expect(expJson.already_has_audio).toBe(1);
    expect(expJson.living_skipped).toBe(1);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as NarrativeBatchManifest;
    expect(manifest.kind).toBe('kinloom-narrative-audio-manifest');
    expect(manifest.living_skipped).toBe(1);
    expect(manifest.narratives).toHaveLength(1);
    expect(manifest.narratives[0]?.id).toBe('nar_hendrik');
    expect(JSON.stringify(manifest)).not.toContain('SecretLiving');
    expect(JSON.stringify(manifest)).not.toContain('per_living');
    expect(manifest.narratives[0]?.chunks[0]?.text).toContain('<|phoneme_start|>ˈoʊk.vɪl<|phoneme_end|>');

    // Simulate Colab rendering audio-hendrik-van-der-meer.mp3 + manifest-results.json
    const importDir = path.join(repoDir, 'colab-rendered');
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, 'audio-hendrik-van-der-meer.mp3'), Buffer.from('ID3-colab-mp3'));
    fs.writeFileSync(
      path.join(importDir, 'manifest-results.json'),
      JSON.stringify([
        {
          id: 'nar_hendrik',
          duration_seconds: 142.4,
          editor_notes_start_seconds: 118.2,
          story_voice: 'Charon',
          notes_voice: 'Kore',
        },
      ])
    );

    const impRes = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--import-dir',
      importDir,
      '--json',
    ]);
    expect(impRes.exitCode, impRes.stderr).toBe(0);
    const impJson = JSON.parse(impRes.stdout) as {
      imported: number;
      yaml_updated: boolean;
      living_skipped: number;
    };
    expect(impJson.imported).toBe(1);
    expect(impJson.yaml_updated).toBe(true);
    expect(impJson.living_skipped).toBe(1);
    expect(fs.existsSync(path.join(repoDir, 'media', 'audio-hendrik-van-der-meer.mp3'))).toBe(true);

    const updatedNarratives = parseCoreNarrativesYaml(
      fs.readFileSync(path.join(repoDir, 'data', 'narratives.yaml'), 'utf8')
    );
    const hendrikNar = updatedNarratives.find((n) => n.id === 'nar_hendrik');
    expect(hendrikNar?.extensions?.narrative_audio).toEqual({
      file: '/media/audio-hendrik-van-der-meer.mp3',
      duration_seconds: 142,
      editor_notes_start_seconds: 118,
      story_voice: 'Charon',
      notes_voice: 'Kore',
    });
  });

  it('runs batch dry-run and live resumable openai-speech synthesis with --update-yaml', async () => {
    const repoDir = await makeTempDir();
    seedSyntheticArchive(repoDir);

    const helpRes = await invokeNarrativeAudio(['batch', '--help']);
    expect(helpRes.exitCode).toBe(0);
    expect(helpRes.stdout).toContain('kinloom narrative-audio batch');

    const dryRes = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--endpoint',
      'http://127.0.0.1:8000',
      '--dry-run',
    ]);
    expect(dryRes.exitCode, dryRes.stderr).toBe(0);
    expect(dryRes.stdout).toContain('openai-speech · fishaudio/drama-3');
    expect(dryRes.stdout).toContain('nar_hendrik');
    expect(dryRes.stdout).not.toContain('SecretLiving');

    const wavChunk = makeWav(Buffer.alloc(24000, 0x03), 24000);
    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(wavChunk, { status: 200, headers: { 'content-type': 'audio/wav' } });
    });
    const mockExec: ExecFileFn = async (_file, args) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('ID3-batch-mp3'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const liveRes = await invokeNarrativeAudio(
      ['batch', '--repo', repoDir, '--endpoint', 'http://127.0.0.1:8000', '--update-yaml', '--json'],
      { fetchImpl: mockFetch, execFileImpl: mockExec }
    );
    expect(liveRes.exitCode, liveRes.stderr).toBe(0);
    const liveJson = JSON.parse(liveRes.stdout) as {
      synthesized: number;
      skipped_existing: number;
      yaml_updated: boolean;
      living_skipped: number;
    };
    expect(liveJson.synthesized).toBe(1);
    expect(liveJson.skipped_existing).toBe(0);
    expect(liveJson.yaml_updated).toBe(true);
    expect(liveJson.living_skipped).toBe(1);

    // Resumable run when audio file already exists on disk (even if YAML lacked it) skips synthesis
    const secondOutDir = path.join(repoDir, 'media');
    const resumable = await invokeNarrativeAudio(
      [
        'batch',
        '--repo',
        repoDir,
        '--endpoint',
        'http://127.0.0.1:8000',
        '--out-dir',
        secondOutDir,
        '--force',
        '--dry-run',
        '--json',
      ],
      { fetchImpl: mockFetch, execFileImpl: mockExec }
    );
    expect(resumable.exitCode).toBe(0);
    expect(JSON.parse(resumable.stdout).items.length).toBe(2);
  });

  it('covers batch validation errors, per-file meta import, object-map meta import, and gemini/chirp batch synthesis', async () => {
    const repoDir = await makeTempDir();
    seedSyntheticArchive(repoDir);

    // Missing config / missing narratives / invalid backend / missing import dir
    const emptyDir = await makeTempDir();
    const noConf = await invokeNarrativeAudio(['batch', '--repo', emptyDir]);
    expect(noConf.exitCode).toBe(2);
    expect(noConf.stderr).toContain('Missing');

    fs.copyFileSync(path.join(repoDir, 'kinloom.config.yaml'), path.join(emptyDir, 'kinloom.config.yaml'));
    const noNar = await invokeNarrativeAudio(['batch', '--repo', emptyDir]);
    expect(noNar.exitCode).toBe(2);

    const badBackend = await invokeNarrativeAudio(['batch', '--repo', repoDir, '--backend', 'unknown']);
    expect(badBackend.exitCode).toBe(2);

    const badImp = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--import-dir',
      path.join(repoDir, 'no-such-dir'),
    ]);
    expect(badImp.exitCode).toBe(2);

    // Text-mode export and import with per-file <slug>.meta.json and object-map manifest-results.json
    const expText = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--export-manifest',
      path.join(repoDir, 'm.json'),
    ]);
    expect(expText.exitCode).toBe(0);
    expect(expText.stdout).toContain('Exported narrative audio manifest');

    const singleMetaDir = path.join(repoDir, 'single-meta');
    fs.mkdirSync(singleMetaDir, { recursive: true });
    fs.writeFileSync(path.join(singleMetaDir, 'hendrik-van-der-meer.mp3'), Buffer.from('ID3-single'));
    fs.writeFileSync(
      path.join(singleMetaDir, 'hendrik-van-der-meer.meta.json'),
      JSON.stringify({ duration_seconds: 88, editor_notes_start_seconds: 70, story_voice: 'Charon' })
    );
    const impText = await invokeNarrativeAudio(['batch', '--repo', repoDir, '--import-dir', singleMetaDir]);
    expect(impText.exitCode, impText.stderr).toBe(0);
    expect(impText.stdout).toContain('Imported 1 narrative audio file(s)');

    // Object-map manifest-results.json with --force
    const objMetaDir = path.join(repoDir, 'obj-meta');
    fs.mkdirSync(objMetaDir, { recursive: true });
    fs.writeFileSync(path.join(objMetaDir, 'audio-hendrik-van-der-meer.mp3'), Buffer.from('ID3-obj'));
    fs.writeFileSync(
      path.join(objMetaDir, 'manifest-results.json'),
      JSON.stringify({ 'hendrik-van-der-meer': { duration_seconds: 91 } })
    );
    const impObj = await invokeNarrativeAudio([
      'batch',
      '--repo',
      repoDir,
      '--import-dir',
      objMetaDir,
      '--force',
      '--json',
    ]);
    expect(impObj.exitCode, impObj.stderr).toBe(0);
    expect(JSON.parse(impObj.stdout).missing).toBe(1);

    // Error handling in openai-speech synthesis (HTTP 500 -> exit 1) & mismatched ref flags (-> exit 2 even without ffmpeg)
    const scriptPath = path.join(repoDir, 'mini.txt');
    fs.writeFileSync(scriptPath, 'Jane Doe lived in Oakville.');
    const refMismatch = await invokeNarrativeAudio(
      [
        'synth',
        scriptPath,
        '--backend',
        'openai-speech',
        '--endpoint',
        'http://127.0.0.1:8000',
        '--story-ref-audio',
        scriptPath,
      ],
      { env: { PATH: '' } }
    );
    expect(refMismatch.exitCode).toBe(2);
    expect(refMismatch.stderr).toContain('--story-ref-audio and --story-ref-text');

    const notesRefMismatch = await invokeNarrativeAudio(
      [
        'synth',
        scriptPath,
        '--backend',
        'openai-speech',
        '--endpoint',
        'http://127.0.0.1:8000',
        '--notes-ref-text',
        'Reference sample',
      ],
      { env: { PATH: '' } }
    );
    expect(notesRefMismatch.exitCode).toBe(2);
    expect(notesRefMismatch.stderr).toContain('--notes-ref-audio and --notes-ref-text');

    const openAiErr = await invokeNarrativeAudio(
      ['synth', scriptPath, '--backend', 'openai-speech', '--endpoint', 'http://127.0.0.1:8000'],
      {
        fetchImpl: async () => new Response('server down', { status: 400 }),
        execFileImpl: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      }
    );
    expect(openAiErr.exitCode).toBe(1);
    expect(openAiErr.stderr).toContain('openai-speech HTTP 400');

    // Batch live synthesis with Gemini backend + text output + skip-existing
    const gemOutDir = path.join(repoDir, 'gem-batch');
    const wavChunk = makeWav(Buffer.alloc(24000, 0x02), 24000);
    const mockExec: ExecFileFn = async (_f, args) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('ID3-gem-batch'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const gemBatch = await invokeNarrativeAudio(
      ['batch', '--repo', repoDir, '--backend', 'gemini', '--out-dir', gemOutDir, '--force'],
      {
        env: { GEMINI_API_KEY: 'gem-secret' },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ inlineData: { mimeType: 'audio/wav', data: wavChunk.toString('base64') } }],
                  },
                },
              ],
              usageMetadata: { totalTokenCount: 100 },
            }),
            { status: 200 }
          ),
        execFileImpl: mockExec,
      }
    );
    expect(gemBatch.exitCode, gemBatch.stderr).toBe(0);
    expect(gemBatch.stdout).toContain('Synthesized 2 narrative(s) [gemini');

    // Empty markdown falls back to title heading
    expect(narrativeMarkdownToSpokenScript('   ', 'Hendrik van der Meer')).toBe('## Hendrik van der Meer');
  });
});
