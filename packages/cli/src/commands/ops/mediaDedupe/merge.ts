import { getMediaPersonIds, type MediaItem, MediaItemSchema } from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import { normalizeMediaFilePath } from '../shared/mediaFiles.js';
import { type MediaDedupeGroupPlan, uniqueNonEmptyStrings } from './types.js';

const FILLABLE_SCALAR_KEYS = [
  'date_edtf',
  'page',
  'thumb_file',
  'mime_type',
  'duration_seconds',
  'poster_url',
  'transcript_url',
] as const;

type FillableScalarKey = (typeof FILLABLE_SCALAR_KEYS)[number];

function computeMetadataCompletenessScore(item: MediaItem): number {
  let score = 0;
  if (item.source_id && item.source_id.trim().length > 0) {
    score += 1;
  }
  if (item.event_id && item.event_id.trim().length > 0) {
    score += 1;
  }
  if (item.provenance && item.provenance.trim().length > 0) {
    score += 1;
  }
  if (item.date_edtf && item.date_edtf.trim().length > 0) {
    score += 1;
  }
  score += getMediaPersonIds(item).length;
  return score;
}

function compareMediaCandidates(
  a: MediaItem,
  b: MediaItem,
  refCounts: ReadonlyMap<string, number>,
  preferSet: ReadonlySet<string>
): number {
  const prefA = preferSet.has(a.id) ? 1 : 0;
  const prefB = preferSet.has(b.id) ? 1 : 0;
  if (prefA !== prefB) {
    return prefB - prefA;
  }
  const refA = refCounts.get(a.id) ?? 0;
  const refB = refCounts.get(b.id) ?? 0;
  if (refA !== refB) {
    return refB - refA;
  }
  const scoreA = computeMetadataCompletenessScore(a);
  const scoreB = computeMetadataCompletenessScore(b);
  if (scoreA !== scoreB) {
    return scoreB - scoreA;
  }
  const capA = a.caption.trim().length;
  const capB = b.caption.trim().length;
  if (capA !== capB) {
    return capB - capA;
  }
  return a.id.localeCompare(b.id);
}

function fillOptionalScalar<K extends FillableScalarKey>(
  canonical: MediaItem,
  retired: readonly MediaItem[],
  key: K
): void {
  const currentVal = canonical[key];
  const isEmpty =
    currentVal === undefined ||
    currentVal === null ||
    (typeof currentVal === 'string' && currentVal.trim().length === 0);
  if (!isEmpty) {
    return;
  }
  for (const item of retired) {
    const candidateVal = item[key];
    const hasVal =
      candidateVal !== undefined &&
      candidateVal !== null &&
      (typeof candidateVal !== 'string' || candidateVal.trim().length > 0);
    if (hasVal) {
      canonical[key] = candidateVal;
      break;
    }
  }
}

