import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliValidationError } from '../../../../errors.js';
import {
  type AudioExecFileFn,
  applyPhonemeTags,
  buildOpenAiSpeechPayload,
  computePronunciationCacheKey,
  DEFAULT_OPENAI_SPEECH_MODEL,
  defaultAudioExecFile,
  formatPhonemeTerm,
  ipaToArpabet,
  loadVoiceCloneReference,
  normalizePronunciationAudioWithFfmpeg,
  normalizeSpeechEndpointUrl,
  parsePhonemeMode,
  pronunciationAudioFilename,
  stripIpaSlashes,
  synthesizeOpenAiSpeech,
} from './index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'kinloom-audio-test-'): Promise<string> {
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

describe('phonemes and v2 cache key parity', () => {
  it('computes v2 SHA-256 cache key matching server pronunciationHelper byte-for-byte', () => {
    const expectedRaw =
      'v2|text:hendrik van der meer|phonetic:hen-drik vahn der meer|ipa:ˈɦɛn.drɪk|lang:nl|voice:charon';
    const expectedHash = createHash('sha256').update(expectedRaw, 'utf8').digest('hex');

    const computed = computePronunciationCacheKey({
      text: '  Hendrik van der Meer  ',
      phonetic: ' HEN-drik vahn der MEER ',
      ipa: ' /ˈɦɛn.drɪk/ ',
      language: ' NL ',
    });
    expect(computed).toBe(expectedHash);

    // IPA case sensitivity must produce a distinct hash (unlike text/phonetic/lang/voice)
    const upperIpaHash = computePronunciationCacheKey({
      text: 'Hendrik van der Meer',
      phonetic: 'hen-drik vahn der meer',
      ipa: '/ˈɦƐN.DRɪK/',
      language: 'nl',
      voice: 'CHARON',
    });
    expect(upperIpaHash).not.toBe(expectedHash);

    expect(
      pronunciationAudioFilename({
        text: 'Hendrik van der Meer',
        phonetic: 'HEN-drik vahn der MEER',
        ipa: '/ˈɦɛn.drɪk/',
        language: 'nl',
        ext: 'wav',
      })
    ).toBe(`pronunciation-${expectedHash.slice(0, 16)}.wav`);

    expect(
      pronunciationAudioFilename({
        text: 'Oakville',
        ext: 'mp3',
      })
    ).toMatch(/^pronunciation-[0-9a-f]{16}\.mp3$/);
  });

  it('parses phoneme modes and rejects invalid values at the boundary', () => {
    expect(parsePhonemeMode(undefined)).toBe('ipa');
    expect(parsePhonemeMode('', 'plain')).toBe('plain');
    expect(parsePhonemeMode('IPA')).toBe('ipa');
    expect(parsePhonemeMode('arpabet')).toBe('arpabet');
    expect(parsePhonemeMode('plain')).toBe('plain');
    expect(() => parsePhonemeMode('ssml')).toThrow(CliValidationError);
  });

  it('converts IPA to ARPAbet deterministically and formats phoneme tags for all modes', () => {
    expect(stripIpaSlashes(' //ˈoʊk.vɪl// ')).toBe('ˈoʊk.vɪl');
    expect(ipaToArpabet('/ˈoʊk.vɪl/')).toBe('OW1 K V IH0 L');
    expect(ipaToArpabet('/ˌtʃɑːrlz dʒeɪn/')).toBe('CH AA2 R L Z JH EY0 N');
    expect(ipaToArpabet('')).toBe('');
    expect(ipaToArpabet('/???/')).toBe('???');

    expect(formatPhonemeTerm({ text: 'Oakville', ipa: '/ˈoʊk.vɪl/', phonetic: 'OHK-vil' }, 'ipa')).toBe(
      '<|phoneme_start|>ˈoʊk.vɪl<|phoneme_end|>'
    );
    expect(
      formatPhonemeTerm({ text: 'Oakville', ipa: '/ˈoʊk.vɪl/', arpabet: 'OW1 K V IH0 L' }, 'arpabet')
    ).toBe('<|phoneme_start|>OW1 K V IH0 L<|phoneme_end|>');
    expect(formatPhonemeTerm({ text: 'Oakville', ipa: '/ˈoʊk.vɪl/' }, 'arpabet')).toBe(
      '<|phoneme_start|>OW1 K V IH0 L<|phoneme_end|>'
    );
    expect(formatPhonemeTerm({ text: 'Oakville', phonetic: 'OHK-vil' }, 'arpabet')).toBe('OHK-vil');
    expect(formatPhonemeTerm({ text: 'Oakville', phonetic: 'OHK-vil' }, 'ipa')).toBe('OHK-vil');
    expect(formatPhonemeTerm({ text: 'Oakville', ipa: '/ˈoʊk.vɪl/', phonetic: 'OHK-vil' }, 'plain')).toBe(
      'OHK-vil'
    );
    expect(formatPhonemeTerm({ text: 'Oakville', ipa: '/ˈoʊk.vɪl/' }, 'plain')).toBe('Oakville');
  });

  it('applies phoneme tags longest-first on whole words only', () => {
    const hints = {
      '': '/empty/',
      Meer: { text: 'Meer', ipa: '/meːr/', phonetic: 'MAIR' },
      'Hendrik van der Meer': '/ˈɦɛn.drɪk vɑn dɛr meːr/',
    };
    expect(applyPhonemeTags('Hendrik van der Meer met Meer in Meerville.', hints, 'ipa')).toBe(
      '<|phoneme_start|>ˈɦɛn.drɪk vɑn dɛr meːr<|phoneme_end|> met <|phoneme_start|>meːr<|phoneme_end|> in Meerville.'
    );
    expect(applyPhonemeTags('Hendrik van der Meer met Meer.', hints, 'plain')).toBe(
      'Hendrik van der MAIR met MAIR.'
    );
  });
});

