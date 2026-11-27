import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  type ExecFileFn,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  type OptionSpec,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/index.js';

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
export const CLOUD_TTS_API = 'https://texttospeech.googleapis.com/v1/text:synthesize';
export const DEFAULT_BACKEND = 'chirp3-hd';
export const DEFAULT_LANGUAGE = 'en-US';
export const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_TEXT_MODEL = 'gemini-4-hydrogen';
export const CHIRP_MAX_BYTES = 4500;
export const NOTES_MARKER = "# EDITOR'S NOTES";

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
] as const;

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const;

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'] as const;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface ChirpPronunciation {
  readonly phrase: string;
  readonly phoneticEncoding: 'PHONETIC_ENCODING_IPA';
  readonly pronunciation: string;
}

export interface NarrativeRecord {
  readonly id: string;
  readonly slug?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly body_md?: string;
}

export interface ScriptLintResult {
  readonly sections: readonly string[];
  readonly notes: readonly string[];
  readonly wordCount: number;
  readonly problems: readonly string[];
}

export interface WavStripResult {
  readonly pcm: Buffer;
  readonly sampleRate: number;
}

interface SynthChunk {
  readonly text: string;
  readonly voice: string;
  readonly pauseBefore: number;
  readonly isNotes: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

export function ordinal(n: number): string {
  if (n >= 1 && n <= 20) {
    return ORDINALS[n - 1];
  }
  if (n === 30) {
    return 'thirtieth';
  }
  if (n > 20 && n < 30) {
    return `twenty-${ORDINALS[(n % 10) - 1]}`;
  }
  if (n > 30 && n <= 39) {
    return `thirty-${ORDINALS[(n % 10) - 1]}`;
  }
  return String(n);
}

export function speakDates(text: string): string {
  const dayBeforeMonth = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)? (${MONTHS})(,? (\\d{4}))?\\b`, 'g');
  const step1 = text.replace(
    dayBeforeMonth,
    (_match, dayStr: string, month: string, _yearClause: string | undefined, year: string | undefined) => {
      const spoken = `${month} ${ordinal(Number.parseInt(dayStr, 10))}`;
      return year ? `${spoken}, ${year}` : spoken;
    }
  );
  const monthBeforeDay = new RegExp(`\\b(${MONTHS}) (\\d{1,2})(?:st|nd|rd|th)?\\b`, 'g');
  return step1.replace(
    monthBeforeDay,
    (_match, month: string, dayStr: string) => `${month} ${ordinal(Number.parseInt(dayStr, 10))}`
  );
}

export function intToWords(n: number): string {
  if (n < 0) {
    return `minus ${intToWords(-n)}`;
  }
  if (n < 20) {
    return ONES[n];
  }
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r === 0 ? TENS[t] : `${TENS[t]}-${ONES[r]}`;
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return r === 0 ? `${ONES[h]} hundred` : `${ONES[h]} hundred ${intToWords(r)}`;
  }
  const scales: readonly (readonly [number, string])[] = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ];
  for (const [scaleVal, scaleName] of scales) {
    if (n >= scaleVal) {
      const q = Math.floor(n / scaleVal);
      const r = n % scaleVal;
      const head = `${intToWords(q)} ${scaleName}`;
      return r === 0 ? head : `${head} ${intToWords(r)}`;
    }
  }
  return String(n);
}

export function speakNumbers(text: string): string {
  const step1 = text.replace(/\bU\.S\.(?=\s|$)/g, 'United States');
  const step2 = step1.replace(/\bNo\.\s*(?=\d)/g, 'number ');
  return step2.replace(/\b\d{1,3}(?:,\d{3})+\b/g, (match) =>
    intToWords(Number.parseInt(match.replaceAll(',', ''), 10))
  );
}

export function applyNames(text: string, names: Readonly<Record<string, string>>): string {
  let out = text;
  const entries = Object.entries(names).sort((a, b) => b[0].length - a[0].length);
  for (const [name, ipa] of entries) {
    const rx = new RegExp(`(?<![\\w/])${escapeRegExp(name)}(?![\\w/])`, 'g');
    out = out.replace(rx, () => ipa);
  }
  return out;
}

export function buildChirpPronunciations(
  text: string,
  names: Readonly<Record<string, string>>
): ChirpPronunciation[] {
  const entries: ChirpPronunciation[] = [];
  const sorted = Object.entries(names).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, ipa] of sorted) {
    const rx = new RegExp(`(?<!\\w)${escapeRegExp(phrase)}(?!\\w)`);
    if (rx.test(text)) {
      const cleanedIpa = ipa.trim().replace(/^\/+|\/+$/g, '');
      entries.push({
        phrase,
        phoneticEncoding: 'PHONETIC_ENCODING_IPA',
        pronunciation: cleanedIpa,
      });
    }
  }
  return entries;
}

export function resolveChirpVoice(voice: string, languageCode: string): string {
  if (voice.includes('-')) {
    return voice;
  }
  return `${languageCode}-Chirp3-HD-${voice}`;
}

export function splitToByteLimit(text: string, maxBytes = CHIRP_MAX_BYTES): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return [text];
  }
  const parts: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  const paragraphs = text
    .split('\n\n')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  for (const para of paragraphs) {
    const paraBytes = Buffer.byteLength(para, 'utf8');
    if (current.length > 0 && currentBytes + paraBytes + 2 > maxBytes) {
      parts.push(current.join('\n\n'));
      current = [para];
      currentBytes = paraBytes;
    } else {
      current.push(para);
      currentBytes += paraBytes + (current.length > 1 ? 2 : 0);
    }
  }
  if (current.length > 0) {
    parts.push(current.join('\n\n'));
  }
  return parts;
}

export function splitScript(script: string): {
  readonly sections: string[];
  readonly notes: string[];
} {
  const markerIdx = script.indexOf(NOTES_MARKER);
  const story = markerIdx === -1 ? script : script.slice(0, markerIdx);
  const notesRaw = markerIdx === -1 ? '' : script.slice(markerIdx + NOTES_MARKER.length);

  const sections = story
    .split(/(?=^## )/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^##\s*(.+)$/m, '$1.'));

  const notes = notesRaw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0);

  return { sections, notes };
}

export function stripWavHeader(raw: Uint8Array, defaultRate = 24000): WavStripResult {
  if (raw.byteLength < 12) {
    return { pcm: Buffer.from(raw), sampleRate: defaultRate };
  }
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { pcm: Buffer.from(buf), sampleRate: defaultRate };
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sampleRate = defaultRate;
  let pcm: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(buf.byteLength, dataStart + chunkSize);

    if (chunkId === 'fmt ' && chunkSize >= 16 && dataStart + 8 <= buf.byteLength) {
      const parsedRate = view.getUint32(dataStart + 4, true);
      if (parsedRate > 0) {
        sampleRate = parsedRate;
      }
    } else if (chunkId === 'data') {
      pcm = Buffer.from(buf.subarray(dataStart, dataEnd));
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return {
    pcm: pcm ?? Buffer.from(buf),
    sampleRate,
  };
}

export function loadNarratives(filePath: string): NarrativeRecord[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed: unknown = parseYaml(raw);
  let list: unknown[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isPlainRecord(parsed) && Array.isArray(parsed.narratives)) {
    list = parsed.narratives;
  } else {
    list = [];
  }
  return list
    .filter((item): item is Record<string, unknown> => isPlainRecord(item) && typeof item.id === 'string')
    .map((item) => ({
      id: item.id as string,
      slug: typeof item.slug === 'string' ? item.slug : undefined,
      title: typeof item.title === 'string' ? item.title : undefined,
      kind: typeof item.kind === 'string' ? item.kind : undefined,
      body_md: typeof item.body_md === 'string' ? item.body_md : undefined,
    }));
}

export function lintNarrativeScript(
  scriptLabel: string,
  text: string,
  names?: Readonly<Record<string, string>>
): ScriptLintResult {
  const problems: string[] = [];
  const patterns: readonly (readonly [string, RegExp])[] = [
    ["day-before-month date (write 'May ninth, 1766')", new RegExp(`\\b\\d{1,2} (${MONTHS})\\b`)],
    ["numeric month-day date (write 'May ninth')", new RegExp(`\\b(${MONTHS}) \\d{1,2}\\b(?!\\d)`)],
    ["currency symbol (write '470 pounds')", /[£$]/],
    ['s./d. money abbreviation', /\b\d+[sd]\./],
    ['citation remnant', /\b(Lib\.|Vol\.|pp?\.\s*\d|DB \d|FHL|Book \d+)/],
    ["slash (write 'or')", /\S\/\S/],
    ['comma-grouped number (Chirp pauses on commas; spell out in words)', /\b\d{1,3}(?:,\d{3})+\b/],
    ['abbreviation to spell out', /\b(ca\.|b\.|d\.|decd|Co\.|Jr\.|Sr\.|Capt\.|U\.S\.|No\.)(?=\s|$)/],
    ['markdown emphasis or link', /[*_`]|\]\(/],
    ['quotation mark', /["\u201c\u201d]/],
  ];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [label, rx] of patterns) {
      if (rx.test(line)) {
        problems.push(`${scriptLabel}:${i + 1}: ${label}: ${line.trim().slice(0, 100)}`);
      }
    }
  }

  if (!text.includes(NOTES_MARKER)) {
    problems.push(`no '${NOTES_MARKER}' section (fine only if there are no notes)`);
  }

  if (names) {
    for (const [k, v] of Object.entries(names)) {
      const rx = new RegExp(`(?<!\\w)${escapeRegExp(k)}(?!\\w)`);
      if (!rx.test(text)) {
        problems.push(`names: '${k}' does not appear in the script`);
      }
      if (!(v.startsWith('/') && v.endsWith('/'))) {
        problems.push(`names: '${k}' value is not /IPA/ in slashes: ${v}`);
      }
    }
  }

  const { sections, notes } = splitScript(text);
  return {
    sections,
    notes,
    wordCount: countWords(text),
    problems,
  };
}

