import { performance } from 'node:perf_hooks';
import {
  discoverFirstMediaPathFromBundle,
  emptyServerTiming,
  evaluateSecurityHeaders,
  normalizeProbeBaseUrl,
  normalizeSameOriginMediaPath,
  parseServerTimingHeader,
  resolveProbeBudgets,
  roundDurationMs,
} from './syntheticProbeParsing.js';
import {
  type BundleColdProbeResult,
  type BundleProbeResult,
  type BundleWarmProbeResult,
  DEFAULT_MEDIA_RANGE_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  type HtmlProbeResult,
  type MediaRangeProbeResult,
  type MediaRangeSource,
  type RunSyntheticProbeInput,
  type SyntheticProbeBudgets,
  type SyntheticProbeClock,
  type SyntheticProbeReport,
} from './syntheticProbeTypes.js';

const DEFAULT_CLOCK: SyntheticProbeClock = {
  now: () => performance.now(),
  nowIso: () => new Date().toISOString(),
};

interface ProbeTransport {
  readonly baseUrl: URL;
  readonly budgets: SyntheticProbeBudgets;
  readonly token?: string;
  readonly timeoutMs: number;
  readonly fetchImpl: typeof fetch;
  readonly clock: SyntheticProbeClock;
}

function buildProbeEndpointUrl(baseUrl: URL, routePath: string): string {
  const cleanRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;
  const basePath = baseUrl.pathname === '/' ? '' : baseUrl.pathname;
  return `${baseUrl.origin}${basePath}${cleanRoute}`;
}

function createBaseRequestHeaders(token?: string, extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  if (token?.trim()) {
    headers.set('authorization', `Bearer ${token.trim()}`);
  }
  return headers;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runHtmlProbe(transport: ProbeTransport): Promise<HtmlProbeResult> {
  const url = buildProbeEndpointUrl(transport.baseUrl, '/');
  const isHttps = transport.baseUrl.protocol === 'https:';
  const startedAt = transport.clock.now();
  const violations: string[] = [];

  try {
    const response = await fetchWithTimeout(
      transport.fetchImpl,
      url,
      {
        method: 'GET',
        redirect: 'follow',
        headers: createBaseRequestHeaders(transport.token, { accept: 'text/html,application/xhtml+xml' }),
      },
      transport.timeoutMs
    );
    const ttfbMs = roundDurationMs(transport.clock.now() - startedAt);
    const body = await response.arrayBuffer();
    const totalMs = roundDurationMs(transport.clock.now() - startedAt);
    const securityHeaders = evaluateSecurityHeaders(response.headers, isHttps);

    if (response.status < 200 || response.status >= 300) {
      violations.push(`HTML root returned HTTP ${response.status} (expected 2xx).`);
    }
    if (ttfbMs > transport.budgets.maxHtmlTtfbMs) {
      violations.push(`HTML TTFB ${ttfbMs} ms exceeded budget of ${transport.budgets.maxHtmlTtfbMs} ms.`);
    }
    if (transport.budgets.requireSecurityHeaders && !securityHeaders.ok) {
      violations.push(`Missing required security header(s): ${securityHeaders.missing.join(', ')}.`);
    }

    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      url,
      httpStatus: response.status,
      ttfbMs,
      totalMs,
      bytes: body.byteLength,
      securityHeaders,
      violations,
    };
  } catch (err: unknown) {
    const totalMs = roundDurationMs(transport.clock.now() - startedAt);
    const message = err instanceof Error ? err.message : String(err);
    violations.push(`HTML root probe failed: ${message}`);
    return {
      status: 'fail',
      url,
      httpStatus: null,
      ttfbMs: totalMs,
      totalMs,
      bytes: 0,
      securityHeaders: evaluateSecurityHeaders(new Headers(), isHttps),
      violations,
      error: message,
    };
  }
}

