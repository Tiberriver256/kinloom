import { z } from 'zod';

const CoercedEdtfStringSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) {
      return '';
    }
    return String(val);
  });

const OptionalCoercedStringSchema = z
  .union([z.string(), z.number(), z.null()])
  .transform((val) => (val === null ? null : String(val)))
  .optional();

export const EventScopeSchema = z.enum([
  'personal',
  'family',
  'local',
  'state',
  'national',
  'global',
]);

export const EventKindSchema = z.enum([
  'point_event',
  'residence_anchor',
  'context_span',
]);

export const ConfidenceTierSchema = z.enum(['Confirmed', 'Inferred', 'Possible']);

export const PlaceTypeSchema = z.enum([
  'country',
  'state',
  'county',
  'town',
  'homestead',
]);

export const KinshipRelationSchema = z.enum(['parent', 'child', 'spouse']);

export const SourceConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const ArchivalMediaKindSchema = z.enum([
  'document_scan',
  'portrait',
  'family_photo',
  'headstone',
  'record_scan',
  'milestone',
  'video_story',
  'audio_oral_history',
]);

export const BuildModeSchema = z.enum(['public', 'private']);

export const NarrativeKindSchema = z.enum([
  'biography',
  'family_story',
  'research_note',
  'memoir',
]);

