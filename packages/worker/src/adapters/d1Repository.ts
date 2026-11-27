import type {
  AgentTokenRecord,
  ArchiveRawSnapshot,
  ArchiveRepository,
  AtomicMutationOp,
  BatchId,
  CommitMutationsResult,
  EntityLookupKey,
  EntityType,
  InviteRecord,
  MagicLinkRecord,
  PrivacyConfig,
  RevisionAuthor,
  RevisionId,
  RevisionQuery,
  RevisionRecord,
  Sha256Hex,
  StoredEntityRecord,
  TalkComment,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import type { D1Database } from '../types.js';
import { D1AccessAndTalkStore } from './d1/accessAndTalkStore.js';
import { D1AtomicMutationStore } from './d1/atomicMutationStore.js';
import { D1EntityReadStore } from './d1/entityReadStore.js';

export interface D1ArchiveRepositoryOptions {
  privacyConfig?: Partial<PrivacyConfig>;
}

/**
 * Cloudflare D1 implementation of ArchiveRepository.
 * Composes entity reads, atomic DB.batch() mutations, and access/talk persistence stores.
 */
export class D1ArchiveRepository implements ArchiveRepository {
  private readonly entityReads: D1EntityReadStore;
  private readonly atomicMutations: D1AtomicMutationStore;
  private readonly accessAndTalk: D1AccessAndTalkStore;

  constructor(db: D1Database, options?: D1ArchiveRepositoryOptions) {
    this.entityReads = new D1EntityReadStore(db, options?.privacyConfig);
    this.atomicMutations = new D1AtomicMutationStore(db, this.entityReads);
    this.accessAndTalk = new D1AccessAndTalkStore(db);
  }

  getHeadRevisionId(): Promise<RevisionId> {
    return this.entityReads.getHeadRevisionId();
  }

  getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null> {
    return this.entityReads.getEntity(entityType, entityId);
  }

  getEntitiesBatch(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>> {
    return this.entityReads.getEntitiesBatch(keys);
  }

  getLivingPersonIds(): Promise<ReadonlySet<string>> {
    return this.entityReads.getLivingPersonIds();
  }

  loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    return this.entityReads.loadActiveSnapshot();
  }

  commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    return this.atomicMutations.commitAtomicMutations(params);
  }

  listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    return this.entityReads.listRevisions(query);
  }

  getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    return this.entityReads.getRevisionById(revisionId);
  }

  getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    return this.entityReads.getRevisionsByBatch(batchId);
  }

  listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    return this.accessAndTalk.listTalkComments(entityType, entityId);
  }

  insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment> {
    return this.accessAndTalk.insertTalkComment(input);
  }

  softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean> {
    return this.accessAndTalk.softDeleteTalkComment(commentId, deletedAt);
  }

  getUser(email: string): Promise<UserRecord | null> {
    return this.accessAndTalk.getUser(email);
  }

  listUsers(): Promise<readonly UserRecord[]> {
    return this.accessAndTalk.listUsers();
  }

  upsertUser(user: UserRecord): Promise<UserRecord> {
    return this.accessAndTalk.upsertUser(user);
  }

  updateUserRole(email: string, role: UserRole): Promise<UserRecord | null> {
    return this.accessAndTalk.updateUserRole(email, role);
  }

  deleteUser(email: string): Promise<boolean> {
    return this.accessAndTalk.deleteUser(email);
  }

  touchUserLogin(email: string, atIso: string): Promise<void> {
    return this.accessAndTalk.touchUserLogin(email, atIso);
  }

  getInvite(token: string): Promise<InviteRecord | null> {
    return this.accessAndTalk.getInvite(token);
  }

  listInvites(): Promise<readonly InviteRecord[]> {
    return this.accessAndTalk.listInvites();
  }

  createInvite(invite: InviteRecord): Promise<InviteRecord> {
    return this.accessAndTalk.createInvite(invite);
  }

  recordInviteUse(token: string, atIso: string): Promise<void> {
    return this.accessAndTalk.recordInviteUse(token, atIso);
  }

  revokeInvite(token: string, atIso: string): Promise<boolean> {
    return this.accessAndTalk.revokeInvite(token, atIso);
  }

  insertMagicLink(record: MagicLinkRecord): Promise<void> {
    return this.accessAndTalk.insertMagicLink(record);
  }

  getMagicLink(tokenHash: Sha256Hex): Promise<MagicLinkRecord | null> {
    return this.accessAndTalk.getMagicLink(tokenHash);
  }

  countRecentMagicLinks(email: string, sinceIso: string): Promise<number> {
    return this.accessAndTalk.countRecentMagicLinks(email, sinceIso);
  }

  consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null> {
    return this.accessAndTalk.consumeMagicLink(tokenHash, nowIso);
  }

  findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null> {
    return this.accessAndTalk.findActiveAgentTokenByHash(tokenHash);
  }

  listAgentTokens(): Promise<readonly AgentTokenRecord[]> {
    return this.accessAndTalk.listAgentTokens();
  }

  createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord> {
    return this.accessAndTalk.createAgentToken(record);
  }

  revokeAgentToken(tokenId: string, atIso: string): Promise<boolean> {
    return this.accessAndTalk.revokeAgentToken(tokenId, atIso);
  }
}
