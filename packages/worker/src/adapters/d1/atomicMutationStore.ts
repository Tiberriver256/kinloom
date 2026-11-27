import {
  type AtomicMutationOp,
  type AtomicMutationStore,
  asRevisionId,
  type BatchId,
  type CommitMutationsResult,
  computeEntityDiff,
  type EntityReadStore,
  type OptimisticConflictError,
  parseEntityPayload,
  type RevisionAuthor,
  type RevisionRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
} from '@kinloom/core';
import type { D1Database, D1PreparedStatement } from '../../types.js';
import { pushCreateRunStatements, type RevisionResultEntry } from './createRunStatements.js';
import {
  parseDbAuthorNameRow,
  parseDbReturningRevisionIdRow,
  parseDbReturningRevisionPairRow,
} from './rowMappers.js';
import {
  buildCommittedRevisionRecord,
  entityCompositeKey,
  isSqliteConstraintError,
  prepareD1Statement,
  resolveSlugForOp,
  rowToEntityPayload,
} from './sqlHelpers.js';

export class D1AtomicMutationStore implements AtomicMutationStore {
  constructor(
    private readonly db: D1Database,
    private readonly readStore: Pick<EntityReadStore, 'getHeadRevisionId' | 'getEntity'> & {
      getEntitiesBatch: NonNullable<EntityReadStore['getEntitiesBatch']>;
    }
  ) {}

  async commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    if (params.operations.length === 0) {
      return {
        kind: 'committed',
        head_revision_id: await this.readStore.getHeadRevisionId(),
        revisions: [],
      };
    }

    const statements: D1PreparedStatement[] = [];
    const revisionResultEntries: RevisionResultEntry[] = [];
    const mutatedInBatch = new Set<string>();
    const ops = params.operations;

    for (let i = 0; i < ops.length; i += 1) {
      const op = ops[i];
      const key = entityCompositeKey(op.entity_type, op.entity_id);

      if (op.action === 'create') {
        let runEnd = i;
        while (runEnd < ops.length && ops[runEnd].action === 'create') {
          mutatedInBatch.add(entityCompositeKey(ops[runEnd].entity_type, ops[runEnd].entity_id));
          runEnd += 1;
        }
        pushCreateRunStatements(this.db, {
          ops: ops.slice(i, runEnd),
          batchId: params.batch_id,
          author: params.author,
          nowIso: params.nowIso,
          statements,
          revisionResultEntries,
        });
        i = runEnd - 1;
        continue;
      }

      const alreadyMutatedInBatch = mutatedInBatch.has(key);

      if (op.expected_parent_revision_id === null && !alreadyMutatedInBatch) {
        return this.buildConflictForOp(op, params.nowIso);
      }

      const revStmt = this.buildRevisionInsertStatement({
        op,
        batchId: params.batch_id,
        author: params.author,
        nowIso: params.nowIso,
        alreadyMutatedInBatch,
      });
      revisionResultEntries.push({
        stmtIndex: statements.length,
        kind: 'single',
        ops: [op],
      });
      statements.push(revStmt);

      statements.push(this.buildEntityMutationStatement(op, params.nowIso));
      mutatedInBatch.add(key);
    }

