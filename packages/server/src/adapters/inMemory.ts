import {
  asRevisionId,
  compileArchive,
  computeEntityDiff,
  entityLookupCompositeKey,
  parseEntityPayload,
  patchCompiledBundle,
  resolveEffectiveLiving,
  type AgentTokenRecord,
  type ArchiveBundle,
  type ArchiveRawSnapshot,
  type ArchiveRepository,
  type AtomicMutationOp,
  type AuthProvider,
  type BatchId,
  type BundleCache,
  type CachedBundleObject,
  type Clock,
  type CommitMutationsResult,
  type EmailSender,
  type EntityLookupKey,
  type EntityPayload,
  type EntityType,
  type InviteRecord,
  type KinloomSiteConfig,
  type KinshipEdge,
  type MagicLinkRecord,
  type MediaByteRange,
  type MediaItem,
  type MediaStore,
  type Narrative,
  type OptimisticConflictError,
  type Place,
  type PrivacyConfig,
  type Pronunciation,
  type RawEvent,
  type RawPerson,
  type RevisionAuthor,
  type RevisionId,
  type RevisionQuery,
  type RevisionRecord,
  type Sha256Hex,
  type SourceRecord,
  type StoredEntityRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  type StoredMediaObject,
  type TalkComment,
  type UserRecord,
  type UserRole,
} from '@kinloom/core';
import { bytesToStream, matchesIfNoneMatch, readStreamToBytes } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';
import type { KinloomServerPorts, PronunciationLexiconStore } from '../ports.js';
import { FixedClock } from './systemClock.js';

