import {
  asBatchId,
  asRevisionId,
  assertMediaAllowedForPrivacy,
  BatchSubmissionSchema,
  computeEntityDiff,
  deriveKinshipEdgeId,
  entityLookupCompositeKey,
  isEditSummaryValid,
  parseEntityPayload,
  resolveEffectiveLiving,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
  transitionBatchRevertLifecycle,
  transitionEntityLifecycle,
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  type ArchiveRepository,
  type AtomicMutationOp,
  type BatchId,
  type BatchSubmission,
  type BundleCache,
  type Clock,
  type EntityLifecycleState,
  type EntityLookupKey,
  type EntityPayload,
  type EntityType,
  type KinloomServerPlugin,
  type KinloomSiteConfig,
  type OptimisticConflictError,
  type RawEvent,
  type RawPerson,
  type RevisionAuthor,
  type RevisionId,
  type RevisionRecord,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
} from '@kinloom/core';
import { generateEntityId, readBodyToString } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';

const ENTITY_ID_PREFIX: Record<Exclude<EntityType, 'kinship_edge'>, string> = {
  person: 'per',
  event: 'evt',
  place: 'plc',
  source: 'src',
  media: 'med',
  narrative: 'nar',
};

export interface WikiWriteServiceDeps {
  repository: ArchiveRepository;
  bundleCache: BundleCache;
  clock: Clock;
  siteConfig: KinloomSiteConfig;
  plugins?: readonly KinloomServerPlugin[];
  onPluginError?: (pluginId: string, error: unknown) => void;
}

interface WorkingEntityRecord {
  lifecycle: EntityLifecycleState;
  hasPrimarySource: boolean;
  slug: string | null;
  updatedAt: string;
}

function rowToPayload(row: StoredEntityRecord): EntityPayload {
  if ('edge' in row) {
    return structuredClone(row.edge) as unknown as EntityPayload;
  }
  return structuredClone(row.data);
}

function rowToWorking(row: StoredEntityRecord | null): WorkingEntityRecord {
  if (!row) {
    return {
      lifecycle: { kind: 'nonExistent' },
      hasPrimarySource: true,
      slug: null,
      updatedAt: '',
    };
  }
  const payload = rowToPayload(row);
  if (row.deleted_at !== null) {
    return {
      lifecycle: {
        kind: 'softDeleted',
        currentRevisionId: row.current_revision_id,
        lastData: payload,
        deletedAt: row.deleted_at,
      },
      hasPrimarySource: 'edge' in row ? true : row.has_primary_source,
      slug: 'edge' in row ? null : row.slug,
      updatedAt: row.updated_at,
    };
  }
  return {
    lifecycle: {
      kind: 'active',
      currentRevisionId: row.current_revision_id,
      data: payload,
    },
    hasPrimarySource: 'edge' in row ? true : row.has_primary_source,
    slug: 'edge' in row ? null : row.slug,
    updatedAt: row.updated_at,
  };
}

function extractSlug(entityType: EntityType, payload: EntityPayload | null): string | null {
  if (!payload || entityType === 'kinship_edge') {
    return null;
  }
  return typeof payload.slug === 'string' && payload.slug.trim().length > 0
    ? payload.slug.trim()
    : null;
}

function extractMediaEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const eventId = (payload as Record<string, unknown>).event_id;
  return typeof eventId === 'string' && eventId.trim().length > 0 ? eventId.trim() : null;
}

function compositeKey(entityType: EntityType, entityId: string): string {
  return entityLookupCompositeKey(entityType, entityId);
}

