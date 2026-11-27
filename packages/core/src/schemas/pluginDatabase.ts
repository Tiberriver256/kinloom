import { z } from 'zod';

/**
 * Valid SQL namespace segment for a database-backed plugin.
 * Plugin tables must start with `plugin_<namespace>_` and indexes with `idx_plugin_<namespace>_`.
 */
export const PLUGIN_DATABASE_NAMESPACE_RE = /^[a-z][a-z0-9_]{1,24}$/;

/**
 * Valid stable identifier for a plugin SQL migration (e.g. `0001_recipes_initial`).
 */
export const PLUGIN_MIGRATION_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const PluginDatabaseNamespaceSchema = z
  .string()
  .trim()
  .regex(
    PLUGIN_DATABASE_NAMESPACE_RE,
    'Plugin databaseNamespace must start with a lowercase letter and contain 2-25 lowercase letters, digits, or underscores.'
  );

export const PluginMigrationIdSchema = z
  .string()
  .trim()
  .regex(
    PLUGIN_MIGRATION_ID_RE,
    'Plugin migration id must start with a lowercase letter or digit and contain 2-64 lowercase letters, digits, underscores, or hyphens.'
  );

export const PluginSqlMigrationSchema = z.object({
  version: z.number().int().min(1),
  id: PluginMigrationIdSchema,
  description: z.string().trim().min(1).max(240),
  sql: z.string().trim().min(1),
});

export const AppliedPluginMigrationRecordSchema = z.object({
  plugin_id: z.string().min(1),
  namespace: PluginDatabaseNamespaceSchema,
  version: z.number().int().min(1),
  migration_id: PluginMigrationIdSchema,
  checksum_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  applied_at: z.string().min(1),
});

export type PluginSqlValue = string | number | null | Uint8Array;

export interface PluginSqlMigration {
  /** Positive monotonic integer starting at 1 per plugin. */
  readonly version: number;
  /** Stable identifier such as '0001_recipes_initial'. Matches /^[a-z0-9][a-z0-9_-]{1,63}$/. */
  readonly id: string;
  /** Short human-readable summary shown in `kinloom migrate` and diagnostics. */
  readonly description: string;
  /** Idempotent SQLite/D1 DDL restricted strictly to tables/indexes under `plugin_<namespace>_*`. */
  readonly sql: string;
}

export interface AppliedPluginMigrationRecord {
  readonly plugin_id: string;
  readonly namespace: string;
  readonly version: number;
  readonly migration_id: string;
  readonly checksum_sha256: string;
  readonly applied_at: string;
}

export interface PluginSqlRunResult {
  readonly changes: number;
  readonly lastRowId?: number;
}

export interface PluginSqlStatement {
  readonly sql: string;
  readonly params?: readonly PluginSqlValue[];
}

export interface PluginDatabasePort {
  readonly adapterKind: string;
  readonly namespace: string;
  query<T>(
    sql: string,
    params: readonly PluginSqlValue[],
    parseRow: (raw: Record<string, unknown>) => T
  ): Promise<readonly T[]>;
  first<T>(
    sql: string,
    params: readonly PluginSqlValue[],
    parseRow: (raw: Record<string, unknown>) => T
  ): Promise<T | null>;
  run(sql: string, params?: readonly PluginSqlValue[]): Promise<PluginSqlRunResult>;
  batch(statements: readonly PluginSqlStatement[]): Promise<readonly PluginSqlRunResult[]>;
}

export interface PluginDatabaseFactory {
  readonly adapterKind: string;
  forPlugin(pluginId: string, namespace: string): PluginDatabasePort;
}
