import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureDemoFramesForStep } from './captureDemoFrames.ts';
import { loadArchivalVideoPalette } from './remotion/tokens.ts';
import { checkScriptLeakHygiene, type TutorialScript, TutorialScriptSchema } from './schema.ts';
import {
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiTutorialTtsProvider,
} from './tts/geminiTts.ts';
import { OpenAiSpeechTutorialTtsProvider } from './tts/openAiSpeechTts.ts';
import { CachedTutorialTtsProvider, type TutorialTtsProvider } from './tts/provider.ts';
import { SilentMockTutorialTtsProvider } from './tts/silentMockTts.ts';
import {
  buildWebVtt,
  computeStepDurationFrames,
  concatenateCueWavs,
  validateWebVttMonotonicity,
} from './vtt.ts';

export type TtsBackendOption = 'gemini' | 'openai-speech' | 'silent';
export type VideoFormatOption = 'mp4' | 'webm' | 'both';

export interface RenderTutorialsCliOptions {
  readonly dryRun: boolean;
  readonly chapterFilter?: string;
  readonly tts: TtsBackendOption;
  readonly format: VideoFormatOption;
  readonly outDir: string;
  readonly cacheDir: string;
  readonly scriptsDir: string;
  readonly demoUrl: string;
  readonly skipCapture: boolean;
  readonly coreChaptersSourcePath: string;
}

export interface RenderedManifestStep {
  readonly videoMp4Url?: string;
  readonly videoWebmUrl?: string;
  readonly posterUrl: string;
  readonly posterAlt: string;
  readonly captionsVttUrl: string;
  readonly durationSeconds: number;
}

export interface RenderedTutorialManifest {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly ttsModel: string;
  readonly voice: string;
  readonly chapters: Readonly<
    Record<
      string,
      {
        readonly durationSeconds: number;
        readonly steps: Readonly<Record<string, RenderedManifestStep>>;
      }
    >
  >;
}

export interface RenderTutorialsSummary {
  readonly dryRun: boolean;
  readonly scriptCount: number;
  readonly stepCount: number;
  readonly cueCount: number;
  readonly cacheHits: number;
  readonly manifest: RenderedTutorialManifest;
}

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(TOOL_ROOT, '../..');

export function parseCliArgs(argv: readonly string[]): RenderTutorialsCliOptions {
  let dryRun = false;
  let chapterFilter: string | undefined;
  let tts: TtsBackendOption | undefined;
  let format: VideoFormatOption = 'mp4';
  let outDir = path.join(TOOL_ROOT, 'out');
  let cacheDir = path.join(TOOL_ROOT, '.cache');
  let scriptsDir = path.join(TOOL_ROOT, 'scripts');
  let demoUrl = 'http://127.0.0.1:4173';
  let skipCapture = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--skip-capture') {
      skipCapture = true;
    } else if (arg === '--chapter' && argv[i + 1]) {
      chapterFilter = argv[++i];
    } else if (arg === '--tts' && argv[i + 1]) {
      const value = argv[++i];
      if (value !== 'gemini' && value !== 'openai-speech' && value !== 'silent') {
        throw new RangeError(`Unsupported --tts backend '${value}'. Expected gemini | openai-speech | silent.`);
      }
      tts = value;
    } else if (arg === '--format' && argv[i + 1]) {
      const value = argv[++i];
      if (value !== 'mp4' && value !== 'webm' && value !== 'both') {
        throw new RangeError(`Unsupported --format '${value}'. Expected mp4 | webm | both.`);
      }
      format = value;
    } else if (arg === '--out-dir') {
      const next = argv[++i];
      if (next) outDir = path.resolve(next);
    } else if (arg === '--cache-dir') {
      const next = argv[++i];
      if (next) cacheDir = path.resolve(next);
    } else if (arg === '--scripts-dir') {
      const next = argv[++i];
      if (next) scriptsDir = path.resolve(next);
    } else if (arg === '--demo-url') {
      const next = argv[++i];
      if (next) demoUrl = next;
    }
  }

  const resolvedTts: TtsBackendOption =
    tts ?? (dryRun ? 'silent' : process.env['GEMINI_API_KEY'] ? 'gemini' : 'silent');

  return {
    dryRun,
    ...(chapterFilter !== undefined ? { chapterFilter } : {}),
    tts: resolvedTts,
    format,
    outDir,
    cacheDir,
    scriptsDir,
    demoUrl,
    skipCapture: skipCapture || dryRun,
    coreChaptersSourcePath: path.join(REPO_ROOT, 'packages/ui/src/lib/coreTutorialChapters.ts'),
  };
}

