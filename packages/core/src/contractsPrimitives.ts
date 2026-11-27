import type { EntityDiffSummary } from './revisions.js';
import type { KinshipEdge } from './schemas/entities.js';
import {
  type AgentTokenScope,
  type AuthorType,
  type EntityPayload,
  type EntityType,
  type RevisionAction,
  type RevisionRecord,
  toEntityPayload,
  type UserRole,
} from './schemas/revisions.js';

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

export function storedRecordToEntityPayload(row: StoredEntityRecord): EntityPayload {
  if ('edge' in row) {
    return toEntityPayload(structuredClone(row.edge));
  }
  return structuredClone(row.data);
}

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
