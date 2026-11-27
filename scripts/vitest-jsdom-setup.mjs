import { afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (globalThis.fetch !== ORIGINAL_FETCH) {
    globalThis.fetch = ORIGINAL_FETCH;
  }
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.history.replaceState({}, '', '/');
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1280,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        writable: true,
        value: 800,
      });
    } catch {
      // Ignore storage/history errors on non-standard test origins.
    }
  }
  if (typeof document !== 'undefined') {
    document.body.innerHTML = '';
    document.title = '';
  }
});