function entityCompositeKey(entityType: EntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function getRowPayload(row: StoredEntityRow | StoredKinshipRow): EntityPayload {
  if ('edge' in row) {
    return structuredClone(row.edge) as unknown as EntityPayload;
  }
  return structuredClone(row.data);
}

/**
 * Full reference in-memory ArchiveRepository with real atomic optimistic-lock rollback.
 */
export class InMemoryArchiveRepository implements ArchiveRepository {
  private readonly entities = new Map<string, StoredEntityRow>();
  private readonly kinship = new Map<string, StoredKinshipRow>();
  private readonly revisions: RevisionRecord[] = [];
  private readonly talkComments: TalkComment[] = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly invites = new Map<string, InviteRecord>();
  private readonly magicLinks = new Map<string, MagicLinkRecord>();
  private readonly agentTokens = new Map<string, AgentTokenRecord>();
  private nextCommentId = 1;
  private readonly privacyConfig?: Partial<PrivacyConfig>;

  constructor(options?: { privacyConfig?: Partial<PrivacyConfig> }) {
    this.privacyConfig = options?.privacyConfig;
  }

  async getHeadRevisionId(): Promise<RevisionId> {
    const last = this.revisions[this.revisions.length - 1];
    return asRevisionId(last ? last.revision_id : 0);
  }

  async getEntity(
    entityType: EntityType,
    entityId: string
  ): Promise<StoredEntityRecord | null> {
    if (entityType === 'kinship_edge') {
      const row = this.kinship.get(entityId);
      return row ? structuredClone(row) : null;
    }
    const row = this.entities.get(entityCompositeKey(entityType, entityId));
    return row ? structuredClone(row) : null;
  }

  async getEntitiesBatch(
    keys: readonly EntityLookupKey[]
  ): Promise<Map<string, StoredEntityRecord | null>> {
    const result = new Map<string, StoredEntityRecord | null>();
    for (const key of keys) {
      const composite = entityLookupCompositeKey(key.entityType, key.entityId);
      if (result.has(composite)) {
        continue;
      }
      if (key.entityType === 'kinship_edge') {
        const row = this.kinship.get(key.entityId);
        result.set(composite, row ? structuredClone(row) : null);
      } else {
        const row = this.entities.get(composite);
        result.set(composite, row ? structuredClone(row) : null);
      }
    }
    return result;
  }

  async getLivingPersonIds(): Promise<ReadonlySet<string>> {
    const living = new Set<string>();
    for (const row of this.entities.values()) {
      if (row.entity_type !== 'person' || row.deleted_at !== null) {
        continue;
      }
      const parsed = parseEntityPayload('person', row.data);
      if (resolveEffectiveLiving(parsed, this.privacyConfig)) {
        living.add(row.entity_id);
      }
    }
    return living;
  }

  async loadActiveSnapshot(): Promise<ArchiveRawSnapshot> {
    const activeEntities: StoredEntityRow[] = [];
    for (const row of this.entities.values()) {
      if (row.deleted_at === null) {
        activeEntities.push(structuredClone(row));
      }
    }
    activeEntities.sort(
      (a, b) => a.entity_type.localeCompare(b.entity_type) || a.entity_id.localeCompare(b.entity_id)
    );

    const activeKinship: StoredKinshipRow[] = [];
    for (const row of this.kinship.values()) {
      if (row.deleted_at === null) {
        activeKinship.push(structuredClone(row));
      }
    }
    activeKinship.sort((a, b) => a.edge_id.localeCompare(b.edge_id));

    return {
      head_revision_id: await this.getHeadRevisionId(),
      entities: activeEntities,
      kinship: activeKinship,
    };
  }

  private findLastRevisionForEntity(
    entityType: EntityType,
    entityId: string,
    workingRevisions: readonly RevisionRecord[]
  ): RevisionRecord | null {
    for (let i = workingRevisions.length - 1; i >= 0; i -= 1) {
      const rev = workingRevisions[i];
      if (rev.entity_type === entityType && rev.entity_id === entityId) {
        return rev;
      }
    }
    return null;
  }

  private buildConflict(
    op: AtomicMutationOp,
    existing: StoredEntityRow | StoredKinshipRow,
    workingRevisions: readonly RevisionRecord[]
  ): OptimisticConflictError {
    const lastRev = this.findLastRevisionForEntity(op.entity_type, op.entity_id, workingRevisions);
    const serverEntity = existing.deleted_at === null ? getRowPayload(existing) : null;
    return {
      kind: 'conflict',
      entity_type: op.entity_type,
      entity_id: op.entity_id,
      expected_parent_revision_id: op.expected_parent_revision_id,
      server_revision_id: existing.current_revision_id,
      server_entity: serverEntity,
      server_deleted_at: existing.deleted_at,
      last_author_name: lastRev?.author_name ?? 'Unknown editor',
      last_updated_at: existing.updated_at,
      diff: computeEntityDiff(serverEntity, op.after_json),
    };
  }

  async commitAtomicMutations(params: {
    batch_id: BatchId | null;
    author: RevisionAuthor;
    nowIso: string;
    operations: readonly AtomicMutationOp[];
  }): Promise<CommitMutationsResult> {
    // Stage all writes in isolated clones so any optimistic-lock failure rolls back atomically.
    const workingEntities = new Map<string, StoredEntityRow>();
    for (const [key, row] of this.entities.entries()) {
      workingEntities.set(key, structuredClone(row));
    }
    const workingKinship = new Map<string, StoredKinshipRow>();
    for (const [key, row] of this.kinship.entries()) {
      workingKinship.set(key, structuredClone(row));
    }
    const workingRevisions = [...this.revisions];
    const stagedRevisions: RevisionRecord[] = [];
    const mutatedInBatch = new Set<string>();

    let nextRevNum = (workingRevisions[workingRevisions.length - 1]?.revision_id ?? 0) + 1;

    for (const op of params.operations) {
      const key = entityCompositeKey(op.entity_type, op.entity_id);
      const existing: StoredEntityRow | StoredKinshipRow | null =
        op.entity_type === 'kinship_edge'
          ? (workingKinship.get(op.entity_id) ?? null)
          : (workingEntities.get(key) ?? null);

      const alreadyMutatedInBatch = mutatedInBatch.has(key);

      if (op.action === 'create') {
        if (existing !== null) {
          return this.buildConflict(op, existing, workingRevisions);
        }
      } else {
        if (existing === null) {
          return {
            kind: 'conflict',
            entity_type: op.entity_type,
            entity_id: op.entity_id,
            expected_parent_revision_id: op.expected_parent_revision_id,
            server_revision_id: asRevisionId(0),
            server_entity: null,
            server_deleted_at: null,
            last_author_name: 'None',
            last_updated_at: params.nowIso,
            diff: computeEntityDiff(null, op.after_json),
          };
        }

        if (op.expected_parent_revision_id !== null) {
          if (existing.current_revision_id !== op.expected_parent_revision_id) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        } else if (!alreadyMutatedInBatch) {
          return this.buildConflict(op, existing, workingRevisions);
        }

        if (op.action === 'update' || op.action === 'delete') {
          if (existing.deleted_at !== null) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        } else if (op.action === 'restore') {
          if (existing.deleted_at === null) {
            return this.buildConflict(op, existing, workingRevisions);
          }
        }
      }

      const assignedRevId = asRevisionId(nextRevNum);
      nextRevNum += 1;

      const parentRevId = existing ? existing.current_revision_id : null;
      const revRecord: RevisionRecord = {
        revision_id: assignedRevId,
        batch_id: params.batch_id,
        entity_type: op.entity_type,
        entity_id: op.entity_id,
        parent_revision_id: parentRevId,
        action: op.action,
        reverted_revision_id: op.reverted_revision_id ?? null,
        author_id: params.author.author_id,
        author_name: params.author.author_name,
        author_type: params.author.author_type,
        summary: op.summary,
        has_primary_source: op.has_primary_source,
        before_json: op.before_json ? structuredClone(op.before_json) : null,
        after_json: op.after_json ? structuredClone(op.after_json) : null,
        created_at: params.nowIso,
      };

      const isSoftDelete = op.soft_delete === true || op.action === 'delete' || op.after_json === null;

      if (op.entity_type === 'kinship_edge') {
        const nextEdge: KinshipEdge = op.after_json
          ? parseEntityPayload('kinship_edge', op.after_json)
          : (existing as StoredKinshipRow).edge;
        const nextRow: StoredKinshipRow = {
          edge_id: op.entity_id,
          edge: structuredClone(nextEdge),
          current_revision_id: assignedRevId,
          deleted_at: isSoftDelete ? params.nowIso : null,
          updated_at: params.nowIso,
        };
        workingKinship.set(op.entity_id, nextRow);
      } else {
        const prevRow = existing as StoredEntityRow | null;
        const nextData: EntityPayload = op.after_json
          ? structuredClone(op.after_json)
          : structuredClone(prevRow!.data);
        const nextSlug =
          op.slug !== undefined
            ? op.slug
            : typeof nextData.slug === 'string'
              ? nextData.slug
              : (prevRow?.slug ?? null);
        const nextRow: StoredEntityRow = {
          entity_type: op.entity_type,
          entity_id: op.entity_id,
          slug: nextSlug,
          data: nextData,
          current_revision_id: assignedRevId,
          has_primary_source: op.has_primary_source,
          deleted_at: isSoftDelete ? params.nowIso : null,
          updated_at: params.nowIso,
        };
        workingEntities.set(key, nextRow);
      }

      workingRevisions.push(revRecord);
      stagedRevisions.push(revRecord);
      mutatedInBatch.add(key);
    }

    // All operations succeeded: swap staged state atomically.
    this.entities.clear();
    for (const [key, row] of workingEntities.entries()) {
      this.entities.set(key, row);
    }
    this.kinship.clear();
    for (const [key, row] of workingKinship.entries()) {
      this.kinship.set(key, row);
    }
    this.revisions.push(...stagedRevisions);

    return {
      kind: 'committed',
      head_revision_id: await this.getHeadRevisionId(),
      revisions: stagedRevisions.map((r) => structuredClone(r)),
    };
  }

  async listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const filtered: RevisionRecord[] = [];
    for (let i = this.revisions.length - 1; i >= 0; i -= 1) {
      const rev = this.revisions[i];
      if (query.cursor !== undefined && rev.revision_id >= query.cursor) {
        continue;
      }
      if (query.entity_type && rev.entity_type !== query.entity_type) {
        continue;
      }
      if (query.entity_id && rev.entity_id !== query.entity_id) {
        continue;
      }
      if (query.batch_id && rev.batch_id !== query.batch_id) {
        continue;
      }
      if (query.author_type && rev.author_type !== query.author_type) {
        continue;
      }
      filtered.push(structuredClone(rev));
      if (filtered.length > limit) {
        break;
      }
    }

    const hasMore = filtered.length > limit;
    const items = hasMore ? filtered.slice(0, limit) : filtered;
    const lastItem = items[items.length - 1];
    return {
      items,
      next_cursor: hasMore && lastItem ? asRevisionId(lastItem.revision_id) : null,
    };
  }

  async getRevisionById(revisionId: RevisionId): Promise<RevisionRecord | null> {
    const found = this.revisions.find((r) => r.revision_id === revisionId);
    return found ? structuredClone(found) : null;
  }

  async getRevisionsByBatch(batchId: BatchId): Promise<readonly RevisionRecord[]> {
    return this.revisions
      .filter((r) => r.batch_id === batchId)
      .toSorted((a, b) => a.revision_id - b.revision_id)
      .map((r) => structuredClone(r));
  }

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    return this.talkComments
      .filter(
        (c) => c.entity_type === entityType && c.entity_id === entityId && c.deleted_at === null
      )
      .toSorted((a, b) => a.comment_id - b.comment_id)
      .map((c) => structuredClone(c));
  }

  async insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment> {
    const comment: TalkComment = {
      comment_id: this.nextCommentId,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      author_id: input.author_id,
      author_name: input.author_name,
      body_md: input.body_md,
      created_at: input.created_at,
      edited_at: null,
      deleted_at: null,
    };
    this.nextCommentId += 1;
    this.talkComments.push(comment);
    return structuredClone(comment);
  }

  async softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean> {
    const comment = this.talkComments.find((c) => c.comment_id === commentId && c.deleted_at === null);
    if (!comment) {
      return false;
    }
    comment.deleted_at = deletedAt;
    return true;
  }

  async getUser(email: string): Promise<UserRecord | null> {
    const record = this.users.get(email.trim().toLowerCase());
    return record ? structuredClone(record) : null;
  }

  async listUsers(): Promise<readonly UserRecord[]> {
    return [...this.users.values()]
      .toSorted((a, b) => a.email.localeCompare(b.email))
      .map((u) => structuredClone(u));
  }

  async upsertUser(user: UserRecord): Promise<UserRecord> {
    const normalized: UserRecord = {
      ...structuredClone(user),
      email: user.email.trim().toLowerCase(),
    };
    this.users.set(normalized.email, normalized);
    return structuredClone(normalized);
  }

  async updateUserRole(email: string, role: UserRole): Promise<UserRecord | null> {
    const key = email.trim().toLowerCase();
    const existing = this.users.get(key);
    if (!existing) {
      return null;
    }
    existing.role = role;
    return structuredClone(existing);
  }

  async deleteUser(email: string): Promise<boolean> {
    return this.users.delete(email.trim().toLowerCase());
  }

  async touchUserLogin(email: string, atIso: string): Promise<void> {
    const existing = this.users.get(email.trim().toLowerCase());
    if (existing) {
      existing.last_login_at = atIso;
    }
  }

  async getInvite(token: string): Promise<InviteRecord | null> {
    const invite = this.invites.get(token);
    return invite ? structuredClone(invite) : null;
  }

  async listInvites(): Promise<readonly InviteRecord[]> {
    return [...this.invites.values()]
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
      .map((i) => structuredClone(i));
  }

  async createInvite(invite: InviteRecord): Promise<InviteRecord> {
    const clone = structuredClone(invite);
    this.invites.set(clone.token, clone);
    return structuredClone(clone);
  }

  async recordInviteUse(token: string, atIso: string): Promise<void> {
    const invite = this.invites.get(token);
    if (invite) {
      invite.uses += 1;
      invite.last_used_at = atIso;
    }
  }

  async revokeInvite(token: string, atIso: string): Promise<boolean> {
    const invite = this.invites.get(token);
    if (!invite || invite.revoked_at !== null) {
      return false;
    }
    invite.revoked_at = atIso;
    return true;
  }

  async insertMagicLink(record: MagicLinkRecord): Promise<void> {
    const normalized: MagicLinkRecord = {
      ...structuredClone(record),
      email: record.email.trim().toLowerCase(),
    };
    this.magicLinks.set(normalized.token_hash, normalized);
  }

  async getMagicLink(tokenHash: Sha256Hex): Promise<MagicLinkRecord | null> {
    const record = this.magicLinks.get(tokenHash);
    return record ? structuredClone(record) : null;
  }

  async countRecentMagicLinks(email: string, sinceIso: string): Promise<number> {
    const normalized = email.trim().toLowerCase();
    let count = 0;
    for (const record of this.magicLinks.values()) {
      if (record.email.trim().toLowerCase() === normalized && record.expires_at > sinceIso) {
        count += 1;
      }
    }
    return count;
  }

  async consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null> {
    const record = this.magicLinks.get(tokenHash);
    if (!record || record.used_at !== null) {
      return null;
    }
    const expiresMs = Date.parse(record.expires_at);
    const nowMs = Date.parse(nowIso);
    if (Number.isNaN(expiresMs) || Number.isNaN(nowMs) || expiresMs <= nowMs) {
      return null;
    }
    record.used_at = nowIso;
    return structuredClone(record);
  }

  async findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null> {
    for (const token of this.agentTokens.values()) {
      if (token.token_hash === tokenHash && token.revoked_at === null) {
        return structuredClone(token);
      }
    }
    return null;
  }

  async listAgentTokens(): Promise<readonly AgentTokenRecord[]> {
    return [...this.agentTokens.values()]
      .toSorted((a, b) => b.created_at.localeCompare(a.created_at))
      .map((t) => structuredClone(t));
  }

  async createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord> {
    const clone = structuredClone(record);
    this.agentTokens.set(clone.token_id, clone);
    return structuredClone(clone);
  }

  async revokeAgentToken(tokenId: string, atIso: string): Promise<boolean> {
    const token = this.agentTokens.get(tokenId);
    if (!token || token.revoked_at !== null) {
      return false;
    }
    token.revoked_at = atIso;
    return true;
  }
}

