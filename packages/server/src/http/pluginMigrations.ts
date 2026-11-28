import {
  type AppliedPluginMigrationRecord,
  type Clock,
  type KinloomServerPlugin,
  PLUGIN_DATABASE_NAMESPACE_RE,
  PLUGIN_MIGRATION_ID_RE,
  type PluginSqlMigration,
} from '@kinloom/core';
import { sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';

/**
 * Core Kinloom tables that plugins must never read, alter, or reference in SQL.
 */
export const FORBIDDEN_PLUGIN_CORE_TABLES: ReadonlySet<string> = new Set([
  'entities',
  'kinship_edges',
  'revisions',
  'users',
  'invites',
  'magic_links',
  'agent_tokens',
  'talk_comments',
  'watchlists',
  'pronunciation_lexicon',
  'plugin_settings',
  'plugin_setting_secrets',
  'page_visit_daily',
  'observability_cache_daily',
  'd1_migrations',
  'plugin_migrations',
  'steward_reviews',
]);

const FORBIDDEN_SQL_DIRECTIVES: ReadonlySet<string> = new Set([
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
]);

const ALLOWED_RUNTIME_HEADS: ReadonlySet<string> = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'WITH',
  'REPLACE',
]);

const CLAUSE_STOP_WORDS: ReadonlySet<string> = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'HAVING',
  'WINDOW',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'OUTER',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'SET',
  'VALUES',
  'RETURNING',
  'INTO',
  'AS',
]);

const CONFLICT_ACTIONS: ReadonlySet<string> = new Set(['ABORT', 'FAIL', 'IGNORE', 'REPLACE', 'ROLLBACK']);

type SqlToken =
  | { readonly kind: 'word'; readonly value: string; readonly upper: string }
  | { readonly kind: 'ident'; readonly value: string }
  | { readonly kind: 'string' }
  | { readonly kind: 'punct'; readonly value: ';' | '.' | ',' | '(' | ')' };

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '$';
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  const len = sql.length;
  let i = 0;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Skip whitespace
    if (ch <= ' ') {
      i += 1;
      continue;
    }

    // Line comment
    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      i += 1;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ kind: 'string' });
      continue;
    }

    // Double-quoted or backtick identifier
    if (ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      let ident = '';
      while (i < len) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          ident += quote;
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i += 1;
          break;
        }
        ident += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'ident', value: ident });
      continue;
    }

    // Bracket-quoted identifier
    if (ch === '[') {
      i += 1;
      let ident = '';
      while (i < len && sql[i] !== ']') {
        ident += sql[i];
        i += 1;
      }
      if (i < len && sql[i] === ']') {
        i += 1;
      }
      tokens.push({ kind: 'ident', value: ident });
      continue;
    }

    // Punctuation relevant to SQL structure
    if (ch === ';' || ch === '.' || ch === ',' || ch === '(' || ch === ')') {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }

    // Unquoted keyword or identifier
    if (isIdentStart(ch)) {
      let word = ch;
      i += 1;
      while (i < len && isIdentPart(sql[i])) {
        word += sql[i];
        i += 1;
      }
      tokens.push({ kind: 'word', value: word, upper: word.toUpperCase() });
      continue;
    }

    i += 1;
  }

  return tokens;
}

/**
 * Splits a multi-statement SQL script into individual non-empty statements,
 * ignoring semicolons inside comments and quoted literals.
 */
