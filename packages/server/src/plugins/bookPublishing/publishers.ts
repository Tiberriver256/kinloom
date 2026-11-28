import { z } from 'zod';
import { toHex } from '../../crypto.js';
import {
  buildCoverDimensionsFromValues,
  computeCoverDimensionsOffline,
  computeOfflineSpineWidthIn,
  resolveLuluPodPackageId,
} from './geometry.js';
import type {
  BookPhysicalSpec,
  BookPrintJobRecord,
  BookPrintJobRequest,
  BookPrintJobStatus,
  BookPublisherEnvironment,
  BookPublisherProvider,
  BookQuoteRequest,
  BookQuoteResult,
  BookShippingLevel,
  BookValidationResult,
  CoverDimensionsResult,
} from './types.js';

export const LULU_SANDBOX_BASE_URL = 'https://api.sandbox.lulu.com';
export const LULU_PRODUCTION_BASE_URL = 'https://api.lulu.com';
const LULU_TOKEN_PATH = '/auth/realms/glasstree/protocol/openid-connect/token';
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

const TEXT_ENCODER = new TextEncoder();

export function parseDecimalDollarsToCents(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) {
    return 0;
  }
  const str = typeof raw === 'number' ? raw.toFixed(2) : raw.trim();
  if (!str) {
    return 0;
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(str);
  const wholeStr = match?.[2];
  if (!match || !wholeStr) {
    throw new RangeError(`Invalid decimal currency amount: '${raw}'.`);
  }
  const sign = match[1] ? -1 : 1;
  const whole = Number.parseInt(wholeStr, 10);
  const fracRaw = match[3] ?? '';
  const fracPadded = `${fracRaw}00`;
  const fracCents = Number.parseInt(fracPadded.slice(0, 2), 10);
  const roundUp = fracPadded.length > 2 && Number.parseInt(fracPadded.charAt(2), 10) >= 5 ? 1 : 0;
  return sign * (whole * 100 + fracCents + roundUp);
}

