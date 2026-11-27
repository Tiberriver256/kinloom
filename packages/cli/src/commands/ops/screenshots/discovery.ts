import { buildAuthRequestHeaders, normalizeRoutePath, routeToSlug, sanitizeSlug } from './parse.js';
import type {
  AuthHeader,
  BundleDiscoveryResult,
  DiscoveredNarrativeSample,
  DiscoveredNavLink,
  DiscoveredPersonSample,
  DiscoveredPlaceSample,
  DiscoveredPluginSlot,
  PageCaptureTarget,
  PluginCaptureTarget,
} from './types.js';

interface CoreRouteDefinition {
  readonly route: string;
  readonly slug: string;
  readonly label: string;
  readonly isMap?: boolean;
}

export const CORE_KINLOOM_PAGE_ROUTES: readonly CoreRouteDefinition[] = Object.freeze([
  { route: '/', slug: 'home', label: 'Archive Overview' },
  { route: '/tree', slug: 'tree', label: 'Family Tree' },
  { route: '/map', slug: 'map', label: 'Migration Map', isMap: true },
  { route: '/places', slug: 'places', label: 'Places Directory' },
  { route: '/time', slug: 'time', label: 'Archive Timeline' },
  { route: '/kinship', slug: 'kinship', label: 'Kinship Finder' },
  { route: '/evidence', slug: 'evidence', label: 'Evidence & Sources' },
  { route: '/changes', slug: 'changes', label: 'Revision History' },
  { route: '/admin', slug: 'admin', label: 'Site Administration' },
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

function hasNarrativeAudioExtension(narrative: Record<string, unknown>): boolean {
  const extensions = narrative.extensions;
  if (!isRecord(extensions)) return false;
  const audio = extensions.narrative_audio ?? extensions.audio;
  return isRecord(audio) && typeof audio.file === 'string' && audio.file.trim().length > 0;
}

function deriveSearchTerm(fullName: string): string {
  const parts = fullName
    .split(/\s+/)
    .map((p) => p.replace(/[^A-Za-z0-9'-]/g, ''))
    .filter((p) => p.length >= 3);
  return parts[parts.length - 1] ?? fullName.slice(0, 12);
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
    if (readBoolean(rawPerson, 'is_living') || fullName.toLowerCase() === 'living') {
      continue;
    }
    const hasPronunciation = isRecord(rawPerson.pronunciation);
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
      typeof rawPlace.lat === 'number' &&
      Number.isFinite(rawPlace.lat) &&
      typeof rawPlace.lng === 'number' &&
      Number.isFinite(rawPlace.lng);
    const score =
      (hasCoords ? 2 : 0) +
      (readString(rawPlace, 'description') ? 3 : 0) +
      (isRecord(rawPlace.pronunciation) ? 2 : 0);
    rankedPlaces.push({ score, sample: { id, slug, name } });
  }
  rankedPlaces.sort((a, b) => b.score - a.score || a.sample.slug.localeCompare(b.sample.slug));

  return {
    people: rankedPeople.slice(0, Math.max(0, options.samplePeople)).map((entry) => entry.sample),
    places: rankedPlaces.slice(0, Math.max(0, options.samplePlaces)).map((entry) => entry.sample),
    narratives: narrativeSamples,
  };
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

export async function fetchArchiveBundleForDiscovery(options: {
  readonly baseUrl: string;
  readonly samplePeople: number;
  readonly samplePlaces: number;
  readonly authCookie?: string;
  readonly authHeaders?: readonly AuthHeader[];
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<BundleDiscoveryResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = buildAuthRequestHeaders({
    authCookie: options.authCookie,
    authHeaders: options.authHeaders,
  });
  const fetchTimeout = Math.min(options.timeoutMs, 10_000);

  const apiPayload = await tryFetchJson(`${options.baseUrl}/api/bundle`, fetchImpl, headers, fetchTimeout);
  if (apiPayload !== null) {
    return {
      source: 'api-bundle',
      ...extractSamplesFromBundle(apiPayload, {
        samplePeople: options.samplePeople,
        samplePlaces: options.samplePlaces,
      }),
    };
  }

  const staticPayload = await tryFetchJson(
    `${options.baseUrl}/data/bundle.json`,
    fetchImpl,
    headers,
    fetchTimeout
  );
  if (staticPayload !== null) {
    return {
      source: 'static-bundle',
      ...extractSamplesFromBundle(staticPayload, {
        samplePeople: options.samplePeople,
        samplePlaces: options.samplePlaces,
      }),
    };
  }

  return { source: 'none', people: [], places: [], narratives: [] };
}

export function isKnownCoreRoute(routePath: string): boolean {
  const pathOnly = routePath.split('?')[0].toLowerCase();
  if (KNOWN_CORE_EXACT_ROUTES.has(pathOnly)) {
    return true;
  }
  return KNOWN_CORE_PREFIXES.some((prefix) => pathOnly.startsWith(prefix));
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

export function buildPageCaptureTargets(input: {
  readonly discovery: BundleDiscoveryResult;
  readonly navExtraCoreRoutes: readonly { readonly route: string; readonly label: string }[];
  readonly explicitRoutes: readonly string[];
}): readonly PageCaptureTarget[] {
  const targets: PageCaptureTarget[] = [];
  const seenRoutes = new Set<string>();

  const pushTarget = (target: PageCaptureTarget): void => {
    if (seenRoutes.has(target.route)) {
      return;
    }
    seenRoutes.add(target.route);
    targets.push(target);
  };

  for (const core of CORE_KINLOOM_PAGE_ROUTES) {
    pushTarget({
      category: 'page',
      id: `page:${core.slug}`,
      slug: core.slug,
      label: core.label,
      route: core.route,
      isMap: core.isMap,
    });
  }

  for (const person of input.discovery.people) {
    const route = `/person/${person.slug}`;
    const slug = sanitizeSlug(`person-${person.slug}`, 'person');
    pushTarget({
      category: 'page',
      id: `page:${slug}`,
      slug,
      label: `Person: ${person.fullName}`,
      route,
    });
  }

  for (const place of input.discovery.places) {
    const route = `/place/${place.slug}`;
    const slug = sanitizeSlug(`place-${place.slug}`, 'place');
    pushTarget({
      category: 'page',
      id: `page:${slug}`,
      slug,
      label: `Place: ${place.name}`,
      route,
    });
  }

  for (const extra of input.navExtraCoreRoutes) {
    if (extra.route === '/people') {
      continue;
    }
    const slug = routeToSlug(extra.route);
    pushTarget({
      category: 'page',
      id: `page:${slug}`,
      slug,
      label: extra.label,
      route: extra.route,
      isMap: extra.route === '/map',
    });
  }

  const hasNarrativesNav = input.navExtraCoreRoutes.some((item) => item.route === '/narratives');
  if (hasNarrativesNav) {
    for (const narrative of input.discovery.narratives) {
      const route = `/narratives/${narrative.slug}`;
      const slug = sanitizeSlug(`narrative-${narrative.slug}`, 'narrative');
      pushTarget({
        category: 'page',
        id: `page:${slug}`,
        slug,
        label: `Narrative: ${narrative.title}`,
        route,
      });
    }
  }

  for (const route of input.explicitRoutes) {
    const slug = routeToSlug(route);
    pushTarget({
      category: 'page',
      id: `page:${slug}`,
      slug,
      label: route === '/' ? 'Archive Overview' : `Route ${route}`,
      route,
      isMap: route === '/map',
    });
  }

  return targets;
}

export function buildPluginCaptureTargets(input: {
  readonly discoveredPluginRoutes: readonly { readonly route: string; readonly label: string }[];
  readonly explicitPluginRoutes: readonly string[];
  readonly discoveredSlots: readonly DiscoveredPluginSlot[];
}): readonly PluginCaptureTarget[] {
  const targets: PluginCaptureTarget[] = [];
  const seenIds = new Set<string>();

  const pushTarget = (target: PluginCaptureTarget): void => {
    if (seenIds.has(target.id)) {
      return;
    }
    seenIds.add(target.id);
    targets.push(target);
  };

  for (const item of input.discoveredPluginRoutes) {
    const slug = routeToSlug(item.route);
    pushTarget({
      category: 'plugin',
      id: `plugin:route:${slug}`,
      slug,
      state: 'default',
      label: `Plugin Screen: ${item.label}`,
      route: item.route,
    });
  }

  for (const route of input.explicitPluginRoutes) {
    const slug = routeToSlug(route);
    pushTarget({
      category: 'plugin',
      id: `plugin:route:${slug}`,
      slug,
      state: 'default',
      label: `Plugin Route ${route}`,
      route,
    });
  }

  for (const slot of input.discoveredSlots) {
    const slug = sanitizeSlug(`slot-${slot.pluginId}-${slot.slotName}`, 'plugin-slot');
    pushTarget({
      category: 'plugin',
      id: `plugin:slot:${slug}`,
      slug,
      state: 'widget',
      label: `Plugin Widget: ${slot.pluginId} (${slot.slotName})`,
      route: slot.route,
      pluginId: slot.pluginId,
      slotSelector: slot.selector,
    });
  }

  return targets;
}
