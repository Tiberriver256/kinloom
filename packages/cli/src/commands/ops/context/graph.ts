import { edtfYear } from '@kinloom/core';
import { isConfirmedDeceasedRelative, scrubDeep, scrubText } from './privacy.js';
import {
  type ContextKinshipEdge,
  type ContextRelativeArchiveMedia,
  type ContextRelativeListItem,
  type ContextRelativeRelation,
  type LivingPrivacyState,
  type LooseYamlRecord,
  REDACTED_RELATIVE_LABEL,
  type RelativeIdGroups,
} from './types.js';
import {
  asNonEmptyString,
  formatLifespan,
  isPlainRecord,
  parseBlocksById,
  parseMatchingYamlBlocks,
} from './yamlScanner.js';

const RELATIVE_RELATION_RANK: Record<ContextRelativeRelation, number> = {
  parent: 0,
  spouse: 1,
  child: 2,
  sibling: 3,
};

function collectSiblingIds(
  parentIds: ReadonlySet<string>,
  excludedIds: ReadonlySet<string>,
  kinshipBlocks: readonly string[]
): Set<string> {
  const siblingIds = new Set<string>();
  if (parentIds.size === 0) {
    return siblingIds;
  }
  const blocks = kinshipBlocks.filter((block) => {
    for (const parentId of parentIds) {
      if (block.includes(parentId)) {
        return true;
      }
    }
    return false;
  });
  for (const edge of parseMatchingYamlBlocks(blocks)) {
    const from = typeof edge['from'] === 'string' ? edge['from'] : '';
    const to = typeof edge['to'] === 'string' ? edge['to'] : '';
    let siblingId = '';
    if (edge['relation'] === 'parent' && parentIds.has(from)) {
      siblingId = to;
    } else if (edge['relation'] === 'child' && parentIds.has(to)) {
      siblingId = from;
    }
    if (siblingId && !excludedIds.has(siblingId)) {
      siblingIds.add(siblingId);
    }
  }
  return siblingIds;
}

export function resolveImmediateKinship(
  kinshipBlocks: readonly string[],
  personId: string,
  includeFamily: boolean
): {
  relevantKinship: LooseYamlRecord[];
  relativeIds: RelativeIdGroups;
  allRelativeIds: Set<string>;
} {
  const relevantKinship = parseMatchingYamlBlocks(kinshipBlocks.filter((b) => b.includes(personId)));

  const parentIds = new Set<string>();
  const spouseIds = new Set<string>();
  const childIds = new Set<string>();
  for (const edge of relevantKinship) {
    const from = typeof edge['from'] === 'string' ? edge['from'] : '';
    const to = typeof edge['to'] === 'string' ? edge['to'] : '';
    if (edge['relation'] === 'parent') {
      if (to === personId && from) {
        parentIds.add(from);
      } else if (from === personId && to) {
        childIds.add(to);
      }
    } else if (edge['relation'] === 'child') {
      if (from === personId && to) {
        parentIds.add(to);
      } else if (to === personId && from) {
        childIds.add(from);
      }
    } else if (edge['relation'] === 'spouse') {
      if (from === personId && to) {
        spouseIds.add(to);
      } else if (to === personId && from) {
        spouseIds.add(from);
      }
    }
  }

  const siblingIds = includeFamily
    ? collectSiblingIds(
        parentIds,
        new Set([personId, ...parentIds, ...spouseIds, ...childIds]),
        kinshipBlocks
      )
    : new Set<string>();

  const allRelativeIds = new Set<string>([...parentIds, ...spouseIds, ...childIds, ...siblingIds]);
  return {
    relevantKinship,
    relativeIds: { parentIds, spouseIds, childIds, siblingIds },
    allRelativeIds,
  };
}

