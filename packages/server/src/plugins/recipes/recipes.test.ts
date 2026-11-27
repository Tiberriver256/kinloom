import { DatabaseSync } from 'node:sqlite';
import {
  asRevisionId,
  type PluginDatabasePort,
  type PluginSqlRunResult,
  type PluginSqlStatement,
  type PluginSqlValue,
  PrivacyViolationError,
} from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { createInMemoryServerPorts } from '../../adapters/inMemory.js';
import {
  assertScopedPluginSql,
  splitPluginSqlStatements,
  validatePluginMigrations,
} from '../../http/pluginMigrations.js';
import { createKinloomServer } from '../../http/router.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from '../../testing/adapterContractSuite.js';
import { InMemoryRecipesRepository } from './inMemoryRecipesRepository.js';
import { RECIPES_INITIAL_MIGRATION_SQL, RECIPES_PLUGIN_MIGRATIONS } from './migrations.js';
import { runRecipesRepositoryContractSuite } from './recipesRepositoryContractSuite.js';
import {
  assertDeceasedRecipeAttribution,
  CreateRecipeCommentSchema,
  CreateRecipeInputSchema,
  deriveRecipeActorKey,
  parseRecipeStarDbRow,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  type RecipeCommentRecord,
  redactLivingRecipeAttribution,
  slugifyRecipeTitle,
  toPublicRecipeComment,
  UpdateRecipeCommentSchema,
  UpdateRecipePhotoInputSchema,
} from './schemas.js';
import { SqlRecipesRepository } from './sqlRecipesRepository.js';

