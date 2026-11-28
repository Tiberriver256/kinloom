import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TutorialMediaManifestSchema } from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORE_TUTORIAL_CHAPTERS } from '../../../packages/ui/src/lib/coreTutorialChapters.js';
import { captureDemoFramesForStep, resolveCaptureRouteUrl } from './captureDemoFrames.ts';
import { loadArchivalVideoPalette } from './remotion/tokens.ts';
import {
  extractCoreChapterStepMap,
  loadTutorialScripts,
  parseCliArgs,
  runTutorialsPipeline,
  verifyCoreScriptParity,
} from './renderTutorials.ts';
import { checkScriptLeakHygiene } from './schema.ts';
import { DEFAULT_GEMINI_TTS_MODEL, GeminiTutorialTtsProvider } from './tts/geminiTts.ts';
import { OpenAiSpeechTutorialTtsProvider } from './tts/openAiSpeechTts.ts';
import { CachedTutorialTtsProvider, computeTtsCacheKey } from './tts/provider.ts';
import { estimateSilentCueDurationSeconds, SilentMockTutorialTtsProvider } from './tts/silentMockTts.ts';
import {
  buildWebVtt,
  computeStepDurationFrames,
  concatenateCueWavs,
  DEFAULT_SAMPLE_RATE,
  extractWavPcm,
  formatVttTimestamp,
  measureWavDurationSeconds,
  validateWebVttMonotonicity,
  wrapPcmAsWav,
} from './vtt.ts';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(TOOL_ROOT, '../..');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('tools/tutorials-video isolated Remotion + Gemini TTS pipeline', () => {
  it('enforces strict MIT licensing isolation: zero Remotion dependencies in any @kinloom/* package', () => {
    const packagesDir = path.join(REPO_ROOT, 'packages');
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
      if (!fs.existsSync(pkgJsonPath)) {
        continue;
      }
      const pkgText = fs.readFileSync(pkgJsonPath, 'utf8');
      expect(pkgText).not.toMatch(/remotion/i);
    }

    const toolPkg = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8')) as {
      private: boolean;
    };
    expect(toolPkg.private).toBe(true);
    expect(fs.existsSync(path.join(TOOL_ROOT, 'LICENSE-NOTICE.md'))).toBe(true);
  });

  it('keeps 1:1 chapterId and stepId parity between all 6 scripts and coreTutorialChapters.ts with zero leaks', () => {
    const scripts = loadTutorialScripts(path.join(TOOL_ROOT, 'scripts'));
    expect(scripts).toHaveLength(6);

    const coreStepMap = new Map(
      CORE_TUTORIAL_CHAPTERS.map((chapter) => [chapter.id, chapter.steps.map((s) => s.id)])
    );
    expect(scripts.map((s) => s.chapterId).toSorted()).toEqual([...coreStepMap.keys()].toSorted());

    for (const script of scripts) {
      expect(script.steps.map((s) => s.stepId)).toEqual(coreStepMap.get(script.chapterId));
    }

    const coreSourcePath = path.join(REPO_ROOT, 'packages/ui/src/lib/coreTutorialChapters.ts');
    const extracted = extractCoreChapterStepMap(fs.readFileSync(coreSourcePath, 'utf8'));
    expect(extracted.size).toBe(6);
    expect(() => verifyCoreScriptParity(scripts, coreSourcePath, true)).not.toThrow();

    const forbiddenFixture = JSON.stringify({ email: ['synthetic', 'gmail.com'].join('@') });
    expect(checkScriptLeakHygiene(forbiddenFixture, 'test.json')).toHaveLength(1);
    expect(checkScriptLeakHygiene('{"email":"editor@archive.example.test"}', 'test.json')).toHaveLength(0);
  });

  it('measures exact WAV durations, builds monotonic WebVTT captions, and computes frame counts', () => {
    const oneSecPcm = Buffer.alloc(DEFAULT_SAMPLE_RATE * 2);
    const twoSecPcm = Buffer.alloc(DEFAULT_SAMPLE_RATE * 2 * 2);
    const wav1 = wrapPcmAsWav(oneSecPcm, DEFAULT_SAMPLE_RATE);
    const wav2 = wrapPcmAsWav(twoSecPcm, DEFAULT_SAMPLE_RATE);

    expect(measureWavDurationSeconds(wav1)).toBe(1);
    expect(extractWavPcm(wav2).durationSeconds).toBe(2);

    const combined = concatenateCueWavs([
      { text: 'First narration line.', wav: wav1, pauseAfterSeconds: 0.5 },
      { text: 'Second narration line.', wav: wav2, pauseAfterSeconds: 0.25 },
    ]);

    expect(combined.durationSeconds).toBeCloseTo(3.75, 4);
    expect(combined.cues).toEqual([
      { startSeconds: 0, endSeconds: 1, text: 'First narration line.' },
      { startSeconds: 1.5, endSeconds: 3.5, text: 'Second narration line.' },
    ]);

    const vtt = buildWebVtt(combined.cues);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000');
    expect(vtt).toContain('00:00:01.500 --> 00:00:03.500');
    expect(validateWebVttMonotonicity(vtt)).toEqual({ ok: true, cueCount: 2, errors: [] });
    expect(validateWebVttMonotonicity('NOT_VTT').ok).toBe(false);
    expect(formatVttTimestamp(3661.25)).toBe('01:01:01.250');
    expect(computeStepDurationFrames(combined.durationSeconds, 30)).toBe(113);
  });

  it('synthesizes via mocked Gemini TTS (gemini-3.8-flash-tts) with retry and SHA-256 disk caching', async () => {
    const pcmBytes = Buffer.alloc(DEFAULT_SAMPLE_RATE * 2); // 1 second of PCM
    let callCount = 0;
    const sleepCalls: number[] = [];

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      expect(String(input)).toContain(`${DEFAULT_GEMINI_TTS_MODEL}:generateContent`);
      expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe('synthetic-test-key');

      if (callCount === 1) {
        return new Response('rate limited', { status: 429 });
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;codec=pcm;rate=24000',
                      data: pcmBytes.toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const gemini = new GeminiTutorialTtsProvider({
      apiKey: 'synthetic-test-key',
      fetchImpl: mockFetch as typeof fetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const cacheDir = makeTempDir('kinloom-tts-cache-');
    const cached = new CachedTutorialTtsProvider(gemini, cacheDir);

    const first = await cached.synthesize({
      text: '  Open   Family Tree in the top bar. ',
      voice: 'Charon',
      style: 'Warm archival narrator',
    });
    expect(first.cacheHit).toBe(false);
    expect(first.durationSeconds).toBe(1);
    expect(callCount).toBe(2);
    expect(sleepCalls).toEqual([1000]);

    // Second identical call (with normalized whitespace) hits deterministic SHA-256 disk cache
    const second = await cached.synthesize({
      text: 'Open Family Tree in the top bar.',
      voice: 'Charon',
      style: 'Warm archival narrator',
    });
    expect(second.cacheHit).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(callCount).toBe(2);

    expect(
      computeTtsCacheKey({
        provider: 'gemini',
        model: DEFAULT_GEMINI_TTS_MODEL,
        voice: 'Charon',
        style: 'Warm archival narrator',
        text: 'Open Family Tree in the top bar.',
      })
    ).toBe(first.cacheKey);
  });

  it('supports mocked OpenAI-compatible speech TTS and silent deterministic mock TTS', async () => {
    const wavBytes = wrapPcmAsWav(Buffer.alloc(DEFAULT_SAMPLE_RATE * 2), DEFAULT_SAMPLE_RATE);
    const mockFetch = vi.fn(async () => new Response(new Uint8Array(wavBytes), { status: 200 }));
    const openAi = new OpenAiSpeechTutorialTtsProvider({
      endpointUrl: 'http://127.0.0.1:8000/v1/audio/speech',
      apiKey: 'local-token',
      fetchImpl: mockFetch as typeof fetch,
    });
    const res = await openAi.synthesize({ text: 'Hello archive', voice: 'alloy', style: 'calm' });
    expect(measureWavDurationSeconds(res.wav)).toBe(1);

    const silent = new SilentMockTutorialTtsProvider();
    expect(estimateSilentCueDurationSeconds('short text')).toBe(2);
    const silentRes = await silent.synthesize({
      text: 'one two three four five six seven eight nine ten',
      voice: 'Charon',
      style: 'calm',
    });
    expect(measureWavDurationSeconds(silentRes.wav)).toBe(4);
  });

  it('runs full --dry-run --tts silent verification pipeline, validates TutorialMediaManifestSchema, and loads Paper & Ink tokens', async () => {
    const cacheDir = makeTempDir('kinloom-pipeline-cache-');
    const outDir = makeTempDir('kinloom-pipeline-out-');
    const options = parseCliArgs([
      '--dry-run',
      '--tts',
      'silent',
      '--format',
      'both',
      '--cache-dir',
      cacheDir,
      '--out-dir',
      outDir,
    ]);

    const summary = await runTutorialsPipeline(options);
    expect(summary.dryRun).toBe(true);
    expect(summary.scriptCount).toBe(6);
    expect(summary.stepCount).toBe(15);
    expect(summary.cueCount).toBe(30);

    // Second run with same cache directory hits cache on every cue
    const secondRun = await runTutorialsPipeline(options);
    expect(secondRun.cacheHits).toBe(30);

    // Output manifest validates cleanly against @kinloom/core TutorialMediaManifestSchema
    const validatedManifest = TutorialMediaManifestSchema.parse(summary.manifest);
    expect(Object.keys(validatedManifest.chapters)).toHaveLength(6);
    expect(
      validatedManifest.chapters['core-tree-pedigree']?.steps['tree-chart-and-list']?.videoWebmUrl
    ).toBe('/tutorials/core-tree-pedigree/tree-chart-and-list.webm');

    // Tokens & dry-run capture helper
    const lightPalette = loadArchivalVideoPalette('light');
    const darkPalette = loadArchivalVideoPalette('dark');
    expect(lightPalette.surfaceCanvas).toBe('#F5EFE2');
    expect(darkPalette.surfaceCanvas).toBe('#171614');
    expect(resolveCaptureRouteUrl('http://127.0.0.1:4173/', '/tree')).toBe('http://127.0.0.1:4173/tree');

    const scripts = loadTutorialScripts(path.join(TOOL_ROOT, 'scripts'), 'core-tree-pedigree');
    const firstScript = scripts[0];
    const firstStep = firstScript?.steps[0];
    if (!firstScript || !firstStep) {
      throw new Error('Expected core-tree-pedigree script with at least one step');
    }
    const dryFrames = await captureDemoFramesForStep({
      script: firstScript,
      step: firstStep,
      demoUrl: 'http://127.0.0.1:4173',
      cacheDir,
      dryRun: true,
    });
    expect(dryFrames).toHaveLength(2);
    expect(dryFrames[0]?.name).toBe('tree-chart');
  });
});
