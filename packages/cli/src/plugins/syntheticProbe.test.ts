import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../errors.js';
import {
  discoverSiteCliPlugins,
  isBuiltInCliCommand,
  RESERVED_VERIFY_CHECK_IDS,
  resolvePluginCommands,
  runRegisteredCheck,
} from '../plugins.js';
import {
  createSyntheticProbePlugin,
  discoverFirstDeceasedPersonSlugFromBundle,
  discoverFirstMediaPathFromBundle,
  evaluateSecurityHeaders,
  normalizeProbeBaseUrl,
  parseExpectedPluginsCsv,
  parseServerTimingHeader,
  resolveProbeToken,
  runSyntheticProbe,
  SYNTHETIC_PROBE_COMMAND_NAME,
  SYNTHETIC_PROBE_PLUGIN_ID,
  SYNTHETIC_PROBE_VERIFY_CHECK_ID,
  type SyntheticProbeClock,
  type SyntheticProbeReport,
} from './syntheticProbe.js';

const openServers: http.Server[] = [];
const tempDirs: string[] = [];

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

async function startLocalServer(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function createFullArchiveFixtureHandler(options?: {
  includeMedia?: boolean;
  omitEtag?: boolean;
  ignoreConditional304?: boolean;
  disable206?: boolean;
  omitCsp?: boolean;
  expectedAuthToken?: string;
}): http.RequestListener {
  const bundleEtag = '"bundle-rev-42"';
  const mediaPayload = Buffer.alloc(4096, 0x6b);
  const bundleBody = JSON.stringify({
    meta: { build_mode: 'public', generated_at: '2026-06-15T12:00:00.000Z' },
    people: [],
    media: options?.includeMedia === false ? [] : [{ id: 'med_1', file: '/media/sample-portrait.jpg' }],
  });

  return (req, res) => {
    if (options?.expectedAuthToken && req.headers.authorization !== `Bearer ${options.expectedAuthToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    const securityHeaders: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      ...(options?.omitCsp ? {} : { 'content-security-policy': "default-src 'self'" }),
    };

    if (reqUrl.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...securityHeaders });
      res.end('<!doctype html><html><head><title>Example Archive</title></head><body>OK</body></html>');
      return;
    }

    if (reqUrl.pathname === '/api/bundle') {
      if (
        !options?.omitEtag &&
        !options?.ignoreConditional304 &&
        req.headers['if-none-match'] === bundleEtag
      ) {
        res.writeHead(304, {
          etag: bundleEtag,
          'cache-control': 'private, no-cache',
          'server-timing': 'bundle;dur=1.2, total;dur=2.4',
          ...securityHeaders,
        });
        res.end();
        return;
      }

      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        ...(options?.omitEtag ? {} : { etag: bundleEtag }),
        'cache-control': 'private, no-cache',
        'server-timing': 'd1;dur=2.45, r2;dur=6.1, bundle;dur=9.2, total;dur=11.8',
        ...securityHeaders,
      });
      res.end(bundleBody);
      return;
    }

    if (reqUrl.pathname === '/media/sample-portrait.jpg' || reqUrl.pathname === '/media/custom-scan.jpg') {
      const rangeHeader = req.headers.range;
      if (!options?.disable206 && typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
        const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
        const start = match ? Number(match[1]) : 0;
        const end = Math.min(match ? Number(match[2]) : 1023, mediaPayload.byteLength - 1);
        const slice = mediaPayload.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'image/jpeg',
          'content-length': String(slice.byteLength),
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${mediaPayload.byteLength}`,
          'server-timing': 'r2;dur=4.5, total;dur=5.1',
          ...securityHeaders,
        });
        res.end(slice);
        return;
      }

      res.writeHead(200, {
        'content-type': 'image/jpeg',
        'content-length': String(mediaPayload.byteLength),
        ...securityHeaders,
      });
      res.end(mediaPayload);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  };
}

function createSteppedClock(timestampsMs: readonly number[]): SyntheticProbeClock {
  let index = 0;
  return {
    now: () => timestampsMs[Math.min(index++, timestampsMs.length - 1)] ?? 0,
    nowIso: () => '2026-06-15T12:00:00.000Z',
  };
}

