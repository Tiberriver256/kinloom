import { useCallback, useEffect, useState } from 'react';
import {
  computeQuickTogglePreference,
  parseStoredThemePreference,
  type ResolvedTheme,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
  toColorSchemeMetaContent,
} from '../lib/themeModel.js';

const THEME_CHANGE_EVENT = 'kinloom-theme-change';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

function getDarkMediaQueryList(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return null;
  }
  return window.matchMedia(DARK_MEDIA_QUERY);
}

export function readSystemPrefersDark(): boolean {
  return getDarkMediaQueryList()?.matches ?? false;
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') {
    return 'system';
  }
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    if (stored !== null) {
      return 'system';
    }
  } catch {
    // Restricted storage falls back to any active DOM theme override.
  }
  return parseStoredThemePreference(document.documentElement.dataset.theme);
}

export function readResolvedDarkMode(): boolean {
  if (typeof document !== 'undefined') {
    const domTheme = document.documentElement.dataset.theme;
    if (domTheme === 'dark' || domTheme === 'light') {
      return domTheme === 'dark';
    }
  }
  return readSystemPrefersDark();
}

export function applyThemeToDocument(preference: ThemePreference): void {
  if (typeof document === 'undefined') {
    return;
  }
  const root = document.documentElement;
  if (preference === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
  if (meta) {
    meta.content = toColorSchemeMetaContent(preference);
  }
}

function persistThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Restricted storage contexts still apply the theme to the active document.
  }
}

function subscribeMediaQueryChange(
  mql: MediaQueryList | null,
  listener: (event: MediaQueryListEvent) => void
): () => void {
  if (!mql || typeof mql.addEventListener !== 'function') {
    return () => {};
  }
  mql.addEventListener('change', listener);
  return (): void => {
    mql.removeEventListener('change', listener);
  };
}

export function subscribeResolvedDarkMode(onChange: (isDark: boolean) => void): () => void {
  if (typeof window === 'undefined') {
    return () => {};
  }
  let lastValue = readResolvedDarkMode();
  const notify = (): void => {
    const nextValue = readResolvedDarkMode();
    if (nextValue !== lastValue) {
      lastValue = nextValue;
      onChange(nextValue);
    }
  };

  const unsubscribeMedia = subscribeMediaQueryChange(getDarkMediaQueryList(), notify);
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  window.addEventListener(THEME_CHANGE_EVENT, notify);
  return (): void => {
    unsubscribeMedia();
    observer.disconnect();
    window.removeEventListener(THEME_CHANGE_EVENT, notify);
  };
}

export interface ThemePreferenceState {
  readonly preference: ThemePreference;
  readonly resolvedTheme: ResolvedTheme;
  readonly systemTheme: ResolvedTheme;
  readonly isDark: boolean;
  readonly setPreference: (next: ThemePreference) => void;
  readonly toggleQuickTheme: () => void;
}

export function useThemePreference(): ThemePreferenceState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredThemePreference());
  const [systemIsDark, setSystemIsDark] = useState<boolean>(() => readSystemPrefersDark());

  useEffect(() => {
    applyThemeToDocument(preference);
  }, [preference]);

  useEffect(() => {
    const onMediaChange = (event: MediaQueryListEvent): void => {
      // Never delete a stored light/dark pin when OS preference shifts to match it.
      setSystemIsDark(event.matches);
    };
    const unsubscribeMedia = subscribeMediaQueryChange(getDarkMediaQueryList(), onMediaChange);

    const onStorage = (event: StorageEvent): void => {
      if (event.key !== THEME_STORAGE_KEY && event.key !== null) {
        return;
      }
      const next = parseStoredThemePreference(event.newValue);
      setPreferenceState(next);
      applyThemeToDocument(next);
    };

    const onSameTabChange = (event: Event): void => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const next = parseStoredThemePreference(typeof detail === 'string' ? detail : null);
      setPreferenceState(next);
    };

    window.addEventListener('storage', onStorage);
    window.addEventListener(THEME_CHANGE_EVENT, onSameTabChange);

    return (): void => {
      unsubscribeMedia();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(THEME_CHANGE_EVENT, onSameTabChange);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    applyThemeToDocument(next);
    persistThemePreference(next);
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: next }));
  }, []);

  const toggleQuickTheme = useCallback(() => {
    const currentSystemIsDark = readSystemPrefersDark();
    setSystemIsDark(currentSystemIsDark);
    const next = computeQuickTogglePreference(preference, currentSystemIsDark);
    setPreference(next);
  }, [preference, setPreference]);

  const resolvedTheme = resolveTheme(preference, systemIsDark);
  const systemTheme: ResolvedTheme = systemIsDark ? 'dark' : 'light';

  return {
    preference,
    resolvedTheme,
    systemTheme,
    isDark: resolvedTheme === 'dark',
    setPreference,
    toggleQuickTheme,
  };
}
