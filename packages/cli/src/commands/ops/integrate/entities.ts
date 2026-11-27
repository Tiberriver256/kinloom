import {
  type AlternateDate,
  type EventParticipant,
  extractNarrativeCitations,
  type MediaItem,
  MediaItemSchema,
  mergeEventSources,
  type Narrative,
  NarrativeSchema,
  type Place,
  PlaceSchema,
  type RawEvent,
  RawEventSchema,
  type SourceRecord,
  SourceRecordSchema,
  validateNarrativeCitations,
} from '@kinloom/core';
import { parseRemoveKinshipEntries } from './kinship.js';
import { ALLOWED_PERSON_UPDATE_KEYS } from './people.js';
import {
  canonicalJsonStringify,
  dedupeStrings,
  isPlainObject,
  parseOptionalStringList,
} from './primitives.js';
import type { NormalizedPatch, UpsertCounts } from './types.js';

const ALLOWED_PATCH_KEYS = new Set([
  'person_id',
  'person_updates',
  'people',
  'events',
  'remove_event_ids',
  'places',
  'sources',
  'remove_source_ids',
  'media',
  'remove_media_ids',
  'kinship',
  'remove_kinship',
  'narratives',
]);

export function normalizeAndValidatePatch(rawPatch: unknown, expectedPersonId: string): NormalizedPatch {
  if (!isPlainObject(rawPatch)) {
    throw new Error('patch.json root must be a JSON object.');
  }

  for (const key of Object.keys(rawPatch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      throw new Error(`Unknown top-level key '${key}' in patch.json.`);
    }
  }

  if (typeof rawPatch.person_id !== 'string' || rawPatch.person_id !== expectedPersonId) {
    throw new Error(
      `patch.json person_id '${String(rawPatch.person_id)}' does not match --person '${expectedPersonId}'.`
    );
  }

  const rawUpdates = rawPatch.person_updates ?? null;
  if (rawUpdates !== null && !isPlainObject(rawUpdates)) {
    throw new Error('patch.json person_updates must be an object when provided.');
  }
  if (rawUpdates) {
    for (const key of Object.keys(rawUpdates)) {
      if (!ALLOWED_PERSON_UPDATE_KEYS.has(key)) {
        throw new Error(`Unknown key '${key}' in patch.json person_updates.`);
      }
    }
  }

  const readArrayField = (field: string): unknown[] => {
    const val = rawPatch[field];
    if (val === undefined) {
      return [];
    }
    if (!Array.isArray(val)) {
      throw new Error(`patch.json '${field}' must be an array.`);
    }
    return val;
  };

  return {
    person_id: rawPatch.person_id,
    person_updates: rawUpdates,
    people: readArrayField('people'),
    events: readArrayField('events'),
    remove_event_ids: parseOptionalStringList(rawPatch.remove_event_ids, 'patch.json remove_event_ids'),
    places: readArrayField('places'),
    sources: readArrayField('sources'),
    remove_source_ids: parseOptionalStringList(rawPatch.remove_source_ids, 'patch.json remove_source_ids'),
    media: readArrayField('media'),
    remove_media_ids: parseOptionalStringList(rawPatch.remove_media_ids, 'patch.json remove_media_ids'),
    kinship: readArrayField('kinship'),
    remove_kinship: parseRemoveKinshipEntries(rawPatch.remove_kinship, 'patch.json remove_kinship'),
    narratives: readArrayField('narratives'),
  };
}

function mergedPrimarySourceFlag(
  existing: boolean | undefined,
  incoming: boolean | undefined
): boolean | undefined {
  if (existing === true || incoming === true) {
    return true;
  }
  if (existing === false || incoming === false) {
    return false;
  }
  return undefined;
}

function mergeRecordExtensions(
  prevExt?: Readonly<Record<string, unknown>>,
  incomingExt?: Readonly<Record<string, unknown>>
): Record<string, unknown> | undefined {
  if (!prevExt && !incomingExt) {
    return undefined;
  }
  return {
    ...(prevExt ? structuredClone(prevExt) : {}),
    ...(incomingExt ? structuredClone(incomingExt) : {}),
  };
}

