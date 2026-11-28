import type {
  AgentTokenRecord,
  BatchId,
  InviteRecord,
  OptimisticConflictError,
  RevisionId,
  RevisionQuery,
  UserRecord,
} from './contractsPrimitives.js';
import type { AdminDocsResponse } from './schemas/adminDocs.js';
import type { AdminChangelogsResponse } from './schemas/changelogs.js';
import type { AdminDiagnosticsReport } from './schemas/diagnostics.js';
import type {
  ArchiveBundle,
  MediaChecklistItem,
  MediaItem,
  Pronunciation,
  ReadingsBundle,
} from './schemas/entities.js';
import type { OnboardingSessionResponse, UpdateOnboardingStateRequest } from './schemas/onboarding.js';
import type { PluginSettingsSnapshot, PluginSettingsUpdateRequest } from './schemas/pluginSettings.js';
import type {
  AgentTokenScope,
  EntityPayload,
  EntityType,
  RevisionRecord,
  StewardReviewStamp,
  TalkComment,
  UserRole,
} from './schemas/revisions.js';

export type PronunciationLexicon = Record<string, Pronunciation>;

export interface ArchiveApiErrorShape {
  readonly status: number;
  readonly code: string;
  readonly message?: string;
  readonly details?: unknown;
}

export function isArchiveApiError(err: unknown): err is ArchiveApiErrorShape {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const candidate = err as {
    status?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    typeof candidate.status === 'number' &&
    Number.isFinite(candidate.status) &&
    typeof candidate.code === 'string' &&
    candidate.code.length > 0 &&
    (candidate.message === undefined || typeof candidate.message === 'string')
  );
}

export interface UpsertPronunciationTermResult {
  readonly term: string;
  readonly pronunciation: Pronunciation | null;
  readonly pronunciations: PronunciationLexicon;
}

export interface GeneratePronunciationAudioInput {
  readonly entity_type: 'person' | 'place';
  readonly entity_id: string;
  readonly text?: string;
  readonly phonetic?: string;
  readonly ipa?: string;
  readonly language?: string;
  readonly voice?: string;
}

export interface GeneratedPronunciationAudioResult {
  readonly audio_url: string;
  readonly content_type: string;
  readonly size_bytes: number;
  readonly deduplicated?: boolean;
}

export interface ArchiveAuthProviders {
  google: boolean;
  magicLink: boolean;
}

export interface ArchiveSessionState {
  authenticated: boolean;
  principal_kind: 'anonymous' | 'invite_viewer' | 'user';
  email?: string;
  displayName?: string;
  role?: 'admin' | 'editor' | 'viewer';
  inviteLabel?: string;
}

export interface ArchiveCapabilities {
  canEdit: boolean;
  canUploadMedia: boolean;
  hasRevisionHistory: boolean;
  hasTalk: boolean;
  canManageSite: boolean;
  canReadArchive?: boolean;
  hasReadings?: boolean;
  hasMediaChecklist?: boolean;
}

export interface EntityWriteInput {
  entity_id?: string;
  data: EntityPayload;
  expected_parent_revision_id?: RevisionId;
  merge?: boolean;
  summary: string;
  has_primary_source: boolean;
}

export type PublicAgentTokenRecord = Omit<AgentTokenRecord, 'token_hash'>;

export interface CreatedInviteResponse {
  invite: InviteRecord;
  invite_url: string;
}

export interface CreatedAgentTokenResponse {
  token_id: string;
  label: string;
  scope: AgentTokenScope;
  plaintext_secret: string;
}

export interface AdminDataSource {
  listUsers(): Promise<readonly UserRecord[]>;
  createUser?(input: { email: string; display_name: string; role: UserRole }): Promise<UserRecord>;
  updateUserRole(email: string, input: { role: UserRole; display_name?: string }): Promise<UserRecord>;
  deleteUser?(email: string): Promise<void>;
  listInvites(): Promise<readonly InviteRecord[]>;
  createInvite(input: { label: string; expires_in_days?: number }): Promise<CreatedInviteResponse>;
  revokeInvite(token: string): Promise<void>;
  listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]>;
  createAgentToken(input: { label: string; scope: AgentTokenScope }): Promise<CreatedAgentTokenResponse>;
  revokeAgentToken(tokenId: string): Promise<void>;
  getSystemDiagnostics?(): Promise<AdminDiagnosticsReport>;
  getChangelogs?(): Promise<AdminChangelogsResponse>;
  getAdminDocs?(): Promise<AdminDocsResponse>;
  getPluginSettings?(): Promise<readonly PluginSettingsSnapshot[]>;
  updatePluginSettings?(
    pluginId: string,
    input: PluginSettingsUpdateRequest
  ): Promise<PluginSettingsSnapshot>;
}

