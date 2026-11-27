import type { ServerDocumentContributions } from '../http/documentContributions.js';

export const CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
export const CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';
export const CLOUDFLARE_WEB_ANALYTICS_BEACON_URL = `${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN}/beacon.min.js`;
export const CLOUDFLARE_WEB_ANALYTICS_PRIVACY_DISCLOSURE_ID = 'cloudflare-web-analytics';
export const CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY =
  'This archive uses optional, cookie-free Cloudflare Web Analytics for aggregate page-load and Core Web Vitals performance telemetry with zero cookies, zero cross-site tracking, and zero advertising trackers.';

const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

export type CloudflareWebAnalyticsToken = string & {
  readonly __brand: 'CloudflareWebAnalyticsToken';
};

export type WebAnalyticsOptions =
  | {
      readonly enabled: false;
      readonly token?: string;
    }
  | {
      readonly enabled: true;
      readonly token: string;
    };

export function isCloudflareWebAnalyticsToken(value: unknown): value is CloudflareWebAnalyticsToken {
  return typeof value === 'string' && CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN.test(value);
}

/**
 * Validates that a Cloudflare Web Analytics beacon token is an exact 32-character lowercase hex string.
 * Rejects whitespace, uppercase characters, non-hex characters, and HTML/script payloads fail-fast.
 */
export function validateCloudflareWebAnalyticsToken(token: unknown): CloudflareWebAnalyticsToken {
  if (!isCloudflareWebAnalyticsToken(token)) {
    throw new RangeError(
      'Invalid Cloudflare Web Analytics token: expected an exact 32-character lowercase hexadecimal string (/^[0-9a-f]{32}$/).'
    );
  }
  return token;
}

export function isWebAnalyticsEnabled(option: WebAnalyticsOptions | undefined): boolean {
  return option?.enabled === true;
}

function escapeSingleQuotedAttributeValue(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;');
}

/**
 * Renders the Cloudflare Web Analytics beacon script tag using a validated 32-char lowercase hex token.
 */
export function renderCloudflareWebAnalyticsBeaconHtml(token: CloudflareWebAnalyticsToken | string): string {
  const validatedToken = validateCloudflareWebAnalyticsToken(token);
  const serializedPayload = escapeSingleQuotedAttributeValue(JSON.stringify({ token: validatedToken }));
  return `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_BEACON_URL}" data-cf-beacon='${serializedPayload}'></script>`;
}

/**
 * Compiles opt-in Cloudflare Web Analytics into CSP, HTML beacon, and /privacy contributions.
 * Returns undefined when omitted or disabled so the server stays on the zero-overhead default path.
 */
export function createWebAnalyticsDocumentContributions(
  option: WebAnalyticsOptions | undefined
): ServerDocumentContributions | undefined {
  if (!option?.enabled) {
    return undefined;
  }

  const validatedToken = validateCloudflareWebAnalyticsToken(option.token);
  const beaconHtml = renderCloudflareWebAnalyticsBeaconHtml(validatedToken);

  return {
    csp: {
      scriptSrc: [CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN],
      connectSrc: [CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN],
    },
    bodyEndHtml: [beaconHtml],
    privacyDisclosures: [
      {
        id: CLOUDFLARE_WEB_ANALYTICS_PRIVACY_DISCLOSURE_ID,
        summary: CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
        replacesZeroAnalyticsClaim: true,
      },
    ],
  };
}
