import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordRuntimeError } from './types.js';

export const DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS = 20_000;
export const DEFAULT_BROWSER_TOTAL_TIMEOUT_MS = 60_000;
export const DEFAULT_BROWSER_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_BROWSER_KILL_GRACE_MS = 500;

export interface OptionalBrowserProcess {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly killed?: boolean;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface OptionalBrowserPage {
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number | undefined }
  ): Promise<unknown>;
  content(): Promise<string>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  close(): Promise<void>;
  waitForFunction?(
    pageFunction: string,
    arg?: unknown,
    options?: { timeout?: number | undefined }
  ): Promise<unknown>;
  waitForTimeout?(timeout: number): Promise<void>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
}

export interface OptionalBrowserContext {
  newPage(): Promise<OptionalBrowserPage>;
  close(): Promise<void>;
  setDefaultTimeout?(timeout: number): void;
  setDefaultNavigationTimeout?(timeout: number): void;
}

export interface OptionalBrowser {
  newContext(options?: { userAgent?: string }): Promise<OptionalBrowserContext>;
  close(): Promise<void>;
  process?(): OptionalBrowserProcess | null | undefined;
}

export interface PlaywrightCoreModule {
  readonly chromium: {
    executablePath?(): string;
    launch(options?: {
      headless?: boolean;
      executablePath?: string | undefined;
      args?: string[];
      timeout?: number | undefined;
      env?: Record<string, string> | undefined;
    }): Promise<OptionalBrowser>;
  };
}

export type BrowserExecutableResolution =
  | { readonly kind: 'override'; readonly executablePath: string; readonly envVar: string }
  | { readonly kind: 'playwright-bundled'; readonly executablePath: string }
  | { readonly kind: 'system-binary'; readonly executablePath: string }
  | { readonly kind: 'playwright-default' };

export class BrowserTimeoutError extends RecordRuntimeError {
  readonly phase: string;
  readonly timeoutMs: number;

  constructor(phase: string, timeoutMs: number, detail?: string) {
    const base = `Browser timed out after ${timeoutMs}ms during ${phase}`;
    super(detail ? `${base}: ${detail}` : `${base}.`, 1);
    this.name = 'BrowserTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export type ChromiumLauncher = (options: {
  readonly env: NodeJS.ProcessEnv;
  readonly overrideEnvVar?: string | undefined;
  readonly launchTimeoutMs?: number;
}) => Promise<OptionalBrowser>;

export interface LaunchOptionalChromiumOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly overrideEnvVar?: string | undefined;
  readonly launchTimeoutMs?: number;
  readonly closeTimeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
  readonly loadPlaywright?: () => Promise<PlaywrightCoreModule>;
  readonly isExecutable?: ((filePath: string) => boolean) | undefined;
}

export interface BrowserSession {
  readonly browser: OptionalBrowser;
  readonly context: OptionalBrowserContext;
  readonly page: OptionalBrowserPage;
  readonly deadlineMs: number;
  remainingMs(): number;
  runStep<R>(phase: string, task: (stepTimeoutMs: number) => Promise<R>, maxStepMs?: number): Promise<R>;
}

export interface RunWithBrowserSessionOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly overrideEnvVar?: string | undefined;
  readonly userAgent?: string | undefined;
  readonly totalTimeoutMs?: number | undefined;
  readonly launchTimeoutMs?: number | undefined;
  readonly closeTimeoutMs?: number | undefined;
  readonly killGraceMs?: number | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly launcher?: ChromiumLauncher | undefined;
}

const DIRECT_SYSTEM_CHROMIUM_PATHS = [
  '/usr/lib/chromium/chromium',
  '/usr/lib/chromium-browser/chromium-browser',
];

const DEFAULT_BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

const DESKTOP_ENV_VARS_TO_STRIP = [
  'WAYLAND_DISPLAY',
  'GTK_USE_PORTAL',
  'ELECTRON_OZONE_PLATFORM_HINT',
  'CHROMIUM_USER_FLAGS',
  'CHROME_USER_FLAGS',
] as const;

