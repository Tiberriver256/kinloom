import { edtfYearBounds } from '../edtf.js';
import { escapeLivingNameRegExp } from './policy.js';
import { mayMatchPattern, registerPatternPrefilter } from './prefilter.js';

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

export interface CompileLivingNameMatcherOptions {
  /** Optional explicit reference year used to clamp derived minYear bounds (zero ambient Date). */
  referenceYear?: number;
}

export const NARRATIVE_POSTHUMOUS_HORIZON_YEARS = 100;

export interface NarrativeMaxYearInput {
  subjectPersonId?: string | null;
  personIds: readonly string[];
  eventIds: readonly string[];
  livingIds: ReadonlySet<string>;
  deathYearByPersonId: ReadonlyMap<string, number | null>;
  eventMaxYearById: ReadonlyMap<string, number | null>;
}

export interface SourceCitingEventLike {
  edtf_date?: unknown;
  sources?: unknown;
}

const MAX_LIVING_NAME_HITS = 50;
const matcherCombinedPrefilter = new WeakMap<CompiledLivingNameMatcher, RegExp>();

export function extractLatestEdtfYear(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const bounds = edtfYearBounds(raw);
  return bounds ? bounds[1] : null;
}

export function extractEarliestEdtfYear(raw: unknown): number | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const bounds = edtfYearBounds(raw);
  return bounds ? bounds[0] : null;
}

export function computeSourceMaxYearById(
  events: readonly SourceCitingEventLike[]
): Map<string, number | null> {
  const sourceMaxYearById = new Map<string, number | null>();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const rawSources = event.sources;
    if (!Array.isArray(rawSources) || rawSources.length === 0) {
      continue;
    }
    const eventYear = extractLatestEdtfYear(event.edtf_date);
    for (let s = 0; s < rawSources.length; s += 1) {
      const ref = rawSources[s];
      let sourceId = '';
      if (typeof ref === 'string') {
        sourceId = ref.trim();
      } else if (typeof ref === 'object' && ref !== null && 'source_id' in ref) {
        const candidate = (ref as { source_id?: unknown }).source_id;
        if (typeof candidate === 'string') {
          sourceId = candidate.trim();
        }
      }
      if (!sourceId) {
        continue;
      }
      const prev = sourceMaxYearById.get(sourceId);
      if (prev === undefined) {
        sourceMaxYearById.set(sourceId, eventYear);
      } else if (prev !== null) {
        sourceMaxYearById.set(sourceId, eventYear === null ? null : Math.max(prev, eventYear));
      }
    }
  }
  return sourceMaxYearById;
}

export function resolveNarrativeMaxYear(input: NarrativeMaxYearInput): number | null {
  const { subjectPersonId, personIds, eventIds, livingIds, deathYearByPersonId, eventMaxYearById } = input;
  const hasSubject = Boolean(subjectPersonId);
  if (!hasSubject && personIds.length === 0) {
    return null;
  }
  let maxDeathYear: number | null = null;
  if (subjectPersonId) {
    if (livingIds.has(subjectPersonId)) {
      return null;
    }
    const subjDeath = deathYearByPersonId.get(subjectPersonId) ?? null;
    if (subjDeath === null) {
      return null;
    }
    maxDeathYear = subjDeath;
  }
  for (let i = 0; i < personIds.length; i += 1) {
    const personId = personIds[i];
    if (livingIds.has(personId)) {
      return null;
    }
    const deathYear = deathYearByPersonId.get(personId) ?? null;
    if (deathYear === null) {
      return null;
    }
    maxDeathYear = maxDeathYear === null ? deathYear : Math.max(maxDeathYear, deathYear);
  }
  if (maxDeathYear === null) {
    return null;
  }
  let narrativeMaxYear = maxDeathYear + NARRATIVE_POSTHUMOUS_HORIZON_YEARS;
  for (let i = 0; i < eventIds.length; i += 1) {
    const eventYear = eventMaxYearById.get(eventIds[i]);
    if (typeof eventYear === 'number' && eventYear > narrativeMaxYear) {
      narrativeMaxYear = eventYear;
    }
  }
  return narrativeMaxYear;
}

