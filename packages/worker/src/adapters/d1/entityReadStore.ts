import {
  type ArchiveRawSnapshot,
  type AtomicMutationOp,
  asRevisionId,
  type BatchId,
  type Clock,
  type EntityLookupKey,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  fastLocaleCompare,
  type PrefetchedWriteContext,
  type PrivacyConfig,
  type RevisionId,
  type RevisionLogStore,
  type RevisionQuery,
  type RevisionRecord,
  resolveEffectiveLiving,
  type StewardReviewStamp,
  type StewardReviewTargetKind,
  type StoredEntityRecord,
  type StoredEntityRow,
} from '@kinloom/core';
import { SystemClock } from '@kinloom/server';
import type { D1Database, D1PreparedStatement } from '../../types.js';
import {
  mapEntityRow,
  mapKinshipRow,
  mapRevisionRow,
  type NonKinshipEntityType,
  parseDbEntityRow,
  parseDbHeadRevisionRow,
  parseDbKinshipRow,
  parseDbLivingPersonDeltaRow,
  parseDbLivingPersonProjectionRow,
  parseDbRevisionRow,
} from './rowMappers.js';
import { chunkJsonArray, prepareD1Statement } from './sqlHelpers.js';

interface CachedLivingPeopleState {
  headRevisionId: number;
  referenceYear: number;
  privacyKey: string;
  livingIds: Set<string>;
}

const MAX_INCREMENTAL_LIVING_REVISIONS = 500;
const livingPeopleCaches = new WeakMap<D1Database, CachedLivingPeopleState>();

const HEAD_REV_SQL = 'SELECT COALESCE(MAX(revision_id), 0) AS head_revision_id FROM revisions';
const LIVING_DELTA_SQL = `SELECT r.entity_id AS entity_id,
        e.entity_id AS active_entity_id,
        e.deleted_at AS deleted_at,
        json_extract(e.data_json, '$.is_living') AS is_living,
        json_extract(e.data_json, '$.birth_edtf') AS birth_edtf,
        json_extract(e.data_json, '$.death_edtf') AS death_edtf
   FROM (
     SELECT DISTINCT entity_id
       FROM revisions
      WHERE revision_id > ? AND entity_type = 'person'
   ) AS r
   LEFT JOIN entities AS e
     ON e.entity_type = 'person' AND e.entity_id = r.entity_id`;
const LIVING_FULL_SQL = `SELECT entity_id,
        json_extract(data_json, '$.is_living') AS is_living,
        json_extract(data_json, '$.birth_edtf') AS birth_edtf,
        json_extract(data_json, '$.death_edtf') AS death_edtf
   FROM entities
   WHERE entity_type = 'person' AND deleted_at IS NULL`;

const REVISION_BASE_SELECT = `SELECT revision_id, batch_id, entity_type, entity_id, parent_revision_id, action,
                reverted_revision_id, author_id, author_name, author_type,
                summary, has_primary_source, before_json, after_json, created_at
         FROM revisions`;

const REVISION_WITH_REVIEW_SELECT = `SELECT r.revision_id, r.batch_id, r.entity_type, r.entity_id, r.parent_revision_id, r.action,
                r.reverted_revision_id, r.author_id, r.author_name, r.author_type,
                r.summary, r.has_primary_source, r.before_json, r.after_json, r.created_at,
                COALESCE(sr_rev.target_kind, sr_batch.target_kind) AS review_target_kind,
                COALESCE(sr_rev.target_id, sr_batch.target_id) AS review_target_id,
                COALESCE(sr_rev.reviewer_id, sr_batch.reviewer_id) AS review_reviewer_id,
                COALESCE(sr_rev.reviewer_name, sr_batch.reviewer_name) AS review_reviewer_name,
                CASE WHEN sr_rev.target_id IS NOT NULL THEN sr_rev.note ELSE sr_batch.note END AS review_note,
                COALESCE(sr_rev.reviewed_at, sr_batch.reviewed_at) AS review_reviewed_at
         FROM revisions AS r
         LEFT JOIN steward_reviews AS sr_rev
           ON sr_rev.target_kind = 'revision' AND sr_rev.target_id = CAST(r.revision_id AS TEXT)
         LEFT JOIN steward_reviews AS sr_batch
           ON sr_batch.target_kind = 'batch' AND sr_batch.target_id = r.batch_id`;

