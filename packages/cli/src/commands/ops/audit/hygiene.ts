import type { KinshipEdge, RawEvent, RawPerson } from '@kinloom/core';
import { applyKinshipRemovals } from '../shared/integrateEngine/kinship.js';
import type { RemoveKinshipEntry } from '../shared/integrateEngine/types.js';
import { analyzeTreeHygiene, diffTreeHygieneWarnings, type TreeHygieneWarning } from '../tree-hygiene.js';
import { asString, isPlainRecord, type LooseRecord, stringListField } from './types.js';

function isKinshipRelation(value: string): value is KinshipEdge['relation'] {
  return value === 'parent' || value === 'child' || value === 'spouse';
}

function toHygienePerson(record: LooseRecord): RawPerson | null {
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  if (!id) {
    return null;
  }
  return {
    id,
    slug: typeof record['slug'] === 'string' && record['slug'].trim() ? record['slug'].trim() : id,
    full_name: asString(record['full_name']).trim() || id,
    given_name: asString(record['given_name']).trim(),
    surname: asString(record['surname']).trim(),
    alt_names: stringListField(record['alt_names']),
    sex: asString(record['sex']).trim() || 'U',
    is_living: record['is_living'] === true || record['living'] === true,
    lineage_group: asString(record['lineage_group']).trim() || 'extended',
    birth_edtf: asString(record['birth_edtf'] ?? record['birth_date']).trim(),
    death_edtf: asString(record['death_edtf'] ?? record['death_date']).trim(),
    portrait_url: typeof record['portrait_url'] === 'string' ? record['portrait_url'] : null,
    ...(isPlainRecord(record['extensions']) ? { extensions: { ...record['extensions'] } } : {}),
  };
}

function applyPersonFieldsForHygiene(existing: RawPerson, patchFields: LooseRecord): RawPerson {
  const next: RawPerson = {
    ...existing,
    ...(existing.extensions ? { extensions: { ...existing.extensions } } : {}),
  };
  if (typeof patchFields['full_name'] === 'string' && patchFields['full_name'].trim()) {
    next.full_name = patchFields['full_name'].trim();
  }
  if (typeof patchFields['sex'] === 'string' && patchFields['sex'].trim()) {
    next.sex = patchFields['sex'].trim();
  }
  if (typeof patchFields['lineage_group'] === 'string' && patchFields['lineage_group'].trim()) {
    next.lineage_group = patchFields['lineage_group'].trim();
  }
  if (patchFields['birth_edtf'] !== undefined || patchFields['birth_date'] !== undefined) {
    next.birth_edtf = asString(patchFields['birth_edtf'] ?? patchFields['birth_date']).trim();
  }
  if (patchFields['death_edtf'] !== undefined || patchFields['death_date'] !== undefined) {
    next.death_edtf = asString(patchFields['death_edtf'] ?? patchFields['death_date']).trim();
  }
  if (isPlainRecord(patchFields['extensions'])) {
    next.extensions = {
      ...next.extensions,
      ...patchFields['extensions'],
    };
  }
  return next;
}

function extractHygieneParticipants(raw: unknown): RawEvent['participants'] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RawEvent['participants'] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) {
      continue;
    }
    const personId = typeof item['person_id'] === 'string' ? item['person_id'].trim() : '';
    if (!personId) {
      continue;
    }
    out.push({
      person_id: personId,
      role: asString(item['role']).trim(),
    });
  }
  return out;
}

