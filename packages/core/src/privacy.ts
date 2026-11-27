import { edtfYear } from './edtf.js';
import type { PrivacyConfig } from './schemas/config.js';
import type {
  ArchiveEvent,
  BuildMode,
  MediaItem,
  Narrative,
  Person,
  RawEvent,
  RawPerson,
  ResidenceSpan,
} from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';

export interface LivingStatusInput {
  explicitLiving?: boolean;
  hasDeathOrBurial: boolean;
  birthYear: number | null;
  earliestEventYear: number | null;
  referenceYear?: number;
  livingCutoffYears?: number;
}

export interface RedactOptions {
  privacy?: Partial<PrivacyConfig>;
  clone?: boolean;
}

export interface ApplyPrivacyFilterOptions {
  privacy?: Partial<PrivacyConfig>;
  cloneInputs?: boolean;
}

export interface FilterMediaPrivacyOptions {
  cloneInputs?: boolean;
  stripLivingPortraits?: boolean;
}

export class PrivacyViolationError extends Error {
  readonly code: 'LIVING_MEDIA_FORBIDDEN' | 'PRIVACY_VIOLATION';
  readonly status = 422;
  readonly blockedPersonIds: readonly string[];

  constructor(
    message: string,
    options: {
      code?: 'LIVING_MEDIA_FORBIDDEN' | 'PRIVACY_VIOLATION';
      blockedPersonIds?: readonly string[];
    } = {}
  ) {
    super(message);
    this.name = 'PrivacyViolationError';
    this.code = options.code ?? 'LIVING_MEDIA_FORBIDDEN';
    this.blockedPersonIds = options.blockedPersonIds ?? [];
  }
}

export type MediaPrivacyCheckResult =
  | { ok: true }
  | { ok: false; code: 'LIVING_MEDIA_FORBIDDEN'; message: string; blockedPersonIds: string[] };

/**
 * Returns the current UTC calendar year from the runtime clock for default living-cutoff calculations.
 */
export function getCurrentReferenceYear(): number {
  return new Date().getUTCFullYear();
}

/**
 * 100-year living-person privacy heuristic (default cutoff = 101 years so <= referenceYear - 101 is deceased).
 */
export function isPersonLivingPublic(params: LivingStatusInput): boolean {
  const {
    explicitLiving,
    hasDeathOrBurial,
    birthYear,
    earliestEventYear,
    referenceYear = getCurrentReferenceYear(),
    livingCutoffYears = 101,
  } = params;
  if (explicitLiving) {
    return true;
  }
  if (hasDeathOrBurial) {
    return false;
  }
  const cutoff = referenceYear - livingCutoffYears;
  if (birthYear !== null) {
    return birthYear > cutoff;
  }
  if (earliestEventYear !== null) {
    return earliestEventYear > cutoff;
  }
  return true;
}

/**
 * Resolve effective living status honoring both explicit `is_living` and configured birth-year cutoff.
 */
export function resolveEffectiveLiving(
  person: Pick<RawPerson, 'is_living' | 'birth_edtf' | 'death_edtf'>,
  privacy?: Partial<PrivacyConfig>
): boolean {
  if (person.is_living) {
    return true;
  }
  if (person.death_edtf && person.death_edtf.trim().length > 0) {
    return false;
  }
  const birthYear = edtfYear(person.birth_edtf);
  if (birthYear !== null) {
    return isPersonLivingPublic({
      explicitLiving: false,
      hasDeathOrBurial: false,
      birthYear,
      earliestEventYear: null,
      referenceYear: privacy?.referenceYear ?? getCurrentReferenceYear(),
      livingCutoffYears: privacy?.livingCutoffYears ?? 101,
    });
  }
  return false;
}