const BASE_HEADLESS_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
] as const;

const SYSTEM_FALLBACK_EXTRA_ARGS = ['--password-store=basic', '--ozone-platform=headless'] as const;

export function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function findDirectSystemChromium(isExecutable: (filePath: string) => boolean): string | undefined {
  for (const candidate of DIRECT_SYSTEM_CHROMIUM_PATHS) {
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function findPathSystemChromium(
  env: NodeJS.ProcessEnv,
  isExecutable: (filePath: string) => boolean
): string | undefined {
  const pathVar = env['PATH'] ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const candidate of DEFAULT_BROWSER_NAMES) {
      const fullPath = path.join(dir, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

export function findSystemChromium(
  env: NodeJS.ProcessEnv,
  overrideEnvVar?: string,
  isExecutable: (filePath: string) => boolean = isExecutableFile
): string | undefined {
  if (overrideEnvVar) {
    const override = env[overrideEnvVar]?.trim();
    if (override && isExecutable(override)) {
      return override;
    }
  }
  return findDirectSystemChromium(isExecutable) ?? findPathSystemChromium(env, isExecutable);
}

export function resolveChromiumExecutable(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly overrideEnvVar?: string | undefined;
  readonly playwrightExecutablePath?: string | undefined;
  readonly isExecutable?: ((filePath: string) => boolean) | undefined;
}): BrowserExecutableResolution {
  const isExecutable = options.isExecutable ?? isExecutableFile;

  if (options.overrideEnvVar) {
    const override = options.env[options.overrideEnvVar]?.trim();
    if (override && isExecutable(override)) {
      return { kind: 'override', executablePath: override, envVar: options.overrideEnvVar };
    }
  }

  const bundled = options.playwrightExecutablePath?.trim();
  if (bundled && isExecutable(bundled)) {
    return { kind: 'playwright-bundled', executablePath: bundled };
  }

  const systemBinary =
    findDirectSystemChromium(isExecutable) ?? findPathSystemChromium(options.env, isExecutable);
  if (systemBinary) {
    return { kind: 'system-binary', executablePath: systemBinary };
  }

  return { kind: 'playwright-default' };
}

export function buildSanitizedBrowserEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  for (const key of DESKTOP_ENV_VARS_TO_STRIP) {
    delete cleaned[key];
  }
  // Prevent Arch/Omarchy /usr/bin/chromium wrappers from reading ~/.config/chromium-flags.conf.
  cleaned['XDG_CONFIG_HOME'] = path.join(os.tmpdir(), 'kinloom-headless-xdg-config');
  return cleaned;
}

export function withBrowserDeadline<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  const effectiveTimeoutMs = Math.max(0, Math.floor(timeoutMs));
  if (effectiveTimeoutMs <= 0) {
    promise.catch(() => {});
    return Promise.reject(new BrowserTimeoutError(phase, 0));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      promise.catch(() => {});
      reject(new BrowserTimeoutError(phase, effectiveTimeoutMs));
    }, effectiveTimeoutMs);
    timer.unref?.();

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function isBrowserProcessAlive(proc: OptionalBrowserProcess): boolean {
  if (proc.exitCode !== null && proc.exitCode !== undefined) {
    return false;
  }
  if (proc.signalCode !== null && proc.signalCode !== undefined) {
    return false;
  }
  return true;
}

function sleepUnref(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function forceTerminateBrowserProcess(
  proc: OptionalBrowserProcess | null | undefined,
  graceMs = DEFAULT_BROWSER_KILL_GRACE_MS
): Promise<void> {
  if (!proc || !isBrowserProcessAlive(proc)) {
    return;
  }
  try {
    proc.kill('SIGTERM');
  } catch {
    return;
  }
  if (!isBrowserProcessAlive(proc)) {
    return;
  }
  await sleepUnref(Math.max(0, graceMs));
  if (!isBrowserProcessAlive(proc)) {
    return;
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    // Process already exited between check and SIGKILL.
  }
}

export async function safeCloseBrowser(
  handles: {
    readonly page?: OptionalBrowserPage | undefined;
    readonly context?: OptionalBrowserContext | undefined;
    readonly browser?: OptionalBrowser | undefined;
  },
  options: {
    readonly closeTimeoutMs?: number | undefined;
    readonly killGraceMs?: number | undefined;
  } = {}
): Promise<void> {
  const closeTimeoutMs = Math.max(1, options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS);
  const killGraceMs = Math.max(0, options.killGraceMs ?? DEFAULT_BROWSER_KILL_GRACE_MS);
  const deadline = Date.now() + closeTimeoutMs;
  const stepSlice = Math.max(1, Math.floor(closeTimeoutMs / 3));
  let timedOutOrFailed = false;

  const remaining = (): number => Math.max(1, deadline - Date.now());

  if (handles.page) {
    try {
      await withBrowserDeadline(handles.page.close(), Math.min(remaining(), stepSlice), 'page.close');
    } catch {
      timedOutOrFailed = true;
    }
  }

  if (handles.context) {
    try {
      await withBrowserDeadline(handles.context.close(), Math.min(remaining(), stepSlice), 'context.close');
    } catch {
      timedOutOrFailed = true;
    }
  }

  if (handles.browser) {
    try {
      await withBrowserDeadline(handles.browser.close(), remaining(), 'browser.close');
    } catch {
      timedOutOrFailed = true;
    }
    const proc = handles.browser.process?.();
    if (timedOutOrFailed || (proc && isBrowserProcessAlive(proc))) {
      await forceTerminateBrowserProcess(proc, killGraceMs);
    }
  }
}

async function defaultLoadPlaywright(): Promise<PlaywrightCoreModule> {
  const moduleName = 'playwright-core';
  return (await import(moduleName)) as PlaywrightCoreModule;
}

export async function launchOptionalChromium(
  options: LaunchOptionalChromiumOptions
): Promise<OptionalBrowser> {
  let playwrightMod: PlaywrightCoreModule;
  try {
    const loader = options.loadPlaywright ?? defaultLoadPlaywright;
    playwrightMod = await loader();
  } catch {
    throw new RecordRuntimeError(
      'Browser fallback requires the optional `playwright-core` package (`npm install -g playwright-core` or install alongside `@kinloom/cli`).'
    );
  }

  let playwrightExecutablePath: string | undefined;
  try {
    playwrightExecutablePath = playwrightMod.chromium.executablePath?.();
  } catch {
    playwrightExecutablePath = undefined;
  }

  const resolution = resolveChromiumExecutable({
    env: options.env,
    overrideEnvVar: options.overrideEnvVar,
    playwrightExecutablePath,
    isExecutable: options.isExecutable,
  });

  const launchTimeoutMs = Math.max(
    1,
    Math.floor(options.launchTimeoutMs ?? DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS)
  );
  const usesSystemBinary = resolution.kind === 'system-binary';
  const args = usesSystemBinary
    ? [...BASE_HEADLESS_ARGS, ...SYSTEM_FALLBACK_EXTRA_ARGS]
    : [...BASE_HEADLESS_ARGS];

  const launchOptions: {
    headless: boolean;
    timeout: number;
    args: string[];
    executablePath?: string | undefined;
    env?: Record<string, string> | undefined;
  } = {
    headless: true,
    timeout: launchTimeoutMs,
    args,
  };

  if (resolution.kind === 'override' || resolution.kind === 'system-binary') {
    launchOptions.executablePath = resolution.executablePath;
  }
  if (usesSystemBinary) {
    launchOptions.env = buildSanitizedBrowserEnv(options.env);
  }

  let timedOut = false;
  const launchPromise = playwrightMod.chromium.launch(launchOptions);
  void launchPromise.then(
    (lateBrowser) => {
      if (timedOut) {
        void safeCloseBrowser(
          { browser: lateBrowser },
          {
            closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS,
            killGraceMs: options.killGraceMs ?? DEFAULT_BROWSER_KILL_GRACE_MS,
          }
        );
      }
    },
    () => {
      // Rejection is surfaced by withBrowserDeadline or suppressed after timeout.
    }
  );

  try {
    return await withBrowserDeadline(launchPromise, launchTimeoutMs, 'launch');
  } catch (err: unknown) {
    if (err instanceof BrowserTimeoutError) {
      timedOut = true;
    }
    throw err;
  }
}

export async function runWithBrowserSession<T>(
  options: RunWithBrowserSessionOptions,
  fn: (session: BrowserSession) => Promise<T>
): Promise<T> {
  const nowMs = options.nowMs ?? (() => Date.now());
  const totalTimeoutMs = Math.max(1, Math.floor(options.totalTimeoutMs ?? DEFAULT_BROWSER_TOTAL_TIMEOUT_MS));
  const closeTimeoutMs = Math.max(1, Math.floor(options.closeTimeoutMs ?? DEFAULT_BROWSER_CLOSE_TIMEOUT_MS));
  const killGraceMs = Math.max(0, Math.floor(options.killGraceMs ?? DEFAULT_BROWSER_KILL_GRACE_MS));
  const deadlineMs = nowMs() + totalTimeoutMs;
  const remainingMs = (): number => Math.max(0, deadlineMs - nowMs());

  const launcher = options.launcher ?? launchOptionalChromium;
  const requestedLaunchTimeout = options.launchTimeoutMs ?? DEFAULT_BROWSER_LAUNCH_TIMEOUT_MS;
  const effectiveLaunchTimeout = Math.min(requestedLaunchTimeout, remainingMs());

  let browser: OptionalBrowser | undefined;
  let context: OptionalBrowserContext | undefined;
  let page: OptionalBrowserPage | undefined;

  let launchTimedOut = false;
  const launchPromise = launcher({
    env: options.env,
    overrideEnvVar: options.overrideEnvVar,
    launchTimeoutMs: effectiveLaunchTimeout,
  });
  void launchPromise.then(
    (lateBrowser) => {
      if (launchTimedOut) {
        void safeCloseBrowser({ browser: lateBrowser }, { closeTimeoutMs, killGraceMs });
      }
    },
    () => {}
  );

  try {
    try {
      browser = await withBrowserDeadline(launchPromise, effectiveLaunchTimeout, 'launch');
    } catch (err: unknown) {
      if (err instanceof BrowserTimeoutError) {
        launchTimedOut = true;
      }
      throw err;
    }

    context = await withBrowserDeadline(
      browser.newContext(options.userAgent ? { userAgent: options.userAgent } : undefined),
      remainingMs(),
      'newContext'
    );
    const afterContextMs = remainingMs();
    if (afterContextMs > 0) {
      context.setDefaultTimeout?.(afterContextMs);
      context.setDefaultNavigationTimeout?.(afterContextMs);
    }

    page = await withBrowserDeadline(context.newPage(), remainingMs(), 'newPage');
    const afterPageMs = remainingMs();
    if (afterPageMs > 0) {
      page.setDefaultTimeout?.(afterPageMs);
      page.setDefaultNavigationTimeout?.(afterPageMs);
    }

    const activeBrowser = browser;
    const activeContext = context;
    const activePage = page;

    const session: BrowserSession = {
      browser: activeBrowser,
      context: activeContext,
      page: activePage,
      deadlineMs,
      remainingMs,
      async runStep<R>(
        phase: string,
        task: (stepTimeoutMs: number) => Promise<R>,
        maxStepMs?: number
      ): Promise<R> {
        const budget = remainingMs();
        const stepTimeoutMs =
          maxStepMs !== undefined ? Math.min(budget, Math.max(0, Math.floor(maxStepMs))) : budget;
        if (stepTimeoutMs <= 0) {
          throw new BrowserTimeoutError(phase, 0);
        }
        return withBrowserDeadline(task(stepTimeoutMs), stepTimeoutMs, phase);
      },
    };

    return await withBrowserDeadline(fn(session), remainingMs(), 'session');
  } finally {
    await safeCloseBrowser({ page, context, browser }, { closeTimeoutMs, killGraceMs });
  }
}
