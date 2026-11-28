import { type BundleDiscoveryResult, CORE_KINLOOM_PAGE_ROUTES } from '../shared/routeDiscovery.js';
import { routeToSlug, sanitizeSlug } from './parse.js';
import type { DiscoveredPluginSlot, PageCaptureTarget, PluginCaptureTarget } from './types.js';

export {
  BUNDLE_DISCOVERY_PROBES,
  CORE_KINLOOM_PAGE_ROUTES,
  classifyDiscoveredNavLinks,
  extractEnabledPluginRoutesFromBundle,
  extractSamplesFromBundle,
  type FetchedArchiveBundlePayload,
  fetchArchiveBundleForDiscovery,
  fetchArchiveBundlePayloadForDiscovery,
  isKnownCoreRoute,
} from '../shared/routeDiscovery.js';

function isHeavyRoutePath(route: string): boolean {
  const pathOnly = (route.split('?')[0] ?? '').toLowerCase();
  return pathOnly === '/evidence';
}

function isMapRoutePath(route: string): boolean {
  const pathOnly = (route.split('?')[0] ?? '').toLowerCase();
  return pathOnly === '/map';
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
      isHeavyPage: core.isHeavyPage,
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
      isMap: isMapRoutePath(extra.route),
      isHeavyPage: isHeavyRoutePath(extra.route),
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
      isMap: isMapRoutePath(route),
      isHeavyPage: isHeavyRoutePath(route),
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