export function collectLivingNames(
  people: readonly Pick<RawPerson, 'is_living' | 'full_name' | 'alt_names'>[]
): string[] {
  const names = new Set<string>();
  for (const p of people) {
    if (!p.is_living) {
      continue;
    }
    const full = p.full_name.trim();
    if (full && full.toLowerCase() !== 'living') {
      names.add(full);
    }
    for (const alt of p.alt_names) {
      const trimmed = alt.trim();
      if (trimmed && trimmed.toLowerCase() !== 'living') {
        names.add(trimmed);
      }
    }
  }
  return [...names].toSorted((a, b) => b.length - a.length || a.localeCompare(b));
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileLivingNamePattern(livingNames: readonly string[]): RegExp | null {
  if (livingNames.length === 0) {
    return null;
  }
  const body = livingNames.map((name) => escapeRegExp(name)).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, 'gu');
}

export function scrubLivingNames(text: string, pattern: RegExp | null): string {
  if (!text || !pattern) {
    return text;
  }
  return text.replaceAll(pattern, 'Living');
}

/**
 * Enforce living-person redaction on a single Person entity (API read/write boundary).
 */
export function redactSinglePerson<T extends RawPerson>(
  person: T,
  mode: BuildMode,
  options?: RedactOptions
): T {
  const copy = options?.clone === false ? person : structuredClone(person);
  if (!resolveEffectiveLiving(copy, options?.privacy)) {
    return copy;
  }
  copy.is_living = true;

  if (mode === 'public') {
    copy.full_name = 'Living';
    copy.given_name = 'Living';
    copy.surname = '';
    copy.alt_names = [];
    copy.birth_edtf = '';
    copy.death_edtf = '';
    copy.portrait_url = null;
    if ('pronunciation' in copy) {
      delete copy.pronunciation;
    }
    if ('thumb_url' in copy) {
      copy.thumb_url = null;
    }
    if ('birth_year' in copy) {
      (copy as unknown as Person).birth_year = null;
    }
    if ('death_year' in copy) {
      (copy as unknown as Person).death_year = null;
    }
    if ('media_count' in copy) {
      (copy as unknown as Person).media_count = 0;
    }
    return copy;
  }

  // Private mode: retain name and optional birth year; strip exact birthdate and portrait.
  const showBirthYear = options?.privacy?.privateModeShowsBirthYear ?? true;
  const stripPortraits = options?.privacy?.stripLivingPortraits ?? true;
  const birthYear = showBirthYear ? edtfYear(copy.birth_edtf) : null;
  copy.birth_edtf = birthYear !== null ? String(birthYear) : '';
  if ('birth_year' in copy) {
    (copy as unknown as Person).birth_year = birthYear;
  }
  if (stripPortraits) {
    copy.portrait_url = null;
    if ('pronunciation' in copy) {
      delete copy.pronunciation;
    }
    if ('thumb_url' in copy) {
      copy.thumb_url = null;
    }
    if ('media_count' in copy) {
      (copy as unknown as Person).media_count = 0;
    }
  }
  return copy;
}

/**
 * Enforce living-person write sanitization before storing a Person record in D1/YAML.
 * Living people keep name and birth year only; exact birthdates and portraits are stripped.
 */
export function sanitizePersonForWrite<T extends RawPerson>(
  person: T,
  privacyConfig?: Partial<PrivacyConfig>
): T {
  return redactSinglePerson(person, 'private', { privacy: privacyConfig });
}

/**
 * Enforce living-person write sanitization before storing an Event record in D1/YAML.
 * Events with living participants keep year-only date (when permitted) and omit exact location and summary prose.
 */