export function formatYamlSnippet(options: {
  readonly fileName: string;
  readonly durationSeconds: number;
  readonly editorNotesStartSeconds?: number;
  readonly storyVoice: string;
  readonly notesVoice: string;
}): string {
  const lines = [
    '# Kinloom narratives.yaml snippet:',
    'extensions:',
    '  narrative_audio:',
    `    file: media/${options.fileName}`,
    `    duration_seconds: ${Math.round(options.durationSeconds)}`,
  ];
  if (options.editorNotesStartSeconds !== undefined) {
    lines.push(`    editor_notes_start_seconds: ${Math.round(options.editorNotesStartSeconds)}`);
  }
  lines.push(`    story_voice: ${options.storyVoice}`);
  lines.push(`    notes_voice: ${options.notesVoice}`);
  return lines.join('\n');
}

function defaultExecFile(
  file: string,
  args: readonly string[],
  options?: Parameters<ExecFileFn>[2]
): ReturnType<ExecFileFn> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) {
        const enriched = error as Error & { stdout?: Buffer; stderr?: Buffer };
        enriched.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        enriched.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
        reject(enriched);
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
        stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
      });
    });
  });
}

function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
}

function resolvePath(rawPath: string, ctx: RecordCommandContext): string {
  const expanded = expandHomePath(rawPath, ctx.env);
  return path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
}