export function scanTargetAndUnknownYearEvents(
  eventBlocks: readonly string[],
  personId: string,
  parsedPeople: readonly LooseYamlRecord[]
): {
  rawPersonEvents: LooseYamlRecord[];
  unknownYearEventsByPerson: Map<string, Array<{ edtf_date: string }>>;
} {
  const needEventYearIds = new Set<string>();
  for (const person of parsedPeople) {
    if (typeof person['id'] !== 'string') {
      continue;
    }
    const hasDeath = asNonEmptyString(person['death_edtf']).length > 0;
    const hasBirth = asNonEmptyString(person['birth_edtf']).length > 0;
    if (!person['is_living'] && !person['living'] && !hasDeath && !hasBirth) {
      needEventYearIds.add(person['id']);
    }
  }

  const targetEventBlocks: string[] = [];
  const unknownYearEventsByPerson = new Map<string, Array<{ edtf_date: string }>>();
  for (const block of eventBlocks) {
    if (block.includes(personId)) {
      targetEventBlocks.push(block);
    }
    if (needEventYearIds.size > 0) {
      for (const uid of needEventYearIds) {
        if (block.includes(uid)) {
          const dateMatch = /^\s+edtf_date:\s*(.*)$/m.exec(block);
          const dateVal = dateMatch ? dateMatch[1].trim().replaceAll(/^["']|["']$/g, '') : '';
          const list = unknownYearEventsByPerson.get(uid);
          if (list) {
            list.push({ edtf_date: dateVal });
          } else {
            unknownYearEventsByPerson.set(uid, [{ edtf_date: dateVal }]);
          }
        }
      }
    }
  }

  const rawPersonEvents = parseMatchingYamlBlocks(targetEventBlocks).filter(
    (ev) =>
      Array.isArray(ev['participants']) &&
      ev['participants'].some((pt) => isPlainRecord(pt) && pt['person_id'] === personId)
  );

  return { rawPersonEvents, unknownYearEventsByPerson };
}

export function buildRelativesSummary(
  relativeIds: RelativeIdGroups,
  peopleById: ReadonlyMap<string, LooseYamlRecord>,
  privacyState: LivingPrivacyState
): {
  parents: ContextRelativeListItem[];
  spouses: ContextRelativeListItem[];
  children: ContextRelativeListItem[];
} {
  const formatRelativeList = (idSet: ReadonlySet<string>): ContextRelativeListItem[] =>
    [...idSet].toSorted().map((id) => {
      if (privacyState.livingIds.has(id)) {
        return REDACTED_RELATIVE_LABEL;
      }
      const rel = peopleById.get(id);
      if (!rel) {
        return {
          id,
          full_name: '(missing in people.yaml)',
          lifespan: '? - ?',
          gedcom_xref: null,
        };
      }
      return {
        id: String(rel['id']),
        full_name: scrubText(asNonEmptyString(rel['full_name']), privacyState.livingNamePattern),
        lifespan: formatLifespan(rel),
        gedcom_xref: typeof rel['gedcom_xref'] === 'string' ? rel['gedcom_xref'] : null,
      };
    });

  return {
    parents: formatRelativeList(relativeIds.parentIds),
    spouses: formatRelativeList(relativeIds.spouseIds),
    children: formatRelativeList(relativeIds.childIds),
  };
}

export function buildSanitizedKinshipEdges(
  relevantKinship: readonly LooseYamlRecord[],
  personId: string,
  livingIds: ReadonlySet<string>
): ContextKinshipEdge[] {
  return relevantKinship
    .filter((edge) => edge['from'] === personId || edge['to'] === personId)
    .map((edge) => {
      const fromId = typeof edge['from'] === 'string' ? edge['from'] : '';
      const toId = typeof edge['to'] === 'string' ? edge['to'] : '';
      return {
        from: livingIds.has(fromId) ? REDACTED_RELATIVE_LABEL : fromId,
        to: livingIds.has(toId) ? REDACTED_RELATIVE_LABEL : toId,
        relation: typeof edge['relation'] === 'string' ? edge['relation'] : '',
        ...(typeof edge['family_xref'] === 'string' ? { family_xref: edge['family_xref'] } : {}),
      };
    });
}

function linkedMediaPersonIds(item: LooseYamlRecord): string[] {
  const ids: string[] = [];
  if (typeof item['person_id'] === 'string' && item['person_id']) {
    ids.push(item['person_id']);
  }
  if (Array.isArray(item['person_ids'])) {
    for (const pid of item['person_ids']) {
      if (typeof pid === 'string' && pid) {
        ids.push(pid);
      }
    }
  }
  return ids;
}

function eventHasLivingParticipant(event: LooseYamlRecord, livingIds: ReadonlySet<string>): boolean {
  const participants = Array.isArray(event['participants']) ? event['participants'] : [];
  return participants.some(
    (pt) => isPlainRecord(pt) && typeof pt['person_id'] === 'string' && livingIds.has(pt['person_id'])
  );
}

export function collectPersonEventsAndReferences(
  rawPersonEvents: readonly LooseYamlRecord[],
  targetPerson: LooseYamlRecord,
  privacyState: LivingPrivacyState
): {
  events: Record<string, unknown>[];
  personEventIds: Set<string>;
  referencedPlaceIds: Set<string>;
  referencedSourceIds: Set<string>;
} {
  const personEventIds = new Set<string>();
  const referencedPlaceIds = new Set<string>();
  const referencedSourceIds = new Set<string>();

  const events = rawPersonEvents.map((ev) => {
    if (typeof ev['id'] === 'string') {
      personEventIds.add(ev['id']);
    }
    const participants = Array.isArray(ev['participants']) ? ev['participants'] : [];
    const hasLivingParticipant = eventHasLivingParticipant(ev, privacyState.livingIds);
    let clone = structuredClone(ev);

    if (hasLivingParticipant) {
      clone['participants'] = participants.map((pt) => {
        if (
          isPlainRecord(pt) &&
          typeof pt['person_id'] === 'string' &&
          privacyState.livingIds.has(pt['person_id'])
        ) {
          return { person_id: REDACTED_RELATIVE_LABEL, role: pt['role'] };
        }
        return pt;
      });
      const yr = edtfYear(
        typeof clone['edtf_date'] === 'string' || typeof clone['edtf_date'] === 'number' ? clone['edtf_date'] : null
      );
      clone['edtf_date'] = yr !== null ? String(yr) : '';
      clone['place_id'] = null;
      clone['summary'] = 'Event involves a living relative (location and exact date omitted).';
      delete clone['photo_url'];
    } else if (typeof clone['place_id'] === 'string' && clone['place_id']) {
      referencedPlaceIds.add(clone['place_id']);
    }

    clone = scrubDeep(clone, privacyState.livingNamePattern);

    for (const sRef of Array.isArray(clone['sources']) ? clone['sources'] : []) {
      if (isPlainRecord(sRef) && typeof sRef['source_id'] === 'string' && sRef['source_id']) {
        referencedSourceIds.add(sRef['source_id']);
      }
    }
    return clone;
  });

  const targetExtensions = isPlainRecord(targetPerson['extensions']) ? targetPerson['extensions'] : null;
  for (const extSrc of Array.isArray(targetExtensions?.['sources']) ? targetExtensions['sources'] : []) {
    if (typeof extSrc === 'string' && extSrc.trim()) {
      referencedSourceIds.add(extSrc.trim());
    } else if (isPlainRecord(extSrc) && typeof extSrc['source_id'] === 'string') {
      referencedSourceIds.add(extSrc['source_id']);
    }
  }

  return { events, personEventIds, referencedPlaceIds, referencedSourceIds };
}

export function collectPersonMedia(params: {
  mediaBlocks: readonly string[];
  personId: string;
  personEventIds: ReadonlySet<string>;
  referencedSourceIds: Set<string>;
  privacyState: LivingPrivacyState;
}): Record<string, unknown>[] {
  const candidateBlocks = params.mediaBlocks.filter((block) => {
    if (block.includes(params.personId)) {
      return true;
    }
    for (const eid of params.personEventIds) {
      if (block.includes(eid)) {
        return true;
      }
    }
    return false;
  });

  return parseMatchingYamlBlocks(candidateBlocks)
    .filter((item) => {
      const linkedPeople = new Set(linkedMediaPersonIds(item));
      for (const pid of linkedPeople) {
        if (params.privacyState.livingIds.has(pid)) {
          return false;
        }
      }
      return (
        linkedPeople.has(params.personId) ||
        (typeof item['event_id'] === 'string' && params.personEventIds.has(item['event_id']))
      );
    })
    .map((item) => {
      if (typeof item['source_id'] === 'string' && item['source_id']) {
        params.referencedSourceIds.add(item['source_id']);
      }
      return scrubDeep(structuredClone(item), params.privacyState.livingNamePattern);
    });
}

export function collectPersonNarratives(params: {
  narrativeBlocks: readonly string[];
  personId: string;
  referencedPlaceIds: Set<string>;
  referencedSourceIds: Set<string>;
  privacyState: LivingPrivacyState;
}): Record<string, unknown>[] {
  return parseMatchingYamlBlocks(params.narrativeBlocks.filter((b) => b.includes(params.personId)))
    .filter(
      (nar) =>
        nar['subject_person_id'] === params.personId ||
        (Array.isArray(nar['person_ids']) && nar['person_ids'].includes(params.personId))
    )
    .map((nar) => {
      for (const sid of Array.isArray(nar['source_ids']) ? nar['source_ids'] : []) {
        if (typeof sid === 'string' && sid) {
          params.referencedSourceIds.add(sid);
        }
      }
      for (const plid of Array.isArray(nar['place_ids']) ? nar['place_ids'] : []) {
        if (typeof plid === 'string' && plid) {
          params.referencedPlaceIds.add(plid);
        }
      }
      const clone = structuredClone(nar);
      if (Array.isArray(clone['person_ids'])) {
        clone['person_ids'] = clone['person_ids'].map((pid) =>
          typeof pid === 'string' && params.privacyState.livingIds.has(pid) ? REDACTED_RELATIVE_LABEL : pid
        );
      }
      return scrubDeep(clone, params.privacyState.livingNamePattern);
    });
}

export function collectReferencedPlacesAndSources(params: {
  placeBlocks: readonly string[];
  sourceBlocks: readonly string[];
  referencedPlaceIds: ReadonlySet<string>;
  referencedSourceIds: ReadonlySet<string>;
  livingNamePattern: RegExp | null;
}): {
  places: Record<string, unknown>[];
  sources: Record<string, unknown>[];
} {
  const places = parseBlocksById(params.placeBlocks, params.referencedPlaceIds).toSorted((a, b) =>
    String(a['id'] ?? '').localeCompare(String(b['id'] ?? ''))
  );

  const sources = parseBlocksById(params.sourceBlocks, params.referencedSourceIds)
    .map((s) => scrubDeep(structuredClone(s), params.livingNamePattern))
    .toSorted((a, b) => String(a['id'] ?? '').localeCompare(String(b['id'] ?? '')));

  return { places, sources };
}

export function collectRelativeArchiveMedia(params: {
  includeFamily: boolean;
  relativeIds: RelativeIdGroups;
  peopleById: ReadonlyMap<string, LooseYamlRecord>;
  privacyState: LivingPrivacyState;
  mediaBlocks: readonly string[];
  eventBlocks: readonly string[];
  ownMediaIds: ReadonlySet<string>;
}): ContextRelativeArchiveMedia[] {
  if (!params.includeFamily) {
    return [];
  }

  const { livingIds, livingNamePattern, privacy } = params.privacyState;
  const deceasedById = new Map<string, ContextRelativeRelation>();
  const groups: ReadonlyArray<readonly [ContextRelativeRelation, ReadonlySet<string>]> = [
    ['parent', params.relativeIds.parentIds],
    ['spouse', params.relativeIds.spouseIds],
    ['child', params.relativeIds.childIds],
    ['sibling', params.relativeIds.siblingIds],
  ];
  for (const [relation, ids] of groups) {
    for (const id of [...ids].toSorted()) {
      if (deceasedById.has(id)) {
        continue;
      }
      if (!isConfirmedDeceasedRelative(params.peopleById.get(id), livingIds, privacy)) {
        continue;
      }
      deceasedById.set(id, relation);
    }
  }
  if (deceasedById.size === 0) {
    return [];
  }

  const candidateBlocks = params.mediaBlocks.filter((block) => {
    for (const id of deceasedById.keys()) {
      if (block.includes(id)) {
        return true;
      }
    }
    return false;
  });
  const parsed = parseMatchingYamlBlocks(candidateBlocks);
  const wantedEventIds = new Set<string>();
  for (const item of parsed) {
    if (typeof item['event_id'] === 'string' && item['event_id']) {
      wantedEventIds.add(item['event_id']);
    }
  }
  const eventsById = new Map<string, LooseYamlRecord>();
  for (const event of parseBlocksById(params.eventBlocks, wantedEventIds)) {
    if (typeof event['id'] === 'string') {
      eventsById.set(event['id'], event);
    }
  }

  const rows: ContextRelativeArchiveMedia[] = [];
  const seenMediaIds = new Set<string>();
  for (const item of parsed) {
    if (typeof item['id'] !== 'string' || !item['id'] || seenMediaIds.has(item['id'])) {
      continue;
    }
    if (params.ownMediaIds.has(item['id'])) {
      continue;
    }
    const linked = linkedMediaPersonIds(item);
    if (linked.some((id) => livingIds.has(id))) {
      continue;
    }
    const eventId = typeof item['event_id'] === 'string' ? item['event_id'] : '';
    const event = eventId ? eventsById.get(eventId) : undefined;
    if (event && eventHasLivingParticipant(event, livingIds)) {
      continue;
    }

    let best: { relativeId: string; relation: ContextRelativeRelation } | null = null;
    for (const id of linked) {
      const relation = deceasedById.get(id);
      if (!relation) {
        continue;
      }
      if (
        !best ||
        RELATIVE_RELATION_RANK[relation] < RELATIVE_RELATION_RANK[best.relation] ||
        (relation === best.relation && id.localeCompare(best.relativeId) < 0)
      ) {
        best = { relativeId: id, relation };
      }
    }
    if (!best) {
      continue;
    }
    if (typeof item['file'] !== 'string' || !item['file']) {
      continue;
    }
    seenMediaIds.add(item['id']);
    rows.push({
      id: item['id'],
      file: scrubText(item['file'], livingNamePattern),
      caption: scrubText(typeof item['caption'] === 'string' ? item['caption'] : '', livingNamePattern),
      relation: best.relation,
      relativeId: best.relativeId,
    });
  }

  return rows.toSorted((a, b) => a.id.localeCompare(b.id));
}
