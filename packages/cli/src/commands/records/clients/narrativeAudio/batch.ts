import fs from 'node:fs';
import path from 'node:path';
import {
  getCurrentReferenceYear,
  type Narrative,
  parseNarrativesYaml as parseCoreNarrativesYaml,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  type RawPerson,
  resolveEffectiveLiving,
  serializeNarrativesYaml,
} from '@kinloom/core';
import { CliValidationError } from '../../../../errors.js';
import {
  DEFAULT_OPENAI_SPEECH_MODEL,
  loadVoiceCloneReference,
  normalizeSpeechEndpointUrl,
  parsePhonemeMode,
  type VoiceCloneReference,
} from '../../../ops/shared/audio/index.js';
import { getBooleanOption, getNumberOption, getStringOption, parseCommandArgs } from '../../runtime/args.js';
import { resolveUserPathFromContext } from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  collectArchiveLexiconHints,
  hasExistingNarrativeAudio,
  loadImportMetaMap,
  type NarrativeBatchManifest,
  type NarrativeBatchManifestItem,
  narrativeMarkdownToSpokenScript,
  readSingleImportMeta,
  withNarrativeAudioExtension,
} from './batchPrep.js';
import { BATCH_PARSE_SPEC, renderBatchHelp } from './batchSpec.js';
import { synthesizeWithOpenAiSpeech } from './openaiSynthesis.js';
import {
  buildSynthChunks,
  DEFAULT_BACKEND,
  DEFAULT_LANGUAGE,
  DEFAULT_TTS_MODEL,
  type TtsBackend,
} from './script.js';
import {
  encodePcmToMp3,
  findExecutableOnPath,
  synthesizeWithChirp,
  synthesizeWithGemini,
} from './synthesis.js';

export {
  collectArchiveLexiconHints,
  type NarrativeBatchManifest,
  type NarrativeBatchManifestItem,
  narrativeMarkdownToSpokenScript,
};

