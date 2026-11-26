export interface LivingNamePerson {
  full_name?: unknown;
  given_name?: unknown;
  surname?: unknown;
  alt_names?: unknown;
  birth_edtf?: unknown;
}

export interface LivingNameTarget {
  location: string;
  text: string;
  /** Optional latest calendar year of the entity being scanned (e.g. 1791 for a 1791 event). */
  maxYear?: number | null;
}

export interface LivingNameHit {
  location: string;
  match: string;
}

export interface DerivedLivingNameRule {
  pattern: RegExp;
  /** Derived First Surname only applies when target.maxYear is null/undefined or >= minYear. */
  minYear: number | null;
}

export interface CompiledLivingNameMatcher {
  exactPattern: RegExp | null;
  derivedRules: DerivedLivingNameRule[];
}

const MAX_LIVING_NAME_HITS = 50;

function trimmedNameTokens(value: unknown): string[] {
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * First token of given_name (or of full_name when given_name has fewer than two tokens)
 * plus the surname. Used only when at least two tokens sit before the surname and the
 * result is at least 6 characters, so "Clara Elizabeth Maple" also matches "Clara Maple".
 */
function derivedFirstSurname(person: LivingNamePerson): string | null {
  const surname = typeof person.surname === 'string' ? person.surname.trim() : '';
  if (!surname) {
    return null;
  }
  let tokensBeforeSurname = trimmedNameTokens(person.given_name);
  if (tokensBeforeSurname.length < 2) {
    const fullTokens = trimmedNameTokens(person.full_name);
    const last = fullTokens[fullTokens.length - 1];
    if (
      fullTokens.length >= 3 &&
      last !== undefined &&
      last.toLowerCase() === surname.toLowerCase()
    ) {
      tokensBeforeSurname = fullTokens.slice(0, -1);
    }
  }
  if (tokensBeforeSurname.length < 2) {
    return null;
  }
  const first = tokensBeforeSurname[0];
  if (!first) {
    return null;
  }
  const derived = `${first} ${surname}`;
  if (derived.length < 6) {
    return null;
  }
  return derived;
}

function addExactNameKeys(person: LivingNamePerson, keys: Set<string>): void {
  const alts = Array.isArray(person.alt_names) ? person.alt_names : [];
  for (const raw of [person.full_name, ...alts]) {
    if (typeof raw !== 'string') {
      continue;
    }
    const cleaned = raw.trim();
    if (cleaned.length > 0) {
      keys.add(cleaned.toLowerCase());
    }
  }
  const derived = derivedFirstSurname(person);
  if (derived) {
    keys.add(derived.toLowerCase());
  }
}

function collectStoredMultiwordNames(person: LivingNamePerson): string[] {
  const alts = Array.isArray(person.alt_names) ? person.alt_names : [];
  const names: string[] = [];
  for (const raw of [person.full_name, ...alts]) {
    if (typeof raw !== 'string') {
      continue;
    }
    const cleaned = raw.trim();
    // Multi-word names >= 6 chars prevent common single-token false positives.
    if (cleaned.length >= 6 && cleaned.includes(' ')) {
      names.push(cleaned);
    }
  }
  return names;
}

function extractEarliestYear(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const matches = [...raw.matchAll(/\b(\d{4})\b/g)].map((m) => Number(m[1]));
  if (matches.length === 0) {
    return null;
  }
  return Math.min(...matches);
}

function buildAlternationRegex(names: readonly string[]): RegExp | null {
  if (names.length === 0) {
    return null;
  }
  const escaped = [...new Set(names)]
    .toSorted((a, b) => b.length - a.length)
    .map((name) => name.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(?<![A-Za-z])(?:${escaped.join('|')})(?![A-Za-z])`, 'gi');
}

export function compileLivingNameMatcher(
  livingPeople: readonly LivingNamePerson[],
  deceasedPeople: readonly LivingNamePerson[] = []
): CompiledLivingNameMatcher {
  const deceasedNameKeys = new Set<string>();
  for (const person of deceasedPeople) {
    addExactNameKeys(person, deceasedNameKeys);
  }
  const exactNames = new Set<string>();
  const derivedByKey = new Map<string, { label: string; minYear: number | null }>();
  for (const person of livingPeople) {
    for (const stored of collectStoredMultiwordNames(person)) {
      exactNames.add(stored);
    }
    const derived = derivedFirstSurname(person);
    // A deceased namesake with the same First Surname must not become a living-name hit.
    if (derived && !deceasedNameKeys.has(derived.toLowerCase())) {
      const key = derived.toLowerCase();
      const birthYear = extractEarliestYear(person.birth_edtf);
      const minYear = birthYear !== null ? birthYear - 2 : null;
      const existing = derivedByKey.get(key);
      if (!existing) {
        derivedByKey.set(key, { label: derived, minYear });
      } else if (existing.minYear === null || minYear === null) {
        existing.minYear = null;
      } else if (minYear < existing.minYear) {
        existing.minYear = minYear;
      }
    }
  }

  const byMinYear = new Map<number | null, string[]>();
  for (const { label, minYear } of derivedByKey.values()) {
    const bucket = byMinYear.get(minYear) ?? [];
    bucket.push(label);
    byMinYear.set(minYear, bucket);
  }
  const derivedRules: DerivedLivingNameRule[] = [];
  for (const [minYear, labels] of byMinYear.entries()) {
    const pattern = buildAlternationRegex(labels);
    if (pattern) {
      derivedRules.push({ pattern, minYear });
    }
  }

  return {
    exactPattern: buildAlternationRegex([...exactNames]),
    derivedRules,
  };
}

export function compileLivingNameRegex(
  livingPeople: readonly LivingNamePerson[],
  deceasedPeople: readonly LivingNamePerson[] = []
): RegExp | null {
  const deceasedNameKeys = new Set<string>();
  for (const person of deceasedPeople) {
    addExactNameKeys(person, deceasedNameKeys);
  }
  const names = new Set<string>();
  for (const person of livingPeople) {
    for (const stored of collectStoredMultiwordNames(person)) {
      names.add(stored);
    }
    const derived = derivedFirstSurname(person);
    // A deceased namesake with the same First Surname must not become a living-name hit.
    if (derived && !deceasedNameKeys.has(derived.toLowerCase())) {
      names.add(derived);
    }
  }
  return buildAlternationRegex([...names]);
}

export function collectLivingNameHits(
  pattern: RegExp | null,
  targets: readonly LivingNameTarget[]
): LivingNameHit[] {
  if (!pattern) {
    return [];
  }
  const hits: LivingNameHit[] = [];
  for (const target of targets) {
    if (!target.text) {
      continue;
    }
    pattern.lastIndex = 0;
    for (const match of target.text.matchAll(pattern)) {
      if (hits.length >= MAX_LIVING_NAME_HITS) {
        return hits;
      }
      const text = match[0];
      if (text) {
        hits.push({ location: target.location, match: text });
      }
    }
  }
  return hits;
}

export function collectLivingNameHitsWithMatcher(
  matcher: CompiledLivingNameMatcher,
  targets: readonly LivingNameTarget[]
): LivingNameHit[] {
  if (!matcher.exactPattern && matcher.derivedRules.length === 0) {
    return [];
  }
  const hits: LivingNameHit[] = [];
  const seen = new Set<string>();
  const scanPattern = (pattern: RegExp, target: LivingNameTarget): boolean => {
    pattern.lastIndex = 0;
    for (const match of target.text.matchAll(pattern)) {
      const text = match[0];
      if (!text) {
        continue;
      }
      const key = `${target.location}\0${match.index ?? -1}\0${text.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      hits.push({ location: target.location, match: text });
      if (hits.length >= MAX_LIVING_NAME_HITS) {
        return true;
      }
    }
    return false;
  };

  for (const target of targets) {
    if (!target.text) {
      continue;
    }
    if (matcher.exactPattern && scanPattern(matcher.exactPattern, target)) {
      return hits;
    }
    for (const rule of matcher.derivedRules) {
      if (
        rule.minYear !== null &&
        typeof target.maxYear === 'number' &&
        target.maxYear < rule.minYear
      ) {
        continue;
      }
      if (scanPattern(rule.pattern, target)) {
        return hits;
      }
    }
  }
  return hits;
}
