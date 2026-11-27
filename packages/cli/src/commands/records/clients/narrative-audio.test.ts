import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRecordContext,
  type ExecFileFn,
  type RecordCommandContext,
} from '../runtime/index.js';
import {
  applyNames,
  buildChirpPronunciations,
  formatYamlSnippet,
  intToWords,
  ordinal,
  resolveChirpVoice,
  runNarrativeAudioCommand,
  speakDates,
  speakNumbers,
  splitScript,
  splitToByteLimit,
  stripWavHeader,
} from './narrative-audio.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-na-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeSyntheticWav(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  // Include an extra 'JUNK' chunk before 'data' to verify chunk-walking skips non-data chunks.
  const junkPayload = Buffer.from('test');
  const header = Buffer.alloc(12 + 24 + 8 + junkPayload.length + 8);
  let off = 0;
  header.write('RIFF', off, 'ascii');
  off += 4;
  header.writeUInt32LE(header.length - 8 + pcm.length, off);
  off += 4;
  header.write('WAVE', off, 'ascii');
  off += 4;
  // fmt chunk
  header.write('fmt ', off, 'ascii');
  off += 4;
  header.writeUInt32LE(16, off);
  off += 4;
  header.writeUInt16LE(1, off); // PCM
  off += 2;
  header.writeUInt16LE(channels, off);
  off += 2;
  header.writeUInt32LE(sampleRate, off);
  off += 4;
  header.writeUInt32LE(byteRate, off);
  off += 4;
  header.writeUInt16LE(blockAlign, off);
  off += 2;
  header.writeUInt16LE(bitsPerSample, off);
  off += 2;
  // JUNK chunk
  header.write('JUNK', off, 'ascii');
  off += 4;
  header.writeUInt32LE(junkPayload.length, off);
  off += 4;
  junkPayload.copy(header, off);
  off += junkPayload.length;
  // data chunk
  header.write('data', off, 'ascii');
  off += 4;
  header.writeUInt32LE(pcm.length, off);
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
  });
  const outcome = await runNarrativeAudioCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
  };
}

