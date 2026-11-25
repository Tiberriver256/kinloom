import {
  AgentTokenScopeSchema,
  asRevisionId,
  asSha256Hex,
  AuthorTypeSchema,
  computeEntityDiff,
  entityLookupCompositeKey,
  EntityTypeSchema,
  parseEntityPayload,
  resolveEffectiveLiving,
  RevisionActionSchema,
  UserRoleSchema,
  type AgentTokenRecord,
  type ArchiveRawSnapshot,
  type ArchiveRepository,
  type AtomicMutationOp,
  type BatchId,
  type CommitMutationsResult,
  type EntityLookupKey,
  type EntityPayload,
  type EntityType,
  type InviteRecord,
  type KinshipEdge,
  type MagicLinkRecord,
  type OptimisticConflictError,
  type PrivacyConfig,
  type RevisionAuthor,
  type RevisionId,
  type RevisionQuery,
  type RevisionRecord,
  type Sha256Hex,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  type TalkComment,
  type UserRecord,
  type UserRole,
} from '@kinloom/core';
import type { D1Database, D1PreparedStatement } from '../types.js';

// Set-based statements pass rows as one JSON array bind, read with json_each().
// D1 caps a single bound value at 2 MB, so keep each JSON chunk well under it.
const D1_JSON_PARAM_MAX_BYTES = 900_000;

const utf8 = new TextEncoder();

interface JsonArrayChunk {
  readonly json: string;
  readonly start: number;
  readonly count: number;
}