function mapShippingLevelToLulu(level: BookShippingLevel): string {
  switch (level) {
    case 'mail':
      return 'MAIL';
    case 'ground':
      return 'GROUND_HD';
    case 'expedited':
      return 'EXPEDITED';
    case 'express':
      return 'EXPRESS';
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

export function mapLuluStatusToBookPrintJobStatus(rawStatus: string): BookPrintJobStatus {
  const normalized = rawStatus.trim().toUpperCase();
  switch (normalized) {
    case 'CREATED':
    case 'UNPAID':
    case 'PAYMENT_IN_PROGRESS':
      return 'created';
    case 'VALIDATING':
    case 'NORMALIZING':
      return 'validating';
    case 'PRODUCTION_READY':
    case 'PRODUCTION_DELAYED':
      return 'ready_for_production';
    case 'IN_PRODUCTION':
      return 'in_production';
    case 'SHIPPED':
      return 'shipped';
    case 'REJECTED':
    case 'ERROR':
      return 'rejected';
    case 'CANCELED':
    case 'CANCELLED':
      return 'canceled';
    default:
      return 'created';
  }
}

function mapLuluValidationStatus(rawStatus: string): BookValidationResult['status'] {
  const normalized = rawStatus.trim().toUpperCase();
  if (normalized === 'NORMALIZED') {
    return 'normalized';
  }
  if (normalized === 'VALIDATED') {
    return 'validated';
  }
  if (normalized === 'VALIDATING' || normalized === 'NORMALIZING') {
    return 'validating';
  }
  return 'error';
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().toLowerCase();
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/.test(clean)) {
    return null;
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(encoded: string): Uint8Array | null {
  try {
    const clean = encoded.trim();
    if (!clean) {
      return null;
    }
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export async function signLuluWebhookHmacHex(secret: string, rawBody: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const bodyBuf = new Uint8Array(rawBody).buffer;
  const sig = await crypto.subtle.sign('HMAC', key, bodyBuf);
  return toHex(new Uint8Array(sig));
}

export async function verifyLuluWebhookHmac(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | null
): Promise<boolean> {
  if (!secret || !signatureHeader) {
    return false;
  }
  const candidate = signatureHeader.trim();
  const sigBytes = hexToBytes(candidate) ?? base64ToBytes(candidate);
  if (sigBytes?.byteLength !== 32) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    'raw',
    TEXT_ENCODER.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const sigBuf = new Uint8Array(sigBytes).buffer;
  const bodyBuf = new Uint8Array(rawBody).buffer;
  return crypto.subtle.verify('HMAC', key, sigBuf, bodyBuf);
}

const LuluTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  token_type: z.string().optional(),
});

const LuluCoverDimensionsResponseSchema = z.object({
  width: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  height: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  unit: z.string().optional(),
});

const LuluCostResponseSchema = z.object({
  currency: z.string().default('USD'),
  total_cost_excl_tax: z.union([z.string(), z.number()]).optional(),
  total_cost_incl_tax: z.union([z.string(), z.number()]).optional(),
  total_tax: z.union([z.string(), z.number()]).optional(),
  line_item_costs: z
    .array(
      z.object({
        total_cost_excl_tax: z.union([z.string(), z.number()]).optional(),
      })
    )
    .optional(),
  shipping_cost: z
    .object({
      total_cost_excl_tax: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
  fulfillment_cost: z
    .object({
      total_cost_excl_tax: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

const LuluValidationResponseSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  status: z.string(),
  errors: z.array(z.string()).optional().default([]),
  warnings: z.array(z.string()).optional().default([]),
});

const LuluPrintJobResponseSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((v) => String(v)),
  external_id: z.string().optional().default(''),
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
        title: z.string().optional(),
        quantity: z.number().int().positive().optional(),
        tracking_urls: z.array(z.string()).optional(),
      })
    )
    .optional()
    .default([]),
  date_modified: z.string().optional(),
});

export interface LuluBookPublisherOptions {
  readonly environment: BookPublisherEnvironment;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly webhookSecret?: string | undefined;
  readonly baseUrlOverride?: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly nowMs?: () => number;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

/**
 * First-class Lulu Print API adapter (OAuth2 client_credentials, cached token with 401 refresh,
 * landscape Casewrap hardcover SKUs, preflight validation, cost quotes, and HMAC-SHA256 webhooks).
 */
export function createLuluBookPublisherAdapter(options: LuluBookPublisherOptions): BookPublisherProvider {
  const sandbox = options.environment === 'sandbox';
  const baseUrl = trimTrailingSlashes(
    options.baseUrlOverride ?? (sandbox ? LULU_SANDBOX_BASE_URL : LULU_PRODUCTION_BASE_URL)
  );
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const nowMs = options.nowMs ?? (() => Date.now());

  let cachedToken: { readonly token: string; readonly expiresAtMs: number } | null = null;

  async function fetchAccessToken(): Promise<string> {
    if (cachedToken && nowMs() < cachedToken.expiresAtMs) {
      return cachedToken.token;
    }
    const basicCreds = btoa(`${options.clientId}:${options.clientSecret}`);
    const res = await fetchImpl(`${baseUrl}${LULU_TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicCreds}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Lulu OAuth token request failed (${res.status}): ${errBody.slice(0, 200)}`);
    }
    const parsed = LuluTokenResponseSchema.parse(await res.json());
    cachedToken = {
      token: parsed.access_token,
      expiresAtMs: nowMs() + Math.max(10_000, parsed.expires_in * 1000 - TOKEN_EXPIRY_BUFFER_MS),
    };
    return parsed.access_token;
  }

  async function authorizedJson<T>(method: 'GET' | 'POST', endpointPath: string, body?: unknown): Promise<T> {
    const attempt = async (forceRefresh: boolean): Promise<Response> => {
      if (forceRefresh) {
        cachedToken = null;
      }
      const token = await fetchAccessToken();
      return fetchImpl(`${baseUrl}${endpointPath}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    };

    let res = await attempt(false);
    if (res.status === 401) {
      res = await attempt(true);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Lulu API ${method} ${endpointPath} failed (${res.status}): ${detail.slice(0, 240)}`);
    }
    return (await res.json()) as T;
  }

  const providerId = sandbox ? 'lulu-sandbox' : 'lulu-production';

  return {
    id: providerId,
    displayName: sandbox ? 'Lulu Print API (Sandbox)' : 'Lulu Print API (Production)',
    sandbox,

    resolveProviderSku(spec: BookPhysicalSpec): string {
      return resolveLuluPodPackageId(spec);
    },

    async getCoverDimensions(spec: BookPhysicalSpec): Promise<CoverDimensionsResult> {
      const sku = resolveLuluPodPackageId(spec);
      const raw = await authorizedJson<unknown>('POST', '/cover-dimensions/', {
        pod_package_id: sku,
        interior_page_count: spec.interiorPageCount,
        unit: 'inch',
      });
      const parsed = LuluCoverDimensionsResponseSchema.parse(raw);
      const offline = computeCoverDimensionsOffline(spec, sku);
      const inferredSpine = Math.max(0.25, parsed.width - (offline.totalWidthIn - offline.spineWidthIn));
      return buildCoverDimensionsFromValues({
        spec,
        totalWidthIn: parsed.width,
        totalHeightIn: parsed.height,
        spineWidthIn: inferredSpine,
        source: 'provider_api',
        providerSku: sku,
      });
    },

    async estimateCost(request: BookQuoteRequest): Promise<BookQuoteResult> {
      const sku = resolveLuluPodPackageId(request.spec);
      const raw = await authorizedJson<unknown>('POST', '/print-job-cost-calculations/', {
        line_items: [
          {
            page_count: request.spec.interiorPageCount,
            pod_package_id: sku,
            quantity: request.quantity,
          },
        ],
        shipping_address: {
          name: request.shippingAddress.name,
          street1: request.shippingAddress.street1,
          ...(request.shippingAddress.street2 ? { street2: request.shippingAddress.street2 } : {}),
          city: request.shippingAddress.city,
          ...(request.shippingAddress.stateCode ? { state_code: request.shippingAddress.stateCode } : {}),
          country_code: request.shippingAddress.countryCode,
          postcode: request.shippingAddress.postalCode,
          phone_number: request.shippingAddress.phoneNumber,
        },
        shipping_option: mapShippingLevelToLulu(request.shippingLevel),
      });
      const parsed = LuluCostResponseSchema.parse(raw);
      const manufacturingCostCents = (parsed.line_item_costs ?? []).reduce(
        (sum, item) => sum + parseDecimalDollarsToCents(item.total_cost_excl_tax),
        0
      );
      const shippingCostCents = parseDecimalDollarsToCents(parsed.shipping_cost?.total_cost_excl_tax);
      const fulfillmentFeeCents = parseDecimalDollarsToCents(parsed.fulfillment_cost?.total_cost_excl_tax);
      const taxCents = parseDecimalDollarsToCents(parsed.total_tax);
      const totalCostCents =
        parsed.total_cost_incl_tax !== undefined
          ? parseDecimalDollarsToCents(parsed.total_cost_incl_tax)
          : manufacturingCostCents + shippingCostCents + fulfillmentFeeCents + taxCents;

      return {
        providerId,
        providerSku: sku,
        currency: parsed.currency,
        manufacturingCostCents,
        shippingCostCents,
        fulfillmentFeeCents,
        taxCents,
        totalCostCents,
        sandbox,
      };
    },

    async validateInteriorAndCover(params: {
      readonly spec: BookPhysicalSpec;
      readonly interiorPdfUrl: string;
      readonly coverPdfUrl: string;
    }): Promise<{ readonly interior: BookValidationResult; readonly cover: BookValidationResult }> {
      const sku = resolveLuluPodPackageId(params.spec);
      const [rawInterior, rawCover] = await Promise.all([
        authorizedJson<unknown>('POST', '/validate-interior/', {
          source_url: params.interiorPdfUrl,
          pod_package_id: sku,
        }),
        authorizedJson<unknown>('POST', '/validate-cover/', {
          source_url: params.coverPdfUrl,
          pod_package_id: sku,
          interior_page_count: params.spec.interiorPageCount,
        }),
      ]);

      const interiorParsed = LuluValidationResponseSchema.parse(rawInterior);
      const coverParsed = LuluValidationResponseSchema.parse(rawCover);
      const interiorStatus = mapLuluValidationStatus(interiorParsed.status);
      const coverStatus = mapLuluValidationStatus(coverParsed.status);

      return {
        interior: {
          ok: interiorStatus !== 'error' && interiorParsed.errors.length === 0,
          status: interiorStatus,
          validationId: interiorParsed.id,
          errors: interiorParsed.errors,
          warnings: interiorParsed.warnings,
        },
        cover: {
          ok: coverStatus !== 'error' && coverParsed.errors.length === 0,
          status: coverStatus,
          validationId: coverParsed.id,
          errors: coverParsed.errors,
          warnings: coverParsed.warnings,
        },
      };
    },

    async createPrintJob(request: BookPrintJobRequest): Promise<BookPrintJobRecord> {
      const sku = resolveLuluPodPackageId(request.spec);
      const raw = await authorizedJson<unknown>('POST', '/print-jobs/', {
        external_id: request.externalId,
        contact_email: request.contactEmail,
        shipping_level: mapShippingLevelToLulu(request.shippingLevel),
        shipping_address: {
          name: request.shippingAddress.name,
          street1: request.shippingAddress.street1,
          ...(request.shippingAddress.street2 ? { street2: request.shippingAddress.street2 } : {}),
          city: request.shippingAddress.city,
          ...(request.shippingAddress.stateCode ? { state_code: request.shippingAddress.stateCode } : {}),
          country_code: request.shippingAddress.countryCode,
          postcode: request.shippingAddress.postalCode,
          phone_number: request.shippingAddress.phoneNumber,
        },
        line_items: [
          {
            external_id: `${request.externalId}-item-1`,
            title: request.title,
            quantity: request.quantity,
            printable_normalization: {
              pod_package_id: sku,
              interior: { source_url: request.interiorPdfUrl },
              cover: { source_url: request.coverPdfUrl },
            },
          },
        ],
      });
      const parsed = LuluPrintJobResponseSchema.parse(raw);
      const rawStatusName =
        typeof parsed.status === 'string' ? parsed.status : (parsed.status?.name ?? 'CREATED');
      const statusDetail = typeof parsed.status === 'object' ? parsed.status?.message : undefined;
      const trackingUrls = parsed.line_items.flatMap((li) => li.tracking_urls ?? []);

      return {
        providerId,
        jobId: parsed.id,
        externalId: parsed.external_id || request.externalId,
        title: parsed.line_items[0]?.title ?? request.title,
        status: mapLuluStatusToBookPrintJobStatus(rawStatusName),
        statusDetail,
        trackingUrls,
        sandbox,
        quantity: parsed.line_items[0]?.quantity ?? request.quantity,
        spec: request.spec,
        updatedAt: parsed.date_modified ?? new Date(nowMs()).toISOString(),
      };
    },

    async getPrintJobStatus(jobId: string): Promise<BookPrintJobRecord> {
      const raw = await authorizedJson<unknown>('GET', `/print-jobs/${encodeURIComponent(jobId)}/`);
      const parsed = LuluPrintJobResponseSchema.parse(raw);
      const rawStatusName =
        typeof parsed.status === 'string' ? parsed.status : (parsed.status?.name ?? 'CREATED');
      const statusDetail = typeof parsed.status === 'object' ? parsed.status?.message : undefined;
      const trackingUrls = parsed.line_items.flatMap((li) => li.tracking_urls ?? []);

      return {
        providerId,
        jobId: parsed.id,
        externalId: parsed.external_id,
        title: parsed.line_items[0]?.title ?? 'Archival Hardcover Book',
        status: mapLuluStatusToBookPrintJobStatus(rawStatusName),
        statusDetail,
        trackingUrls,
        sandbox,
        quantity: parsed.line_items[0]?.quantity ?? 1,
        spec: {
          trimPreset: 'us-letter-landscape',
          binding: 'hardcover-casewrap-glossy',
          paperStock: '80lb-coated-white-color',
          interiorPageCount: 24,
        },
        updatedAt: parsed.date_modified ?? new Date(nowMs()).toISOString(),
      };
    },

    async verifyWebhookSignature(rawBody: Uint8Array, headers: Headers): Promise<boolean> {
      const headerValue = headers.get('lulu-hmac-sha256') ?? headers.get('Lulu-HMAC-SHA256');
      return verifyLuluWebhookHmac(options.webhookSecret ?? '', rawBody, headerValue);
    },
  };
}

export interface MockBookPublisherOptions {
  readonly webhookSecret?: string | undefined;
  readonly nowIso?: () => string;
  readonly failValidationMessage?: string;
}

const SHIPPING_BASE_CENTS: Readonly<Record<BookShippingLevel, number>> = {
  mail: 799,
  ground: 1199,
  expedited: 2199,
  express: 3499,
};

/**
 * Deterministic offline BookPublisherProvider for hermetic tests, local CLI dry-runs,
 * and previewing POD quotes & job tracking without external credentials.
 */
export function createMockBookPublisherAdapter(
  options: MockBookPublisherOptions = {}
): BookPublisherProvider {
  const nowIso = options.nowIso ?? (() => '2026-11-27T12:00:00.000Z');
  const jobs = new Map<string, BookPrintJobRecord>();
  let sequence = 0;

  return {
    id: 'mock',
    displayName: 'Mock Print Publisher (Offline Sandbox)',
    sandbox: true,

    resolveProviderSku(spec: BookPhysicalSpec): string {
      return resolveLuluPodPackageId(spec);
    },

    async getCoverDimensions(spec: BookPhysicalSpec): Promise<CoverDimensionsResult> {
      const sku = resolveLuluPodPackageId(spec);
      const spine = computeOfflineSpineWidthIn(spec.interiorPageCount, spec.paperStock);
      const offline = computeCoverDimensionsOffline(spec, sku);
      return buildCoverDimensionsFromValues({
        spec,
        totalWidthIn: offline.totalWidthIn,
        totalHeightIn: offline.totalHeightIn,
        spineWidthIn: spine,
        source: 'offline_estimate',
        providerSku: sku,
      });
    },

    async estimateCost(request: BookQuoteRequest): Promise<BookQuoteResult> {
      const sku = resolveLuluPodPackageId(request.spec);
      const perPageCents = request.spec.paperStock === '80lb-coated-white-color' ? 14 : 11;
      const bindingBaseCents = 1450;
      const unitManufacturing = bindingBaseCents + request.spec.interiorPageCount * perPageCents;
      const manufacturingCostCents = unitManufacturing * request.quantity;
      const shippingCostCents =
        SHIPPING_BASE_CENTS[request.shippingLevel] + Math.max(0, request.quantity - 1) * 250;
      const fulfillmentFeeCents = 150;
      const subtotal = manufacturingCostCents + shippingCostCents + fulfillmentFeeCents;
      const taxCents = request.shippingAddress.countryCode === 'US' ? Math.round(subtotal * 0.07) : 0;

      return {
        providerId: 'mock',
        providerSku: sku,
        currency: 'USD',
        manufacturingCostCents,
        shippingCostCents,
        fulfillmentFeeCents,
        taxCents,
        totalCostCents: subtotal + taxCents,
        sandbox: true,
      };
    },

    async validateInteriorAndCover(params: {
      readonly spec: BookPhysicalSpec;
      readonly interiorPdfUrl: string;
      readonly coverPdfUrl: string;
    }): Promise<{ readonly interior: BookValidationResult; readonly cover: BookValidationResult }> {
      if (options.failValidationMessage) {
        return {
          interior: {
            ok: false,
            status: 'error',
            validationId: 'mock-val-interior-err',
            errors: [options.failValidationMessage],
            warnings: [],
          },
          cover: {
            ok: true,
            status: 'normalized',
            validationId: 'mock-val-cover-ok',
            errors: [],
            warnings: [],
          },
        };
      }
      const interiorValid = params.interiorPdfUrl.trim().length > 0;
      const coverValid = params.coverPdfUrl.trim().length > 0;
      return {
        interior: {
          ok: interiorValid,
          status: interiorValid ? 'normalized' : 'error',
          validationId: 'mock-val-interior-1',
          errors: interiorValid ? [] : ['Interior PDF URL is required.'],
          warnings: [],
        },
        cover: {
          ok: coverValid,
          status: coverValid ? 'normalized' : 'error',
          validationId: 'mock-val-cover-1',
          errors: coverValid ? [] : ['Cover PDF URL is required.'],
          warnings: [],
        },
      };
    },

    async createPrintJob(request: BookPrintJobRequest): Promise<BookPrintJobRecord> {
      sequence += 1;
      const jobId = `mock-job-${sequence}`;
      const record: BookPrintJobRecord = {
        providerId: 'mock',
        jobId,
        externalId: request.externalId,
        title: request.title,
        status: 'ready_for_production',
        statusDetail: 'Validated in offline mock sandbox',
        trackingUrls: [],
        sandbox: true,
        quantity: request.quantity,
        spec: request.spec,
        updatedAt: nowIso(),
      };
      jobs.set(jobId, record);
      return record;
    },

    async getPrintJobStatus(jobId: string): Promise<BookPrintJobRecord> {
      const existing = jobs.get(jobId);
      if (!existing) {
        throw new Error(`Mock print job '${jobId}' was not found.`);
      }
      return existing;
    },

    async verifyWebhookSignature(rawBody: Uint8Array, headers: Headers): Promise<boolean> {
      const headerValue = headers.get('lulu-hmac-sha256') ?? headers.get('Lulu-HMAC-SHA256');
      return verifyLuluWebhookHmac(options.webhookSecret ?? '', rawBody, headerValue);
    },
  };
}
