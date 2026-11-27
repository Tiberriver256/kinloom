export {
  LANG_DISPLAY_NAMES,
  normalizeLangCode,
  PRONOUNCE_SUPPORTED_LANGS,
  type PronounceAuditOptions,
  type PronounceAuditResult,
  type PronounceCoverageGapPerson,
  type PronounceCoverageGapPlace,
  type PronounceDeduplicateKeepReason,
  type PronounceDeduplicateKeptOverride,
  type PronounceDeduplicateOptions,
  type PronounceDeduplicatePromotedToken,
  type PronounceDeduplicateRemovedOverride,
  type PronounceDeduplicateResult,
  type PronounceDeduplicateSkippedPromotion,
  type PronounceHomonymCollision,
  type PronounceLang,
  type PronounceLivingLeak,
  type PronounceMissingPersonGap,
  type PronouncePartialPersonGap,
  type PronounceQualityWarning,
  type PronounceRedundantPersonOverride,
  type PronounceUnsourcedEntry,
} from '../shared/pronunciation/types.js';

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