export function splitPluginSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  const len = sql.length;
  let current = '';
  let i = 0;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === '-' && next === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') {
        i += 1;
      }
      if (i < len) {
        current += '\n';
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      current += ' ';
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      current += ch;
      i += 1;
      while (i < len) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          current += quote + quote;
          i += 2;
          continue;
        }
        current += sql[i];
        if (sql[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '[') {
      current += ch;
      i += 1;
      while (i < len) {
        current += sql[i];
        if (sql[i] === ']') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = '';
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  const trailing = current.trim();
  if (trailing.length > 0) {
    statements.push(trailing);
  }
  return statements;
}

export function assertValidPluginNamespace(namespace: string): string {
  const trimmed = namespace.trim();
  if (!PLUGIN_DATABASE_NAMESPACE_RE.test(trimmed)) {
    throw new RangeError(
      `Invalid plugin databaseNamespace '${namespace}': must match ${PLUGIN_DATABASE_NAMESPACE_RE.source}.`
    );
  }
  return trimmed;
}

export function pluginTablePrefix(namespace: string): string {
  return `plugin_${assertValidPluginNamespace(namespace)}_`;
}

export function pluginIndexPrefix(namespace: string): string {
  return `idx_plugin_${assertValidPluginNamespace(namespace)}_`;
}

function isWord(token: SqlToken | undefined, expectedUpper: string): boolean {
  return token?.kind === 'word' && token.upper === expectedUpper;
}

function readIdentValue(token: SqlToken | undefined): string | null {
  if (!token) {
    return null;
  }
  if (token.kind === 'ident' || token.kind === 'word') {
    return token.value;
  }
  return null;
}

function isForbiddenTableName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('sqlite_') || FORBIDDEN_PLUGIN_CORE_TABLES.has(lower);
}

function failGuard(mode: 'registration' | 'runtime', message: string): never {
  if (mode === 'registration') {
    throw new RangeError(message);
  }
  throw new KinloomHttpError(500, 'PLUGIN_SQL_SCOPE_VIOLATION', message);
}

function assertScopedTableName(
  mode: 'registration' | 'runtime',
  namespace: string,
  tableName: string,
  cteNames?: ReadonlySet<string>
): void {
  const lower = tableName.toLowerCase();
  if (cteNames?.has(lower)) {
    return;
  }
  if (isForbiddenTableName(lower)) {
    failGuard(
      mode,
      `Plugin namespace '${namespace}' SQL must not reference forbidden core or system table '${tableName}'.`
    );
  }
  const requiredPrefix = `plugin_${namespace}_`;
  if (!lower.startsWith(requiredPrefix) || lower.length <= requiredPrefix.length) {
    failGuard(
      mode,
      `Plugin namespace '${namespace}' SQL references table '${tableName}', which must start with '${requiredPrefix}'.`
    );
  }
}

function assertScopedIndexName(mode: 'registration' | 'runtime', namespace: string, indexName: string): void {
  const lower = indexName.toLowerCase();
  if (isForbiddenTableName(lower)) {
    failGuard(
      mode,
      `Plugin namespace '${namespace}' SQL must not reference forbidden index name '${indexName}'.`
    );
  }
  const requiredPrefix = `idx_plugin_${namespace}_`;
  if (!lower.startsWith(requiredPrefix) || lower.length <= requiredPrefix.length) {
    failGuard(
      mode,
      `Plugin namespace '${namespace}' SQL references index '${indexName}', which must start with '${requiredPrefix}'.`
    );
  }
}

function readUnqualifiedTarget(
  tokens: readonly SqlToken[],
  index: number,
  mode: 'registration' | 'runtime',
  namespace: string,
  label: string
): { readonly name: string; readonly nextIndex: number } {
  const name = readIdentValue(tokens[index]);
  if (!name) {
    failGuard(mode, `Plugin namespace '${namespace}' SQL is missing a valid ${label} identifier.`);
  }
  const after = tokens[index + 1];
  if (after?.kind === 'punct' && after.value === '.') {
    failGuard(
      mode,
      `Plugin namespace '${namespace}' SQL must not use schema-qualified ${label} '${name}.*'.`
    );
  }
  return { name, nextIndex: index + 1 };
}

function checkForbiddenTokensAndDirectives(
  tokens: readonly SqlToken[],
  mode: 'registration' | 'runtime',
  namespace: string
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === 'word' && FORBIDDEN_SQL_DIRECTIVES.has(token.upper)) {
      failGuard(mode, `Plugin namespace '${namespace}' SQL contains forbidden directive '${token.upper}'.`);
    }

    if (token.kind === 'word' && token.upper === 'CREATE') {
      let nextIdx = i + 1;
      if (isWord(tokens[nextIdx], 'TEMP') || isWord(tokens[nextIdx], 'TEMPORARY')) {
        nextIdx += 1;
      }
      if (isWord(tokens[nextIdx], 'TRIGGER')) {
        failGuard(mode, `Plugin namespace '${namespace}' SQL must not use CREATE TRIGGER.`);
      }
    }

    // Block sqlite_* system catalog references anywhere outside dot-qualified column names.
    const prev = i > 0 ? tokens[i - 1] : undefined;
    const isColumnAfterDot = prev?.kind === 'punct' && prev.value === '.';
    if (!isColumnAfterDot && (token.kind === 'word' || token.kind === 'ident')) {
      const lower = token.value.toLowerCase();
      if (lower.startsWith('sqlite_')) {
        failGuard(
          mode,
          `Plugin namespace '${namespace}' SQL must not reference SQLite system object '${token.value}'.`
        );
      }
    }
  }
}

