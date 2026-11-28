import type { Pronunciation, ResolvedPersonPronunciation } from './pronunciationSchema.js';

const IPA_GLYPHS_IN_PHONETIC_RE = /[əɚɜæɑɔʊʌɪɛʃʒθðŋˈˌː]/g;
const IPA_SLASH_WRAP_RE = /\/[^\s/](?:[^/]*[^\s/])?\//;

export const SINGLE_LETTER_INITIAL_RE = /^[\p{L}]\.?$/u;
export const PERSON_NAME_DECORATION_RE = /^(?:jr\.?|sr\.?|ii|iii|iv|v|vi)$/i;

export interface LexiconLowerIndexMeta {
  readonly byLower: Map<string, { readonly key: string; readonly entry: Pronunciation }>;
  readonly maxWordSpan: number;
  readonly hasMatchContainsRule: boolean;
  readonly resolvedPersonCache: Map<string, ResolvedPersonPronunciation | null>;
}

const lexiconLowerIndexCache = new WeakMap<Readonly<Record<string, Pronunciation>>, LexiconLowerIndexMeta>();

function countWhitespaceSeparatedWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i += 1) {
    const isSpace = text.charCodeAt(i) <= 32;
    if (!isSpace && !inWord) {
      words += 1;
      inWord = true;
    } else if (isSpace) {
      inWord = false;
    }
  }
  return words;
}

export function getLexiconLowerIndexMeta(
  lexicon: Readonly<Record<string, Pronunciation>>
): LexiconLowerIndexMeta {
  let cached = lexiconLowerIndexCache.get(lexicon);
  if (!cached) {
    const byLower = new Map<string, { readonly key: string; readonly entry: Pronunciation }>();
    let maxWords = 1;
    let hasMatchContainsRule = false;
    for (const [key, entry] of Object.entries(lexicon)) {
      const trimmed = key.trim();
      const lower = trimmed.toLowerCase();
      if (!byLower.has(lower)) {
        byLower.set(lower, { key, entry });
      }
      if (entry.match_full_name_contains !== undefined) {
        hasMatchContainsRule = true;
      }
      if (maxWords < 4 && trimmed.includes(' ')) {
        const wc = countWhitespaceSeparatedWords(trimmed);
        if (wc > maxWords) {
          maxWords = Math.min(4, wc);
        }
      }
    }
    cached = {
      byLower,
      maxWordSpan: maxWords,
      hasMatchContainsRule,
      resolvedPersonCache: new Map(),
    };
    lexiconLowerIndexCache.set(lexicon, cached);
  }
  return cached;
}

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
  if (trimmed.includes('/') && IPA_SLASH_WRAP_RE.test(trimmed)) {
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
    const entry = lexicon[trimmed];
    if (entry !== undefined) {
      return { key: trimmed, entry };
    }
  }
  return getLexiconLowerIndexMeta(lexicon).byLower.get(trimmed.toLowerCase());
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

