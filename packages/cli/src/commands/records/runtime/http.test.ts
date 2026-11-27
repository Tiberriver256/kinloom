import { describe, expect, it } from 'vitest';
import {
  assertSafeUrl,
  CookieJar,
  CURL_META_MARKER,
  fetchWithCurl,
  HttpStatusError,
  httpGetBytes,
  httpGetJson,
  httpRequest,
  isPrivateOrReservedIp,
  looksLikeHtmlErrorPage,
  parseRetryAfterMs,
  SsrfBlockedError,
} from './http.js';

const instantSleep = async (): Promise<void> => {};

describe('records runtime http client', () => {
  it('blocks private/reserved IPv4, IPv6, localhost, non-HTTPS, and disallowed hosts', () => {
    expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    expect(isPrivateOrReservedIp('172.16.5.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.1.10')).toBe(true);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);

    expect(() => assertSafeUrl('http://catalog.archives.gov/api')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('https://localhost/secret')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('https://169.254.169.254/latest/meta-data')).toThrow(SsrfBlockedError);
    expect(() => assertSafeUrl('https://evil.example/file.jpg', { allowedHosts: ['.archives.gov'] })).toThrow(
      SsrfBlockedError
    );
    expect(assertSafeUrl('https://catalog.archives.gov/api', { allowedHosts: ['.archives.gov'] }).host).toBe(
      'catalog.archives.gov'
    );
  });

  it('retries 429/503/522 and transient network failures, honoring Retry-After capped at 30s', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } });
      }
      if (calls === 2) {
        return new Response('cloudflare timeout', { status: 522 });
      }
      if (calls === 3) {
        throw new TypeError('socket hang up');
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { data } = await httpGetJson('https://api.example.org/search', {
      fetchImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 4,
      baseBackoffMs: 100,
    });
    expect(data).toEqual({ ok: true });
    expect(calls).toBe(4);
    expect(sleeps).toEqual([2000, 200, 400]);

    expect(parseRetryAfterMs('120', 0, 30_000)).toBe(30_000);
    expect(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 0, 30_000)).toBe(5_000);
  });

  it('blocks SSRF redirects BEFORE connecting to disallowed hosts and preserves cookies across safe redirects', async () => {
    const visited: string[] = [];
    const fetchBlocked: typeof fetch = async (input) => {
      const url = String(input);
      visited.push(url);
      return new Response('', {
        status: 302,
        headers: { location: 'https://127.0.0.1/internal' },
      });
    };

    await expect(
      httpRequest('https://proxy.archieven.nl/scan', {
        fetchImpl: fetchBlocked,
        sleepFn: instantSleep,
      })
    ).rejects.toThrow(SsrfBlockedError);
    expect(visited).toEqual(['https://proxy.archieven.nl/scan']);

    // Cookie jar tracks cookies across safe redirect hops.
    const jar = new CookieJar();
    const seenCookies: (string | null)[] = [];
    const fetchRedirect: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seenCookies.push(headers.get('cookie'));
      if (url.endsWith('/start')) {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://archive.example.org/final',
            'set-cookie': 'session_id=abc123; Path=/; HttpOnly',
          },
        });
      }
      return new Response('final-ok', { status: 200 });
    };

    const res = await httpRequest('https://archive.example.org/start', {
      fetchImpl: fetchRedirect,
      sleepFn: instantSleep,
      cookieJar: jar,
    });
    expect(res.bytes.toString('utf8')).toBe('final-ok');
    expect(jar.get('session_id')).toBe('abc123');
    expect(seenCookies).toEqual([null, 'session_id=abc123']);
  });

  it('rejects HTML error pages and truncated Content-Length payloads on binary fetches', async () => {
    expect(looksLikeHtmlErrorPage('<!DOCTYPE html><html><body>Denied</body></html>')).toBe(true);
    expect(looksLikeHtmlErrorPage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);

    await expect(
      httpGetBytes('https://images.example.org/scan.jpg', {
        fetchImpl: async () => new Response('<html><body>403</body></html>', { status: 200 }),
        sleepFn: instantSleep,
      })
    ).rejects.toThrow(/HTML error page/);

    await expect(
      httpGetBytes('https://images.example.org/scan.jpg', {
        fetchImpl: async () =>
          new Response(Buffer.from([1, 2, 3]), {
            status: 200,
            headers: { 'content-length': '10' },
          }),
        sleepFn: instantSleep,
        verifyContentLength: true,
      })
    ).rejects.toThrow(/Incomplete download/);

    await expect(
      httpRequest('https://api.example.org/missing', {
        fetchImpl: async () => new Response('not found', { status: 404 }),
        sleepFn: instantSleep,
      })
    ).rejects.toThrow(HttpStatusError);
  });

  it('fetches via isolated curl transport with allowlist enforcement and transient retries', async () => {
    let calls = 0;
    const res = await fetchWithCurl('https://michigan.access.preservica.com/?s=smith', {
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['michigan.access.preservica.com'] },
      sleepFn: instantSleep,
      maxAttempts: 3,
      execFileImpl: async (_file, args) => {
        calls += 1;
        if (calls === 1) {
          const err = new Error('timeout') as Error & { code?: number };
          err.code = 28;
          throw err;
        }
        const target = args.at(-1) ?? '';
        return {
          stdout: Buffer.from(`<html>ok</html>\n${CURL_META_MARKER}\n200\n${target}`),
          stderr: Buffer.alloc(0),
        };
      },
    });
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(res.bytes.toString('utf8')).toBe('<html>ok</html>');

    await expect(
      fetchWithCurl('https://evil.example/page', {
        urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ['michigan.access.preservica.com'] },
        sleepFn: instantSleep,
        execFileImpl: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
      })
    ).rejects.toThrow(SsrfBlockedError);
  });
});
