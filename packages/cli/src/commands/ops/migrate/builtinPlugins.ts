import fs from 'node:fs';
import path from 'node:path';
import type { PluginSqlMigration } from '@kinloom/core';
import {
  BOOK_PUBLISHING_DATABASE_NAMESPACE,
  BOOK_PUBLISHING_PLUGIN_ID,
  BOOK_PUBLISHING_PLUGIN_MIGRATIONS,
  computeMigrationChecksum,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_PLUGIN_ID,
  RECIPES_PLUGIN_MIGRATIONS,
  validatePluginMigrations,
} from '@kinloom/server';
import { parse as parseYaml } from 'yaml';
import { pluginMigrationLedgerKey } from './pluginMigrations.js';
import { parseMigrationSchemaRequirements } from './sqlParser.js';
import { type DiscoveredPluginMigration, isPlainRecord } from './types.js';

export interface BuiltInServerPluginMigrationSpec {
  readonly pluginId: string;
  readonly namespace: string;
  readonly aliases: readonly string[];
  readonly workerFactoryNames: readonly string[];
  readonly migrations: readonly PluginSqlMigration[];
}

export const BUILTIN_SERVER_PLUGIN_MIGRATIONS: readonly BuiltInServerPluginMigrationSpec[] = [
  {
    pluginId: BOOK_PUBLISHING_PLUGIN_ID,
    namespace: BOOK_PUBLISHING_DATABASE_NAMESPACE,
    aliases: [
      'book-publishing',
      'book_publishing',
      'bookpublishing',
      BOOK_PUBLISHING_PLUGIN_ID,
      '@kinloom/book-publishing',
    ],
    workerFactoryNames: ['createBookPublishingServerPlugin'],
    migrations: BOOK_PUBLISHING_PLUGIN_MIGRATIONS,
  },
  {
    pluginId: RECIPES_PLUGIN_ID,
    namespace: RECIPES_DATABASE_NAMESPACE,
    aliases: ['recipes', RECIPES_PLUGIN_ID, '@kinloom/recipes'],
    workerFactoryNames: ['createRecipesServerPlugin'],
    migrations: RECIPES_PLUGIN_MIGRATIONS,
  },
];

const SPEC_BY_ALIAS = new Map<string, BuiltInServerPluginMigrationSpec>();
for (const spec of BUILTIN_SERVER_PLUGIN_MIGRATIONS) {
  for (const alias of [spec.pluginId, spec.namespace, ...spec.aliases]) {
    SPEC_BY_ALIAS.set(alias.trim().toLowerCase(), spec);
  }
}

const WORKER_ENTRY_CANDIDATES = ['src/worker.ts', 'src/index.ts', 'worker.ts'] as const;
const CONFIG_YAML_CANDIDATES = ['kinloom.config.yaml', path.join('data', 'kinloom.config.yaml')] as const;

function resolveSpecByAlias(rawName: string): BuiltInServerPluginMigrationSpec | undefined {
  return SPEC_BY_ALIAS.get(rawName.trim().toLowerCase());
}

function isExistingFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

/**
 * Strips single-line (`//`) and block (`/* ... *\/`) comments from TypeScript source
 * while preserving quoted string and template literal contents.
 */
function stripTypeScriptComments(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && source.charAt(i) !== '\n') {
        i += 1;
      }
      if (i < len) {
        out += '\n';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) {
        if (source.charAt(i) === '\n') {
          out += '\n';
        }
        i += 1;
      }
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < len) {
        const current = source.charAt(i);
        if (current === '\\') {
          out += current + source.charAt(i + 1);
          i += 2;
          continue;
        }
        out += current;
        i += 1;
        if (current === quote) {
          break;
        }
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

function extractCallArguments(code: string, openParenIndex: number): string {
  let depth = 0;
  let i = openParenIndex;
  const len = code.length;
  const start = openParenIndex + 1;

  while (i < len) {
    const ch = code.charAt(i);
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < len) {
        if (code.charAt(i) === '\\') {
          i += 2;
          continue;
        }
        if (code.charAt(i) === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(start, i);
      }
    }
    i += 1;
  }

  return code.slice(start);
}

