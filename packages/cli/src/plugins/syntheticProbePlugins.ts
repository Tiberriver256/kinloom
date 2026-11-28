import { roundDurationMs } from './syntheticProbeParsing.js';
import type {
  BundleColdProbeResult,
  PluginProbesReport,
  SinglePluginProbeResult,
  SyntheticProbeClock,
} from './syntheticProbeTypes.js';

export interface PluginProbeTransport {
  readonly baseUrl: URL;
  readonly token?: string | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly clock: SyntheticProbeClock;
}

export interface RunPluginHealthProbesInput {
  readonly transport: PluginProbeTransport;
  readonly htmlBody: string;
  readonly bundleCold: BundleColdProbeResult;
  readonly discoveredPersonSlug: string | null;
  readonly expectPlugins: readonly string[];
}

interface HttpProbeFetchResult {
  readonly ok: true;
  readonly status: number;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly durationMs: number;
}

interface HttpProbeFetchError {
  readonly ok: false;
  readonly message: string;
  readonly durationMs: number;
}

const KNOWN_PLUGIN_CHECK_IDS = new Set([
  'kinloom-workers-observability',
  'kinloom-web-analytics',
  'kinloom-page-visit-stats',
  'kinloom-open-finance',
  'kinloom-recipes',
  'kinloom-book-publishing',
  'kinloom-pronunciation',
]);

