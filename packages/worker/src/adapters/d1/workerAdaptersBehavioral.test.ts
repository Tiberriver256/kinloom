import {
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  type AtomicMutationOp,
  asBatchId,
  asRevisionId,
  asSha256Hex,
  type EntityReadStore,
  type RevisionAuthor,
  type StoredEntityRow,
  type StoredKinshipRow,
} from '@kinloom/core';
import { FixedClock } from '@kinloom/server';
import { createSyntheticSiteConfig } from '@kinloom/server/testing';
import { describe, expect, it, vi } from 'vitest';
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
  R2Bucket,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
} from '../../types.js';
import { computeSiteConfigHash, R2IncrementalPatchBundleCache } from '../r2BundleCache.js';
import { D1AccessAndTalkStore } from './accessAndTalkStore.js';
import { D1AtomicMutationStore } from './atomicMutationStore.js';
import { D1EntityReadStore } from './entityReadStore.js';
import {
  parseDbAgentTokenRow,
  parseDbAuthorNameRow,
  parseDbCountRow,
  parseDbInviteRow,
  parseDbLivingPersonProjectionRow,
  parseDbMagicLinkRow,
  parseDbPronunciationLexiconRow,
  parseDbRevisionRow,
  parseDbUserRow,
} from './rowMappers.js';

interface RecordedStatement {
  readonly sql: string;
  readonly bindings: readonly unknown[];
}

interface StubD1Handlers {
  readonly onFirst?: (stmt: RecordedStatement) => Promise<unknown> | unknown;
  readonly onRun?: (stmt: RecordedStatement) => Promise<D1Result<unknown>> | D1Result<unknown>;
  readonly onAll?: (stmt: RecordedStatement) => Promise<D1Result<unknown>> | D1Result<unknown>;
  readonly onBatch?: (
    stmts: readonly RecordedStatement[]
  ) => Promise<D1Result<unknown>[]> | D1Result<unknown>[];
}

function makeD1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    meta: { changes },
    results,
  };
}

function createStubD1Database(handlers: StubD1Handlers): {
  db: D1Database;
  recorded: RecordedStatement[];
} {
  const recorded: RecordedStatement[] = [];
  const statementMeta = new WeakMap<D1PreparedStatement, RecordedStatement>();

  const makeStatement = (sql: string, bindings: readonly unknown[]): D1PreparedStatement => {
    const info: RecordedStatement = { sql, bindings };
    const stmt: D1PreparedStatement = {
      bind(...values: unknown[]): D1PreparedStatement {
        return makeStatement(sql, values);
      },
      async first<T = Record<string, unknown>>(): Promise<T | null> {
        recorded.push(info);
        if (!handlers.onFirst) {
          return null;
        }
        return (await handlers.onFirst(info)) as T | null;
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        recorded.push(info);
        if (!handlers.onRun) {
          return makeD1Result<T>([], 1);
        }
        return (await handlers.onRun(info)) as D1Result<T>;
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        recorded.push(info);
        if (!handlers.onAll) {
          return makeD1Result<T>([]);
        }
        return (await handlers.onAll(info)) as D1Result<T>;
      },
    };
    statementMeta.set(stmt, info);
    return stmt;
  };

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query, []);
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const infos = statements.map((s) => statementMeta.get(s) ?? { sql: '', bindings: [] });
      for (const info of infos) {
        recorded.push(info);
      }
      if (!handlers.onBatch) {
        return infos.map(() => makeD1Result<T>([]));
      }
      return (await handlers.onBatch(infos)) as D1Result<T>[];
    },
    async exec(): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
  };

  return { db, recorded };
}

const AUTHOR: RevisionAuthor = {
  author_id: 'editor@archive.example.test',
  author_name: 'Jane Doe',
  author_type: 'human',
};

const NOW_ISO = '2026-11-27T08:00:00.000Z';

function makeStoredSource(overrides: Partial<StoredEntityRow> = {}): StoredEntityRow {
  return {
    entity_type: 'source',
    entity_id: 'src_oakville_1880',
    slug: null,
    data: {
      id: 'src_oakville_1880',
      citation: '1880 Census, Oakville',
      source_type: 'census',
      has_primary_source: true,
    },
    current_revision_id: asRevisionId(3),
    has_primary_source: true,
    deleted_at: null,
    updated_at: '2026-11-20T00:00:00.000Z',
    ...overrides,
  };
}

