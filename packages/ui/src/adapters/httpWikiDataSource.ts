import type {
  AdminDataSource,
  AgentTokenScope,
  ArchiveAuthProviders,
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  BatchId,
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  EntityPayload,
  EntityType,
  EntityWriteInput,
  InviteRecord,
  MediaChecklistItem,
  MediaItem,
  OptimisticConflictError,
  PublicAgentTokenRecord,
  ReadingsBundle,
  RevisionId,
  RevisionQuery,
  RevisionRecord,
  TalkComment,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import {
  ApiErrorEnvelopeSchema,
  ArchiveBundleMetaSchema,
  asRevisionId,
  OptimisticConflictErrorSchema,
  ReadingsBundleSchema,
} from '@kinloom/core';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  PublicAgentTokenRecord,
} from '@kinloom/core';

export interface HttpWikiDataSourceOptions {
  /** Base origin or path prefix, defaults to '' (same-origin). */
  apiBaseUrl?: string;
  /** Optional static asset base URL for readings.json fallback. */
  assetBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function normalizeAssetBase(raw?: string): string {
  const fallback = raw || '/';
  return fallback.endsWith('/') ? fallback : `${fallback}/`;
}

async function parseErrorEnvelope(res: Response): Promise<ApiClientError> {
  try {
    const body: unknown = await res.json();
    const parsed = ApiErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      return new ApiClientError(
        res.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.details
      );
    }
  } catch {
    // Response was not JSON; fall through to generic HTTP error.
  }
  return new ApiClientError(res.status, `HTTP_${res.status}`, `HTTP ${res.status} ${res.statusText}`);
}

function normalizeConflict(details: unknown): OptimisticConflictError {
  const parsed = OptimisticConflictErrorSchema.parse(details);
  return {
    ...parsed,
    expected_parent_revision_id:
      parsed.expected_parent_revision_id === null ? null : asRevisionId(parsed.expected_parent_revision_id),
    server_revision_id: asRevisionId(parsed.server_revision_id),
  };
}

/**
 * Live HTTP Wiki adapter implementing ArchiveDataSource plus Admin helper endpoints.
 */
export class HttpWikiDataSource implements ArchiveDataSource, AdminDataSource {
  readonly admin: AdminDataSource = this;
  private readonly apiBase: string;
  private readonly assetBase: string;
  private readonly fetchImpl: typeof fetch;
  private cachedBundle: ArchiveBundle | null = null;
  private cachedEtag: string | null = null;