function buildUrl(baseUrl: URL, routePath: string): string {
  const cleanRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const basePath = baseUrl.pathname === '/' ? '' : baseUrl.pathname;
  return `${baseUrl.origin}${basePath}${cleanRoute}`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readErrorCode(payload: unknown): string | null {
  if (!isObjectRecord(payload)) {
    return null;
  }
  const errorObj = payload['error'];
  if (isObjectRecord(errorObj) && typeof errorObj['code'] === 'string' && errorObj['code'].trim()) {
    return errorObj['code'].trim();
  }
  return null;
}

async function fetchEndpoint(
  transport: PluginProbeTransport,
  routePath: string,
  options: { readonly includeAuth: boolean }
): Promise<HttpProbeFetchResult | HttpProbeFetchError> {
  const url = buildUrl(transport.baseUrl, routePath);
  const headers = new Headers({ accept: 'application/json' });
  if (options.includeAuth && transport.token?.trim()) {
    headers.set('authorization', `Bearer ${transport.token.trim()}`);
  }
  const startedAt = transport.clock.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs);
  try {
    const response = await transport.fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const durationMs = roundDurationMs(transport.clock.now() - startedAt);
    return {
      ok: true,
      status: response.status,
      headers: response.headers,
      bodyText,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = roundDurationMs(transport.clock.now() - startedAt);
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      durationMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

function checkWorkersObservability(
  bundleCold: BundleColdProbeResult,
  expected: boolean
): SinglePluginProbeResult {
  const pluginId = 'kinloom-workers-observability';
  const hasRequestId = Boolean(bundleCold.xRequestId?.trim());
  const spanCount = Object.keys(bundleCold.serverTiming.allSpansMs).length;
  if (hasRequestId || spanCount > 0) {
    return {
      pluginId,
      status: 'pass',
      httpStatus: bundleCold.httpStatus,
      durationMs: 0,
      detail: `x-request-id=${hasRequestId ? 'present' : 'absent'} server-timing-spans=${spanCount}`,
      violations: [],
    };
  }
  if (expected) {
    const violation = `${pluginId}: expected X-Request-Id or Server-Timing header on /api/bundle.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: bundleCold.httpStatus,
      durationMs: 0,
      detail: 'Observability headers missing on /api/bundle',
      violations: [violation],
    };
  }
  return {
    pluginId,
    status: 'warn',
    httpStatus: bundleCold.httpStatus,
    durationMs: 0,
    detail: 'No X-Request-Id or Server-Timing headers detected on /api/bundle',
    violations: [],
  };
}

function checkWebAnalytics(htmlBody: string, expected: boolean): SinglePluginProbeResult {
  const pluginId = 'kinloom-web-analytics';
  const hasBeacon = htmlBody.includes('static.cloudflareinsights.com/beacon.min.js');
  if (hasBeacon) {
    return {
      pluginId,
      status: 'pass',
      httpStatus: 200,
      durationMs: 0,
      detail: 'Cloudflare Web Analytics beacon script detected in root HTML',
      violations: [],
    };
  }
  if (expected) {
    const violation = `${pluginId}: expected Cloudflare Web Analytics beacon script in root HTML.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: 200,
      durationMs: 0,
      detail: 'Web Analytics beacon script missing from root HTML',
      violations: [violation],
    };
  }
  return {
    pluginId,
    status: 'warn',
    httpStatus: 200,
    durationMs: 0,
    detail: 'Web Analytics beacon not enabled in root HTML',
    violations: [],
  };
}

async function checkPageVisitStats(
  transport: PluginProbeTransport,
  isPrivateArchive: boolean,
  discoveredPersonSlug: string | null,
  expected: boolean
): Promise<SinglePluginProbeResult> {
  const pluginId = 'kinloom-page-visit-stats';
  const res = await fetchEndpoint(transport, '/api/observability/config', { includeAuth: true });
  if (!res.ok) {
    const violation = `${pluginId}: /api/observability/config probe failed: ${res.message}`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: null,
      durationMs: res.durationMs,
      detail: res.message,
      violations: [violation],
    };
  }
  if (res.status === 404) {
    if (expected) {
      const violation = `${pluginId}: expected active plugin, but /api/observability/config returned HTTP 404.`;
      return {
        pluginId,
        status: 'fail',
        httpStatus: 404,
        durationMs: res.durationMs,
        detail: 'Route /api/observability/config returned 404',
        violations: [violation],
      };
    }
    return {
      pluginId,
      status: 'skipped',
      httpStatus: 404,
      durationMs: res.durationMs,
      detail: 'Not registered (HTTP 404)',
      violations: [],
    };
  }
  if (res.status !== 200) {
    const violation = `${pluginId}: /api/observability/config returned HTTP ${res.status}.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Unexpected HTTP ${res.status}`,
      violations: [violation],
    };
  }

  const violations: string[] = [];
  const parsed = parseJsonSafe(res.bodyText);
  const validShape =
    isObjectRecord(parsed) &&
    parsed['enabled'] === true &&
    typeof parsed['public_badges_enabled'] === 'boolean';
  if (!validShape) {
    violations.push(`${pluginId}: /api/observability/config returned invalid JSON schema.`);
  }
  const cacheControl = (res.headers.get('cache-control') ?? '').toLowerCase();
  if (isPrivateArchive && cacheControl.includes('public')) {
    violations.push(`${pluginId}: private archive /api/observability/config returned public Cache-Control.`);
  }

  let totalDuration = res.durationMs;
  let badgeSummary = validShape && parsed['public_badges_enabled'] ? 'badges=on' : 'badges=off';
  if (validShape && parsed['public_badges_enabled'] && discoveredPersonSlug) {
    const countRes = await fetchEndpoint(
      transport,
      `/api/observability/page-visits?kind=person&slug=${encodeURIComponent(discoveredPersonSlug)}`,
      { includeAuth: true }
    );
    totalDuration = roundDurationMs(totalDuration + countRes.durationMs);
    if (!countRes.ok) {
      violations.push(`${pluginId}: /api/observability/page-visits probe failed: ${countRes.message}`);
    } else if (countRes.status !== 200) {
      violations.push(`${pluginId}: /api/observability/page-visits returned HTTP ${countRes.status}.`);
    } else {
      const countJson = parseJsonSafe(countRes.bodyText);
      const validCount =
        isObjectRecord(countJson) &&
        typeof countJson['total_views'] === 'number' &&
        Number.isInteger(countJson['total_views']) &&
        countJson['total_views'] >= 0;
      if (!validCount) {
        violations.push(`${pluginId}: /api/observability/page-visits returned invalid total_views.`);
      } else {
        badgeSummary = `badges=on sample_views=${countJson['total_views']}`;
      }
    }
  }

  return {
    pluginId,
    status: violations.length === 0 ? 'pass' : 'fail',
    httpStatus: res.status,
    durationMs: totalDuration,
    detail: `Healthy (${badgeSummary})`,
    violations,
  };
}

