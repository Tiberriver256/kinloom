import {
  type AccessControlStore,
  type AgentTokenScope,
  AgentTokenScopeSchema,
  type Clock,
  type InviteRecord,
  type PublicAgentTokenRecord,
  type UserRecord,
  type UserRole,
  UserRoleSchema,
} from '@kinloom/core';
import { z } from 'zod';
import { randomBase64Url, sha256Hex } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';

const CreateUserSchema = z.object({
  email: z.string().trim().email(),
  display_name: z.string().trim().min(1).max(200),
  role: UserRoleSchema,
});

const UpdateUserSchema = z.object({
  role: UserRoleSchema,
  display_name: z.string().trim().min(1).max(200).optional(),
});

const CreateInviteSchema = z.object({
  label: z.string().trim().min(1).max(200),
  expires_in_days: z.number().int().min(1).max(3650).optional(),
});

const CreateAgentTokenSchema = z.object({
  label: z.string().trim().min(1).max(200),
  scope: AgentTokenScopeSchema,
});

export type { PublicAgentTokenRecord } from '@kinloom/core';

export interface AdminServiceDeps {
  repository: AccessControlStore;
  clock: Clock;
}

export class AdminService {
  private readonly repository: AccessControlStore;
  private readonly clock: Clock;

  constructor(deps: AdminServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock;
  }

  async listUsers(): Promise<readonly UserRecord[]> {
    return this.repository.listUsers();
  }

  async createUser(params: {
    email: string;
    display_name: string;
    role: UserRole;
    addedBy: string;
  }): Promise<UserRecord> {
    const parsed = CreateUserSchema.parse({
      email: params.email,
      display_name: params.display_name,
      role: params.role,
    });
    const normalizedEmail = parsed.email.toLowerCase();
    const existing = await this.repository.getUser(normalizedEmail);
    if (existing) {
      throw new KinloomHttpError(409, 'USER_EXISTS', `User '${normalizedEmail}' already exists.`);
    }

    return this.repository.upsertUser({
      email: normalizedEmail,
      display_name: parsed.display_name,
      role: parsed.role,
      added_by: params.addedBy,
      added_at: this.clock.nowIso(),
      last_login_at: null,
    });
  }

  async updateUser(params: { email: string; role: UserRole; display_name?: string | undefined }): Promise<UserRecord> {
    const parsed = UpdateUserSchema.parse({
      role: params.role,
      display_name: params.display_name,
    });
    const normalizedEmail = params.email.trim().toLowerCase();
    const existing = await this.repository.getUser(normalizedEmail);
    if (!existing) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `User '${normalizedEmail}' was not found.`);
    }

    if (existing.role === 'admin' && parsed.role !== 'admin') {
      await this.assertNotLastAdmin(normalizedEmail);
    }

    if (parsed.display_name !== undefined) {
      return this.repository.upsertUser({
        ...existing,
        role: parsed.role,
        display_name: parsed.display_name,
      });
    }

    const updated = await this.repository.updateUserRole(normalizedEmail, parsed.role);
    if (!updated) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `User '${normalizedEmail}' was not found.`);
    }
    return updated;
  }

  async deleteUser(params: { email: string }): Promise<void> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const existing = await this.repository.getUser(normalizedEmail);
    if (!existing) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `User '${normalizedEmail}' was not found.`);
    }

    if (existing.role === 'admin') {
      await this.assertNotLastAdmin(normalizedEmail);
    }

    const deleted = await this.repository.deleteUser(normalizedEmail);
    if (!deleted) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `User '${normalizedEmail}' was not found.`);
    }
  }

  async listInvites(): Promise<readonly InviteRecord[]> {
    return this.repository.listInvites();
  }

  async createInvite(params: {
    label: string;
    expires_in_days?: number | undefined;
    createdBy: string;
    origin: string;
  }): Promise<{ invite: InviteRecord; invite_url: string }> {
    const parsed = CreateInviteSchema.parse({
      label: params.label,
      expires_in_days: params.expires_in_days,
    });
    const nowMs = this.clock.now().getTime();
    const token = `inv_${randomBase64Url(18)}`;
    const expiresAt =
      parsed.expires_in_days !== undefined
        ? new Date(nowMs + parsed.expires_in_days * 86_400_000).toISOString()
        : null;

    const invite = await this.repository.createInvite({
      token,
      label: parsed.label,
      created_by: params.createdBy,
      created_at: this.clock.nowIso(),
      expires_at: expiresAt,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });

    return {
      invite,
      invite_url: `${params.origin.replace(/\/$/, '')}/api/auth/invite/${encodeURIComponent(token)}`,
    };
  }

  async revokeInvite(params: { token: string }): Promise<void> {
    const revoked = await this.repository.revokeInvite(params.token, this.clock.nowIso());
    if (!revoked) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `Invite '${params.token}' was not found.`);
    }
  }

  async listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]> {
    const tokens = await this.repository.listAgentTokens();
    return tokens.map(({ token_hash: _hash, ...publicFields }) => publicFields);
  }

  async createAgentToken(params: { label: string; scope: AgentTokenScope; createdBy: string }): Promise<{
    token_id: string;
    label: string;
    scope: AgentTokenScope;
    plaintext_secret: string;
  }> {
    const parsed = CreateAgentTokenSchema.parse({
      label: params.label,
      scope: params.scope,
    });

    const tokenId = `tok_${randomBase64Url(12)}`;
    const plaintextSecret = `klm_${randomBase64Url(32)}`;
    const tokenHash = await sha256Hex(plaintextSecret);

    await this.repository.createAgentToken({
      token_id: tokenId,
      token_hash: tokenHash,
      label: parsed.label,
      scope: parsed.scope,
      created_by: params.createdBy,
      created_at: this.clock.nowIso(),
      revoked_at: null,
    });

    return {
      token_id: tokenId,
      label: parsed.label,
      scope: parsed.scope,
      plaintext_secret: plaintextSecret,
    };
  }

  async revokeAgentToken(params: { tokenId: string }): Promise<void> {
    const revoked = await this.repository.revokeAgentToken(params.tokenId, this.clock.nowIso());
    if (!revoked) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `Agent token '${params.tokenId}' was not found.`);
    }
  }

  private async assertNotLastAdmin(targetEmail: string): Promise<void> {
    const users = await this.repository.listUsers();
    const otherAdmins = users.filter((u) => u.role === 'admin' && u.email !== targetEmail);
    if (otherAdmins.length === 0) {
      throw new KinloomHttpError(
        409,
        'LAST_ADMIN_PROTECTED',
        'Cannot remove or demote the last remaining administrator.'
      );
    }
  }
}
