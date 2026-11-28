import {
  extractNarrativeCitations,
  type MediaItem,
  MediaItemSchema,
  type Narrative,
  NarrativeSchema,
  type Place,
  PlaceSchema,
  type SourceRecord,
  SourceRecordSchema,
  validateNarrativeCitations,
} from '@kinloom/core';
import { mergedPrimarySourceFlag, mergeRecordExtensions, upsertById } from './entityUpsert.js';
import { dedupeStrings, isPlainObject } from './primitives.js';
import type { UpsertCounts } from './types.js';

export { normalizeAndValidatePatch } from './entityUpsert.js';
export { mergeEventsPatch } from './eventMergers.js';

function assertValidPlaceCoordinates(place: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(place)) {
    throw new Error(`${label} must be an object.`);
  }
  const placeIdLabel = typeof place['id'] === 'string' ? place['id'] : 'unknown';
  const hasLng = place['lng'] !== undefined && place['lng'] !== null;
  const hasLon = place['lon'] !== undefined && place['lon'] !== null;
  if (!hasLng && !hasLon) {
    throw new Error(`${label} (${placeIdLabel}) is missing coordinates (lat/lng).`);
  }
  if (hasLng && hasLon && Number(place['lng']) !== Number(place['lon'])) {
    throw new Error(
      `${label} (${placeIdLabel}) specifies conflicting lng (${String(place['lng'])}) and lon (${String(place['lon'])}).`
    );
  }
  const lat = Number(place['lat']);
  const lng = Number(hasLng ? place['lng'] : place['lon']);
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
  delete copy['lon'];
  return copy;
}

function assertMergedPlaceCoordinates(place: Place, label: string): void {
  const { lat, lng } = place;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`${label} (${place.id}) has non-finite coordinates.`);
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`${label} (${place.id}) coordinates out of range: (${lat}, ${lng}).`);
  }
  if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) {
    throw new Error(`${label} (${place.id}) has forbidden (0, 0) coordinates.`);
  }
}

export function mergePlacesPatch(
  existingPlaces: readonly Place[],
  patchPlaces: readonly unknown[]
): { items: Place[]; counts: UpsertCounts } {
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
        merged['pronunciation'] = structuredClone(prev.pronunciation);
      }
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged['has_primary_source'] = hasPrimary;
      }
      if (incoming.sources === undefined && prev.sources !== undefined) {
        merged['sources'] = structuredClone(prev.sources);
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged['extensions'] = mergedExt;
      }
      return merged;
    }
  );
  for (let i = 0; i < placesMerge.items.length; i += 1) {
    const pl = placesMerge.items[i];
    if (pl === undefined) continue;
    assertMergedPlaceCoordinates(pl, `merged place '${pl.id}'`);
  }
  return { items: placesMerge.items, counts: placesMerge.counts };
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
        merged['has_primary_source'] = hasPrimary;
      }
      if (incoming.author === undefined && prev.author !== undefined) {
        merged['author'] = prev.author;
      }
      if (incoming.publisher === undefined && prev.publisher !== undefined) {
        merged['publisher'] = prev.publisher;
      }
      if (incoming.repository === undefined && prev.repository !== undefined) {
        merged['repository'] = prev.repository;
      }
      if (incoming.url === undefined && prev.url !== undefined) {
        merged['url'] = prev.url;
      }
      if (incoming.gedcom_xref === undefined && prev.gedcom_xref !== undefined) {
        merged['gedcom_xref'] = prev.gedcom_xref;
      }
      return merged;
    }
  );
  const topLevelRemoveSourceIds = new Set(removeSourceIds);
  const removedSourceIds: string[] = [];
  if (topLevelRemoveSourceIds.size === 0) {
    return {
      items: sourcesMerge.items,
      counts: sourcesMerge.counts,
      removedSourceIds,
      topLevelRemoveSourceIds,
    };
  }
  const patchedSourceIds = new Set(sourcesMerge.parsedIncoming.map((s) => s.id));
  for (const removeId of topLevelRemoveSourceIds) {
    if (patchedSourceIds.has(removeId)) {
      throw new Error(`patch.json cannot both add/update and remove source '${removeId}' in the same patch.`);
    }
  }
  const items = sourcesMerge.items.filter((src) => {
    if (topLevelRemoveSourceIds.has(src.id)) {
      removedSourceIds.push(src.id);
      return false;
    }
    return true;
  });
  return { items, counts: sourcesMerge.counts, removedSourceIds, topLevelRemoveSourceIds };
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
        merged['has_primary_source'] = hasPrimary;
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
        merged['extensions'] = mergedExt;
      }
      return merged;
    }
  );
  const topLevelRemoveMediaIds = new Set(removeMediaIds);
  const removedMediaIds: string[] = [];
  if (topLevelRemoveMediaIds.size === 0) {
    return {
      items: mediaMerge.items,
      counts: mediaMerge.counts,
      removedMediaIds,
      topLevelRemoveMediaIds,
    };
  }
  const patchedMediaIds = new Set(mediaMerge.parsedIncoming.map((m) => m.id));
  for (const removeId of topLevelRemoveMediaIds) {
    if (patchedMediaIds.has(removeId)) {
      throw new Error(`patch.json cannot both add/update and remove media '${removeId}' in the same patch.`);
    }
  }
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
  normalizedPatchNarratives: Narrative[];
} {
  let inlineCitationCount = 0;
  const normalizedRawNarratives = patchNarratives.map((rawNar) => {
    if (!isPlainObject(rawNar)) {
      return rawNar;
    }
    const copy: Record<string, unknown> = { ...rawNar };
    if (copy['kind'] === undefined) {
      copy['kind'] = 'biography';
    }
    if (copy['kind'] === 'biography' && copy['subject_person_id'] === undefined) {
      copy['subject_person_id'] = personId;
    }
    if (typeof copy['body_md'] === 'string') {
      const citationErrors = validateNarrativeCitations(
        [{ id: typeof copy['id'] === 'string' ? copy['id'] : 'unknown', body_md: copy['body_md'] }],
        sourceIds,
        mediaIds
      );
      if (citationErrors.length > 0) {
        throw new Error(citationErrors[0]);
      }
      const extracted = extractNarrativeCitations(copy['body_md']);
      if (extracted.references.length > 0) {
        const citedSourceIds = extracted.references.map((ref) => ref.sourceId);
        copy['source_ids'] = dedupeStrings(
          Array.isArray(copy['source_ids'])
            ? copy['source_ids'].filter((id): id is string => typeof id === 'string')
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
    normalizedRawNarratives,
    (n) => NarrativeSchema.parse(n),
    (prev, incoming) => {
      const merged: Record<string, unknown> = { ...incoming };
      const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
      if (hasPrimary !== undefined) {
        merged['has_primary_source'] = hasPrimary;
      }
      if (incoming.updated_at === undefined && prev.updated_at !== undefined) {
        merged['updated_at'] = prev.updated_at;
      }
      if (incoming.summary === undefined && prev.summary !== undefined) {
        merged['summary'] = prev.summary;
      }
      const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
      if (mergedExt !== undefined) {
        merged['extensions'] = mergedExt;
      }
      return merged;
    }
  );

  return {
    items: narrativesMerge.items,
    counts: narrativesMerge.counts,
    inlineCitationCount,
    normalizedPatchNarratives: narrativesMerge.parsedIncoming,
  };
}
