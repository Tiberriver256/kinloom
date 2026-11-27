import type {
  AdminDataSource,
  AgentTokenScope,
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  InviteRecord,
  PublicAgentTokenRecord,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import { parseErrorEnvelope } from './httpClient.js';

export interface HttpTransportCallbacks {
  readonly apiUrl: (path: string) => string;
  readonly fetchImpl: typeof fetch;
  readonly requestJson: <T>(path: string, init?: RequestInit) => Promise<T>;
}

export function createHttpAdminDataSource(transport: HttpTransportCallbacks): AdminDataSource {
  const deleteNoContent = async (path: string): Promise<void> => {
    const res = await transport.fetchImpl(transport.apiUrl(path), {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok && res.status !== 204) {
      throw await parseErrorEnvelope(res);
    }
  };

  return {
    async listUsers(): Promise<readonly UserRecord[]> {
      const data = await transport.requestJson<{ users: UserRecord[] }>('/api/admin/users');
      return data.users;
    },
    async createUser(input: { email: string; display_name: string; role: UserRole }): Promise<UserRecord> {
      const data = await transport.requestJson<{ user: UserRecord }>('/api/admin/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      return data.user;
    },
    async updateUserRole(
      email: string,
      input: { role: UserRole; display_name?: string }
    ): Promise<UserRecord> {
      const data = await transport.requestJson<{ user: UserRecord }>(
        `/api/admin/users/${encodeURIComponent(email)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      );
      return data.user;
    },
    async deleteUser(email: string): Promise<void> {
      await deleteNoContent(`/api/admin/users/${encodeURIComponent(email)}`);
    },
    async listInvites(): Promise<readonly InviteRecord[]> {
      const data = await transport.requestJson<{ invites: InviteRecord[] }>('/api/admin/invites');
      return data.invites;
    },
    async createInvite(input: { label: string; expires_in_days?: number }): Promise<CreatedInviteResponse> {
      return transport.requestJson<CreatedInviteResponse>('/api/admin/invites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async revokeInvite(token: string): Promise<void> {
      await deleteNoContent(`/api/admin/invites/${encodeURIComponent(token)}`);
    },
    async listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]> {
      const data = await transport.requestJson<{ tokens: PublicAgentTokenRecord[] }>(
        '/api/admin/agent-tokens'
      );
      return data.tokens;
    },
    async createAgentToken(input: {
      label: string;
      scope: AgentTokenScope;
    }): Promise<CreatedAgentTokenResponse> {
      return transport.requestJson<CreatedAgentTokenResponse>('/api/admin/agent-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async revokeAgentToken(tokenId: string): Promise<void> {
      await deleteNoContent(`/api/admin/agent-tokens/${encodeURIComponent(tokenId)}`);
    },
  };
}