function createNodeSqlitePluginDb(namespace: string): {
  readonly port: PluginDatabasePort;
  readonly close: () => void;
} {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const stmt of splitPluginSqlStatements(RECIPES_INITIAL_MIGRATION_SQL)) {
    db.exec(stmt);
  }

  const port: PluginDatabasePort = {
    adapterKind: 'node-sqlite',
    namespace,
    async query<T>(
      sql: string,
      params: readonly PluginSqlValue[],
      parseRow: (raw: Record<string, unknown>) => T
    ): Promise<readonly T[]> {
      const scoped = assertScopedPluginSql(namespace, sql);
      const rows = db.prepare(scoped).all(...params) as Record<string, unknown>[];
      return rows.map((row) => parseRow(row));
    },
    async first<T>(
      sql: string,
      params: readonly PluginSqlValue[],
      parseRow: (raw: Record<string, unknown>) => T
    ): Promise<T | null> {
      const scoped = assertScopedPluginSql(namespace, sql);
      const row = db.prepare(scoped).get(...params) as Record<string, unknown> | undefined;
      return row ? parseRow(row) : null;
    },
    async run(sql: string, params: readonly PluginSqlValue[] = []): Promise<PluginSqlRunResult> {
      const scoped = assertScopedPluginSql(namespace, sql);
      const res = db.prepare(scoped).run(...params);
      return {
        changes: Number(res.changes),
        lastRowId: Number(res.lastInsertRowid),
      };
    },
    async batch(statements: readonly PluginSqlStatement[]): Promise<readonly PluginSqlRunResult[]> {
      const validated = statements.map((item) => ({
        sql: assertScopedPluginSql(namespace, item.sql),
        params: item.params ?? [],
      }));
      db.exec('BEGIN');
      try {
        const results: PluginSqlRunResult[] = [];
        for (const item of validated) {
          const res = db.prepare(item.sql).run(...item.params);
          results.push({
            changes: Number(res.changes),
            lastRowId: Number(res.lastInsertRowid),
          });
        }
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };

  return { port, close: () => db.close() };
}

runRecipesRepositoryContractSuite('InMemoryRecipesRepository', async () => ({
  repo: new InMemoryRecipesRepository(),
}));

runRecipesRepositoryContractSuite('SqlRecipesRepository (node:sqlite)', async () => {
  const { port, close } = createNodeSqlitePluginDb(RECIPES_DATABASE_NAMESPACE);
  return {
    repo: new SqlRecipesRepository(port),
    async dispose() {
      close();
    },
  };
});

describe('Recipes plugin migrations, schemas, privacy guard, and default-off invariant', () => {
  it('validates RECIPES_PLUGIN_MIGRATIONS cleanly against strict plugin SQL namespace guard', () => {
    const validated = validatePluginMigrations({
      id: RECIPES_PLUGIN_ID,
      databaseNamespace: RECIPES_DATABASE_NAMESPACE,
      migrations: RECIPES_PLUGIN_MIGRATIONS,
    });
    expect(validated).toHaveLength(1);
    expect(validated[0].migration.id).toBe('0001_recipes_initial');
    expect(validated[0].statements.length).toBeGreaterThanOrEqual(13);
  });

  it('slugifies titles, validates schemas, derives non-reversible actor keys, and redacts emails in public comments', async () => {
    expect(slugifyRecipeTitle("Nana's Crème Brûlée & Tart!")).toBe('nana-s-creme-brulee-tart');
    expect(slugifyRecipeTitle('A')).toBe('a-recipe');
    expect(slugifyRecipeTitle('!!!')).toBe('recipe');

    expect(
      CreateRecipeInputSchema.parse({
        title: '  Rhubarb Crisp  ',
        tags: ['Summer', 'Fruit Pie'],
      })
    ).toMatchObject({
      title: 'Rhubarb Crisp',
      course: 'other',
      tags: ['summer', 'fruit pie'],
      attributed_person_id: null,
    });

    expect(UpdateRecipePhotoInputSchema.parse({ caption: '  Card back  ', set_cover: true })).toEqual({
      caption: 'Card back',
      set_cover: true,
    });
    expect(CreateRecipeCommentSchema.parse({ body_md: '  Delicious!  ' })).toEqual({
      body_md: 'Delicious!',
      parent_comment_id: null,
    });
    expect(UpdateRecipeCommentSchema.parse({ body_md: '  Updated note  ' })).toEqual({
      body_md: 'Updated note',
    });
    expect(
      parseRecipeStarDbRow({
        recipe_id: 'rec_1',
        actor_key: 'usr_abc',
        created_at: '2026-11-27T10:00:00.000Z',
      })
    ).toEqual({
      recipe_id: 'rec_1',
      actor_key: 'usr_abc',
      created_at: '2026-11-27T10:00:00.000Z',
    });

    const userKey1 = await deriveRecipeActorKey({
      kind: 'user',
      email: 'Clara@Archive.Example.Test',
      display_name: 'Clara',
      role: 'editor',
    });
    const userKey2 = await deriveRecipeActorKey({
      kind: 'user',
      email: 'clara@archive.example.test',
      display_name: 'Clara',
      role: 'editor',
    });
    expect(userKey1).toBe(userKey2);
    expect(userKey1).toMatch(/^usr_[0-9a-f]{24}$/);
    expect(userKey1).not.toContain('clara');

    const inviteKey = await deriveRecipeActorKey({
      kind: 'invite_viewer',
      invite_token: 'tok_example_12345',
      label: 'Family Link',
    });
    expect(inviteKey).toMatch(/^inv_[0-9a-f]{24}$/);
    expect(await deriveRecipeActorKey({ kind: 'anonymous' })).toBeNull();
    expect(
      await deriveRecipeActorKey({
        kind: 'agent',
        token_id: 'agt_1',
        label: 'Bot',
        scope: 'write_batch',
      })
    ).toBeNull();

    const activeComment: RecipeCommentRecord = {
      id: 'cmt_1',
      recipe_id: 'rec_1',
      parent_comment_id: null,
      depth: 0,
      author_id: 'clara@archive.example.test',
      author_key: userKey1 ?? 'usr_0',
      author_name: 'Clara Alder',
      body_md: 'Baked this for Sunday supper.',
      created_at: '2026-11-27T10:00:00.000Z',
      edited_at: null,
      deleted_at: null,
      deleted_by_role: null,
    };

    const ownerView = toPublicRecipeComment(activeComment, {
      kind: 'user',
      email: 'clara@archive.example.test',
      display_name: 'Clara Alder',
      role: 'editor',
    });
    expect(JSON.stringify(ownerView)).not.toContain('clara@archive.example.test');
    expect(ownerView.can_edit).toBe(true);
    expect(ownerView.can_delete).toBe(true);

    const adminView = toPublicRecipeComment(activeComment, {
      kind: 'user',
      email: 'steward@archive.example.test',
      display_name: 'Steward',
      role: 'admin',
    });
    expect(adminView.can_edit).toBe(false);
    expect(adminView.can_delete).toBe(true);

    const deletedComment: RecipeCommentRecord = {
      ...activeComment,
      deleted_at: '2026-11-27T11:00:00.000Z',
      deleted_by_role: 'admin',
    };
    const tombstone = toPublicRecipeComment(deletedComment, {
      kind: 'user',
      email: 'clara@archive.example.test',
      display_name: 'Clara Alder',
      role: 'admin',
    });
    expect(tombstone).toMatchObject({
      deleted: true,
      deleted_by_role: 'admin',
      author_name: null,
      author_key: null,
      body_md: '',
      can_edit: false,
      can_delete: false,
    });
  });

  it('enforces living-person attribution privacy guard on write and read paths', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const deceased = createSyntheticHistoricalPerson({
      id: 'per_deceased_baker',
      slug: 'hannah-alder',
      full_name: 'Hannah Alder',
    });
    const living = createSyntheticLivingPerson({
      id: 'per_living_baker',
      slug: 'sam-alder',
      full_name: 'Sam Alder',
    });

    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: { author_id: 'admin@archive.example.test', author_name: 'Admin', author_type: 'human' },
      nowIso: ports.clock.nowIso(),
      operations: [
        {
          action: 'create',
          entity_type: 'person',
          entity_id: deceased.id,
          slug: deceased.slug,
          expected_parent_revision_id: null,
          before_json: null,
          after_json: deceased,
          summary: 'Add deceased ancestor',
          has_primary_source: true,
        },
        {
          action: 'create',
          entity_type: 'person',
          entity_id: living.id,
          slug: living.slug,
          expected_parent_revision_id: null,
          before_json: null,
          after_json: living,
          summary: 'Add living person',
          has_primary_source: true,
        },
      ],
    });

    expect(await assertDeceasedRecipeAttribution(null, ports.repository)).toBeNull();
    expect(await assertDeceasedRecipeAttribution('   ', ports.repository)).toBeNull();
    expect(await assertDeceasedRecipeAttribution(deceased.id, ports.repository)).toBe(deceased.id);

    await expect(assertDeceasedRecipeAttribution(living.id, ports.repository)).rejects.toBeInstanceOf(
      PrivacyViolationError
    );

    await expect(assertDeceasedRecipeAttribution('per_nonexistent', ports.repository)).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ANCESTOR_REFERENCE',
    });

    // Also catches entity whose data has is_living: true even if not in livingIds set
    await expect(
      assertDeceasedRecipeAttribution('per_flag_living', {
        async getLivingPersonIds() {
          return new Set();
        },
        async getEntity() {
          return {
            entity_type: 'person',
            entity_id: 'per_flag_living',
            slug: 'flag-living',
            data: { id: 'per_flag_living', is_living: true },
            current_revision_id: asRevisionId(1),
            has_primary_source: true,
            deleted_at: null,
            updated_at: '2026-11-27T10:00:00.000Z',
          };
        },
      })
    ).rejects.toBeInstanceOf(PrivacyViolationError);

    // Read-path redaction
    const redacted = redactLivingRecipeAttribution(
      { id: 'rec_1', attributed_person_id: living.id },
      new Set([living.id])
    );
    expect(redacted.attributed_person_id).toBeNull();
  });

  it('exposes zero /api/plugins/recipes routes when plugins array is empty (default-off invariant)', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const ports = createInMemoryServerPorts(siteConfig);
    const server = createKinloomServer({
      siteConfig,
      ports: { ...ports, plugins: [] },
      sessionSecret: CONTRACT_SESSION_SECRET,
    });
    const res = await server.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/plugins/recipes`));
    expect(res.status).toBe(404);
  });
});
