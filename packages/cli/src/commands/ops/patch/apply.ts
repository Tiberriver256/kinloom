import {
  extractNarrativeCitations,
  getMediaPersonIds,
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  NarrativeSchema,
  type Place,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
  RawPersonSchema,
  type SourceRecord,
  validateNarrativeCitations,
} from '@kinloom/core';
import { ZodError } from 'zod';
import { CliValidationError } from '../../../errors.js';
import type { LoadedLocalArchiveRepo } from '../../dataFiles.js';
import { compileAndAuditMergedArchive } from '../shared/bundlePrivacy.js';
import {
  mergeEventsPatch,
  mergeMediaPatch,
  mergePlacesPatch,
  mergeSourcesPatch,
} from '../shared/integrateEngine/entities.js';
import {
  mergedPrimarySourceFlag,
  mergeRecordExtensions,
  upsertById,
} from '../shared/integrateEngine/entityUpsert.js';
import { validateRetirementIntegrity } from '../shared/integrateEngine/integrity.js';
import { mergeKinshipPatch } from '../shared/integrateEngine/kinship.js';
import {
  canonicalJsonStringify,
  dedupeStrings,
  isPlainObject,
} from '../shared/integrateEngine/primitives.js';
import { SAFE_PERSON_ID_RE, SAFE_SLUG_RE, type UpsertCounts } from '../shared/integrateEngine/types.js';
import { findDuplicateNormalizedMediaFiles } from '../shared/mediaFiles.js';
import {
  assertLivingPersonPrivacyInvariants,
  assertPatchedRelationsLivingPrivacy,
  isEffectiveLivingPerson,
} from './privacy.js';
import type {
  NormalizedMultiEntityPatch,
  PatchAllEntityCounts,
  PatchEntityCounts,
  PatchValidationSummary,
} from './types.js';