const SIMPLE_PERSON_NAME_RE = /^[A-Za-z0-9 .'-]+$/;

function stripParentheticals(input: string): string {
  if (!input.includes('(')) {
    return input;
  }
  let out = '';
  let cursor = 0;
  while (cursor < input.length) {
    const openIdx = input.indexOf('(', cursor);
    if (openIdx === -1) {
      out += input.slice(cursor);
      break;
    }
    const closeIdx = input.indexOf(')', openIdx + 1);
    if (closeIdx === -1) {
      out += input.slice(cursor);
      break;
    }
    out += input.slice(cursor, openIdx);
    out += ' ';
    cursor = closeIdx + 1;
  }
  return out;
}

export function tokenizePersonName(person: {
  readonly full_name?: string | undefined;
  readonly given_name?: string | undefined;
  readonly surname?: string | undefined;
}): string[] {
  const rawFull = person.full_name?.trim() ?? '';
  const combined = rawFull || [person.given_name?.trim(), person.surname?.trim()].filter(Boolean).join(' ');
  if (!combined) {
    return [];
  }
  if (SIMPLE_PERSON_NAME_RE.test(combined)) {
    const parts = combined.split(/\s+/);
    const out: string[] = [];
    for (let tok of parts) {
      if (tok.startsWith("'") || tok.startsWith('-') || tok.startsWith('.')) {
        tok = tok.replace(/^['.-]+/, '');
      }
      if (tok.endsWith("'") || tok.endsWith('-')) {
        tok = tok.replace(/['-]+$/, '');
      }
      if (tok) {
        out.push(tok);
      }
    }
    return out;
  }
  const cleaned = stripParentheticals(combined).replaceAll(/[“”"]/g, ' ').replaceAll(/,/g, ' ').trim();
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(/\s+/)
    .map((tok) => tok.replace(/^[^A-Za-zÀ-ÖØ-öø-ÿ0-9]+/, '').replace(/[^A-Za-zÀ-ÖØ-öø-ÿ0-9.]+$/, ''))
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
  let firstLang: string | undefined;
  let firstLower: string | undefined;
  let allSameExact = true;
  for (const entry of entries) {
    const raw = entry.language?.trim();
    if (!raw) {
      continue;
    }
    if (firstLang === undefined) {
      firstLang = raw;
      firstLower = raw.toLowerCase();
    } else if (allSameExact && raw !== firstLang && raw.toLowerCase() !== firstLower) {
      allSameExact = false;
    }
  }
  if (firstLang === undefined) {
    return undefined;
  }
  if (allSameExact) {
    return firstLang;
  }
  const rawLangs = entries.map((e) => e.language?.trim()).filter((lang): lang is string => Boolean(lang));
  const baseLangs = new Set(
    rawLangs.map((l) => normalizeBaseLanguage(l)).filter((b): b is string => Boolean(b))
  );
  if (baseLangs.size === 1) {
    const qualified = rawLangs.find((l) => /[-_]/.test(l));
    return qualified ?? rawLangs[0];
  }
  return undefined;
}

export function composeProvenance(entries: readonly Pronunciation[]): {
  readonly source_label?: string | undefined;
  readonly source_url?: string | undefined;
  readonly region?: string | undefined;
} {
  let firstLabel: string | undefined;
  let firstLabelLower: string | undefined;
  let extraLabels: string[] | null = null;
  let seenLabels: Set<string> | null = null;

  let firstUrl: string | undefined;
  let multiUrl = false;

  let firstRegion: string | undefined;
  let multiRegion = false;

  for (const entry of entries) {
    const label = entry.source_label?.trim();
    if (label) {
      const lower = label.toLowerCase();
      if (firstLabel === undefined) {
        firstLabel = label;
        firstLabelLower = lower;
      } else if (lower !== firstLabelLower) {
        if (!seenLabels) {
          seenLabels = new Set([firstLabelLower ?? '', lower]);
          extraLabels = [firstLabel, label];
        } else if (!seenLabels.has(lower) && extraLabels) {
          seenLabels.add(lower);
          extraLabels.push(label);
        }
      }
    }
    const url = entry.source_url?.trim();
    if (url) {
      if (firstUrl === undefined) {
        firstUrl = url;
      } else if (url !== firstUrl) {
        multiUrl = true;
      }
    }
    const region = entry.region?.trim();
    if (region) {
      if (firstRegion === undefined) {
        firstRegion = region;
      } else if (region !== firstRegion) {
        multiRegion = true;
      }
    }
  }

  const out: {
    source_label?: string | undefined;
    source_url?: string | undefined;
    region?: string | undefined;
  } = {};
  if (extraLabels) {
    out.source_label = extraLabels.join(' + ');
  } else if (firstLabel !== undefined) {
    out.source_label = firstLabel;
  }
  if (firstUrl !== undefined && !multiUrl) {
    out.source_url = firstUrl;
  }
  if (firstRegion !== undefined && !multiRegion) {
    out.region = firstRegion;
  }
  return out;
}

export function findSurnameTokenSpan(
  tokens: readonly string[],
  surname?: string
): { readonly start: number; readonly end: number } | null {
  if (tokens.length === 0) {
    return null;
  }
  let end = tokens.length;
  while (end > 1) {
    const prevTok = tokens[end - 1];
    if (!prevTok || !PERSON_NAME_DECORATION_RE.test(prevTok)) {
      break;
    }
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
