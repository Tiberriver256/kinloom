import fs from 'node:fs';
import path from 'node:path';
import {
  getCurrentReferenceYear,
  type KinloomSiteConfig,
  type Narrative,
  type RawPerson,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { CliValidationError } from '../../../../errors.js';
import type { PhonemeMode, PhonemeTermHint } from '../../../ops/shared/audio/index.js';
import {
  detectLivingPronunciationLeaks,
  loadArchivePronunciationLexicon,
} from '../../../ops/shared/pronunciation/index.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import { NOTES_MARKER, type SynthChunk, speakDates, speakNumbers, type TtsBackend } from './script.js';

export interface NarrativeBatchManifestItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly target_file: string;
  readonly public_url: string;
  readonly script: string;
  readonly chunks: readonly SynthChunk[];
}

export interface NarrativeBatchManifest {
  readonly version: 1;
  readonly kind: 'kinloom-narrative-audio-manifest';
  readonly generated_at: string;
  readonly backend: TtsBackend;
  readonly model: string;
  readonly voice: string;
  readonly notes_voice: string;
  readonly phoneme_mode: PhonemeMode;
  readonly section_pause: number;
  readonly notes_pause: number;
  readonly living_skipped: number;
  readonly narratives: readonly NarrativeBatchManifestItem[];
}

export interface ImportedAudioMeta {
  readonly duration_seconds?: number;
  readonly editor_notes_start_seconds?: number;
  readonly story_voice?: string;
  readonly notes_voice?: string;
}

