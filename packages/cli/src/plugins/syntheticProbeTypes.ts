export const SYNTHETIC_PROBE_PLUGIN_ID = 'kinloom-synthetic-probe';
export const SYNTHETIC_PROBE_COMMAND_NAME = 'probe';
export const SYNTHETIC_PROBE_VERIFY_CHECK_ID = 'synthetic-probe';

export type ServerTimingSpanName = 'd1' | 'r2' | 'bundle' | 'total';

export interface ParsedServerTiming {
  readonly raw: string | null;
  readonly spansMs: Readonly<Partial<Record<ServerTimingSpanName, number>>>;
  readonly allSpansMs: Readonly<Record<string, number>>;
}

export interface SyntheticProbeClock {
  now(): number;
  nowIso(): string;
}

export interface SyntheticProbeBudgets {
  readonly maxHtmlTtfbMs: number;
  readonly maxBundleColdMs: number;
  readonly maxBundleWarmMs: number;
  readonly maxMediaRangeMs: number;
  readonly require304: boolean;
  readonly require206: boolean;
  readonly requireSecurityHeaders: boolean;
}

export const DEFAULT_SYNTHETIC_PROBE_BUDGETS: SyntheticProbeBudgets = Object.freeze({
  maxHtmlTtfbMs: 800,
  maxBundleColdMs: 1500,
  maxBundleWarmMs: 400,
  maxMediaRangeMs: 1000,
  require304: true,
  require206: true,
  requireSecurityHeaders: true,
});

export const DEFAULT_MEDIA_RANGE_BYTES = 1024;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

export interface SyntheticProbePluginOptions {
  /**
   * When false, returns an inert plugin with zero commands and zero verify checks.
   * Defaults to true when the factory is explicitly invoked.
   */
  readonly enabled?: boolean;
  /**
   * Opt-in integration with `kinloom verify`. Strictly false by default so registering
   * the `probe` CLI command never adds network requests to local `kinloom verify` runs.
   */
  readonly attachVerifyCheck?: boolean;
  /** Default archive base URL used when `--url` is omitted or during opt-in verify checks. */
  readonly targetUrl?: string;
  /** Optional explicit media path (e.g. `/media/portrait.jpg`) for the 206 byte-range probe. */
  readonly mediaPath?: string;
  /** Number of leading bytes requested in the Range probe (default: 1024, i.e. bytes=0-1023). */
  readonly mediaRangeBytes?: number;
  /** Optional bearer token for private archive probes. Never included in probe output. */
  readonly token?: string;
  /** Budget threshold overrides. */
  readonly budgets?: Partial<SyntheticProbeBudgets>;
  /** Optional timeout in milliseconds per HTTP request (default: 15000). */
  readonly timeoutMs?: number;
  /** Run live plugin health verification checks by default. */
  readonly checkPlugins?: boolean;
  /** Server plugin IDs required to be active when plugin health checks run. */
  readonly expectPlugins?: readonly string[];
  /** Optional fetch implementation for deterministic tests. */
  readonly fetchImpl?: typeof fetch;
  /** Optional clock for deterministic latency and timestamp measurement. */
  readonly clock?: SyntheticProbeClock;
}

export interface SecurityHeaderCheckResult {
  readonly required: readonly string[];
  readonly present: readonly string[];
  readonly missing: readonly string[];
  readonly ok: boolean;
}

export interface HtmlProbeResult {
  readonly status: 'pass' | 'fail';
  readonly url: string;
  readonly httpStatus: number | null;
  readonly ttfbMs: number;
  readonly totalMs: number;
  readonly bytes: number;
  readonly securityHeaders: SecurityHeaderCheckResult;
  readonly violations: readonly string[];
  readonly error?: string;
}

export interface BundleColdProbeResult {
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly bytes: number;
  readonly etag: string | null;
  readonly cacheControl: string | null;
  readonly xRequestId?: string | null;
  readonly serverTiming: ParsedServerTiming;
  readonly error?: string;
}

export type BundleWarmProbeResult =
  | {
      readonly status: 'skipped';
      readonly reason: string;
      readonly httpStatus: null;
      readonly durationMs: null;
      readonly etag: null;
      readonly cacheControl: null;
      readonly serverTiming: ParsedServerTiming;
    }
  | {
      readonly status: 'pass' | 'fail';
      readonly httpStatus: number | null;
      readonly durationMs: number;
      readonly etag: string | null;
      readonly cacheControl: string | null;
      readonly serverTiming: ParsedServerTiming;
      readonly error?: string;
    };

export interface BundleProbeResult {
  readonly status: 'pass' | 'fail';
  readonly url: string;
  readonly cold: BundleColdProbeResult;
  readonly warm: BundleWarmProbeResult;
  readonly violations: readonly string[];
}

export type MediaRangeSource = 'flag' | 'option' | 'bundle';

export type MediaRangeProbeResult =
  | {
      readonly status: 'skipped';
      readonly reason: string;
      readonly violations: readonly [];
    }
  | {
      readonly status: 'pass' | 'fail';
      readonly url: string;
      readonly source: MediaRangeSource;
      readonly rangeHeader: string;
      readonly httpStatus: number | null;
      readonly durationMs: number;
      readonly bytes: number;
      readonly acceptRanges: string | null;
      readonly contentRange: string | null;
      readonly serverTiming: ParsedServerTiming;
      readonly violations: readonly string[];
      readonly error?: string;
    };

export type SinglePluginProbeStatus = 'pass' | 'warn' | 'fail' | 'skipped';

export interface SinglePluginProbeResult {
  readonly pluginId: string;
  readonly status: SinglePluginProbeStatus;
  readonly httpStatus: number | null;
  readonly durationMs: number;
  readonly detail: string;
  readonly violations: readonly string[];
}

export interface PluginProbesReport {
  readonly status: 'pass' | 'fail';
  readonly checks: readonly SinglePluginProbeResult[];
  readonly leakGuardPassed: boolean | null;
  readonly diagnosticsChecked: boolean;
  readonly violations: readonly string[];
}

export interface SyntheticProbeReport {
  readonly ok: boolean;
  readonly targetUrl: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly budgets: SyntheticProbeBudgets;
  readonly html: HtmlProbeResult;
  readonly bundle: BundleProbeResult;
  readonly mediaRange: MediaRangeProbeResult;
  readonly plugins?: PluginProbesReport;
  readonly violations: readonly string[];
}

export interface RunSyntheticProbeInput {
  readonly targetUrl: string;
  readonly mediaPath?: string;
  readonly mediaPathSource?: Extract<MediaRangeSource, 'flag' | 'option'>;
  readonly mediaRangeBytes?: number;
  readonly token?: string;
  readonly budgets?: Partial<SyntheticProbeBudgets>;
  readonly timeoutMs?: number;
  readonly checkPlugins?: boolean;
  readonly expectPlugins?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly clock?: SyntheticProbeClock;
}