function createStubReadStore(options: {
  headRevisionId?: number;
  entities?: ReadonlyMap<string, StoredEntityRow | StoredKinshipRow>;
}): Pick<EntityReadStore, 'getHeadRevisionId' | 'getEntity'> & {
  getEntitiesBatch: NonNullable<EntityReadStore['getEntitiesBatch']>;
} {
  const entities = options.entities ?? new Map<string, StoredEntityRow | StoredKinshipRow>();
  return {
    async getHeadRevisionId() {
      return asRevisionId(options.headRevisionId ?? 0);
    },
    async getEntity(entityType, entityId) {
      return entities.get(`${entityType}:${entityId}`) ?? null;
    },
    async getEntitiesBatch(keys) {
      const out = new Map<string, StoredEntityRow | StoredKinshipRow | null>();
      for (const k of keys) {
        const key = `${k.entityType}:${k.entityId}`;
        out.set(key, entities.get(key) ?? null);
      }
      return out;
    },
  };
}

describe('D1AtomicMutationStore error, conflict, and statement-variant behaviors', () => {
  it('returns committed empty result without executing a D1 batch when operations is empty', async () => {
    const onBatch = vi.fn(() => []);
    const { db } = createStubD1Database({ onBatch });
    const store = new D1AtomicMutationStore(db, createStubReadStore({ headRevisionId: 9 }));

    const result = await store.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [],
    });

    expect(result).toEqual({
      kind: 'committed',
      head_revision_id: asRevisionId(9),
      revisions: [],
    });
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('rejects create operations missing after_json before calling D1 batch', async () => {
    const { db } = createStubD1Database({});
    const store = new D1AtomicMutationStore(db, createStubReadStore({}));

    const badCreate: AtomicMutationOp = {
      entity_type: 'person',
      entity_id: 'per_missing_payload',
      action: 'create',
      expected_parent_revision_id: null,
      summary: 'Invalid create',
      has_primary_source: false,
      before_json: null,
      after_json: null,
    };

    await expect(
      store.commitAtomicMutations({
        batch_id: null,
        author: AUTHOR,
        nowIso: NOW_ISO,
        operations: [badCreate],
      })
    ).rejects.toThrow('Create person operation requires after_json.');
  });

  it('returns immediate conflict via buildConflictForOp when non-create op passes null expected_parent_revision_id', async () => {
    const existing = makeStoredSource();
    const { db } = createStubD1Database({
      onFirst: () => ({ author_name: 'Clara Oak' }),
    });
    const store = new D1AtomicMutationStore(
      db,
      createStubReadStore({
        entities: new Map([['source:src_oakville_1880', existing]]),
      })
    );

    const conflictExisting = await store.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_oakville_1880',
          action: 'update',
          expected_parent_revision_id: null,
          summary: 'Missing expected rev',
          has_primary_source: true,
          before_json: existing.data,
          after_json: {
            id: 'src_oakville_1880',
            citation: '1880 Census, Oakville (revised)',
            source_type: 'census',
            has_primary_source: true,
          },
        },
      ],
    });

    expect(conflictExisting.kind).toBe('conflict');
    if (conflictExisting.kind === 'conflict') {
      expect(conflictExisting.server_revision_id).toBe(asRevisionId(3));
      expect(conflictExisting.last_author_name).toBe('Clara Oak');
      expect(conflictExisting.server_entity).toEqual(existing.data);
    }

    const emptyStore = new D1AtomicMutationStore(db, createStubReadStore({}));
    const conflictMissing = await emptyStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_absent',
          action: 'update',
          expected_parent_revision_id: null,
          summary: 'Update missing entity',
          has_primary_source: false,
          before_json: null,
          after_json: {
            id: 'src_absent',
            citation: 'Absent source',
            source_type: 'other',
          },
        },
      ],
    });

    expect(conflictMissing).toMatchObject({
      kind: 'conflict',
      entity_type: 'source',
      entity_id: 'src_absent',
      server_revision_id: asRevisionId(0),
      server_entity: null,
      server_deleted_at: null,
      last_author_name: 'None',
      last_updated_at: NOW_ISO,
    });
  });

  it('commits kinship_edge payload updates and slugless entity updates with exact SQL statements', async () => {
    const { db, recorded } = createStubD1Database({
      onBatch: (stmts) =>
        stmts.map((s, idx) => {
          if (s.sql.includes('INSERT INTO revisions')) {
            return makeD1Result([
              { revision_id: idx === 0 ? 10 : 11, parent_revision_id: idx === 0 ? 4 : 3 },
            ]);
          }
          return makeD1Result([], 1);
        }),
    });
    const store = new D1AtomicMutationStore(db, createStubReadStore({}));

    const result = await store.commitAtomicMutations({
      batch_id: asBatchId('batch_update_variants'),
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'kinship_edge',
          entity_id: 'edge_1',
          action: 'update',
          expected_parent_revision_id: asRevisionId(4),
          summary: 'Update kinship edge xref',
          has_primary_source: false,
          before_json: { from: 'per_parent', to: 'per_child', relation: 'parent' },
          after_json: { from: 'per_parent', to: 'per_child', relation: 'parent', family_xref: '@F9@' },
        },
        {
          entity_type: 'source',
          entity_id: 'src_oakville_1880',
          action: 'update',
          expected_parent_revision_id: asRevisionId(3),
          summary: 'Update slugless source',
          has_primary_source: true,
          before_json: makeStoredSource().data,
          after_json: {
            id: 'src_oakville_1880',
            citation: '1880 Census, Oakville, Sheet 4B',
            source_type: 'census',
            has_primary_source: true,
          },
        },
      ],
    });

    expect(result.kind).toBe('committed');
    if (result.kind === 'committed') {
      expect(result.head_revision_id).toBe(asRevisionId(11));
      expect(result.revisions).toHaveLength(2);
      expect(result.revisions[0]!.revision_id).toBe(asRevisionId(10));
      expect(result.revisions[1]!.revision_id).toBe(asRevisionId(11));
    }

    const kinshipUpdate = recorded.find(
      (s) => s.sql.includes('UPDATE kinship_edges') && s.sql.includes('from_person_id = ?')
    );
    expect(kinshipUpdate?.bindings).toEqual([
      'per_parent',
      'per_child',
      'parent',
      '@F9@',
      null,
      NOW_ISO,
      'edge_1',
    ]);

    const sluglessUpdate = recorded.find(
      (s) => s.sql.includes('UPDATE entities') && !s.sql.includes('SET slug = ?')
    );
    expect(sluglessUpdate).toBeDefined();
    expect(sluglessUpdate?.bindings[4]).toBe('source');
    expect(sluglessUpdate?.bindings[5]).toBe('src_oakville_1880');
  });

  it('throws clear errors when D1 returning rows are missing or when a non-constraint D1 error occurs', async () => {
    const missingCreateRowsDb = createStubD1Database({
      onBatch: () => [makeD1Result([]), makeD1Result([])],
    }).db;
    const createStore = new D1AtomicMutationStore(missingCreateRowsDb, createStubReadStore({}));

    await expect(
      createStore.commitAtomicMutations({
        batch_id: null,
        author: AUTHOR,
        nowIso: NOW_ISO,
        operations: [
          {
            entity_type: 'source',
            entity_id: 'src_1',
            action: 'create',
            expected_parent_revision_id: null,
            summary: 'Create source',
            has_primary_source: true,
            before_json: null,
            after_json: { id: 'src_1', citation: '1890 Ledger', source_type: 'other' },
          },
        ],
      })
    ).rejects.toThrow('D1 create revision insert returned 0 rows for 1 operations.');

    const missingSingleRowDb = createStubD1Database({
      onBatch: () => [makeD1Result([]), makeD1Result([])],
    }).db;
    const singleStore = new D1AtomicMutationStore(missingSingleRowDb, createStubReadStore({}));

    await expect(
      singleStore.commitAtomicMutations({
        batch_id: null,
        author: AUTHOR,
        nowIso: NOW_ISO,
        operations: [
          {
            entity_type: 'source',
            entity_id: 'src_1',
            action: 'update',
            expected_parent_revision_id: asRevisionId(1),
            summary: 'Update source',
            has_primary_source: true,
            before_json: null,
            after_json: { id: 'src_1', citation: '1890 Ledger', source_type: 'other' },
          },
        ],
      })
    ).rejects.toThrow('D1 revision insert did not return the inserted revision row.');

    const transientFailureDb = createStubD1Database({
      onBatch: () => {
        throw new Error('D1_INTERNAL_OVERLOADED');
      },
    }).db;
    const failureStore = new D1AtomicMutationStore(transientFailureDb, createStubReadStore({}));

    await expect(
      failureStore.commitAtomicMutations({
        batch_id: null,
        author: AUTHOR,
        nowIso: NOW_ISO,
        operations: [
          {
            entity_type: 'source',
            entity_id: 'src_1',
            action: 'update',
            expected_parent_revision_id: asRevisionId(1),
            summary: 'Update source',
            has_primary_source: true,
            before_json: null,
            after_json: { id: 'src_1', citation: '1890 Ledger', source_type: 'other' },
          },
        ],
      })
    ).rejects.toThrow('D1_INTERNAL_OVERLOADED');
  });

  it('resolves SQLITE_CONSTRAINT conflicts across duplicate creates, missing targets, deleted rows, active restores, and fallback collisions', async () => {
    const constraintDb = (authorName: string | null) =>
      createStubD1Database({
        onBatch: () => {
          throw new Error('SQLITE_CONSTRAINT: CHECK constraint failed');
        },
        onFirst: () => (authorName !== null ? { author_name: authorName } : null),
      }).db;

    const existingActive = makeStoredSource();
    const existingDeleted = makeStoredSource({
      entity_id: 'src_deleted',
      current_revision_id: asRevisionId(5),
      deleted_at: '2026-11-22T00:00:00.000Z',
    });

    // 1. Create on already-existing entity
    const dupExistingStore = new D1AtomicMutationStore(
      constraintDb('Jane Doe'),
      createStubReadStore({ entities: new Map([['source:src_oakville_1880', existingActive]]) })
    );
    const r1 = await dupExistingStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_oakville_1880',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Duplicate create',
          has_primary_source: true,
          before_json: null,
          after_json: existingActive.data,
        },
      ],
    });
    expect(r1).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_oakville_1880',
      server_revision_id: asRevisionId(3),
      last_author_name: 'Jane Doe',
    });

    // 2. Duplicate create of same new entity within a single batch (alreadySeen)
    const emptyReadStore = createStubReadStore({});
    const dupBatchStore = new D1AtomicMutationStore(constraintDb(null), emptyReadStore);
    const r2 = await dupBatchStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_new',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'First create',
          has_primary_source: false,
          before_json: null,
          after_json: { id: 'src_new', citation: 'A', source_type: 'other' },
        },
        {
          entity_type: 'source',
          entity_id: 'src_new',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Second create',
          has_primary_source: false,
          before_json: null,
          after_json: { id: 'src_new', citation: 'B', source_type: 'other' },
        },
      ],
    });
    expect(r2).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_new',
      server_revision_id: asRevisionId(0),
      last_author_name: 'None',
    });

    // 3. Create + follow-up null-parent update in same batch, followed by update of missing entity
    const r3 = await dupBatchStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_chain',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Create chain',
          has_primary_source: false,
          before_json: null,
          after_json: { id: 'src_chain', citation: 'Initial', source_type: 'other' },
        },
        {
          entity_type: 'source',
          entity_id: 'src_chain',
          action: 'update',
          expected_parent_revision_id: null,
          summary: 'In-batch update',
          has_primary_source: false,
          before_json: { id: 'src_chain', citation: 'Initial', source_type: 'other' },
          after_json: { id: 'src_chain', citation: 'Amended', source_type: 'other' },
        },
        {
          entity_type: 'source',
          entity_id: 'src_ghost',
          action: 'update',
          expected_parent_revision_id: asRevisionId(2),
          summary: 'Update non-existent entity',
          has_primary_source: false,
          before_json: null,
          after_json: { id: 'src_ghost', citation: 'Ghost', source_type: 'other' },
        },
      ],
    });
    expect(r3).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_ghost',
      server_revision_id: asRevisionId(0),
      last_author_name: 'None',
    });

    // 4. Update on soft-deleted row matching expected_parent_revision_id
    const deletedStore = new D1AtomicMutationStore(
      constraintDb(null),
      createStubReadStore({ entities: new Map([['source:src_deleted', existingDeleted]]) })
    );
    const r4 = await deletedStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_deleted',
          action: 'update',
          expected_parent_revision_id: asRevisionId(5),
          summary: 'Update soft-deleted source',
          has_primary_source: true,
          before_json: null,
          after_json: existingDeleted.data,
        },
      ],
    });
    expect(r4).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_deleted',
      server_revision_id: asRevisionId(5),
      server_entity: null,
      server_deleted_at: '2026-11-22T00:00:00.000Z',
      last_author_name: 'Unknown editor',
    });

    // 5. Restore on already-active row matching expected_parent_revision_id
    const r5 = await dupExistingStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_oakville_1880',
          action: 'restore',
          expected_parent_revision_id: asRevisionId(3),
          summary: 'Restore already active source',
          has_primary_source: true,
          before_json: null,
          after_json: existingActive.data,
        },
      ],
    });
    expect(r5).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_oakville_1880',
      server_revision_id: asRevisionId(3),
      server_deleted_at: null,
      server_entity: existingActive.data,
    });

    // 6. Fallback path: unique slug constraint failure even though revision & active status match
    const r6 = await dupExistingStore.commitAtomicMutations({
      batch_id: null,
      author: AUTHOR,
      nowIso: NOW_ISO,
      operations: [
        {
          entity_type: 'source',
          entity_id: 'src_oakville_1880',
          action: 'update',
          expected_parent_revision_id: asRevisionId(3),
          summary: 'Slug collision on update',
          has_primary_source: true,
          before_json: existingActive.data,
          after_json: existingActive.data,
        },
      ],
    });
    expect(r6).toMatchObject({
      kind: 'conflict',
      entity_id: 'src_oakville_1880',
      server_revision_id: asRevisionId(3),
      last_author_name: 'Jane Doe',
    });
  });
});

