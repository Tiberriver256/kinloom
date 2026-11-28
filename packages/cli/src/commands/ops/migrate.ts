import path from 'node:path';
import {
  BUILTIN_SERVER_PLUGIN_MIGRATIONS,
  type BuiltInServerPluginMigrationSpec,
  detectEnabledBuiltInPlugins,
  discoverBuiltInPluginMigrations,
  mergePluginMigrations,
} from './migrate/builtinPlugins.js';
import {
  defaultWranglerExecutor,
  executeD1Command,
  executeD1File,
  executePluginMigrationFile,
  inspectD1Schema,
} from './migrate/d1Client.js';
import {
  discoverMigrations,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
  resolveWranglerBin,
} from './migrate/discovery.js';
import {
  buildPluginLedgerInsertSql,
  discoverPluginMigrations,
  evaluatePluginMigrationStatus,
  pluginMigrationLedgerKey,
  resolvePluginMigrationsDir,
} from './migrate/pluginMigrations.js';
import { formatMigrateReport } from './migrate/report.js';
import {
  buildMissingAlterStatements,
  evaluateMigrationStatus,
  parseMigrationSchemaRequirements,
} from './migrate/sqlParser.js';
import type {
  MigrateCommandOptions,
  MigrateCommandResult,
  MigrateExecContext,
  MigrateTarget,
} from './migrate/types.js';

export type {
  AppliedPluginLedgerEntry,
  D1DatabaseBinding,
  D1SchemaSnapshot,
  DiscoveredMigration,
  DiscoveredPluginMigration,
  MigrateCommandOptions,
  MigrateCommandResult,
  MigrateTarget,
  MigrationColumnRequirement,
  MigrationSchemaRequirements,
  MigrationStatusEntry,
  PluginMigrationSource,
  PluginMigrationStatusEntry,
} from './migrate/types.js';
export {
  BUILTIN_SERVER_PLUGIN_MIGRATIONS,
  type BuiltInServerPluginMigrationSpec,
  detectEnabledBuiltInPlugins,
  discoverBuiltInPluginMigrations,
  discoverMigrations,
  discoverPluginMigrations,
  evaluateMigrationStatus,
  evaluatePluginMigrationStatus,
  formatMigrateReport,
  mergePluginMigrations,
  parseMigrationSchemaRequirements,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
  resolvePluginMigrationsDir,
};