function detectBuiltInPluginsFromConfigYaml(
  repoDir: string,
  matched: Map<string, BuiltInServerPluginMigrationSpec>
): void {
  for (const relPath of CONFIG_YAML_CANDIDATES) {
    const configPath = path.join(repoDir, relPath);
    if (!isExistingFile(configPath)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(fs.readFileSync(configPath, 'utf8'));
    } catch {
      continue;
    }
    if (!isPlainRecord(parsed)) {
      continue;
    }
    const pluginsField = parsed['plugins'];
    if (Array.isArray(pluginsField)) {
      for (const entry of pluginsField) {
        if (typeof entry === 'string') {
          const spec = resolveSpecByAlias(entry);
          if (spec) {
            matched.set(spec.pluginId, spec);
          }
        } else if (isPlainRecord(entry) && entry['enabled'] !== false) {
          const idCandidate =
            typeof entry['id'] === 'string'
              ? entry['id']
              : typeof entry['name'] === 'string'
                ? entry['name']
                : '';
          const spec = resolveSpecByAlias(idCandidate);
          if (spec) {
            matched.set(spec.pluginId, spec);
          }
        }
      }
    } else if (isPlainRecord(pluginsField)) {
      for (const [key, value] of Object.entries(pluginsField)) {
        const spec = resolveSpecByAlias(key);
        if (!spec) {
          continue;
        }
        if (value === true || (isPlainRecord(value) && value['enabled'] !== false)) {
          matched.set(spec.pluginId, spec);
        }
      }
    }
  }
}

function detectBuiltInPluginsFromWorkerSources(
  repoDir: string,
  matched: Map<string, BuiltInServerPluginMigrationSpec>
): void {
  for (const relPath of WORKER_ENTRY_CANDIDATES) {
    const workerPath = path.join(repoDir, relPath);
    if (!isExistingFile(workerPath)) {
      continue;
    }
    const stripped = stripTypeScriptComments(fs.readFileSync(workerPath, 'utf8'));
    for (const spec of BUILTIN_SERVER_PLUGIN_MIGRATIONS) {
      for (const factoryName of spec.workerFactoryNames) {
        const callRe = new RegExp(`\\b${factoryName}\\s*\\(`, 'g');
        let callMatch: RegExpExecArray | null;
        while ((callMatch = callRe.exec(stripped)) !== null) {
          const openParenIndex = callMatch.index + callMatch[0].length - 1;
          const argsText = extractCallArguments(stripped, openParenIndex);
          if (!/\benabled\s*:\s*false\b/.test(argsText)) {
            matched.set(spec.pluginId, spec);
            break;
          }
        }
      }
    }
  }
}

/**
 * Auto-discovers enabled built-in `@kinloom/server` plugins that declare SQL migrations
 * from `<repo>/kinloom.config.yaml` (or `data/kinloom.config.yaml`) and/or worker entry
 * files (`src/worker.ts`, `src/index.ts`, `worker.ts`).
 */
export function detectEnabledBuiltInPlugins(repoDir: string): readonly BuiltInServerPluginMigrationSpec[] {
  const resolvedRepo = path.resolve(repoDir);
  const matched = new Map<string, BuiltInServerPluginMigrationSpec>();

  detectBuiltInPluginsFromConfigYaml(resolvedRepo, matched);
  detectBuiltInPluginsFromWorkerSources(resolvedRepo, matched);

  return [...matched.values()].sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

export async function discoverBuiltInPluginMigrations(repoDir: string): Promise<{
  readonly enabledPlugins: readonly string[];
  readonly migrations: readonly DiscoveredPluginMigration[];
}> {
  const specs = detectEnabledBuiltInPlugins(repoDir);
  if (specs.length === 0) {
    return { enabledPlugins: [], migrations: [] };
  }

  const discovered: DiscoveredPluginMigration[] = [];
  for (const spec of specs) {
    validatePluginMigrations({
      id: spec.pluginId,
      databaseNamespace: spec.namespace,
      migrations: spec.migrations,
    });

    for (const item of spec.migrations) {
      discovered.push({
        pluginId: spec.pluginId,
        namespace: spec.namespace,
        version: item.version,
        migrationId: item.id,
        filePath: `@kinloom/server:${spec.namespace}/${item.id}`,
        sql: item.sql,
        checksumSha256: await computeMigrationChecksum(item.sql),
        requirements: parseMigrationSchemaRequirements(item.sql, item.version),
        source: 'builtin',
      });
    }
  }

  return {
    enabledPlugins: specs.map((spec) => spec.pluginId),
    migrations: discovered,
  };
}

/**
 * Merges filesystem-discovered plugin migrations with built-in `@kinloom/server` plugin migrations.
 * Filesystem migrations take precedence when the same `(pluginId, version)` key is present in both.
 */
export function mergePluginMigrations(
  filesystemMigrations: readonly DiscoveredPluginMigration[],
  builtInMigrations: readonly DiscoveredPluginMigration[]
): DiscoveredPluginMigration[] {
  const merged = new Map<string, DiscoveredPluginMigration>();

  for (const item of filesystemMigrations) {
    merged.set(pluginMigrationLedgerKey(item.pluginId, item.version), item);
  }
  for (const item of builtInMigrations) {
    const key = pluginMigrationLedgerKey(item.pluginId, item.version);
    if (!merged.has(key)) {
      merged.set(key, item);
    }
  }

  return [...merged.values()].sort(
    (a, b) =>
      a.namespace.localeCompare(b.namespace) ||
      a.version - b.version ||
      a.migrationId.localeCompare(b.migrationId)
  );
}