afterEach(async () => {
  while (openServers.length > 0) {
    const srv = openServers.pop();
    if (srv) await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('synthetic probe plugin default-off isolation and registration', () => {
  it('stays completely absent from the standard CLI when not registered', async () => {
    expect(isBuiltInCliCommand(SYNTHETIC_PROBE_COMMAND_NAME)).toBe(false);
    expect(RESERVED_VERIFY_CHECK_IDS.has(SYNTHETIC_PROBE_VERIFY_CHECK_ID)).toBe(false);

    const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-probe-off-'));
    tempDirs.push(emptyDir);

    const helpCap = createCaptureIo();
    expect(await runCli(['--help'], { cwd: emptyDir, io: helpCap.io })).toBe(EXIT_OK);
    expect(helpCap.stdout.join('\n')).not.toContain('Site plugin commands:');
    expect(helpCap.stdout.join('\n')).not.toContain('kinloom probe');

    const unknownCap = createCaptureIo();
    expect(
      await runCli(['probe', '--url', 'https://archive.example.test'], { cwd: emptyDir, io: unknownCap.io })
    ).toBe(EXIT_USAGE);
    expect(unknownCap.stderr.join('\n')).toContain("Unknown command 'probe'");
  });

  it('returns an inert no-op plugin when enabled is false and loads with zero discovery warnings', async () => {
    const disabled = createSyntheticProbePlugin({
      enabled: false,
      attachVerifyCheck: true,
      targetUrl: 'https://archive.example.test',
    });
    expect(disabled.id).toBe(SYNTHETIC_PROBE_PLUGIN_ID);
    expect(disabled.commands).toEqual([]);
    expect(disabled.verifyChecks).toBeUndefined();

    const resolved = resolvePluginCommands([disabled]);
    expect(resolved.plugins).toEqual([]);
    expect(resolved.commands.size).toBe(0);
    expect(resolved.verifyChecks).toEqual([]);

    const siteDir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-probe-disabled-ext-'));
    tempDirs.push(siteDir);
    const extDir = path.join(siteDir, 'extensions', 'synthetic-probe');
    await mkdir(extDir, { recursive: true });
    await writeFile(
      path.join(extDir, 'cli.mjs'),
      `export default {
  id: '${SYNTHETIC_PROBE_PLUGIN_ID}',
  name: 'Kinloom Synthetic Performance Probe (disabled)',
  commands: [],
};
`,
      'utf8'
    );

    const discovered = await discoverSiteCliPlugins(siteDir);
    expect(discovered.warnings).toEqual([]);
    expect(discovered.plugins).toEqual([]);
  });

  it('registers only the probe command by default without attaching verify checks', () => {
    const plugin = createSyntheticProbePlugin();
    const resolved = resolvePluginCommands([plugin]);
    expect(resolved.commands.has('probe')).toBe(true);
    expect(resolved.verifyChecks).toEqual([]);
    expect(resolved.auditChecks).toEqual([]);
  });
});

describe('synthetic probe pure parsers and boundary validation', () => {
  it('parses RFC Server-Timing headers into canonical and general millisecond spans', () => {
    const parsed = parseServerTimingHeader(
      'd1;dur=2.45;desc="D1 SQL", r2;dur=6.1, bundle;dur=9.2, total;dur=11.8, edge;dur=0.5'
    );
    expect(parsed.spansMs).toEqual({ d1: 2.45, r2: 6.1, bundle: 9.2, total: 11.8 });
    expect(parsed.allSpansMs).toEqual({ d1: 2.45, r2: 6.1, bundle: 9.2, total: 11.8, edge: 0.5 });

    expect(parseServerTimingHeader(null)).toEqual({ raw: null, spansMs: {}, allSpansMs: {} });
  });

  it('enforces HSTS on HTTPS origins and checks baseline security headers on HTTP', () => {
    const headers = new Headers({
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
    });

    const httpResult = evaluateSecurityHeaders(headers, false);
    expect(httpResult.ok).toBe(true);
    expect(httpResult.missing).toEqual([]);

    const httpsMissingHsts = evaluateSecurityHeaders(headers, true);
    expect(httpsMissingHsts.ok).toBe(false);
    expect(httpsMissingHsts.missing).toEqual(['strict-transport-security']);

    headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
    expect(evaluateSecurityHeaders(headers, true).ok).toBe(true);
  });

  it('discovers only safe same-origin media paths from /api/bundle payloads', () => {
    expect(
      discoverFirstMediaPathFromBundle({
        media: [{ file: 'https://external.example.test/skip.jpg' }, { file: '/media/portrait.jpg' }],
      })
    ).toBe('/media/portrait.jpg');
    expect(discoverFirstMediaPathFromBundle({ media: [{ file: '//evil.example/a.jpg' }] })).toBeNull();
    expect(discoverFirstMediaPathFromBundle({ media: [] })).toBeNull();
    expect(discoverFirstMediaPathFromBundle(null)).toBeNull();
  });

  it('rejects non-HTTP target URLs at the boundary', () => {
    expect(normalizeProbeBaseUrl('https://archive.example.test/').toString()).toBe(
      'https://archive.example.test/'
    );
    expect(() => normalizeProbeBaseUrl('ftp://archive.example.test')).toThrow(/Unsupported URL protocol/);
    expect(() => normalizeProbeBaseUrl('not-a-url')).toThrow(/Invalid target URL/);
  });
});

describe('synthetic probe against a real local HTTP server', () => {
  it('passes HTML, bundle cold/304 warm + Server-Timing, and R2 media 206 probes in both JSON and text CLI modes', async () => {
    const baseUrl = await startLocalServer(createFullArchiveFixtureHandler());
    const plugin = createSyntheticProbePlugin();

    const jsonCap = createCaptureIo();
    const jsonExit = await runCli(['probe', '--url', baseUrl, '--json'], {
      io: jsonCap.io,
      plugins: [plugin],
    });
    expect(jsonExit).toBe(EXIT_OK);
    expect(jsonCap.stderr).toEqual([]);

    const report = JSON.parse(jsonCap.stdout.join('\n')) as SyntheticProbeReport;
    expect(report.ok).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.html.status).toBe('pass');
    expect(report.html.httpStatus).toBe(200);
    expect(report.html.securityHeaders.ok).toBe(true);
    expect(report.bundle.status).toBe('pass');
    expect(report.bundle.cold.httpStatus).toBe(200);
    expect(report.bundle.cold.etag).toBe('"bundle-rev-42"');
    expect(report.bundle.cold.serverTiming.spansMs).toEqual({
      d1: 2.45,
      r2: 6.1,
      bundle: 9.2,
      total: 11.8,
    });
    expect(report.bundle.warm.status).toBe('pass');
    expect(report.bundle.warm.httpStatus).toBe(304);
    expect(report.bundle.warm.serverTiming.spansMs).toEqual({ bundle: 1.2, total: 2.4 });
    expect(report.mediaRange.status).toBe('pass');
    if (report.mediaRange.status !== 'skipped') {
      expect(report.mediaRange.source).toBe('bundle');
      expect(report.mediaRange.httpStatus).toBe(206);
      expect(report.mediaRange.bytes).toBe(1024);
      expect(report.mediaRange.contentRange).toBe('bytes 0-1023/4096');
      expect(report.mediaRange.acceptRanges).toBe('bytes');
      expect(report.mediaRange.serverTiming.spansMs).toEqual({ r2: 4.5, total: 5.1 });
    }

    const textCap = createCaptureIo();
    const textExit = await runCli(['probe', '--url', baseUrl, '--media-path', '/media/custom-scan.jpg'], {
      io: textCap.io,
      plugins: [plugin],
    });
    expect(textExit).toBe(EXIT_OK);
    const rendered = textCap.stdout.join('\n');
    expect(rendered).toContain('Synthetic Probe [PASS]');
    expect(rendered).toContain('1. HTML root: PASS');
    expect(rendered).toContain('3. Bundle warm (If-None-Match): PASS | status=304');
    expect(rendered).toContain('4. Media range (bytes=0-1023): PASS | status=206');
  });

  it('skips the media 206 probe cleanly when the bundle contains no media and no --media-path is supplied', async () => {
    const baseUrl = await startLocalServer(createFullArchiveFixtureHandler({ includeMedia: false }));
    const report = await runSyntheticProbe({ targetUrl: baseUrl });
    expect(report.ok).toBe(true);
    expect(report.mediaRange).toEqual({
      status: 'skipped',
      reason: 'No media path provided or discovered in /api/bundle.',
      violations: [],
    });
  });

  it('sends bearer token authorization without leaking the token into JSON or text output', async () => {
    const secretToken = 'kin_synthetic_test_token_999';
    const baseUrl = await startLocalServer(
      createFullArchiveFixtureHandler({ expectedAuthToken: secretToken })
    );
    const plugin = createSyntheticProbePlugin();
    const cap = createCaptureIo();

    const exitCode = await runCli(['probe', '--url', baseUrl, '--token', secretToken, '--json'], {
      io: cap.io,
      plugins: [plugin],
    });
    expect(exitCode).toBe(EXIT_OK);
    expect(cap.stdout.join('\n')).not.toContain(secretToken);
  });

  it('fails with exit code 1 when 304, 206, or security headers violate budgets and honors --no-require-* flags', async () => {
    const failingUrl = await startLocalServer(
      createFullArchiveFixtureHandler({
        ignoreConditional304: true,
        disable206: true,
        omitCsp: true,
      })
    );
    const plugin = createSyntheticProbePlugin();

    const failCap = createCaptureIo();
    const failExit = await runCli(['probe', '--url', failingUrl, '--json'], {
      io: failCap.io,
      plugins: [plugin],
    });
    expect(failExit).toBe(EXIT_ERROR);
    const failedReport = JSON.parse(failCap.stdout.join('\n')) as SyntheticProbeReport;
    expect(failedReport.ok).toBe(false);
    expect(failedReport.violations).toEqual([
      'Missing required security header(s): content-security-policy.',
      '/api/bundle conditional request returned HTTP 200 (expected 304 Not Modified).',
      'Media range request returned HTTP 200 (expected 206 Partial Content).',
      'Media 206 response missing valid Content-Range header.',
      "Media 206 response missing 'Accept-Ranges: bytes' header.",
    ]);

    const relaxedCap = createCaptureIo();
    const relaxedExit = await runCli(
      ['probe', '--url', failingUrl, '--no-require-304', '--no-require-206', '--no-require-security-headers'],
      { io: relaxedCap.io, plugins: [plugin] }
    );
    expect(relaxedExit).toBe(EXIT_OK);
    expect(relaxedCap.stdout.join('\n')).toContain('Synthetic Probe [PASS]');
  });

  it('returns EXIT_USAGE when --url is missing and no targetUrl is configured', async () => {
    const cap = createCaptureIo();
    const exitCode = await runCli(['probe'], {
      io: cap.io,
      plugins: [createSyntheticProbePlugin()],
    });
    expect(exitCode).toBe(EXIT_USAGE);
    expect(cap.stderr.join('\n')).toContain('Missing target URL');
  });
});

describe('synthetic probe deterministic latency budgets and opt-in verify integration', () => {
  it('flags deterministic TTFB, cold bundle, warm bundle, and media range latency budget breaches', async () => {
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const secHeaders = {
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'strict-transport-security': 'max-age=31536000; includeSubDomains',
      };
      if (url.endsWith('/api/bundle')) {
        if (headers.get('if-none-match') === '"rev-7"') {
          return new Response(null, { status: 304, headers: { etag: '"rev-7"', ...secHeaders } });
        }
        return new Response(JSON.stringify({ media: [{ file: '/media/p.jpg' }] }), {
          status: 200,
          headers: { etag: '"rev-7"', 'content-type': 'application/json', ...secHeaders },
        });
      }
      if (url.endsWith('/media/p.jpg')) {
        return new Response(new Uint8Array(1024), {
          status: 206,
          headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-1023/2048', ...secHeaders },
        });
      }
      return new Response('<html>ok</html>', { status: 200, headers: secHeaders });
    };

    // htmlStart=10->960 (950>800), cold=1000->2800 (1800>1500), warm=2800->3350 (550>400), media=3350->4600 (1250>1000)
    const clock = createSteppedClock([0, 10, 960, 1000, 1000, 2800, 2800, 3350, 3350, 4600, 4600]);

    const plugin = createSyntheticProbePlugin({ fetchImpl: fakeFetch, clock });
    const cap = createCaptureIo();
    const exitCode = await runCli(['probe', '--url', 'https://archive.example.test'], {
      io: cap.io,
      plugins: [plugin],
    });

    expect(exitCode).toBe(EXIT_ERROR);
    const out = cap.stdout.join('\n');
    expect(out).toContain('Synthetic Probe [FAIL]');
    expect(out).toContain('VIOLATION: HTML TTFB 950 ms exceeded budget of 800 ms.');
    expect(out).toContain('VIOLATION: /api/bundle cold latency 1800 ms exceeded budget of 1500 ms.');
    expect(out).toContain('VIOLATION: /api/bundle warm latency 550 ms exceeded budget of 400 ms.');
    expect(out).toContain('VIOLATION: Media range latency 1250 ms exceeded budget of 1000 ms.');
  });

  function createVerifyCtx() {
    return {
      repoDir: '/tmp/example',
      dataDir: '/tmp/example/data',
      siteConfig: {} as never,
      people: [],
      events: [],
      places: [],
      sources: [],
      kinship: [],
      media: [],
      narratives: [],
      strictHygiene: false,
      strictPronunciation: false,
    };
  }

  it('registers an opt-in synthetic-probe verifyCheck only when attachVerifyCheck is true', async () => {
    const baseUrl = await startLocalServer(createFullArchiveFixtureHandler());
    const resolved = resolvePluginCommands([
      createSyntheticProbePlugin({ attachVerifyCheck: true, targetUrl: baseUrl }),
    ]);
    expect(resolved.verifyChecks).toHaveLength(1);
    const reg = resolved.verifyChecks[0];
    expect(reg?.check.id).toBe(SYNTHETIC_PROBE_VERIFY_CHECK_ID);

    const passCheck = await runRegisteredCheck(reg.pluginId, reg.check, createVerifyCtx());
    expect(passCheck.ok).toBe(true);
    expect(passCheck.errors).toEqual([]);
    expect(passCheck.details?.['mediaRangeStatus']).toBe('pass');

    const missingReg = resolvePluginCommands([createSyntheticProbePlugin({ attachVerifyCheck: true })])
      .verifyChecks[0];
    const missingResult = await runRegisteredCheck(missingReg.pluginId, missingReg.check, createVerifyCtx());
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors[0]).toContain("requires a configured 'targetUrl'");
  });
});

