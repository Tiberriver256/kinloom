import {
  type AlternateDate,
  type EventParticipant,
  mergeEventSources,
  type RawEvent,
  RawEventSchema,
} from '@kinloom/core';
import { mergedPrimarySourceFlag, upsertById } from './entityUpsert.js';
import { isPlainObject, parseOptionalStringList } from './primitives.js';
import type { UpsertCounts } from './types.js';

function dedupeParticipants(
  existing: readonly EventParticipant[] | undefined,
  additions: readonly EventParticipant[] | undefined
): EventParticipant[] {
  const incomingIds = new Set((additions ?? []).map((pt) => pt.person_id));
  const retained = (existing ?? []).filter((pt) => !incomingIds.has(pt.person_id));
  const out: EventParticipant[] = [];
  const seen = new Set<string>();
  for (const pt of [...retained, ...(additions ?? [])]) {
    const key = `${pt.person_id}|${pt.role}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ person_id: pt.person_id, role: pt.role });
  }
  return out;
}

function alternateDateKey(entry: AlternateDate): string {
  return `${entry.edtf_date}\u0000${entry.source_id}\u0000${entry.note}`;
}

function mergeAlternateDates(
  existing: readonly AlternateDate[] | undefined,
  incoming: readonly AlternateDate[] | undefined
): AlternateDate[] | undefined {
  if (incoming === undefined) {
    return existing?.map((entry) => ({ ...entry }));
  }
  const merged: AlternateDate[] = [];
  const seen = new Set<string>();
  for (const entry of [...(existing ?? []), ...incoming]) {
    const key = alternateDateKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      edtf_date: entry.edtf_date,
      source_id: entry.source_id,
      note: entry.note,
    });
  }
  return merged;
}

function mergeSharedEvent(
  prev: RawEvent,
  incoming: RawEvent,
  removeSourceIds: Set<string> | undefined
): RawEvent {
  const retainedPrevSources = removeSourceIds
    ? prev.sources.filter((ref) => !removeSourceIds.has(ref.source_id))
    : prev.sources;
  const merged: RawEvent = {
    ...prev,
    ...incoming,
    participants: dedupeParticipants(prev.participants, incoming.participants),
    sources: mergeEventSources(retainedPrevSources, incoming.sources),
  };

  const hasPrimarySource = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
  if (hasPrimarySource === undefined) {
    delete merged.has_primary_source;
  } else {
    merged.has_primary_source = hasPrimarySource;
  }

  const alternateDates = mergeAlternateDates(prev.alternate_dates, incoming.alternate_dates);
  if (alternateDates === undefined) {
    delete merged.alternate_dates;
  } else {
    merged.alternate_dates = alternateDates;
  }

  if (!Object.hasOwn(incoming, 'place_precision')) {
    if (prev.place_precision === undefined) {
      delete merged.place_precision;
    } else {
      merged.place_precision = prev.place_precision;
    }
  }

  return merged;
}

export function mergeEventsPatch(
  existingEvents: readonly RawEvent[],
  patchEvents: readonly unknown[],
  removeEventIds: readonly string[]
): {
  items: RawEvent[];
  counts: UpsertCounts;
  removedEventIds: string[];
  topLevelRemoveEventIds: Set<string>;
  cleanedPatchEvents: RawEvent[];
} {
  const eventRemoveSourceIds = new Map<string, Set<string>>();
  const cleanedRawEvents = patchEvents.map((rawEv, idx) => {
    if (!isPlainObject(rawEv)) {
      return rawEv;
    }
    const removeIds = parseOptionalStringList(
      rawEv.remove_source_ids,
      `patch.events[${idx}].remove_source_ids`
    );
    const copy: Record<string, unknown> = { ...rawEv };
    delete copy.remove_source_ids;
    const parsedEv = RawEventSchema.parse(copy);
    if (removeIds.length > 0) {
      const removeSet = new Set(removeIds);
      for (const ref of parsedEv.sources) {
        if (removeSet.has(ref.source_id)) {
          throw new Error(`Event '${parsedEv.id}' cannot both attach and remove source '${ref.source_id}'.`);
        }
      }
      const existingSet = eventRemoveSourceIds.get(parsedEv.id);
      if (existingSet) {
        for (const id of removeSet) {
          existingSet.add(id);
        }
      } else {
        eventRemoveSourceIds.set(parsedEv.id, removeSet);
      }
    }
    return parsedEv;
  });

  const eventsMerge = upsertById(
    existingEvents,
    cleanedRawEvents,
    (ev) => RawEventSchema.parse(ev),
    (prev, incoming) => mergeSharedEvent(prev, incoming, eventRemoveSourceIds.get(incoming.id))
  );
  const topLevelRemoveEventIds = new Set(removeEventIds);
  const removedEventIds: string[] = [];
  if (topLevelRemoveEventIds.size === 0) {
    return {
      items: eventsMerge.items,
      counts: eventsMerge.counts,
      removedEventIds,
      topLevelRemoveEventIds,
      cleanedPatchEvents: eventsMerge.parsedIncoming,
    };
  }
  const patchedEventIds = new Set(eventsMerge.parsedIncoming.map((ev) => ev.id));
  for (const removeId of topLevelRemoveEventIds) {
    if (patchedEventIds.has(removeId)) {
      throw new Error(`patch.json cannot both add/update and remove event '${removeId}' in the same patch.`);
    }
  }
  const items = eventsMerge.items.filter((ev) => {
    if (topLevelRemoveEventIds.has(ev.id)) {
      removedEventIds.push(ev.id);
      return false;
    }
    return true;
  });
  return {
    items,
    counts: eventsMerge.counts,
    removedEventIds,
    topLevelRemoveEventIds,
    cleanedPatchEvents: eventsMerge.parsedIncoming,
  };
}
