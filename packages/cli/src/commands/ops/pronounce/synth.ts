import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  type AudioExecFileFn,
  DEFAULT_OPENAI_SPEECH_MODEL,
  loadVoiceCloneReference,
  normalizePronunciationAudioWithFfmpeg,
  normalizeSpeechEndpointUrl,
  type PhonemeMode,
  parsePhonemeMode,
  synthesizeOpenAiSpeech,
  type VoiceCloneReference,
} from '../shared/audio/index.js';
import {
  applyPronunciationAudioUpdates,
  buildSynthResult,
  DEFAULT_PRONOUNCE_GEMINI_MODEL,
  type PronounceBatchManifest,
  type PronounceSynthBackend,
  type PronounceSynthItemResult,
  type PronounceSynthResult,
  synthesizeTargetWithGemini,
  wrapPcmAsWav,
} from './synthHelpers.js';
import {
  collectPronounceSynthTargets,
  type PronounceAudioFormat,
  type PronounceSynthScope,
} from './synthTargets.js';

export {
  DEFAULT_PRONOUNCE_GEMINI_MODEL,
  type PronounceBatchManifest,
  type PronounceSynthBackend,
  type PronounceSynthItemResult,
  type PronounceSynthResult,
  wrapPcmAsWav,
};

export interface PronounceSynthOptions {
  readonly repoDir?: string;
  readonly backend?: PronounceSynthBackend;
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly voice?: string;
  readonly phonemeMode?: PhonemeMode;
  readonly refAudioPath?: string;
  readonly refText?: string;
  readonly outDir?: string;
  readonly format?: PronounceAudioFormat;
  readonly scope?: PronounceSynthScope;
  readonly skipExisting?: boolean;
  readonly force?: boolean;
  readonly updateConfig?: boolean;
  readonly exportManifestPath?: string;
  readonly importDir?: string;
  readonly concurrency?: number;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly execFileImpl?: AudioExecFileFn;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly nowIso?: () => string;
}