function requireExistingFile(rawPath: string, label: string, ctx: RecordCommandContext): string {
  const abs = resolvePath(rawPath, ctx);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new CliValidationError(`${label} not found: ${rawPath}`);
  }
  return abs;
}

function defaultMp3Path(scriptPath: string): string {
  const dir = path.dirname(scriptPath);
  const ext1 = path.extname(scriptPath);
  let base = ext1 ? path.basename(scriptPath, ext1) : path.basename(scriptPath);
  const ext2 = path.extname(base);
  if (ext2) {
    base = path.basename(base, ext2);
  }
  return path.join(dir, `${base}.mp3`);
}

function defaultTranscriptPath(audioPath: string): string {
  const dir = path.dirname(audioPath);
  const ext = path.extname(audioPath);
  const base = ext ? path.basename(audioPath, ext) : path.basename(audioPath);
  return path.join(dir, `${base}.transcript.md`);
}

function resolveGeminiApiKey(keyFile: string | undefined, ctx: RecordCommandContext): string {
  if (keyFile) {
    const abs = resolvePath(keyFile, ctx);
    return fs.readFileSync(abs, 'utf8').trim();
  }
  const key = (ctx.env.GEMINI_API_KEY ?? ctx.env.GOOGLE_API_KEY ?? '').trim();
  if (!key) {
    throw new RecordRuntimeError('Set GEMINI_API_KEY (or GOOGLE_API_KEY), or pass --key-file.');
  }
  return key;
}