async function checkOpenFinance(
  transport: PluginProbeTransport,
  isPrivateArchive: boolean,
  expected: boolean
): Promise<SinglePluginProbeResult> {
  const pluginId = 'kinloom-open-finance';
  const res = await fetchEndpoint(transport, '/api/open-finance/summary', { includeAuth: true });
  if (!res.ok) {
    const violation = `${pluginId}: /api/open-finance/summary probe failed: ${res.message}`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: null,
      durationMs: res.durationMs,
      detail: res.message,
      violations: [violation],
    };
  }
  if (res.status === 404) {
    if (expected) {
      const violation = `${pluginId}: expected active plugin, but /api/open-finance/summary returned HTTP 404.`;
      return {
        pluginId,
        status: 'fail',
        httpStatus: 404,
        durationMs: res.durationMs,
        detail: 'Route /api/open-finance/summary returned 404',
        violations: [violation],
      };
    }
    return {
      pluginId,
      status: 'skipped',
      httpStatus: 404,
      durationMs: res.durationMs,
      detail: 'Not registered (HTTP 404)',
      violations: [],
    };
  }
  if (res.status !== 200) {
    const violation = `${pluginId}: /api/open-finance/summary returned HTTP ${res.status}.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Unexpected HTTP ${res.status}`,
      violations: [violation],
    };
  }

  const violations: string[] = [];
  const parsed = parseJsonSafe(res.bodyText);
  const platforms = isObjectRecord(parsed) && Array.isArray(parsed['platforms']) ? parsed['platforms'] : null;
  const validShape =
    isObjectRecord(parsed) &&
    isObjectRecord(parsed['visibility']) &&
    platforms !== null &&
    Array.isArray(parsed['cost_items']);
  if (!validShape || platforms === null) {
    violations.push(`${pluginId}: /api/open-finance/summary returned invalid JSON schema.`);
  } else {
    for (const platform of platforms) {
      const url = isObjectRecord(platform) ? platform['url'] : null;
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        violations.push(`${pluginId}: donation platform URL must use https://.`);
        break;
      }
    }
  }

  const cacheControl = (res.headers.get('cache-control') ?? '').toLowerCase();
  if (isPrivateArchive && cacheControl.includes('public')) {
    violations.push(`${pluginId}: private archive /api/open-finance/summary returned public Cache-Control.`);
  }

  const platformCount = validShape && platforms !== null ? platforms.length : 0;
  return {
    pluginId,
    status: violations.length === 0 ? 'pass' : 'fail',
    httpStatus: res.status,
    durationMs: res.durationMs,
    detail: `Healthy (platforms=${platformCount})`,
    violations,
  };
}

async function checkRecipes(
  transport: PluginProbeTransport,
  expected: boolean
): Promise<SinglePluginProbeResult> {
  const pluginId = 'kinloom-recipes';
  const res = await fetchEndpoint(transport, '/api/plugins/recipes?limit=1', { includeAuth: true });
  if (!res.ok) {
    const violation = `${pluginId}: /api/plugins/recipes probe failed: ${res.message}`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: null,
      durationMs: res.durationMs,
      detail: res.message,
      violations: [violation],
    };
  }
  if (res.status === 404) {
    if (expected) {
      const violation = `${pluginId}: expected active plugin, but /api/plugins/recipes returned HTTP 404.`;
      return {
        pluginId,
        status: 'fail',
        httpStatus: 404,
        durationMs: res.durationMs,
        detail: 'Route /api/plugins/recipes returned 404',
        violations: [violation],
      };
    }
    return {
      pluginId,
      status: 'skipped',
      httpStatus: 404,
      durationMs: res.durationMs,
      detail: 'Not registered (HTTP 404)',
      violations: [],
    };
  }
  if (res.status !== 200) {
    const code = readErrorCode(parseJsonSafe(res.bodyText));
    const suffix = code ? ` (${code})` : '';
    const violation = `${pluginId}: /api/plugins/recipes returned HTTP ${res.status}${suffix}.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Failed with HTTP ${res.status}${suffix}`,
      violations: [violation],
    };
  }

  const parsed = parseJsonSafe(res.bodyText);
  if (!isObjectRecord(parsed) || !Array.isArray(parsed['recipes'])) {
    const violation = `${pluginId}: /api/plugins/recipes returned invalid JSON schema.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: 'Invalid recipes response payload',
      violations: [violation],
    };
  }

  return {
    pluginId,
    status: 'pass',
    httpStatus: res.status,
    durationMs: res.durationMs,
    detail: `Healthy (sampled=${parsed['recipes'].length})`,
    violations: [],
  };
}

async function checkBookPublishing(
  transport: PluginProbeTransport,
  expected: boolean
): Promise<SinglePluginProbeResult> {
  const pluginId = 'kinloom-book-publishing';
  const res = await fetchEndpoint(transport, '/api/plugins/book-publishing/status', { includeAuth: true });
  if (!res.ok) {
    const violation = `${pluginId}: /api/plugins/book-publishing/status probe failed: ${res.message}`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: null,
      durationMs: res.durationMs,
      detail: res.message,
      violations: [violation],
    };
  }
  if (res.status === 404) {
    if (expected) {
      const violation = `${pluginId}: expected active plugin, but /api/plugins/book-publishing/status returned HTTP 404.`;
      return {
        pluginId,
        status: 'fail',
        httpStatus: 404,
        durationMs: res.durationMs,
        detail: 'Route /api/plugins/book-publishing/status returned 404',
        violations: [violation],
      };
    }
    return {
      pluginId,
      status: 'skipped',
      httpStatus: 404,
      durationMs: res.durationMs,
      detail: 'Not registered (HTTP 404)',
      violations: [],
    };
  }
  if (res.status === 200) {
    return {
      pluginId,
      status: 'pass',
      httpStatus: 200,
      durationMs: res.durationMs,
      detail: 'Healthy (HTTP 200)',
      violations: [],
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      pluginId,
      status: 'pass',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Registered and admin-protected (HTTP ${res.status})`,
      violations: [],
    };
  }

  const violation = `${pluginId}: /api/plugins/book-publishing/status returned HTTP ${res.status}.`;
  return {
    pluginId,
    status: 'fail',
    httpStatus: res.status,
    durationMs: res.durationMs,
    detail: `Unexpected HTTP ${res.status}`,
    violations: [violation],
  };
}

