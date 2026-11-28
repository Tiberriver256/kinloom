import { CliValidationError } from '../../../errors.js';

export interface AuthHeader {
  readonly name: string;
  readonly value: string;
}

export interface DiscoveredPersonSample {
  readonly id: string;
  readonly slug: string;
  readonly fullName: string;
  readonly searchTerm: string;
  readonly hasPronunciation: boolean;
  readonly hasMedia: boolean;
  readonly hasBiography: boolean;
  readonly hasNarrativeAudio: boolean;
}

export interface DiscoveredPlaceSample {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface DiscoveredNarrativeSample {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

export interface BundleDiscoveryResult {
  readonly source: 'api-bundle' | 'static-bundle' | 'none';
  readonly people: readonly DiscoveredPersonSample[];
  readonly places: readonly DiscoveredPlaceSample[];
  readonly narratives: readonly DiscoveredNarrativeSample[];
}

export interface DiscoveredNavLink {
  readonly href: string;
  readonly text: string;
}

export interface CoreRouteDefinition {
  readonly route: string;
  readonly slug: string;
  readonly label: string;
  readonly isMap?: boolean;
  readonly isHeavyPage?: boolean;
}

export const CORE_KINLOOM_PAGE_ROUTES: readonly CoreRouteDefinition[] = Object.freeze([
  { route: '/', slug: 'home', label: 'Archive Overview' },
  { route: '/tree', slug: 'tree', label: 'Family Tree' },
  { route: '/map', slug: 'map', label: 'Migration Map', isMap: true },
  { route: '/places', slug: 'places', label: 'Places Directory' },
  { route: '/time', slug: 'time', label: 'Archive Timeline' },
  { route: '/kinship', slug: 'kinship', label: 'Kinship Finder' },
  { route: '/evidence', slug: 'evidence', label: 'Evidence & Sources', isHeavyPage: true },
  { route: '/changes', slug: 'changes', label: 'Revision History' },
  { route: '/admin', slug: 'admin', label: 'Site Administration' },
]);

export const BUNDLE_DISCOVERY_PROBES: readonly {
  readonly path: string;
  readonly source: Exclude<BundleDiscoveryResult['source'], 'none'>;
}[] = Object.freeze([
  { path: '/api/bundle', source: 'api-bundle' },
  { path: '/data/archive.json', source: 'static-bundle' },
  { path: '/data/bundle.json', source: 'static-bundle' },
]);

const KNOWN_CORE_EXACT_ROUTES = new Set<string>([
  '/',
  '/people',
  '/places',
  '/time',
  '/timeline',
  '/tree',
  '/map',
  '/kinship',
  '/evidence',
  '/sources',
  '/media',
  '/narratives',
  '/changes',
  '/admin',
  '/privacy',
]);

const KNOWN_CORE_PREFIXES = ['/person/', '/people/', '/place/', '/places/', '/narratives/', '/sources/'];

const KNOWN_PLUGIN_ROUTE_MAP: Readonly<Record<string, string>> = Object.freeze({
  recipes: '/recipes',
  'kinloom-recipes': '/recipes',
  'family-recipes': '/recipes',
  'open-finance': '/support',
  open_finance: '/support',
  'kinloom-open-finance': '/support',
  support: '/support',
});

function trimTrailingChar(value: string, ch: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === ch) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

export function normalizeRoutePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliValidationError('Route path cannot be empty.');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new CliValidationError(`Route '${raw}' must be a relative path starting with '/'.`);
  }
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutHash = withSlash.split('#')[0] ?? '';
  const [pathnamePart = '', queryPart] = withoutHash.split('?');
  const collapsedPath = trimTrailingChar(pathnamePart.replace(/\/+/g, '/'), '/') || '/';
  return queryPart ? `${collapsedPath}?${queryPart}` : collapsedPath;
}

