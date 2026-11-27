import {
  type ArchiveBundle,
  ArchiveBundleSchema,
  type ArchiveRawSnapshot,
  type AtomicMutationOp,
  type AtomicMutationStore,
  asRevisionId,
  type BatchId,
  type BundleCache,
  type Clock,
  computeEntityDiff,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  fastLocaleCompare,
  isTrustedArchiveBundle,
  type KinloomServerPlugin,
  type OptimisticConflictError,
  parseEntityPayload,
  type RevisionAuthor,
  type RevisionId,
  type RevisionLogStore,
  type RevisionRecord,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
} from '@kinloom/core';
import { readBodyToString } from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';
import { extractSlug, rowToPayload } from './payloadPolicy.js';

export interface WikiCommitPipelineDeps {
  readonly repository: EntityReadStore & AtomicMutationStore & RevisionLogStore;
  readonly bundleCache: BundleCache;
  readonly clock: Clock;
  readonly plugins: readonly KinloomServerPlugin[];
  readonly onPluginError?: (pluginId: string, error: unknown) => void;
}

export function buildInitialSnapshotFromRevisions(
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

    const key = entityLookupCompositeKey(rev.entity_type, rev.entity_id);
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
      ? fastLocaleCompare(a.entity_id, b.entity_id)
      : fastLocaleCompare(a.entity_type, b.entity_type)
  );
  const kinship = [...kinshipById.values()].toSorted((a, b) => fastLocaleCompare(a.edge_id, b.edge_id));

  return {
    head_revision_id: headRevisionId,
    entities,
    kinship,
  };
}

export class WikiCommitPipeline {
  constructor(private readonly deps: WikiCommitPipelineDeps) {}

  async buildConflictHttpError(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    existing: StoredEntityRecord;
    candidateAfter: EntityPayload | null;
  }): Promise<KinloomHttpError> {
    const history = await this.deps.repository.listRevisions({
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

  async commitAndPropagate(params: {
    batchId: BatchId | null;
    author: RevisionAuthor;
    operations: readonly AtomicMutationOp[];
  }): Promise<{
    head_revision_id: RevisionId;
    revisions: readonly RevisionRecord[];
    etag: string;
  }> {
    const result = await this.deps.repository.commitAtomicMutations({
      batch_id: params.batchId,
      author: params.author,
      nowIso: this.deps.clock.nowIso(),
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

    const etag = await this.refreshBundleCache(result.revisions, result.head_revision_id);
    await this.notifyPlugins(result.revisions, result.head_revision_id);

    return {
      head_revision_id: result.head_revision_id,
      revisions: result.revisions,
      etag,
    };
  }

  private async refreshBundleCache(
    committedRevisions: readonly RevisionRecord[],
    headRevisionId: RevisionId
  ): Promise<string> {
    if (committedRevisions.length > 0 && this.deps.bundleCache.tryApplyMutationsFromMemo) {
      const fastPatched = await this.deps.bundleCache.tryApplyMutationsFromMemo(committedRevisions);
      if (fastPatched !== null) {
        return fastPatched.etag;
      }
    }

    if (this.deps.bundleCache.applyMutationsAndStore && committedRevisions.length > 0) {
      const cached = await this.deps.bundleCache.getCached(null);
      const firstNewRevId = committedRevisions[0].revision_id;
      if (cached.status === 'hit') {
        if (cached.object.revision_id === firstNewRevId - 1) {
          let previousBundle: ArchiveBundle | null = null;
          if (cached.object.parsedBundle !== undefined) {
            if (isTrustedArchiveBundle(cached.object.parsedBundle)) {
              previousBundle = cached.object.parsedBundle;
            } else {
              const parsed = ArchiveBundleSchema.safeParse(cached.object.parsedBundle);
              if (parsed.success) {
                previousBundle = parsed.data;
              }
            }
            if (typeof cached.object.body !== 'string') {
              await cached.object.body.cancel().catch(() => undefined);
            }
          } else {
            try {
              const decoded: unknown = JSON.parse(await readBodyToString(cached.object.body));
              const parsed = ArchiveBundleSchema.safeParse(decoded);
              if (parsed.success) {
                previousBundle = parsed.data;
              }
            } catch {
              previousBundle = null;
            }
          }
          if (previousBundle !== null) {
            const patched = await this.deps.bundleCache.applyMutationsAndStore(
              previousBundle,
              committedRevisions
            );
            return patched.etag;
          }
        } else if (typeof cached.object.body !== 'string') {
          await cached.object.body.cancel().catch(() => undefined);
        }
      }
    }

    // When the first committed revision is r1, materialize the active snapshot directly without a full DB roundtrip.
    const snapshot =
      committedRevisions.length > 0 && committedRevisions[0].revision_id === 1
        ? buildInitialSnapshotFromRevisions(committedRevisions, headRevisionId)
        : await this.deps.repository.loadActiveSnapshot();
    const rebuilt = await this.deps.bundleCache.rebuildAndStore(snapshot);
    return rebuilt.etag || `"r${headRevisionId}"`;
  }

  private async notifyPlugins(
    revisions: readonly RevisionRecord[],
    headRevisionId: RevisionId
  ): Promise<void> {
    for (const plugin of this.deps.plugins) {
      if (!plugin.onRevisionCommitted) {
        continue;
      }
      try {
        await plugin.onRevisionCommitted({ revisions, headRevisionId });
      } catch (err) {
        this.deps.onPluginError?.(plugin.id, err);
      }
    }
  }
}
