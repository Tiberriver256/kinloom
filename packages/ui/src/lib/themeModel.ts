export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kinloom-theme';

export function parseStoredThemePreference(raw: string | null | undefined): ThemePreference {
  if (raw === 'light' || raw === 'dark') {
    return raw;
  }
  return 'system';
}

export function resolveTheme(preference: ThemePreference, systemIsDark: boolean): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') {
    return preference;
  }
  return systemIsDark ? 'dark' : 'light';
}

/**
 * Two-state convenience toggle: switches to the opposite of the currently rendered scheme.
 * When the target matches the current OS preference, reverts to `'system'` instead of pinning.
 */
export function computeQuickTogglePreference(
  currentPreference: ThemePreference,
  systemIsDark: boolean
): ThemePreference {
  const currentResolved = resolveTheme(currentPreference, systemIsDark);
  const target: ResolvedTheme = currentResolved === 'dark' ? 'light' : 'dark';
  const systemTheme: ResolvedTheme = systemIsDark ? 'dark' : 'light';
  return target === systemTheme ? 'system' : target;
}

export function toColorSchemeMetaContent(preference: ThemePreference): 'light dark' | 'light' | 'dark' {
  return preference === 'system' ? 'light dark' : preference;
}
