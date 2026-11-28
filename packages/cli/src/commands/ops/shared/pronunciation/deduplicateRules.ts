import {
  inspectPersonPronunciationTokens,
  type Pronunciation,
  type RawPerson,
  type ResolvedPersonPronunciation,
  resolvePersonPronunciation,
} from '@kinloom/core';
import {
  extractAlignedTokenSegment,
  matchesComposedTokenSequence,
  normalizeIpaComparable,
  normalizeWhitespace,
} from './tokenAlignment.js';
import type { PronounceDeduplicateKeepReason } from './types.js';

export {
  normalizeIpaComparable,
  normalizeIpaForConflictCheck,
  normalizePhoneticComparable,
  normalizeWhitespace,
} from './tokenAlignment.js';

function hasExplicitPronunciationContent(entry?: Pronunciation | null): entry is Pronunciation {
  if (!entry) {
    return false;
  }
  if (entry.phonetic?.trim() || entry.ipa?.trim() || entry.audio_url?.trim() || entry.note?.trim()) {
    return true;
  }
  return Boolean(
    entry.variants?.some(
      (v) =>
        Boolean(v.phonetic?.trim()) ||
        Boolean(v.ipa?.trim()) ||
        Boolean(v.audio_url?.trim()) ||
        Boolean(v.note?.trim())
    )
  );
}

export type OverrideRedundancyDecision =
  | {
      readonly kind: 'removable';
      readonly resolved: ResolvedPersonPronunciation;
    }
  | {
      readonly kind: 'keep';
      readonly reason: PronounceDeduplicateKeepReason;
      readonly detail: string;
    };

/**
 * Conservatively determine whether an explicit `person.pronunciation` override is 100%
 * losslessly redundant against the shared pronunciation lexicon.
 */
export function evaluatePersonOverrideRedundancy(
  person: RawPerson,
  lexicon: Readonly<Record<string, Pronunciation>>,
  force = false
): OverrideRedundancyDecision | null {
  const own = person.pronunciation;
  if (!hasExplicitPronunciationContent(own)) {
    return null;
  }

  const withoutOwn = resolvePersonPronunciation({ ...person, pronunciation: undefined }, lexicon);
  if (withoutOwn?.coverage !== 'full') {
    const missing = withoutOwn?.missingParts?.length
      ? ` (missing shared tokens: ${withoutOwn.missingParts.join(', ')})`
      : '';
    return {
      kind: 'keep',
      reason: 'would_drop_coverage',
      detail: `Removing override would drop coverage below full${missing}.`,
    };
  }

  const ownNote = normalizeWhitespace(own.note);
  const sharedNote = normalizeWhitespace(withoutOwn.note);
  if (ownNote && ownNote !== sharedNote) {
    return {
      kind: 'keep',
      reason: 'has_unique_note',
      detail: 'Override carries a unique pronunciation note.',
    };
  }

  if (own.variants && own.variants.length > 0) {
    const sharedVariantsJson = JSON.stringify(withoutOwn.variants ?? []);
    if (JSON.stringify(own.variants) !== sharedVariantsJson) {
      return {
        kind: 'keep',
        reason: 'has_unique_variants',
        detail: 'Override carries unique pronunciation variants.',
      };
    }
  }

  const ownAudio = normalizeWhitespace(own.audio_url);
  const sharedAudio = normalizeWhitespace(withoutOwn.audio_url);
  if (ownAudio && ownAudio !== sharedAudio) {
    return {
      kind: 'keep',
      reason: 'has_unique_audio',
      detail: 'Override carries a custom audio_url.',
    };
  }

  if (!force) {
    const inspectedTokens =
      withoutOwn.resolvedFrom === 'composed'
        ? inspectPersonPronunciationTokens(person, lexicon).tokens
        : null;

    const ownPhonetic = normalizeWhitespace(own.phonetic);
    const sharedPhonetic = normalizeWhitespace(withoutOwn.phonetic);
    const phoneticEquivalent =
      !ownPhonetic ||
      ownPhonetic === sharedPhonetic ||
      Boolean(
        inspectedTokens &&
          matchesComposedTokenSequence({
            value: ownPhonetic,
            tokens: inspectedTokens,
            mode: 'phonetic',
          })
      );
    if (!phoneticEquivalent) {
      return {
        kind: 'keep',
        reason: 'pronunciation_differs',
        detail: `Respelling differs ("${ownPhonetic}" vs shared "${sharedPhonetic || 'none'}").`,
      };
    }

    const ownIpa = normalizeIpaComparable(own.ipa);
    const sharedIpa = normalizeIpaComparable(withoutOwn.ipa);
    const ipaEquivalent =
      !ownIpa ||
      ownIpa === sharedIpa ||
      Boolean(
        inspectedTokens &&
          matchesComposedTokenSequence({
            value: ownIpa,
            tokens: inspectedTokens,
            mode: 'ipa',
          })
      );
    if (!ipaEquivalent) {
      return {
        kind: 'keep',
        reason: 'pronunciation_differs',
        detail: `IPA differs ("${own.ipa?.trim()}" vs shared "${withoutOwn.ipa?.trim() || 'none'}").`,
      };
    }
  }

  return {
    kind: 'removable',
    resolved: withoutOwn,
  };
}

