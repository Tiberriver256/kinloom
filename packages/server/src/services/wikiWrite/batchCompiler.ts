import {
  type AtomicMutationOp,
  asBatchId,
  asRevisionId,
  type BatchId,
  type BatchSubmission,
  BatchSubmissionSchema,
  type Clock,
  type EntityLookupKey,
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
  const parsed = BatchSubmissionSchema.parse(submission);
  const batchId = asBatchId(parsed.batch_id);
  const nowIso = deps.clock.nowIso();

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

  const [initialLivingIds, headRevisionId, prefetchedRows] = await Promise.all([
    deps.repository.getLivingPersonIds(),
    deps.repository.getHeadRevisionId(),
    prefetchEntitiesByKey(deps.repository, prefetchKeys),
  ]);

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

  for (const [key, row] of prefetchedRows.entries()) {
    workingByKey.set(key, rowToWorking(row));
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
          deps.clock.currentYear(),
          entityType,
          validated.entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        operations.push({
          entity_type: entityType,
          entity_id: validated.entityId,
          slug: extractSlug(entityType, validated.sanitized),
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
          slug: extractSlug(entityType, validated.sanitized),
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

        const mergedRaw: EntityPayload = patch.merge
          ? { ...structuredClone(current.lifecycle.data), ...structuredClone(patch.data) }
          : structuredClone(patch.data);
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
          deps.clock.currentYear(),
          entityType,
          entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug: extractSlug(entityType, validated.sanitized),
          action: 'update',
          expected_parent_revision_id: expectedParent,
          summary,
          has_primary_source: hasPrimarySource,
          before_json: structuredClone(current.lifecycle.data),
          after_json: validated.sanitized,
        });

        workingByKey.set(key, {
          lifecycle: { kind: 'active', currentRevisionId: syntheticRev, data: validated.sanitized },
          hasPrimarySource,
          slug: extractSlug(entityType, validated.sanitized),
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

        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug: current.slug,
          action: 'delete',
          expected_parent_revision_id: expectedParent,
          summary,
          has_primary_source: current.hasPrimarySource,
          before_json: structuredClone(current.lifecycle.data),
          after_json: null,
          soft_delete: true,
        });

        workingByKey.set(key, {
          lifecycle: {
            kind: 'softDeleted',
            currentRevisionId: syntheticRev,
            lastData: structuredClone(current.lifecycle.data),
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

        const candidateRaw = patch.data
          ? { ...structuredClone(current.lifecycle.lastData), ...structuredClone(patch.data) }
          : structuredClone(current.lifecycle.lastData);
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
          deps.clock.currentYear(),
          entityType,
          entityId,
          validated.sanitized,
          livingIds,
          workingEvents
        );

        operations.push({
          entity_type: entityType,
          entity_id: entityId,
          slug: extractSlug(entityType, validated.sanitized),
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
          slug: extractSlug(entityType, validated.sanitized),
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
