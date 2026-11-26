import type { KinshipEdge, RawEvent, RawPerson } from '@kinloom/core';

export type TreeHygieneCategory =
  | 'excess_parents'
  | 'parent_child_chronology'
  | 'child_marriage'
  | 'duplicate_vital_event'
  | 'placeholder_event';

export const TREE_HYGIENE_CATEGORIES: readonly TreeHygieneCategory[] = [
  'excess_parents',
  'parent_child_chronology',
  'child_marriage',
  'duplicate_vital_event',
  'placeholder_event',
];

export interface TreeHygieneWarning {
  category: TreeHygieneCategory;
  personIds: string[];
  eventIds?: string[];
  message: string;
}

export interface TreeHygieneSummary {
  warnings: TreeHygieneWarning[];
  counts: Record<TreeHygieneCategory, number>;
}

interface ParsedDatePart {
  year: number;
  month: number | null;
  day: number | null;
}

interface ParsedEdtfRange {
  minYear: number | null;
  maxYear: number | null;
  minDate: ParsedDatePart | null;
  maxDate: ParsedDatePart | null;
}

const MIN_PARENT_AGE_YEARS = 13;
const MIN_MARRIAGE_AGE_YEARS = 14;
const PLACEHOLDER_EVENT_PREFIX = 'Recorded event for ';

const ADOPTIVE_MARKER_RE = /\badopt(?:ed|ion|ive)?\b|\badop\b/i;
const ADOPTIVE_XREF_RE = /adopt|adop/i;

const BAPTISM_OR_CHRISTENING_RE = /\b(baptis\w*|christen\w*)\b/i;
const BIRTH_TITLE_RE = /\b(birth|born)\b/i;
const BIRTH_SUBJECT_ROLES = new Set([
  'birth_subject',
  'principal',
  'subject',
  'infant',
  'newborn',
]);

const POST_DEATH_EVENT_RE =
  /\b(burial|buried|interment|interred|funeral|probate|estate|will|obituary|memorial|headstone|gravestone|cemetery|tombstone|cremation|inquest)\b/i;
const DEATH_TITLE_RE = /\b(death|died)\b/i;
const DEATH_SUBJECT_ROLES = new Set([
  'death_subject',
  'deceased',
  'decedent',
  'principal',
  'subject',
]);

const MARRIAGE_TITLE_RE = /\b(marr(?:iage|ied)?|wedding|nuptial)\b/i;
const DIVORCE_TITLE_RE = /\bdivorc\w*\b/i;
const NON_SPOUSE_ROLE_RE =
  /\b(parent|father|mother|witness|officiant|minister|clergy|bondsman|surety|clerk|mentioned|child|informant|guest)\b/i;
const SPOUSE_ROLE_RE = /\b(spouse|bride|groom|husband|wife|partner|principal|subject|co_principal)\b/i;

function parseDatePart(raw: string): ParsedDatePart | null {
  const clean = raw.trim().replaceAll(/[~?%]+$/g, '');
  if (!clean) {
    return null;
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (full) {
    return {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
    };
  }
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(clean);
  if (monthOnly) {
    return {
      year: Number(monthOnly[1]),
      month: Number(monthOnly[2]),
      day: null,
    };
  }
  const yearOnly = /^(\d{4})$/.exec(clean);
  if (yearOnly) {
    return {
      year: Number(yearOnly[1]),
      month: null,
      day: null,
    };
  }
  const decade = /^(\d{3})X$/i.exec(clean);
  if (decade) {
    return {
      year: Number(decade[1]) * 10,
      month: null,
      day: null,
    };
  }
  const fallback = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(clean);
  if (fallback) {
    return {
      year: Number(fallback[1]),
      month: null,
      day: null,
    };
  }
  return null;
}

function parseEdtfRange(edtf: string | null | undefined): ParsedEdtfRange | null {
  if (!edtf) {
    return null;
  }
  const trimmed = edtf.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('/')) {
    const slash = trimmed.indexOf('/');
    const leftRaw = trimmed.slice(0, slash).trim();
    const rightRaw = trimmed.slice(slash + 1).trim();
    const left = leftRaw ? parseDatePart(leftRaw) : null;
    const right = rightRaw ? parseDatePart(rightRaw) : null;
    if (!left && !right) {
      return null;
    }
    return {
      minYear: left?.year ?? null,
      maxYear: right?.year ?? null,
      minDate: left,
      maxDate: right,
    };
  }
  const decade = /^(\d{3})X$/i.exec(trimmed.replaceAll(/[~?%]+$/g, ''));
  if (decade) {
    const startYear = Number(decade[1]) * 10;
    return {
      minYear: startYear,
      maxYear: startYear + 9,
      minDate: { year: startYear, month: null, day: null },
      maxDate: { year: startYear + 9, month: null, day: null },
    };
  }
  const single = parseDatePart(trimmed);
  if (!single) {
    return null;
  }
  return {
    minYear: single.year,
    maxYear: single.year,
    minDate: single,
    maxDate: single,
  };
}

