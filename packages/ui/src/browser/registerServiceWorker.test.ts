import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isServiceWorkerSupportedOrigin,
  registerKinloomServiceWorker,
  resolveServiceWorkerTarget,
  type ServiceWorkerRegistrar,
} from './registerServiceWorker.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerKinloomServiceWorker', () => {
  it('resolves root and subpath service worker script URLs and scopes', () => {
    expect(resolveServiceWorkerTarget()).toEqual({ scriptUrl: '/sw.js', scope: '/' });
    expect(resolveServiceWorkerTarget('/')).toEqual({ scriptUrl: '/sw.js', scope: '/' });
    expect(resolveServiceWorkerTarget('/kinloom')).toEqual({
      scriptUrl: '/kinloom/sw.js',
      scope: '/kinloom/',
    });
    expect(resolveServiceWorkerTarget('/kinloom/')).toEqual({
      scriptUrl: '/kinloom/sw.js',
      scope: '/kinloom/',
    });
  });

  it('allows only HTTPS or localhost origins for service worker registration', () => {
    expect(isServiceWorkerSupportedOrigin({ protocol: 'https:', hostname: 'archive.example.test' })).toBe(
      true
    );
    expect(isServiceWorkerSupportedOrigin({ protocol: 'http:', hostname: 'localhost' })).toBe(true);
    expect(isServiceWorkerSupportedOrigin({ protocol: 'http:', hostname: '127.0.0.1' })).toBe(true);
    expect(isServiceWorkerSupportedOrigin({ protocol: 'http:', hostname: '[::1]' })).toBe(true);
    expect(isServiceWorkerSupportedOrigin({ protocol: 'http:', hostname: 'archive.example.test' })).toBe(
      false
    );
    expect(isServiceWorkerSupportedOrigin({ protocol: 'file:', hostname: '' })).toBe(false);
    expect(isServiceWorkerSupportedOrigin(null)).toBe(false);
  });

  it('skips automatically in Vitest, when disabled, on non-HTTPS origins, or when serviceWorker is unavailable', async () => {
    // Default invocation inside Vitest skips cleanly without requiring a browser global.
    expect(await registerKinloomServiceWorker()).toBeNull();

    const register = vi.fn();
    const registrar: ServiceWorkerRegistrar = { register };

    expect(
      await registerKinloomServiceWorker({
        enabled: false,
        serviceWorker: registrar,
        location: { protocol: 'https:', hostname: 'archive.example.test' },
      })
    ).toBeNull();

    expect(
      await registerKinloomServiceWorker({
        serviceWorker: registrar,
        location: { protocol: 'http:', hostname: 'archive.example.test' },
      })
    ).toBeNull();

    expect(
      await registerKinloomServiceWorker({
        serviceWorker: null,
        location: { protocol: 'https:', hostname: 'archive.example.test' },
        skipInTests: false,
      })
    ).toBeNull();

    expect(register).not.toHaveBeenCalled();
  });

  it('registers /sw.js with updateViaCache: none for root and subpath deployments', async () => {
    const fakeRegistration = { scope: '/' } as ServiceWorkerRegistration;
    const register = vi.fn(async () => fakeRegistration);

    const rootResult = await registerKinloomServiceWorker({
      baseUrl: '/',
      serviceWorker: { register },
      location: { protocol: 'https:', hostname: 'archive.example.test' },
    });
    expect(rootResult).toBe(fakeRegistration);
    expect(register).toHaveBeenCalledWith('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });

    const subpathResult = await registerKinloomServiceWorker({
      baseUrl: '/kinloom/',
      serviceWorker: { register },
      location: { protocol: 'http:', hostname: 'localhost' },
    });
    expect(subpathResult).toBe(fakeRegistration);
    expect(register).toHaveBeenCalledWith('/kinloom/sw.js', {
      scope: '/kinloom/',
      updateViaCache: 'none',
    });
  });

  it('swallows registration errors silently with zero console noise', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const rejectingRegistrar: ServiceWorkerRegistrar = {
      register: vi.fn(async () => {
        throw new Error('SecurityError: SW blocked');
      }),
    };

    const result = await registerKinloomServiceWorker({
      serviceWorker: rejectingRegistrar,
      location: { protocol: 'https:', hostname: 'archive.example.test' },
    });

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
