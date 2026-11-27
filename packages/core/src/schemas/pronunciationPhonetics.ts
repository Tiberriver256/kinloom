import type { Pronunciation } from './pronunciationSchema.js';

const IPA_GLYPHS_IN_PHONETIC_RE = /[əɚɜæɑɔʊʌɪɛʃʒθðŋˈˌː]/g;
const IPA_SLASH_WRAP_RE = /\/[^\s/](?:[^/]*[^\s/])?\//;

export const SINGLE_LETTER_INITIAL_RE = /^[\p{L}]\.?$/u;
export const PERSON_NAME_DECORATION_RE = /^(?:jr\.?|sr\.?|ii|iii|iv|v|vi)$/i;

/**
 * Detect IPA symbols or `/.../` slash-wrapped IPA notation inside a plain-English
 * `phonetic` (Respelling) string. Returns deduplicated offending symbols in order.
 */
export function findIpaGlyphsInPhonetic(phonetic?: string | null): string[] {
  const trimmed = phonetic?.trim() ?? '';
  if (!trimmed) {
    return [];
  }
  const found: string[] = [];
  const seen = new Set<string>();
  for (const match of trimmed.matchAll(IPA_GLYPHS_IN_PHONETIC_RE)) {
    const glyph = match[0];
    if (!seen.has(glyph)) {
      seen.add(glyph);
      found.push(glyph);
    }
  }
  if (IPA_SLASH_WRAP_RE.test(trimmed)) {
    found.push('/.../');
  }
  return found;
}

export function hasIpaGlyphsInPhonetic(phonetic?: string | null): boolean {
  return findIpaGlyphsInPhonetic(phonetic).length > 0;
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

export function mergePronunciationEntry(
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

export function hasPronunciationEntryContent(entry?: Pronunciation | null): boolean {
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

export function lookupLexiconMatch(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string
): { readonly key: string; readonly entry: Pronunciation } | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.hasOwn(lexicon, trimmed)) {
    return { key: trimmed, entry: lexicon[trimmed] };
  }
  const lower = trimmed.toLowerCase();
  for (const [candidateKey, entry] of Object.entries(lexicon)) {
    if (candidateKey.trim().toLowerCase() === lower) {
      return { key: candidateKey, entry };
    }
  }
  return undefined;
}

export function lookupLexiconEntry(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string
): Pronunciation | undefined {
  return lookupLexiconMatch(lexicon, key)?.entry;
}

export function isLexiconEntryCompatibleWithPerson(entry: Pronunciation, fullNameLower: string): boolean {
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

export function lookupCompatiblePersonLexiconMatch(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string,
  fullNameLower: string
): { readonly key: string; readonly entry: Pronunciation } | undefined {
  const match = lookupLexiconMatch(lexicon, key);
  if (!match || !hasPronunciationEntryContent(match.entry)) {
    return undefined;
  }
  if (!isLexiconEntryCompatibleWithPerson(match.entry, fullNameLower)) {
    return undefined;
  }
  return match;
}

export function lookupCompatiblePersonLexiconEntry(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string,
  fullNameLower: string
): Pronunciation | undefined {
  return lookupCompatiblePersonLexiconMatch(lexicon, key, fullNameLower)?.entry;
}

export function tokenizePersonName(person: {
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

export function isSingleLetterInitial(token: string): boolean {
  return SINGLE_LETTER_INITIAL_RE.test(token.trim());
}

export function stripIpaDelimiters(ipa: string): string {
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

export function composeLanguageTag(entries: readonly Pronunciation[]): string | undefined {
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
    const qualified = rawLangs.find((l) => /[-_]/.test(l));
    return qualified ?? rawLangs[0];
  }
  // Omit a single language tag for mixed-language names so TTS follows the composed respelling.
  return undefined;
}

export function composeProvenance(entries: readonly Pronunciation[]): {
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

export function findSurnameTokenSpan(
  tokens: readonly string[],
  surname?: string
): { readonly start: number; readonly end: number } | null {
  if (tokens.length === 0) {
    return null;
  }
  let end = tokens.length;
  while (end > 1 && PERSON_NAME_DECORATION_RE.test(tokens[end - 1])) {
    end -= 1;
  }
  const surnameTokens = surname?.trim() ? tokenizePersonName({ full_name: surname }) : [];
  if (surnameTokens.length > 0 && surnameTokens.length <= end) {
    const start = end - surnameTokens.length;
    const matches = surnameTokens.every(
      (sTok, idx) => tokens[start + idx]?.toLowerCase() === sTok.toLowerCase()
    );
    if (matches) {
      return { start, end };
    }
  }
  if (end >= 2) {
    return { start: end - 1, end };
  }
  return surnameTokens.length > 0 ? { start: 0, end } : null;
}