function chunkJsonArrayWithRanges(items: readonly unknown[]): JsonArrayChunk[] {
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

function chunkJsonArray(items: readonly unknown[]): string[] {
  return chunkJsonArrayWithRanges(items).map((c) => c.json);
}

interface RevisionResultEntry {
  readonly stmtIndex: number;
  readonly kind: 'create' | 'single';
  readonly ops: readonly AtomicMutationOp[];
}

function buildCommittedRevisionRecord(params: {
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

type NonKinshipEntityType = Exclude<EntityType, 'kinship_edge'>;

interface RawDbEntityRow {
  entity_type: string;
  entity_id: string;
  slug: string | null;
  data_json: string;
  current_revision_id: number;
  has_primary_source: number;
  deleted_at: string | null;
  updated_at: string;
}

interface RawDbKinshipRow {
  edge_id: string;
  from_person_id: string;
  to_person_id: string;
  relation: string;
  family_xref: string | null;
  current_revision_id: number;
  deleted_at: string | null;
  updated_at: string;
}

interface RawDbRevisionRow {
  revision_id: number;
  batch_id: string | null;
  entity_type: string;
  entity_id: string;
  parent_revision_id: number | null;
  action: string;
  reverted_revision_id: number | null;
  author_id: string;
  author_name: string;
  author_type: string;
  summary: string;
  has_primary_source: number;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

interface RawDbTalkRow {
  comment_id: number;
  entity_type: string;
  entity_id: string;
  author_id: string;
  author_name: string;
  body_md: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

interface RawDbUserRow {
  email: string;
  display_name: string;
  role: string;
  added_by: string;
  added_at: string;
  last_login_at: string | null;
}

interface RawDbInviteRow {
  token: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  uses: number;
  last_used_at: string | null;
}

interface RawDbMagicLinkRow {
  token_hash: string;
  email: string;
  invite_token: string | null;
  expires_at: string;
  used_at: string | null;
}

interface RawDbAgentTokenRow {
  token_id: string;
  token_hash: string;
  label: string;
  scope: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function parseJsonObject(raw: string): EntityPayload {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored entity JSON must be a plain object.');
  }
  return parsed as EntityPayload;
}

function parseNonKinshipEntityType(raw: string): NonKinshipEntityType {
  const parsed = EntityTypeSchema.parse(raw);
  if (parsed === 'kinship_edge') {
    throw new Error('Unexpected kinship_edge row inside entities table.');
  }
  return parsed;
}

function mapEntityRow(row: RawDbEntityRow): StoredEntityRow {
  return {
    entity_type: parseNonKinshipEntityType(row.entity_type),
    entity_id: row.entity_id,
    slug: row.slug,
    data: parseJsonObject(row.data_json),
    current_revision_id: asRevisionId(row.current_revision_id),
    has_primary_source: row.has_primary_source !== 0,
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

function mapKinshipRow(row: RawDbKinshipRow): StoredKinshipRow {
  const edge: KinshipEdge = parseEntityPayload('kinship_edge', {
    from: row.from_person_id,
    to: row.to_person_id,
    relation: row.relation,
    ...(row.family_xref !== null ? { family_xref: row.family_xref } : {}),
  });
  return {
    edge_id: row.edge_id,
    edge,
    current_revision_id: asRevisionId(row.current_revision_id),
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

function mapRevisionRow(row: RawDbRevisionRow): RevisionRecord {
  return {
    revision_id: asRevisionId(row.revision_id),
    batch_id: row.batch_id,
    entity_type: EntityTypeSchema.parse(row.entity_type),
    entity_id: row.entity_id,
    parent_revision_id: row.parent_revision_id,
    action: RevisionActionSchema.parse(row.action),
    reverted_revision_id: row.reverted_revision_id,
    author_id: row.author_id,
    author_name: row.author_name,
    author_type: AuthorTypeSchema.parse(row.author_type),
    summary: row.summary,
    has_primary_source: row.has_primary_source !== 0,
    before_json: row.before_json !== null ? parseJsonObject(row.before_json) : null,
    after_json: row.after_json !== null ? parseJsonObject(row.after_json) : null,
    created_at: row.created_at,
  };
}

function mapTalkRow(row: RawDbTalkRow): TalkComment {
  return {
    comment_id: row.comment_id,
    entity_type: EntityTypeSchema.parse(row.entity_type),
    entity_id: row.entity_id,
    author_id: row.author_id,
    author_name: row.author_name,
    body_md: row.body_md,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
  };
}

function mapUserRow(row: RawDbUserRow): UserRecord {
  return {
    email: row.email,
    display_name: row.display_name,
    role: UserRoleSchema.parse(row.role),
    added_by: row.added_by,
    added_at: row.added_at,
    last_login_at: row.last_login_at,
  };
}

function mapInviteRow(row: RawDbInviteRow): InviteRecord {
  return {
    token: row.token,
    label: row.label,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    uses: row.uses,
    last_used_at: row.last_used_at,
  };
}

function mapMagicLinkRow(row: RawDbMagicLinkRow): MagicLinkRecord {
  return {
    token_hash: asSha256Hex(row.token_hash),
    email: row.email,
    invite_token: row.invite_token,
    expires_at: row.expires_at,
    used_at: row.used_at,
  };
}

function mapAgentTokenRow(row: RawDbAgentTokenRow): AgentTokenRecord {
  return {
    token_id: row.token_id,
    token_hash: asSha256Hex(row.token_hash),
    label: row.label,
    scope: AgentTokenScopeSchema.parse(row.scope),
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

function entityCompositeKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function rowToEntityPayload(row: StoredEntityRow | StoredKinshipRow): EntityPayload {
  if ('edge' in row) {
    return structuredClone(row.edge) as unknown as EntityPayload;
  }
  return structuredClone(row.data);
}

function isSqliteConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_CONSTRAINT') ||
    message.includes('CHECK constraint failed') ||
    message.includes('UNIQUE constraint failed') ||
    message.includes('PRIMARY KEY constraint failed')
  );
}

function resolveSlugForOp(op: AtomicMutationOp): { updateSlug: boolean; value: string | null } {
  if (op.slug !== undefined) {
    return { updateSlug: true, value: op.slug };
  }
  if (op.after_json && typeof op.after_json.slug === 'string') {
    return { updateSlug: true, value: op.after_json.slug };
  }
  return { updateSlug: false, value: null };
}

export interface D1ArchiveRepositoryOptions {
  privacyConfig?: Partial<PrivacyConfig>;
}

/**
 * Cloudflare D1 implementation of ArchiveRepository.
 * Enforces zero-N+1 snapshot loading and mathematically atomic DB.batch() optimistic concurrency.
 */
const PREPARED_STATEMENT_CACHE_LIMIT = 64;
const preparedStatementCaches = new WeakMap<D1Database, Map<string, D1PreparedStatement>>();

export class D1ArchiveRepository implements ArchiveRepository {
  private readonly db: D1Database;
  private readonly privacyConfig?: Partial<PrivacyConfig>;

  constructor(db: D1Database, options?: D1ArchiveRepositoryOptions) {
    this.db = db;
    this.privacyConfig = options?.privacyConfig;
  }

  private prepare(sql: string): D1PreparedStatement {
    let cache = preparedStatementCaches.get(this.db);
    if (!cache) {
      cache = new Map();
      preparedStatementCaches.set(this.db, cache);
    }
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (cache.size < PREPARED_STATEMENT_CACHE_LIMIT) {
        cache.set(sql, stmt);
      }
    }
    return stmt;
  }

  async getHeadRevisionId(): Promise<RevisionId> {
    const row = await this.prepare('SELECT COALESCE(MAX(revision_id), 0) AS head_revision_id FROM revisions')
      .first<{ head_revision_id: number }>();
    return asRevisionId(row?.head_revision_id ?? 0);
  }

  async getEntity(
    entityType: EntityType,
    entityId: string
  ): Promise<StoredEntityRecord | null> {
    if (entityType === 'kinship_edge') {
      const row = await this.prepare(
          `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                  current_revision_id, deleted_at, updated_at
           FROM kinship_edges
           WHERE edge_id = ?`
        )
        .bind(entityId)
        .first<RawDbKinshipRow>();
      return row ? mapKinshipRow(row) : null;
    }

    const row = await this.prepare(
        `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE entity_type = ? AND entity_id = ?`
      )
      .bind(entityType, entityId)
      .first<RawDbEntityRow>();
    return row ? mapEntityRow(row) : null;
  }

  async getEntitiesBatch(
    keys: readonly EntityLookupKey[]
  ): Promise<Map<string, StoredEntityRecord | null>> {
    const result = new Map<string, StoredEntityRecord | null>();
    if (keys.length === 0) {
      return result;
    }

    const entityPairs: Array<[NonKinshipEntityType, string]> = [];
    const kinshipIds: string[] = [];
    for (const key of keys) {
      const composite = entityLookupCompositeKey(key.entityType, key.entityId);
      if (result.has(composite)) {
        continue;
      }
      result.set(composite, null);
      if (key.entityType === 'kinship_edge') {
        kinshipIds.push(key.entityId);
      } else {
        entityPairs.push([key.entityType, key.entityId]);
      }
    }

    const statements: D1PreparedStatement[] = [];
    const statementKinds: Array<'kinship_edge' | 'entity'> = [];

    for (const pairsJson of chunkJsonArray(entityPairs)) {
      statements.push(
        this.prepare(
            `SELECT e.entity_type, e.entity_id, e.slug, e.data_json, e.current_revision_id,
                    e.has_primary_source, e.deleted_at, e.updated_at
             FROM json_each(?) AS k
             JOIN entities AS e
               ON e.entity_type = json_extract(k.value, '$[0]')
              AND e.entity_id = json_extract(k.value, '$[1]')`
          )
          .bind(pairsJson)
      );
      statementKinds.push('entity');
    }

    for (const idsJson of chunkJsonArray(kinshipIds)) {
      statements.push(
        this.prepare(
            `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                    current_revision_id, deleted_at, updated_at
             FROM kinship_edges
             WHERE edge_id IN (SELECT value FROM json_each(?))`
          )
          .bind(idsJson)
      );
      statementKinds.push('kinship_edge');
    }

    const batchResults = await this.db.batch(statements);
    for (let i = 0; i < batchResults.length; i += 1) {
      const kind = statementKinds[i];
      if (kind === 'kinship_edge') {
        const rows = (batchResults[i]?.results ?? []) as unknown as RawDbKinshipRow[];
        for (const row of rows) {
          const mapped = mapKinshipRow(row);
          result.set(entityLookupCompositeKey('kinship_edge', mapped.edge_id), mapped);
        }
      } else {
        const rows = (batchResults[i]?.results ?? []) as unknown as RawDbEntityRow[];
        for (const row of rows) {
          const mapped = mapEntityRow(row);
          result.set(entityLookupCompositeKey(mapped.entity_type, mapped.entity_id), mapped);
        }
      }
    }

    return result;
  }

  async getLivingPersonIds(): Promise<ReadonlySet<string>> {
    const result = await this.prepare(
        `SELECT entity_id,
                json_extract(data_json, '$.is_living') AS is_living,
                json_extract(data_json, '$.birth_edtf') AS birth_edtf,
                json_extract(data_json, '$.death_edtf') AS death_edtf
         FROM entities
         WHERE entity_type = 'person' AND deleted_at IS NULL`
      )
      .all<{
        entity_id: string;
        is_living: number | boolean | null;
        birth_edtf: string | number | null;
        death_edtf: string | number | null;
      }>();

    const living = new Set<string>();
    for (const row of result.results) {
      if (
        resolveEffectiveLiving(
          {
            is_living: Boolean(row.is_living),
            birth_edtf: row.birth_edtf == null ? '' : String(row.birth_edtf),
            death_edtf: row.death_edtf == null ? '' : String(row.death_edtf),
          },
          this.privacyConfig
        )
      ) {
        living.add(row.entity_id);
      }
    }
    return living;
  }

  async loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    const [entitiesRes, kinshipRes, headRes] = await this.db.batch([
      this.prepare(
        `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE deleted_at IS NULL
         ORDER BY entity_type, entity_id`
      ),
      this.prepare(
        `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                current_revision_id, deleted_at, updated_at
         FROM kinship_edges
         WHERE deleted_at IS NULL`
      ),
      this.prepare('SELECT COALESCE(MAX(revision_id), 0) AS head_revision_id FROM revisions'),
    ]);

    const entities = (entitiesRes.results as unknown as RawDbEntityRow[]).map(mapEntityRow);
    const kinship = (kinshipRes.results as unknown as RawDbKinshipRow[])
      .map(mapKinshipRow)
      .toSorted((a, b) => a.edge_id.localeCompare(b.edge_id));
    const headRow = (headRes.results as unknown as Array<{ head_revision_id: number }>)[0];

    return {
      head_revision_id: asRevisionId(headRow?.head_revision_id ?? 0),
      entities,
      kinship,
    };
  }

  async commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    if (params.operations.length === 0) {
      return {
        kind: 'committed',
        head_revision_id: await this.getHeadRevisionId(),
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
        // Each create run becomes a few set-based statements instead of two per row.
        let runEnd = i;
        while (runEnd < ops.length && ops[runEnd].action === 'create') {
          mutatedInBatch.add(entityCompositeKey(ops[runEnd].entity_type, ops[runEnd].entity_id));
          runEnd += 1;
        }
        this.pushCreateRunStatements({
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

      const entityStmt = this.buildEntityMutationStatement(op, params.nowIso);
      statements.push(entityStmt);

      mutatedInBatch.add(key);
    }

    try {
      const results = await this.db.batch(statements);
      const committedRevisions: RevisionRecord[] = [];
      for (const entry of revisionResultEntries) {
        if (entry.kind === 'create') {
          const revRows = (results[entry.stmtIndex]?.results ?? []) as unknown as Array<{
            revision_id: number;
          }>;
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
          const revRows = (results[entry.stmtIndex]?.results ?? []) as unknown as Array<{
            revision_id: number;
            parent_revision_id: number | null;
          }>;
          const revRow = revRows[0];
          if (!revRow) {
            throw new Error('D1 revision insert did not return the inserted revision row.');
          }
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

  /**
   * Appends set-based INSERTs for a run of create ops: revisions first, then the
   * entity and kinship rows. Each row links to the newest revision for its key, which
   * is the revision this run just inserted, and entities copy data_json and
   * has_primary_source from it so the payload crosses the binding once. Duplicate
   * keys still fail the primary key, so DB.batch() rolls back as before.
   */
  private pushCreateRunStatements(params: {
    ops: readonly AtomicMutationOp[];
    batchId: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    statements: D1PreparedStatement[];
    revisionResultEntries: RevisionResultEntry[];
  }): void {
    const { ops, batchId, author, nowIso, statements, revisionResultEntries } = params;

    // Pass before_json / after_json as raw objects so chunkJsonArrayWithRanges encodes
    // each payload once; SQLite json_extract() returns compact JSON text for objects and NULL for null.
    // Omit ORDER BY key because json_each() on a JSON array yields elements in array index order
    // without forcing a temp B-tree sort over multi-megabyte payloads.
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
          this.prepare(
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
          this.prepare(
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
        this.prepare(
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
          )
          .bind(nowIso, rowsJson)
      );
    }

    for (const rowsJson of chunkJsonArray(kinshipRows)) {
      statements.push(
        this.prepare(
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
          )
          .bind(nowIso, rowsJson)
      );
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
      return this.prepare(
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
        )
        .bind(
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

    // update, delete, and revert rely on CHECK (action IN ('create', 'restore') OR parent_revision_id IS NOT NULL).
    return this.prepare(
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
      )
      .bind(
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

  private buildEntityMutationStatement(
    op: AtomicMutationOp,
    nowIso: string
  ): D1PreparedStatement {
    const isSoftDelete =
      op.soft_delete === true || op.action === 'delete' || op.after_json === null;
    const deletedAt = isSoftDelete ? nowIso : null;

    if (op.entity_type === 'kinship_edge') {
      if (op.after_json !== null) {
        const edge = parseEntityPayload('kinship_edge', op.after_json);
        return this.prepare(
            `UPDATE kinship_edges
             SET from_person_id = ?, to_person_id = ?, relation = ?, family_xref = ?,
                 current_revision_id = last_insert_rowid(), deleted_at = ?, updated_at = ?
             WHERE edge_id = ?`
          )
          .bind(
            edge.from,
            edge.to,
            edge.relation,
            edge.family_xref ?? null,
            deletedAt,
            nowIso,
            op.entity_id
          );
      }

      return this.prepare(
          `UPDATE kinship_edges
           SET current_revision_id = last_insert_rowid(), deleted_at = ?, updated_at = ?
           WHERE edge_id = ?`
        )
        .bind(deletedAt, nowIso, op.entity_id);
    }

    const hasPrimary = op.has_primary_source ? 1 : 0;

    if (op.after_json !== null) {
      const slugInfo = resolveSlugForOp(op);
      if (slugInfo.updateSlug) {
        return this.prepare(
            `UPDATE entities
             SET slug = ?, data_json = ?, current_revision_id = last_insert_rowid(),
                 has_primary_source = ?, deleted_at = ?, updated_at = ?
             WHERE entity_type = ? AND entity_id = ?`
          )
          .bind(
            slugInfo.value,
            JSON.stringify(op.after_json),
            hasPrimary,
            deletedAt,
            nowIso,
            op.entity_type,
            op.entity_id
          );
      }

      return this.prepare(
          `UPDATE entities
           SET data_json = ?, current_revision_id = last_insert_rowid(),
               has_primary_source = ?, deleted_at = ?, updated_at = ?
           WHERE entity_type = ? AND entity_id = ?`
        )
        .bind(
          JSON.stringify(op.after_json),
          hasPrimary,
          deletedAt,
          nowIso,
          op.entity_type,
          op.entity_id
        );
    }

    return this.prepare(
        `UPDATE entities
         SET current_revision_id = last_insert_rowid(),
             has_primary_source = ?, deleted_at = ?, updated_at = ?
         WHERE entity_type = ? AND entity_id = ?`
      )
      .bind(hasPrimary, deletedAt, nowIso, op.entity_type, op.entity_id);
  }

  private async resolveConstraintConflict(
    operations: readonly AtomicMutationOp[],
    nowIso: string,
    originalError: unknown
  ): Promise<OptimisticConflictError> {
    const existingByKey = await this.getEntitiesBatch(
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

    // Fallback for unique secondary-index conflict (such as duplicate active slug or kinship edge)
    const fallbackOp = operations[0];
    if (fallbackOp) {
      const existing = await this.getEntity(fallbackOp.entity_type, fallbackOp.entity_id);
      return this.buildConflictFromExisting(fallbackOp, existing, nowIso);
    }
    throw originalError;
  }

  private async buildConflictForOp(
    op: AtomicMutationOp,
    nowIso: string
  ): Promise<OptimisticConflictError> {
    const existing = await this.getEntity(op.entity_type, op.entity_id);
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

    const lastRev = await this.prepare(
        `SELECT author_name
         FROM revisions
         WHERE entity_type = ? AND entity_id = ?
         ORDER BY revision_id DESC
         LIMIT 1`
      )
      .bind(op.entity_type, op.entity_id)
      .first<{ author_name: string }>();

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

  async listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (query.entity_type) {
      conditions.push('entity_type = ?');
      bindings.push(query.entity_type);
    }
    if (query.entity_id) {
      conditions.push('entity_id = ?');
      bindings.push(query.entity_id);
    }
    if (query.batch_id) {
      conditions.push('batch_id = ? AND batch_id IS NOT NULL');
      bindings.push(query.batch_id);
    }
    if (query.author_type) {
      conditions.push('author_type = ?');
      bindings.push(query.author_type);
    }
    if (query.cursor !== undefined) {
      conditions.push('revision_id < ?');
      bindings.push(query.cursor);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const res = await this.prepare(
        `SELECT revision_id, batch_id, entity_type, entity_id, parent_revision_id, action,
                reverted_revision_id, author_id, author_name, author_type,
                summary, has_primary_source, before_json, after_json, created_at
         FROM revisions
         ${whereSql}
         ORDER BY revision_id DESC
         LIMIT ?`
      )
      .bind(...bindings, limit + 1)
      .all<RawDbRevisionRow>();

    const hasMore = res.results.length > limit;
    const sliced = hasMore ? res.results.slice(0, limit) : res.results;
    const items = sliced.map(mapRevisionRow);
    const lastItem = items[items.length - 1];

    return {
      items,
      next_cursor: hasMore && lastItem ? asRevisionId(lastItem.revision_id) : null,
    };
  }

  async getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    const row = await this.prepare(
        `SELECT revision_id, batch_id, entity_type, entity_id, parent_revision_id, action,
                reverted_revision_id, author_id, author_name, author_type,
                summary, has_primary_source, before_json, after_json, created_at
         FROM revisions
         WHERE revision_id = ?`
      )
      .bind(revisionId)
      .first<RawDbRevisionRow>();
    return row ? mapRevisionRow(row) : null;
  }

  async getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    const res = await this.prepare(
        `SELECT revision_id, batch_id, entity_type, entity_id, parent_revision_id, action,
                reverted_revision_id, author_id, author_name, author_type,
                summary, has_primary_source, before_json, after_json, created_at
         FROM revisions
         WHERE batch_id = ? AND batch_id IS NOT NULL
         ORDER BY revision_id ASC`
      )
      .bind(batchId)
      .all<RawDbRevisionRow>();
    return res.results.map(mapRevisionRow);
  }

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    const res = await this.prepare(
        `SELECT comment_id, entity_type, entity_id, author_id, author_name,
                body_md, created_at, edited_at, deleted_at
         FROM talk_comments
         WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL
         ORDER BY comment_id ASC`
      )
      .bind(entityType, entityId)
      .all<RawDbTalkRow>();
    return res.results.map(mapTalkRow);
  }

  async insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment> {
    const row = await this.prepare(
        `INSERT INTO talk_comments (
           entity_type, entity_id, author_id, author_name, body_md, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING comment_id, entity_type, entity_id, author_id, author_name,
                   body_md, created_at, edited_at, deleted_at`
      )
      .bind(
        input.entity_type,
        input.entity_id,
        input.author_id,
        input.author_name,
        input.body_md,
        input.created_at
      )
      .first<RawDbTalkRow>();

    if (!row) {
      throw new Error('Failed to insert talk comment.');
    }
    return mapTalkRow(row);
  }

  async softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean> {
    const res = await this.prepare(
        `UPDATE talk_comments
         SET deleted_at = ?
         WHERE comment_id = ? AND deleted_at IS NULL`
      )
      .bind(deletedAt, commentId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async getUser(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const row = await this.prepare(
        `SELECT email, display_name, role, added_by, added_at, last_login_at
         FROM users
         WHERE email = ?`
      )
      .bind(normalized)
      .first<RawDbUserRow>();
    return row ? mapUserRow(row) : null;
  }

  async listUsers(): Promise<readonly UserRecord[]> {
    const res = await this.prepare(
        `SELECT email, display_name, role, added_by, added_at, last_login_at
         FROM users
         ORDER BY email ASC`
      )
      .all<RawDbUserRow>();
    return res.results.map(mapUserRow);
  }

  async upsertUser(user: UserRecord): Promise<UserRecord> {
    const normalizedEmail = user.email.trim().toLowerCase();
    const row = await this.prepare(
        `INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           display_name = excluded.display_name,
           role = excluded.role,
           added_by = excluded.added_by,
           added_at = excluded.added_at,
           last_login_at = excluded.last_login_at
         RETURNING email, display_name, role, added_by, added_at, last_login_at`
      )
      .bind(
        normalizedEmail,
        user.display_name,
        user.role,
        user.added_by,
        user.added_at,
        user.last_login_at
      )
      .first<RawDbUserRow>();

    if (!row) {
      throw new Error(`Failed to upsert user '${normalizedEmail}'.`);
    }
    return mapUserRow(row);
  }

  async updateUserRole(email: string, role: UserRole): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const row = await this.prepare(
        `UPDATE users
         SET role = ?
         WHERE email = ?
         RETURNING email, display_name, role, added_by, added_at, last_login_at`
      )
      .bind(role, normalized)
      .first<RawDbUserRow>();
    return row ? mapUserRow(row) : null;
  }

  async deleteUser(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const res = await this.prepare('DELETE FROM users WHERE email = ?').bind(normalized).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async touchUserLogin(email: string, atIso: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    await this.prepare('UPDATE users SET last_login_at = ? WHERE email = ?')
      .bind(atIso, normalized)
      .run();
  }

  async getInvite(token: string): Promise<InviteRecord | null> {
    const row = await this.prepare(
        `SELECT token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         FROM invites
         WHERE token = ?`
      )
      .bind(token)
      .first<RawDbInviteRow>();
    return row ? mapInviteRow(row) : null;
  }

  async listInvites(): Promise<readonly InviteRecord[]> {
    const res = await this.prepare(
        `SELECT token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         FROM invites
         ORDER BY created_at DESC`
      )
      .all<RawDbInviteRow>();
    return res.results.map(mapInviteRow);
  }

  async createInvite(invite: InviteRecord): Promise<InviteRecord> {
    const row = await this.prepare(
        `INSERT INTO invites (
           token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at`
      )
      .bind(
        invite.token,
        invite.label,
        invite.created_by,
        invite.created_at,
        invite.expires_at,
        invite.revoked_at,
        invite.uses,
        invite.last_used_at
      )
      .first<RawDbInviteRow>();

    if (!row) {
      throw new Error(`Failed to create invite '${invite.token}'.`);
    }
    return mapInviteRow(row);
  }

  async recordInviteUse(token: string, atIso: string): Promise<void> {
    await this.prepare('UPDATE invites SET uses = uses + 1, last_used_at = ? WHERE token = ?')
      .bind(atIso, token)
      .run();
  }

  async revokeInvite(token: string, atIso: string): Promise<boolean> {
    const res = await this.prepare('UPDATE invites SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL')
      .bind(atIso, token)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async insertMagicLink(record: MagicLinkRecord): Promise<void> {
    await this.prepare(
        `INSERT INTO magic_links (token_hash, email, invite_token, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        record.token_hash,
        record.email,
        record.invite_token,
        record.expires_at,
        record.used_at
      )
      .run();
  }

  async consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null> {
    // Single atomic UPDATE prevents replay races across concurrent verification requests.
    const row = await this.prepare(
        `UPDATE magic_links
         SET used_at = ?
         WHERE token_hash = ?
           AND used_at IS NULL
           AND expires_at > ?
         RETURNING token_hash, email, invite_token, expires_at, used_at`
      )
      .bind(nowIso, tokenHash, nowIso)
      .first<RawDbMagicLinkRow>();
    return row ? mapMagicLinkRow(row) : null;
  }

  async findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null> {
    const row = await this.prepare(
        `SELECT token_id, token_hash, label, scope, created_by, created_at, revoked_at
         FROM agent_tokens
         WHERE token_hash = ? AND revoked_at IS NULL`
      )
      .bind(tokenHash)
      .first<RawDbAgentTokenRow>();
    return row ? mapAgentTokenRow(row) : null;
  }

  async listAgentTokens(): Promise<readonly AgentTokenRecord[]> {
    const res = await this.prepare(
        `SELECT token_id, token_hash, label, scope, created_by, created_at, revoked_at
         FROM agent_tokens
         ORDER BY created_at DESC`
      )
      .all<RawDbAgentTokenRow>();
    return res.results.map(mapAgentTokenRow);
  }

  async createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord> {
    const row = await this.prepare(
        `INSERT INTO agent_tokens (
           token_id, token_hash, label, scope, created_by, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING token_id, token_hash, label, scope, created_by, created_at, revoked_at`
      )
      .bind(
        record.token_id,
        record.token_hash,
        record.label,
        record.scope,
        record.created_by,
        record.created_at,
        record.revoked_at
      )
      .first<RawDbAgentTokenRow>();

    if (!row) {
      throw new Error(`Failed to create agent token '${record.token_id}'.`);
    }
    return mapAgentTokenRow(row);
  }

  async revokeAgentToken(tokenId: string, atIso: string): Promise<boolean> {
    const res = await this.prepare('UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL')
      .bind(atIso, tokenId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }
}