function buildInitialSnapshotFromRevisions(
  revisions: readonly RevisionRecord[],
  headRevisionId: RevisionId
): ArchiveRawSnapshot {
  const entitiesByKey = new Map<string, StoredEntityRow>();
  const kinshipById = new Map<string, StoredKinshipRow>();

  for (const rev of revisions) {
    if (rev.entity_type === 'kinship_edge') {
      if (rev.after_json === null) {
        kinshipById.delete(rev.entity_id);
      } else {
        kinshipById.set(rev.entity_id, {
          edge_id: rev.entity_id,
          edge: parseEntityPayload('kinship_edge', rev.after_json),
          current_revision_id: asRevisionId(rev.revision_id),
          deleted_at: null,
          updated_at: rev.created_at,
        });
      }
      continue;
    }

    const key = compositeKey(rev.entity_type, rev.entity_id);
    if (rev.after_json === null) {
      entitiesByKey.delete(key);
    } else {
      entitiesByKey.set(key, {
        entity_type: rev.entity_type,
        entity_id: rev.entity_id,
        slug: extractSlug(rev.entity_type, rev.after_json),
        data: rev.after_json,
        current_revision_id: asRevisionId(rev.revision_id),
        has_primary_source: rev.has_primary_source,
        deleted_at: null,
        updated_at: rev.created_at,
      });
    }
  }

  const entities = [...entitiesByKey.values()].toSorted((a, b) =>
    a.entity_type === b.entity_type
      ? a.entity_id.localeCompare(b.entity_id)
      : a.entity_type.localeCompare(b.entity_type)
  );
  const kinship = [...kinshipById.values()].toSorted((a, b) => a.edge_id.localeCompare(b.edge_id));

  return {
    head_revision_id: headRevisionId,
    entities,
    kinship,
  };
}

export class WikiWriteService {
  private readonly repository: ArchiveRepository;
  private readonly bundleCache: BundleCache;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly plugins: readonly KinloomServerPlugin[];
  private readonly onPluginError?: (pluginId: string, error: unknown) => void;

  constructor(deps: WikiWriteServiceDeps) {
    this.repository = deps.repository;
    this.bundleCache = deps.bundleCache;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
    this.plugins = deps.plugins ?? [];
    this.onPluginError = deps.onPluginError;
  }