export async function runMigrateCommand(options: MigrateCommandOptions = {}): Promise<MigrateCommandResult> {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const target: MigrateTarget = options.target ?? 'remote';
  const dryRun = Boolean(options.dryRun);
  const includeEnabledPlugins = options.includeEnabledPlugins ?? true;
  const binding = resolveD1DatabaseBinding(repoDir);
  const migrationsDir = resolveMigrationsDir(repoDir, options.migrationsDir, binding.migrationsDirHint);
  const migrations = discoverMigrations(migrationsDir);
  const pluginMigrationsDir = resolvePluginMigrationsDir(repoDir, options.pluginMigrationsDir);
  const filesystemPluginMigrations = pluginMigrationsDir
    ? await discoverPluginMigrations(pluginMigrationsDir)
    : [];
  const builtInDiscovery = includeEnabledPlugins
    ? await discoverBuiltInPluginMigrations(repoDir)
    : { enabledPlugins: [] as readonly string[], migrations: [] };
  const pluginMigrations = mergePluginMigrations(filesystemPluginMigrations, builtInDiscovery.migrations);
  const hasPluginMigrations = pluginMigrations.length > 0;
  const enabledBuiltInPlugins = builtInDiscovery.enabledPlugins;

  const ctx: MigrateExecContext = {
    repoDir,
    binding,
    target,
    wranglerBin: resolveWranglerBin(repoDir, options.wranglerBin),
    execWrangler: options.execWrangler ?? defaultWranglerExecutor,
  };

  const beforeSnapshot = await inspectD1Schema(ctx, migrations, hasPluginMigrations);
  const beforeEntries = migrations.map((m) => evaluateMigrationStatus(m, beforeSnapshot));
  const pendingBefore = beforeEntries.filter((e) => e.status === 'pending');

  const pluginBeforeEntries = hasPluginMigrations
    ? pluginMigrations.map((pm) => evaluatePluginMigrationStatus(pm, beforeSnapshot))
    : [];
  const pluginPendingBefore = pluginBeforeEntries.filter((e) => e.status === 'pending');

  if (dryRun || (pendingBefore.length === 0 && pluginPendingBefore.length === 0)) {
    const applied = beforeEntries.filter((e) => e.status === 'applied');
    const pending = pendingBefore;
    const pluginApplied = pluginBeforeEntries.filter((e) => e.status === 'applied');
    const base = {
      ok: true,
      repo: repoDir,
      configPath: binding.configPath,
      dbName: binding.dbName,
      target,
      dryRun,
      migrationsDir,
      applied,
      pending,
      executed: [] as string[],
      verified: pending.length === 0 && pluginPendingBefore.length === 0,
      ...(pluginMigrationsDir ? { pluginMigrationsDir } : {}),
      ...(enabledBuiltInPlugins.length > 0 ? { enabledBuiltInPlugins } : {}),
      ...(hasPluginMigrations
        ? {
            pluginApplied,
            pluginPending: pluginPendingBefore,
            pluginExecuted: [] as string[],
          }
        : {}),
    };
    const rendered = options.json ? JSON.stringify(base, null, 2) : formatMigrateReport(base);
    return { ...base, rendered };
  }

  const executed: string[] = [];
  const pendingIds = new Set(pendingBefore.map((e) => e.id));
  for (const migration of migrations) {
    if (!pendingIds.has(migration.id)) {
      continue;
    }
    const partialAlterStatements = buildMissingAlterStatements(migration, beforeSnapshot);
    if (partialAlterStatements && partialAlterStatements.length > 0) {
      await executeD1Command(ctx, partialAlterStatements.join(' '));
    } else {
      await executeD1File(ctx, migration.filePath);
    }
    executed.push(migration.id);
  }

  const pluginExecuted: string[] = [];
  const pluginExecutedKeys = new Set<string>();
  const pendingPluginKeys = new Set(
    pluginPendingBefore.map((e) => pluginMigrationLedgerKey(e.pluginId, e.version))
  );
  for (const pluginMigration of pluginMigrations) {
    const key = pluginMigrationLedgerKey(pluginMigration.pluginId, pluginMigration.version);
    if (!pendingPluginKeys.has(key)) {
      continue;
    }
    await executePluginMigrationFile(ctx, pluginMigration);
    await executeD1Command(ctx, buildPluginLedgerInsertSql(pluginMigration, new Date().toISOString()));
    pluginExecuted.push(`${pluginMigration.namespace}/${pluginMigration.migrationId}`);
    pluginExecutedKeys.add(key);
  }

  const afterSnapshot = await inspectD1Schema(ctx, migrations, hasPluginMigrations);
  const executedSet = new Set(executed);
  const afterEntries = migrations.map((m) => evaluateMigrationStatus(m, afterSnapshot, executedSet));
  const applied = afterEntries.filter((e) => e.status === 'applied');
  const pending = afterEntries.filter((e) => e.status === 'pending');

  const pluginAfterEntries = hasPluginMigrations
    ? pluginMigrations.map((pm) => evaluatePluginMigrationStatus(pm, afterSnapshot, pluginExecutedKeys))
    : [];
  const pluginApplied = pluginAfterEntries.filter((e) => e.status === 'applied');
  const pluginPending = pluginAfterEntries.filter((e) => e.status === 'pending');
  const verified = pending.length === 0 && pluginPending.length === 0;

  const base = {
    ok: verified,
    repo: repoDir,
    configPath: binding.configPath,
    dbName: binding.dbName,
    target,
    dryRun: false,
    migrationsDir,
    applied,
    pending,
    executed,
    verified,
    ...(pluginMigrationsDir ? { pluginMigrationsDir } : {}),
    ...(enabledBuiltInPlugins.length > 0 ? { enabledBuiltInPlugins } : {}),
    ...(hasPluginMigrations
      ? {
          pluginApplied,
          pluginPending,
          pluginExecuted,
        }
      : {}),
  };
  const rendered = options.json ? JSON.stringify(base, null, 2) : formatMigrateReport(base);
  return { ...base, rendered };
}
