import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DEFAULT_TEXT_MODEL, DEFAULT_TTS_MODEL } from './script.js';

const LIST_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'kind',
    kind: 'string',
    flags: ['--kind'],
    default: 'biography',
    metavar: 'KIND',
    help: 'Filter narratives by kind (default: biography; empty string lists all).',
  },
];

export const LIST_PARSE_SPEC: CommandParseSpec = {
  options: LIST_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'narratives_yaml',
};

export const EXTRACT_PARSE_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  minPositionals: 2,
  maxPositionals: 2,
  positionalLabel: 'narratives_yaml narrative_id',
};

const CHECK_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'names',
    kind: 'string',
    flags: ['--names'],
    metavar: 'PATH',
    help: 'IPA names JSON file.',
  },
];

export const CHECK_PARSE_SPEC: CommandParseSpec = {
  options: CHECK_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'script',
};

const SYNTH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'names',
    kind: 'string',
    flags: ['--names'],
    metavar: 'PATH',
    help: 'IPA names JSON file.',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['-o', '--out'],
    metavar: 'PATH',
    help: 'Output .mp3 path (default: next to script).',
  },
  {
    key: 'backend',
    kind: 'string',
    flags: ['--backend'],
    metavar: 'chirp3-hd|gemini',
    help: 'TTS engine: chirp3-hd (Google Cloud TTS) or gemini (Gemini TTS).',
  },
  {
    key: 'languageCode',
    kind: 'string',
    flags: ['--language-code'],
    metavar: 'BCP47',
    help: 'BCP-47 language code for chirp3-hd voices (default: en-US).',
  },
  {
    key: 'gcpProject',
    kind: 'string',
    flags: ['--gcp-project'],
    metavar: 'PROJECT',
    help: 'GCP project ID for chirp3-hd billing quota header.',
  },
  {
    key: 'model',
    kind: 'string',
    flags: ['--model'],
    default: DEFAULT_TTS_MODEL,
    metavar: 'MODEL',
    help: `Gemini TTS model when --backend gemini (default: ${DEFAULT_TTS_MODEL}).`,
  },
  {
    key: 'voice',
    kind: 'string',
    flags: ['--voice'],
    default: 'Charon',
    metavar: 'VOICE',
    help: 'Story voice (default: Charon).',
  },
  {
    key: 'notesVoice',
    kind: 'string',
    flags: ['--notes-voice'],
    default: 'Kore',
    metavar: 'VOICE',
    help: "Editor's notes voice (default: Kore).",
  },
  {
    key: 'sectionPause',
    kind: 'number',
    flags: ['--section-pause'],
    default: 0.8,
    min: 0,
    metavar: 'SECONDS',
    help: 'Silence between story sections in seconds (default: 0.8).',
  },
  {
    key: 'notesPause',
    kind: 'number',
    flags: ['--notes-pause'],
    default: 2.0,
    min: 0,
    metavar: 'SECONDS',
    help: "Silence before Editor's notes in seconds (default: 2.0).",
  },
  {
    key: 'bitrate',
    kind: 'string',
    flags: ['--bitrate'],
    default: '96k',
    metavar: 'RATE',
    help: 'MP3 bitrate passed to ffmpeg (default: 96k).',
  },
  {
    key: 'keyFile',
    kind: 'string',
    flags: ['--key-file'],
    metavar: 'PATH',
    help: 'File containing the API key.',
  },
  {
    key: 'dryRun',
    kind: 'boolean',
    flags: ['--dry-run'],
    help: 'Print the exact payload/text each request would send without calling APIs.',
  },
];

export const SYNTH_PARSE_SPEC: CommandParseSpec = {
  options: SYNTH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'script',
};

const TRANSCRIBE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'model',
    kind: 'string',
    flags: ['--model'],
    default: DEFAULT_TEXT_MODEL,
    metavar: 'MODEL',
    help: `Gemini text/multimodal model (default: ${DEFAULT_TEXT_MODEL}).`,
  },
  {
    key: 'keyFile',
    kind: 'string',
    flags: ['--key-file'],
    metavar: 'PATH',
    help: 'File containing the Gemini API key.',
  },
  {
    key: 'out',
    kind: 'string',
    flags: ['-o', '--out'],
    metavar: 'PATH',
    help: 'Output .md path (default: next to audio).',
  },
];

export const TRANSCRIBE_PARSE_SPEC: CommandParseSpec = {
  options: TRANSCRIBE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'audio',
};

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio <command> [options]',
    summary: 'Narrate Kinloom narrative biographies with Chirp 3: HD or Gemini TTS.',
    subcommands: [
      { name: 'list', summary: 'List narratives (word count, id, title), shortest first.' },
      { name: 'extract', summary: 'Print one narrative slug, title, and body_md.' },
      { name: 'check', summary: 'Lint a spoken script (and optional names file).' },
      { name: 'synth', summary: "Synthesize SCRIPT to MP3 (story voice, then editor's notes voice)." },
      { name: 'transcribe', summary: 'Verbatim, timestamped transcript that flags audio glitches.' },
    ],
  });
}

export function renderListHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio list <narratives_yaml> [options]',
    summary: 'List narratives (word count, id, title), shortest first.',
    options: LIST_OPTIONS,
  });
}

export function renderExtractHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio extract <narratives_yaml> <narrative_id>',
    summary: "Print one narrative's slug, title and body_md (input for the script writer).",
  });
}

export function renderCheckHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio check <script> [options]',
    summary: 'Lint a spoken script (and names file) before paying for synthesis.',
    options: CHECK_OPTIONS,
  });
}

export function renderSynthHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio synth <script> [options]',
    summary: "Synthesize SCRIPT to MP3 (story voice, then editor's notes voice).",
    options: SYNTH_OPTIONS,
  });
}

export function renderTranscribeHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom narrative-audio transcribe <audio> [options]',
    summary: 'Verbatim, timestamped transcript that flags glitches (paid; for QA).',
    options: TRANSCRIBE_OPTIONS,
  });
}
