import { parseOptionalPositiveInt, parseOptionalPositiveNumber, safeParseArgs } from '../cli/types.js';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import type {
  KinloomCheckResult,
  KinloomCliCommand,
  KinloomCliPlugin,
  KinloomCliPluginContext,
  KinloomVerifyCheck,
} from '../pluginTypes.js';
import {
  formatSyntheticProbeReport,
  parseExpectedPluginsCsv,
  resolveProbeBudgets,
  resolveProbeToken,
} from './syntheticProbeParsing.js';
import { runSyntheticProbe } from './syntheticProbeRunner.js';
import {
  DEFAULT_MEDIA_RANGE_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SYNTHETIC_PROBE_BUDGETS,
  SYNTHETIC_PROBE_COMMAND_NAME,
  SYNTHETIC_PROBE_PLUGIN_ID,
  SYNTHETIC_PROBE_VERIFY_CHECK_ID,
  type SyntheticProbeBudgets,
  type SyntheticProbePluginOptions,
} from './syntheticProbeTypes.js';

export {
  discoverFirstDeceasedPersonSlugFromBundle,
  discoverFirstMediaPathFromBundle,
  evaluateSecurityHeaders,
  formatSyntheticProbeReport,
  normalizeProbeBaseUrl,
  parseExpectedPluginsCsv,
  parseServerTimingHeader,
  resolveProbeBudgets,
  resolveProbeToken,
} from './syntheticProbeParsing.js';
export { runPluginHealthProbes } from './syntheticProbePlugins.js';
export { runSyntheticProbe } from './syntheticProbeRunner.js';
export {
  type BundleColdProbeResult,
  type BundleProbeResult,
  type BundleWarmProbeResult,
  DEFAULT_MEDIA_RANGE_BYTES,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_SYNTHETIC_PROBE_BUDGETS,
  type HtmlProbeResult,
  type MediaRangeProbeResult,
  type MediaRangeSource,
  type ParsedServerTiming,
  type PluginProbesReport,
  type RunSyntheticProbeInput,
  type SecurityHeaderCheckResult,
  type ServerTimingSpanName,
  type SinglePluginProbeResult,
  type SinglePluginProbeStatus,
  SYNTHETIC_PROBE_COMMAND_NAME,
  SYNTHETIC_PROBE_PLUGIN_ID,
  SYNTHETIC_PROBE_VERIFY_CHECK_ID,
  type SyntheticProbeBudgets,
  type SyntheticProbeClock,
  type SyntheticProbePluginOptions,
  type SyntheticProbeReport,
} from './syntheticProbeTypes.js';

export const SYNTHETIC_PROBE_HELP = `Usage: kinloom probe --url <baseUrl> [options]

Measure HTML TTFB and security headers, /api/bundle cold vs conditional 304 latency,
RFC Server-Timing spans, R2 media HTTP 206 byte-range delivery, and optional live plugin
health checks against a Kinloom archive.

Options:
  --url <baseUrl>                 Target archive base URL (or KINLOOM_PROBE_URL / plugin targetUrl)
  --media-path <path>             Explicit same-origin media path for the 206 Range probe
  --media-range-bytes <bytes>     Leading byte count for the Range probe (default: ${DEFAULT_MEDIA_RANGE_BYTES})
  --token <secret>                Bearer token (defaults to KINLOOM_PROBE_TOKEN, KINLOOM_TOKEN, or KINLOOM_AGENT_TOKEN)
  --plugins                       Run live plugin health checks and private-archive leak guard
  --expect-plugins <csv>          Comma-separated server plugin IDs required to be active (implies --plugins)
  --timeout-ms <ms>               Per-request timeout in ms (default: ${DEFAULT_PROBE_TIMEOUT_MS})
  --max-html-ttfb-ms <ms>         HTML root TTFB budget in ms (default: ${DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxHtmlTtfbMs})
  --max-bundle-cold-ms <ms>       /api/bundle cold fetch budget in ms (default: ${DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxBundleColdMs})
  --max-bundle-warm-ms <ms>       /api/bundle 304 conditional fetch budget in ms (default: ${DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxBundleWarmMs})
  --max-media-range-ms <ms>       Media 206 Range fetch budget in ms (default: ${DEFAULT_SYNTHETIC_PROBE_BUDGETS.maxMediaRangeMs})
  --no-require-304                Do not fail when /api/bundle omits ETag or skips 304 Not Modified
  --no-require-206                Do not fail when media probe returns 200 instead of 206 Partial Content
  --no-require-security-headers   Do not fail when baseline security headers are missing
  --json                          Emit machine-readable JSON report
  -h, --help                      Show this help message`;

