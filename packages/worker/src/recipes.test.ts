import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FixedClock,
  KinloomHttpError,
  type KinloomServerPlugin,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  RECIPES_PLUGIN_MIGRATIONS,
} from '@kinloom/server';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticSiteConfig,
  runRecipesRepositoryContractSuite,
} from '@kinloom/server/testing';
import { Miniflare } from 'miniflare';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { probeD1SchemaMigrationLevel } from './adapters/d1/schemaProbe.js';
import {
  createCloudflareWorker,
  createD1RecipesRepository,
  type D1Database,
  D1PluginDatabaseFactory,
  type KinloomWorkerEnv,
  type R2Bucket,
  runD1PluginMigrations,
} from './index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CORE_MIGRATION_FILES = [
  '0001_initial.sql',
  '0002_pronunciations.sql',
  '0003_pronunciation_provenance.sql',
  '0004_plugin_settings.sql',
  '0005_page_visit_stats.sql',
  '0006_plugin_migrations.sql',
] as const;

const CORE_MIGRATIONS = CORE_MIGRATION_FILES.map((name) =>
  readFileSync(resolve(THIS_DIR, '../migrations', name), 'utf8')
);

async function applySqlScript(db: D1Database, sqlScript: string): Promise<void> {
  const withoutComments = sqlScript
    .split('\n')
    .map((line) => (line.trimStart().startsWith('--') ? '' : line))
    .join('\n');
  const statements = withoutComments
    .split(';')
    .map((stmt) => stmt.trim())
    .filter((stmt) => stmt.length > 0);
  if (statements.length > 0) {
    await db.batch(statements.map((stmt) => db.prepare(stmt)));
  }
}

async function listUserTables(db: D1Database): Promise<string[]> {
  const result = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
    .all<{ name?: unknown }>();
  return result.results
    .map((row) => (typeof row.name === 'string' ? row.name : ''))
    .filter((name) => name.length > 0);
}

let sharedMf: Miniflare | null = null;
let dbCounter = 0;

async function createMiniflareD1(): Promise<{
  readonly mf: Miniflare;
  readonly db: D1Database;
  readonly bucket: R2Bucket;
}> {
  dbCounter += 1;
  const mf = new Miniflare({
    modules: true,
    compatibilityDate: '2026-08-06',
    script: 'export default { fetch() { return new Response("ok"); } };',
    d1Databases: {
      DB: `recipes-contract-db-${dbCounter}`,
    },
    r2Buckets: {
      MEDIA_BUCKET: `recipes-contract-bucket-${dbCounter}`,
    },
  });
  const db = (await mf.getD1Database('DB')) as unknown as D1Database;
  const bucket = (await mf.getR2Bucket('MEDIA_BUCKET')) as unknown as R2Bucket;
  for (const sql of CORE_MIGRATIONS) {
    await applySqlScript(db, sql);
  }
  return { mf, db, bucket };
}

afterAll(async () => {
  if (sharedMf) {
    await sharedMf.dispose();
    sharedMf = null;
  }
});

runRecipesRepositoryContractSuite('Cloudflare D1 SqlRecipesRepository (Miniflare)', async () => {
  const { mf, db } = await createMiniflareD1();
  const clock = new FixedClock('2026-11-27T12:00:00.000Z');
  const recipesPlugin: KinloomServerPlugin = {
    id: RECIPES_PLUGIN_ID,
    name: 'Family Recipe Sharing',
    databaseNamespace: RECIPES_DATABASE_NAMESPACE,
    migrations: RECIPES_PLUGIN_MIGRATIONS,
  };
  await runD1PluginMigrations(db, [recipesPlugin], clock);
  const repo = createD1RecipesRepository(db);
  return {
    repo,
    async dispose() {
      await mf.dispose();
    },
  };
});