export function groupDuplicateMediaByFile(media: readonly MediaItem[]): Array<[string, MediaItem[]]> {
  const groupedByFile = new Map<string, MediaItem[]>();
  for (const item of media) {
    const normalized = normalizeMediaFilePath(item.file);
    if (!normalized) {
      continue;
    }
    const bucket = groupedByFile.get(normalized) ?? [];
    bucket.push(item);
    groupedByFile.set(normalized, bucket);
  }

  return [...groupedByFile.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .toSorted(([a], [b]) => a.localeCompare(b));
}

export function mergeDuplicateMediaGroup(
  items: readonly MediaItem[],
  refCounts: ReadonlyMap<string, number>,
  preferSet: ReadonlySet<string>,
  normalizedFile: string
): MediaDedupeGroupPlan {
  const preferredInGroup = items.filter((item) => preferSet.has(item.id));
  if (preferredInGroup.length > 1) {
    throw new CliValidationError(
      `Conflicting \`--prefer\` flags for duplicate media file '${normalizedFile}': ${preferredInGroup.map((i) => i.id).join(', ')}. Specify at most one preferred media_id per duplicate file group.`
    );
  }

  const ordered = [...items].toSorted((a, b) => compareMediaCandidates(a, b, refCounts, preferSet));
  const canonical = structuredClone(ordered[0]);
  const retired = ordered.slice(1);
  const retiredIds = retired.map((item) => item.id).toSorted((a, b) => a.localeCompare(b));
  const warnings: string[] = [];

  // 1. Merge person_id / person_ids losslessly.
  const mergedPersonIds = uniqueNonEmptyStrings(ordered.flatMap((item) => getMediaPersonIds(item)));
  if (mergedPersonIds.length > 0) {
    if (!canonical.person_id) {
      const firstPrimary = ordered.find((item) => Boolean(item.person_id))?.person_id;
      if (firstPrimary) {
        canonical.person_id = firstPrimary;
      }
    }
    if (mergedPersonIds.length > 1 || canonical.person_ids !== undefined) {
      canonical.person_ids = mergedPersonIds;
    }
  }

  // 2. Merge extensions base (retired first in reverse priority so canonical always wins).
  const mergedExtensions: Record<string, unknown> = {};
  for (const item of [...ordered].reverse()) {
    if (item.extensions) {
      for (const [k, v] of Object.entries(item.extensions)) {
        mergedExtensions[k] = structuredClone(v);
      }
    }
  }

  // 3. Caption: keep canonical (or longest non-empty), preserve distinct non-substring alternates.
  let chosenCaption = canonical.caption.trim();
  if (!chosenCaption) {
    const longest = ordered
      .map((item) => item.caption.trim())
      .filter((c) => c.length > 0)
      .toSorted((a, b) => b.length - a.length)[0];
    if (longest) {
      chosenCaption = longest;
      canonical.caption = longest;
    }
  }
  const existingAltCaptions = Array.isArray(mergedExtensions.alternate_captions)
    ? mergedExtensions.alternate_captions.filter((c): c is string => typeof c === 'string')
    : [];
  const altCaptions = uniqueNonEmptyStrings([
    ...existingAltCaptions,
    ...retired
      .map((item) => item.caption.trim())
      .filter((cap) => cap.length > 0 && !chosenCaption.toLowerCase().includes(cap.toLowerCase())),
  ]);
  if (altCaptions.length > 0) {
    mergedExtensions.alternate_captions = altCaptions;
  }

  // 4. Provenance: fill if empty; preserve distinct alternate provenance notes.
  let chosenProvenance = canonical.provenance?.trim() ?? '';
  if (!chosenProvenance) {
    const firstProv = retired.map((item) => item.provenance?.trim() ?? '').find((p) => p.length > 0);
    if (firstProv) {
      chosenProvenance = firstProv;
      canonical.provenance = firstProv;
    }
  }
  const existingAltProv = Array.isArray(mergedExtensions.alternate_provenance)
    ? mergedExtensions.alternate_provenance.filter((p): p is string => typeof p === 'string')
    : [];
  const altProvenance = uniqueNonEmptyStrings([
    ...existingAltProv,
    ...retired
      .map((item) => item.provenance?.trim() ?? '')
      .filter((prov) => prov.length > 0 && prov.toLowerCase() !== chosenProvenance.toLowerCase()),
  ]);
  if (altProvenance.length > 0) {
    mergedExtensions.alternate_provenance = altProvenance;
  }

  // 5. source_id / event_id: fill missing, warn and record conflicts in extensions.
  if (!canonical.source_id) {
    const fallbackSource = retired.find((item) => Boolean(item.source_id?.trim()))?.source_id;
    if (fallbackSource) {
      canonical.source_id = fallbackSource;
    }
  }
  const distinctSources = uniqueNonEmptyStrings(ordered.map((item) => item.source_id));
  const additionalSources = distinctSources.filter((sid) => sid !== canonical.source_id);
  if (additionalSources.length > 0) {
    const prevAdditional = Array.isArray(mergedExtensions.additional_source_ids)
      ? mergedExtensions.additional_source_ids.filter((s): s is string => typeof s === 'string')
      : [];
    mergedExtensions.additional_source_ids = uniqueNonEmptyStrings([...prevAdditional, ...additionalSources]);
    warnings.push(
      `Conflicting source_id on '${normalizedFile}': kept canonical '${canonical.source_id}' on ${canonical.id}; recorded additional [${additionalSources.join(', ')}] in extensions.additional_source_ids.`
    );
  }

  if (!canonical.event_id) {
    const fallbackEvent = retired.find((item) => Boolean(item.event_id?.trim()))?.event_id;
    if (fallbackEvent) {
      canonical.event_id = fallbackEvent;
    }
  }
  const distinctEvents = uniqueNonEmptyStrings(ordered.map((item) => item.event_id));
  const additionalEvents = distinctEvents.filter((eid) => eid !== canonical.event_id);
  if (additionalEvents.length > 0) {
    const prevAdditional = Array.isArray(mergedExtensions.additional_event_ids)
      ? mergedExtensions.additional_event_ids.filter((s): s is string => typeof s === 'string')
      : [];
    mergedExtensions.additional_event_ids = uniqueNonEmptyStrings([...prevAdditional, ...additionalEvents]);
    warnings.push(
      `Conflicting event_id on '${normalizedFile}': kept canonical '${canonical.event_id}' on ${canonical.id}; recorded additional [${additionalEvents.join(', ')}] in extensions.additional_event_ids.`
    );
  }

  // 6. Fill optional scalar metadata in deterministic survivor-score order.
  for (const key of FILLABLE_SCALAR_KEYS) {
    fillOptionalScalar(canonical, retired, key);
  }

  // 7. has_primary_source: true if any record in the group has true.
  if (ordered.some((item) => item.has_primary_source === true)) {
    canonical.has_primary_source = true;
  }

  // 8. Record auditability trail in extensions.merged_from_media_ids.
  const prevMergedFrom = Array.isArray(mergedExtensions.merged_from_media_ids)
    ? mergedExtensions.merged_from_media_ids.filter((id): id is string => typeof id === 'string')
    : [];
  mergedExtensions.merged_from_media_ids = uniqueNonEmptyStrings([...prevMergedFrom, ...retiredIds]).toSorted(
    (a, b) => a.localeCompare(b)
  );
  canonical.extensions = mergedExtensions;

  const validated = MediaItemSchema.parse(canonical);

  return {
    normalizedFile,
    canonicalId: validated.id,
    retiredIds,
    mergedPersonIds,
    warnings,
    mergedRecord: validated,
  };
}

export function planDuplicateMediaMerges(params: {
  media: readonly MediaItem[];
  duplicateEntries: ReadonlyArray<readonly [string, readonly MediaItem[]]>;
  refCounts: ReadonlyMap<string, number>;
  preferSet: ReadonlySet<string>;
}): {
  groups: MediaDedupeGroupPlan[];
  retiredToCanonical: Map<string, string>;
  warnings: string[];
  mergedMedia: MediaItem[];
} {
  const groups: MediaDedupeGroupPlan[] = [];
  const retiredToCanonical = new Map<string, string>();
  const canonicalReplacementById = new Map<string, MediaItem>();
  const warnings: string[] = [];

  for (const [normalizedFile, bucket] of params.duplicateEntries) {
    const plan = mergeDuplicateMediaGroup(bucket, params.refCounts, params.preferSet, normalizedFile);
    groups.push(plan);
    canonicalReplacementById.set(plan.canonicalId, plan.mergedRecord);
    for (const retiredId of plan.retiredIds) {
      retiredToCanonical.set(retiredId, plan.canonicalId);
    }
    warnings.push(...plan.warnings);
  }

  const mergedMedia: MediaItem[] = [];
  for (const item of params.media) {
    if (retiredToCanonical.has(item.id)) {
      continue;
    }
    const replacement = canonicalReplacementById.get(item.id);
    mergedMedia.push(MediaItemSchema.parse(replacement ?? item));
  }

  return { groups, retiredToCanonical, warnings, mergedMedia };
}
