import type { WranglerExecutor } from '../shared/wrangler.js';

export type MigrateTarget = 'remote' | 'local';

export interface D1DatabaseBinding {
  readonly configPath: string;
  readonly dbName: string;
  readonly migrationsDirHint?: string;
}

export interface MigrationColumnRequirement {
  readonly table: string;
  readonly column: string;
  readonly statement: string;
}

export interface MigrationSchemaRequirements {
  readonly createdTables: readonly string[];
  readonly addedColumns: readonly MigrationColumnRequirement[];
  readonly createdIndexes: readonly string[];
  readonly isInitialSchema: boolean;
  readonly onlyAlterAddColumns: boolean;
}

export interface DiscoveredMigration {
  readonly id: string;
  readonly number: number;
  readonly filePath: string;
  readonly sql: string;
  readonly requirements: MigrationSchemaRequirements;
}

export interface AppliedPluginLedgerEntry {
  readonly pluginId: string;
  readonly namespace: string;
  readonly version: number;
  readonly migrationId: string;
  readonly checksumSha256: string;
}

export interface DiscoveredPluginMigration {
  readonly pluginId: string;
  readonly namespace: string;
  readonly version: number;
  readonly migrationId: string;
  readonly filePath: string;
  readonly sql: string;
  readonly checksumSha256: string;
  readonly requirements: MigrationSchemaRequirements;
}

export interface PluginMigrationStatusEntry {
  readonly pluginId: string;
  readonly namespace: string;
  readonly version: number;
  readonly migrationId: string;
  readonly filePath: string;
  readonly status: 'applied' | 'pending';
  readonly satisfiedBy: 'plugin_migrations' | 'applied_now' | 'pending';
  readonly missingObjects: readonly string[];
}

export interface D1SchemaSnapshot {
  readonly tables: ReadonlySet<string>;
  readonly indexes: ReadonlySet<string>;
  readonly columnsByTable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly trackedMigrations: ReadonlySet<string>;
  readonly pluginLedger?: ReadonlyMap<string, AppliedPluginLedgerEntry>;
}

export interface MigrationStatusEntry {
  readonly id: string;
  readonly number: number;
  readonly filePath: string;
  readonly status: 'applied' | 'pending';
  readonly satisfiedBy: 'schema' | 'd1_migrations' | 'applied_now' | 'pending';
  readonly missingObjects: readonly string[];
}

export interface MigrateCommandOptions {
  readonly repoDir?: string;
  readonly target?: MigrateTarget;
  readonly dryRun?: boolean;
  readonly json?: boolean;
  readonly migrationsDir?: string;
  readonly pluginMigrationsDir?: string;
  readonly wranglerBin?: string;
  readonly execWrangler?: WranglerExecutor;
}

export interface MigrateCommandResult {
  readonly ok: boolean;
  readonly repo: string;
  readonly configPath: string;
  readonly dbName: string;
  readonly target: MigrateTarget;
  readonly dryRun: boolean;
  readonly migrationsDir: string;
  readonly applied: readonly MigrationStatusEntry[];
  readonly pending: readonly MigrationStatusEntry[];
  readonly executed: readonly string[];
  readonly verified: boolean;
  readonly rendered: string;
  readonly pluginMigrationsDir?: string;
  readonly pluginApplied?: readonly PluginMigrationStatusEntry[];
  readonly pluginPending?: readonly PluginMigrationStatusEntry[];
  readonly pluginExecuted?: readonly string[];
}

export interface D1StatementResult {
  readonly success: boolean;
  readonly results: readonly Record<string, unknown>[];
}

export interface MigrateExecContext {
  readonly repoDir: string;
  readonly binding: D1DatabaseBinding;
  readonly target: MigrateTarget;
  readonly wranglerBin: string;
  readonly execWrangler: WranglerExecutor;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
