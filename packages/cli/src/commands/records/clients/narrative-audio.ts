import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './narrativeAudio/cliSpecs.js';
import { runCheck, runExtract, runList, runSynth, runTranscribe } from './narrativeAudio/commands.js';

export {
  applyNames,
  buildChirpPronunciations,
  CHIRP_MAX_BYTES,
  type ChirpPronunciation,
  CLOUD_TTS_API,
  DEFAULT_BACKEND,
  DEFAULT_LANGUAGE,
  DEFAULT_TEXT_MODEL,
  DEFAULT_TTS_MODEL,
  formatYamlSnippet,
  GEMINI_API_BASE,
  intToWords,
  lintNarrativeScript,
  type NarrativeRecord,
  NOTES_MARKER,
  ordinal,
  resolveChirpVoice,
  type ScriptLintResult,
  speakDates,
  speakNumbers,
  splitScript,
  splitToByteLimit,
  stripWavHeader,
  type WavStripResult,
} from './narrativeAudio/script.js';
export { loadNarratives } from './narrativeAudio/synthesis.js';

export const runNarrativeAudioCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'list':
        return runList(rest, ctx);
      case 'extract':
        return runExtract(rest, ctx);
      case 'check':
        return runCheck(rest, ctx);
      case 'synth':
        return await runSynth(rest, ctx);
      case 'transcribe':
        return await runTranscribe(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom narrative-audio --help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
