import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DiscoveredNavLink,
  DiscoveredPluginSlot,
  ScreenshotBrowserFactory,
  ScreenshotBrowserHandle,
  ScreenshotPageHandle,
  ScreenshotTheme,
} from './types.js';

export interface PlaywrightLaunchModule {
  readonly chromium: {
    executablePath?(): string;
    launch(options?: {
      readonly headless?: boolean;
      readonly executablePath?: string;
      readonly args?: readonly string[];
      readonly timeout?: number;
      readonly env?: Record<string, string>;
    }): Promise<ScreenshotBrowserHandle>;
  };
}

export type PlaywrightModuleImporter = (specifier: 'playwright-core' | 'playwright') => Promise<unknown>;

function isPlaywrightLaunchModule(value: unknown): value is PlaywrightLaunchModule {
  if (typeof value !== 'object' || value === null || !('chromium' in value)) {
    return false;
  }
  const { chromium } = value;
  return (
    typeof chromium === 'object' &&
    chromium !== null &&
    'launch' in chromium &&
    typeof chromium.launch === 'function'
  );
}

const DIRECT_CHROMIUM_PATHS = ['/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser'];
const CHROMIUM_BIN_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const DESKTOP_ENV_STRIP = [
  'WAYLAND_DISPLAY',
  'GTK_USE_PORTAL',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'CHROMIUM_USER_FLAGS',
  'CHROME_USER_FLAGS',
] as const;

const BASE_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-dev-shm-usage',
] as const;

const SYSTEM_EXTRA_ARGS = ['--password-store=basic', '--ozone-platform=headless'] as const;

export function isExecutableBinary(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveScreenshotChromiumPath(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly playwrightExecutablePath?: string;
  readonly isExecutable?: (filePath: string) => boolean;
}): { readonly executablePath?: string; readonly isSystemBinary: boolean } {
  const checkExec = options.isExecutable ?? isExecutableBinary;
  const envOverride = options.env.KINLOOM_CHROMIUM_PATH?.trim();
  if (envOverride && checkExec(envOverride)) {
    return { executablePath: envOverride, isSystemBinary: false };
  }
  const bundled = options.playwrightExecutablePath?.trim();
  if (bundled && checkExec(bundled)) {
    return { executablePath: undefined, isSystemBinary: false };
  }
  for (const candidate of DIRECT_CHROMIUM_PATHS) {
    if (checkExec(candidate)) {
      return { executablePath: candidate, isSystemBinary: true };
    }
  }
  const pathEnv = options.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const name of CHROMIUM_BIN_NAMES) {
      const fullPath = path.join(dir, name);
      if (checkExec(fullPath)) {
        return { executablePath: fullPath, isSystemBinary: true };
      }
    }
  }
  return { executablePath: undefined, isSystemBinary: false };
}

export function buildHeadlessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  for (const key of DESKTOP_ENV_STRIP) {
    delete cleaned[key];
  }
  cleaned.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'kinloom-headless-xdg-config');
  return cleaned;
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const effectiveMs = Math.max(50, Math.floor(timeoutMs));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      promise.catch(() => {});
      reject(new Error(`Timed out after ${effectiveMs}ms during ${label}.`));
    }, effectiveMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      },
      (err: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      }
    );
  });
}

export async function loadPlaywrightModule(
  importer: PlaywrightModuleImporter = (name) => import(name)
): Promise<PlaywrightLaunchModule> {
  const candidates = ['playwright-core', 'playwright'] as const;
  for (const name of candidates) {
    try {
      const mod = await importer(name);
      if (isPlaywrightLaunchModule(mod)) {
        return mod;
      }
    } catch {
      // Try next candidate package.
    }
  }
  throw new Error(
    'Screenshots require the optional `playwright-core` (or `playwright`) package (`npm install -D playwright-core`).'
  );
}

export function createPlaywrightBrowserFactory(deps?: {
  readonly loadModule?: () => Promise<PlaywrightLaunchModule>;
  readonly isExecutable?: (filePath: string) => boolean;
}): ScreenshotBrowserFactory {
  const loadModule = deps?.loadModule ?? loadPlaywrightModule;
  const isExecutable = deps?.isExecutable;

  return async ({ timeoutMs, env }) => {
    const playwrightMod = await loadModule();
    let bundledPath: string | undefined;
    try {
      bundledPath = playwrightMod.chromium.executablePath?.();
    } catch {
      bundledPath = undefined;
    }
    const resolved = resolveScreenshotChromiumPath({
      env,
      playwrightExecutablePath: bundledPath,
      isExecutable,
    });
    const args = resolved.isSystemBinary ? [...BASE_ARGS, ...SYSTEM_EXTRA_ARGS] : [...BASE_ARGS];
    const launchTimeout = Math.max(5_000, timeoutMs);
    return withTimeout(
      playwrightMod.chromium.launch({
        headless: true,
        timeout: launchTimeout,
        args,
        executablePath: resolved.executablePath,
        env: resolved.isSystemBinary ? buildHeadlessEnv(env) : undefined,
      }),
      launchTimeout + 2_000,
      'chromium.launch'
    );
  };
}