export interface ArchiveDataSource {
  readonly admin?: AdminDataSource;
  loadArchive(options?: { ifNoneMatch?: string }): Promise<{
    bundle: ArchiveBundle;
    etag: string | null;
    notModified: boolean;
  }>;
  loadReadings(): Promise<ReadingsBundle | null>;
  loadMediaChecklist?(): Promise<MediaChecklistItem[]>;
  getSession?(): Promise<{
    session: ArchiveSessionState;
    capabilities: ArchiveCapabilities;
    authProviders?: ArchiveAuthProviders;
  }>;
  getOnboardingState?(options?: { signal?: AbortSignal }): Promise<OnboardingSessionResponse>;
  updateOnboardingState?(
    patch: UpdateOnboardingStateRequest,
    options?: { signal?: AbortSignal }
  ): Promise<OnboardingSessionResponse>;

  getEntity?(
    entityType: EntityType,
    entityId: string
  ): Promise<{
    entity: EntityPayload;
    current_revision_id: RevisionId;
    has_primary_source: boolean;
    deleted_at: string | null;
    updated_at: string;
  }>;
  createEntity?(
    entityType: EntityType,
    input: EntityWriteInput
  ): Promise<{
    entity: EntityPayload;
    revision: RevisionRecord;
    etag: string;
  }>;
  updateEntity?(
    entityType: EntityType,
    entityId: string,
    input: EntityWriteInput,
    options?: { signal?: AbortSignal }
  ): Promise<
    | { ok: true; entity: EntityPayload; revision: RevisionRecord; etag: string }
    | { ok: false; conflict: OptimisticConflictError }
  >;
  deleteEntity?(
    entityType: EntityType,
    entityId: string,
    input: { expected_parent_revision_id: RevisionId; summary: string }
  ): Promise<{ revision: RevisionRecord; etag: string }>;
  restoreEntity?(
    entityType: EntityType,
    entityId: string,
    input: { expected_parent_revision_id: RevisionId; data?: EntityPayload; summary: string }
  ): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }>;

  listRevisions?(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }>;
  revertRevision?(
    revisionId: RevisionId,
    summary?: string
  ): Promise<{
    revision: RevisionRecord;
    etag: string;
  }>;
  revertBatch?(
    batchId: BatchId,
    summary?: string
  ): Promise<{
    revisions: readonly RevisionRecord[];
    etag: string;
  }>;
  markRevisionReviewed?(
    revisionId: RevisionId,
    note?: string | null
  ): Promise<{ review: StewardReviewStamp }>;
  clearRevisionReview?(revisionId: RevisionId): Promise<void>;
  markBatchReviewed?(batchId: BatchId, note?: string | null): Promise<{ review: StewardReviewStamp }>;
  clearBatchReview?(batchId: BatchId): Promise<void>;

  uploadMedia?(
    formData: FormData,
    options?: { signal?: AbortSignal }
  ): Promise<{
    media: MediaItem;
    url: string;
    revision: RevisionRecord;
    etag: string;
  }>;

  listTalkComments?(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]>;
  postTalkComment?(entityType: EntityType, entityId: string, bodyMd: string): Promise<TalkComment>;
  deleteTalkComment?(entityType: EntityType, entityId: string, commentId: number): Promise<void>;

  requestMagicLink?(email: string): Promise<{ sent: boolean }>;
  logout?(): Promise<void>;

  loadPronunciations?(options?: { signal?: AbortSignal }): Promise<PronunciationLexicon | undefined>;
  upsertPronunciationTerm?(
    term: string,
    entry: Pronunciation,
    options?: { signal?: AbortSignal }
  ): Promise<UpsertPronunciationTermResult>;
  generatePronunciationAudio?(
    input: GeneratePronunciationAudioInput,
    options?: { signal?: AbortSignal }
  ): Promise<GeneratedPronunciationAudioResult>;
  getGoogleSignInUrl?(returnTo?: string, options?: { selectAccount?: boolean }): string;
}
