import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliValidationError } from '../../../errors.js';
import { stripJsoncCommentsAndTrailingCommas } from '../sync.js';
import { parseMigrationSchemaRequirements } from './sqlParser.js';
import { type D1DatabaseBinding, type DiscoveredMigration, isPlainRecord } from './types.js';

const OPS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_FILE_RE = /^(\d+)_.*\.sql$/i;

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
      throw new CliValidationError(`Could not read [[d1_databases]] database_name from ${configPath}.`);
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

export function resolveMigrationsDir(
  repoDir: string,
  explicitMigrationsDir?: string,
  migrationsDirHint?: string
): string {
  if (explicitMigrationsDir && explicitMigrationsDir.trim().length > 0) {
    const resolved = path.resolve(repoDir, explicitMigrationsDir.trim());
    if (!hasNumberedMigrations(resolved)) {
      throw new CliValidationError(`No numbered SQL migrations (NNNN_*.sql) found under ${resolved}.`);
    }
    return resolved;
  }

  const resolvedRepo = path.resolve(repoDir);
  const searchOrder = [
    ...(migrationsDirHint && migrationsDirHint.trim().length > 0
      ? [path.resolve(resolvedRepo, migrationsDirHint.trim())]
      : []),
    path.join(resolvedRepo, 'node_modules', '@kinloom', 'worker', 'migrations'),
    path.resolve(OPS_DIR, '../../../../worker/migrations'),
    path.resolve(OPS_DIR, '../../../migrations'),
    path.resolve(OPS_DIR, '../../../../migrations'),
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
    throw new CliValidationError(`No numbered SQL migrations (NNNN_*.sql) found under ${migrationsDir}.`);
  }

  return entries;
}

export function resolveWranglerBin(repoDir: string, explicitBin?: string): string {
  if (explicitBin && explicitBin.trim().length > 0) {
    return explicitBin.trim();
  }
  const localBin = path.join(repoDir, 'node_modules', '.bin', 'wrangler');
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  return 'wrangler';
}
