import {
  type AtomicMutationOp,
  asRevisionId,
  type BatchId,
  type EntityPayload,
  type EntityType,
  type RevisionAuthor,
  type RevisionRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  storedRecordToEntityPayload,
} from '@kinloom/core';
import type { D1Database, D1PreparedStatement } from '../../types.js';

// Set-based statements pass rows as one JSON array bind, read with json_each().
// D1 caps a single bound value at 2 MB, so keep each JSON chunk well under it.
const D1_JSON_PARAM_MAX_BYTES = 900_000;
const PREPARED_STATEMENT_CACHE_LIMIT = 64;

const utf8 = new TextEncoder();
const preparedStatementCaches = new WeakMap<D1Database, Map<string, D1PreparedStatement>>();

export interface JsonArrayChunk {
  readonly json: string;
  readonly start: number;
  readonly count: number;
}

export function prepareD1Statement(db: D1Database, sql: string): D1PreparedStatement {
  let cache = preparedStatementCaches.get(db);
  if (!cache) {
    cache = new Map();
    preparedStatementCaches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    if (cache.size < PREPARED_STATEMENT_CACHE_LIMIT) {
      cache.set(sql, stmt);
    }
  }
  return stmt;
}

export function chunkJsonArrayWithRanges(items: readonly unknown[]): JsonArrayChunk[] {
  const chunks: JsonArrayChunk[] = [];
  let current: string[] = [];
  let currentMaxBytes = 2;
  let currentExactBytes = 2;
  let exactStale = false;
  let chunkStart = 0;

  for (let i = 0; i < items.length; i += 1) {
    const encoded = JSON.stringify(items[i]);
    const itemMaxBytes = encoded.length * 3 + 1;

    if (current.length > 0 && currentMaxBytes + itemMaxBytes > D1_JSON_PARAM_MAX_BYTES) {
      if (exactStale) {
        currentExactBytes = utf8.encode(current.join(',')).length + 2;
        exactStale = false;
      }
      const itemExactBytes = utf8.encode(encoded).length + 1;
      if (currentExactBytes + itemExactBytes > D1_JSON_PARAM_MAX_BYTES) {
        chunks.push({ json: `[${current.join(',')}]`, start: chunkStart, count: current.length });
        current = [encoded];
        currentMaxBytes = 2 + itemMaxBytes;
        currentExactBytes = 2 + itemExactBytes;
        exactStale = false;
        chunkStart = i;
        continue;
      }
      current.push(encoded);
      currentMaxBytes += itemMaxBytes;
      currentExactBytes += itemExactBytes;
      continue;
    }

    current.push(encoded);
    currentMaxBytes += itemMaxBytes;
    exactStale = true;
  }

  if (current.length > 0) {
    chunks.push({ json: `[${current.join(',')}]`, start: chunkStart, count: current.length });
  }
  return chunks;
}

export function chunkJsonArray(items: readonly unknown[]): string[] {
  return chunkJsonArrayWithRanges(items).map((c) => c.json);
}

export function buildCommittedRevisionRecord(params: {
  revisionId: number;
  parentRevisionId: number | null;
  op: AtomicMutationOp;
  batchId: BatchId | null;
  author: RevisionAuthor;
  nowIso: string;
}): RevisionRecord {
  const { revisionId, parentRevisionId, op, batchId, author, nowIso } = params;
  return {
    revision_id: asRevisionId(revisionId),
    batch_id: batchId,
    entity_type: op.entity_type,
    entity_id: op.entity_id,
    parent_revision_id: parentRevisionId !== null ? asRevisionId(parentRevisionId) : null,
    action: op.action,
    reverted_revision_id: op.reverted_revision_id ?? null,
    author_id: author.author_id,
    author_name: author.author_name,
    author_type: author.author_type,
    summary: op.summary,
    has_primary_source: op.has_primary_source,
    before_json: op.before_json,
    after_json: op.after_json,
    created_at: nowIso,
  };
}

export function entityCompositeKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export function rowToEntityPayload(row: StoredEntityRow | StoredKinshipRow): EntityPayload {
  return storedRecordToEntityPayload(row);
}

export function isSqliteConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_CONSTRAINT') ||
    message.includes('CHECK constraint failed') ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('PRIMARY KEY constraint failed')
  );
}

export function resolveSlugForOp(op: AtomicMutationOp): { updateSlug: boolean; value: string | null } {
  if (op.slug !== undefined) {
    return { updateSlug: true, value: op.slug };
  }
  if (op.after_json && typeof op.after_json['slug'] === 'string') {
    return { updateSlug: true, value: op.after_json['slug'] };
  }
  return { updateSlug: false, value: null };
}
