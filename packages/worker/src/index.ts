import type {
  AuthProvider,
  Clock,
  EmailSender,
  KinloomServerPlugin,
  KinloomSiteConfig,
} from '@kinloom/core';
import {
  createKinloomServer,
  GoogleOAuthProvider,
  KinloomHttpError,
  SystemClock,
} from '@kinloom/server';
import { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
import { CloudflareEmailSender } from './adapters/cloudflareEmailSender.js';
import { D1ArchiveRepository } from './adapters/d1Repository.js';
import { R2IncrementalPatchBundleCache } from './adapters/r2BundleCache.js';
import { R2MediaStore } from './adapters/r2MediaStore.js';
import type { ExportedHandler, KinloomWorkerEnv } from './types.js';

export const KINLOOM_WORKER_VERSION = '0.1.0';

export { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
export {
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
  DEFAULT_EMAIL_FROM,
  type CloudflareEmailSenderOptions,
} from './adapters/cloudflareEmailSender.js';
export { D1ArchiveRepository, type D1ArchiveRepositoryOptions } from './adapters/d1Repository.js';
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
  R2GetOptions,
  R2HTTPMetadata,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  R2Range,
  SendEmailBinding,
  SendEmailMessage,
} from './types.js';

class UnconfiguredAuthProvider implements AuthProvider {
  readonly id = 'google';

  buildAuthorizationUrl(): string {
    throw new KinloomHttpError(
      503,
      'AUTH_PROVIDER_UNCONFIGURED',
      'Google OAuth is not configured for this archive.'
    );
  }

  async exchangeCode(): Promise<{ email: string; displayName: string; emailVerified: boolean }> {
    throw new KinloomHttpError(
      503,
      'AUTH_PROVIDER_UNCONFIGURED',
      'Google OAuth is not configured for this archive.'
    );
  }
}

export interface CreateCloudflareWorkerOptions {
  siteConfig: KinloomSiteConfig;
  plugins?: readonly KinloomServerPlugin[];
  clock?: Clock;
  emailSender?: EmailSender;
  authProvider?: AuthProvider;
  onPluginError?: (pluginId: string, error: unknown) => void;
}

/**
 * Thin Cloudflare Worker entrypoint factory.
 * Wires D1, R2, Cloudflare Email Service, and ASSETS adapters into portable createKinloomServer.
 */
export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions
): ExportedHandler<KinloomWorkerEnv> {
  return {
    async fetch(request: Request, env: KinloomWorkerEnv): Promise<Response> {
      const clock = options.clock ?? new SystemClock();
      const mode = env.ARCHIVE_MODE === 'public' ? 'public' : 'private';

      const repository = new D1ArchiveRepository(env.DB, {
        privacyConfig: options.siteConfig.privacy,
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
          : new UnconfiguredAuthProvider());
      const assetHandler = createCloudflareAssetHandler(env.ASSETS);

      const server = createKinloomServer({
        siteConfig: options.siteConfig,
        sessionSecret: env.SESSION_SECRET,
        bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL,
        onPluginError: options.onPluginError,
        ports: {
          repository,
          bundleCache,
          mediaStore,
          emailSender,
          authProvider,
          clock,
          assetHandler,
          plugins: options.plugins,
        },
      });

      return server.fetch(request);
    },
  };
}