function collectCteNames(tokens: readonly SqlToken[]): Set<string> {
  const ctes = new Set<string>();
  if (!isWord(tokens[0], 'WITH')) {
    return ctes;
  }
  let i = 1;
  if (isWord(tokens[i], 'RECURSIVE')) {
    i += 1;
  }
  let parenDepth = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.kind === 'punct' && token.value === '(') {
      parenDepth += 1;
      i += 1;
      continue;
    }
    if (token.kind === 'punct' && token.value === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      i += 1;
      continue;
    }
    if (parenDepth === 0) {
      const candidate = readIdentValue(token);
      if (candidate) {
        let lookahead = i + 1;
        // Skip optional CTE column list `(col1, col2)`
        const lookaheadToken = tokens[lookahead];
        if (lookaheadToken?.kind === 'punct' && lookaheadToken.value === '(') {
          let inner = 1;
          lookahead += 1;
          while (lookahead < tokens.length && inner > 0) {
            const innerTok = tokens[lookahead];
            if (innerTok.kind === 'punct' && innerTok.value === '(') inner += 1;
            else if (innerTok.kind === 'punct' && innerTok.value === ')') inner -= 1;
            lookahead += 1;
          }
        }
        if (isWord(tokens[lookahead], 'AS')) {
          ctes.add(candidate.toLowerCase());
          i = lookahead + 1;
          continue;
        }
      }
    }
    i += 1;
  }
  return ctes;
}

