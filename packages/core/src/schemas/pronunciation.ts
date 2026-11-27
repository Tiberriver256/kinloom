import { z } from 'zod';
import {
  getPlaceQualifierSegments,
  isBareLexiconEntryCompatibleWithPlace,
  splitPlaceSegments,
} from './pronunciationGeo.js';

export const PronunciationVariantSchema = z.object({
  label: z.string().min(1),
  phonetic: z.string().min(1).optional(),
  ipa: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  audio_url: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  source_url: z.string().min(1).optional(),
  source_label: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

export type PronunciationVariant = z.infer<typeof PronunciationVariantSchema>;

export const PronunciationSchema = z.object({
  phonetic: z.string().min(1).optional(),
  ipa: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  audio_url: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
  source_url: z.string().min(1).optional(),
  source_label: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  match_full_name_contains: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
  variants: z.array(PronunciationVariantSchema).optional(),
});

export type Pronunciation = z.infer<typeof PronunciationSchema>;

export type PronunciationCoverage = 'full' | 'partial' | 'surname';

export type PronunciationResolutionSource =
  | 'person'
  | 'lexicon_id'
  | 'lexicon_full_name'
  | 'composed'
  | 'lexicon_surname';

export interface ResolvedPersonPronunciation extends Pronunciation {
  readonly coverage: PronunciationCoverage;
  readonly matchedPart?: string;
  readonly resolvedFrom?: PronunciationResolutionSource;
  readonly missingParts?: readonly string[];
}

/**
 * Merge a base pronunciation lexicon with live overrides, resolving case-insensitive
 * key collisions so an override always supersedes any differently cased base key.
 */
export function mergePronunciationLexicons(
  base?: Readonly<Record<string, Pronunciation>> | null,
  override?: Readonly<Record<string, Pronunciation>> | null
): Record<string, Pronunciation> {
  const out: Record<string, Pronunciation> = {};
  const keyByLower = new Map<string, string>();
  const apply = (source?: Readonly<Record<string, Pronunciation>> | null): void => {
    if (!source) {
      return;
    }
    for (const [key, entry] of Object.entries(source)) {
      const lower = key.toLowerCase();
      const prevKey = keyByLower.get(lower);
      if (prevKey && prevKey !== key) {
        delete out[prevKey];
      }
      keyByLower.set(lower, key);
      out[key] = entry;
    }
  };
  apply(base);
  apply(override);
  return out;
}

function mergePronunciationEntry(
  shared: Pronunciation | undefined,
  own: Pronunciation | undefined
): Pronunciation | null {
  if (!own && !shared) {
    return null;
  }
  if (!shared) {
    return own ?? null;
  }
  if (!own) {
    return shared;
  }
  const merged: Pronunciation = {
    ...shared,
    ...own,
  };
  const ownChangesSpokenGuide =
    (own.phonetic !== undefined && own.phonetic !== shared.phonetic) ||
    (own.ipa !== undefined && own.ipa !== shared.ipa);
  if (ownChangesSpokenGuide && own.audio_url === undefined) {
    delete merged.audio_url;
  }
  return merged;
}

function hasPronunciationEntryContent(entry?: Pronunciation | null): boolean {
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

function lookupLexiconEntry(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string
): Pronunciation | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.hasOwn(lexicon, trimmed)) {
    return lexicon[trimmed];
  }
  const lower = trimmed.toLowerCase();
  for (const [candidateKey, entry] of Object.entries(lexicon)) {
    if (candidateKey.trim().toLowerCase() === lower) {
      return entry;
    }
  }
  return undefined;
}

function isLexiconEntryCompatibleWithPerson(entry: Pronunciation, fullNameLower: string): boolean {
  if (entry.match_full_name_contains === undefined) {
    return true;
  }
  const needles = Array.isArray(entry.match_full_name_contains)
    ? entry.match_full_name_contains
    : [entry.match_full_name_contains];
  const validNeedles = needles.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (validNeedles.length === 0) {
    return true;
  }
  return Boolean(fullNameLower) && validNeedles.some((needle) => fullNameLower.includes(needle));
}

function lookupCompatiblePersonLexiconEntry(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string,
  fullNameLower: string
): Pronunciation | undefined {
  const entry = lookupLexiconEntry(lexicon, key);
  if (!entry || !hasPronunciationEntryContent(entry)) {
    return undefined;
  }
  if (!isLexiconEntryCompatibleWithPerson(entry, fullNameLower)) {
    return undefined;
  }
  return entry;
}

const SINGLE_LETTER_INITIAL_RE = /^[\p{L}]\.?$/u;
const PERSON_NAME_DECORATION_RE = /^(?:jr\.?|sr\.?|ii|iii|iv|v|vi)$/i;

function tokenizePersonName(person: {
  readonly full_name?: string;
  readonly given_name?: string;
  readonly surname?: string;
}): string[] {
  const rawFull = person.full_name?.trim() ?? '';
  const combined = rawFull || [person.given_name?.trim(), person.surname?.trim()].filter(Boolean).join(' ');
  if (!combined) {
    return [];
  }
  const cleaned = combined
    .replaceAll(/\([^)]*\)/g, ' ')
    .replaceAll(/[“”"]/g, ' ')
    .replaceAll(/,/g, ' ')
    .trim();
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(/\s+/)
    .map((tok) => tok.replaceAll(/^[^A-Za-zÀ-ÖØ-öø-ÿ0-9]+|[^A-Za-zÀ-ÖØ-öø-ÿ0-9.]+$/g, ''))
    .filter(Boolean);
}

function isSingleLetterInitial(token: string): boolean {
  return SINGLE_LETTER_INITIAL_RE.test(token.trim());
}

function stripIpaDelimiters(ipa: string): string {
  const trimmed = ipa.trim();
  if (
    (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed.length > 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeBaseLanguage(language?: string | null): string | null {
  const trimmed = language?.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  return trimmed.split(/[-_]/)[0] || null;
}

interface ComposedTokenPart {
  readonly kind: 'resolved' | 'initial' | 'decoration';
  readonly token: string;
  readonly entry?: Pronunciation;
  readonly joinWithHyphen?: boolean;
}

function composeLanguageTag(entries: readonly Pronunciation[]): string | undefined {
  const rawLangs = entries.map((e) => e.language?.trim()).filter((lang): lang is string => Boolean(lang));
  if (rawLangs.length === 0) {
    return undefined;
  }
  const uniqueExact = new Set(rawLangs.map((l) => l.toLowerCase()));
  if (uniqueExact.size === 1) {
    return rawLangs[0];
  }
  const baseLangs = new Set(
    rawLangs.map((l) => normalizeBaseLanguage(l)).filter((b): b is string => Boolean(b))
  );
  if (baseLangs.size === 1) {
    // Prefer a region-qualified tag (e.g. en-US over en) if all share one base language.
    const qualified = rawLangs.find((l) => /[-_]/.test(l));
    return qualified ?? rawLangs[0];
  }
  // Mixed-language full names omit a single tag so TTS follows the composed respelling.
  return undefined;
}

function composeProvenance(entries: readonly Pronunciation[]): {
  readonly source_label?: string;
  readonly source_url?: string;
  readonly region?: string;
} {
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  const urls = new Set<string>();
  const regions = new Set<string>();

  for (const entry of entries) {
    const label = entry.source_label?.trim();
    if (label && !seenLabels.has(label.toLowerCase())) {
      seenLabels.add(label.toLowerCase());
      labels.push(label);
    }
    const url = entry.source_url?.trim();
    if (url) {
      urls.add(url);
    }
    const region = entry.region?.trim();
    if (region) {
      regions.add(region);
    }
  }

  return {
    ...(labels.length > 0 ? { source_label: labels.join(' + ') } : {}),
    ...(urls.size === 1 ? { source_url: [...urls][0] } : {}),
    ...(regions.size === 1 ? { region: [...regions][0] } : {}),
  };
}

function resolveCompositionalPersonPronunciation(
  tokens: readonly string[],
  lexicon: Readonly<Record<string, Pronunciation>>,
  fullNameLower: string
): { readonly resolved: ResolvedPersonPronunciation | null; readonly missingParts: readonly string[] } {
  if (tokens.length === 0) {
    return { resolved: null, missingParts: [] };
  }

  const parts: ComposedTokenPart[] = [];
  const missingParts: string[] = [];
  let resolvedMeaningfulCount = 0;

  let idx = 0;
  while (idx < tokens.length) {
    // Greedy longest-phrase match (up to 4 tokens) so multi-word surnames match atomically.
    const maxSpan = Math.min(4, tokens.length - idx);
    let matchedSpan = 0;
    let matchedEntry: Pronunciation | undefined;
    let matchedText = '';

    for (let span = maxSpan; span >= 1; span -= 1) {
      const phrase = tokens.slice(idx, idx + span).join(' ');
      const candidate = lookupCompatiblePersonLexiconEntry(lexicon, phrase, fullNameLower);
      if (candidate) {
        matchedSpan = span;
        matchedEntry = candidate;
        matchedText = phrase;
        break;
      }
    }

    if (matchedSpan > 0 && matchedEntry) {
      parts.push({ kind: 'resolved', token: matchedText, entry: matchedEntry });
      resolvedMeaningfulCount += 1;
      idx += matchedSpan;
      continue;
    }

    const token = tokens[idx];

    if (token.includes('-')) {
      const subTokens = token
        .split('-')
        .map((s) => s.trim())
        .filter(Boolean);
      if (subTokens.length > 1) {
        const subEntries: Pronunciation[] = [];
        let allSubMatched = true;
        for (const sub of subTokens) {
          const subEntry = lookupCompatiblePersonLexiconEntry(lexicon, sub, fullNameLower);
          if (!subEntry) {
            allSubMatched = false;
            missingParts.push(sub);
          } else {
            subEntries.push(subEntry);
          }
        }
        if (allSubMatched) {
          for (let s = 0; s < subTokens.length; s += 1) {
            parts.push({
              kind: 'resolved',
              token: subTokens[s],
              entry: subEntries[s],
              joinWithHyphen: s > 0,
            });
          }
          resolvedMeaningfulCount += 1;
        }
        idx += 1;
        continue;
      }
    }

    if (tokens.length > 1 && isSingleLetterInitial(token)) {
      parts.push({ kind: 'initial', token });
      idx += 1;
      continue;
    }

    if (tokens.length > 1 && PERSON_NAME_DECORATION_RE.test(token)) {
      parts.push({ kind: 'decoration', token });
      idx += 1;
      continue;
    }

    missingParts.push(token);
    idx += 1;
  }

  if (missingParts.length > 0 || resolvedMeaningfulCount === 0) {
    return { resolved: null, missingParts };
  }

  const resolvedEntries = parts
    .filter(
      (p): p is ComposedTokenPart & { readonly entry: Pronunciation } =>
        p.kind === 'resolved' && Boolean(p.entry)
    )
    .map((p) => p.entry);

  const allHavePhonetic = resolvedEntries.every((e) => Boolean(e.phonetic?.trim()));
  const allHaveIpa = resolvedEntries.every((e) => Boolean(e.ipa?.trim()));

  let phonetic: string | undefined;
  if (allHavePhonetic) {
    let out = '';
    for (const part of parts) {
      const piece = part.kind === 'resolved' ? (part.entry?.phonetic?.trim() ?? '') : part.token;
      if (!piece) {
        continue;
      }
      out = !out ? piece : part.joinWithHyphen ? `${out}-${piece}` : `${out} ${piece}`;
    }
    phonetic = out || undefined;
  }

  let ipa: string | undefined;
  if (allHaveIpa) {
    let out = '';
    for (const part of parts) {
      if (part.kind !== 'resolved' || !part.entry?.ipa?.trim()) {
        continue;
      }
      const piece = stripIpaDelimiters(part.entry.ipa);
      if (!piece) {
        continue;
      }
      out = !out ? piece : part.joinWithHyphen ? `${out}-${piece}` : `${out} ${piece}`;
    }
    ipa = out ? `/${out}/` : undefined;
  }

  if (!phonetic && !ipa) {
    return { resolved: null, missingParts: [] };
  }

  const language = composeLanguageTag(resolvedEntries);
  const provenance = composeProvenance(resolvedEntries);

  return {
    resolved: {
      ...(phonetic ? { phonetic } : {}),
      ...(ipa ? { ipa } : {}),
      ...(language ? { language } : {}),
      ...provenance,
      coverage: 'full',
      resolvedFrom: 'composed',
    },
    missingParts: [],
  };
}

/**
 * Resolve a person's effective pronunciation in strict precedence order:
 * 1. Explicit `person.pronunciation` (`coverage: 'full'`)
 * 2. Exact `lexicon[person.id]` or `lexicon[person.full_name]` (`coverage: 'full'`)
 * 3. Compositional full-name resolution across all meaningful name tokens (`coverage: 'full'`)
 * 4. Surname-only fallback (`coverage: 'surname'`, `matchedPart: surname`)
 *
 * Living people always resolve to `null`.
 */
export function resolvePersonPronunciation(
  person: {
    readonly id?: string;
    readonly is_living?: boolean;
    readonly full_name?: string;
    readonly given_name?: string;
    readonly surname?: string;
    readonly pronunciation?: Pronunciation | null;
  },
  lexicon?: Readonly<Record<string, Pronunciation>> | null
): ResolvedPersonPronunciation | null {
  if (person.is_living || person.full_name?.trim() === 'Living') {
    return null;
  }

  const fullNameTrimmed = person.full_name?.trim() ?? '';
  const fullNameLower = fullNameTrimmed.toLowerCase();
  const idKey = person.id?.trim() ?? '';

  const exactIdEntry = lexicon && idKey ? lookupLexiconEntry(lexicon, idKey) : undefined;
  const exactFullNameEntry =
    lexicon && fullNameTrimmed
      ? lookupCompatiblePersonLexiconEntry(lexicon, fullNameTrimmed, fullNameLower)
      : undefined;
  const exactShared =
    exactIdEntry && hasPronunciationEntryContent(exactIdEntry) ? exactIdEntry : exactFullNameEntry;

  const own = person.pronunciation ?? undefined;
  if (own && hasPronunciationEntryContent(own)) {
    const merged = mergePronunciationEntry(exactShared, own);
    if (merged) {
      return {
        ...merged,
        coverage: 'full',
        resolvedFrom: 'person',
      };
    }
  }

  if (exactIdEntry && hasPronunciationEntryContent(exactIdEntry)) {
    return {
      ...exactIdEntry,
      coverage: 'full',
      resolvedFrom: 'lexicon_id',
    };
  }
  if (exactFullNameEntry) {
    return {
      ...exactFullNameEntry,
      coverage: 'full',
      resolvedFrom: 'lexicon_full_name',
    };
  }

  if (!lexicon) {
    return null;
  }

  const tokens = tokenizePersonName(person);
  const { resolved: composed, missingParts } = resolveCompositionalPersonPronunciation(
    tokens,
    lexicon,
    fullNameLower
  );
  if (composed) {
    return composed;
  }

  const surnameKey = person.surname?.trim() ?? '';
  if (surnameKey) {
    const surnameEntry = lookupCompatiblePersonLexiconEntry(lexicon, surnameKey, fullNameLower);
    if (surnameEntry) {
      return {
        ...surnameEntry,
        coverage: 'surname',
        matchedPart: surnameKey,
        resolvedFrom: 'lexicon_surname',
        ...(missingParts.length > 0 ? { missingParts } : {}),
      };
    }
  }

  return null;
}

/**
 * Resolve a place's effective pronunciation in strict specificity order:
 * 1. Explicit `place.pronunciation` on the place record itself
 * 2. `lexicon[place.id]` (exact place ID key)
 * 3. `lexicon[place.full_name]` (case-insensitive qualified name, including matching
 *    qualified keys such as "Zeeland, Michigan" for "Zeeland, Ottawa County, Michigan, United States")
 * 4. Bare `lexicon[place.name]` only when region, `match_full_name_contains`, and language
 *    do not conflict with the place's country/region scope.
 */
export function resolvePlacePronunciation(
  place: {
    readonly id?: string;
    readonly name?: string;
    readonly full_name?: string;
    readonly pronunciation?: Pronunciation | null;
  },
  lexicon?: Readonly<Record<string, Pronunciation>> | null
): Pronunciation | null {
  let shared: Pronunciation | undefined;

  if (lexicon) {
    const idKey = place.id?.trim();
    if (idKey && lexicon[idKey]) {
      shared = lexicon[idKey];
    }

    const fullNameKey = place.full_name?.trim();
    if (!shared && fullNameKey) {
      shared =
        lexicon[fullNameKey] ??
        Object.entries(lexicon).find(([k]) => k.toLowerCase() === fullNameKey.toLowerCase())?.[1];
    }

    const nameKey = place.name?.trim();
    if (!shared && nameKey && fullNameKey) {
      const nameLower = nameKey.toLowerCase();
      const qualifierSegments = getPlaceQualifierSegments(place).map((s) => s.toLowerCase());
      const qualifierJoined = qualifierSegments.join(', ');
      let bestQualified: { readonly keyLen: number; readonly entry: Pronunciation } | null = null;

      for (const [key, entry] of Object.entries(lexicon)) {
        const keySegments = splitPlaceSegments(key);
        if (keySegments.length < 2 || keySegments[0].toLowerCase() !== nameLower) {
          continue;
        }
        const keyQualifiers = keySegments.slice(1).map((s) => s.toLowerCase());
        const allMatch = keyQualifiers.every(
          (q) => qualifierSegments.includes(q) || (q.length >= 3 && qualifierJoined.includes(q))
        );
        if (allMatch && (!bestQualified || key.length > bestQualified.keyLen)) {
          bestQualified = { keyLen: key.length, entry };
        }
      }
      if (bestQualified) {
        shared = bestQualified.entry;
      }
    }

    if (!shared && nameKey) {
      const bareEntry =
        lexicon[nameKey] ??
        Object.entries(lexicon).find(([k]) => k.toLowerCase() === nameKey.toLowerCase())?.[1];
      if (bareEntry && isBareLexiconEntryCompatibleWithPlace(bareEntry, place)) {
        shared = bareEntry;
      }
    }
  }

  const own = place.pronunciation ?? undefined;
  return mergePronunciationEntry(shared, own);
}