export const defaultScreenshotBrowserFactory: ScreenshotBrowserFactory = createPlaywrightBrowserFactory();

export async function safeCloseHandle(
  handle: { close(): Promise<void> } | undefined,
  label: string,
  timeoutMs = 5_000
): Promise<void> {
  if (!handle) {
    return;
  }
  try {
    await withTimeout(handle.close(), timeoutMs, label);
  } catch {
    // Suppress close timeout/errors during cleanup.
  }
}

export interface RawThemeSurfaceProbe {
  readonly backgroundColor: string | null;
  readonly textColor: string | null;
  readonly dataTheme: string | null;
  readonly colorScheme: string | null;
  readonly prefersDark: boolean | null;
}

const APPLY_LIGHT_THEME_EXPR =
  "(() => { const root = document.documentElement; if (root && root.hasAttribute('data-theme')) { root.setAttribute('data-theme', 'light'); } })()";
const APPLY_DARK_THEME_EXPR =
  "(() => { const root = document.documentElement; if (root && root.hasAttribute('data-theme')) { root.setAttribute('data-theme', 'dark'); } })()";

export async function navigateAndSettlePage(options: {
  readonly page: ScreenshotPageHandle;
  readonly url: string;
  readonly theme: ScreenshotTheme;
  readonly timeoutMs: number;
  readonly waitMs: number;
  readonly isMap?: boolean;
  readonly navigationTimeoutMs?: number;
  readonly mapSettleTimeoutMs?: number;
}): Promise<void> {
  const { page, url, theme, timeoutMs, waitMs, isMap, navigationTimeoutMs, mapSettleTimeoutMs } = options;
  page.setDefaultTimeout?.(timeoutMs);
  page.setDefaultNavigationTimeout?.(timeoutMs);

  // Emulate prefers-color-scheme explicitly before navigation so initial paint
  // and map basemap selection boot directly in the requested color scheme.
  if (page.emulateMedia) {
    try {
      await page.emulateMedia({ colorScheme: theme });
    } catch {
      // Context colorScheme still applies when page-level emulateMedia is unavailable.
    }
  }

  const navTimeout = navigationTimeoutMs ?? (isMap ? Math.min(timeoutMs, 10_000) : timeoutMs);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: navTimeout });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(navTimeout, 10_000) });
  }

  // Apply data-theme only if the site already declares a data-theme attribute on <html>,
  // while colorScheme emulation handles prefers-color-scheme automatically.
  try {
    await page.evaluate(theme === 'dark' ? APPLY_DARK_THEME_EXPR : APPLY_LIGHT_THEME_EXPR);
  } catch {
    // Non-fatal if document evaluation fails on error page.
  }

  // Bounded font readiness wait (never hangs indefinitely).
  try {
    await withTimeout(
      page.evaluate(
        `(() => (document.fonts && 'ready' in document.fonts ? document.fonts.ready.then(() => true) : true))()`
      ),
      Math.min(2_000, timeoutMs),
      'document.fonts.ready'
    );
  } catch {
    // Continue even if webfont load timed out.
  }

  // Wait for Kinloom SPA loading shell to disappear if present.
  try {
    await page.waitForSelector('[class*="archive-loading-shell"]', {
      state: 'hidden',
      timeout: Math.min(4_000, timeoutMs),
    });
  } catch {
    // Loading shell either absent or still visible; proceed to capture what rendered.
  }

  if (isMap) {
    const settleBudgetMs = Math.min(mapSettleTimeoutMs ?? 4_000, timeoutMs);
    try {
      await page.waitForSelector('[data-map-playback-bar="true"], [class*="map-bottom-dock"], canvas', {
        state: 'visible',
        timeout: settleBudgetMs,
      });
    } catch {
      // Map canvas or controls may not render in software headless mode; continue without hanging.
    }
    const tilePollMs = Math.max(100, Math.min(1_500, settleBudgetMs));
    try {
      await withTimeout(
        page.evaluate(`(() => new Promise((resolve) => {
          const deadline = Date.now() + ${tilePollMs};
          const isReady = () => {
            if (document.querySelector('[class*="map-style-note"]')) return true;
            const host = document.querySelector('.map-canvas');
            const map = host && host.kinloomMigrationMap;
            if (!map) return false;
            const styleReady = typeof map.isStyleLoaded === 'function' ? map.isStyleLoaded() : true;
            const tilesReady = typeof map.areTilesLoaded === 'function' ? map.areTilesLoaded() : true;
            return Boolean(styleReady && tilesReady);
          };
          const tick = () => {
            if (isReady() || Date.now() >= deadline) {
              resolve(true);
              return;
            }
            setTimeout(tick, 75);
          };
          tick();
        }))()`),
        tilePollMs + 500,
        'map.tileSettle'
      );
    } catch {
      // Proceed with rendered paper/partial map tiles rather than blocking on remote tile servers.
    }
  }

  if (waitMs > 0) {
    await page.waitForTimeout(waitMs);
  }
}