  async createEntity(params: {
    entityType: EntityType;
    entityId?: string;
    data: EntityPayload;
    summary: string;
    hasPrimarySource: boolean;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    this.assertSummaryValid(params.summary);

    const { entityId, sanitized } = await this.validateAndSanitizePayload({
      entityType: params.entityType,
      requestedEntityId: params.entityId,
      rawPayload: params.data,
      hasPrimarySource: params.hasPrimarySource,
    });

    const existing = await this.repository.getEntity(params.entityType, entityId);
    if (existing !== null) {
      throw new KinloomHttpError(
        409,
        'ENTITY_EXISTS',
        existing.deleted_at !== null
          ? `Entity ${params.entityType}/${entityId} is soft-deleted; use restore or revert instead.`
          : `Entity ${params.entityType}/${entityId} already exists.`
      );
    }

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'create',
      expected_parent_revision_id: null,
      summary: params.summary.trim(),
      has_primary_source: params.hasPrimarySource,
      before_json: null,
      after_json: sanitized,
    };

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations: [op],
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag,
    };
  }

  async updateEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    data: EntityPayload;
    merge?: boolean;
    summary: string;
    hasPrimarySource: boolean;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    this.assertSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    const existingPayload = rowToPayload(existing);
    const mergedRaw: EntityPayload = params.merge
      ? { ...existingPayload, ...structuredClone(params.data) }
      : structuredClone(params.data);

    const { sanitized } = await this.validateAndSanitizePayload({
      entityType: params.entityType,
      requestedEntityId: params.entityId,
      rawPayload: mergedRaw,
      hasPrimarySource: params.hasPrimarySource,
      requireIdMatch: true,
    });

    if (existing.deleted_at !== null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: sanitized,
      });
    }

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'update',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: params.hasPrimarySource,
      before_json: existingPayload,
      after_json: sanitized,
    };

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations: [op],
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag,
    };
  }

  async deleteEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    summary: string;
    author: RevisionAuthor;
  }): Promise<{ revision: RevisionRecord; etag: string }> {
    this.assertSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    if (existing.deleted_at !== null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: null,
      });
    }

    const beforePayload = rowToPayload(existing);
    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: 'edge' in existing ? null : existing.slug,
      action: 'delete',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: 'edge' in existing ? true : existing.has_primary_source,
      before_json: beforePayload,
      after_json: null,
      soft_delete: true,
    };

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations: [op],
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      revision: committed.revisions[0],
      etag,
    };
  }

  async restoreEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    data?: EntityPayload;
    summary: string;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    this.assertSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    const existingPayload = rowToPayload(existing);
    const candidateRaw = params.data
      ? { ...existingPayload, ...structuredClone(params.data) }
      : existingPayload;

    const hasPrimary = 'edge' in existing ? true : existing.has_primary_source;
    const { sanitized } = await this.validateAndSanitizePayload({
      entityType: params.entityType,
      requestedEntityId: params.entityId,
      rawPayload: candidateRaw,
      hasPrimarySource: hasPrimary,
      requireIdMatch: true,
    });

    if (existing.deleted_at === null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: sanitized,
      });
    }

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'restore',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: hasPrimary,
      before_json: null,
      after_json: sanitized,
      restore_deleted: true,
    };

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations: [op],
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag,
    };
  }

  async revertRevision(params: {
    revisionId: RevisionId;
    summary?: string;
    author: RevisionAuthor;
  }): Promise<{ revision: RevisionRecord; etag: string }> {
    const targetRev = await this.repository.getRevisionById(params.revisionId);
    if (!targetRev) {
      throw new KinloomHttpError(
        404,
        'REVISION_NOT_FOUND',
        `Revision r${params.revisionId} was not found.`
      );
    }

    const [existing, headRev] = await Promise.all([
      this.repository.getEntity(targetRev.entity_type, targetRev.entity_id),
      this.repository.getHeadRevisionId(),
    ]);
    const working = rowToWorking(existing);

    const outcome = transitionEntityLifecycle(
      working.lifecycle,
      {
        type: 'revert',
        targetRevision: targetRev,
        summary: params.summary,
        nowIso: this.clock.nowIso(),
      },
      headRev + 1
    );

    if (!outcome.ok) {
      throw new KinloomHttpError(
        outcome.status,
        outcome.status === 409 ? 'OPTIMISTIC_CONFLICT' : 'NOT_FOUND',
        `Cannot revert revision r${params.revisionId}: ${outcome.code}.`
      );
    }

    let sanitizedAfter: EntityPayload | null = null;
    if (outcome.revisionInsert.afterJson !== null) {
      const validated = await this.validateAndSanitizePayload({
        entityType: targetRev.entity_type,
        requestedEntityId: targetRev.entity_id,
        rawPayload: outcome.revisionInsert.afterJson,
        hasPrimarySource: targetRev.has_primary_source,
      });
      sanitizedAfter = validated.sanitized;
    }

    const op: AtomicMutationOp = {
      entity_type: targetRev.entity_type,
      entity_id: targetRev.entity_id,
      slug: extractSlug(targetRev.entity_type, sanitizedAfter),
      action: 'revert',
      expected_parent_revision_id: existing ? existing.current_revision_id : null,
      reverted_revision_id: asRevisionId(targetRev.revision_id),
      summary: outcome.revisionInsert.summary,
      has_primary_source: targetRev.has_primary_source,
      before_json: outcome.revisionInsert.beforeJson,
      after_json: sanitizedAfter,
      soft_delete: sanitizedAfter === null,
      restore_deleted: working.lifecycle.kind === 'softDeleted' && sanitizedAfter !== null,
    };

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations: [op],
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      revision: committed.revisions[0],
      etag,
    };
  }

  async submitBatch(params: {
    submission: BatchSubmission;
    author: RevisionAuthor;
  }): Promise<{
    batch_id: BatchId;
    revisions: readonly RevisionRecord[];
    head_revision_id: RevisionId;
    etag: string;
  }> {
    const parsed = BatchSubmissionSchema.parse(params.submission);
    const batchId = asBatchId(parsed.batch_id);
    const nowIso = this.clock.nowIso();

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
      this.repository.getLivingPersonIds(),
      this.repository.getHeadRevisionId(),
      this.prefetchEntities(prefetchKeys),
    ]);

    // If a media update/restore merges or restores an existing record whose stored event_id was not in patch.data, batch-fetch those events too.
    const extraEventKeys: EntityLookupKey[] = [];
    for (const patch of parsed.patches) {
      if (patch.entity_type !== 'media' || (patch.action !== 'update' && patch.action !== 'restore')) {
        continue;
      }
      const existingMedia = prefetchedRows.get(compositeKey('media', patch.entity_id));
      if (!existingMedia || 'edge' in existingMedia) {
        continue;
      }
      const existingEventId = extractMediaEventId(existingMedia.data);
      if (existingEventId && !prefetchedRows.has(compositeKey('event', existingEventId))) {
        extraEventKeys.push({ entityType: 'event', entityId: existingEventId });
      }
    }
    if (extraEventKeys.length > 0) {
      const extraRows = await this.prefetchEntities(extraEventKeys);
      for (const [k, v] of extraRows.entries()) {
        prefetchedRows.set(k, v);
      }
    }

    const livingIds = new Set<string>(initialLivingIds);
    const workingEvents = new Map<string, Pick<RawEvent, 'id' | 'participants'>>();
    const prefetchedEventIds = new Set<string>();
    const workingByKey = new Map<string, WorkingEntityRecord>();
    const lockedInitialByKey = new Set<string>();
    const operations: AtomicMutationOp[] = [];
    let syntheticRev = headRevisionId + 1;

    for (const [key, row] of prefetchedRows.entries()) {
      workingByKey.set(key, rowToWorking(row));
      if (key.startsWith('event:')) {
        const eventId = key.slice('event:'.length);
        prefetchedEventIds.add(eventId);
        if (row && !('edge' in row) && row.deleted_at === null) {
          const parsedEv = parseEntityPayload('event', row.data);
          workingEvents.set(parsedEv.id, { id: parsedEv.id, participants: parsedEv.participants });
        }
      }
    }

    const getWorking = async (entityType: EntityType, entityId: string): Promise<WorkingEntityRecord> => {
      const key = compositeKey(entityType, entityId);
      const cached = workingByKey.get(key);
      if (cached) {
        return cached;
      }
      const row = await this.repository.getEntity(entityType, entityId);
      prefetchedRows.set(key, row);
      const loaded = rowToWorking(row);
      workingByKey.set(key, loaded);
      return loaded;
    };

    for (const patch of parsed.patches) {
      const entityType = patch.entity_type;
      const entityId = patch.entity_id;
      const key = compositeKey(entityType, entityId);
      const current = await getWorking(entityType, entityId);
      const alreadyMutatedInBatch = lockedInitialByKey.has(key);
      const summary = (patch.summary ?? parsed.summary).trim();
      this.assertSummaryValid(summary);

      const hasPrimarySource =
        ('has_primary_source' in patch && patch.has_primary_source !== undefined
          ? patch.has_primary_source
          : parsed.has_primary_source);

      switch (patch.action) {
        case 'create': {
          if (current.lifecycle.kind !== 'nonExistent') {
            throw new KinloomHttpError(
              409,
              'OPTIMISTIC_CONFLICT',
              `Cannot create ${entityType}/${entityId}: entity already exists or is soft-deleted.`
            );
          }
          const validated = await this.validateAndSanitizePayload({
            entityType,
            requestedEntityId: entityId,
            rawPayload: patch.data,
            hasPrimarySource,
            livingPersonIdsOverride: livingIds,
            extraEventsById: workingEvents,
            prefetchedEventIds,
          });
          this.updateWorkingPrivacyContext(entityType, validated.entityId, validated.sanitized, livingIds, workingEvents);

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

          workingByKey.set(compositeKey(entityType, validated.entityId), {
            lifecycle: { kind: 'active', currentRevisionId: syntheticRev, data: validated.sanitized },
            hasPrimarySource,
            slug: extractSlug(entityType, validated.sanitized),
            updatedAt: nowIso,
          });
          lockedInitialByKey.add(compositeKey(entityType, validated.entityId));
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
          const validated = await this.validateAndSanitizePayload({
            entityType,
            requestedEntityId: entityId,
            rawPayload: mergedRaw,
            hasPrimarySource,
            requireIdMatch: true,
            livingPersonIdsOverride: livingIds,
            extraEventsById: workingEvents,
            prefetchedEventIds,
          });

          const expectedParent = alreadyMutatedInBatch
            ? null
            : asRevisionId(patch.parent_revision_id ?? current.lifecycle.currentRevisionId);

          if (
            !alreadyMutatedInBatch &&
            patch.parent_revision_id !== undefined &&
            patch.parent_revision_id !== current.lifecycle.currentRevisionId
          ) {
            const existingRow = prefetchedRows.get(key) ?? (await this.repository.getEntity(entityType, entityId));
            if (existingRow) {
              throw await this.buildConflictHttpError({
                entityType,
                entityId,
                expectedParentRevisionId: asRevisionId(patch.parent_revision_id),
                existing: existingRow,
                candidateAfter: validated.sanitized,
              });
            }
          }

          this.updateWorkingPrivacyContext(entityType, entityId, validated.sanitized, livingIds, workingEvents);

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

          const expectedParent = alreadyMutatedInBatch
            ? null
            : asRevisionId(patch.parent_revision_id ?? current.lifecycle.currentRevisionId);

          if (
            !alreadyMutatedInBatch &&
            patch.parent_revision_id !== undefined &&
            patch.parent_revision_id !== current.lifecycle.currentRevisionId
          ) {
            const existingRow = prefetchedRows.get(key) ?? (await this.repository.getEntity(entityType, entityId));
            if (existingRow) {
              throw await this.buildConflictHttpError({
                entityType,
                entityId,
                expectedParentRevisionId: asRevisionId(patch.parent_revision_id),
                existing: existingRow,
                candidateAfter: null,
              });
            }
          }

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
          const validated = await this.validateAndSanitizePayload({
            entityType,
            requestedEntityId: entityId,
            rawPayload: candidateRaw,
            hasPrimarySource: current.hasPrimarySource,
            requireIdMatch: true,
            livingPersonIdsOverride: livingIds,
            extraEventsById: workingEvents,
            prefetchedEventIds,
          });

          const expectedParent = alreadyMutatedInBatch
            ? null
            : asRevisionId(patch.parent_revision_id ?? current.lifecycle.currentRevisionId);

          if (
            !alreadyMutatedInBatch &&
            patch.parent_revision_id !== undefined &&
            patch.parent_revision_id !== current.lifecycle.currentRevisionId
          ) {
            const existingRow = prefetchedRows.get(key) ?? (await this.repository.getEntity(entityType, entityId));
            if (existingRow) {
              throw await this.buildConflictHttpError({
                entityType,
                entityId,
                expectedParentRevisionId: asRevisionId(patch.parent_revision_id),
                existing: existingRow,
                candidateAfter: validated.sanitized,
              });
            }
          }

          this.updateWorkingPrivacyContext(entityType, entityId, validated.sanitized, livingIds, workingEvents);

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

    const committed = await this.commitOrThrowConflict({
      batchId,
      author: params.author,
      operations,
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      batch_id: batchId,
      revisions: committed.revisions,
      head_revision_id: committed.head_revision_id,
      etag,
    };
  }

  async revertBatch(params: {
    batchId: BatchId;
    summary?: string;
    author: RevisionAuthor;
  }): Promise<{
    reverted_batch_id: BatchId;
    revisions: readonly RevisionRecord[];
    head_revision_id: RevisionId;
    etag: string;
  }> {
    const batchRevisions = await this.repository.getRevisionsByBatch(params.batchId);
    if (batchRevisions.length === 0) {
      throw new KinloomHttpError(
        404,
        'BATCH_NOT_FOUND',
        `Batch ${params.batchId} was not found.`
      );
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

    const [headRev, initialLivingIds, prefetchedRows] = await Promise.all([
      this.repository.getHeadRevisionId(),
      this.repository.getLivingPersonIds(),
      this.prefetchEntities(prefetchKeys),
    ]);

    const currentStatesByKey = new Map<string, EntityLifecycleState>();
    const initialRevisionByKey = new Map<string, RevisionId>();
    const workingEvents = new Map<string, Pick<RawEvent, 'id' | 'participants'>>();
    const prefetchedEventIds = new Set<string>();

    for (const [key, row] of prefetchedRows.entries()) {
      if (key.startsWith('event:')) {
        const eventId = key.slice('event:'.length);
        prefetchedEventIds.add(eventId);
        if (row && !('edge' in row) && row.deleted_at === null) {
          const parsedEv = parseEntityPayload('event', row.data);
          workingEvents.set(parsedEv.id, { id: parsedEv.id, participants: parsedEv.participants });
        }
      }
    }

    for (const rev of batchRevisions) {
      const key = compositeKey(rev.entity_type, rev.entity_id);
      if (!currentStatesByKey.has(key)) {
        const row = prefetchedRows.get(key) ?? null;
        const working = rowToWorking(row);
        currentStatesByKey.set(key, working.lifecycle);
        if (row) {
          initialRevisionByKey.set(key, row.current_revision_id);
        }
      }
    }

    const outcome = transitionBatchRevertLifecycle(
      currentStatesByKey,
      batchRevisions,
      headRev + 1,
      {
        nowIso: this.clock.nowIso(),
        summaryPrefix: params.summary?.trim() || `Revert batch ${params.batchId}`,
      }
    );

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
        const validated = await this.validateAndSanitizePayload({
          entityType: step.entityType,
          requestedEntityId: step.entityId,
          rawPayload: step.revisionInsert.afterJson,
          hasPrimarySource,
          livingPersonIdsOverride: livingIds,
          extraEventsById: workingEvents,
          prefetchedEventIds,
        });
        sanitizedAfter = validated.sanitized;
        this.updateWorkingPrivacyContext(step.entityType, step.entityId, sanitizedAfter, livingIds, workingEvents);
      } else if (step.entityType === 'person') {
        livingIds.delete(step.entityId);
      } else if (step.entityType === 'event') {
        workingEvents.delete(step.entityId);
        prefetchedEventIds.add(step.entityId);
      }

      const alreadyLocked = lockedInitialByKey.has(step.entityKey);
      const expectedParent = alreadyLocked
        ? null
        : (initialRevisionByKey.get(step.entityKey) ?? null);
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

    const committed = await this.commitOrThrowConflict({
      batchId: null,
      author: params.author,
      operations,
    });
    const etag = await this.refreshBundleCache(committed.revisions, committed.head_revision_id);
    await this.notifyPlugins(committed.revisions, committed.head_revision_id);

    return {
      reverted_batch_id: params.batchId,
      revisions: committed.revisions,
      head_revision_id: committed.head_revision_id,
      etag,
    };
  }

  private async prefetchEntities(
    keys: readonly EntityLookupKey[]
  ): Promise<Map<string, StoredEntityRecord | null>> {
    if (keys.length === 0) {
      return new Map();
    }
    if (this.repository.getEntitiesBatch) {
      return this.repository.getEntitiesBatch(keys);
    }
    const unique: EntityLookupKey[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      const composite = compositeKey(key.entityType, key.entityId);
      if (seen.has(composite)) {
        continue;
      }
      seen.add(composite);
      unique.push(key);
    }
    const rows = await Promise.all(
      unique.map((key) => this.repository.getEntity(key.entityType, key.entityId))
    );
    const result = new Map<string, StoredEntityRecord | null>();
    for (let i = 0; i < unique.length; i += 1) {
      const key = unique[i];
      result.set(compositeKey(key.entityType, key.entityId), rows[i] ?? null);
    }
    return result;
  }

  private assertSummaryValid(summary: string): void {
    if (!isEditSummaryValid(summary)) {
      throw new KinloomHttpError(
        400,
        'VALIDATION_ERROR',
        'Edit summary must be at least 3 characters.'
      );
    }
  }

  private updateWorkingPrivacyContext(
    entityType: EntityType,
    entityId: string,
    sanitized: EntityPayload,
    livingIds: Set<string>,
    workingEvents: Map<string, Pick<RawEvent, 'id' | 'participants'>>
  ): void {
    if (entityType === 'person') {
      const parsed = sanitized as unknown as RawPerson;
      if (resolveEffectiveLiving(parsed, this.siteConfig.privacy)) {
        livingIds.add(entityId);
      } else {
        livingIds.delete(entityId);
      }
    } else if (entityType === 'event') {
      const parsed = sanitized as unknown as RawEvent;
      workingEvents.set(entityId, { id: parsed.id, participants: parsed.participants });
    }
  }

  private async validateAndSanitizePayload(params: {
    entityType: EntityType;
    requestedEntityId?: string;
    rawPayload: EntityPayload;
    hasPrimarySource: boolean;
    requireIdMatch?: boolean;
    livingPersonIdsOverride?: ReadonlySet<string>;
    extraEventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>;
    prefetchedEventIds?: ReadonlySet<string>;
  }): Promise<{ entityId: string; sanitized: EntityPayload }> {
    // Shallow-copy top-level fields before assigning id/has_primary_source;
    // parseEntityPayload() produces a freshly allocated validated record.
    const candidate: Record<string, unknown> = { ...params.rawPayload };
    if (candidate.extensions !== undefined) {
      candidate.extensions = structuredClone(candidate.extensions);
    }

    if (params.entityType === 'kinship_edge') {
      const parsedEdge = parseEntityPayload('kinship_edge', candidate);
      const derivedId = deriveKinshipEdgeId(parsedEdge);
      if (params.requireIdMatch && params.requestedEntityId && params.requestedEntityId !== derivedId) {
        throw new KinloomHttpError(
          400,
          'VALIDATION_ERROR',
          `Kinship edge ID mismatch: expected '${params.requestedEntityId}', derived '${derivedId}'.`
        );
      }
      return {
        entityId: params.requestedEntityId ?? derivedId,
        sanitized: parsedEdge as unknown as EntityPayload,
      };
    }

    const prefix = ENTITY_ID_PREFIX[params.entityType];
    const bodyId = typeof candidate.id === 'string' && candidate.id.trim().length > 0
      ? candidate.id.trim()
      : undefined;

    if (params.requireIdMatch && params.requestedEntityId && bodyId && bodyId !== params.requestedEntityId) {
      throw new KinloomHttpError(
        400,
        'VALIDATION_ERROR',
        `Payload id '${bodyId}' does not match path id '${params.requestedEntityId}'.`
      );
    }

    const entityId = params.requestedEntityId ?? bodyId ?? generateEntityId(prefix);
    candidate.id = entityId;
    candidate.has_primary_source = params.hasPrimarySource;

    switch (params.entityType) {
      case 'person': {
        const parsed = parseEntityPayload('person', candidate);
        const sanitized = sanitizePersonForWrite(parsed, this.siteConfig.privacy);
        return { entityId, sanitized: sanitized as unknown as EntityPayload };
      }
      case 'event': {
        const parsed = parseEntityPayload('event', candidate);
        const livingIds = params.livingPersonIdsOverride ?? (await this.repository.getLivingPersonIds());
        const sanitized = sanitizeEventForWrite(parsed, livingIds, this.siteConfig.privacy);
        return { entityId, sanitized: sanitized as unknown as EntityPayload };
      }
      case 'media': {
        const parsed = parseEntityPayload('media', candidate);
        const livingIds = params.livingPersonIdsOverride ?? (await this.repository.getLivingPersonIds());
        let eventsMap: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>> | undefined =
          params.extraEventsById;
        if (
          parsed.event_id &&
          !params.extraEventsById?.has(parsed.event_id) &&
          !params.prefetchedEventIds?.has(parsed.event_id)
        ) {
          const evRow = await this.repository.getEntity('event', parsed.event_id);
          if (evRow && !('edge' in evRow) && evRow.deleted_at === null) {
            const parsedEv = parseEntityPayload('event', evRow.data);
            const nextEvents = new Map(params.extraEventsById ?? []);
            nextEvents.set(parsedEv.id, parsedEv);
            eventsMap = nextEvents;
          }
        }
        assertMediaAllowedForPrivacy(parsed, livingIds, eventsMap);
        return { entityId, sanitized: parsed as unknown as EntityPayload };
      }
      case 'place': {
        const parsed = parseEntityPayload('place', candidate);
        return { entityId, sanitized: parsed as unknown as EntityPayload };
      }
      case 'source': {
        const parsed = parseEntityPayload('source', candidate);
        return { entityId, sanitized: parsed as unknown as EntityPayload };
      }
      case 'narrative': {
        const parsed = parseEntityPayload('narrative', candidate);
        return { entityId, sanitized: parsed as unknown as EntityPayload };
      }
      default: {
        const _exhaustive: never = params.entityType;
        throw new Error(`Unhandled entity type: ${String(_exhaustive)}`);
      }
    }
  }

  private async buildConflictHttpError(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    existing: StoredEntityRecord;
    candidateAfter: EntityPayload | null;
  }): Promise<KinloomHttpError> {
    const history = await this.repository.listRevisions({
      entity_type: params.entityType,
      entity_id: params.entityId,
      limit: 1,
    });
    const lastAuthorName = history.items[0]?.author_name ?? 'Unknown editor';
    const serverEntity = params.existing.deleted_at === null ? rowToPayload(params.existing) : null;
    const conflict: OptimisticConflictError = {
      kind: 'conflict',
      entity_type: params.entityType,
      entity_id: params.entityId,
      expected_parent_revision_id: params.expectedParentRevisionId,
      server_revision_id: params.existing.current_revision_id,
      server_entity: serverEntity,
      server_deleted_at: params.existing.deleted_at,
      last_author_name: lastAuthorName,
      last_updated_at: params.existing.updated_at,
      diff: computeEntityDiff(serverEntity, params.candidateAfter),
    };
    return new KinloomHttpError(
      409,
      'OPTIMISTIC_CONFLICT',
      `Entity ${params.entityType}/${params.entityId} was modified by another editor.`,
      conflict
    );
  }

  private async commitOrThrowConflict(params: {
    batchId: BatchId | null;
    author: RevisionAuthor;
    operations: readonly AtomicMutationOp[];
  }): Promise<{ head_revision_id: RevisionId; revisions: readonly RevisionRecord[] }> {
    const result = await this.repository.commitAtomicMutations({
      batch_id: params.batchId,
      author: params.author,
      nowIso: this.clock.nowIso(),
      operations: params.operations,
    });
    if (result.kind === 'conflict') {
      throw new KinloomHttpError(
        409,
        'OPTIMISTIC_CONFLICT',
        `Entity ${result.entity_type}/${result.entity_id} was modified by another editor.`,
        result
      );
    }
    return {
      head_revision_id: result.head_revision_id,
      revisions: result.revisions,
    };
  }

  private async refreshBundleCache(
    committedRevisions: readonly RevisionRecord[],
    headRevisionId: RevisionId
  ): Promise<string> {
    if (this.bundleCache.applyMutationsAndStore && committedRevisions.length > 0) {
      const cached = await this.bundleCache.getCached(null);
      const firstNewRevId = committedRevisions[0].revision_id;
      if (cached.status === 'hit' && cached.object.revision_id === firstNewRevId - 1) {
        const previousBundle =
          cached.object.parsedBundle ??
          (JSON.parse(await readBodyToString(cached.object.body)) as ArchiveBundle);
        const patched = await this.bundleCache.applyMutationsAndStore(
          previousBundle,
          committedRevisions
        );
        return patched.etag;
      }
    }

    // When the first committed revision is r1, no earlier revisions existed in the archive,
    // so we can materialize the active snapshot directly without a full DB roundtrip.
    const snapshot =
      committedRevisions.length > 0 && committedRevisions[0].revision_id === 1
        ? buildInitialSnapshotFromRevisions(committedRevisions, headRevisionId)
        : await this.repository.loadActiveSnapshot();
    const rebuilt = await this.bundleCache.rebuildAndStore(snapshot);
    return rebuilt.etag || `"r${headRevisionId}"`;
  }

  private async notifyPlugins(
    revisions: readonly RevisionRecord[],
    headRevisionId: RevisionId
  ): Promise<void> {
    for (const plugin of this.plugins) {
      if (!plugin.onRevisionCommitted) {
        continue;
      }
      try {
        await plugin.onRevisionCommitted({ revisions, headRevisionId });
      } catch (err) {
        this.onPluginError?.(plugin.id, err);
      }
    }
  }
}