function extractFirstTokenIfAtLeast(
  raw: unknown,
  minTokenCount: 2 | 3,
  matchingLastLower?: string
): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const len = raw.length;
  let start = 0;
  while (start < len && raw.charCodeAt(start) <= 32) {
    start += 1;
  }
  let end = len;
  while (end > start && raw.charCodeAt(end - 1) <= 32) {
    end -= 1;
  }
  if (start >= end) {
    return null;
  }

  let firstEnd = start;
  while (firstEnd < end && raw.charCodeAt(firstEnd) > 32) {
    firstEnd += 1;
  }
  if (firstEnd >= end) {
    return null;
  }

  let cur = firstEnd;
  let tokenCount = 1;
  let lastTokenStart = start;
  while (cur < end) {
    while (cur < end && raw.charCodeAt(cur) <= 32) {
      cur += 1;
    }
    if (cur < end) {
      lastTokenStart = cur;
      tokenCount += 1;
      while (cur < end && raw.charCodeAt(cur) > 32) {
        cur += 1;
      }
    }
  }

  if (tokenCount < minTokenCount) {
    return null;
  }
  if (matchingLastLower !== undefined && raw.slice(lastTokenStart, end).toLowerCase() !== matchingLastLower) {
    return null;
  }
  return raw.slice(start, firstEnd);
}

function derivedFirstSurname(person: LivingNamePerson): string | null {
  const surname = typeof person.surname === 'string' ? person.surname.trim() : '';
  if (!surname) {
    return null;
  }
  let first = extractFirstTokenIfAtLeast(person.given_name, 2);
  if (!first) {
    first = extractFirstTokenIfAtLeast(person.full_name, 3, surname.toLowerCase());
    if (!first) {
      return null;
    }
  }
  if (first.length + 1 + surname.length < 6) {
    return null;
  }
  return `${first} ${surname}`;
}

function addDeceasedExactNameKeysIfRelevant(
  person: LivingNamePerson,
  candidateDerivedKeys: { readonly has: (key: string) => boolean },
  deceasedNameKeys: Set<string>
): void {
  if (typeof person.full_name === 'string') {
    const cleaned = person.full_name.trim();
    if (cleaned.length >= 6) {
      const lower = cleaned.toLowerCase();
      if (candidateDerivedKeys.has(lower)) {
        deceasedNameKeys.add(lower);
      }
    }
  }
  if (Array.isArray(person.alt_names)) {
    for (let i = 0; i < person.alt_names.length; i += 1) {
      const raw = person.alt_names[i];
      if (typeof raw === 'string') {
        const cleaned = raw.trim();
        if (cleaned.length >= 6) {
          const lower = cleaned.toLowerCase();
          if (candidateDerivedKeys.has(lower)) {
            deceasedNameKeys.add(lower);
          }
        }
      }
    }
  }
  const derived = derivedFirstSurname(person);
  if (derived) {
    const lower = derived.toLowerCase();
    if (candidateDerivedKeys.has(lower)) {
      deceasedNameKeys.add(lower);
    }
  }
}

function addStoredMultiwordNames(person: LivingNamePerson, out: Set<string>): void {
  if (typeof person.full_name === 'string') {
    const cleaned = person.full_name.trim();
    if (cleaned.length >= 6 && cleaned.includes(' ')) {
      out.add(cleaned);
    }
  }
  if (Array.isArray(person.alt_names)) {
    for (let i = 0; i < person.alt_names.length; i += 1) {
      const raw = person.alt_names[i];
      if (typeof raw === 'string') {
        const cleaned = raw.trim();
        if (cleaned.length >= 6 && cleaned.includes(' ')) {
          out.add(cleaned);
        }
      }
    }
  }
}

function buildUnicodeAlternationRegex(names: readonly string[]): RegExp | null {
  if (names.length === 0) {
    return null;
  }
  const uniqueNames = [...new Set(names)].toSorted((a, b) => b.length - a.length);
  const escaped = uniqueNames.map((name) => escapeLivingNameRegExp(name));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  registerPatternPrefilter(pattern, uniqueNames, true);
  return pattern;
}

