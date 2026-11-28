import { CliValidationError } from '../../../errors.js';

const MAX_CELL_LENGTH = 72;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function compileMatchRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new CliValidationError('Option `--match` requires a non-empty regular expression pattern.');
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(`Invalid \`--match\` regular expression '${trimmed}': ${detail}`);
  }
}

export function parseFieldsCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const fields = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (fields.length === 0) {
    throw new CliValidationError('Option `--fields` must specify at least one field name.');
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    if (!seen.has(field)) {
      seen.add(field);
      deduped.push(field);
    }
  }
  return deduped;
}

export function getNestedFieldValue(record: unknown, fieldPath: string): unknown {
  const segments = fieldPath
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return undefined;
  }
  let current: unknown = record;
  for (const segment of segments) {
    if (!isPlainObject(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function isFieldMissing(record: unknown, fieldPath: string): boolean {
  const value = getNestedFieldValue(record, fieldPath);
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (isPlainObject(value)) {
    return Object.keys(value).length === 0;
  }
  return false;
}

export function matchesRecordRegex(value: unknown, regex: RegExp): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    return regex.test(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return regex.test(String(value));
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (matchesRecordRegex(item, regex)) {
        return true;
      }
    }
    return false;
  }
  if (isPlainObject(value)) {
    for (const val of Object.values(value)) {
      if (matchesRecordRegex(val, regex)) {
        return true;
      }
    }
    return false;
  }
  return false;
}

export function projectRecordFields(record: unknown, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    const value = getNestedFieldValue(record, field);
    projected[field] = value === undefined ? null : value;
  }
  return projected;
}

export function formatCellValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '-';
  }
  let text: string;
  if (typeof value === 'string') {
    text = value.replace(/\s+/g, ' ').trim();
    if (!text) {
      return '-';
    }
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    text = String(value);
  } else if (Array.isArray(value)) {
    if (value.length === 0) {
      return '-';
    }
    const parts = value.map((item) =>
      typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
        ? String(item)
        : JSON.stringify(item)
    );
    text = parts.join(', ');
  } else {
    text = JSON.stringify(value);
  }
  if (text.length > MAX_CELL_LENGTH) {
    return `${text.slice(0, MAX_CELL_LENGTH - 3)}...`;
  }
  return text;
}

export function formatCompactTable(columns: readonly string[], rows: readonly unknown[]): string {
  if (rows.length === 0) {
    return '  (none)';
  }
  const formattedRows = rows.map((row) =>
    columns.map((col) => formatCellValue(getNestedFieldValue(row, col)))
  );
  const widths = columns.map((col, idx) => {
    let maxLen = col.length;
    for (const row of formattedRows) {
      const cell = row[idx] ?? '';
      if (cell.length > maxLen) {
        maxLen = cell.length;
      }
    }
    return maxLen;
  });

  const headerLine = columns
    .map((col, idx) => col.padEnd(widths[idx] ?? col.length))
    .join('  ')
    .trimEnd();
  const dividerLine = widths.map((w) => '-'.repeat(w)).join('  ');
  const bodyLines = formattedRows.map((row) =>
    row
      .map((cell, idx) => cell.padEnd(widths[idx] ?? cell.length))
      .join('  ')
      .trimEnd()
  );

  return [headerLine, dividerLine, ...bodyLines].join('\n');
}
