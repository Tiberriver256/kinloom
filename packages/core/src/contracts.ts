import type {
  AgentTokenRecord,
  ArchiveRawSnapshot,
  AtomicMutationOp,
  BatchId,
  Clock,
  CommitMutationsResult,
  EntityLookupKey,
  InviteRecord,
  MagicLinkRecord,
  RevisionAuthor,
  RevisionId,
  RevisionQuery,
  Sha256Hex,
  StoredEntityRecord,
  UserRecord,
} from './contractsPrimitives.js';
import type { KinloomSiteConfig } from './schemas/config.js';
import type { PluginRuntimeStatus, PluginStatusProbeResult } from './schemas/diagnostics.js';
import type { ArchiveBundle, Pronunciation } from './schemas/entities.js';
import type {
  AppliedPluginMigrationRecord,
  PluginDatabaseFactory,
  PluginDatabasePort,
  PluginSqlMigration,
  PluginSqlRunResult,
  PluginSqlStatement,
  PluginSqlValue,
} from './schemas/pluginDatabase.js';
import type {
  PluginSettingScalarValue,
  PluginSettingsSchema,
  PluginSettingsSecretWriteOp,
} from './schemas/pluginSettings.js';
import type {
  AgentTokenScope,
  ApiErrorEnvelope,
  EntityType,
  RevisionRecord,
  TalkComment,
  UserRole,
} from './schemas/revisions.js';

export {
  type AgentTokenRecord,
  type ArchiveRawSnapshot,
  type AtomicMutationOp,
  asBatchId,
  asRevisionId,
  asSha256Hex,
  type BatchId,
  type Clock,
  type CommitMutationsResult,
  type EntityLookupKey,
  entityLookupCompositeKey,
  type InviteRecord,
  type MagicLinkRecord,
  type OptimisticConflictError,
  type RevisionAuthor,
  type RevisionId,
  type RevisionQuery,
  type Sha256Hex,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  storedRecordToEntityPayload,
  type UserRecord,
} from './contractsPrimitives.js';
export {
  type AdminDataSource,
  type ArchiveApiErrorShape,
  type ArchiveAuthProviders,
  type ArchiveCapabilities,
  type ArchiveDataSource,
  type ArchiveSessionState,
  type CreatedAgentTokenResponse,
  type CreatedInviteResponse,
  type EntityWriteInput,
  type GeneratedPronunciationAudioResult,
  type GeneratePronunciationAudioInput,
  isArchiveApiError,
  type PronunciationLexicon,
  type PublicAgentTokenRecord,
  type UpsertPronunciationTermResult,
} from './contractsUi.js';
export type { AgentTokenScope, ApiErrorEnvelope, UserRole } from './schemas/revisions.js';
export type {
  AppliedPluginMigrationRecord,
  PluginDatabaseFactory,
  PluginDatabasePort,
  PluginSqlMigration,
  PluginSqlRunResult,
  PluginSqlStatement,
  PluginSqlValue,
};

export interface EntityReadStore {
  getHeadRevisionId(): Promise<RevisionId>;
  getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null>;
  getEntitiesBatch?(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>>;
  getLivingPersonIds(): Promise<ReadonlySet<string>>;
  loadActiveSnapshot(): Promise<ArchiveRawSnapshot>;
}

export interface AtomicMutationStore {
  commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult>;
}

export interface RevisionLogStore {
  listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }>;
  getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null>;
  getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]>;
}

export interface TalkCommentStore {
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
}

export interface AccessControlStore {
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
  countRecentMagicLinks(email: string, sinceIso: string): Promise<number>;
  consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null>;

  findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null>;
  listAgentTokens(): Promise<readonly AgentTokenRecord[]>;
  createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord>;
  revokeAgentToken(tokenId: string, atIso: string): Promise<boolean>;
}

export interface ArchiveRepository
  extends EntityReadStore,
    AtomicMutationStore,
    RevisionLogStore,
    TalkCommentStore,
    AccessControlStore {
  readonly adapterKind?: string;
}

export interface CachedBundleObject {
  etag: string;
  revision_id: RevisionId;
  body: ReadableStream<Uint8Array> | string;
  byteLength: number;
  generated_at: string;
  readonly parsedBundle?: ArchiveBundle;
}

export interface BundleCache {
  readonly adapterKind?: string;
  getCached(
    ifNoneMatch: string | null
  ): Promise<
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
  range?: { start: number; end: number; total: number };
}

