import {
  type EntityType,
  isSafeInternalRoute,
  KinloomOnboardingStepSchema,
  type PluginDocumentation,
} from '@kinloom/core';
import type {
  EntityCreateFormEntry,
  EntityEditFormEntry,
} from '../components/wiki/entityForms/fieldTypes.js';
import type {
  KinloomMediaRenderer,
  KinloomOnboardingContext,
  KinloomOnboardingStep,
  KinloomUiPlugin,
  KinloomUiPluginRoute,
} from './types.js';

export type CompiledKinloomOnboardingStep = KinloomOnboardingStep & {
  readonly pluginId: string;
};

export interface CompiledKinloomUiPlugins {
  readonly plugins: readonly KinloomUiPlugin[];
  readonly routes: readonly (KinloomUiPluginRoute & { pluginId: string })[];
  readonly mediaRenderers: readonly KinloomMediaRenderer[];
  readonly entityEditForms: Readonly<Partial<Record<EntityType, EntityEditFormEntry>>>;
  readonly entityCreateForms: Readonly<Partial<Record<EntityType, EntityCreateFormEntry>>>;
  readonly onboardingSteps: readonly CompiledKinloomOnboardingStep[];
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
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end > 0 ? trimmed.slice(0, end) : '/';
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

function compareCompiledOnboardingSteps(
  a: CompiledKinloomOnboardingStep,
  b: CompiledKinloomOnboardingStep
): number {
  const orderA = a.order ?? 200;
  const orderB = b.order ?? 200;
  if (orderA !== orderB) {
    return orderA - orderB;
  }
  const byPlugin = a.pluginId.localeCompare(b.pluginId);
  if (byPlugin !== 0) {
    return byPlugin;
  }
  return a.id.localeCompare(b.id);
}

function validatePluginOnboardingStep(
  step: KinloomOnboardingStep,
  pluginId: string,
  seenStepOwners: Map<string, string>
): CompiledKinloomOnboardingStep {
  const parsed = KinloomOnboardingStepSchema.safeParse({
    id: step.id,
    title: step.title,
    description: step.description,
    ...(step.minRole !== undefined ? { minRole: step.minRole } : {}),
    ...(step.roles !== undefined ? { roles: [...step.roles] } : {}),
    ...(step.order !== undefined ? { order: step.order } : {}),
    ...(step.targetRoute !== undefined ? { targetRoute: step.targetRoute } : {}),
    ...(step.tutorialChapterId !== undefined ? { tutorialChapterId: step.tutorialChapterId } : {}),
  });

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const pathLabel = issue?.path?.length ? issue.path.join('.') : 'step';
    throw new RangeError(
      `UI plugin '${pluginId}' onboarding step '${String(step.id ?? '')}' has invalid ${pathLabel}: ${issue?.message ?? 'invalid schema'}.`
    );
  }

  const normalizedId = parsed.data.id;
  if (normalizedId.toLowerCase().startsWith('core:')) {
    throw new RangeError(
      `UI plugin '${pluginId}' onboarding step '${normalizedId}' cannot use reserved 'core:' prefix.`
    );
  }

  const existingOwner = seenStepOwners.get(normalizedId);
  if (existingOwner) {
    throw new RangeError(
      `Duplicate UI plugin onboarding step id '${normalizedId}' in plugin '${pluginId}' (already registered by plugin '${existingOwner}').`
    );
  }

  if (step.action !== undefined) {
    const action = step.action;
    if (typeof action.label !== 'string' || action.label.trim().length === 0) {
      throw new RangeError(
        `UI plugin '${pluginId}' onboarding step '${normalizedId}' action.label must be a non-empty string.`
      );
    }
    if (action.kind === 'route') {
      if (typeof action.to !== 'string' || !isSafeInternalRoute(action.to)) {
        throw new RangeError(
          `UI plugin '${pluginId}' onboarding step '${normalizedId}' action.to '${String(action.to)}' must be a safe internal route starting with '/'.`
        );
      }
    } else if (action.kind === 'tutorial') {
      if (typeof action.chapterId !== 'string' || action.chapterId.trim().length === 0) {
        throw new RangeError(
          `UI plugin '${pluginId}' onboarding step '${normalizedId}' action.chapterId must be a non-empty string.`
        );
      }
    } else if (action.kind === 'callback') {
      if (typeof action.onActivate !== 'function') {
        throw new RangeError(
          `UI plugin '${pluginId}' onboarding step '${normalizedId}' action.onActivate must be a function.`
        );
      }
    } else {
      throw new RangeError(
        `UI plugin '${pluginId}' onboarding step '${normalizedId}' has unsupported action kind.`
      );
    }
  }

  seenStepOwners.set(normalizedId, pluginId);

  return {
    ...step,
    id: normalizedId,
    title: parsed.data.title,
    description: parsed.data.description,
    ...(parsed.data.targetRoute !== undefined ? { targetRoute: parsed.data.targetRoute } : {}),
    ...(parsed.data.tutorialChapterId !== undefined
      ? { tutorialChapterId: parsed.data.tutorialChapterId }
      : {}),
    pluginId,
  };
}