export interface PromotionCandidate {
  readonly term: string;
  readonly entry: Pronunciation;
  readonly personId: string;
}

export function extractPromotableTokenFromPerson(
  person: RawPerson,
  lexicon: Readonly<Record<string, Pronunciation>>
): PromotionCandidate | null {
  const own = person.pronunciation;
  if (!hasExplicitPronunciationContent(own)) {
    return null;
  }
  const inspection = inspectPersonPronunciationTokens(person, lexicon);
  const editableTokens = inspection.tokens.filter((t) => t.kind === 'token');
  const unresolvedIndices: number[] = [];
  for (let i = 0; i < inspection.tokens.length; i += 1) {
    const tok = inspection.tokens[i];
    if (tok === undefined) continue;
    if (tok.kind === 'token' && tok.entry === null) {
      unresolvedIndices.push(i);
    }
  }
  if (editableTokens.length === 0 || unresolvedIndices.length !== 1) {
    return null;
  }

  const missingIdx = unresolvedIndices[0];
  if (missingIdx === undefined) return null;
  const missingToken = inspection.tokens[missingIdx];
  if (!missingToken) return null;
  const beforeTokens = inspection.tokens.slice(0, missingIdx);
  const afterTokens = inspection.tokens.slice(missingIdx + 1);

  const ownPhonetic = normalizeWhitespace(own.phonetic);
  const extractedPhonetic = ownPhonetic
    ? (extractAlignedTokenSegment({
        fullValue: ownPhonetic,
        beforeTokens,
        missingToken,
        afterTokens,
        mode: 'phonetic',
      }) ?? undefined)
    : undefined;

  // Never silently drop a present Respelling into an IPA-only lexicon entry.
  if (ownPhonetic && !extractedPhonetic) {
    return null;
  }

  const ownIpaInner = normalizeIpaComparable(own.ipa);
  const extractedIpa = ownIpaInner
    ? (extractAlignedTokenSegment({
        fullValue: ownIpaInner,
        beforeTokens,
        missingToken,
        afterTokens,
        mode: 'ipa',
      }) ?? undefined)
    : undefined;

  // Never promote a phonetic-only token when IPA was present but failed alignment.
  if (ownIpaInner && !extractedIpa) {
    return null;
  }

  if (!extractedPhonetic && !extractedIpa) {
    return null;
  }

  const entry: Pronunciation = {
    ...(extractedPhonetic ? { phonetic: extractedPhonetic } : {}),
    ...(extractedIpa ? { ipa: extractedIpa } : {}),
    ...(own.language?.trim() ? { language: own.language.trim() } : {}),
    ...(own.source_label?.trim() ? { source_label: own.source_label.trim() } : {}),
    ...(own.source_url?.trim() ? { source_url: own.source_url.trim() } : {}),
    ...(own.region?.trim() ? { region: own.region.trim() } : {}),
  };

  return {
    term: missingToken.text,
    entry,
    personId: person.id,
  };
}
