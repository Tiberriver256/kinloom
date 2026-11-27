import { type ExecFileOptions, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ExecFileFn, type ExecFileResult, RecordRuntimeError } from './types.js';
import {
  assertSafeUrl,
  type CookieJar,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_USER_AGENT,
  HttpStatusError,
  looksLikeHtmlErrorPage,
  parseRetryAfterMs,
  SsrfBlockedError,
  type UrlSecurityPolicy,
} from './urlPolicy.js';

export {
  assertSafeUrl,
  CookieJar,
  DEFAULT_RETRY_STATUSES,
  DEFAULT_USER_AGENT,
  type HostAllowRule,
  HttpStatusError,
  isPrivateOrReservedIp,
  looksLikeHtmlErrorPage,
  parseRetryAfterMs,
  SsrfBlockedError,
  type UrlSecurityPolicy,
} from './urlPolicy.js';

export interface HttpRequestOptions {
  readonly method?: 'GET' | 'POST' | 'HEAD';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly retryStatuses?: ReadonlySet<number>;
  readonly maxRedirects?: number;
  readonly urlPolicy?: UrlSecurityPolicy;
  readonly cookieJar?: CookieJar;
  readonly fetchImpl: typeof fetch;
  readonly sleepFn: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  readonly throwOnHttpError?: boolean;
}

export interface HttpResponseResult {
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Buffer;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function httpRequest(rawUrl: string, options: HttpRequestOptions): Promise<HttpResponseResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseBackoffMs = options.baseBackoffMs ?? 500;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
  const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const maxRedirects = options.maxRedirects ?? 10;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const nowMs = options.nowMs ?? (() => Date.now());
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  const throwOnHttpError = options.throwOnHttpError ?? true;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let currentUrl = assertSafeUrl(rawUrl, options.urlPolicy).toString();
    let currentMethod: 'GET' | 'POST' | 'HEAD' = options.method ?? 'GET';
    let currentBody = options.body;

