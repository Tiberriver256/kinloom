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
  KinloomSiteConfig,
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
import type { KinloomServerPorts } from '../ports.js';
import { InMemoryAccessAndTalkStore } from './inMemory/accessAndTalkStore.js';
import { FakeAuthProvider, InMemoryEmailSender } from './inMemory/authAndEmailFakes.js';
import {
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPronunciationLexiconStore,
} from './inMemory/bundleAndMediaStores.js';
import { InMemoryEntityAndMutationStore } from './inMemory/entityAndMutationStore.js';
import { FixedClock } from './systemClock.js';

export {
  FakeAuthProvider,
  type FakeOAuthProfile,
  InMemoryEmailSender,
  type SentMagicLinkEmail,
} from './inMemory/authAndEmailFakes.js';
export {
  extractCollectionsFromSnapshot,
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPronunciationLexiconStore,
} from './inMemory/bundleAndMediaStores.js';

/**
 * Full reference in-memory ArchiveRepository composing entity/mutation and access/talk stores.
 */
export class InMemoryArchiveRepository implements ArchiveRepository {
  private readonly entityStore: InMemoryEntityAndMutationStore;
  private readonly accessStore = new InMemoryAccessAndTalkStore();

  constructor(options?: { privacyConfig?: Partial<PrivacyConfig> }) {
    this.entityStore = new InMemoryEntityAndMutationStore(options);
  }

  getHeadRevisionId(): Promise<RevisionId> {
    return this.entityStore.getHeadRevisionId();
  }

  getEntity(entityType: EntityType, entityId: string): Promise<StoredEntityRecord | null> {
    return this.entityStore.getEntity(entityType, entityId);
  }

  getEntitiesBatch(keys: readonly EntityLookupKey[]): Promise<Map<string, StoredEntityRecord | null>> {
    return this.entityStore.getEntitiesBatch(keys);
  }

  getLivingPersonIds(): Promise<ReadonlySet<string>> {
    return this.entityStore.getLivingPersonIds();
  }

  loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    return this.entityStore.loadActiveSnapshot();
  }

  commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    return this.entityStore.commitAtomicMutations(params);
  }

  listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    return this.entityStore.listRevisions(query);
  }

  getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    return this.entityStore.getRevisionById(revisionId);
  }

  getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    return this.entityStore.getRevisionsByBatch(batchId);
  }

  listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    return this.accessStore.listTalkComments(entityType, entityId);
  }

  insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment> {
    return this.accessStore.insertTalkComment(input);
  }

  softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean> {
    return this.accessStore.softDeleteTalkComment(commentId, deletedAt);
  }

  getUser(email: string): Promise<UserRecord | null> {
    return this.accessStore.getUser(email);
  }

  listUsers(): Promise<readonly UserRecord[]> {
    return this.accessStore.listUsers();
  }

  upsertUser(user: UserRecord): Promise<UserRecord> {
    return this.accessStore.upsertUser(user);
  }

  updateUserRole(email: string, role: UserRole): Promise<UserRecord | null> {
    return this.accessStore.updateUserRole(email, role);
  }

  deleteUser(email: string): Promise<boolean> {
    return this.accessStore.deleteUser(email);
  }

  touchUserLogin(email: string, atIso: string): Promise<void> {
    return this.accessStore.touchUserLogin(email, atIso);
  }

  getInvite(token: string): Promise<InviteRecord | null> {
    return this.accessStore.getInvite(token);
  }

  listInvites(): Promise<readonly InviteRecord[]> {
    return this.accessStore.listInvites();
  }

  createInvite(invite: InviteRecord): Promise<InviteRecord> {
    return this.accessStore.createInvite(invite);
  }

  recordInviteUse(token: string, atIso: string): Promise<void> {
    return this.accessStore.recordInviteUse(token, atIso);
  }

  revokeInvite(token: string, atIso: string): Promise<boolean> {
    return this.accessStore.revokeInvite(token, atIso);
  }

  insertMagicLink(record: MagicLinkRecord): Promise<void> {
    return this.accessStore.insertMagicLink(record);
  }

  getMagicLink(tokenHash: Sha256Hex): Promise<MagicLinkRecord | null> {
    return this.accessStore.getMagicLink(tokenHash);
  }

  countRecentMagicLinks(email: string, sinceIso: string): Promise<number> {
    return this.accessStore.countRecentMagicLinks(email, sinceIso);
  }

  consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null> {
    return this.accessStore.consumeMagicLink(tokenHash, nowIso);
  }

  findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null> {
    return this.accessStore.findActiveAgentTokenByHash(tokenHash);
  }

  listAgentTokens(): Promise<readonly AgentTokenRecord[]> {
    return this.accessStore.listAgentTokens();
  }

  createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord> {
    return this.accessStore.createAgentToken(record);
  }

  revokeAgentToken(tokenId: string, atIso: string): Promise<boolean> {
    return this.accessStore.revokeAgentToken(tokenId, atIso);
  }
}

export interface InMemoryServerPortsBundle extends KinloomServerPorts {
  repository: InMemoryArchiveRepository;
  bundleCache: InMemoryIncrementalBundleCache;
  mediaStore: InMemoryMediaStore;
  emailSender: InMemoryEmailSender;
  authProvider: FakeAuthProvider;
  clock: FixedClock;
  pronunciationLexiconStore: InMemoryPronunciationLexiconStore;
}

export function createInMemoryServerPorts(
  siteConfig: KinloomSiteConfig,
  options?: { initialIso?: string }
): InMemoryServerPortsBundle {
  const clock = new FixedClock(options?.initialIso ?? '2026-06-01T12:00:00.000Z');
  const repository = new InMemoryArchiveRepository({ privacyConfig: siteConfig.privacy });
  const bundleCache = new InMemoryIncrementalBundleCache(siteConfig, clock);
  const mediaStore = new InMemoryMediaStore();
  const emailSender = new InMemoryEmailSender();
  const authProvider = new FakeAuthProvider();
  const pronunciationLexiconStore = new InMemoryPronunciationLexiconStore();

  return {
    repository,
    bundleCache,
    mediaStore,
    emailSender,
    authProvider,
    clock,
    pronunciationLexiconStore,
  };
}
