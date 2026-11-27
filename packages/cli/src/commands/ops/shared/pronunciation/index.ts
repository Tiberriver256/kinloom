export { runPronounceAuditCommand } from './audit.js';
export { formatAuditText } from './auditReport.js';
export {
  derivePlaceScopeHint,
  detectHomonymousPlaceCollisions,
  detectLivingPronunciationLeaks,
  hasPronunciationValues,
  inspectNonTrivialPlaceReason,
  inspectPronunciationQuality,
} from './auditRules.js';
export {
  evaluatePersonOverrideRedundancy,
  extractPromotableTokenFromPerson,
  normalizeIpaComparable,
  normalizeIpaForConflictCheck,
  normalizePhoneticComparable,
  normalizeWhitespace,
  type OverrideRedundancyDecision,
  type PromotionCandidate,
} from './deduplicateRules.js';
export { loadArchivePronunciationLexicon } from './lexiconLoader.js';
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
} from './types.js';
