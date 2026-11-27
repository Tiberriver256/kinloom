import {
  type ArchiveRawSnapshot,
  asRevisionId,
  type BatchId,
  type Clock,
  type EntityLookupKey,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  type PrivacyConfig,
  type RevisionId,
  type RevisionLogStore,
  type RevisionQuery,
  type RevisionRecord,
  resolveEffectiveLiving,
  type StoredEntityRecord,
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
  type RawDbEntityRow,
  type RawDbKinshipRow,
  type RawDbRevisionRow,
} from './rowMappers.js';
import { chunkJsonArray, prepareD1Statement } from './sqlHelpers.js';

export class D1EntityReadStore implements EntityReadStore, RevisionLogStore {
  private readonly clock: Clock;

  constructor(
    private readonly db: D1Database,
    private readonly privacyConfig?: Partial<PrivacyConfig>,
    clock?: Clock
  ) {
    this.clock = clock ?? new SystemClock();
  }

  async getHeadRevisionId(): Promise<RevisionId> {
    const row = await prepareD1Statement(
      this.db,
      'SELECT COALESCE(MAX(revision_id), 0) AS head_revision_id FROM revisions'
    ).first<{ head_revision_id: number }>();
    return asRevisionId(row?.head_revision_id ?? 0);
  }

  async getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null> {
    if (entityType === 'kinship_edge') {
      const row = await prepareD1Statement(
        this.db,
        `SELECT edge_id, from_person_id, to_person_id, relation, family_xref,
                  current_revision_id, deleted_at, updated_at
           FROM kinship_edges
           WHERE edge_id = ?`
      )
        .bind(entityId)
        .first<RawDbKinshipRow>();
      return row ? mapKinshipRow(row) : null;
    }

    const row = await prepareD1Statement(
      this.db,
      `SELECT entity_type, entity_id, slug, data_json, current_revision_id,
                has_primary_source, deleted_at, updated_at
         FROM entities
         WHERE entity_type = ? AND entity_id = ?`
    )
      .bind(entityType, entityId)
      .first<RawDbEntityRow>();
    return row ? mapEntityRow(row) : null;
  }

  async getEntitiesBatch(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>> {
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

    const batchResults = await this.db.batch(statements);
    for (let i = 0; i < batchResults.length; i += 1) {
      const kind = statementKinds[i];
      const rawRows = batchResults[i]?.results ?? [];
      if (kind === 'kinship_edge') {
        for (const rawRow of rawRows) {
          const mapped = mapKinshipRow(parseDbKinshipRow(rawRow));
          result.set(entityLookupCompositeKey('kinship_edge', mapped.edge_id), mapped);
        }
      } else {
        for (const rawRow of rawRows) {
          const mapped = mapEntityRow(parseDbEntityRow(rawRow));
          result.set(entityLookupCompositeKey(mapped.entity_type, mapped.entity_id), mapped);
        }
      }
    }

    return result;
  }

  async getLivingPersonIds(): Promise<ReadonlySet<string>> {
    const result = await prepareD1Statement(
      this.db,
      `SELECT entity_id,
                json_extract(data_json, '$.is_living') AS is_living,
                json_extract(data_json, '$.birth_edtf') AS birth_edtf,
                json_extract(data_json, '$.death_edtf') AS death_edtf
         FROM entities
         WHERE entity_type = 'person' AND deleted_at IS NULL`
    ).all<{
      entity_id: string;
      is_living: number | boolean | null;
      birth_edtf: string | number | null;
      death_edtf: string | number | null;
    }>();

    const living = new Set<string>();
    const referenceYear = this.clock.currentYear();
    for (const row of result.results) {
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
      prepareD1Statement(this.db, 'SELECT COALESCE(MAX(revision_id), 0) AS head_revision_id FROM revisions'),
    ]);

    const entities = entitiesRes.results.map((rawRow) => mapEntityRow(parseDbEntityRow(rawRow)));
    const kinship = kinshipRes.results
      .map((rawRow) => mapKinshipRow(parseDbKinshipRow(rawRow)))
      .toSorted((a, b) => a.edge_id.localeCompare(b.edge_id));
    const headRaw = headRes.results[0];
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
    const res = await prepareD1Statement(
      this.db,
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
    const row = await prepareD1Statement(
      this.db,
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
    const res = await prepareD1Statement(
      this.db,
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
}
