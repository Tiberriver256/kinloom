import { parseRemoveKinshipEntries } from './kinship.js';
import { ALLOWED_PERSON_UPDATE_KEYS } from './people.js';
import { canonicalJsonStringify, isPlainObject, parseOptionalStringList } from './primitives.js';
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

  if (typeof rawPatch['person_id'] !== 'string' || rawPatch['person_id'] !== expectedPersonId) {
    throw new Error(
      `patch.json person_id '${String(rawPatch['person_id'])}' does not match --person '${expectedPersonId}'.`
    );
  }

  const rawUpdates = rawPatch['person_updates'] ?? null;
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
    person_id: rawPatch['person_id'],
    person_updates: rawUpdates,
    people: readArrayField('people'),
    events: readArrayField('events'),
    remove_event_ids: parseOptionalStringList(rawPatch['remove_event_ids'], 'patch.json remove_event_ids'),
    places: readArrayField('places'),
    sources: readArrayField('sources'),
    remove_source_ids: parseOptionalStringList(rawPatch['remove_source_ids'], 'patch.json remove_source_ids'),
    media: readArrayField('media'),
    remove_media_ids: parseOptionalStringList(rawPatch['remove_media_ids'], 'patch.json remove_media_ids'),
    kinship: readArrayField('kinship'),
    remove_kinship: parseRemoveKinshipEntries(rawPatch['remove_kinship'], 'patch.json remove_kinship'),
    narratives: readArrayField('narratives'),
  };
}

export function mergedPrimarySourceFlag(
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

export function mergeRecordExtensions(
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

export function upsertById<T extends { id: string }>(
  existingList: readonly T[],
  incomingList: readonly unknown[],
  parseItem: (raw: unknown) => T,
  mergeExisting?: (prev: T, incoming: T) => unknown
): { items: T[]; counts: UpsertCounts; parsedIncoming: T[] } {
  const result = [...existingList];
  if (incomingList.length === 0) {
    return { items: result, counts: { added: 0, updated: 0, unchanged: 0 }, parsedIncoming: [] };
  }
  const idxById = new Map<string, number>();
  for (let i = 0; i < result.length; i += 1) {
    const item = result[i];
    if (item !== undefined) idxById.set(item.id, i);
  }
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const parsedIncoming = new Array<T>(incomingList.length);

  for (let i = 0; i < incomingList.length; i += 1) {
    const incoming = parseItem(incomingList[i]);
    parsedIncoming[i] = incoming;
    const existingIdx = idxById.get(incoming.id);
    if (existingIdx === undefined) {
      idxById.set(incoming.id, result.length);
      result.push(incoming);
      added += 1;
      continue;
    }
    const prev = result[existingIdx];
    if (prev === undefined) continue;
    const merged = mergeExisting ? parseItem(mergeExisting(prev, incoming)) : incoming;
    if (canonicalJsonStringify(prev) === canonicalJsonStringify(merged)) {
      unchanged += 1;
    } else {
      result[existingIdx] = merged;
      updated += 1;
    }
  }

  return { items: result, counts: { added, updated, unchanged }, parsedIncoming };
}