function isMissingStewardReviewsTableError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if ('cause' in error && error.cause !== undefined) {
      parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
    }
  } else {
    parts.push(String(error));
  }
  return parts.some((text) => {
    const lower = text.toLowerCase();
    return lower.includes('no such table') && lower.includes('steward_reviews');
  });
}

export class D1EntityReadStore implements EntityReadStore, RevisionLogStore {
  private readonly clock: Clock;
  private readonly privacyKey: string;

  constructor(
    private readonly db: D1Database,
    private readonly privacyConfig?: Partial<PrivacyConfig>,
    clock?: Clock
  ) {
    this.clock = clock ?? new SystemClock();
    this.privacyKey = JSON.stringify(privacyConfig ?? null);
  }

  private buildEntityLookupBatchStatements(
    keys: readonly EntityLookupKey[],
    result: Map<string, StoredEntityRecord | null>,
    statements: D1PreparedStatement[],
    statementKinds: Array<'kinship_edge' | 'entity'>
  ): void {
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

    for (const pairsJson of chunkJsonArray(entityPairs)) {
      statements.push(
        prepareD1Statement(
          this.db,
          `SELECT e.entity_type, e.entity_id, e.slug, e.data_json, e.current_revision_id,
                    e.has_primary_source, e.deleted_at, e.updated_at
             FROM json_each(?) AS k
             JOIN entities AS e
               ON e.entity_type = json_extract(k.value, '$[0]')
              AND e.entity_id = json_extract(k.value, '$[1]')`
        ).bind(pairsJson)
      );
      statementKinds.push('entity');
    }

    for (const idsJson of chunkJsonArray(kinshipIds)) {
      statements.push(
        prepareD1Statement(
          this.db,
          `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                    current_revision_id, deleted_at, updated_at
             FROM kinship_edges
             WHERE edge_id IN (SELECT value FROM json_each(?))`
        ).bind(idsJson)
      );
      statementKinds.push('kinship_edge');
    }
  }

  private applyLivingDeltaRows(
    cached: CachedLivingPeopleState,
    rawRows: readonly unknown[],
    referenceYear: number
  ): void {
    for (let i = 0; i < rawRows.length; i += 1) {
      const row = parseDbLivingPersonDeltaRow(rawRows[i]);
      if (row.active_entity_id === null || row.deleted_at !== null) {
        cached.livingIds.delete(row.entity_id);
        continue;
      }
      const isLiving = resolveEffectiveLiving(
        {
          is_living: Boolean(row.is_living),
          birth_edtf: row.birth_edtf == null ? '' : String(row.birth_edtf),
          death_edtf: row.death_edtf == null ? '' : String(row.death_edtf),
        },
        this.privacyConfig,
        referenceYear
      );
      if (isLiving) {
        cached.livingIds.add(row.entity_id);
      } else {
        cached.livingIds.delete(row.entity_id);
      }
    }
  }

  notifyCommittedMutations(operations: readonly AtomicMutationOp[], headRevisionId: RevisionId): void {
    const referenceYear = this.clock.currentYear();
    const cached = livingPeopleCaches.get(this.db);
    if (
      !cached ||
      cached.referenceYear !== referenceYear ||
      cached.privacyKey !== this.privacyKey ||
      headRevisionId !== cached.headRevisionId + operations.length
    ) {
      return;
    }
    for (const op of operations) {
      if (op.entity_type !== 'person') {
        continue;
      }
      if (op.soft_delete === true || op.action === 'delete' || op.after_json === null) {
        cached.livingIds.delete(op.entity_id);
        continue;
      }
      const isLiving = resolveEffectiveLiving(
        {
          is_living: Boolean(op.after_json['is_living']),
          birth_edtf: op.after_json['birth_edtf'] == null ? '' : String(op.after_json['birth_edtf']),
          death_edtf: op.after_json['death_edtf'] == null ? '' : String(op.after_json['death_edtf']),
        },
        this.privacyConfig,
        referenceYear
      );
      if (isLiving) {
        cached.livingIds.add(op.entity_id);
      } else {
        cached.livingIds.delete(op.entity_id);
      }
    }
    cached.headRevisionId = headRevisionId;
  }

  async getHeadRevisionId(): Promise<RevisionId> {
    const rawRow = await prepareD1Statement(this.db, HEAD_REV_SQL).first<unknown>();
    const row = rawRow !== null ? parseDbHeadRevisionRow(rawRow) : null;
    return asRevisionId(row?.head_revision_id ?? 0);
  }

