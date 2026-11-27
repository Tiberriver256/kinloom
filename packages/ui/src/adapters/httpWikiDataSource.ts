import type {
  AdminDataSource,
  ArchiveAuthProviders,
  ArchiveBundle,
  ArchiveCapabilities,
  ArchiveDataSource,
  ArchiveSessionState,
  BatchId,
  EntityPayload,
  EntityType,
  EntityWriteInput,
  GeneratedPronunciationAudioResult,
  GeneratePronunciationAudioInput,
  MediaChecklistItem,
  MediaItem,
  OptimisticConflictError,
  Pronunciation,
  PronunciationLexicon,
  ReadingsBundle,
  RevisionId,
  RevisionQuery,
  RevisionRecord,
  TalkComment,
  UpsertPronunciationTermResult,
} from '@kinloom/core';
import { ArchiveBundleSchema, MediaChecklistItemSchema, ReadingsBundleSchema } from '@kinloom/core';
import { createHttpAdminDataSource } from './httpWiki/adminClient.js';
import {
  ApiClientError,
  type HttpWikiDataSourceOptions,
  normalizeAssetBase,
  normalizeConflict,
  parseErrorEnvelope,
  stripTrailingSlash,
} from './httpWiki/httpClient.js';
import {
  parseBatchRevertResponse,
  parseEntityGetResponse,
  parseEntityWriteResponse,
  parseGeneratedPronunciationAudioResponse,
  parseMagicLinkResponse,
  parseMediaUploadResponse,
  parsePronunciationLexiconResponse,
  parseRevisionListResponse,
  parseRevisionOnlyResponse,
  parseSessionResponse,
  parseTalkCommentListResponse,
  parseTalkCommentResponse,
  parseUpsertPronunciationTermResponse,
} from './httpWiki/responseParsers.js';

export type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  PublicAgentTokenRecord,
} from '@kinloom/core';
export type { HttpWikiDataSourceOptions };
export { ApiClientError };

/**
 * Live HTTP Wiki adapter implementing ArchiveDataSource with segregated `admin` sub-port.
 */
export class HttpWikiDataSource implements ArchiveDataSource {
  readonly admin: AdminDataSource;
  private readonly apiBase: string;
  private readonly assetBase: string;
  private readonly fetchImpl: typeof fetch;
  private cachedBundle: ArchiveBundle | null = null;
  private cachedEtag: string | null = null;

  constructor(options: HttpWikiDataSourceOptions = {}) {
    this.apiBase = stripTrailingSlash(options.apiBaseUrl ?? '');
    this.assetBase = normalizeAssetBase(options.assetBaseUrl);
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.admin = createHttpAdminDataSource({
      apiUrl: (path) => this.apiUrl(path),
      fetchImpl: this.fetchImpl,
      requestJson: (path, parse, init) => this.requestJson(path, parse, init),
    });
  }

  private apiUrl(path: string): string {
    return `${this.apiBase}${path}`;
  }

