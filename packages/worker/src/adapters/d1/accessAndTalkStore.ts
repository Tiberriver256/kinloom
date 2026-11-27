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
import type { D1Database } from '../../types.js';
import {
  mapAgentTokenRow,
  mapInviteRow,
  mapMagicLinkRow,
  mapTalkRow,
  mapUserRow,
  type RawDbAgentTokenRow,
  type RawDbInviteRow,
  type RawDbMagicLinkRow,
  type RawDbTalkRow,
  type RawDbUserRow,
} from './rowMappers.js';
import { prepareD1Statement } from './sqlHelpers.js';

export class D1AccessAndTalkStore implements AccessControlStore, TalkCommentStore {
  constructor(private readonly db: D1Database) {}

  async listTalkComments(entityType: EntityType, entityId: string): Promise<readonly TalkComment[]> {
    const res = await prepareD1Statement(
      this.db,
      `SELECT comment_id, entity_type, entity_id, author_id, author_name,
                body_md, created_at, edited_at, deleted_at
         FROM talk_comments
         WHERE entity_type = ? AND entity_id = ? AND deleted_at IS NULL
         ORDER BY comment_id ASC`
    )
      .bind(entityType, entityId)
      .all<RawDbTalkRow>();
    return res.results.map(mapTalkRow);
  }

  async insertTalkComment(input: {
    entity_type: EntityType;
    entity_id: string;
    author_id: string;
    author_name: string;
    body_md: string;
    created_at: string;
  }): Promise<TalkComment> {
    const row = await prepareD1Statement(
      this.db,
      `INSERT INTO talk_comments (
           entity_type, entity_id, author_id, author_name, body_md, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         RETURNING comment_id, entity_type, entity_id, author_id, author_name,
                   body_md, created_at, edited_at, deleted_at`
    )
      .bind(
        input.entity_type,
        input.entity_id,
        input.author_id,
        input.author_name,
        input.body_md,
        input.created_at
      )
      .first<RawDbTalkRow>();

    if (!row) {
      throw new Error('Failed to insert talk comment.');
    }
    return mapTalkRow(row);
  }