async function resolveCloudTtsHeaders(
  gcpProject: string | undefined,
  keyFile: string | undefined,
  ctx: RecordCommandContext
): Promise<Record<string, string>> {
  if (keyFile) {
    const abs = resolvePath(keyFile, ctx);
    return { 'x-goog-api-key': fs.readFileSync(abs, 'utf8').trim() };
  }
  const envKey = (ctx.env.GOOGLE_CLOUD_TTS_API_KEY ?? '').trim();
  if (envKey) {
    return { 'x-goog-api-key': envKey };
  }

  const execFn = ctx.execFileImpl ?? defaultExecFile;
  const hasGcloud = ctx.execFileImpl !== undefined || findExecutableOnPath('gcloud', ctx.env) !== null;

  let token = (ctx.env.GOOGLE_CLOUD_ACCESS_TOKEN ?? '').trim();
  if (!token) {
    if (!hasGcloud) {
      throw new RecordRuntimeError(
        'gcloud not found on PATH; install gcloud or set GOOGLE_CLOUD_TTS_API_KEY / --key-file.'
      );
    }
    try {
      const res = await execFn('gcloud', ['auth', 'print-access-token'], { env: ctx.env });
      token = res.stdout.toString('utf8').trim();
    } catch (err: unknown) {
      const detail =
        isPlainRecord(err) && Buffer.isBuffer(err.stderr)
          ? err.stderr.toString('utf8').trim()
          : err instanceof Error
            ? err.message
            : '';
      throw new RecordRuntimeError(`Failed to get gcloud access token: ${detail || 'run gcloud auth login'}`);
    }
    if (!token) {
      throw new RecordRuntimeError('Failed to get gcloud access token: run gcloud auth login');
    }
  }

  let project =
    (gcpProject ?? '').trim() ||
    (ctx.env.GOOGLE_CLOUD_PROJECT ?? '').trim() ||
    (ctx.env.GCP_PROJECT ?? '').trim();

  if (!project && hasGcloud) {
    try {
      const res = await execFn('gcloud', ['config', 'get-value', 'project'], { env: ctx.env });
      const val = res.stdout.toString('utf8').trim();
      if (val && val !== '(unset)') {
        project = val;
      }
    } catch {
      // Optional billing quota project header.
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (project) {
    headers['x-goog-user-project'] = project;
  }
  return headers;
}

async function postJsonWithRetries(params: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly label: string;
  readonly ctx: RecordCommandContext;
  readonly retries?: number;
}): Promise<Record<string, unknown>> {
  const retries = params.retries ?? 3;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await params.ctx.fetchImpl(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...params.headers,
      },
      body: JSON.stringify(params.body),
    });
    if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
      await params.ctx.sleepFn(5000 * (attempt + 1));
      continue;
    }
    const text = await response.text();
    if (response.status !== 200) {
      throw new RecordRuntimeError(`${params.label}: HTTP ${response.status}: ${text.slice(0, 800)}`);
    }
    const parsed: unknown = JSON.parse(text);
    if (!isPlainRecord(parsed)) {
      throw new RecordRuntimeError(`${params.label}: unexpected non-object JSON response`);
    }
    return parsed;
  }
  throw new RecordRuntimeError(`${params.label}: request failed after retries`);
}