function validateTableReferencesInQueryTokens(
  tokens: readonly SqlToken[],
  mode: 'registration' | 'runtime',
  namespace: string,
  cteNames: ReadonlySet<string>
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.kind !== 'word') {
      continue;
    }

    if (tok.upper === 'FROM' || tok.upper === 'JOIN') {
      let cursor = i + 1;
      while (cursor < tokens.length) {
        const next = tokens[cursor];
        // Subquery `FROM (SELECT ...)` is validated as the loop scans inside the parentheses.
        if (next?.kind === 'punct' && next.value === '(') {
          break;
        }
        const target = readUnqualifiedTarget(tokens, cursor, mode, namespace, 'table');
        assertScopedTableName(mode, namespace, target.name, cteNames);
        cursor = target.nextIndex;

        // Skip optional `[AS] alias`
        const aliasToken = tokens[cursor];
        if (isWord(aliasToken, 'AS')) {
          cursor += 2;
        } else if (
          aliasToken &&
          (aliasToken.kind === 'ident' ||
            (aliasToken.kind === 'word' && !CLAUSE_STOP_WORDS.has(aliasToken.upper)))
        ) {
          cursor += 1;
        }

        // Handle comma-separated tables in FROM clause: `FROM plugin_a x, users y`
        const commaToken = tokens[cursor];
        if (tok.upper === 'FROM' && commaToken?.kind === 'punct' && commaToken.value === ',') {
          cursor += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (tok.upper === 'INTO') {
      const target = readUnqualifiedTarget(tokens, i + 1, mode, namespace, 'table');
      assertScopedTableName(mode, namespace, target.name, cteNames);
      continue;
    }

    if (tok.upper === 'UPDATE') {
      // Skip `ON CONFLICT ... DO UPDATE SET`
      const prev = i > 0 ? tokens[i - 1] : undefined;
      if (isWord(prev, 'DO')) {
        continue;
      }
      let cursor = i + 1;
      if (
        isWord(tokens[cursor], 'OR') &&
        tokens[cursor + 1]?.kind === 'word' &&
        CONFLICT_ACTIONS.has((tokens[cursor + 1] as { upper: string }).upper)
      ) {
        cursor += 2;
      }
      const target = readUnqualifiedTarget(tokens, cursor, mode, namespace, 'table');
      assertScopedTableName(mode, namespace, target.name, cteNames);
    }
  }
}

function validateDdlStatement(tokens: readonly SqlToken[], namespace: string): void {
  checkForbiddenTokensAndDirectives(tokens, 'registration', namespace);

  if (tokens.length === 0) {
    return;
  }

  const first = tokens[0];
  if (first.kind !== 'word') {
    throw new RangeError(
      `Plugin namespace '${namespace}' migration statement must start with a DDL keyword.`
    );
  }

  if (first.upper === 'CREATE') {
    let cursor = 1;
    if (isWord(tokens[cursor], 'TEMP') || isWord(tokens[cursor], 'TEMPORARY')) {
      cursor += 1;
    }

    if (isWord(tokens[cursor], 'TABLE')) {
      cursor += 1;
      if (
        isWord(tokens[cursor], 'IF') &&
        isWord(tokens[cursor + 1], 'NOT') &&
        isWord(tokens[cursor + 2], 'EXISTS')
      ) {
        cursor += 3;
      }
      const target = readUnqualifiedTarget(tokens, cursor, 'registration', namespace, 'table');
      assertScopedTableName('registration', namespace, target.name);

      // Ensure any foreign key REFERENCES inside CREATE TABLE also point strictly to this namespace.
      for (let i = target.nextIndex; i < tokens.length; i += 1) {
        if (isWord(tokens[i], 'REFERENCES')) {
          const refTarget = readUnqualifiedTarget(tokens, i + 1, 'registration', namespace, 'table');
          assertScopedTableName('registration', namespace, refTarget.name);
        }
      }
      return;
    }

    if (isWord(tokens[cursor], 'UNIQUE')) {
      cursor += 1;
    }
    if (isWord(tokens[cursor], 'INDEX')) {
      cursor += 1;
      if (
        isWord(tokens[cursor], 'IF') &&
        isWord(tokens[cursor + 1], 'NOT') &&
        isWord(tokens[cursor + 2], 'EXISTS')
      ) {
        cursor += 3;
      }
      const idxTarget = readUnqualifiedTarget(tokens, cursor, 'registration', namespace, 'index');
      assertScopedIndexName('registration', namespace, idxTarget.name);
      if (!isWord(tokens[idxTarget.nextIndex], 'ON')) {
        throw new RangeError(
          `Plugin namespace '${namespace}' CREATE INDEX '${idxTarget.name}' must include ON <table>.`
        );
      }
      const tableTarget = readUnqualifiedTarget(
        tokens,
        idxTarget.nextIndex + 1,
        'registration',
        namespace,
        'table'
      );
      assertScopedTableName('registration', namespace, tableTarget.name);
      return;
    }

    if (isWord(tokens[cursor], 'VIEW')) {
      cursor += 1;
      if (
        isWord(tokens[cursor], 'IF') &&
        isWord(tokens[cursor + 1], 'NOT') &&
        isWord(tokens[cursor + 2], 'EXISTS')
      ) {
        cursor += 3;
      }
      const viewTarget = readUnqualifiedTarget(tokens, cursor, 'registration', namespace, 'view');
      assertScopedTableName('registration', namespace, viewTarget.name);
      const rest = tokens.slice(viewTarget.nextIndex);
      const cteNames = collectCteNames(rest);
      validateTableReferencesInQueryTokens(rest, 'registration', namespace, cteNames);
      return;
    }

    throw new RangeError(`Plugin namespace '${namespace}' migration uses unsupported CREATE DDL statement.`);
  }

  if (first.upper === 'ALTER' && isWord(tokens[1], 'TABLE')) {
    const target = readUnqualifiedTarget(tokens, 2, 'registration', namespace, 'table');
    assertScopedTableName('registration', namespace, target.name);
    for (let i = target.nextIndex; i < tokens.length; i += 1) {
      if (isWord(tokens[i], 'REFERENCES')) {
        const refTarget = readUnqualifiedTarget(tokens, i + 1, 'registration', namespace, 'table');
        assertScopedTableName('registration', namespace, refTarget.name);
      }
      if (isWord(tokens[i], 'RENAME') && isWord(tokens[i + 1], 'TO')) {
        const renamed = readUnqualifiedTarget(tokens, i + 2, 'registration', namespace, 'table');
        assertScopedTableName('registration', namespace, renamed.name);
      }
    }
    return;
  }

  if (first.upper === 'DROP') {
    let cursor = 1;
    const isTable = isWord(tokens[cursor], 'TABLE');
    const isIndex = isWord(tokens[cursor], 'INDEX');
    const isView = isWord(tokens[cursor], 'VIEW');
    if (!isTable && !isIndex && !isView) {
      throw new RangeError(
        `Plugin namespace '${namespace}' migration only allows DROP TABLE, DROP INDEX, or DROP VIEW.`
      );
    }
    cursor += 1;
    if (isWord(tokens[cursor], 'IF') && isWord(tokens[cursor + 1], 'EXISTS')) {
      cursor += 2;
    }
    const target = readUnqualifiedTarget(
      tokens,
      cursor,
      'registration',
      namespace,
      isIndex ? 'index' : 'table'
    );
    if (isIndex) {
      assertScopedIndexName('registration', namespace, target.name);
    } else {
      assertScopedTableName('registration', namespace, target.name);
    }
    return;
  }

  throw new RangeError(
    `Plugin namespace '${namespace}' migration statement '${first.upper}' is not allowed in plugin DDL.`
  );
}

/**
 * Validates that every DDL statement in a plugin migration script is strictly confined
 * to `plugin_<namespace>_*` tables/views and `idx_plugin_<namespace>_*` indexes.
 * Returns the split individual SQL statements.
 */
export function validatePluginMigrationSql(namespace: string, sql: string): readonly string[] {
  const validNamespace = assertValidPluginNamespace(namespace);
  const statements = splitPluginSqlStatements(sql);
  if (statements.length === 0) {
    throw new RangeError(`Plugin namespace '${validNamespace}' migration SQL must not be empty.`);
  }
  for (const statement of statements) {
    const tokens = tokenizeSql(statement);
    if (tokens.length === 0) {
      throw new RangeError(`Plugin namespace '${validNamespace}' migration contains an empty statement.`);
    }
    validateDdlStatement(tokens, validNamespace);
  }
  return statements;
}

/**
 * Runtime SQL scope guard executed before every `PluginDatabasePort` query/run/batch call.
 * Enforces single-statement DML restricted strictly to `plugin_<namespace>_*` tables.
 * Throws `KinloomHttpError(500, 'PLUGIN_SQL_SCOPE_VIOLATION', ...)` on violation.
 */
export function assertScopedPluginSql(namespace: string, sql: string): string {
  const validNamespace = assertValidPluginNamespace(namespace);
  const statements = splitPluginSqlStatements(sql);
  if (statements.length === 0) {
    throw new KinloomHttpError(
      500,
      'PLUGIN_SQL_SCOPE_VIOLATION',
      `Plugin namespace '${validNamespace}' attempted to execute empty SQL.`
    );
  }
  if (statements.length > 1) {
    throw new KinloomHttpError(
      500,
      'PLUGIN_SQL_SCOPE_VIOLATION',
      `Plugin namespace '${validNamespace}' must execute one SQL statement per call (use batch() for multiple statements).`
    );
  }

  const tokens = tokenizeSql(statements[0]);
  if (tokens.length === 0) {
    throw new KinloomHttpError(
      500,
      'PLUGIN_SQL_SCOPE_VIOLATION',
      `Plugin namespace '${validNamespace}' attempted to execute blank SQL.`
    );
  }

  checkForbiddenTokensAndDirectives(tokens, 'runtime', validNamespace);

  const head = tokens[0];
  if (head.kind !== 'word' || !ALLOWED_RUNTIME_HEADS.has(head.upper)) {
    throw new KinloomHttpError(
      500,
      'PLUGIN_SQL_SCOPE_VIOLATION',
      `Plugin namespace '${validNamespace}' runtime query must start with SELECT, INSERT, UPDATE, DELETE, REPLACE, or WITH.`
    );
  }

  const cteNames = collectCteNames(tokens);
  validateTableReferencesInQueryTokens(tokens, 'runtime', validNamespace, cteNames);
  return statements[0];
}

export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n').trim();
}

