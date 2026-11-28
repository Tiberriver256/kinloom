import {
  type Clock,
  type EntityReadStore,
  formatDeceasedLifespan,
  type KinloomSiteConfig,
  parseEntityPayload,
  renderOgCardSvg,
  resolveBrandSpec,
  resolveRouteOgMetadata,
} from '@kinloom/core';
import type { ServerPrivacyDisclosure } from '../documentContributions.js';
import { applySecurityHeaders } from '../securityHeaders.js';

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const DEFAULT_ZERO_TRACKER_BULLET =
  'This archive embeds zero tracking pixels or behavioral analytics trackers.';

export interface RenderPrivacyPolicyOptions {
  readonly disclosures?: readonly ServerPrivacyDisclosure[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderAnalyticsPrivacyBullets(disclosures?: readonly ServerPrivacyDisclosure[]): string {
  if (!disclosures || disclosures.length === 0) {
    return `      <li>${DEFAULT_ZERO_TRACKER_BULLET}</li>`;
  }
  const replacesZeroClaim = disclosures.some((item) => item.replacesZeroAnalyticsClaim === true);
  const items: string[] = [];
  if (!replacesZeroClaim) {
    items.push(`      <li>${DEFAULT_ZERO_TRACKER_BULLET}</li>`);
  }
  for (const disclosure of disclosures) {
    items.push(`      <li>${escapeHtml(disclosure.summary)}</li>`);
  }
  return items.join('\n');
}

export function renderPrivacyPolicyHtml(
  siteConfig: KinloomSiteConfig,
  options?: RenderPrivacyPolicyOptions
): string {
  const title = escapeHtml(siteConfig.site.title);
  const familyName = escapeHtml(siteConfig.site.familyName);
  const accent =
    siteConfig.theme?.accent && HEX_COLOR_PATTERN.test(siteConfig.theme.accent)
      ? siteConfig.theme.accent
      : '#1B2A41';
  const analyticsBullets = renderAnalyticsPrivacyBullets(options?.disclosures);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy | ${title}</title>
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#F5EFE2" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#171614" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="/favicon.ico" sizes="48x48">
  <link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: light)" href="/favicon-light.svg">
  <link rel="icon" type="image/svg+xml" media="(prefers-color-scheme: dark)" href="/favicon-dark.svg">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <style>
    :root {
      color-scheme: light dark;
      --paper: #F5EFE2;
      --card: #FCF9F2;
      --ink: #1B2A41;
      --muted: #554E45;
      --rule: #D6CEBE;
      --accent: ${accent};
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --paper: #171614;
        --card: #1F1D1A;
        --ink: #EDE6D9;
        --muted: #BDB3A3;
        --rule: #3D3832;
        --accent: #D89C56;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2.5rem 1.25rem 4rem;
      background: var(--paper);
      color: var(--ink);
      font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
      line-height: 1.65;
    }
    main {
      max-width: 44rem;
      margin: 0 auto;
      padding: 2.5rem 2.25rem;
      background: var(--card);
      border: 1px solid var(--rule);
      border-radius: 6px;
    }
    .kicker {
      margin: 0 0 0.5rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 {
      margin: 0 0 0.75rem;
      font-size: 2rem;
      line-height: 1.2;
      color: var(--ink);
    }
    .lead {
      margin: 0 0 2rem;
      color: var(--muted);
      font-size: 1.05rem;
    }
    h2 {
      margin: 1.75rem 0 0.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--rule);
      font-size: 1.15rem;
      color: var(--ink);
    }
    p { margin: 0 0 0.9rem; }
    ul { margin: 0.5rem 0 1rem; padding-left: 1.35rem; }
    li { margin-bottom: 0.45rem; }
    footer {
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--rule);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.88rem;
      color: var(--muted);
    }
    a { color: var(--accent); }
    @media (max-width: 600px) {
      main { padding: 1.75rem 1.25rem; }
      h1 { font-size: 1.6rem; }
    }
  </style>
</head>
<body>
  <main>
    <p class="kicker">${title}</p>
    <h1>Privacy Policy</h1>
    <p class="lead">${title} is a non-commercial, private family history archive maintained for members of the ${familyName} family.</p>

    <h2>Information Used for Sign-In</h2>
    <p>Access to this archive is restricted to invited family members and administrators. When you sign in with Google or a one-time magic-link email, this archive stores only your email address and display name.</p>
    <p>We use this information solely to verify your identity, maintain your session cookie, and attribute historical record edits or notes inside the archive.</p>

    <h2>Protection of Living Relatives</h2>
    <p>Living relatives are automatically protected throughout the archive. Public views redact living individuals, and automated privacy rules strip portraits and residence histories for living people.</p>

    <h2>No Advertising or Third-Party Sharing</h2>
    <ul>
      <li>This archive serves zero advertisements.</li>
${analyticsBullets}
      <li>Your email address, display name, and family records are never sold, rented, or shared with third-party data brokers.</li>
    </ul>