describe('narrative-audio pure helpers', () => {
  it('converts ordinals and dates into spoken English', () => {
    expect(ordinal(1)).toBe('first');
    expect(ordinal(12)).toBe('twelfth');
    expect(ordinal(21)).toBe('twenty-first');
    expect(ordinal(30)).toBe('thirtieth');
    expect(ordinal(31)).toBe('thirty-first');

    expect(speakDates('Born 9 May 1766 in Virginia.')).toBe('Born May ninth, 1766 in Virginia.');
    expect(speakDates('Married May 9, 1766 and died 30 October.')).toBe(
      'Married May ninth, 1766 and died October thirtieth.'
    );
    expect(speakDates('Signed 21st July 1852.')).toBe('Signed July twenty-first, 1852.');
  });

  it('expands abbreviations and comma-grouped numbers into words', () => {
    expect(intToWords(0)).toBe('zero');
    expect(intToWords(42)).toBe('forty-two');
    expect(intToWords(6469)).toBe('six thousand four hundred sixty-nine');
    expect(intToWords(1_000_000)).toBe('one million');

    expect(speakNumbers('Served in the U.S. Army, Regiment No. 14, among 6,469 men.')).toBe(
      'Served in the United States Army, Regiment number 14, among six thousand four hundred sixty-nine men.'
    );
  });

  it('applies inline IPA names longest-first on whole words only', () => {
    const names = {
      Mercer: '/ˈmɜːrsər/',
      'Alden Mercer': '/ˈɔːldən ˈmɜːrsər/',
    };
    expect(applyNames('Alden Mercer met Mercer in Mercerville.', names)).toBe(
      '/ˈɔːldən ˈmɜːrsər/ met /ˈmɜːrsər/ in Mercerville.'
    );
  });

  it('builds Chirp 3: HD customPronunciations only for names present in text', () => {
    const names = {
      Mercer: '/ˈmɜːrsər/',
      'Alden Mercer': '/ˈɔːldən ˈmɜːrsər/',
      UnusedName: '/ˈʌnjuːzd/',
    };
    expect(buildChirpPronunciations('Alden Mercer crossed the river.', names)).toEqual([
      {
        phrase: 'Alden Mercer',
        phoneticEncoding: 'PHONETIC_ENCODING_IPA',
        pronunciation: 'ˈɔːldən ˈmɜːrsər',
      },
      {
        phrase: 'Mercer',
        phoneticEncoding: 'PHONETIC_ENCODING_IPA',
        pronunciation: 'ˈmɜːrsər',
      },
    ]);
    expect(resolveChirpVoice('Charon', 'en-US')).toBe('en-US-Chirp3-HD-Charon');
    expect(resolveChirpVoice('en-GB-Chirp3-HD-Kore', 'en-US')).toBe('en-GB-Chirp3-HD-Kore');
  });

  it('splits long sections on paragraph boundaries within UTF-8 byte limits', () => {
    const p1 = 'A'.repeat(40);
    const p2 = 'B'.repeat(40);
    const p3 = 'é'.repeat(20); // 40 bytes in UTF-8
    const parts = splitToByteLimit(`${p1}\n\n${p2}\n\n${p3}`, 50);
    expect(parts).toEqual([p1, p2, p3]);
    expect(splitToByteLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits scripts into sections and notes and formats YAML snippets', () => {
    const script = [
      '## Early Years',
      'Alden Mercer grew up near Springfield.',
      '',
      '## Later Life',
      'He retired in 1870.',
      '',
      "# EDITOR'S NOTES",
      '- Born in Ohio.',
      '* Confirmed by 1860 census.',
    ].join('\n');
    const { sections, notes } = splitScript(script);
    expect(sections).toEqual([
      'Early Years.\nAlden Mercer grew up near Springfield.',
      'Later Life.\nHe retired in 1870.',
    ]);
    expect(notes).toEqual(['Born in Ohio.', 'Confirmed by 1860 census.']);

    const snippet = formatYamlSnippet({
      fileName: 'alden-mercer.mp3',
      durationSeconds: 125.6,
      editorNotesStartSeconds: 102.2,
      storyVoice: 'Charon',
      notesVoice: 'Kore',
    });
    expect(snippet).toContain('extensions:\n  narrative_audio:');
    expect(snippet).toContain('    file: media/alden-mercer.mp3');
    expect(snippet).toContain('    duration_seconds: 126');
    expect(snippet).toContain('    editor_notes_start_seconds: 102');
    expect(snippet).toContain('    story_voice: Charon');
    expect(snippet).toContain('    notes_voice: Kore');
  });

  it('strips RIFF/WAV headers using DataView and preserves raw PCM pass-through', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = makeSyntheticWav(pcm, 44100);
    const stripped = stripWavHeader(wav, 24000);
    expect(stripped.sampleRate).toBe(44100);
    expect(stripped.pcm.equals(pcm)).toBe(true);

    const rawPass = stripWavHeader(pcm, 24000);
    expect(rawPass.sampleRate).toBe(24000);
    expect(rawPass.pcm.equals(pcm)).toBe(true);
  });
});