function readNamesJson(namesPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
  if (!isPlainRecord(parsed)) {
    throw new CliValidationError(`Names file must be a JSON object: ${namesPath}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new CliValidationError(`Names entry '${k}' must map to an IPA string.`);
    }
    out[k] = v;
  }
  return out;
}

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

const LIST_PARSE_SPEC: CommandParseSpec = {
  options: LIST_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'narratives_yaml',
};

const EXTRACT_PARSE_SPEC: CommandParseSpec = {
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

const CHECK_PARSE_SPEC: CommandParseSpec = {
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

const SYNTH_PARSE_SPEC: CommandParseSpec = {
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

const TRANSCRIBE_PARSE_SPEC: CommandParseSpec = {
  options: TRANSCRIBE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'audio',
};

function renderRootHelp(): string {
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

function runList(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, LIST_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom narrative-audio list <narratives_yaml> [options]',
          summary: 'List narratives (word count, id, title), shortest first.',
          options: LIST_OPTIONS,
        })
      ),
    };
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

function runExtract(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, EXTRACT_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom narrative-audio extract <narratives_yaml> <narrative_id>',
          summary: "Print one narrative's slug, title and body_md (input for the script writer).",
        })
      ),
    };
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

function runCheck(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const parsed = parseCommandArgs(argv, CHECK_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom narrative-audio check <script> [options]',
          summary: 'Lint a spoken script (and names file) before paying for synthesis.',
          options: CHECK_OPTIONS,
        })
      ),
    };
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

async function runSynth(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, SYNTH_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom narrative-audio synth <script> [options]',
          summary: "Synthesize SCRIPT to MP3 (story voice, then editor's notes voice).",
          options: SYNTH_OPTIONS,
        })
      ),
    };
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
  if (rawBackend !== 'chirp3-hd' && rawBackend !== 'gemini') {
    throw new CliValidationError(`Invalid --backend '${rawBackend}': choose from chirp3-hd, gemini.`);
  }
  const backend: 'chirp3-hd' | 'gemini' = rawBackend;

  const languageCode = (
    getStringOption(parsed, 'languageCode') ??
    ctx.env.NARRATIVE_AUDIO_LANGUAGE ??
    DEFAULT_LANGUAGE
  ).trim();
  const gcpProject = getStringOption(parsed, 'gcpProject');
  const model = getStringOption(parsed, 'model') ?? DEFAULT_TTS_MODEL;
  const voice = getStringOption(parsed, 'voice') ?? 'Charon';
  const notesVoice = getStringOption(parsed, 'notesVoice') ?? 'Kore';
  const sectionPause = getNumberOption(parsed, 'sectionPause') ?? 0.8;
  const notesPause = getNumberOption(parsed, 'notesPause') ?? 2.0;
  const bitrate = getStringOption(parsed, 'bitrate') ?? '96k';
  const keyFile = getStringOption(parsed, 'keyFile');
  const outArg = getStringOption(parsed, 'out');
  const dryRun = getBooleanOption(parsed, 'dryRun');

  const rawText = fs.readFileSync(scriptPath, 'utf8');
  const withNames =
    backend === 'gemini' && Object.keys(namesMap).length > 0 ? applyNames(rawText, namesMap) : rawText;
  const prepared = speakNumbers(speakDates(withNames));
  const { sections, notes } = splitScript(prepared);

  const chunks: SynthChunk[] = [];
  for (const section of sections) {
    const subChunks = backend === 'chirp3-hd' ? splitToByteLimit(section) : [section];
    for (let idx = 0; idx < subChunks.length; idx += 1) {
      chunks.push({
        text: subChunks[idx],
        voice,
        pauseBefore: idx === 0 ? sectionPause : 0.4,
        isNotes: false,
      });
    }
  }
  if (notes.length > 0) {
    const notesBody = `Editor's notes.\n\n${notes.join('\n\n')}`;
    const subNotes = backend === 'chirp3-hd' ? splitToByteLimit(notesBody) : [notesBody];
    for (let idx = 0; idx < subNotes.length; idx += 1) {
      chunks.push({
        text: subNotes[idx],
        voice: notesVoice,
        pauseBefore: idx === 0 ? notesPause : 0.4,
        isNotes: true,
      });
    }
  }

  if (dryRun) {
    const outLines: string[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const label =
        backend === 'chirp3-hd' ? resolveChirpVoice(chunk.voice, languageCode) : `${model}:${chunk.voice}`;
      const notesSuffix = chunk.isNotes ? ' · notes' : '';
      outLines.push(`===== request ${i + 1} [${backend} · ${label}${notesSuffix}] =====`);
      outLines.push(chunk.text);
      if (backend === 'chirp3-hd' && Object.keys(namesMap).length > 0) {
        const prons = buildChirpPronunciations(chunk.text, namesMap);
        if (prons.length > 0) {
          outLines.push(`  customPronunciations: ${JSON.stringify(prons)}`);
        }
      }
      outLines.push('');
    }
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, outLines.join('\n')) };
  }

  if (ctx.execFileImpl === undefined && findExecutableOnPath('ffmpeg', ctx.env) === null) {
    throw new RecordRuntimeError('ffmpeg not found on PATH');
  }

  const outPath = outArg ? resolvePath(outArg, ctx) : defaultMp3Path(scriptPath);
  const pcmParts: Buffer[] = [];
  let pcmLength = 0;
  let rate = 24000;
  let totalTokens = 0;
  let totalChars = 0;
  let notesStartSec: number | undefined;

  if (backend === 'chirp3-hd') {
    const headers = await resolveCloudTtsHeaders(gcpProject, keyFile, ctx);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const resolvedVoice = resolveChirpVoice(chunk.voice, languageCode);
      const inputObj: Record<string, unknown> = { text: chunk.text };
      if (Object.keys(namesMap).length > 0) {
        const prons = buildChirpPronunciations(chunk.text, namesMap);
        if (prons.length > 0) {
          inputObj.customPronunciations = { pronunciations: prons };
        }
      }
      const payload = {
        input: inputObj,
        voice: { languageCode, name: resolvedVoice },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
      };
      const resp = await postJsonWithRetries({
        url: CLOUD_TTS_API,
        headers,
        body: payload,
        label: 'cloud-tts',
        ctx,
      });
      if (typeof resp.audioContent !== 'string') {
        throw new RecordRuntimeError('cloud-tts response missing audioContent');
      }
      const decoded = Buffer.from(resp.audioContent, 'base64');
      const stripped = stripWavHeader(decoded, 24000);
      rate = stripped.sampleRate;
      if (pcmLength > 0) {
        const silenceSamples = Math.trunc(rate * chunk.pauseBefore);
        const silence = Buffer.alloc(silenceSamples * 2);
        pcmParts.push(silence);
        pcmLength += silence.length;
      }
      if (chunk.isNotes && notesStartSec === undefined) {
        notesStartSec = pcmLength / 2 / rate;
      }
      pcmParts.push(stripped.pcm);
      pcmLength += stripped.pcm.length;
      totalChars += chunk.text.length;
      ctx.io.stderr(
        `  section ${i + 1}/${chunks.length} [${resolvedVoice}]: ${countWords(chunk.text)} words, ` +
          `${(stripped.pcm.length / 2 / rate).toFixed(1)}s, ${chunk.text.length} chars`
      );
    }
  } else {
    const key = resolveGeminiApiKey(keyFile, ctx);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const resp = await postJsonWithRetries({
        url: `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
        headers: { 'x-goog-api-key': key },
        body: {
          contents: [{ parts: [{ text: chunk.text }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: chunk.voice } },
            },
          },
        },
        label: model,
        ctx,
      });

      const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
      const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
      const content = firstCand && isPlainRecord(firstCand.content) ? firstCand.content : undefined;
      const parts = content && Array.isArray(content.parts) ? content.parts : [];
      const firstPart = isPlainRecord(parts[0]) ? parts[0] : undefined;
      const inlineData = firstPart && isPlainRecord(firstPart.inlineData) ? firstPart.inlineData : undefined;
      if (!inlineData || typeof inlineData.data !== 'string') {
        throw new RecordRuntimeError(`${model}: response missing inline audio data`);
      }

      const decoded = Buffer.from(inlineData.data, 'base64');
      let chunkPcm: Buffer;
      if (decoded.length >= 4 && decoded.toString('ascii', 0, 4) === 'RIFF') {
        const stripped = stripWavHeader(decoded, rate);
        chunkPcm = stripped.pcm;
        rate = stripped.sampleRate;
      } else {
        chunkPcm = decoded;
        const mimeType = typeof inlineData.mimeType === 'string' ? inlineData.mimeType : '';
        const rateMatch = /rate=(\d+)/.exec(mimeType);
        if (rateMatch) {
          rate = Number.parseInt(rateMatch[1], 10);
        }
      }

      if (pcmLength > 0) {
        const silenceSamples = Math.trunc(rate * chunk.pauseBefore);
        const silence = Buffer.alloc(silenceSamples * 2);
        pcmParts.push(silence);
        pcmLength += silence.length;
      }
      if (chunk.isNotes && notesStartSec === undefined) {
        notesStartSec = pcmLength / 2 / rate;
      }
      pcmParts.push(chunkPcm);
      pcmLength += chunkPcm.length;

      const usage = isPlainRecord(resp.usageMetadata) ? resp.usageMetadata : {};
      const tokens = typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : 0;
      totalTokens += tokens;
      ctx.io.stderr(
        `  section ${i + 1}/${chunks.length} [${chunk.voice}]: ${countWords(chunk.text)} words, ` +
          `${(chunkPcm.length / 2 / rate).toFixed(1)}s, ${tokens} tokens`
      );
    }
  }

  const combinedPcm = Buffer.concat(pcmParts);
  const tmpPcmPath = path.join(
    os.tmpdir(),
    `kinloom-narrative-audio-${process.pid}-${process.hrtime.bigint()}.pcm`
  );
  const execFn = ctx.execFileImpl ?? defaultExecFile;
  try {
    fs.writeFileSync(tmpPcmPath, combinedPcm);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await execFn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        String(rate),
        '-ac',
        '1',
        '-i',
        tmpPcmPath,
        '-b:a',
        bitrate,
        outPath,
      ],
      { env: ctx.env }
    );
  } catch (err: unknown) {
    if (isPlainRecord(err) && err.code === 'ENOENT') {
      throw new RecordRuntimeError('ffmpeg not found on PATH');
    }
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmpPcmPath);
    } catch {
      // Best-effort temp cleanup.
    }
  }

  const totalSec = combinedPcm.length / 2 / rate;
  const usageStr = backend === 'chirp3-hd' ? `${totalChars} chars` : `${totalTokens} tokens`;
  const summaryLine = `wrote ${outPath} (${totalSec.toFixed(1)}s / ${(totalSec / 60).toFixed(1)} min, ${backend}, ${usageStr})`;
  const snippet = formatYamlSnippet({
    fileName: path.basename(outPath),
    durationSeconds: totalSec,
    editorNotesStartSeconds: notesStartSec,
    storyVoice: voice,
    notesVoice,
  });

  const bytesOut = emitStdout(ctx.io, `${summaryLine}\n\n${snippet}`);
  return { exitCode: 0, bytesOut };
}

async function runTranscribe(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, TRANSCRIBE_PARSE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom narrative-audio transcribe <audio> [options]',
          summary: 'Verbatim, timestamped transcript that flags glitches (paid; for QA).',
          options: TRANSCRIBE_OPTIONS,
        })
      ),
    };
  }

  const audioPath = requireExistingFile(parsed.positionals[0], 'audio file', ctx);
  const model = getStringOption(parsed, 'model') ?? DEFAULT_TEXT_MODEL;
  const keyFile = getStringOption(parsed, 'keyFile');
  const outArg = getStringOption(parsed, 'out');
  const key = resolveGeminiApiKey(keyFile, ctx);

  const ext = path.extname(audioPath).toLowerCase();
  const mime = ext === '.wav' ? 'audio/wav' : ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';

  const prompt =
    'Transcribe this audio VERBATIM with [mm:ss] timestamps at the start of each ' +
    'sentence. Write exactly what is spoken, including mistakes, repetitions and ' +
    'mispronunciations (note them in [brackets]), and any non-speech sounds such as ' +
    'clicks, noise bursts, garbled audio, long silences, or abrupt cuts. If any ' +
    'phonetic symbols or slashes are read out literally, mark them [read IPA aloud]. ' +
    'Do not correct or clean up anything.';

  const audioBase64 = fs.readFileSync(audioPath).toString('base64');
  const resp = await postJsonWithRetries({
    url: `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
    headers: { 'x-goog-api-key': key },
    body: {
      contents: [
        {
          parts: [{ inlineData: { mimeType: mime, data: audioBase64 } }, { text: prompt }],
        },
      ],
    },
    label: model,
    ctx,
  });

  const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
  const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
  const content = firstCand && isPlainRecord(firstCand.content) ? firstCand.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  const text = parts.map((p) => (isPlainRecord(p) && typeof p.text === 'string' ? p.text : '')).join('');

  const outPath = outArg ? resolvePath(outArg, ctx) : defaultTranscriptPath(audioPath);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, 'utf8');

  const bytesOut = emitStdout(ctx.io, text);
  ctx.io.stderr(`\nwrote ${outPath}`);
  return { exitCode: 0, bytesOut };
}

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
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
