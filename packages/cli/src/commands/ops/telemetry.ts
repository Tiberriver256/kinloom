import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface OpsIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface TelemetryEvent {
  ts: string;
  cmd: string;
  subcmd: string;
  person_id: string | null;
  duration_ms: number;
  cache_hit: boolean | null;
  exit_code: number;
  bytes_out: number;
}

export interface TelemetryEventInput {
  ts?: string;
  cmd?: string;
  subcmd: string;
  person_id?: string | null;
  duration_ms?: number;
  cache_hit?: boolean | null;
  exit_code?: number;
  bytes_out?: number;
}

export interface RecordTelemetryOptions {
  force?: boolean | undefined;
  filePath?: string | undefined;
}

export interface MeasureCommandMeta<TResult> {
  cmd?: string;
  subcmd: string;
  personId?: string | null;
  filePath?: string;
  force?: boolean;
  extractResultMeta?: (result: TResult) => {
    personId?: string | null;
    cacheHit?: boolean | undefined | null;
    exitCode?: number;
    bytesOut?: number;
  };
}

export interface TelemetrySummaryRow {
  subcmd: string;
  count: number;
  p50_ms: number;
  p95_ms: number;
  total_ms: number;
  cache_hit_pct: number | null;
  fail_pct: number;
}

export interface TelemetryReportOptions {
  filePath?: string;
  sinceHours?: number;
  json?: boolean;
  nowMs?: number;
}

export interface TelemetryReportResult {
  filePath: string;
  sinceHours: number | null;
  totalEvents: number;
  skippedLines: number;
  rows: TelemetrySummaryRow[];
  rendered: string;
}

export { TELEMETRY_HELP } from './help.js';

export function getDefaultTelemetryFilePath(): string {
  return path.join(os.homedir(), '.cache', 'kinloom-telemetry', 'calls.jsonl');
}

export function getTelemetryFilePath(overridePath?: string): string {
  if (overridePath && overridePath.trim().length > 0) {
    return path.resolve(overridePath.trim());
  }
  const envOverride = process.env['KINLOOM_TELEMETRY_FILE'];
  if (envOverride && envOverride.trim().length > 0) {
    return path.resolve(envOverride.trim());
  }
  return getDefaultTelemetryFilePath();
}

export function isTelemetrySuppressedByParent(): boolean {
  return process.env['KINLOOM_TELEMETRY_PARENT'] === '1';
}

export function recordTelemetryEvent(record: TelemetryEventInput, options?: RecordTelemetryOptions): void {
  if (!options?.force && isTelemetrySuppressedByParent()) {
    return;
  }
  try {
    const filePath = getTelemetryFilePath(options?.filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entry: TelemetryEvent = {
      ts: record.ts ?? new Date().toISOString(),
      cmd: record.cmd ?? 'kinloom',
      subcmd: record.subcmd,
      person_id: record.person_id ?? null,
      duration_ms: Math.max(0, Math.round(Number(record.duration_ms ?? 0))),
      cache_hit: typeof record.cache_hit === 'boolean' ? record.cache_hit : null,
      exit_code: Number.isInteger(record.exit_code) ? Number(record.exit_code) : 0,
      bytes_out: Math.max(0, Math.round(Number(record.bytes_out ?? 0))),
    };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Fail-open: telemetry must never break CLI execution.
  }
}

function extractErrorExitCode(err: unknown): number {
  if (typeof err === 'object' && err !== null && 'exitCode' in err) {
    const code = (err as { exitCode: unknown }).exitCode;
    if (typeof code === 'number' && Number.isInteger(code) && code > 0) {
      return code;
    }
  }
  return 1;
}

export async function measureCommand<TResult>(
  meta: MeasureCommandMeta<TResult>,
  fn: () => Promise<TResult>
): Promise<TResult> {
  const startMs = performance.now();
  try {
    const result = await fn();
    const derived = meta.extractResultMeta ? meta.extractResultMeta(result) : undefined;
    recordTelemetryEvent(
      {
        cmd: meta.cmd ?? 'kinloom',
        subcmd: meta.subcmd,
        person_id: derived?.personId !== undefined ? derived.personId : (meta.personId ?? null),
        duration_ms: performance.now() - startMs,
        cache_hit: derived?.cacheHit ?? null,
        exit_code: derived?.exitCode ?? 0,
        bytes_out: derived?.bytesOut ?? 0,
      },
      { force: meta.force, filePath: meta.filePath }
    );
    return result;
  } catch (err: unknown) {
    recordTelemetryEvent(
      {
        cmd: meta.cmd ?? 'kinloom',
        subcmd: meta.subcmd,
        person_id: meta.personId ?? null,
        duration_ms: performance.now() - startMs,
        cache_hit: null,
        exit_code: extractErrorExitCode(err),
        bytes_out: 0,
      },
      { force: meta.force, filePath: meta.filePath }
    );
    throw err;
  }
}

function parseTelemetryLine(line: string): TelemetryEvent | null {
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null;
    }
    const obj = raw as Record<string, unknown>;
    const ts = typeof obj['ts'] === 'string' ? obj['ts'] : '';
    const cmd = typeof obj['cmd'] === 'string' ? obj['cmd'] : 'kinloom';
    const subcmd = typeof obj['subcmd'] === 'string' ? obj['subcmd'] : '';
    const personId = typeof obj['person_id'] === 'string' ? obj['person_id'] : null;
    const durationMs =
      typeof obj['duration_ms'] === 'number' && Number.isFinite(obj['duration_ms'])
        ? Math.max(0, obj['duration_ms'])
        : 0;
    const cacheHit = typeof obj['cache_hit'] === 'boolean' ? obj['cache_hit'] : null;
    const exitCode = typeof obj['exit_code'] === 'number' && Number.isInteger(obj['exit_code']) ? obj['exit_code'] : 0;
    const bytesOut =
      typeof obj['bytes_out'] === 'number' && Number.isFinite(obj['bytes_out']) ? Math.max(0, obj['bytes_out']) : 0;
    return {
      ts,
      cmd,
      subcmd,
      person_id: personId,
      duration_ms: durationMs,
      cache_hit: cacheHit,
      exit_code: exitCode,
      bytes_out: bytesOut,
    };
  } catch {
    return null;
  }
}

