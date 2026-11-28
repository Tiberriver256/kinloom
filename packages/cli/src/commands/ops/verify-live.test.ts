import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../../cli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import type { SyntheticProbeClock } from '../../plugins/syntheticProbe.js';
import type { WranglerExecutor } from './shared/wrangler.js';
import {
  evaluateLiveBundlePrivacy,
  formatVerifyLiveTextReport,
  runVerifyLiveCommand,
  type VerifyLiveBrowserFactory,
} from './verify-live.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeWranglerRepo(withRoute = true): Promise<string> {
  const dir = await makeTempDir('kinloom-verify-live-');
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

function makeMockD1Wrangler(options?: {
  readonly backupBefore?: number;
  readonly backupAfter?: number;
  readonly remainingTokens?: number;
  readonly remainingInvites?: number;
  readonly sqlLog?: string[];
}): WranglerExecutor {
  return async (_bin, args) => {
    const sql = args[args.indexOf('--command') + 1] ?? '';
    options?.sqlLog?.push(sql);
    if (sql.startsWith('SELECT COUNT(*) AS count FROM agent_tokens')) {
      return {
        stdout: JSON.stringify([{ success: true, results: [{ count: options?.backupBefore ?? 1 }] }]),
        stderr: '',
      };
    }
    if (sql.includes('DELETE FROM')) {
      const statements: Array<{ success: true; results: Array<Record<string, unknown>> }> = [];
      const tokenDeletes = (sql.match(/DELETE FROM agent_tokens/g) ?? []).length;
      const inviteDeletes = (sql.match(/DELETE FROM invites/g) ?? []).length;
      for (let i = 0; i < tokenDeletes + inviteDeletes; i += 1) {
        statements.push({ success: true, results: [] });
      }
      statements.push({ success: true, results: [{ count: options?.backupAfter ?? 1 }] });
      if (tokenDeletes > 0) {
        statements.push({ success: true, results: [{ count: options?.remainingTokens ?? 0 }] });
      }
      if (inviteDeletes > 0) {
        statements.push({ success: true, results: [{ count: options?.remainingInvites ?? 0 }] });
      }
      return { stdout: JSON.stringify(statements), stderr: '' };
    }
    const insertCount = (sql.match(/INSERT INTO/g) ?? []).length;
    return {
      stdout: JSON.stringify(
        Array.from({ length: Math.max(1, insertCount) }, () => ({ success: true, results: [] }))
      ),
      stderr: '',
    };
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
  let t = 50;
  return {
    now: () => {
      t += 4;
      return t;
    },
    nowIso: () => '2026-11-28T12:00:00.000Z',
  };
})();

function makeCleanPrivateBundle(): Record<string, unknown> {
  return {
    meta: { build_mode: 'private', generated_at: '2026-11-28T12:00:00.000Z' },
    people: [
      {
        id: 'per_arthur_alder',
        slug: 'arthur-alder',
        full_name: 'Arthur Alder',
        is_living: false,
        birth_edtf: '1880-04-12',
        death_edtf: '1952-08-03',
        portrait_url: '/media/arthur.jpg',
      },
      {
        id: 'per_living_descendant',
        slug: 'living-descendant',
        full_name: 'Robin Alder',
        is_living: true,
        birth_edtf: '1991',
        alt_names: [],
        primary_place_id: null,
        portrait_url: null,
        thumb_url: null,
        media_count: 0,
      },
    ],
    events: [
      {
        id: 'ev_living_birth',
        edtf_date: '1991',
        place_id: null,
        photo_url: null,
        participants: [{ person_id: 'per_living_descendant', role: 'subject' }],
      },
    ],
    residence_spans: [{ id: 'span_arthur', person_id: 'per_arthur_alder' }],
    media: [{ id: 'med_arthur', person_id: 'per_arthur_alder', file: '/media/arthur.jpg' }],
    narratives: [
      { id: 'nar_arthur', subject_person_id: 'per_arthur_alder', person_ids: ['per_arthur_alder'] },
    ],
  };
}