export function compileLivingNameMatcher(
  livingPeople: readonly LivingNamePerson[],
  deceasedPeople: readonly LivingNamePerson[] = [],
  options?: CompileLivingNameMatcherOptions
): CompiledLivingNameMatcher {
  const exactNames = new Set<string>();
  const candidateDerivedByKey = new Map<string, { label: string; minYear: number | null }>();

  for (let i = 0; i < livingPeople.length; i += 1) {
    const person = livingPeople[i];
    addStoredMultiwordNames(person, exactNames);
    const derived = derivedFirstSurname(person);
    if (derived) {
      const key = derived.toLowerCase();
      const birthYear = extractEarliestEdtfYear(person.birth_edtf);
      let minYear = birthYear !== null ? birthYear - 2 : null;
      if (minYear !== null && options?.referenceYear !== undefined && minYear > options.referenceYear) {
        minYear = options.referenceYear;
      }
      const existing = candidateDerivedByKey.get(key);
      if (!existing) {
        candidateDerivedByKey.set(key, { label: derived, minYear });
      } else if (existing.minYear === null || minYear === null) {
        existing.minYear = null;
      } else if (minYear < existing.minYear) {
        existing.minYear = minYear;
      }
    }
  }

  if (candidateDerivedByKey.size > 0 && deceasedPeople.length > 0) {
    const deceasedCollisions = new Set<string>();
    for (let i = 0; i < deceasedPeople.length; i += 1) {
      addDeceasedExactNameKeysIfRelevant(deceasedPeople[i], candidateDerivedByKey, deceasedCollisions);
    }
    for (const collided of deceasedCollisions) {
      candidateDerivedByKey.delete(collided);
    }
  }

  const byMinYear = new Map<number | null, string[]>();
  const allCombinedLabels: string[] = [...exactNames];
  for (const { label, minYear } of candidateDerivedByKey.values()) {
    allCombinedLabels.push(label);
    const bucket = byMinYear.get(minYear);
    if (bucket) {
      bucket.push(label);
    } else {
      byMinYear.set(minYear, [label]);
    }
  }
  const derivedRules: DerivedLivingNameRule[] = [];
  for (const [minYear, labels] of byMinYear.entries()) {
    const pattern = buildUnicodeAlternationRegex(labels);
    if (pattern) {
      derivedRules.push({ pattern, minYear });
    }
  }

  const matcher: CompiledLivingNameMatcher = {
    exactPattern: buildUnicodeAlternationRegex([...exactNames]),
    derivedRules,
  };
  if (allCombinedLabels.length > 0 && (matcher.exactPattern ? 1 : 0) + derivedRules.length > 1) {
    const prefilterKey = /./;
    registerPatternPrefilter(prefilterKey, allCombinedLabels, true);
    matcherCombinedPrefilter.set(matcher, prefilterKey);
  }
  return matcher;
}

export function mayMatchLivingNameMatcher(matcher: CompiledLivingNameMatcher, text: string): boolean {
  if (!text) {
    return false;
  }
  if (!matcher.exactPattern && matcher.derivedRules.length === 0) {
    return false;
  }
  const combined = matcherCombinedPrefilter.get(matcher);
  if (combined) {
    return mayMatchPattern(combined, text);
  }
  if (matcher.exactPattern && mayMatchPattern(matcher.exactPattern, text)) {
    return true;
  }
  for (let i = 0; i < matcher.derivedRules.length; i += 1) {
    if (mayMatchPattern(matcher.derivedRules[i].pattern, text)) {
      return true;
    }
  }
  return false;
}

export function compileLivingNameRegex(
  livingPeople: readonly LivingNamePerson[],
  deceasedPeople: readonly LivingNamePerson[] = []
): RegExp | null {
  const names = new Set<string>();
  const candidateDerived = new Map<string, string>();
  for (let i = 0; i < livingPeople.length; i += 1) {
    const person = livingPeople[i];
    addStoredMultiwordNames(person, names);
    const derived = derivedFirstSurname(person);
    if (derived) {
      const lower = derived.toLowerCase();
      if (!candidateDerived.has(lower)) {
        candidateDerived.set(lower, derived);
      }
    }
  }
  if (candidateDerived.size > 0) {
    const deceasedCollisions = new Set<string>();
    for (let i = 0; i < deceasedPeople.length; i += 1) {
      addDeceasedExactNameKeysIfRelevant(deceasedPeople[i], candidateDerived, deceasedCollisions);
    }
    for (const [lower, label] of candidateDerived.entries()) {
      if (!deceasedCollisions.has(lower)) {
        names.add(label);
      }
    }
  }
  return buildUnicodeAlternationRegex([...names]);
}

export function collectLivingNameHits(
  pattern: RegExp | null,
  targets: readonly LivingNameTarget[]
): LivingNameHit[] {
  if (!pattern) {
    return [];
  }
  const hits: LivingNameHit[] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (!target.text || !mayMatchPattern(pattern, target.text)) {
      continue;
    }
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(target.text)) !== null) {
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
  const combined = matcherCombinedPrefilter.get(matcher);
  const hits: LivingNameHit[] = [];
  const seen = new Set<string>();
  const scanPattern = (pattern: RegExp, target: LivingNameTarget): boolean => {
    if (!mayMatchPattern(pattern, target.text)) {
      return false;
    }
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(target.text)) !== null) {
      const text = match[0];
      if (!text) {
        continue;
      }
      const key = `${target.location}\0${match.index}\0${text.toLowerCase()}`;
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

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i];
    if (!target.text) {
      continue;
    }
    if (combined && !mayMatchPattern(combined, target.text)) {
      continue;
    }
    if (matcher.exactPattern && scanPattern(matcher.exactPattern, target)) {
      return hits;
    }
    for (let j = 0; j < matcher.derivedRules.length; j += 1) {
      const rule = matcher.derivedRules[j];
      if (rule.minYear !== null && typeof target.maxYear === 'number' && target.maxYear < rule.minYear) {
        continue;
      }
      if (scanPattern(rule.pattern, target)) {
        return hits;
      }
    }
  }
  return hits;
}