function mergeHygieneParticipants(
  existing: readonly RawEvent['participants'][number][],
  incoming: readonly RawEvent['participants'][number][]
): RawEvent['participants'] {
  const incomingPersonIds = new Set(incoming.map((participant) => participant.person_id));
  const out: RawEvent['participants'] = [];
  const seen = new Set<string>();
  const pushUnique = (participant: RawEvent['participants'][number]): void => {
    const key = `${participant.person_id}|${participant.role}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ person_id: participant.person_id, role: participant.role });
    }
  };
  for (const participant of existing) {
    if (!incomingPersonIds.has(participant.person_id)) {
      pushUnique(participant);
    }
  }
  for (const participant of incoming) {
    pushUnique(participant);
  }
  return out;
}

function toHygieneEvent(record: LooseRecord): RawEvent | null {
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  if (!id) {
    return null;
  }
  return {
    id,
    title: asString(record['title']),
    scope: 'personal',
    event_kind: 'point_event',
    ...(typeof record['category'] === 'string' ? { category: record['category'] } : {}),
    edtf_date: asString(record['edtf_date']).trim(),
    place_id: typeof record['place_id'] === 'string' ? record['place_id'] : null,
    summary: asString(record['summary']),
    participants: extractHygieneParticipants(record['participants']),
    sources: [],
  };
}

function toHygieneRemoveKinship(record: LooseRecord): RemoveKinshipEntry | null {
  const from = typeof record['from'] === 'string' ? record['from'].trim() : '';
  const to = typeof record['to'] === 'string' ? record['to'].trim() : '';
  const rawRelation = typeof record['relation'] === 'string' ? record['relation'].trim() : '';
  if (!from || !to || !isKinshipRelation(rawRelation)) {
    return null;
  }
  const familyXref =
    typeof record['family_xref'] === 'string' && record['family_xref'].trim().length > 0
      ? record['family_xref'].trim()
      : undefined;
  const symmetric = typeof record['symmetric'] === 'boolean' ? record['symmetric'] : true;
  return {
    from,
    to,
    relation: rawRelation,
    ...(familyXref !== undefined ? { family_xref: familyXref } : {}),
    symmetric,
  };
}

function toHygieneKinship(record: LooseRecord): KinshipEdge | null {
  const from = typeof record['from'] === 'string' ? record['from'].trim() : '';
  const to = typeof record['to'] === 'string' ? record['to'].trim() : '';
  const rawRelation = typeof record['relation'] === 'string' ? record['relation'].trim() : '';
  if (!from || !to || !isKinshipRelation(rawRelation)) {
    return null;
  }
  return {
    from,
    to,
    relation: rawRelation,
    ...(typeof record['family_xref'] === 'string'
      ? { family_xref: record['family_xref'] }
      : record['family_xref'] === null
        ? { family_xref: null }
        : {}),
  };
}

export function runAuditHygieneRegressionCheck(input: {
  personId: string;
  patch: LooseRecord;
  livePeople: readonly LooseRecord[];
  liveEvents: readonly LooseRecord[];
  liveKinship: readonly LooseRecord[];
  typedLive?: {
    readonly people: readonly RawPerson[];
    readonly events: readonly RawEvent[];
    readonly kinship: readonly KinshipEdge[];
  };
}): TreeHygieneWarning[] {
  let prePeople: readonly RawPerson[];
  let preEvents: readonly RawEvent[];
  let preKinship: readonly KinshipEdge[];

  if (input.typedLive) {
    prePeople = input.typedLive.people;
    preEvents = input.typedLive.events;
    preKinship = input.typedLive.kinship;
  } else {
    const builtPeople: RawPerson[] = [];
    for (const raw of input.livePeople) {
      const person = toHygienePerson(raw);
      if (person) {
        builtPeople.push(person);
      }
    }
    const builtEvents: RawEvent[] = [];
    for (const raw of input.liveEvents) {
      const event = toHygieneEvent(raw);
      if (event) {
        builtEvents.push(event);
      }
    }
    const builtKinship: KinshipEdge[] = [];
    for (const raw of input.liveKinship) {
      const edge = toHygieneKinship(raw);
      if (edge) {
        builtKinship.push(edge);
      }
    }
    prePeople = builtPeople;
    preEvents = builtEvents;
    preKinship = builtKinship;
  }

  const touchedPersonIds = new Set<string>([input.personId]);
  const touchedEventIds = new Set<string>();

  const postPeopleMap = new Map<string, RawPerson>();
  for (let i = 0; i < prePeople.length; i += 1) {
    const person = prePeople[i];
    if (person === undefined) continue;
    postPeopleMap.set(person.id, person);
  }
  for (const rawPerson of Array.isArray(input.patch['people']) ? input.patch['people'] : []) {
    if (!isPlainRecord(rawPerson) || typeof rawPerson['id'] !== 'string' || !rawPerson['id'].trim()) {
      continue;
    }
    const stagedId = rawPerson['id'].trim();
    touchedPersonIds.add(stagedId);
    const existing = postPeopleMap.get(stagedId);
    if (existing) {
      if (!existing.is_living) {
        postPeopleMap.set(stagedId, applyPersonFieldsForHygiene(existing, rawPerson));
      }
    } else {
      const created = toHygienePerson(rawPerson);
      if (created) {
        postPeopleMap.set(stagedId, created);
      }
    }
  }
  const updates = isPlainRecord(input.patch['person_updates']) ? input.patch['person_updates'] : null;
  if (updates) {
    const existingTarget = postPeopleMap.get(input.personId);
    if (existingTarget && !existingTarget.is_living) {
      postPeopleMap.set(input.personId, applyPersonFieldsForHygiene(existingTarget, updates));
    }
  }

  const postEventsMap = new Map<string, RawEvent>();
  for (let i = 0; i < preEvents.length; i += 1) {
    const event = preEvents[i];
    if (event === undefined) continue;
    postEventsMap.set(event.id, event);
  }
  for (const rawEv of Array.isArray(input.patch['events']) ? input.patch['events'] : []) {
    if (!isPlainRecord(rawEv) || typeof rawEv['id'] !== 'string' || !rawEv['id'].trim()) {
      continue;
    }
    const evId = rawEv['id'].trim();
    touchedEventIds.add(evId);
    const incomingParticipants = extractHygieneParticipants(rawEv['participants']);
    for (const participant of incomingParticipants) {
      touchedPersonIds.add(participant.person_id);
    }
    const existing = postEventsMap.get(evId);
    if (existing) {
      const mergedParticipants = mergeHygieneParticipants(existing.participants, incomingParticipants);
      for (const participant of mergedParticipants) {
        touchedPersonIds.add(participant.person_id);
      }
      postEventsMap.set(evId, {
        ...existing,
        ...(typeof rawEv['title'] === 'string' ? { title: rawEv['title'] } : {}),
        ...(rawEv['edtf_date'] !== undefined ? { edtf_date: asString(rawEv['edtf_date']).trim() } : {}),
        ...(typeof rawEv['category'] === 'string' || rawEv['category'] === null
          ? { category: rawEv['category'] }
          : {}),
        participants: mergedParticipants,
      });
    } else {
      const created = toHygieneEvent(rawEv);
      if (created) {
        postEventsMap.set(evId, created);
      }
    }
  }
  for (const rawId of Array.isArray(input.patch['remove_event_ids']) ? input.patch['remove_event_ids'] : []) {
    if (typeof rawId === 'string' && rawId.trim()) {
      const trimmed = rawId.trim();
      touchedEventIds.add(trimmed);
      postEventsMap.delete(trimmed);
    }
  }

  const removeKinshipEntries: RemoveKinshipEntry[] = [];
  for (const rawEntry of Array.isArray(input.patch['remove_kinship']) ? input.patch['remove_kinship'] : []) {
    if (!isPlainRecord(rawEntry)) {
      continue;
    }
    const entry = toHygieneRemoveKinship(rawEntry);
    if (!entry) {
      continue;
    }
    touchedPersonIds.add(entry.from);
    touchedPersonIds.add(entry.to);
    removeKinshipEntries.push(entry);
  }

  const stagedKinshipEdges: KinshipEdge[] = [];
  for (const rawEdge of Array.isArray(input.patch['kinship']) ? input.patch['kinship'] : []) {
    if (!isPlainRecord(rawEdge)) {
      continue;
    }
    const edge = toHygieneKinship(rawEdge);
    if (!edge) {
      continue;
    }
    touchedPersonIds.add(edge.from);
    touchedPersonIds.add(edge.to);
    stagedKinshipEdges.push(edge);
  }

  let postKinship: readonly KinshipEdge[];
  if (removeKinshipEntries.length === 0 && stagedKinshipEdges.length === 0) {
    postKinship = preKinship;
  } else {
    const { remaining: kinshipAfterRemovals } = applyKinshipRemovals(
      preKinship,
      removeKinshipEntries,
      stagedKinshipEdges
    );
    const postKinshipMap = new Map<string, KinshipEdge>();
    for (let i = 0; i < kinshipAfterRemovals.length; i += 1) {
      const edge = kinshipAfterRemovals[i];
      if (edge === undefined) continue;
      postKinshipMap.set(`${edge.from}|${edge.to}|${edge.relation}`, edge);
    }
    for (const edge of stagedKinshipEdges) {
      const key = `${edge.from}|${edge.to}|${edge.relation}`;
      const existing = postKinshipMap.get(key);
      postKinshipMap.set(key, {
        ...(existing ?? edge),
        ...edge,
        family_xref: edge.family_xref !== undefined ? edge.family_xref : existing?.family_xref,
      });
    }
    postKinship = [...postKinshipMap.values()];
  }

  const preHygiene = analyzeTreeHygiene({
    people: prePeople,
    events: preEvents,
    kinship: preKinship,
  });
  const postHygiene = analyzeTreeHygiene({
    people: [...postPeopleMap.values()],
    events: [...postEventsMap.values()],
    kinship: postKinship,
  });

  return diffTreeHygieneWarnings({
    preWarnings: preHygiene.warnings,
    postWarnings: postHygiene.warnings,
    touchedPersonIds,
    touchedEventIds,
  });
}
