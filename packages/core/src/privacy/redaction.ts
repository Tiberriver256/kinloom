import { edtfYear } from '../edtf.js';
import type {
  ArchiveEvent,
  BuildMode,
  MediaItem,
  Narrative,
  Person,
  RawPerson,
  ResidenceSpan,
} from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/entities.js';
import {
  type ApplyPrivacyFilterOptions,
  collectLivingNames,
  compileLivingNamePattern,
  type FilterMediaPrivacyOptions,
  isCompiledPerson,
  type RedactOptions,
  redactCompiledPerson,
  redactSingleRawPerson,
  resolveEffectiveLiving,
  scrubLivingNames,
} from './policy.js';

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

function applyPrivacyFilterCore<TPerson extends RawPerson>(
  people: readonly TPerson[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode,
  redactPerson: (person: TPerson, mode: BuildMode, options: RedactOptions) => TPerson,
  options?: ApplyPrivacyFilterOptions
): PrivacyFilterResult<TPerson> {
  const cloneInputs = options?.cloneInputs ?? true;
  const privacy = options?.privacy;
  const referenceYear = options?.referenceYear;
  const redactOpts: RedactOptions = { privacy, referenceYear, clone: cloneInputs };

  const livingIds = new Set<string>();
  const effectiveLivingPeople: Pick<RawPerson, 'is_living' | 'full_name' | 'alt_names'>[] = [];
  for (const p of people) {
    if (resolveEffectiveLiving(p, privacy, referenceYear)) {
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

  const outPeople = people.map((p) => redactPerson(p, mode, redactOpts));
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

export function applyPrivacyFilter(
  people: readonly Person[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode,
  options?: ApplyPrivacyFilterOptions
): PrivacyFilterResult<Person>;
export function applyPrivacyFilter(
  people: readonly RawPerson[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode,
  options?: ApplyPrivacyFilterOptions
): PrivacyFilterResult<RawPerson>;
export function applyPrivacyFilter(
  people: readonly (RawPerson | Person)[],
  events: readonly ArchiveEvent[],
  residenceSpans: readonly ResidenceSpan[],
  mode: BuildMode,
  options?: ApplyPrivacyFilterOptions
): PrivacyFilterResult<RawPerson> | PrivacyFilterResult<Person> {
  return applyPrivacyFilterCore(
    people,
    events,
    residenceSpans,
    mode,
    (p, m, o) => (isCompiledPerson(p) ? redactCompiledPerson(p, m, o) : redactSingleRawPerson(p, m, o)),
    options
  );
}

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
        ev?.participants.some((pt) => {
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
