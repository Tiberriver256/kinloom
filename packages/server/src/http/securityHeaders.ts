export const DEFAULT_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://www.openhistoricalmap.org https://*.openhistoricalmap.org",
  "connect-src 'self' https://www.openhistoricalmap.org https://*.openhistoricalmap.org",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://accounts.google.com",
].join('; ');

export const MEDIA_CONTENT_SECURITY_POLICY = "default-src 'none'; sandbox";

export const STRICT_TRANSPORT_SECURITY_VALUE = 'max-age=31536000; includeSubDomains';

export interface ApplySecurityHeadersOptions {
  isSecure: boolean;
  isMedia?: boolean;
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
  } else if (!headers.has('content-security-policy')) {
    headers.set('content-security-policy', DEFAULT_CONTENT_SECURITY_POLICY);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