describe('Cloudflare Worker 0006_plugin_migrations, D1PluginDatabaseFactory, and plugin isolation', () => {
  it('keeps default archives free of plugin tables, probes 0006, runs idempotent plugin migrations, enforces runtime scope guard, and injects pluginDb into worker routes', async () => {
    const { mf, db, bucket } = await createMiniflareD1();
    sharedMf = mf;

    // Applying 0006 twice is idempotent and probeD1SchemaMigrationLevel reports 0006.
    await applySqlScript(db, CORE_MIGRATIONS[CORE_MIGRATIONS.length - 1]);
    expect(await probeD1SchemaMigrationLevel(db)).toBe('0006_plugin_migrations.sql');

    // Default archive has plugin_migrations ledger but ZERO plugin_recipes_* tables.
    const defaultTables = await listUserTables(db);
    expect(defaultTables).toContain('plugin_migrations');
    expect(defaultTables.filter((t) => t.startsWith('plugin_recipes_'))).toEqual([]);

    // Running plugin migrations with empty plugins list leaves zero plugin tables.
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');
    expect(await runD1PluginMigrations(db, [], clock)).toEqual({ applied: [], skipped: [] });
    expect((await listUserTables(db)).filter((t) => t.startsWith('plugin_recipes_'))).toEqual([]);

    // Registering recipes plugin applies migration v1 once and skips idempotently on second run.
    const recipesStubPlugin: KinloomServerPlugin = {
      id: RECIPES_PLUGIN_ID,
      name: 'Family Recipe Sharing',
      databaseNamespace: RECIPES_DATABASE_NAMESPACE,
      migrations: RECIPES_PLUGIN_MIGRATIONS,
      routes: [
        {
          method: 'GET',
          pathPrefix: '/api/plugins/recipes-probe',
          minRole: 'public',
          async handle(ctx) {
            if (!ctx.pluginDb) {
              return new Response(JSON.stringify({ ok: false }), { status: 500 });
            }
            const countRow = await ctx.pluginDb.first(
              'SELECT COUNT(*) AS total FROM plugin_recipes_items WHERE deleted_at IS NULL',
              [],
              (raw) => z.object({ total: z.number().int() }).parse(raw)
            );
            return new Response(
              JSON.stringify({
                adapterKind: ctx.pluginDb.adapterKind,
                namespace: ctx.pluginDb.namespace,
                total: countRow?.total ?? 0,
              }),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }
            );
          },
        },
      ],
    };

    const firstMigration = await runD1PluginMigrations(db, [recipesStubPlugin], clock);
    expect(firstMigration.applied).toHaveLength(1);
    expect(firstMigration.applied[0].migration_id).toBe('0001_recipes_initial');
    expect(firstMigration.skipped).toEqual([]);

    const secondMigration = await runD1PluginMigrations(db, [recipesStubPlugin], clock);
    expect(secondMigration.applied).toEqual([]);
    expect(secondMigration.skipped).toHaveLength(1);

    const tablesAfter = await listUserTables(db);
    expect(tablesAfter).toContain('plugin_recipes_items');
    expect(tablesAfter).toContain('plugin_recipes_photos');
    expect(tablesAfter).toContain('plugin_recipes_stars');
    expect(tablesAfter).toContain('plugin_recipes_comments');

    // Runtime SQL scope guard blocks core tables, sqlite_master, and cross-namespace queries on D1PluginDatabasePort.
    const factory = new D1PluginDatabaseFactory(db);
    const recipesDb = factory.forPlugin(RECIPES_PLUGIN_ID, RECIPES_DATABASE_NAMESPACE);
    expect(await recipesDb.batch([])).toEqual([]);

    for (const forbiddenSql of [
      'SELECT * FROM entities',
      'SELECT * FROM users',
      'SELECT * FROM plugin_migrations',
      'SELECT name FROM sqlite_master',
      'SELECT * FROM plugin_other_items',
    ]) {
      await expect(recipesDb.query(forbiddenSql, [], (row) => row)).rejects.toBeInstanceOf(KinloomHttpError);
      await expect(recipesDb.first(forbiddenSql, [], (row) => row)).rejects.toBeInstanceOf(KinloomHttpError);
      await expect(recipesDb.run(forbiddenSql)).rejects.toBeInstanceOf(KinloomHttpError);
      await expect(recipesDb.batch([{ sql: forbiddenSql }])).rejects.toBeInstanceOf(KinloomHttpError);
    }

    // Worker injects scoped D1PluginDatabasePort into registered DB-backed plugin routes.
    const worker = createCloudflareWorker({
      siteConfig: createSyntheticSiteConfig(),
      clock,
      plugins: [recipesStubPlugin],
    });
    const env: KinloomWorkerEnv = {
      DB: db,
      MEDIA_BUCKET: bucket,
      SESSION_SECRET: CONTRACT_SESSION_SECRET,
      ARCHIVE_MODE: 'private',
    };
    const probeRes = await worker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes-probe`),
      env
    );
    expect(probeRes.status).toBe(200);
    expect(await probeRes.json()).toEqual({
      adapterKind: 'd1',
      namespace: 'recipes',
      total: 0,
    });
  });
});