const NOTES_HEADING_RE = /^(?:editor'?s|research|source|archival)\s+notes?\b|^discrepanc(?:y|ies)\b/i;

function stripMarkdownToSpoken(raw: string): string {
  return raw
    .replace(/\(\s*(?:\[(?:src|med|per|evt|plc)_[A-Za-z0-9_-]+\](?:\s*[,;]\s*)?)+\)/g, '')
    .replace(
      /\[(?:src|med|per|evt|plc)_[A-Za-z0-9_-]+(?:\s*,\s*(?:src|med|per|evt|plc)_[A-Za-z0-9_-]+)*\]/g,
      ''
    )
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]+/g, '')
    .replace(/["\u201c\u201d]/g, '')
    .replace(/\bca\.\s*/gi, 'about ')
    .replace(/\bb\.\s*(?=\d)/g, 'born ')
    .replace(/\bd\.\s*(?=\d)/g, 'died ')
    .replace(/\bJr\.(?=\s|$|[.,;])/g, 'Junior')
    .replace(/\bSr\.(?=\s|$|[.,;])/g, 'Senior')
    .replace(/\bCapt\.(?=\s)/g, 'Captain')
    .replace(/\s+([.,;!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function narrativeMarkdownToSpokenScript(bodyMd: string, title?: string): string {
  const cleanedLines = bodyMd.split(/\r?\n/);
  const storyBlocks: string[] = [];
  const noteLines: string[] = [];
  let inNotesSection = false;
  let currentBlock: string[] = [];

  const flushBlock = (): void => {
    const joined = currentBlock.join('\n').trim();
    currentBlock = [];
    if (!joined) {
      return;
    }
    if (inNotesSection) {
      for (const line of joined.split(/\n+/)) {
        const stripped = stripMarkdownToSpoken(line.replace(/^\s*[-*]\s*/, ''));
        if (stripped) {
          noteLines.push(`- ${stripped}`);
        }
      }
    } else {
      const cleaned = joined
        .split(/\n+/)
        .map((line) => (line.startsWith('## ') ? line : stripMarkdownToSpoken(line)))
        .filter((line) => line.length > 0)
        .join('\n');
      if (cleaned) {
        storyBlocks.push(cleaned);
      }
    }
  };

  for (const rawLine of cleanedLines) {
    const headingMatch = /^#{1,3}\s+(.+)$/.exec(rawLine.trim());
    if (headingMatch) {
      flushBlock();
      const headingText = stripMarkdownToSpoken(headingMatch[1]);
      if (NOTES_HEADING_RE.test(headingText)) {
        inNotesSection = true;
      } else {
        inNotesSection = false;
        if (headingText) {
          currentBlock.push(`## ${headingText}`);
        }
      }
      continue;
    }
    if (rawLine.trim() === '') {
      flushBlock();
      continue;
    }
    currentBlock.push(rawLine.trim());
  }
  flushBlock();

  if (storyBlocks.length === 0 && title?.trim()) {
    storyBlocks.push(`## ${stripMarkdownToSpoken(title)}`);
  }

  const storyText = speakNumbers(speakDates(storyBlocks.join('\n\n')));
  if (noteLines.length === 0) {
    return storyText;
  }
  const notesText = speakNumbers(speakDates(noteLines.join('\n')));
  return `${storyText}\n\n${NOTES_MARKER}\n${notesText}`;
}

export function collectArchiveLexiconHints(
  repoDir: string,
  siteConfig: KinloomSiteConfig,
  people: readonly RawPerson[]
): Record<string, PhonemeTermHint> {
  const lexicon = loadArchivePronunciationLexicon(repoDir, siteConfig.pronunciations);
  const lexiconLowerKeys = new Map<string, string>();
  for (const key of Object.keys(lexicon)) {
    lexiconLowerKeys.set(key.trim().toLowerCase(), key);
  }

  const deceasedPeople: RawPerson[] = [];
  const livingPeople: Array<{ index: number; person: RawPerson }> = [];
  const referenceYear = siteConfig.privacy.referenceYear ?? getCurrentReferenceYear();
  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy, referenceYear)
    ) {
      livingPeople.push({ index: i + 1, person });
      continue;
    }
    deceasedPeople.push(person);
  }

  const leaks = detectLivingPronunciationLeaks(livingPeople, deceasedPeople, lexiconLowerKeys);
  if (leaks.length > 0) {
    throw new CliValidationError(
      `Privacy fence blocked narrative audio batch: found ${leaks.length} living-person pronunciation leak(s). Run \`kinloom pronounce audit\` first.`
    );
  }

  const hints: Record<string, PhonemeTermHint> = {};
  for (const [term, entry] of Object.entries(lexicon)) {
    if (entry.ipa?.trim() || entry.phonetic?.trim()) {
      hints[term] = {
        text: term,
        ipa: entry.ipa,
        phonetic: entry.phonetic,
      };
    }
  }
  return hints;
}

export function hasExistingNarrativeAudio(narrative: Narrative): boolean {
  const ext = narrative.extensions;
  if (!ext || !isPlainRecord(ext)) {
    return false;
  }
  const raw = ext['narrative_audio'] ?? ext['audio'];
  return isPlainRecord(raw) && typeof raw['file'] === 'string' && raw['file'].trim().length > 0;
}

function parseMetaRecord(raw: unknown): ImportedAudioMeta | undefined {
  if (!isPlainRecord(raw)) {
    return undefined;
  }
  return {
    duration_seconds:
      typeof raw['duration_seconds'] === 'number' && Number.isFinite(raw['duration_seconds'])
        ? raw['duration_seconds']
        : undefined,
    editor_notes_start_seconds:
      typeof raw['editor_notes_start_seconds'] === 'number' && Number.isFinite(raw['editor_notes_start_seconds'])
        ? raw['editor_notes_start_seconds']
        : undefined,
    story_voice:
      typeof raw['story_voice'] === 'string' && raw['story_voice'].trim() ? raw['story_voice'].trim() : undefined,
    notes_voice:
      typeof raw['notes_voice'] === 'string' && raw['notes_voice'].trim() ? raw['notes_voice'].trim() : undefined,
  };
}

export function loadImportMetaMap(importDir: string): Map<string, ImportedAudioMeta> {
  const map = new Map<string, ImportedAudioMeta>();
  const resultsPath = path.join(importDir, 'manifest-results.json');
  if (!fs.existsSync(resultsPath)) {
    return map;
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      if (!isPlainRecord(item)) {
        continue;
      }
      const meta = parseMetaRecord(item);
      if (!meta) {
        continue;
      }
      if (typeof item['id'] === 'string') {
        map.set(item['id'], meta);
      }
      if (typeof item['slug'] === 'string') {
        map.set(item['slug'], meta);
      }
    }
  } else if (isPlainRecord(parsed)) {
    for (const [k, v] of Object.entries(parsed)) {
      const meta = parseMetaRecord(v);
      if (meta) {
        map.set(k, meta);
      }
    }
  }
  return map;
}

export function readSingleImportMeta(importDir: string, slug: string): ImportedAudioMeta | undefined {
  for (const name of [`audio-${slug}.meta.json`, `${slug}.meta.json`]) {
    const candidate = path.join(importDir, name);
    if (fs.existsSync(candidate)) {
      return parseMetaRecord(JSON.parse(fs.readFileSync(candidate, 'utf8')));
    }
  }
  return undefined;
}

export function withNarrativeAudioExtension(
  narrative: Narrative,
  meta: {
    readonly publicUrl: string;
    readonly durationSeconds?: number;
    readonly editorNotesStartSeconds?: number;
    readonly storyVoice: string;
    readonly notesVoice: string;
  }
): Narrative {
  const audioEntry: Record<string, unknown> = {
    file: meta.publicUrl,
  };
  if (meta.durationSeconds !== undefined) {
    audioEntry['duration_seconds'] = Math.round(meta.durationSeconds);
  }
  if (meta.editorNotesStartSeconds !== undefined) {
    audioEntry['editor_notes_start_seconds'] = Math.round(meta.editorNotesStartSeconds);
  }
  audioEntry['story_voice'] = meta.storyVoice;
  audioEntry['notes_voice'] = meta.notesVoice;

  return {
    ...narrative,
    extensions: {
      ...(narrative.extensions ?? {}),
      narrative_audio: audioEntry,
    },
  };
}