export function extractCollectionsFromSnapshot(snapshot: ArchiveRawSnapshot): {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  media: MediaItem[];
  narratives: Narrative[];
  kinship: KinshipEdge[];
} {
  const people: RawPerson[] = [];
  const events: RawEvent[] = [];
  const places: Place[] = [];
  const sources: SourceRecord[] = [];
  const media: MediaItem[] = [];
  const narratives: Narrative[] = [];

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null) {
      continue;
    }
    switch (row.entity_type) {
      case 'person': {
        const parsed = parseEntityPayload('person', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        people.push(parsed);
        break;
      }
      case 'event': {
        const parsed = parseEntityPayload('event', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        events.push(parsed);
        break;
      }
      case 'place': {
        const parsed = parseEntityPayload('place', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        places.push(parsed);
        break;
      }
      case 'source': {
        const parsed = parseEntityPayload('source', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        sources.push(parsed);
        break;
      }
      case 'media': {
        const parsed = parseEntityPayload('media', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        media.push(parsed);
        break;
      }
      case 'narrative': {
        const parsed = parseEntityPayload('narrative', row.data);
        if (!row.has_primary_source && parsed.has_primary_source === undefined) {
          parsed.has_primary_source = false;
        }
        narratives.push(parsed);
        break;
      }
      default: {
        const _exhaustive: never = row.entity_type;
        throw new Error(`Unhandled entity type: ${String(_exhaustive)}`);
      }
    }
  }

  const kinship = snapshot.kinship
    .filter((row) => row.deleted_at === null)
    .map((row) => structuredClone(row.edge));

  return { people, events, places, sources, media, narratives, kinship };
}

/**
 * In-memory incremental BundleCache using @kinloom/core patchCompiledBundle + compileArchive.
 */
export class InMemoryIncrementalBundleCache implements BundleCache {
  private readonly siteConfig: KinloomSiteConfig;
  private readonly clock: Clock;
  private cached: CachedBundleObject | null = null;
  public rebuildCount = 0;
  public incrementalPatchCount = 0;

  constructor(siteConfig: KinloomSiteConfig, clock: Clock) {
    this.siteConfig = siteConfig;
    this.clock = clock;
  }

  invalidate(): void {
    this.cached = null;
  }

  async getCached(ifNoneMatch: string | null): Promise<
    | { status: 'not_modified'; etag: string }
    | { status: 'hit'; object: CachedBundleObject }
    | { status: 'miss' }
  > {
    if (!this.cached) {
      return { status: 'miss' };
    }
    if (matchesIfNoneMatch(ifNoneMatch, this.cached.etag)) {
      return { status: 'not_modified', etag: this.cached.etag };
    }
    return {
      status: 'hit',
      object: {
        ...this.cached,
      },
    };
  }

  async rebuildAndStore(snapshot: ArchiveRawSnapshot): Promise<CachedBundleObject> {
    const collections = extractCollectionsFromSnapshot(snapshot);
    const generatedAt = this.clock.nowIso();
    const { bundle } = compileArchive({
      ...collections,
      siteConfig: this.siteConfig,
      mode: 'private',
      generatedAt,
      maxRevisionId: snapshot.head_revision_id,
    });
    this.rebuildCount += 1;
    return this.storeBundle(bundle, snapshot.head_revision_id, generatedAt);
  }

  async applyMutationsAndStore(
    previous: ArchiveBundle,
    mutations: readonly RevisionRecord[]
  ): Promise<CachedBundleObject> {
    const generatedAt = this.clock.nowIso();
    const patched = patchCompiledBundle(previous, mutations, this.siteConfig, 'private', {
      generatedAt,
    });
    let maxRev = previous.meta.max_revision_id ?? 0;
    for (const m of mutations) {
      if (m.revision_id > maxRev) {
        maxRev = m.revision_id;
      }
    }
    this.incrementalPatchCount += 1;
    return this.storeBundle(patched, asRevisionId(maxRev), generatedAt);
  }

  private storeBundle(
    bundle: ArchiveBundle,
    revisionId: RevisionId,
    generatedAt: string
  ): CachedBundleObject {
    const serialized = JSON.stringify(bundle);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    const object: CachedBundleObject = {
      etag: `"r${revisionId}"`,
      revision_id: revisionId,
      body: serialized,
      byteLength,
      generated_at: generatedAt,
    };
    this.cached = object;
    return object;
  }
}

interface StoredBlobEntry {
  bytes: Uint8Array;
  contentType: string;
  sha256: Sha256Hex;
}

/**
 * In-memory content-addressed MediaStore with HTTP 206 byte-range slice support.
 */
export class InMemoryMediaStore implements MediaStore {
  private readonly blobs = new Map<string, StoredBlobEntry>();
  public putCount = 0;

  async head(key: string): Promise<{ exists: boolean; sizeBytes?: number; contentType?: string }> {
    const entry = this.blobs.get(key);
    if (!entry) {
      return { exists: false };
    }
    return {
      exists: true,
      sizeBytes: entry.bytes.byteLength,
      contentType: entry.contentType,
    };
  }

  async put(params: {
    key: string;
    body: ArrayBuffer | ReadableStream<Uint8Array>;
    contentType: string;
    sha256: Sha256Hex;
  }): Promise<void> {
    const bytes =
      params.body instanceof ArrayBuffer
        ? new Uint8Array(params.body.slice(0))
        : await readStreamToBytes(params.body);
    this.blobs.set(params.key, {
      bytes,
      contentType: params.contentType,
      sha256: params.sha256,
    });
    this.putCount += 1;
  }

  async get(key: string, options?: { range?: MediaByteRange }): Promise<StoredMediaObject | null> {
    const entry = this.blobs.get(key);
    if (!entry) {
      return null;
    }
    const total = entry.bytes.byteLength;
    if (options?.range) {
      const start = Math.max(0, options.range.offset);
      const endExclusive =
        options.range.length !== undefined
          ? Math.min(total, start + options.range.length)
          : total;
      const slice = entry.bytes.slice(start, endExclusive);
      return {
        key,
        contentType: entry.contentType,
        sizeBytes: slice.byteLength,
        sha256: entry.sha256,
        body: bytesToStream(slice),
        range: {
          start,
          end: start + slice.byteLength - 1,
          total,
        },
      };
    }

    return {
      key,
      contentType: entry.contentType,
      sizeBytes: total,
      sha256: entry.sha256,
      body: bytesToStream(entry.bytes),
    };
  }
}

export interface SentMagicLinkEmail {
  toEmail: string;
  siteTitle: string;
  magicLinkUrl: string;
  expiresMinutes: number;
}

export class InMemoryEmailSender implements EmailSender {
  readonly sentMessages: SentMagicLinkEmail[] = [];

  async sendMagicLink(params: SentMagicLinkEmail): Promise<void> {
    this.sentMessages.push({ ...params });
  }
}

export interface FakeOAuthProfile {
  email: string;
  displayName: string;
  emailVerified: boolean;
}

export class FakeAuthProvider implements AuthProvider {
  readonly id = 'fake-google';
  private readonly profilesByCode = new Map<string, FakeOAuthProfile>();
  public lastAuthorizationParams: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'select_account' | 'consent';
  } | null = null;
  public lastExchangeParams: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  } | null = null;

  registerCode(code: string, profile: FakeOAuthProfile): void {
    this.profilesByCode.set(code, profile);
  }

  buildAuthorizationUrl(params: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
    prompt?: 'select_account' | 'consent';
  }): string {
    this.lastAuthorizationParams = { ...params };
    const url = new URL('https://accounts.example.test/oauth/authorize');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('redirect_uri', params.redirectUri);
    if (params.prompt) {
      url.searchParams.set('prompt', params.prompt);
    }
    return url.toString();
  }

  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<FakeOAuthProfile> {
    this.lastExchangeParams = { ...params };
    const profile = this.profilesByCode.get(params.code);
    if (!profile) {
      throw new KinloomHttpError(400, 'INVALID_OAUTH_STATE', `Unknown OAuth code: ${params.code}`);
    }
    return { ...profile };
  }
}

export class InMemoryPronunciationLexiconStore implements PronunciationLexiconStore {
  private readonly entries = new Map<string, Pronunciation>();

  async list(): Promise<Record<string, Pronunciation>> {
    const out: Record<string, Pronunciation> = {};
    for (const [term, entry] of [...this.entries.entries()].toSorted(([a], [b]) =>
      a.localeCompare(b)
    )) {
      out[term] = structuredClone(entry);
    }
    return out;
  }

  async upsert(
    term: string,
    entry: Pronunciation,
    _updatedBy: string,
    _updatedAt: string
  ): Promise<Pronunciation> {
    const clone = structuredClone(entry);
    this.entries.set(term, clone);
    return structuredClone(clone);
  }

  async delete(term: string): Promise<void> {
    this.entries.delete(term);
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
