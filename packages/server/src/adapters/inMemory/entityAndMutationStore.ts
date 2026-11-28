import {
  type ArchiveRawSnapshot,
  type AtomicMutationOp,
  type AtomicMutationStore,
  asRevisionId,
  type BatchId,
  type Clock,
  type CommitMutationsResult,
  computeEntityDiff,
  type EntityLookupKey,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  type KinshipEdge,
  type OptimisticConflictError,
  type PrivacyConfig,
  parseEntityPayload,
  type RevisionAuthor,
  type RevisionId,
  type RevisionLogStore,
  type RevisionQuery,
  type RevisionRecord,
  resolveEffectiveLiving,
  type StewardReviewStamp,
  type StewardReviewTargetKind,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  storedRecordToEntityPayload,
} from '@kinloom/core';
import { SystemClock } from '../systemClock.js';

function entityCompositeKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function getRowPayload(row: StoredEntityRow | StoredKinshipRow): EntityPayload {
  return storedRecordToEntityPayload(row);
}

/**
 * In-memory entity, kinship, and append-only revision store with atomic clone-and-swap rollback.
 */
export class InMemoryEntityAndMutationStore
  implements EntityReadStore, AtomicMutationStore, RevisionLogStore
{
  private readonly entities = new Map<string, StoredEntityRow>();
  private readonly kinship = new Map<string, StoredKinshipRow>();
  private readonly revisions: RevisionRecord[] = [];
  private readonly stewardReviews = new Map<string, StewardReviewStamp>();
  private readonly privacyConfig?: Partial<PrivacyConfig> | undefined;
  private readonly clock: Clock;

  constructor(options?: { privacyConfig?: Partial<PrivacyConfig>; clock?: Clock }) {
    this.privacyConfig = options?.privacyConfig;
    this.clock = options?.clock ?? new SystemClock();
  }

  async getHeadRevisionId(): Promise<RevisionId> {
    const last = this.revisions[this.revisions.length - 1];
    return asRevisionId(last ? last.revision_id : 0);
  }

  async getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null> {
    if (entityType === 'kinship_edge') {
      const row = this.kinship.get(entityId);
      return row ? structuredClone(row) : null;
    }
    const row = this.entities.get(entityCompositeKey(entityType, entityId));
    return row ? structuredClone(row) : null;
  }

  async getEntityBySlug(
    entityType: 'person' | 'place' | 'narrative',
    slugOrId: string
  ): Promise<StoredEntityRow | null> {
    const byId = this.entities.get(entityCompositeKey(entityType, slugOrId));
    if (byId && byId.deleted_at === null) {
      return structuredClone(byId);
    }
    for (const row of this.entities.values()) {
      if (row.entity_type !== entityType || row.deleted_at !== null) {
        continue;
      }
      if (row.slug === slugOrId || row.entity_id === slugOrId) {
        return structuredClone(row);
      }
      const rawDataSlug = (row.data as Record<string, unknown>)['slug'];
      if (typeof rawDataSlug === 'string' && rawDataSlug === slugOrId) {
        return structuredClone(row);
      }
    }
    return null;
  }

  async getEntitiesBatch(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>> {
    const result = new Map<string, StoredEntityRecord | null>();
    for (const key of keys) {
      const composite = entityLookupCompositeKey(key.entityType, key.entityId);
      if (result.has(composite)) {
        continue;
      }
      if (key.entityType === 'kinship_edge') {
        const row = this.kinship.get(key.entityId);
        result.set(composite, row ? structuredClone(row) : null);
      } else {
        const row = this.entities.get(composite);
        result.set(composite, row ? structuredClone(row) : null);
      }
    }
    return result;
  }

  async getLivingPersonIds(): Promise<ReadonlySet<string>> {
    const living = new Set<string>();
    for (const row of this.entities.values()) {
      if (row.entity_type !== 'person' || row.deleted_at !== null) {
        continue;
      }
      const parsed = parseEntityPayload('person', row.data);
      if (resolveEffectiveLiving(parsed, this.privacyConfig, this.clock.currentYear())) {
        living.add(row.entity_id);
      }
    }
    return living;
  }

  async loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    const activeEntities: StoredEntityRow[] = [];
    for (const row of this.entities.values()) {
      if (row.deleted_at === null) {
        activeEntities.push(structuredClone(row));
      }
    }
    activeEntities.sort(
      (a, b) => a.entity_type.localeCompare(b.entity_type) || a.entity_id.localeCompare(b.entity_id)
    );

    const activeKinship: StoredKinshipRow[] = [];
    for (const row of this.kinship.values()) {
      if (row.deleted_at === null) {
        activeKinship.push(structuredClone(row));
      }
    }
    activeKinship.sort((a, b) => a.edge_id.localeCompare(b.edge_id));

    return {
      head_revision_id: await this.getHeadRevisionId(),
      entities: activeEntities,
      kinship: activeKinship,
    };
  }

  private findLastRevisionForEntity(
    entityType: EntityType,
    entityId: string,
    workingRevisions: readonly RevisionRecord[]
  ): RevisionRecord | null {
    for (let i = workingRevisions.length - 1; i >= 0; i -= 1) {
      const rev = workingRevisions[i];
      if (rev && rev.entity_type === entityType && rev.entity_id === entityId) {
        return rev;
      }
    }
    return null;
  }

  private buildConflict(
    op: AtomicMutationOp,
    existing: StoredEntityRow | StoredKinshipRow,
    workingRevisions: readonly RevisionRecord[]
  ): OptimisticConflictError {
    const lastRev = this.findLastRevisionForEntity(op.entity_type, op.entity_id, workingRevisions);
    const serverEntity = existing.deleted_at === null ? getRowPayload(existing) : null;
    return {
      kind: 'conflict',
      entity_type: op.entity_type,
      entity_id: op.entity_id,
      expected_parent_revision_id: op.expected_parent_revision_id,
      server_revision_id: existing.current_revision_id,
      server_entity: serverEntity,
      server_deleted_at: existing.deleted_at,
      last_author_name: lastRev?.author_name ?? 'Unknown editor',
      last_updated_at: existing.updated_at,
      diff: computeEntityDiff(serverEntity, op.after_json),
    };
  }

  async commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    // Stage writes in isolated clones so any optimistic-lock conflict rolls back atomically.
    const workingEntities = new Map<string, StoredEntityRow>();
    for (const [key, row] of this.entities.entries()) {
      workingEntities.set(key, structuredClone(row));
    }
    const workingKinship = new Map<string, StoredKinshipRow>();
    for (const [key, row] of this.kinship.entries()) {
      workingKinship.set(key, structuredClone(row));
    }
    const workingRevisions = [...this.revisions];
    const stagedRevisions: RevisionRecord[] = [];
    const mutatedInBatch = new Set<string>();

    let nextRevNum = (workingRevisions[workingRevisions.length - 1]?.revision_id ?? 0) + 1;

    for (const op of params.operations) {
      const key = entityCompositeKey(op.entity_type, op.entity_id);
      const existing: StoredEntityRow | StoredKinshipRow | null =
        op.entity_type === 'kinship_edge'
          ? (workingKinship.get(op.entity_id) ?? null)
          : (workingEntities.get(key) ?? null);

      const alreadyMutatedInBatch = mutatedInBatch.has(key);

      if (op.action === 'create') {
        if (existing !== null) {
          return this.buildConflict(op, existing, workingRevisions);
        }
      } else {
        if (existing === null) {
          return {
            kind: 'conflict',
            entity_type: op.entity_type,
            entity_id: op.entity_id,
            expected_parent_revision_id: op.expected_parent_revision_id,
            server_revision_id: asRevisionId(0),
            server_entity: null,
            server_deleted_at: null,
            last_author_name: 'None',
            last_updated_at: params.nowIso,
            diff: computeEntityDiff(null, op.after_json),
          };
        }

        if (op.expected_parent_revision_id !== null) {
          if (existing.current_revision_id !== op.expected_parent_revision_id) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        } else if (!alreadyMutatedInBatch) {
          return this.buildConflict(op, existing, workingRevisions);
        }

        if (op.action === 'update' || op.action === 'delete') {
          if (existing.deleted_at !== null) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        } else if (op.action === 'restore') {
          if (existing.deleted_at === null) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        }
      }

      const assignedRevId = asRevisionId(nextRevNum);
      nextRevNum += 1;

      const parentRevId = existing ? existing.current_revision_id : null;
      const revRecord: RevisionRecord = {
        revision_id: assignedRevId,
        batch_id: params.batch_id,
        entity_type: op.entity_type,
        entity_id: op.entity_id,
        parent_revision_id: parentRevId,
        action: op.action,
        reverted_revision_id: op.reverted_revision_id ?? null,
        author_id: params.author.author_id,
        author_name: params.author.author_name,
        author_type: params.author.author_type,
        summary: op.summary,
        has_primary_source: op.has_primary_source,
        before_json: op.before_json ? structuredClone(op.before_json) : null,
        after_json: op.after_json ? structuredClone(op.after_json) : null,
        created_at: params.nowIso,
      };

      const isSoftDelete = op.soft_delete === true || op.action === 'delete' || op.after_json === null;

      if (op.entity_type === 'kinship_edge') {
        const nextEdge: KinshipEdge = op.after_json
          ? parseEntityPayload('kinship_edge', op.after_json)
          : (existing as StoredKinshipRow).edge;
        const nextRow: StoredKinshipRow = {
          edge_id: op.entity_id,
          edge: structuredClone(nextEdge),
          current_revision_id: assignedRevId,
          deleted_at: isSoftDelete ? params.nowIso : null,
          updated_at: params.nowIso,
        };
        workingKinship.set(op.entity_id, nextRow);
      } else {
        const prevRow = existing as StoredEntityRow | null;
        if (!op.after_json && !prevRow) {
          throw new Error(`Missing prior entity payload for ${op.entity_type}:${op.entity_id}`);
        }
        const nextData: EntityPayload = op.after_json
          ? structuredClone(op.after_json)
          : structuredClone((prevRow as StoredEntityRow).data);
        const nextSlug =
          op.slug !== undefined
            ? op.slug
            : typeof nextData['slug'] === 'string'
              ? nextData['slug']
              : (prevRow?.slug ?? null);
        const nextRow: StoredEntityRow = {
          entity_type: op.entity_type,
          entity_id: op.entity_id,
          slug: nextSlug,
          data: nextData,
          current_revision_id: assignedRevId,
          has_primary_source: op.has_primary_source,
          deleted_at: isSoftDelete ? params.nowIso : null,
          updated_at: params.nowIso,
        };
        workingEntities.set(key, nextRow);
      }

      workingRevisions.push(revRecord);
      stagedRevisions.push(revRecord);
      mutatedInBatch.add(key);
    }

    this.entities.clear();
    for (const [key, row] of workingEntities.entries()) {
      this.entities.set(key, row);
    }
    this.kinship.clear();
    for (const [key, row] of workingKinship.entries()) {
      this.kinship.set(key, row);
    }
    this.revisions.push(...stagedRevisions);

    return {
      kind: 'committed',
      head_revision_id: await this.getHeadRevisionId(),
      revisions: stagedRevisions.map((r) => structuredClone(r)),
    };
  }

  private attachStewardReview(rev: RevisionRecord): RevisionRecord {
    const cloned = structuredClone(rev);
    const direct = this.stewardReviews.get(`revision:${rev.revision_id}`);
    const inherited = !direct && rev.batch_id ? this.stewardReviews.get(`batch:${rev.batch_id}`) : undefined;
    const resolved = direct ?? inherited;
    if (resolved) {
      cloned.review = structuredClone(resolved);
    }
    return cloned;
  }

  async listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const filtered: RevisionRecord[] = [];
    for (let i = this.revisions.length - 1; i >= 0; i -= 1) {
      const rev = this.revisions[i];
      if (!rev) {
        continue;
      }
      if (query.cursor !== undefined && rev.revision_id >= query.cursor) {
        continue;
      }
      if (query.entity_type && rev.entity_type !== query.entity_type) {
        continue;
      }
      if (query.entity_id && rev.entity_id !== query.entity_id) {
        continue;
      }
      if (query.batch_id && rev.batch_id !== query.batch_id) {
        continue;
      }
      if (query.author_type && rev.author_type !== query.author_type) {
        continue;
      }
      filtered.push(this.attachStewardReview(rev));
      if (filtered.length > limit) {
        break;
      }
    }

    const hasMore = filtered.length > limit;
    const items = hasMore ? filtered.slice(0, limit) : filtered;
    const lastItem = items[items.length - 1];
    return {
      items,
      next_cursor: hasMore && lastItem ? asRevisionId(lastItem.revision_id) : null,
    };
  }

  async getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    const found = this.revisions.find((r) => r.revision_id === revisionId);
    return found ? this.attachStewardReview(found) : null;
  }

  async getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    return this.revisions
      .filter((r) => r.batch_id === batchId)
      .toSorted((a, b) => a.revision_id - b.revision_id)
      .map((r) => this.attachStewardReview(r));
  }

  async upsertStewardReview(input: {
    target_kind: StewardReviewTargetKind;
    target_id: string;
    reviewer_id: string;
    reviewer_name: string;
    note: string | null;
    reviewed_at: string;
  }): Promise<StewardReviewStamp> {
    const stamp: StewardReviewStamp = {
      target_kind: input.target_kind,
      target_id: input.target_id,
      reviewer_id: input.reviewer_id,
      reviewer_name: input.reviewer_name,
      note: input.note,
      reviewed_at: input.reviewed_at,
    };
    this.stewardReviews.set(`${input.target_kind}:${input.target_id}`, structuredClone(stamp));
    return structuredClone(stamp);
  }

  async deleteStewardReview(targetKind: StewardReviewTargetKind, targetId: string): Promise<boolean> {
    return this.stewardReviews.delete(`${targetKind}:${targetId}`);
  }
}
