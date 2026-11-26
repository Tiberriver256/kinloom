import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CliValidationError } from '../../errors.js';
import {
  stripJsoncCommentsAndTrailingCommas,
  type WranglerExecOptions,
  type WranglerExecutor,
} from './sync.js';

const execFileAsync = promisify(execFile);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_FILE_RE = /^(\d+)_.*\.sql$/i;

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

export interface D1SchemaSnapshot {
  readonly tables: ReadonlySet<string>;
  readonly indexes: ReadonlySet<string>;
  readonly columnsByTable: ReadonlyMap<string, ReadonlySet<string>>;
  readonly trackedMigrations: ReadonlySet<string>;
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
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unquoteSqlIdent(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('`') && trimmed.endsWith('`')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function stripSqlComments(sql: string): string {
  let out = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inSingle) {
      out += ch;
      if (ch === "'" && next === "'") {
        out += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      out += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i += 1;
      }
      if (i < sql.length) {
        out += '\n';
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 1;
      continue;
    }

    out += ch;
  }

  return out;
}

function splitSqlStatements(sql: string): string[] {
  const cleaned = stripSqlComments(sql);
  const statements: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inSingle) {
      current += ch;
      if (ch === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (ch === "'") {
        inSingle = false;
      }
      continue;
    }

    if (inDouble) {
      current += ch;
      if (ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(`${trimmed};`);
      }
      current = '';
      continue;
    }

    current += ch;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(`${trailing};`);
  }

  return statements;
}

export function parseMigrationSchemaRequirements(
  sql: string,
  migrationNumber = 0
): MigrationSchemaRequirements {
  const statements = splitSqlStatements(sql);
  const createdTables: string[] = [];
  const addedColumns: MigrationColumnRequirement[] = [];
  const createdIndexes: string[] = [];
  let nonAlterStatements = 0;

  for (const stmt of statements) {
    const createTableMatch =
      /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
        stmt
      );
    if (createTableMatch) {
      const name = unquoteSqlIdent(
        createTableMatch[1] ??
          createTableMatch[2] ??
          createTableMatch[3] ??
          createTableMatch[4] ??
          ''
      );
      if (name && !createdTables.includes(name)) {
        createdTables.push(name);
      }
      nonAlterStatements += 1;
      continue;
    }

    const createIndexMatch =
      /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
        stmt
      );
    if (createIndexMatch) {
      const name = unquoteSqlIdent(
        createIndexMatch[1] ??
          createIndexMatch[2] ??
          createIndexMatch[3] ??
          createIndexMatch[4] ??
          ''
      );
      if (name && !createdIndexes.includes(name)) {
        createdIndexes.push(name);
      }
      nonAlterStatements += 1;
      continue;
    }

    const alterAddColMatch =
      /^ALTER\s+TABLE\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))\s+ADD\s+(?:COLUMN\s+)?(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_]*))/i.exec(
        stmt
      );
    if (alterAddColMatch) {
      const table = unquoteSqlIdent(
        alterAddColMatch[1] ??
          alterAddColMatch[2] ??
          alterAddColMatch[3] ??
          alterAddColMatch[4] ??
          ''
      );
      const column = unquoteSqlIdent(
        alterAddColMatch[5] ??
          alterAddColMatch[6] ??
          alterAddColMatch[7] ??
          alterAddColMatch[8] ??
          ''
      );
      if (table && column) {
        addedColumns.push({ table, column, statement: stmt });
      }
      continue;
    }

    nonAlterStatements += 1;
  }

  return {
    createdTables,
    addedColumns,
    createdIndexes,
    isInitialSchema: migrationNumber === 1 && createdTables.includes('revisions'),
    onlyAlterAddColumns: addedColumns.length > 0 && nonAlterStatements === 0,
  };
}

function parseWranglerTomlD1Binding(raw: string): {
  dbName: string;
  migrationsDirHint?: string;
} {
  let inD1Section = false;
  let dbName = '';
  let migrationsDirHint: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) {
      continue;
    }
    if (line.startsWith('[')) {
      if (inD1Section && dbName) {
        break;
      }
      inD1Section = /^\[\[\s*d1_databases\s*\]\]$/.test(line);
      continue;
    }
    if (!inD1Section) {
      continue;
    }
    const dbMatch = /^database_name\s*=\s*(?:"([^"]+)"|'([^']+)')$/.exec(line);
    if (dbMatch) {
      dbName = (dbMatch[1] ?? dbMatch[2] ?? '').trim();
      continue;
    }
    const dirMatch = /^migrations_dir\s*=\s*(?:"([^"]+)"|'([^']+)')$/.exec(line);
    if (dirMatch) {
      const value = (dirMatch[1] ?? dirMatch[2] ?? '').trim();
      if (value) {
        migrationsDirHint = value;
      }
    }
  }

  return { dbName, migrationsDirHint };
}

