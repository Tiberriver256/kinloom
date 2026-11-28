import type {
  AdminDiagnosticsReport,
  AgentTokenScope,
  ArchiveAuthProviders,
  ArchiveCapabilities,
  ArchiveSessionState,
  AuthorType,
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  EntityPayload,
  EntityType,
  GeneratedPronunciationAudioResult,
  InviteRecord,
  MediaItem,
  PluginSettingsSnapshot,
  Pronunciation,
  PronunciationLexicon,
  PublicAgentTokenRecord,
  RevisionAction,
  RevisionId,
  RevisionRecord,
  StewardReviewStamp,
  TalkComment,
  UpsertPronunciationTermResult,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import {
  AdminDiagnosticsReportSchema,
  AdminPluginSettingsListResponseSchema,
  AdminPluginSettingsUpdateResponseSchema,
  AgentTokenScopeSchema,
  AuthorTypeSchema,
  asRevisionId,
  EntityPayloadSchema,
  EntityTypeSchema,
  MediaItemSchema,
  PronunciationSchema,
  RevisionActionSchema,
  StewardReviewStampSchema,
  UserRoleSchema,
} from '@kinloom/core';

type JsonRecord = Record<string, unknown>;

function expectRecord(raw: unknown, label: string): JsonRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`Expected object for ${label}`);
  }
  return raw as JsonRecord;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected string for ${label}`);
  }
  return value;
}

function expectNonEmptyString(value: unknown, label: string): string {
  const s = expectString(value, label);
  if (s.length === 0) {
    throw new Error(`Expected non-empty string for ${label}`);
  }
  return s;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean for ${label}`);
  }
  return value;
}

function expectNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Expected finite number for ${label}`);
  }
  return value;
}

function expectArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array for ${label}`);
  }
  return value;
}

function expectNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return expectString(value, label);
}

function parseOptionalEntityPayload(value: unknown, label: string): EntityPayload | null {
  if (value === null || value === undefined) {
    return null;
  }
  return parseEntityPayloadChecked(value, label);
}

