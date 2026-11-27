import type {
  AgentTokenRecord,
  BatchId,
  InviteRecord,
  OptimisticConflictError,
  RevisionId,
  RevisionQuery,
  UserRecord,
} from './contractsPrimitives.js';
import type { ArchiveBundle, MediaChecklistItem, MediaItem, ReadingsBundle } from './schemas/entities.js';
import type {
  AgentTokenScope,
  EntityPayload,
  EntityType,
  RevisionRecord,
  TalkComment,
  UserRole,
} from './schemas/revisions.js';

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
}