function maxPossibleAgeYears(birth: ParsedEdtfRange, target: ParsedEdtfRange): number | null {
  if (birth.minYear === null || target.maxYear === null) {
    return null;
  }
  const b = birth.minDate;
  const t = target.maxDate;
  if (b && t && b.month !== null && t.month !== null) {
    let years = t.year - b.year;
    if (t.month < b.month) {
      years -= 1;
    } else if (t.month === b.month && b.day !== null && t.day !== null && t.day < b.day) {
      years -= 1;
    }
    return years;
  }
  return target.maxYear - birth.minYear;
}

function isStrictlyAfterDate(later: ParsedEdtfRange, earlier: ParsedEdtfRange): boolean {
  if (later.minYear === null || earlier.maxYear === null) {
    return false;
  }
  if (later.minYear > earlier.maxYear) {
    return true;
  }
  if (later.minYear < earlier.maxYear) {
    return false;
  }
  const l = later.minDate;
  const e = earlier.maxDate;
  if (!l || !e || l.month === null || e.month === null) {
    return false;
  }
  if (l.month > e.month) {
    return true;
  }
  if (l.month < e.month) {
    return false;
  }
  if (l.day !== null && e.day !== null) {
    return l.day > e.day;
  }
  return false;
}

function isMoreThanOneYearAfter(later: ParsedEdtfRange, earlier: ParsedEdtfRange): boolean {
  if (later.minYear === null || earlier.maxYear === null) {
    return false;
  }
  const yearDiff = later.minYear - earlier.maxYear;
  if (yearDiff > 1) {
    return true;
  }
  if (yearDiff < 1) {
    return false;
  }
  const l = later.minDate;
  const e = earlier.maxDate;
  if (!l || !e || l.month === null || e.month === null) {
    return false;
  }
  if (l.month > e.month) {
    return true;
  }
  if (l.month < e.month) {
    return false;
  }
  if (l.day !== null && e.day !== null) {
    return l.day > e.day;
  }
  return false;
}

function hasAdoptiveExtension(extensions: Record<string, unknown> | undefined): boolean {
  if (!extensions) {
    return false;
  }
  for (const [key, value] of Object.entries(extensions)) {
    if (ADOPTIVE_XREF_RE.test(key)) {
      if (value === true || (typeof value === 'string' && value.trim().length > 0 && value !== 'false')) {
        return true;
      }
    }
    if (typeof value === 'string' && ADOPTIVE_MARKER_RE.test(value)) {
      return true;
    }
  }
  return false;
}

function hasAdoptivePersonTag(person: RawPerson | undefined): boolean {
  if (!person) {
    return false;
  }
  return ADOPTIVE_MARKER_RE.test(person.lineage_group) || hasAdoptiveExtension(person.extensions);
}

function isAdoptionEvent(event: RawEvent): boolean {
  if (event.category && ADOPTIVE_MARKER_RE.test(event.category)) {
    return true;
  }
  if (ADOPTIVE_MARKER_RE.test(event.title)) {
    return true;
  }
  return event.participants.some((p) => ADOPTIVE_MARKER_RE.test(p.role));
}

