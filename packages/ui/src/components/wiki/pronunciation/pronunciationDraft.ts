import type {
  ArchiveDataSource,
  EntityType,
  PersonPronunciationTokenRole,
  Pronunciation,
} from '@kinloom/core';
import { isArchiveApiError } from '@kinloom/core';

export type PronunciationStringFieldKey =
  | 'phonetic'
  | 'ipa'
  | 'language'
  | 'audio_url'
  | 'note'
  | 'source_label'
  | 'source_url'
  | 'region';

export const PRONUNCIATION_STRING_KEYS: readonly PronunciationStringFieldKey[] = [
  'phonetic',
  'ipa',
  'language',
  'audio_url',
  'note',
  'source_label',
  'source_url',
  'region',
];

export const PRONUNCIATION_ROLE_LABELS: Readonly<Record<PersonPronunciationTokenRole, string>> = {
  given: 'First',
  middle: 'Middle',
  surname: 'Surname',
  suffix: 'Suffix',
};

export const SAFE_EXTERNAL_URL_RE = /^https?:\/\//i;

export interface SharedTokenDraft {
  readonly term: string;
  readonly displayText: string;
  readonly existingShared?: Pronunciation | null;
  phonetic: string;
  ipa: string;
  language: string;
  note: string;
  source_label: string;
  source_url: string;
  region: string;
}

export function readDraftPronunciation(value: unknown): Pronunciation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const out: Pronunciation = {};
  for (const key of PRONUNCIATION_STRING_KEYS) {
    const val = raw[key];
    if (typeof val === 'string' && val.length > 0) {
      out[key] = val;
    }
  }
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    out.variants = raw.variants as Pronunciation['variants'];
  }
  if (typeof raw.match_full_name_contains === 'string' || Array.isArray(raw.match_full_name_contains)) {
    out.match_full_name_contains = raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function cleanPronunciation(value: unknown, trimValues: boolean): Pronunciation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const out: Pronunciation = {};
  let hasAnyNonWhitespace = false;
  for (const key of PRONUNCIATION_STRING_KEYS) {
    const val = raw[key];
    if (typeof val !== 'string') {
      continue;
    }
    const normalized = trimValues ? val.trim() : val;
    if (normalized.length > 0) {
      out[key] = normalized;
      if (normalized.trim().length > 0) {
        hasAnyNonWhitespace = true;
      }
    }
  }
  if (Array.isArray(raw.variants) && raw.variants.length > 0) {
    out.variants = raw.variants as Pronunciation['variants'];
    hasAnyNonWhitespace = true;
  }
  if (typeof raw.match_full_name_contains === 'string' || Array.isArray(raw.match_full_name_contains)) {
    out.match_full_name_contains = raw.match_full_name_contains as Pronunciation['match_full_name_contains'];
  }
  return hasAnyNonWhitespace ? out : null;
}

function formatPortError(err: unknown, fallback: string): string {
  if (isArchiveApiError(err)) {
    return err.message || fallback;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return fallback;
}

export type SaveSharedTokenResult =
  | { readonly ok: true; readonly pronunciations?: Record<string, Pronunciation>; readonly message: string }
  | { readonly ok: false; readonly message: string };

export async function saveSharedTokenPronunciation(
  draft: SharedTokenDraft,
  dataSource?: ArchiveDataSource
): Promise<SaveSharedTokenResult> {
  if (!dataSource?.upsertPronunciationTerm) {
    return {
      ok: false,
      message: 'Saving shared pronunciations is not supported by this archive.',
    };
  }
  const trimmedTerm = draft.term.trim();
  const entry: Pronunciation = {};
  const phonetic = draft.phonetic.trim();
  const ipa = draft.ipa.trim();
  const language = draft.language.trim();
  const note = draft.note.trim();
  const sourceLabel = draft.source_label.trim();
  const sourceUrl = draft.source_url.trim();
  const region = draft.region.trim();
  if (phonetic) entry.phonetic = phonetic;
  if (ipa) entry.ipa = ipa;
  if (language) entry.language = language;
  if (note) entry.note = note;
  if (sourceLabel) entry.source_label = sourceLabel;
  if (sourceUrl) entry.source_url = sourceUrl;
  if (region) entry.region = region;
  if (draft.existingShared?.variants && draft.existingShared.variants.length > 0) {
    entry.variants = draft.existingShared.variants;
  }

  try {
    const data = await dataSource.upsertPronunciationTerm(trimmedTerm, entry);
    return {
      ok: true,
      pronunciations:
        data.pronunciations && typeof data.pronunciations === 'object' ? data.pronunciations : undefined,
      message: `Saved shared pronunciation for "${trimmedTerm}". Updates every record sharing this name and generates audio.`,
    };
  } catch (err) {
    return {
      ok: false,
      message: formatPortError(err, 'Failed to save shared pronunciation.'),
    };
  }
}

export type GenerateAudioResult =
  | { readonly ok: true; readonly audioUrl: string; readonly message: string }
  | { readonly ok: false; readonly message: string };

export async function generatePronunciationAudio(params: {
  readonly entityType: Extract<EntityType, 'person' | 'place'>;
  readonly entityId: string;
  readonly text: string;
  readonly draftPronunciation: Pronunciation | null;
  readonly dataSource?: ArchiveDataSource;
}): Promise<GenerateAudioResult> {
  if (!params.dataSource?.generatePronunciationAudio) {
    return {
      ok: false,
      message: 'Audio generation is not supported by this archive.',
    };
  }
  try {
    const data = await params.dataSource.generatePronunciationAudio({
      entity_type: params.entityType,
      entity_id: params.entityId,
      text: params.text,
      phonetic: params.draftPronunciation?.phonetic?.trim() || undefined,
      ipa: params.draftPronunciation?.ipa?.trim() || undefined,
      language: params.draftPronunciation?.language?.trim() || undefined,
    });
    if (!data.audio_url || typeof data.audio_url !== 'string') {
      return { ok: false, message: 'Server response did not include an audio_url.' };
    }
    return {
      ok: true,
      audioUrl: data.audio_url,
      message: 'Pronunciation audio generated. Save changes to publish.',
    };
  } catch (err) {
    return {
      ok: false,
      message: formatPortError(err, 'Audio generation failed.'),
    };
  }
}