    <h2>Account Removal and Questions</h2>
    <p>To request account deletion, session revocation, or corrections to personal information, contact the archive administrator who provided your invitation.</p>

    <footer>
      <a href="/">Return to ${title}</a>
    </footer>
  </main>
</body>
</html>
`;
}

export interface DynamicOgRequestOptions {
  readonly pathname: string;
  readonly headOnly: boolean;
  readonly isSecure: boolean;
  readonly siteConfig: KinloomSiteConfig;
  readonly repository: Pick<EntityReadStore, 'getEntity'>;
  readonly clock?: Clock;
}

function buildSvgResponse(svg: string, headOnly: boolean, isSecure: boolean): Response {
  return applySecurityHeaders(
    new Response(headOnly ? null : svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'public, max-age=3600',
        'referrer-policy': 'same-origin',
      },
    }),
    { isSecure }
  );
}

/**
 * Renders privacy-safe dynamic 1200x630 Open Graph SVG cards for:
 *   - GET /og/site.svg
 *   - GET /og/person/:id.svg (strictly falls back to site OG card if person is living or not found)
 *
 * Returns null if the pathname does not match an OG route.
 */
export async function handleDynamicOgRequest(options: DynamicOgRequestOptions): Promise<Response | null> {
  const { pathname, headOnly, isSecure, siteConfig, repository, clock } = options;
  const spec = resolveBrandSpec(siteConfig);

  if (pathname === '/og/site.svg') {
    const svg = renderOgCardSvg({
      title: spec.title,
      subtitle: spec.subtitle,
      metadataLine: spec.metadataLine,
      footerCredit: spec.footerCredit,
      surface: spec.surface,
      accent: spec.accent,
    });
    return buildSvgResponse(svg, headOnly, isSecure);
  }

  const personMatch = pathname.match(/^\/og\/person\/([^/]+)\.svg$/);
  if (!personMatch) {
    return null;
  }

  let personId: string;
  try {
    personId = decodeURIComponent(personMatch[1]);
  } catch {
    personId = personMatch[1];
  }

  const entity = await repository.getEntity('person', personId);
  const person =
    entity && !entity.deleted_at && 'data' in entity ? parseEntityPayload('person', entity.data) : null;
  const ogMeta = resolveRouteOgMetadata({
    siteConfig,
    person,
    referenceYear: siteConfig.privacy.referenceYear ?? clock?.currentYear(),
  });

  // Living or missing people strictly render the generic site-level OG card
  if (!person || ogMeta.redacted) {
    const fallbackSvg = renderOgCardSvg({
      title: spec.title,
      subtitle: spec.subtitle,
      metadataLine: spec.metadataLine,
      footerCredit: spec.footerCredit,
      surface: spec.surface,
      accent: spec.accent,
    });
    return buildSvgResponse(fallbackSvg, headOnly, isSecure);
  }

  const lifespan = formatDeceasedLifespan(person);
  const svg = renderOgCardSvg({
    kicker: spec.title,
    title: person.full_name.trim() || 'Historical Person',
    subtitle: lifespan,
    metadataLine: spec.footerCredit ?? 'Built with Kinloom',
    footerCredit: spec.footerCredit,
    surface: spec.surface,
    accent: spec.accent,
  });
  return buildSvgResponse(svg, headOnly, isSecure);
}

export interface PrivacyAndOgRouteHandlerDeps {
  readonly siteConfig: KinloomSiteConfig;
  readonly entityStore: Pick<EntityReadStore, 'getEntity'>;
  readonly clock: Clock;
  readonly privacyDisclosures?: readonly ServerPrivacyDisclosure[];
}

export function createPrivacyAndOgRouteHandler(
  deps: PrivacyAndOgRouteHandlerDeps
): (params: { pathname: string; method: string; isSecure: boolean }) => Promise<Response | null> {
  const { siteConfig, entityStore, clock, privacyDisclosures } = deps;

  return async ({ pathname, method, isSecure }) => {
    if (method !== 'GET' && method !== 'HEAD') {
      return null;
    }

    if (pathname === '/privacy' || pathname === '/privacy/') {
      const html = renderPrivacyPolicyHtml(
        siteConfig,
        privacyDisclosures && privacyDisclosures.length > 0 ? { disclosures: privacyDisclosures } : undefined
      );
      return new Response(method === 'HEAD' ? null : html, {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=3600',
          'referrer-policy': 'same-origin',
        },
      });
    }

    if (siteConfig.brand?.dynamicOg && pathname.startsWith('/og/')) {
      return handleDynamicOgRequest({
        pathname,
        headOnly: method === 'HEAD',
        isSecure,
        siteConfig,
        repository: entityStore,
        clock,
      });
    }

    return null;
  };
}
