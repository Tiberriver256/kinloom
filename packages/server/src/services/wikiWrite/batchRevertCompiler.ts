import {
  type AtomicMutationOp,
  asRevisionId,
  type BatchId,
  type Clock,
  type EntityLifecycleState,
  type EntityLookupKey,
  type EntityPayload,
  type EntityReadStore,
  entityLookupCompositeKey,
  type KinloomSiteConfig,
  parseEntityPayload,
  type RawEvent,
  type RevisionId,
  type RevisionLogStore,
  type RevisionRecord,
  type StoredEntityRecord,
  transitionBatchRevertLifecycle,
} from '@kinloom/core';
import { KinloomHttpError } from '../../errors.js';
import {
  extractMediaEventId,
  extractSlug,
  prefetchEntitiesByKey,
  rowToWorking,
  updateWorkingPrivacyContext,
  validateAndSanitizeEntityPayload,
} from './payloadPolicy.js';

export function indexPrefetchedEvents(prefetchedRows: ReadonlyMap<string, StoredEntityRecord | null>): {
  workingEvents: Map<string, Pick<RawEvent, 'id' | 'participants'>>;
  prefetchedEventIds: Set<string>;
} {
  const workingEvents = new Map<string, Pick<RawEvent, 'id' | 'participants'>>();
  const prefetchedEventIds = new Set<string>();
  for (const [key, row] of prefetchedRows.entries()) {
    if (!key.startsWith('event:')) {
      continue;
    }
    const eventId = key.slice('event:'.length);
    prefetchedEventIds.add(eventId);
    if (row && !('edge' in row) && row.deleted_at === null) {
      if (typeof row.data['id'] === 'string' && Array.isArray(row.data['participants'])) {
        workingEvents.set(row.data['id'], {
          id: row.data['id'],
          participants: row.data['participants'] as RawEvent['participants'],
        });
      } else {
        const parsedEv = parseEntityPayload('event', row.data);
        workingEvents.set(parsedEv.id, { id: parsedEv.id, participants: parsedEv.participants });
      }
    }
  }
  return { workingEvents, prefetchedEventIds };
}

export async function compileBatchRevertOps(
  deps: {
    readonly repository: EntityReadStore & RevisionLogStore;
    readonly clock: Clock;
    readonly siteConfig: KinloomSiteConfig;
  },
  params: { batchId: BatchId; summary?: string }
): Promise<AtomicMutationOp[]> {
  const batchRevisions = await deps.repository.getRevisionsByBatch(params.batchId);
  if (batchRevisions.length === 0) {
    throw new KinloomHttpError(404, 'BATCH_NOT_FOUND', `Batch ${params.batchId} was not found.`);
  }

  const prefetchKeys: EntityLookupKey[] = [];
  const revById = new Map<number, RevisionRecord>();
  for (const rev of batchRevisions) {
    revById.set(rev.revision_id, rev);
    prefetchKeys.push({ entityType: rev.entity_type, entityId: rev.entity_id });
    if (rev.entity_type === 'media') {
      const beforeEvId = extractMediaEventId(rev.before_json);
      if (beforeEvId) {
        prefetchKeys.push({ entityType: 'event', entityId: beforeEvId });
      }
      const afterEvId = extractMediaEventId(rev.after_json);
      if (afterEvId) {
        prefetchKeys.push({ entityType: 'event', entityId: afterEvId });
      }
    }
  }

  let headRev: RevisionId;
  let initialLivingIds: ReadonlySet<string>;
  let prefetchedRows: Map<string, StoredEntityRecord | null>;

  if (deps.repository.prefetchWriteContext) {
    const ctx = await deps.repository.prefetchWriteContext(prefetchKeys);
    headRev = ctx.headRevisionId;
    initialLivingIds = ctx.livingPersonIds;
    prefetchedRows = ctx.entities;
  } else {
    [headRev, initialLivingIds, prefetchedRows] = await Promise.all([
      deps.repository.getHeadRevisionId(),
      deps.repository.getLivingPersonIds(),
      prefetchEntitiesByKey(deps.repository, prefetchKeys),
    ]);
  }

  const currentStatesByKey = new Map<string, EntityLifecycleState>();
  const initialRevisionByKey = new Map<string, RevisionId>();
  const { workingEvents, prefetchedEventIds } = indexPrefetchedEvents(prefetchedRows);

  for (const rev of batchRevisions) {
    const key = entityLookupCompositeKey(rev.entity_type, rev.entity_id);
    if (!currentStatesByKey.has(key)) {
      const row = prefetchedRows.get(key) ?? null;
      const working = rowToWorking(row);
      currentStatesByKey.set(key, working.lifecycle);
      if (row) {
        initialRevisionByKey.set(key, row.current_revision_id);
      }
    }
  }

  const outcome = transitionBatchRevertLifecycle(currentStatesByKey, batchRevisions, headRev + 1, {
    nowIso: deps.clock.nowIso(),
    summaryPrefix: params.summary?.trim() || `Revert batch ${params.batchId}`,
  });

  if (!outcome.ok) {
    throw new KinloomHttpError(
      outcome.status,
      outcome.status === 409 ? 'OPTIMISTIC_CONFLICT' : 'NOT_FOUND',
      `Cannot revert batch ${params.batchId} at revision r${outcome.failedRevisionId}: ${outcome.code}.`
    );
  }

  const livingIds = new Set<string>(initialLivingIds);
  const lockedInitialByKey = new Set<string>();
  const operations: AtomicMutationOp[] = [];

  for (const step of outcome.steps) {
    const targetRev = revById.get(step.revisionInsert.revertedRevisionId ?? -1);
    const hasPrimarySource = targetRev?.has_primary_source ?? true;

    let sanitizedAfter: EntityPayload | null = null;
    if (step.revisionInsert.afterJson !== null) {
      const validated = await validateAndSanitizeEntityPayload(deps, {
        entityType: step.entityType,
        requestedEntityId: step.entityId,
        rawPayload: step.revisionInsert.afterJson,
        hasPrimarySource,
        livingPersonIdsOverride: livingIds,
        extraEventsById: workingEvents,
        prefetchedEventIds,
      });
      sanitizedAfter = validated.sanitized;
      updateWorkingPrivacyContext(
        deps.siteConfig,
        deps.clock.currentYear(),
        step.entityType,
        step.entityId,
        sanitizedAfter,
        livingIds,
        workingEvents
      );
    } else if (step.entityType === 'person') {
      livingIds.delete(step.entityId);
    } else if (step.entityType === 'event') {
      workingEvents.delete(step.entityId);
      prefetchedEventIds.add(step.entityId);
    }

    const alreadyLocked = lockedInitialByKey.has(step.entityKey);
    const expectedParent = alreadyLocked ? null : (initialRevisionByKey.get(step.entityKey) ?? null);
    lockedInitialByKey.add(step.entityKey);

    operations.push({
      entity_type: step.entityType,
      entity_id: step.entityId,
      slug: extractSlug(step.entityType, sanitizedAfter),
      action: 'revert',
      expected_parent_revision_id: expectedParent,
      reverted_revision_id:
        step.revisionInsert.revertedRevisionId !== null
          ? asRevisionId(step.revisionInsert.revertedRevisionId)
          : null,
      summary: step.revisionInsert.summary,
      has_primary_source: hasPrimarySource,
      before_json: step.revisionInsert.beforeJson,
      after_json: sanitizedAfter,
      soft_delete: sanitizedAfter === null,
      restore_deleted: step.revisionInsert.beforeJson === null && sanitizedAfter !== null,
    });
  }

  return operations;
}
