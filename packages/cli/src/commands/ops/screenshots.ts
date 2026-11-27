import fs from 'node:fs/promises';
import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import { defaultScreenshotBrowserFactory, safeCloseHandle } from './screenshots/browser.js';
import { buildComponentCaptureTargets } from './screenshots/components.js';
import {
  buildPageCaptureTargets,
  buildPluginCaptureTargets,
  fetchArchiveBundleForDiscovery,
} from './screenshots/discovery.js';
import {
  buildAuthRequestHeaders,
  DEFAULT_CONCURRENCY,
  DEFAULT_INCLUDE,
  DEFAULT_OUT_DIR,
  DEFAULT_SAMPLE_PEOPLE,
  DEFAULT_SAMPLE_PLACES,
  DEFAULT_THEMES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORTS,
  DEFAULT_WAIT_MS,
  MAX_CONCURRENCY,
  normalizeRoutePath,
  parseAuthCookieSpecs,
  validateTargetBaseUrl,
} from './screenshots/parse.js';
import {
  buildScreenshotsManifest,
  formatScreenshotsTextReport,
  renderContactSheetHtml,
} from './screenshots/report.js';
import {
  discoverLiveDomMetadata,
  openConfiguredContext,
  type ResolvedScreenshotRunConfig,
  runSingleCapture,
  runWithBoundedConcurrency,
} from './screenshots/runner.js';
import type {
  CaptureTarget,
  ManifestCaptureEntry,
  ScreenshotsCommandOptions,
  ScreenshotsCommandResult,
  ScreenshotTheme,
  ViewportSpec,
} from './screenshots/types.js';

export { SCREENSHOTS_HELP } from './help.js';
export * from './screenshots/browser.js';
export * from './screenshots/components.js';
export * from './screenshots/discovery.js';
export * from './screenshots/parse.js';
export * from './screenshots/report.js';
export type * from './screenshots/types.js';

function resolveRunConfig(options: ScreenshotsCommandOptions): ResolvedScreenshotRunConfig {
  const targetUrl = validateTargetBaseUrl(options.url);
  const viewports = options.viewports && options.viewports.length > 0 ? options.viewports : DEFAULT_VIEWPORTS;
  const themes = options.themes && options.themes.length > 0 ? options.themes : DEFAULT_THEMES;
  const include = options.include && options.include.length > 0 ? options.include : DEFAULT_INCLUDE;
  const samplePeople = options.samplePeople ?? DEFAULT_SAMPLE_PEOPLE;
  const samplePlaces = options.samplePlaces ?? DEFAULT_SAMPLE_PLACES;
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  if (!Number.isInteger(samplePeople) || samplePeople < 0 || samplePeople > 20) {
    throw new CliValidationError('Option `--sample-people` must be an integer between 0 and 20.');
  }
  if (!Number.isInteger(samplePlaces) || samplePlaces < 0 || samplePlaces > 20) {
    throw new CliValidationError('Option `--sample-places` must be an integer between 0 and 20.');
  }
  if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30_000) {
    throw new CliValidationError('Option `--wait-ms` must be between 0 and 30000.');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 120_000) {
    throw new CliValidationError('Option `--timeout-ms` must be between 500 and 120000.');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new CliValidationError(`Option \`--concurrency\` must be between 1 and ${MAX_CONCURRENCY}.`);
  }

  const authHeaders = options.authHeaders ?? [];
  const authCookie = options.authCookie?.trim() || undefined;
  const cookieSpecs = authCookie ? parseAuthCookieSpecs(authCookie, targetUrl) : [];
  const extraHeaders = buildAuthRequestHeaders({ authCookie, authHeaders });

  return {
    targetUrl,
    outDir: path.resolve(options.outDir?.trim() || DEFAULT_OUT_DIR),
    viewports,
    themes,
    include,
    explicitRoutes: (options.routes ?? []).map(normalizeRoutePath),
    explicitPluginRoutes: (options.pluginRoutes ?? []).map(normalizeRoutePath),
    samplePeople,
    samplePlaces,
    authCookie,
    authHeaders,
    cookieSpecs,
    extraHeaders,
    fullPage: options.fullPage ?? true,
    waitMs,
    timeoutMs,
    concurrency,
    json: options.json ?? false,
  };
}