export function resolveD1DatabaseBinding(repoDir: string): D1DatabaseBinding {
  const resolvedRepo = path.resolve(repoDir);
  const candidates = [
    path.join(resolvedRepo, 'wrangler.jsonc'),
    path.join(resolvedRepo, 'wrangler.json'),
    path.join(resolvedRepo, 'wrangler.toml'),
  ];
  const configPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!configPath) {
    throw new CliValidationError(
      `Missing wrangler.jsonc, wrangler.json, or wrangler.toml under ${resolvedRepo}.`
    );
  }

  const raw = fs.readFileSync(configPath, 'utf8');

  if (configPath.endsWith('.toml')) {
    const parsed = parseWranglerTomlD1Binding(raw);
    if (!parsed.dbName) {
      throw new CliValidationError(
        `Could not read [[d1_databases]] database_name from ${configPath}.`
      );
    }
    return {
      configPath,
      dbName: parsed.dbName,
      migrationsDirHint: parsed.migrationsDirHint,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsoncCommentsAndTrailingCommas(raw));
  } catch (err: unknown) {
    throw new CliValidationError(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new CliValidationError(`Expected a JSON object in ${configPath}.`);
  }

  const d1List = Array.isArray(parsed.d1_databases) ? parsed.d1_databases : [];
  const firstD1 = isPlainRecord(d1List[0]) ? d1List[0] : null;
  const dbName = typeof firstD1?.database_name === 'string' ? firstD1.database_name.trim() : '';
  const migrationsDirHint =
    typeof firstD1?.migrations_dir === 'string' && firstD1.migrations_dir.trim().length > 0
      ? firstD1.migrations_dir.trim()
      : undefined;

  if (!dbName) {
    throw new CliValidationError(`Could not read d1_databases[0].database_name from ${configPath}.`);
  }

  return {
    configPath,
    dbName,
    migrationsDirHint,
  };
}

function hasNumberedMigrations(dirPath: string): boolean {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return false;
    }
    return fs.readdirSync(dirPath).some((entry) => MIGRATION_FILE_RE.test(entry));
  } catch {
    return false;
  }
}

export function resolveMigrationsDir(repoDir: string, explicitMigrationsDir?: string): string {
  if (explicitMigrationsDir && explicitMigrationsDir.trim().length > 0) {
    const resolved = path.resolve(repoDir, explicitMigrationsDir.trim());
    if (!hasNumberedMigrations(resolved)) {
      throw new CliValidationError(
        `No numbered SQL migrations (NNNN_*.sql) found under ${resolved}.`
      );
    }
    return resolved;
  }

  const resolvedRepo = path.resolve(repoDir);
  const searchOrder = [
    path.join(resolvedRepo, 'node_modules', '@kinloom', 'worker', 'migrations'),
    path.resolve(MODULE_DIR, '../../../../worker/migrations'),
    path.resolve(MODULE_DIR, '../../../migrations'),
    path.resolve(MODULE_DIR, '../../../../migrations'),
  ];

  for (const candidate of searchOrder) {
    if (hasNumberedMigrations(candidate)) {
      return candidate;
    }
  }

  throw new CliValidationError(
    `Could not locate bundled @kinloom/worker migrations directory (checked ${searchOrder.join(', ')}).`
  );
}

export function discoverMigrations(migrationsDir: string): DiscoveredMigration[] {
  if (!fs.existsSync(migrationsDir) || !fs.statSync(migrationsDir).isDirectory()) {
    throw new CliValidationError(`Migrations directory not found: ${migrationsDir}`);
  }

  const entries: DiscoveredMigration[] = [];
  for (const fileName of fs.readdirSync(migrationsDir)) {
    const match = MIGRATION_FILE_RE.exec(fileName);
    if (!match) {
      continue;
    }
    const number = Number.parseInt(match[1], 10);
    const filePath = path.join(migrationsDir, fileName);
    if (!fs.statSync(filePath).isFile()) {
      continue;
    }
    const sql = fs.readFileSync(filePath, 'utf8');
    entries.push({
      id: fileName,
      number,
      filePath,
      sql,
      requirements: parseMigrationSchemaRequirements(sql, number),
    });
  }

  entries.sort((a, b) => {
    if (a.number !== b.number) {
      return a.number - b.number;
    }
    return a.id.localeCompare(b.id);
  });

  if (entries.length === 0) {
    throw new CliValidationError(
      `No numbered SQL migrations (NNNN_*.sql) found under ${migrationsDir}.`
    );
  }

  return entries;
}

