import type {
  AuthProvider,
  Clock,
  EmailSender,
  KinloomSiteConfig,
  PronunciationAudioGenerator,
  PronunciationLexiconStore,
} from '@kinloom/core';
import {
  createKinloomServer,
  GoogleOAuthProvider,
  type KinloomServerPlugin,
  SystemClock,
  validateAndCompilePluginRoutes,
} from '@kinloom/server';
import { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
import { CloudflareEmailSender } from './adapters/cloudflareEmailSender.js';
import { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
import { createD1ArchiveRepository } from './adapters/d1Repository.js';
import { GeminiPronunciationAudioGenerator } from './adapters/geminiPronunciationGenerator.js';
import { R2IncrementalPatchBundleCache } from './adapters/r2BundleCache.js';
import { R2MediaStore } from './adapters/r2MediaStore.js';
import type { ExportedHandler, KinloomWorkerEnv } from './types.js';

export const KINLOOM_WORKER_VERSION = '0.40.1';

export {
  createWorkersObservabilityPlugin,
  type DynamicOgRequestOptions,
  handleDynamicOgRequest,
  type KinloomServerPlugin,
  renderPrivacyPolicyHtml,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogLevel,
  type WorkersObservabilityLogRecord,
  type WorkersObservabilityPluginOptions,
  type WorkersObservabilitySink,
} from '@kinloom/server';
export { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
export {
  buildMagicLinkEmailMessage,
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
  type CloudflareEmailSenderOptions,
  DEFAULT_EMAIL_FROM,
} from './adapters/cloudflareEmailSender.js';
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
  onPluginError?: (pluginId: string, error: unknown) => void;
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

  return {
    async fetch(request: Request, env: KinloomWorkerEnv): Promise<Response> {
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

      const server = createKinloomServer({
        siteConfig: options.siteConfig,
        mode,
        sessionSecret: env.SESSION_SECRET,
        bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
        onPluginError: options.onPluginError,
        compiledPluginRoutes,
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
          plugins,
        },
      });

      return server.fetch(request);
    },
  };
}
