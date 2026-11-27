import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  type ServerCspDirectiveAdditions,
} from './securityHeaders.js';

export interface ServerPrivacyDisclosure {
  readonly id: string;
  readonly summary: string;
  /**
   * When true, replaces the default zero-analytics bullet on /privacy so the page
   * never contradicts itself while preserving the zero-ads and no-data-broker bullets.
   */
  readonly replacesZeroAnalyticsClaim?: boolean;
}

export interface ServerDocumentContributions {
  readonly csp?: ServerCspDirectiveAdditions;
  readonly bodyEndHtml?: readonly string[];
  readonly privacyDisclosures?: readonly ServerPrivacyDisclosure[];
}

export interface CompiledDocumentContributions {
  readonly contentSecurityPolicy: string | undefined;
  readonly bodyEndHtml: readonly string[];
  readonly privacyDisclosures: readonly ServerPrivacyDisclosure[];
}

const HTML_CONTENT_TYPE_PATTERN = /^text\/html(?:\s*;|$)/i;
const CLOSING_BODY_TAG_PATTERN = /<\/body\s*>/gi;
const CLOSING_HEAD_TAG_PATTERN = /<\/head\s*>/gi;

function isExcludedHtmlInjectionPath(pathname: string): boolean {
  return (
    pathname === '/api' ||
    pathname.startsWith('/api/') ||
    pathname === '/media' ||
    pathname.startsWith('/media/') ||
    pathname === '/sources' ||
    pathname.startsWith('/sources/') ||
    pathname === '/og' ||
    pathname.startsWith('/og/') ||
    pathname === '/data' ||
    pathname.startsWith('/data/')
  );
}

export function isHtmlDocumentResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.trim() ?? '';
  return HTML_CONTENT_TYPE_PATTERN.test(contentType);
}

function findLastMatchIndex(source: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let lastIndex = -1;
  let match = pattern.exec(source);
  while (match !== null) {
    lastIndex = match.index;
    match = pattern.exec(source);
  }
  return lastIndex;
}

/**
 * Injects verified HTML snippets before the closing </body> tag (or </head> if no </body> exists).
 * Skips snippets already present so injection stays idempotent.
 */
export function injectHtmlSnippets(html: string, snippets: readonly string[]): string {
  const missing = snippets.filter((snippet) => snippet.length > 0 && !html.includes(snippet));
  if (missing.length === 0) {
    return html;
  }
  const block = missing.join('\n');

  const bodyIndex = findLastMatchIndex(html, CLOSING_BODY_TAG_PATTERN);
  if (bodyIndex !== -1) {
    return `${html.slice(0, bodyIndex)}${block}\n${html.slice(bodyIndex)}`;
  }

  const headIndex = findLastMatchIndex(html, CLOSING_HEAD_TAG_PATTERN);
  if (headIndex !== -1) {
    return `${html.slice(0, headIndex)}${block}\n${html.slice(headIndex)}`;
  }

  return `${html}\n${block}`;
}

export function compilePluginDocumentContributions(
  plugins: readonly { readonly documentContributions?: ServerDocumentContributions }[]
): CompiledDocumentContributions | null {
  const scriptSrc: string[] = [];
  const connectSrc: string[] = [];
  const bodyEndHtml: string[] = [];
  const privacyDisclosures: ServerPrivacyDisclosure[] = [];
  const seenDisclosureIds = new Set<string>();

  for (const plugin of plugins) {
    const contrib = plugin.documentContributions;
    if (!contrib) {
      continue;
    }
    if (contrib.csp?.scriptSrc) {
      scriptSrc.push(...contrib.csp.scriptSrc);
    }
    if (contrib.csp?.connectSrc) {
      connectSrc.push(...contrib.csp.connectSrc);
    }
    if (contrib.bodyEndHtml) {
      for (const snippet of contrib.bodyEndHtml) {
        if (snippet.length > 0 && !bodyEndHtml.includes(snippet)) {
          bodyEndHtml.push(snippet);
        }
      }
    }
    if (contrib.privacyDisclosures) {
      for (const disclosure of contrib.privacyDisclosures) {
        if (!seenDisclosureIds.has(disclosure.id)) {
          seenDisclosureIds.add(disclosure.id);
          privacyDisclosures.push(disclosure);
        }
      }
    }
  }

  const hasCspAdditions = scriptSrc.length > 0 || connectSrc.length > 0;
  if (!hasCspAdditions && bodyEndHtml.length === 0 && privacyDisclosures.length === 0) {
    return null;
  }

  const compiledCsp = hasCspAdditions ? buildContentSecurityPolicy({ scriptSrc, connectSrc }) : undefined;

  return {
    contentSecurityPolicy:
      compiledCsp && compiledCsp !== DEFAULT_CONTENT_SECURITY_POLICY ? compiledCsp : undefined,
    bodyEndHtml,
    privacyDisclosures,
  };
}

/**
 * Applies optional plugin HTML contributions (only to 2xx text/html documents outside API/media/OG paths)
 * and standard security headers (with scoped CSP additions on HTML documents only).
 */
export async function finalizeServerResponse(params: {
  readonly request: Request;
  readonly pathname: string;
  readonly response: Response;
  readonly isSecure: boolean;
  readonly isMediaPath: boolean;
  readonly documentContributions: CompiledDocumentContributions | null;
}): Promise<Response> {
  const { request, pathname, response, isSecure, isMediaPath, documentContributions } = params;
  const isMediaResponse = isMediaPath && (response.status === 200 || response.status === 206);

  if (isMediaResponse || !documentContributions) {
    return applySecurityHeaders(response, { isSecure, isMedia: isMediaResponse });
  }

  const isHtml = !isExcludedHtmlInjectionPath(pathname) && isHtmlDocumentResponse(response);
  if (!isHtml) {
    return applySecurityHeaders(response, { isSecure, isMedia: false });
  }

  const canRewriteBody =
    documentContributions.bodyEndHtml.length > 0 &&
    request.method.toUpperCase() !== 'HEAD' &&
    response.status >= 200 &&
    response.status < 300 &&
    response.status !== 204;

  let targetResponse = response;
  if (canRewriteBody) {
    const originalHtml = await response.text();
    const rewrittenHtml = injectHtmlSnippets(originalHtml, documentContributions.bodyEndHtml);
    if (rewrittenHtml !== originalHtml) {
      const headers = new Headers(response.headers);
      headers.delete('content-length');
      headers.delete('content-encoding');
      targetResponse = new Response(rewrittenHtml, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } else {
      targetResponse = new Response(originalHtml, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }
  }

  return applySecurityHeaders(targetResponse, {
    isSecure,
    isMedia: false,
    contentSecurityPolicy: documentContributions.contentSecurityPolicy,
  });
}
