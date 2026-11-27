import { isIP } from 'node:net';
import { RecordRuntimeError } from './types.js';

export const DEFAULT_USER_AGENT = 'kinloom-records/1.0 (+https://github.com/Tiberriver256/kinloom)';

export const DEFAULT_RETRY_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 520, 522, 524]);

export type HostAllowRule = string | RegExp | ((hostname: string) => boolean);

export interface UrlSecurityPolicy {
  readonly allowedSchemes?: readonly ('https:' | 'http:')[];
  readonly allowedHosts?: readonly HostAllowRule[];
  readonly blockPrivateIps?: boolean;
}

export class SsrfBlockedError extends RecordRuntimeError {
  readonly url: string;

  constructor(url: string, reason: string) {
    super(`Refused unsafe URL '${url}': ${reason}`, 1);
    this.name = 'SsrfBlockedError';
    this.url = url;
  }
}

export class HttpStatusError extends RecordRuntimeError {
  readonly status: number;
  readonly url: string;
  readonly bodySnippet: string;

  constructor(status: number, url: string, bodySnippet = '') {
    const suffix = bodySnippet ? `: ${bodySnippet}` : '';
    super(`HTTP ${status} fetching ${url}${suffix}`, 1);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) {
      return null;
    }
    const n = Number.parseInt(part, 10);
    if (n < 0 || n > 255) {
      return null;
    }
    nums.push(n);
  }
  return [nums[0], nums[1], nums[2], nums[3]];
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const octets = parseIpv4Octets(ip);
  if (!octets) {
    return true;
  }
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function expandIpv6(ip: string): number[] | null {
  let normalized = ip.toLowerCase();
  const zoneIdx = normalized.indexOf('%');
  if (zoneIdx !== -1) {
    normalized = normalized.slice(0, zoneIdx);
  }
  const doubleColonParts = normalized.split('::');
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseGroupList = (segment: string): number[] | null => {
    if (segment === '') {
      return [];
    }
    const items = segment.split(':');
    const out: number[] = [];
    for (let i = 0; i < items.length; i += 1) {
      const part = items[i];
      if (i === items.length - 1 && part.includes('.')) {
        const octets = parseIpv4Octets(part);
        if (!octets) {
          return null;
        }
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) {
          return null;
        }
        out.push(Number.parseInt(part, 16));
      }
    }
    return out;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseGroupList(doubleColonParts[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseGroupList(doubleColonParts[0]);
  const right = parseGroupList(doubleColonParts[1]);
  if (!left || !right) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

export function isPrivateOrReservedIp(rawHost: string): boolean {
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const version = isIP(host);
  if (version === 4) {
    return isPrivateOrReservedIpv4(host);
  }
  if (version === 6) {
    const groups = expandIpv6(host);
    if (!groups) {
      return true;
    }
    const allZero = groups.every((g) => g === 0);
    if (allZero) return true; // ::
    const isLoopback = groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1;
    if (isLoopback) return true; // ::1
    const isV4Mapped = groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0);
    if (isV4Mapped) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
      return isPrivateOrReservedIpv4(v4);
    }
    if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((groups[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32
    return false;
  }
  return false;
}

function matchesHostRule(hostname: string, rule: HostAllowRule): boolean {
  const normalized = hostname.toLowerCase();
  if (typeof rule === 'function') {
    return rule(normalized);
  }
  if (rule instanceof RegExp) {
    return rule.test(normalized);
  }
  const target = rule.toLowerCase();
  if (target.startsWith('.')) {
    return normalized.endsWith(target) || normalized === target.slice(1);
  }
  return normalized === target;
}

export function assertSafeUrl(rawUrl: string, policy: UrlSecurityPolicy = {}): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, 'malformed URL');
  }

  const allowedSchemes = policy.allowedSchemes ?? ['https:'];
  if (!allowedSchemes.includes(parsed.protocol as 'https:' | 'http:')) {
    throw new SsrfBlockedError(
      rawUrl,
      `disallowed scheme '${parsed.protocol}' (allowed: ${allowedSchemes.join(', ')})`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new SsrfBlockedError(rawUrl, 'missing hostname');
  }

  if (policy.blockPrivateIps !== false) {
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      throw new SsrfBlockedError(rawUrl, `disallowed local host '${hostname}'`);
    }
    const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (isIP(bare) !== 0 && isPrivateOrReservedIp(bare)) {
      throw new SsrfBlockedError(rawUrl, `disallowed private or reserved IP '${bare}'`);
    }
  }

  if (policy.allowedHosts && policy.allowedHosts.length > 0) {
    const ok = policy.allowedHosts.some((rule) => matchesHostRule(hostname, rule));
    if (!ok) {
      throw new SsrfBlockedError(rawUrl, `host '${hostname}' is not in the allowlist`);
    }
  }

  return parsed;
}

export class CookieJar {
  private readonly store = new Map<string, string>();

  captureFromHeaders(headers: Headers): void {
    const list =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : (() => {
            const single = headers.get('set-cookie');
            return single ? [single] : [];
          })();

    for (const raw of list) {
      const firstPart = raw.split(';', 1)[0]?.trim();
      if (!firstPart) {
        continue;
      }
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx <= 0) {
        continue;
      }
      const name = firstPart.slice(0, eqIdx).trim();
      const value = firstPart.slice(eqIdx + 1).trim();
      if (name) {
        this.store.set(name, value);
      }
    }
  }

  toHeaderValue(): string | undefined {
    if (this.store.size === 0) {
      return undefined;
    }
    const pairs: string[] = [];
    for (const [name, value] of this.store.entries()) {
      pairs.push(`${name}=${value}`);
    }
    return pairs.join('; ');
  }

  get(name: string): string | undefined {
    return this.store.get(name);
  }

  set(name: string, value: string): void {
    this.store.set(name, value);
  }
}

export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number,
  maxMs = 30_000
): number | undefined {
  if (!headerValue) {
    return undefined;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxMs, Math.round(seconds * 1000));
    }
  }
  const parsedDate = Date.parse(trimmed);
  if (Number.isFinite(parsedDate)) {
    return Math.min(maxMs, Math.max(0, parsedDate - nowMs));
  }
  return undefined;
}

const HTML_SIGNATURE_RE = /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<title\b)/i;

export function looksLikeHtmlErrorPage(payload: Uint8Array | string): boolean {
  const sample =
    typeof payload === 'string'
      ? payload.slice(0, 512)
      : Buffer.from(payload.subarray(0, 512)).toString('utf8');
  return HTML_SIGNATURE_RE.test(sample);
}
