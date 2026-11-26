import type { EntityDiffSummary } from './revisions.js';
import type { KinloomSiteConfig } from './schemas/config.js';
import type {
  ArchiveBundle,
  KinshipEdge,
  MediaChecklistItem,
  MediaItem,
  ReadingsBundle,
} from './schemas/entities.js';
import type {
  AgentTokenScope,
  ApiErrorEnvelope,
  AuthorType,
  EntityPayload,
  EntityType,
  RevisionAction,
  RevisionRecord,
  TalkComment,
  UserRole,
} from './schemas/revisions.js';

export type { AgentTokenScope, ApiErrorEnvelope, UserRole } from './schemas/revisions.js';

/**
 * Branded semantic primitives prevent mixing entity IDs, revision numbers, and opaque digests.
 */
export type RevisionId = number & { readonly __brand: 'RevisionId' };
export type BatchId = string & { readonly __brand: 'BatchId' };
export type Sha256Hex = string & { readonly __brand: 'Sha256Hex' };

export function asRevisionId(value: number): RevisionId {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`Invalid RevisionId: ${value}`);
  }
  return value as RevisionId;
}

export function asBatchId(value: string): BatchId {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RangeError('BatchId must be a non-empty string');
  }
  return trimmed as BatchId;
}

export function asSha256Hex(value: string): Sha256Hex {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new RangeError(`Invalid Sha256Hex digest: ${value}`);
  }
  return normalized as Sha256Hex;
}

export interface Clock {
  now(): Date;
  nowIso(): string;
  currentYear(): number;
}

export interface StoredEntityRow {
  entity_type: Exclude<EntityType, 'kinship_edge'>;
  entity_id: string;
  slug: string | null;
  data: EntityPayload;
  current_revision_id: RevisionId;
  has_primary_source: boolean;
  deleted_at: string | null;
  updated_at: string;
}

export interface StoredKinshipRow {
  edge_id: string;
  edge: KinshipEdge;
  current_revision_id: RevisionId;
  deleted_at: string | null;
  updated_at: string;
}

export type StoredEntityRecord = StoredEntityRow | StoredKinshipRow;

export interface EntityLookupKey {
  readonly entityType: EntityType;
  readonly entityId: string;
}

export function entityLookupCompositeKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

export interface ArchiveRawSnapshot {
  head_revision_id: RevisionId;
  entities: readonly StoredEntityRow[];
  kinship: readonly StoredKinshipRow[];
}

export interface RevisionAuthor {
  author_id: string;
  author_name: string;
  author_type: AuthorType;
}

export interface AtomicMutationOp {
  entity_type: EntityType;
  entity_id: string;
  slug?: string | null;
  action: RevisionAction;
  expected_parent_revision_id: RevisionId | null;
  reverted_revision_id?: RevisionId | null;
  summary: string;
  has_primary_source: boolean;
  before_json: EntityPayload | null;
  after_json: EntityPayload | null;
  soft_delete?: boolean;
  restore_deleted?: boolean;
}

export interface OptimisticConflictError {
  kind: 'conflict';
  entity_type: EntityType;
  entity_id: string;
  expected_parent_revision_id: RevisionId | null;
  server_revision_id: RevisionId;
  server_entity: EntityPayload | null;
  server_deleted_at: string | null;
  last_author_name: string;
  last_updated_at: string;
  diff: EntityDiffSummary;
}

export type CommitMutationsResult =
  | {
      kind: 'committed';
      head_revision_id: RevisionId;
      revisions: readonly RevisionRecord[];
    }
  | OptimisticConflictError;

export interface UserRecord {
  email: string;
  display_name: string;
  role: UserRole;
  added_by: string;
  added_at: string;
  last_login_at: string | null;
}

export interface InviteRecord {
  token: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  uses: number;
  last_used_at: string | null;
}

export interface MagicLinkRecord {
  token_hash: Sha256Hex;
  email: string;
  invite_token: string | null;
  expires_at: string;
  used_at: string | null;
}

export interface AgentTokenRecord {
  token_id: string;
  token_hash: Sha256Hex;
  label: string;
  scope: AgentTokenScope;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

export interface RevisionQuery {
  entity_type?: EntityType;
  entity_id?: string;
  batch_id?: BatchId;
  author_type?: AuthorType;
  cursor?: RevisionId;
  limit?: number;
}

/**
 * Persistence port implemented by D1ArchiveRepository (production) and InMemoryArchiveRepository (unit tests).
 */
export interface ArchiveRepository {
  getHeadRevisionId(): Promise<RevisionId>;
  getEntity(
    entityType: EntityType,
    entityId: string
  ): Promise<StoredEntityRecord | null>;
  getEntitiesBatch?(
    keys: readonly EntityLookupKey[]
  ): Promise<Map<string, StoredEntityRecord | null>>;
  getLivingPersonIds(): Promise<ReadonlySet<string>>;
  loadActiveSnapshot(): Promise<ArchiveRawSnapshot>;

  commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult>;

  listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }>;
  getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null>;
  getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]>;

  listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]>;
  insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment>;
  softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean>;

  getUser(email: string): Promise<UserRecord | null>;
  listUsers(): Promise<readonly UserRecord[]>;
  upsertUser(user: UserRecord): Promise<UserRecord>;
  updateUserRole(email: string, role: UserRole): Promise<UserRecord | null>;
  deleteUser(email: string): Promise<boolean>;
  touchUserLogin(email: string, atIso: string): Promise<void>;

  getInvite(token: string): Promise<InviteRecord | null>;
  listInvites(): Promise<readonly InviteRecord[]>;
  createInvite(invite: InviteRecord): Promise<InviteRecord>;
  recordInviteUse(token: string, atIso: string): Promise<void>;
  revokeInvite(token: string, atIso: string): Promise<boolean>;

  insertMagicLink(record: MagicLinkRecord): Promise<void>;
  getMagicLink?(tokenHash: Sha256Hex): Promise<MagicLinkRecord | null>;
  consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null>;

  findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null>;
  listAgentTokens(): Promise<readonly AgentTokenRecord[]>;
  createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord>;
  revokeAgentToken(tokenId: string, atIso: string): Promise<boolean>;
}

/**
 * Compiled bundle cache port supporting both incremental patching and full cold rebuilds.
 */
export interface CachedBundleObject {
  etag: string;
  revision_id: RevisionId;
  body: ReadableStream<Uint8Array> | string;
  byteLength: number;
  generated_at: string;
  readonly parsedBundle?: ArchiveBundle;
}

export interface BundleCache {
  getCached(ifNoneMatch: string | null): Promise<
    | { status: 'not_modified'; etag: string }
    | { status: 'hit'; object: CachedBundleObject }
    | { status: 'miss' }
  >;
  rebuildAndStore(snapshot: ArchiveRawSnapshot): Promise<CachedBundleObject>;
  applyMutationsAndStore?(
    previous: ArchiveBundle,
    mutations: readonly RevisionRecord[]
  ): Promise<CachedBundleObject>;
}

/**
 * Content-addressed binary storage port implemented by R2MediaStore or filesystem/S3 stores.
 */
export interface MediaByteRange {
  offset: number;
  length?: number;
}

export interface StoredMediaObject {
  key: string;
  contentType: string;
  sizeBytes: number;
  sha256?: Sha256Hex;
  etag?: string;
  body: ReadableStream<Uint8Array>;
  /** Populated when serving an HTTP 206 Partial Content byte range (required for video/audio scrubbing). */
  range?: { start: number; end: number; total: number };
}

export interface MediaStore {
  head(key: string): Promise<{ exists: boolean; sizeBytes?: number; contentType?: string }>;
  put(params: {
    key: string;
    body: ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    sha256: Sha256Hex;
  }): Promise<void>;
  get(key: string, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null>;
}

/**
 * Optional static SPA asset fallback port (for example Cloudflare ASSETS binding or Node static handler).
 */
export interface AssetHandler {
  fetch(request: Request): Promise<Response>;
}

/**
 * Pluggable transactional email sender port.
 */
export interface EmailSender {
  sendMagicLink(params: {
    toEmail: string;
    siteTitle: string;
    magicLinkUrl: string;
    expiresMinutes: number;
  }): Promise<void>;
}

/**
 * Pluggable identity provider port.
 */
export interface AuthProvider {
  readonly id: string;
  /** Optional explicit flag for adapters that represent an unconfigured provider. Defaults to true. */
  readonly configured?: boolean;
  buildAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'select_account' | 'consent';
  }): string;
  exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ email: string; displayName: string; emailVerified: boolean }>;
}

/**
 * Discriminated caller principal resolved by server auth middleware.
 */
export type CallerPrincipal =
  | { kind: 'anonymous' }
  | { kind: 'invite_viewer'; invite_token: string; label: string }
  | { kind: 'user'; email: string; display_name: string; role: UserRole }
  | { kind: 'agent'; token_id: string; label: string; scope: AgentTokenScope };

export type PluginRouteMinRole = 'public' | 'viewer' | 'editor' | 'admin';

export interface KinloomServerPluginContext {
  request: Request;
  url: URL;
  principal: CallerPrincipal;
  siteConfig: KinloomSiteConfig;
  ports: KinloomServerPorts;
}

export interface KinloomServerPluginRoute {
  method: string;
  pathPrefix: string;
  minRole: PluginRouteMinRole;
  handle(ctx: KinloomServerPluginContext): Promise<Response>;
}

export interface KinloomServerPlugin {
  readonly id: string;
  readonly name: string;
  readonly routes?: readonly KinloomServerPluginRoute[];
  onRevisionCommitted?(event: {
    revisions: readonly RevisionRecord[];
    headRevisionId: RevisionId;
  }): Promise<void>;
}

export interface KinloomServerPorts {
  repository: ArchiveRepository;
  bundleCache: BundleCache;
  mediaStore: MediaStore;
  emailSender: EmailSender;
  authProvider?: AuthProvider;
  clock: Clock;
  assetHandler?: AssetHandler;
  plugins?: readonly KinloomServerPlugin[];
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
}

export interface EntityWriteInput {
  entity_id?: string;
  data: EntityPayload;
  expected_parent_revision_id?: RevisionId;
  merge?: boolean;
  summary: string;
  has_primary_source: boolean;
}

/**
 * UI-side data transport port implemented by StaticDemoDataSource and HttpWikiDataSource.
 */
export interface ArchiveDataSource {
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

  getEntity?(entityType: EntityType, entityId: string): Promise<{
    entity: EntityPayload;
    current_revision_id: RevisionId;
    has_primary_source: boolean;
    deleted_at: string | null;
    updated_at: string;
  }>;
  createEntity?(entityType: EntityType, input: EntityWriteInput): Promise<{
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

export type { ApiErrorEnvelope as KinloomApiErrorEnvelope };