async function checkPronunciation(
  transport: PluginProbeTransport,
  expected: boolean
): Promise<SinglePluginProbeResult> {
  const pluginId = 'kinloom-pronunciation';
  const res = await fetchEndpoint(transport, '/api/pronunciations', { includeAuth: true });
  if (!res.ok) {
    const violation = `${pluginId}: /api/pronunciations probe failed: ${res.message}`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: null,
      durationMs: res.durationMs,
      detail: res.message,
      violations: [violation],
    };
  }
  if (res.status === 404) {
    if (expected) {
      const violation = `${pluginId}: expected active plugin, but /api/pronunciations returned HTTP 404.`;
      return {
        pluginId,
        status: 'fail',
        httpStatus: 404,
        durationMs: res.durationMs,
        detail: 'Route /api/pronunciations returned 404',
        violations: [violation],
      };
    }
    return {
      pluginId,
      status: 'skipped',
      httpStatus: 404,
      durationMs: res.durationMs,
      detail: 'Not registered (HTTP 404)',
      violations: [],
    };
  }
  if (res.status !== 200) {
    const violation = `${pluginId}: /api/pronunciations returned HTTP ${res.status}.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Unexpected HTTP ${res.status}`,
      violations: [violation],
    };
  }

  const parsed = parseJsonSafe(res.bodyText);
  if (!isObjectRecord(parsed) || !isObjectRecord(parsed['pronunciations'])) {
    const violation = `${pluginId}: /api/pronunciations returned invalid JSON schema.`;
    return {
      pluginId,
      status: 'fail',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: 'Invalid pronunciations response payload',
      violations: [violation],
    };
  }

  const cacheControl = (res.headers.get('cache-control') ?? '').toLowerCase();
  const termCount = Object.keys(parsed['pronunciations']).length;
  if (!cacheControl.includes('no-store')) {
    return {
      pluginId,
      status: 'warn',
      httpStatus: res.status,
      durationMs: res.durationMs,
      detail: `Loaded ${termCount} term(s), but Cache-Control omitted no-store`,
      violations: [],
    };
  }

  return {
    pluginId,
    status: 'pass',
    httpStatus: res.status,
    durationMs: res.durationMs,
    detail: `Healthy (terms=${termCount})`,
    violations: [],
  };
}

