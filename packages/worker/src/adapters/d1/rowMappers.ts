import {
  type AgentTokenRecord,
  AgentTokenScopeSchema,
  AuthorTypeSchema,
  asRevisionId,
  asSha256Hex,
  type EntityPayload,
  type EntityType,
  EntityTypeSchema,
  type InviteRecord,
  type KinshipEdge,
  type MagicLinkRecord,
  parseEntityPayload,
  RevisionActionSchema,
  type RevisionRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  type TalkComment,
  type UserRecord,
  UserRoleSchema,
} from '@kinloom/core';

export type NonKinshipEntityType = Exclude<EntityType, 'kinship_edge'>;

export interface RawDbEntityRow {
  entity_type: string;
  entity_id: string;
  slug: string | null;
  data_json: string;
  current_revision_id: number;
  has_primary_source: number;
  deleted_at: string | null;
  updated_at: string;
}

export interface RawDbKinshipRow {
  edge_id: string;
  from_person_id: string;
  to_person_id: string;
  relation: string;
  family_xref: string | null;
  current_revision_id: number;
  deleted_at: string | null;
  updated_at: string;
}

export interface RawDbRevisionRow {
  revision_id: number;
  batch_id: string | null;
  entity_type: string;
  entity_id: string;
  parent_revision_id: number | null;
  action: string;
  reverted_revision_id: number | null;
  author_id: string;
  author_name: string;
  author_type: string;
  summary: string;
  has_primary_source: number;
  before_json: string | null;
  after_json: string | null;
  created_at: string;
}

export interface RawDbTalkRow {
  comment_id: number;
  entity_type: string;
  entity_id: string;
  author_id: string;
  author_name: string;
  body_md: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface RawDbUserRow {
  email: string;
  display_name: string;
  role: string;
  added_by: string;
  added_at: string;
  last_login_at: string | null;
}

export interface RawDbInviteRow {
  token: string;
  label: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  uses: number;
  last_used_at: string | null;
}

export interface RawDbMagicLinkRow {
  token_hash: string;
  email: string;
  invite_token: string | null;
  expires_at: string;
  used_at: string | null;
}

export interface RawDbAgentTokenRow {
  token_id: string;
  token_hash: string;
  label: string;
  scope: string;
  created_by: string;
  created_at: string;
  revoked_at: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectString(record: Record<string, unknown>, field: string): string {
  const val = record[field];
  if (typeof val !== 'string') {
    throw new Error(`D1 row field '${field}' must be a string.`);
  }
  return val;
}

function expectNullableString(record: Record<string, unknown>, field: string): string | null {
  const val = record[field];
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val !== 'string') {
    throw new Error(`D1 row field '${field}' must be a string or null.`);
  }
  return val;
}

function expectNumber(record: Record<string, unknown>, field: string): number {
  const val = record[field];
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`D1 row field '${field}' must be a finite number.`);
  }
  return val;
}

function expectNullableNumber(record: Record<string, unknown>, field: string): number | null {
  const val = record[field];
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`D1 row field '${field}' must be a finite number or null.`);
  }
  return val;
}

export function parseDbEntityRow(raw: unknown): RawDbEntityRow {
  if (!isRecord(raw)) {
    throw new Error('Expected D1 entity row object.');
  }
  return {
    entity_type: expectString(raw, 'entity_type'),
    entity_id: expectString(raw, 'entity_id'),
    slug: expectNullableString(raw, 'slug'),
    data_json: expectString(raw, 'data_json'),
    current_revision_id: expectNumber(raw, 'current_revision_id'),
    has_primary_source: expectNumber(raw, 'has_primary_source'),
    deleted_at: expectNullableString(raw, 'deleted_at'),
    updated_at: expectString(raw, 'updated_at'),
  };
}

export function parseDbKinshipRow(raw: unknown): RawDbKinshipRow {
  if (!isRecord(raw)) {
    throw new Error('Expected D1 kinship row object.');
  }
  return {
    edge_id: expectString(raw, 'edge_id'),
    from_person_id: expectString(raw, 'from_person_id'),
    to_person_id: expectString(raw, 'to_person_id'),
    relation: expectString(raw, 'relation'),
    family_xref: expectNullableString(raw, 'family_xref'),
    current_revision_id: expectNumber(raw, 'current_revision_id'),
    deleted_at: expectNullableString(raw, 'deleted_at'),
    updated_at: expectString(raw, 'updated_at'),
  };
}

export function parseDbHeadRevisionRow(raw: unknown): { head_revision_id: number } {
  if (!isRecord(raw)) {
    throw new Error('Expected D1 head revision row object.');
  }
  return { head_revision_id: expectNumber(raw, 'head_revision_id') };
}