  private async requestJson<T>(path: string, parse: (raw: unknown) => T, init: RequestInit = {}): Promise<T> {
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
    const raw: unknown = await res.json();
    try {
      return parse(raw);
    } catch (err) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        `Invalid response payload from ${path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
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

    const raw: unknown = await res.json();
    let bundle: ArchiveBundle;
    try {
      bundle = ArchiveBundleSchema.parse(raw);
    } catch (err) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        `Invalid archive bundle payload: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const etag = res.headers.get('etag');
    this.cachedBundle = bundle;
    this.cachedEtag = etag;

    return { bundle, etag, notModified: false };
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
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.assetBase}data/media-checklist.json`, {
        credentials: 'same-origin',
      });
    } catch {
      return [];
    }
    if (!res.ok) {
      return [];
    }
    const raw: unknown = await res.json();
    if (typeof raw !== 'object' || raw === null || !('items' in raw) || !Array.isArray(raw.items)) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        'Invalid media checklist payload: expected object with items array'
      );
    }
    try {
      return raw.items.map((item) => MediaChecklistItemSchema.parse(item));
    } catch (err) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        `Invalid media checklist payload: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async getSession(options?: { signal?: AbortSignal }): Promise<{
    session: ArchiveSessionState;
    capabilities: ArchiveCapabilities;
    authProviders?: ArchiveAuthProviders;
  }> {
    return this.requestJson('/api/auth/me', parseSessionResponse, { signal: options?.signal });
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
    return this.requestJson(
      `/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      parseEntityGetResponse,
      { signal: options?.signal }
    );
  }

  async createEntity(
    entityType: EntityType,
    input: EntityWriteInput
  ): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    return this.requestJson(`/api/entities/${encodeURIComponent(entityType)}`, parseEntityWriteResponse, {
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
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: options?.signal,
      }
    );

    if (res.status === 409) {
      const err = await parseErrorEnvelope(res);
      return { ok: false, conflict: normalizeConflict(err.details) };
    }
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }

    const raw: unknown = await res.json();
    try {
      const parsed = parseEntityWriteResponse(raw);
      return { ok: true, ...parsed };
    } catch (err) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        `Invalid response payload from /api/entities/${entityType}/${entityId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async deleteEntity(
    entityType: EntityType,
    entityId: string,
    input: { expected_parent_revision_id: RevisionId; summary: string }
  ): Promise<{ revision: RevisionRecord; etag: string }> {
    return this.requestJson(
      `/api/entities/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      parseRevisionOnlyResponse,
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
      parseEntityWriteResponse,
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
    return this.requestJson(`/api/revisions${qs ? `?${qs}` : ''}`, parseRevisionListResponse);
  }

  async revertRevision(
    revisionId: RevisionId,
    summary?: string
  ): Promise<{ revision: RevisionRecord; etag: string }> {
    return this.requestJson(`/api/revisions/${revisionId}/revert`, parseRevisionOnlyResponse, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  async revertBatch(
    batchId: BatchId,
    summary?: string
  ): Promise<{ revisions: readonly RevisionRecord[]; etag: string }> {
    return this.requestJson(`/api/batches/${encodeURIComponent(batchId)}/revert`, parseBatchRevertResponse, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(summary ? { summary } : {}),
    });
  }

  async uploadMedia(
    formData: FormData,
    options?: { signal?: AbortSignal }
  ): Promise<{ media: MediaItem; url: string; revision: RevisionRecord; etag: string }> {
    const res = await this.fetchImpl(this.apiUrl('/api/media/upload'), {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
      signal: options?.signal,
    });
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }
    const raw: unknown = await res.json();
    try {
      return parseMediaUploadResponse(raw);
    } catch (err) {
      throw new ApiClientError(
        res.status,
        'INVALID_API_RESPONSE',
        `Invalid response payload from /api/media/upload: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    return this.requestJson(
      `/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      parseTalkCommentListResponse
    );
  }

  async postTalkComment(entityType: EntityType, entityId: string, bodyMd: string): Promise<TalkComment> {
    return this.requestJson(
      `/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}`,
      parseTalkCommentResponse,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body_md: bodyMd }),
      }
    );
  }

  async deleteTalkComment(entityType: EntityType, entityId: string, commentId: number): Promise<void> {
    const res = await this.fetchImpl(
      this.apiUrl(`/api/talk/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/${commentId}`),
      { method: 'DELETE', credentials: 'same-origin' }
    );
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  }

  async requestMagicLink(
    email: string,
    options?: { next?: string; signal?: AbortSignal }
  ): Promise<{ sent: boolean }> {
    return this.requestJson('/api/auth/magic-link/request', parseMagicLinkResponse, {
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

  async loadPronunciations(options?: { signal?: AbortSignal }): Promise<PronunciationLexicon | undefined> {
    const res = await this.fetchImpl(this.apiUrl('/api/pronunciations'), {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: options?.signal,
    });
    if (res.status === 404) {
      return undefined;
    }
    if (!res.ok) {
      throw await parseErrorEnvelope(res);
    }
    const raw: unknown = await res.json();
    return parsePronunciationLexiconResponse(raw);
  }

  async upsertPronunciationTerm(
    term: string,
    entry: Pronunciation,
    options?: { signal?: AbortSignal }
  ): Promise<UpsertPronunciationTermResult> {
    const trimmedTerm = term.trim();
    return this.requestJson(
      `/api/pronunciations/${encodeURIComponent(trimmedTerm)}`,
      parseUpsertPronunciationTermResponse,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(entry),
        signal: options?.signal,
      }
    );
  }

  async generatePronunciationAudio(
    input: GeneratePronunciationAudioInput,
    options?: { signal?: AbortSignal }
  ): Promise<GeneratedPronunciationAudioResult> {
    return this.requestJson('/api/pronunciation/generate', parseGeneratedPronunciationAudioResponse, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: options?.signal,
    });
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
}

export function createHttpWikiDataSource(options?: HttpWikiDataSourceOptions): HttpWikiDataSource {
  return new HttpWikiDataSource(options);
}
