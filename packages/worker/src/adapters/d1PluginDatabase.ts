import {
  type AppliedPluginMigrationRecord,
  AppliedPluginMigrationRecordSchema,
  type Clock,
  type PluginDatabaseFactory,
  type PluginDatabasePort,
  type PluginSqlRunResult,
  type PluginSqlStatement,
  type PluginSqlValue,
} from '@kinloom/core';
import {
  assertScopedPluginSql,
  assertValidPluginNamespace,
  type KinloomServerPlugin,
  type PluginMigrationExecutor,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  type RunPluginMigrationsResult,
  runPluginMigrations,
  SqlRecipesRepository,
} from '@kinloom/server';
import type { D1Database } from '../types.js';

/**
 * Namespace-scoped Cloudflare D1 implementation of PluginDatabasePort.
 * Every statement passes through `assertScopedPluginSql(namespace, sql)` before preparing,
 * and every returned row passes through the caller's `parseRow` boundary validator.
 */
export class D1PluginDatabasePort implements PluginDatabasePort {
  readonly adapterKind = 'd1';
  readonly namespace: string;
  private readonly db: D1Database;

  constructor(db: D1Database, namespace: string) {
    this.db = db;
    this.namespace = assertValidPluginNamespace(namespace);
  }

  async query<T>(
    sql: string,
    params: readonly PluginSqlValue[],
    parseRow: (raw: Record<string, unknown>) => T
  ): Promise<readonly T[]> {
    const scopedSql = assertScopedPluginSql(this.namespace, sql);
    const stmt = this.db.prepare(scopedSql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await bound.all<Record<string, unknown>>();
    return result.results.map((row) => parseRow(row));
  }

  async first<T>(
    sql: string,
    params: readonly PluginSqlValue[],
    parseRow: (raw: Record<string, unknown>) => T
  ): Promise<T | null> {
    const scopedSql = assertScopedPluginSql(this.namespace, sql);
    const stmt = this.db.prepare(scopedSql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const row = await bound.first<Record<string, unknown>>();
    return row === null ? null : parseRow(row);
  }

  async run(sql: string, params: readonly PluginSqlValue[] = []): Promise<PluginSqlRunResult> {
    const scopedSql = assertScopedPluginSql(this.namespace, sql);
    const stmt = this.db.prepare(scopedSql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    const result = await bound.run();
    return {
      changes: result.meta.changes ?? 0,
      ...(typeof result.meta.last_row_id === 'number' ? { lastRowId: result.meta.last_row_id } : {}),
    };
  }

  async batch(statements: readonly PluginSqlStatement[]): Promise<readonly PluginSqlRunResult[]> {
    if (statements.length === 0) {
      return [];
    }
    // Validate every statement before executing any statement in the batch.
    const prepared = statements.map((item) => {
      const scopedSql = assertScopedPluginSql(this.namespace, item.sql);
      const stmt = this.db.prepare(scopedSql);
      const params = item.params ?? [];
      return params.length > 0 ? stmt.bind(...params) : stmt;
    });
    const results = await this.db.batch(prepared);
    return results.map((result) => ({
      changes: result.meta.changes ?? 0,
      ...(typeof result.meta.last_row_id === 'number' ? { lastRowId: result.meta.last_row_id } : {}),
    }));
  }
}

/**
 * Cloudflare D1 implementation of PluginDatabaseFactory.
 * Instantiating the factory executes zero SQL statements on default archives.
 */
export class D1PluginDatabaseFactory implements PluginDatabaseFactory {
  readonly adapterKind = 'd1';
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  forPlugin(_pluginId: string, namespace: string): PluginDatabasePort {
    return new D1PluginDatabasePort(this.db, namespace);
  }
}

/**
 * Creates a Cloudflare D1 executor for `runPluginMigrations` backed by the `plugin_migrations` ledger.
 */
export function createD1PluginMigrationExecutor(db: D1Database): PluginMigrationExecutor {
  return {
    async listAppliedMigrations(): Promise<readonly AppliedPluginMigrationRecord[]> {
      const result = await db
        .prepare(
          'SELECT plugin_id, namespace, version, migration_id, checksum_sha256, applied_at FROM plugin_migrations ORDER BY plugin_id ASC, version ASC'
        )
        .all<Record<string, unknown>>();
      return result.results.map((row) => AppliedPluginMigrationRecordSchema.parse(row));
    },
    async applyMigration(params): Promise<void> {
      const statements = [
        ...params.statements.map((stmt) => db.prepare(stmt)),
        db
          .prepare(
            `INSERT INTO plugin_migrations (plugin_id, namespace, version, migration_id, checksum_sha256, applied_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .bind(
            params.pluginId,
            params.namespace,
            params.migration.version,
            params.migration.id,
            params.checksumSha256,
            params.appliedAt
          ),
      ];
      await db.batch(statements);
    },
  };
}

/**
 * Applies versioned, namespaced plugin migrations idempotently against Cloudflare D1.
 */
export async function runD1PluginMigrations(
  db: D1Database,
  plugins: readonly Pick<KinloomServerPlugin, 'id' | 'databaseNamespace' | 'migrations'>[],
  clock: Clock
): Promise<RunPluginMigrationsResult> {
  return runPluginMigrations(createD1PluginMigrationExecutor(db), plugins, clock);
}

/**
 * Convenience factory creating a Cloudflare D1-backed SqlRecipesRepository
 * confined strictly to the `plugin_recipes_*` namespace.
 */
export function createD1RecipesRepository(db: D1Database): SqlRecipesRepository {
  const factory = new D1PluginDatabaseFactory(db);
  return new SqlRecipesRepository(factory.forPlugin(RECIPES_PLUGIN_ID, RECIPES_DATABASE_NAMESPACE));
}
