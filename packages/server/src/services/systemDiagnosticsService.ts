import {
  type AdminDiagnosticsReport,
  AdminDiagnosticsReportSchema,
  type DiagnosticsPlatform,
  type HealthCheckResult,
  KINLOOM_CORE_VERSION,
  type KinloomServerPluginStatusContext,
  type KinloomSiteConfig,
  type PluginRuntimeStatus,
  PluginRuntimeStatusSchema,
  type PluginStatusRecord,
} from '@kinloom/core';
import type { KinloomServerPlugin, KinloomServerPorts } from '../http/pluginLifecycle.js';
import type { RecentErrorRingBuffer } from '../http/recentErrorBuffer.js';
import { sanitizeDiagnosticDetail } from '../http/redaction.js';
import { KINLOOM_SERVER_VERSION } from '../version.js';
import {
  loadPersistedPronunciationConfig,
  PRONUNCIATION_PLUGIN_ID,
  resolveActivePronunciationGeneratorLabel,
} from './pronunciationRuntime.js';

const HEALTH_PROBE_MEDIA_KEY = '__kinloom_diagnostics_health_probe__';
const SAFE_COMMIT_SHA_PATTERN = /^[0-9a-zA-Z._-]{4,64}$/;
const SAFE_COMPAT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface KinloomServerDiagnosticsConfig {
  readonly workerVersion?: string | null;
  readonly buildCommitSha?: string | null;
  readonly buildTimestamp?: string | null;
  readonly schemaMigrationLevel?: string | null;
  readonly getSchemaMigrationLevel?: () => Promise<string | null>;
  readonly platform?: DiagnosticsPlatform;
  readonly workersCompatibilityDate?: string | null;
  readonly readOnlyDemo?: boolean;
  readonly recentErrorsCapacity?: number;
  readonly recentErrorBuffer?: RecentErrorRingBuffer;
}

export interface SystemDiagnosticsServiceDeps {
  readonly siteConfig: KinloomSiteConfig;
  readonly mode: 'private' | 'public';
  readonly ports: KinloomServerPorts;
  readonly plugins: readonly KinloomServerPlugin[];
  readonly recentErrors: RecentErrorRingBuffer;
  readonly diagnosticsConfig?: KinloomServerDiagnosticsConfig;
  readonly onPluginError?: (pluginId: string, error: unknown) => void;
}

function readNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function roundMs(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const rounded = Math.round(durationMs * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function detectPlatform(explicit?: DiagnosticsPlatform): DiagnosticsPlatform {
  if (explicit) {
    return explicit;
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return 'cloudflare-workers';
  }
  if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') {
    return 'node';
  }
  return 'unknown';
}

function detectNodeVersion(platform: DiagnosticsPlatform): string | null {
  if (platform !== 'node') {
    return null;
  }
  if (typeof process !== 'undefined' && typeof process.versions?.node === 'string') {
    return process.versions.node;
  }
  return null;
}

function sanitizeCommitSha(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return SAFE_COMMIT_SHA_PATTERN.test(trimmed) ? trimmed : null;
}

function sanitizeCompatDate(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  return SAFE_COMPAT_DATE_PATTERN.test(trimmed) ? trimmed : null;
}

function collectPluginHooks(plugin: KinloomServerPlugin): string[] {
  const hooks: string[] = [];
  if (typeof plugin.onRevisionCommitted === 'function') {
    hooks.push('onRevisionCommitted');
  }
  if (typeof plugin.onRequestStart === 'function') {
    hooks.push('onRequestStart');
  }
  if (typeof plugin.onResponse === 'function') {
    hooks.push('onResponse');
  }
  if (typeof plugin.onError === 'function') {
    hooks.push('onError');
  }
  if (typeof plugin.onSecurityEvent === 'function') {
    hooks.push('onSecurityEvent');
  }
  if (plugin.documentContributions !== undefined) {
    hooks.push('documentContributions');
  }
  if (plugin.settingsSchema !== undefined) {
    hooks.push('settingsSchema');
  }
  return hooks;
}

function normalizePluginStatus(raw: unknown): PluginRuntimeStatus {
  const parsed = PluginRuntimeStatusSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'active';
}

export class SystemDiagnosticsService {
  constructor(private readonly deps: SystemDiagnosticsServiceDeps) {}

  async getReport(): Promise<AdminDiagnosticsReport> {
    const { ports, plugins, siteConfig, mode, diagnosticsConfig } = this.deps;
    const platform = detectPlatform(diagnosticsConfig?.platform);
    const statusCtx: KinloomServerPluginStatusContext = {
      siteConfig,
      ports,
      mode,
    };

    const [
      schemaMigrationLevel,
      repositoryProbe,
      bundleCacheProbe,
      mediaStoreProbe,
      pluginStatuses,
      observability,
      pronunciationGeneratorLabel,
    ] = await Promise.all([
      this.probeSchemaMigrationLevel(),
      this.probeRepository(),
      this.probeBundleCache(),
      this.probeMediaStore(),
      Promise.all(plugins.map((plugin) => this.probePluginStatus(plugin, statusCtx))),
      this.resolveObservabilityFlags(plugins, statusCtx),
      this.resolvePronunciationGeneratorAdapter(ports),
    ]);

    const authProviderConfigured = Boolean(ports.authProvider && ports.authProvider.configured !== false);

    const rawReport: AdminDiagnosticsReport = {
      generated_at: ports.clock.nowIso(),
      versions: {
        core_version: KINLOOM_CORE_VERSION,
        server_version: KINLOOM_SERVER_VERSION,
        worker_version: sanitizeDiagnosticDetail(diagnosticsConfig?.workerVersion, 64),
        build_commit_sha: sanitizeCommitSha(diagnosticsConfig?.buildCommitSha),
        build_timestamp: sanitizeDiagnosticDetail(diagnosticsConfig?.buildTimestamp, 64),
        schema_migration_level: sanitizeDiagnosticDetail(schemaMigrationLevel, 128),
      },
      runtime: {
        platform,
        node_version: detectNodeVersion(platform),
        workers_compatibility_date: sanitizeCompatDate(diagnosticsConfig?.workersCompatibilityDate),
        adapters: {
          repository: ports.repository.adapterKind ?? 'custom',
          bundle_cache: ports.bundleCache.adapterKind ?? 'custom',
          media_store: ports.mediaStore.adapterKind ?? 'custom',
          email_sender: ports.emailSender.adapterKind ?? 'custom',
          auth_provider_configured: authProviderConfigured,
          auth_provider_id: authProviderConfigured ? (ports.authProvider?.id ?? null) : null,
          pronunciation_generator: pronunciationGeneratorLabel,
          pronunciation_lexicon_store: ports.pronunciationLexiconStore
            ? (ports.pronunciationLexiconStore.adapterKind ?? 'custom')
            : 'none',
        },
      },
      config: {
        mode,
        read_only_demo: diagnosticsConfig?.readOnlyDemo === true,
        auth_methods: {
          google_oauth: authProviderConfigured,
          magic_link: true,
          invite_links: true,
          agent_tokens: true,
        },
        observability,
        wiki: {
          allow_talk: siteConfig.wiki?.allowTalk ?? true,
          allow_watchlists: siteConfig.wiki?.allowWatchlists ?? false,
          max_upload_bytes: siteConfig.wiki?.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
        },
        privacy: {
          living_cutoff_years: siteConfig.privacy.livingCutoffYears,
          private_mode_shows_birth_year: siteConfig.privacy.privateModeShowsBirthYear,
          strip_living_portraits: siteConfig.privacy.stripLivingPortraits,
          strip_living_residence_spans: siteConfig.privacy.stripLivingResidenceSpans,
          mark_gedcom_living_confidential: siteConfig.privacy.markGedcomLivingConfidential,
        },
      },
      archive: {
        head_revision_id: repositoryProbe.headRevisionId,
        bundle_cache_status: bundleCacheProbe.cacheStatus,
        counts: repositoryProbe.counts,
      },
      health_checks: [repositoryProbe.healthCheck, bundleCacheProbe.healthCheck, mediaStoreProbe],
      plugins: pluginStatuses,
      recent_errors: [...this.deps.recentErrors.snapshot()],
    };

    return AdminDiagnosticsReportSchema.parse(rawReport);
  }

  private async resolvePronunciationGeneratorAdapter(ports: KinloomServerPorts): Promise<string> {
    const { config } = await loadPersistedPronunciationConfig(ports.pluginSettingsStore);
    const configuredSecrets: Record<string, boolean> = {};
    if (ports.pluginSettingsStore) {
      try {
        const meta = await ports.pluginSettingsStore.getSecretMetadata(PRONUNCIATION_PLUGIN_ID);
        for (const [key, entry] of Object.entries(meta)) {
          configuredSecrets[key] = entry.configured === true;
        }
      } catch {
        // Ignore secret metadata lookup failures in diagnostics probe.
      }
    }
    return resolveActivePronunciationGeneratorLabel({
      config,
      configuredSecrets,
      injectedGenerator: ports.pronunciationGenerator,
      envDefaults: ports.pronunciationEnv,
    });
  }

  private async resolveObservabilityFlags(
    plugins: readonly KinloomServerPlugin[],
    statusCtx: KinloomServerPluginStatusContext
  ): Promise<{
    enabled: boolean;
    server_timing: boolean;
    security_telemetry: boolean;
    web_analytics: boolean;
  }> {
    let enabled = false;
    let serverTiming = false;
    let securityTelemetry = false;
    let webAnalytics = false;

    for (const plugin of plugins) {
      let flags = plugin.observabilityFlags;
      if (typeof plugin.getObservabilityFlags === 'function') {
        try {
          flags = await plugin.getObservabilityFlags(statusCtx);
        } catch (error) {
          try {
            this.deps.onPluginError?.(plugin.id, error);
          } catch {
            // Isolate reporter failures so diagnostics stay available.
          }
        }
      }
      if (!flags?.enabled) {
        continue;
      }
      enabled = true;
      if (flags.serverTiming) {
        serverTiming = true;
      }
      if (flags.securityTelemetry) {
        securityTelemetry = true;
      }
      if (flags.webAnalytics) {
        webAnalytics = true;
      }
    }

    return {
      enabled,
      server_timing: serverTiming,
      security_telemetry: securityTelemetry,
      web_analytics: webAnalytics,
    };
  }

  private async probeSchemaMigrationLevel(): Promise<string | null> {
    const cfg = this.deps.diagnosticsConfig;
    if (cfg?.getSchemaMigrationLevel) {
      try {
        const level = await cfg.getSchemaMigrationLevel();
        return level ?? cfg.schemaMigrationLevel ?? null;
      } catch {
        return cfg.schemaMigrationLevel ?? null;
      }
    }
    return cfg?.schemaMigrationLevel ?? null;
  }

  private async probeRepository(): Promise<{
    readonly headRevisionId: number;
    readonly counts: AdminDiagnosticsReport['archive']['counts'];
    readonly healthCheck: HealthCheckResult;
  }> {
    const startMs = readNowMs();
    try {
      const [snapshot, livingIds] = await Promise.all([
        this.deps.ports.repository.loadActiveSnapshot(),
        this.deps.ports.repository.getLivingPersonIds(),
      ]);
      const latencyMs = roundMs(readNowMs() - startMs);

      let peopleDeceased = 0;
      let peopleLiving = 0;
      let events = 0;
      let places = 0;
      let sources = 0;
      let media = 0;
      let narratives = 0;

      for (const row of snapshot.entities) {
        switch (row.entity_type) {
          case 'person':
            if (livingIds.has(row.entity_id)) {
              peopleLiving += 1;
            } else {
              peopleDeceased += 1;
            }
            break;
          case 'event':
            events += 1;
            break;
          case 'place':
            places += 1;
            break;
          case 'source':
            sources += 1;
            break;
          case 'media':
            media += 1;
            break;
          case 'narrative':
            narratives += 1;
            break;
        }
      }

      const headRevisionId = Number(snapshot.head_revision_id);
      return {
        headRevisionId: Number.isSafeInteger(headRevisionId) && headRevisionId >= 0 ? headRevisionId : 0,
        counts: {
          people_deceased: peopleDeceased,
          people_living: peopleLiving,
          events,
          places,
          sources,
          media,
          narratives,
        },
        healthCheck: {
          name: 'repository',
          status: 'pass',
          latency_ms: latencyMs,
          detail: `Head revision r${headRevisionId}`,
        },
      };
    } catch {
      return {
        headRevisionId: 0,
        counts: {
          people_deceased: 0,
          people_living: 0,
          events: 0,
          places: 0,
          sources: 0,
          media: 0,
          narratives: 0,
        },
        healthCheck: {
          name: 'repository',
          status: 'fail',
          latency_ms: roundMs(readNowMs() - startMs),
          detail: 'Repository probe failed',
        },
      };
    }
  }

  private async probeBundleCache(): Promise<{
    readonly cacheStatus: 'hit' | 'miss' | 'error';
    readonly healthCheck: HealthCheckResult;
  }> {
    const startMs = readNowMs();
    try {
      const cached = await this.deps.ports.bundleCache.getCached(null);
      const latencyMs = roundMs(readNowMs() - startMs);
      if (cached.status === 'hit') {
        return {
          cacheStatus: 'hit',
          healthCheck: {
            name: 'bundle_cache',
            status: 'pass',
            latency_ms: latencyMs,
            detail: `Cached at r${cached.object.revision_id}`,
          },
        };
      }
      if (cached.status === 'not_modified') {
        return {
          cacheStatus: 'hit',
          healthCheck: {
            name: 'bundle_cache',
            status: 'pass',
            latency_ms: latencyMs,
            detail: 'Cache warm',
          },
        };
      }
      return {
        cacheStatus: 'miss',
        healthCheck: {
          name: 'bundle_cache',
          status: 'warn',
          latency_ms: latencyMs,
          detail: 'Cache cold (not compiled yet)',
        },
      };
    } catch {
      return {
        cacheStatus: 'error',
        healthCheck: {
          name: 'bundle_cache',
          status: 'fail',
          latency_ms: roundMs(readNowMs() - startMs),
          detail: 'Bundle cache probe failed',
        },
      };
    }
  }

  private async probeMediaStore(): Promise<HealthCheckResult> {
    const startMs = readNowMs();
    try {
      await this.deps.ports.mediaStore.head(HEALTH_PROBE_MEDIA_KEY);
      return {
        name: 'media_store',
        status: 'pass',
        latency_ms: roundMs(readNowMs() - startMs),
        detail: 'Reachable',
      };
    } catch {
      return {
        name: 'media_store',
        status: 'fail',
        latency_ms: roundMs(readNowMs() - startMs),
        detail: 'Media store probe failed',
      };
    }
  }

  private async probePluginStatus(
    plugin: KinloomServerPlugin,
    statusCtx: KinloomServerPluginStatusContext
  ): Promise<PluginStatusRecord> {
    let status: PluginRuntimeStatus = normalizePluginStatus(plugin.status ?? 'active');
    let detail: string | null = null;

    if (typeof plugin.getStatus === 'function') {
      try {
        const probe = await plugin.getStatus(statusCtx);
        status = normalizePluginStatus(probe.status);
        detail = sanitizeDiagnosticDetail(probe.detail);
      } catch (error) {
        status = 'degraded';
        detail = 'Status probe threw an error';
        try {
          this.deps.onPluginError?.(plugin.id, error);
        } catch {
          // Isolate reporter failures so diagnostics stay available.
        }
      }
    }

    const version = plugin.version?.trim() ? plugin.version.trim() : 'unversioned';
    return {
      id: plugin.id,
      name: plugin.name,
      version,
      status,
      surface: 'server',
      route_count: plugin.routes?.length ?? 0,
      hooks: collectPluginHooks(plugin),
      detail,
    };
  }
}
