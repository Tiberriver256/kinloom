import { type AtomicMutationOp, type BatchId, parseEntityPayload, type RevisionAuthor } from '@kinloom/core';
import type { D1Database, D1PreparedStatement } from '../../types.js';
import {
  chunkJsonArray,
  chunkJsonArrayWithRanges,
  prepareD1Statement,
  resolveSlugForOp,
} from './sqlHelpers.js';

export interface RevisionResultEntry {
  readonly stmtIndex: number;
  readonly kind: 'create' | 'update' | 'single';
  readonly ops: readonly AtomicMutationOp[];
}

export function pushCreateRunStatements(
  db: D1Database,
  params: {
    ops: readonly AtomicMutationOp[];
    batchId: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    statements: D1PreparedStatement[];
    revisionResultEntries: RevisionResultEntry[];
  }
): void {
  const { ops, batchId, author, nowIso, statements, revisionResultEntries } = params;

  const afterJsons = new Array<string>(ops.length);
  for (let i = 0; i < ops.length; i += 1) {
    const afterJson = ops[i].after_json;
    if (!afterJson) {
      throw new Error(`Create ${ops[i].entity_type} operation requires after_json.`);
    }
    afterJsons[i] = JSON.stringify(afterJson);
  }

  const firstSummary = ops[0].summary;
  const firstPrimary = ops[0].has_primary_source;
  const uniformMetadata = ops.every(
    (op) =>
      op.summary === firstSummary &&
      op.has_primary_source === firstPrimary &&
      op.before_json === null &&
      (op.reverted_revision_id ?? null) === null
  );

  if (uniformMetadata) {
    const compactRows = ops.map((op, i) => [op.entity_type, op.entity_id, afterJsons[i]]);
    const uniformPrimaryInt = firstPrimary ? 1 : 0;
    for (const chunk of chunkJsonArrayWithRanges(compactRows)) {
      revisionResultEntries.push({
        stmtIndex: statements.length,
        kind: 'create',
        ops: ops.slice(chunk.start, chunk.start + chunk.count),
      });
      statements.push(
        prepareD1Statement(
          db,
          `INSERT INTO revisions (
             batch_id, entity_type, entity_id, parent_revision_id, action,
             reverted_revision_id, author_id, author_name, author_type,
             summary, has_primary_source, before_json, after_json, created_at
           )
           SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), NULL, 'create',
                  NULL, ?, ?, ?, ?, ?, NULL, json_extract(value, '$[2]'), ?
           FROM json_each(?)
           RETURNING revision_id`
        ).bind(
          batchId,
          author.author_id,
          author.author_name,
          author.author_type,
          firstSummary,
          uniformPrimaryInt,
          nowIso,
          chunk.json
        )
      );
    }
  } else {
    const revisionRows = ops.map((op, i) => [
      op.entity_type,
      op.entity_id,
      op.reverted_revision_id ?? null,
      op.summary,
      op.has_primary_source ? 1 : 0,
      op.before_json !== null ? JSON.stringify(op.before_json) : null,
      afterJsons[i],
    ]);
    for (const chunk of chunkJsonArrayWithRanges(revisionRows)) {
      revisionResultEntries.push({
        stmtIndex: statements.length,
        kind: 'create',
        ops: ops.slice(chunk.start, chunk.start + chunk.count),
      });
      statements.push(
        prepareD1Statement(
          db,
          `INSERT INTO revisions (
             batch_id, entity_type, entity_id, parent_revision_id, action,
             reverted_revision_id, author_id, author_name, author_type,
             summary, has_primary_source, before_json, after_json, created_at
           )
           SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'), NULL, 'create',
                  json_extract(value, '$[2]'), ?, ?, ?,
                  json_extract(value, '$[3]'), json_extract(value, '$[4]'),
                  json_extract(value, '$[5]'), json_extract(value, '$[6]'), ?
           FROM json_each(?)
           RETURNING revision_id`
        ).bind(batchId, author.author_id, author.author_name, author.author_type, nowIso, chunk.json)
      );
    }
  }

  const entityRows: unknown[] = [];
  const kinshipRows: unknown[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i];
    const afterPayload = op.after_json;
    if (!afterPayload) {
      throw new Error(`Create ${op.entity_type} operation requires after_json.`);
    }
    const deletedAt = op.soft_delete === true ? nowIso : null;
    if (op.entity_type === 'kinship_edge') {
      const edge = parseEntityPayload('kinship_edge', afterPayload);
      kinshipRows.push([
        op.entity_id,
        edge.from,
        edge.to,
        edge.relation,
        edge.family_xref ?? null,
        deletedAt,
      ]);
    } else {
      entityRows.push([
        op.entity_type,
        op.entity_id,
        resolveSlugForOp(op).value,
        afterJsons[i],
        op.has_primary_source ? 1 : 0,
        deletedAt,
      ]);
    }
  }

  for (const rowsJson of chunkJsonArray(entityRows)) {
    statements.push(
      prepareD1Statement(
        db,
        `INSERT INTO entities (
             entity_type, entity_id, slug, data_json, current_revision_id,
             has_primary_source, deleted_at, updated_at
           )
           SELECT j.entity_type, j.entity_id, j.slug, j.after_json,
                  (SELECT r2.revision_id FROM revisions AS r2
                   WHERE r2.entity_type = j.entity_type AND r2.entity_id = j.entity_id
                   ORDER BY r2.revision_id DESC LIMIT 1),
                  j.has_primary_source, j.deleted_at, ?
           FROM (
             SELECT json_extract(value, '$[0]') AS entity_type,
                    json_extract(value, '$[1]') AS entity_id,
                    json_extract(value, '$[2]') AS slug,
                    json_extract(value, '$[3]') AS after_json,
                    json_extract(value, '$[4]') AS has_primary_source,
                    json_extract(value, '$[5]') AS deleted_at
             FROM json_each(?)
           ) AS j`
      ).bind(nowIso, rowsJson)
    );
  }

  for (const rowsJson of chunkJsonArray(kinshipRows)) {
    statements.push(
      prepareD1Statement(
        db,
        `INSERT INTO kinship_edges (
             edge_id, from_person_id, to_person_id, relation, family_xref,
             current_revision_id, deleted_at, updated_at
           )
           SELECT j.edge_id, j.from_person_id, j.to_person_id, j.relation, j.family_xref,
                  (SELECT r.revision_id FROM revisions AS r
                   WHERE r.entity_type = 'kinship_edge' AND r.entity_id = j.edge_id
                   ORDER BY r.revision_id DESC LIMIT 1),
                  j.deleted_at, ?
           FROM (
             SELECT json_extract(value, '$[0]') AS edge_id,
                    json_extract(value, '$[1]') AS from_person_id,
                    json_extract(value, '$[2]') AS to_person_id,
                    json_extract(value, '$[3]') AS relation,
                    json_extract(value, '$[4]') AS family_xref,
                    json_extract(value, '$[5]') AS deleted_at
             FROM json_each(?)
           ) AS j`
      ).bind(nowIso, rowsJson)
    );
  }
}

