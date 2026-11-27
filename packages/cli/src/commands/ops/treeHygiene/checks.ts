import { fastLocaleCompare, type KinshipEdge, type RawEvent, type RawPerson } from '@kinloom/core';
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

interface ParentLinkRecord {
  parentId: string;
  firstXref: string | null;
  extraXrefs: string[] | null;
}

interface IndexedTreeData {
  peopleById: Map<string, RawPerson>;
  parentsByChild: Map<string, ParentLinkRecord[]>;
  adoptionEventPairs: Set<string>;
  childWithAdoptionEvent: Set<string>;
  birthEventsByPerson: Map<string, RawEvent[]>;
  deathEventsByPerson: Map<string, RawEvent[]>;
  marriageEventsByCouple: Map<string, { spouses: string[]; events: RawEvent[] }>;
  birthRangeByPerson: Map<string, { raw: string; range: ParsedEdtfRange }>;
  deathRangeByPerson: Map<string, { raw: string; range: ParsedEdtfRange }>;
  placeholderWarnings: TreeHygieneWarning[];
}

const CATEGORY_ORDER = new Map<TreeHygieneCategory, number>(
  TREE_HYGIENE_CATEGORIES.map((category, index) => [category, index])
);

function indexTreeData(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  kinship: readonly KinshipEdge[];
}): IndexedTreeData {
  const peopleById = new Map<string, RawPerson>();
  for (let i = 0; i < input.people.length; i += 1) {
    const person = input.people[i];
    peopleById.set(person.id, person);
  }
  const placeholderWarnings: TreeHygieneWarning[] = [];

  // Index parent edges deduplicated per (childId, parentId) using compact arrays instead of nested Maps/Sets.
  const parentsByChild = new Map<string, ParentLinkRecord[]>();
  const addParentLink = (childId: string, parentId: string, familyXref: string | null | undefined): void => {
    const trimmedXref = familyXref && familyXref.trim().length > 0 ? familyXref.trim() : null;
    let list = parentsByChild.get(childId);
    if (!list) {
      list = [{ parentId, firstXref: trimmedXref, extraXrefs: null }];
      parentsByChild.set(childId, list);
      return;
    }
    for (let i = 0; i < list.length; i += 1) {
      const rec = list[i];
      if (rec.parentId === parentId) {
        if (trimmedXref) {
          if (rec.firstXref === null) {
            rec.firstXref = trimmedXref;
          } else if (rec.firstXref !== trimmedXref) {
            if (!rec.extraXrefs) {
              rec.extraXrefs = [trimmedXref];
            } else if (!rec.extraXrefs.includes(trimmedXref)) {
              rec.extraXrefs.push(trimmedXref);
            }
          }
        }
        return;
      }
    }
    list.push({ parentId, firstXref: trimmedXref, extraXrefs: null });
  };

  for (let i = 0; i < input.kinship.length; i += 1) {
    const edge = input.kinship[i];
    if (edge.relation === 'parent') {
      addParentLink(edge.to, edge.from, edge.family_xref);
    } else if (edge.relation === 'child') {
      addParentLink(edge.from, edge.to, edge.family_xref);
    }
  }

  // Single fused pass over events for adoption indexing, placeholder detection, and vital event buckets.
  const adoptionEventPairs = new Set<string>();
  const childWithAdoptionEvent = new Set<string>();
  const birthEventsByPerson = new Map<string, RawEvent[]>();
  const deathEventsByPerson = new Map<string, RawEvent[]>();
  const marriageEventsByCouple = new Map<string, { spouses: string[]; events: RawEvent[] }>();

  for (let i = 0; i < input.events.length; i += 1) {
    const event = input.events[i];
    const pts = event.participants;

    if (isAdoptionEvent(event)) {
      const ids = [...new Set(pts.map((p) => p.person_id))];
      for (let a = 0; a < ids.length; a += 1) {
        childWithAdoptionEvent.add(ids[a]);
        for (let b = a + 1; b < ids.length; b += 1) {
          adoptionEventPairs.add(`${ids[a]}|${ids[b]}`);
          adoptionEventPairs.add(`${ids[b]}|${ids[a]}`);
        }
      }
    }

    const title = event.title;
    if (
      title.length >= PLACEHOLDER_EVENT_PREFIX.length &&
      (title.startsWith(PLACEHOLDER_EVENT_PREFIX) || title.trimStart().startsWith(PLACEHOLDER_EVENT_PREFIX))
    ) {
      const personIds = [...new Set(pts.map((p) => p.person_id))].toSorted(fastLocaleCompare);
      const dateSuffix = event.edtf_date.trim() ? ` (${event.edtf_date.trim()})` : '';
      placeholderWarnings.push({
        category: 'placeholder_event',
        personIds,
        eventIds: [event.id],
        message: `Event ${event.id} has generic GEDCOM placeholder title "${title.trim()}"${dateSuffix}.`,
      });
    }

    if (pts.length === 1) {
      const participant = pts[0];
      if (isBirthEventForParticipant(event, participant.role)) {
        let list = birthEventsByPerson.get(participant.person_id);
        if (!list) {
          list = [];
          birthEventsByPerson.set(participant.person_id, list);
        }
        list.push(event);
      }
      if (isDeathEventForParticipant(event, participant.role)) {
        let list = deathEventsByPerson.get(participant.person_id);
        if (!list) {
          list = [];
          deathEventsByPerson.set(participant.person_id, list);
        }
        list.push(event);
      }
    } else if (pts.length > 1) {
      let birthAdded: Set<string> | null = null;
      let deathAdded: Set<string> | null = null;
      for (let p = 0; p < pts.length; p += 1) {
        const participant = pts[p];
        if (isBirthEventForParticipant(event, participant.role)) {
          if (!birthAdded) birthAdded = new Set<string>();
          if (!birthAdded.has(participant.person_id)) {
            birthAdded.add(participant.person_id);
            let list = birthEventsByPerson.get(participant.person_id);
            if (!list) {
              list = [];
              birthEventsByPerson.set(participant.person_id, list);
            }
            list.push(event);
          }
        }
        if (isDeathEventForParticipant(event, participant.role)) {
          if (!deathAdded) deathAdded = new Set<string>();
          if (!deathAdded.has(participant.person_id)) {
            deathAdded.add(participant.person_id);
            let list = deathEventsByPerson.get(participant.person_id);
            if (!list) {
              list = [];
              deathEventsByPerson.set(participant.person_id, list);
            }
            list.push(event);
          }
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
  }

  // Resolve effective birth/death ranges for chronology checks (RawPerson first, single event fallback).
  const birthRangeByPerson = new Map<string, { raw: string; range: ParsedEdtfRange }>();
  const deathRangeByPerson = new Map<string, { raw: string; range: ParsedEdtfRange }>();
  for (let i = 0; i < input.people.length; i += 1) {
    const person = input.people[i];
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

function getSortedXrefs(rec: ParentLinkRecord): string[] {
  if (rec.firstXref === null) {
    return [];
  }
  if (!rec.extraXrefs) {
    return [rec.firstXref];
  }
  return [rec.firstXref, ...rec.extraXrefs].toSorted(fastLocaleCompare);
}

function hasRecordAdoptiveXref(rec: ParentLinkRecord): boolean {
  if (rec.firstXref !== null && ADOPTIVE_XREF_RE.test(rec.firstXref)) {
    return true;
  }
  if (rec.extraXrefs) {
    for (let i = 0; i < rec.extraXrefs.length; i += 1) {
      if (ADOPTIVE_XREF_RE.test(rec.extraXrefs[i])) {
        return true;
      }
    }
  }
  return false;
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

  const hasAnyAdoptionEvents = adoptionEventPairs.size > 0;

  for (const [childId, parentList] of parentsByChild) {
    if (parentList.length === 2) {
      if (fastLocaleCompare(parentList[0].parentId, parentList[1].parentId) > 0) {
        const tmp = parentList[0];
        parentList[0] = parentList[1];
        parentList[1] = tmp;
      }
    } else if (parentList.length > 2) {
      parentList.sort((a, b) => fastLocaleCompare(a.parentId, b.parentId));
    }

    const child = peopleById.get(childId);
    const childIsAdoptive = hasAdoptivePersonTag(child) || childWithAdoptionEvent.has(childId);

    let nonAdoptiveCount = 0;
    let nonAdoptiveMotherCount = 0;
    let nonAdoptiveFatherCount = 0;

    // Fast path for standard 1- or 2-parent links: compute counts inline without allocating per-parent objects/arrays.
    const parentLen = parentList.length;
    for (let i = 0; i < parentLen; i += 1) {
      const rec = parentList[i];
      const parent = peopleById.get(rec.parentId);
      const isAdoptive =
        hasRecordAdoptiveXref(rec) ||
        hasAdoptivePersonTag(parent) ||
        (hasAnyAdoptionEvents && adoptionEventPairs.has(`${childId}|${rec.parentId}`));
      if (!isAdoptive) {
        nonAdoptiveCount += 1;
        const sex = normalizeSex(parent);
        if (sex === 'F') {
          nonAdoptiveMotherCount += 1;
        } else if (sex === 'M') {
          nonAdoptiveFatherCount += 1;
        }
      }
    }

    if (
      (nonAdoptiveCount > 2 && !childIsAdoptive) ||
      nonAdoptiveMotherCount > 1 ||
      nonAdoptiveFatherCount > 1
    ) {
      const nonAdoptive: Array<{ parentId: string; sex: 'F' | 'M' | 'U'; xrefs: string[] }> = [];
      for (let i = 0; i < parentLen; i += 1) {
        const rec = parentList[i];
        const parent = peopleById.get(rec.parentId);
        const isAdoptive =
          hasRecordAdoptiveXref(rec) ||
          hasAdoptivePersonTag(parent) ||
          (hasAnyAdoptionEvents && adoptionEventPairs.has(`${childId}|${rec.parentId}`));
        if (!isAdoptive) {
          nonAdoptive.push({
            parentId: rec.parentId,
            sex: normalizeSex(parent),
            xrefs: getSortedXrefs(rec),
          });
        }
      }
      const nonAdoptiveMothers = nonAdoptive.filter((e) => e.sex === 'F');
      const nonAdoptiveFathers = nonAdoptive.filter((e) => e.sex === 'M');
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

    for (let i = 0; i < parentLen; i += 1) {
      const rec = parentList[i];
      const parentId = rec.parentId;
      const parent = peopleById.get(parentId);
      const isAdoptive =
        hasRecordAdoptiveXref(rec) ||
        hasAdoptivePersonTag(parent) ||
        (hasAnyAdoptionEvents && adoptionEventPairs.has(`${childId}|${parentId}`));
      if (isAdoptive) {
        continue;
      }

      const parentBirth = birthRangeByPerson.get(parentId);
      if (parentBirth) {
        const parentAge = maxPossibleAgeYears(parentBirth.range, childBirth.range);
        if (parentAge !== null && parentAge < MIN_PARENT_AGE_YEARS) {
          warnings.push({
            category: 'parent_child_chronology',
            personIds: [parentId, childId],
            message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born when parent ${personLabel(parentId, peopleById)} (born ${parentBirth.raw}) was age ${parentAge} (< ${MIN_PARENT_AGE_YEARS}).`,
          });
        }
      }

      const parentDeath = deathRangeByPerson.get(parentId);
      if (parentDeath) {
        const sex = normalizeSex(parent);
        if (sex === 'F') {
          if (isStrictlyAfterDate(childBirth.range, parentDeath.range)) {
            warnings.push({
              category: 'parent_child_chronology',
              personIds: [parentId, childId],
              message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born after mother ${personLabel(parentId, peopleById)} died (${parentDeath.raw}).`,
            });
          }
        } else if (isMoreThanOneYearAfter(childBirth.range, parentDeath.range)) {
          const roleLabel = sex === 'M' ? 'father' : 'parent';
          warnings.push({
            category: 'parent_child_chronology',
            personIds: [parentId, childId],
            message: `${personLabel(childId, peopleById)} (born ${childBirth.raw}) was born more than 1 year after ${roleLabel} ${personLabel(parentId, peopleById)} died (${parentDeath.raw}).`,
          });
        }
      }
    }
  }
}

function collectMarriageChronologyWarnings(data: IndexedTreeData, warnings: TreeHygieneWarning[]): void {
  const { peopleById, birthRangeByPerson, marriageEventsByCouple } = data;
  for (const { spouses, events: coupleMarriages } of marriageEventsByCouple.values()) {
    for (let i = 0; i < coupleMarriages.length; i += 1) {
      const event = coupleMarriages[i];
      const marriageRaw = event.edtf_date.trim();
      const marriageRange = parseEdtfRange(marriageRaw);
      if (!marriageRange) {
        continue;
      }
      for (let s = 0; s < spouses.length; s += 1) {
        const spouseId = spouses[s];
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
}

function collectDuplicateVitalEventWarnings(data: IndexedTreeData, warnings: TreeHygieneWarning[]): void {
  const { peopleById, birthEventsByPerson, deathEventsByPerson, marriageEventsByCouple } = data;

  for (const [personId, birthEvents] of birthEventsByPerson) {
    if (birthEvents.length > 1) {
      const sorted = [...birthEvents].toSorted((a, b) => fastLocaleCompare(a.id, b.id));
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
      const sorted = [...deathEvents].toSorted((a, b) => fastLocaleCompare(a.id, b.id));
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
      const sorted = [...coupleMarriages].toSorted((a, b) => fastLocaleCompare(a.id, b.id));
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

  collectParentWarnings(data, warnings);
  collectMarriageChronologyWarnings(data, warnings);
  collectDuplicateVitalEventWarnings(data, warnings);

  if (warnings.length > 1) {
    warnings.sort(
      (a, b) =>
        (CATEGORY_ORDER.get(a.category) ?? 0) - (CATEGORY_ORDER.get(b.category) ?? 0) ||
        fastLocaleCompare(a.personIds.join(','), b.personIds.join(',')) ||
        fastLocaleCompare((a.eventIds ?? []).join(','), (b.eventIds ?? []).join(',')) ||
        fastLocaleCompare(a.message, b.message)
    );
  }

  const counts: Record<TreeHygieneCategory, number> = {
    excess_parents: 0,
    parent_child_chronology: 0,
    child_marriage: 0,
    duplicate_vital_event: 0,
    placeholder_event: 0,
  };
  for (let i = 0; i < warnings.length; i += 1) {
    counts[warnings[i].category] += 1;
  }

  return { warnings, counts };
}
