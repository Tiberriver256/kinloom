import type {
  ArchiveEvent,
  BuildMode,
  MediaItem,
  Person,
  RawPerson,
  ResidenceSpan,
} from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';
import { edtfYear } from './edtf.js';

export interface LivingStatusInput {
  explicitLiving?: boolean;
  hasDeathOrBurial: boolean;
  birthYear: number | null;
  earliestEventYear: number | null;
  referenceYear?: number;
  livingCutoffYears?: number;
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
    referenceYear = 2026,
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
  const alternations = livingNames.map(
    (name) => `(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`
  );
  return new RegExp(alternations.join('|'), 'gu');
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
export function redactSinglePerson<T extends RawPerson>(person: T, mode: BuildMode): T {
  const copy = structuredClone(person);
  if (!copy.is_living) {
    return copy;
  }
  if (mode === 'public') {
    copy.full_name = 'Living';
    copy.given_name = 'Living';
    copy.surname = '';
    copy.alt_names = [];
    copy.birth_edtf = '';
    copy.death_edtf = '';
    copy.portrait_url = null;
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

  // Private mode: retain name and birth year only; strip exact birthdate and portrait.
  const birthYear = edtfYear(copy.birth_edtf);
  copy.birth_edtf = birthYear !== null ? String(birthYear) : '';
  copy.portrait_url = null;
  if ('thumb_url' in copy) {
    copy.thumb_url = null;
  }
  if ('birth_year' in copy) {
    (copy as unknown as Person).birth_year = birthYear;
  }
  if ('media_count' in copy) {
    (copy as unknown as Person).media_count = 0;
  }
  return copy;
}

/**
 * Enforce living-person write sanitization before storing a Person record in D1/YAML.
 * Living people keep name and birth year only; exact birthdates and portraits are stripped.
 */
export function sanitizePersonForWrite<T extends RawPerson>(person: T): T {
  return redactSinglePerson(person, 'private');
}

/**
 * Enforce living-person redaction on a single Event entity.
 * Returns null when the event must be omitted completely (living-only event in public mode).
 */
export function redactSingleEvent(
  event: ArchiveEvent,
  livingIds: ReadonlySet<string>,
  livingPattern: RegExp | null,
  mode: BuildMode
): ArchiveEvent | null {
  const copy = structuredClone(event);
  const partIds = new Set(copy.participants.map((pt) => pt.person_id));
  const hasLivingParticipant = [...partIds].some((id) => livingIds.has(id));

  if (mode === 'public') {
    if (partIds.size > 0 && [...partIds].every((id) => livingIds.has(id))) {
      return null;
    }
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
    const yr = edtfYear(copy.edtf_date);
    copy.edtf_date = yr !== null ? String(yr) : '';
    copy.place_id = null;
    copy.summary = 'Living relative record (location and exact date omitted).';
    copy.photo_url = undefined;
  }
  return copy;
}

export interface PrivacyFilterResult<TPerson extends RawPerson> {
  people: TPerson[];
  events: ArchiveEvent[];
  residenceSpans: ResidenceSpan[];
  reviewFlags: string[];
}

/**
 * Full-archive living-person privacy filter matching public and private build policies.
 */
export function applyPrivacyFilter<TPerson extends RawPerson>(
  people: readonly TPerson[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode
): PrivacyFilterResult<TPerson> {
  const livingIds = new Set(people.filter((p) => p.is_living).map((p) => p.id));
  const livingNames = collectLivingNames(people);
  const livingPattern = compileLivingNamePattern(livingNames);
  const reviewFlags: string[] = [];

  const outPeople = people.map((p) => redactSinglePerson(p, mode));
  const outEvents: ArchiveEvent[] = [];

  for (const ev of events) {
    const partIds = new Set(ev.participants.map((pt) => pt.person_id));
    const hasLivingParticipant = [...partIds].some((id) => livingIds.has(id));

    const redacted = redactSingleEvent(ev, livingIds, livingPattern, mode);
    if (!redacted) {
      continue;
    }

    if (mode === 'public' && !hasLivingParticipant) {
      const title = redacted.title || '';
      const summary = redacted.summary || '';
      for (const lname of livingNames) {
        if (lname.length < 5) {
          continue;
        }
        if (title.includes(lname)) {
          reviewFlags.push(
            `[${redacted.id}] '${title}' mentions living person '${lname}' in event title.`
          );
        }
        if (summary.includes(lname)) {
          reviewFlags.push(
            `[${redacted.id}] '${title}' mentions living person '${lname}' in summary prose.`
          );
        }
      }
    }

    outEvents.push(redacted);
  }

  const outSpans = residenceSpans
    .filter((s) => !livingIds.has(s.person_id))
    .map((s) => structuredClone(s));

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
  eventsById?: ReadonlyMap<string, Pick<ArchiveEvent, 'id' | 'participants'>>
): MediaItem[] {
  const result: MediaItem[] = [];
  for (const item of media) {
    const linkedPersonIds = getMediaPersonIds(item);
    let blocked = false;
    for (const pid of linkedPersonIds) {
      const person = peopleById.get(pid);
      if (!person || person.is_living) {
        blocked = true;
        break;
      }
    }
    if (blocked) {
      continue;
    }
    if (item.event_id && eventsById) {
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
    const copy = structuredClone(item);
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