async function runBundleWarmProbe(
  transport: ProbeTransport,
  url: string,
  coldEtag: string | null,
  violations: string[]
): Promise<BundleWarmProbeResult> {
  if (!coldEtag) {
    if (transport.budgets.require304) {
      violations.push('/api/bundle cold response omitted ETag header; cannot verify 304 Not Modified.');
      return {
        status: 'fail',
        httpStatus: null,
        durationMs: 0,
        etag: null,
        cacheControl: null,
        serverTiming: emptyServerTiming(),
        error: 'Missing ETag on cold /api/bundle response.',
      };
    }
    return {
      status: 'skipped',
      reason: 'Cold /api/bundle response omitted ETag header.',
      httpStatus: null,
      durationMs: null,
      etag: null,
      cacheControl: null,
      serverTiming: emptyServerTiming(),
    };
  }

  const warmStart = transport.clock.now();
  try {
    const response = await fetchWithTimeout(
      transport.fetchImpl,
      url,
      {
        method: 'GET',
        headers: createBaseRequestHeaders(transport.token, {
          accept: 'application/json',
          'if-none-match': coldEtag,
        }),
      },
      transport.timeoutMs
    );
    await response.arrayBuffer();
    const warmDurationMs = roundDurationMs(transport.clock.now() - warmStart);
    const warmViolations: string[] = [];

    if (transport.budgets.require304 && response.status !== 304) {
      warmViolations.push(
        `/api/bundle conditional request returned HTTP ${response.status} (expected 304 Not Modified).`
      );
    } else if (!transport.budgets.require304 && response.status !== 304 && response.status !== 200) {
      warmViolations.push(
        `/api/bundle conditional request returned HTTP ${response.status} (expected 304 or 200).`
      );
    }
    if (warmDurationMs > transport.budgets.maxBundleWarmMs) {
      warmViolations.push(
        `/api/bundle warm latency ${warmDurationMs} ms exceeded budget of ${transport.budgets.maxBundleWarmMs} ms.`
      );
    }
    violations.push(...warmViolations);
    return {
      status: warmViolations.length === 0 ? 'pass' : 'fail',
      httpStatus: response.status,
      durationMs: warmDurationMs,
      etag: response.headers.get('etag'),
      cacheControl: response.headers.get('cache-control'),
      serverTiming: parseServerTimingHeader(response.headers.get('server-timing')),
    };
  } catch (err: unknown) {
    const warmDurationMs = roundDurationMs(transport.clock.now() - warmStart);
    const message = err instanceof Error ? err.message : String(err);
    violations.push(`/api/bundle conditional probe failed: ${message}`);
    return {
      status: 'fail',
      httpStatus: null,
      durationMs: warmDurationMs,
      etag: null,
      cacheControl: null,
      serverTiming: emptyServerTiming(),
      error: message,
    };
  }
}

async function runBundleProbe(
  transport: ProbeTransport
): Promise<{ readonly result: BundleProbeResult; readonly discoveredMediaPath: string | null }> {
  const url = buildProbeEndpointUrl(transport.baseUrl, '/api/bundle');
  const violations: string[] = [];
  let discoveredMediaPath: string | null = null;
  let cold: BundleColdProbeResult;

  const coldStart = transport.clock.now();
  try {
    const response = await fetchWithTimeout(
      transport.fetchImpl,
      url,
      {
        method: 'GET',
        headers: createBaseRequestHeaders(transport.token, { accept: 'application/json' }),
      },
      transport.timeoutMs
    );
    const bodyBytes = await response.arrayBuffer();
    const coldDurationMs = roundDurationMs(transport.clock.now() - coldStart);
    cold = {
      httpStatus: response.status,
      durationMs: coldDurationMs,
      bytes: bodyBytes.byteLength,
      etag: response.headers.get('etag'),
      cacheControl: response.headers.get('cache-control'),
      serverTiming: parseServerTimingHeader(response.headers.get('server-timing')),
    };

    if (response.status < 200 || response.status >= 300) {
      violations.push(`/api/bundle cold request returned HTTP ${response.status} (expected 2xx).`);
    } else {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bodyBytes));
        discoveredMediaPath = discoverFirstMediaPathFromBundle(parsed);
      } catch {
        // Non-JSON payload still records latency; media discovery stays null.
      }
    }

    if (coldDurationMs > transport.budgets.maxBundleColdMs) {
      violations.push(
        `/api/bundle cold latency ${coldDurationMs} ms exceeded budget of ${transport.budgets.maxBundleColdMs} ms.`
      );
    }
  } catch (err: unknown) {
    const coldDurationMs = roundDurationMs(transport.clock.now() - coldStart);
    const message = err instanceof Error ? err.message : String(err);
    cold = {
      httpStatus: null,
      durationMs: coldDurationMs,
      bytes: 0,
      etag: null,
      cacheControl: null,
      serverTiming: emptyServerTiming(),
      error: message,
    };
    violations.push(`/api/bundle cold probe failed: ${message}`);
  }

  const warm = await runBundleWarmProbe(transport, url, cold.etag, violations);
  return {
    discoveredMediaPath,
    result: {
      status: violations.length === 0 ? 'pass' : 'fail',
      url,
      cold,
      warm,
      violations,
    },
  };
}

