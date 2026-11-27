import {
  ApiErrorEnvelopeSchema,
  type ArchiveBundle,
  ArchiveBundleSchema,
  type ArchiveRawSnapshot,
  asRevisionId,
  type BatchSubmission,
  EntityPayloadSchema,
  EntityTypeSchema,
  KinshipEdgeSchema,
  type MediaItem,
  MediaItemSchema,
  type OptimisticConflictError,
  OptimisticConflictErrorSchema,
  type RevisionRecord,
  RevisionRecordSchema,
  type StoredEntityRow,
  type StoredKinshipRow,
} from '@kinloom/core';
import { z } from 'zod';
import { CliValidationError, KinloomApiError } from './errors.js';

export interface KinloomApiClientOptions {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

const SubmitBatchResponseSchema = z.object({
  batch_id: z.string().min(1),
  revisions: z.array(RevisionRecordSchema),
  head_revision_id: z.number().int().nonnegative(),
  etag: z.string().min(1),
});

export type SubmitBatchResponse = z.infer<typeof SubmitBatchResponseSchema>;

const ExportYamlPayloadSchema = z.object({
  head_revision_id: z.number().int().nonnegative(),
  exported_at: z.string().min(1),
  files: z.record(z.string(), z.string()),
});

export type ExportYamlResult =
  | { status: 'not_modified'; etag: string | null }
  | {
      status: 'ok';
      head_revision_id: number;
      exported_at: string;
      etag: string | null;
      files: Record<string, string>;
    };

const StoredEntityRowSchema = z.object({
  entity_type: EntityTypeSchema.exclude(['kinship_edge']),
  entity_id: z.string().min(1),
  slug: z.string().nullable(),
  data: EntityPayloadSchema,
  current_revision_id: z.number().int().nonnegative(),
  has_primary_source: z.boolean().default(true),
  deleted_at: z.string().nullable().default(null),
  updated_at: z.string(),
});

const StoredKinshipRowSchema = z.object({
  edge_id: z.string().min(1),
  edge: KinshipEdgeSchema,
  current_revision_id: z.number().int().nonnegative(),
  deleted_at: z.string().nullable().default(null),
  updated_at: z.string(),
});

const ArchiveRawSnapshotPayloadSchema = z.object({
  head_revision_id: z.number().int().nonnegative(),
  entities: z.array(StoredEntityRowSchema),
  kinship: z.array(StoredKinshipRowSchema),
});

const WrappedArchiveSnapshotResponseSchema = z
  .object({
    head_revision_id: z.number().int().nonnegative().optional(),
    exported_at: z.string().min(1).optional(),
    snapshot: z.object({
      head_revision_id: z.number().int().nonnegative().optional(),
      entities: z.array(StoredEntityRowSchema),
      kinship: z.array(StoredKinshipRowSchema),
    }),
  })
  .refine((value) => value.snapshot.head_revision_id !== undefined || value.head_revision_id !== undefined, {
    message: 'Missing head_revision_id in snapshot response.',
  });

const ExportSnapshotResponseSchema = z.union([
  WrappedArchiveSnapshotResponseSchema,
  ArchiveRawSnapshotPayloadSchema,
]);

export type ExportSnapshotResult =
  | { status: 'not_modified'; etag: string | null }
  | { status: 'ok'; snapshot: ArchiveRawSnapshot; etag: string | null };

export type GetBundleResult =
  | { status: 'not_modified'; etag: string | null }
  | { status: 'ok'; bundle: ArchiveBundle; etag: string | null };

const UploadMediaResponseSchema = z.object({
  media: MediaItemSchema,
  url: z.string().min(1),
  revision: RevisionRecordSchema,
  etag: z.string().min(1),
});

export type UploadMediaResponse = {
  media: MediaItem;
  url: string;
  revision: RevisionRecord;
  etag: string;
};

export interface UploadMediaRequest {
  fileBytes: Uint8Array;
  fileName: string;
  mimeType: string;
  metadata: Record<string, unknown>;
  summary: string;
}

function normalizeBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliValidationError(`Invalid site URL '${rawUrl}'. Expected an http:// or https:// URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliValidationError(
      `Unsupported site URL protocol '${parsed.protocol}'. Expected http: or https:.`
    );
  }
  return trimmed.replace(/\/+$/, '');
}

async function parseErrorResponse(response: Response): Promise<KinloomApiError> {
  const rawText = await response.text();
  let parsedJson: unknown = null;
  if (rawText.trim()) {
    try {
      parsedJson = JSON.parse(rawText);
    } catch {
      parsedJson = null;
    }
  }

  const envelope = ApiErrorEnvelopeSchema.safeParse(parsedJson);
  if (envelope.success) {
    const { code, message, details } = envelope.data.error;
    let conflict: OptimisticConflictError | undefined;
    if (response.status === 409 && details !== undefined) {
      const parsedConflict = OptimisticConflictErrorSchema.safeParse(details);
      if (parsedConflict.success) {
        const c = parsedConflict.data;
        conflict = {
          kind: 'conflict',
          entity_type: c.entity_type,
          entity_id: c.entity_id,
          expected_parent_revision_id:
            c.expected_parent_revision_id !== null ? asRevisionId(c.expected_parent_revision_id) : null,
          server_revision_id: asRevisionId(c.server_revision_id),
          server_entity: c.server_entity,
          server_deleted_at: c.server_deleted_at,
          last_author_name: c.last_author_name,
          last_updated_at: c.last_updated_at,
          diff: c.diff,
        };
      }
    }
    return new KinloomApiError({
      status: response.status,
      code,
      message,
      details,
      conflict,
    });
  }

  const fallbackMessage = rawText.trim() || `HTTP ${response.status} ${response.statusText}`;
  return new KinloomApiError({
    status: response.status,
    code: `HTTP_${response.status}`,
    message: fallbackMessage,
    details: parsedJson ?? undefined,
  });
}

async function parseJsonBody<TSchema extends z.ZodTypeAny>(
  response: Response,
  schema: TSchema,
  endpoint: string
): Promise<z.infer<TSchema>> {
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new KinloomApiError({
      status: response.status,
      code: 'INVALID_JSON_RESPONSE',
      message: `Server returned invalid JSON from ${endpoint}.`,
    });
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`
    );
    throw new KinloomApiError({
      status: response.status,
      code: 'INVALID_RESPONSE_SCHEMA',
      message: `Unexpected response shape from ${endpoint}: ${issues.join('; ')}`,
      details: issues,
    });
  }
  return parsed.data;
}