describe('OpenAI-compatible speech client and ffmpeg normalizer', () => {
  it('normalizes speech endpoint URLs and rejects invalid protocols or empty values', () => {
    expect(normalizeSpeechEndpointUrl('http://127.0.0.1:8000')).toBe('http://127.0.0.1:8000/v1/audio/speech');
    expect(normalizeSpeechEndpointUrl('https://gpu.example.test/proxy/v1/')).toBe(
      'https://gpu.example.test/proxy/v1/audio/speech'
    );
    expect(normalizeSpeechEndpointUrl('https://gpu.example.test/v1/audio/speech/')).toBe(
      'https://gpu.example.test/v1/audio/speech'
    );
    expect(() => normalizeSpeechEndpointUrl('   ')).toThrow(CliValidationError);
    expect(() => normalizeSpeechEndpointUrl('not a url')).toThrow(CliValidationError);
    expect(() => normalizeSpeechEndpointUrl('ftp://gpu.example.test')).toThrow(CliValidationError);
  });

  it('loads voice clone references and rejects missing, empty, or textless references', async () => {
    const dir = await makeTempDir();
    const wavPath = path.join(dir, 'ref.wav');
    const emptyPath = path.join(dir, 'empty.wav');
    fs.writeFileSync(wavPath, Buffer.from('RIFFdemo'));
    fs.writeFileSync(emptyPath, Buffer.alloc(0));

    expect(loadVoiceCloneReference(wavPath, 'Hello Oakville.')).toEqual({
      audioBase64: Buffer.from('RIFFdemo').toString('base64'),
      text: 'Hello Oakville.',
    });
    expect(() => loadVoiceCloneReference(wavPath, '   ')).toThrow(CliValidationError);
    expect(() => loadVoiceCloneReference(path.join(dir, 'missing.wav'), 'Hi')).toThrow(CliValidationError);
    expect(() => loadVoiceCloneReference(emptyPath, 'Hi')).toThrow(CliValidationError);
  });

  it('builds OpenAI speech payloads strictly without seed, retries 429/503/network errors, and sends auth + references', async () => {
    const built = buildOpenAiSpeechPayload({
      model: DEFAULT_OPENAI_SPEECH_MODEL,
      input: 'Jane Doe lived in Oakville.',
      voice: 'Charon',
      speed: 1.05,
      references: [{ audioBase64: 'QUJD', text: 'Reference transcript.' }],
    });
    expect(built).toEqual({
      model: 'fishaudio/drama-3',
      input: 'Jane Doe lived in Oakville.',
      voice: 'Charon',
      response_format: 'wav',
      speed: 1.05,
      references: [{ audio: 'QUJD', text: 'Reference transcript.' }],
    });
    expect('seed' in built).toBe(false);

    const sleepCalls: number[] = [];
    let attempt = 0;
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth: string | null = null;

    const mockFetch = vi.fn<typeof fetch>(async (_input, init) => {
      attempt += 1;
      capturedAuth = new Headers(init?.headers).get('authorization');
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (attempt === 1) {
        return new Response('rate limit', { status: 429, headers: { 'retry-after': '1' } });
      }
      if (attempt === 2) {
        throw new Error('ECONNRESET');
      }
      return new Response(Buffer.from('RIFF-ok-audio'), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    });

    const res = await synthesizeOpenAiSpeech({
      endpoint: 'http://127.0.0.1:8000',
      model: DEFAULT_OPENAI_SPEECH_MODEL,
      input: '<|phoneme_start|>ˈoʊk.vɪl<|phoneme_end|>',
      voice: 'Charon',
      apiKey: 'secret-token',
      references: [{ audioBase64: 'QUJD', text: 'Ref' }],
      baseRetryDelayMs: 50,
      fetchImpl: mockFetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(res.bytes.toString('utf8')).toBe('RIFF-ok-audio');
    expect(res.contentType).toBe('audio/wav');
    expect(capturedAuth).toBe('Bearer secret-token');
    expect('seed' in capturedBody).toBe(false);
    expect(sleepCalls).toEqual([1000, 100]);

    // Non-retryable HTTP 400 fails immediately without retrying
    const failFetch = vi.fn<typeof fetch>(async () => new Response('bad request', { status: 400 }));
    await expect(
      synthesizeOpenAiSpeech({
        endpoint: 'http://127.0.0.1:8000',
        model: DEFAULT_OPENAI_SPEECH_MODEL,
        input: 'Test',
        voice: 'Charon',
        fetchImpl: failFetch,
        sleepFn: async () => {},
      })
    ).rejects.toThrow('openai-speech HTTP 400: bad request');
    expect(failFetch).toHaveBeenCalledTimes(1);

    // Empty body throws
    const emptyFetch = vi.fn<typeof fetch>(async () => new Response(new Uint8Array(0), { status: 200 }));
    await expect(
      synthesizeOpenAiSpeech({
        endpoint: 'http://127.0.0.1:8000',
        model: DEFAULT_OPENAI_SPEECH_MODEL,
        input: 'Test',
        voice: 'Charon',
        retries: 0,
        fetchImpl: emptyFetch,
        sleepFn: async () => {},
      })
    ).rejects.toThrow('openai-speech returned an empty audio body');
  });

  it('normalizes pronunciation audio with ffmpeg for wav and mp3 and surfaces missing ffmpeg cleanly', async () => {
    const dir = await makeTempDir();
    const outWav = path.join(dir, 'media', 'clip.wav');
    const outMp3 = path.join(dir, 'media', 'clip.mp3');
    const recordedCalls: Array<{ file: string; args: readonly string[] }> = [];

    const mockExec: AudioExecFileFn = async (file, args) => {
      recordedCalls.push({ file, args });
      const target = args[args.length - 1]!;
      fs.writeFileSync(target, Buffer.from('NORMALIZED-AUDIO'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const wavRes = await normalizePronunciationAudioWithFfmpeg({
      inputBytes: Buffer.from('RAW-WAV'),
      outPath: outWav,
      format: 'wav',
      execFileImpl: mockExec,
    });
    expect(wavRes.sizeBytes).toBe(16);
    expect(recordedCalls[0]?.args).toContain('pcm_s16le');
    expect(recordedCalls[0]?.args).toContain(
      'silenceremove=start_periods=1:start_silence=0.08:start_threshold=-45dB,loudnorm=I=-16:TP=-1.5:LRA=11'
    );

    const mp3Res = await normalizePronunciationAudioWithFfmpeg({
      inputBytes: Buffer.from('RAW-WAV'),
      outPath: outMp3,
      format: 'mp3',
      bitrate: '128k',
      trimSilence: false,
      execFileImpl: mockExec,
    });
    expect(mp3Res.sizeBytes).toBe(16);
    expect(recordedCalls[1]?.args).toContain('128k');
    expect(recordedCalls[1]?.args).toContain('loudnorm=I=-16:TP=-1.5:LRA=11');

    const enoentExec: AudioExecFileFn = async () => {
      const err = new Error('spawn ffmpeg ENOENT') as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    };
    await expect(
      normalizePronunciationAudioWithFfmpeg({
        inputBytes: Buffer.from('RAW'),
        outPath: outWav,
        format: 'wav',
        execFileImpl: enoentExec,
      })
    ).rejects.toThrow('ffmpeg not found on PATH');

    const genericExec: AudioExecFileFn = async () => {
      throw new Error('ffmpeg codec failure');
    };
    await expect(
      normalizePronunciationAudioWithFfmpeg({
        inputBytes: Buffer.from('RAW'),
        outPath: outWav,
        format: 'wav',
        execFileImpl: genericExec,
      })
    ).rejects.toThrow('ffmpeg codec failure');
  });

  it('executes subprocesses via defaultAudioExecFile and retries 503 with default sleep', async () => {
    const okOut = await defaultAudioExecFile(process.execPath, ['-e', 'process.stdout.write("audio-ok")']);
    expect(okOut.stdout.toString('utf8')).toBe('audio-ok');

    const stdinOut = await defaultAudioExecFile(
      process.execPath,
      [
        '-e',
        'const chunks=[];process.stdin.on("data",c=>chunks.push(c));process.stdin.on("end",()=>process.stdout.write(Buffer.concat(chunks)));',
      ],
      { input: Buffer.from('piped-audio-bytes') }
    );
    expect(stdinOut.stdout.toString('utf8')).toBe('piped-audio-bytes');

    await expect(
      defaultAudioExecFile(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(1)'])
    ).rejects.toMatchObject({
      stderr: Buffer.from('boom'),
    });

    let calls = 0;
    const retryFetch = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('retry', { status: 503, headers: { 'retry-after': 'not-a-number' } });
      }
      return new Response(Buffer.from('MP3-DATA'), { status: 200 });
    });
    const res = await synthesizeOpenAiSpeech({
      endpoint: 'http://127.0.0.1:8000',
      model: DEFAULT_OPENAI_SPEECH_MODEL,
      input: 'Oakville',
      voice: 'Charon',
      responseFormat: 'mp3',
      baseRetryDelayMs: 1,
      fetchImpl: retryFetch,
    });
    expect(res.bytes.toString('utf8')).toBe('MP3-DATA');
    expect(res.contentType).toBe('audio/mpeg');
    expect(calls).toBe(2);
  });
});