export async function computeMigrationChecksum(sql: string): Promise<string> {
  return sha256Hex(normalizeMigrationSql(sql));
}

export interface ValidatedPluginMigration {
  readonly pluginId: string;
  readonly namespace: string;
  readonly migration: PluginSqlMigration;
  readonly statements: readonly string[];
}

/**
 * Validates a plugin's databaseNamespace and ordered migrations at registration time.
 */
export function validatePluginMigrations(
  plugin: Pick<KinloomServerPlugin, 'id' | 'databaseNamespace' | 'migrations'>
): readonly ValidatedPluginMigration[] {
  const pluginId = plugin.id.trim();
  if (!pluginId) {
    throw new RangeError('Server plugin id must be non-empty when validating migrations.');
  }

  const migrations = plugin.migrations ?? [];
  if (plugin.databaseNamespace === undefined) {
    if (migrations.length > 0) {
      throw new RangeError(
        `Server plugin '${pluginId}' declares ${migrations.length} migration(s) without a databaseNamespace.`
      );
    }
    return [];
  }

  const namespace = assertValidPluginNamespace(plugin.databaseNamespace);
  const validated: ValidatedPluginMigration[] = [];
  const seenIds = new Set<string>();
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new RangeError(
        `Server plugin '${pluginId}' migration version must be a positive integer >= 1 (received ${migration.version}).`
      );
    }
    if (migration.version <= previousVersion) {
      throw new RangeError(
        `Server plugin '${pluginId}' migrations must have strictly ascending versions (${migration.version} followed ${previousVersion}).`
      );
    }
    previousVersion = migration.version;

    const migrationId = migration.id.trim();
    if (!PLUGIN_MIGRATION_ID_RE.test(migrationId)) {
      throw new RangeError(
        `Server plugin '${pluginId}' migration id '${migration.id}' must match ${PLUGIN_MIGRATION_ID_RE.source}.`
      );
    }
    if (seenIds.has(migrationId)) {
      throw new RangeError(`Server plugin '${pluginId}' has duplicate migration id '${migrationId}'.`);
    }
    seenIds.add(migrationId);

    if (!migration.description || migration.description.trim().length === 0) {
      throw new RangeError(
        `Server plugin '${pluginId}' migration '${migrationId}' must provide a non-empty description.`
      );
    }

    const statements = validatePluginMigrationSql(namespace, migration.sql);
    validated.push({
      pluginId,
      namespace,
      migration: {
        version: migration.version,
        id: migrationId,
        description: migration.description.trim(),
        sql: migration.sql,
      },
      statements,
    });
  }

  return validated;
}