export async function runBatch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, BATCH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderBatchHelp()) };
  }

  const repoDir = resolveUserPathFromContext(getStringOption(parsed, 'repo') ?? '.', ctx);
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const peoplePath = path.join(repoDir, 'data', 'people.yaml');
  const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');

  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(`Missing ${configPath} (pass --repo <archive-root>).`);
  }
  if (!fs.existsSync(narrativesPath)) {
    throw new CliValidationError(`Missing ${narrativesPath}.`);
  }

  const siteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const people: RawPerson[] = fs.existsSync(peoplePath)
    ? parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'))
    : [];
  const allNarratives = parseCoreNarrativesYaml(fs.readFileSync(narrativesPath, 'utf8'));

  const referenceYear = siteConfig.privacy.referenceYear ?? getCurrentReferenceYear();
  const livingIds = new Set<string>();
  for (const person of people) {
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy, referenceYear)
    ) {
      livingIds.add(person.id);
    }
  }

  const kindFilter = getStringOption(parsed, 'kind') ?? 'biography';
  const force = getBooleanOption(parsed, 'force');
  const dryRun = getBooleanOption(parsed, 'dryRun');
  const jsonOutput = getBooleanOption(parsed, 'json');
  const exportManifestArg = getStringOption(parsed, 'exportManifest');
  const importDirArg = getStringOption(parsed, 'importDir');
  const updateYaml = getBooleanOption(parsed, 'updateYaml') || Boolean(importDirArg);

  const rawEndpoint = (
    getStringOption(parsed, 'endpoint') ??
    ctx.env.KINLOOM_TTS_ENDPOINT ??
    ctx.env.NARRATIVE_AUDIO_ENDPOINT ??
    ''
  ).trim();

  const rawBackend = (
    getStringOption(parsed, 'backend') ??
    ctx.env.NARRATIVE_AUDIO_BACKEND ??
    (rawEndpoint ? 'openai-speech' : DEFAULT_BACKEND)
  )
    .trim()
    .toLowerCase();
  if (rawBackend !== 'chirp3-hd' && rawBackend !== 'gemini' && rawBackend !== 'openai-speech') {
    throw new CliValidationError(
      `Invalid --backend '${rawBackend}': choose from chirp3-hd, gemini, openai-speech.`
    );
  }
  const backend: TtsBackend = rawBackend;

  const model = parsed.provided.has('model')
    ? (getStringOption(parsed, 'model') ?? DEFAULT_TTS_MODEL)
    : backend === 'openai-speech'
      ? DEFAULT_OPENAI_SPEECH_MODEL
      : DEFAULT_TTS_MODEL;
  const voice = getStringOption(parsed, 'voice') ?? 'Charon';
  const notesVoice = getStringOption(parsed, 'notesVoice') ?? 'Kore';
  const phonemeMode = parsePhonemeMode(getStringOption(parsed, 'phonemeMode'), 'ipa');
  const sectionPause = getNumberOption(parsed, 'sectionPause') ?? 0.8;
  const notesPause = getNumberOption(parsed, 'notesPause') ?? 2.0;
  const bitrate = getStringOption(parsed, 'bitrate') ?? '96k';
  const languageCode = (
    getStringOption(parsed, 'languageCode') ??
    ctx.env.NARRATIVE_AUDIO_LANGUAGE ??
    DEFAULT_LANGUAGE
  ).trim();
  const gcpProject = getStringOption(parsed, 'gcpProject');
  const keyFile = getStringOption(parsed, 'keyFile');
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.OPENAI_SPEECH_API_KEY;
  const outDirArg = getStringOption(parsed, 'outDir');
  const outDir = outDirArg ? resolveUserPathFromContext(outDirArg, ctx) : path.join(repoDir, 'media');

  const lexiconHints = collectArchiveLexiconHints(repoDir, siteConfig, people);

  let livingSkipped = 0;
  let alreadyHasAudio = 0;
  const candidates: Narrative[] = [];
  for (const narrative of allNarratives) {
    const touchesLiving =
      (narrative.subject_person_id !== undefined && livingIds.has(narrative.subject_person_id)) ||
      narrative.person_ids.some((pid) => livingIds.has(pid));
    if (touchesLiving) {
      livingSkipped += 1;
      continue;
    }
    if (kindFilter && narrative.kind !== kindFilter) {
      continue;
    }
    if (!force && hasExistingNarrativeAudio(narrative)) {
      alreadyHasAudio += 1;
      continue;
    }
    candidates.push(narrative);
  }

  const manifestItems: NarrativeBatchManifestItem[] = candidates.map((narrative) => {
    const slug = narrative.slug || narrative.id;
    const script = narrativeMarkdownToSpokenScript(narrative.body_md, narrative.title);
    const chunks = buildSynthChunks({
      rawText: script,
      backend,
      namesMap: lexiconHints,
      phonemeMode,
      voice,
      notesVoice,
      sectionPause,
      notesPause,
    });
    const fileName = `audio-${slug}.mp3`;
    return {
      id: narrative.id,
      slug,
      title: narrative.title,
      target_file: `media/${fileName}`,
      public_url: `/media/${fileName}`,
      script,
      chunks,
    };
  });

  if (exportManifestArg) {
    const manifestPath = resolveUserPathFromContext(exportManifestArg, ctx);
    const manifest: NarrativeBatchManifest = {
      version: 1,
      kind: 'kinloom-narrative-audio-manifest',
      generated_at: new Date(ctx.nowMs()).toISOString(),
      backend,
      model,
      voice,
      notes_voice: notesVoice,
      phoneme_mode: phonemeMode,
      section_pause: sectionPause,
      notes_pause: notesPause,
      living_skipped: livingSkipped,
      narratives: manifestItems,
    };
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const summary = {
      ok: true,
      mode: 'export_manifest',
      manifest_path: manifestPath,
      narratives: manifestItems.length,
      already_has_audio: alreadyHasAudio,
      living_skipped: livingSkipped,
    };
    const bytesOut = jsonOutput
      ? emitJsonStdout(ctx.io, summary)
      : emitStdout(
          ctx.io,
          `Exported narrative audio manifest: ${manifestPath} (${manifestItems.length} narratives, ${alreadyHasAudio} skipped with audio, ${livingSkipped} living excluded)`
        );
    return { exitCode: 0, bytesOut };
  }

  if (importDirArg) {
    const importDir = resolveUserPathFromContext(importDirArg, ctx);
    if (!fs.existsSync(importDir) || !fs.statSync(importDir).isDirectory()) {
      throw new CliValidationError(`Import directory does not exist: ${importDir}`);
    }
    fs.mkdirSync(outDir, { recursive: true });
    const bulkMeta = loadImportMetaMap(importDir);
    const updatesById = new Map<
      string,
      {
        readonly publicUrl: string;
        readonly durationSeconds?: number;
        readonly editorNotesStartSeconds?: number;
        readonly storyVoice: string;
        readonly notesVoice: string;
      }
    >();
    const importedIds: string[] = [];
    const missingIds: string[] = [];

    for (const item of manifestItems) {
      const candidateFiles = [`audio-${item.slug}.mp3`, `${item.slug}.mp3`, `${item.id}.mp3`];
      const srcPath = candidateFiles
        .map((name) => path.join(importDir, name))
        .find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!srcPath) {
        missingIds.push(item.id);
        continue;
      }
      const destPath = path.join(outDir, `audio-${item.slug}.mp3`);
      fs.copyFileSync(srcPath, destPath);
      const meta =
        bulkMeta.get(item.id) ?? bulkMeta.get(item.slug) ?? readSingleImportMeta(importDir, item.slug);
      updatesById.set(item.id, {
        publicUrl: item.public_url,
        durationSeconds: meta?.duration_seconds,
        editorNotesStartSeconds: meta?.editor_notes_start_seconds,
        storyVoice: meta?.story_voice ?? voice,
        notesVoice: meta?.notes_voice ?? notesVoice,
      });
      importedIds.push(item.id);
    }

    if (updateYaml && updatesById.size > 0) {
      const updatedNarratives = allNarratives.map((n) => {
        const update = updatesById.get(n.id);
        return update ? withNarrativeAudioExtension(n, update) : n;
      });
      fs.writeFileSync(narrativesPath, serializeNarrativesYaml(updatedNarratives), 'utf8');
    }

    const summary = {
      ok: true,
      mode: 'import_dir',
      imported: importedIds.length,
      missing: missingIds.length,
      yaml_updated: updateYaml && updatesById.size > 0,
      living_skipped: livingSkipped,
      imported_ids: importedIds,
      missing_ids: missingIds,
    };
    const bytesOut = jsonOutput
      ? emitJsonStdout(ctx.io, summary)
      : emitStdout(
          ctx.io,
          `Imported ${importedIds.length} narrative audio file(s) into ${outDir} (${missingIds.length} missing, ${livingSkipped} living excluded)`
        );
    return { exitCode: 0, bytesOut };
  }

  if (dryRun) {
    const plan = manifestItems.map((item) => {
      const destPath = path.join(outDir, `audio-${item.slug}.mp3`);
      return {
        id: item.id,
        slug: item.slug,
        title: item.title,
        target: destPath,
        chunks: item.chunks.length,
        status: !force && fs.existsSync(destPath) ? 'skipped_existing' : 'planned',
      };
    });
    const summary = {
      ok: true,
      mode: 'dry_run',
      backend,
      model,
      phoneme_mode: phonemeMode,
      already_has_audio: alreadyHasAudio,
      living_skipped: livingSkipped,
      items: plan,
    };
    const bytesOut = jsonOutput
      ? emitJsonStdout(ctx.io, summary)
      : emitStdout(
          ctx.io,
          [
            `Narrative Audio Batch (dry-run) [${backend} · ${model}]`,
            `  Candidates: ${plan.length} | Already have audio: ${alreadyHasAudio} | Living excluded: ${livingSkipped}`,
            ...plan.map((p) => `  - ${p.id} (${p.slug}): ${p.chunks} chunks -> ${p.status}`),
          ].join('\n')
        );
    return { exitCode: 0, bytesOut };
  }

  if (ctx.execFileImpl === undefined && findExecutableOnPath('ffmpeg', ctx.env) === null) {
    throw new RecordRuntimeError('ffmpeg not found on PATH');
  }

  const endpointUrl = backend === 'openai-speech' ? normalizeSpeechEndpointUrl(rawEndpoint) : '';
  const storyRefAudio = getStringOption(parsed, 'storyRefAudio');
  const storyRefText = getStringOption(parsed, 'storyRefText');
  const notesRefAudio = getStringOption(parsed, 'notesRefAudio');
  const notesRefText = getStringOption(parsed, 'notesRefText');
  let storyRef: VoiceCloneReference | undefined;
  let notesRef: VoiceCloneReference | undefined;
  if (storyRefAudio || storyRefText) {
    if (!storyRefAudio || !storyRefText) {
      throw new CliValidationError('Pass both --story-ref-audio and --story-ref-text together.');
    }
    storyRef = loadVoiceCloneReference(resolveUserPathFromContext(storyRefAudio, ctx), storyRefText);
  }
  if (notesRefAudio || notesRefText) {
    if (!notesRefAudio || !notesRefText) {
      throw new CliValidationError('Pass both --notes-ref-audio and --notes-ref-text together.');
    }
    notesRef = loadVoiceCloneReference(resolveUserPathFromContext(notesRefAudio, ctx), notesRefText);
  }

  const synthesizedIds: string[] = [];
  const skippedExistingIds: string[] = [];
  const updatesById = new Map<
    string,
    {
      readonly publicUrl: string;
      readonly durationSeconds: number;
      readonly editorNotesStartSeconds?: number;
      readonly storyVoice: string;
      readonly notesVoice: string;
    }
  >();

  for (const item of manifestItems) {
    const destPath = path.join(outDir, `audio-${item.slug}.mp3`);
    if (!force && fs.existsSync(destPath)) {
      skippedExistingIds.push(item.id);
      continue;
    }

    const synthesis =
      backend === 'openai-speech'
        ? await synthesizeWithOpenAiSpeech({
            chunks: item.chunks,
            endpoint: endpointUrl,
            model,
            apiKey,
            storyRef,
            notesRef,
            ctx,
          })
        : backend === 'chirp3-hd'
          ? await synthesizeWithChirp({
              chunks: item.chunks,
              namesMap: lexiconHints,
              languageCode,
              gcpProject,
              keyFile,
              ctx,
            })
          : await synthesizeWithGemini({
              chunks: item.chunks,
              model,
              keyFile,
              ctx,
            });

    await encodePcmToMp3({
      pcm: synthesis.combinedPcm,
      sampleRate: synthesis.sampleRate,
      bitrate,
      outPath: destPath,
      ctx,
    });

    const totalSec = synthesis.combinedPcm.length / 2 / synthesis.sampleRate;
    synthesizedIds.push(item.id);
    updatesById.set(item.id, {
      publicUrl: item.public_url,
      durationSeconds: totalSec,
      editorNotesStartSeconds: synthesis.notesStartSec,
      storyVoice: voice,
      notesVoice,
    });
  }

  if (updateYaml && updatesById.size > 0) {
    const updatedNarratives = allNarratives.map((n) => {
      const update = updatesById.get(n.id);
      return update ? withNarrativeAudioExtension(n, update) : n;
    });
    fs.writeFileSync(narrativesPath, serializeNarrativesYaml(updatedNarratives), 'utf8');
  }

  const summary = {
    ok: true,
    mode: 'batch_synth',
    backend,
    model,
    synthesized: synthesizedIds.length,
    skipped_existing: skippedExistingIds.length,
    already_has_audio: alreadyHasAudio,
    living_skipped: livingSkipped,
    yaml_updated: updateYaml && updatesById.size > 0,
    synthesized_ids: synthesizedIds,
    skipped_existing_ids: skippedExistingIds,
  };
  const bytesOut = jsonOutput
    ? emitJsonStdout(ctx.io, summary)
    : emitStdout(
        ctx.io,
        `Synthesized ${synthesizedIds.length} narrative(s) [${backend} · ${model}] (${skippedExistingIds.length} skipped existing, ${livingSkipped} living excluded)`
      );
  return { exitCode: 0, bytesOut };
}