/**
 * Extracts core chapter IDs and their ordered step IDs from `packages/ui/src/lib/coreTutorialChapters.ts`
 * so `npm run tutorials:verify` guarantees 1:1 parity without requiring a workspace build first.
 */
export function extractCoreChapterStepMap(sourceText: string): ReadonlyMap<string, readonly string[]> {
  const map = new Map<string, string[]>();
  const chapterSplit = sourceText.split('KinloomTutorialChapterSchema.parse(').slice(1);
  for (const block of chapterSplit) {
    const chapterMatch = /\bid:\s*'([^']+)'/.exec(block);
    if (!chapterMatch) {
      continue;
    }
    const chapterId = chapterMatch[1];
    if (!chapterId) {
      continue;
    }
    const stepsIdx = block.indexOf('steps:');
    if (stepsIdx === -1) {
      continue;
    }
    const stepsBlock = block.slice(stepsIdx);
    const stepIds: string[] = [];
    const stepIdRe = /\bid:\s*'([^']+)'/g;
    let m: RegExpExecArray | null;
    while ((m = stepIdRe.exec(stepsBlock)) !== null) {
      if (m[1]) {
        stepIds.push(m[1]);
      }
    }
    map.set(chapterId, stepIds);
  }
  return map;
}

export function loadTutorialScripts(scriptsDir: string, chapterFilter?: string): readonly TutorialScript[] {
  if (!fs.existsSync(scriptsDir)) {
    throw new Error(`Tutorial scripts directory not found: ${scriptsDir}`);
  }
  const files = fs
    .readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.script.json'))
    .toSorted((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No *.script.json files found in ${scriptsDir}.`);
  }

  const leakFindings: string[] = [];
  const scripts: TutorialScript[] = [];

  for (const fileName of files) {
    const absPath = path.join(scriptsDir, fileName);
    const rawText = fs.readFileSync(absPath, 'utf8');
    leakFindings.push(...checkScriptLeakHygiene(rawText, fileName));
    const parsedJson: unknown = JSON.parse(rawText);
    const script = TutorialScriptSchema.parse(parsedJson);
    if (!chapterFilter || script.chapterId === chapterFilter) {
      scripts.push(script);
    }
  }

  if (leakFindings.length > 0) {
    throw new Error(`Privacy leak check failed in tutorial scripts:\n${leakFindings.join('\n')}`);
  }

  if (chapterFilter && scripts.length === 0) {
    throw new RangeError(`No tutorial script matched --chapter '${chapterFilter}'.`);
  }

  return scripts;
}

export function verifyCoreScriptParity(
  scripts: readonly TutorialScript[],
  coreChaptersSourcePath: string,
  requireAllCoreChapters: boolean
): void {
  const sourceText = fs.readFileSync(coreChaptersSourcePath, 'utf8');
  const coreMap = extractCoreChapterStepMap(sourceText);
  const scriptByChapter = new Map(scripts.map((s) => [s.chapterId, s]));

  if (requireAllCoreChapters) {
    for (const [coreChapterId] of coreMap) {
      if (!scriptByChapter.has(coreChapterId)) {
        throw new Error(`Missing tutorial script for core chapter '${coreChapterId}'.`);
      }
    }
  }

  for (const script of scripts) {
    const expectedSteps = coreMap.get(script.chapterId);
    if (!expectedSteps) {
      throw new Error(`Tutorial script '${script.chapterId}' does not match any core chapter in coreTutorialChapters.ts.`);
    }
    const actualSteps = script.steps.map((s) => s.stepId);
    if (
      expectedSteps.length !== actualSteps.length ||
      expectedSteps.some((stepId, idx) => stepId !== actualSteps[idx])
    ) {
      throw new Error(
        `Step parity mismatch for '${script.chapterId}': expected [${expectedSteps.join(', ')}], got [${actualSteps.join(', ')}].`
      );
    }
  }
}

export function createTtsProvider(backend: TtsBackendOption): TutorialTtsProvider {
  if (backend === 'silent') {
    return new SilentMockTutorialTtsProvider();
  }
  if (backend === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'] ?? '';
    return new GeminiTutorialTtsProvider({
      apiKey,
      model: process.env['KINLOOM_TUTORIAL_TTS_MODEL'] ?? DEFAULT_GEMINI_TTS_MODEL,
    });
  }
  const endpointUrl = process.env['KINLOOM_OPENAI_TTS_URL'] ?? 'http://127.0.0.1:8000/v1/audio/speech';
  return new OpenAiSpeechTutorialTtsProvider({
    endpointUrl,
    apiKey: process.env['KINLOOM_OPENAI_TTS_API_KEY'],
  });
}

export async function runTutorialsPipeline(
  options: RenderTutorialsCliOptions,
  providerOverride?: TutorialTtsProvider
): Promise<RenderTutorialsSummary> {
  const scripts = loadTutorialScripts(options.scriptsDir, options.chapterFilter);
  verifyCoreScriptParity(scripts, options.coreChaptersSourcePath, !options.chapterFilter);

  const innerProvider = providerOverride ?? createTtsProvider(options.tts);
  const cachedTts = new CachedTutorialTtsProvider(innerProvider, path.join(options.cacheDir, 'tutorial-tts'));

  const chaptersOut: Record<
    string,
    { durationSeconds: number; steps: Record<string, RenderedManifestStep> }
  > = {};

  let totalSteps = 0;
  let totalCues = 0;
  let cacheHits = 0;

  let serveUrl: string | undefined;
  let remotionRenderer: typeof import('@remotion/renderer') | undefined;

  if (!options.dryRun) {
    const bundler = await import('@remotion/bundler');
    remotionRenderer = await import('@remotion/renderer');
    const entryPoint = path.join(TOOL_ROOT, 'src/remotion/Root.tsx');
    serveUrl = await bundler.bundle({ entryPoint });
  }

  for (const script of scripts) {
    const chapterOutDir = path.join(options.outDir, script.chapterId);
    if (!options.dryRun) {
      fs.mkdirSync(chapterOutDir, { recursive: true });
    }

    let chapterDurationSeconds = 0;
    const stepsOut: Record<string, RenderedManifestStep> = {};

    for (const [stepIdx, step] of script.steps.entries()) {
      totalSteps += 1;

      const capturedFrames = await captureDemoFramesForStep({
        script,
        step,
        demoUrl: options.demoUrl,
        cacheDir: path.join(options.cacheDir, 'tutorial-frames'),
        dryRun: options.skipCapture,
      });

      const cueAudioSegments: { text: string; wav: Buffer; pauseAfterSeconds: number }[] = [];
      for (const cue of step.cues) {
        totalCues += 1;
        const synth = await cachedTts.synthesize({
          text: cue.text,
          voice: cue.voice ?? script.voice,
          style: script.style,
        });
        if (synth.cacheHit) {
          cacheHits += 1;
        }
        cueAudioSegments.push({
          text: cue.text,
          wav: synth.wav,
          pauseAfterSeconds: cue.pauseAfterSeconds,
        });
      }

      const stepAudio = concatenateCueWavs(cueAudioSegments);
      const vttContent = buildWebVtt(stepAudio.cues);
      const vttValidation = validateWebVttMonotonicity(vttContent);
      if (!vttValidation.ok) {
        throw new Error(
          `WebVTT monotonicity failed for ${script.chapterId}/${step.stepId}: ${vttValidation.errors.join('; ')}`
        );
      }

      const durationInFrames = computeStepDurationFrames(stepAudio.durationSeconds, script.fps);
      const wholeDurationSec = Math.max(1, Math.round(stepAudio.durationSeconds));
      chapterDurationSeconds += wholeDurationSec;

      const relPrefix = `/tutorials/${script.chapterId}/${step.stepId}`;
      const vttPath = path.join(chapterOutDir, `${step.stepId}.vtt`);
      const wavPath = path.join(chapterOutDir, `${step.stepId}.wav`);
      const mp4Path = path.join(chapterOutDir, `${step.stepId}.mp4`);
      const webmPath = path.join(chapterOutDir, `${step.stepId}.webm`);
      const posterPath = path.join(chapterOutDir, `${step.stepId}.png`);

      if (!options.dryRun && serveUrl && remotionRenderer) {
        fs.writeFileSync(vttPath, vttContent, 'utf8');
        fs.writeFileSync(wavPath, stepAudio.wav);

        const palette = loadArchivalVideoPalette(step.theme);
        const inputProps = {
          chapterId: script.chapterId,
          chapterTitle: script.title,
          stepId: step.stepId,
          stepTitle: step.title,
          stepNumber: stepIdx + 1,
          totalSteps: script.steps.length,
          frameUrls: capturedFrames.map((f) => pathToFileURL(f.filePath).href),
          audioUrl: pathToFileURL(wavPath).href,
          callout: step.callout,
          cues: stepAudio.cues,
          durationInFrames,
          fps: script.fps,
          width: script.width,
          height: script.height,
          palette,
        };

        const composition = await remotionRenderer.selectComposition({
          serveUrl,
          id: 'TutorialStep',
          inputProps,
        });

        if (options.format === 'mp4' || options.format === 'both') {
          await remotionRenderer.renderMedia({
            composition,
            serveUrl,
            codec: 'h264',
            crf: 26,
            pixelFormat: 'yuv420p',
            audioCodec: 'aac',
            audioBitrate: '96k',
            outputLocation: mp4Path,
            inputProps,
            ffmpegOverride: ({ args }) => [...args.slice(0, -1), '-movflags', '+faststart', args.at(-1) ?? mp4Path],
          });
        }

        if (options.format === 'webm' || options.format === 'both') {
          await remotionRenderer.renderMedia({
            composition,
            serveUrl,
            codec: 'vp9',
            crf: 32,
            audioCodec: 'opus',
            audioBitrate: '64k',
            outputLocation: webmPath,
            inputProps,
          });
        }

        await remotionRenderer.renderStill({
          composition,
          serveUrl,
          output: posterPath,
          imageFormat: 'png',
          frame: Math.min(15, Math.max(0, durationInFrames - 1)),
          inputProps,
        });
      }

      stepsOut[step.stepId] = {
        ...(options.format === 'mp4' || options.format === 'both' ? { videoMp4Url: `${relPrefix}.mp4` } : {}),
        ...(options.format === 'webm' || options.format === 'both' ? { videoWebmUrl: `${relPrefix}.webm` } : {}),
        posterUrl: `${relPrefix}.png`,
        posterAlt: step.posterAlt,
        captionsVttUrl: `${relPrefix}.vtt`,
        durationSeconds: wholeDurationSec,
      };
    }

    chaptersOut[script.chapterId] = {
      durationSeconds: Math.max(1, chapterDurationSeconds),
      steps: stepsOut,
    };
  }

  const manifest: RenderedTutorialManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ttsModel: innerProvider.modelName,
    voice: scripts[0]?.voice ?? DEFAULT_GEMINI_TTS_VOICE,
    chapters: chaptersOut,
  };

  if (!options.dryRun) {
    fs.mkdirSync(options.outDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.outDir, 'tutorial-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8'
    );
  }

  return {
    dryRun: options.dryRun,
    scriptCount: scripts.length,
    stepCount: totalSteps,
    cueCount: totalCues,
    cacheHits,
    manifest,
  };
}

const isMain =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const options = parseCliArgs(process.argv.slice(2));
  runTutorialsPipeline(options)
    .then((summary) => {
      const mode = summary.dryRun ? 'dry-run verified' : 'rendered';
      console.log(
        `Tutorials pipeline ${mode}: ${summary.scriptCount} chapters, ${summary.stepCount} steps, ${summary.cueCount} cues (${summary.cacheHits} TTS cache hits, model=${summary.manifest.ttsModel}).`
      );
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
