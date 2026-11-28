import {
  compileArchive,
  extractCollectionsFromSnapshot,
  type KinloomServerPluginContext,
  type KinloomServerPluginReadonlySettingsContext,
  type KinloomServerPluginStatusContext,
  type PluginSettingScalarValue,
  type PluginSettingsSchema,
} from '@kinloom/core';
import { z } from 'zod';
import {
  base64UrlDecodeString,
  base64UrlEncodeBytes,
  base64UrlEncodeString,
  hmacSignBase64Url,
  hmacVerifyBase64Url,
  randomBase64Url,
  sha256Hex,
} from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';
import { jsonResponse } from '../../http/httpPrimitives.js';
import type { KinloomServerPlugin, KinloomServerPorts } from '../../http/pluginLifecycle.js';
import { KINLOOM_SERVER_VERSION } from '../../version.js';
import { compileArchivalBook } from './compiler.js';
import { computeCoverDimensionsOffline, resolveLuluPodPackageId } from './geometry.js';
import {
  BOOK_PUBLISHING_DATABASE_NAMESPACE,
  BOOK_PUBLISHING_PLUGIN_MIGRATIONS,
  type BookPublishingJobsStore,
  InMemoryBookPublishingJobsStore,
  SqlBookPublishingJobsStore,
} from './jobsStore.js';
import { createDeterministicPdfRenderer } from './pdfEngine.js';
import { BookPrivacyError } from './privacyGate.js';
import {
  createLuluBookPublisherAdapter,
  createMockBookPublisherAdapter,
  mapLuluStatusToBookPrintJobStatus,
} from './publishers.js';
import {
  BOOK_PUBLISHING_ARTIFACTS_ROUTE,
  BOOK_PUBLISHING_COMPILE_ROUTE,
  BOOK_PUBLISHING_ESTIMATE_ROUTE,
  BOOK_PUBLISHING_JOBS_ROUTE,
  BOOK_PUBLISHING_PLUGIN_ID,
  BOOK_PUBLISHING_STATUS_ROUTE,
  BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE,
  type BookBindingStyle,
  BookBindingStyleSchema,
  type BookBuildReport,
  BookEditionSchema,
  type BookPaperStock,
  BookPaperStockSchema,
  type BookPhysicalSpec,
  type BookPrintJobRecord,
  type BookPublisherEnvironment,
  BookPublisherEnvironmentSchema,
  type BookPublisherProvider,
  type BookPublisherProviderId,
  BookPublisherProviderIdSchema,
  BookShippingAddressSchema,
  type BookShippingLevel,
  BookShippingLevelSchema,
  type BookTrimPresetId,
  BookTrimPresetIdSchema,
  type PdfRendererPort,
} from './types.js';

export interface BookPublishingRuntimeConfig {
  readonly publisherProvider: BookPublisherProviderId;
  readonly environment: BookPublisherEnvironment;
  readonly defaultTrimPreset: BookTrimPresetId;
  readonly defaultBinding: BookBindingStyle;
  readonly defaultPaperStock: BookPaperStock;
  readonly defaultShippingLevel: BookShippingLevel;
  readonly contactEmail: string;
}

export interface BookPublishingServerPluginOptions {
  /**
   * When false, returns an inert disabled plugin with zero routes, zero settingsSchema,
   * and zero runtime footprint. Defaults to true when explicitly invoked.
   */
  readonly enabled?: boolean;
  readonly defaultProvider?: BookPublisherProviderId;
  readonly defaultEnvironment?: BookPublisherEnvironment;
  readonly defaultTrimPreset?: BookTrimPresetId;
  readonly defaultBinding?: BookBindingStyle;
  readonly defaultPaperStock?: BookPaperStock;
  readonly defaultShippingLevel?: BookShippingLevel;
  readonly defaultContactEmail?: string;
  /** Optional custom PDF renderer (defaults to pure-TS deterministic PDF renderer). */
  readonly pdfRenderer?: PdfRendererPort;
  /** Optional custom publisher factory override for tests or custom POD providers. */
  readonly publisherFactory?: (params: {
    readonly config: BookPublishingRuntimeConfig;
    readonly secrets: {
      readonly luluClientId: string | null;
      readonly luluClientSecret: string | null;
      readonly luluWebhookSecret: string | null;
    };
  }) => BookPublisherProvider;
  /** Optional fetch implementation forwarded to LuluBookPublisherAdapter. */
  readonly fetchImpl?: typeof fetch;
  /** Secret used to sign expiring artifact capability URLs (defaults to per-instance random secret). */
  readonly artifactSigningSecret?: string;
  /** Lifetime of signed artifact capability tokens in seconds (default: 7200 = 2 hours). */
  readonly artifactTokenTtlSeconds?: number;
}

const DEFAULT_ARTIFACT_TTL_SECONDS = 2 * 60 * 60;
const ARTIFACT_MEDIA_PREFIX = 'plugins/book-publishing/';
const SAFE_ARTIFACT_ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;

const CompileBookRequestSchema = z.object({
  title: z.string().trim().max(160).optional(),
  subtitle: z.string().trim().max(240).optional(),
  dedication: z.string().trim().max(600).optional(),
  trimPreset: BookTrimPresetIdSchema.optional(),
  binding: BookBindingStyleSchema.optional(),
  paperStock: BookPaperStockSchema.optional(),
  edition: BookEditionSchema.optional(),
  includeLiving: z.boolean().optional(),
  allowLivingPortraits: z.boolean().optional(),
  acknowledgeReviewFlags: z.boolean().optional(),
  branchId: z.string().trim().max(80).optional(),
  rootPersonId: z.string().trim().max(80).optional(),
  proofMarks: z.boolean().optional(),
  includeInlineBase64: z.boolean().optional(),
});

const EstimateBookRequestSchema = z.object({
  trimPreset: BookTrimPresetIdSchema.optional(),
  binding: BookBindingStyleSchema.optional(),
  paperStock: BookPaperStockSchema.optional(),
  interiorPageCount: z.number().int().min(24).max(800),
  quantity: z.number().int().min(1).max(250).default(1),
  shippingLevel: BookShippingLevelSchema.optional(),
  shippingAddress: BookShippingAddressSchema,
});