async function runMediaRangeProbe(
  transport: ProbeTransport,
  mediaPath: string | null,
  source: MediaRangeSource | null,
  mediaRangeBytes: number
): Promise<MediaRangeProbeResult> {
  if (!mediaPath || !source) {
    return {
      status: 'skipped',
      reason: 'No media path provided or discovered in /api/bundle.',
      violations: [],
    };
  }
  const normalizedPath = normalizeSameOriginMediaPath(mediaPath);
  if (!normalizedPath) {
    return {
      status: 'skipped',
      reason: `Ignoring non-relative media path '${mediaPath}'.`,
      violations: [],
    };
  }

  const url = buildProbeEndpointUrl(transport.baseUrl, normalizedPath);
  const rangeEnd = Math.max(0, Math.floor(mediaRangeBytes) - 1);
  const rangeHeader = `bytes=0-${rangeEnd}`;
  const violations: string[] = [];
  const startedAt = transport.clock.now();

  try {
    const response = await fetchWithTimeout(
      transport.fetchImpl,
      url,
      {
        method: 'GET',
        headers: createBaseRequestHeaders(transport.token, { range: rangeHeader }),
      },
      transport.timeoutMs
    );
    const body = await response.arrayBuffer();
    const durationMs = roundDurationMs(transport.clock.now() - startedAt);
    const acceptRanges = response.headers.get('accept-ranges');
    const contentRange = response.headers.get('content-range');
    const serverTiming = parseServerTimingHeader(response.headers.get('server-timing'));

    if (transport.budgets.require206) {
      if (response.status !== 206) {
        violations.push(
          `Media range request returned HTTP ${response.status} (expected 206 Partial Content).`
        );
      }
      if (!contentRange || !/^bytes\s+\d+-\d+\/(\d+|\*)$/i.test(contentRange.trim())) {
        violations.push('Media 206 response missing valid Content-Range header.');
      }
      if (!acceptRanges?.toLowerCase().includes('bytes')) {
        violations.push("Media 206 response missing 'Accept-Ranges: bytes' header.");
      }
    } else if (response.status !== 206 && response.status !== 200) {
      violations.push(`Media range request returned HTTP ${response.status} (expected 206 or 200).`);
    }

    if (durationMs > transport.budgets.maxMediaRangeMs) {
      violations.push(
        `Media range latency ${durationMs} ms exceeded budget of ${transport.budgets.maxMediaRangeMs} ms.`
      );
    }

    return {
      status: violations.length === 0 ? 'pass' : 'fail',
      url,
      source,
      rangeHeader,
      httpStatus: response.status,
      durationMs,
      bytes: body.byteLength,
      acceptRanges,
      contentRange,
      serverTiming,
      violations,
    };
  } catch (err: unknown) {
    const durationMs = roundDurationMs(transport.clock.now() - startedAt);
    const message = err instanceof Error ? err.message : String(err);
    violations.push(`Media range probe failed: ${message}`);
    return {
      status: 'fail',
      url,
      source,
      rangeHeader,
      httpStatus: null,
      durationMs,
      bytes: 0,
      acceptRanges: null,
      contentRange: null,
      serverTiming: emptyServerTiming(),
      violations,
      error: message,
    };
  }
}

/**
 * Executes the full synthetic performance probe sequence against a Kinloom archive URL.
 */
export async function runSyntheticProbe(input: RunSyntheticProbeInput): Promise<SyntheticProbeReport> {
  const baseUrl = normalizeProbeBaseUrl(input.targetUrl);
  const budgets = resolveProbeBudgets(input.budgets);
  const clock = input.clock ?? DEFAULT_CLOCK;
  const transport: ProbeTransport = {
    baseUrl,
    budgets,
    token: input.token,
    timeoutMs: input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    fetchImpl: input.fetchImpl ?? globalThis.fetch,
    clock,
  };

  const startedAt = clock.now();
  const timestamp = clock.nowIso();

  const html = await runHtmlProbe(transport);
  const bundleRun = await runBundleProbe(transport);

  const chosenMediaPath = input.mediaPath?.trim() ? input.mediaPath.trim() : bundleRun.discoveredMediaPath;
  const chosenMediaSource: MediaRangeSource | null = input.mediaPath?.trim()
    ? (input.mediaPathSource ?? 'option')
    : bundleRun.discoveredMediaPath
      ? 'bundle'
      : null;

  const mediaRange = await runMediaRangeProbe(
    transport,
    chosenMediaPath,
    chosenMediaSource,
    input.mediaRangeBytes ?? DEFAULT_MEDIA_RANGE_BYTES
  );

  const violations = [...html.violations, ...bundleRun.result.violations, ...mediaRange.violations];
  const durationMs = roundDurationMs(clock.now() - startedAt);

  return {
    ok: violations.length === 0,
    targetUrl: baseUrl.toString().replace(/\/$/, ''),
    timestamp,
    durationMs,
    budgets,
    html,
    bundle: bundleRun.result,
    mediaRange,
    violations,
  };
}
