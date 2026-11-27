import type { KinshipEdge, RawEvent, RawPerson } from '@kinloom/core';
import {
  ADOPTIVE_XREF_RE,
  getMarriageSpouseIds,
  hasAdoptivePersonTag,
  isAdoptionEvent,
  isBirthEventForParticipant,
  isDeathEventForParticipant,
  isMarriageEvent,
  normalizeSex,
  personLabel,
} from './classifiers.js';
import { isMoreThanOneYearAfter, isStrictlyAfterDate, maxPossibleAgeYears, parseEdtfRange } from './dates.js';
import {
  MIN_MARRIAGE_AGE_YEARS,
  MIN_PARENT_AGE_YEARS,
  type ParsedEdtfRange,
  PLACEHOLDER_EVENT_PREFIX,
  TREE_HYGIENE_CATEGORIES,
  type TreeHygieneCategory,
  type TreeHygieneSummary,
  type TreeHygieneWarning,
} from './types.js';

interface IndexedTreeData {
  peopleById: Map<string, RawPerson>;
  parentsByChild: Map<string, Map<string, Set<string>>>;
  adoptionEventPairs: Set<string>;
  childWithAdoptionEvent: Set<string>;
  birthEventsByPerson: Map<string, RawEvent[]>;
  deathEventsByPerson: Map<string, RawEvent[]>;
  marriageEventsByCouple: Map<string, { spouses: string[]; events: RawEvent[] }>;
  birthRangeByPerson: Map<string, { raw: string; range: ParsedEdtfRange }>;
  deathRangeByPerson: Map<string, { raw: string; range: ParsedEdtfRange }>;
  placeholderWarnings: TreeHygieneWarning[];
}

function indexTreeData(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  kinship: readonly KinshipEdge[];
}): IndexedTreeData {
  const peopleById = new Map<string, RawPerson>(input.people.map((person) => [person.id, person]));
  const placeholderWarnings: TreeHygieneWarning[] = [];

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
      placeholderWarnings.push({
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
    const birthRaw =
      person.birth_edtf.trim() || birthEventsByPerson.get(person.id)?.[0]?.edtf_date.trim() || '';
    const birthRange = parseEdtfRange(birthRaw);
    if (birthRange) {
      birthRangeByPerson.set(person.id, { raw: birthRaw, range: birthRange });
    }
    const deathRaw =
      person.death_edtf.trim() || deathEventsByPerson.get(person.id)?.[0]?.edtf_date.trim() || '';
    const deathRange = parseEdtfRange(deathRaw);
    if (deathRange) {
      deathRangeByPerson.set(person.id, { raw: deathRaw, range: deathRange });
    }
  }

  return {
    peopleById,
    parentsByChild,
    adoptionEventPairs,
    childWithAdoptionEvent,
    birthEventsByPerson,
    deathEventsByPerson,
    marriageEventsByCouple,
    birthRangeByPerson,
    deathRangeByPerson,
    placeholderWarnings,
  };
}

function collectParentWarnings(data: IndexedTreeData, warnings: TreeHygieneWarning[]): void {
  const {
    peopleById,
    parentsByChild,
    adoptionEventPairs,
    childWithAdoptionEvent,
    birthRangeByPerson,
    deathRangeByPerson,
  } = data;

  for (const [childId, parentMap] of parentsByChild) {
    const child = peopleById.get(childId);
    const childIsAdoptive = hasAdoptivePersonTag(child) || childWithAdoptionEvent.has(childId);

    const parentEntries = [...parentMap.entries()]
      .map(([parentId, xrefs]) => {
        const parent = peopleById.get(parentId);
        const sortedXrefs = [...xrefs].toSorted((a, b) => a.localeCompare(b));
        const hasAdoptiveXref = sortedXrefs.some((xref) => ADOPTIVE_XREF_RE.test(xref));
        const hasAdoptiveLink =
          hasAdoptiveXref || hasAdoptivePersonTag(parent) || adoptionEventPairs.has(`${childId}|${parentId}`);
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
}

function collectMarriageChronologyWarnings(
  events: readonly RawEvent[],
  data: IndexedTreeData,
  warnings: TreeHygieneWarning[]
): void {
  const { peopleById, birthRangeByPerson } = data;
  for (const event of events) {
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
}

function collectDuplicateVitalEventWarnings(data: IndexedTreeData, warnings: TreeHygieneWarning[]): void {
  const { peopleById, birthEventsByPerson, deathEventsByPerson, marriageEventsByCouple } = data;

  for (const [personId, birthEvents] of birthEventsByPerson) {
    if (birthEvents.length > 1) {
      const sorted = [...birthEvents].toSorted((a, b) => a.id.localeCompare(b.id));
      const detail = sorted
        .map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`)
        .join(', ');
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
      const detail = sorted
        .map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`)
        .join(', ');
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
      const detail = sorted
        .map((e) => `${e.id}${e.edtf_date.trim() ? ` (${e.edtf_date.trim()})` : ''}`)
        .join(', ');
      warnings.push({
        category: 'duplicate_vital_event',
        personIds: spouses,
        eventIds: sorted.map((e) => e.id),
        message: `Duplicate marriage events for ${coupleLabel}: ${detail}.`,
      });
    }
  }
}

export function analyzeTreeHygiene(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  kinship: readonly KinshipEdge[];
}): TreeHygieneSummary {
  const data = indexTreeData(input);
  const warnings: TreeHygieneWarning[] = [...data.placeholderWarnings];

  // (a) Excess parents (>2 parents or >1 non-adoptive parent of the same sex)
  // (b1) Parent-child chronology (child born before parent age 13, after mother's death, or >1 year after father's death)
  collectParentWarnings(data, warnings);

  // (b2) Marriage chronology anomalies (spouse under age 14 at marriage date)
  collectMarriageChronologyWarnings(input.events, data, warnings);

  // (c) Duplicate vital events on the same person (births, deaths) or same couple (marriages)
  collectDuplicateVitalEventWarnings(data, warnings);

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