function makeLiveArchiveFetch(options?: {
  readonly anonymousBundleStatus?: number;
  readonly bundlePayload?: unknown;
  readonly pronunciationStatus?: number;
  readonly pwaOverrides?: Partial<Record<string, { status: number; body: string; contentType?: string }>>;
}): typeof fetch {
  const secHeaders = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'content-security-policy': "default-src 'self'",
    'strict-transport-security': 'max-age=31536000',
  };
  const bundlePayload = options?.bundlePayload ?? makeCleanPrivateBundle();

  return async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const parsed = new URL(rawUrl);
    const headers = new Headers(init?.headers);
    const hasAuth =
      Boolean(headers.get('authorization')?.startsWith('Bearer ')) ||
      Boolean(headers.get('cookie')?.includes('kinloom_session='));

    if (parsed.pathname.startsWith('/api/auth/invite/tmp_inv_')) {
      return new Response(null, {
        status: 302,
        headers: {
          location: '/',
          'set-cookie': '__Host-kinloom_session=live_viewer_cookie; Path=/; HttpOnly; Secure',
        },
      });
    }

    if (parsed.pathname === '/') {
      return new Response('<!doctype html><html><body><h1>Alder Family Archive</h1></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', ...secHeaders },
      });
    }

    if (parsed.pathname === '/api/bundle') {
      if (!hasAuth) {
        const anonStatus = options?.anonymousBundleStatus ?? 401;
        return new Response(JSON.stringify(anonStatus === 200 ? bundlePayload : { error: 'unauthorized' }), {
          status: anonStatus,
          headers: { 'content-type': 'application/json', ...secHeaders },
        });
      }
      if (headers.get('if-none-match') === '"rev-10"') {
        return new Response(null, {
          status: 304,
          headers: { etag: '"rev-10"', 'cache-control': 'private, no-cache', ...secHeaders },
        });
      }
      return new Response(JSON.stringify(bundlePayload), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          etag: '"rev-10"',
          'cache-control': 'private, no-cache',
          'x-request-id': 'req_live_10',
          'server-timing': 'd1;dur=2.1, r2;dur=4.0, bundle;dur=6.2, total;dur=9.1',
          ...secHeaders,
        },
      });
    }

    if (parsed.pathname === '/media/arthur.jpg') {
      return new Response(new Uint8Array(1024), {
        status: 206,
        headers: {
          'accept-ranges': 'bytes',
          'content-range': 'bytes 0-1023/4096',
          'content-type': 'image/jpeg',
          ...secHeaders,
        },
      });
    }

    if (parsed.pathname === '/api/pronunciations') {
      if (!hasAuth) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      const pronStatus = options?.pronunciationStatus ?? 200;
      return new Response(
        pronStatus === 200
          ? JSON.stringify({ pronunciations: { alder: { phonetic: 'AWL-der' } } })
          : 'not found',
        {
          status: pronStatus,
          headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
        }
      );
    }

    const pwaDefault: Record<string, { status: number; body: string; contentType: string }> = {
      '/site.webmanifest': {
        status: 200,
        body: JSON.stringify({
          name: 'Alder Archive',
          icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
        }),
        contentType: 'application/manifest+json',
      },
      '/sw.js': {
        status: 200,
        body: 'self.addEventListener("fetch", () => {});',
        contentType: 'application/javascript',
      },
      '/favicon-light.svg': {
        status: 200,
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>',
        contentType: 'image/svg+xml',
      },
      '/favicon-dark.svg': {
        status: 200,
        body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>',
        contentType: 'image/svg+xml',
      },
    };
    const pwaOverride = options?.pwaOverrides?.[parsed.pathname];
    const pwaAsset = pwaOverride ?? pwaDefault[parsed.pathname];
    if (pwaAsset) {
      return new Response(pwaAsset.body, {
        status: pwaAsset.status,
        headers: { 'content-type': pwaAsset.contentType ?? 'text/plain' },
      });
    }

    return new Response('not found', { status: 404 });
  };
}