function isBirthEventForParticipant(event: RawEvent, role: string): boolean {
  const normalizedRole = role.trim().toLowerCase();
  if (!BIRTH_SUBJECT_ROLES.has(normalizedRole)) {
    return false;
  }
  if (BAPTISM_OR_CHRISTENING_RE.test(event.title) && !BIRTH_TITLE_RE.test(event.title)) {
    return false;
  }
  if (normalizedRole === 'birth_subject') {
    return true;
  }
  if (event.category?.trim().toLowerCase() === 'birth') {
    return true;
  }
  return BIRTH_TITLE_RE.test(event.title);
}

function isDeathEventForParticipant(event: RawEvent, role: string): boolean {
  const normalizedRole = role.trim().toLowerCase();
  if (!DEATH_SUBJECT_ROLES.has(normalizedRole)) {
    return false;
  }
  if (POST_DEATH_EVENT_RE.test(event.title) && !DEATH_TITLE_RE.test(event.title)) {
    return false;
  }
  if (normalizedRole === 'death_subject') {
    return true;
  }
  if (event.category?.trim().toLowerCase() === 'death') {
    return true;
  }
  return DEATH_TITLE_RE.test(event.title);
}

function isMarriageEvent(event: RawEvent): boolean {
  if (DIVORCE_TITLE_RE.test(event.title) && !MARRIAGE_TITLE_RE.test(event.title)) {
    return false;
  }
  if (event.category?.trim().toLowerCase() === 'marriage') {
    return true;
  }
  if (MARRIAGE_TITLE_RE.test(event.title)) {
    return true;
  }
  return event.participants.some((p) => {
    const r = p.role.trim();
    return /\b(spouse|bride|groom|husband|wife)\b/i.test(r) && !NON_SPOUSE_ROLE_RE.test(r);
  });
}

function getMarriageSpouseIds(event: RawEvent): string[] {
  const spouses = new Set<string>();
  for (const participant of event.participants) {
    const role = participant.role.trim();
    if (NON_SPOUSE_ROLE_RE.test(role)) {
      continue;
    }
    if (SPOUSE_ROLE_RE.test(role)) {
      spouses.add(participant.person_id);
    }
  }
  return [...spouses].toSorted((a, b) => a.localeCompare(b));
}

function personLabel(personId: string, peopleById: ReadonlyMap<string, RawPerson>): string {
  const person = peopleById.get(personId);
  return person ? `${person.full_name} (${person.id})` : personId;
}

function normalizeSex(person: RawPerson | undefined): 'F' | 'M' | 'U' {
  const raw = person?.sex?.trim().toUpperCase();
  if (raw === 'F' || raw === 'M') {
    return raw;
  }
  return 'U';
}

