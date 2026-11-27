import type {
  D1SchemaSnapshot,
  DiscoveredMigration,
  MigrationColumnRequirement,
  MigrationSchemaRequirements,
  MigrationStatusEntry,
} from './types.js';

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
        createTableMatch[1] ?? createTableMatch[2] ?? createTableMatch[3] ?? createTableMatch[4] ?? ''
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
        createIndexMatch[1] ?? createIndexMatch[2] ?? createIndexMatch[3] ?? createIndexMatch[4] ?? ''
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
        alterAddColMatch[1] ?? alterAddColMatch[2] ?? alterAddColMatch[3] ?? alterAddColMatch[4] ?? ''
      );
      const column = unquoteSqlIdent(
        alterAddColMatch[5] ?? alterAddColMatch[6] ?? alterAddColMatch[7] ?? alterAddColMatch[8] ?? ''
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

export function buildMissingAlterStatements(
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