export function buildAuthRequestHeaders(options: {
  readonly authCookie?: string | undefined;
  readonly authHeaders?: readonly AuthHeader[] | undefined;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.authHeaders) {
    for (const header of options.authHeaders) {
      headers[header.name] = header.value;
    }
  }
  if (options.authCookie?.trim()) {
    headers['Cookie'] = options.authCookie.trim();
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number {
  const val = obj[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : 0;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean {
  return obj[key] === true;
}

function readArray(obj: Record<string, unknown>, key: string): readonly unknown[] {
  return Array.isArray(obj[key]) ? obj[key] : [];
}

function isArchiveBundlePayload(payload: unknown): payload is Record<string, unknown> {
  return (
    isRecord(payload) &&
    (Array.isArray(payload['people']) ||
      Array.isArray(payload['places']) ||
      Array.isArray(payload['narratives']))
  );
}

function hasNarrativeAudioExtension(narrative: Record<string, unknown>): boolean {
  const extensions = narrative['extensions'];
  if (!isRecord(extensions)) return false;
  const audio = extensions['narrative_audio'] ?? extensions['audio'];
  return isRecord(audio) && typeof audio['file'] === 'string' && audio['file'].trim().length > 0;
}

function deriveSearchTerm(fullName: string): string {
  const parts = fullName
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z0-9'-]/g, ''))
    .filter((p) => p.length >= 3);
  return parts[parts.length - 1] ?? fullName.slice(0, 12);
}

export function isKnownCoreRoute(routePath: string): boolean {
  const pathOnly = (routePath.split('?')[0] ?? '').toLowerCase();
  if (KNOWN_CORE_EXACT_ROUTES.has(pathOnly)) {
    return true;
  }
  return KNOWN_CORE_PREFIXES.some((prefix) => pathOnly.startsWith(prefix));
}

export function extractSamplesFromBundle(
  rawBundle: unknown,
  options: { readonly samplePeople: number; readonly samplePlaces: number }
): Omit<BundleDiscoveryResult, 'source'> {
  if (!isRecord(rawBundle)) {
    return { people: [], places: [], narratives: [] };
  }

  const rawMedia = readArray(rawBundle, 'media').filter(isRecord);
  const rawNarratives = readArray(rawBundle, 'narratives').filter(isRecord);
  const mediaPersonIds = new Set<string>();
  for (const item of rawMedia) {
    const singlePersonId = readString(item, 'person_id');
    if (singlePersonId) {
      mediaPersonIds.add(singlePersonId);
    }
    for (const pid of readArray(item, 'person_ids')) {
      if (typeof pid === 'string' && pid.trim().length > 0) {
        mediaPersonIds.add(pid.trim());
      }
    }
  }

  const bioPersonIds = new Set<string>();
  const audioPersonIds = new Set<string>();
  const narrativeSamples: DiscoveredNarrativeSample[] = [];
  for (const item of rawNarratives) {
    const personId = readString(item, 'person_id');
    const subjectIds = readArray(item, 'subject_person_ids').filter(
      (id): id is string => typeof id === 'string' && id.trim().length > 0
    );
    const hasAudio = hasNarrativeAudioExtension(item);
    for (const pid of personId ? [personId, ...subjectIds] : subjectIds) {
      bioPersonIds.add(pid);
      if (hasAudio) {
        audioPersonIds.add(pid);
      }
    }
    const slug = readString(item, 'slug');
    const id = readString(item, 'id');
    const title = readString(item, 'title');
    if (slug && id && title && narrativeSamples.length < 2) {
      narrativeSamples.push({ id, slug, title });
    }
  }

  const rankedPeople: Array<{ readonly sample: DiscoveredPersonSample; readonly score: number }> = [];
  for (const rawPerson of readArray(rawBundle, 'people')) {
    if (!isRecord(rawPerson)) {
      continue;
    }
    const id = readString(rawPerson, 'id');
    const slug = readString(rawPerson, 'slug');
    const fullName = readString(rawPerson, 'full_name');
    if (!id || !slug || !fullName) {
      continue;
    }
    if (
      readBoolean(rawPerson, 'is_living') ||
      readBoolean(rawPerson, 'living') ||
      readBoolean(rawPerson, 'effective_living') ||
      fullName.toLowerCase() === 'living' ||
      slug.toLowerCase() === 'living'
    ) {
      continue;
    }
    const hasPronunciation = isRecord(rawPerson['pronunciation']);
    const hasMedia = mediaPersonIds.has(id) || Boolean(readString(rawPerson, 'portrait_url'));
    const hasBiography = bioPersonIds.has(id);
    const hasNarrativeAudio = audioPersonIds.has(id);
    const eventCount = readNumber(rawPerson, 'event_count');
    const score =
      (hasNarrativeAudio ? 5 : 0) +
      (hasBiography ? 4 : 0) +
      (hasPronunciation ? 4 : 0) +
      (hasMedia ? 3 : 0) +
      Math.min(eventCount, 20) * 0.1;

    rankedPeople.push({
      score,
      sample: {
        id,
        slug,
        fullName,
        searchTerm: deriveSearchTerm(fullName),
        hasPronunciation,
        hasMedia,
        hasBiography,
        hasNarrativeAudio,
      },
    });
  }
  rankedPeople.sort((a, b) => b.score - a.score || a.sample.slug.localeCompare(b.sample.slug));

  const rankedPlaces: Array<{ readonly sample: DiscoveredPlaceSample; readonly score: number }> = [];
  for (const rawPlace of readArray(rawBundle, 'places')) {
    if (!isRecord(rawPlace)) continue;
    const id = readString(rawPlace, 'id');
    const slug = readString(rawPlace, 'slug');
    const name = readString(rawPlace, 'name');
    if (!id || !slug || !name) continue;
    const hasCoords =
      typeof rawPlace['lat'] === 'number' &&
      Number.isFinite(rawPlace['lat']) &&
      typeof rawPlace['lng'] === 'number' &&
      Number.isFinite(rawPlace['lng']);
    const score =
      (hasCoords ? 2 : 0) +
      (readString(rawPlace, 'description') ? 3 : 0) +
      (isRecord(rawPlace['pronunciation']) ? 2 : 0);
    rankedPlaces.push({ score, sample: { id, slug, name } });
  }
  rankedPlaces.sort((a, b) => b.score - a.score || a.sample.slug.localeCompare(b.sample.slug));

  return {
    people: rankedPeople.slice(0, Math.max(0, options.samplePeople)).map((entry) => entry.sample),
    places: rankedPlaces.slice(0, Math.max(0, options.samplePlaces)).map((entry) => entry.sample),
    narratives: narrativeSamples,
  };
}

function resolvePluginRouteCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const mapped = KNOWN_PLUGIN_ROUTE_MAP[trimmed.toLowerCase()];
  if (mapped) {
    return mapped;
  }
  if (!trimmed.startsWith('/')) {
    return null;
  }
  let normalized: string;
  try {
    normalized = normalizeRoutePath(trimmed);
  } catch {
    return null;
  }
  const lower = normalized.toLowerCase();
  if (
    isKnownCoreRoute(normalized) ||
    lower.startsWith('/api/') ||
    lower.startsWith('/media/') ||
    lower.startsWith('/data/') ||
    lower.startsWith('/invite/')
  ) {
    return null;
  }
  return normalized;
}

function collectPluginEntries(value: unknown, out: string[], seen: Set<string>): void {
  const addCandidate = (raw: string | undefined): void => {
    if (!raw) {
      return;
    }
    const route = resolvePluginRouteCandidate(raw);
    if (route && !seen.has(route)) {
      seen.add(route);
      out.push(route);
    }
  };

  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        addCandidate(item);
        continue;
      }
      if (!isRecord(item) || item['enabled'] === false) {
        continue;
      }
      const explicitRoute =
        readString(item, 'route') ??
        readString(item, 'path') ??
        readString(item, 'basePath') ??
        readString(item, 'navPath');
      if (explicitRoute) {
        addCandidate(explicitRoute);
      } else {
        addCandidate(readString(item, 'id') ?? readString(item, 'plugin_id') ?? readString(item, 'name'));
      }
    }
    return;
  }

  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === false || entry === null || entry === undefined) {
        continue;
      }
      if (isRecord(entry)) {
        if (entry['enabled'] === false) {
          continue;
        }
        const explicitRoute =
          readString(entry, 'route') ??
          readString(entry, 'path') ??
          readString(entry, 'basePath') ??
          readString(entry, 'navPath');
        if (explicitRoute) {
          addCandidate(explicitRoute);
          continue;
        }
      }
      addCandidate(key);
    }
  }
}

