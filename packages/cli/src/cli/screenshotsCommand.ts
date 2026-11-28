import path from 'node:path';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import {
  type CliDispatchContext,
  parseOptionalPositiveInt,
  requireStringFlag,
  safeParseArgs,
  writeRenderedOutput,
} from './types.js';

function parseOptionalNonNegativeInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    throw new CliValidationError(`Option \`${flagName}\` must be a non-negative integer.`);
  }
  return parsed;
}

export async function runScreenshots(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      repo: { type: 'string' },
      'out-dir': { type: 'string' },
      viewports: { type: 'string' },
      themes: { type: 'string' },
      include: { type: 'string' },
      routes: { type: 'string', multiple: true },
      'plugin-routes': { type: 'string', multiple: true },
      'sample-people': { type: 'string' },
      'sample-places': { type: 'string' },
      'auth-cookie': { type: 'string' },
      'auth-header': { type: 'string', multiple: true },
      'with-temp-auth': { type: 'boolean', default: false },
      'full-page': { type: 'boolean', default: false },
      'no-full-page': { type: 'boolean', default: false },
      'wait-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      concurrency: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  if (values['full-page'] && values['no-full-page']) {
    throw new CliValidationError('Specify either `--full-page` or `--no-full-page`, not both.');
  }
  if (values['with-temp-auth'] && values['auth-cookie']?.trim()) {
    throw new CliValidationError('Specify either `--auth-cookie` or `--with-temp-auth`, not both.');
  }

  const url = values['with-temp-auth'] ? values.url?.trim() : requireStringFlag(values.url, '--url');
  const [
    {
      parseAuthHeader,
      parseIncludeOption,
      parseRouteList,
      parseThemesOption,
      parseViewportsOption,
      runScreenshotsCommand,
    },
    { measureCommand },
  ] = await Promise.all([import('../commands/ops/screenshots.js'), import('../commands/ops/telemetry.js')]);

  const outDir = values['out-dir']
    ? path.resolve(ctx.cwd, values['out-dir'])
    : path.resolve(ctx.cwd, 'kinloom-screenshots');

  const viewports = values.viewports ? parseViewportsOption(values.viewports) : undefined;
  const themes = values.themes ? parseThemesOption(values.themes) : undefined;
  const include = values.include ? parseIncludeOption(values.include) : undefined;
  const routes = values.routes ? parseRouteList(values.routes) : undefined;
  const pluginRoutes = values['plugin-routes'] ? parseRouteList(values['plugin-routes']) : undefined;
  const authHeaders = values['auth-header'] ? values['auth-header'].map(parseAuthHeader) : undefined;
  const samplePeople = parseOptionalNonNegativeInt(values['sample-people'], '--sample-people');
  const samplePlaces = parseOptionalNonNegativeInt(values['sample-places'], '--sample-places');
  const waitMs = parseOptionalNonNegativeInt(values['wait-ms'], '--wait-ms');
  const timeoutMs = parseOptionalPositiveInt(values['timeout-ms'], '--timeout-ms');
  const concurrency = parseOptionalPositiveInt(values.concurrency, '--concurrency');
  const fullPage = !values['no-full-page'];

  const result = await measureCommand(
    {
      subcmd: 'screenshots',
      extractResultMeta: (res) => ({
        exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runScreenshotsCommand({
        url,
        outDir,
        viewports,
        themes,
        include,
        routes,
        pluginRoutes,
        samplePeople,
        samplePlaces,
        authCookie: values['auth-cookie'],
        authHeaders,
        withTempAuth: values['with-temp-auth'],
        repoDir: values.repo ? path.resolve(ctx.cwd, values.repo) : ctx.cwd,
        execWrangler: ctx.execWrangler,
        fullPage,
        waitMs,
        timeoutMs,
        concurrency,
        json: values.json,
        fetchImpl: ctx.fetchImpl,
        browserFactory: ctx.screenshotBrowserFactory,
      })
  );

  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}
