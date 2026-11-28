import { CliValidationError } from '../errors.js';
import {
  DEFAULT_SYNTHETIC_PROBE_BUDGETS,
  type ParsedServerTiming,
  type SecurityHeaderCheckResult,
  type ServerTimingSpanName,
  type SyntheticProbeBudgets,
  type SyntheticProbeReport,
} from './syntheticProbeTypes.js';

const BASE_SECURITY_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
] as const;

export function roundDurationMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function emptyServerTiming(): ParsedServerTiming {
  return { raw: null, spansMs: {}, allSpansMs: {} };
}

function isKnownServerTimingSpan(name: string): name is ServerTimingSpanName {
  return name === 'd1' || name === 'r2' || name === 'bundle' || name === 'total';
}

/**
 * Validates and normalizes an archive base URL for synthetic probes.
 */
export function normalizeProbeBaseUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new CliValidationError('Missing required target URL (`--url`).');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliValidationError(`Invalid target URL '${trimmed}'. Expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliValidationError(
      `Unsupported URL protocol '${parsed.protocol}'. Expected http:// or https://.`
    );
  }
  parsed.hash = '';
  parsed.search = '';
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }
  return parsed;
}

/**
 * Parses a W3C / RFC Server-Timing header value into millisecond span durations.
 */
export function parseServerTimingHeader(header: string | null): ParsedServerTiming {
  if (!header?.trim()) {
    return emptyServerTiming();
  }
  const spansMs: Partial<Record<ServerTimingSpanName, number>> = {};
  const allSpansMs: Record<string, number> = {};

  for (const rawEntry of header.split(',')) {
    const parts = rawEntry
      .split(';')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    const metricName = parts[0]?.toLowerCase();
    if (!metricName || !/^[a-z0-9._-]+$/.test(metricName)) {
      continue;
    }
    for (const param of parts.slice(1)) {
      const match = /^dur\s*=\s*"?([0-9]+(?:\.[0-9]+)?)"?$/i.exec(param);
      if (!match?.[1]) {
        continue;
      }
      const parsedDuration = Number(match[1]);
      if (Number.isFinite(parsedDuration) && parsedDuration >= 0) {
        const rounded = roundDurationMs(parsedDuration);
        allSpansMs[metricName] = rounded;
        if (isKnownServerTimingSpan(metricName)) {
          spansMs[metricName] = rounded;
        }
      }
    }
  }

  return {
    raw: header.trim(),
    spansMs,
    allSpansMs,
  };
}

/**
 * Evaluates baseline HTTP security headers on the root HTML response.
 */
export function evaluateSecurityHeaders(headers: Headers, isHttps: boolean): SecurityHeaderCheckResult {
  const required: string[] = [...BASE_SECURITY_HEADERS];
  if (isHttps) {
    required.push('strict-transport-security');
  }
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const value = headers.get(name);
    if (value?.trim()) {
      present.push(name);
    } else {
      missing.push(name);
    }
  }
  return {
    required,
    present,
    missing,
    ok: missing.length === 0,
  };
}

export function normalizeSameOriginMediaPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Discovers the first same-origin media file path from a parsed `/api/bundle` payload.
 */
export function discoverFirstMediaPathFromBundle(bundleJson: unknown): string | null {
  if (typeof bundleJson !== 'object' || bundleJson === null) {
    return null;
  }
  const mediaField: unknown = Reflect.get(bundleJson, 'media');
  if (!Array.isArray(mediaField)) {
    return null;
  }
  for (const item of mediaField) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const fileValue: unknown = Reflect.get(item, 'file');
    if (typeof fileValue !== 'string') {
      continue;
    }
    const normalized = normalizeSameOriginMediaPath(fileValue);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

/**
 * Discovers the first deceased person slug from a parsed `/api/bundle` payload.
 */
export function discoverFirstDeceasedPersonSlugFromBundle(bundleJson: unknown): string | null {
  if (typeof bundleJson !== 'object' || bundleJson === null) {
    return null;
  }
  const peopleField: unknown = Reflect.get(bundleJson, 'people');
  if (!Array.isArray(peopleField)) {
    return null;
  }
  for (const item of peopleField) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const isLiving: unknown = Reflect.get(item, 'is_living');
    if (isLiving === true) {
      continue;
    }
    const slug: unknown = Reflect.get(item, 'slug');
    if (typeof slug === 'string' && slug.trim().length > 0) {
      return slug.trim();
    }
  }
  return null;
}

/**
 * Parses a comma-separated list of expected server plugin IDs into a deduplicated array.
 */
