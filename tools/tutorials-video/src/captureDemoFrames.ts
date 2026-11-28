import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TutorialScript, TutorialScriptStep } from './schema.ts';

export interface CapturedFrameArtifact {
  readonly name: string;
  readonly filePath: string;
  readonly sha256: string;
}

export interface CaptureStepFramesOptions {
  readonly script: TutorialScript;
  readonly step: TutorialScriptStep;
  readonly demoUrl: string;
  readonly cacheDir: string;
  readonly dryRun?: boolean;
}

export const SYNTHETIC_CAPTURE_EMAILS: Readonly<Record<'editor' | 'admin', string>> = {
  editor: 'editor@archive.example.test',
  admin: 'admin@archive.example.test',
};

export function resolveCaptureRouteUrl(demoUrl: string, demoRoute: string): string {
  const normalizedBase = demoUrl.replace(/\/+$/, '');
  return `${normalizedBase}${demoRoute.startsWith('/') ? demoRoute : `/${demoRoute}`}`;
}

/**
 * Captures deterministic 2x PNG frames against the public-domain Lincoln & Todd demo archive
 * (or a local synthetic test server seeded strictly with Lincoln/Todd data for editor/admin chapters).
 */
export async function captureDemoFramesForStep(
  options: CaptureStepFramesOptions
): Promise<readonly CapturedFrameArtifact[]> {
  const { script, step, demoUrl, cacheDir, dryRun = false } = options;
  const stepDir = path.join(cacheDir, script.chapterId);
  const screenshotActions = step.captureActions.filter((action) => action.kind === 'screenshot');

  if (dryRun) {
    return screenshotActions.map((action) => ({
      name: action.name,
      filePath: path.join(stepDir, `${step.stepId}-${action.name}.png`),
      sha256: createHash('sha256')
        .update(`${script.chapterId}:${step.stepId}:${action.name}:${step.demoRoute}`)
        .digest('hex'),
    }));
  }

  fs.mkdirSync(stepDir, { recursive: true });
  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: step.viewport,
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
      locale: 'en-US',
      colorScheme: step.theme,
      ...(step.authRole === 'editor' || step.authRole === 'admin'
        ? { extraHTTPHeaders: { 'x-kinloom-tutorial-actor': SYNTHETIC_CAPTURE_EMAILS[step.authRole] } }
        : {}),
    });
    const page = await context.newPage();
    const targetUrl = resolveCaptureRouteUrl(demoUrl, step.demoRoute);
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    const captured: CapturedFrameArtifact[] = [];
    for (const action of step.captureActions) {
      if (action.kind === 'waitForSelector') {
        await page.waitForSelector(action.selector, { timeout: 10_000 });
      } else if (action.kind === 'click') {
        await page.click(action.selector);
      } else if (action.kind === 'screenshot') {
        const outFile = path.join(stepDir, `${step.stepId}-${action.name}.png`);
        const bytes = await page.screenshot({ path: outFile, fullPage: false });
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        captured.push({ name: action.name, filePath: outFile, sha256 });
      }
    }

    await context.close();
    return captured;
  } finally {
    await browser.close();
  }
}
