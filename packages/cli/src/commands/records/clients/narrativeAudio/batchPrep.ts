import fs from 'node:fs';
import path from 'node:path';
import {
  getCurrentReferenceYear,
  type KinloomSiteConfig,
  type Narrative,
  parseNarrativesYaml as parseCoreNarrativesYaml,
  parseKinloomConfigYaml,
  parsePeopleYaml,
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
  readonly duration_seconds?: number | undefined;
  readonly editor_notes_start_seconds?: number | undefined;
  readonly story_voice?: string | undefined;
  readonly notes_voice?: string | undefined;
}

export interface LoadedNarrativeArchive {
  readonly siteConfig: KinloomSiteConfig;
  readonly people: readonly RawPerson[];
  readonly allNarratives: readonly Narrative[];
  readonly livingIds: ReadonlySet<string>;
  readonly lexiconHints: Record<string, PhonemeTermHint>;
  readonly narrativesPath: string;
}

export interface CandidateSelectionResult {
  readonly candidates: readonly Narrative[];
  readonly livingSkipped: number;
  readonly alreadyHasAudio: number;
}

export interface BatchSliceRange {
  readonly start: number;
  readonly end?: number | undefined;
}

const NOTES_HEADING_RE = /^(?:editor'?s|research|source|archival)\s+notes?\b|^discrepanc(?:y|ies)\b/i;

function isEnoentError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

export function loadArchiveForNarrativeAudio(repoDir: string): LoadedNarrativeArchive {
  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  const peoplePath = path.join(repoDir, 'data', 'people.yaml');
  const narrativesPath = path.join(repoDir, 'data', 'narratives.yaml');

  let rawConfig: string;
  try {
    rawConfig = fs.readFileSync(configPath, 'utf8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      throw new CliValidationError(`Missing ${configPath} (pass --repo <archive-root>).`);
    }
    throw err;
  }

  let rawNarratives: string;
  try {
    rawNarratives = fs.readFileSync(narrativesPath, 'utf8');
  } catch (err: unknown) {
    if (isEnoentError(err)) {
      throw new CliValidationError(`Missing ${narrativesPath}.`);
    }
    throw err;
  }

  const siteConfig = parseKinloomConfigYaml(rawConfig);
  let people: RawPerson[] = [];
  try {
    people = parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'));
  } catch (err: unknown) {
    if (!isEnoentError(err)) {
      throw err;
    }
  }
  const allNarratives = parseCoreNarrativesYaml(rawNarratives);

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

  const lexiconHints = collectArchiveLexiconHints(repoDir, siteConfig, people);

  return {
    siteConfig,
    people,
    allNarratives,
    livingIds,
    lexiconHints,
    narrativesPath,
  };
}

export function selectNarrativeCandidates(options: {
  readonly allNarratives: readonly Narrative[];
  readonly livingIds: ReadonlySet<string>;
  readonly kindFilter: string;
  readonly force: boolean;
}): CandidateSelectionResult {
  let livingSkipped = 0;
  let alreadyHasAudio = 0;
  const candidates: Narrative[] = [];
  for (const narrative of options.allNarratives) {
    const touchesLiving =
      (narrative.subject_person_id !== undefined && options.livingIds.has(narrative.subject_person_id)) ||
      narrative.person_ids.some((pid) => options.livingIds.has(pid));
    if (touchesLiving) {
      livingSkipped += 1;
      continue;
    }
    if (options.kindFilter && narrative.kind !== options.kindFilter) {
      continue;
    }
    if (!options.force && hasExistingNarrativeAudio(narrative)) {
      alreadyHasAudio += 1;
      continue;
    }
    candidates.push(narrative);
  }
  return { candidates, livingSkipped, alreadyHasAudio };
}

export function parseBatchSlice(raw: string): BatchSliceRange {
  const trimmed = raw.trim();
  const match = /^(\d*):(\d*)$/.exec(trimmed);
  if (!match || (match[1] === '' && match[2] === '')) {
    throw new CliValidationError(
      `Invalid --slice '${raw}': expected <start>:<end> with non-negative integers (e.g. 0:10, 5:, :10).`
    );
  }
  const startRaw = match[1] ?? '';
  const endRaw = match[2] ?? '';
  const start = startRaw.length > 0 ? Number.parseInt(startRaw, 10) : 0;
  const end = endRaw.length > 0 ? Number.parseInt(endRaw, 10) : undefined;
  if (!Number.isSafeInteger(start) || (end !== undefined && !Number.isSafeInteger(end))) {
    throw new CliValidationError(`Invalid --slice '${raw}': slice bounds out of range.`);
  }
  if (end !== undefined && end < start) {
    throw new CliValidationError(
      `Invalid --slice '${raw}': end (${end}) must be greater than or equal to start (${start}).`
    );
  }
  return { start, end };
}

export function hasNonEmptyAudioFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

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
      const headingText = stripMarkdownToSpoken(headingMatch[1] ?? '');
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
    if (person === undefined) continue;
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
      typeof raw['editor_notes_start_seconds'] === 'number' &&
      Number.isFinite(raw['editor_notes_start_seconds'])
        ? raw['editor_notes_start_seconds']
        : undefined,
    story_voice:
      typeof raw['story_voice'] === 'string' && raw['story_voice'].trim()
        ? raw['story_voice'].trim()
        : undefined,
    notes_voice:
      typeof raw['notes_voice'] === 'string' && raw['notes_voice'].trim()
        ? raw['notes_voice'].trim()
        : undefined,
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
    readonly durationSeconds?: number | undefined;
    readonly editorNotesStartSeconds?: number | undefined;
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