  async getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null> {
    if (entityType === 'kinship_edge') {
      const rawRow = await prepareD1Statement(
        this.db,
        `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                  current_revision_id, deleted_at, updated_at
           FROM kinship_edges
           WHERE edge_id = ?`
      )
        .bind(entityId)
        .first<unknown>();
      return rawRow !== null ? mapKinshipRow(parseDbKinshipRow(rawRow)) : null;
    }

    const rawRow = await prepareD1Statement(
      this.db,
      `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE entity_type = ? AND entity_id = ?`
    )
      .bind(entityType, entityId)
      .first<unknown>();
    return rawRow !== null ? mapEntityRow(parseDbEntityRow(rawRow)) : null;
  }

  async getEntityBySlug(
    entityType: 'person' | 'place' | 'narrative',
    slugOrId: string
  ): Promise<StoredEntityRow | null> {
    const rawRow = await prepareD1Statement(
      this.db,
      `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE entity_type = ? AND deleted_at IS NULL AND (slug = ? OR entity_id = ?)
         LIMIT 1`
    )
      .bind(entityType, slugOrId, slugOrId)
      .first<unknown>();
    return rawRow !== null ? mapEntityRow(parseDbEntityRow(rawRow)) : null;
  }

  async getEntitiesBatch(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>> {
    const result = new Map<string, StoredEntityRecord | null>();
    if (keys.length === 0) {
      return result;
    }

    const statements: D1PreparedStatement[] = [];
    const statementKinds: Array<'kinship_edge' | 'entity'> = [];
    this.buildEntityLookupBatchStatements(keys, result, statements, statementKinds);

    const batchResults = await this.db.batch(statements);
    for (let i = 0; i < batchResults.length; i += 1) {
      const kind = statementKinds[i];
      const rawRows = batchResults[i]?.results ?? [];
      if (kind === 'kinship_edge') {
        for (let j = 0; j < rawRows.length; j += 1) {
          const mapped = mapKinshipRow(parseDbKinshipRow(rawRows[j]));
          result.set(entityLookupCompositeKey('kinship_edge', mapped.edge_id), mapped);
        }
      } else {
        for (let j = 0; j < rawRows.length; j += 1) {
          const mapped = mapEntityRow(parseDbEntityRow(rawRows[j]));
          result.set(entityLookupCompositeKey(mapped.entity_type, mapped.entity_id), mapped);
        }
      }
    }

    return result;
  }

  async prefetchWriteContext(keys: readonly EntityLookupKey[]): Promise<PrefetchedWriteContext> {
    const referenceYear = this.clock.currentYear();
    const cached = livingPeopleCaches.get(this.db);
    const hasWarmLivingCache =
      cached !== undefined &&
      cached.referenceYear === referenceYear &&
      cached.privacyKey === this.privacyKey &&
      cached.headRevisionId > 0;

    const entities = new Map<string, StoredEntityRecord | null>();
    const statements: D1PreparedStatement[] = [prepareD1Statement(this.db, HEAD_REV_SQL)];
    const statementKinds: Array<'kinship_edge' | 'entity'> = [];

    if (hasWarmLivingCache) {
      statements.push(prepareD1Statement(this.db, LIVING_DELTA_SQL).bind(cached.headRevisionId));
    } else {
      statements.push(prepareD1Statement(this.db, LIVING_FULL_SQL));
    }

    this.buildEntityLookupBatchStatements(keys, entities, statements, statementKinds);

    const batchResults = await this.db.batch(statements);
    const headRaw = batchResults[0]?.results[0];
    const headRevNum = headRaw !== undefined ? parseDbHeadRevisionRow(headRaw).head_revision_id : 0;
    const headRevisionId = asRevisionId(headRevNum);

    for (let i = 0; i < statementKinds.length; i += 1) {
      const kind = statementKinds[i];
      const rawRows = batchResults[i + 2]?.results ?? [];
      if (kind === 'kinship_edge') {
        for (let j = 0; j < rawRows.length; j += 1) {
          const mapped = mapKinshipRow(parseDbKinshipRow(rawRows[j]));
          entities.set(entityLookupCompositeKey('kinship_edge', mapped.edge_id), mapped);
        }
      } else {
        for (let j = 0; j < rawRows.length; j += 1) {
          const mapped = mapEntityRow(parseDbEntityRow(rawRows[j]));
          entities.set(entityLookupCompositeKey(mapped.entity_type, mapped.entity_id), mapped);
        }
      }
    }

    let livingPersonIds: ReadonlySet<string>;
    if (hasWarmLivingCache && headRevNum >= cached.headRevisionId) {
      const deltaRows = batchResults[1]?.results ?? [];
      if (deltaRows.length > 0) {
        this.applyLivingDeltaRows(cached, deltaRows, referenceYear);
      }
      cached.headRevisionId = headRevNum;
      livingPersonIds = new Set(cached.livingIds);
    } else if (!hasWarmLivingCache) {
      const living = new Set<string>();
      const peopleRows = batchResults[1]?.results ?? [];
      for (let i = 0; i < peopleRows.length; i += 1) {
        const row = parseDbLivingPersonProjectionRow(peopleRows[i]);
        if (
          resolveEffectiveLiving(
            {
              is_living: Boolean(row.is_living),
              birth_edtf: row.birth_edtf == null ? '' : String(row.birth_edtf),
              death_edtf: row.death_edtf == null ? '' : String(row.death_edtf),
            },
            this.privacyConfig,
            referenceYear
          )
        ) {
          living.add(row.entity_id);
        }
      }
      if (headRevNum > 0) {
        livingPeopleCaches.set(this.db, {
          headRevisionId: headRevNum,
          referenceYear,
          privacyKey: this.privacyKey,
          livingIds: new Set(living),
        });
      }
      livingPersonIds = living;
    } else {
      livingPeopleCaches.delete(this.db);
      livingPersonIds = await this.getLivingPersonIds();
    }

    return {
      headRevisionId,
      livingPersonIds,
      entities,
    };
  }

  async getLivingPersonIds(): Promise<ReadonlySet<string>> {
    const referenceYear = this.clock.currentYear();
    const cached = livingPeopleCaches.get(this.db);

    if (cached && cached.referenceYear === referenceYear && cached.privacyKey === this.privacyKey) {
      const headRev = await this.getHeadRevisionId();
      if (headRev > 0) {
        if (headRev === cached.headRevisionId) {
          return new Set(cached.livingIds);
        }
        if (
          headRev > cached.headRevisionId &&
          headRev - cached.headRevisionId <= MAX_INCREMENTAL_LIVING_REVISIONS
        ) {
          const delta = await prepareD1Statement(this.db, LIVING_DELTA_SQL)
            .bind(cached.headRevisionId)
            .all<unknown>();
          this.applyLivingDeltaRows(cached, delta.results, referenceYear);
          cached.headRevisionId = headRev;
          return new Set(cached.livingIds);
        }
      }
    }

    const [peopleRes, headRes] = await this.db.batch([
      prepareD1Statement(this.db, LIVING_FULL_SQL),
      prepareD1Statement(this.db, HEAD_REV_SQL),
    ]);

    const living = new Set<string>();
    for (const rawRow of peopleRes?.results ?? []) {
      const row = parseDbLivingPersonProjectionRow(rawRow);
      if (
        resolveEffectiveLiving(
          {
            is_living: Boolean(row.is_living),
            birth_edtf: row.birth_edtf == null ? '' : String(row.birth_edtf),
            death_edtf: row.death_edtf == null ? '' : String(row.death_edtf),
          },
          this.privacyConfig,
          referenceYear
        )
      ) {
        living.add(row.entity_id);
      }
    }

    const headRaw = headRes?.results[0];
    const headRev = headRaw !== undefined ? parseDbHeadRevisionRow(headRaw).head_revision_id : 0;
    if (headRev > 0) {
      livingPeopleCaches.set(this.db, {
        headRevisionId: headRev,
        referenceYear,
        privacyKey: this.privacyKey,
        livingIds: new Set(living),
      });
    }

    return living;
  }

  async loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    const [entitiesRes, kinshipRes, headRes] = await this.db.batch([
      prepareD1Statement(
        this.db,
        `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE deleted_at IS NULL
         ORDER BY entity_type, entity_id`
      ),
      prepareD1Statement(
        this.db,
        `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                current_revision_id, deleted_at, updated_at
         FROM kinship_edges
         WHERE deleted_at IS NULL`
      ),
      prepareD1Statement(this.db, HEAD_REV_SQL),
    ]);

    const entities = (entitiesRes?.results ?? []).map((rawRow) => mapEntityRow(parseDbEntityRow(rawRow)));
    const kinship = (kinshipRes?.results ?? [])
      .map((rawRow) => mapKinshipRow(parseDbKinshipRow(rawRow)))
      .toSorted((a, b) => fastLocaleCompare(a.edge_id, b.edge_id));
    const headRaw = headRes?.results[0];
    const headRow = headRaw !== undefined ? parseDbHeadRevisionRow(headRaw) : undefined;

    return {
      head_revision_id: asRevisionId(headRow?.head_revision_id ?? 0),
      entities,
      kinship,
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
    let res: { results: unknown[] };
    try {
      res = await prepareD1Statement(
        this.db,
        `${REVISION_WITH_REVIEW_SELECT}
         ${whereSql}
         ORDER BY revision_id DESC
         LIMIT ?`
      )
        .bind(...bindings, limit + 1)
        .all<unknown>();
    } catch (error) {
      if (!isMissingStewardReviewsTableError(error)) {
        throw error;
      }
      res = await prepareD1Statement(
        this.db,
        `${REVISION_BASE_SELECT}
         ${whereSql}
         ORDER BY revision_id DESC
         LIMIT ?`
      )
        .bind(...bindings, limit + 1)
        .all<unknown>();
    }

    const hasMore = res.results.length > limit;
    const sliced = hasMore ? res.results.slice(0, limit) : res.results;
    const items = sliced.map((rawRow) => mapRevisionRow(parseDbRevisionRow(rawRow)));
    const lastItem = items[items.length - 1];

    return {
      items,
      next_cursor: hasMore && lastItem ? asRevisionId(lastItem.revision_id) : null,
    };
  }

  async getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    let rawRow: unknown;
    try {
      rawRow = await prepareD1Statement(
        this.db,
        `${REVISION_WITH_REVIEW_SELECT}
         WHERE revision_id = ?`
      )
        .bind(revisionId)
        .first<unknown>();
    } catch (error) {
      if (!isMissingStewardReviewsTableError(error)) {
        throw error;
      }
      rawRow = await prepareD1Statement(
        this.db,
        `${REVISION_BASE_SELECT}
         WHERE revision_id = ?`
      )
        .bind(revisionId)
        .first<unknown>();
    }
    return rawRow !== null ? mapRevisionRow(parseDbRevisionRow(rawRow)) : null;
  }