    try {
      let response: Response | undefined;
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        assertSafeUrl(currentUrl, options.urlPolicy);

        const reqHeaders = new Headers();
        reqHeaders.set('user-agent', userAgent);
        if (options.headers) {
          for (const [k, v] of Object.entries(options.headers)) {
            reqHeaders.set(k, v);
          }
        }
        if (options.cookieJar) {
          const cookieHeader = options.cookieJar.toHeaderValue();
          if (cookieHeader && !reqHeaders.has('cookie')) {
            reqHeaders.set('cookie', cookieHeader);
          }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const fetchInit: RequestInit = {
            method: currentMethod,
            headers: reqHeaders,
            redirect: 'manual',
            signal: controller.signal,
          };
          if (currentBody !== undefined && currentMethod === 'POST') {
            fetchInit.body = typeof currentBody === 'string' ? currentBody : Buffer.from(currentBody);
          }
          response = await options.fetchImpl(currentUrl, fetchInit);
        } finally {
          clearTimeout(timer);
        }

        options.cookieJar?.captureFromHeaders(response.headers);

        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            break;
          }
          if (hop === maxRedirects) {
            throw new RecordRuntimeError(`Too many redirects (${maxRedirects}) for ${rawUrl}`);
          }
          const nextUrl = new URL(location, currentUrl).toString();
          assertSafeUrl(nextUrl, options.urlPolicy);
          currentUrl = nextUrl;
          if (
            response.status === 303 ||
            ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
          ) {
            currentMethod = 'GET';
            currentBody = undefined;
          }
          continue;
        }
        break;
      }

      if (!response) {
        throw new RecordRuntimeError(`No HTTP response received for ${rawUrl}`);
      }

      const finalUrl = response.url ? assertSafeUrl(response.url, options.urlPolicy).toString() : currentUrl;
      const arrayBuf = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuf);

      if (retryStatuses.has(response.status) && attempt < maxAttempts) {
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'), nowMs(), maxRetryAfterMs);
        const backoff = retryAfter ?? Math.min(maxRetryAfterMs, baseBackoffMs * 2 ** (attempt - 1));
        await options.sleepFn(backoff);
        continue;
      }

      if (throwOnHttpError && (response.status < 200 || response.status >= 300)) {
        const snippet = bytes.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
        throw new HttpStatusError(response.status, finalUrl, snippet);
      }

      return {
        status: response.status,
        url: finalUrl,
        headers: response.headers,
        bytes,
      };
    } catch (err: unknown) {
      if (err instanceof SsrfBlockedError || err instanceof HttpStatusError) {
        throw err;
      }
      lastError = err;
      if (attempt < maxAttempts) {
        const backoff = Math.min(maxRetryAfterMs, baseBackoffMs * 2 ** (attempt - 1));
        await options.sleepFn(backoff);
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new RecordRuntimeError(`Network error fetching ${rawUrl}: ${message}`);
}

export async function httpGetJson(
  rawUrl: string,
  options: HttpRequestOptions
): Promise<{ readonly data: unknown; readonly response: HttpResponseResult }> {
  const response = await httpRequest(rawUrl, options);
  if (looksLikeHtmlErrorPage(response.bytes)) {
    throw new RecordRuntimeError(
      `Expected JSON from ${response.url}, but received an HTML page (HTTP ${response.status}).`
    );
  }
  try {
    const data: unknown = JSON.parse(response.bytes.toString('utf8'));
    return { data, response };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Invalid JSON from ${response.url}: ${message}`);
  }
}

export async function httpGetText(
  rawUrl: string,
  options: HttpRequestOptions
): Promise<{ readonly text: string; readonly response: HttpResponseResult }> {
  const response = await httpRequest(rawUrl, options);
  return {
    text: response.bytes.toString('utf8'),
    response,
  };
}

export interface BinaryFetchOptions extends HttpRequestOptions {
  readonly rejectHtml?: boolean;
  readonly verifyContentLength?: boolean;
}

export async function httpGetBytes(rawUrl: string, options: BinaryFetchOptions): Promise<HttpResponseResult> {
  const response = await httpRequest(rawUrl, options);
  if (options.rejectHtml !== false && looksLikeHtmlErrorPage(response.bytes)) {
    throw new RecordRuntimeError(
      `Expected binary payload from ${response.url}, but received an HTML error page.`
    );
  }
  if (options.verifyContentLength) {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader && /^\d+$/.test(contentLengthHeader.trim())) {
      const expected = Number.parseInt(contentLengthHeader.trim(), 10);
      if (response.bytes.length !== expected) {
        throw new RecordRuntimeError(
          `Incomplete download from ${response.url}: expected ${expected} bytes, got ${response.bytes.length}.`
        );
      }
    }
  }
  return response;
}

export const CURL_META_MARKER = '__KINLOOM_CURL_META__';

export const RETRYABLE_CURL_EXIT_CODES: ReadonlySet<number> = new Set([6, 7, 18, 28, 35, 52, 55, 56, 92]);

export function defaultExecFile(
  file: string,
  args: readonly string[],
  options?: ExecFileOptions
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        maxBuffer: 64 * 1024 * 1024,
        ...options,
        encoding: 'buffer',
      },
      (err, stdout, stderr) => {
        const outBuf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        const errBuf = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
        if (err) {
          const enriched = err as Error & {
            stdout?: Buffer;
            stderr?: Buffer;
            code?: number | string | null;
            killed?: boolean;
            signal?: NodeJS.Signals | null;
          };
          enriched.stdout = outBuf;
          enriched.stderr = errBuf;
          reject(enriched);
          return;
        }
        resolve({ stdout: outBuf, stderr: errBuf });
      }
    );
  });
}

export interface CurlFetchOptions {
  readonly headers?: Readonly<Record<string, string>>;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly connectTimeoutSec?: number;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly retryStatuses?: ReadonlySet<number>;
  readonly urlPolicy?: UrlSecurityPolicy;
  readonly execFileImpl?: ExecFileFn;
  readonly sleepFn: (ms: number) => Promise<void>;
  readonly nowMs?: () => number;
  readonly throwOnHttpError?: boolean;
  readonly rejectHtml?: boolean;
}

function parseCurlHeaders(rawHeaders: string): Headers {
  const headers = new Headers();
  const blocks = rawHeaders.split(/\r?\n\r?\n/).filter((b) => b.trim().length > 0);
  const lastBlock = blocks.at(-1) ?? '';
  for (const line of lastBlock.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name && !name.startsWith('HTTP/')) {
      try {
        headers.append(name, value);
      } catch {
        // Ignore non-standard header names from legacy servers.
      }
    }
  }
  return headers;
}

export async function fetchWithCurl(rawUrl: string, options: CurlFetchOptions): Promise<HttpResponseResult> {
  const validatedUrl = assertSafeUrl(rawUrl, options.urlPolicy).toString();
  const execFn = options.execFileImpl ?? defaultExecFile;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
  const baseBackoffMs = options.baseBackoffMs ?? 1000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;
  const retryStatuses = options.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 60_000);
  const connectTimeoutSec = Math.max(1, Math.ceil(options.connectTimeoutSec ?? 15));
  const nowMs = options.nowMs ?? (() => Date.now());
  const userAgent = options.userAgent ?? 'Mozilla/5.0';
  const throwOnHttpError = options.throwOnHttpError ?? true;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-curl-'));
    const hdrPath = path.join(tmpDir, 'headers.txt');
    try {
      const attemptMaxSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      const args: string[] = [
        '-sSL',
        '-A',
        userAgent,
        '--max-time',
        String(attemptMaxSec),
        '--connect-timeout',
        String(Math.min(connectTimeoutSec, attemptMaxSec)),
        '-D',
        hdrPath,
        '-w',
        `\n${CURL_META_MARKER}\n%{http_code}\n%{url_effective}`,
      ];
      if (options.headers) {
        for (const [k, v] of Object.entries(options.headers)) {
          args.push('-H', `${k}: ${v}`);
        }
      }
      args.push(validatedUrl);

      const { stdout } = await execFn('curl', args, { timeout: timeoutMs + 5000 });
      const markerBuf = Buffer.from(`\n${CURL_META_MARKER}\n`, 'utf8');
      const markerIdx = stdout.lastIndexOf(markerBuf);
      let bodyBytes: Buffer;
      let statusCode = 200;
      let effectiveUrl = validatedUrl;

      if (markerIdx !== -1) {
        bodyBytes = stdout.subarray(0, markerIdx);
        const metaLines = stdout
          .subarray(markerIdx + markerBuf.length)
          .toString('utf8')
          .trim()
          .split(/\r?\n/);
        const parsedCode = Number.parseInt(metaLines[0]?.trim() ?? '', 10);
        if (Number.isInteger(parsedCode) && parsedCode > 0) {
          statusCode = parsedCode;
        }
        if (metaLines[1]?.trim()) {
          effectiveUrl = metaLines[1].trim();
        }
      } else {
        bodyBytes = stdout;
      }

      const safeEffectiveUrl = assertSafeUrl(effectiveUrl, options.urlPolicy).toString();
      let responseHeaders = new Headers();
      try {
        if (fs.existsSync(hdrPath)) {
          responseHeaders = parseCurlHeaders(fs.readFileSync(hdrPath, 'utf8'));
        }
      } catch {
        // Ignore missing header dump (e.g. when execFileImpl is mocked in tests).
      }

      if (retryStatuses.has(statusCode) && attempt < maxAttempts) {
        const retryAfter = parseRetryAfterMs(responseHeaders.get('retry-after'), nowMs(), maxRetryAfterMs);
        const backoff = retryAfter ?? Math.min(maxRetryAfterMs, baseBackoffMs * 2 ** (attempt - 1));
        await options.sleepFn(backoff);
        continue;
      }

      if (throwOnHttpError && (statusCode < 200 || statusCode >= 300)) {
        const snippet = bodyBytes.subarray(0, 200).toString('utf8').replace(/\s+/g, ' ').trim();
        throw new HttpStatusError(statusCode, safeEffectiveUrl, snippet);
      }

      if (options.rejectHtml && looksLikeHtmlErrorPage(bodyBytes)) {
        throw new RecordRuntimeError(
          `Expected binary payload from ${safeEffectiveUrl}, but received an HTML error page.`
        );
      }

      return {
        status: statusCode,
        url: safeEffectiveUrl,
        headers: responseHeaders,
        bytes: Buffer.from(bodyBytes),
      };
    } catch (err: unknown) {
      if (err instanceof SsrfBlockedError || err instanceof HttpStatusError) {
        throw err;
      }
      const errObj = err as { code?: unknown; stderr?: Buffer; message?: string };
      if (errObj.code === 'ENOENT') {
        throw new RecordRuntimeError('curl is required but was not found on PATH.');
      }
      const numericCode = typeof errObj.code === 'number' ? errObj.code : undefined;
      const stderrText = Buffer.isBuffer(errObj.stderr) ? errObj.stderr.toString('utf8').trim() : '';
      lastError = stderrText || (err instanceof Error ? err.message : String(err));
      const canRetry =
        attempt < maxAttempts && (numericCode === undefined || RETRYABLE_CURL_EXIT_CODES.has(numericCode));
      if (canRetry) {
        const backoff = Math.min(maxRetryAfterMs, baseBackoffMs * 2 ** (attempt - 1));
        await options.sleepFn(backoff);
        continue;
      }
      break;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }

  throw new RecordRuntimeError(`curl error fetching ${validatedUrl}: ${String(lastError)}`);
}