const CreatePrintJobRequestSchema = z.object({
  title: z.string().trim().max(160).optional(),
  subtitle: z.string().trim().max(240).optional(),
  dedication: z.string().trim().max(600).optional(),
  trimPreset: BookTrimPresetIdSchema.optional(),
  binding: BookBindingStyleSchema.optional(),
  paperStock: BookPaperStockSchema.optional(),
  edition: BookEditionSchema.optional(),
  includeLiving: z.boolean().optional(),
  allowLivingPortraits: z.boolean().optional(),
  acknowledgeReviewFlags: z.boolean().optional(),
  branchId: z.string().trim().max(80).optional(),
  rootPersonId: z.string().trim().max(80).optional(),
  quantity: z.number().int().min(1).max(250).default(1),
  shippingLevel: BookShippingLevelSchema.optional(),
  shippingAddress: BookShippingAddressSchema,
  contactEmail: z.string().trim().email().optional(),
  confirmProduction: z.boolean().optional(),
});

const LuluWebhookPayloadSchema = z.object({
  topic: z.string().optional(),
  data: z
    .object({
      id: z.union([z.number(), z.string()]).transform((v) => String(v)),
      status: z
        .union([
          z.string(),
          z.object({
            name: z.string(),
            message: z.string().optional(),
          }),
        ])
        .optional(),
      line_items: z
        .array(
          z.object({
            tracking_urls: z.array(z.string()).optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

interface ArtifactTokenPayload {
  readonly aid: string;
  readonly exp: number;
  readonly fn: string;
}

function sanitizePdfFilename(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 96);
  if (!cleaned) {
    return 'kinloom-book.pdf';
  }
  return cleaned.endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

function artifactMediaKey(artifactId: string): string {
  return `${ARTIFACT_MEDIA_PREFIX}${artifactId}.pdf`;
}

function buildBookPublishingSettingsSchema(initial: BookPublishingRuntimeConfig): PluginSettingsSchema {
  return {
    title: 'Archival Book Publishing & POD',
    description:
      'Generate print-ready landscape hardcover interior and cover PDFs and submit print-on-demand jobs through Lulu Print API or the offline mock sandbox.',
    sections: [
      {
        id: 'runtime_status',
        title: 'Publishing Runtime Status',
        description: 'Read-only status of the active publisher adapter, PDF renderer, and stored secrets.',
        fields: [
          {
            key: 'active_publisher',
            label: 'Active Publisher Adapter',
            type: 'readonly',
            defaultValue: initial.publisherProvider === 'lulu' ? `lulu-${initial.environment}` : 'mock',
          },
          {
            key: 'pdf_renderer',
            label: 'Active PDF Renderer',
            type: 'readonly',
            defaultValue: 'deterministic-pdf',
          },
          {
            key: 'configured_credentials',
            label: 'Configured Publisher Secrets',
            type: 'readonly',
            defaultValue: 'none stored',
          },
        ],
      },
      {
        id: 'publisher_config',
        title: 'Publisher & Prepress Defaults',
        description: 'Select the print-on-demand provider, sandbox/production mode, and default trim specs.',
        fields: [
          {
            key: 'publisher_provider',
            label: 'Publisher Provider',
            type: 'select',
            required: true,
            defaultValue: initial.publisherProvider,
            options: [
              { value: 'mock', label: 'Offline Mock Sandbox (Dry-Run)' },
              { value: 'lulu', label: 'Lulu Print API' },
            ],
          },
          {
            key: 'environment',
            label: 'Publisher Environment',
            type: 'select',
            required: true,
            defaultValue: initial.environment,
            options: [
              { value: 'sandbox', label: 'Sandbox (api.sandbox.lulu.com)' },
              { value: 'production', label: 'Production (api.lulu.com — Live Paid Orders)' },
            ],
          },
          {
            key: 'default_trim_preset',
            label: 'Default Landscape Trim Size',
            type: 'select',
            required: true,
            defaultValue: initial.defaultTrimPreset,
            options: [
              { value: 'us-letter-landscape', label: 'US Letter Landscape (11 × 8.5 in)' },
              { value: 'a4-landscape', label: 'A4 Landscape (11.69 × 8.27 in)' },
              { value: 'photo-10x8-landscape', label: 'Photo Landscape (10 × 8 in)' },
              { value: 'small-9x7-landscape', label: 'Small Landscape (9 × 7 in)' },
            ],
          },
          {
            key: 'default_binding',
            label: 'Default Hardcover Binding',
            type: 'select',
            required: true,
            defaultValue: initial.defaultBinding,
            options: [
              { value: 'hardcover-casewrap-glossy', label: 'Casewrap Glossy Hardcover' },
              { value: 'hardcover-casewrap-matte', label: 'Casewrap Matte Hardcover' },
            ],
          },
          {
            key: 'default_paper_stock',
            label: 'Default Interior Paper Stock',
            type: 'select',
            required: true,
            defaultValue: initial.defaultPaperStock,
            options: [
              { value: '80lb-coated-white-color', label: '80# Coated White Color (444 PPI)' },
              { value: '60lb-uncoated-white-color', label: '60# Uncoated White Color (380 PPI)' },
            ],
          },
          {
            key: 'default_shipping_level',
            label: 'Default Shipping Speed',
            type: 'select',
            required: true,
            defaultValue: initial.defaultShippingLevel,
            options: [
              { value: 'mail', label: 'Mail' },
              { value: 'ground', label: 'Ground' },
              { value: 'expedited', label: 'Expedited' },
              { value: 'express', label: 'Express' },
            ],
          },
          {
            key: 'contact_email',
            label: 'Publisher Contact Email',
            type: 'string',
            defaultValue: initial.contactEmail,
            placeholder: 'steward@archive.example',
            maxLength: 160,
            helpText: 'Email address receiving order validation and shipping notices from the publisher.',
            validate: (val) => {
              if (val === null || val === '') {
                return null;
              }
              if (typeof val !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim())) {
                return 'Publisher Contact Email must be a valid email address.';
              }
              return null;
            },
          },
        ],
      },
      {
        id: 'publisher_credentials',
        title: 'Publisher Credentials (Write-Only)',
        description:
          'Credentials are stored isolated from non-secret settings, masked in Admin UI, and never returned in plain text.',
        fields: [
          {
            key: 'lulu_client_id',
            label: 'Lulu API Client ID',
            type: 'string',
            secret: true,
            placeholder: 'Enter Lulu API Client Key / ID',
            minLength: 4,
            maxLength: 512,
            helpText: 'Write-only OAuth2 client ID from developers.lulu.com.',
          },
          {
            key: 'lulu_client_secret',
            label: 'Lulu API Client Secret',
            type: 'string',
            secret: true,
            placeholder: 'Enter Lulu API Client Secret',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only OAuth2 client secret from developers.lulu.com.',
          },
          {
            key: 'lulu_webhook_secret',
            label: 'Lulu Webhook Signing Secret',
            type: 'string',
            secret: true,
            placeholder: 'Enter Lulu Webhook HMAC Secret',
            minLength: 8,
            maxLength: 512,
            helpText: 'Write-only HMAC-SHA256 secret used to verify Lulu-HMAC-SHA256 webhook signatures.',
          },
        ],
      },
    ],
  };
}

function applySettingsValuesToConfig(
  values: Readonly<Record<string, PluginSettingScalarValue>>,
  fallback: BookPublishingRuntimeConfig
): BookPublishingRuntimeConfig {
  const providerParsed = BookPublisherProviderIdSchema.safeParse(values.publisher_provider);
  const envParsed = BookPublisherEnvironmentSchema.safeParse(values.environment);
  const trimParsed = BookTrimPresetIdSchema.safeParse(values.default_trim_preset);
  const bindingParsed = BookBindingStyleSchema.safeParse(values.default_binding);
  const paperParsed = BookPaperStockSchema.safeParse(values.default_paper_stock);
  const shippingParsed = BookShippingLevelSchema.safeParse(values.default_shipping_level);

  return {
    publisherProvider: providerParsed.success ? providerParsed.data : fallback.publisherProvider,
    environment: envParsed.success ? envParsed.data : fallback.environment,
    defaultTrimPreset: trimParsed.success ? trimParsed.data : fallback.defaultTrimPreset,
    defaultBinding: bindingParsed.success ? bindingParsed.data : fallback.defaultBinding,
    defaultPaperStock: paperParsed.success ? paperParsed.data : fallback.defaultPaperStock,
    defaultShippingLevel: shippingParsed.success ? shippingParsed.data : fallback.defaultShippingLevel,
    contactEmail:
      typeof values.contact_email === 'string' ? values.contact_email.trim() : fallback.contactEmail,
  };
}

function resolveActivePublisherLabel(config: BookPublishingRuntimeConfig): string {
  return config.publisherProvider === 'lulu' ? `lulu-${config.environment}` : 'mock';
}

function parseReferenceYear(iso: string): number {
  const yr = Number.parseInt(iso.slice(0, 4), 10);
  return Number.isInteger(yr) && yr >= 1900 ? yr : 2026;
}

/**
 * Optional, strictly off-by-default Kinloom server plugin for archival landscape hardcover
 * book compilation, prepress PDF export, and print-on-demand fulfillment (Lulu Print API + Mock).
 */
const BOOK_PUBLISHING_SERVER_DOCS = {
  id: 'docs-book-publishing-server',
  title: 'Archival Book Publishing (Server)',
  summary:
    'Compiles print-ready family history PDFs with strict living-person privacy gating and publisher export.',
  sections: [
    {
      id: 'compilation',
      heading: 'Print-Ready PDF Compilation',
      markdown:
        'Generates archival book interiors and covers from deceased branch records, narratives, and cited sources with deterministic trim-size geometry.',
    },
    {
      id: 'privacy-gate',
      heading: 'Mandatory Living-Person Privacy Gate',
      markdown:
        'Every book compilation job runs through the privacy gate so living relatives are never included in printed or exported artifacts.',
    },
  ],
} as const;

export function createBookPublishingServerPlugin(
  options: BookPublishingServerPluginOptions = {}
): KinloomServerPlugin {
  if (options.enabled === false) {
    return {
      id: BOOK_PUBLISHING_PLUGIN_ID,
      name: 'Archival Book Publishing (disabled)',
      documentation: BOOK_PUBLISHING_SERVER_DOCS,
      version: KINLOOM_SERVER_VERSION,
      status: 'disabled',
      getStatus: () => ({ status: 'disabled', detail: 'Disabled via plugin options' }),
    };
  }

  const initialConfig: BookPublishingRuntimeConfig = {
    publisherProvider: options.defaultProvider ?? 'mock',
    environment: options.defaultEnvironment ?? 'sandbox',
    defaultTrimPreset: options.defaultTrimPreset ?? 'us-letter-landscape',
    defaultBinding: options.defaultBinding ?? 'hardcover-casewrap-glossy',
    defaultPaperStock: options.defaultPaperStock ?? '80lb-coated-white-color',
    defaultShippingLevel: options.defaultShippingLevel ?? 'ground',
    contactEmail: options.defaultContactEmail ?? '',
  };
  let runtimeConfig: BookPublishingRuntimeConfig = { ...initialConfig };

  const pdfRenderer: PdfRendererPort = options.pdfRenderer ?? createDeterministicPdfRenderer();
  let fallbackRandomSigningSecret: string | null = options.artifactSigningSecret ?? null;
  async function resolveArtifactSigningSecret(
    ctx: Pick<KinloomServerPluginContext, 'derivePluginSigningKey'>
  ): Promise<string> {
    if (options.artifactSigningSecret) {
      return options.artifactSigningSecret;
    }
    if (typeof ctx.derivePluginSigningKey === 'function') {
      return ctx.derivePluginSigningKey('book-artifacts');
    }
    if (fallbackRandomSigningSecret === null) {
      fallbackRandomSigningSecret = randomBase64Url(32);
    }
    return fallbackRandomSigningSecret;
  }
  const artifactTokenTtlSeconds = options.artifactTokenTtlSeconds ?? DEFAULT_ARTIFACT_TTL_SECONDS;

  const settingsSchema = buildBookPublishingSettingsSchema(runtimeConfig);
  const mockPublisherSingleton = createMockBookPublisherAdapter();
  const fallbackJobsStore = new InMemoryBookPublishingJobsStore();

  function resolveJobsStore(ctx: Pick<KinloomServerPluginContext, 'pluginDb'>): BookPublishingJobsStore {
    if (ctx.pluginDb) {
      return new SqlBookPublishingJobsStore(ctx.pluginDb, fallbackJobsStore);
    }
    return fallbackJobsStore;
  }

  async function loadEffectiveConfigAndSecrets(ports: KinloomServerPorts): Promise<{
    readonly config: BookPublishingRuntimeConfig;
    readonly secrets: {
      readonly luluClientId: string | null;
      readonly luluClientSecret: string | null;
      readonly luluWebhookSecret: string | null;
    };
  }> {
    let config = runtimeConfig;
    let luluClientId: string | null = null;
    let luluClientSecret: string | null = null;
    let luluWebhookSecret: string | null = null;

    if (ports.pluginSettingsStore) {
      try {
        const stored = await ports.pluginSettingsStore.getSettings(BOOK_PUBLISHING_PLUGIN_ID);
        if (stored) {
          config = applySettingsValuesToConfig(stored.values, runtimeConfig);
        }
        if (typeof ports.pluginSettingsStore.getSecretValue === 'function') {
          [luluClientId, luluClientSecret, luluWebhookSecret] = await Promise.all([
            ports.pluginSettingsStore.getSecretValue(BOOK_PUBLISHING_PLUGIN_ID, 'lulu_client_id'),
            ports.pluginSettingsStore.getSecretValue(BOOK_PUBLISHING_PLUGIN_ID, 'lulu_client_secret'),
            ports.pluginSettingsStore.getSecretValue(BOOK_PUBLISHING_PLUGIN_ID, 'lulu_webhook_secret'),
          ]);
        }
      } catch {
        // Fall back to in-memory runtime config if settings store is unavailable.
      }
    }

    return {
      config,
      secrets: { luluClientId, luluClientSecret, luluWebhookSecret },
    };
  }

  function resolvePublisherProvider(params: {
    readonly config: BookPublishingRuntimeConfig;
    readonly secrets: {
      readonly luluClientId: string | null;
      readonly luluClientSecret: string | null;
      readonly luluWebhookSecret: string | null;
    };
  }): BookPublisherProvider {
    if (options.publisherFactory) {
      return options.publisherFactory(params);
    }
    if (params.config.publisherProvider === 'lulu') {
      if (!params.secrets.luluClientId || !params.secrets.luluClientSecret) {
        throw new KinloomHttpError(
          422,
          'BOOK_PUBLISHER_CREDENTIALS_MISSING',
          'Lulu Print API requires lulu_client_id and lulu_client_secret configured in Admin Plugin Settings.'
        );
      }
      return createLuluBookPublisherAdapter({
        environment: params.config.environment,
        clientId: params.secrets.luluClientId,
        clientSecret: params.secrets.luluClientSecret,
        webhookSecret: params.secrets.luluWebhookSecret ?? undefined,
        fetchImpl: options.fetchImpl,
      });
    }
    return mockPublisherSingleton;
  }

  async function storeSignedArtifact(params: {
    readonly ctx: KinloomServerPluginContext;
    readonly ports: KinloomServerPorts;
    readonly bytes: Uint8Array;
    readonly fileName: string;
    readonly nowMs: number;
  }): Promise<{ readonly artifactId: string; readonly token: string; readonly expiresAtIso: string }> {
    const artifactId = `art_${randomBase64Url(12)}`;
    const expiresAtMs = params.nowMs + artifactTokenTtlSeconds * 1000;
    const safeFileName = sanitizePdfFilename(params.fileName);
    const sha256 = await sha256Hex(params.bytes);
    const arrayBuffer = new Uint8Array(params.bytes).buffer;

    await params.ports.mediaStore.put({
      key: artifactMediaKey(artifactId),
      body: arrayBuffer,
      contentType: 'application/pdf',
      sha256,
    });

    const payloadJson = JSON.stringify({
      aid: artifactId,
      exp: expiresAtMs,
      fn: safeFileName,
    } satisfies ArtifactTokenPayload);
    const payloadB64 = base64UrlEncodeString(payloadJson);
    const signingKey = await resolveArtifactSigningSecret(params.ctx);
    const sig = await hmacSignBase64Url(signingKey, payloadB64);
    return {
      artifactId,
      token: `${payloadB64}.${sig}`,
      expiresAtIso: new Date(expiresAtMs).toISOString(),
    };
  }

  async function verifyArtifactToken(
    ctx: KinloomServerPluginContext,
    ports: KinloomServerPorts,
    token: string,
    nowMs: number
  ): Promise<{ readonly artifactId: string; readonly fileName: string } | null> {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }
    const [payloadB64, sig] = parts;
    if (!payloadB64 || !sig) {
      return null;
    }
    const signingKey = await resolveArtifactSigningSecret(ctx);
    const valid = await hmacVerifyBase64Url(signingKey, payloadB64, sig);
    if (!valid) {
      return null;
    }
    const decoded = base64UrlDecodeString(payloadB64);
    if (!decoded) {
      return null;
    }
    let parsed: ArtifactTokenPayload;
    try {
      const raw: unknown = JSON.parse(decoded);
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as Record<string, unknown>).aid !== 'string' ||
        typeof (raw as Record<string, unknown>).exp !== 'number'
      ) {
        return null;
      }
      const rawRec = raw as Record<string, unknown>;
      const aid = rawRec.aid as string;
      if (!SAFE_ARTIFACT_ID_PATTERN.test(aid)) {
        return null;
      }
      parsed = {
        aid,
        exp: rawRec.exp as number,
        fn: typeof rawRec.fn === 'string' ? sanitizePdfFilename(rawRec.fn) : 'kinloom-book.pdf',
      };
    } catch {
      return null;
    }
    if (nowMs > parsed.exp) {
      if (typeof ports.mediaStore.delete === 'function') {
        try {
          await ports.mediaStore.delete(artifactMediaKey(parsed.aid));
        } catch {
          // Best-effort cleanup of expired artifacts.
        }
      }
      return null;
    }
    return { artifactId: parsed.aid, fileName: parsed.fn };
  }

  async function deleteArtifactObjects(
    ports: KinloomServerPorts,
    artifactIds: readonly string[]
  ): Promise<void> {
    if (typeof ports.mediaStore.delete !== 'function' || artifactIds.length === 0) {
      return;
    }
    await Promise.all(
      artifactIds.map(async (id) => {
        try {
          await ports.mediaStore.delete?.(artifactMediaKey(id));
        } catch {
          // Best-effort R2 cleanup on revocation.
        }
      })
    );
  }

  async function loadArchiveBundleForBook(
    ports: KinloomServerPorts,
    siteConfig: Parameters<typeof compileArchive>[0]['siteConfig']
  ) {
    const snapshot = await ports.repository.loadActiveSnapshot();
    const collections = extractCollectionsFromSnapshot(snapshot);
    const nowIso = ports.clock.nowIso();
    // Compile in 'private' mode here so runBookPrivacyGate() has full visibility into living names
    // to scrub prose, strip portraits, and report accurate excludedLivingPeopleCount!
    const compiled = compileArchive({
      people: collections.people,
      events: collections.events,
      places: collections.places,
      sources: collections.sources,
      kinship: collections.kinship,
      media: collections.media,
      narratives: collections.narratives,
      siteConfig,
      mode: 'private',
      generatedAt: nowIso,
      referenceYear: parseReferenceYear(nowIso),
      maxRevisionId: snapshot.head_revision_id,
    });
    return compiled.bundle;
  }

  function mapPrivacyError(err: unknown): never {
    if (err instanceof BookPrivacyError) {
      throw new KinloomHttpError(422, err.code, err.message, {
        review_flags: err.reviewFlags,
      });
    }
    if (err instanceof RangeError) {
      throw new KinloomHttpError(422, 'BOOK_PREPRESS_ERROR', err.message);
    }
    throw err;
  }

  return {
    id: BOOK_PUBLISHING_PLUGIN_ID,
    name: 'Archival Book Publishing',
    documentation: BOOK_PUBLISHING_SERVER_DOCS,
    version: KINLOOM_SERVER_VERSION,
    status: 'active',
    databaseNamespace: BOOK_PUBLISHING_DATABASE_NAMESPACE,
    migrations: BOOK_PUBLISHING_PLUGIN_MIGRATIONS,
    settingsSchema,

    getStatus: async (ctx?: KinloomServerPluginStatusContext) => {
      let effective = runtimeConfig;
      if (ctx?.ports.pluginSettingsStore) {
        try {
          const stored = await ctx.ports.pluginSettingsStore.getSettings(BOOK_PUBLISHING_PLUGIN_ID);
          if (stored) {
            effective = applySettingsValuesToConfig(stored.values, initialConfig);
            runtimeConfig = effective;
          }
        } catch {
          // Keep in-memory fallback when settings store is unavailable.
        }
      }
      return {
        status: 'active',
        detail: `publisher=${resolveActivePublisherLabel(effective)}, renderer=${pdfRenderer.adapterKind}`,
      };
    },

    getReadonlySettings: (
      ctx: KinloomServerPluginReadonlySettingsContext
    ): Readonly<Record<string, PluginSettingScalarValue>> => {
      const effective = applySettingsValuesToConfig(ctx.values, initialConfig);
      const configured: string[] = [];
      for (const key of ['lulu_client_id', 'lulu_client_secret', 'lulu_webhook_secret'] as const) {
        if (ctx.configuredSecrets[key]) {
          configured.push(key);
        }
      }
      return {
        active_publisher: resolveActivePublisherLabel(effective),
        pdf_renderer: pdfRenderer.adapterKind,
        configured_credentials: configured.length > 0 ? configured.join(', ') : 'none stored',
      };
    },

    onSettingsUpdated: (event) => {
      runtimeConfig = applySettingsValuesToConfig(event.values, initialConfig);
    },

    routes: [
      {
        method: 'GET',
        pathPrefix: BOOK_PUBLISHING_STATUS_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== BOOK_PUBLISHING_STATUS_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const serverPorts = ctx.ports as KinloomServerPorts;
          const { config, secrets } = await loadEffectiveConfigAndSecrets(serverPorts);
          const bundle = await loadArchiveBundleForBook(serverPorts, ctx.siteConfig);
          const nowIso = serverPorts.clock.nowIso();

          let previewReport: BookBuildReport | null = null;
          try {
            const compiled = compileArchivalBook({
              bundle,
              siteConfig: ctx.siteConfig,
              options: {
                trimPreset: config.defaultTrimPreset,
                binding: config.defaultBinding,
                paperStock: config.defaultPaperStock,
                edition: 'public',
                acknowledgeReviewFlags: true,
                generatedAtIso: nowIso,
                referenceYear: parseReferenceYear(nowIso),
              },
            });
            previewReport = compiled.report;
          } catch {
            previewReport = null;
          }

          const jobsStore = resolveJobsStore(ctx);
          const jobs = await jobsStore.listJobs();

          return jsonResponse(
            {
              plugin_id: BOOK_PUBLISHING_PLUGIN_ID,
              active_publisher: resolveActivePublisherLabel(config),
              publisher_provider: config.publisherProvider,
              environment: config.environment,
              pdf_renderer: pdfRenderer.adapterKind,
              lulu_credentials_configured: Boolean(secrets.luluClientId && secrets.luluClientSecret),
              defaults: {
                trim_preset: config.defaultTrimPreset,
                binding: config.defaultBinding,
                paper_stock: config.defaultPaperStock,
                shipping_level: config.defaultShippingLevel,
                contact_email: config.contactEmail,
              },
              branches: ctx.siteConfig.branches.map((b) => ({ id: b.id, label: b.label })),
              readiness: previewReport
                ? {
                    included_people: previewReport.counts.includedPeople,
                    excluded_living_people: previewReport.counts.excludedLivingPeople,
                    included_media: previewReport.counts.includedMedia,
                    excluded_living_media: previewReport.counts.excludedLivingMedia,
                    estimated_pages: previewReport.counts.finalPageCount,
                    spine_width_in: previewReport.coverDimensions.spineWidthIn,
                    allow_spine_text: previewReport.coverDimensions.allowSpineText,
                    provider_sku: previewReport.coverDimensions.providerSku,
                    review_flags_detected: previewReport.privacy.reviewFlagsDetected,
                  }
                : null,
              jobs,
            },
            200,
            { 'cache-control': 'no-store' }
          );
        },
      },
      {
        method: 'POST',
        pathPrefix: BOOK_PUBLISHING_COMPILE_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== BOOK_PUBLISHING_COMPILE_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
          }
          let rawBody: unknown;
          try {
            rawBody = await ctx.request.json();
          } catch {
            throw new KinloomHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
          }
          const parsed = CompileBookRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            throw new KinloomHttpError(
              422,
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid book compile request.'
            );
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const { config } = await loadEffectiveConfigAndSecrets(serverPorts);
          const bundle = await loadArchiveBundleForBook(serverPorts, ctx.siteConfig);
          const nowIso = serverPorts.clock.nowIso();
          const nowMs = Date.parse(nowIso) || Date.now();

          let compiled: ReturnType<typeof compileArchivalBook>;
          try {
            compiled = compileArchivalBook({
              bundle,
              siteConfig: ctx.siteConfig,
              options: {
                title: parsed.data.title,
                subtitle: parsed.data.subtitle,
                dedication: parsed.data.dedication,
                trimPreset: parsed.data.trimPreset ?? config.defaultTrimPreset,
                binding: parsed.data.binding ?? config.defaultBinding,
                paperStock: parsed.data.paperStock ?? config.defaultPaperStock,
                edition: parsed.data.edition ?? 'public',
                includeLiving: parsed.data.includeLiving,
                allowLivingPortraits: parsed.data.allowLivingPortraits,
                acknowledgeReviewFlags: parsed.data.acknowledgeReviewFlags,
                branchId: parsed.data.branchId,
                rootPersonId: parsed.data.rootPersonId,
                proofMarks: parsed.data.proofMarks,
                generatedAtIso: nowIso,
                referenceYear: parseReferenceYear(nowIso),
              },
            });
          } catch (err) {
            mapPrivacyError(err);
          }

          const [interiorPdf, coverPdf] = await Promise.all([
            pdfRenderer.renderInterior(compiled),
            pdfRenderer.renderCover(compiled, compiled.report.coverDimensions),
          ]);

          const [interiorArtifact, coverArtifact] = await Promise.all([
            storeSignedArtifact({
              ctx,
              ports: serverPorts,
              bytes: interiorPdf,
              fileName: 'kinloom-book-interior.pdf',
              nowMs,
            }),
            storeSignedArtifact({
              ctx,
              ports: serverPorts,
              bytes: coverPdf,
              fileName: 'kinloom-book-cover.pdf',
              nowMs,
            }),
          ]);

          return jsonResponse(
            {
              report: compiled.report,
              renderer: pdfRenderer.adapterKind,
              artifacts: {
                interior_pdf_url: `${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/${interiorArtifact.token}`,
                cover_pdf_url: `${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/${coverArtifact.token}`,
                interior_bytes: interiorPdf.byteLength,
                cover_bytes: coverPdf.byteLength,
                expires_at: interiorArtifact.expiresAtIso,
                ...(parsed.data.includeInlineBase64
                  ? {
                      interior_pdf_base64: base64UrlEncodeBytes(interiorPdf),
                      cover_pdf_base64: base64UrlEncodeBytes(coverPdf),
                    }
                  : {}),
              },
              preview: {
                interior_html: compiled.interiorHtml,
                cover_html: compiled.coverHtml,
              },
            },
            200,
            { 'cache-control': 'no-store' }
          );
        },
      },
      {
        method: 'POST',
        pathPrefix: BOOK_PUBLISHING_ESTIMATE_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== BOOK_PUBLISHING_ESTIMATE_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
          }
          let rawBody: unknown;
          try {
            rawBody = await ctx.request.json();
          } catch {
            throw new KinloomHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
          }
          const parsed = EstimateBookRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            throw new KinloomHttpError(
              422,
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid cost estimate request.'
            );
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await loadEffectiveConfigAndSecrets(serverPorts);
          const provider = resolvePublisherProvider(state);
          const spec: BookPhysicalSpec = {
            trimPreset: parsed.data.trimPreset ?? state.config.defaultTrimPreset,
            binding: parsed.data.binding ?? state.config.defaultBinding,
            paperStock: parsed.data.paperStock ?? state.config.defaultPaperStock,
            interiorPageCount:
              parsed.data.interiorPageCount % 2 === 0
                ? parsed.data.interiorPageCount
                : parsed.data.interiorPageCount + 1,
          };

          const [coverDimensions, quote] = await Promise.all([
            provider.getCoverDimensions(spec),
            provider.estimateCost({
              spec,
              quantity: parsed.data.quantity,
              shippingAddress: parsed.data.shippingAddress,
              shippingLevel: parsed.data.shippingLevel ?? state.config.defaultShippingLevel,
            }),
          ]);

          return jsonResponse({ quote, cover_dimensions: coverDimensions }, 200, {
            'cache-control': 'no-store',
          });
        },
      },
      {
        method: 'POST',
        pathPrefix: BOOK_PUBLISHING_JOBS_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== BOOK_PUBLISHING_JOBS_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
          }
          let rawBody: unknown;
          try {
            rawBody = await ctx.request.json();
          } catch {
            throw new KinloomHttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
          }
          const parsed = CreatePrintJobRequestSchema.safeParse(rawBody);
          if (!parsed.success) {
            throw new KinloomHttpError(
              422,
              'VALIDATION_ERROR',
              parsed.error.issues[0]?.message ?? 'Invalid print job request.'
            );
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await loadEffectiveConfigAndSecrets(serverPorts);
          const provider = resolvePublisherProvider(state);

          if (!provider.sandbox && parsed.data.confirmProduction !== true) {
            throw new KinloomHttpError(
              422,
              'PRODUCTION_CONFIRMATION_REQUIRED',
              'Live production print orders require explicit confirmProduction=true.'
            );
          }

          const contactEmail =
            parsed.data.contactEmail ??
            state.config.contactEmail ??
            (ctx.principal.kind === 'user' ? ctx.principal.email : '');
          if (!contactEmail) {
            throw new KinloomHttpError(
              422,
              'CONTACT_EMAIL_REQUIRED',
              'Provide a contactEmail or configure Publisher Contact Email in Admin Plugin Settings.'
            );
          }

          const bundle = await loadArchiveBundleForBook(serverPorts, ctx.siteConfig);
          const nowIso = serverPorts.clock.nowIso();
          const nowMs = Date.parse(nowIso) || Date.now();

          let compiled: ReturnType<typeof compileArchivalBook>;
          try {
            compiled = compileArchivalBook({
              bundle,
              siteConfig: ctx.siteConfig,
              options: {
                title: parsed.data.title,
                subtitle: parsed.data.subtitle,
                dedication: parsed.data.dedication,
                trimPreset: parsed.data.trimPreset ?? state.config.defaultTrimPreset,
                binding: parsed.data.binding ?? state.config.defaultBinding,
                paperStock: parsed.data.paperStock ?? state.config.defaultPaperStock,
                edition: parsed.data.edition ?? 'public',
                includeLiving: parsed.data.includeLiving,
                allowLivingPortraits: parsed.data.allowLivingPortraits,
                acknowledgeReviewFlags: parsed.data.acknowledgeReviewFlags,
                branchId: parsed.data.branchId,
                rootPersonId: parsed.data.rootPersonId,
                proofMarks: false,
                generatedAtIso: nowIso,
                referenceYear: parseReferenceYear(nowIso),
              },
            });
          } catch (err) {
            mapPrivacyError(err);
          }

          const authoritativeCover = await provider.getCoverDimensions(compiled.report.spec);
          const [interiorPdf, coverPdf] = await Promise.all([
            pdfRenderer.renderInterior(compiled),
            pdfRenderer.renderCover(compiled, authoritativeCover),
          ]);

          const externalId = `kinloom-book-${randomBase64Url(8)}`;
          const [interiorArtifact, coverArtifact] = await Promise.all([
            storeSignedArtifact({
              ctx,
              ports: serverPorts,
              bytes: interiorPdf,
              fileName: `${externalId}-interior.pdf`,
              nowMs,
            }),
            storeSignedArtifact({
              ctx,
              ports: serverPorts,
              bytes: coverPdf,
              fileName: `${externalId}-cover.pdf`,
              nowMs,
            }),
          ]);
          const createdArtifactIds = [interiorArtifact.artifactId, coverArtifact.artifactId];

          const interiorPdfUrl = `${ctx.url.origin}${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/${interiorArtifact.token}`;
          const coverPdfUrl = `${ctx.url.origin}${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/${coverArtifact.token}`;

          const validation = await provider.validateInteriorAndCover({
            spec: compiled.report.spec,
            interiorPdfUrl,
            coverPdfUrl,
          });
          if (!validation.interior.ok || !validation.cover.ok) {
            await deleteArtifactObjects(serverPorts, createdArtifactIds);
            throw new KinloomHttpError(
              422,
              'BOOK_PREFLIGHT_FAILED',
              'Publisher preflight validation failed.',
              {
                interior: validation.interior,
                cover: validation.cover,
              }
            );
          }

          const job = await provider.createPrintJob({
            externalId,
            title: compiled.report.title,
            contactEmail,
            spec: compiled.report.spec,
            quantity: parsed.data.quantity,
            interiorPdfUrl,
            coverPdfUrl,
            shippingAddress: parsed.data.shippingAddress,
            shippingLevel: parsed.data.shippingLevel ?? state.config.defaultShippingLevel,
          });

          const jobsStore = resolveJobsStore(ctx);
          await jobsStore.upsertJob(job, createdArtifactIds);

          return jsonResponse(
            {
              job,
              validation,
              report: compiled.report,
            },
            201,
            { 'cache-control': 'no-store' }
          );
        },
      },
      {
        method: 'GET',
        pathPrefix: BOOK_PUBLISHING_JOBS_ROUTE,
        minRole: 'admin',
        async handle(ctx): Promise<Response> {
          const cleanPath = ctx.url.pathname.replace(/\/+$/, '');
          const jobsStore = resolveJobsStore(ctx);
          if (cleanPath === BOOK_PUBLISHING_JOBS_ROUTE) {
            const jobs = await jobsStore.listJobs();
            return jsonResponse({ jobs }, 200, {
              'cache-control': 'no-store',
            });
          }
          if (!cleanPath.startsWith(`${BOOK_PUBLISHING_JOBS_ROUTE}/`)) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const jobId = decodeURIComponent(cleanPath.slice(BOOK_PUBLISHING_JOBS_ROUTE.length + 1));
          if (!jobId || jobId.includes('/')) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }

          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await loadEffectiveConfigAndSecrets(serverPorts);
          const provider = resolvePublisherProvider(state);
          const existingRow = await jobsStore.getJob(jobId);
          const existing = existingRow?.job;
          try {
            const refreshed = await provider.getPrintJobStatus(jobId);
            const merged: BookPrintJobRecord = existing
              ? {
                  ...existing,
                  status: refreshed.status,
                  statusDetail: refreshed.statusDetail ?? existing.statusDetail,
                  trackingUrls:
                    refreshed.trackingUrls.length > 0 ? refreshed.trackingUrls : existing.trackingUrls,
                  updatedAt: refreshed.updatedAt,
                }
              : refreshed;
            await jobsStore.upsertJob(merged);
            return jsonResponse({ job: merged }, 200, { 'cache-control': 'no-store' });
          } catch (err) {
            if (existing) {
              return jsonResponse({ job: existing }, 200, { 'cache-control': 'no-store' });
            }
            throw new KinloomHttpError(
              404,
              'PRINT_JOB_NOT_FOUND',
              err instanceof Error ? err.message : `Print job '${jobId}' was not found.`
            );
          }
        },
      },
      {
        method: 'GET',
        pathPrefix: BOOK_PUBLISHING_ARTIFACTS_ROUTE,
        minRole: 'public',
        async handle(ctx): Promise<Response> {
          const cleanPath = ctx.url.pathname.replace(/\/+$/, '');
          if (!cleanPath.startsWith(`${BOOK_PUBLISHING_ARTIFACTS_ROUTE}/`)) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route GET ${ctx.url.pathname} was not found.`);
          }
          const token = cleanPath.slice(BOOK_PUBLISHING_ARTIFACTS_ROUTE.length + 1);
          const serverPorts = ctx.ports as KinloomServerPorts;
          const nowMs = Date.parse(serverPorts.clock.nowIso()) || Date.now();
          const verified = await verifyArtifactToken(ctx, serverPorts, token, nowMs);
          if (!verified) {
            throw new KinloomHttpError(
              401,
              'INVALID_ARTIFACT_TOKEN',
              'Book artifact token is invalid, expired, or revoked.'
            );
          }
          const stored = await serverPorts.mediaStore.get(artifactMediaKey(verified.artifactId));
          if (!stored) {
            throw new KinloomHttpError(
              401,
              'INVALID_ARTIFACT_TOKEN',
              'Book artifact token is invalid, expired, or revoked.'
            );
          }
          return new Response(stored.body, {
            status: 200,
            headers: {
              'content-type': 'application/pdf',
              'content-disposition': `inline; filename="${verified.fileName}"`,
              'cache-control': 'no-store',
              'x-robots-tag': 'noindex, nofollow',
            },
          });
        },
      },
      {
        method: 'POST',
        pathPrefix: BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE,
        minRole: 'public',
        async handle(ctx): Promise<Response> {
          if (ctx.url.pathname.replace(/\/+$/, '') !== BOOK_PUBLISHING_WEBHOOK_LULU_ROUTE) {
            throw new KinloomHttpError(404, 'NOT_FOUND', `Route POST ${ctx.url.pathname} was not found.`);
          }
          const rawBytes = new Uint8Array(await ctx.request.arrayBuffer());
          const serverPorts = ctx.ports as KinloomServerPorts;
          const state = await loadEffectiveConfigAndSecrets(serverPorts);

          const verifier =
            state.config.publisherProvider === 'lulu' &&
            state.secrets.luluClientId &&
            state.secrets.luluClientSecret
              ? resolvePublisherProvider(state)
              : createMockBookPublisherAdapter({
                  webhookSecret: state.secrets.luluWebhookSecret ?? undefined,
                });

          const verified = verifier.verifyWebhookSignature
            ? await verifier.verifyWebhookSignature(rawBytes, ctx.request.headers)
            : false;
          if (!verified) {
            throw new KinloomHttpError(
              401,
              'INVALID_WEBHOOK_SIGNATURE',
              'Webhook signature verification failed.'
            );
          }

          let rawJson: unknown;
          try {
            rawJson = JSON.parse(new TextDecoder().decode(rawBytes));
          } catch {
            throw new KinloomHttpError(400, 'INVALID_JSON', 'Webhook body must be valid JSON.');
          }
          const parsed = LuluWebhookPayloadSchema.safeParse(rawJson);
          if (!parsed.success || !parsed.data.data) {
            return jsonResponse({ accepted: true, updated: false }, 200, { 'cache-control': 'no-store' });
          }

          const jobId = parsed.data.data.id;
          const rawStatus = parsed.data.data.status;
          const statusName = typeof rawStatus === 'string' ? rawStatus : (rawStatus?.name ?? 'CREATED');
          const statusDetail = typeof rawStatus === 'object' ? rawStatus?.message : undefined;
          const mappedStatus = mapLuluStatusToBookPrintJobStatus(statusName);
          const trackingUrls = (parsed.data.data.line_items ?? []).flatMap((li) => li.tracking_urls ?? []);
          const nowIso = serverPorts.clock.nowIso();

          const jobsStore = resolveJobsStore(ctx);
          const existingRow = await jobsStore.getJob(jobId);
          const existing = existingRow?.job;
          if (existing) {
            await jobsStore.upsertJob({
              ...existing,
              status: mappedStatus,
              statusDetail: statusDetail ?? existing.statusDetail,
              trackingUrls: trackingUrls.length > 0 ? trackingUrls : existing.trackingUrls,
              updatedAt: nowIso,
            });
          } else {
            const defaultSpec: BookPhysicalSpec = {
              trimPreset: state.config.defaultTrimPreset,
              binding: state.config.defaultBinding,
              paperStock: state.config.defaultPaperStock,
              interiorPageCount: 24,
            };
            const offlineCover = computeCoverDimensionsOffline(
              defaultSpec,
              resolveLuluPodPackageId(defaultSpec)
            );
            await jobsStore.upsertJob({
              providerId: resolveActivePublisherLabel(state.config),
              jobId,
              externalId: jobId,
              title: `Print Job ${jobId} (${offlineCover.providerSku})`,
              status: mappedStatus,
              statusDetail,
              trackingUrls,
              sandbox: state.config.environment === 'sandbox',
              quantity: 1,
              spec: defaultSpec,
              updatedAt: nowIso,
            });
          }

          // Revoke single-job capability artifact URLs as soon as publisher has ingested files.
          if (
            mappedStatus === 'ready_for_production' ||
            mappedStatus === 'in_production' ||
            mappedStatus === 'shipped' ||
            mappedStatus === 'canceled' ||
            mappedStatus === 'rejected'
          ) {
            const artifactIds = await jobsStore.clearArtifactIds(jobId);
            await deleteArtifactObjects(serverPorts, artifactIds);
          }

          return jsonResponse(
            {
              accepted: true,
              updated: true,
              job_id: jobId,
              status: mappedStatus,
            },
            200,
            { 'cache-control': 'no-store' }
          );
        },
      },
    ],
  };
}