export function parseDbReturningRevisionIdRow(raw: unknown): { revision_id: number } {
  if (!isRecord(raw)) {
    throw new Error('Expected D1 returning revision_id row object.');
  }
  return { revision_id: expectNumber(raw, 'revision_id') };
}

export function parseDbReturningRevisionPairRow(raw: unknown): {
  revision_id: number;
  parent_revision_id: number | null;
} {
  if (!isRecord(raw)) {
    throw new Error('Expected D1 returning revision row object.');
  }
  return {
    revision_id: expectNumber(raw, 'revision_id'),
    parent_revision_id: expectNullableNumber(raw, 'parent_revision_id'),
  };
}

function parseJsonObject(raw: string): EntityPayload {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Stored entity JSON must be a plain object.');
  }
  return parsed as EntityPayload;
}

function parseNonKinshipEntityType(raw: string): NonKinshipEntityType {
  const parsed = EntityTypeSchema.parse(raw);
  if (parsed === 'kinship_edge') {
    throw new Error('Unexpected kinship_edge row inside entities table.');
  }
  return parsed;
}

export function mapEntityRow(row: RawDbEntityRow): StoredEntityRow {
  return {
    entity_type: parseNonKinshipEntityType(row.entity_type),
    entity_id: row.entity_id,
    slug: row.slug,
    data: parseJsonObject(row.data_json),
    current_revision_id: asRevisionId(row.current_revision_id),
    has_primary_source: row.has_primary_source !== 0,
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

export function mapKinshipRow(row: RawDbKinshipRow): StoredKinshipRow {
  const edge: KinshipEdge = parseEntityPayload('kinship_edge', {
    from: row.from_person_id,
    to: row.to_person_id,
    relation: row.relation,
    ...(row.family_xref !== null ? { family_xref: row.family_xref } : {}),
  });
  return {
    edge_id: row.edge_id,
    edge,
    current_revision_id: asRevisionId(row.current_revision_id),
    deleted_at: row.deleted_at,
    updated_at: row.updated_at,
  };
}

export function mapRevisionRow(row: RawDbRevisionRow): RevisionRecord {
  return {
    revision_id: asRevisionId(row.revision_id),
    batch_id: row.batch_id,
    entity_type: EntityTypeSchema.parse(row.entity_type),
    entity_id: row.entity_id,
    parent_revision_id: row.parent_revision_id,
    action: RevisionActionSchema.parse(row.action),
    reverted_revision_id: row.reverted_revision_id,
    author_id: row.author_id,
    author_name: row.author_name,
    author_type: AuthorTypeSchema.parse(row.author_type),
    summary: row.summary,
    has_primary_source: row.has_primary_source !== 0,
    before_json: row.before_json !== null ? parseJsonObject(row.before_json) : null,
    after_json: row.after_json !== null ? parseJsonObject(row.after_json) : null,
    created_at: row.created_at,
  };
}

export function mapTalkRow(row: RawDbTalkRow): TalkComment {
  return {
    comment_id: row.comment_id,
    entity_type: EntityTypeSchema.parse(row.entity_type),
    entity_id: row.entity_id,
    author_id: row.author_id,
    author_name: row.author_name,
    body_md: row.body_md,
    created_at: row.created_at,
    edited_at: row.edited_at,
    deleted_at: row.deleted_at,
  };
}

export function mapUserRow(row: RawDbUserRow): UserRecord {
  return {
    email: row.email,
    display_name: row.display_name,
    role: UserRoleSchema.parse(row.role),
    added_by: row.added_by,
    added_at: row.added_at,
    last_login_at: row.last_login_at,
  };
}

export function mapInviteRow(row: RawDbInviteRow): InviteRecord {
  return {
    token: row.token,
    label: row.label,
    created_by: row.created_by,
    created_at: row.created_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    uses: row.uses,
    last_used_at: row.last_used_at,
  };
}

export function mapMagicLinkRow(row: RawDbMagicLinkRow): MagicLinkRecord {
  return {
    token_hash: asSha256Hex(row.token_hash),
    email: row.email,
    invite_token: row.invite_token,
    expires_at: row.expires_at,
    used_at: row.used_at,
  };
}

export function mapAgentTokenRow(row: RawDbAgentTokenRow): AgentTokenRecord {
  return {
    token_id: row.token_id,
    token_hash: asSha256Hex(row.token_hash),
    label: row.label,
    scope: AgentTokenScopeSchema.parse(row.scope),
    created_by: row.created_by,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}