export interface MediaStore {
  readonly adapterKind?: string;
  head(key: string): Promise<{ exists: boolean; sizeBytes?: number; contentType?: string }>;
  put(params: {
    key: string;
    body: ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    sha256: Sha256Hex;
  }): Promise<void>;
  get(key: string, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null>;
}

export interface AssetHandler {
  fetch(request: Request): Promise<Response>;
}

export interface EmailSender {
  readonly adapterKind?: string;
  sendMagicLink(params: {
    toEmail: string;
    siteTitle: string;
    magicLinkUrl: string;
    expiresMinutes: number;
  }): Promise<void>;
}

export interface AuthProvider {
  readonly id: string;
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
  /** Scoped database port when plugin declares databaseNamespace and host provides pluginDatabaseFactory. */
  pluginDb?: PluginDatabasePort;
}

export interface KinloomServerPluginRoute {
  method: string;
  pathPrefix: string;
  minRole: PluginRouteMinRole;
  handle(ctx: KinloomServerPluginContext): Promise<Response>;
}

export interface KinloomServerPluginReadonlySettingsContext {
  readonly siteConfig: KinloomSiteConfig;
  readonly ports: KinloomServerPorts;
  readonly mode: 'private' | 'public';
  readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
  readonly configuredSecrets: Readonly<Record<string, boolean>>;
}

export interface KinloomServerPluginSettingsUpdatedEvent {
  readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
  readonly configuredSecrets: Readonly<Record<string, boolean>>;
}

export interface KinloomServerPlugin {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly status?: PluginRuntimeStatus;
  readonly routes?: readonly KinloomServerPluginRoute[];
  readonly settingsSchema?: PluginSettingsSchema;
  /** Optional SQL namespace segment (for example 'recipes' -> tables must start with 'plugin_recipes_'). */
  readonly databaseNamespace?: string;
  /** Ordered, idempotent DDL migrations owned by this plugin. Requires databaseNamespace. */
  readonly migrations?: readonly PluginSqlMigration[];
  getStatus?(): PluginStatusProbeResult | Promise<PluginStatusProbeResult>;
  getReadonlySettings?(
    ctx: KinloomServerPluginReadonlySettingsContext
  ):
    | Readonly<Record<string, PluginSettingScalarValue>>
    | Promise<Readonly<Record<string, PluginSettingScalarValue>>>;
  onSettingsUpdated?(event: KinloomServerPluginSettingsUpdatedEvent): void | Promise<void>;
  onRevisionCommitted?(event: {
    revisions: readonly RevisionRecord[];
    headRevisionId: RevisionId;
  }): Promise<void>;
}

export interface StoredPluginSettingsRecord {
  readonly plugin_id: string;
  readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
  readonly updated_at: string;
  readonly updated_by: string;
}

export interface StoredPluginSecretMetadata {
  readonly configured: boolean;
  readonly updated_at: string | null;
}

export interface PluginSettingsStore {
  readonly adapterKind?: string;
  getSettings(pluginId: string): Promise<StoredPluginSettingsRecord | null>;
  getSecretMetadata(pluginId: string): Promise<Readonly<Record<string, StoredPluginSecretMetadata>>>;
  getSecretValue?(pluginId: string, fieldKey: string): Promise<string | null>;
  savePluginSettings(params: {
    readonly pluginId: string;
    readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
    readonly secretMutations: readonly PluginSettingsSecretWriteOp[];
    readonly updatedBy: string;
    readonly updatedAt: string;
  }): Promise<{
    readonly settings: StoredPluginSettingsRecord;
    readonly secretMetadata: Readonly<Record<string, StoredPluginSecretMetadata>>;
  }>;
}

export interface PronunciationAudioResult {
  bytes: Uint8Array;
  contentType: string;
  ext: 'wav' | 'mp3';
}

export interface PronunciationAudioGenerator {
  readonly adapterKind?: string;
  generate(params: {
    text: string;
    phonetic?: string;
    ipa?: string;
    language?: string;
    voice?: string;
  }): Promise<PronunciationAudioResult>;
}

export interface PronunciationLexiconStore {
  readonly adapterKind?: string;
  list(): Promise<Record<string, Pronunciation>>;
  upsert(term: string, entry: Pronunciation, updatedBy: string, updatedAt: string): Promise<Pronunciation>;
  delete(term: string): Promise<void>;
}

export interface KinloomServerPorts {
  repository: ArchiveRepository;
  bundleCache: BundleCache;
  mediaStore: MediaStore;
  emailSender: EmailSender;
  authProvider?: AuthProvider;
  clock: Clock;
  assetHandler?: AssetHandler;
  pronunciationGenerator?: PronunciationAudioGenerator;
  pronunciationLexiconStore?: PronunciationLexiconStore;
  pluginSettingsStore?: PluginSettingsStore;
  pluginDatabaseFactory?: PluginDatabaseFactory;
  plugins?: readonly KinloomServerPlugin[];
}

export type { ApiErrorEnvelope as KinloomApiErrorEnvelope };
