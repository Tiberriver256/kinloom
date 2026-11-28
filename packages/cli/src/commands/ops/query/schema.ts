import { fastLocaleCompare, parseYaml } from '@kinloom/core';
import { isPlainObject } from './helpers.js';
import type { QuerySchemaReport, SchemaFileInspection, SchemaKeyFrequency } from './types.js';

function inspectYamlDocumentKeys(raw: unknown): { recordCount: number; keyCounts: Map<string, number> } {
  const keyCounts = new Map<string, number>();
  if (raw === null || raw === undefined) {
    return { recordCount: 0, keyCounts };
  }
  if (Array.isArray(raw)) {
    let recordCount = 0;
    for (const entry of raw) {
      recordCount += 1;
      if (isPlainObject(entry)) {
        for (const key of Object.keys(entry)) {
          keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
        }
      }
    }
    return { recordCount, keyCounts };
  }
  if (isPlainObject(raw)) {
    for (const key of Object.keys(raw)) {
      keyCounts.set(key, 1);
    }
    return { recordCount: 1, keyCounts };
  }
  return { recordCount: 1, keyCounts };
}

export function inspectArchiveYamlSchema(
  repoDir: string,
  yamlTexts: ReadonlyArray<{ name: string; content: string }>
): QuerySchemaReport {
  const sortedTexts = [...yamlTexts].toSorted((a, b) => fastLocaleCompare(a.name, b.name));
  const files: SchemaFileInspection[] = [];
  let totalRecords = 0;

  for (const file of sortedTexts) {
    const parsed = parseYaml(file.content);
    const { recordCount, keyCounts } = inspectYamlDocumentKeys(parsed);
    totalRecords += recordCount;

    const keys: SchemaKeyFrequency[] = [...keyCounts.entries()]
      .toSorted((a, b) => b[1] - a[1] || fastLocaleCompare(a[0], b[0]))
      .map(([key, count]) => ({
        key,
        count,
        pct: recordCount > 0 ? Math.round((count / recordCount) * 1000) / 10 : 0,
      }));

    files.push({
      file: file.name,
      recordCount,
      keys,
    });
  }

  return {
    ok: true,
    target: 'schema',
    repo: repoDir,
    totalFiles: files.length,
    totalRecords,
    files,
  };
}

export function formatSchemaTextReport(report: QuerySchemaReport): string {
  const lines: string[] = [
    `Schema ${report.repo}`,
    `Files: ${report.totalFiles}, Total records: ${report.totalRecords}`,
  ];
  if (report.files.length === 0) {
    lines.push('  (no YAML files found under data/)');
    return `${lines.join('\n')}\n`;
  }
  for (const file of report.files) {
    lines.push('');
    lines.push(`${file.file} (${file.recordCount} ${file.recordCount === 1 ? 'record' : 'records'}):`);
    if (file.keys.length === 0) {
      lines.push('  (no keys)');
      continue;
    }
    const maxKeyWidth = Math.max(...file.keys.map((entry) => entry.key.length));
    for (const entry of file.keys) {
      const pctText = `${entry.pct.toFixed(1)}%`;
      lines.push(`  ${entry.key.padEnd(maxKeyWidth)}  ${String(entry.count).padStart(5)}  (${pctText})`);
    }
  }
  return `${lines.join('\n')}\n`;
}
