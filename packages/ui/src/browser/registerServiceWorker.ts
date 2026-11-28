import { joinPwaBasePath, normalizePwaBaseUrl } from '@kinloom/core';

export interface ServiceWorkerRegistrar {
  register(scriptURL: string | URL, options?: RegistrationOptions): Promise<ServiceWorkerRegistration>;
}

export interface RegisterServiceWorkerOptions {
  readonly baseUrl?: string;
  readonly enabled?: boolean;
  readonly serviceWorker?: ServiceWorkerRegistrar | null;
  readonly location?: Pick<Location, 'protocol' | 'hostname'> | null;
  readonly skipInTests?: boolean;
}

export interface ResolvedServiceWorkerTarget {
  readonly scriptUrl: string;
  readonly scope: string;
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function resolveServiceWorkerTarget(baseUrl?: string): ResolvedServiceWorkerTarget {
  const scope = normalizePwaBaseUrl(baseUrl);
  return {
    scriptUrl: joinPwaBasePath(scope, 'sw.js'),
    scope,
  };
}

export function isServiceWorkerSupportedOrigin(
  location?: Pick<Location, 'protocol' | 'hostname'> | null
): boolean {
  if (!location) {
    return false;
  }
  const protocol = location.protocol.toLowerCase();
  if (protocol === 'https:') {
    return true;
  }
  return protocol === 'http:' && LOCALHOST_HOSTNAMES.has(location.hostname.toLowerCase());
}

function isVitestRuntime(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  if (env?.['VITEST']) {
    return true;
  }
  const metaEnv = (import.meta as { env?: Record<string, unknown> }).env;
  return Boolean(metaEnv?.['VITEST']) || metaEnv?.['MODE'] === 'test';
}

/**
 * Registers Kinloom's privacy-safe `/sw.js` service worker in supported browser contexts.
 * Skips automatically in SSR, Vitest, non-HTTPS remote origins, or browsers without Service Worker
 * support, and swallows registration errors without console noise.
 */
export async function registerKinloomServiceWorker(
  options?: RegisterServiceWorkerOptions
): Promise<ServiceWorkerRegistration | null> {
  if (options?.enabled === false) {
    return null;
  }

  const skipInTests = options?.skipInTests ?? options?.serviceWorker === undefined;
  if (skipInTests && isVitestRuntime()) {
    return null;
  }

  const location = options?.location ?? (typeof window !== 'undefined' ? window.location : null);
  if (!isServiceWorkerSupportedOrigin(location)) {
    return null;
  }

  const container =
    options?.serviceWorker !== undefined
      ? options.serviceWorker
      : typeof navigator !== 'undefined' && 'serviceWorker' in navigator
        ? navigator.serviceWorker
        : null;

  if (!container || typeof container.register !== 'function') {
    return null;
  }

  const target = resolveServiceWorkerTarget(options?.baseUrl);
  try {
    return await container.register(target.scriptUrl, {
      scope: target.scope,
      updateViaCache: 'none',
    });
  } catch {
    return null;
  }
}
