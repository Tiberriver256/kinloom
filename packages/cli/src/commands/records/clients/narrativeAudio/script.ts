import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  applyPhonemeTags,
  DEFAULT_OPENAI_SPEECH_MODEL,
  type PhonemeMode,
  type PhonemeTermHint,
} from '../../../ops/shared/audio/index.js';
import { isPlainRecord } from '../../runtime/primitives.js';

export { DEFAULT_OPENAI_SPEECH_MODEL, type PhonemeMode, type PhonemeTermHint };

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

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export type TtsBackend = 'chirp3-hd' | 'gemini' | 'openai-speech';
export type NamesHintMap = Readonly<Record<string, string | PhonemeTermHint>>;

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

export interface WavStripResult {
  readonly pcm: Buffer;
  readonly sampleRate: number;
}

export interface SynthChunk {
  readonly text: string;
  readonly voice: string;
  readonly pauseBefore: number;
  readonly isNotes: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countWords(text: string): number {
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

export function applyNames(text: string, names: NamesHintMap): string {
  let out = text;
  const entries = Object.entries(names).sort((a, b) => b[0].length - a[0].length);
  for (const [name, entry] of entries) {
    const replacement =
      typeof entry === 'string' ? entry : entry.ipa?.trim() || entry.phonetic?.trim() || entry.text;
    if (!replacement) {
      continue;
    }
    const rx = new RegExp(`(?<![\\w/])${escapeRegExp(name)}(?![\\w/])`, 'g');
    out = out.replace(rx, () => replacement);
  }
  return out;
}

export function buildChirpPronunciations(text: string, names: NamesHintMap): ChirpPronunciation[] {
  const entries: ChirpPronunciation[] = [];
  const sorted = Object.entries(names).sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, entry] of sorted) {
    const rawIpa = typeof entry === 'string' ? entry : entry.ipa;
    if (!rawIpa?.trim()) {
      continue;
    }
    const rx = new RegExp(`(?<!\\w)${escapeRegExp(phrase)}(?!\\w)`);
    if (rx.test(text)) {
      const cleanedIpa = rawIpa.trim().replace(/^\/+|\/+$/g, '');
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

export function parseNarrativesYaml(rawYaml: string): NarrativeRecord[] {
  const parsed: unknown = parseYaml(rawYaml);
  let list: unknown[];
  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isPlainRecord(parsed) && Array.isArray(parsed['narratives'])) {
    list = parsed['narratives'];
  } else {
    list = [];
  }
  return list
    .filter((item): item is Record<string, unknown> => isPlainRecord(item) && typeof item['id'] === 'string')
    .map((item) => ({
      id: item['id'] as string,
      slug: typeof item['slug'] === 'string' ? item['slug'] : undefined,
      title: typeof item['title'] === 'string' ? item['title'] : undefined,
      kind: typeof item['kind'] === 'string' ? item['kind'] : undefined,
      body_md: typeof item['body_md'] === 'string' ? item['body_md'] : undefined,
    }));
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

export function buildSynthChunks(options: {
  readonly rawText: string;
  readonly backend: TtsBackend;
  readonly namesMap: NamesHintMap;
  readonly phonemeMode?: PhonemeMode;
  readonly voice: string;
  readonly notesVoice: string;
  readonly sectionPause: number;
  readonly notesPause: number;
}): SynthChunk[] {
  const hasNames = Object.keys(options.namesMap).length > 0;
  const withNames = !hasNames
    ? options.rawText
    : options.backend === 'openai-speech'
      ? applyPhonemeTags(options.rawText, options.namesMap, options.phonemeMode ?? 'ipa')
      : options.backend === 'gemini'
        ? options.phonemeMode
          ? applyPhonemeTags(options.rawText, options.namesMap, options.phonemeMode)
          : applyNames(options.rawText, options.namesMap)
        : options.rawText;
  const prepared = speakNumbers(speakDates(withNames));
  const { sections, notes } = splitScript(prepared);

  const chunks: SynthChunk[] = [];
  for (const section of sections) {
    const subChunks = options.backend === 'chirp3-hd' ? splitToByteLimit(section) : [section];
    for (let idx = 0; idx < subChunks.length; idx += 1) {
      chunks.push({
        text: subChunks[idx],
        voice: options.voice,
        pauseBefore: idx === 0 ? options.sectionPause : 0.4,
        isNotes: false,
      });
    }
  }
  if (notes.length > 0) {
    const notesBody = `Editor's notes.\n\n${notes.join('\n\n')}`;
    const subNotes = options.backend === 'chirp3-hd' ? splitToByteLimit(notesBody) : [notesBody];
    for (let idx = 0; idx < subNotes.length; idx += 1) {
      chunks.push({
        text: subNotes[idx],
        voice: options.notesVoice,
        pauseBefore: idx === 0 ? options.notesPause : 0.4,
        isNotes: true,
      });
    }
  }
  return chunks;
}

export function formatDryRunPlan(options: {
  readonly chunks: readonly SynthChunk[];
  readonly backend: TtsBackend;
  readonly languageCode: string;
  readonly model: string;
  readonly namesMap: NamesHintMap;
  readonly endpoint?: string;
  readonly phonemeMode?: PhonemeMode;
}): string {
  const outLines: string[] = [];
  for (let i = 0; i < options.chunks.length; i += 1) {
    const chunk = options.chunks[i];
    const label =
      options.backend === 'chirp3-hd'
        ? resolveChirpVoice(chunk.voice, options.languageCode)
        : `${options.model}:${chunk.voice}`;
    const notesSuffix = chunk.isNotes ? ' · notes' : '';
    const extraSuffix =
      options.backend === 'openai-speech' && options.phonemeMode ? ` · phonemes:${options.phonemeMode}` : '';
    outLines.push(`===== request ${i + 1} [${options.backend} · ${label}${notesSuffix}${extraSuffix}] =====`);
    outLines.push(chunk.text);
    if (options.backend === 'chirp3-hd' && Object.keys(options.namesMap).length > 0) {
      const prons = buildChirpPronunciations(chunk.text, options.namesMap);
      if (prons.length > 0) {
        outLines.push(`  customPronunciations: ${JSON.stringify(prons)}`);
      }
    }
    outLines.push('');
  }
  return outLines.join('\n');
}

export function defaultMp3Path(scriptPath: string): string {
  const ext1 = path.extname(scriptPath);
  let base = ext1 ? path.basename(scriptPath, ext1) : path.basename(scriptPath);
  const ext2 = path.extname(base);
  if (ext2) base = path.basename(base, ext2);
  return path.join(path.dirname(scriptPath), `${base}.mp3`);
}

export function defaultTranscriptPath(audioPath: string): string {
  const ext = path.extname(audioPath);
  const base = ext ? path.basename(audioPath, ext) : path.basename(audioPath);
  return path.join(path.dirname(audioPath), `${base}.transcript.md`);
}

export function inferAudioMimeType(audioPath: string): string {
  const ext = path.extname(audioPath).toLowerCase();
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.ogg') return 'audio/ogg';
  return 'audio/mpeg';
}