export function extractEnabledPluginRoutesFromBundle(rawBundle: unknown): readonly string[] {
  if (!isRecord(rawBundle)) {
    return [];
  }
  const routes: string[] = [];
  const seen = new Set<string>();
  const meta = isRecord(rawBundle['meta']) ? rawBundle['meta'] : undefined;

  collectPluginEntries(rawBundle['plugins'], routes, seen);
  collectPluginEntries(rawBundle['enabled_plugins'], routes, seen);
  collectPluginEntries(rawBundle['plugin_routes'], routes, seen);
  collectPluginEntries(rawBundle['pluginRoutes'], routes, seen);
  collectPluginEntries(rawBundle['extensions'], routes, seen);
  if (meta) {
    collectPluginEntries(meta['plugins'], routes, seen);
    collectPluginEntries(meta['enabled_plugins'], routes, seen);
    collectPluginEntries(meta['plugin_routes'], routes, seen);
    collectPluginEntries(meta['pluginRoutes'], routes, seen);
    collectPluginEntries(meta['extensions'], routes, seen);
  }
  return routes;
}

async function tryFetchJson(
  url: string,
  fetchImpl: typeof fetch,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => {
      controller.abort();
    },
    Math.max(1000, timeoutMs)
  );
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchedArchiveBundlePayload {
  readonly source: BundleDiscoveryResult['source'];
  readonly payload: Record<string, unknown> | null;
}