async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));

  const runWorker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await worker(items[idx]);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export async function runPronounceSynthCommand(
  options: PronounceSynthOptions
): Promise<PronounceSynthResult> {
  const env = options.env ?? process.env;
  const backend: PronounceSynthBackend = options.backend ?? 'gemini';
  if (backend !== 'gemini' && backend !== 'openai-speech') {
    throw new CliValidationError(`Invalid --backend '${backend}': choose from gemini, openai-speech.`);
  }

  const scope: PronounceSynthScope = options.scope ?? 'curated';
  if (scope !== 'lexicon' && scope !== 'curated' && scope !== 'all') {
    throw new CliValidationError(`Invalid --scope '${scope}': choose from lexicon, curated, all.`);
  }

  const format: PronounceAudioFormat = options.format ?? 'wav';
  if (format !== 'wav' && format !== 'mp3') {
    throw new CliValidationError(`Invalid --format '${format}': choose from wav, mp3.`);
  }

  const phonemeMode = parsePhonemeMode(options.phonemeMode, 'ipa');
  const voice = options.voice?.trim() || 'Charon';
  const model =
    options.model?.trim() ||
    (backend === 'openai-speech' ? DEFAULT_OPENAI_SPEECH_MODEL : DEFAULT_PRONOUNCE_GEMINI_MODEL);
  const force = Boolean(options.force);
  const skipExisting = force ? false : (options.skipExisting ?? true);
  const concurrency = options.concurrency ?? (backend === 'openai-speech' ? 4 : 2);
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CliValidationError('Option `--concurrency` must be a positive integer.');
  }

  const collected = collectPronounceSynthTargets({
    repoDir: options.repoDir ?? process.cwd(),
    scope,
    voice,
    format,
    phonemeMode,
  });
  const outDir = path.resolve(options.outDir?.trim() || path.join(collected.repoDir, 'media'));
  const json = Boolean(options.json);

  const baseMeta = {
    ok: true as const,
    repo: collected.repoDir,
    out_dir: outDir,
    backend,
    model,
    voice,
    phoneme_mode: phonemeMode,
    format,
    scope,
  };

  if (options.exportManifestPath) {
    const manifestPath = path.resolve(options.exportManifestPath);
    const manifest: PronounceBatchManifest = {
      version: 1,
      kind: 'kinloom-pronounce-manifest',
      generated_at: (options.nowIso ?? (() => new Date().toISOString()))(),
      backend,
      model,
      voice,
      phoneme_mode: phonemeMode,
      format,
      scope,
      living_people_excluded: collected.livingExcluded,
      targets: collected.targets,
    };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const items: PronounceSynthItemResult[] = collected.targets.map((t) => ({
      id: t.id,
      scope: t.scope,
      key: t.key,
      text: t.text,
      filename: t.filename,
      audio_url: t.audio_url,
      status: 'planned',
    }));
    return buildSynthResult(
      {
        ...baseMeta,
        mode: 'export_manifest',
        manifest_path: manifestPath,
        config_updated: false,
        config_entries_updated: 0,
        updatedConfigEntries: 0,
        updatedPersonEntries: 0,
        updatedPlaceEntries: 0,
        summary: {
          total_targets: collected.targets.length,
          deduplicated: collected.deduplicatedCount,
          living_people_excluded: collected.livingExcluded,
          synthesized: 0,
          imported: 0,
          skipped_existing: 0,
          planned: items.length,
          missing_import: 0,
        },
        items,
      },
      json
    );
  }

  const dryRun = Boolean(options.dryRun);

  if (options.importDir) {
    const importDir = path.resolve(options.importDir);
    if (!fs.existsSync(importDir) || !fs.statSync(importDir).isDirectory()) {
      throw new CliValidationError(`Import directory does not exist: ${importDir}`);
    }
    if (!dryRun) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const items: PronounceSynthItemResult[] = [];
    for (const target of collected.targets) {
      const destPath = path.join(outDir, target.filename);
      if (skipExisting && fs.existsSync(destPath)) {
        items.push({
          id: target.id,
          scope: target.scope,
          key: target.key,
          text: target.text,
          filename: target.filename,
          audio_url: target.audio_url,
          status: 'skipped_existing',
          size_bytes: fs.statSync(destPath).size,
        });
        continue;
      }
      const srcPath = path.join(importDir, target.filename);
      if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
        items.push({
          id: target.id,
          scope: target.scope,
          key: target.key,
          text: target.text,
          filename: target.filename,
          audio_url: target.audio_url,
          status: 'missing_import',
        });
        continue;
      }
      if (dryRun) {
        items.push({
          id: target.id,
          scope: target.scope,
          key: target.key,
          text: target.text,
          filename: target.filename,
          audio_url: target.audio_url,
          status: 'planned',
          size_bytes: fs.statSync(srcPath).size,
        });
        continue;
      }
      fs.copyFileSync(srcPath, destPath);
      items.push({
        id: target.id,
        scope: target.scope,
        key: target.key,
        text: target.text,
        filename: target.filename,
        audio_url: target.audio_url,
        status: 'imported',
        size_bytes: fs.statSync(destPath).size,
      });
    }

    const updates = options.updateConfig
      ? applyPronunciationAudioUpdates({
          configPath: collected.configPath,
          siteConfig: collected.siteConfig,
          peoplePath: collected.peoplePath,
          people: collected.people,
          livingPersonIds: collected.livingPersonIds,
          placesPath: collected.placesPath,
          places: collected.places,
          targets: collected.targets,
          deduplicatedOverrides: collected.deduplicatedOverrides,
          items,
          force,
          dryRun,
        })
      : { updatedConfigEntries: 0, updatedPersonEntries: 0, updatedPlaceEntries: 0 };

    return buildSynthResult(
      {
        ...baseMeta,
        mode: dryRun ? 'dry_run' : 'import_dir',
        manifest_path: null,
        config_updated: !dryRun && updates.updatedConfigEntries > 0,
        config_entries_updated: updates.updatedConfigEntries,
        updatedConfigEntries: updates.updatedConfigEntries,
        updatedPersonEntries: updates.updatedPersonEntries,
        updatedPlaceEntries: updates.updatedPlaceEntries,
        summary: {
          total_targets: collected.targets.length,
          deduplicated: collected.deduplicatedCount,
          living_people_excluded: collected.livingExcluded,
          synthesized: 0,
          imported: items.filter((i) => i.status === 'imported').length,
          skipped_existing: items.filter((i) => i.status === 'skipped_existing').length,
          planned: items.filter((i) => i.status === 'planned').length,
          missing_import: items.filter((i) => i.status === 'missing_import').length,
        },
        items,
      },
      json
    );
  }

  if (dryRun) {
    const items: PronounceSynthItemResult[] = collected.targets.map((target) => {
      const destPath = path.join(outDir, target.filename);
      return {
        id: target.id,
        scope: target.scope,
        key: target.key,
        text: target.text,
        filename: target.filename,
        audio_url: target.audio_url,
        status: skipExisting && fs.existsSync(destPath) ? 'skipped_existing' : 'planned',
      };
    });
    const updates = options.updateConfig
      ? applyPronunciationAudioUpdates({
          configPath: collected.configPath,
          siteConfig: collected.siteConfig,
          peoplePath: collected.peoplePath,
          people: collected.people,
          livingPersonIds: collected.livingPersonIds,
          placesPath: collected.placesPath,
          places: collected.places,
          targets: collected.targets,
          deduplicatedOverrides: collected.deduplicatedOverrides,
          items,
          force,
          dryRun: true,
        })
      : { updatedConfigEntries: 0, updatedPersonEntries: 0, updatedPlaceEntries: 0 };
    return buildSynthResult(
      {
        ...baseMeta,
        mode: 'dry_run',
        manifest_path: null,
        config_updated: false,
        config_entries_updated: updates.updatedConfigEntries,
        updatedConfigEntries: updates.updatedConfigEntries,
        updatedPersonEntries: updates.updatedPersonEntries,
        updatedPlaceEntries: updates.updatedPlaceEntries,
        summary: {
          total_targets: collected.targets.length,
          deduplicated: collected.deduplicatedCount,
          living_people_excluded: collected.livingExcluded,
          synthesized: 0,
          imported: 0,
          skipped_existing: items.filter((i) => i.status === 'skipped_existing').length,
          planned: items.filter((i) => i.status === 'planned').length,
          missing_import: 0,
        },
        items,
      },
      json
    );
  }

  const endpointRaw = options.endpoint?.trim() || env['KINLOOM_TTS_ENDPOINT']?.trim() || '';
  const openAiUrl = backend === 'openai-speech' ? normalizeSpeechEndpointUrl(endpointRaw) : '';
  const openAiApiKey = options.apiKey?.trim() || env['OPENAI_SPEECH_API_KEY']?.trim() || undefined;
  const geminiApiKey =
    options.apiKey?.trim() || env['GEMINI_API_KEY']?.trim() || env['GOOGLE_API_KEY']?.trim() || '';
  if (backend === 'gemini' && !geminiApiKey) {
    throw new CliValidationError('Set GEMINI_API_KEY (or pass --api-key) for --backend gemini.');
  }

  let references: readonly VoiceCloneReference[] | undefined;
  if (options.refAudioPath || options.refText) {
    if (!options.refAudioPath || !options.refText) {
      throw new CliValidationError('Pass both --ref-audio and --ref-text together for voice cloning.');
    }
    references = [loadVoiceCloneReference(path.resolve(options.refAudioPath), options.refText)];
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleepFn = options.sleepFn ?? (async (ms: number) => new Promise((r) => setTimeout(r, ms)));

  const items = await runPool(
    collected.targets,
    concurrency,
    async (target): Promise<PronounceSynthItemResult> => {
      const destPath = path.join(outDir, target.filename);
      if (skipExisting && fs.existsSync(destPath)) {
        return {
          id: target.id,
          scope: target.scope,
          key: target.key,
          text: target.text,
          filename: target.filename,
          audio_url: target.audio_url,
          status: 'skipped_existing',
          size_bytes: fs.statSync(destPath).size,
        };
      }

      const rawBytes =
        backend === 'openai-speech'
          ? (
              await synthesizeOpenAiSpeech({
                endpoint: openAiUrl,
                model,
                input: target.speech_input,
                voice: target.voice,
                responseFormat: 'wav',
                apiKey: openAiApiKey,
                references,
                fetchImpl,
                sleepFn,
              })
            ).bytes
          : await synthesizeTargetWithGemini({
              target,
              model,
              apiKey: geminiApiKey,
              fetchImpl,
              sleepFn,
            });

      const normalized = await normalizePronunciationAudioWithFfmpeg({
        inputBytes: rawBytes,
        outPath: destPath,
        format,
        execFileImpl: options.execFileImpl,
        env,
      });

      return {
        id: target.id,
        scope: target.scope,
        key: target.key,
        text: target.text,
        filename: target.filename,
        audio_url: target.audio_url,
        status: 'synthesized',
        size_bytes: normalized.sizeBytes,
      };
    }
  );

  const updates = options.updateConfig
    ? applyPronunciationAudioUpdates({
        configPath: collected.configPath,
        siteConfig: collected.siteConfig,
        peoplePath: collected.peoplePath,
        people: collected.people,
        livingPersonIds: collected.livingPersonIds,
        placesPath: collected.placesPath,
        places: collected.places,
        targets: collected.targets,
        deduplicatedOverrides: collected.deduplicatedOverrides,
        items,
        force,
        dryRun: false,
      })
    : { updatedConfigEntries: 0, updatedPersonEntries: 0, updatedPlaceEntries: 0 };

  return buildSynthResult(
    {
      ...baseMeta,
      mode: 'synth',
      manifest_path: null,
      config_updated: updates.updatedConfigEntries > 0,
      config_entries_updated: updates.updatedConfigEntries,
      updatedConfigEntries: updates.updatedConfigEntries,
      updatedPersonEntries: updates.updatedPersonEntries,
      updatedPlaceEntries: updates.updatedPlaceEntries,
      summary: {
        total_targets: collected.targets.length,
        deduplicated: collected.deduplicatedCount,
        living_people_excluded: collected.livingExcluded,
        synthesized: items.filter((i) => i.status === 'synthesized').length,
        imported: 0,
        skipped_existing: items.filter((i) => i.status === 'skipped_existing').length,
        planned: 0,
        missing_import: 0,
      },
      items,
    },
    json
  );
}
