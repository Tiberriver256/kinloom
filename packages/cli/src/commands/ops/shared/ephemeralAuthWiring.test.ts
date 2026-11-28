import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../../../cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../../../errors.js';
import { createSyntheticProbePlugin, type SyntheticProbeClock } from '../../../plugins/syntheticProbe.js';
import type { DesignAuditBrowserFactory } from '../design-audit/capture.js';
import { parseDesignAuditCookieSpecs, runDesignAuditCommand } from '../design-audit.js';
import type { ScreenshotBrowserFactory } from '../screenshots/types.js';
import { runScreenshotsCommand } from '../screenshots.js';
import type { WranglerExecutor } from './wrangler.js';

const tempDirs: string[] = [];

async function makeWranglerRepo(withRoute = true): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-temp-auth-wire-'));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, 'wrangler.jsonc'),
    JSON.stringify({
      d1_databases: [{ database_name: 'alder-db' }],
      ...(withRoute ? { routes: [{ pattern: 'alder.example.org/*' }] } : {}),
    }),
    'utf8'
  );
  return dir;
}

function makeMockD1Wrangler(sqlLog: string[]): WranglerExecutor {
  return async (_bin, args) => {
    const sql = args[args.indexOf('--command') + 1] ?? '';
    sqlLog.push(sql);
    if (sql.startsWith('SELECT COUNT(*) AS count FROM agent_tokens')) {
      return { stdout: JSON.stringify([{ success: true, results: [{ count: 1 }] }]), stderr: '' };
    }
    if (sql.includes('DELETE FROM')) {
      const statements: Array<{ success: true; results: Array<Record<string, unknown>> }> = [];
      const tokenDeletes = (sql.match(/DELETE FROM agent_tokens/g) ?? []).length;
      const inviteDeletes = (sql.match(/DELETE FROM invites/g) ?? []).length;
      for (let i = 0; i < tokenDeletes + inviteDeletes; i += 1) {
        statements.push({ success: true, results: [] });
      }
      statements.push({ success: true, results: [{ count: 1 }] });
      if (tokenDeletes > 0) {
        statements.push({ success: true, results: [{ count: 0 }] });
      }
      if (inviteDeletes > 0) {
        statements.push({ success: true, results: [{ count: 0 }] });
      }
      return { stdout: JSON.stringify(statements), stderr: '' };
    }
    return { stdout: JSON.stringify([{ success: true, results: [] }]), stderr: '' };
  };
}

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) },
    stdout,
    stderr,
  };
}

