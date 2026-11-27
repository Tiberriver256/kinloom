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
  discoverFirstMediaPathFromBundle,
  evaluateSecurityHeaders,
  normalizeProbeBaseUrl,
  parseServerTimingHeader,
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
    expect(passCheck.details?.mediaRangeStatus).toBe('pass');

    const missingReg = resolvePluginCommands([createSyntheticProbePlugin({ attachVerifyCheck: true })])
      .verifyChecks[0];
    const missingResult = await runRegisteredCheck(missingReg.pluginId, missingReg.check, createVerifyCtx());
    expect(missingResult.ok).toBe(false);
    expect(missingResult.errors[0]).toContain("requires a configured 'targetUrl'");
  });
});