const INSPECT_NAV_LINKS_EXPR = `(() => {
  const anchors = Array.from(document.querySelectorAll('header a[href], nav a[href], footer a[href]'));
  return anchors.map((anchor) => ({
    href: anchor.getAttribute('href') || '',
    text: (anchor.textContent || '').trim(),
  }));
})()`;

const INSPECT_PLUGIN_SLOTS_EXPR = `(() => {
  const nodes = Array.from(document.querySelectorAll('[data-kinloom-plugin-slot], [data-plugin-id], [data-slot]'));
  const found = [];
  const seen = new Set();
  for (const el of nodes) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const pluginIdAttr = el.getAttribute('data-plugin-id');
    const slotAttr = el.getAttribute('data-kinloom-plugin-slot') || el.getAttribute('data-slot');
    const parentEl = el.closest('[data-slot]');
    const parentSlot = parentEl ? parentEl.getAttribute('data-slot') : null;
    const slotName = slotAttr || parentSlot || 'slot';
    const pluginId = pluginIdAttr || slotName;
    const selector = pluginIdAttr
      ? '[data-plugin-id="' + pluginIdAttr.replace(/"/g, '\\\\"') + '"]'
      : slotAttr
        ? '[data-slot="' + slotAttr.replace(/"/g, '\\\\"') + '"]'
        : '[data-kinloom-plugin-slot]';
    const key = pluginId + ':' + slotName;
    if (!seen.has(key)) {
      seen.add(key);
      found.push({ pluginId, slotName, selector });
    }
  }
  return found;
})()`;

const INSPECT_THEME_SURFACE_EXPR = `(() => {
  const root = document.documentElement;
  const body = document.body;
  const rootStyle = root ? getComputedStyle(root) : null;
  const bodyStyle = body ? getComputedStyle(body) : null;
  const rawBodyBg = bodyStyle ? bodyStyle.backgroundColor : '';
  const isTransparent = !rawBodyBg || rawBodyBg === 'transparent' || rawBodyBg === 'rgba(0, 0, 0, 0)';
  const surfaceToken = rootStyle ? rootStyle.getPropertyValue('--surface-canvas').trim() : '';
  const backgroundColor = !isTransparent
    ? rawBodyBg
    : (rootStyle && rootStyle.backgroundColor && rootStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? rootStyle.backgroundColor
        : surfaceToken || null);
  const textColor = (bodyStyle && bodyStyle.color) || (rootStyle && rootStyle.color) || null;
  const dataTheme = root ? root.getAttribute('data-theme') : null;
  const colorScheme = rootStyle ? rootStyle.colorScheme || null : null;
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? Boolean(window.matchMedia('(prefers-color-scheme: dark)').matches)
      : null;
  return { backgroundColor, textColor, dataTheme, colorScheme, prefersDark };
})()`;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function inspectThemeSurface(page: ScreenshotPageHandle): Promise<RawThemeSurfaceProbe | null> {
  try {
    const raw: unknown = await page.evaluate<unknown>(INSPECT_THEME_SURFACE_EXPR);
    if (!isPlainRecord(raw)) {
      return null;
    }
    const backgroundColor =
      typeof raw.backgroundColor === 'string' ? raw.backgroundColor.trim() || null : null;
    const textColor = typeof raw.textColor === 'string' ? raw.textColor.trim() || null : null;
    const dataTheme = typeof raw.dataTheme === 'string' ? raw.dataTheme.trim() || null : null;
    const colorScheme = typeof raw.colorScheme === 'string' ? raw.colorScheme.trim() || null : null;
    const prefersDark = typeof raw.prefersDark === 'boolean' ? raw.prefersDark : null;
    if (backgroundColor === null && textColor === null && dataTheme === null && prefersDark === null) {
      return null;
    }
    return { backgroundColor, textColor, dataTheme, colorScheme, prefersDark };
  } catch {
    return null;
  }
}

export async function inspectLiveNavLinks(page: ScreenshotPageHandle): Promise<readonly DiscoveredNavLink[]> {
  try {
    return await page.evaluate<DiscoveredNavLink[]>(INSPECT_NAV_LINKS_EXPR);
  } catch {
    return [];
  }
}

export async function inspectVisiblePluginSlots(
  page: ScreenshotPageHandle,
  route: string
): Promise<readonly DiscoveredPluginSlot[]> {
  try {
    const rawSlots =
      await page.evaluate<
        Array<{ readonly pluginId: string; readonly slotName: string; readonly selector: string }>
      >(INSPECT_PLUGIN_SLOTS_EXPR);
    return rawSlots.map((slot) => ({ ...slot, route }));
  } catch {
    return [];
  }
}