/**
 * Validates databaseNamespace uniqueness and migration SQL across a set of registered plugins.
 */
export function validateRegisteredPluginDatabases(
  plugins: readonly Pick<KinloomServerPlugin, 'id' | 'databaseNamespace' | 'migrations'>[]
): readonly ValidatedPluginMigration[] {
  const namespaceOwner = new Map<string, string>();
  const allValidated: ValidatedPluginMigration[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    const validated = validatePluginMigrations(plugin);
    if (plugin.databaseNamespace !== undefined) {
      const namespace = assertValidPluginNamespace(plugin.databaseNamespace);
      const existingOwner = namespaceOwner.get(namespace);
      if (existingOwner && existingOwner !== pluginId) {
        throw new RangeError(
          `Duplicate plugin databaseNamespace '${namespace}' claimed by '${existingOwner}' and '${pluginId}'.`
        );
      }
      namespaceOwner.set(namespace, pluginId);
    }
    allValidated.push(...validated);
  }

  return allValidated;
}

export interface PluginMigrationExecutor {
  listAppliedMigrations(): Promise<readonly AppliedPluginMigrationRecord[]>;
  applyMigration(params: {
    readonly pluginId: string;
    readonly namespace: string;
    readonly migration: PluginSqlMigration;
    readonly statements: readonly string[];
    readonly checksumSha256: string;
    readonly appliedAt: string;
  }): Promise<void>;
}

