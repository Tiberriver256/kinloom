import {
  findIpaGlyphsInPhonetic,
  type Place,
  type Pronunciation,
  type PronunciationVariant,
  type RawPerson,
} from '@kinloom/core';
import {
  normalizeLangCode,
  type PronounceHomonymCollision,
  type PronounceLivingLeak,
  type PronounceQualityWarning,
} from './types.js';

const NON_ENGLISH_COUNTRY_HINTS = [
  'netherlands',
  'nederland',
  'holland',
  'zeeland',
  'friesland',
  'gelderland',
  'sweden',
  'sverige',
  'finland',
  'suomi',
  'poland',
  'polska',
  'germany',
  'deutschland',
  'prussia',
  'preußen',
  'belgium',
  'belgië',
  'norway',
  'norge',
  'denmark',
  'danmark',
  'france',
  'italy',
  'italia',
  'austria',
  'switzerland',
];

const NON_TRIVIAL_PLACE_PATTERNS: readonly RegExp[] = [
  /(?:dijk|kerk|stad|holm|vik|berg|borg|huizen|woude|zand|sluis|meer|veld|veen|buren|dam|sloot)$/i,
  /(?:järvi|koski|mäki|lahti|niemi|luoto|pää|kylä)$/i,
  /(?:sz|cz|rz|dz|ść|ź|ł|ń|ś|ć)/i,
  /(?:ij|oe|ui|eu|aa|ee|oo|uu)/i,
  /(?:ough|augh|sch|tz|ckh|gham|cester|wich|borough|burgh)/i,
];

interface ForeignIpaRule {
  readonly pattern: RegExp;
  readonly tokenLabel: string;
}

const COMMON_ENGLISH_IPA_RULES: readonly ForeignIpaRule[] = [
  { pattern: /[ɝɚ]/, tokenLabel: 'rhotic schwa (/ɝ/ or /ɚ/)' },
  { pattern: /ɜː?r/, tokenLabel: 'English r-colored /ɜːr/' },
  { pattern: /ɹ/, tokenLabel: 'English approximant /ɹ/' },
  { pattern: /oʊ/, tokenLabel: 'English diphthong /oʊ/' },
  { pattern: /eɪ/, tokenLabel: 'English diphthong /eɪ/' },
  { pattern: /[θð]/, tokenLabel: 'English dental fricative (/θ/ or /ð/)' },
];

const ENGLISH_AI_DIPHTHONG_RULE: ForeignIpaRule = {
  pattern: /aɪ/,
  tokenLabel: 'English diphthong /aɪ/',
};

const FOREIGN_IPA_SUSPICIOUS_RULES: Readonly<Record<string, readonly ForeignIpaRule[]>> = {
  nl: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    { pattern: /aɪ(?![̯])/, tokenLabel: 'English diphthong /aɪ/' },
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  sv: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  fi: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  pl: [
    ...COMMON_ENGLISH_IPA_RULES.slice(0, 3),
    ENGLISH_AI_DIPHTHONG_RULE,
    ...COMMON_ENGLISH_IPA_RULES.slice(3),
  ],
  de: COMMON_ENGLISH_IPA_RULES,
};

function hasNonAsciiChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return true;
    }
  }
  return false;
}

export function inspectNonTrivialPlaceReason(place: Place): string | null {
  const fullLower = place.full_name.toLowerCase();
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const qualifierJoined = segments.length > 1 ? segments.slice(1).join(', ') : fullLower;

  for (const countryHint of NON_ENGLISH_COUNTRY_HINTS) {
    if (qualifierJoined.includes(countryHint)) {
      return `foreign place (${countryHint})`;
    }
  }
  if (hasNonAsciiChar(place.name)) {
    return 'non-ASCII orthography';
  }
  for (const pattern of NON_TRIVIAL_PLACE_PATTERNS) {
    if (pattern.test(place.name)) {
      return 'non-trivial orthography';
    }
  }
  return null;
}

export function derivePlaceScopeHint(place: Place): string {
  const segments = place.full_name
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) {
    return place.full_name;
  }
  return segments.slice(-2).join(', ');
}