  async getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    let res: { results: unknown[] };
    try {
      res = await prepareD1Statement(
        this.db,
        `${REVISION_WITH_REVIEW_SELECT}
         WHERE batch_id = ? AND batch_id IS NOT NULL
         ORDER BY revision_id ASC`
      )
        .bind(batchId)
        .all<unknown>();
    } catch (error) {
      if (!isMissingStewardReviewsTableError(error)) {
        throw error;
      }
      res = await prepareD1Statement(
        this.db,
        `${REVISION_BASE_SELECT}
         WHERE batch_id = ? AND batch_id IS NOT NULL
         ORDER BY revision_id ASC`
      )
        .bind(batchId)
        .all<unknown>();
    }
    return res.results.map((rawRow) => mapRevisionRow(parseDbRevisionRow(rawRow)));
  }

  async upsertStewardReview(input: {
    target_kind: StewardReviewTargetKind;
    target_id: string;
    reviewer_id: string;
    reviewer_name: string;
    note: string | null;
    reviewed_at: string;
  }): Promise<StewardReviewStamp> {
    await prepareD1Statement(
      this.db,
      `INSERT INTO steward_reviews (target_kind, target_id, reviewer_id, reviewer_name, note, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(target_kind, target_id) DO UPDATE SET
         reviewer_id = excluded.reviewer_id,
         reviewer_name = excluded.reviewer_name,
         note = excluded.note,
         reviewed_at = excluded.reviewed_at`
    )
      .bind(
        input.target_kind,
        input.target_id,
        input.reviewer_id,
        input.reviewer_name,
        input.note,
        input.reviewed_at
      )
      .run();

    return {
      target_kind: input.target_kind,
      target_id: input.target_id,
      reviewer_id: input.reviewer_id,
      reviewer_name: input.reviewer_name,
      note: input.note,
      reviewed_at: input.reviewed_at,
    };
  }

  async deleteStewardReview(targetKind: StewardReviewTargetKind, targetId: string): Promise<boolean> {
    const res = await prepareD1Statement(
      this.db,
      `DELETE FROM steward_reviews
       WHERE target_kind = ? AND target_id = ?`
    )
      .bind(targetKind, targetId)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  }
}