/**
 * Set-based optimistic-locked UPDATE run for non-kinship active entities.
 * Any missing, soft-deleted, or stale-revision entity yields `e.current_revision_id = NULL`,
 * triggering the `revisions` `parent_revision_id IS NOT NULL` CHECK constraint so `db.batch()`
 * rolls back atomically with identical conflict semantics to single-statement updates.
 */
export function pushUpdateRunStatements(
  db: D1Database,
  params: {
    ops: readonly AtomicMutationOp[];
    batchId: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    statements: D1PreparedStatement[];
    revisionResultEntries: RevisionResultEntry[];
  }
): void {
  const { ops, batchId, author, nowIso, statements, revisionResultEntries } = params;

  const afterJsons = new Array<string>(ops.length);
  for (let i = 0; i < ops.length; i += 1) {
    afterJsons[i] = JSON.stringify(ops[i].after_json);
  }

  const firstSummary = ops[0].summary;
  const firstPrimary = ops[0].has_primary_source;
  const uniformMetadata = ops.every(
    (op) =>
      op.summary === firstSummary &&
      op.has_primary_source === firstPrimary &&
      (op.reverted_revision_id ?? null) === null
  );

  if (uniformMetadata) {
    const compactRows = ops.map((op, i) => [
      op.entity_type,
      op.entity_id,
      op.expected_parent_revision_id,
      op.before_json !== null ? JSON.stringify(op.before_json) : null,
      afterJsons[i],
    ]);
    const uniformPrimaryInt = firstPrimary ? 1 : 0;
    for (const chunk of chunkJsonArrayWithRanges(compactRows)) {
      revisionResultEntries.push({
        stmtIndex: statements.length,
        kind: 'update',
        ops: ops.slice(chunk.start, chunk.start + chunk.count),
      });
      statements.push(
        prepareD1Statement(
          db,
          `INSERT INTO revisions (
             batch_id, entity_type, entity_id, parent_revision_id, action,
             reverted_revision_id, author_id, author_name, author_type,
             summary, has_primary_source, before_json, after_json, created_at
           )
           SELECT ?, j.entity_type, j.entity_id, e.current_revision_id, 'update',
                  NULL, ?, ?, ?,
                  ?, ?, j.before_json, j.after_json, ?
           FROM (
             SELECT json_extract(value, '$[0]') AS entity_type,
                    json_extract(value, '$[1]') AS entity_id,
                    json_extract(value, '$[2]') AS expected_parent,
                    json_extract(value, '$[3]') AS before_json,
                    json_extract(value, '$[4]') AS after_json
             FROM json_each(?)
           ) AS j
           LEFT JOIN entities AS e
             ON e.entity_type = j.entity_type
            AND e.entity_id = j.entity_id
            AND e.current_revision_id = j.expected_parent
            AND e.deleted_at IS NULL
           RETURNING revision_id, parent_revision_id`
        ).bind(
          batchId,
          author.author_id,
          author.author_name,
          author.author_type,
          firstSummary,
          uniformPrimaryInt,
          nowIso,
          chunk.json
        )
      );
    }
  } else {
    const revisionRows = ops.map((op, i) => [
      op.entity_type,
      op.entity_id,
      op.expected_parent_revision_id,
      op.reverted_revision_id ?? null,
      op.summary,
      op.has_primary_source ? 1 : 0,
      op.before_json !== null ? JSON.stringify(op.before_json) : null,
      afterJsons[i],
    ]);

    for (const chunk of chunkJsonArrayWithRanges(revisionRows)) {
      revisionResultEntries.push({
        stmtIndex: statements.length,
        kind: 'update',
        ops: ops.slice(chunk.start, chunk.start + chunk.count),
      });
      statements.push(
        prepareD1Statement(
          db,
          `INSERT INTO revisions (
             batch_id, entity_type, entity_id, parent_revision_id, action,
             reverted_revision_id, author_id, author_name, author_type,
             summary, has_primary_source, before_json, after_json, created_at
           )
           SELECT ?, j.entity_type, j.entity_id, e.current_revision_id, 'update',
                  j.reverted_revision_id, ?, ?, ?,
                  j.summary, j.has_primary_source, j.before_json, j.after_json, ?
           FROM (
             SELECT json_extract(value, '$[0]') AS entity_type,
                    json_extract(value, '$[1]') AS entity_id,
                    json_extract(value, '$[2]') AS expected_parent,
                    json_extract(value, '$[3]') AS reverted_revision_id,
                    json_extract(value, '$[4]') AS summary,
                    json_extract(value, '$[5]') AS has_primary_source,
                    json_extract(value, '$[6]') AS before_json,
                    json_extract(value, '$[7]') AS after_json
             FROM json_each(?)
           ) AS j
           LEFT JOIN entities AS e
             ON e.entity_type = j.entity_type
            AND e.entity_id = j.entity_id
            AND e.current_revision_id = j.expected_parent
            AND e.deleted_at IS NULL
           RETURNING revision_id, parent_revision_id`
        ).bind(batchId, author.author_id, author.author_name, author.author_type, nowIso, chunk.json)
      );
    }
  }

  const entityUpdateRows = ops.map((op, i) => {
    const slugInfo = resolveSlugForOp(op);
    return [
      op.entity_type,
      op.entity_id,
      slugInfo.updateSlug ? 1 : 0,
      slugInfo.value,
      op.has_primary_source ? 1 : 0,
      afterJsons[i],
    ];
  });

  for (const rowsJson of chunkJsonArray(entityUpdateRows)) {
    statements.push(
      prepareD1Statement(
        db,
        `UPDATE entities
            SET slug = CASE WHEN j.update_slug = 1 THEN j.slug ELSE entities.slug END,
                data_json = j.after_json,
                current_revision_id = (
                  SELECT r2.revision_id FROM revisions AS r2
                  WHERE r2.entity_type = j.entity_type AND r2.entity_id = j.entity_id
                  ORDER BY r2.revision_id DESC LIMIT 1
                ),
                has_primary_source = j.has_primary_source,
                deleted_at = NULL,
                updated_at = ?
           FROM (
             SELECT json_extract(value, '$[0]') AS entity_type,
                    json_extract(value, '$[1]') AS entity_id,
                    json_extract(value, '$[2]') AS update_slug,
                    json_extract(value, '$[3]') AS slug,
                    json_extract(value, '$[4]') AS has_primary_source,
                    json_extract(value, '$[5]') AS after_json
             FROM json_each(?)
           ) AS j
          WHERE entities.entity_type = j.entity_type
            AND entities.entity_id = j.entity_id`
      ).bind(nowIso, rowsJson)
    );
  }
}