export const AlternateDateSchema = z.object({
  edtf_date: CoercedEdtfStringSchema,
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const AlternatePlaceSchema = z.object({
  place_name: z.string().min(1),
  place_id: z.string().nullable().optional(),
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const FactConflictSchema = z.object({
  claim: z.string().min(1),
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const EventParticipantSchema = z.object({
  person_id: z.string().min(1),
  role: z.string().min(1),
});

export const EventSourceRefSchema = z.object({
  source_id: z.string().min(1),
  confidence: SourceConfidenceSchema,
  claimed_date: OptionalCoercedStringSchema,
  citation_detail: z.string().nullable().optional(),
  scan_url: z.string().nullable().optional(),
  scan_title: z.string().nullable().optional(),
});

export const HistoricalNameSchema = z.object({
  name: z.string().min(1),
  valid_from: OptionalCoercedStringSchema,
  valid_to: OptionalCoercedStringSchema,
});

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

/**
 * Merge a base pronunciation lexicon with live overrides, resolving case-insensitive
 * key collisions so an override always supersedes any differently cased base key.
 */
export function mergePronunciationLexicons(
  base?: Readonly<Record<string, Pronunciation>> | null,
  override?: Readonly<Record<string, Pronunciation>> | null,
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
  own: Pronunciation | undefined,
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

const US_STATE_NAMES = new Set([
  'alabama',
  'alaska',
  'arizona',
  'arkansas',
  'california',
  'colorado',
  'connecticut',
  'delaware',
  'florida',
  'georgia',
  'hawaii',
  'idaho',
  'illinois',
  'indiana',
  'iowa',
  'kansas',
  'kentucky',
  'louisiana',
  'maine',
  'maryland',
  'massachusetts',
  'michigan',
  'minnesota',
  'mississippi',
  'missouri',
  'montana',
  'nebraska',
  'nevada',
  'new hampshire',
  'new jersey',
  'new mexico',
  'new york',
  'north carolina',
  'north dakota',
  'ohio',
  'oklahoma',
  'oregon',
  'pennsylvania',
  'rhode island',
  'south carolina',
  'south dakota',
  'tennessee',
  'texas',
  'utah',
  'vermont',
  'virginia',
  'washington',
  'west virginia',
  'wisconsin',
  'wyoming',
  'district of columbia',
]);

const COUNTRY_TOKEN_PATTERNS: readonly { readonly code: string; readonly tokens: readonly string[] }[] = [
  {
    code: 'US',
    tokens: ['united states', 'united states of america', 'usa', 'u.s.a.', 'u.s.'],
  },
  {
    code: 'NL',
    tokens: [
      'netherlands',
      'the netherlands',
      'nederland',
      'north holland',
      'south holland',
      'noord-holland',
      'zuid-holland',
      'noord-brabant',
      'north brabant',
      'gelderland',
      'friesland',
      'fryslân',
      'groningen',
      'overijssel',
      'drenthe',
      'utrecht',
      'flevoland',
      'limburg',
    ],
  },
  {
    code: 'BE',
    tokens: ['belgium', 'belgië', 'belgique', 'flanders', 'vlaanderen', 'wallonia'],
  },
  {
    code: 'GB',
    tokens: ['united kingdom', 'great britain', 'england', 'scotland', 'wales', 'northern ireland', 'uk'],
  },
  {
    code: 'SE',
    tokens: ['sweden', 'sverige', 'värmland', 'dalarna', 'skåne', 'småland', 'östergötland', 'västergötland', 'bergslagen'],
  },
  {
    code: 'FI',
    tokens: ['finland', 'suomi', 'ostrobothnia', 'pohjanmaa', 'satakunta', 'karelia', 'karjala'],
  },
  {
    code: 'PL',
    tokens: ['poland', 'polska', 'galicia', 'pomerania', 'silesia', 'masovia', 'greater poland'],
  },
  {
    code: 'DE',
    tokens: ['germany', 'deutschland', 'prussia', 'preußen', 'bavaria', 'bayern', 'saxony', 'sachsen', 'hanover', 'hannover', 'hesse', 'hessen', 'westphalia', 'württemberg', 'baden'],
  },
  {
    code: 'CA',
    tokens: ['canada', 'ontario', 'quebec', 'québec', 'nova scotia', 'new brunswick', 'manitoba', 'saskatchewan', 'alberta', 'british columbia'],
  },
  {
    code: 'IE',
    tokens: ['ireland', 'éire'],
  },
  {
    code: 'NO',
    tokens: ['norway', 'norge'],
  },
  {
    code: 'DK',
    tokens: ['denmark', 'danmark'],
  },
  {
    code: 'FR',
    tokens: ['france'],
  },
  {
    code: 'IT',
    tokens: ['italy', 'italia'],
  },
  {
    code: 'AU',
    tokens: ['australia'],
  },
  {
    code: 'NZ',
    tokens: ['new zealand'],
  },
];

const LANGUAGE_COMPATIBLE_COUNTRIES: Readonly<Record<string, ReadonlySet<string>>> = {
  nl: new Set(['NL', 'BE']),
  sv: new Set(['SE', 'FI']),
  fi: new Set(['FI', 'SE']),
  pl: new Set(['PL']),
  de: new Set(['DE', 'AT', 'CH']),
  fr: new Set(['FR', 'BE', 'CH', 'CA']),
  it: new Set(['IT', 'CH']),
  no: new Set(['NO']),
  nb: new Set(['NO']),
  nn: new Set(['NO']),
  da: new Set(['DK']),
  en: new Set(['US', 'GB', 'CA', 'IE', 'AU', 'NZ']),
};

function splitPlaceSegments(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function inferCountryCodeFromSegments(segments: readonly string[]): string | null {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const seg = segments[i].toLowerCase();
    for (const entry of COUNTRY_TOKEN_PATTERNS) {
      if (entry.tokens.includes(seg)) {
        return entry.code;
      }
    }
    if (US_STATE_NAMES.has(seg)) {
      return 'US';
    }
  }
  const joined = segments.join(', ').toLowerCase();
  for (const entry of COUNTRY_TOKEN_PATTERNS) {
    for (const token of entry.tokens) {
      if (token.length >= 4 && joined.includes(token)) {
        return entry.code;
      }
    }
  }
  for (const state of US_STATE_NAMES) {
    if (joined.includes(state)) {
      return 'US';
    }
  }
  return null;
}

function getPlaceQualifierSegments(place: { readonly name?: string; readonly full_name?: string }): string[] {
  const fullName = place.full_name?.trim();
  if (!fullName) {
    return [];
  }
  const segments = splitPlaceSegments(fullName);
  const nameLower = place.name?.trim().toLowerCase();
  if (segments.length > 1 && nameLower && segments[0].toLowerCase() === nameLower) {
    return segments.slice(1);
  }
  return segments;
}

function languageCompatibleCountries(language: string): ReadonlySet<string> | null {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const parts = normalized.split(/[-_]/);
  const primary = parts[0];
  const subtag = parts[1]?.toUpperCase();
  if (subtag && /^[A-Z]{2}$/.test(subtag)) {
    return new Set([subtag]);
  }
  return LANGUAGE_COMPATIBLE_COUNTRIES[primary] ?? null;
}

function isBareLexiconEntryCompatibleWithPlace(
  entry: Pronunciation,
  place: { readonly name?: string; readonly full_name?: string },
): boolean {
  const fullName = place.full_name?.trim() ?? '';
  const fullNameLower = fullName.toLowerCase();

  if (entry.match_full_name_contains !== undefined) {
    const needles = Array.isArray(entry.match_full_name_contains)
      ? entry.match_full_name_contains
      : [entry.match_full_name_contains];
    const validNeedles = needles.map((n) => n.trim().toLowerCase()).filter(Boolean);
    if (validNeedles.length > 0) {
      if (!fullNameLower || !validNeedles.some((needle) => fullNameLower.includes(needle))) {
        return false;
      }
    }
  }

  const qualifierSegments = getPlaceQualifierSegments(place);
  const placeCountry = qualifierSegments.length > 0 ? inferCountryCodeFromSegments(qualifierSegments) : null;

  if (entry.region?.trim() && fullNameLower) {
    const regionSegments = splitPlaceSegments(entry.region);
    const regionCountry = inferCountryCodeFromSegments(regionSegments);
    const qualifierJoined = qualifierSegments.join(', ').toLowerCase();
    const directRegionMatch =
      fullNameLower.includes(entry.region.trim().toLowerCase()) ||
      regionSegments.some((seg) => qualifierJoined.includes(seg.toLowerCase()));

    if (regionCountry && placeCountry && regionCountry !== placeCountry) {
      return false;
    }
    if (!directRegionMatch && (!regionCountry || !placeCountry || regionCountry !== placeCountry)) {
      return false;
    }
  }

  if (entry.language?.trim() && placeCountry) {
    const compatibleCountries = languageCompatibleCountries(entry.language);
    if (compatibleCountries && !compatibleCountries.has(placeCountry)) {
      return false;
    }
  }

  return true;
}

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

function hasPronunciationEntryContent(entry?: Pronunciation | null): boolean {
  if (!entry) {
    return false;
  }
  if (
    Boolean(entry.phonetic?.trim()) ||
    Boolean(entry.ipa?.trim()) ||
    Boolean(entry.audio_url?.trim()) ||
    Boolean(entry.note?.trim())
  ) {
    return true;
  }
  return Boolean(
    entry.variants?.some(
      (v) =>
        Boolean(v.phonetic?.trim()) ||
        Boolean(v.ipa?.trim()) ||
        Boolean(v.audio_url?.trim()) ||
        Boolean(v.note?.trim()),
    ),
  );
}

function lookupLexiconEntry(
  lexicon: Readonly<Record<string, Pronunciation>>,
  key: string,
): Pronunciation | undefined {
  const trimmed = key.trim();
  if (!trimmed) {
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(lexicon, trimmed)) {
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

function isLexiconEntryCompatibleWithPerson(
  entry: Pronunciation,
  fullNameLower: string,
): boolean {
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
  fullNameLower: string,
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
  const combined =
    rawFull || [person.given_name?.trim(), person.surname?.trim()].filter(Boolean).join(' ');
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
  const rawLangs = entries
    .map((e) => e.language?.trim())
    .filter((lang): lang is string => Boolean(lang));
  if (rawLangs.length === 0) {
    return undefined;
  }
  const uniqueExact = new Set(rawLangs.map((l) => l.toLowerCase()));
  if (uniqueExact.size === 1) {
    return rawLangs[0];
  }
  const baseLangs = new Set(
    rawLangs.map((l) => normalizeBaseLanguage(l)).filter((b): b is string => Boolean(b)),
  );
  if (baseLangs.size === 1) {
    // Prefer a region-qualified tag (e.g. en-US over en) if all share one base language.
    const qualified = rawLangs.find((l) => /[-_]/.test(l));
    return qualified ?? rawLangs[0];
  }
  // Mixed-language full names (e.g. English given name + Dutch surname) omit a single
  // language tag so TTS speaks the composed respelling rather than mangling one half.
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
  fullNameLower: string,
): { readonly resolved: ResolvedPersonPronunciation | null; readonly missingParts: readonly string[] } {
  if (tokens.length === 0) {
    return { resolved: null, missingParts: [] };
  }

  const parts: ComposedTokenPart[] = [];
  const missingParts: string[] = [];
  let resolvedMeaningfulCount = 0;

  let idx = 0;
  while (idx < tokens.length) {
    // Greedy longest-phrase match (up to 4 tokens) so multi-word surnames like "van der Berg" match atomically.
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

    // Hyphenated name tokens (e.g. "Anne-Marie" or "Smith-Jones"): compose sub-parts when each resolves.
    if (token.includes('-')) {
      const subTokens = token.split('-').map((s) => s.trim()).filter(Boolean);
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
          idx += 1;
          continue;
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
    .filter((p): p is ComposedTokenPart & { readonly entry: Pronunciation } => p.kind === 'resolved' && Boolean(p.entry))
    .map((p) => p.entry);

  const allHavePhonetic = resolvedEntries.every((e) => Boolean(e.phonetic?.trim()));
  const allHaveIpa = resolvedEntries.every((e) => Boolean(e.ipa?.trim()));

  let phonetic: string | undefined;
  if (allHavePhonetic) {
    let out = '';
    for (const part of parts) {
      const piece =
        part.kind === 'resolved' ? (part.entry?.phonetic?.trim() ?? '') : part.token;
      if (!piece) {
        continue;
      }
      if (!out) {
        out = piece;
      } else if (part.joinWithHyphen) {
        out += `-${piece}`;
      } else {
        out += ` ${piece}`;
      }
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
      if (!out) {
        out = piece;
      } else if (part.joinWithHyphen) {
        out += `-${piece}`;
      } else {
        out += ` ${piece}`;
      }
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
  lexicon?: Readonly<Record<string, Pronunciation>> | null,
): ResolvedPersonPronunciation | null {
  if (person.is_living || person.full_name?.trim() === 'Living') {
    return null;
  }

  const fullNameTrimmed = person.full_name?.trim() ?? '';
  const fullNameLower = fullNameTrimmed.toLowerCase();
  const idKey = person.id?.trim() ?? '';

  const exactIdEntry =
    lexicon && idKey ? lookupLexiconEntry(lexicon, idKey) : undefined;
  const exactFullNameEntry =
    lexicon && fullNameTrimmed
      ? lookupCompatiblePersonLexiconEntry(lexicon, fullNameTrimmed, fullNameLower)
      : undefined;
  const exactShared =
    exactIdEntry && hasPronunciationEntryContent(exactIdEntry)
      ? exactIdEntry
      : exactFullNameEntry;

  // 1. Explicit person.pronunciation always wins with full coverage.
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

  // 2. Exact person-ID or exact full-name entry in shared lexicon.
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

  // 3. Compositional full-name resolution across every meaningful token.
  const tokens = tokenizePersonName(person);
  const { resolved: composed, missingParts } = resolveCompositionalPersonPronunciation(
    tokens,
    lexicon,
    fullNameLower,
  );
  if (composed) {
    return composed;
  }

  // 4. Surname-only fallback so existing archives never regress.
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
  lexicon?: Readonly<Record<string, Pronunciation>> | null,
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
        Object.entries(lexicon).find(
          ([k]) => k.toLowerCase() === fullNameKey.toLowerCase(),
        )?.[1];
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
          (q) =>
            qualifierSegments.includes(q) ||
            (q.length >= 3 && qualifierJoined.includes(q)),
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
        Object.entries(lexicon).find(
          ([k]) => k.toLowerCase() === nameKey.toLowerCase(),
        )?.[1];
      if (bareEntry && isBareLexiconEntryCompatibleWithPlace(bareEntry, place)) {
        shared = bareEntry;
      }
    }
  }

  const own = place.pronunciation ?? undefined;
  return mergePronunciationEntry(shared, own);
}

export const RawPersonSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  gedcom_xref: z.string().nullable().optional(),
  full_name: z.string(),
  given_name: z.string(),
  surname: z.string(),
  alt_names: z.array(z.string()).default([]),
  sex: z.string().default('U'),
  is_living: z.boolean().default(false),
  lineage_group: z.string().default('extended'),
  branch: z.string().optional(),
  birth_edtf: CoercedEdtfStringSchema.default(''),
  death_edtf: CoercedEdtfStringSchema.default(''),
  portrait_url: z.string().nullable().default(null),
  thumb_url: z.string().nullable().optional(),
  pronunciation: PronunciationSchema.nullable().optional(),
  has_primary_source: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const PersonSchema = RawPersonSchema.extend({
  birth_year: z.number().int().nullable(),
  death_year: z.number().int().nullable(),
  event_count: z.number().int().nonnegative(),
  media_count: z.number().int().nonnegative().optional(),
  primary_place_id: z.string().nullable(),
});

export const PlaceSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  place_type: PlaceTypeSchema,
  parent_id: z.string().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  min_lat: z.number().optional(),
  max_lat: z.number().optional(),
  min_lng: z.number().optional(),
  max_lng: z.number().optional(),
  ancestor_ids: z.array(z.string()).optional(),
  historical_names: z.array(HistoricalNameSchema).optional(),
  summary: z.string().nullable().optional(),
  photo_url: z.string().nullable().optional(),
  photo_caption: z.string().nullable().optional(),
  pronunciation: PronunciationSchema.nullable().optional(),
  sources: z.array(EventSourceRefSchema).optional(),
  has_primary_source: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const RawEventSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: EventScopeSchema,
  event_kind: EventKindSchema,
  category: z.string().nullable().optional(),
  edtf_date: CoercedEdtfStringSchema.default(''),
  alternate_dates: z.array(AlternateDateSchema).optional(),
  alternate_places: z.array(AlternatePlaceSchema).optional(),
  fact_conflicts: z.array(FactConflictSchema).optional(),
  place_id: z.string().nullable().default(null),
  place_precision: z.string().nullable().optional(),
  summary: z.string().nullable().default('').transform((v) => v ?? ''),
  severity_rank: z.number().nullable().optional(),
  weather_metrics: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  source_url: z.string().nullable().optional(),
  photo_url: z.string().nullable().optional(),
  photo_placeholder_caption: z.string().nullable().optional(),
  participants: z.array(EventParticipantSchema).default([]),
  sources: z.array(EventSourceRefSchema).default([]),
  has_primary_source: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const ArchiveEventSchema = RawEventSchema.extend({
  display_date: z.string(),
  year: z.number().int().nullable(),
  time_min: z.number().int().nullable(),
  time_max: z.number().int().nullable(),
  place_ancestors: z.array(z.string()).optional(),
});

export const NarrativeEnrichmentOverrideSchema = z.object({
  override_event_id: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  alternate_dates: z.array(AlternateDateSchema).optional(),
  alternate_places: z.array(AlternatePlaceSchema).optional(),
  fact_conflicts: z.array(FactConflictSchema).optional(),
  sources: z.array(EventSourceRefSchema).optional(),
  category: z.string().optional(),
  severity_rank: z.number().optional(),
  photo_url: z.string().optional(),
  photo_placeholder_caption: z.string().optional(),
});

export const NarrativeEnrichmentSchema = z.union([
  NarrativeEnrichmentOverrideSchema,
  RawEventSchema,
]);

export const ResidenceSpanSchema = z.object({
  id: z.string().min(1),
  person_id: z.string().min(1),
  place_id: z.string().min(1),
  time_min: z.number().int(),
  time_max: z.number().int(),
  start_year: z.number().int().nullable(),
  end_year: z.number().int().nullable(),
  confidence_tier: ConfidenceTierSchema,
  from_event_id: z.string().min(1),
  to_event_id: z.string().min(1),
});

export const KinshipEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: KinshipRelationSchema,
  family_xref: z.string().nullable().optional(),
});

export const SourceRecordSchema = z.object({
  id: z.string().min(1),
  gedcom_xref: z.string().nullable().optional(),
  citation: z.string(),
  author: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  source_type: z.string(),
  repository: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  has_primary_source: z.boolean().optional(),
});

export const MediaItemSchema = z.object({
  id: z.string().min(1),
  kind: ArchivalMediaKindSchema,
  source_id: z.string().nullable().optional(),
  page: z.number().int().nullable().optional(),
  person_id: z.string().nullable().optional(),
  person_ids: z.array(z.string().min(1)).optional(),
  person_slug: z.string().nullable().optional(),
  person_name: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  file: z.string().min(1),
  thumb_file: z.string().nullable().optional(),
  caption: z.string(),
  date_edtf: OptionalCoercedStringSchema,
  provenance: z.string().nullable().optional(),
  mime_type: z.string().min(1).nullable().optional(),
  duration_seconds: z.number().nonnegative().nullable().optional(),
  poster_url: z.string().min(1).nullable().optional(),
  transcript_url: z.string().min(1).nullable().optional(),
  has_primary_source: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const NarrativeSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  kind: NarrativeKindSchema.optional(),
  subject_person_id: z.string().min(1).optional(),
  title: z.string().min(1),
  summary: z.string().optional(),
  body_md: z.string(),
  date_edtf: OptionalCoercedStringSchema,
  person_ids: z.array(z.string().min(1)).default([]),
  place_ids: z.array(z.string().min(1)).default([]),
  event_ids: z.array(z.string().min(1)).default([]),
  source_ids: z.array(z.string().min(1)).default([]),
  updated_at: z.string().optional(),
  has_primary_source: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export const ReadingPageSchema = z.object({
  page: z.number().int().positive(),
  label: z.string().min(1),
  file: z.string().min(1),
  text: z.string(),
  image_url: z.string().optional(),
});

export const ReadingDocumentSchema = z.object({
  source_id: z.string().min(1),
  title: z.string().min(1),
  author: z.string(),
  provenance: z.string(),
  pdf_url: z.string().optional(),
  pdf_size_bytes: z.number().int().nonnegative().optional(),
  pages: z.array(ReadingPageSchema),
});

export const ReadingsBundleSchema = z.object({
  version: z.number().int().positive(),
  documents: z.record(z.string(), ReadingDocumentSchema),
  event_page_map: z.record(z.string(), z.record(z.string(), z.number().int())),
});

export const HistoricalContextItemSchema = RawEventSchema.extend({
  scope: z.enum(['local', 'state', 'national', 'global']),
});

export const ArchiveBundleCountsSchema = z.object({
  people: z.number().int().nonnegative(),
  living_redacted: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  residence_spans: z.number().int().nonnegative(),
  places: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  media: z.number().int().nonnegative().optional(),
  narratives: z.number().int().nonnegative().optional(),
});

export const ArchiveBundleMetaSchema = z.object({
  version: z.string().optional(),
  build_mode: BuildModeSchema,
  generated_at: z.string(),
  max_revision_id: z.number().int().nonnegative().optional(),
  uncited_entity_keys: z.array(z.string()).optional(),
  counts: ArchiveBundleCountsSchema,
});

export const ArchiveBundleSchema = z.object({
  meta: ArchiveBundleMetaSchema,
  people: z.array(PersonSchema),
  events: z.array(ArchiveEventSchema),
  residence_spans: z.array(ResidenceSpanSchema),
  places: z.array(PlaceSchema),
  place_ancestors: z.record(z.string(), z.array(z.string())),
  kinship: z.array(KinshipEdgeSchema),
  sources: z.array(SourceRecordSchema),
  media: z.array(MediaItemSchema).optional(),
  narratives: z.array(NarrativeSchema).optional(),
  pronunciations: z.record(z.string(), PronunciationSchema).optional(),
});

export type EventScope = z.infer<typeof EventScopeSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
export type ConfidenceTier = z.infer<typeof ConfidenceTierSchema>;
export type PlaceType = z.infer<typeof PlaceTypeSchema>;
export type KinshipRelation = z.infer<typeof KinshipRelationSchema>;
export type SourceConfidence = z.infer<typeof SourceConfidenceSchema>;
export type ArchivalMediaKind = z.infer<typeof ArchivalMediaKindSchema>;
export type BuildMode = z.infer<typeof BuildModeSchema>;
export type NarrativeKind = z.infer<typeof NarrativeKindSchema>;

export type AlternateDate = z.infer<typeof AlternateDateSchema>;
export type AlternatePlace = z.infer<typeof AlternatePlaceSchema>;
export type FactConflict = z.infer<typeof FactConflictSchema>;
export type EventParticipant = z.infer<typeof EventParticipantSchema>;
export type EventSourceRef = z.infer<typeof EventSourceRefSchema>;
export type HistoricalName = z.infer<typeof HistoricalNameSchema>;
export type RawPerson = z.infer<typeof RawPersonSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type RawEvent = z.infer<typeof RawEventSchema>;
export type ArchiveEvent = z.infer<typeof ArchiveEventSchema>;
export type NarrativeEnrichmentOverride = z.infer<typeof NarrativeEnrichmentOverrideSchema>;
export type NarrativeEnrichment = z.infer<typeof NarrativeEnrichmentSchema>;
export type ResidenceSpan = z.infer<typeof ResidenceSpanSchema>;
export type KinshipEdge = z.infer<typeof KinshipEdgeSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type MediaItem = z.infer<typeof MediaItemSchema>;
export type Narrative = z.infer<typeof NarrativeSchema>;
export type ReadingPage = z.infer<typeof ReadingPageSchema>;
export type ReadingDocument = z.infer<typeof ReadingDocumentSchema>;
export type ReadingsBundle = z.infer<typeof ReadingsBundleSchema>;
export type HistoricalContextItem = z.infer<typeof HistoricalContextItemSchema>;
export type ArchiveBundle = z.infer<typeof ArchiveBundleSchema>;

export interface MediaChecklistItem {
  person_id: string;
  person_slug: string;
  person_name: string;
  lifespan: string;
  obje_xref: string;
  title: string;
  media_type: string;
  form: string;
  status?: 'digitized' | 'missing';
  file?: string;
}

export interface CoPresenceItem {
  person: Person;
  tier: ConfidenceTier;
  distanceMiles: number | null;
  sameHousehold: boolean;
  kinshipLabel: string;
  kinshipRank: number;
  placeId: string | null;
  matchedEventId: string | null;
}

export interface RadarSnapshot {
  coPresenceVisible: CoPresenceItem[];
  coPresenceOverflow: CoPresenceItem[];
  localVisible: ArchiveEvent[];
  localOverflow: ArchiveEvent[];
  macroVisible: ArchiveEvent[];
  macroOverflow: ArchiveEvent[];
}

export interface SourceReaderRequest {
  sourceId: string;
  eventId?: string;
  page?: number;
  highlightQuery?: string;
}

export interface SourceInspectorRequest {
  sourceId: string;
  eventId?: string;
  citationDetail?: string;
  claimedDate?: string;
  scanUrl?: string;
  scanTitle?: string;
  confidence?: SourceConfidence;
}

/**
 * Returns every person ID linked to a media item across both `person_ids` and legacy `person_id`.
 */
export function getMediaPersonIds(item: Pick<MediaItem, 'person_id' | 'person_ids'>): string[] {
  const ids = new Set<string>();
  if (item.person_id) {
    ids.add(item.person_id);
  }
  if (item.person_ids) {
    for (const id of item.person_ids) {
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}
