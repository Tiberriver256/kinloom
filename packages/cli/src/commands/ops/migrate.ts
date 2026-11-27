import path from 'node:path';
import {
  defaultWranglerExecutor,
  executeD1Command,
  executeD1File,
  inspectD1Schema,
} from './migrate/d1Client.js';
import {
  discoverMigrations,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
  resolveWranglerBin,
} from './migrate/discovery.js';
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
  D1DatabaseBinding,
  D1SchemaSnapshot,
  DiscoveredMigration,
  MigrateCommandOptions,
  MigrateCommandResult,
  MigrateTarget,
  MigrationColumnRequirement,
  MigrationSchemaRequirements,
  MigrationStatusEntry,
} from './migrate/types.js';
export {
  discoverMigrations,
  evaluateMigrationStatus,
  formatMigrateReport,
  parseMigrationSchemaRequirements,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
};

export async function runMigrateCommand(options: MigrateCommandOptions = {}): Promise<MigrateCommandResult> {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const target: MigrateTarget = options.target ?? 'remote';
  const dryRun = Boolean(options.dryRun);
  const binding = resolveD1DatabaseBinding(repoDir);
  const migrationsDir = resolveMigrationsDir(repoDir, options.migrationsDir, binding.migrationsDirHint);
  const migrations = discoverMigrations(migrationsDir);

  const ctx: MigrateExecContext = {
    repoDir,
    binding,
    target,
    wranglerBin: resolveWranglerBin(repoDir, options.wranglerBin),
    execWrangler: options.execWrangler ?? defaultWranglerExecutor,
  };

  const beforeSnapshot = await inspectD1Schema(ctx, migrations);
  const beforeEntries = migrations.map((m) => evaluateMigrationStatus(m, beforeSnapshot));
  const pendingBefore = beforeEntries.filter((e) => e.status === 'pending');

  if (dryRun || pendingBefore.length === 0) {
    const applied = beforeEntries.filter((e) => e.status === 'applied');
    const pending = pendingBefore;
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
      verified: pending.length === 0,
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

  const afterSnapshot = await inspectD1Schema(ctx, migrations);
  const executedSet = new Set(executed);
  const afterEntries = migrations.map((m) => evaluateMigrationStatus(m, afterSnapshot, executedSet));
  const applied = afterEntries.filter((e) => e.status === 'applied');
  const pending = afterEntries.filter((e) => e.status === 'pending');
  const verified = pending.length === 0;

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
  };
  const rendered = options.json ? JSON.stringify(base, null, 2) : formatMigrateReport(base);
  return { ...base, rendered };
}
