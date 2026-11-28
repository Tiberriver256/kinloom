import type {
  AuthProvider,
  Clock,
  EmailSender,
  KinloomSiteConfig,
  PluginDatabaseFactory,
  PluginSettingsStore,
  PronunciationAudioGenerator,
  PronunciationLexiconStore,
} from '@kinloom/core';
import {
  createKinloomServer,
  GoogleOAuthProvider,
  type KinloomServerPlugin,
  type PageVisitStatsStore,
  RecentErrorRingBuffer,
  SystemClock,
  validateAndCompilePluginRoutes,
} from '@kinloom/server';
import { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
import { CloudflareEmailSender } from './adapters/cloudflareEmailSender.js';
import { probeD1SchemaMigrationLevel } from './adapters/d1/schemaProbe.js';
import { D1PageVisitStatsStore } from './adapters/d1PageVisitStatsStore.js';
import { D1PluginDatabaseFactory } from './adapters/d1PluginDatabase.js';
import { D1PluginSettingsStore } from './adapters/d1PluginSettingsStore.js';
import { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
import { createD1ArchiveRepository } from './adapters/d1Repository.js';
import { GeminiPronunciationAudioGenerator } from './adapters/geminiPronunciationGenerator.js';
import { R2IncrementalPatchBundleCache } from './adapters/r2BundleCache.js';
import { R2MediaStore } from './adapters/r2MediaStore.js';
import type { ExecutionContext, ExportedHandler, KinloomWorkerEnv } from './types.js';

export const KINLOOM_WORKER_VERSION = '0.54.6';

export {
  type AdminObservabilityStatsResponse,
  AdminObservabilityStatsResponseSchema,
  type AllowlistedDonationUrl,
  buildDonationPlatformUrl,
  buildOpenFinancePublicSummary,
  CLOUDFLARE_WEB_ANALYTICS_BEACON_URL,
  CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_DISCLOSURE_ID,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN,
  type CloudflareWebAnalyticsToken,
  computeFundingGoalSummary,
  computeOpenFinanceTotals,
  createDefaultOpenFinanceConfig,
  createOpenFinancePlugin,
  createPageVisitStatsPlugin,
  createPronunciationPlugin,
  createWorkersObservabilityPlugin,
  type DailyVisitPoint,
  DONATION_PLATFORM_IDS,
  DONATION_PLATFORM_REGISTRY,
  type DonationPlatformId,
  type DonationPlatformSpec,
  type DonationUrlValidationResult,
  type DynamicOgRequestOptions,
  formatCurrencyCents,
  handleDynamicOgRequest,
  InMemoryPageVisitStatsStore,
  isCloudflareWebAnalyticsToken,
  isWebAnalyticsEnabled,
  type KinloomServerPlugin,
  type ObservabilityCacheOutcome,
  type ObservabilityCacheSummary,
  type ObservabilityCacheTotals,
  type ObservabilityStatsWindow,
  OPEN_FINANCE_ADMIN_ROUTE,
  OPEN_FINANCE_COST_CADENCES,
  OPEN_FINANCE_COST_CATEGORIES,
  OPEN_FINANCE_CURRENCIES,
  OPEN_FINANCE_PLUGIN_ID,
  OPEN_FINANCE_PUBLIC_ROUTE,
  type OpenFinanceAdminConfigResponse,
  type OpenFinanceConfig,
  type OpenFinanceConfigInput,
  type OpenFinanceCostCadence,
  type OpenFinanceCostCategory,
  type OpenFinanceCostItem,
  type OpenFinanceCostTotals,
  type OpenFinanceCurrency,
  type OpenFinanceFundingGoal,
  type OpenFinanceFundingGoalSummary,
  type OpenFinancePlatformConfig,
  type OpenFinancePlatformInput,
  type OpenFinancePluginOptions,
  type OpenFinancePublicCostItem,
  type OpenFinancePublicPlatform,
  type OpenFinancePublicSummary,
  type OpenFinanceVisibility,
  PAGE_VISIT_STATS_ADMIN_ROUTE,
  PAGE_VISIT_STATS_PLUGIN_ID,
  PAGE_VISIT_STATS_PRIVACY_DISCLOSURE_ID,
  PAGE_VISIT_STATS_PRIVACY_SUMMARY,
  PAGE_VISIT_STATS_PUBLIC_COUNT_ROUTE,
  type PageVisitEntityKind,
  type PageVisitIncrementInput,
  type PageVisitStatsPluginOptions,
  type PageVisitStatsStore,
  type PageVisitTopRow,
  type ParseOpenFinanceConfigResult,
  PRONUNCIATION_PLUGIN_ID,
  type PronunciationFallbackBackend,
  type PronunciationPhonemeMode,
  type PronunciationPluginOptions,
  type PronunciationPluginRuntimeConfig,
  type PronunciationTtsBackend,
  type PublicPageVisitCountResponse,
  PublicPageVisitCountResponseSchema,
  parseOpenFinanceConfig,
  RECIPES_DATABASE_NAMESPACE,
  RECIPES_INITIAL_MIGRATION_SQL,
  RECIPES_PLUGIN_ID,
  RECIPES_PLUGIN_MIGRATIONS,
  type RecipesRepository,
  type RenderPrivacyPolicyOptions,
  renderCloudflareWebAnalyticsBeaconHtml,
  renderPrivacyPolicyHtml,
  SERVER_SECURITY_EVENT_TYPES,
  type SecurityTelemetryAlertSink,
  type SecurityTelemetryLogLevel,
  type SecurityTelemetryLogRecord,
  type SecurityTelemetryOptions,
  type SecurityTelemetrySink,
  type ServerCspDirectiveAdditions,
  type ServerDocumentContributions,
  type ServerPrivacyDisclosure,
  type ServerSecurityEvent,
  type ServerSecurityEventType,
  SqlRecipesRepository,
  type TopVisitedPage,
  validateCloudflareWebAnalyticsToken,
  validateDonationPlatformUrl,
  validateOpenFinanceConfig,
  type WebAnalyticsOptions,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogLevel,
  type WorkersObservabilityLogRecord,
  type WorkersObservabilityPluginOptions,
  type WorkersObservabilitySink,
  type WorkersSecurityTelemetryOption,
} from '@kinloom/server';
export { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
export {
  buildMagicLinkEmailMessage,
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
  type CloudflareEmailSenderOptions,
  DEFAULT_EMAIL_FROM,
} from './adapters/cloudflareEmailSender.js';
export { D1PageVisitStatsStore } from './adapters/d1PageVisitStatsStore.js';
export {
  createD1PluginMigrationExecutor,
  createD1RecipesRepository,
  D1PluginDatabaseFactory,
  D1PluginDatabasePort,
  runD1PluginMigrations,
} from './adapters/d1PluginDatabase.js';
export { D1PluginSettingsStore } from './adapters/d1PluginSettingsStore.js';
export { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
export {
  createD1ArchiveRepository,
  D1ArchiveRepository,
  type D1ArchiveRepositoryOptions,
} from './adapters/d1Repository.js';
export {
  buildPronunciationPrompt,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiPronunciationAudioGenerator,
  type GeminiPronunciationAudioGeneratorOptions,
  wrapPcmAsWav,
} from './adapters/geminiPronunciationGenerator.js';
export {
  DEFAULT_COMPILED_BUNDLE_KEY,
  R2IncrementalPatchBundleCache,
  type R2IncrementalPatchBundleCacheOptions,
} from './adapters/r2BundleCache.js';
export { R2MediaStore } from './adapters/r2MediaStore.js';
export type {
  D1Database,
  D1ExecResult,
  D1Meta,
  D1PreparedStatement,
  D1Result,
  ExecutionContext,
  ExportedHandler,
  Fetcher,
  KinloomWorkerEnv,
  R2Bucket,
  R2Conditional,
  R2GetOptions,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2Range,
  SendEmailAddress,
  SendEmailBinding,
  SendEmailMessage,
  SendEmailMessageBuilder,
  SendEmailResult,
} from './types.js';

export interface CreateCloudflareWorkerOptions {
  siteConfig: KinloomSiteConfig;
  plugins?: readonly KinloomServerPlugin[];
  clock?: Clock;
  emailSender?: EmailSender;
  authProvider?: AuthProvider;
  pronunciationGenerator?: PronunciationAudioGenerator;
  pronunciationLexiconStore?: PronunciationLexiconStore;
  pluginSettingsStore?: PluginSettingsStore;
  pluginDatabaseFactory?: PluginDatabaseFactory;
  pageVisitStatsStore?: PageVisitStatsStore;
  onPluginError?: (pluginId: string, error: unknown) => void;
  buildCommitSha?: string;
  buildTimestamp?: string;
  workersCompatibilityDate?: string;
  recentErrorsCapacity?: number;
}

/**
 * Thin Cloudflare Worker entrypoint factory.
 * Wires D1, R2, Cloudflare Email Service, and ASSETS adapters into portable createKinloomServer.
 */
export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions
): ExportedHandler<KinloomWorkerEnv> {
  const plugins = options.plugins ? [...options.plugins] : [];
  const compiledPluginRoutes = validateAndCompilePluginRoutes(plugins);
  const isolateRecentErrors = new RecentErrorRingBuffer(options.recentErrorsCapacity);

  return {
    async fetch(request: Request, env: KinloomWorkerEnv, ctx?: ExecutionContext): Promise<Response> {
      const clock = options.clock ?? new SystemClock();
      const mode = env.ARCHIVE_MODE === 'public' ? 'public' : 'private';

      const repository = createD1ArchiveRepository(env.DB, {
        privacyConfig: options.siteConfig.privacy,
        clock,
      });
      const bundleCache = new R2IncrementalPatchBundleCache({
        bucket: env.MEDIA_BUCKET,
        siteConfig: options.siteConfig,
        clock,
        mode,
      });
      const mediaStore = new R2MediaStore(env.MEDIA_BUCKET);
      const emailSender =
        options.emailSender ??
        new CloudflareEmailSender({
          binding: env.SEND_EMAIL,
          fromEmail: env.EMAIL_FROM,
          clock,
        });
      const authProvider =
        options.authProvider ??
        (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? new GoogleOAuthProvider({
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            })
          : undefined);
      const assetHandler = createCloudflareAssetHandler(env.ASSETS);
      const pronunciationGenerator =
        options.pronunciationGenerator ??
        (env.GEMINI_API_KEY
          ? new GeminiPronunciationAudioGenerator({
              apiKey: env.GEMINI_API_KEY,
              model: env.GEMINI_TTS_MODEL,
            })
          : undefined);
      const pronunciationLexiconStore =
        options.pronunciationLexiconStore ?? new D1PronunciationLexiconStore(env.DB);
      const pluginSettingsStore = options.pluginSettingsStore ?? new D1PluginSettingsStore(env.DB);
      const pluginDatabaseFactory = options.pluginDatabaseFactory ?? new D1PluginDatabaseFactory(env.DB);
      const pageVisitStatsStore = options.pageVisitStatsStore ?? new D1PageVisitStatsStore(env.DB);

      const server = createKinloomServer({
        siteConfig: options.siteConfig,
        mode,
        sessionSecret: env.SESSION_SECRET,
        bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
        onPluginError: options.onPluginError,
        compiledPluginRoutes,
        diagnostics: {
          workerVersion: KINLOOM_WORKER_VERSION,
          platform: 'cloudflare-workers',
          buildCommitSha: options.buildCommitSha ?? env.KINLOOM_BUILD_SHA ?? null,
          buildTimestamp: options.buildTimestamp ?? env.KINLOOM_BUILD_TIMESTAMP ?? null,
          workersCompatibilityDate:
            options.workersCompatibilityDate ?? env.KINLOOM_COMPATIBILITY_DATE ?? null,
          getSchemaMigrationLevel: () => probeD1SchemaMigrationLevel(env.DB),
          recentErrorBuffer: isolateRecentErrors,
        },
        ports: {
          repository,
          bundleCache,
          mediaStore,
          emailSender,
          authProvider,
          clock,
          assetHandler,
          pronunciationGenerator,
          pronunciationLexiconStore,
          pluginSettingsStore,
          pluginDatabaseFactory,
          pageVisitStatsStore,
          plugins,
        },
      });

      return server.fetch(request, ctx ? { waitUntil: (promise) => ctx.waitUntil(promise) } : undefined);
    },
  };
}
