import type {
  AdminDataSource,
  AdminDiagnosticsReport,
  AgentTokenScope,
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  InviteRecord,
  PluginSettingsSnapshot,
  PluginSettingsUpdateRequest,
  PublicAgentTokenRecord,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import { parseErrorEnvelope } from './httpClient.js';
import {
  parseAdminDiagnosticsReport,
  parseAdminPluginSettingsListResponse,
  parseAdminPluginSettingsUpdateResponse,
  parseAgentTokensListResponse,
  parseCreatedAgentTokenResponse,
  parseCreatedInviteResponse,
  parseInvitesListResponse,
  parseUserResponse,
  parseUsersListResponse,
} from './responseParsers.js';

export interface HttpTransportCallbacks {
  readonly apiUrl: (path: string) => string;
  readonly fetchImpl: typeof fetch;
  readonly requestJson: <T>(path: string, parse: (raw: unknown) => T, init?: RequestInit) => Promise<T>;
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
      return transport.requestJson('/api/admin/users', parseUsersListResponse);
    },
    async createUser(input: { email: string; display_name: string; role: UserRole }): Promise<UserRecord> {
      return transport.requestJson('/api/admin/users', parseUserResponse, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async updateUserRole(
      email: string,
      input: { role: UserRole; display_name?: string }
    ): Promise<UserRecord> {
      return transport.requestJson(`/api/admin/users/${encodeURIComponent(email)}`, parseUserResponse, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async deleteUser(email: string): Promise<void> {
      await deleteNoContent(`/api/admin/users/${encodeURIComponent(email)}`);
    },
    async listInvites(): Promise<readonly InviteRecord[]> {
      return transport.requestJson('/api/admin/invites', parseInvitesListResponse);
    },
    async createInvite(input: { label: string; expires_in_days?: number }): Promise<CreatedInviteResponse> {
      return transport.requestJson('/api/admin/invites', parseCreatedInviteResponse, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async revokeInvite(token: string): Promise<void> {
      await deleteNoContent(`/api/admin/invites/${encodeURIComponent(token)}`);
    },
    async listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]> {
      return transport.requestJson('/api/admin/agent-tokens', parseAgentTokensListResponse);
    },
    async createAgentToken(input: {
      label: string;
      scope: AgentTokenScope;
    }): Promise<CreatedAgentTokenResponse> {
      return transport.requestJson('/api/admin/agent-tokens', parseCreatedAgentTokenResponse, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    },
    async revokeAgentToken(tokenId: string): Promise<void> {
      await deleteNoContent(`/api/admin/agent-tokens/${encodeURIComponent(tokenId)}`);
    },
    async getSystemDiagnostics(): Promise<AdminDiagnosticsReport> {
      return transport.requestJson('/api/admin/system', parseAdminDiagnosticsReport);
    },
    async getPluginSettings(): Promise<readonly PluginSettingsSnapshot[]> {
      return transport.requestJson('/api/admin/plugin-settings', parseAdminPluginSettingsListResponse);
    },
    async updatePluginSettings(
      pluginId: string,
      input: PluginSettingsUpdateRequest
    ): Promise<PluginSettingsSnapshot> {
      return transport.requestJson(
        `/api/admin/plugin-settings/${encodeURIComponent(pluginId)}`,
        parseAdminPluginSettingsUpdateResponse,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }
      );
    },
  };
}
