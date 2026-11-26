import fs from 'node:fs';
import path from 'node:path';
import { RecordRuntimeError } from './types.js';

export interface OptionalBrowserPage {
  goto(
    url: string,
    options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }
  ): Promise<unknown>;
  content(): Promise<string>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  close(): Promise<void>;
}

export interface OptionalBrowserContext {
  newPage(): Promise<OptionalBrowserPage>;
  close(): Promise<void>;
}

export interface OptionalBrowser {
  newContext(options?: { userAgent?: string }): Promise<OptionalBrowserContext>;
  close(): Promise<void>;
}

interface PlaywrightCoreModule {
  chromium: {
    launch(options?: {
      headless?: boolean;
      executablePath?: string;
      args?: string[];
    }): Promise<OptionalBrowser>;
  };
}

const DEFAULT_BROWSER_NAMES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
];

export function findSystemChromium(
  env: NodeJS.ProcessEnv,
  overrideEnvVar?: string
): string | undefined {
  if (overrideEnvVar) {
    const override = env[overrideEnvVar]?.trim();
    if (override) {
      return override;
    }
  }
  const pathVar = env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const candidate of DEFAULT_BROWSER_NAMES) {
      const fullPath = path.join(dir, candidate);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          return fullPath;
        }
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined;
}

export async function launchOptionalChromium(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly overrideEnvVar?: string;
}): Promise<OptionalBrowser> {
  let playwrightMod: PlaywrightCoreModule;
  try {
    const moduleName = 'playwright-core';
    playwrightMod = (await import(moduleName)) as PlaywrightCoreModule;
  } catch {
    throw new RecordRuntimeError(
      'Browser fallback requires the optional `playwright-core` package (`npm install -g playwright-core` or install alongside `@kinloom/cli`).'
    );
  }

  const executablePath = findSystemChromium(options.env, options.overrideEnvVar);
  return playwrightMod.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--disable-blink-features=AutomationControlled'],
  });
}
