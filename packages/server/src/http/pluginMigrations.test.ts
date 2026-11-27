import type { AppliedPluginMigrationRecord, KinloomServerPlugin } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import { FixedClock } from '../adapters/systemClock.js';
import { KinloomHttpError } from '../errors.js';
import {
  assertScopedPluginSql,
  assertValidPluginNamespace,
  computeMigrationChecksum,
  FORBIDDEN_PLUGIN_CORE_TABLES,
  type PluginMigrationExecutor,
  pluginIndexPrefix,
  pluginTablePrefix,
  runPluginMigrations,
  splitPluginSqlStatements,
  validatePluginMigrationSql,
  validatePluginMigrations,
  validateRegisteredPluginDatabases,
} from './pluginMigrations.js';

describe('pluginMigrations static DDL guard, runtime SQL scope guard, and runner', () => {
  it('validates plugin namespaces and prefixes', () => {
    expect(assertValidPluginNamespace('recipes')).toBe('recipes');
    expect(pluginTablePrefix('recipes')).toBe('plugin_recipes_');
    expect(pluginIndexPrefix('recipes')).toBe('idx_plugin_recipes_');

    expect(() => assertValidPluginNamespace('a')).toThrow(RangeError);
    expect(() => assertValidPluginNamespace('BadCaps')).toThrow(RangeError);
    expect(() => assertValidPluginNamespace('bad-dash')).toThrow(RangeError);
    expect(() => assertValidPluginNamespace('1digit')).toThrow(RangeError);
  });

  it('splits multi-statement SQL while preserving semicolons inside strings and stripping comments', () => {
    const sql = `
      -- Leading comment with ; semicolon
      CREATE TABLE IF NOT EXISTS plugin_demo_items (
        id TEXT PRIMARY KEY,
        note TEXT NOT NULL DEFAULT 'semi;colon''quoted'
      );
      /* Block comment; with ; semicolons */
      CREATE INDEX IF NOT EXISTS idx_plugin_demo_items_id ON plugin_demo_items (id);
    `;
    const statements = splitPluginSqlStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("'semi;colon''quoted'");
    expect(statements[1]).toContain('idx_plugin_demo_items_id');
  });

  it('allows valid namespaced DDL (tables, indexes, FKs, alter, view, drop) and rejects core/cross-namespace escapes', () => {
    const validDdl = `
      CREATE TABLE IF NOT EXISTS plugin_demo_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT 'entities'
      );
      CREATE TABLE IF NOT EXISTS plugin_demo_notes (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES plugin_demo_items(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plugin_demo_items_title ON plugin_demo_items (title);
      ALTER TABLE plugin_demo_items ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
      CREATE VIEW IF NOT EXISTS plugin_demo_active_items AS SELECT id FROM plugin_demo_items WHERE archived = 0;
      DROP VIEW IF EXISTS plugin_demo_active_items;
      DROP INDEX IF EXISTS idx_plugin_demo_items_title;
      DROP TABLE IF EXISTS plugin_demo_notes;
    `;
    const stmts = validatePluginMigrationSql('demo', validDdl);
    expect(stmts).toHaveLength(8);

    // Rejects core tables, cross-namespace tables, unprefixed indexes, core FK references, triggers, pragmas, schema qualifiers
    const invalidCases: string[] = [
      '',
      '   -- only comment',
      'CREATE TABLE entities (id TEXT);',
      'CREATE TABLE plugin_other_items (id TEXT);',
      'CREATE TABLE main.plugin_demo_items (id TEXT);',
      'CREATE TABLE plugin_demo_bad_fk (id TEXT, person_id TEXT REFERENCES entities(id));',
      'CREATE INDEX idx_wrong_prefix ON plugin_demo_items (id);',
      'CREATE INDEX idx_plugin_demo_bad ON entities (id);',
      'CREATE INDEX idx_plugin_demo_missing_on plugin_demo_items (id);',
      'ALTER TABLE users ADD COLUMN hack TEXT;',
      'ALTER TABLE plugin_demo_items RENAME TO users;',
      'ALTER TABLE plugin_demo_items ADD COLUMN ref TEXT REFERENCES users(email);',
      'CREATE TRIGGER plugin_demo_trig AFTER INSERT ON plugin_demo_items BEGIN SELECT 1; END;',
      'CREATE VIEW plugin_demo_bad_view AS SELECT * FROM users;',
      'CREATE VIEW bad_view_name AS SELECT * FROM plugin_demo_items;',
      'PRAGMA foreign_keys = OFF;',
      'ATTACH DATABASE ":memory:" AS evil;',
      'VACUUM;',
      'REINDEX;',
      'DETACH DATABASE evil;',
      'DROP TRIGGER plugin_demo_trig;',
      'DROP TABLE users;',
      'DROP INDEX idx_wrong;',
      'SELECT * FROM plugin_demo_items;',
      'CREATE VIRTUAL TABLE plugin_demo_fts USING fts5(title);',
      'CREATE TABLE plugin_demo_sys (id TEXT CHECK (id != sqlite_master));',
    ];
    for (const badSql of invalidCases) {
      expect(() => validatePluginMigrationSql('demo', badSql), `expected rejection for: ${badSql}`).toThrow(
        RangeError
      );
    }
  });

  it('enforces runtime SQL scope guard with KinloomHttpError(500, PLUGIN_SQL_SCOPE_VIOLATION)', () => {
    expect(
      assertScopedPluginSql(
        'recipes',
        "SELECT r.id, r.title FROM plugin_recipes_items r INNER JOIN plugin_recipes_stars s ON s.recipe_id = r.id WHERE r.course = 'other'"
      )
    ).toContain('plugin_recipes_items');

    expect(
      assertScopedPluginSql(
        'recipes',
        `WITH active AS (SELECT id FROM plugin_recipes_items WHERE deleted_at IS NULL)
         SELECT a.id FROM active a JOIN plugin_recipes_photos p ON p.recipe_id = a.id`
      )
    ).toContain('WITH active');

    expect(
      assertScopedPluginSql(
        'recipes',
        'INSERT INTO plugin_recipes_stars (recipe_id, actor_key, created_at) VALUES (?, ?, ?) ON CONFLICT(recipe_id, actor_key) DO UPDATE SET created_at = excluded.created_at'
      )
    ).toContain('DO UPDATE SET');

    expect(
      assertScopedPluginSql(
        'recipes',
        'UPDATE OR IGNORE plugin_recipes_items SET star_count = (SELECT COUNT(*) FROM plugin_recipes_stars WHERE recipe_id = ?) WHERE id = ?'
      )
    ).toContain('UPDATE OR IGNORE');

    expect(
      assertScopedPluginSql(
        'recipes',
        'DELETE FROM plugin_recipes_stars WHERE recipe_id = ? AND actor_key = ?'
      )
    ).toContain('DELETE FROM');

    const badRuntimeQueries: string[] = [
      '',
      'SELECT * FROM plugin_recipes_items; DELETE FROM plugin_recipes_items;',
      'SELECT * FROM entities;',
      'SELECT * FROM plugin_recipes_items r, users u WHERE r.created_by_id = u.email;',
      'SELECT * FROM (SELECT email FROM users);',
      'SELECT * FROM plugin_other_items;',
      'SELECT name FROM sqlite_master;',
      'SELECT * FROM main.plugin_recipes_items;',
      'PRAGMA table_info(users);',
      'ATTACH DATABASE "foo" AS bar;',
      'CREATE TABLE plugin_recipes_sneaky (id TEXT);',
      'DROP TABLE plugin_recipes_items;',
      'UPDATE users SET role = "admin";',
      'INSERT INTO plugin_migrations (plugin_id) VALUES (?);',
    ];

    for (const badSql of badRuntimeQueries) {
      let caught: unknown;
      try {
        assertScopedPluginSql('recipes', badSql);
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected KinloomHttpError for: ${badSql}`).toBeInstanceOf(KinloomHttpError);
      const httpErr = caught as KinloomHttpError;
      expect(httpErr.status).toBe(500);
      expect(httpErr.code).toBe('PLUGIN_SQL_SCOPE_VIOLATION');
    }

    // Confirm every forbidden core table in spec is blocked
    for (const coreTable of FORBIDDEN_PLUGIN_CORE_TABLES) {
      expect(() => assertScopedPluginSql('recipes', `SELECT * FROM ${coreTable}`)).toThrow(KinloomHttpError);
    }
  });

  it('validates plugin migration ordering, IDs, duplicate namespaces, and idempotent runner with checksum drift rejection', async () => {
    const validPlugin: KinloomServerPlugin = {
      id: 'kinloom-demo',
      name: 'Demo Plugin',
      databaseNamespace: 'demo',
      migrations: [
        {
          version: 1,
          id: '0001_demo_init',
          description: 'Create demo items table',
          sql: 'CREATE TABLE IF NOT EXISTS plugin_demo_items (id TEXT PRIMARY KEY);',
        },
        {
          version: 2,
          id: '0002_demo_index',
          description: 'Create demo items index',
          sql: 'CREATE INDEX IF NOT EXISTS idx_plugin_demo_items_id ON plugin_demo_items (id);',
        },
      ],
    };

    expect(validatePluginMigrations(validPlugin)).toHaveLength(2);
    expect(validatePluginMigrations({ id: 'no-db' })).toEqual([]);

    // Invalid plugin registrations
    expect(() =>
      validatePluginMigrations({
        id: 'missing-ns',
        migrations: validPlugin.migrations,
      })
    ).toThrow(/without a databaseNamespace/);

    expect(() =>
      validatePluginMigrations({
        id: 'bad-order',
        databaseNamespace: 'demo',
        migrations: [
          {
            version: 2,
            id: '0002_first',
            description: 'First',
            sql: 'CREATE TABLE plugin_demo_a (id TEXT);',
          },
          {
            version: 2,
            id: '0002_dup_ver',
            description: 'Second',
            sql: 'CREATE TABLE plugin_demo_b (id TEXT);',
          },
        ],
      })
    ).toThrow(/strictly ascending/);

    expect(() =>
      validatePluginMigrations({
        id: 'bad-id',
        databaseNamespace: 'demo',
        migrations: [
          {
            version: 1,
            id: 'INVALID ID',
            description: 'Bad',
            sql: 'CREATE TABLE plugin_demo_a (id TEXT);',
          },
        ],
      })
    ).toThrow(RangeError);

    expect(() =>
      validatePluginMigrations({
        id: 'dup-id',
        databaseNamespace: 'demo',
        migrations: [
          {
            version: 1,
            id: '0001_same',
            description: 'One',
            sql: 'CREATE TABLE plugin_demo_a (id TEXT);',
          },
          {
            version: 2,
            id: '0001_same',
            description: 'Two',
            sql: 'CREATE TABLE plugin_demo_b (id TEXT);',
          },
        ],
      })
    ).toThrow(/duplicate migration id/);

    expect(() =>
      validateRegisteredPluginDatabases([validPlugin, { id: 'kinloom-demo-2', databaseNamespace: 'demo' }])
    ).toThrow(/Duplicate plugin databaseNamespace 'demo'/);

    // Runner test: zero DB touch when no plugins declare migrations
    let listCalls = 0;
    const ledger: AppliedPluginMigrationRecord[] = [];
    const appliedStatements: string[][] = [];
    const executor: PluginMigrationExecutor = {
      async listAppliedMigrations() {
        listCalls += 1;
        return [...ledger];
      },
      async applyMigration(params) {
        appliedStatements.push([...params.statements]);
        ledger.push({
          plugin_id: params.pluginId,
          namespace: params.namespace,
          version: params.migration.version,
          migration_id: params.migration.id,
          checksum_sha256: params.checksumSha256,
          applied_at: params.appliedAt,
        });
      },
    };
    const clock = new FixedClock('2026-11-27T12:00:00.000Z');

    const emptyRun = await runPluginMigrations(executor, [{ id: 'static' }], clock);
    expect(emptyRun).toEqual({ applied: [], skipped: [] });
    expect(listCalls).toBe(0);

    // First run applies both migrations
    const firstRun = await runPluginMigrations(executor, [validPlugin], clock);
    expect(firstRun.applied).toHaveLength(2);
    expect(firstRun.skipped).toEqual([]);
    expect(appliedStatements).toHaveLength(2);
    expect(firstRun.applied[0].checksum_sha256).toBe(
      await computeMigrationChecksum(validPlugin.migrations?.[0].sql ?? '')
    );

    // Second run is strictly idempotent
    const secondRun = await runPluginMigrations(executor, [validPlugin], clock);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped).toHaveLength(2);
    expect(appliedStatements).toHaveLength(2);

    // Mutated SQL for an already-applied version fails fast with RangeError
    const mutatedPlugin: KinloomServerPlugin = {
      ...validPlugin,
      migrations: [
        {
          version: 1,
          id: '0001_demo_init',
          description: 'Mutated SQL',
          sql: 'CREATE TABLE IF NOT EXISTS plugin_demo_items (id TEXT PRIMARY KEY, extra TEXT);',
        },
      ],
    };
    await expect(runPluginMigrations(executor, [mutatedPlugin], clock)).rejects.toThrow(
      /checksum or identity mismatch/
    );
  });
});