export function sanitizeEventForWrite<T extends RawEvent>(
  event: T,
  livingPersonIds: ReadonlySet<string>,
  privacyConfig?: Partial<PrivacyConfig>
): T {
  const hasLivingParticipant = event.participants.some((pt) => livingPersonIds.has(pt.person_id));
  if (!hasLivingParticipant) {
    return {
      ...event,
      participants: event.participants.map((pt) => ({ ...pt })),
      sources: event.sources.map((s) => ({ ...s })),
    };
  }
  const copy = structuredClone(event);
  const showBirthYear = privacyConfig?.privateModeShowsBirthYear ?? true;
  const stripPortraits = privacyConfig?.stripLivingPortraits ?? true;
  const yr = showBirthYear ? edtfYear(copy.edtf_date) : null;
  copy.edtf_date = yr !== null ? String(yr) : '';
  copy.place_id = null;
  copy.summary = 'Living relative record (location and exact date omitted).';
  if (stripPortraits) {
    copy.photo_url = undefined;
  }
  if ('place_ancestors' in copy) {
    (copy as unknown as ArchiveEvent).place_ancestors = [];
  }
  return copy;
}

/**
 * Check whether a media item may be stored or attached without exposing a living person.
 */
export function validateMediaForPrivacy(
  media: Pick<MediaItem, 'id' | 'person_id' | 'person_ids' | 'event_id'>,
  livingPersonIds: ReadonlySet<string>,
  eventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>
): MediaPrivacyCheckResult {
  const blocked = new Set<string>();
  for (const pid of getMediaPersonIds(media)) {
    if (livingPersonIds.has(pid)) {
      blocked.add(pid);
    }
  }
  if (media.event_id && eventsById) {
    const ev = eventsById.get(media.event_id);
    if (ev) {
      for (const pt of ev.participants) {
        if (livingPersonIds.has(pt.person_id)) {
          blocked.add(pt.person_id);
        }
      }
    }
  }
  if (blocked.size > 0) {
    const blockedPersonIds = [...blocked].toSorted();
    return {
      ok: false,
      code: 'LIVING_MEDIA_FORBIDDEN',
      message: `Media ${media.id} cannot be linked to living person(s): ${blockedPersonIds.join(', ')}`,
      blockedPersonIds,
    };
  }
  return { ok: true };
}

/**
 * Throw PrivacyViolationError (HTTP 422) when a media upload references any living person directly or via an event.
 */
export function assertMediaAllowedForPrivacy(
  media: Pick<MediaItem, 'id' | 'person_id' | 'person_ids' | 'event_id'>,
  livingPersonIds: ReadonlySet<string>,
  eventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>
): void {
  const result = validateMediaForPrivacy(media, livingPersonIds, eventsById);
  if (!result.ok) {
    throw new PrivacyViolationError(result.message, {
      code: result.code,
      blockedPersonIds: result.blockedPersonIds,
    });
  }
}

/**
 * Enforce living-person redaction on a single Event entity.
 * Returns null when the event must be omitted completely (living-only event in public mode).
 */
export function redactSingleEvent(
  event: ArchiveEvent,
  livingIds: ReadonlySet<string>,
  livingPattern: RegExp | null,
  mode: BuildMode,
  options?: RedactOptions
): ArchiveEvent | null {
  let hasAnyParticipant = false;
  let hasLivingParticipant = false;
  let allParticipantsLiving = true;
  for (const pt of event.participants) {
    hasAnyParticipant = true;
    if (livingIds.has(pt.person_id)) {
      hasLivingParticipant = true;
    } else {
      allParticipantsLiving = false;
    }
  }

  if (mode === 'public' && hasAnyParticipant && allParticipantsLiving) {
    return null;
  }

  const copy = options?.clone === false ? event : structuredClone(event);

  if (mode === 'public') {
    if (hasLivingParticipant) {
      if (copy.title) {
        copy.title = scrubLivingNames(copy.title, livingPattern);
      }
      copy.summary = 'Shared family milestone (details redacted for living participants).';
      copy.place_id = null;
      copy.photo_url = undefined;
      if (copy.alternate_dates) {
        for (const alt of copy.alternate_dates) {
          if (alt.note) {
            alt.note = scrubLivingNames(alt.note, livingPattern);
          }
        }
      }
      if (copy.alternate_places) {
        for (const alt of copy.alternate_places) {
          if (alt.note) {
            alt.note = scrubLivingNames(alt.note, livingPattern);
          }
        }
      }
      if (copy.fact_conflicts) {
        for (const alt of copy.fact_conflicts) {
          if (alt.note) {
            alt.note = scrubLivingNames(alt.note, livingPattern);
          }
        }
      }
    }
    return copy;
  }

  // Private mode: strip exact date to year, strip place and summary for living-participant events.
  if (hasLivingParticipant) {
    const showBirthYear = options?.privacy?.privateModeShowsBirthYear ?? true;
    const stripPortraits = options?.privacy?.stripLivingPortraits ?? true;
    const yr = showBirthYear ? edtfYear(copy.edtf_date) : null;
    copy.edtf_date = yr !== null ? String(yr) : '';
    copy.place_id = null;
    copy.summary = 'Living relative record (location and exact date omitted).';
    if (stripPortraits) {
      copy.photo_url = undefined;
    }
  }
  return copy;
}