export function computePercentile(sortedAscending: readonly number[], percentile: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const idx = Math.min(
    sortedAscending.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sortedAscending.length) - 1)
  );
  return Math.round(sortedAscending[idx]);
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarizeTelemetryEvents(events: readonly TelemetryEvent[]): TelemetrySummaryRow[] {
  const bySubcmd = new Map<string, TelemetryEvent[]>();
  for (const event of events) {
    const key = event.subcmd.trim() || event.cmd.trim() || 'unknown';
    const bucket = bySubcmd.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      bySubcmd.set(key, [event]);
    }
  }

  const rows: TelemetrySummaryRow[] = [];
  for (const [subcmd, group] of bySubcmd.entries()) {
    const durations = group.map((e) => e.duration_ms).toSorted((a, b) => a - b);
    const totalMs = Math.round(durations.reduce((acc, ms) => acc + ms, 0));
    const cacheObservations = group.filter((e) => e.cache_hit !== null);
    const cacheHits = cacheObservations.filter((e) => e.cache_hit === true).length;
    const failures = group.filter((e) => e.exit_code !== 0).length;

    rows.push({
      subcmd,
      count: group.length,
      p50_ms: computePercentile(durations, 50),
      p95_ms: computePercentile(durations, 95),
      total_ms: totalMs,
      cache_hit_pct:
        cacheObservations.length > 0 ? roundOneDecimal((cacheHits / cacheObservations.length) * 100) : null,
      fail_pct: roundOneDecimal((failures / group.length) * 100),
    });
  }

  return rows.toSorted(
    (a, b) => b.total_ms - a.total_ms || b.count - a.count || a.subcmd.localeCompare(b.subcmd)
  );
}

export function formatTelemetryTable(
  rows: readonly TelemetrySummaryRow[],
  meta: { filePath: string; sinceHours: number | null; totalEvents: number }
): string {
  const headerNote =
    meta.sinceHours !== null
      ? `Telemetry (${meta.totalEvents} events in last ${meta.sinceHours}h) | ${meta.filePath}`
      : `Telemetry (${meta.totalEvents} events) | ${meta.filePath}`;

  if (rows.length === 0) {
    return `${headerNote}\n(no telemetry events recorded)`;
  }

  const headers = ['subcmd', 'count', 'p50_ms', 'p95_ms', 'total_ms', 'cache_hit%', 'fail%'];
  const formattedRows = rows.map((row) => [
    row.subcmd,
    String(row.count),
    String(row.p50_ms),
    String(row.p95_ms),
    String(row.total_ms),
    row.cache_hit_pct === null ? '-' : `${row.cache_hit_pct.toFixed(1)}%`,
    `${row.fail_pct.toFixed(1)}%`,
  ]);

  const widths = headers.map((header, idx) =>
    Math.max(header.length, ...formattedRows.map((cells) => cells[idx].length))
  );

  const formatRow = (cells: readonly string[]): string =>
    cells.map((cell, idx) => (idx === 0 ? cell.padEnd(widths[idx]) : cell.padStart(widths[idx]))).join('  ');

  const lines: string[] = [
    headerNote,
    formatRow(headers),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...formattedRows.map(formatRow),
  ];

  return lines.join('\n');
}

export async function runTelemetryReportCommand(
  options: TelemetryReportOptions = {},
  io?: OpsIo
): Promise<TelemetryReportResult> {
  const filePath = getTelemetryFilePath(options.filePath);
  const sinceHours =
    options.sinceHours !== undefined && Number.isFinite(options.sinceHours) ? options.sinceHours : null;
  const nowMs = options.nowMs ?? Date.now();
  const cutoffMs = sinceHours !== null ? nowMs - sinceHours * 3_600_000 : null;

  let rawText = '';
  try {
    rawText = await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (!(typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT')) {
      throw err;
    }
  }

  const events: TelemetryEvent[] = [];
  let skippedLines = 0;

  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    const parsed = parseTelemetryLine(trimmed);
    if (!parsed) {
      skippedLines += 1;
      continue;
    }
    if (cutoffMs !== null) {
      const eventMs = Date.parse(parsed.ts);
      if (!Number.isFinite(eventMs) || eventMs < cutoffMs) {
        continue;
      }
    }
    events.push(parsed);
  }

  const rows = summarizeTelemetryEvents(events);
  const payload = {
    filePath,
    sinceHours,
    totalEvents: events.length,
    skippedLines,
    rows,
  };

  const rendered = options.json
    ? JSON.stringify(payload, null, 2)
    : formatTelemetryTable(rows, {
        filePath,
        sinceHours,
        totalEvents: events.length,
      });

  if (io) {
    io.stdout(rendered);
  }

  return {
    ...payload,
    rendered,
  };
}
