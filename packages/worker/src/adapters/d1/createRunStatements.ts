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
  readonly kind: 'create' | 'single';
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
    const compactRows = ops.map((op) => [op.entity_type, op.entity_id, op.after_json]);
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
    const revisionRows = ops.map((op) => [
      op.entity_type,
      op.entity_id,
      op.reverted_revision_id ?? null,
      op.summary,
      op.has_primary_source ? 1 : 0,
      op.before_json,
      op.after_json,
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
  for (const op of ops) {
    if (!op.after_json) {
      throw new Error(`Create ${op.entity_type} operation requires after_json.`);
    }
    const deletedAt = op.soft_delete === true ? nowIso : null;
    if (op.entity_type === 'kinship_edge') {
      const edge = parseEntityPayload('kinship_edge', op.after_json);
      kinshipRows.push([
        op.entity_id,
        edge.from,
        edge.to,
        edge.relation,
        edge.family_xref ?? null,
        deletedAt,
      ]);
    } else {
      entityRows.push([op.entity_type, op.entity_id, resolveSlugForOp(op).value, deletedAt]);
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
           SELECT r.entity_type, r.entity_id, j.slug, r.after_json, r.revision_id,
                  r.has_primary_source, j.deleted_at, ?
           FROM (
             SELECT json_extract(value, '$[0]') AS entity_type,
                    json_extract(value, '$[1]') AS entity_id,
                    json_extract(value, '$[2]') AS slug,
                    json_extract(value, '$[3]') AS deleted_at
             FROM json_each(?)
           ) AS j
           JOIN revisions r ON r.revision_id = (
             SELECT MAX(r2.revision_id) FROM revisions r2
             WHERE r2.entity_type = j.entity_type AND r2.entity_id = j.entity_id
           )`
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
                  (SELECT MAX(r.revision_id) FROM revisions r
                   WHERE r.entity_type = 'kinship_edge' AND r.entity_id = j.edge_id),
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