function formatZodIssues(err: ZodError): string {
  return err.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`).join('; ');
}

function wrapValidationCall<T>(label: string, fn: () => T): T {
  try {
    return fn();
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      throw err;
    }
    if (err instanceof ZodError) {
      throw new CliValidationError(`Invalid ${label}: ${formatZodIssues(err)}`);
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(detail);
  }
}

function toPatchCounts(counts: UpsertCounts, removed = 0): PatchEntityCounts {
  return {
    added: counts.added,
    updated: counts.updated,
    unchanged: counts.unchanged,
    removed,
  };
}

function mergePersonRecord(
  existing: RawPerson,
  rawObj: Record<string, unknown>,
  parsedIncoming: RawPerson
): RawPerson {
  const next: Record<string, unknown> = structuredClone(existing);
  const directFields = [
    'slug',
    'gedcom_xref',
    'full_name',
    'given_name',
    'surname',
    'sex',
    'is_living',
    'lineage_group',
    'branch',
    'birth_edtf',
    'death_edtf',
    'portrait_url',
    'thumb_url',
    'pronunciation',
    'has_primary_source',
  ] as const;

  for (const field of directFields) {
    if (Object.hasOwn(rawObj, field) && rawObj[field] !== undefined) {
      next[field] = structuredClone(parsedIncoming[field]);
    }
  }

  if (Object.hasOwn(rawObj, 'alt_names') && rawObj['alt_names'] !== undefined) {
    next['alt_names'] = dedupeStrings(existing.alt_names, parsedIncoming.alt_names);
  }

  if (Object.hasOwn(rawObj, 'extensions') && rawObj['extensions'] !== undefined) {
    const mergedExt = mergeRecordExtensions(existing.extensions, parsedIncoming.extensions);
    if (mergedExt !== undefined) {
      next['extensions'] = mergedExt;
    }
  }

  return RawPersonSchema.parse(next);
}

function mergePeopleForPatch(input: {
  readonly existingPeople: readonly RawPerson[];
  readonly incomingPeople: readonly unknown[];
  readonly privacyConfig: Partial<PrivacyConfig> | undefined;
  readonly allowLiving: boolean;
}): {
  readonly items: RawPerson[];
  readonly counts: PatchEntityCounts;
  readonly peopleById: Map<string, RawPerson>;
  readonly livingIds: Set<string>;
  readonly livingPeopleTouched: number;
} {
  const { existingPeople, incomingPeople, privacyConfig, allowLiving } = input;
  const items = [...existingPeople];
  const idxById = new Map<string, number>();
  const slugToId = new Map<string, string>();
  for (let i = 0; i < items.length; i += 1) {
    const person = items[i];
    if (person === undefined) continue;
    idxById.set(person.id, i);
    slugToId.set(person.slug, person.id);
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let livingPeopleTouched = 0;
  const seenPatchIds = new Set<string>();

  for (let i = 0; i < incomingPeople.length; i += 1) {
    const label = `patch.people[${i}]`;
    const raw = incomingPeople[i];
    if (!isPlainObject(raw)) {
      throw new CliValidationError(`${label} must be an object.`);
    }
    if (
      typeof raw['id'] !== 'string' ||
      !SAFE_PERSON_ID_RE.test(raw['id']) ||
      raw['id'] !== raw['id'].trim()
    ) {
      throw new CliValidationError(
        `${label} has invalid id '${String(raw['id'])}'. Only ASCII letters, digits, _, and - are allowed.`
      );
    }
    if (seenPatchIds.has(raw['id'])) {
      throw new CliValidationError(`Duplicate person id '${raw['id']}' in patch.people.`);
    }
    seenPatchIds.add(raw['id']);

    const parsedResult = RawPersonSchema.safeParse(raw);
    if (!parsedResult.success) {
      throw new CliValidationError(`Invalid person in ${label}: ${formatZodIssues(parsedResult.error)}`);
    }
    const parsed = parsedResult.data;

    const existingIdx = idxById.get(parsed.id);
    const existing = existingIdx !== undefined ? items[existingIdx] : undefined;
    const candidate = existing ? mergePersonRecord(existing, raw, parsed) : parsed;

    if (candidate.full_name.trim().length === 0) {
      throw new CliValidationError(`${label} ('${candidate.id}') must have a non-empty full_name.`);
    }
    if (!SAFE_SLUG_RE.test(candidate.slug)) {
      throw new CliValidationError(
        `${label} ('${candidate.id}') has invalid slug '${candidate.slug}'. Use lowercase ASCII letters, digits, hyphens, or underscores.`
      );
    }

    const existingIsLiving = existing ? isEffectiveLivingPerson(existing, privacyConfig) : false;
    const candidateIsLiving = isEffectiveLivingPerson(candidate, privacyConfig);

    if (existingIsLiving || candidateIsLiving) {
      if (!allowLiving) {
        throw new CliValidationError(
          `PRIVACY REFUSAL: ${label} ('${candidate.id}') involves a living person. Pass --allow-living to permit privacy-compliant living-person updates.`
        );
      }
      if (candidateIsLiving) {
        assertLivingPersonPrivacyInvariants(candidate, label);
      }
    }

    const slugOwner = slugToId.get(candidate.slug);
    if (slugOwner !== undefined && slugOwner !== candidate.id) {
      throw new CliValidationError(
        `Slug collision: ${label} ('${candidate.id}') reuses slug '${candidate.slug}' already owned by '${slugOwner}'.`
      );
    }

    if (existingIdx === undefined || existing === undefined) {
      idxById.set(candidate.id, items.length);
      slugToId.set(candidate.slug, candidate.id);
      items.push(candidate);
      added += 1;
      if (candidateIsLiving) {
        livingPeopleTouched += 1;
      }
      continue;
    }

    if (canonicalJsonStringify(existing) === canonicalJsonStringify(candidate)) {
      unchanged += 1;
    } else {
      if (existing.slug !== candidate.slug && slugToId.get(existing.slug) === existing.id) {
        slugToId.delete(existing.slug);
      }
      slugToId.set(candidate.slug, candidate.id);
      items[existingIdx] = candidate;
      updated += 1;
      if (candidateIsLiving) {
        livingPeopleTouched += 1;
      }
    }
  }

  const peopleById = new Map<string, RawPerson>();
  const livingIds = new Set<string>();
  for (const person of items) {
    peopleById.set(person.id, person);
    if (isEffectiveLivingPerson(person, privacyConfig)) {
      livingIds.add(person.id);
    }
  }

  return {
    items,
    counts: { added, updated, unchanged, removed: 0 },
    peopleById,
    livingIds,
    livingPeopleTouched,
  };
}

function mergeNarrativesForPatch(input: {
  readonly existingNarratives: readonly Narrative[];
  readonly patchNarratives: readonly unknown[];
  readonly removeNarrativeIds: readonly string[];
  readonly sourceIds: ReadonlySet<string>;
  readonly mediaIds: ReadonlySet<string>;
}): {
  readonly items: Narrative[];
  readonly counts: PatchEntityCounts;
  readonly parsedIncoming: Narrative[];
} {
  const { existingNarratives, patchNarratives, removeNarrativeIds, sourceIds, mediaIds } = input;
  const normalizedRawNarratives = patchNarratives.map((rawNar) => {
    if (!isPlainObject(rawNar)) {
      return rawNar;
    }
    const copy: Record<string, unknown> = { ...rawNar };
    if (typeof copy['body_md'] === 'string') {
      const citationErrors = validateNarrativeCitations(
        [{ id: typeof copy['id'] === 'string' ? copy['id'] : 'unknown', body_md: copy['body_md'] }],
        sourceIds,
        mediaIds
      );
      if (citationErrors.length > 0) {
        throw new CliValidationError(citationErrors[0] ?? 'Invalid narrative citation.');
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
    }
    return copy;
  });

  const merged = wrapValidationCall('patch.narratives', () =>
    upsertById(
      existingNarratives,
      normalizedRawNarratives,
      (n) => NarrativeSchema.parse(n),
      (prev, incoming) => {
        const next: Record<string, unknown> = { ...incoming };
        const hasPrimary = mergedPrimarySourceFlag(prev.has_primary_source, incoming.has_primary_source);
        if (hasPrimary !== undefined) {
          next['has_primary_source'] = hasPrimary;
        }
        if (incoming.updated_at === undefined && prev.updated_at !== undefined) {
          next['updated_at'] = prev.updated_at;
        }
        if (incoming.summary === undefined && prev.summary !== undefined) {
          next['summary'] = prev.summary;
        }
        const mergedExt = mergeRecordExtensions(prev.extensions, incoming.extensions);
        if (mergedExt !== undefined) {
          next['extensions'] = mergedExt;
        }
        return next;
      }
    )
  );

  const removeSet = new Set(removeNarrativeIds);
  if (removeSet.size === 0) {
    return {
      items: merged.items,
      counts: toPatchCounts(merged.counts, 0),
      parsedIncoming: merged.parsedIncoming,
    };
  }

  const incomingIds = new Set(merged.parsedIncoming.map((n) => n.id));
  for (const removeId of removeSet) {
    if (incomingIds.has(removeId)) {
      throw new CliValidationError(
        `Patch cannot both add/update and remove narrative '${removeId}' in the same patch.`
      );
    }
  }

  let removed = 0;
  const items = merged.items.filter((nar) => {
    if (removeSet.has(nar.id)) {
      removed += 1;
      return false;
    }
    return true;
  });

  return {
    items,
    counts: toPatchCounts(merged.counts, removed),
    parsedIncoming: merged.parsedIncoming,
  };
}

function validateMultiEntityReferentialIntegrity(input: {
  readonly patchEvents: readonly RawEvent[];
  readonly patchKinship: readonly KinshipEdge[];
  readonly patchMedia: readonly MediaItem[];
  readonly patchNarratives: readonly Narrative[];
  readonly peopleById: ReadonlyMap<string, RawPerson>;
  readonly placeIds: ReadonlySet<string>;
  readonly sourceIds: ReadonlySet<string>;
  readonly eventsById: ReadonlyMap<string, RawEvent>;
  readonly allMedia: readonly MediaItem[];
}): void {
  const {
    patchEvents,
    patchKinship,
    patchMedia,
    patchNarratives,
    peopleById,
    placeIds,
    sourceIds,
    eventsById,
    allMedia,
  } = input;

  for (const ev of patchEvents) {
    if (ev.place_id && !placeIds.has(ev.place_id)) {
      throw new CliValidationError(`Event '${ev.id}' references missing place_id '${ev.place_id}'.`);
    }
    for (const pt of ev.participants) {
      if (!peopleById.has(pt.person_id)) {
        throw new CliValidationError(`Event '${ev.id}' references missing person_id '${pt.person_id}'.`);
      }
    }
    for (const ref of ev.sources) {
      if (!sourceIds.has(ref.source_id)) {
        throw new CliValidationError(`Event '${ev.id}' references missing source_id '${ref.source_id}'.`);
      }
    }
  }

  for (const edge of patchKinship) {
    if (!peopleById.has(edge.from)) {
      throw new CliValidationError(`Kinship edge references missing 'from' person '${edge.from}'.`);
    }
    if (!peopleById.has(edge.to)) {
      throw new CliValidationError(`Kinship edge references missing 'to' person '${edge.to}'.`);
    }
  }

  for (const item of patchMedia) {
    for (const pid of getMediaPersonIds(item)) {
      if (!peopleById.has(pid)) {
        throw new CliValidationError(`Media '${item.id}' references missing person_id '${pid}'.`);
      }
    }
    if (item.event_id && !eventsById.has(item.event_id)) {
      throw new CliValidationError(`Media '${item.id}' references missing event_id '${item.event_id}'.`);
    }
    if (item.source_id && !sourceIds.has(item.source_id)) {
      throw new CliValidationError(`Media '${item.id}' references missing source_id '${item.source_id}'.`);
    }
  }

  const duplicateMedia = findDuplicateNormalizedMediaFiles(allMedia);
  if (duplicateMedia.length > 0) {
    const first = duplicateMedia[0];
    if (first) {
      throw new CliValidationError(
        `Duplicate media file path '${first.file}' shared by media IDs: ${first.mediaIds.join(', ')}.`
      );
    }
  }

  for (const nar of patchNarratives) {
    if (nar.subject_person_id && !peopleById.has(nar.subject_person_id)) {
      throw new CliValidationError(
        `Narrative '${nar.id}' references missing subject_person_id '${nar.subject_person_id}'.`
      );
    }
    for (const pid of nar.person_ids) {
      if (!peopleById.has(pid)) {
        throw new CliValidationError(`Narrative '${nar.id}' references missing person_id '${pid}'.`);
      }
    }
    for (const plId of nar.place_ids) {
      if (!placeIds.has(plId)) {
        throw new CliValidationError(`Narrative '${nar.id}' references missing place_id '${plId}'.`);
      }
    }
    for (const evId of nar.event_ids) {
      if (!eventsById.has(evId)) {
        throw new CliValidationError(`Narrative '${nar.id}' references missing event_id '${evId}'.`);
      }
    }
    for (const srcId of nar.source_ids) {
      if (!sourceIds.has(srcId)) {
        throw new CliValidationError(`Narrative '${nar.id}' references missing source_id '${srcId}'.`);
      }
    }
  }
}

export interface AppliedMultiEntityPatch {
  readonly people: RawPerson[];
  readonly places: Place[];
  readonly events: RawEvent[];
  readonly kinship: KinshipEdge[];
  readonly sources: SourceRecord[];
  readonly media: MediaItem[];
  readonly narratives: Narrative[];
  readonly counts: PatchAllEntityCounts;
  readonly livingPeopleTouched: number;
  readonly validation: PatchValidationSummary;
}

export function applyAndValidateMultiEntityPatch(input: {
  readonly loaded: LoadedLocalArchiveRepo;
  readonly patch: NormalizedMultiEntityPatch;
  readonly allowLiving: boolean;
}): AppliedMultiEntityPatch {
  const { loaded, patch, allowLiving } = input;
  const siteConfig = loaded.siteConfig;
  if (!siteConfig) {
    throw new CliValidationError(`Missing kinloom.config.yaml under ${loaded.repoDir}.`);
  }

  const peopleMerge = mergePeopleForPatch({
    existingPeople: loaded.people,
    incomingPeople: patch.people,
    privacyConfig: siteConfig.privacy,
    allowLiving,
  });

  const placesMerge = wrapValidationCall('patch.places', () => mergePlacesPatch(loaded.places, patch.places));
  const sourcesMerge = wrapValidationCall('patch.sources', () =>
    mergeSourcesPatch(loaded.sources, patch.sources, patch.remove_source_ids)
  );
  const eventsMerge = wrapValidationCall('patch.events', () =>
    mergeEventsPatch(loaded.events, patch.events, patch.remove_event_ids)
  );
  const mediaMerge = wrapValidationCall('patch.media', () =>
    mergeMediaPatch(loaded.media, patch.media, patch.remove_media_ids)
  );
  const kinshipMerge = wrapValidationCall('patch.kinship', () =>
    mergeKinshipPatch(loaded.kinship, patch.kinship, patch.remove_kinship)
  );

  const placeIds = new Set(placesMerge.items.map((p) => p.id));
  const sourceIds = new Set(sourcesMerge.items.map((s) => s.id));
  const mediaIds = new Set(mediaMerge.items.map((m) => m.id));
  const eventsById = new Map(eventsMerge.items.map((ev) => [ev.id, ev]));

  const narrativesMerge = mergeNarrativesForPatch({
    existingNarratives: loaded.narratives,
    patchNarratives: patch.narratives,
    removeNarrativeIds: patch.remove_narrative_ids,
    sourceIds,
    mediaIds,
  });

  const patchMediaItems = mediaMerge.items.filter((m) =>
    patch.media.some((raw) => isPlainObject(raw) && raw['id'] === m.id)
  );

  validateMultiEntityReferentialIntegrity({
    patchEvents: eventsMerge.cleanedPatchEvents,
    patchKinship: kinshipMerge.parsedPatchKinship,
    patchMedia: patchMediaItems,
    patchNarratives: narrativesMerge.parsedIncoming,
    peopleById: peopleMerge.peopleById,
    placeIds,
    sourceIds,
    eventsById,
    allMedia: mediaMerge.items,
  });

  assertPatchedRelationsLivingPrivacy({
    allowLiving,
    livingIds: peopleMerge.livingIds,
    patchEvents: eventsMerge.cleanedPatchEvents,
    patchMedia: patchMediaItems,
    patchNarratives: narrativesMerge.parsedIncoming,
    allEventsById: eventsById,
  });

  wrapValidationCall('retirement integrity', () => {
    validateRetirementIntegrity({
      topLevelRemoveEventIds: eventsMerge.topLevelRemoveEventIds,
      topLevelRemoveMediaIds: mediaMerge.topLevelRemoveMediaIds,
      topLevelRemoveSourceIds: sourcesMerge.topLevelRemoveSourceIds,
      mergedPeople: peopleMerge.items,
      finalEvents: eventsMerge.items,
      finalMedia: mediaMerge.items,
      finalNarratives: narrativesMerge.items,
      sourceIds,
      mediaIds,
    });
  });

  const { privateResult, publicResult, livingLeaks } = compileAndAuditMergedArchive(
    {
      people: peopleMerge.items,
      events: eventsMerge.items,
      places: placesMerge.items,
      sources: sourcesMerge.items,
      kinship: kinshipMerge.items,
      media: mediaMerge.items,
      narratives: narrativesMerge.items,
      ...(loaded.enrichments.length > 0 ? { enrichments: loaded.enrichments } : {}),
      siteConfig,
    },
    { skipBundleRevalidation: false }
  );

  return {
    people: peopleMerge.items,
    places: placesMerge.items,
    events: eventsMerge.items,
    kinship: kinshipMerge.items,
    sources: sourcesMerge.items,
    media: mediaMerge.items,
    narratives: narrativesMerge.items,
    counts: {
      people: peopleMerge.counts,
      places: toPatchCounts(placesMerge.counts),
      events: toPatchCounts(eventsMerge.counts, eventsMerge.removedEventIds.length),
      kinship: toPatchCounts(kinshipMerge.counts, kinshipMerge.removed.length),
      sources: toPatchCounts(sourcesMerge.counts, sourcesMerge.removedSourceIds.length),
      media: toPatchCounts(mediaMerge.counts, mediaMerge.removedMediaIds.length),
      narratives: narrativesMerge.counts,
    },
    livingPeopleTouched: peopleMerge.livingPeopleTouched,
    validation: {
      privateCounts: privateResult.bundle.meta.counts,
      publicCounts: publicResult.bundle.meta.counts,
      privateReviewFlags: privateResult.reviewFlags.length,
      publicReviewFlags: publicResult.reviewFlags.length,
      livingLeaks,
    },
  };
}