describe('narrative-audio CLI subcommands', () => {
  it('supports list and extract on narratives.yaml', async () => {
    const tmp = await makeTempDir();
    const yamlPath = path.join(tmp, 'narratives.yaml');
    await writeFile(
      yamlPath,
      [
        'narratives:',
        '  - id: N002',
        '    slug: clarissa-vance',
        '    title: Clarissa Vance',
        '    kind: biography',
        '    body_md: "Clarissa Vance lived in Sangamon County for forty years and kept a meticulous diary."',
        '  - id: N001',
        '    slug: alden-mercer',
        '    title: Alden Mercer',
        '    kind: biography',
        '    body_md: "Alden Mercer farmed near Springfield."',
        '  - id: N003',
        '    slug: county-overview',
        '    title: County Overview',
        '    kind: place',
        '    body_md: "A short place sketch."',
      ].join('\n')
    );

    const listBio = await invokeNarrativeAudio(['list', yamlPath]);
    expect(listBio.exitCode, listBio.stderr).toBe(0);
    expect(listBio.stdout.split('\n')).toEqual([
      '     5  N001  Alden Mercer',
      '    14  N002  Clarissa Vance',
    ]);

    const listAll = await invokeNarrativeAudio(['list', yamlPath, '--kind', '']);
    expect(listAll.exitCode).toBe(0);
    expect(listAll.stdout).toContain('N003  County Overview');

    const extracted = await invokeNarrativeAudio(['extract', yamlPath, 'N001']);
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    expect(extracted.stdout).toContain('SLUG: alden-mercer');
    expect(extracted.stdout).toContain('TITLE: Alden Mercer');
    expect(extracted.stdout).toContain('Alden Mercer farmed near Springfield.');

    const missing = await invokeNarrativeAudio(['extract', yamlPath, 'N999']);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('no narrative with id N999');
  });

  it('lints scripts accurately with check (exit 0 on clean, exit 1 on violations)', async () => {
    const tmp = await makeTempDir();
    const cleanScript = path.join(tmp, 'clean.txt');
    const cleanNames = path.join(tmp, 'clean-names.json');
    await writeFile(
      cleanScript,
      [
        '## Early Life',
        'Alden Mercer was born May ninth, 1766 in Springfield.',
        '',
        "# EDITOR'S NOTES",
        '- Birth date comes from the parish register.',
      ].join('\n')
    );
    await writeFile(cleanNames, JSON.stringify({ 'Alden Mercer': '/ˈɔːldən ˈmɜːrsər/' }));

    const okRes = await invokeNarrativeAudio(['check', cleanScript, '--names', cleanNames]);
    expect(okRes.exitCode, okRes.stderr).toBe(0);
    expect(okRes.stdout).toContain('1 story sections, 1 notes');
    expect(okRes.stdout).toContain('\nok');

    const dirtyScript = path.join(tmp, 'dirty.txt');
    const badNames = path.join(tmp, 'bad-names.json');
    await writeFile(
      dirtyScript,
      [
        'Born 9 May 1766, paid $470 or 5s. per Lib. 4, worth 6,469 dollars.',
        'He lived near U.S. Route No. 2 and used *emphasis* with "quotes" and a/b.',
      ].join('\n')
    );
    await writeFile(
      badNames,
      JSON.stringify({ MissingName: 'not-slashed' })
    );

    const failRes = await invokeNarrativeAudio(['check', dirtyScript, '--names', badNames]);
    expect(failRes.exitCode).toBe(1);
    expect(failRes.stdout).toContain('day-before-month date');
    expect(failRes.stdout).toContain('currency symbol');
    expect(failRes.stdout).toContain('s./d. money abbreviation');
    expect(failRes.stdout).toContain('citation remnant');
    expect(failRes.stdout).toContain('comma-grouped number');
    expect(failRes.stdout).toContain('abbreviation to spell out');
    expect(failRes.stdout).toContain('markdown emphasis or link');
    expect(failRes.stdout).toContain('quotation mark');
    expect(failRes.stdout).toContain("slash (write 'or')");
    expect(failRes.stdout).toContain("no '# EDITOR'S NOTES' section");
    expect(failRes.stdout).toContain("names: 'MissingName' does not appear in the script");
    expect(failRes.stdout).toContain('value is not /IPA/ in slashes');
  });

  it('supports synth --dry-run for both chirp3-hd and gemini backends with env defaults', async () => {
    const tmp = await makeTempDir();
    const scriptPath = path.join(tmp, 'alden.script.txt');
    const namesPath = path.join(tmp, 'names.json');
    await writeFile(
      scriptPath,
      [
        '## Origins',
        'Alden Mercer arrived 9 May 1766 with 1,200 acres.',
        '',
        "# EDITOR'S NOTES",
        '- Deeds recorded in Springfield.',
      ].join('\n')
    );
    await writeFile(namesPath, JSON.stringify({ 'Alden Mercer': '/ˈɔːldən ˈmɜːrsər/' }));

    const chirpDry = await invokeNarrativeAudio(
      ['synth', scriptPath, '--names', namesPath, '--dry-run'],
      { env: { NARRATIVE_AUDIO_LANGUAGE: 'en-GB' } }
    );
    expect(chirpDry.exitCode, chirpDry.stderr).toBe(0);
    expect(chirpDry.stdout).toContain('===== request 1 [chirp3-hd · en-GB-Chirp3-HD-Charon] =====');
    expect(chirpDry.stdout).toContain('Alden Mercer arrived May ninth, 1766 with one thousand two hundred acres.');
    expect(chirpDry.stdout).toContain('customPronunciations:');
    expect(chirpDry.stdout).toContain('===== request 2 [chirp3-hd · en-GB-Chirp3-HD-Kore · notes] =====');

    const geminiDry = await invokeNarrativeAudio(
      ['synth', scriptPath, '--names', namesPath, '--dry-run'],
      { env: { NARRATIVE_AUDIO_BACKEND: 'gemini' } }
    );
    expect(geminiDry.exitCode, geminiDry.stderr).toBe(0);
    expect(geminiDry.stdout).toContain('===== request 1 [gemini · gemini-3.8-flash-tts:Charon] =====');
    expect(geminiDry.stdout).toContain('/ˈɔːldən ˈmɜːrsər/ arrived May ninth, 1766');
  });

  it('synthesizes via Chirp 3: HD with gcloud ADC, retries transient 503, strips WAV headers, runs ffmpeg, and emits YAML snippet', async () => {
    const tmp = await makeTempDir();
    const scriptPath = path.join(tmp, 'alden.script.txt');
    const namesPath = path.join(tmp, 'names.json');
    const outPath = path.join(tmp, 'out', 'alden.mp3');
    await writeFile(
      scriptPath,
      [
        '## Story',
        'Alden Mercer worked the mill.',
        '',
        "# EDITOR'S NOTES",
        '- Mill stood along Sugar Creek.',
      ].join('\n')
    );
    await writeFile(namesPath, JSON.stringify({ 'Alden Mercer': '/ˈɔːldən ˈmɜːrsər/' }));

    // 0.5 seconds of 16-bit mono PCM at 24kHz = 24000 bytes
    const pcmChunk = Buffer.alloc(24000, 0x11);
    const wavChunk = makeSyntheticWav(pcmChunk, 24000);

    const sentRequests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
    let attemptCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      attemptCount += 1;
      const headersObj: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headersObj[k] = v;
      });
      if (attemptCount === 1) {
        return new Response('transient overload', { status: 503 });
      }
      sentRequests.push({
        url: String(input),
        headers: headersObj,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(
        JSON.stringify({ audioContent: wavChunk.toString('base64') }),
        { status: 200 }
      );
    };

    const execCalls: Array<{ file: string; args: readonly string[]; pcmBytes?: number }> = [];
    const mockExec: ExecFileFn = async (file, args) => {
      if (file === 'gcloud' && args[0] === 'auth') {
        execCalls.push({ file, args });
        return { stdout: Buffer.from('adc-token-123\n'), stderr: Buffer.alloc(0) };
      }
      if (file === 'gcloud' && args[0] === 'config') {
        execCalls.push({ file, args });
        return { stdout: Buffer.from('synthetic-gcp-project\n'), stderr: Buffer.alloc(0) };
      }
      if (file === 'ffmpeg') {
        const inputIdx = args.indexOf('-i');
        const pcmPath = args[inputIdx + 1];
        const pcmBytes = fs.statSync(pcmPath).size;
        execCalls.push({ file, args, pcmBytes });
        fs.writeFileSync(args[args.length - 1], Buffer.from('ID3-mock-mp3'));
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
      }
      throw new Error(`Unexpected executable: ${file}`);
    };

    const res = await invokeNarrativeAudio(
      ['synth', scriptPath, '--names', namesPath, '-o', outPath, '--notes-pause', '1.0'],
      {
        env: {},
        fetchImpl: mockFetch,
        execFileImpl: mockExec,
      }
    );

    expect(res.exitCode, res.stderr).toBe(0);
    expect(attemptCount).toBe(3); // 1 transient 503 + 2 successful chunks
    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[0].url).toContain('texttospeech.googleapis.com');
    expect(sentRequests[0].headers.authorization).toBe('Bearer adc-token-123');
    expect(sentRequests[0].headers['x-goog-user-project']).toBe('synthetic-gcp-project');

    const firstBody = sentRequests[0].body as {
      input: { customPronunciations?: { pronunciations: Array<{ phrase: string }> } };
      voice: { name: string };
    };
    expect(firstBody.voice.name).toBe('en-US-Chirp3-HD-Charon');
    expect(firstBody.input.customPronunciations?.pronunciations[0].phrase).toBe('Alden Mercer');

    const ffmpegCall = execCalls.find((c) => c.file === 'ffmpeg');
    expect(ffmpegCall).toBeDefined();
    // 0.5s story + 1.0s silence + 0.5s notes = 2.0s = 2 * 24000 * 2 = 96000 bytes
    expect(ffmpegCall?.pcmBytes).toBe(96000);
    expect(fs.existsSync(outPath)).toBe(true);

    expect(res.stdout).toContain('wrote ');
    expect(res.stdout).toContain('chirp3-hd');
    expect(res.stdout).toContain('extensions:\n  narrative_audio:');
    expect(res.stdout).toContain('    file: media/alden.mp3');
    expect(res.stdout).toContain('    duration_seconds: 2');
    expect(res.stdout).toContain('    editor_notes_start_seconds: 2');
  });

  it('synthesizes via Gemini TTS backend and transcribes audio to markdown', async () => {
    const tmp = await makeTempDir();
    const scriptPath = path.join(tmp, 'brief.txt');
    const outMp3 = path.join(tmp, 'brief.mp3');
    await writeFile(scriptPath, 'Clarissa Vance taught school in Illinois.');

    const rawPcm = Buffer.alloc(48000, 0x05); // 1.0s at 24kHz
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      expect(headers.get('x-goog-api-key')).toBe('gemini-secret-key');
      if (url.includes('gemini-3.8-flash-tts:generateContent')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;rate=24000',
                        data: rawPcm.toString('base64'),
                      },
                    },
                  ],
                },
              },
            ],
            usageMetadata: { totalTokenCount: 312 },
          }),
          { status: 200 }
        );
      }
      if (url.includes('gemini-4-hydrogen:generateContent')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: '[00:00] Clarissa Vance taught school in Illinois.' }],
                },
              },
            ],
          }),
          { status: 200 }
        );
      }
      return new Response('not found', { status: 404 });
    };

    const mockExec: ExecFileFn = async (file, args) => {
      expect(file).toBe('ffmpeg');
      fs.writeFileSync(args[args.length - 1], Buffer.from('ID3-gemini-mp3'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const synthRes = await invokeNarrativeAudio(
      ['synth', scriptPath, '--backend', 'gemini', '-o', outMp3],
      {
        env: { GEMINI_API_KEY: 'gemini-secret-key' },
        fetchImpl: mockFetch,
        execFileImpl: mockExec,
      }
    );
    expect(synthRes.exitCode, synthRes.stderr).toBe(0);
    expect(synthRes.stdout).toContain('gemini, 312 tokens');
    expect(synthRes.stdout).toContain('    file: media/brief.mp3');
    expect(synthRes.stdout).not.toContain('editor_notes_start_seconds');

    const transcribeRes = await invokeNarrativeAudio(['transcribe', outMp3], {
      env: { GOOGLE_API_KEY: 'gemini-secret-key' },
      fetchImpl: mockFetch,
    });
    expect(transcribeRes.exitCode, transcribeRes.stderr).toBe(0);
    expect(transcribeRes.stdout).toBe('[00:00] Clarissa Vance taught school in Illinois.');
    const transcriptFile = path.join(tmp, 'brief.transcript.md');
    expect(fs.existsSync(transcriptFile)).toBe(true);
    expect(fs.readFileSync(transcriptFile, 'utf8')).toBe(
      '[00:00] Clarissa Vance taught school in Illinois.'
    );
    expect(transcribeRes.stderr).toContain(`wrote ${transcriptFile}`);
  });
});