function upsertById<T extends { id: string }>(
  existingList: readonly T[],
  incomingList: readonly unknown[],
  parseItem: (raw: unknown) => T,
  mergeExisting?: (prev: T, incoming: T) => unknown
): { items: T[]; counts: UpsertCounts } {
  const result = existingList.map((item) => structuredClone(item));
  const idxById = new Map<string, number>(result.map((item, idx) => [item.id, idx]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  for (const raw of incomingList) {
    const incoming = parseItem(raw);
    const existingIdx = idxById.get(incoming.id);
    if (existingIdx === undefined) {
      idxById.set(incoming.id, result.length);
      result.push(incoming);
      added += 1;
      continue;
    }
    const prev = result[existingIdx];
    const merged = mergeExisting ? parseItem(mergeExisting(prev, incoming)) : incoming;
    if (canonicalJsonStringify(prev) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged } };
}

function assertValidPlaceCoordinates(place: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(place)) {
    throw new Error(`${label} must be an object.`);
  }
  const placeIdLabel = typeof place.id === 'string' ? place.id : 'unknown';
  const hasLng = place.lng !== undefined && place.lng !== null;
  const hasLon = place.lon !== undefined && place.lon !== null;
  if (!hasLng && !hasLon) {
    throw new Error(`${label} (${placeIdLabel}) is missing coordinates (lat/lng).`);
  }
  if (hasLng && hasLon && Number(place.lng) !== Number(place.lon)) {
    throw new Error(
      `${label} (${placeIdLabel}) specifies conflicting lng (${String(place.lng)}) and lon (${String(place.lon)}).`
    );
  }
  const lat = Number(place.lat);
  const lng = Number(hasLng ? place.lng : place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`${label} (${placeIdLabel}) has non-finite coordinates.`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`${label} (${placeIdLabel}) coordinates out of range: (${lat}, ${lng}).`);
  }
  if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) {
    throw new Error(`${label} (${placeIdLabel}) has forbidden (0, 0) coordinates.`);
  }
  const copy: Record<string, unknown> = { ...place, lat, lng };
  delete copy.lon;
  return copy;
}

export function mergePlacesPatch(
  existingPlaces: readonly Place[],
  patchPlaces: readonly unknown[]
): { items: Place[]; counts: UpsertCounts } {
  // Invariant 2: Every place in patch.places and merged places must have valid non-(0, 0) coordinates.
  const placeIdsWithExplicitPronunciation = new Set<string>();
  const validatedPatchPlaces = patchPlaces.map((pl, idx) => {
    const normalized = assertValidPlaceCoordinates(pl, `patch.places[${idx}]`);
    const parsed = PlaceSchema.parse(normalized);
    if (Object.hasOwn(normalized, 'pronunciation')) {
      placeIdsWithExplicitPronunciation.add(parsed.id);
    }
    return parsed;
  });
  const placesMerge = upsertById(
    existingPlaces,
    validatedPatchPlaces,
    (p) => PlaceSchema.parse(p),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      if (
        !placeIdsWithExplicitPronunciation.has(incoming.id) &&
        incoming.pronunciation === undefined &&
        prev.pronunciation !== undefined
      ) {
        merged.pronunciation = structuredClone(prev.pronunciation);
      }
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.sources === undefined && prev.sources !== undefined) {
        merged.sources = structuredClone(prev.sources);
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );
  for (const pl of placesMerge.items) {
    assertValidPlaceCoordinates(pl, `merged place '${pl.id}'`);
  }
  return placesMerge;
}