export function parseExpectedPluginsCsv(raw?: string): readonly string[] {
  if (!raw?.trim()) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Resolves the bearer token for synthetic probes in canonical precedence order:
 * explicit CLI `--token` -> plugin option `token` -> `KINLOOM_PROBE_TOKEN` -> `KINLOOM_TOKEN` -> `KINLOOM_AGENT_TOKEN`.
 */
export function resolveProbeToken(
  explicitToken?: string,
  optionToken?: string,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const candidates = [
    explicitToken,
    optionToken,
    env['KINLOOM_PROBE_TOKEN'],
    env['KINLOOM_TOKEN'],
    env['KINLOOM_AGENT_TOKEN'],
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

export function resolveProbeBudgets(overrides?: Partial<SyntheticProbeBudgets>): SyntheticProbeBudgets {
  return {
    maxHtmlTtfbMs: overrides?.maxHtmlTtfbMs ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxHtmlTtfbMs,
    maxBundleColdMs: overrides?.maxBundleColdMs ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxBundleColdMs,
    maxBundleWarmMs: overrides?.maxBundleWarmMs ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxBundleWarmMs,
    maxMediaRangeMs: overrides?.maxMediaRangeMs ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxMediaRangeMs,
    require304: overrides?.require304 ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.require304,
    require206: overrides?.require206 ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.require206,
    requireSecurityHeaders:
      overrides?.requireSecurityHeaders ?? DEFAULT_SYNTHETIC_PROBE_BUDGETS.requireSecurityHeaders,
  };
}

function formatServerTimingSummary(timing: ParsedServerTiming): string {
  const entries = Object.entries(timing.allSpansMs);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([key, value]) => `${key}=${value}ms`).join(', ');
}

/**
 * Renders a concise human-readable synthetic probe report.
 */
export function formatSyntheticProbeReport(report: SyntheticProbeReport): string {
  const headerStatus = report.ok ? 'PASS' : 'FAIL';
  const lines: string[] = [
    `Synthetic Probe [${headerStatus}] ${report.targetUrl} (${report.durationMs} ms)`,
    `  1. HTML root: ${report.html.status.toUpperCase()} | status=${report.html.httpStatus ?? 'ERR'} ttfb=${report.html.ttfbMs}ms (budget<=${report.budgets.maxHtmlTtfbMs}ms) total=${report.html.totalMs}ms bytes=${report.html.bytes} headers=${report.html.securityHeaders.present.length}/${report.html.securityHeaders.required.length}`,
    `  2. Bundle cold: status=${report.bundle.cold.httpStatus ?? 'ERR'} latency=${report.bundle.cold.durationMs}ms (budget<=${report.budgets.maxBundleColdMs}ms) bytes=${report.bundle.cold.bytes} etag=${report.bundle.cold.etag ?? 'none'} server-timing=${formatServerTimingSummary(report.bundle.cold.serverTiming)}`,
  ];

  if (report.bundle.warm.status === 'skipped') {
    lines.push(`  3. Bundle warm (If-None-Match): SKIPPED | ${report.bundle.warm.reason}`);
  } else {
    lines.push(
      `  3. Bundle warm (If-None-Match): ${report.bundle.warm.status.toUpperCase()} | status=${report.bundle.warm.httpStatus ?? 'ERR'} latency=${report.bundle.warm.durationMs}ms (budget<=${report.budgets.maxBundleWarmMs}ms) server-timing=${formatServerTimingSummary(report.bundle.warm.serverTiming)}`
    );
  }

  if (report.mediaRange.status === 'skipped') {
    lines.push(`  4. Media range (206): SKIPPED | ${report.mediaRange.reason}`);
  } else {
    lines.push(
      `  4. Media range (${report.mediaRange.rangeHeader}): ${report.mediaRange.status.toUpperCase()} | status=${report.mediaRange.httpStatus ?? 'ERR'} latency=${report.mediaRange.durationMs}ms (budget<=${report.budgets.maxMediaRangeMs}ms) bytes=${report.mediaRange.bytes} content-range=${report.mediaRange.contentRange ?? 'none'} accept-ranges=${report.mediaRange.acceptRanges ?? 'none'}`
    );
  }

  if (report.plugins) {
    const leakLabel =
      report.plugins.leakGuardPassed === null ? 'n/a' : report.plugins.leakGuardPassed ? 'pass' : 'fail';
    const diagLabel = report.plugins.diagnosticsChecked ? 'checked' : 'skipped';
    lines.push(
      `  5. Plugins: ${report.plugins.status.toUpperCase()} | checks=${report.plugins.checks.length} leak-guard=${leakLabel} diagnostics=${diagLabel}`
    );
    for (const check of report.plugins.checks) {
      const httpLabel = check.httpStatus === null ? 'n/a' : String(check.httpStatus);
      lines.push(
        `     - ${check.pluginId}: ${check.status.toUpperCase()} | status=${httpLabel} latency=${check.durationMs}ms | ${check.detail}`
      );
    }
  }

  for (const violation of report.violations) {
    lines.push(`  VIOLATION: ${violation}`);
  }

  return lines.join('\n');
}
