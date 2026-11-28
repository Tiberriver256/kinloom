import { describe, expect, it } from 'vitest';
import {
  applyThemeToDocument,
  readResolvedDarkMode,
  readStoredThemePreference,
  subscribeResolvedDarkMode,
} from './useThemePreference.js';

describe('useThemePreference SSR guards in Node environment', () => {
  it('returns safe system defaults and no-op subscriptions when window and document are undefined', () => {
    expect(readStoredThemePreference()).toBe('system');
    expect(readResolvedDarkMode()).toBe(false);
    expect(applyThemeToDocument('dark')).toBeUndefined();

    const calls: boolean[] = [];
    const unsubscribe = subscribeResolvedDarkMode((isDark) => {
      calls.push(isDark);
    });
    expect(unsubscribe()).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
