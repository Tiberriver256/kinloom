export interface ServerCspDirectiveAdditions {
  readonly scriptSrc?: readonly string[];
  readonly connectSrc?: readonly string[];
}

const STRICT_HTTPS_ORIGIN_PATTERN = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/;

const BASE_CSP_DIRECTIVES = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self' 'unsafe-inline'"],
  ['img-src', "'self' data: blob: https:"],
  ['font-src', "'self' data: https://www.openhistoricalmap.org https://*.openhistoricalmap.org"],
  ['connect-src', "'self' https://www.openhistoricalmap.org https://*.openhistoricalmap.org"],
  ['media-src', "'self' blob:"],
  ['worker-src', "'self' blob:"],
  ['object-src', "'none'"],
  ['base-uri', "'self'"],
  ['frame-ancestors', "'none'"],
  ['form-action', "'self' https://accounts.google.com"],
] as const;

function validateStrictHttpsCspOrigin(rawOrigin: string, directive: 'script-src' | 'connect-src'): string {
  if (!STRICT_HTTPS_ORIGIN_PATTERN.test(rawOrigin)) {
    throw new RangeError(
      `Invalid CSP origin '${rawOrigin}' for '${directive}'. Only exact lowercase https:// origins are permitted.`
    );
  }
  return rawOrigin;
}

function appendValidatedOrigins(
  baseValue: string,
  additions: readonly string[] | undefined,
  directive: 'script-src' | 'connect-src'
): string {
  if (!additions || additions.length === 0) {
    return baseValue;
  }
  const seen = new Set(baseValue.split(' '));
  const extra: string[] = [];
  for (const origin of additions) {
    const validated = validateStrictHttpsCspOrigin(origin, directive);
    if (!seen.has(validated)) {
      seen.add(validated);
      extra.push(validated);
    }
  }
  return extra.length > 0 ? `${baseValue} ${extra.join(' ')}` : baseValue;
}

/**
 * Builds Kinloom's Content-Security-Policy string with optional strictly validated
 * HTTPS origin additions scoped exclusively to script-src and connect-src.
 */
export function buildContentSecurityPolicy(additions?: ServerCspDirectiveAdditions): string {
  return BASE_CSP_DIRECTIVES.map(([directive, baseValue]) => {
    if (directive === 'script-src') {
      return `${directive} ${appendValidatedOrigins(baseValue, additions?.scriptSrc, 'script-src')}`;
    }
    if (directive === 'connect-src') {
      return `${directive} ${appendValidatedOrigins(baseValue, additions?.connectSrc, 'connect-src')}`;
    }
    return `${directive} ${baseValue}`;
  }).join('; ');
}

export const DEFAULT_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy();

export const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

export const STRICT_TRANSPORT_SECURITY_VALUE = 'max-age=31536000; includeSubDomains';

export interface ApplySecurityHeadersOptions {
  isSecure: boolean;
  isMedia?: boolean;
  contentSecurityPolicy?: string;
}

/**
 * Applies standard edge HTTP security headers to API, HTML, static asset, and /media responses.
 */
export function applySecurityHeaders(response: Response, options: ApplySecurityHeadersOptions): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('x-frame-options', 'DENY');
  if (!headers.has('referrer-policy')) {
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  }
  if (options.isSecure) {
    headers.set('strict-transport-security', STRICT_TRANSPORT_SECURITY_VALUE);
  }
  if (options.isMedia) {
    headers.set('content-security-policy', MEDIA_CONTENT_SECURITY_POLICY);
    if (!headers.has('content-disposition')) {
      headers.set('content-disposition', 'inline');
    }
  } else {
    const targetCsp = options.contentSecurityPolicy ?? DEFAULT_CONTENT_SECURITY_POLICY;
    const existingCsp = headers.get('content-security-policy');
    if (
      existingCsp === null ||
      (options.contentSecurityPolicy !== undefined && existingCsp === DEFAULT_CONTENT_SECURITY_POLICY)
    ) {
      headers.set('content-security-policy', targetCsp);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