describe('R2IncrementalPatchBundleCache edge paths and precondition races', () => {
  const siteConfig = createSyntheticSiteConfig();
  const configHash = computeSiteConfigHash(siteConfig);
  const clock = new FixedClock(new Date(NOW_ISO));

  function makeR2Body(
    text: string,
    meta: { key?: string; etag?: string; customMetadata?: Record<string, string>; cancelReject?: boolean }
  ): R2ObjectBody {
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        if (meta.cancelReject) {
          return Promise.reject(new Error('stream already closed'));
        }
        return undefined;
      },
    });
    return {
      key: meta.key ?? 'compiled/archive.json',
      size: bytes.byteLength,
      etag: meta.etag ?? 'r2-etag-1',
      uploaded: new Date(NOW_ISO),
      ...(meta.customMetadata !== undefined ? { customMetadata: meta.customMetadata } : {}),
      body,
      bodyUsed: false,
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
      async text() {
        return text;
      },
    };
  }

  it('returns miss when head() is null for conditional getCached and cancels streams on malformed revision metadata', async () => {
    const getSpy = vi.fn(async (): Promise<R2ObjectBody | null> => null);
    const bucket: R2Bucket = {
      head: async () => null,
      get: getSpy,
      put: async () => null,
      delete: async () => undefined,
    };
    const cache = new R2IncrementalPatchBundleCache({ bucket, siteConfig, clock });

    expect(await cache.getCached(`"r1-${configHash}"`)).toEqual({ status: 'miss' });
    expect(getSpy).not.toHaveBeenCalled();

    // Non-numeric revision metadata -> cancels body (even if cancel rejects) and returns miss
    const corruptBucket: R2Bucket = {
      head: async () => null,
      get: async () =>
        makeR2Body('{}', {
          customMetadata: { revision: 'abc', config_hash: configHash },
          cancelReject: true,
        }),
      put: async () => null,
      delete: async () => undefined,
    };
    const corruptCache = new R2IncrementalPatchBundleCache({ bucket: corruptBucket, siteConfig, clock });
    expect(await corruptCache.getCached(null)).toEqual({ status: 'miss' });

    // Unsafe integer revision metadata -> parseRevisionMetadata returns null -> miss
    const unsafeIntBucket: R2Bucket = {
      head: async () => null,
      get: async () =>
        makeR2Body('{}', {
          customMetadata: { revision: '99999999999999999999', config_hash: configHash },
        }),
      put: async () => null,
      delete: async () => undefined,
    };
    const unsafeCache = new R2IncrementalPatchBundleCache({ bucket: unsafeIntBucket, siteConfig, clock });
    expect(await unsafeCache.getCached(null)).toEqual({ status: 'miss' });
  });

  it('returns not_modified and cancels body when object updates between head() and get() to match If-None-Match', async () => {
    const targetEtag = `"r2-${configHash}"`;
    const bucket: R2Bucket = {
      head: async (): Promise<R2Object> => ({
        key: 'compiled/archive.json',
        size: 2,
        etag: 'raw-1',
        uploaded: new Date(NOW_ISO),
        customMetadata: {
          revision: '1',
          config_hash: configHash,
          etag: `"r1-${configHash}"`,
        },
      }),
      get: async () =>
        makeR2Body('{}', {
          customMetadata: {
            revision: '2',
            config_hash: configHash,
            etag: targetEtag,
          },
          cancelReject: true,
        }),
      put: async () => null,
      delete: async () => undefined,
    };

    const cache = new R2IncrementalPatchBundleCache({ bucket, siteConfig, clock });
    expect(await cache.getCached(targetEtag)).toEqual({
      status: 'not_modified',
      etag: targetEtag,
    });
  });

  it('retries when a fresher head disappears before get(), and handles exhausted put() preconditions with fresher hit or local fallback', async () => {
    const emptySnapshot: ArchiveRawSnapshot = {
      head_revision_id: asRevisionId(2),
      entities: [],
      kinship: [],
    };

    // Case 1: first head reports fresher rev 10, getCached misses (vanished), second attempt succeeds
    let headCall = 0;
    const retryBucket: R2Bucket = {
      head: async (): Promise<R2Object | null> => {
        headCall += 1;
        if (headCall === 1) {
          return {
            key: 'compiled/archive.json',
            size: 10,
            etag: 'fresher-etag',
            uploaded: new Date(NOW_ISO),
            customMetadata: {
              revision: '10',
              config_hash: configHash,
              etag: `"r10-${configHash}"`,
            },
          };
        }
        return null;
      },
      get: async () => null,
      put: async (key, _val, options?: R2PutOptions): Promise<R2Object> => ({
        key,
        size: 100,
        etag: 'stored-etag',
        uploaded: new Date(NOW_ISO),
        ...(options?.customMetadata !== undefined ? { customMetadata: options.customMetadata } : {}),
      }),
      delete: async () => undefined,
    };

    const retryCache = new R2IncrementalPatchBundleCache({ bucket: retryBucket, siteConfig, clock });
    const stored = await retryCache.rebuildAndStore(emptySnapshot);
    expect(stored.revision_id).toBe(asRevisionId(2));
    expect(headCall).toBe(2);

    // Case 2: all 5 put() attempts return null, then getCached(null) returns a fresher hit (rev 5)
    let hitBucketGetCalled = false;
    const fresherHitBucket: R2Bucket = {
      head: async () => null,
      get: async () => {
        hitBucketGetCalled = true;
        return makeR2Body(JSON.stringify({ meta: { max_revision_id: 5 } }), {
          customMetadata: {
            revision: '5',
            config_hash: configHash,
            etag: `"r5-${configHash}"`,
            generated_at: NOW_ISO,
          },
        });
      },
      put: async () => null,
      delete: async () => undefined,
    };
    const fresherHitCache = new R2IncrementalPatchBundleCache({
      bucket: fresherHitBucket,
      siteConfig,
      clock,
    });
    const resolvedFresher = await fresherHitCache.rebuildAndStore(emptySnapshot);
    expect(hitBucketGetCalled).toBe(true);
    expect(resolvedFresher.revision_id).toBe(asRevisionId(5));
    expect(resolvedFresher.etag).toBe(`"r5-${configHash}"`);

    // Case 3: all 5 put() attempts return null and final getCached(null) misses -> falls back to local bundle
    const fallbackBucket: R2Bucket = {
      head: async () => null,
      get: async () => null,
      put: async () => null,
      delete: async () => undefined,
    };
    const fallbackCache = new R2IncrementalPatchBundleCache({
      bucket: fallbackBucket,
      siteConfig,
      clock,
    });
    const fallbackObj = await fallbackCache.rebuildAndStore(emptySnapshot);
    expect(fallbackObj.revision_id).toBe(asRevisionId(2));
    expect(fallbackObj.etag).toBe(`"r2-${configHash}"`);
    const parsed = fallbackObj.parsedBundle as ArchiveBundle | undefined;
    expect(parsed?.meta.max_revision_id).toBe(2);
  });
});