export interface PrivacyFilterResult<TPerson extends RawPerson> {
  people: TPerson[];
  events: ArchiveEvent[];
  residenceSpans: ResidenceSpan[];
  reviewFlags: string[];
}

function collectReviewFlagsForField(
  eventId: string,
  title: string,
  fieldText: string,
  fieldLabel: 'event title' | 'summary prose',
  pattern: RegExp,
  reviewFlags: string[]
): void {
  if (!fieldText) {
    return;
  }
  const seen = new Set<string>();
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fieldText)) !== null) {
    const lname = match[0];
    if (!seen.has(lname)) {
      seen.add(lname);
      reviewFlags.push(`[${eventId}] '${title}' mentions living person '${lname}' in ${fieldLabel}.`);
    }
  }
}

/**
 * Full-archive living-person privacy filter matching public and private build policies.
 */
export function applyPrivacyFilter<TPerson extends RawPerson>(
  people: readonly TPerson[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode,
  options?: ApplyPrivacyFilterOptions
): PrivacyFilterResult<TPerson> {
  const cloneInputs = options?.cloneInputs ?? true;
  const privacy = options?.privacy;
  const redactOpts: RedactOptions = { privacy, clone: cloneInputs };

  const livingIds = new Set<string>();
  const effectiveLivingPeople: Pick<RawPerson, 'is_living' | 'full_name' | 'alt_names'>[] = [];
  for (const p of people) {
    if (resolveEffectiveLiving(p, privacy)) {
      livingIds.add(p.id);
      effectiveLivingPeople.push({
        is_living: true,
        full_name: p.full_name,
        alt_names: p.alt_names,
      });
    }
  }

  const livingNames = collectLivingNames(effectiveLivingPeople);
  const livingPattern = compileLivingNamePattern(livingNames);
  const reviewLivingNames = livingNames.filter((name) => name.length >= 5);
  const reviewPattern =
    reviewLivingNames.length === livingNames.length
      ? livingPattern
      : compileLivingNamePattern(reviewLivingNames);
  const reviewFlags: string[] = [];

  const outPeople = people.map((p) => redactSinglePerson(p, mode, redactOpts));
  const outEvents: ArchiveEvent[] = [];

  for (const ev of events) {
    const hasLivingParticipant = ev.participants.some((pt) => livingIds.has(pt.person_id));

    const redacted = redactSingleEvent(ev, livingIds, livingPattern, mode, redactOpts);
    if (!redacted) {
      continue;
    }

    if (mode === 'public' && !hasLivingParticipant && reviewPattern) {
      const title = redacted.title || '';
      const summary = redacted.summary || '';
      collectReviewFlagsForField(redacted.id, title, title, 'event title', reviewPattern, reviewFlags);
      collectReviewFlagsForField(redacted.id, title, summary, 'summary prose', reviewPattern, reviewFlags);
    }

    outEvents.push(redacted);
  }

  const stripLivingSpans = mode === 'public' || (privacy?.stripLivingResidenceSpans ?? true);
  const filteredSpans = stripLivingSpans
    ? residenceSpans.filter((s) => !livingIds.has(s.person_id))
    : [...residenceSpans];
  const outSpans = cloneInputs ? filteredSpans.map((s) => structuredClone(s)) : filteredSpans;

  return {
    people: outPeople,
    events: outEvents,
    residenceSpans: outSpans,
    reviewFlags,
  };
}

/**
 * Filter media items so living-person photos/portraits are excluded in both public and private modes.
 * Supports both multi-person `person_ids` and single `person_id`.
 */
export function filterMediaForPrivacy(
  media: readonly MediaItem[],
  peopleById: ReadonlyMap<string, Pick<RawPerson, 'id' | 'is_living' | 'full_name' | 'slug'>>,
  eventsById?: ReadonlyMap<string, Pick<ArchiveEvent, 'id' | 'participants'>>,
  options?: FilterMediaPrivacyOptions
): MediaItem[] {
  const cloneInputs = options?.cloneInputs ?? true;
  const stripLivingPortraits = options?.stripLivingPortraits ?? true;
  const result: MediaItem[] = [];
  for (const item of media) {
    const linkedPersonIds = getMediaPersonIds(item);
    let blocked = false;
    for (const pid of linkedPersonIds) {
      const person = peopleById.get(pid);
      if (!person || (stripLivingPortraits && person.is_living)) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    if (stripLivingPortraits && item.event_id && eventsById) {
      const ev = eventsById.get(item.event_id);
      if (
        ev &&
        ev.participants.some((pt) => {
          const participant = peopleById.get(pt.person_id);
          return participant?.is_living;
        })
      ) {
        continue;
      }
    }
    const copy = cloneInputs ? structuredClone(item) : item;
    if (copy.person_id) {
      const target = peopleById.get(copy.person_id);
      if (target) {
        if (target.full_name) {
          copy.person_name = target.full_name;
        }
        if (target.slug) {
          copy.person_slug = target.slug;
        }
      }
    }
    result.push(copy);
  }
  return result;
}

export interface RedactNarrativeOptions {
  clone?: boolean;
}

/**
 * Enforce living-person redaction on a single Narrative entity.
 * In public mode, strips living IDs from `subject_person_id` and `person_ids`,
 * and scrubs living names from prose when a living person was referenced.
 */
export function redactSingleNarrative(
  narrative: Narrative,
  livingIds: ReadonlySet<string>,
  livingPattern: RegExp | null,
  mode: BuildMode,
  options?: RedactNarrativeOptions
): Narrative {
  const copy = options?.clone === false ? narrative : structuredClone(narrative);
  if (mode !== 'public') {
    return copy;
  }

  const hasLivingSubject = Boolean(copy.subject_person_id && livingIds.has(copy.subject_person_id));
  const hasLivingPerson = copy.person_ids.some((pid) => livingIds.has(pid));

  if (hasLivingSubject) {
    delete copy.subject_person_id;
  }
  if (hasLivingPerson) {
    copy.person_ids = copy.person_ids.filter((pid) => !livingIds.has(pid));
  }
  if ((hasLivingSubject || hasLivingPerson) && livingPattern) {
    copy.title = scrubLivingNames(copy.title, livingPattern);
    if (copy.summary) {
      copy.summary = scrubLivingNames(copy.summary, livingPattern);
    }
    copy.body_md = scrubLivingNames(copy.body_md, livingPattern);
  }
  return copy;
}

/**
 * Enforce living-person redaction across a list of Narratives.
 */
export function filterNarrativesForPrivacy(
  narratives: readonly Narrative[],
  livingIds: ReadonlySet<string>,
  livingPattern: RegExp | null,
  mode: BuildMode,
  options?: { cloneInputs?: boolean }
): Narrative[] {
  const clone = options?.cloneInputs ?? true;
  return narratives.map((n) => redactSingleNarrative(n, livingIds, livingPattern, mode, { clone }));
}
