import { afterEach, vi } from 'vitest';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (globalThis.fetch !== ORIGINAL_FETCH) {
    globalThis.fetch = ORIGINAL_FETCH;
  }
});