  constructor(options: HttpWikiDataSourceOptions = {}) {
    this.apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
    this.assetBase = normalizeAssetBase(options.assetBaseUrl);
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  private apiUrl(path: string): string {
    return `${this.apiBase}${path}`;
  }

  private async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(this.apiUrl(path), {
      credentials: 'same-origin',
      ...init,
      headers: {
        accept: 'application/json',
        ...init.headers,
      },
    });
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }
    return (await res.json()) as T;
  }

  async loadArchive(options?: { ifNoneMatch?: string }): Promise<{
    bundle: ArchiveBundle;
    etag: string | null;
    notModified: boolean;
  }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const candidateEtag = options?.ifNoneMatch ?? this.cachedEtag ?? undefined;
    if (candidateEtag) {
      headers['if-none-match'] = candidateEtag;
    }

    const res = await this.fetchImpl(this.apiUrl('/api/bundle'), {
      credentials: 'same-origin',
      headers,
    });

    if (res.status === 304 && this.cachedBundle) {
      return {
        bundle: this.cachedBundle,
        etag: res.headers.get('etag') ?? this.cachedEtag,
        notModified: true,
      };
    }

    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }

    const raw = (await res.json()) as ArchiveBundle;
    // Validate the bundle envelope boundary while avoiding redundant per-item Zod overhead on live server bundles.
    ArchiveBundleMetaSchema.parse(raw.meta);
    const etag = res.headers.get('etag');
    this.cachedBundle = raw;
    this.cachedEtag = etag;

    return {
      bundle: raw,
      etag,
      notModified: false,
    };
  }

  async loadReadings(): Promise<ReadingsBundle | null> {
    const res = await this.fetchImpl(`${this.assetBase}data/readings.json`, {
      credentials: 'same-origin',
    });
    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }
    const raw: unknown = await res.json();
    return ReadingsBundleSchema.parse(raw);
  }

  async loadMediaChecklist(): Promise<MediaChecklistItem[]> {
    try {
      const res = await this.fetchImpl(`${this.assetBase}data/media-checklist.json`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        return [];
      }
      const raw = (await res.json()) as { items?: MediaChecklistItem[] };
      return Array.isArray(raw.items) ? raw.items : [];
    } catch {
      return [];
    }
  }

  async getSession(options?: { signal?: AbortSignal }): Promise<{
    session: ArchiveSessionState;
    capabilities: ArchiveCapabilities;
    authProviders?: ArchiveAuthProviders;
  }> {
    return this.requestJson<{
      session: ArchiveSessionState;
      capabilities: ArchiveCapabilities;
      authProviders?: ArchiveAuthProviders;
    }>('/api/auth/me', { signal: options?.signal });
  }

  async getEntity(
    entityType: EntityType,
    entityId: string,
    options?: { signal?: AbortSignal }
  ): Promise<{
    entity: EntityPayload;
    current_revision_id: RevisionId;
    has_primary_source: boolean;
    deleted_at: string | null;
    updated_at: string;
  }> {
    const data = await this.requestJson<{
      entity: EntityPayload;
      current_revision_id: number;
      has_primary_source: boolean;
      deleted_at: string | null;
      updated_at: string;
    }>(`/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`, {
      signal: options?.signal,
    });
    return {
      ...data,
      current_revision_id: asRevisionId(data.current_revision_id),
    };
  }

  async createEntity(
    entityType: EntityType,
    input: EntityWriteInput
  ): Promise<{
    entity: EntityPayload;
    revision: RevisionRecord;
    etag: string;
  }> {
    return this.requestJson(`/api/entities/${encodeURIComponent(entityType)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async updateEntity(
    entityType: EntityType,
    entityId: string,
    input: EntityWriteInput,
    options?: { signal?: AbortSignal }
  ): Promise<
    | { ok: true; entity: EntityPayload; revision: RevisionRecord; etag: string }
    | { ok: false; conflict: OptimisticConflictError }
  > {
    const res = await this.fetchImpl(
      this.apiUrl(`/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`),
      {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: options?.signal,
      }
    );

    if (res.status === 409) {
      const err = await parseErrorEnvelope(res);
      return {
        ok: false,
        conflict: normalizeConflict(err.details),
      };
    }

    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }

    const body = (await res.json()) as {
      entity: EntityPayload;
      revision: RevisionRecord;
      etag: string;
    };
    return { ok: true, ...body };
  }

  async deleteEntity(
    entityType: EntityType,
    entityId: string,
    input: { expected_parent_revision_id: RevisionId; summary: string }
  ): Promise<{ revision: RevisionRecord; etag: string }> {
    return this.requestJson(
      `/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
  }

  async restoreEntity(
    entityType: EntityType,
    entityId: string,
    input: { expected_parent_revision_id: RevisionId; data?: EntityPayload; summary: string }
  ): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    return this.requestJson(
      `/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/restore`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
  }

  async listRevisions(query: RevisionQuery = {}): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    const params = new URLSearchParams();
    if (query.entity_type) {
      params.set('entity_type', query.entity_type);
    }
    if (query.entity_id) {
      params.set('entity_id', query.entity_id);
    }
    if (query.batch_id) {
      params.set('batch_id', query.batch_id);
    }
    if (query.author_type) {
      params.set('author_type', query.author_type);
    }
    if (query.cursor !== undefined) {
      params.set('cursor', String(query.cursor));
    }
    if (query.limit !== undefined) {
      params.set('limit', String(query.limit));
    }
    const qs = params.toString();
    const res = await this.requestJson<{
      items: RevisionRecord[];
      next_cursor: number | null;
    }>(`/api/revisions${qs ? `?${qs}` : ''}`);
    return {
      items: res.items,
      next_cursor: res.next_cursor === null ? null : asRevisionId(res.next_cursor),
    };
  }

  async revertRevision(
    revisionId: RevisionId,
    summary?: string
  ): Promise<{
    revision: RevisionRecord;
    etag: string;
  }> {
    return this.requestJson(`/api/revisions/${revisionId}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  async revertBatch(
    batchId: BatchId,
    summary?: string
  ): Promise<{
    revisions: readonly RevisionRecord[];
    etag: string;
  }> {
    return this.requestJson(`/api/batches/${encodeURIComponent(batchId)}/revert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  async uploadMedia(
    formData: FormData,
    options?: { signal?: AbortSignal }
  ): Promise<{
    media: MediaItem;
    url: string;
    revision: RevisionRecord;
    etag: string;
  }> {
    const res = await this.fetchImpl(this.apiUrl('/api/media/upload'), {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
      signal: options?.signal,
    });
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }
    return (await res.json()) as {
      media: MediaItem;
      url: string;
      revision: RevisionRecord;
      etag: string;
    };
  }

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    const data = await this.requestJson<{ comments: TalkComment[] }>(
      `/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`
    );
    return data.comments;
  }

  async postTalkComment(entityType: EntityType, entityId: string, bodyMd: string): Promise<TalkComment> {
    const data = await this.requestJson<{ comment: TalkComment }>(
      `/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body_md: bodyMd }),
      }
    );
    return data.comment;
  }

  async deleteTalkComment(entityType: EntityType, entityId: string, commentId: number): Promise<void> {
    const res = await this.fetchImpl(
      this.apiUrl(`/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/${commentId}`),
      {
        method: 'DELETE',
        credentials: 'same-origin',
      }
    );
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }

  async requestMagicLink(
    email: string,
    options?: { next?: string; signal?: AbortSignal }
  ): Promise<{ sent: boolean }> {
    return this.requestJson<{ sent: boolean }>('/api/auth/magic-link/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(options?.next ? { email, next: options.next } : { email }),
      signal: options?.signal,
    });
  }

  async logout(): Promise<void> {
    const res = await this.fetchImpl(this.apiUrl('/api/auth/logout'), {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }

  getGoogleSignInUrl(nextPath?: string, options?: { selectAccount?: boolean }): string {
    const params = new URLSearchParams();
    if (nextPath) {
      params.set('next', nextPath);
    }
    if (options?.selectAccount) {
      params.set('select_account', '1');
    }
    const qs = params.toString();
    return this.apiUrl(`/api/auth/google/start${qs ? `?${qs}` : ''}`);
  }

  // --- Admin helper endpoints ---

  async listUsers(): Promise<readonly UserRecord[]> {
    const data = await this.requestJson<{ users: UserRecord[] }>('/api/admin/users');
    return data.users;
  }

  async createUser(input: { email: string; display_name: string; role: UserRole }): Promise<UserRecord> {
    const data = await this.requestJson<{ user: UserRecord }>('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return data.user;
  }

  async updateUserRole(email: string, input: { role: UserRole; display_name?: string }): Promise<UserRecord> {
    const data = await this.requestJson<{ user: UserRecord }>(
      `/api/admin/users/${encodeURIComponent(email)}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }
    );
    return data.user;
  }

  async deleteUser(email: string): Promise<void> {
    const res = await this.fetchImpl(this.apiUrl(`/api/admin/users/${encodeURIComponent(email)}`), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }

  async listInvites(): Promise<readonly InviteRecord[]> {
    const data = await this.requestJson<{ invites: InviteRecord[] }>('/api/admin/invites');
    return data.invites;
  }

  async createInvite(input: { label: string; expires_in_days?: number }): Promise<CreatedInviteResponse> {
    return this.requestJson<CreatedInviteResponse>('/api/admin/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async revokeInvite(token: string): Promise<void> {
    const res = await this.fetchImpl(this.apiUrl(`/api/admin/invites/${encodeURIComponent(token)}`), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }

  async listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]> {
    const data = await this.requestJson<{ tokens: PublicAgentTokenRecord[] }>('/api/admin/agent-tokens');
    return data.tokens;
  }

  async createAgentToken(input: {
    label: string;
    scope: AgentTokenScope;
  }): Promise<CreatedAgentTokenResponse> {
    return this.requestJson<CreatedAgentTokenResponse>('/api/admin/agent-tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  }

  async revokeAgentToken(tokenId: string): Promise<void> {
    const res = await this.fetchImpl(this.apiUrl(`/api/admin/agent-tokens/${encodeURIComponent(tokenId)}`), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }
}

export function createHttpWikiDataSource(options?: HttpWikiDataSourceOptions): HttpWikiDataSource {
  return new HttpWikiDataSource(options);
}