export function mergeSourcesPatch(
  existingSources: readonly SourceRecord[],
  patchSources: readonly unknown[],
  removeSourceIds: readonly string[]
): {
  items: SourceRecord[];
  counts: UpsertCounts;
  removedSourceIds: string[];
  topLevelRemoveSourceIds: Set<string>;
} {
  const sourcesMerge = upsertById(
    existingSources,
    patchSources,
    (s) => SourceRecordSchema.parse(s),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.author === undefined && prev.author !== undefined) {
        merged.author = prev.author;
      }
      if (incoming.publisher === undefined && prev.publisher !== undefined) {
        merged.publisher = prev.publisher;
      }
      if (incoming.repository === undefined && prev.repository !== undefined) {
        merged.repository = prev.repository;
      }
      if (incoming.url === undefined && prev.url !== undefined) {
        merged.url = prev.url;
      }
      if (incoming.gedcom_xref === undefined && prev.gedcom_xref !== undefined) {
        merged.gedcom_xref = prev.gedcom_xref;
      }
      return merged;
    }
  );
  const topLevelRemoveSourceIds = new Set(removeSourceIds);
  if (topLevelRemoveSourceIds.size > 0) {
    const patchedSourceIds = new Set(patchSources.map((s) => SourceRecordSchema.parse(s).id));
    for (const removeId of topLevelRemoveSourceIds) {
      if (patchedSourceIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove source '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedSourceIds: string[] = [];
  const items = sourcesMerge.items.filter((src) => {
    if (topLevelRemoveSourceIds.has(src.id)) {
      removedSourceIds.push(src.id);
      return false;
    }
    return true;
  });
  return { items, counts: sourcesMerge.counts, removedSourceIds, topLevelRemoveSourceIds };
}

// Incoming roles replace a person's existing roles on the event. A person keeps
// several roles only when the incoming patch lists each one explicitly.
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
  cleanedPatchEvents: unknown[];
} {
  // Extract optional per-event remove_source_ids before schema parsing.
  const eventRemoveSourceIds = new Map<string, Set<string>>();
  const cleanedPatchEvents = patchEvents.map((rawEv, idx) => {
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
    cleanedPatchEvents,
    (ev) => RawEventSchema.parse(ev),
    (prev, incoming) => mergeSharedEvent(prev, incoming, eventRemoveSourceIds.get(incoming.id))
  );
  const topLevelRemoveEventIds = new Set(removeEventIds);
  if (topLevelRemoveEventIds.size > 0) {
    const patchedEventIds = new Set(cleanedPatchEvents.map((ev) => RawEventSchema.parse(ev).id));
    for (const removeId of topLevelRemoveEventIds) {
      if (patchedEventIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove event '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedEventIds: string[] = [];
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
    cleanedPatchEvents,
  };
}

export function mergeMediaPatch(
  existingMedia: readonly MediaItem[],
  patchMedia: readonly unknown[],
  removeMediaIds: readonly string[]
): {
  items: MediaItem[];
  counts: UpsertCounts;
  removedMediaIds: string[];
  topLevelRemoveMediaIds: Set<string>;
} {
  const mediaMerge = upsertById(
    existingMedia,
    patchMedia,
    (m) => MediaItemSchema.parse(m),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      const optionalKeys = [
        'thumb_file',
        'provenance',
        'date_edtf',
        'page',
        'mime_type',
        'duration_seconds',
        'poster_url',
        'transcript_url',
      ] as const;
      for (const key of optionalKeys) {
        if (incoming[key] === undefined && prev[key] !== undefined) {
          merged[key] = prev[key];
        }
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );
  const topLevelRemoveMediaIds = new Set(removeMediaIds);
  if (topLevelRemoveMediaIds.size > 0) {
    const patchedMediaIds = new Set(patchMedia.map((m) => MediaItemSchema.parse(m).id));
    for (const removeId of topLevelRemoveMediaIds) {
      if (patchedMediaIds.has(removeId)) {
        throw new Error(
          `patch.json cannot both add/update and remove media '${removeId}' in the same patch.`
        );
      }
    }
  }
  const removedMediaIds: string[] = [];
  const items = mediaMerge.items.filter((item) => {
    if (topLevelRemoveMediaIds.has(item.id)) {
      removedMediaIds.push(item.id);
      return false;
    }
    return true;
  });
  return { items, counts: mediaMerge.counts, removedMediaIds, topLevelRemoveMediaIds };
}

export function mergeNarrativesPatch(
  existingNarratives: readonly Narrative[],
  patchNarratives: readonly unknown[],
  personId: string,
  sourceIds: ReadonlySet<string>,
  mediaIds: ReadonlySet<string>
): {
  items: Narrative[];
  counts: UpsertCounts;
  inlineCitationCount: number;
  normalizedPatchNarratives: unknown[];
} {
  let inlineCitationCount = 0;
  const normalizedPatchNarratives = patchNarratives.map((rawNar) => {
    if (!isPlainObject(rawNar)) {
      return rawNar;
    }
    const copy: Record<string, unknown> = { ...rawNar };
    if (copy.kind === undefined) {
      copy.kind = 'biography';
    }
    if (copy.kind === 'biography' && copy.subject_person_id === undefined) {
      copy.subject_person_id = personId;
    }
    if (typeof copy.body_md === 'string') {
      const citationErrors = validateNarrativeCitations(
        [{ id: typeof copy.id === 'string' ? copy.id : 'unknown', body_md: copy.body_md }],
        sourceIds,
        mediaIds
      );
      if (citationErrors.length > 0) {
        throw new Error(citationErrors[0]);
      }
      const extracted = extractNarrativeCitations(copy.body_md);
      if (extracted.references.length > 0) {
        const citedSourceIds = extracted.references.map((ref) => ref.sourceId);
        copy.source_ids = dedupeStrings(
          Array.isArray(copy.source_ids)
            ? copy.source_ids.filter((id): id is string => typeof id === 'string')
            : [],
          citedSourceIds
        );
      }
      inlineCitationCount += extracted.occurrences.length;
    }
    return copy;
  });

  const narrativesMerge = upsertById(
    existingNarratives,
    normalizedPatchNarratives,
    (n) => NarrativeSchema.parse(n),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged.has_primary_source = hasPrimary;
      }
      if (incoming.updated_at === undefined && prev.updated_at !== undefined) {
        merged.updated_at = prev.updated_at;
      }
      if (incoming.summary === undefined && prev.summary !== undefined) {
        merged.summary = prev.summary;
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged.extensions = mergedExt;
      }
      return merged;
    }
  );

  return {
    items: narrativesMerge.items,
    counts: narrativesMerge.counts,
    inlineCitationCount,
    normalizedPatchNarratives,
  };
}
