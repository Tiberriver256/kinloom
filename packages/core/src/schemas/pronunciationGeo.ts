import type { Pronunciation } from './pronunciation.js';

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
    tokens: [
      'sweden',
      'sverige',
      'värmland',
      'dalarna',
      'skåne',
      'småland',
      'östergötland',
      'västergötland',
      'bergslagen',
    ],
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
    tokens: [
      'germany',
      'deutschland',
      'prussia',
      'preußen',
      'bavaria',
      'bayern',
      'saxony',
      'sachsen',
      'hanover',
      'hannover',
      'hesse',
      'hessen',
      'westphalia',
      'württemberg',
      'baden',
    ],
  },
  {
    code: 'CA',
    tokens: [
      'canada',
      'ontario',
      'quebec',
      'québec',
      'nova scotia',
      'new brunswick',
      'manitoba',
      'saskatchewan',
      'alberta',
      'british columbia',
    ],
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

export function splitPlaceSegments(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function inferCountryCodeFromSegments(segments: readonly string[]): string | null {
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

export function getPlaceQualifierSegments(place: {
  readonly name?: string;
  readonly full_name?: string;
}): string[] {
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

export function isBareLexiconEntryCompatibleWithPlace(
  entry: Pronunciation,
  place: { readonly name?: string; readonly full_name?: string }
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