    try {
      const results = await this.db.batch(statements);
      const committedRevisions: RevisionRecord[] = [];
      for (const entry of revisionResultEntries) {
        const rawRows = results[entry.stmtIndex]?.results ?? [];
        if (entry.kind === 'create') {
          const revRows = rawRows.map(parseDbReturningRevisionIdRow);
          if (revRows.length !== entry.ops.length) {
            throw new Error(
              `D1 create revision insert returned ${revRows.length} rows for ${entry.ops.length} operations.`
            );
          }
          // RETURNING order is unspecified; AUTOINCREMENT revision_id follows insertion order.
          const sortedIds = revRows.toSorted((a, b) => a.revision_id - b.revision_id);
          for (let j = 0; j < sortedIds.length; j += 1) {
            committedRevisions.push(
              buildCommittedRevisionRecord({
                revisionId: sortedIds[j].revision_id,
                parentRevisionId: null,
                op: entry.ops[j],
                batchId: params.batch_id,
                author: params.author,
                nowIso: params.nowIso,
              })
            );
          }
        } else {
          const firstRow = rawRows[0];
          if (!firstRow) {
            throw new Error('D1 revision insert did not return the inserted revision row.');
          }
          const revRow = parseDbReturningRevisionPairRow(firstRow);
          committedRevisions.push(
            buildCommittedRevisionRecord({
              revisionId: revRow.revision_id,
              parentRevisionId: revRow.parent_revision_id,
              op: entry.ops[0],
              batchId: params.batch_id,
              author: params.author,
              nowIso: params.nowIso,
            })
          );
        }
      }
      if (committedRevisions.length !== ops.length) {
        throw new Error(
          `D1 batch returned ${committedRevisions.length} revisions for ${ops.length} operations.`
        );
      }
      const lastRevision = committedRevisions[committedRevisions.length - 1];
      return {
        kind: 'committed',
        head_revision_id: asRevisionId(lastRevision.revision_id),
        revisions: committedRevisions,
      };
    } catch (error) {
      if (!isSqliteConstraintError(error)) {
        throw error;
      }
      return this.resolveConstraintConflict(params.operations, params.nowIso, error);
    }
  }

  private buildRevisionInsertStatement(params: {
    op: AtomicMutationOp;
    batchId: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    alreadyMutatedInBatch: boolean;
  }): D1PreparedStatement {
    const { op, batchId, author, nowIso, alreadyMutatedInBatch } = params;
    const beforeJson = op.before_json !== null ? JSON.stringify(op.before_json) : null;
    const afterJson = op.after_json !== null ? JSON.stringify(op.after_json) : null;
    const hasPrimary = op.has_primary_source ? 1 : 0;
    const revertedRevId = op.reverted_revision_id ?? null;

    const lockWhere = this.buildLockWhereClause(op, alreadyMutatedInBatch);

    if (op.action === 'restore') {
      // Guard restore atomically through the action CHECK constraint so stale or active rows roll back DB.batch().
      return prepareD1Statement(
        this.db,
        `INSERT INTO revisions (
             batch_id, entity_type, entity_id, parent_revision_id, action,
             reverted_revision_id, author_id, author_name, author_type,
             summary, has_primary_source, before_json, after_json, created_at
           ) VALUES (
             ?, ?, ?,
             (SELECT current_revision_id FROM ${lockWhere.table} WHERE ${lockWhere.sql}),
             CASE
               WHEN EXISTS (SELECT 1 FROM ${lockWhere.table} WHERE ${lockWhere.sql}) THEN 'restore'
               ELSE 'invalid_restore_lock'
             END,
             ?, ?, ?, ?, ?, ?, ?, ?, ?
           )
           RETURNING revision_id, parent_revision_id`
      ).bind(
        batchId,
        op.entity_type,
        op.entity_id,
        ...lockWhere.bindings,
        ...lockWhere.bindings,
        revertedRevId,
        author.author_id,
        author.author_name,
        author.author_type,
        op.summary,
        hasPrimary,
        beforeJson,
        afterJson,
        nowIso
      );
    }

    return prepareD1Statement(
      this.db,
      `INSERT INTO revisions (
           batch_id, entity_type, entity_id, parent_revision_id, action,
           reverted_revision_id, author_id, author_name, author_type,
           summary, has_primary_source, before_json, after_json, created_at
         ) VALUES (
           ?, ?, ?,
           (SELECT current_revision_id FROM ${lockWhere.table} WHERE ${lockWhere.sql}),
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )
         RETURNING revision_id, parent_revision_id`
    ).bind(
      batchId,
      op.entity_type,
      op.entity_id,
      ...lockWhere.bindings,
      op.action,
      revertedRevId,
      author.author_id,
      author.author_name,
      author.author_type,
      op.summary,
      hasPrimary,
      beforeJson,
      afterJson,
      nowIso
    );
  }

  private buildLockWhereClause(
    op: AtomicMutationOp,
    alreadyMutatedInBatch: boolean
  ): { table: 'entities' | 'kinship_edges'; sql: string; bindings: unknown[] } {
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (op.entity_type === 'kinship_edge') {
      conditions.push('edge_id = ?');
      bindings.push(op.entity_id);
    } else {
      conditions.push('entity_type = ?', 'entity_id = ?');
      bindings.push(op.entity_type, op.entity_id);
    }

    if (op.expected_parent_revision_id !== null) {
      conditions.push('current_revision_id = ?');
      bindings.push(op.expected_parent_revision_id);
    } else if (!alreadyMutatedInBatch) {
      conditions.push('1 = 0');
    }

    if (op.action === 'update' || op.action === 'delete') {
      conditions.push('deleted_at IS NULL');
    } else if (op.action === 'restore') {
      conditions.push('deleted_at IS NOT NULL');
    }

    return {
      table: op.entity_type === 'kinship_edge' ? 'kinship_edges' : 'entities',
      sql: conditions.join(' AND '),
      bindings,
    };
  }

  private buildEntityMutationStatement(op: AtomicMutationOp, nowIso: string): D1PreparedStatement {
    const isSoftDelete = op.soft_delete === true || op.action === 'delete' || op.after_json === null;
    const deletedAt = isSoftDelete ? nowIso : null;

    if (op.entity_type === 'kinship_edge') {
      if (op.after_json !== null) {
        const edge = parseEntityPayload('kinship_edge', op.after_json);
        return prepareD1Statement(
          this.db,
          `UPDATE kinship_edges
             SET from_person_id = ?, to_person_id = ?, relation = ?, family_xref = ?,
                 current_revision_id = last_insert_rowid(), deleted_at = ?, updated_at = ?
             WHERE edge_id = ?`
        ).bind(edge.from, edge.to, edge.relation, edge.family_xref ?? null, deletedAt, nowIso, op.entity_id);
      }

      return prepareD1Statement(
        this.db,
        `UPDATE kinship_edges
           SET current_revision_id = last_insert_rowid(), deleted_at = ?, updated_at = ?
           WHERE edge_id = ?`
      ).bind(deletedAt, nowIso, op.entity_id);
    }

    const hasPrimary = op.has_primary_source ? 1 : 0;

    if (op.after_json !== null) {
      const slugInfo = resolveSlugForOp(op);
      if (slugInfo.updateSlug) {
        return prepareD1Statement(
          this.db,
          `UPDATE entities
             SET slug = ?, data_json = ?, current_revision_id = last_insert_rowid(),
                 has_primary_source = ?, deleted_at = ?, updated_at = ?
             WHERE entity_type = ? AND entity_id = ?`
        ).bind(
          slugInfo.value,
          JSON.stringify(op.after_json),
          hasPrimary,
          deletedAt,
          nowIso,
          op.entity_type,
          op.entity_id
        );
      }

      return prepareD1Statement(
        this.db,
        `UPDATE entities
           SET data_json = ?, current_revision_id = last_insert_rowid(),
               has_primary_source = ?, deleted_at = ?, updated_at = ?
           WHERE entity_type = ? AND entity_id = ?`
      ).bind(JSON.stringify(op.after_json), hasPrimary, deletedAt, nowIso, op.entity_type, op.entity_id);
    }

    return prepareD1Statement(
      this.db,
      `UPDATE entities
         SET current_revision_id = last_insert_rowid(),
             has_primary_source = ?, deleted_at = ?, updated_at = ?
         WHERE entity_type = ? AND entity_id = ?`
    ).bind(hasPrimary, deletedAt, nowIso, op.entity_type, op.entity_id);
  }

  private async resolveConstraintConflict(
    operations: readonly AtomicMutationOp[],
    nowIso: string,
    originalError: unknown
  ): Promise<OptimisticConflictError> {
    const existingByKey = await this.readStore.getEntitiesBatch(
      operations.map((op) => ({ entityType: op.entity_type, entityId: op.entity_id }))
    );
    const seenInBatch = new Set<string>();

    for (const op of operations) {
      const key = entityCompositeKey(op.entity_type, op.entity_id);
      const alreadySeen = seenInBatch.has(key);
      const existing = existingByKey.get(key) ?? null;

      if (op.action === 'create') {
        if (existing !== null || alreadySeen) {
          return this.buildConflictFromExisting(op, existing, nowIso);
        }
        seenInBatch.add(key);
        continue;
      }

      if (alreadySeen && op.expected_parent_revision_id === null) {
        continue;
      }

      if (existing === null) {
        return this.buildConflictFromExisting(op, null, nowIso);
      }

      if (
        op.expected_parent_revision_id === null ||
        existing.current_revision_id !== op.expected_parent_revision_id
      ) {
        return this.buildConflictFromExisting(op, existing, nowIso);
      }

      if ((op.action === 'update' || op.action === 'delete') && existing.deleted_at !== null) {
        return this.buildConflictFromExisting(op, existing, nowIso);
      }

      if (op.action === 'restore' && existing.deleted_at === null) {
        return this.buildConflictFromExisting(op, existing, nowIso);
      }

      seenInBatch.add(key);
    }

    const fallbackOp = operations[0];
    if (fallbackOp) {
      const existing = await this.readStore.getEntity(fallbackOp.entity_type, fallbackOp.entity_id);
      return this.buildConflictFromExisting(fallbackOp, existing, nowIso);
    }
    throw originalError;
  }

  private async buildConflictForOp(op: AtomicMutationOp, nowIso: string): Promise<OptimisticConflictError> {
    const existing = await this.readStore.getEntity(op.entity_type, op.entity_id);
    return this.buildConflictFromExisting(op, existing, nowIso);
  }

  private async buildConflictFromExisting(
    op: AtomicMutationOp,
    existing: StoredEntityRow | StoredKinshipRow | null,
    nowIso: string
  ): Promise<OptimisticConflictError> {
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
        last_updated_at: nowIso,
        diff: computeEntityDiff(null, op.after_json),
      };
    }

    const lastRevRaw = await prepareD1Statement(
      this.db,
      `SELECT author_name
         FROM revisions
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY revision_id DESC
         LIMIT 1`
    )
      .bind(op.entity_type, op.entity_id)
      .first<unknown>();
    const lastRev = lastRevRaw !== null ? parseDbAuthorNameRow(lastRevRaw) : null;

    const serverEntity = existing.deleted_at === null ? rowToEntityPayload(existing) : null;
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
}
