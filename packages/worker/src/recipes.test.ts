import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asSha256Hex } from '@kinloom/core';
import {
  CreateRecipeInputSchema,
  computeCrc32,
  createRecipesServerPlugin,
  FixedClock,
  getSessionCookieName,
  KinloomHttpError,
  type KinloomServerPlugin,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  RECIPES_PLUGIN_MIGRATIONS,
  signSessionToken,
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
  R2MediaStore,
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

    // Verify R2MediaStore.delete removes objects cleanly in Miniflare R2
    const r2Store = new R2MediaStore(bucket);
    const sampleKey = 'plugins/recipes/rec_r2_del/pho_r2_del.png';
    await r2Store.put({
      key: sampleKey,
      body: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'image/png',
      sha256: asSha256Hex('a'.repeat(64)),
    });
    expect((await r2Store.head(sampleKey)).exists).toBe(true);
    await r2Store.delete(sampleKey);
    expect((await r2Store.head(sampleKey)).exists).toBe(false);

    // End-to-end Miniflare Worker photo upload, EXIF stripping, GET, and DELETE over D1 + R2
    const d1Repo = createD1RecipesRepository(db);
    await d1Repo.createRecipe({
      id: 'rec_mf_photo',
      data: CreateRecipeInputSchema.parse({ title: 'Miniflare Apple Crisp', course: 'dessert' }),
      actor: { id: 'admin@archive.example.test', name: 'Worker Steward' },
      nowIso: clock.nowIso(),
    });
    await db
      .prepare(
        'INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at) VALUES (?, ?, ?, ?, ?, NULL)'
      )
      .bind('admin@archive.example.test', 'Worker Steward', 'admin', 'bootstrap', clock.nowIso())
      .run();

    const recipesWorker = createCloudflareWorker({
      siteConfig: createSyntheticSiteConfig(),
      clock,
      plugins: [createRecipesServerPlugin()],
    });
    const sessionToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: {
        kind: 'user',
        email: 'admin@archive.example.test',
        display_name: 'Worker Steward',
        role: 'admin',
      },
    });
    const cookie = `${getSessionCookieName(true)}=${sessionToken}`;

    const enc = new TextEncoder();
    const makePngChunk = (type: string, data: Uint8Array): Uint8Array => {
      const body = new Uint8Array(4 + data.byteLength);
      body.set(enc.encode(type), 0);
      body.set(data, 4);
      const out = new Uint8Array(12 + data.byteLength);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, data.byteLength, false);
      out.set(body, 4);
      dv.setUint32(8 + data.byteLength, computeCrc32(body), false);
      return out;
    };
    const ihdr = new Uint8Array(13);
    new DataView(ihdr.buffer).setUint32(0, 128, false);
    new DataView(ihdr.buffer).setUint32(4, 96, false);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const pngParts = [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      makePngChunk('IHDR', ihdr),
      makePngChunk('eXIf', enc.encode('WORKER_GPS_SECRET')),
      makePngChunk('IDAT', new Uint8Array([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])),
      makePngChunk('IEND', new Uint8Array(0)),
    ];
    const pngTotal = pngParts.reduce((s, p) => s + p.byteLength, 0);
    const pngBytes = new Uint8Array(pngTotal);
    let pos = 0;
    for (const part of pngParts) {
      pngBytes.set(part, pos);
      pos += part.byteLength;
    }

    const uploadForm = new FormData();
    uploadForm.set('file', new File([pngBytes], 'crisp.png', { type: 'image/png' }));
    uploadForm.set('caption', 'Handwritten crisp card');

    const uploadRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/miniflare-apple-crisp/photos`, {
        method: 'POST',
        headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
        body: uploadForm,
      }),
      env
    );
    expect(uploadRes.status).toBe(201);
    const uploaded = (await uploadRes.json()) as { photo: { id: string; url: string; width: number } };
    expect(uploaded.photo.width).toBe(128);

    const getRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}${uploaded.photo.url}`, { headers: { cookie } }),
      env
    );
    expect(getRes.status).toBe(200);
    const servedText = new TextDecoder('latin1').decode(new Uint8Array(await getRes.arrayBuffer()));
    expect(servedText).not.toContain('WORKER_GPS_SECRET');

    const delRes = await recipesWorker.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/miniflare-apple-crisp/photos/${uploaded.photo.id}`,
        {
          method: 'DELETE',
          headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
        }
      ),
      env
    );
    expect(delRes.status).toBe(204);
    expect((await r2Store.head(`plugins/recipes/rec_mf_photo/${uploaded.photo.id}.png`)).exists).toBe(false);

    // End-to-end Miniflare Worker recipe create, PATCH, stale 409 conflict, PUT, and soft-DELETE over D1
    const createRecipeRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes`, {
        method: 'POST',
        headers: {
          cookie,
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'D1 Honey Oat Bread',
          summary: 'Baked in cast iron.',
          story_md: 'Copied from the 1934 ledger.',
          ingredients: [{ id: 'ing_1', quantity: '3', unit: 'cups', item: 'flour', note: '', group: 'Dry' }],
          steps: [{ id: 'stp_1', instruction: 'Knead and rise 1 hour.', note: '' }],
          prep_minutes: 20,
          cook_minutes: 40,
          servings: '1 loaf',
          course: 'bread',
          tags: ['winter', 'heirloom'],
          provenance_note: '1934 kitchen ledger',
          source_era: '1930s',
        }),
      }),
      env
    );
    expect(createRecipeRes.status).toBe(201);
    const createdRecipe = (await createRecipeRes.json()) as {
      recipe: { id: string; slug: string; version: number };
    };
    expect(createdRecipe.recipe.slug).toBe('d1-honey-oat-bread');
    expect(createdRecipe.recipe.version).toBe(1);

    const patchRecipeRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}`, {
        method: 'PATCH',
        headers: {
          cookie,
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'D1 Spiced Honey Oat Bread',
          expected_version: 1,
        }),
      }),
      env
    );
    expect(patchRecipeRes.status).toBe(200);
    const patchedRecipe = (await patchRecipeRes.json()) as { recipe: { version: number; title: string } };
    expect(patchedRecipe.recipe.version).toBe(2);
    expect(patchedRecipe.recipe.title).toBe('D1 Spiced Honey Oat Bread');

    const stalePatchRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}`, {
        method: 'PATCH',
        headers: {
          cookie,
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Stale D1 Overwrite',
          expected_version: 1,
        }),
      }),
      env
    );
    expect(stalePatchRes.status).toBe(409);
    const stalePayload = (await stalePatchRes.json()) as {
      error: { code: string; details: { server_version: number } };
    };
    expect(stalePayload.error.code).toBe('RECIPE_VERSION_CONFLICT');
    expect(stalePayload.error.details.server_version).toBe(2);

    // End-to-end Miniflare Worker star/unstar idempotency, favorites=true, and sort=most_starred over D1
    const starPost1 = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}/star`, {
        method: 'POST',
        headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
      }),
      env
    );
    expect(starPost1.status).toBe(200);
    expect(await starPost1.json()).toEqual({
      recipe_id: createdRecipe.recipe.id,
      star_count: 1,
      viewer_has_starred: true,
    });

    const starPost2 = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}/star`, {
        method: 'POST',
        headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
      }),
      env
    );
    expect(starPost2.status).toBe(200);
    expect(await starPost2.json()).toEqual({
      recipe_id: createdRecipe.recipe.id,
      star_count: 1,
      viewer_has_starred: true,
    });

    const favListRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes?favorites=true&sort=most_starred`, {
        headers: { cookie },
      }),
      env
    );
    expect(favListRes.status).toBe(200);
    const favListJson = (await favListRes.json()) as {
      recipes: Array<{ id: string; star_count: number; viewer_has_starred: boolean }>;
      permissions: { can_create: boolean; can_star: boolean };
    };
    expect(favListJson.permissions.can_star).toBe(true);
    expect(favListJson.recipes.map((r) => [r.id, r.star_count, r.viewer_has_starred])).toEqual([
      [createdRecipe.recipe.id, 1, true],
    ]);

    const starDel = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}/star`, {
        method: 'DELETE',
        headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
      }),
      env
    );
    expect(starDel.status).toBe(200);
    expect(await starDel.json()).toEqual({
      recipe_id: createdRecipe.recipe.id,
      star_count: 0,
      viewer_has_starred: false,
    });

    const deleteRecipeRes = await recipesWorker.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes/${createdRecipe.recipe.slug}`, {
        method: 'DELETE',
        headers: { cookie, origin: CONTRACT_TEST_ORIGIN },
      }),
      env
    );
    expect(deleteRecipeRes.status).toBe(204);
  });
});
