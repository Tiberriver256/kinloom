import type {
  AccessControlStore,
  AgentTokenRecord,
  EntityType,
  InviteRecord,
  MagicLinkRecord,
  Sha256Hex,
  TalkComment,
  TalkCommentStore,
  UserRecord,
  UserRole,
} from '@kinloom/core';

/**
 * In-memory persistence for talk comments, users, invites, magic links, and scoped agent tokens.
 */
export class InMemoryAccessAndTalkStore implements AccessControlStore, TalkCommentStore {
  private readonly talkComments: TalkComment[] = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly invites = new Map<string, InviteRecord>();
  private readonly magicLinks = new Map<string, MagicLinkRecord>();
  private readonly agentTokens = new Map<string, AgentTokenRecord>();
  private nextCommentId = 1;

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    return this.talkComments
      .filter((c) => c.entity_type === entityType && c.entity_id === entityId && c.deleted_at === null)
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
