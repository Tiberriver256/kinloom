import {
  inspectPersonPronunciationTokens,
  type Pronunciation,
  type RawPerson,
  type ResolvedPersonPronunciation,
  resolvePersonPronunciation,
  stripIpaDelimiters,
} from '@kinloom/core';
import type { PronounceDeduplicateKeepReason } from './types.js';

export function normalizeWhitespace(value?: string | null): string {
  return (value ?? '').trim().replaceAll(/\s+/g, ' ');
}

export function normalizeIpaComparable(value?: string | null): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return '';
  }
  return normalizeWhitespace(stripIpaDelimiters(trimmed));
}

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
    const ownPhonetic = normalizeWhitespace(own.phonetic);
    const sharedPhonetic = normalizeWhitespace(withoutOwn.phonetic);
    if (ownPhonetic && ownPhonetic !== sharedPhonetic) {
      return {
        kind: 'keep',
        reason: 'pronunciation_differs',
        detail: `Respelling differs ("${ownPhonetic}" vs shared "${sharedPhonetic || 'none'}").`,
      };
    }

    const ownIpa = normalizeIpaComparable(own.ipa);
    const sharedIpa = normalizeIpaComparable(withoutOwn.ipa);
    if (ownIpa && ownIpa !== sharedIpa) {
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

function stripDelimitedPrefixAndSuffix(
  fullValue: string,
  prefixPieces: readonly string[],
  suffixPieces: readonly string[]
): string | null {
  let remaining = normalizeWhitespace(fullValue);
  for (const piece of prefixPieces) {
    const norm = normalizeWhitespace(piece);
    if (!norm) {
      return null;
    }
    if (remaining.toLowerCase().startsWith(`${norm.toLowerCase()} `)) {
      remaining = remaining.slice(norm.length + 1).trim();
    } else if (remaining.toLowerCase().startsWith(`${norm.toLowerCase()}-`)) {
      remaining = remaining.slice(norm.length + 1).trim();
    } else {
      return null;
    }
  }
  for (let i = suffixPieces.length - 1; i >= 0; i -= 1) {
    const norm = normalizeWhitespace(suffixPieces[i]);
    if (!norm) {
      return null;
    }
    if (remaining.toLowerCase().endsWith(` ${norm.toLowerCase()}`)) {
      remaining = remaining.slice(0, remaining.length - norm.length - 1).trim();
    } else if (remaining.toLowerCase().endsWith(`-${norm.toLowerCase()}`)) {
      remaining = remaining.slice(0, remaining.length - norm.length - 1).trim();
    } else {
      return null;
    }
  }
  return remaining || null;
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
    if (tok.kind === 'token' && tok.entry === null) {
      unresolvedIndices.push(i);
    }
  }
  if (editableTokens.length === 0 || unresolvedIndices.length !== 1) {
    return null;
  }

  const missingIdx = unresolvedIndices[0];
  const missingToken = inspection.tokens[missingIdx];
  const beforeTokens = inspection.tokens.slice(0, missingIdx);
  const afterTokens = inspection.tokens.slice(missingIdx + 1);

  let extractedPhonetic: string | undefined;
  const ownPhonetic = normalizeWhitespace(own.phonetic);
  if (ownPhonetic) {
    const beforePhonetic: string[] = [];
    const afterPhonetic: string[] = [];
    let canExtractPhonetic = true;
    for (const tok of beforeTokens) {
      const piece = tok.kind === 'token' ? normalizeWhitespace(tok.entry?.phonetic) : tok.text;
      if (!piece) {
        canExtractPhonetic = false;
        break;
      }
      beforePhonetic.push(piece);
    }
    if (canExtractPhonetic) {
      for (const tok of afterTokens) {
        const piece = tok.kind === 'token' ? normalizeWhitespace(tok.entry?.phonetic) : tok.text;
        if (!piece) {
          canExtractPhonetic = false;
          break;
        }
        afterPhonetic.push(piece);
      }
    }
    if (canExtractPhonetic) {
      const remainder = stripDelimitedPrefixAndSuffix(ownPhonetic, beforePhonetic, afterPhonetic);
      if (remainder) {
        extractedPhonetic = remainder;
      }
    }
  }

  let extractedIpa: string | undefined;
  const ownIpaInner = normalizeIpaComparable(own.ipa);
  if (ownIpaInner) {
    const beforeIpa: string[] = [];
    const afterIpa: string[] = [];
    let canExtractIpa = true;
    for (const tok of beforeTokens) {
      if (tok.kind !== 'token') {
        continue;
      }
      const piece = normalizeIpaComparable(tok.entry?.ipa);
      if (!piece) {
        canExtractIpa = false;
        break;
      }
      beforeIpa.push(piece);
    }
    if (canExtractIpa) {
      for (const tok of afterTokens) {
        if (tok.kind !== 'token') {
          continue;
        }
        const piece = normalizeIpaComparable(tok.entry?.ipa);
        if (!piece) {
          canExtractIpa = false;
          break;
        }
        afterIpa.push(piece);
      }
    }
    if (canExtractIpa) {
      const remainder = stripDelimitedPrefixAndSuffix(ownIpaInner, beforeIpa, afterIpa);
      if (remainder) {
        extractedIpa = `/${remainder}/`;
      }
    }
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