function resolveWranglerBin(repoDir: string, explicitBin?: string): string {
  if (explicitBin && explicitBin.trim().length > 0) {
    return explicitBin.trim();
  }
  const localBin = path.join(repoDir, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'wrangler';
}

const defaultWranglerExecutor: WranglerExecutor = async (
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

interface D1StatementResult {
  readonly success: boolean;
  readonly results: readonly Record<string, unknown>[];
}

interface MigrateExecContext {
  readonly repoDir: string;
  readonly binding: D1DatabaseBinding;
  readonly target: MigrateTarget;
  readonly wranglerBin: string;
  readonly execWrangler: WranglerExecutor;
}

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

async function executeD1Command(
  ctx: MigrateExecContext,
  sql: string
): Promise<D1StatementResult[]> {
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

async function executeD1File(
  ctx: MigrateExecContext,
  filePath: string
): Promise<D1StatementResult[]> {
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

async function inspectD1Schema(
  ctx: MigrateExecContext,
  migrations: readonly DiscoveredMigration[]
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
    const pragmaSql = orderedColumnTables
      .map((table) => `PRAGMA table_info(${table});`)
      .join(' ');
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
  };
}

export function evaluateMigrationStatus(
  migration: DiscoveredMigration,
  snapshot: D1SchemaSnapshot,
  justExecutedIds?: ReadonlySet<string>
): MigrationStatusEntry {
  const { requirements } = migration;
  const missingObjects: string[] = [];

  if (requirements.isInitialSchema) {
    if (!snapshot.tables.has('revisions')) {
      for (const table of requirements.createdTables) {
        if (!snapshot.tables.has(table)) {
          missingObjects.push(`table:${table}`);
        }
      }
    }
  } else {
    for (const table of requirements.createdTables) {
      if (!snapshot.tables.has(table)) {
        missingObjects.push(`table:${table}`);
      }
    }
    for (const colReq of requirements.addedColumns) {
      const tableCols = snapshot.columnsByTable.get(colReq.table);
      if (!snapshot.tables.has(colReq.table) || !tableCols?.has(colReq.column)) {
        missingObjects.push(`column:${colReq.table}.${colReq.column}`);
      }
    }
    for (const index of requirements.createdIndexes) {
      if (!snapshot.indexes.has(index)) {
        missingObjects.push(`index:${index}`);
      }
    }

    const hasSchemaAssertions =
      requirements.createdTables.length > 0 ||
      requirements.addedColumns.length > 0 ||
      requirements.createdIndexes.length > 0;
    if (!hasSchemaAssertions && !snapshot.trackedMigrations.has(migration.id)) {
      missingObjects.push(`migration:${migration.id}`);
    }
  }

  if (missingObjects.length === 0) {
    const satisfiedBy = justExecutedIds?.has(migration.id)
      ? 'applied_now'
      : snapshot.trackedMigrations.has(migration.id)
        ? 'd1_migrations'
        : 'schema';
    return {
      id: migration.id,
      number: migration.number,
      filePath: migration.filePath,
      status: 'applied',
      satisfiedBy,
      missingObjects: [],
    };
  }

  return {
    id: migration.id,
    number: migration.number,
    filePath: migration.filePath,
    status: 'pending',
    satisfiedBy: 'pending',
    missingObjects,
  };
}

function buildMissingAlterStatements(
  migration: DiscoveredMigration,
  snapshot: D1SchemaSnapshot
): string[] | null {
  if (!migration.requirements.onlyAlterAddColumns) {
    return null;
  }
  const existingCols = migration.requirements.addedColumns.filter((colReq) =>
    snapshot.columnsByTable.get(colReq.table)?.has(colReq.column)
  );
  if (existingCols.length === 0) {
    return null;
  }
  return migration.requirements.addedColumns
    .filter((colReq) => !snapshot.columnsByTable.get(colReq.table)?.has(colReq.column))
    .map((colReq) => colReq.statement);
}

export function formatMigrateReport(
  result: Omit<MigrateCommandResult, 'rendered'>
): string {
  const lines: string[] = [];
  const modeLabel = result.dryRun ? 'dry-run' : 'live';
  lines.push(
    `Kinloom D1 migrate (${modeLabel}, --${result.target}): ${result.dbName}`
  );
  lines.push(`Config: ${result.configPath}`);
  lines.push(`Migrations: ${result.migrationsDir}`);
  lines.push(
    `Summary: ${result.applied.length} applied, ${result.pending.length} pending, ${result.executed.length} executed`
  );

  if (result.applied.length > 0) {
    lines.push('Applied:');
    for (const item of result.applied) {
      lines.push(`  [ok] ${item.id} (${item.satisfiedBy})`);
    }
  }

  if (result.pending.length > 0) {
    lines.push('Pending:');
    for (const item of result.pending) {
      const detail =
        item.missingObjects.length > 0 ? ` missing ${item.missingObjects.join(', ')}` : '';
      lines.push(`  [pending] ${item.id}${detail}`);
    }
  } else if (result.dryRun) {
    lines.push('All migrations are already satisfied. No writes needed.');
  } else if (result.verified) {
    lines.push('Post-migration schema verification passed.');
  }

  return lines.join('\n');
}

export async function runMigrateCommand(
  options: MigrateCommandOptions = {}
): Promise<MigrateCommandResult> {
  const repoDir = path.resolve(options.repoDir ?? process.cwd());
  const target: MigrateTarget = options.target ?? 'remote';
  const dryRun = Boolean(options.dryRun);
  const binding = resolveD1DatabaseBinding(repoDir);
  const migrationsDir = resolveMigrationsDir(repoDir, options.migrationsDir);
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
  const afterEntries = migrations.map((m) =>
    evaluateMigrationStatus(m, afterSnapshot, executedSet)
  );
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