export async function fetchArchiveBundlePayloadForDiscovery(options: {
  readonly baseUrl: string;
  readonly authCookie?: string | undefined;
  readonly authHeaders?: readonly AuthHeader[] | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<FetchedArchiveBundlePayload> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = buildAuthRequestHeaders({
    authCookie: options.authCookie,
    authHeaders: options.authHeaders,
  });
  const cleanBase = options.baseUrl.replace(/\/+$/, '');
  const fetchTimeout = Math.min(options.timeoutMs, 10_000);

  for (const probe of BUNDLE_DISCOVERY_PROBES) {
    const payload = await tryFetchJson(`${cleanBase}${probe.path}`, fetchImpl, headers, fetchTimeout);
    if (isArchiveBundlePayload(payload)) {
      return { source: probe.source, payload };
    }
  }

  return { source: 'none', payload: null };
}

export async function fetchArchiveBundleForDiscovery(options: {
  readonly baseUrl: string;
  readonly samplePeople: number;
  readonly samplePlaces: number;
  readonly authCookie?: string | undefined;
  readonly authHeaders?: readonly AuthHeader[] | undefined;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<BundleDiscoveryResult> {
  const fetched = await fetchArchiveBundlePayloadForDiscovery(options);
  if (fetched.payload) {
    return {
      source: fetched.source,
      ...extractSamplesFromBundle(fetched.payload, {
        samplePeople: options.samplePeople,
        samplePlaces: options.samplePlaces,
      }),
    };
  }

  return { source: 'none', people: [], places: [], narratives: [] };
}

export function classifyDiscoveredNavLinks(
  links: readonly DiscoveredNavLink[],
  baseUrl: string
): {
  readonly extraCoreRoutes: readonly { readonly route: string; readonly label: string }[];
  readonly pluginRoutes: readonly { readonly route: string; readonly label: string }[];
} {
  const targetOrigin = new URL(baseUrl).origin;
  const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
  const extraCoreRoutes: Array<{ readonly route: string; readonly label: string }> = [];
  const pluginRoutes: Array<{ readonly route: string; readonly label: string }> = [];
  const seen = new Set<string>();

  for (const link of links) {
    const rawHref = link.href.trim();
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
      continue;
    }
    let resolved: URL;
    try {
      resolved = new URL(rawHref, `${baseUrl}/`);
    } catch {
      continue;
    }
    if (resolved.origin !== targetOrigin) {
      continue;
    }
    let pathname = resolved.pathname;
    if (basePath && pathname.startsWith(basePath)) {
      pathname = pathname.slice(basePath.length) || '/';
    }
    if (pathname.startsWith('/api/') || pathname.startsWith('/media/') || pathname.startsWith('/data/')) {
      continue;
    }
    const normalized = normalizeRoutePath(pathname);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    const label = link.text.trim() || normalized;
    if (isKnownCoreRoute(normalized)) {
      extraCoreRoutes.push({ route: normalized, label });
    } else {
      pluginRoutes.push({ route: normalized, label });
    }
  }

  return { extraCoreRoutes, pluginRoutes };
}
