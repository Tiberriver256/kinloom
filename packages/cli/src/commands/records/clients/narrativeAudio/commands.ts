import fs from 'node:fs';
import path from 'node:path';
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
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import {
  CHECK_PARSE_SPEC,
  EXTRACT_PARSE_SPEC,
  LIST_PARSE_SPEC,
  renderCheckHelp,
  renderExtractHelp,
  renderListHelp,
  renderSynthHelp,
  renderTranscribeHelp,
  SYNTH_PARSE_SPEC,
  TRANSCRIBE_PARSE_SPEC,
} from './cliSpecs.js';
import { synthesizeWithOpenAiSpeech } from './openaiSynthesis.js';
import {
  buildSynthChunks,
  countWords,
  DEFAULT_BACKEND,
  DEFAULT_LANGUAGE,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TTS_MODEL,
  defaultMp3Path,
  defaultTranscriptPath,
  formatDryRunPlan,
  formatYamlSnippet,
  type TtsBackend,
} from './script.js';
import { lintNarrativeScript } from './scriptLint.js';
import {
  encodePcmToMp3,
  findExecutableOnPath,
  loadNarratives,
  readNamesJson,
  requireExistingFile,
  synthesizeWithChirp,
  synthesizeWithGemini,
  transcribeAudioFile,
} from './synthesis.js';

export function runList(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, LIST_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderListHelp()) };
  }

  const yamlPath = requireExistingFile(parsed.positionals[0], 'narratives YAML', ctx);
  const kind = getStringOption(parsed, 'kind') ?? 'biography';
  const rows = loadNarratives(yamlPath)
    .filter((n) => !kind || n.kind === kind)
    .map((n) => ({
      words: countWords(n.body_md ?? ''),
      id: n.id,
      title: n.title ?? '',
    }))
    .sort((a, b) => a.words - b.words || a.id.localeCompare(b.id));

  if (rows.length === 0) {
    return { exitCode: 0, bytesOut: 0 };
  }
  const rendered = rows.map((r) => `${String(r.words).padStart(6)}  ${r.id}  ${r.title}`).join('\n');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, rendered) };
}

export function runExtract(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, EXTRACT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderExtractHelp()) };
  }

  const yamlPath = requireExistingFile(parsed.positionals[0], 'narratives YAML', ctx);
  const narrativeId = parsed.positionals[1];
  const found = loadNarratives(yamlPath).find((n) => n.id === narrativeId);
  if (!found) {
    throw new RecordRuntimeError(`no narrative with id ${narrativeId}`);
  }
  const output = `SLUG: ${found.slug ?? narrativeId}\nTITLE: ${found.title ?? ''}\n\n${found.body_md ?? ''}`;
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, output) };
}