export interface RunPluginMigrationsResult {
  readonly applied: readonly AppliedPluginMigrationRecord[];
  readonly skipped: readonly AppliedPluginMigrationRecord[];
}

/**
 * Applies versioned, namespaced plugin migrations idempotently against the `plugin_migrations` ledger.
 * Zero-overhead no-op when no registered plugins declare migrations.
 */
export async function runPluginMigrations(
  executor: PluginMigrationExecutor,
  plugins: readonly Pick<KinloomServerPlugin, 'id' | 'databaseNamespace' | 'migrations'>[],
  clock: Clock
): Promise<RunPluginMigrationsResult> {
  const validated = validateRegisteredPluginDatabases(plugins);
  if (validated.length === 0) {
    return { applied: [], skipped: [] };
  }

  const existingRecords = await executor.listAppliedMigrations();
  const existingByKey = new Map<string, AppliedPluginMigrationRecord>();
  for (const record of existingRecords) {
    existingByKey.set(`${record.plugin_id}:${record.version}`, record);
  }

  const applied: AppliedPluginMigrationRecord[] = [];
  const skipped: AppliedPluginMigrationRecord[] = [];

  for (const item of validated) {
    const checksumSha256 = await computeMigrationChecksum(item.migration.sql);
    const key = `${item.pluginId}:${item.migration.version}`;
    const existing = existingByKey.get(key);

    if (existing) {
      if (
        existing.checksum_sha256 !== checksumSha256 ||
        existing.migration_id !== item.migration.id ||
        existing.namespace !== item.namespace
      ) {
        throw new RangeError(
          `Plugin migration checksum or identity mismatch for '${item.pluginId}' v${item.migration.version} ('${item.migration.id}'): ` +
            `ledger recorded id='${existing.migration_id}' namespace='${existing.namespace}' checksum=${existing.checksum_sha256}, ` +
            `but current migration has id='${item.migration.id}' namespace='${item.namespace}' checksum=${checksumSha256}.`
        );
      }
      skipped.push(existing);
      continue;
    }

    const appliedAt = clock.nowIso();
    await executor.applyMigration({
      pluginId: item.pluginId,
      namespace: item.namespace,
      migration: item.migration,
      statements: item.statements,
      checksumSha256,
      appliedAt,
    });

    const record: AppliedPluginMigrationRecord = {
      plugin_id: item.pluginId,
      namespace: item.namespace,
      version: item.migration.version,
      migration_id: item.migration.id,
      checksum_sha256: checksumSha256,
      applied_at: appliedAt,
    };
    existingByKey.set(key, record);
    applied.push(record);
  }

  return { applied, skipped };
}
