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
  SystemClock,
  type PronunciationAudioGenerator,
  type PronunciationLexiconStore,
} from '@kinloom/server';
import { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
import { CloudflareEmailSender } from './adapters/cloudflareEmailSender.js';
import { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
import { D1ArchiveRepository } from './adapters/d1Repository.js';
import { GeminiPronunciationAudioGenerator } from './adapters/geminiPronunciationGenerator.js';
import { R2IncrementalPatchBundleCache } from './adapters/r2BundleCache.js';
import { R2MediaStore } from './adapters/r2MediaStore.js';
import type { ExportedHandler, KinloomWorkerEnv } from './types.js';

export const KINLOOM_WORKER_VERSION = '0.38.0';

export { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
export {
  buildMagicLinkEmailMessage,
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
  DEFAULT_EMAIL_FROM,
  type CloudflareEmailSenderOptions,
} from './adapters/cloudflareEmailSender.js';
export { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
export { D1ArchiveRepository, type D1ArchiveRepositoryOptions } from './adapters/d1Repository.js';
export {
  buildPronunciationPrompt,
  DEFAULT_GEMINI_TTS_MODEL,
  DEFAULT_GEMINI_TTS_VOICE,
  GeminiPronunciationAudioGenerator,
  wrapPcmAsWav,
  type GeminiPronunciationAudioGeneratorOptions,
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

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPrivacyPolicyHtml(siteConfig: KinloomSiteConfig): string {
  const title = escapeHtml(siteConfig.site.title);
  const familyName = escapeHtml(siteConfig.site.familyName);
  const accent =
    siteConfig.theme?.accent && HEX_COLOR_PATTERN.test(siteConfig.theme.accent)
      ? siteConfig.theme.accent
      : '#1B2A41';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy | ${title}</title>
  <style>
    :root {
      --paper: #F5EFE2;
      --card: #FCF9F2;
      --ink: #1B2A41;
      --muted: #554E45;
      --rule: #D6CEBE;
      --accent: ${accent};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2.5rem 1.25rem 4rem;
      background: var(--paper);
      color: var(--ink);
      font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
      line-height: 1.65;
    }
    main {
      max-width: 44rem;
      margin: 0 auto;
      padding: 2.5rem 2.25rem;
      background: var(--card);
      border: 1px solid var(--rule);
      border-radius: 6px;
    }
    .kicker {
      margin: 0 0 0.5rem;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.78rem;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--accent);
    }
    h1 {
      margin: 0 0 0.75rem;
      font-size: 2rem;
      line-height: 1.2;
      color: var(--ink);
    }
    .lead {
      margin: 0 0 2rem;
      color: var(--muted);
      font-size: 1.05rem;
    }
    h2 {
      margin: 1.75rem 0 0.5rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--rule);
      font-size: 1.15rem;
      color: var(--ink);
    }
    p { margin: 0 0 0.9rem; }
    ul { margin: 0.5rem 0 1rem; padding-left: 1.35rem; }
    li { margin-bottom: 0.45rem; }
    footer {
      margin-top: 2rem;
      padding-top: 1.25rem;
      border-top: 1px solid var(--rule);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 0.88rem;
      color: var(--muted);
    }
    a { color: var(--accent); }
    @media (max-width: 600px) {
      main { padding: 1.75rem 1.25rem; }
      h1 { font-size: 1.6rem; }
    }
  </style>
</head>
<body>
  <main>
    <p class="kicker">${title}</p>
    <h1>Privacy Policy</h1>
    <p class="lead">${title} is a non-commercial, private family history archive maintained for members of the ${familyName} family.</p>

    <h2>Information Used for Sign-In</h2>
    <p>Access to this archive is restricted to invited family members and administrators. When you sign in with Google or a one-time magic-link email, this archive stores only your email address and display name.</p>
    <p>We use this information solely to verify your identity, maintain your session cookie, and attribute historical record edits or notes inside the archive.</p>

    <h2>Protection of Living Relatives</h2>
    <p>Living relatives are automatically protected throughout the archive. Public views redact living individuals, and automated privacy rules strip portraits and residence histories for living people.</p>

    <h2>No Advertising or Third-Party Sharing</h2>
    <ul>
      <li>This archive serves zero advertisements.</li>
      <li>This archive embeds zero tracking pixels or behavioral analytics trackers.</li>
      <li>Your email address, display name, and family records are never sold, rented, or shared with third-party data brokers.</li>
    </ul>

    <h2>Account Removal and Questions</h2>
    <p>To request account deletion, session revocation, or corrections to personal information, contact the archive administrator who provided your invitation.</p>

    <footer>
      <a href="/">Return to ${title}</a>
    </footer>
  </main>
</body>
</html>
`;
}

function createPrivacyPolicyResponse(siteConfig: KinloomSiteConfig, headOnly: boolean): Response {
  const html = renderPrivacyPolicyHtml(siteConfig);
  return new Response(headOnly ? null : html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    },
  });
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
      const url = new URL(request.url);
      if (
        (request.method === 'GET' || request.method === 'HEAD') &&
        (url.pathname === '/privacy' || url.pathname === '/privacy/')
      ) {
        return createPrivacyPolicyResponse(options.siteConfig, request.method === 'HEAD');
      }

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
          plugins: options.plugins,
        },
      });

      return server.fetch(request);
    },
  };
}
