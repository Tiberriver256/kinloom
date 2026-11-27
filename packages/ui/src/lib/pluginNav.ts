import type { ArchiveCapabilities, ArchiveSessionState } from '@kinloom/core';
import type { KinloomUiPluginNavMinRole, KinloomUiPluginRoute } from '../plugins/types.js';

function stripTrailingSlashes(pathname: string): string {
  if (pathname === '/' || pathname === '') {
    return '/';
  }
  const stripped = pathname.replace(/\/+$/, '');
  return stripped.length > 0 ? stripped : '/';
}

/**
 * Evaluates whether a plugin navigation route is visible for the active session and capabilities.
 * Routes default to `'public'` visibility when `navMinRole` is omitted.
 */
export function isPluginNavRouteVisible(
  minRole: KinloomUiPluginNavMinRole | undefined,
  session: ArchiveSessionState | null,
  capabilities: ArchiveCapabilities
): boolean {
  const effectiveRole: KinloomUiPluginNavMinRole = minRole ?? 'public';
  if (effectiveRole === 'public') {
    return true;
  }
  if (effectiveRole === 'viewer') {
    return session !== null && session.principal_kind !== 'anonymous';
  }
  if (effectiveRole === 'editor') {
    return Boolean(capabilities.canEdit || (session?.authenticated && session.principal_kind === 'user'));
  }
  return Boolean(
    capabilities.canManageSite ||
      (session?.authenticated && session.principal_kind === 'user' && session.role === 'admin')
  );
}

/**
 * Checks whether a plugin route's navigation item should render as active for `pathname`.
 * Uses `navMatchPrefix` boundary matching when declared so nested routes (e.g. `/recipes/:slug`)
 * keep the parent nav pill active.
 */
export function isPluginNavRouteActive(
  route: Pick<KinloomUiPluginRoute, 'path' | 'navMatchPrefix'>,
  pathname: string
): boolean {
  const current = stripTrailingSlashes(pathname);
  if (route.navMatchPrefix !== undefined) {
    const prefix = stripTrailingSlashes(route.navMatchPrefix);
    if (prefix === '/') {
      return current === '/';
    }
    return current === prefix || current.startsWith(`${prefix}/`);
  }
  return current === stripTrailingSlashes(route.path);
}

/**
 * Filters plugin routes that declare `navLabel` by visibility role and sorts them by
 * ascending `navOrder` (ties preserve original registration order).
 */
export function selectVisiblePluginNavRoutes<T extends KinloomUiPluginRoute>(
  routes: readonly T[],
  session: ArchiveSessionState | null,
  capabilities: ArchiveCapabilities
): readonly T[] {
  return routes
    .map((route, index) => ({ route, index }))
    .filter(
      ({ route }) =>
        Boolean(route.navLabel) && isPluginNavRouteVisible(route.navMinRole, session, capabilities)
    )
    .toSorted((a, b) => {
      const orderA = a.route.navOrder ?? 0;
      const orderB = b.route.navOrder ?? 0;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a.index - b.index;
    })
    .map(({ route }) => route);
}
