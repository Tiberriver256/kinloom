import {
  type AtomicMutationOp,
  type AuthorType,
  asBatchId,
  asRevisionId,
  type BatchId,
  type BatchSubmission,
  BatchSubmissionSchema,
  type Clock,
  type EntityLookupKey,
  type EntityPatch,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  type KinloomSiteConfig,
  type RevisionId,
  type RevisionLogStore,
  type StoredEntityRecord,
} from '@kinloom/core';
import { KinloomHttpError } from '../../errors.js';
import { compileBatchRevertOps, indexPrefetchedEvents } from './batchRevertCompiler.js';
import type { WikiCommitPipeline } from './commitPipeline.js';
import {
  assertEditSummaryValid,
  extractMediaEventId,
  extractSlug,
  prefetchEntitiesByKey,
  rowToWorking,
  updateWorkingPrivacyContext,
  validateAndSanitizeEntityPayload,
  type WorkingEntityRecord,
} from './payloadPolicy.js';

export { compileBatchRevertOps };

export interface BatchCompilerDeps {
  readonly repository: EntityReadStore & RevisionLogStore;
  readonly clock: Clock;
  readonly siteConfig: KinloomSiteConfig;
  readonly commitPipeline: WikiCommitPipeline;
}

const VALID_ENTITY_TYPES = new Set<EntityType>([
  'person',
  'event',
  'place',
  'source',
  'media',
  'narrative',
  'kinship_edge',
]);

const VALID_AUTHOR_TYPES = new Set<AuthorType>(['human', 'agent', 'system_seed']);

function isPlainPayloadObject(value: unknown): value is EntityPayload {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function tryFastValidateBatchSubmission(raw: unknown): BatchSubmission | null {
  if (!isPlainPayloadObject(raw)) {
    return null;
  }
  const batchId = raw.batch_id;
  const summary = raw.summary;
  if (typeof batchId !== 'string' || batchId.length === 0) {
    return null;
  }
  if (typeof summary !== 'string' || summary.length < 3) {
    return null;
  }
  const authorTypeRaw = raw.author_type ?? 'agent';
  if (typeof authorTypeRaw !== 'string' || !VALID_AUTHOR_TYPES.has(authorTypeRaw as AuthorType)) {
    return null;
  }
  const hasPrimaryRaw = raw.has_primary_source ?? true;
  if (typeof hasPrimaryRaw !== 'boolean') {
    return null;
  }
  const rawPatches = raw.patches;
  if (!Array.isArray(rawPatches) || rawPatches.length === 0) {
    return null;
  }

  const patches: EntityPatch[] = new Array(rawPatches.length);
  for (let i = 0; i < rawPatches.length; i += 1) {
    const p = rawPatches[i];
    if (!isPlainPayloadObject(p)) {
      return null;
    }
    const action = p.action;
    const entityType = p.entity_type;
    const entityId = p.entity_id;
    if (
      typeof entityType !== 'string' ||
      !VALID_ENTITY_TYPES.has(entityType as EntityType) ||
      typeof entityId !== 'string' ||
      entityId.length === 0
    ) {
      return null;
    }
    const patchSummary = p.summary;
    if (patchSummary !== undefined && (typeof patchSummary !== 'string' || patchSummary.length < 3)) {
      return null;
    }
    const parentRev = p.parent_revision_id;
    if (
      parentRev !== undefined &&
      (typeof parentRev !== 'number' || !Number.isInteger(parentRev) || parentRev <= 0)
    ) {
      return null;
    }

    if (action === 'create') {
      if (!isPlainPayloadObject(p.data)) {
        return null;
      }
      if (p.has_primary_source !== undefined && typeof p.has_primary_source !== 'boolean') {
        return null;
      }
      patches[i] = {
        action: 'create',
        entity_type: entityType as EntityType,
        entity_id: entityId,
        data: p.data,
        ...(patchSummary !== undefined ? { summary: patchSummary } : {}),
        ...(p.has_primary_source !== undefined ? { has_primary_source: p.has_primary_source } : {}),
      };
    } else if (action === 'update') {
      if (!isPlainPayloadObject(p.data)) {
        return null;
      }
      const merge = p.merge ?? true;
      if (typeof merge !== 'boolean') {
        return null;
      }
      if (p.has_primary_source !== undefined && typeof p.has_primary_source !== 'boolean') {
        return null;
      }
      patches[i] = {
        action: 'update',
        entity_type: entityType as EntityType,
        entity_id: entityId,
        data: p.data,
        merge,
        ...(parentRev !== undefined ? { parent_revision_id: parentRev } : {}),
        ...(patchSummary !== undefined ? { summary: patchSummary } : {}),
        ...(p.has_primary_source !== undefined ? { has_primary_source: p.has_primary_source } : {}),
      };
    } else if (action === 'delete') {
      patches[i] = {
        action: 'delete',
        entity_type: entityType as EntityType,
        entity_id: entityId,
        ...(parentRev !== undefined ? { parent_revision_id: parentRev } : {}),
        ...(patchSummary !== undefined ? { summary: patchSummary } : {}),
      };
    } else if (action === 'restore') {
      if (p.data !== undefined && !isPlainPayloadObject(p.data)) {
        return null;
      }
      patches[i] = {
        action: 'restore',
        entity_type: entityType as EntityType,
        entity_id: entityId,
        ...(parentRev !== undefined ? { parent_revision_id: parentRev } : {}),
        ...(p.data !== undefined ? { data: p.data } : {}),
        ...(patchSummary !== undefined ? { summary: patchSummary } : {}),
      };
    } else {
      return null;
    }
  }

  return {
    batch_id: batchId,
    author_type: authorTypeRaw as AuthorType,
    summary,
    has_primary_source: hasPrimaryRaw,
    patches,
  };
}

async function resolveBatchExpectedParent(
  deps: Pick<BatchCompilerDeps, 'repository' | 'commitPipeline'>,
  params: {
    alreadyMutatedInBatch: boolean;
    patchParentRevisionId: number | undefined;
    currentRevisionId: RevisionId;
    entityType: EntityType;
    entityId: string;
    key: string;
    prefetchedRows: ReadonlyMap<string, StoredEntityRecord | null>;
    candidateAfter: EntityPayload | null;
  }
): Promise<RevisionId | null> {
  if (params.alreadyMutatedInBatch) {
    return null;
  }
  const expectedParent = asRevisionId(params.patchParentRevisionId ?? params.currentRevisionId);
  if (
    params.patchParentRevisionId !== undefined &&
    params.patchParentRevisionId !== params.currentRevisionId
  ) {
    const existingRow =
      params.prefetchedRows.get(params.key) ??
      (await deps.repository.getEntity(params.entityType, params.entityId));
    if (existingRow) {
      throw await deps.commitPipeline.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: asRevisionId(params.patchParentRevisionId),
        existing: existingRow,
        candidateAfter: params.candidateAfter,
      });
    }
  }
  return expectedParent;
}

