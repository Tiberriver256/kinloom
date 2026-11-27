import type { PronunciationCoverage } from '@kinloom/core';

export const PRONOUNCE_SUPPORTED_LANGS = ['nl', 'sv', 'fi', 'pl', 'de', 'en'] as const;
export type PronounceLang = (typeof PRONOUNCE_SUPPORTED_LANGS)[number];

export const LANG_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  nl: 'Dutch',
  sv: 'Swedish',
  fi: 'Finnish',
  pl: 'Polish',
  de: 'German',
  en: 'English',
  fr: 'French',
  no: 'Norwegian',
  da: 'Danish',
};

export type PronounceSourceTier = 'native_speaker' | 'broadcast_lexicon' | 'community' | 'automated';

export type PronounceSourceStatus = 'verified' | 'no_match' | 'requires_api_key' | 'manual_lookup' | 'error';

export type PronounceProviderId =
  | 'forvo'
  | 'youglish'
  | 'wiktionary'
  | 'voa'
  | 'wikipedia'
  | 'nameshouts'
  | 'pronouncenames'
  | 'howtopronounce';

export const PRONOUNCE_TIER_RANK: Readonly<Record<PronounceSourceTier, number>> = {
  native_speaker: 1,
  broadcast_lexicon: 2,
  community: 3,
  automated: 4,
};

export interface PronounceAudioHit {
  filename: string;
  commons_file: string;
  url: string;
  language?: string;
  source_url: string;
  provider?: PronounceProviderId;
  tier?: PronounceSourceTier;
  speaker?: string;
  country?: string;
}

export interface PronounceSourceHit {
  provider: PronounceProviderId;
  tier: PronounceSourceTier;
  status: PronounceSourceStatus;
  site: string;
  title: string;
  url: string;
  label: string;
  ipa: string[];
  phonetic?: string[];
  audio_files: string[];
  note?: string;
}

export interface PronounceLookupResult {
  ok: true;
  term: string;
  lang: string | null;
  verified: boolean;
  corroborated: boolean;
  sourceCount: number;
  highestTier: PronounceSourceTier | null;
  native_speaker_verified: boolean;
  verification_note: string | null;
  cache_hit: boolean;
  ipa: string[];
  primary_ipa: string | null;
  audio_files: PronounceAudioHit[];
  source_url: string | null;
  source_label: string | null;
  sources: PronounceSourceHit[];
  fetched_at: string;
  rendered: string;
}

export interface PronounceLookupOptions {
  term: string;
  lang?: string;
  region?: string;
  json?: boolean;
  refresh?: boolean;
  cacheDir?: string;
  timeoutMs?: number;
  forvoApiKey?: string;
  fetchImpl?: typeof fetch;
  sleepFn?: (ms: number) => Promise<void>;
  nowIso?: () => string;
}

export interface PronounceCoverageGapPerson {
  surname: string;
  deceased_count: number;
}

export interface PronounceMissingPersonGap {
  id: string;
  full_name: string;
  surname: string;
}

export interface PronouncePartialPersonGap {
  id: string;
  full_name: string;
  coverage: Exclude<PronunciationCoverage, 'full'>;
  matched_part: string | null;
  missing_parts: string[];
}

export interface PronounceLivingLeak {
  scope: 'person' | 'lexicon';
  location: string;
  reason: string;
}

export interface PronounceCoverageGapPlace {
  id: string;
  name: string;
  full_name: string;
  reason: string;
}

export interface PronounceUnsourcedEntry {
  scope: 'lexicon' | 'person' | 'place';
  key: string;
  label: string;
  missing_note: boolean;
}

export interface PronounceHomonymCollision {
  lexicon_key: string;
  places: Array<{ id: string; name: string; full_name: string; scope_hint: string }>;
  recommendation: string;
}

export interface PronounceQualityWarning {
  scope: 'lexicon' | 'person' | 'place';
  key: string;
  code: 'empty_entry' | 'malformed_ipa' | 'suspicious_english_ipa_for_foreign_lang';
  language?: string;
  ipa?: string;
  message: string;
}

export interface PronounceAuditResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  summary: {
    deceasedTotal: number;
    deceasedFullCoverage: number;
    deceasedPartialOnly: number;
    deceasedMissing: number;
    livingLeaks: number;
    placesTotal: number;
    placesCovered: number;
    placesMissing: number;
    lexicon_entries: number;
    deceased_people: number;
    living_people_excluded: number;
    places: number;
    missing_surnames: number;
    missing_non_trivial_places: number;
    unsourced_entries: number;
    homonymous_place_collisions: number;
    ipa_quality_warnings: number;
  };
  living_leaks: PronounceLivingLeak[];
  coverage_gaps: {
    people_missing: PronounceMissingPersonGap[];
    people_partial: PronouncePartialPersonGap[];
    surnames: PronounceCoverageGapPerson[];
    places: PronounceCoverageGapPlace[];
  };
  unsourced_entries: PronounceUnsourcedEntry[];
  homonymous_place_collisions: PronounceHomonymCollision[];
  ipa_quality_warnings: PronounceQualityWarning[];
  rendered: string;
}

export interface PronounceAuditOptions {
  repoDir?: string;
  json?: boolean;
  strict?: boolean;
}

export function normalizeLangCode(lang?: string | null): string | null {
  if (!lang) {
    return null;
  }
  const base = lang.trim().toLowerCase().split(/[-_]/)[0];
  return base || null;
}