export function runCheck(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, CHECK_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderCheckHelp()) };
  }

  const scriptArg = parsed.positionals[0];
  const scriptPath = requireExistingFile(scriptArg, 'script file', ctx);
  const namesArg = getStringOption(parsed, 'names');
  const namesMap = namesArg ? readNamesJson(requireExistingFile(namesArg, 'names file', ctx)) : undefined;

  const text = fs.readFileSync(scriptPath, 'utf8');
  const result = lintNarrativeScript(scriptArg, text, namesMap);

  const lines: string[] = [
    `${result.sections.length} story sections, ${result.notes.length} notes, ${result.wordCount} words`,
    ...result.problems,
  ];
  if (result.problems.length > 0) {
    return { exitCode: 1, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
  }
  lines.push('ok');
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export async function runSynth(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SYNTH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderSynthHelp()) };
  }

  const scriptPath = requireExistingFile(parsed.positionals[0], 'script file', ctx);
  const namesArg = getStringOption(parsed, 'names');
  const namesMap = namesArg ? readNamesJson(requireExistingFile(namesArg, 'names file', ctx)) : {};

  const rawBackend = (
    getStringOption(parsed, 'backend') ??
    ctx.env.NARRATIVE_AUDIO_BACKEND ??
    DEFAULT_BACKEND
  )
    .trim()
    .toLowerCase();
  if (rawBackend !== 'chirp3-hd' && rawBackend !== 'gemini' && rawBackend !== 'openai-speech') {
    throw new CliValidationError(
      `Invalid --backend '${rawBackend}': choose from chirp3-hd, gemini, openai-speech.`
    );
  }
  const backend: TtsBackend = rawBackend;

  const languageCode = (
    getStringOption(parsed, 'languageCode') ??
    ctx.env.NARRATIVE_AUDIO_LANGUAGE ??
    DEFAULT_LANGUAGE
  ).trim();
  const gcpProject = getStringOption(parsed, 'gcpProject');
  const model = parsed.provided.has('model')
    ? (getStringOption(parsed, 'model') ?? DEFAULT_TTS_MODEL)
    : backend === 'openai-speech'
      ? DEFAULT_OPENAI_SPEECH_MODEL
      : DEFAULT_TTS_MODEL;
  const endpointRaw = (
    getStringOption(parsed, 'endpoint') ??
    ctx.env.KINLOOM_TTS_ENDPOINT ??
    ctx.env.NARRATIVE_AUDIO_ENDPOINT ??
    ''
  ).trim();
  const apiKey = getStringOption(parsed, 'apiKey') ?? ctx.env.OPENAI_SPEECH_API_KEY;
  const rawPhonemeMode = getStringOption(parsed, 'phonemeMode');
  const phonemeMode =
    rawPhonemeMode !== undefined
      ? parsePhonemeMode(rawPhonemeMode)
      : backend === 'openai-speech'
        ? 'ipa'
        : undefined;
  const voice = getStringOption(parsed, 'voice') ?? 'Charon';
  const notesVoice = getStringOption(parsed, 'notesVoice') ?? 'Kore';
  const sectionPause = getNumberOption(parsed, 'sectionPause') ?? 0.8;
  const notesPause = getNumberOption(parsed, 'notesPause') ?? 2.0;
  const bitrate = getStringOption(parsed, 'bitrate') ?? '96k';
  const keyFile = getStringOption(parsed, 'keyFile');
  const outArg = getStringOption(parsed, 'out');
  const dryRun = getBooleanOption(parsed, 'dryRun');

  const rawText = fs.readFileSync(scriptPath, 'utf8');
  const chunks = buildSynthChunks({
    rawText,
    backend,
    namesMap,
    phonemeMode,
    voice,
    notesVoice,
    sectionPause,
    notesPause,
  });

  const storyRefAudio = getStringOption(parsed, 'storyRefAudio');
  const storyRefText = getStringOption(parsed, 'storyRefText');
  const notesRefAudio = getStringOption(parsed, 'notesRefAudio');
  const notesRefText = getStringOption(parsed, 'notesRefText');
  if ((storyRefAudio || storyRefText) && (!storyRefAudio || !storyRefText)) {
    throw new CliValidationError('Pass both --story-ref-audio and --story-ref-text together.');
  }
  if ((notesRefAudio || notesRefText) && (!notesRefAudio || !notesRefText)) {
    throw new CliValidationError('Pass both --notes-ref-audio and --notes-ref-text together.');
  }

  if (dryRun) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatDryRunPlan({
          chunks,
          backend,
          languageCode,
          model,
          namesMap,
          endpoint: endpointRaw || undefined,
          phonemeMode,
        })
      ),
    };
  }

  const endpointUrl = backend === 'openai-speech' ? normalizeSpeechEndpointUrl(endpointRaw) : '';
  let storyRef: VoiceCloneReference | undefined;
  let notesRef: VoiceCloneReference | undefined;
  if (storyRefAudio && storyRefText) {
    storyRef = loadVoiceCloneReference(resolveUserPathFromContext(storyRefAudio, ctx), storyRefText);
  }
  if (notesRefAudio && notesRefText) {
    notesRef = loadVoiceCloneReference(resolveUserPathFromContext(notesRefAudio, ctx), notesRefText);
  }

  if (ctx.execFileImpl === undefined && findExecutableOnPath('ffmpeg', ctx.env) === null) {
    throw new RecordRuntimeError('ffmpeg not found on PATH');
  }

  const outPath = outArg ? resolveUserPathFromContext(outArg, ctx) : defaultMp3Path(scriptPath);
  const synthesis =
    backend === 'chirp3-hd'
      ? await synthesizeWithChirp({ chunks, namesMap, languageCode, gcpProject, keyFile, ctx })
      : backend === 'openai-speech'
        ? await synthesizeWithOpenAiSpeech({
            chunks,
            endpoint: endpointUrl,
            model,
            apiKey,
            storyRef,
            notesRef,
            ctx,
          })
        : await synthesizeWithGemini({ chunks, model, keyFile, ctx });

  await encodePcmToMp3({
    pcm: synthesis.combinedPcm,
    sampleRate: synthesis.sampleRate,
    bitrate,
    outPath,
    ctx,
  });

  const totalSec = synthesis.combinedPcm.length / 2 / synthesis.sampleRate;
  const summaryLine = `wrote ${outPath} (${totalSec.toFixed(1)}s / ${(totalSec / 60).toFixed(1)} min, ${backend}, ${synthesis.usageStr})`;
  const snippet = formatYamlSnippet({
    fileName: path.basename(outPath),
    durationSeconds: totalSec,
    editorNotesStartSeconds: synthesis.notesStartSec,
    storyVoice: voice,
    notesVoice,
  });

  const bytesOut = emitStdout(ctx.io, `${summaryLine}\n\n${snippet}`);
  return { exitCode: 0, bytesOut };
}

export async function runTranscribe(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TRANSCRIBE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTranscribeHelp()) };
  }

  const audioPath = requireExistingFile(parsed.positionals[0], 'audio file', ctx);
  const model = getStringOption(parsed, 'model') ?? DEFAULT_TEXT_MODEL;
  const keyFile = getStringOption(parsed, 'keyFile');
  const outArg = getStringOption(parsed, 'out');

  const text = await transcribeAudioFile({ audioPath, model, keyFile, ctx });
  const outPath = outArg ? resolveUserPathFromContext(outArg, ctx) : defaultTranscriptPath(audioPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');

  const bytesOut = emitStdout(ctx.io, text);
  ctx.io.stderr(`\nwrote ${outPath}`);
  return { exitCode: 0, bytesOut };
}