  async softDeleteTalkComment(commentId: number, deletedAt: string): Promise<boolean> {
    const res = await prepareD1Statement(
      this.db,
      `UPDATE talk_comments
         SET deleted_at = ?
         WHERE comment_id = ? AND deleted_at IS NULL`
    )
      .bind(deletedAt, commentId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async getUser(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const row = await prepareD1Statement(
      this.db,
      `SELECT email, display_name, role, added_by, added_at, last_login_at
         FROM users
         WHERE email = ?`
    )
      .bind(normalized)
      .first<RawDbUserRow>();
    return row ? mapUserRow(row) : null;
  }

  async listUsers(): Promise<readonly UserRecord[]> {
    const res = await prepareD1Statement(
      this.db,
      `SELECT email, display_name, role, added_by, added_at, last_login_at
         FROM users
         ORDER BY email ASC`
    ).all<RawDbUserRow>();
    return res.results.map(mapUserRow);
  }

  async upsertUser(user: UserRecord): Promise<UserRecord> {
    const normalizedEmail = user.email.trim().toLowerCase();
    const row = await prepareD1Statement(
      this.db,
      `INSERT INTO users (email, display_name, role, added_by, added_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           display_name = excluded.display_name,
           role = excluded.role,
           added_by = excluded.added_by,
           added_at = excluded.added_at,
           last_login_at = excluded.last_login_at
         RETURNING email, display_name, role, added_by, added_at, last_login_at`
    )
      .bind(normalizedEmail, user.display_name, user.role, user.added_by, user.added_at, user.last_login_at)
      .first<RawDbUserRow>();

    if (!row) {
      throw new Error(`Failed to upsert user '${normalizedEmail}'.`);
    }
    return mapUserRow(row);
  }

  async updateUserRole(email: string, role: UserRole): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    const row = await prepareD1Statement(
      this.db,
      `UPDATE users
         SET role = ?
         WHERE email = ?
         RETURNING email, display_name, role, added_by, added_at, last_login_at`
    )
      .bind(role, normalized)
      .first<RawDbUserRow>();
    return row ? mapUserRow(row) : null;
  }

  async deleteUser(email: string): Promise<boolean> {
    const normalized = email.trim().toLowerCase();
    const res = await prepareD1Statement(this.db, 'DELETE FROM users WHERE email = ?').bind(normalized).run();
    return (res.meta.changes ?? 0) > 0;
  }

  async touchUserLogin(email: string, atIso: string): Promise<void> {
    const normalized = email.trim().toLowerCase();
    await prepareD1Statement(this.db, 'UPDATE users SET last_login_at = ? WHERE email = ?')
      .bind(atIso, normalized)
      .run();
  }

  async getInvite(token: string): Promise<InviteRecord | null> {
    const row = await prepareD1Statement(
      this.db,
      `SELECT token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         FROM invites
         WHERE token = ?`
    )
      .bind(token)
      .first<RawDbInviteRow>();
    return row ? mapInviteRow(row) : null;
  }

  async listInvites(): Promise<readonly InviteRecord[]> {
    const res = await prepareD1Statement(
      this.db,
      `SELECT token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         FROM invites
         ORDER BY created_at DESC`
    ).all<RawDbInviteRow>();
    return res.results.map(mapInviteRow);
  }

  async createInvite(invite: InviteRecord): Promise<InviteRecord> {
    const row = await prepareD1Statement(
      this.db,
      `INSERT INTO invites (
           token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING token, label, created_by, created_at, expires_at, revoked_at, uses, last_used_at`
    )
      .bind(
        invite.token,
        invite.label,
        invite.created_by,
        invite.created_at,
        invite.expires_at,
        invite.revoked_at,
        invite.uses,
        invite.last_used_at
      )
      .first<RawDbInviteRow>();

    if (!row) {
      throw new Error(`Failed to create invite '${invite.token}'.`);
    }
    return mapInviteRow(row);
  }

  async recordInviteUse(token: string, atIso: string): Promise<void> {
    await prepareD1Statement(this.db, 'UPDATE invites SET uses = uses + 1, last_used_at = ? WHERE token = ?')
      .bind(atIso, token)
      .run();
  }

  async revokeInvite(token: string, atIso: string): Promise<boolean> {
    const res = await prepareD1Statement(
      this.db,
      'UPDATE invites SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL'
    )
      .bind(atIso, token)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async insertMagicLink(record: MagicLinkRecord): Promise<void> {
    const normalizedEmail = record.email.trim().toLowerCase();
    await prepareD1Statement(
      this.db,
      `INSERT INTO magic_links (token_hash, email, invite_token, expires_at, used_at)
         VALUES (?, ?, ?, ?, ?)`
    )
      .bind(record.token_hash, normalizedEmail, record.invite_token, record.expires_at, record.used_at)
      .run();
  }

  async getMagicLink(tokenHash: Sha256Hex): Promise<MagicLinkRecord | null> {
    const row = await prepareD1Statement(
      this.db,
      `SELECT token_hash, email, invite_token, expires_at, used_at
         FROM magic_links
         WHERE token_hash = ?`
    )
      .bind(tokenHash)
      .first<RawDbMagicLinkRow>();
    return row ? mapMagicLinkRow(row) : null;
  }

  async countRecentMagicLinks(email: string, sinceIso: string): Promise<number> {
    const normalized = email.trim().toLowerCase();
    const row = await prepareD1Statement(
      this.db,
      `SELECT COUNT(*) AS count
         FROM magic_links
         WHERE email = ? AND expires_at > ?`
    )
      .bind(normalized, sinceIso)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  async consumeMagicLink(tokenHash: Sha256Hex, nowIso: string): Promise<MagicLinkRecord | null> {
    // Single atomic UPDATE prevents replay races across concurrent verification requests.
    const row = await prepareD1Statement(
      this.db,
      `UPDATE magic_links
         SET used_at = ?
         WHERE token_hash = ?
           AND used_at IS NULL
           AND expires_at > ?
         RETURNING token_hash, email, invite_token, expires_at, used_at`
    )
      .bind(nowIso, tokenHash, nowIso)
      .first<RawDbMagicLinkRow>();
    return row ? mapMagicLinkRow(row) : null;
  }

  async findActiveAgentTokenByHash(tokenHash: Sha256Hex): Promise<AgentTokenRecord | null> {
    const row = await prepareD1Statement(
      this.db,
      `SELECT token_id, token_hash, label, scope, created_by, created_at, revoked_at
         FROM agent_tokens
         WHERE token_hash = ? AND revoked_at IS NULL`
    )
      .bind(tokenHash)
      .first<RawDbAgentTokenRow>();
    return row ? mapAgentTokenRow(row) : null;
  }

  async listAgentTokens(): Promise<readonly AgentTokenRecord[]> {
    const res = await prepareD1Statement(
      this.db,
      `SELECT token_id, token_hash, label, scope, created_by, created_at, revoked_at
         FROM agent_tokens
         ORDER BY created_at DESC`
    ).all<RawDbAgentTokenRow>();
    return res.results.map(mapAgentTokenRow);
  }

  async createAgentToken(record: AgentTokenRecord): Promise<AgentTokenRecord> {
    const row = await prepareD1Statement(
      this.db,
      `INSERT INTO agent_tokens (
           token_id, token_hash, label, scope, created_by, created_at, revoked_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         RETURNING token_id, token_hash, label, scope, created_by, created_at, revoked_at`
    )
      .bind(
        record.token_id,
        record.token_hash,
        record.label,
        record.scope,
        record.created_by,
        record.created_at,
        record.revoked_at
      )
      .first<RawDbAgentTokenRow>();

    if (!row) {
      throw new Error(`Failed to create agent token '${record.token_id}'.`);
    }
    return mapAgentTokenRow(row);
  }

  async revokeAgentToken(tokenId: string, atIso: string): Promise<boolean> {
    const res = await prepareD1Statement(
      this.db,
      'UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL'
    )
      .bind(atIso, tokenId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }
}