describe('D1 rowMappers strict envelope and projection field checks', () => {
  it('rejects non-object rows for count, author, projection, revision, user, invite, magic-link, agent-token, and pronunciation tables', () => {
    expect(() => parseDbCountRow(null)).toThrow('Expected D1 count row object.');
    expect(() => parseDbAuthorNameRow('bad')).toThrow('Expected D1 author_name row object.');
    expect(() => parseDbLivingPersonProjectionRow([])).toThrow(
      'Expected D1 living person projection row object.'
    );
    expect(() => parseDbRevisionRow(null)).toThrow('Expected D1 revision row object.');
    expect(() => parseDbUserRow(123)).toThrow('Expected D1 user row object.');
    expect(() => parseDbInviteRow(null)).toThrow('Expected D1 invite row object.');
    expect(() => parseDbMagicLinkRow(false)).toThrow('Expected D1 magic link row object.');
    expect(() => parseDbAgentTokenRow([])).toThrow('Expected D1 agent token row object.');
    expect(() => parseDbPronunciationLexiconRow(null)).toThrow(
      'Expected D1 pronunciation lexicon row object.'
    );
  });

  it('handles null living-projection flags and rejects invalid non-string/number EDTF projection fields', () => {
    expect(
      parseDbLivingPersonProjectionRow({
        entity_id: 'per_oak',
        is_living: null,
        birth_edtf: null,
        death_edtf: 1920,
      })
    ).toEqual({
      entity_id: 'per_oak',
      is_living: null,
      birth_edtf: null,
      death_edtf: 1920,
    });

    expect(() =>
      parseDbLivingPersonProjectionRow({
        entity_id: 'per_oak',
        is_living: 0,
        birth_edtf: { invalid: true },
        death_edtf: null,
      })
    ).toThrow("D1 row field 'birth_edtf' must be a string, finite number, or null.");
  });
});