describe('synthetic probe --plugins, token fallback, and diagnostics checks', () => {
  it('resolves probe tokens in canonical precedence order and parses bundle person slugs and expected plugin CSVs', () => {
    expect(
      resolveProbeToken('cli-tok', 'opt-tok', {
        KINLOOM_PROBE_TOKEN: 'probe-tok',
        KINLOOM_TOKEN: 'main-tok',
        KINLOOM_AGENT_TOKEN: 'agent-tok',
      })
    ).toBe('cli-tok');
    expect(
      resolveProbeToken('  ', 'opt-tok', {
        KINLOOM_PROBE_TOKEN: 'probe-tok',
        KINLOOM_TOKEN: 'main-tok',
        KINLOOM_AGENT_TOKEN: 'agent-tok',
      })
    ).toBe('opt-tok');
    expect(
      resolveProbeToken(undefined, undefined, {
        KINLOOM_PROBE_TOKEN: 'probe-tok',
        KINLOOM_TOKEN: 'main-tok',
        KINLOOM_AGENT_TOKEN: 'agent-tok',
      })
    ).toBe('probe-tok');
    expect(
      resolveProbeToken(undefined, undefined, {
        KINLOOM_TOKEN: 'main-tok',
        KINLOOM_AGENT_TOKEN: 'agent-tok',
      })
    ).toBe('main-tok');
    expect(
      resolveProbeToken(undefined, undefined, {
        KINLOOM_AGENT_TOKEN: 'agent-tok',
      })
    ).toBe('agent-tok');
    expect(resolveProbeToken(undefined, undefined, {})).toBeUndefined();

    expect(
      discoverFirstDeceasedPersonSlugFromBundle({
        people: [
          null,
          { is_living: true, slug: 'living-relative' },
          { is_living: false, slug: 'abraham-lincoln-1809' },
        ],
      })
    ).toBe('abraham-lincoln-1809');
    expect(
      discoverFirstDeceasedPersonSlugFromBundle({ people: [{ is_living: true, slug: 'x' }] })
    ).toBeNull();
    expect(discoverFirstDeceasedPersonSlugFromBundle({ people: 'invalid' })).toBeNull();
    expect(discoverFirstDeceasedPersonSlugFromBundle(null)).toBeNull();

    expect(parseExpectedPluginsCsv(' kinloom-recipes, kinloom-open-finance, kinloom-recipes, , ')).toEqual([
      'kinloom-recipes',
      'kinloom-open-finance',
    ]);
    expect(parseExpectedPluginsCsv('')).toEqual([]);
    expect(parseExpectedPluginsCsv(undefined)).toEqual([]);
  });

  function createPluginArchiveFetch(overrides?: {
    privateToken?: string;
    includeWebAnalytics?: boolean;
    omitObservabilityHeaders?: boolean;
    publicBadgesEnabled?: boolean;
    pageVisitCountStatus?: number;
    pageVisitCountBody?: string;
    pageVisitConfigStatus?: number;
    pageVisitConfigBody?: string;
    pageVisitConfigCacheControl?: string;
    openFinanceStatus?: number;
    openFinanceBody?: string;
    openFinanceCacheControl?: string;
    leakOpenFinanceAnon?: boolean;
    recipesStatus?: number;
    recipesBody?: string;
    bookStatus?: number;
    pronunciationStatus?: number;
    pronunciationBody?: string;
    pronunciationCacheControl?: string;
    diagnosticsRoute?: '/api/admin/system' | '/api/admin/diagnostics';
    diagnosticsStatus?: number;
    diagnosticsBody?: string;
    throwOnPath?: string;
  }): typeof fetch {
    const secHeaders = {
      'content-security-policy': "default-src 'self'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'strict-transport-security': 'max-age=31536000; includeSubDomains',
    };
    const token = overrides?.privateToken;

    return async (input, init) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsedUrl = new URL(urlStr);
      const pathname = parsedUrl.pathname;
      if (overrides?.throwOnPath && pathname === overrides.throwOnPath) {
        throw new Error(`Synthetic network failure on ${pathname}`);
      }
      const headers = new Headers(init?.headers);
      const isAuthed = !token || headers.get('authorization') === `Bearer ${token}`;

      if (pathname === '/') {
        const beacon =
          overrides?.includeWebAnalytics !== false
            ? '<script defer src="https://static.cloudflareinsights.com/beacon.min.js"></script>'
            : '';
        return new Response(`<!doctype html><html><head>${beacon}</head><body>ok</body></html>`, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8', ...secHeaders },
        });
      }

      if (pathname === '/api/bundle') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        const obsHeaders = overrides?.omitObservabilityHeaders
          ? {}
          : {
              'x-request-id': 'req_probe_test_1',
              'server-timing': 'd1;dur=1.5, bundle;dur=3.2, total;dur=4.8',
            };
        if (headers.get('if-none-match') === '"rev-10"') {
          return new Response(null, {
            status: 304,
            headers: { etag: '"rev-10"', ...obsHeaders, ...secHeaders },
          });
        }
        return new Response(
          JSON.stringify({
            people: [{ id: 'p_1', slug: 'abraham-lincoln-1809', is_living: false }],
            media: [{ id: 'm_1', file: '/media/portrait.jpg' }],
          }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              etag: '"rev-10"',
              'cache-control': 'private, no-cache',
              ...obsHeaders,
              ...secHeaders,
            },
          }
        );
      }

      if (pathname === '/media/portrait.jpg') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(new Uint8Array(1024), {
          status: 206,
          headers: { 'accept-ranges': 'bytes', 'content-range': 'bytes 0-1023/2048', ...secHeaders },
        });
      }

      if (pathname === '/api/observability/config') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(
          overrides?.pageVisitConfigBody ??
            JSON.stringify({
              enabled: true,
              public_badges_enabled: overrides?.publicBadgesEnabled ?? true,
              record_spa_beacons: true,
            }),
          {
            status: overrides?.pageVisitConfigStatus ?? 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': overrides?.pageVisitConfigCacheControl ?? 'private, no-cache',
            },
          }
        );
      }

      if (pathname === '/api/observability/page-visits') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(
          overrides?.pageVisitCountBody ??
            JSON.stringify({
              route_key: '/person/abraham-lincoln-1809',
              entity_kind: 'person',
              entity_slug: 'abraham-lincoln-1809',
              total_views: 4,
            }),
          {
            status: overrides?.pageVisitCountStatus ?? 200,
            headers: { 'content-type': 'application/json', 'cache-control': 'private, no-cache' },
          }
        );
      }

      if (pathname === '/api/open-finance/summary') {
        if (!isAuthed && !overrides?.leakOpenFinanceAnon) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(
          overrides?.openFinanceBody ??
            JSON.stringify({
              visibility: { show_support_page: true, show_in_nav: true, show_in_footer: true },
              platforms: [{ platform: 'github_sponsors', url: 'https://github.com/sponsors/kinloom-demo' }],
              cost_items: [],
            }),
          {
            status: overrides?.openFinanceStatus ?? 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': overrides?.openFinanceCacheControl ?? 'private, no-cache',
            },
          }
        );
      }

      if (pathname === '/api/plugins/recipes') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(overrides?.recipesBody ?? JSON.stringify({ recipes: [] }), {
          status: overrides?.recipesStatus ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname === '/api/plugins/book-publishing/status') {
        return new Response(JSON.stringify({ ok: true }), {
          status: overrides?.bookStatus ?? 403,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname === '/api/pronunciations') {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(
          overrides?.pronunciationBody ?? JSON.stringify({ pronunciations: { lincoln: {} } }),
          {
            status: overrides?.pronunciationStatus ?? 200,
            headers: {
              'content-type': 'application/json',
              'cache-control': overrides?.pronunciationCacheControl ?? 'private, no-store',
            },
          }
        );
      }

      const diagRoute = overrides?.diagnosticsRoute ?? '/api/admin/system';
      if (pathname === diagRoute) {
        if (!isAuthed) {
          return new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED' } }), { status: 401 });
        }
        return new Response(
          overrides?.diagnosticsBody ??
            JSON.stringify({
              plugins: [
                { id: 'kinloom-recipes', status: 'active', detail: 'd1' },
                { id: 'kinloom-open-finance', status: 'active', detail: '1 platform' },
              ],
            }),
          {
            status: overrides?.diagnosticsStatus ?? 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }

      return new Response('Not Found', { status: 404 });
    };
  }

  it('verifies all plugins, leak guard, diagnostics, and KINLOOM_TOKEN env fallback without leaking the token', async () => {
    const secretToken = 'kl_probe_env_secret_74_xyz';
    const prevToken = process.env['KINLOOM_TOKEN'];
    const prevProbeToken = process.env['KINLOOM_PROBE_TOKEN'];
    const prevAgentToken = process.env['KINLOOM_AGENT_TOKEN'];
    delete process.env['KINLOOM_PROBE_TOKEN'];
    delete process.env['KINLOOM_AGENT_TOKEN'];
    process.env['KINLOOM_TOKEN'] = secretToken;

    try {
      const fetchImpl = createPluginArchiveFetch({ privateToken: secretToken });
      const plugin = createSyntheticProbePlugin({ fetchImpl });

      const jsonCap = createCaptureIo();
      const jsonExit = await runCli(
        [
          'probe',
          '--url',
          'https://private-archive.example.test',
          '--plugins',
          '--expect-plugins',
          'kinloom-workers-observability,kinloom-web-analytics,kinloom-page-visit-stats,kinloom-open-finance,kinloom-recipes,kinloom-book-publishing,kinloom-pronunciation',
          '--json',
        ],
        { io: jsonCap.io, plugins: [plugin] }
      );
      expect(jsonExit).toBe(EXIT_OK);
      const rawJson = jsonCap.stdout.join('\n');
      expect(rawJson).not.toContain(secretToken);

      const report = JSON.parse(rawJson) as SyntheticProbeReport;
      expect(report.ok).toBe(true);
      expect(report.plugins?.status).toBe('pass');
      expect(report.plugins?.leakGuardPassed).toBe(true);
      expect(report.plugins?.diagnosticsChecked).toBe(true);
      expect(report.plugins?.checks).toHaveLength(7);
      expect(report.plugins?.checks.every((c) => c.status === 'pass')).toBe(true);

      const textCap = createCaptureIo();
      const textExit = await runCli(['probe', '--url', 'https://private-archive.example.test', '--plugins'], {
        io: textCap.io,
        plugins: [plugin],
      });
      expect(textExit).toBe(EXIT_OK);
      const rendered = textCap.stdout.join('\n');
      expect(rendered).not.toContain(secretToken);
      expect(rendered).toContain('5. Plugins: PASS | checks=7 leak-guard=pass diagnostics=checked');
      expect(rendered).toContain('kinloom-recipes: PASS');
      expect(rendered).toContain('kinloom-book-publishing: PASS');
    } finally {
      if (prevToken === undefined) delete process.env['KINLOOM_TOKEN'];
      else process.env['KINLOOM_TOKEN'] = prevToken;
      if (prevProbeToken === undefined) delete process.env['KINLOOM_PROBE_TOKEN'];
      else process.env['KINLOOM_PROBE_TOKEN'] = prevProbeToken;
      if (prevAgentToken === undefined) delete process.env['KINLOOM_AGENT_TOKEN'];
      else process.env['KINLOOM_AGENT_TOKEN'] = prevAgentToken;
    }
  });

  it('fails non-zero on plugin 5xx, degraded diagnostics, private archive leaks, and missing expected plugins', async () => {
    const token = 'kl_fail_probe_token_74';

    const brokenFetch = createPluginArchiveFetch({
      privateToken: token,
      recipesStatus: 503,
      recipesBody: JSON.stringify({ error: { code: 'PLUGIN_MIGRATION_REQUIRED' } }),
      leakOpenFinanceAnon: true,
      openFinanceCacheControl: 'public, max-age=60',
      pageVisitConfigCacheControl: 'public, max-age=60',
      pageVisitCountStatus: 500,
      bookStatus: 502,
      pronunciationStatus: 500,
      diagnosticsRoute: '/api/admin/diagnostics',
      diagnosticsStatus: 200,
      diagnosticsBody: JSON.stringify({
        plugins: [
          null,
          { id: 'kinloom-recipes', status: 'degraded', detail: 'Pending 0001_recipes_initial' },
        ],
      }),
    });

    const report = await runSyntheticProbe({
      targetUrl: 'https://broken-archive.example.test',
      token,
      checkPlugins: true,
      expectPlugins: ['kinloom-unknown-plugin'],
      fetchImpl: brokenFetch,
    });
    expect(report.ok).toBe(false);
    expect(report.plugins?.status).toBe('fail');
    expect(report.plugins?.leakGuardPassed).toBe(false);
    expect(report.plugins?.diagnosticsChecked).toBe(true);
    expect(report.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PLUGIN_MIGRATION_REQUIRED'),
        expect.stringContaining('Private archive leak: unauthenticated GET /api/open-finance/summary'),
        expect.stringContaining('returned public Cache-Control'),
        expect.stringContaining('/api/observability/page-visits returned HTTP 500'),
        expect.stringContaining('/api/plugins/book-publishing/status returned HTTP 502'),
        expect.stringContaining('/api/pronunciations returned HTTP 500'),
        expect.stringContaining("plugin 'kinloom-recipes' in 'degraded' state"),
        expect.stringContaining("Unknown expected plugin ID 'kinloom-unknown-plugin'"),
      ])
    );
  });

  it('reports skipped and warn cleanly when optional plugins are absent, and fails when they are expected', async () => {
    const minimalFetch = createPluginArchiveFetch({
      includeWebAnalytics: false,
      omitObservabilityHeaders: true,
      pageVisitConfigStatus: 404,
      openFinanceStatus: 404,
      recipesStatus: 404,
      bookStatus: 404,
      pronunciationStatus: 404,
    });

    const permissive = await runSyntheticProbe({
      targetUrl: 'https://minimal.example.test',
      checkPlugins: true,
      fetchImpl: minimalFetch,
    });
    expect(permissive.ok).toBe(true);
    expect(permissive.plugins?.status).toBe('pass');
    expect(permissive.plugins?.leakGuardPassed).toBeNull();
    expect(
      permissive.plugins?.checks.find((c) => c.pluginId === 'kinloom-workers-observability')?.status
    ).toBe('warn');
    expect(permissive.plugins?.checks.find((c) => c.pluginId === 'kinloom-web-analytics')?.status).toBe(
      'warn'
    );
    expect(permissive.plugins?.checks.find((c) => c.pluginId === 'kinloom-recipes')?.status).toBe('skipped');

    const strict = await runSyntheticProbe({
      targetUrl: 'https://minimal.example.test',
      expectPlugins: [
        'kinloom-workers-observability',
        'kinloom-web-analytics',
        'kinloom-page-visit-stats',
        'kinloom-open-finance',
        'kinloom-recipes',
        'kinloom-book-publishing',
        'kinloom-pronunciation',
      ],
      fetchImpl: minimalFetch,
    });
    expect(strict.ok).toBe(false);
    expect(strict.plugins?.checks.every((c) => c.status === 'fail')).toBe(true);
  });

  it('handles invalid plugin JSON payloads, non-HTTPS finance URLs, diagnostics 5xx/403, and transport errors cleanly', async () => {
    const badSchemaReport = await runSyntheticProbe({
      targetUrl: 'https://bad-json.example.test',
      token: 'tok-diag-test',
      checkPlugins: true,
      fetchImpl: createPluginArchiveFetch({
        pageVisitConfigBody: JSON.stringify({ enabled: false }),
        openFinanceBody: JSON.stringify({
          visibility: {},
          platforms: [{ url: 'http://insecure.example.test' }],
          cost_items: [],
        }),
        recipesBody: JSON.stringify({ nope: true }),
        bookStatus: 200,
        pronunciationBody: JSON.stringify({ pronunciations: 'bad' }),
        diagnosticsStatus: 500,
      }),
    });
    expect(badSchemaReport.ok).toBe(false);
    expect(badSchemaReport.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/api/observability/config returned invalid JSON schema'),
        expect.stringContaining('donation platform URL must use https://'),
        expect.stringContaining('/api/plugins/recipes returned invalid JSON schema'),
        expect.stringContaining('/api/pronunciations returned invalid JSON schema'),
        expect.stringContaining('Admin diagnostics (/api/admin/system) returned HTTP 500'),
      ])
    );

    const warnAndInvalidCountReport = await runSyntheticProbe({
      targetUrl: 'https://warn.example.test',
      token: 'tok-agent-403',
      checkPlugins: true,
      fetchImpl: createPluginArchiveFetch({
        pageVisitCountBody: JSON.stringify({ total_views: -1 }),
        openFinanceBody: 'not-json',
        pronunciationCacheControl: 'private, max-age=60',
        diagnosticsStatus: 403,
      }),
    });
    expect(warnAndInvalidCountReport.ok).toBe(false);
    expect(warnAndInvalidCountReport.plugins?.diagnosticsChecked).toBe(false);
    expect(
      warnAndInvalidCountReport.plugins?.checks.find((c) => c.pluginId === 'kinloom-pronunciation')?.status
    ).toBe('warn');
    expect(warnAndInvalidCountReport.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('invalid total_views'),
        expect.stringContaining('/api/open-finance/summary returned invalid JSON schema'),
      ])
    );

    const invalidDiagJsonReport = await runSyntheticProbe({
      targetUrl: 'https://bad-diag.example.test',
      token: 'tok-bad-diag',
      checkPlugins: true,
      fetchImpl: createPluginArchiveFetch({
        diagnosticsStatus: 200,
        diagnosticsBody: 'not-json',
        pageVisitConfigStatus: 502,
        openFinanceStatus: 502,
      }),
    });
    expect(invalidDiagJsonReport.ok).toBe(false);
    expect(invalidDiagJsonReport.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('returned invalid JSON'),
        expect.stringContaining('/api/observability/config returned HTTP 502'),
        expect.stringContaining('/api/open-finance/summary returned HTTP 502'),
      ])
    );

    for (const failingPath of [
      '/api/observability/config',
      '/api/observability/page-visits',
      '/api/open-finance/summary',
      '/api/plugins/recipes',
      '/api/plugins/book-publishing/status',
      '/api/pronunciations',
      '/api/admin/system',
    ]) {
      const errReport = await runSyntheticProbe({
        targetUrl: 'https://net-err.example.test',
        token: 'tok-net-err',
        checkPlugins: true,
        fetchImpl: createPluginArchiveFetch({ throwOnPath: failingPath }),
      });
      expect(errReport.ok).toBe(false);
      expect(
        errReport.violations.some((v) => v.includes(`Synthetic network failure on ${failingPath}`))
      ).toBe(true);
    }
  });
});
