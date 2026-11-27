import type { EntityType } from '@kinloom/core';
import type {
  EntityCreateFormEntry,
  EntityEditFormEntry,
} from '../components/wiki/entityForms/fieldTypes.js';
import type { KinloomMediaRenderer, KinloomUiPlugin, KinloomUiPluginRoute } from './types.js';

export interface CompiledKinloomUiPlugins {
  readonly plugins: readonly KinloomUiPlugin[];
  readonly routes: readonly (KinloomUiPluginRoute & { pluginId: string })[];
  readonly mediaRenderers: readonly KinloomMediaRenderer[];
  readonly entityEditForms: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>;
  readonly entityCreateForms: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>>;
}

export const RESERVED_UI_ROUTE_PATHS: readonly string[] = [
  '/',
  '/people',
  '/person/:slug',
  '/places',
  '/place/:slug',
  '/time',
  '/tree',
  '/map',
  '/kinship',
  '/evidence',
  '/changes',
  '/admin',
];

function normalizeUiRoutePath(raw: string, pluginId: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) {
    throw new RangeError(`UI plugin '${pluginId}' route path '${raw}' must start with '/'.`);
  }
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  return withoutTrailingSlash.length > 0 ? withoutTrailingSlash : '/';
}

/**
 * Canonicalize dynamic parameter segments (`:slug`, `:id`) into `:` so
 * `/person/:id` is detected as colliding with built-in `/person/:slug`.
 */
function routeCollisionKey(normalizedPath: string): string {
  if (normalizedPath === '/') {
    return '/';
  }
  return normalizedPath
    .split('/')
    .map((seg) => (seg.startsWith(':') ? ':' : seg.toLowerCase()))
    .join('/');
}

const RESERVED_UI_ROUTE_KEYS = new Map<string, string>(
  RESERVED_UI_ROUTE_PATHS.map((p) => [routeCollisionKey(p), p])
);

/**
 * Validate UI plugin IDs, route paths, and entity form overrides at provider startup.
 * Throws RangeError on empty/duplicate IDs, reserved or duplicate routes, or duplicate form overrides.
 */
export function validateAndCompileUiPlugins(plugins: readonly KinloomUiPlugin[]): CompiledKinloomUiPlugins {
  const seenPluginIds = new Set<string>();
  const seenRouteOwners = new Map<string, { pluginId: string; path: string }>();
  const editFormOwners = new Map<EntityType, string>();
  const createFormOwners = new Map<EntityType, string>();

  const routes: (KinloomUiPluginRoute & { pluginId: string })[] = [];
  const mediaRenderers: KinloomMediaRenderer[] = [];
  const entityEditForms: Partial<Record<EntityType, EntityEditFormEntry>> = {};
  const entityCreateForms: Partial<Record<EntityType, EntityCreateFormEntry>> = {};

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      throw new RangeError('UI plugin id must be a non-empty string.');
    }
    if (seenPluginIds.has(pluginId)) {
      throw new RangeError(`Duplicate UI plugin id '${pluginId}'.`);
    }
    seenPluginIds.add(pluginId);

    if (plugin.routes) {
      for (const route of plugin.routes) {
        const normalizedPath = normalizeUiRoutePath(route.path, pluginId);
        const key = routeCollisionKey(normalizedPath);
        const reservedMatch = RESERVED_UI_ROUTE_KEYS.get(key);
        if (reservedMatch !== undefined) {
          throw new RangeError(
            `UI plugin '${pluginId}' route '${normalizedPath}' collides with reserved built-in route '${reservedMatch}'.`
          );
        }
        const existingOwner = seenRouteOwners.get(key);
        if (existingOwner) {
          throw new RangeError(
            `Duplicate UI plugin route '${normalizedPath}' in plugin '${pluginId}' conflicts with '${existingOwner.path}' in plugin '${existingOwner.pluginId}'.`
          );
        }
        seenRouteOwners.set(key, { pluginId, path: normalizedPath });
        let normalizedPrefix: string | undefined;
        if (route.navMatchPrefix !== undefined) {
          normalizedPrefix = normalizeUiRoutePath(route.navMatchPrefix, pluginId);
        }
        if (route.navOrder !== undefined && !Number.isFinite(route.navOrder)) {
          throw new RangeError(
            `UI plugin '${pluginId}' route '${normalizedPath}' navOrder must be a finite number.`
          );
        }
        routes.push({
          ...route,
          path: normalizedPath,
          ...(normalizedPrefix !== undefined ? { navMatchPrefix: normalizedPrefix } : {}),
          pluginId,
        });
      }
    }

    if (plugin.mediaRenderers) {
      mediaRenderers.push(...plugin.mediaRenderers);
    }

    if (plugin.entityEditForms) {
      for (const [entityType, entry] of Object.entries(plugin.entityEditForms) as [
        EntityType,
        EntityEditFormEntry | undefined,
      ][]) {
        if (!entry) {
          continue;
        }
        const existingOwner = editFormOwners.get(entityType);
        if (existingOwner) {
          throw new RangeError(
            `Conflicting UI plugin entityEditForms override for '${entityType}' in plugin '${pluginId}' (already registered by plugin '${existingOwner}').`
          );
        }
        editFormOwners.set(entityType, pluginId);
        entityEditForms[entityType] = entry;
      }
    }

    if (plugin.entityCreateForms) {
      for (const [entityType, entry] of Object.entries(plugin.entityCreateForms) as [
        EntityType,
        EntityCreateFormEntry | undefined,
      ][]) {
        if (!entry) {
          continue;
        }
        const existingOwner = createFormOwners.get(entityType);
        if (existingOwner) {
          throw new RangeError(
            `Conflicting UI plugin entityCreateForms override for '${entityType}' in plugin '${pluginId}' (already registered by plugin '${existingOwner}').`
          );
        }
        createFormOwners.set(entityType, pluginId);
        entityCreateForms[entityType] = entry;
      }
    }
  }

  return { plugins, routes, mediaRenderers, entityEditForms, entityCreateForms };
}