function makeFakeBrowserFactory(options?: {
  readonly h1Visible?: boolean;
  readonly h1Text?: string;
  readonly pageErrors?: readonly string[];
  readonly failedRequests?: readonly { url: string; reason?: string }[];
  readonly responses?: readonly { url: string; status: number }[];
  readonly onCookies?: (cookies: readonly { name: string; value: string; url: string }[]) => void;
}): VerifyLiveBrowserFactory {
  return async () => ({
    newContext: async () => ({
      addCookies: async (cookies) => {
        options?.onCookies?.(cookies);
      },
      newPage: async () => {
        const pageErrorHandlers: Array<(err: Error) => void> = [];
        const reqFailHandlers: Array<
          (req: { url(): string; failure(): { errorText?: string } | null }) => void
        > = [];
        const resHandlers: Array<(res: { url(): string; status(): number }) => void> = [];
        return {
          on: (event: string, listener: (...args: never[]) => void) => {
            if (event === 'pageerror') {
              pageErrorHandlers.push(listener as (err: Error) => void);
            } else if (event === 'requestfailed') {
              reqFailHandlers.push(
                listener as (req: { url(): string; failure(): { errorText?: string } | null }) => void
              );
            } else if (event === 'response') {
              resHandlers.push(listener as (res: { url(): string; status(): number }) => void);
            }
          },
          goto: async () => {
            for (const msg of options?.pageErrors ?? []) {
              for (const fn of pageErrorHandlers) {
                fn(new Error(msg));
              }
            }
            for (const item of options?.failedRequests ?? []) {
              for (const fn of reqFailHandlers) {
                fn({ url: () => item.url, failure: () => (item.reason ? { errorText: item.reason } : null) });
              }
            }
            for (const item of options?.responses ?? []) {
              for (const fn of resHandlers) {
                fn({ url: () => item.url, status: () => item.status });
              }
            }
          },
          waitForSelector: async () => undefined,
          evaluate: async <T>(): Promise<T> =>
            ({
              visible: options?.h1Visible ?? true,
              text: options?.h1Text ?? 'Alder Family Archive',
            }) as T,
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    }),
    close: async () => undefined,
  });
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('evaluateLiveBundlePrivacy', () => {
  it('passes on clean private and clean public bundles', () => {
    const privateRes = evaluateLiveBundlePrivacy(
      makeCleanPrivateBundle(),
      'https://alder.example.org/api/bundle',
      200
    );
    expect(privateRes.status).toBe('pass');
    expect(privateRes.buildMode).toBe('private');
    expect(privateRes.counts).toEqual({
      livingPeople: 1,
      livingPortraits: 0,
      livingExactBirthdates: 0,
      livingResidenceSpans: 0,
      livingMedia: 0,
      livingNarratives: 0,
      livingEventLeaks: 0,
      livingPrimaryPlaces: 0,
    });

    const publicRes = evaluateLiveBundlePrivacy(
      {
        meta: { build_mode: 'public' },
        people: [
          {
            id: 'per_living_1',
            full_name: 'Living',
            is_living: true,
            birth_edtf: '',
            alt_names: [],
            primary_place_id: null,
            portrait_url: null,
            thumb_url: null,
            media_count: 0,
          },
        ],
        events: [],
        residence_spans: [],
        media: [],
        narratives: [],
      },
      'https://alder.example.org/api/bundle',
      200
    );
    expect(publicRes.status).toBe('pass');
    expect(publicRes.buildMode).toBe('public');
  });

  it('detects every living-person privacy violation class (portraits, exact birthdates, spans, media, narratives, events, public leaks)', () => {
    const invalidRes = evaluateLiveBundlePrivacy({ meta: {} }, 'https://alder.example.org/api/bundle', 200);
    expect(invalidRes.status).toBe('fail');
    expect(invalidRes.violations[0]).toContain('missing people array');

    const leakyPrivate = evaluateLiveBundlePrivacy(
      {
        meta: { build_mode: 'private' },
        people: [
          {
            id: 'per_living_leak',
            full_name: 'Robin Alder',
            is_living: true,
            birth_edtf: '1991-06-15',
            primary_place_id: 'plc_home',
            portrait_url: '/media/living-portrait.jpg',
            media_count: 2,
          },
        ],
        events: [
          {
            id: 'ev_living_grad',
            edtf_date: '2013-05-20',
            place_id: 'plc_school',
            photo_url: '/media/grad.jpg',
            participants: [{ person_id: 'per_living_leak' }],
          },
        ],
        residence_spans: [{ id: 'span_living', person_id: 'per_living_leak' }],
        media: [
          { id: 'med_direct', person_id: 'per_living_leak' },
          { id: 'med_array', person_ids: ['per_living_leak'] },
          { id: 'med_event', event_id: 'ev_living_grad' },
        ],
        narratives: [
          { id: 'nar_subject', subject_person_id: 'per_living_leak', person_ids: [] },
          { id: 'nar_member', person_ids: ['per_living_leak'] },
        ],
      },
      'https://alder.example.org/api/bundle',
      200
    );

    expect(leakyPrivate.status).toBe('fail');
    expect(leakyPrivate.counts).toEqual({
      livingPeople: 1,
      livingPortraits: 1,
      livingExactBirthdates: 1,
      livingResidenceSpans: 1,
      livingMedia: 4,
      livingNarratives: 2,
      livingEventLeaks: 3,
      livingPrimaryPlaces: 1,
    });

    const leakyPublic = evaluateLiveBundlePrivacy(
      {
        meta: { build_mode: 'public' },
        people: [
          {
            id: 'per_pub_living',
            full_name: 'Exposed Name',
            is_living: true,
            birth_edtf: '1991',
            alt_names: ['Nickname'],
          },
        ],
        events: [],
        residence_spans: [],
        media: [],
        narratives: [],
      },
      'https://alder.example.org/api/bundle',
      200
    );
    expect(leakyPublic.status).toBe('fail');
    expect(leakyPublic.counts.livingExactBirthdates).toBe(1);
    expect(leakyPublic.violations.some((v) => v.includes('full_name'))).toBe(true);
    expect(leakyPublic.violations.some((v) => v.includes('alt_names'))).toBe(true);
  });
});

describe('runVerifyLiveCommand and kinloom verify-live CLI', () => {
  it('passes end-to-end with ephemeral D1 auth, plugins, privacy, browser smoke, PWA, and guaranteed cleanup', async () => {
    const repoDir = await makeWranglerRepo(true);
    const sqlLog: string[] = [];
    const seenCookies: Array<{ name: string; value: string; url: string }> = [];

    const result = await runVerifyLiveCommand({
      repoDir,
      expectPlugins: ['kinloom-workers-observability', 'kinloom-pronunciation'],
      browser: true,
      checkPwa: true,
      fetchImpl: makeLiveArchiveFetch(),
      execWrangler: makeMockD1Wrangler({ sqlLog }),
      browserFactory: makeFakeBrowserFactory({ onCookies: (c) => seenCookies.push(...c) }),
      clock: deterministicClock,
    });

    expect(result.ok).toBe(true);
    expect(result.authMode).toBe('ephemeral-d1');
    expect(result.targetUrl).toBe('https://alder.example.org');
    expect(result.anonymousGate.status).toBe('pass');
    expect(result.anonymousGate.httpStatus).toBe(401);
    expect(result.probe.ok).toBe(true);
    expect(result.privacy.status).toBe('pass');
    expect(result.browser.status).toBe('pass');
    expect(result.browser.h1Visible).toBe(true);
    expect(result.browser.h1Text).toBe('Alder Family Archive');
    expect(result.pwa.status).toBe('pass');
    expect(result.pwa.assets.every((a) => a.ok)).toBe(true);
    expect(result.cleanup?.backupCountBefore).toBe(1);
    expect(result.cleanup?.backupCountAfter).toBe(1);
    expect(result.cleanup?.remainingTmpCount).toBe(0);
    expect(seenCookies).toEqual([
      { name: '__Host-kinloom_session', value: 'live_viewer_cookie', url: 'https://alder.example.org' },
    ]);
    expect(result.rendered).toContain('Live Verification: PASS');
    expect(result.rendered).toContain('D1 Cleanup: PASS');
    expect(result.rendered).not.toContain('live_viewer_cookie');
    expect(sqlLog.some((s) => s.includes('DELETE FROM agent_tokens'))).toBe(true);
    expect(sqlLog.some((s) => s.includes('DELETE FROM invites'))).toBe(true);
  });

  it('catches anonymous 200 privacy-gate failure, missing plugin, browser smoke failures, and PWA failures while cleaning up D1', async () => {
    const repoDir = await makeWranglerRepo(true);
    const sqlLog: string[] = [];

    const result = await runVerifyLiveCommand({
      repoDir,
      expectPlugins: ['kinloom-pronunciation'],
      browser: true,
      checkPwa: true,
      json: true,
      fetchImpl: makeLiveArchiveFetch({
        anonymousBundleStatus: 200,
        pronunciationStatus: 404,
        pwaOverrides: {
          '/site.webmanifest': { status: 200, body: '{"name": ""}', contentType: 'application/json' },
          '/sw.js': { status: 200, body: '<!doctype html><html></html>', contentType: 'text/html' },
          '/favicon-light.svg': { status: 200, body: 'not-an-svg', contentType: 'text/plain' },
          '/favicon-dark.svg': { status: 404, body: 'missing', contentType: 'text/plain' },
        },
      }),
      execWrangler: makeMockD1Wrangler({ sqlLog }),
      browserFactory: makeFakeBrowserFactory({
        h1Visible: false,
        h1Text: '',
        pageErrors: ['Uncaught ReferenceError: boom'],
        failedRequests: [
          { url: 'https://alder.example.org/assets/main.js', reason: 'net::ERR_FAILED' },
          { url: 'https://thirdparty.example.com/assets/ignore.js', reason: 'net::ERR_ABORTED' },
        ],
        responses: [{ url: 'https://alder.example.org/api/bundle', status: 500 }],
      }),
      clock: deterministicClock,
    });

    expect(result.ok).toBe(false);
    expect(result.anonymousGate.status).toBe('fail');
    expect(result.probe.ok).toBe(false);
    expect(result.browser.status).toBe('fail');
    expect(result.browser.failedRequests).toEqual([
      'https://alder.example.org/assets/main.js (net::ERR_FAILED)',
    ]);
    expect(result.browser.failedResponses).toEqual(['500 https://alder.example.org/api/bundle']);
    expect(result.pwa.status).toBe('fail');
    expect(result.pwa.assets.filter((a) => !a.ok)).toHaveLength(4);
    expect(result.cleanup?.remainingTmpCount).toBe(0);
    expect(sqlLog.some((s) => s.includes('DELETE FROM agent_tokens'))).toBe(true);

    const textReport = formatVerifyLiveTextReport(result);
    expect(textReport).toContain('Live Verification: FAIL');
    expect(textReport).toContain('Violations:');
  });

  it('supports --token without D1 calls, handles browser/network errors gracefully, and dispatches cleanly via runCli', async () => {
    const emptyDir = await makeTempDir('kinloom-verify-live-notmp-');
    let wranglerCalled = false;
    const execWrangler: WranglerExecutor = async () => {
      wranglerCalled = true;
      return { stdout: '[]', stderr: '' };
    };

    const tokenRes = await runVerifyLiveCommand({
      repoDir: emptyDir,
      url: 'https://alder.example.org',
      token: 'explicit_bearer_token',
      browser: true,
      fetchImpl: makeLiveArchiveFetch(),
      execWrangler,
      browserFactory: async () => {
        throw new Error('chromium missing');
      },
      clock: deterministicClock,
    });

    expect(wranglerCalled).toBe(false);
    expect(tokenRes.authMode).toBe('bearer-token');
    expect(tokenRes.cleanup).toBeNull();
    expect(tokenRes.browser.status).toBe('fail');
    expect(tokenRes.browser.violations[0]).toContain('chromium missing');

    // CLI dispatch JSON + text + help + guide + validation errors
    const repoDir = await makeWranglerRepo(true);
    const { io, stdout } = createCaptureIo();
    const okCode = await runCli(['verify-live', '--repo', repoDir, '--check-pwa', '--json'], {
      cwd: repoDir,
      io,
      fetchImpl: makeLiveArchiveFetch(),
      execWrangler: makeMockD1Wrangler(),
    });
    expect(okCode).toBe(EXIT_OK);
    const parsedJson = JSON.parse(stdout.join('\n')) as {
      ok: boolean;
      authMode: string;
      pwa: { status: string };
    };
    expect(parsedJson.ok).toBe(true);
    expect(parsedJson.authMode).toBe('ephemeral-d1');
    expect(parsedJson.pwa.status).toBe('pass');

    const failIo = createCaptureIo();
    const failCode = await runCli(['verify-live', '--url', 'https://alder.example.org', '--token', 'tok_1'], {
      cwd: emptyDir,
      io: failIo.io,
      fetchImpl: makeLiveArchiveFetch({ anonymousBundleStatus: 200 }),
    });
    expect(failCode).toBe(EXIT_ERROR);

    const helpIo = createCaptureIo();
    expect(await runCli(['verify-live', '--help'], { cwd: emptyDir, io: helpIo.io })).toBe(EXIT_OK);
    expect(helpIo.stdout.join('\n')).toContain('Usage: kinloom verify-live');

    const guideIo = createCaptureIo();
    expect(await runCli(['verify-live', '--guide'], { cwd: emptyDir, io: guideIo.io })).toBe(EXIT_OK);
    expect(guideIo.stdout.join('\n')).toContain('Live Deployment Verification');

    const usageIo = createCaptureIo();
    expect(
      await runCli(['verify-live', '--token', 't', '--with-temp-auth'], { cwd: repoDir, io: usageIo.io })
    ).toBe(EXIT_USAGE);
    expect(await runCli(['verify-live'], { cwd: emptyDir, io: usageIo.io })).toBe(EXIT_USAGE);
    expect(
      await runCli(['verify-live', '--url', 'https://alder.example.org', '--timeout-ms', '100'], {
        cwd: emptyDir,
        io: usageIo.io,
      })
    ).toBe(EXIT_USAGE);

    // Non-JSON / non-200 / network error paths on privacy & PWA checks
    const errRes = await runVerifyLiveCommand({
      repoDir: emptyDir,
      url: 'https://alder.example.org',
      checkPwa: true,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      clock: deterministicClock,
    });
    expect(errRes.ok).toBe(false);
    expect(errRes.authMode).toBe('anonymous');
    expect(errRes.anonymousGate.status).toBe('fail');
    expect(errRes.privacy.status).toBe('fail');
    expect(errRes.pwa.status).toBe('fail');

    // Non-200 & non-JSON authenticated /api/bundle, plus invalid-JSON/non-object manifest & empty sw.js
    const non200Bundle = await runVerifyLiveCommand({
      repoDir: emptyDir,
      url: 'https://alder.example.org',
      token: 'tok_non200',
      checkPwa: true,
      fetchImpl: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === '/api/bundle') {
          return new Response('server err', { status: 503 });
        }
        if (pathname === '/site.webmanifest') {
          return new Response('{bad-json', { status: 200 });
        }
        if (pathname === '/sw.js') {
          return new Response('   ', { status: 200 });
        }
        return new Response('<svg></svg>', { status: 200 });
      },
      clock: deterministicClock,
    });
    expect(non200Bundle.privacy.status).toBe('fail');
    expect(non200Bundle.privacy.violations[0]).toContain('HTTP 503');
    expect(non200Bundle.pwa.assets.find((a) => a.path === '/site.webmanifest')?.detail).toBe(
      'invalid JSON manifest'
    );
    expect(non200Bundle.pwa.assets.find((a) => a.path === '/sw.js')?.detail).toBe(
      'empty service worker script'
    );

    const nonJsonBundle = await runVerifyLiveCommand({
      repoDir: emptyDir,
      url: 'https://alder.example.org',
      token: 'tok_nonjson',
      checkPwa: true,
      fetchImpl: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === '/api/bundle') {
          return new Response('<html>not json</html>', { status: 200 });
        }
        if (pathname === '/site.webmanifest') {
          return new Response('[]', { status: 200 });
        }
        return new Response('<svg></svg>', { status: 200 });
      },
      clock: deterministicClock,
    });
    expect(nonJsonBundle.privacy.violations[0]).toContain('non-JSON');
    expect(nonJsonBundle.pwa.assets.find((a) => a.path === '/site.webmanifest')?.detail).toBe(
      'manifest must be a JSON object'
    );

    // Ephemeral mode with missing routes[0].pattern and no --url fails validation cleanly
    const noRouteRepo = await makeWranglerRepo(false);
    await expect(
      runVerifyLiveCommand({
        repoDir: noRouteRepo,
        execWrangler: makeMockD1Wrangler(),
      })
    ).rejects.toThrow(/Missing target URL/);

    // Explicit --token + --browser + malformed items in bundle privacy + missing failure errorText
    const seenBrowserHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
    const tokenBrowserRes = await runVerifyLiveCommand({
      repoDir: emptyDir,
      url: 'https://alder.example.org',
      token: 'tok_browser_direct',
      browser: true,
      fetchImpl: makeLiveArchiveFetch(),
      browserFactory: async () => ({
        newContext: async (opts) => {
          seenBrowserHeaders.push(opts?.extraHTTPHeaders);
          return {
            newPage: async () => {
              let reqFail:
                | ((req: { url(): string; failure(): { errorText?: string } | null }) => void)
                | null = null;
              return {
                on: (event: string, listener: (...args: never[]) => void) => {
                  if (event === 'requestfailed') {
                    reqFail = listener as (req: {
                      url(): string;
                      failure(): { errorText?: string } | null;
                    }) => void;
                  }
                },
                goto: async () => {
                  reqFail?.({ url: () => 'not-a-valid-url', failure: () => null });
                  reqFail?.({ url: () => 'https://alder.example.org/assets/chunk.js', failure: () => null });
                },
                evaluate: async <T>(): Promise<T> => ({ visible: true, text: 'Archive' }) as T,
                close: async () => undefined,
              };
            },
            close: async () => undefined,
          };
        },
        close: async () => undefined,
      }),
      clock: deterministicClock,
    });
    expect(seenBrowserHeaders).toEqual([{ Authorization: 'Bearer tok_browser_direct' }]);
    expect(tokenBrowserRes.browser.status).toBe('fail');
    expect(tokenBrowserRes.browser.failedRequests).toEqual(['https://alder.example.org/assets/chunk.js']);

    // Defensive non-record elements & unknown build_mode in evaluateLiveBundlePrivacy
    const mixedPrivacy = evaluateLiveBundlePrivacy(
      {
        people: [null, { full_name: 'Living', is_living: true, thumb_url: '/media/t.jpg' }],
        events: [null, { participants: [{ person_id: 'per_x' }] }],
        residence_spans: [null, { person_id: 'per_x' }],
        media: [null, { person_id: 'per_x' }],
        narratives: [null, { person_id: 'per_x', subject_person_ids: ['per_x'] }],
      },
      'https://alder.example.org/api/bundle',
      200
    );
    expect(mixedPrivacy.buildMode).toBe('unknown');
    expect(mixedPrivacy.counts.livingPortraits).toBe(1);

    // formatVerifyLiveTextReport with backupCountBefore: null
    const formattedNullBefore = formatVerifyLiveTextReport({
      ...tokenBrowserRes,
      cleanup: {
        deletedTokenIds: ['tmp_cli_read_1'],
        deletedInviteTokens: [],
        remainingTmpTokenCount: 0,
        remainingTmpInviteCount: 0,
        remainingTmpCount: 0,
        backupTokenLabel: 'github-actions-nightly-backup',
        backupCountBefore: null,
        backupCountAfter: 1,
      },
    });
    expect(formattedNullBefore).toContain('backupBefore=n/a');
  });

  it('validates live /site.webmanifest title and /favicon-light.svg + /sw.js accents against local kinloom.config.yaml when --check-pwa is enabled', async () => {
    const repoDir = await makeTempDir('kinloom-verify-live-pwa-drift-');
    await writeFile(
      path.join(repoDir, 'kinloom.config.yaml'),
      `schemaVersion: 1
site:
  title: Cedar Valley Archive
  familyName: Cedar
  gedcomSourceName: CEDAR_ARCHIVE
  footerCredit: Built with Kinloom
theme:
  accent: "#2F5245"
`,
      'utf8'
    );

    // Passing run: manifest title, favicon-light accent, and sw.js accent all match kinloom.config.yaml
    const alignedRes = await runVerifyLiveCommand({
      repoDir,
      url: 'https://cedar.example.org',
      token: 'tok_pwa_ok',
      checkPwa: true,
      fetchImpl: makeLiveArchiveFetch({
        pwaOverrides: {
          '/site.webmanifest': {
            status: 200,
            body: JSON.stringify({
              name: 'Cedar Valley Archive',
              short_name: 'Cedar Valley',
              icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
            }),
            contentType: 'application/manifest+json',
          },
          '/sw.js': {
            status: 200,
            body: 'const OFFLINE_HTML = ":root{--bg:#F5EFE2;--accent:#2F5245}";',
            contentType: 'application/javascript',
          },
          '/favicon-light.svg': {
            status: 200,
            body: '<svg xmlns="http://www.w3.org/2000/svg"><style>.kl-accent { stroke: #2F5245; }</style></svg>',
            contentType: 'image/svg+xml',
          },
        },
      }),
      clock: deterministicClock,
    });
    expect(alignedRes.ok).toBe(true);
    expect(alignedRes.pwa.status).toBe('pass');
    expect(alignedRes.pwa.violations).toEqual([]);

    // Failing run: live manifest serves generic "Kinloom" and favicon-light + sw.js serve drifted ochre accent
    const driftedRes = await runVerifyLiveCommand({
      repoDir,
      url: 'https://cedar.example.org',
      token: 'tok_pwa_drift',
      checkPwa: true,
      fetchImpl: makeLiveArchiveFetch({
        pwaOverrides: {
          '/site.webmanifest': {
            status: 200,
            body: JSON.stringify({
              name: 'Kinloom',
              short_name: 'Kinloom',
              icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
            }),
            contentType: 'application/manifest+json',
          },
          '/sw.js': {
            status: 200,
            body: 'const OFFLINE_HTML = ":root{--bg:#F5EFE2;--accent:#7A4612}";',
            contentType: 'application/javascript',
          },
          '/favicon-light.svg': {
            status: 200,
            body: '<svg xmlns="http://www.w3.org/2000/svg"><style>.kl-accent { stroke: #7A4612; }</style></svg>',
            contentType: 'image/svg+xml',
          },
        },
      }),
      clock: deterministicClock,
    });
    expect(driftedRes.ok).toBe(false);
    expect(driftedRes.pwa.status).toBe('fail');
    expect(driftedRes.pwa.assets.find((a) => a.path === '/site.webmanifest')).toMatchObject({
      ok: false,
      httpStatus: 200,
    });
    expect(driftedRes.pwa.assets.find((a) => a.path === '/site.webmanifest')?.detail).toContain(
      'kinloom brandkit --out public'
    );
    expect(driftedRes.pwa.assets.find((a) => a.path === '/sw.js')?.detail).toContain(
      'sw.js offline notice uses accent #7A4612'
    );
    expect(driftedRes.pwa.assets.find((a) => a.path === '/favicon-light.svg')?.detail).toContain(
      'favicon-light.svg uses accent #7A4612'
    );

    // Invalid local kinloom.config.yaml does not crash --check-pwa
    const badCfgDir = await makeTempDir('kinloom-verify-live-bad-cfg-');
    await writeFile(path.join(badCfgDir, 'kinloom.config.yaml'), 'site:\n  title: [broken', 'utf8');
    const badCfgRes = await runVerifyLiveCommand({
      repoDir: badCfgDir,
      url: 'https://cedar.example.org',
      token: 'tok_bad_cfg',
      checkPwa: true,
      fetchImpl: makeLiveArchiveFetch(),
      clock: deterministicClock,
    });
    expect(badCfgRes.ok).toBe(true);
    expect(badCfgRes.pwa.status).toBe('pass');
  });
});
