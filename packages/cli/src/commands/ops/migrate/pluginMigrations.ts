import fs from 'node:fs';
import path from 'node:path';
import {
  assertValidPluginNamespace,
  computeMigrationChecksum,
  validatePluginMigrations,
} from '@kinloom/server';
import { CliValidationError } from '../../../errors.js';
import { parseMigrationSchemaRequirements } from './sqlParser.js';
import type { D1SchemaSnapshot, DiscoveredPluginMigration, PluginMigrationStatusEntry } from './types.js';

const PLUGIN_MIGRATION_FILE_RE = /^(\d+)_([a-z0-9][a-z0-9_-]*)\.sql$/;
const PLUGIN_ID_HEADER_RE = /^\s*--\s*plugin_id\s*:\s*([a-z0-9][a-z0-9_-]{1,63})\s*$/im;

function escapeSqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function pluginMigrationLedgerKey(pluginId: string, version: number): string {
  return `${pluginId}:${version}`;
}

export function resolvePluginMigrationsDir(
  repoDir: string,
  explicitPluginMigrationsDir?: string
): string | null {
  const resolvedRepo = path.resolve(repoDir);
  if (explicitPluginMigrationsDir && explicitPluginMigrationsDir.trim().length > 0) {
    const resolved = path.resolve(resolvedRepo, explicitPluginMigrationsDir.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new CliValidationError(`Plugin migrations directory not found: ${resolved}`);
    }
    return resolved;
  }

  const defaultDir = path.join(resolvedRepo, 'migrations', 'plugins');
  if (fs.existsSync(defaultDir) && fs.statSync(defaultDir).isDirectory()) {
    return defaultDir;
  }
  return null;
}

/**
 * Discovers and validates `<pluginMigrationsDir>/<namespace>/<NNNN>_<name>.sql` files
 * against the shared Kinloom plugin SQL namespace guard.
 */
export async function discoverPluginMigrations(
  pluginMigrationsDir: string
): Promise<DiscoveredPluginMigration[]> {
  if (!fs.existsSync(pluginMigrationsDir) || !fs.statSync(pluginMigrationsDir).isDirectory()) {
    throw new CliValidationError(`Plugin migrations directory not found: ${pluginMigrationsDir}`);
  }

  const namespaceEntries = fs
    .readdirSync(pluginMigrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const discovered: DiscoveredPluginMigration[] = [];

  for (const nsEntry of namespaceEntries) {
    let namespace: string;
    try {
      namespace = assertValidPluginNamespace(nsEntry.name);
    } catch (error) {
      throw new CliValidationError(error instanceof Error ? error.message : String(error));
    }

    const nsDir = path.join(pluginMigrationsDir, nsEntry.name);
    const sqlFiles = fs
      .readdirSync(nsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sql') && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    if (sqlFiles.length === 0) {
      continue;
    }

    let pluginId = `kinloom-${namespace}`;
    const rawMigrations: Array<{
      readonly version: number;
      readonly id: string;
      readonly description: string;
      readonly sql: string;
      readonly filePath: string;
    }> = [];

    for (const fileName of sqlFiles) {
      const match = PLUGIN_MIGRATION_FILE_RE.exec(fileName);
      if (!match) {
        throw new CliValidationError(
          `Invalid plugin migration filename '${fileName}' under '${nsDir}': expected NNNN_<lowercase_name>.sql.`
        );
      }
      const version = Number.parseInt(match[1] ?? '', 10);
      const migrationId = fileName.slice(0, -'.sql'.length);
      const filePath = path.join(nsDir, fileName);
      const sql = fs.readFileSync(filePath, 'utf8');
      const headerMatch = PLUGIN_ID_HEADER_RE.exec(sql);
      if (headerMatch?.[1]) {
        pluginId = headerMatch[1].trim();
      }
      rawMigrations.push({
        version,
        id: migrationId,
        description: `Plugin ${namespace} migration ${migrationId}`,
        sql,
        filePath,
      });
    }

    rawMigrations.sort((a, b) => a.version - b.version || a.id.localeCompare(b.id));

    try {
      validatePluginMigrations({
        id: pluginId,
        databaseNamespace: namespace,
        migrations: rawMigrations.map((m) => ({
          version: m.version,
          id: m.id,
          description: m.description,
          sql: m.sql,
        })),
      });
    } catch (error) {
      throw new CliValidationError(error instanceof Error ? error.message : String(error));
    }

    for (const item of rawMigrations) {
      discovered.push({
        pluginId,
        namespace,
        version: item.version,
        migrationId: item.id,
        filePath: item.filePath,
        sql: item.sql,
        checksumSha256: await computeMigrationChecksum(item.sql),
        requirements: parseMigrationSchemaRequirements(item.sql, item.version),
        source: 'filesystem',
      });
    }
  }

  return discovered;
}

export function evaluatePluginMigrationStatus(
  migration: DiscoveredPluginMigration,
  snapshot: D1SchemaSnapshot,
  justExecutedKeys?: ReadonlySet<string>
): PluginMigrationStatusEntry {
  const key = pluginMigrationLedgerKey(migration.pluginId, migration.version);
  const ledgerEntry = snapshot.pluginLedger?.get(key);

  if (ledgerEntry) {
    if (
      ledgerEntry.checksumSha256 !== migration.checksumSha256 ||
      ledgerEntry.migrationId !== migration.migrationId ||
      ledgerEntry.namespace !== migration.namespace
    ) {
      throw new CliValidationError(
        `Plugin migration checksum or identity mismatch for '${migration.pluginId}' v${migration.version} ('${migration.migrationId}'): ` +
          `database ledger recorded '${ledgerEntry.migrationId}' (${ledgerEntry.checksumSha256}), ` +
          `but file '${migration.filePath}' has checksum ${migration.checksumSha256}.`
      );
    }
  }

  const missingObjects: string[] = [];
  if (!ledgerEntry) {
    missingObjects.push(`plugin_migration:${migration.namespace}/${migration.migrationId}`);
  }
  for (const table of migration.requirements.createdTables) {
    if (!snapshot.tables.has(table)) {
      missingObjects.push(`table:${table}`);
    }
  }
  for (const index of migration.requirements.createdIndexes) {
    if (!snapshot.indexes.has(index)) {
      missingObjects.push(`index:${index}`);
    }
  }

  if (missingObjects.length === 0) {
    return {
      pluginId: migration.pluginId,
      namespace: migration.namespace,
      version: migration.version,
      migrationId: migration.migrationId,
      filePath: migration.filePath,
      status: 'applied',
      satisfiedBy: justExecutedKeys?.has(key) ? 'applied_now' : 'plugin_migrations',
      missingObjects: [],
    };
  }

  return {
    pluginId: migration.pluginId,
    namespace: migration.namespace,
    version: migration.version,
    migrationId: migration.migrationId,
    filePath: migration.filePath,
    status: 'pending',
    satisfiedBy: 'pending',
    missingObjects,
  };
}

export function buildPluginLedgerInsertSql(
  migration: DiscoveredPluginMigration,
  appliedAtIso: string
): string {
  return (
    'INSERT INTO plugin_migrations (plugin_id, namespace, version, migration_id, checksum_sha256, applied_at) ' +
    `VALUES (${escapeSqlText(migration.pluginId)}, ${escapeSqlText(migration.namespace)}, ${migration.version}, ` +
    `${escapeSqlText(migration.migrationId)}, ${escapeSqlText(migration.checksumSha256)}, ${escapeSqlText(appliedAtIso)});`
  );
}
