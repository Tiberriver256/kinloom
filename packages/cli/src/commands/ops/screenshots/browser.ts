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

interface PlaywrightLaunchModule {
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

async function loadPlaywrightModule(): Promise<PlaywrightLaunchModule> {
  const candidates = ['playwright-core', 'playwright'] as const;
  for (const name of candidates) {
    try {
      const mod = (await import(name)) as PlaywrightLaunchModule;
      if (mod?.chromium && typeof mod.chromium.launch === 'function') {
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

export const defaultScreenshotBrowserFactory: ScreenshotBrowserFactory = async ({ timeoutMs, env }) => {
  const playwrightMod = await loadPlaywrightModule();
  let bundledPath: string | undefined;
  try {
    bundledPath = playwrightMod.chromium.executablePath?.();
  } catch {
    bundledPath = undefined;
  }
  const resolved = resolveScreenshotChromiumPath({
    env,
    playwrightExecutablePath: bundledPath,
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

export async function navigateAndSettlePage(options: {
  readonly page: ScreenshotPageHandle;
  readonly url: string;
  readonly theme: ScreenshotTheme;
  readonly timeoutMs: number;
  readonly waitMs: number;
  readonly isMap?: boolean;
}): Promise<void> {
  const { page, url, theme, timeoutMs, waitMs, isMap } = options;
  page.setDefaultTimeout?.(timeoutMs);
  page.setDefaultNavigationTimeout?.(timeoutMs);

  try {
    await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
  } catch {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 10_000) });
  }

  // Apply data-theme only if the site already declares a data-theme attribute on <html>,
  // while colorScheme emulation handles prefers-color-scheme automatically.
  try {
    await page.evaluate(
      `(() => { const root = document.documentElement; if (root && root.hasAttribute('data-theme')) { root.setAttribute('data-theme', ${JSON.stringify(theme)}); } })()`
    );
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
    try {
      await page.waitForSelector('canvas', {
        state: 'visible',
        timeout: Math.min(3_000, timeoutMs),
      });
    } catch {
      // Map canvas may not render in headless software mode; continue without hanging.
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
