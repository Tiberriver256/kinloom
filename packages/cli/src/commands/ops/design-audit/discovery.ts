import {
  type AuthHeader,
  type BundleDiscoveryResult,
  CORE_KINLOOM_PAGE_ROUTES,
  extractEnabledPluginRoutesFromBundle,
  extractSamplesFromBundle,
  fetchArchiveBundlePayloadForDiscovery,
  normalizeRoutePath,
} from '../shared/routeDiscovery.js';

const CORE_ROUTE_ORDER: readonly string[] = [
  '/',
  '/places',
  '/evidence',
  '/time',
  '/tree',
  '/map',
  '/kinship',
  '/changes',
];

const KNOWN_NON_ADMIN_CORE_SET = new Set(
  CORE_KINLOOM_PAGE_ROUTES.filter((entry) => entry.route !== '/admin').map((entry) => entry.route)
);

export const DESIGN_AUDIT_CORE_ROUTES: readonly string[] = Object.freeze(
  CORE_ROUTE_ORDER.filter((route) => KNOWN_NON_ADMIN_CORE_SET.has(route))
);

export interface DesignAuditAutoRoutesResult {
  readonly source: BundleDiscoveryResult['source'];
  readonly routes: readonly string[];
  readonly personRoute: string | null;
  readonly placeRoute: string | null;
  readonly pluginRoutes: readonly string[];
  readonly fallbackReason?: string | undefined;
}

function toAuthHeaderList(headers: Readonly<Record<string, string>> | undefined): readonly AuthHeader[] {
  if (!headers) {
    return [];
  }
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

export function mergeUniqueRoutes(...lists: ReadonlyArray<readonly string[] | undefined>): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const raw of list) {
      const normalized = normalizeRoutePath(raw);
      if (!seen.has(normalized)) {
        seen.add(normalized);
        merged.push(normalized);
      }
    }
  }
  return merged;
}

export async function discoverDesignAuditAutoRoutes(options: {
  readonly baseUrl: string;
  readonly explicitRoutes?: readonly string[] | undefined;
  readonly authCookie?: string | undefined;
  readonly authHeaders?: Readonly<Record<string, string>> | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<DesignAuditAutoRoutesResult> {
  const fetched = await fetchArchiveBundlePayloadForDiscovery({
    baseUrl: options.baseUrl,
    authCookie: options.authCookie,
    authHeaders: toAuthHeaderList(options.authHeaders),
    timeoutMs: options.timeoutMs ?? 10_000,
    fetchImpl: options.fetchImpl,
  });

  if (!fetched.payload) {
    const fallbackRoutes =
      options.explicitRoutes && options.explicitRoutes.length > 0
        ? mergeUniqueRoutes(options.explicitRoutes)
        : ['/'];
    return {
      source: 'none',
      routes: fallbackRoutes,
      personRoute: null,
      placeRoute: null,
      pluginRoutes: [],
      fallbackReason: 'Archive bundle unavailable at /api/bundle (unauthenticated or static-only mode)',
    };
  }

  const samples = extractSamplesFromBundle(fetched.payload, {
    samplePeople: 1,
    samplePlaces: 1,
  });
  const pluginRoutes = extractEnabledPluginRoutesFromBundle(fetched.payload);

  const firstDeceased = samples.people[0];
  const firstPlace = samples.places[0];
  const personRoute = firstDeceased ? `/person/${firstDeceased.slug}` : null;
  const placeRoute = firstPlace ? `/place/${firstPlace.slug}` : null;

  const routes = mergeUniqueRoutes(
    DESIGN_AUDIT_CORE_ROUTES,
    personRoute ? [personRoute] : undefined,
    placeRoute ? [placeRoute] : undefined,
    pluginRoutes,
    options.explicitRoutes
  );

  return {
    source: fetched.source,
    routes,
    personRoute,
    placeRoute,
    pluginRoutes,
  };
}
