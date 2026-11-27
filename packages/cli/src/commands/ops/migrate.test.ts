import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import { EXIT_OK, EXIT_USAGE } from '../../errors.js';
import { isBuiltInCliCommand } from '../../plugins.js';
import {
  discoverMigrations,
  parseMigrationSchemaRequirements,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
  runMigrateCommand,
} from './migrate.js';
import type { WranglerExecutor } from './sync.js';

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface MockD1State {
  tables: Set<string>;
  indexes: Set<string>;
  columnsByTable: Map<string, Set<string>>;
  trackedMigrations: Set<string>;
}

function createMockD1Executor(
  state: MockD1State,
  options?: { simulateApply?: boolean }
): {
  executor: WranglerExecutor;
  calls: { bin: string; args: readonly string[] }[];
} {
  const simulateApply = options?.simulateApply ?? true;
  const calls: { bin: string; args: readonly string[] }[] = [];

  const applySqlToState = (sql: string): void => {
    const reqs = parseMigrationSchemaRequirements(sql);
    for (const table of reqs.createdTables) {
      state.tables.add(table);
      if (!state.columnsByTable.has(table)) {
        state.columnsByTable.set(table, new Set());
      }
    }
    for (const index of reqs.createdIndexes) {
      state.indexes.add(index);
    }
    for (const col of reqs.addedColumns) {
      const cols = state.columnsByTable.get(col.table) ?? new Set<string>();
      cols.add(col.column);
      state.columnsByTable.set(col.table, cols);
    }
  };

  const executor: WranglerExecutor = async (bin, args) => {
    calls.push({ bin, args: [...args] });
    const commandIdx = args.indexOf('--command');
    const fileIdx = args.indexOf('--file');

    if (fileIdx !== -1) {
      const filePath = args[fileIdx + 1];
      if (simulateApply) {
        const sql = fs.readFileSync(filePath, 'utf8');
        applySqlToState(sql);
      }
      return {
        stdout: JSON.stringify([{ success: true, results: [] }]),
        stderr: '',
      };
    }

    const sql = commandIdx !== -1 ? args[commandIdx + 1] : '';
    if (sql.includes('FROM sqlite_master')) {
      const results = [
        ...[...state.tables].map((name) => ({ type: 'table', name })),
        ...[...state.indexes].map((name) => ({ type: 'index', name })),
      ];
      return {
        stdout: JSON.stringify([{ success: true, results }]),
        stderr: '',
      };
    }

    if (sql.includes('FROM d1_migrations')) {
      const results = [...state.trackedMigrations].map((name) => ({ name }));
      return {
        stdout: JSON.stringify([{ success: true, results }]),
        stderr: '',
      };
    }

    if (sql.includes('PRAGMA table_info(')) {
      const matches = [...sql.matchAll(/PRAGMA\s+table_info\(([^)]+)\)/gi)];
      const statements = matches.map((m) => {
        const table = m[1].replaceAll(/^["`[]|["`\]]$/g, '').trim();
        const cols = [...(state.columnsByTable.get(table) ?? [])].map((name) => ({ name }));
        return { success: true, results: cols };
      });
      return {
        stdout: JSON.stringify(statements),
        stderr: '',
      };
    }

    if (simulateApply) {
      applySqlToState(sql);
    }
    return {
      stdout: JSON.stringify([{ success: true, results: [] }]),
      stderr: '',
    };
  };

  return { executor, calls };
}

describe('kinloom migrate', () => {
  it('discovers bundled @kinloom/worker migrations in numeric order and extracts schema requirements', () => {
    const repoDir = createTempDir('kinloom-migrate-discover-');
    const migrationsDir = resolveMigrationsDir(repoDir);
    const migrations = discoverMigrations(migrationsDir);

    expect(migrations.map((m) => m.id)).toEqual([
      '0001_initial.sql',
      '0002_pronunciations.sql',
      '0003_pronunciation_provenance.sql',
      '0004_plugin_settings.sql',
    ]);
    expect(migrations[0].requirements.isInitialSchema).toBe(true);
    expect(migrations[0].requirements.createdTables).toContain('revisions');
    expect(migrations[1].requirements.createdTables).toEqual(['pronunciation_lexicon']);
    expect(migrations[2].requirements.onlyAlterAddColumns).toBe(true);
    expect(migrations[2].requirements.addedColumns.map((c) => c.column)).toEqual([
      'source_url',
      'source_label',
      'region',
      'variants_json',
    ]);
    expect(migrations[3].requirements.createdTables).toEqual(['plugin_settings', 'plugin_setting_secrets']);
  });

  it('resolves D1 database binding from wrangler.jsonc, wrangler.json, and wrangler.toml', () => {
    const jsoncDir = createTempDir('kinloom-migrate-jsonc-');
    fs.writeFileSync(
      path.join(jsoncDir, 'wrangler.jsonc'),
      `{
        // Primary archive D1 database
        "name": "example-archive",
        "d1_databases": [
          {
            "binding": "DB",
            "database_name": "example-archive-db",
          },
        ],
      }`,
      'utf8'
    );
    expect(resolveD1DatabaseBinding(jsoncDir).dbName).toBe('example-archive-db');

    const tomlDir = createTempDir('kinloom-migrate-toml-');
    fs.writeFileSync(
      path.join(tomlDir, 'wrangler.toml'),
      `name = "example-archive"

[[d1_databases]]
binding = "DB"
database_name = "example-toml-db" # archive database
`,
      'utf8'
    );
    const tomlBinding = resolveD1DatabaseBinding(tomlDir);
    expect(tomlBinding.dbName).toBe('example-toml-db');
    expect(tomlBinding.configPath).toBe(path.join(tomlDir, 'wrangler.toml'));
  });

  it('reports exact applied vs pending migrations in --dry-run without executing any writes on a legacy DB', async () => {
    const repoDir = createTempDir('kinloom-migrate-dryrun-');
    fs.writeFileSync(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'legacy-archive-db' }] }),
      'utf8'
    );

    const state: MockD1State = {
      tables: new Set(['entities', 'revisions', 'kinship_edges']),
      indexes: new Set(),
      columnsByTable: new Map(),
      trackedMigrations: new Set(),
    };
    const { executor, calls } = createMockD1Executor(state);

    const result = await runMigrateCommand({
      repoDir,
      target: 'remote',
      dryRun: true,
      execWrangler: executor,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.executed).toEqual([]);
    expect(result.applied.map((m) => m.id)).toEqual(['0001_initial.sql']);
    expect(result.applied[0].satisfiedBy).toBe('schema');
    expect(result.pending.map((m) => m.id)).toEqual([
      '0002_pronunciations.sql',
      '0003_pronunciation_provenance.sql',
      '0004_plugin_settings.sql',
    ]);
    expect(calls.every((c) => !c.args.includes('--file'))).toBe(true);
    expect(calls.every((c) => c.args.includes('--remote'))).toBe(true);
    expect(result.rendered).toContain('0001_initial.sql (schema)');
    expect(result.rendered).toContain('0002_pronunciations.sql');
    expect(result.rendered).toContain('0003_pronunciation_provenance.sql');
    expect(result.rendered).toContain('0004_plugin_settings.sql');
  });

  it('applies only pending migrations in numeric order, verifies schema, and is idempotent on re-run', async () => {
    const repoDir = createTempDir('kinloom-migrate-live-');
    fs.writeFileSync(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'hale-archive-db' }] }),
      'utf8'
    );

    const state: MockD1State = {
      tables: new Set(['entities', 'revisions']),
      indexes: new Set(),
      columnsByTable: new Map(),
      trackedMigrations: new Set(),
    };
    const { executor, calls } = createMockD1Executor(state);

    const first = await runMigrateCommand({
      repoDir,
      target: 'remote',
      dryRun: false,
      json: true,
      execWrangler: executor,
    });

    expect(first.ok).toBe(true);
    expect(first.verified).toBe(true);
    expect(first.pending).toEqual([]);
    expect(first.executed).toEqual([
      '0002_pronunciations.sql',
      '0003_pronunciation_provenance.sql',
      '0004_plugin_settings.sql',
    ]);
    expect(first.applied.map((m) => [m.id, m.satisfiedBy])).toEqual([
      ['0001_initial.sql', 'schema'],
      ['0002_pronunciations.sql', 'applied_now'],
      ['0003_pronunciation_provenance.sql', 'applied_now'],
      ['0004_plugin_settings.sql', 'applied_now'],
    ]);

    const fileExecs = calls.filter((c) => c.args.includes('--file'));
    expect(fileExecs).toHaveLength(3);
    expect(path.basename(fileExecs[0].args[fileExecs[0].args.indexOf('--file') + 1])).toBe(
      '0002_pronunciations.sql'
    );
    expect(path.basename(fileExecs[1].args[fileExecs[1].args.indexOf('--file') + 1])).toBe(
      '0003_pronunciation_provenance.sql'
    );
    expect(path.basename(fileExecs[2].args[fileExecs[2].args.indexOf('--file') + 1])).toBe(
      '0004_plugin_settings.sql'
    );

    // Second run converges with zero write executions
    const callCountBeforeSecond = calls.length;
    const second = await runMigrateCommand({
      repoDir,
      target: 'remote',
      dryRun: false,
      execWrangler: executor,
    });
    expect(second.ok).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.executed).toEqual([]);
    expect(second.pending).toEqual([]);
    expect(second.applied).toHaveLength(4);
    const secondCalls = calls.slice(callCountBeforeSecond);
    expect(secondCalls.every((c) => !c.args.includes('--file'))).toBe(true);
  });

  it('converges cleanly from a partially applied ALTER TABLE migration without duplicating existing columns', async () => {
    const repoDir = createTempDir('kinloom-migrate-partial-');
    fs.writeFileSync(
      path.join(repoDir, 'wrangler.toml'),
      '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "local-archive-db"\n',
      'utf8'
    );

    const state: MockD1State = {
      tables: new Set(['revisions', 'pronunciation_lexicon', 'plugin_settings', 'plugin_setting_secrets']),
      indexes: new Set(['idx_plugin_setting_secrets_plugin_id']),
      columnsByTable: new Map([
        ['pronunciation_lexicon', new Set(['term', 'phonetic', 'source_url', 'source_label'])],
      ]),
      trackedMigrations: new Set(),
    };
    const { executor, calls } = createMockD1Executor(state);

    const result = await runMigrateCommand({
      repoDir,
      target: 'local',
      dryRun: false,
      execWrangler: executor,
    });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.executed).toEqual(['0003_pronunciation_provenance.sql']);

    const alterCall = calls.find(
      (c) => c.args.includes('--command') && c.args[c.args.indexOf('--command') + 1].includes('ALTER TABLE')
    );
    expect(alterCall).toBeDefined();
    expect(alterCall?.args).toContain('--local');
    const alterSql = alterCall?.args[alterCall.args.indexOf('--command') + 1] ?? '';
    expect(alterSql).not.toContain('source_url');
    expect(alterSql).not.toContain('source_label');
    expect(alterSql).toContain('region');
    expect(alterSql).toContain('variants_json');
  });

  it('supports future numbered migrations and reports verification failure when schema remains unsatisfied', async () => {
    const repoDir = createTempDir('kinloom-migrate-future-');
    const customMigrationsDir = path.join(repoDir, 'custom-migrations');
    fs.mkdirSync(customMigrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'wrangler.json'),
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'future-db' }] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(customMigrationsDir, '0004_notes_index.sql'),
      'CREATE TABLE IF NOT EXISTS editorial_notes (id TEXT PRIMARY KEY);\nCREATE INDEX IF NOT EXISTS idx_editorial_notes_id ON editorial_notes (id);\n',
      'utf8'
    );

    const state: MockD1State = {
      tables: new Set(),
      indexes: new Set(),
      columnsByTable: new Map(),
      trackedMigrations: new Set(),
    };
    const { executor } = createMockD1Executor(state, { simulateApply: false });

    const failedResult = await runMigrateCommand({
      repoDir,
      target: 'local',
      migrationsDir: customMigrationsDir,
      execWrangler: executor,
    });

    expect(failedResult.ok).toBe(false);
    expect(failedResult.verified).toBe(false);
    expect(failedResult.pending).toHaveLength(1);
    expect(failedResult.pending[0].missingObjects).toEqual([
      'table:editorial_notes',
      'index:idx_editorial_notes_id',
    ]);
  });

  it('wires migrate help, built-in command registration, and mutual-exclusion validation in runCli', async () => {
    expect(isBuiltInCliCommand('migrate')).toBe(true);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line),
    };

    const helpCode = await runCli(['migrate', '--help'], { io });
    expect(helpCode).toBe(EXIT_OK);
    expect(stdout.join('\n')).toContain('Usage: kinloom migrate [options]');
    expect(stdout.join('\n')).toContain('--dry-run');

    stdout.length = 0;
    stderr.length = 0;
    const conflictCode = await runCli(['migrate', '--remote', '--local'], { io });
    expect(conflictCode).toBe(EXIT_USAGE);
    expect(stderr.join('\n')).toContain('either `--remote` or `--local`, not both');
  });
});
