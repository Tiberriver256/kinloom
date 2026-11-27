import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { WranglerExecOptions, WranglerExecutor } from '../shared/wrangler.js';
import {
  type AppliedPluginLedgerEntry,
  type D1SchemaSnapshot,
  type D1StatementResult,
  type DiscoveredMigration,
  isPlainRecord,
  type MigrateExecContext,
} from './types.js';

const execFileAsync = promisify(execFile);

export const defaultWranglerExecutor: WranglerExecutor = async (
  wranglerBin: string,
  args: readonly string[],
  options: WranglerExecOptions
) => {
  const { stdout, stderr } = await execFileAsync(wranglerBin, [...args], {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBufferBytes,
    timeout: options.timeoutMs,
  });
  return { stdout, stderr };
};

function parseD1JsonOutput(stdout: string, dbName: string): D1StatementResult[] {
  const jsonStart = stdout.indexOf('[');
  if (jsonStart === -1) {
    throw new Error(`Unexpected wrangler D1 output for ${dbName}.`);
  }
  const parsed: unknown = JSON.parse(stdout.slice(jsonStart));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Empty wrangler D1 response for ${dbName}.`);
  }
  const statements: D1StatementResult[] = [];
  for (const stmt of parsed) {
    if (!isPlainRecord(stmt) || stmt.success !== true) {
      throw new Error(`D1 statement failed on ${dbName}.`);
    }
    statements.push({
      success: true,
      results: Array.isArray(stmt.results) ? stmt.results.filter(isPlainRecord) : [],
    });
  }
  return statements;
}

export async function executeD1Command(ctx: MigrateExecContext, sql: string): Promise<D1StatementResult[]> {
  const targetFlag = ctx.target === 'remote' ? '--remote' : '--local';
  const { stdout } = await ctx.execWrangler(
    ctx.wranglerBin,
    [
      'd1',
      'execute',
      ctx.binding.dbName,
      targetFlag,
      '--json',
      '--config',
      ctx.binding.configPath,
      '--command',
      sql,
    ],
    {
      cwd: ctx.repoDir,
      maxBufferBytes: 16 * 1024 * 1024,
      timeoutMs: 60_000,
    }
  );
  return parseD1JsonOutput(stdout, ctx.binding.dbName);
}

export async function executeD1File(ctx: MigrateExecContext, filePath: string): Promise<D1StatementResult[]> {
  const targetFlag = ctx.target === 'remote' ? '--remote' : '--local';
  const { stdout } = await ctx.execWrangler(
    ctx.wranglerBin,
    [
      'd1',
      'execute',
      ctx.binding.dbName,
      targetFlag,
      '--json',
      '--config',
      ctx.binding.configPath,
      '--file',
      filePath,
    ],
    {
      cwd: ctx.repoDir,
      maxBufferBytes: 16 * 1024 * 1024,
      timeoutMs: 60_000,
    }
  );
  return parseD1JsonOutput(stdout, ctx.binding.dbName);
}

export async function inspectD1Schema(
  ctx: MigrateExecContext,
  migrations: readonly DiscoveredMigration[],
  includePluginLedger = false
): Promise<D1SchemaSnapshot> {
  const masterStatements = await executeD1Command(
    ctx,
    "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index');"
  );

  const tables = new Set<string>();
  const indexes = new Set<string>();
  for (const row of masterStatements[0]?.results ?? []) {
    const type = typeof row.type === 'string' ? row.type : '';
    const name = typeof row.name === 'string' ? row.name : '';
    if (!name) {
      continue;
    }
    if (type === 'table') {
      tables.add(name);
    } else if (type === 'index') {
      indexes.add(name);
    }
  }

  const trackedMigrations = new Set<string>();
  if (tables.has('d1_migrations')) {
    const trackedStatements = await executeD1Command(ctx, 'SELECT name FROM d1_migrations;');
    for (const row of trackedStatements[0]?.results ?? []) {
      if (typeof row.name === 'string' && row.name.trim().length > 0) {
        trackedMigrations.add(row.name.trim());
      }
    }
  }

  let pluginLedger: Map<string, AppliedPluginLedgerEntry> | undefined;
  if (includePluginLedger && tables.has('plugin_migrations')) {
    pluginLedger = new Map<string, AppliedPluginLedgerEntry>();
    const ledgerStatements = await executeD1Command(
      ctx,
      'SELECT plugin_id, namespace, version, migration_id, checksum_sha256 FROM plugin_migrations;'
    );
    for (const row of ledgerStatements[0]?.results ?? []) {
      if (
        typeof row.plugin_id === 'string' &&
        typeof row.namespace === 'string' &&
        typeof row.version === 'number' &&
        typeof row.migration_id === 'string' &&
        typeof row.checksum_sha256 === 'string'
      ) {
        pluginLedger.set(`${row.plugin_id}:${row.version}`, {
          pluginId: row.plugin_id,
          namespace: row.namespace,
          version: row.version,
          migrationId: row.migration_id,
          checksumSha256: row.checksum_sha256,
        });
      }
    }
  }

  const tablesNeedingColumns = new Set<string>();
  for (const migration of migrations) {
    for (const colReq of migration.requirements.addedColumns) {
      if (tables.has(colReq.table)) {
        tablesNeedingColumns.add(colReq.table);
      }
    }
  }

  const columnsByTable = new Map<string, Set<string>>();
  const orderedColumnTables = [...tablesNeedingColumns].sort((a, b) => a.localeCompare(b));
  if (orderedColumnTables.length > 0) {
    const pragmaSql = orderedColumnTables.map((table) => `PRAGMA table_info(${table});`).join(' ');
    const pragmaStatements = await executeD1Command(ctx, pragmaSql);
    for (const [idx, table] of orderedColumnTables.entries()) {
      const colSet = new Set<string>();
      for (const row of pragmaStatements[idx]?.results ?? []) {
        if (typeof row.name === 'string' && row.name.trim().length > 0) {
          colSet.add(row.name.trim());
        }
      }
      columnsByTable.set(table, colSet);
    }
  }

  return {
    tables,
    indexes,
    columnsByTable,
    trackedMigrations,
    ...(pluginLedger ? { pluginLedger } : {}),
  };
}