const deterministicClock: SyntheticProbeClock = (() => {
  let tick = 100;
  return {
    now: () => {
      tick += 5;
      return tick;
    },
    nowIso: () => '2026-11-28T12:00:00.000Z',
  };
})();

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('--with-temp-auth wiring across probe, screenshots, and design-audit', () => {
  it('wires --with-temp-auth into kinloom probe with auto URL lookup and guaranteed cleanup', async () => {
    const repoDir = await makeWranglerRepo(true);
    const sqlLog: string[] = [];
    const execWrangler = makeMockD1Wrangler(sqlLog);

    const seenBearers = new Set<string>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const headers = new Headers(init?.headers);
      const auth = headers.get('authorization') ?? '';
      if (auth.startsWith('Bearer ')) {
        seenBearers.add(auth.slice(7));
      }

      const secHeaders = {
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'strict-origin-when-cross-origin',
        'content-security-policy': "default-src 'self'",
        'strict-transport-security': 'max-age=31536000',
      };

      if (url === 'https://alder.example.org/') {
        return new Response('<!doctype html><html><body><h1>Alder Archive</h1></body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html', ...secHeaders },
        });
      }
      if (url === 'https://alder.example.org/api/bundle') {
        if (!auth.startsWith('Bearer ')) {
          return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
        }
        if (headers.get('if-none-match') === '"r1"') {
          return new Response(null, { status: 304, headers: { etag: '"r1"', ...secHeaders } });
        }
        return new Response(JSON.stringify({ meta: { build_mode: 'private' }, people: [], media: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            etag: '"r1"',
            'x-request-id': 'req_probe_1',
            'server-timing': 'd1;dur=2, total;dur=5',
            ...secHeaders,
          },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(['probe', '--with-temp-auth', '--plugins', '--json'], {
      cwd: repoDir,
      io,
      fetchImpl,
      plugins: [createSyntheticProbePlugin({ execWrangler, clock: deterministicClock })],
    });

    expect(exitCode).toBe(EXIT_OK);
    const report = JSON.parse(stdout.join('\n')) as {
      ok: boolean;
      targetUrl: string;
      plugins?: { status: string };
    };
    expect(report.ok).toBe(true);
    expect(report.targetUrl).toBe('https://alder.example.org');
    expect(report.plugins?.status).toBe('pass');
    expect(seenBearers.size).toBe(1);
    expect(sqlLog.some((s) => s.includes('INSERT INTO agent_tokens'))).toBe(true);
    expect(sqlLog.some((s) => s.includes('DELETE FROM agent_tokens'))).toBe(true);

    // Rejects conflicting --token + --with-temp-auth
    const conflictIo = createCaptureIo();
    const conflictCode = await runCli(
      ['probe', '--with-temp-auth', '--token', 'secret', '--url', 'https://alder.example.org'],
      {
        cwd: repoDir,
        io: conflictIo.io,
        plugins: [createSyntheticProbePlugin({ execWrangler })],
      }
    );
    expect(conflictCode).toBe(EXIT_USAGE);

    // Rejects missing URL when wrangler has no routes[0].pattern
    const noRouteRepo = await makeWranglerRepo(false);
    const noRouteIo = createCaptureIo();
    const noRouteCode = await runCli(['probe', '--with-temp-auth'], {
      cwd: noRouteRepo,
      io: noRouteIo.io,
      plugins: [createSyntheticProbePlugin({ execWrangler })],
    });
    expect(noRouteCode).toBe(EXIT_USAGE);
  });

  it('wires --with-temp-auth into kinloom screenshots via ephemeral invite cookie redemption', async () => {
    const repoDir = await makeWranglerRepo(true);
    const outDir = path.join(repoDir, 'shots');
    const sqlLog: string[] = [];
    const execWrangler = makeMockD1Wrangler(sqlLog);

    const addedCookies: Array<{ name: string; value: string; url: string }> = [];
    const seenHeaders: Array<Readonly<Record<string, string>> | undefined> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/auth/invite/tmp_inv_')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': '__Host-kinloom_session=viewer_sess_shots; Path=/; HttpOnly; Secure',
          },
        });
      }
      if (url.endsWith('/api/bundle')) {
        const cookie = new Headers(init?.headers).get('cookie');
        expect(cookie).toBe('__Host-kinloom_session=viewer_sess_shots');
        return new Response(JSON.stringify({ people: [], places: [], narratives: [], media: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const browserFactory: ScreenshotBrowserFactory = async () => ({
      newContext: async (opts) => {
        seenHeaders.push(opts.extraHTTPHeaders);
        return {
          addCookies: async (cookies) => {
            addedCookies.push(...cookies);
          },
          newPage: async () => ({
            goto: async () => undefined,
            screenshot: async ({ path: filePath }) => {
              await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            },
            locator: () => {
              const loc = {
                count: async () => 0,
                first: () => loc,
                nth: () => loc,
                isVisible: async () => false,
                click: async () => undefined,
                fill: async () => undefined,
                screenshot: async () => undefined,
                boundingBox: async () => null,
                textContent: async () => '',
              };
              return loc;
            },
            evaluate: async <T>(): Promise<T> => [] as unknown as T,
            waitForTimeout: async () => undefined,
            waitForSelector: async () => undefined,
            keyboard: { press: async () => undefined },
            on: () => undefined,
            close: async () => undefined,
          }),
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    });

    const { io, stdout } = createCaptureIo();
    const exitCode = await runCli(
      [
        'screenshots',
        '--with-temp-auth',
        '--repo',
        repoDir,
        '--out-dir',
        outDir,
        '--viewports',
        'desktop',
        '--themes',
        'light',
        '--include',
        'pages',
        '--routes',
        '/',
        '--json',
      ],
      {
        cwd: repoDir,
        io,
        fetchImpl,
        execWrangler,
        screenshotBrowserFactory: browserFactory,
      }
    );

    expect(exitCode).toBe(EXIT_OK);
    expect(stdout.join('\n')).not.toContain('viewer_sess_shots');
    expect(
      addedCookies.some((c) => c.name === '__Host-kinloom_session' && c.value === 'viewer_sess_shots')
    ).toBe(true);
    expect(seenHeaders.some((h) => h?.['Cookie'] === '__Host-kinloom_session=viewer_sess_shots')).toBe(true);
    expect(sqlLog.some((s) => s.includes('INSERT INTO invites'))).toBe(true);
    expect(sqlLog.some((s) => s.includes('DELETE FROM invites'))).toBe(true);

    // Rejects conflicting --auth-cookie + --with-temp-auth
    await expect(
      runScreenshotsCommand({
        url: 'https://alder.example.org',
        withTempAuth: true,
        authCookie: 'kinloom_session=abc',
        repoDir,
        execWrangler,
      })
    ).rejects.toThrow(/Specify either `--auth-cookie` or `--with-temp-auth`/);

    const noRouteRepo = await makeWranglerRepo(false);
    await expect(
      runScreenshotsCommand({
        withTempAuth: true,
        repoDir: noRouteRepo,
        execWrangler,
      })
    ).rejects.toThrow(/Missing target URL/);
  });

  it('wires --with-temp-auth and auth cookies/headers into kinloom design-audit and capture.ts', async () => {
    expect(
      parseDesignAuditCookieSpecs('__Host-kinloom_session=tok1; theme=dark', 'https://alder.example.org/')
    ).toEqual([
      { name: '__Host-kinloom_session', value: 'tok1', url: 'https://alder.example.org' },
      { name: 'theme', value: 'dark', url: 'https://alder.example.org' },
    ]);
    expect(() => parseDesignAuditCookieSpecs('bad\ncookie=1', 'https://alder.example.org')).toThrow(
      /CR or LF/
    );
    expect(() => parseDesignAuditCookieSpecs('malformed', 'https://alder.example.org')).toThrow(/name=value/);

    const repoDir = await makeWranglerRepo(true);
    const outDir = path.join(repoDir, 'audit-out');
    const sqlLog: string[] = [];
    const execWrangler = makeMockD1Wrangler(sqlLog);

    const capturedContextHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
    const capturedCookies: Array<{ name: string; value: string; url: string }> = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/auth/invite/tmp_inv_')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: '/',
            'set-cookie': '__Host-kinloom_session=viewer_sess_audit; Path=/; HttpOnly; Secure',
          },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const browserFactory: DesignAuditBrowserFactory = async () => ({
      newContext: async (opts) => {
        capturedContextHeaders.push(opts.extraHTTPHeaders);
        return {
          addCookies: async (cookies) => {
            capturedCookies.push(...cookies);
          },
          newPage: async () => ({
            emulateMedia: async () => undefined,
            goto: async () => undefined,
            waitForTimeout: async () => undefined,
            screenshot: async ({ path: shotPath }) => {
              await writeFile(shotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
            },
            evaluate: async <T>(expr: string | ((...args: never[]) => T)): Promise<T> => {
              const src = String(expr);
              if (src.includes('aboveFoldMainRatio')) {
                return {
                  viewport: '1440x900',
                  docOverflowX: 0,
                  aboveFoldMainRatio: 0.7,
                  aboveFoldChromeRatio: 0.1,
                  navLinkCount: 4,
                  title: 'Alder Archive',
                  h1Text: 'Alder Family Archive',
                  h1Truncated: false,
                  h1Rect: [24, 96, 400, 48],
                  viewportMeta: 'width=device-width, initial-scale=1',
                  interactives: [],
                  textSamples: [],
                  stylesheets: [],
                } as T;
              }
              if (src.includes('playState')) {
                return 0 as T;
              }
              return [] as T;
            },
            addStyleTag: async () => undefined,
          }),
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    });

    const result = await runDesignAuditCommand({
      repoRoot: repoDir,
      outDir,
      themes: ['light'],
      routes: ['/'],
      withTempAuth: true,
      authHeaders: { 'X-Audit-Run': 'ci-114' },
      fetchImpl,
      execWrangler,
      browserFactory,
      json: true,
    });

    expect(result.deterministicRuntime).toBe(true);
    expect(result.captureCount).toBeGreaterThan(0);
    // Both main capture contexts and reduced-motion context received the session cookie & custom header
    expect(capturedContextHeaders.length).toBeGreaterThanOrEqual(2);
    for (const hdrs of capturedContextHeaders) {
      expect(hdrs?.['Cookie']).toBe('__Host-kinloom_session=viewer_sess_audit');
      expect(hdrs?.['X-Audit-Run']).toBe('ci-114');
    }
    expect(
      capturedCookies.every((c) => c.name === '__Host-kinloom_session' && c.value === 'viewer_sess_audit')
    ).toBe(true);
    expect(sqlLog.some((s) => s.includes('INSERT INTO invites'))).toBe(true);
    expect(sqlLog.some((s) => s.includes('DELETE FROM invites'))).toBe(true);

    // CLI dispatch validation checks
    const badIo = createCaptureIo();
    const conflictCode = await runCli(
      ['design-audit', '--with-temp-auth', '--auth-cookie', 'kinloom_session=x'],
      { cwd: repoDir, io: badIo.io }
    );
    expect(conflictCode).toBe(EXIT_USAGE);

    const badHeaderCode = await runCli(['design-audit', '--auth-header', 'InvalidHeader', '--static-only'], {
      cwd: repoDir,
      io: badIo.io,
    });
    expect(badHeaderCode).toBe(EXIT_USAGE);

    const noRouteRepo = await makeWranglerRepo(false);
    await expect(
      runDesignAuditCommand({
        repoRoot: noRouteRepo,
        withTempAuth: true,
        execWrangler,
      })
    ).rejects.toThrow(/Missing target URL/);

    const errCode = await runCli(
      [
        'design-audit',
        '--repo',
        repoDir,
        '--out-dir',
        path.join(repoDir, 'static-out'),
        '--static-only',
        '--auth-header',
        'X-Test: ok',
        '--json',
      ],
      { cwd: repoDir, io: badIo.io }
    );
    expect([EXIT_OK, EXIT_ERROR]).toContain(errCode);
  });
});