/**
 * Fault-isolated resolver for dynamic `plugin.getOnboardingSteps(ctx)` hooks.
 * Invalid, spoofed (`core:*`), duplicate, or throwing plugin hooks are ignored safely.
 */
export function resolveDynamicPluginOnboardingSteps(
  plugins: readonly KinloomUiPlugin[],
  staticStepIds: ReadonlySet<string>,
  ctx: KinloomOnboardingContext
): readonly CompiledKinloomOnboardingStep[] {
  const seenStepOwners = new Map<string, string>();
  for (const id of staticStepIds) {
    seenStepOwners.set(id, 'static');
  }
  const resolved: CompiledKinloomOnboardingStep[] = [];

  for (const plugin of plugins) {
    if (typeof plugin.getOnboardingSteps !== 'function') {
      continue;
    }
    let rawSteps: readonly KinloomOnboardingStep[];
    try {
      const result = plugin.getOnboardingSteps(ctx);
      if (!Array.isArray(result)) {
        continue;
      }
      rawSteps = result;
    } catch {
      continue;
    }

    for (const rawStep of rawSteps) {
      if (!rawStep || typeof rawStep !== 'object') {
        continue;
      }
      try {
        resolved.push(validatePluginOnboardingStep(rawStep, plugin.id.trim(), seenStepOwners));
      } catch {
        // Ignore malformed or colliding dynamic plugin steps rather than crashing the shell.
      }
    }
  }

  return resolved.toSorted(compareCompiledOnboardingSteps);
}

/**
 * Validate UI plugin IDs, route paths, entity form overrides, and static onboarding steps at provider startup.
 * Throws RangeError on empty/duplicate IDs, reserved or duplicate routes, conflicting form overrides, or invalid onboarding steps.
 */

function assertValidUiPluginDocumentation(doc: PluginDocumentation, ownerLabel: string): void {
  if (
    !doc ||
    typeof doc !== 'object' ||
    typeof doc.id !== 'string' ||
    doc.id.trim().length === 0 ||
    typeof doc.title !== 'string' ||
    doc.title.trim().length === 0 ||
    typeof doc.summary !== 'string' ||
    doc.summary.trim().length === 0 ||
    !Array.isArray(doc.sections) ||
    doc.sections.length === 0
  ) {
    throw new RangeError(
      `${ownerLabel} has invalid documentation: id, title, summary, and non-empty sections are required.`
    );
  }
  if (doc.externalUrl !== undefined) {
    if (typeof doc.externalUrl !== 'string' || !/^https?:\/\//i.test(doc.externalUrl.trim())) {
      throw new RangeError(
        `${ownerLabel} has invalid documentation: externalUrl must use http:// or https://.`
      );
    }
  }
  const seen = new Set<string>();
  for (const sec of doc.sections) {
    if (
      !sec ||
      typeof sec !== 'object' ||
      typeof sec.id !== 'string' ||
      sec.id.trim().length === 0 ||
      typeof sec.heading !== 'string' ||
      sec.heading.trim().length === 0 ||
      typeof sec.markdown !== 'string' ||
      sec.markdown.trim().length === 0
    ) {
      throw new RangeError(
        `${ownerLabel} has invalid documentation: each section requires non-empty id, heading, and markdown.`
      );
    }
    const id = sec.id.trim();
    if (seen.has(id)) {
      throw new RangeError(
        `${ownerLabel} has invalid documentation: Duplicate documentation section id '${id}'.`
      );
    }
    seen.add(id);
  }
}

export function validateAndCompileUiPlugins(plugins: readonly KinloomUiPlugin[]): CompiledKinloomUiPlugins {
  const seenPluginIds = new Set<string>();
  const seenRouteOwners = new Map<string, { pluginId: string; path: string }>();
  const seenStepOwners = new Map<string, string>();
  const editFormOwners = new Map<EntityType, string>();
  const createFormOwners = new Map<EntityType, string>();

  const routes: (KinloomUiPluginRoute & { pluginId: string })[] = [];
  const mediaRenderers: KinloomMediaRenderer[] = [];
  const entityEditForms: Partial<Record<EntityType, EntityEditFormEntry>> = {};
  const entityCreateForms: Partial<Record<EntityType, EntityCreateFormEntry>> = {};
  const onboardingSteps: CompiledKinloomOnboardingStep[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      throw new RangeError('UI plugin id must be a non-empty string.');
    }
    if (seenPluginIds.has(pluginId)) {
      throw new RangeError(`Duplicate UI plugin id '${pluginId}'.`);
    }
    seenPluginIds.add(pluginId);

    if (plugin.documentation !== undefined) {
      assertValidUiPluginDocumentation(plugin.documentation, `UI plugin '${pluginId}'`);
    }

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

    if (plugin.onboardingSteps) {
      for (const step of plugin.onboardingSteps) {
        onboardingSteps.push(validatePluginOnboardingStep(step, pluginId, seenStepOwners));
      }
    }
  }

  return {
    plugins,
    routes,
    mediaRenderers,
    entityEditForms,
    entityCreateForms,
    onboardingSteps: onboardingSteps.toSorted(compareCompiledOnboardingSteps),
  };
}
