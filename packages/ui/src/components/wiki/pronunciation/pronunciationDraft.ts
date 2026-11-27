import type { EntityType, PersonPronunciationTokenRole, Pronunciation } from '@kinloom/core';

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

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const errBody = (await response.json()) as {
      error?: { message?: string };
      message?: string;
    };
    return errBody.error?.message || errBody.message || fallback;
  } catch {
    return fallback;
  }
}

export type SaveSharedTokenResult =
  | { readonly ok: true; readonly pronunciations?: Record<string, Pronunciation>; readonly message: string }
  | { readonly ok: false; readonly message: string };

export async function saveSharedTokenPronunciation(draft: SharedTokenDraft): Promise<SaveSharedTokenResult> {
  const trimmedTerm = draft.term.trim();
  const response = await fetch(`/api/pronunciations/${encodeURIComponent(trimmedTerm)}`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phonetic: draft.phonetic.trim() || undefined,
      ipa: draft.ipa.trim() || undefined,
      language: draft.language.trim() || undefined,
      note: draft.note.trim() || undefined,
      source_label: draft.source_label.trim() || undefined,
      source_url: draft.source_url.trim() || undefined,
      region: draft.region.trim() || undefined,
      ...(draft.existingShared?.variants && draft.existingShared.variants.length > 0
        ? { variants: draft.existingShared.variants }
        : {}),
    }),
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(
      response,
      `Failed to save shared pronunciation (HTTP ${response.status}).`
    );
    return { ok: false, message: errorMessage };
  }
  const data = (await response.json()) as {
    pronunciations?: Record<string, Pronunciation>;
  };
  return {
    ok: true,
    pronunciations:
      data.pronunciations && typeof data.pronunciations === 'object' ? data.pronunciations : undefined,
    message: `Saved shared pronunciation for "${trimmedTerm}". Updates every record sharing this name and generates audio.`,
  };
}

export type GenerateAudioResult =
  | { readonly ok: true; readonly audioUrl: string; readonly message: string }
  | { readonly ok: false; readonly message: string };

export async function generatePronunciationAudio(params: {
  readonly entityType: Extract<EntityType, 'person' | 'place'>;
  readonly entityId: string;
  readonly text: string;
  readonly draftPronunciation: Pronunciation | null;
}): Promise<GenerateAudioResult> {
  const response = await fetch('/api/pronunciation/generate', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_type: params.entityType,
      entity_id: params.entityId,
      text: params.text,
      phonetic: params.draftPronunciation?.phonetic?.trim() || undefined,
      ipa: params.draftPronunciation?.ipa?.trim() || undefined,
      language: params.draftPronunciation?.language?.trim() || undefined,
    }),
  });
  if (!response.ok) {
    const errorMessage = await readErrorMessage(
      response,
      `Audio generation failed (HTTP ${response.status}).`
    );
    return { ok: false, message: errorMessage };
  }
  const data = (await response.json()) as { audio_url?: string };
  if (!data.audio_url || typeof data.audio_url !== 'string') {
    return { ok: false, message: 'Server response did not include an audio_url.' };
  }
  return {
    ok: true,
    audioUrl: data.audio_url,
    message: 'Pronunciation audio generated. Save changes to publish.',
  };
}