describe('D1AccessAndTalkStore and D1EntityReadStore edge and query behaviors', () => {
  it('normalizes email in updateUserRole and touchUserLogin, and throws when RETURNING yields null', async () => {
    const updatedUserRow = {
      email: 'jane@archive.example.test',
      display_name: 'Jane Doe',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: '2026-11-01T00:00:00.000Z',
      last_login_at: null,
    };

    const { db, recorded } = createStubD1Database({
      onFirst: (stmt) => {
        if (stmt.sql.includes('UPDATE users') && stmt.bindings[1] === 'jane@archive.example.test') {
          return updatedUserRow;
        }
        return null;
      },
      onRun: () => makeD1Result([], 1),
    });
    const store = new D1AccessAndTalkStore(db);

    const updated = await store.updateUserRole('  Jane@Archive.Example.Test  ', 'admin');
    expect(updated).toEqual(updatedUserRow);

    const missing = await store.updateUserRole('absent@archive.example.test', 'editor');
    expect(missing).toBeNull();

    await store.touchUserLogin('  Jane@Archive.Example.Test ', NOW_ISO);
    const touchStmt = recorded.find((s) => s.sql.includes('SET last_login_at = ?'));
    expect(touchStmt?.bindings).toEqual([NOW_ISO, 'jane@archive.example.test']);

    await expect(
      store.insertTalkComment({
        entity_type: 'person',
        entity_id: 'per_1',
        author_id: 'jane@archive.example.test',
        author_name: 'Jane Doe',
        body_md: 'Check census date.',
        created_at: NOW_ISO,
      })
    ).rejects.toThrow('Failed to insert talk comment.');

    await expect(
      store.upsertUser({
        email: 'Jane@Archive.Example.Test',
        display_name: 'Jane Doe',
        role: 'editor',
        added_by: 'bootstrap',
        added_at: NOW_ISO,
        last_login_at: null,
      })
    ).rejects.toThrow("Failed to upsert user 'jane@archive.example.test'.");

    await expect(
      store.createInvite({
        token: 'inv_oakville_1',
        label: 'Oakville Cousins',
        created_by: 'jane@archive.example.test',
        created_at: NOW_ISO,
        expires_at: null,
        revoked_at: null,
        uses: 0,
        last_used_at: null,
      })
    ).rejects.toThrow("Failed to create invite 'inv_oakville_1'.");

    await expect(
      store.createAgentToken({
        token_id: 'tok_oak_1',
        token_hash: asSha256Hex('a'.repeat(64)),
        label: 'Archival Bot',
        scope: 'read_backup',
        created_by: 'jane@archive.example.test',
        created_at: NOW_ISO,
        revoked_at: null,
      })
    ).rejects.toThrow("Failed to create agent token 'tok_oak_1'.");
  });

  it('reads kinship edges, sorts snapshot kinship edges deterministically, and filters revisions by batch_id and author_type', async () => {
    const rawKinshipB = {
      edge_id: 'edge_b',
      from_person_id: 'per_2',
      to_person_id: 'per_3',
      relation: 'spouse',
      family_xref: null,
      current_revision_id: 2,
      deleted_at: null,
      updated_at: NOW_ISO,
    };
    const rawKinshipA = {
      edge_id: 'edge_a',
      from_person_id: 'per_1',
      to_person_id: 'per_2',
      relation: 'parent',
      family_xref: '@F1@',
      current_revision_id: 1,
      deleted_at: null,
      updated_at: NOW_ISO,
    };
    const rawRevision = {
      revision_id: 12,
      batch_id: 'batch_oak_1',
      entity_type: 'source',
      entity_id: 'src_oakville_1880',
      parent_revision_id: null,
      action: 'create',
      reverted_revision_id: null,
      author_id: 'tok_oak_1',
      author_name: 'Archival Bot',
      author_type: 'agent',
      summary: 'Imported 1880 Oakville census',
      has_primary_source: 1,
      before_json: null,
      after_json: JSON.stringify(makeStoredSource().data),
      created_at: NOW_ISO,
    };

    const { db, recorded } = createStubD1Database({
      onFirst: (stmt) => {
        if (stmt.sql.includes('FROM kinship_edges') && stmt.bindings[0] === 'edge_a') {
          return rawKinshipA;
        }
        return null;
      },
      onBatch: () => [
        makeD1Result([]),
        makeD1Result([rawKinshipB, rawKinshipA]),
        makeD1Result([{ head_revision_id: 12 }]),
      ],
      onAll: () => makeD1Result([rawRevision]),
    });

    const readStore = new D1EntityReadStore(db, undefined, new FixedClock(new Date(NOW_ISO)));

    const foundEdge = await readStore.getEntity('kinship_edge', 'edge_a');
    expect(foundEdge).toEqual({
      edge_id: 'edge_a',
      edge: { from: 'per_1', to: 'per_2', relation: 'parent', family_xref: '@F1@' },
      current_revision_id: asRevisionId(1),
      deleted_at: null,
      updated_at: NOW_ISO,
    });
    expect(await readStore.getEntity('kinship_edge', 'edge_missing')).toBeNull();

    const snapshot = await readStore.loadActiveSnapshot();
    expect(snapshot.head_revision_id).toBe(asRevisionId(12));
    expect(snapshot.kinship.map((row) => row.edge_id)).toEqual(['edge_a', 'edge_b']);

    const revPage = await readStore.listRevisions({
      batch_id: asBatchId('batch_oak_1'),
      author_type: 'agent',
      limit: 10,
    });
    expect(revPage.next_cursor).toBeNull();
    expect(revPage.items).toHaveLength(1);
    expect(revPage.items[0]!.batch_id).toBe('batch_oak_1');
    expect(revPage.items[0]!.author_type).toBe('agent');

    const revQueryStmt = recorded.find((s) => s.sql.includes('ORDER BY revision_id DESC'));
    expect(revQueryStmt?.sql).toContain('batch_id = ? AND batch_id IS NOT NULL');
    expect(revQueryStmt?.sql).toContain('author_type = ?');
    expect(revQueryStmt?.bindings).toEqual(['batch_oak_1', 'agent', 11]);
  });

  it('falls back cleanly on pre-0007 databases missing steward_reviews and rethrows unrelated D1 errors', async () => {
    const rawRevision = {
      revision_id: 4,
      batch_id: 'batch_legacy',
      entity_type: 'person',
      entity_id: 'per_1',
      parent_revision_id: null,
      action: 'create',
      reverted_revision_id: null,
      author_id: 'steward@example.test',
      author_name: 'Steward',
      author_type: 'human',
      summary: 'Created person',
      has_primary_source: 1,
      before_json: null,
      after_json: '{"id":"per_1"}',
      created_at: NOW_ISO,
    };

    const { db } = createStubD1Database({
      onAll: (stmt) => {
        if (stmt.sql.includes('steward_reviews')) {
          throw new Error('D1_ERROR: no such table: steward_reviews');
        }
        return makeD1Result([rawRevision]);
      },
      onFirst: (stmt) => {
        if (stmt.sql.includes('steward_reviews')) {
          throw new Error('D1_ERROR: no such table: steward_reviews');
        }
        return rawRevision;
      },
    });

    const readStore = new D1EntityReadStore(db, undefined, new FixedClock(new Date(NOW_ISO)));
    const listed = await readStore.listRevisions({ limit: 5 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]!.review).toBeUndefined();

    const single = await readStore.getRevisionById(asRevisionId(4));
    expect(single?.revision_id).toBe(4);

    const byBatch = await readStore.getRevisionsByBatch(asBatchId('batch_legacy'));
    expect(byBatch).toHaveLength(1);

    const { db: brokenDb } = createStubD1Database({
      onAll: () => {
        throw new Error('D1_ERROR: disk I/O error');
      },
      onFirst: () => {
        throw new Error('D1_ERROR: disk I/O error');
      },
    });
    const brokenStore = new D1EntityReadStore(brokenDb, undefined, new FixedClock(new Date(NOW_ISO)));
    await expect(brokenStore.listRevisions({})).rejects.toThrow(/disk I\/O error/);
    await expect(brokenStore.getRevisionById(asRevisionId(4))).rejects.toThrow(/disk I\/O error/);
    await expect(brokenStore.getRevisionsByBatch(asBatchId('batch_legacy'))).rejects.toThrow(
      /disk I\/O error/
    );
  });
});