function parseProbeCommandArgs(
  args: readonly string[],
  pluginOptions: SyntheticProbePluginOptions
): {
  readonly targetUrl: string;
  readonly mediaPath?: string;
  readonly mediaPathSource?: 'flag' | 'option';
  readonly mediaRangeBytes: number;
  readonly token?: string;
  readonly timeoutMs: number;
  readonly budgets: SyntheticProbeBudgets;
  readonly checkPlugins: boolean;
  readonly expectPlugins: readonly string[];
  readonly json: boolean;
} {
  const { values } = safeParseArgs({
    args,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      'media-path': { type: 'string' },
      'media-range-bytes': { type: 'string' },
      token: { type: 'string' },
      plugins: { type: 'boolean', default: false },
      'expect-plugins': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'max-html-ttfb-ms': { type: 'string' },
      'max-bundle-cold-ms': { type: 'string' },
      'max-bundle-warm-ms': { type: 'string' },
      'max-media-range-ms': { type: 'string' },
      'no-require-304': { type: 'boolean', default: false },
      'no-require-206': { type: 'boolean', default: false },
      'no-require-security-headers': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const targetUrl =
    values.url?.trim() || pluginOptions.targetUrl?.trim() || process.env['KINLOOM_PROBE_URL']?.trim() || '';
  if (!targetUrl) {
    throw new CliValidationError(
      'Missing target URL. Pass `--url <baseUrl>`, configure `targetUrl`, or set KINLOOM_PROBE_URL.'
    );
  }

  const baseBudgets = resolveProbeBudgets(pluginOptions.budgets);
  const budgets: SyntheticProbeBudgets = {
    maxHtmlTtfbMs:
      parseOptionalPositiveNumber(values['max-html-ttfb-ms'], '--max-html-ttfb-ms') ??
      baseBudgets.maxHtmlTtfbMs,
    maxBundleColdMs:
      parseOptionalPositiveNumber(values['max-bundle-cold-ms'], '--max-bundle-cold-ms') ??
      baseBudgets.maxBundleColdMs,
    maxBundleWarmMs:
      parseOptionalPositiveNumber(values['max-bundle-warm-ms'], '--max-bundle-warm-ms') ??
      baseBudgets.maxBundleWarmMs,
    maxMediaRangeMs:
      parseOptionalPositiveNumber(values['max-media-range-ms'], '--max-media-range-ms') ??
      baseBudgets.maxMediaRangeMs,
    require304: values['no-require-304'] ? false : baseBudgets.require304,
    require206: values['no-require-206'] ? false : baseBudgets.require206,
    requireSecurityHeaders: values['no-require-security-headers']
      ? false
      : baseBudgets.requireSecurityHeaders,
  };

  const flagMediaPath = values['media-path']?.trim();
  const optionMediaPath = pluginOptions.mediaPath?.trim();
  const mediaPath = flagMediaPath || optionMediaPath || undefined;
  const mediaPathSource: 'flag' | 'option' | undefined = flagMediaPath
    ? 'flag'
    : optionMediaPath
      ? 'option'
      : undefined;

  const mediaRangeBytes =
    parseOptionalPositiveInt(values['media-range-bytes'], '--media-range-bytes') ??
    pluginOptions.mediaRangeBytes ??
    DEFAULT_MEDIA_RANGE_BYTES;

  const timeoutMs =
    parseOptionalPositiveInt(values['timeout-ms'], '--timeout-ms') ??
    pluginOptions.timeoutMs ??
    DEFAULT_PROBE_TIMEOUT_MS;

  const token = resolveProbeToken(values.token, pluginOptions.token);
  const cliExpectPlugins = parseExpectedPluginsCsv(values['expect-plugins']);
  const expectPlugins = cliExpectPlugins.length > 0 ? cliExpectPlugins : (pluginOptions.expectPlugins ?? []);
  const checkPlugins =
    Boolean(values.plugins) || expectPlugins.length > 0 || Boolean(pluginOptions.checkPlugins);

  return {
    targetUrl,
    mediaPath,
    mediaPathSource,
    mediaRangeBytes,
    token,
    timeoutMs,
    budgets,
    checkPlugins,
    expectPlugins,
    json: Boolean(values.json),
  };
}

function createProbeCommand(pluginOptions: SyntheticProbePluginOptions): KinloomCliCommand {
  return {
    name: SYNTHETIC_PROBE_COMMAND_NAME,
    summary: 'Run synthetic performance, caching, security-header, media 206, and plugin health probes',
    help: SYNTHETIC_PROBE_HELP,
    async run(args: readonly string[], ctx: KinloomCliPluginContext): Promise<CliExitCode> {
      const parsed = parseProbeCommandArgs(args, pluginOptions);
      const report = await runSyntheticProbe({
        targetUrl: parsed.targetUrl,
        mediaPath: parsed.mediaPath,
        mediaPathSource: parsed.mediaPathSource,
        mediaRangeBytes: parsed.mediaRangeBytes,
        token: parsed.token,
        budgets: parsed.budgets,
        timeoutMs: parsed.timeoutMs,
        checkPlugins: parsed.checkPlugins,
        expectPlugins: parsed.expectPlugins,
        fetchImpl: ctx.fetchImpl ?? pluginOptions.fetchImpl,
        clock: pluginOptions.clock,
      });

      if (parsed.json) {
        ctx.io.stdout(JSON.stringify(report, null, 2));
      } else {
        ctx.io.stdout(formatSyntheticProbeReport(report));
      }

      return report.ok ? EXIT_OK : EXIT_ERROR;
    },
  };
}

function createSyntheticProbeVerifyCheck(pluginOptions: SyntheticProbePluginOptions): KinloomVerifyCheck {
  return {
    id: SYNTHETIC_PROBE_VERIFY_CHECK_ID,
    name: 'Synthetic performance probe',
    async run(): Promise<KinloomCheckResult> {
      const targetUrl = pluginOptions.targetUrl?.trim() || process.env['KINLOOM_PROBE_URL']?.trim() || '';
      if (!targetUrl) {
        return {
          errors: [
            "Synthetic probe verify check requires a configured 'targetUrl' option or KINLOOM_PROBE_URL.",
          ],
          warnings: [],
        };
      }

      const report = await runSyntheticProbe({
        targetUrl,
        mediaPath: pluginOptions.mediaPath,
        mediaPathSource: pluginOptions.mediaPath ? 'option' : undefined,
        mediaRangeBytes: pluginOptions.mediaRangeBytes,
        token: resolveProbeToken(undefined, pluginOptions.token),
        budgets: pluginOptions.budgets,
        timeoutMs: pluginOptions.timeoutMs,
        checkPlugins: pluginOptions.checkPlugins,
        expectPlugins: pluginOptions.expectPlugins,
        fetchImpl: pluginOptions.fetchImpl,
        clock: pluginOptions.clock,
      });

      const warnings: string[] = [];
      if (report.mediaRange.status === 'skipped') {
        warnings.push(report.mediaRange.reason);
      }

      return {
        errors: report.violations,
        warnings,
        details: {
          targetUrl: report.targetUrl,
          ok: report.ok,
          durationMs: report.durationMs,
          htmlTtfbMs: report.html.ttfbMs,
          bundleColdMs: report.bundle.cold.durationMs,
          bundleWarmMs: report.bundle.warm.durationMs,
          mediaRangeStatus: report.mediaRange.status,
        },
      };
    },
  };
}

/**
 * Optional Kinloom CLI plugin for synthetic performance, caching, and header probes.
 * Strictly off unless explicitly registered in a site's extensions or CLI plugin config.
 * Passing `{ enabled: false }` returns an inert no-op plugin with zero commands or verify checks.
 */
export function createSyntheticProbePlugin(options: SyntheticProbePluginOptions = {}): KinloomCliPlugin {
  if (options.enabled === false) {
    return {
      id: SYNTHETIC_PROBE_PLUGIN_ID,
      name: 'Kinloom Synthetic Performance Probe (disabled)',
      commands: [],
    };
  }

  return {
    id: SYNTHETIC_PROBE_PLUGIN_ID,
    name: 'Kinloom Synthetic Performance Probe',
    commands: [createProbeCommand(options)],
    ...(options.attachVerifyCheck === true
      ? { verifyChecks: [createSyntheticProbeVerifyCheck(options)] }
      : {}),
  };
}