export class KinloomApiClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: KinloomApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.token = options.token?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.userAgent = options.userAgent ?? 'kinloom-cli/0.39.0';
  }

  private buildHeaders(extra?: Record<string, string>): Headers {
    const headers = new Headers();
    headers.set('Accept', 'application/json');
    headers.set('User-Agent', this.userAgent);
    if (this.token) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        headers.set(key, value);
      }
    }
    return headers;
  }

  async submitBatch(batch: BatchSubmission): Promise<SubmitBatchResponse> {
    const endpoint = '/api/batches';
    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    return parseJsonBody(response, SubmitBatchResponseSchema, endpoint);
  }

  async exportYaml(options?: { ifNoneMatch?: string }): Promise<ExportYamlResult> {
    const endpoint = '/api/export/yaml';
    const extraHeaders: Record<string, string> = {};
    if (options?.ifNoneMatch) {
      extraHeaders['If-None-Match'] = options.ifNoneMatch;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.buildHeaders(extraHeaders),
    });

    if (response.status === 304) {
      return { status: 'not_modified', etag: response.headers.get('etag') };
    }
    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    const payload = await parseJsonBody(response, ExportYamlPayloadSchema, endpoint);
    return {
      status: 'ok',
      head_revision_id: payload.head_revision_id,
      exported_at: payload.exported_at,
      etag: response.headers.get('etag'),
      files: payload.files,
    };
  }

  async exportSnapshot(options?: { ifNoneMatch?: string }): Promise<ExportSnapshotResult> {
    const endpoint = '/api/export/snapshot';
    const extraHeaders: Record<string, string> = {};
    if (options?.ifNoneMatch) {
      extraHeaders['If-None-Match'] = options.ifNoneMatch;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.buildHeaders(extraHeaders),
    });

    if (response.status === 304) {
      return { status: 'not_modified', etag: response.headers.get('etag') };
    }
    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    const parsed = await parseJsonBody(response, ExportSnapshotResponseSchema, endpoint);
    const rawSnapshot = 'snapshot' in parsed ? parsed.snapshot : parsed;
    const headRevisionId =
      rawSnapshot.head_revision_id ?? ('snapshot' in parsed ? parsed.head_revision_id : undefined);
    if (headRevisionId === undefined) {
      throw new KinloomApiError({
        status: response.status,
        code: 'INVALID_RESPONSE_SCHEMA',
        message: `Unexpected response shape from ${endpoint}: missing head_revision_id`,
      });
    }
    const entities: StoredEntityRow[] = rawSnapshot.entities.map((row) => ({
      ...row,
      current_revision_id: asRevisionId(row.current_revision_id),
    }));
    const kinship: StoredKinshipRow[] = rawSnapshot.kinship.map((row) => ({
      ...row,
      current_revision_id: asRevisionId(row.current_revision_id),
    }));
    const snapshot: ArchiveRawSnapshot = {
      head_revision_id: asRevisionId(headRevisionId),
      entities,
      kinship,
    };

    return {
      status: 'ok',
      snapshot,
      etag: response.headers.get('etag'),
    };
  }

  async getBundle(options?: { ifNoneMatch?: string }): Promise<GetBundleResult> {
    const endpoint = '/api/bundle';
    const extraHeaders: Record<string, string> = {};
    if (options?.ifNoneMatch) {
      extraHeaders['If-None-Match'] = options.ifNoneMatch;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'GET',
      headers: this.buildHeaders(extraHeaders),
    });

    if (response.status === 304) {
      return { status: 'not_modified', etag: response.headers.get('etag') };
    }
    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    const bundle = await parseJsonBody(response, ArchiveBundleSchema, endpoint);
    return {
      status: 'ok',
      bundle,
      etag: response.headers.get('etag'),
    };
  }

  async uploadMedia(request: UploadMediaRequest): Promise<UploadMediaResponse> {
    const endpoint = '/api/media/upload';
    const formData = new FormData();
    const copy = Uint8Array.from(request.fileBytes);
    const blob = new Blob([copy], { type: request.mimeType });
    formData.set('file', blob, request.fileName);
    formData.set('metadata', JSON.stringify(request.metadata));
    formData.set('summary', request.summary);

    const response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: formData,
    });

    if (!response.ok) {
      throw await parseErrorResponse(response);
    }

    return parseJsonBody(response, UploadMediaResponseSchema, endpoint);
  }
}

export function resolveAuthToken(explicitToken?: string): string | undefined {
  const candidate = explicitToken ?? process.env.KINLOOM_TOKEN;
  const trimmed = candidate?.trim();
  return trimmed ? trimmed : undefined;
}
