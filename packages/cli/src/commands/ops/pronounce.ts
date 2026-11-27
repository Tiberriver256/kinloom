export { runPronounceDeduplicateCommand } from './pronounce/deduplicate.js';
export {
  buildForvoLookupUrl,
  buildManualLookupSources,
  buildYouGlishLookupUrl,
  evaluatePronounceCorroboration,
  getPronounceCacheDir,
  rankPronounceSources,
  runPronounceLookupCommand,
} from './pronounce/lookup.js';
export { buildCommonsAudioUrl, extractMediaWikiPronunciations } from './pronounce/mediaWiki.js';
export {
  DEFAULT_PRONOUNCE_GEMINI_MODEL,
  type PronounceBatchManifest,
  type PronounceSynthBackend,
  type PronounceSynthItemResult,
  type PronounceSynthOptions,
  type PronounceSynthResult,
  runPronounceSynthCommand,
  wrapPcmAsWav,
} from './pronounce/synth.js';
export {
  type CollectedPronounceTargets,
  collectPronounceSynthTargets,
  type PronounceAudioFormat,
  type PronounceSynthScope,
  type PronounceSynthTarget,
} from './pronounce/synthTargets.js';
export {
  PRONOUNCE_SUPPORTED_LANGS,
  PRONOUNCE_TIER_RANK,
  type PronounceAudioHit,
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
  type PronounceLookupOptions,
  type PronounceLookupResult,
  type PronounceMissingPersonGap,
  type PronouncePartialPersonGap,
  type PronounceProviderId,
  type PronounceQualityWarning,
  type PronounceRedundantPersonOverride,
  type PronounceSourceHit,
  type PronounceSourceStatus,
  type PronounceSourceTier,
  type PronounceUnsourcedEntry,
} from './pronounce/types.js';
export {
  evaluatePersonOverrideRedundancy,
  loadArchivePronunciationLexicon,
  type OverrideRedundancyDecision,
  runPronounceAuditCommand,
} from './shared/pronunciation/index.js';
