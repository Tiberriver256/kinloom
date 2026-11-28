import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RECIPES_INITIAL_MIGRATION_SQL } from '@kinloom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import { CliValidationError, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import { isBuiltInCliCommand } from '../../plugins.js';
import {
  discoverMigrations,
  discoverPluginMigrations,
  parseMigrationSchemaRequirements,
  resolveD1DatabaseBinding,
  resolveMigrationsDir,
  resolvePluginMigrationsDir,
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

interface MockPluginLedgerRow {
  plugin_id: string;
  namespace: string;
  version: number;
  migration_id: string;
  checksum_sha256: string;
  applied_at: string;
}

interface MockD1State {
  tables: Set<string>;
  indexes: Set<string>;
  columnsByTable: Map<string, Set<string>>;
  trackedMigrations: Set<string>;
  pluginLedger?: MockPluginLedgerRow[];
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
      const filePath = args[fileIdx + 1]!;
      if (simulateApply) {
        const sql = fs.readFileSync(filePath, 'utf8');
        applySqlToState(sql);
      }
      return {
        stdout: JSON.stringify([{ success: true, results: [] }]),
        stderr: '',
      };
    }

    const sql = commandIdx !== -1 ? (args[commandIdx + 1] ?? '') : '';
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

    if (sql.includes('FROM plugin_migrations')) {
      const results = (state.pluginLedger ?? []).map((row) => ({ ...row }));
      return {
        stdout: JSON.stringify([{ success: true, results }]),
        stderr: '',
      };
    }

    if (sql.includes('INSERT INTO plugin_migrations')) {
      const match =
        /VALUES\s*\('([^']*)',\s*'([^']*)',\s*(\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/i.exec(sql);
      if (simulateApply && match) {
        state.pluginLedger ??= [];
        state.pluginLedger.push({
          plugin_id: match[1]!,
          namespace: match[2]!,
          version: Number.parseInt(match[3]!, 10),
          migration_id: match[4]!,
          checksum_sha256: match[5]!,
          applied_at: match[6]!,
        });
      }
      return {
        stdout: JSON.stringify([{ success: true, results: [] }]),
        stderr: '',
      };
    }

    if (sql.includes('PRAGMA table_info(')) {
      const matches = [...sql.matchAll(/PRAGMA\s+table_info\(([^)]+)\)/gi)];
      const statements = matches.map((m) => {
        const table = m[1]!.replaceAll(/^["`[]|["`\]]$/g, '').trim();
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
      '0005_page_visit_stats.sql',
      '0006_plugin_migrations.sql',
      '0007_steward_reviews.sql',
      '0008_user_onboarding.sql',
    ]);
    expect(migrations[0]!.requirements.isInitialSchema).toBe(true);
    expect(migrations[0]!.requirements.createdTables).toContain('revisions');
    expect(migrations[1]!.requirements.createdTables).toEqual(['pronunciation_lexicon']);
    expect(migrations[2]!.requirements.onlyAlterAddColumns).toBe(true);
    expect(migrations[2]!.requirements.addedColumns.map((c) => c.column)).toEqual([
      'source_url',
      'source_label',
      'region',
      'variants_json',
    ]);
    expect(migrations[3]!.requirements.createdTables).toEqual(['plugin_settings', 'plugin_setting_secrets']);
    expect(migrations[4]!.requirements.createdTables).toEqual([
      'page_visit_daily',
      'observability_cache_daily',
    ]);
    expect(migrations[5]!.requirements.createdTables).toEqual(['plugin_migrations']);
    expect(migrations[6]!.requirements.createdTables).toEqual(['steward_reviews']);
    expect(migrations[7]!.requirements.createdTables).toEqual(['user_onboarding_state']);
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
    expect(result.applied[0]!.satisfiedBy).toBe('schema');
    expect(result.pending.map((m) => m.id)).toEqual([
      '0002_pronunciations.sql',
      '0003_pronunciation_provenance.sql',
      '0004_plugin_settings.sql',
      '0005_page_visit_stats.sql',
      '0006_plugin_migrations.sql',
      '0007_steward_reviews.sql',
      '0008_user_onboarding.sql',
    ]);
    expect(calls.every((c) => !c.args.includes('--file'))).toBe(true);
    expect(calls.every((c) => c.args.includes('--remote'))).toBe(true);
    expect(result.rendered).toContain('0001_initial.sql (schema)');
    expect(result.rendered).toContain('0002_pronunciations.sql');
    expect(result.rendered).toContain('0003_pronunciation_provenance.sql');
    expect(result.rendered).toContain('0004_plugin_settings.sql');
    expect(result.rendered).toContain('0005_page_visit_stats.sql');
    expect(result.rendered).toContain('0006_plugin_migrations.sql');
    expect(result.rendered).toContain('0007_steward_reviews.sql');
    expect(result.rendered).toContain('0008_user_onboarding.sql');
    expect(result.pluginMigrationsDir).toBeUndefined();
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
      '0005_page_visit_stats.sql',
      '0006_plugin_migrations.sql',
      '0007_steward_reviews.sql',
      '0008_user_onboarding.sql',
    ]);
    expect(first.applied.map((m) => [m.id, m.satisfiedBy])).toEqual([
      ['0001_initial.sql', 'schema'],
      ['0002_pronunciations.sql', 'applied_now'],
      ['0003_pronunciation_provenance.sql', 'applied_now'],
      ['0004_plugin_settings.sql', 'applied_now'],
      ['0005_page_visit_stats.sql', 'applied_now'],
      ['0006_plugin_migrations.sql', 'applied_now'],
      ['0007_steward_reviews.sql', 'applied_now'],
      ['0008_user_onboarding.sql', 'applied_now'],
    ]);

    const fileExecs = calls.filter((c) => c.args.includes('--file'));
    expect(fileExecs).toHaveLength(7);
    expect(path.basename(fileExecs[0]!.args[fileExecs[0]!.args.indexOf('--file') + 1]!)).toBe(
      '0002_pronunciations.sql'
    );
    expect(path.basename(fileExecs[1]!.args[fileExecs[1]!.args.indexOf('--file') + 1]!)).toBe(
      '0003_pronunciation_provenance.sql'
    );
    expect(path.basename(fileExecs[2]!.args[fileExecs[2]!.args.indexOf('--file') + 1]!)).toBe(
      '0004_plugin_settings.sql'
    );
    expect(path.basename(fileExecs[3]!.args[fileExecs[3]!.args.indexOf('--file') + 1]!)).toBe(
      '0005_page_visit_stats.sql'
    );
    expect(path.basename(fileExecs[4]!.args[fileExecs[4]!.args.indexOf('--file') + 1]!)).toBe(
      '0006_plugin_migrations.sql'
    );
    expect(path.basename(fileExecs[5]!.args[fileExecs[5]!.args.indexOf('--file') + 1]!)).toBe(
      '0007_steward_reviews.sql'
    );
    expect(path.basename(fileExecs[6]!.args[fileExecs[6]!.args.indexOf('--file') + 1]!)).toBe(
      '0008_user_onboarding.sql'
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
    expect(second.applied).toHaveLength(8);
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
      tables: new Set([
        'revisions',
        'pronunciation_lexicon',
        'plugin_settings',
        'plugin_setting_secrets',
        'page_visit_daily',
        'observability_cache_daily',
        'plugin_migrations',
        'steward_reviews',
        'user_onboarding_state',
      ]),
      indexes: new Set([
        'idx_plugin_setting_secrets_plugin_id',
        'idx_page_visit_daily_day_utc',
        'idx_page_visit_daily_kind_day',
        'idx_plugin_migrations_namespace',
        'idx_steward_reviews_reviewed_at',
      ]),
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
      (c) => c.args.includes('--command') && c.args[c.args.indexOf('--command') + 1]!.includes('ALTER TABLE')
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
    expect(failedResult.pending[0]!.missingObjects).toEqual([
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

  it('discovers, validates, applies idempotently, and detects checksum drift for namespaced plugin migrations', async () => {
    const repoDir = createTempDir('kinloom-migrate-plugins-');
    fs.writeFileSync(
      path.join(repoDir, 'wrangler.jsonc'),
      JSON.stringify({ d1_databases: [{ binding: 'DB', database_name: 'recipes-archive-db' }] }),
      'utf8'
    );
    const recipesMigrationsDir = path.join(repoDir, 'migrations', 'plugins', 'recipes');
    fs.mkdirSync(recipesMigrationsDir, { recursive: true });
    const recipeSqlPath = path.join(recipesMigrationsDir, '0001_recipes_initial.sql');
    fs.writeFileSync(recipeSqlPath, RECIPES_INITIAL_MIGRATION_SQL, 'utf8');

    expect(resolvePluginMigrationsDir(repoDir)).toBe(path.join(repoDir, 'migrations', 'plugins'));
    const discovered = await discoverPluginMigrations(path.join(repoDir, 'migrations', 'plugins'));
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      pluginId: 'kinloom-recipes',
      namespace: 'recipes',
      version: 1,
      migrationId: '0001_recipes_initial',
    });

    const state: MockD1State = {
      tables: new Set([
        'revisions',
        'pronunciation_lexicon',
        'plugin_settings',
        'plugin_setting_secrets',
        'page_visit_daily',
        'observability_cache_daily',
        'steward_reviews',
        'user_onboarding_state',
      ]),
      indexes: new Set([
        'idx_plugin_setting_secrets_plugin_id',
        'idx_page_visit_daily_day_utc',
        'idx_page_visit_daily_kind_day',
        'idx_steward_reviews_reviewed_at',
      ]),
      columnsByTable: new Map([
        ['pronunciation_lexicon', new Set(['source_url', 'source_label', 'region', 'variants_json'])],
      ]),
      trackedMigrations: new Set(),
      pluginLedger: [],
    };
    const { executor, calls } = createMockD1Executor(state);

    // Dry-run reports pending 0006 + recipes/0001_recipes_initial without executing writes.
    const dry = await runMigrateCommand({
      repoDir,
      target: 'local',
      dryRun: true,
      execWrangler: executor,
    });
    expect(dry.ok).toBe(true);
    expect(dry.verified).toBe(false);
    expect(dry.pending.map((m) => m.id)).toEqual(['0006_plugin_migrations.sql']);
    expect(dry.pluginPending?.map((p) => p.migrationId)).toEqual(['0001_recipes_initial']);
    expect(dry.rendered).toContain('Plugin pending:');
    expect(dry.rendered).toContain('recipes/0001_recipes_initial');

    // Live run executes 0006 first, then recipes plugin SQL + plugin_migrations ledger insert.
    const live = await runMigrateCommand({
      repoDir,
      target: 'local',
      dryRun: false,
      execWrangler: executor,
    });
    expect(live.ok).toBe(true);
    expect(live.verified).toBe(true);
    expect(live.executed).toEqual(['0006_plugin_migrations.sql']);
    expect(live.pluginExecuted).toEqual(['recipes/0001_recipes_initial']);
    expect(live.pluginApplied?.[0]?.satisfiedBy).toBe('applied_now');
    expect(live.rendered).toContain('Plugin applied:');

    // Second live run is strictly idempotent with zero file executions.
    const beforeSecond = calls.length;
    const second = await runMigrateCommand({
      repoDir,
      target: 'local',
      dryRun: false,
      execWrangler: executor,
    });
    expect(second.ok).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.executed).toEqual([]);
    expect(second.pluginExecuted).toEqual([]);
    expect(second.pluginApplied?.[0]?.satisfiedBy).toBe('plugin_migrations');
    expect(calls.slice(beforeSecond).every((c) => !c.args.includes('--file'))).toBe(true);

    // Mutating the applied SQL file triggers checksum drift error before any write.
    fs.writeFileSync(
      recipeSqlPath,
      `${RECIPES_INITIAL_MIGRATION_SQL}\nCREATE TABLE IF NOT EXISTS plugin_recipes_extra (id TEXT PRIMARY KEY);\n`,
      'utf8'
    );
    await expect(
      runMigrateCommand({
        repoDir,
        target: 'local',
        dryRun: false,
        execWrangler: executor,
      })
    ).rejects.toThrow(/checksum or identity mismatch/);

    // Invalid core-table DDL in an explicit --plugin-migrations directory is rejected before any D1 call.
    const badPluginDir = path.join(repoDir, 'bad-plugins');
    fs.mkdirSync(path.join(badPluginDir, 'evil'), { recursive: true });
    fs.writeFileSync(
      path.join(badPluginDir, 'evil', '0001_bad.sql'),
      'ALTER TABLE users ADD COLUMN evil TEXT;\n',
      'utf8'
    );
    await expect(
      runMigrateCommand({
        repoDir,
        target: 'local',
        pluginMigrationsDir: badPluginDir,
        execWrangler: executor,
      })
    ).rejects.toBeInstanceOf(CliValidationError);

    expect(() => resolvePluginMigrationsDir(repoDir, 'does-not-exist')).toThrow(CliValidationError);
    await expect(discoverPluginMigrations(path.join(repoDir, 'missing-dir'))).rejects.toBeInstanceOf(
      CliValidationError
    );

    // Custom plugin_id header comment, empty namespace folder, invalid namespace name, and invalid filename
    const customDir = path.join(repoDir, 'custom-plugins');
    fs.mkdirSync(path.join(customDir, 'empty_ns'), { recursive: true });
    fs.mkdirSync(path.join(customDir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(customDir, 'notes', '0001_notes_init.sql'),
      '-- plugin_id: custom-notes-plugin\nCREATE TABLE IF NOT EXISTS plugin_notes_entries (id TEXT PRIMARY KEY);\n',
      'utf8'
    );
    const customDiscovered = await discoverPluginMigrations(customDir);
    expect(customDiscovered).toHaveLength(1);
    expect(customDiscovered[0]!.pluginId).toBe('custom-notes-plugin');

    const invalidNameDir = path.join(repoDir, 'invalid-file-plugins');
    fs.mkdirSync(path.join(invalidNameDir, 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(invalidNameDir, 'notes', 'bad_filename.sql'),
      'CREATE TABLE IF NOT EXISTS plugin_notes_entries (id TEXT PRIMARY KEY);\n',
      'utf8'
    );
    await expect(discoverPluginMigrations(invalidNameDir)).rejects.toBeInstanceOf(CliValidationError);

    const invalidNsDir = path.join(repoDir, 'invalid-ns-plugins');
    fs.mkdirSync(path.join(invalidNsDir, 'BAD-NS'), { recursive: true });
    await expect(discoverPluginMigrations(invalidNsDir)).rejects.toBeInstanceOf(CliValidationError);
  });
});