export function inspectPronunciationQuality(
  scope: 'lexicon' | 'person' | 'place',
  key: string,
  entry: Pick<Pronunciation, 'phonetic' | 'ipa' | 'language' | 'audio_url' | 'note'> | PronunciationVariant,
  warnings: PronounceQualityWarning[]
): void {
  const phonetic = entry.phonetic?.trim() ?? '';
  const ipa = entry.ipa?.trim() ?? '';
  const audioUrl = entry.audio_url?.trim() ?? '';
  const language = entry.language?.trim() ?? '';

  if (!phonetic && !ipa && !audioUrl) {
    warnings.push({
      scope,
      key,
      code: 'empty_entry',
      ...(language ? { language } : {}),
      message: `Entry '${key}' has no Respelling, IPA, or audio_url.`,
    });
    return;
  }

  if (phonetic) {
    const ipaGlyphs = findIpaGlyphsInPhonetic(phonetic);
    if (ipaGlyphs.length > 0) {
      warnings.push({
        scope,
        key,
        code: 'ipa_in_phonetic',
        ...(language ? { language } : {}),
        phonetic,
        ipa_glyphs: ipaGlyphs,
        message: `Entry '${key}' Respelling '${phonetic}' contains IPA symbol(s) (${ipaGlyphs.join(', ')}). Use plain English syllables in phonetic (Respelling) and put IPA in ipa.`,
      });
    }
  }

  if (ipa) {
    const validSlashed = ipa.startsWith('/') && ipa.endsWith('/') && ipa.length > 2;
    const validBracketed = ipa.startsWith('[') && ipa.endsWith(']') && ipa.length > 2;
    if (!validSlashed && !validBracketed) {
      warnings.push({
        scope,
        key,
        code: 'malformed_ipa',
        ...(language ? { language } : {}),
        ipa,
        message: `Entry '${key}' has unslashed/malformed IPA '${ipa}' (expected /.../ or [...]).`,
      });
    } else {
      const inner = ipa.slice(1, -1).trim();
      if (!inner || /[A-Z]{2,}/.test(inner)) {
        warnings.push({
          scope,
          key,
          code: 'malformed_ipa',
          ...(language ? { language } : {}),
          ipa,
          message: `Entry '${key}' IPA '${ipa}' looks malformed or contains uppercase Respelling.`,
        });
      }
    }

    const baseLang = normalizeLangCode(language);
    if (baseLang && FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
      const matchedLabels: string[] = [];
      for (const rule of FOREIGN_IPA_SUSPICIOUS_RULES[baseLang]) {
        if (rule.pattern.test(ipa)) {
          matchedLabels.push(rule.tokenLabel);
        }
      }
      if (matchedLabels.length > 0) {
        warnings.push({
          scope,
          key,
          code: 'suspicious_english_ipa_for_foreign_lang',
          language,
          ipa,
          message: `Entry '${key}' (language=${language}) contains suspicious English IPA token(s): ${matchedLabels.join(', ')}.`,
        });
      }
    }
  }
}

export function hasPronunciationValues(entry?: Pronunciation | null): boolean {
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

export function detectLivingPronunciationLeaks(
  livingPeople: readonly { index: number; person: RawPerson }[],
  deceasedPeople: readonly RawPerson[],
  lexiconLowerKeys: ReadonlyMap<string, string>
): PronounceLivingLeak[] {
  const deceasedFullNamesLower = new Set(
    deceasedPeople.map((p) => p.full_name.trim().toLowerCase()).filter(Boolean)
  );
  const deceasedIdsLower = new Set(deceasedPeople.map((p) => p.id.trim().toLowerCase()));
  const livingLeaks: PronounceLivingLeak[] = [];

  for (const { index, person } of livingPeople) {
    if (hasPronunciationValues(person.pronunciation)) {
      livingLeaks.push({
        scope: 'person',
        location: `data/people.yaml record #${index}`,
        reason: 'Living person record contains a pronunciation entry (redacted for privacy).',
      });
    }
    const idLower = person.id.trim().toLowerCase();
    if (idLower && !deceasedIdsLower.has(idLower) && lexiconLowerKeys.has(idLower)) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason: 'Pronunciation Lexicon contains a key matching a living person ID (redacted for privacy).',
      });
    }
    const fullLower = person.full_name.trim().toLowerCase();
    if (
      fullLower &&
      fullLower !== 'living' &&
      !deceasedFullNamesLower.has(fullLower) &&
      lexiconLowerKeys.has(fullLower)
    ) {
      livingLeaks.push({
        scope: 'lexicon',
        location: `kinloom.config.yaml pronunciations (matches data/people.yaml record #${index})`,
        reason:
          'Pronunciation Lexicon contains a full-name key matching a living person (redacted for privacy).',
      });
    }
  }

  return livingLeaks;
}

export function detectHomonymousPlaceCollisions(
  places: readonly Place[],
  lexicon: Readonly<Record<string, Pronunciation>>
): PronounceHomonymCollision[] {
  const placesByBareNameLower = new Map<string, Place[]>();
  for (const place of places) {
    const lower = place.name.trim().toLowerCase();
    if (!lower) {
      continue;
    }
    const list = placesByBareNameLower.get(lower) ?? [];
    list.push(place);
    placesByBareNameLower.set(lower, list);
  }

  const homonymousCollisions: PronounceHomonymCollision[] = [];
  for (const [key] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    if (key.includes(',') || key.startsWith('plc_')) {
      continue;
    }
    const matchingPlaces = placesByBareNameLower.get(key.trim().toLowerCase());
    if (!matchingPlaces || matchingPlaces.length < 2) {
      continue;
    }
    const distinctScopes = new Set(matchingPlaces.map((p) => derivePlaceScopeHint(p).toLowerCase()));
    if (distinctScopes.size < 2) {
      continue;
    }
    const sortedMatches = [...matchingPlaces].toSorted((a, b) => a.full_name.localeCompare(b.full_name));
    const exampleKeys = sortedMatches
      .slice(0, 2)
      .map((p) => `"${p.name}, ${derivePlaceScopeHint(p)}"`)
      .join(' and ');
    homonymousCollisions.push({
      lexicon_key: key,
      places: sortedMatches.map((p) => ({
        id: p.id,
        name: p.name,
        full_name: p.full_name,
        scope_hint: derivePlaceScopeHint(p),
      })),
      recommendation: `Replace bare key "${key}" with qualified keys such as ${exampleKeys} (or set explicit region / match_full_name_contains).`,
    });
  }

  return homonymousCollisions;
}