function parseEntityPayloadChecked(raw: unknown, label: string): EntityPayload {
  const parsed = EntityPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid entity payload for ${label}`);
  }
  return parsed.data;
}

function expectNullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return expectNumber(value, label);
}

function expectBooleanOrBit(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 0 || value === 1) {
    return Boolean(value);
  }
  throw new Error(`Expected boolean (or 0/1) for ${label}`);
}

function parseRevisionLike(raw: unknown, label: string): RevisionRecord {
  const rec = expectRecord(raw, label);
  const revisionId = expectNumber(rec.revision_id, `${label}.revision_id`);
  const entityType: EntityType = EntityTypeSchema.parse(rec.entity_type);
  const action: RevisionAction = RevisionActionSchema.parse(rec.action);
  const authorType: AuthorType = AuthorTypeSchema.parse(rec.author_type);
  const beforeRaw = rec.before_json !== undefined ? rec.before_json : rec.before_snapshot;
  const afterRaw = rec.after_json !== undefined ? rec.after_json : rec.after_snapshot;
  const review =
    rec.review !== undefined && rec.review !== null ? StewardReviewStampSchema.parse(rec.review) : undefined;
  return {
    revision_id: revisionId,
    batch_id: expectNullableString(rec.batch_id, `${label}.batch_id`),
    entity_type: entityType,
    entity_id: expectNonEmptyString(rec.entity_id, `${label}.entity_id`),
    parent_revision_id: expectNullableNumber(rec.parent_revision_id, `${label}.parent_revision_id`),
    action,
    reverted_revision_id: expectNullableNumber(rec.reverted_revision_id, `${label}.reverted_revision_id`),
    author_id: expectNonEmptyString(rec.author_id, `${label}.author_id`),
    author_name: expectNonEmptyString(rec.author_name, `${label}.author_name`),
    author_type: authorType,
    summary: expectString(rec.summary, `${label}.summary`),
    has_primary_source: expectBooleanOrBit(rec.has_primary_source, `${label}.has_primary_source`),
    before_json: parseOptionalEntityPayload(beforeRaw, `${label}.before_json`),
    after_json: parseOptionalEntityPayload(afterRaw, `${label}.after_json`),
    created_at: expectNonEmptyString(rec.created_at, `${label}.created_at`),
    ...(review ? { review } : {}),
  };
}

export function parseStewardReviewResponse(raw: unknown): { review: StewardReviewStamp } {
  const obj = expectRecord(raw, 'steward review response');
  return {
    review: StewardReviewStampSchema.parse(obj.review),
  };
}

export function parsePronunciationLexiconMap(raw: unknown, label: string): PronunciationLexicon {
  const rec = expectRecord(raw, label);
  const out: PronunciationLexicon = {};
  for (const [term, value] of Object.entries(rec)) {
    out[term] = PronunciationSchema.parse(value);
  }
  return out;
}

export function parseSessionResponse(raw: unknown): {
  session: ArchiveSessionState;
  capabilities: ArchiveCapabilities;
  authProviders?: ArchiveAuthProviders;
} {
  const obj = expectRecord(raw, 'session response');
  const sessionObj = expectRecord(obj.session, 'session');
  expectBoolean(sessionObj.authenticated, 'session.authenticated');
  const principalKind = expectString(sessionObj.principal_kind, 'session.principal_kind');
  if (principalKind !== 'anonymous' && principalKind !== 'invite_viewer' && principalKind !== 'user') {
    throw new Error(`Unexpected principal_kind '${principalKind}'`);
  }
  const capsObj = expectRecord(obj.capabilities, 'capabilities');
  const capabilities: ArchiveCapabilities = {
    canEdit: expectBoolean(capsObj.canEdit, 'capabilities.canEdit'),
    canUploadMedia: expectBoolean(capsObj.canUploadMedia, 'capabilities.canUploadMedia'),
    hasRevisionHistory: expectBoolean(capsObj.hasRevisionHistory, 'capabilities.hasRevisionHistory'),
    hasTalk: expectBoolean(capsObj.hasTalk, 'capabilities.hasTalk'),
    canManageSite: expectBoolean(capsObj.canManageSite, 'capabilities.canManageSite'),
  };
  let authProviders: ArchiveAuthProviders | undefined;
  if (obj.authProviders !== undefined) {
    const prov = expectRecord(obj.authProviders, 'authProviders');
    authProviders = {
      google: expectBoolean(prov.google, 'authProviders.google'),
      magicLink: expectBoolean(prov.magicLink, 'authProviders.magicLink'),
    };
  }
  const role =
    sessionObj.role === 'admin' || sessionObj.role === 'editor' || sessionObj.role === 'viewer'
      ? sessionObj.role
      : undefined;
  const session: ArchiveSessionState = {
    authenticated: Boolean(sessionObj.authenticated),
    principal_kind: principalKind,
    email: typeof sessionObj.email === 'string' ? sessionObj.email : undefined,
    displayName: typeof sessionObj.displayName === 'string' ? sessionObj.displayName : undefined,
    role,
    inviteLabel: typeof sessionObj.inviteLabel === 'string' ? sessionObj.inviteLabel : undefined,
  };
  return authProviders ? { session, capabilities, authProviders } : { session, capabilities };
}

export function parseEntityGetResponse(raw: unknown): {
  entity: EntityPayload;
  current_revision_id: RevisionId;
  has_primary_source: boolean;
  deleted_at: string | null;
  updated_at: string;
} {
  const obj = expectRecord(raw, 'entity get response');
  const revNum = expectNumber(obj.current_revision_id, 'current_revision_id');
  const deletedAt = obj.deleted_at === null ? null : expectString(obj.deleted_at, 'deleted_at');
  return {
    entity: parseEntityPayloadChecked(obj.entity, 'entity'),
    current_revision_id: asRevisionId(revNum),
    has_primary_source: expectBoolean(obj.has_primary_source, 'has_primary_source'),
    deleted_at: deletedAt,
    updated_at: expectString(obj.updated_at, 'updated_at'),
  };
}

export function parseEntityWriteResponse(raw: unknown): {
  entity: EntityPayload;
  revision: RevisionRecord;
  etag: string;
} {
  const obj = expectRecord(raw, 'entity write response');
  return {
    entity: parseEntityPayloadChecked(obj.entity, 'entity'),
    revision: parseRevisionLike(obj.revision, 'revision'),
    etag: expectString(obj.etag, 'etag'),
  };
}

export function parseRevisionOnlyResponse(raw: unknown): {
  revision: RevisionRecord;
  etag: string;
} {
  const obj = expectRecord(raw, 'revision response');
  return {
    revision: parseRevisionLike(obj.revision, 'revision'),
    etag: expectString(obj.etag, 'etag'),
  };
}

export function parseRevisionListResponse(raw: unknown): {
  items: readonly RevisionRecord[];
  next_cursor: RevisionId | null;
} {
  const obj = expectRecord(raw, 'revision list response');
  const items = expectArray(obj.items, 'items').map((item, idx) => parseRevisionLike(item, `items[${idx}]`));
  const nextCursor =
    obj.next_cursor === null || obj.next_cursor === undefined
      ? null
      : asRevisionId(expectNumber(obj.next_cursor, 'next_cursor'));
  return { items, next_cursor: nextCursor };
}

export function parseBatchRevertResponse(raw: unknown): {
  revisions: readonly RevisionRecord[];
  etag: string;
} {
  const obj = expectRecord(raw, 'batch revert response');
  const revisions = expectArray(obj.revisions, 'revisions').map((item, idx) =>
    parseRevisionLike(item, `revisions[${idx}]`)
  );
  return {
    revisions,
    etag: expectString(obj.etag, 'etag'),
  };
}

export function parseMediaUploadResponse(raw: unknown): {
  media: MediaItem;
  url: string;
  revision: RevisionRecord;
  etag: string;
} {
  const obj = expectRecord(raw, 'media upload response');
  const media = MediaItemSchema.parse(obj.media);
  return {
    media,
    url: expectNonEmptyString(obj.url, 'url'),
    revision: parseRevisionLike(obj.revision, 'revision'),
    etag: expectString(obj.etag, 'etag'),
  };
}

function parseTalkCommentRecord(raw: unknown, label: string): TalkComment {
  const obj = expectRecord(raw, label);
  const entityType = EntityTypeSchema.parse(obj.entity_type);
  const authorId =
    typeof obj.author_id === 'string' && obj.author_id.length > 0
      ? obj.author_id
      : typeof obj.author_email === 'string' && obj.author_email.length > 0
        ? obj.author_email
        : 'unknown';
  return {
    comment_id: expectNumber(obj.comment_id, `${label}.comment_id`),
    entity_type: entityType,
    entity_id: expectNonEmptyString(obj.entity_id, `${label}.entity_id`),
    author_id: authorId,
    author_name: expectString(obj.author_name, `${label}.author_name`),
    body_md: expectString(obj.body_md, `${label}.body_md`),
    created_at: expectString(obj.created_at, `${label}.created_at`),
    edited_at: expectNullableString(obj.edited_at, `${label}.edited_at`),
    deleted_at: expectNullableString(obj.deleted_at, `${label}.deleted_at`),
  };
}

export function parseTalkCommentListResponse(raw: unknown): readonly TalkComment[] {
  const obj = expectRecord(raw, 'talk comments response');
  return expectArray(obj.comments, 'comments').map((item, idx) =>
    parseTalkCommentRecord(item, `comments[${idx}]`)
  );
}

export function parseTalkCommentResponse(raw: unknown): TalkComment {
  const obj = expectRecord(raw, 'talk comment response');
  return parseTalkCommentRecord(obj.comment, 'comment');
}

export function parseMagicLinkResponse(raw: unknown): { sent: boolean } {
  const obj = expectRecord(raw, 'magic link response');
  return { sent: expectBoolean(obj.sent, 'sent') };
}

export function parsePronunciationLexiconResponse(raw: unknown): PronunciationLexicon {
  const obj = expectRecord(raw, 'pronunciations response');
  return parsePronunciationLexiconMap(obj.pronunciations, 'pronunciations');
}

export function parseUpsertPronunciationTermResponse(raw: unknown): UpsertPronunciationTermResult {
  const obj = expectRecord(raw, 'upsert pronunciation response');
  const term = typeof obj.term === 'string' ? obj.term : '';
  let pronunciation: Pronunciation | null = null;
  if (obj.pronunciation !== null && obj.pronunciation !== undefined) {
    pronunciation = PronunciationSchema.parse(obj.pronunciation);
  }
  const pronunciations = parsePronunciationLexiconMap(obj.pronunciations, 'pronunciations');
  return { term, pronunciation, pronunciations };
}

export function parseGeneratedPronunciationAudioResponse(raw: unknown): GeneratedPronunciationAudioResult {
  const obj = expectRecord(raw, 'generate pronunciation audio response');
  const audioUrl = expectNonEmptyString(obj.audio_url, 'audio_url');
  const contentType = typeof obj.content_type === 'string' ? obj.content_type : 'audio/mpeg';
  const sizeBytes =
    typeof obj.size_bytes === 'number' && Number.isFinite(obj.size_bytes) ? obj.size_bytes : 0;
  const deduplicated = typeof obj.deduplicated === 'boolean' ? obj.deduplicated : undefined;
  return deduplicated === undefined
    ? { audio_url: audioUrl, content_type: contentType, size_bytes: sizeBytes }
    : { audio_url: audioUrl, content_type: contentType, size_bytes: sizeBytes, deduplicated };
}

function parseUserRecord(raw: unknown, label: string): UserRecord {
  const obj = expectRecord(raw, label);
  const role: UserRole = UserRoleSchema.parse(obj.role);
  return {
    email: expectNonEmptyString(obj.email, `${label}.email`),
    display_name: expectString(obj.display_name, `${label}.display_name`),
    role,
    added_by: expectString(obj.added_by, `${label}.added_by`),
    added_at: expectString(obj.added_at, `${label}.added_at`),
    last_login_at: expectNullableString(obj.last_login_at, `${label}.last_login_at`),
  };
}

export function parseUsersListResponse(raw: unknown): readonly UserRecord[] {
  const obj = expectRecord(raw, 'users response');
  return expectArray(obj.users, 'users').map((item, idx) => parseUserRecord(item, `users[${idx}]`));
}

export function parseUserResponse(raw: unknown): UserRecord {
  const obj = expectRecord(raw, 'user response');
  return parseUserRecord(obj.user, 'user');
}

function parseInviteRecord(raw: unknown, label: string): InviteRecord {
  const obj = expectRecord(raw, label);
  return {
    token: expectNonEmptyString(obj.token, `${label}.token`),
    label: expectString(obj.label, `${label}.label`),
    created_by: expectString(obj.created_by, `${label}.created_by`),
    created_at: expectString(obj.created_at, `${label}.created_at`),
    expires_at: expectNullableString(obj.expires_at, `${label}.expires_at`),
    revoked_at: expectNullableString(obj.revoked_at, `${label}.revoked_at`),
    uses: expectNumber(obj.uses, `${label}.uses`),
    last_used_at: expectNullableString(obj.last_used_at, `${label}.last_used_at`),
  };
}

export function parseInvitesListResponse(raw: unknown): readonly InviteRecord[] {
  const obj = expectRecord(raw, 'invites response');
  return expectArray(obj.invites, 'invites').map((item, idx) => parseInviteRecord(item, `invites[${idx}]`));
}

export function parseCreatedInviteResponse(raw: unknown): CreatedInviteResponse {
  const obj = expectRecord(raw, 'created invite response');
  return {
    invite: parseInviteRecord(obj.invite, 'invite'),
    invite_url: expectNonEmptyString(obj.invite_url, 'invite_url'),
  };
}

function parsePublicAgentTokenRecord(raw: unknown, label: string): PublicAgentTokenRecord {
  const obj = expectRecord(raw, label);
  const scope: AgentTokenScope = AgentTokenScopeSchema.parse(obj.scope);
  return {
    token_id: expectNonEmptyString(obj.token_id, `${label}.token_id`),
    label: expectString(obj.label, `${label}.label`),
    scope,
    created_by: expectString(obj.created_by, `${label}.created_by`),
    created_at: expectString(obj.created_at, `${label}.created_at`),
    revoked_at: expectNullableString(obj.revoked_at, `${label}.revoked_at`),
  };
}

export function parseAgentTokensListResponse(raw: unknown): readonly PublicAgentTokenRecord[] {
  const obj = expectRecord(raw, 'agent tokens response');
  return expectArray(obj.tokens, 'tokens').map((item, idx) =>
    parsePublicAgentTokenRecord(item, `tokens[${idx}]`)
  );
}

export function parseCreatedAgentTokenResponse(raw: unknown): CreatedAgentTokenResponse {
  const obj = expectRecord(raw, 'created agent token response');
  const scope: AgentTokenScope = AgentTokenScopeSchema.parse(obj.scope);
  return {
    token_id: expectNonEmptyString(obj.token_id, 'token_id'),
    label: expectString(obj.label, 'label'),
    scope,
    plaintext_secret: expectNonEmptyString(obj.plaintext_secret, 'plaintext_secret'),
  };
}

export function parseAdminDiagnosticsReport(raw: unknown): AdminDiagnosticsReport {
  return AdminDiagnosticsReportSchema.parse(raw);
}

export function parseAdminPluginSettingsListResponse(raw: unknown): readonly PluginSettingsSnapshot[] {
  return AdminPluginSettingsListResponseSchema.parse(raw).plugins;
}

export function parseAdminPluginSettingsUpdateResponse(raw: unknown): PluginSettingsSnapshot {
  return AdminPluginSettingsUpdateResponseSchema.parse(raw).plugin;
}