export function analyzeTreeHygiene(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  kinship: readonly KinshipEdge[];
}): TreeHygieneSummary {
  const warnings: TreeHygieneWarning[] = [];
  const peopleById = new Map<string, RawPerson>(input.people.map((person) => [person.id, person]));

  // Index parent edges deduplicated per (childId, parentId) across both `parent` and `child` edges.
  const parentsByChild = new Map<string, Map<string, Set<string>>>();
  const addParentLink = (childId: string, parentId: string, familyXref: string | null | undefined): void => {
    let parentMap = parentsByChild.get(childId);
    if (!parentMap) {
      parentMap = new Map<string, Set<string>>();
      parentsByChild.set(childId, parentMap);
    }
    let xrefs = parentMap.get(parentId);
    if (!xrefs) {
      xrefs = new Set<string>();
      parentMap.set(parentId, xrefs);
    }
    if (familyXref && familyXref.trim().length > 0) {
      xrefs.add(familyXref.trim());
    }
  };

  for (const edge of input.kinship) {
    if (edge.relation === 'parent') {
      addParentLink(edge.to, edge.from, edge.family_xref);
    } else if (edge.relation === 'child') {
      addParentLink(edge.from, edge.to, edge.family_xref);
    }
  }

  // Index adoption events to recognize adoptive parent links and adoptive children.
  const adoptionEventPairs = new Set<string>();
  const childWithAdoptionEvent = new Set<string>();
  for (const event of input.events) {
    if (!isAdoptionEvent(event)) {
      continue;
    }
    const ids = [...new Set(event.participants.map((p) => p.person_id))];
    for (const id of ids) {
      childWithAdoptionEvent.add(id);
    }
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        adoptionEventPairs.add(`${ids[i]}|${ids[j]}`);
        adoptionEventPairs.add(`${ids[j]}|${ids[i]}`);
      }
    }
  }

  // Index birth/death/marriage events for vital event duplication and date fallbacks.
  const birthEventsByPerson = new Map<string, RawEvent[]>();
  const deathEventsByPerson = new Map<string, RawEvent[]>();
  const marriageEventsByCouple = new Map<string, { spouses: string[]; events: RawEvent[] }>();

  for (const event of input.events) {
    if (event.title.trimStart().startsWith(PLACEHOLDER_EVENT_PREFIX)) {
      const personIds = [...new Set(event.participants.map((p) => p.person_id))].toSorted((a, b) =>
        a.localeCompare(b)
      );
      const dateSuffix = event.edtf_date.trim() ? ` (${event.edtf_date.trim()})` : '';
      warnings.push({
        category: 'placeholder_event',
        personIds,
        eventIds: [event.id],
        message: `Event ${event.id} has generic GEDCOM placeholder title "${event.title.trim()}"${dateSuffix}.`,
      });
    }

    const birthAdded = new Set<string>();
    const deathAdded = new Set<string>();
    for (const participant of event.participants) {
      if (isBirthEventForParticipant(event, participant.role) && !birthAdded.has(participant.person_id)) {
        birthAdded.add(participant.person_id);
        const list = birthEventsByPerson.get(participant.person_id) ?? [];
        list.push(event);
        birthEventsByPerson.set(participant.person_id, list);
      }
      if (isDeathEventForParticipant(event, participant.role) && !deathAdded.has(participant.person_id)) {
        deathAdded.add(participant.person_id);
        const list = deathEventsByPerson.get(participant.person_id) ?? [];
        list.push(event);
        deathEventsByPerson.set(participant.person_id, list);
      }
    }

    if (isMarriageEvent(event)) {
      const spouses = getMarriageSpouseIds(event);
      if (spouses.length >= 2) {
        const coupleKey = spouses.join('|');
        let bucket = marriageEventsByCouple.get(coupleKey);
        if (!bucket) {
          bucket = { spouses, events: [] };
          marriageEventsByCouple.set(coupleKey, bucket);
        }
        bucket.events.push(event);
      }
    }
  }

  // Resolve effective birth/death ranges for chronology checks (RawPerson first, single event fallback).
  const birthRangeByPerson = new Map<string, { raw: string; range: ParsedEdtfRange }>();
  const deathRangeByPerson = new Map<string, { raw: string; range: ParsedEdtfRange }>();
  for (const person of input.people) {
    const birthRaw = person.birth_edtf.trim() || birthEventsByPerson.get(person.id)?.[0]?.edtf_date.trim() || '';
    const birthRange = parseEdtfRange(birthRaw);
    if (birthRange) {
      birthRangeByPerson.set(person.id, { raw: birthRaw, range: birthRange });
    }
    const deathRaw = person.death_edtf.trim() || deathEventsByPerson.get(person.id)?.[0]?.edtf_date.trim() || '';
    const deathRange = parseEdtfRange(deathRaw);
    if (deathRange) {
      deathRangeByPerson.set(person.id, { raw: deathRaw, range: deathRange });
    }
  }

  // (a) Excess parents (>2 parents or >1 non-adoptive parent of the same sex)
  // (b1) Parent-child chronology (child born before parent age 13, after mother's death, or >1 year after father's death)
  for (const [childId, parentMap] of parentsByChild) {
    const child = peopleById.get(childId);
    const childIsAdoptive = hasAdoptivePersonTag(child) || childWithAdoptionEvent.has(childId);

    const parentEntries = [...parentMap.entries()]
      .map(([parentId, xrefs]) => {
        const parent = peopleById.get(parentId);
        const sortedXrefs = [...xrefs].toSorted((a, b) => a.localeCompare(b));
        const hasAdoptiveXref = sortedXrefs.some((xref) => ADOPTIVE_XREF_RE.test(xref));
        const hasAdoptiveLink =
          hasAdoptiveXref ||
          hasAdoptivePersonTag(parent) ||
          adoptionEventPairs.has(`${childId}|${parentId}`);
        return {
          parentId,
          parent,
          sex: normalizeSex(parent),
          xrefs: sortedXrefs,
          hasAdoptiveLink,
        };
      })
      .toSorted((a, b) => a.parentId.localeCompare(b.parentId));

    const nonAdoptive = parentEntries.filter((entry) => !entry.hasAdoptiveLink);
    const nonAdoptiveMothers = nonAdoptive.filter((entry) => entry.sex === 'F');
    const nonAdoptiveFathers = nonAdoptive.filter((entry) => entry.sex === 'M');

    const excessReasons: string[] = [];
    if (nonAdoptive.length > 2 && !childIsAdoptive) {
      excessReasons.push(`${nonAdoptive.length} non-adoptive parents`);
    }
    if (nonAdoptiveMothers.length > 1) {
      const motherSummary = nonAdoptiveMothers
        .map((m) =>
          m.xrefs.length > 0
            ? `${personLabel(m.parentId, peopleById)} [${m.xrefs.join(', ')}]`
            : personLabel(m.parentId, peopleById)
        )
        .join(', ');
      excessReasons.push(`${nonAdoptiveMothers.length} non-adoptive female parents (${motherSummary})`);
    }
    if (nonAdoptiveFathers.length > 1) {
      const fatherSummary = nonAdoptiveFathers
        .map((f) =>
          f.xrefs.length > 0
            ? `${personLabel(f.parentId, peopleById)} [${f.xrefs.join(', ')}]`
            : personLabel(f.parentId, peopleById)
        )
        .join(', ');
      excessReasons.push(`${nonAdoptiveFathers.length} non-adoptive male parents (${fatherSummary})`);
    }

    if (excessReasons.length > 0) {
      warnings.push({
        category: 'excess_parents',
        personIds: [childId, ...nonAdoptive.map((entry) => entry.parentId)],
        message: `${personLabel(childId, peopleById)} has ${excessReasons.join('; ')}.`,
      });
    }

    const childBirth = birthRangeByPerson.get(childId);
    if (!childBirth) {
      continue;
    }

    for (const entry of parentEntries) {
      if (entry.hasAdoptiveLink) {
        continue;
      }
      const parentBirth = birthRangeByPerson.get(entry.parentId);
      if (parentBirth) {
        const parentAge = maxPossibleAgeYears(parentBirth.range, childBirth.range);
        if (parentAge !== null && parentAge < MIN_PARENT_AGE_YEARS) {
          warnings.push({
            category: 'parent_child_chronology',
            personIds: [entry.parentId, childId],
            message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born when parent ${personLabel(entry.parentId, peopleById)} (born ${parentBirth.raw}) was age ${parentAge} (< ${MIN_PARENT_AGE_YEARS}).`,
          });
        }
      }

      const parentDeath = deathRangeByPerson.get(entry.parentId);
      if (parentDeath) {
        if (entry.sex === 'F') {
          if (isStrictlyAfterDate(childBirth.range, parentDeath.range)) {
            warnings.push({
              category: 'parent_child_chronology',
              personIds: [entry.parentId, childId],
              message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born after mother ${personLabel(entry.parentId, peopleById)} died (${parentDeath.raw}).`,
            });
          }
        } else if (isMoreThanOneYearAfter(childBirth.range, parentDeath.range)) {
          const roleLabel = entry.sex === 'M' ? 'father' : 'parent';
          warnings.push({
            category: 'parent_child_chronology',
            personIds: [entry.parentId, childId],
            message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born more than 1 year after ${roleLabel} ${personLabel(entry.parentId, peopleById)} died (${parentDeath.raw}).`,
          });
        }
      }
    }
  }

  // (b2) Marriage chronology anomalies (spouse under age 14 at marriage date)
  for (const event of input.events) {
    if (!isMarriageEvent(event)) {
      continue;
    }
    const marriageRaw = event.edtf_date.trim();
    const marriageRange = parseEdtfRange(marriageRaw);
    if (!marriageRange) {
      continue;
    }
    for (const spouseId of getMarriageSpouseIds(event)) {
      const spouseBirth = birthRangeByPerson.get(spouseId);
      if (!spouseBirth) {
        continue;
      }
      const spouseAge = maxPossibleAgeYears(spouseBirth.range, marriageRange);
      if (spouseAge !== null && spouseAge < MIN_MARRIAGE_AGE_YEARS) {
        warnings.push({
          category: 'child_marriage',
          personIds: [spouseId],
          eventIds: [event.id],
          message: `${personLabel(spouseId, peopleById)} (born ${spouseBirth.raw}) was age ${spouseAge} (< ${MIN_MARRIAGE_AGE_YEARS}) at marriage event ${event.id} (${marriageRaw}).`,
        });
      }
    }
  }

  // (c) Duplicate vital events on the same person (births, deaths) or same couple (marriages)
  for (const [personId, birthEvents] of birthEventsByPerson) {
    if (birthEvents.length > 1) {
      const sorted = [...birthEvents].toSorted((a, b) => a.id.localeCompare(b.id));
      const detail = sorted.map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`).join(', ');
      warnings.push({
        category: 'duplicate_vital_event',
        personIds: [personId],
        eventIds: sorted.map((e) => e.id),
        message: `${personLabel(personId, peopleById)} has ${sorted.length} birth events: ${detail}.`,
      });
    }
  }

  for (const [personId, deathEvents] of deathEventsByPerson) {
    if (deathEvents.length > 1) {
      const sorted = [...deathEvents].toSorted((a, b) => a.id.localeCompare(b.id));
      const detail = sorted.map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`).join(', ');
      warnings.push({
        category: 'duplicate_vital_event',
        personIds: [personId],
        eventIds: sorted.map((e) => e.id),
        message: `${personLabel(personId, peopleById)} has ${sorted.length} death events: ${detail}.`,
      });
    }
  }

  for (const { spouses, events: coupleMarriages } of marriageEventsByCouple.values()) {
    if (coupleMarriages.length > 1) {
      const sorted = [...coupleMarriages].toSorted((a, b) => a.id.localeCompare(b.id));
      const coupleLabel = spouses.map((id) => personLabel(id, peopleById)).join(' and ');
      const detail = sorted.map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`).join(', ');
      warnings.push({
        category: 'duplicate_vital_event',
        personIds: spouses,
        eventIds: sorted.map((e) => e.id),
        message: `Duplicate marriage events for ${coupleLabel}: ${detail}.`,
      });
    }
  }

  const categoryOrder = new Map<TreeHygieneCategory, number>(
    TREE_HYGIENE_CATEGORIES.map((category, index) => [category, index])
  );
  warnings.sort(
    (a, b) =>
      (categoryOrder.get(a.category) ?? 0) - (categoryOrder.get(b.category) ?? 0) ||
      a.personIds.join(',').localeCompare(b.personIds.join(',')) ||
      (a.eventIds ?? []).join(',').localeCompare((b.eventIds ?? []).join(',')) ||
      a.message.localeCompare(b.message)
  );

  const counts: Record<TreeHygieneCategory, number> = {
    excess_parents: 0,
    parent_child_chronology: 0,
    child_marriage: 0,
    duplicate_vital_event: 0,
    placeholder_event: 0,
  };
  for (const warning of warnings) {
    counts[warning.category] += 1;
  }

  return { warnings, counts };
}
