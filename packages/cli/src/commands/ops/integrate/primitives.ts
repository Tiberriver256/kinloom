import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readOptionalUtf8(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

export function sha256File(filePath: string): { sizeBytes: number; sha256: string } {
  const buf = fs.readFileSync(filePath);
  return {
    sizeBytes: buf.byteLength,
    sha256: createHash('sha256').update(buf).digest('hex'),
  };
}

export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

export function parseOptionalStringList(raw: unknown, label: string): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`${label}[${i}] must be a non-empty string.`);
    }
    const trimmed = item.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

export function dedupeStrings(
  existing: readonly string[] | undefined,
  additions: readonly unknown[] | undefined
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...(additions ?? [])]) {
    if (typeof raw !== 'string') {
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValue(item));
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).toSorted((a, b) => a.localeCompare(b))) {
      const prop = (value as Record<string, unknown>)[key];
      if (prop !== undefined) {
        sorted[key] = canonicalizeJsonValue(prop);
      }
    }
    return sorted;
  }
  return value;
}

export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value));
}