export async function compileBatchSubmissionOps(
  deps: BatchCompilerDeps,
  submission: BatchSubmission
): Promise<{
  batchId: BatchId;
  operations: AtomicMutationOp[];
}> {
  const parsed = tryFastValidateBatchSubmission(submission) ?? BatchSubmissionSchema.parse(submission);
  const batchId = asBatchId(parsed.batch_id);
  const nowIso = deps.clock.nowIso();
  const referenceYear = deps.clock.currentYear();

  const prefetchKeys: EntityLookupKey[] = [];
  for (const patch of parsed.patches) {
    prefetchKeys.push({ entityType: patch.entity_type, entityId: patch.entity_id });
    if (patch.entity_type === 'media' && 'data' in patch) {
      const refEventId = extractMediaEventId(patch.data);
      if (refEventId) {
        prefetchKeys.push({ entityType: 'event', entityId: refEventId });
      }
    }
  }

  let initialLivingIds: ReadonlySet<string>;
  let headRevisionId: RevisionId;
  let prefetchedRows: Map<string, StoredEntityRecord | null>;

  if (deps.repository.prefetchWriteContext) {
    const ctx = await deps.repository.prefetchWriteContext(prefetchKeys);
    initialLivingIds = ctx.livingPersonIds;
    headRevisionId = ctx.headRevisionId;
    prefetchedRows = ctx.entities;
  } else {
    [initialLivingIds, headRevisionId, prefetchedRows] = await Promise.all([
      deps.repository.getLivingPersonIds(),
      deps.repository.getHeadRevisionId(),
      prefetchEntitiesByKey(deps.repository, prefetchKeys),
    ]);
  }

  // Fetch events referenced by existing media rows that a merge/restore patch omits.
  const extraEventKeys: EntityLookupKey[] = [];
  for (const patch of parsed.patches) {
    if (patch.entity_type !== 'media' || (patch.action !== 'update' && patch.action !== 'restore')) {
      continue;
    }
    const existingMedia = prefetchedRows.get(entityLookupCompositeKey('media', patch.entity_id));
    if (!existingMedia || 'edge' in existingMedia) {
      continue;
    }
    const existingEventId = extractMediaEventId(existingMedia.data);
    if (existingEventId && !prefetchedRows.has(entityLookupCompositeKey('event', existingEventId))) {
      extraEventKeys.push({ entityType: 'event', entityId: existingEventId });
    }
  }
  if (extraEventKeys.length > 0) {
    const extraRows = await prefetchEntitiesByKey(deps.repository, extraEventKeys);
    for (const [k, v] of extraRows.entries()) {
      prefetchedRows.set(k, v);
    }
  }

  const livingIds = new Set<string>(initialLivingIds);
  const { workingEvents, prefetchedEventIds } = indexPrefetchedEvents(prefetchedRows);
  const workingByKey = new Map<string, WorkingEntityRecord>();
  const lockedInitialByKey = new Set<string>();
  const operations: AtomicMutationOp[] = [];
  let syntheticRev = headRevisionId + 1;

  const ownsPrefetchedRows = Boolean(deps.repository.prefetchWriteContext);
  for (const [key, row] of prefetchedRows.entries()) {
    workingByKey.set(key, rowToWorking(row, !ownsPrefetchedRows));
  }

  const getWorking = async (entityType: EntityType, entityId: string): Promise<WorkingEntityRecord> => {
    const key = entityLookupCompositeKey(entityType, entityId);
    const cached = workingByKey.get(key);
    if (cached) {
      return cached;
    }
    const row = await deps.repository.getEntity(entityType, entityId);
    prefetchedRows.set(key, row);
    const loaded = rowToWorking(row);
    workingByKey.set(key, loaded);
    return loaded;
  };

  for (const patch of parsed.patches) {
    const entityType = patch.entity_type;
    const entityId = patch.entity_id;
    const key = entityLookupCompositeKey(entityType, entityId);
    const current = await getWorking(entityType, entityId);
    const alreadyMutatedInBatch = lockedInitialByKey.has(key);
    const summary = (patch.summary ?? parsed.summary).trim();
    assertEditSummaryValid(summary);

    const hasPrimarySource =
      'has_primary_source' in patch && patch.has_primary_source !== undefined
        ? patch.has_primary_source
        : parsed.has_primary_source;

    switch (patch.action) {
      case 'create': {
        if (current.lifecycle.kind !== 'nonExistent') {
          throw new KinloomHttpError(
            409,
            'OPTIMISTIC_CONFLICT',
            `Cannot create ${entityType}/${entityId}: entity already exists or is soft-deleted.`
          );
        }
        const validated = await validateAndSanitizeEntityPayload(deps, {
          entityType,
          requestedEntityId: entityId,
          rawPayload: patch.data,
          hasPrimarySource,
          livingPersonIdsOverride: livingIds,
          extraEventsById: workingEvents,
          prefetchedEventIds,
        });
        updateWorkingPrivacyContext(
          deps.siteConfig,
          referenceYear,
          entityType,
          validated.entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        const slug = extractSlug(entityType, validated.sanitized);
        operations.push({
          entity_type: entityType,
          entity_id: validated.entityId,
          slug,
          action: 'create',
          expected_parent_revision_id: null,
          summary,
          has_primary_source: hasPrimarySource,
          before_json: null,
          after_json: validated.sanitized,
        });

        const createdKey = entityLookupCompositeKey(entityType, validated.entityId);
        workingByKey.set(createdKey, {
          lifecycle: { kind: 'active', currentRevisionId: syntheticRev, data: validated.sanitized },
          hasPrimarySource,
          slug,
          updatedAt: nowIso,
        });
        lockedInitialByKey.add(createdKey);
        syntheticRev += 1;
        break;
      }

      case 'update': {
        if (current.lifecycle.kind === 'nonExistent') {
          throw new KinloomHttpError(404, 'NOT_FOUND', `Entity ${entityType}/${entityId} was not found.`);
        }
        if (current.lifecycle.kind === 'softDeleted') {
          throw new KinloomHttpError(
            409,
            'OPTIMISTIC_CONFLICT',
            `Entity ${entityType}/${entityId} is soft-deleted; restore before updating.`
          );
        }

        const previousData = current.lifecycle.data;
        const mergedRaw: EntityPayload = patch.merge ? { ...previousData, ...patch.data } : patch.data;
        const validated = await validateAndSanitizeEntityPayload(deps, {
          entityType,
          requestedEntityId: entityId,
          rawPayload: mergedRaw,
          hasPrimarySource,
          requireIdMatch: true,
          livingPersonIdsOverride: livingIds,
          extraEventsById: workingEvents,
          prefetchedEventIds,
        });

        const expectedParent = await resolveBatchExpectedParent(deps, {
          alreadyMutatedInBatch,
          patchParentRevisionId: patch.parent_revision_id,
          currentRevisionId: asRevisionId(current.lifecycle.currentRevisionId),
          entityType,
          entityId,
          key,
          prefetchedRows,
          candidateAfter: validated.sanitized,
        });

        updateWorkingPrivacyContext(
          deps.siteConfig,
          referenceYear,
          entityType,
          entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        const slug = extractSlug(entityType, validated.sanitized);
        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug,
          action: 'update',
          expected_parent_revision_id: expectedParent,
          summary,
          has_primary_source: hasPrimarySource,
          before_json: previousData,
          after_json: validated.sanitized,
        });

        workingByKey.set(key, {
          lifecycle: { kind: 'active', currentRevisionId: syntheticRev, data: validated.sanitized },
          hasPrimarySource,
          slug,
          updatedAt: nowIso,
        });
        lockedInitialByKey.add(key);
        syntheticRev += 1;
        break;
      }

      case 'delete': {
        if (current.lifecycle.kind === 'nonExistent') {
          throw new KinloomHttpError(404, 'NOT_FOUND', `Entity ${entityType}/${entityId} was not found.`);
        }
        if (current.lifecycle.kind === 'softDeleted') {
          throw new KinloomHttpError(
            409,
            'OPTIMISTIC_CONFLICT',
            `Entity ${entityType}/${entityId} is already soft-deleted.`
          );
        }

        const expectedParent = await resolveBatchExpectedParent(deps, {
          alreadyMutatedInBatch,
          patchParentRevisionId: patch.parent_revision_id,
          currentRevisionId: asRevisionId(current.lifecycle.currentRevisionId),
          entityType,
          entityId,
          key,
          prefetchedRows,
          candidateAfter: null,
        });

        if (entityType === 'person') {
          livingIds.delete(entityId);
        } else if (entityType === 'event') {
          workingEvents.delete(entityId);
          prefetchedEventIds.add(entityId);
        }

        const previousData = current.lifecycle.data;
        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug: current.slug,
          action: 'delete',
          expected_parent_revision_id: expectedParent,
          summary,
          has_primary_source: current.hasPrimarySource,
          before_json: previousData,
          after_json: null,
          soft_delete: true,
        });

        workingByKey.set(key, {
          lifecycle: {
            kind: 'softDeleted',
            currentRevisionId: syntheticRev,
            lastData: structuredClone(previousData),
            deletedAt: nowIso,
          },
          hasPrimarySource: current.hasPrimarySource,
          slug: current.slug,
          updatedAt: nowIso,
        });
        lockedInitialByKey.add(key);
        syntheticRev += 1;
        break;
      }

      case 'restore': {
        if (current.lifecycle.kind === 'nonExistent') {
          throw new KinloomHttpError(404, 'NOT_FOUND', `Entity ${entityType}/${entityId} was not found.`);
        }
        if (current.lifecycle.kind !== 'softDeleted') {
          throw new KinloomHttpError(
            409,
            'OPTIMISTIC_CONFLICT',
            `Entity ${entityType}/${entityId} is not soft-deleted.`
          );
        }

        const candidateRaw: EntityPayload = patch.data
          ? { ...current.lifecycle.lastData, ...patch.data }
          : current.lifecycle.lastData;
        const validated = await validateAndSanitizeEntityPayload(deps, {
          entityType,
          requestedEntityId: entityId,
          rawPayload: candidateRaw,
          hasPrimarySource: current.hasPrimarySource,
          requireIdMatch: true,
          livingPersonIdsOverride: livingIds,
          extraEventsById: workingEvents,
          prefetchedEventIds,
        });

        const expectedParent = await resolveBatchExpectedParent(deps, {
          alreadyMutatedInBatch,
          patchParentRevisionId: patch.parent_revision_id,
          currentRevisionId: asRevisionId(current.lifecycle.currentRevisionId),
          entityType,
          entityId,
          key,
          prefetchedRows,
          candidateAfter: validated.sanitized,
        });

        updateWorkingPrivacyContext(
          deps.siteConfig,
          referenceYear,
          entityType,
          entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        const slug = extractSlug(entityType, validated.sanitized);
        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug,
          action: 'restore',
          expected_parent_revision_id: expectedParent,
          summary,
          has_primary_source: current.hasPrimarySource,
          before_json: null,
          after_json: validated.sanitized,
          restore_deleted: true,
        });

        workingByKey.set(key, {
          lifecycle: { kind: 'active', currentRevisionId: syntheticRev, data: validated.sanitized },
          hasPrimarySource: current.hasPrimarySource,
          slug,
          updatedAt: nowIso,
        });
        lockedInitialByKey.add(key);
        syntheticRev += 1;
        break;
      }

      default: {
        const _exhaustive: never = patch;
        throw new Error(`Unhandled patch action: ${String(_exhaustive)}`);
      }
    }
  }

  return { batchId, operations };
}