export async function runScreenshotsCommand(
  options: ScreenshotsCommandOptions
): Promise<ScreenshotsCommandResult> {
  const config = resolveRunConfig(options);
  const secrets = [
    ...(config.authCookie ? [config.authCookie] : []),
    ...config.authHeaders.map((header) => header.value),
  ];

  const bundleDiscovery = await fetchArchiveBundleForDiscovery({
    baseUrl: config.targetUrl,
    samplePeople: config.samplePeople,
    samplePlaces: config.samplePlaces,
    authCookie: config.authCookie,
    authHeaders: config.authHeaders,
    timeoutMs: config.timeoutMs,
    fetchImpl: options.fetchImpl,
  });

  const browserFactory = options.browserFactory ?? defaultScreenshotBrowserFactory;
  const browser = await browserFactory({
    timeoutMs: config.timeoutMs,
    env: options.env ?? process.env,
  });

  let allCaptures: ManifestCaptureEntry[] = [];
  try {
    const liveDom = await discoverLiveDomMetadata(browser, config, bundleDiscovery);

    const targets: CaptureTarget[] = [];
    if (config.include.includes('pages')) {
      targets.push(
        ...buildPageCaptureTargets({
          discovery: bundleDiscovery,
          navExtraCoreRoutes: liveDom.navExtraCoreRoutes,
          explicitRoutes: config.explicitRoutes,
        })
      );
    }
    if (config.include.includes('components')) {
      targets.push(...buildComponentCaptureTargets(bundleDiscovery));
    }
    if (config.include.includes('plugins')) {
      targets.push(
        ...buildPluginCaptureTargets({
          discoveredPluginRoutes: liveDom.discoveredPluginRoutes,
          explicitPluginRoutes: config.explicitPluginRoutes,
          discoveredSlots: liveDom.discoveredSlots,
        })
      );
    }

    const searchQuery = bundleDiscovery.people[0]?.searchTerm ?? bundleDiscovery.places[0]?.name ?? 'archive';

    const matrix: Array<{ readonly viewport: ViewportSpec; readonly theme: ScreenshotTheme }> = [];
    for (const viewport of config.viewports) {
      for (const theme of config.themes) {
        matrix.push({ viewport, theme });
      }
    }

    const perCellResults = await runWithBoundedConcurrency(
      matrix,
      config.concurrency,
      async ({ viewport, theme }) => {
        const context = await openConfiguredContext(browser, viewport, theme, config);
        const entries: ManifestCaptureEntry[] = [];
        try {
          for (const target of targets) {
            const entry = await runSingleCapture({
              context,
              target,
              viewport,
              theme,
              config,
              searchQuery,
              secrets,
            });
            entries.push(entry);
          }
          return entries;
        } finally {
          await safeCloseHandle(context, 'capture.context.close', 3_000);
        }
      }
    );

    const ordered: ManifestCaptureEntry[] = [];
    for (let tIdx = 0; tIdx < targets.length; tIdx += 1) {
      for (const cellEntries of perCellResults) {
        const entry = cellEntries[tIdx];
        if (entry) {
          ordered.push(entry);
        }
      }
    }
    allCaptures = ordered;
  } finally {
    await safeCloseHandle(browser, 'screenshots.browser.close', 5_000);
  }

  await fs.mkdir(config.outDir, { recursive: true });
  const generatedAt = (options.now ? options.now() : new Date()).toISOString();
  const manifest = buildScreenshotsManifest({
    targetUrl: config.targetUrl,
    generatedAt,
    viewports: config.viewports,
    themes: config.themes,
    include: config.include,
    captures: allCaptures,
  });

  const manifestPath = path.join(config.outDir, 'manifest.json');
  const indexHtmlPath = path.join(config.outDir, 'index.html');
  await Promise.all([
    fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
    fs.writeFile(indexHtmlPath, renderContactSheetHtml(manifest), 'utf8'),
  ]);

  const baseResult: Omit<ScreenshotsCommandResult, 'rendered'> = {
    ok: manifest.summary.failed === 0,
    outDir: config.outDir,
    manifestPath,
    indexHtmlPath,
    manifest,
  };
  const rendered = config.json
    ? JSON.stringify(
        {
          ok: baseResult.ok,
          outDir: baseResult.outDir,
          manifestPath: baseResult.manifestPath,
          indexHtmlPath: baseResult.indexHtmlPath,
          summary: manifest.summary,
          manifest,
        },
        null,
        2
      )
    : formatScreenshotsTextReport(baseResult);

  return { ...baseResult, rendered };
}
