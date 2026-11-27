import type {
  DailyVisitPoint,
  ObservabilityCacheSummary,
  ObservabilityCacheTotals,
  ObservabilityStatsWindow,
  PageVisitEntityKind,
} from './pageVisitStatsTypes.js';

export type ParsedVisitCandidate =
  | { readonly kind: 'route'; readonly routeKey: string; readonly label: string }
  | { readonly kind: 'person'; readonly rawSlug: string }
  | { readonly kind: 'place'; readonly rawSlug: string }
  | { readonly kind: 'narrative'; readonly rawSlug: string };

const STATIC_ARCHIVE_ROUTES: Readonly<Record<string, { readonly routeKey: string; readonly label: string }>> =
  {
    '/': { routeKey: '/', label: 'Archive Home' },
    '/people': { routeKey: '/', label: 'Archive Home' },
    '/places': { routeKey: '/places', label: 'Places Directory' },
    '/time': { routeKey: '/time', label: 'Historical Timeline' },
    '/timeline': { routeKey: '/time', label: 'Historical Timeline' },
    '/tree': { routeKey: '/tree', label: 'Family Tree' },
    '/map': { routeKey: '/map', label: 'Migration Map' },
    '/kinship': { routeKey: '/kinship', label: 'Kinship Explorer' },
    '/evidence': { routeKey: '/evidence', label: 'Sources & Evidence' },
    '/changes': { routeKey: '/changes', label: 'Recent Changes' },
  };

const BOT_USER_AGENT_PATTERN =
  /\b(?:bot|crawler|spider|slurp|bingpreview|facebookexternalhit|linkedinbot|twitterbot|whatsapp|discordbot|slackbot|telegrambot|applebot|googlebot|duckduckbot|baiduspider|yandex|semrush|ahrefs|mj12bot|dotbot|petalbot|bytespider|gptbot|claudebot|anthropic-ai|ccbot|headlesschrome|lighthouse|pagespeed|pingdom|uptimerobot|monitoring|statuscake|datadog|synthetics)\b|^(?:curl|wget|python-requests|python-urllib|go-http-client|node-fetch|undici|axios|libwww-perl|java\/|okhttp)\b/i;

const PREFETCH_HEADER_PATTERN = /\b(?:prefetch|prerender|preview)\b/i;
const HTML_CONTENT_TYPE_PATTERN = /^text\/html(?:\s*;|$)/i;
const SAFE_ENTITY_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;

export function formatUtcDayBucket(isoTimestamp: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(isoTimestamp.trim());
  if (match) {
    return match[1];
  }
  const parsed = new Date(isoTimestamp);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

export function shiftUtcDay(dayUtc: string, deltaDays: number): string {
  const [yearStr, monthStr, dayStr] = dayUtc.split('-');
  const utcMs = Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr) + deltaDays);
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function buildContiguousUtcDays(endDayUtc: string, dayCount: number): readonly string[] {
  const safeCount = Math.max(1, Math.floor(dayCount));
  const days: string[] = [];
  for (let offset = safeCount - 1; offset >= 0; offset -= 1) {
    days.push(shiftUtcDay(endDayUtc, -offset));
  }
  return days;
}

export function fillDailySeries(
  endDayUtc: string,
  dayCount: number,
  sparsePoints: readonly DailyVisitPoint[]
): DailyVisitPoint[] {
  const byDay = new Map<string, number>();
  for (const point of sparsePoints) {
    byDay.set(point.day_utc, (byDay.get(point.day_utc) ?? 0) + point.views);
  }
  return buildContiguousUtcDays(endDayUtc, dayCount).map((dayUtc) => ({
    day_utc: dayUtc,
    views: byDay.get(dayUtc) ?? 0,
  }));
}

export function windowSinceDayUtc(endDayUtc: string, window: ObservabilityStatsWindow): string | undefined {
  if (window === '7d') {
    return shiftUtcDay(endDayUtc, -6);
  }
  if (window === '30d') {
    return shiftUtcDay(endDayUtc, -29);
  }
  return undefined;
}

export function trendLengthForWindow(window: ObservabilityStatsWindow): number {
  return window === '7d' ? 7 : 30;
}

export function isBotUserAgent(userAgent: string | null): boolean {
  if (!userAgent) {
    return false;
  }
  const trimmed = userAgent.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return BOT_USER_AGENT_PATTERN.test(trimmed);
}

export function isPrefetchRequest(request: Request): boolean {
  for (const headerName of ['purpose', 'sec-purpose', 'x-purpose', 'x-moz']) {
    const value = request.headers.get(headerName);
    if (value && PREFETCH_HEADER_PATTERN.test(value)) {
      return true;
    }
  }
  return false;
}

export function shouldRecordPageVisit(params: {
  readonly request: Request;
  readonly status: number;
  readonly contentType: string | null;
}): boolean {
  if (params.request.method.toUpperCase() !== 'GET') {
    return false;
  }
  if (params.status < 200 || params.status >= 300) {
    return false;
  }
  if (params.contentType !== null && !HTML_CONTENT_TYPE_PATTERN.test(params.contentType.trim())) {
    return false;
  }
  if (isPrefetchRequest(params.request)) {
    return false;
  }
  if (isBotUserAgent(params.request.headers.get('user-agent'))) {
    return false;
  }
  return true;
}

function normalizePathname(rawPathname: string): string {
  const withoutQuery = rawPathname.split(/[?#]/)[0] ?? '/';
  if (withoutQuery === '/' || withoutQuery === '') {
    return '/';
  }
  const stripped = withoutQuery.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
}

function safeDecodeSlug(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment).trim();
  } catch {
    return null;
  }
  if (!SAFE_ENTITY_SLUG_PATTERN.test(decoded)) {
    return null;
  }
  return decoded;
}

/**
 * Parses an HTTP pathname into a whitelisted static archive page or an entity slug candidate.
 * Returns null for API, admin, auth, invite, media, asset, privacy, or unrecognized paths.
 */
export function parseVisitRouteCandidate(rawPathname: string): ParsedVisitCandidate | null {
  const pathname = normalizePathname(rawPathname);
  const staticEntry = STATIC_ARCHIVE_ROUTES[pathname];
  if (staticEntry) {
    return { kind: 'route', routeKey: staticEntry.routeKey, label: staticEntry.label };
  }

  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    return null;
  }

  const prefix = segments[0].toLowerCase();
  const slug = safeDecodeSlug(segments[1]);
  if (!slug) {
    return null;
  }

  if (prefix === 'person' || prefix === 'people') {
    return { kind: 'person', rawSlug: slug };
  }
  if (prefix === 'place' || prefix === 'places') {
    return { kind: 'place', rawSlug: slug };
  }
  if (prefix === 'narrative' || prefix === 'narratives') {
    return { kind: 'narrative', rawSlug: slug };
  }

  return null;
}

export function staticRouteLabel(routeKey: string): string {
  return STATIC_ARCHIVE_ROUTES[routeKey]?.label ?? routeKey;
}

export function buildEntityRouteKey(kind: Exclude<PageVisitEntityKind, 'route'>, slug: string): string {
  return `/${kind}/${slug}`;
}

export function computeCacheSummary(totals: ObservabilityCacheTotals): ObservabilityCacheSummary {
  const totalRequests = totals.hits + totals.misses + totals.not_modified;
  const hitRatio =
    totalRequests > 0
      ? Math.round(((totals.hits + totals.not_modified) / totalRequests) * 1000) / 1000
      : null;
  return {
    hits: totals.hits,
    misses: totals.misses,
    not_modified: totals.not_modified,
    total_requests: totalRequests,
    hit_ratio: hitRatio,
  };
}