async function checkAdminDiagnostics(
  transport: PluginProbeTransport
): Promise<{ readonly checked: boolean; readonly violations: readonly string[] }> {
  if (!transport.token?.trim()) {
    return { checked: false, violations: [] };
  }

  let route = '/api/admin/system';
  let res = await fetchEndpoint(transport, route, { includeAuth: true });
  if (res.ok && res.status === 404) {
    route = '/api/admin/diagnostics';
    res = await fetchEndpoint(transport, route, { includeAuth: true });
  }
  if (!res.ok) {
    return { checked: true, violations: [`Admin diagnostics probe (${route}) failed: ${res.message}`] };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    return { checked: false, violations: [] };
  }
  if (res.status >= 500 || res.status !== 200) {
    return {
      checked: true,
      violations: [`Admin diagnostics (${route}) returned HTTP ${res.status}.`],
    };
  }

  const parsed = parseJsonSafe(res.bodyText);
  if (!isObjectRecord(parsed)) {
    return {
      checked: true,
      violations: [`Admin diagnostics (${route}) returned invalid JSON.`],
    };
  }

  const violations: string[] = [];
  const pluginsField = parsed['plugins'];
  if (Array.isArray(pluginsField)) {
    for (const entry of pluginsField) {
      if (!isObjectRecord(entry)) {
        continue;
      }
      const id = typeof entry['id'] === 'string' ? entry['id'] : 'unknown';
      const status = typeof entry['status'] === 'string' ? entry['status'] : '';
      if (status === 'degraded' || status === 'error') {
        const detail =
          typeof entry['detail'] === 'string' && entry['detail'].trim() ? `: ${entry['detail']}` : '';
        violations.push(`Admin diagnostics reported plugin '${id}' in '${status}' state${detail}.`);
      }
    }
  }
  return { checked: true, violations };
}

async function runPrivateArchiveLeakGuard(transport: PluginProbeTransport): Promise<{
  readonly isPrivateArchive: boolean;
  readonly leakGuardPassed: boolean | null;
  readonly violations: readonly string[];
}> {
  if (!transport.token?.trim()) {
    return { isPrivateArchive: false, leakGuardPassed: null, violations: [] };
  }

  const anonBundle = await fetchEndpoint(transport, '/api/bundle', { includeAuth: false });
  if (!anonBundle.ok || anonBundle.status !== 401) {
    return { isPrivateArchive: false, leakGuardPassed: null, violations: [] };
  }

  const guardedRoutes = [
    '/api/open-finance/summary',
    '/api/observability/page-visits',
    '/api/plugins/recipes',
    '/api/pronunciations',
  ] as const;

  const violations: string[] = [];
  for (const route of guardedRoutes) {
    const anonRes = await fetchEndpoint(transport, route, { includeAuth: false });
    if (anonRes.ok && anonRes.status === 200) {
      violations.push(`Private archive leak: unauthenticated GET ${route} returned HTTP 200.`);
    }
  }

  return {
    isPrivateArchive: true,
    leakGuardPassed: violations.length === 0,
    violations,
  };
}

/**
 * Runs non-destructive live plugin health checks, optional admin diagnostics inspection,
 * and private-archive leak verification against a Kinloom deployment.
 */
export async function runPluginHealthProbes(input: RunPluginHealthProbesInput): Promise<PluginProbesReport> {
  const expectedSet = new Set(input.expectPlugins);
  const leakGuard = await runPrivateArchiveLeakGuard(input.transport);

  const checks: SinglePluginProbeResult[] = [
    checkWorkersObservability(input.bundleCold, expectedSet.has('kinloom-workers-observability')),
    checkWebAnalytics(input.htmlBody, expectedSet.has('kinloom-web-analytics')),
    await checkPageVisitStats(
      input.transport,
      leakGuard.isPrivateArchive,
      input.discoveredPersonSlug,
      expectedSet.has('kinloom-page-visit-stats')
    ),
    await checkOpenFinance(
      input.transport,
      leakGuard.isPrivateArchive,
      expectedSet.has('kinloom-open-finance')
    ),
    await checkRecipes(input.transport, expectedSet.has('kinloom-recipes')),
    await checkBookPublishing(input.transport, expectedSet.has('kinloom-book-publishing')),
    await checkPronunciation(input.transport, expectedSet.has('kinloom-pronunciation')),
  ];

  const violations: string[] = [];
  for (const check of checks) {
    violations.push(...check.violations);
  }
  for (const expectedId of input.expectPlugins) {
    if (!KNOWN_PLUGIN_CHECK_IDS.has(expectedId)) {
      violations.push(`Unknown expected plugin ID '${expectedId}' in --expect-plugins.`);
    }
  }

  const diagnostics = await checkAdminDiagnostics(input.transport);
  violations.push(...diagnostics.violations);
  violations.push(...leakGuard.violations);

  return {
    status: violations.length === 0 ? 'pass' : 'fail',
    checks,
    leakGuardPassed: leakGuard.leakGuardPassed,
    diagnosticsChecked: diagnostics.checked,
    violations,
  };
}
