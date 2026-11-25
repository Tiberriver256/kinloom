import type { AgentTokenScope, InviteRecord, UserRecord, UserRole } from '@kinloom/core';
import type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  PublicAgentTokenRecord,
} from '../adapters/httpWikiDataSource.js';
import React, { useCallback, useEffect, useState } from 'react';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { HttpWikiDataSource } from '../adapters/httpWikiDataSource.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';

export interface AdminApiClient {
  listUsers(): Promise<readonly UserRecord[]>;
  updateUserRole(email: string, input: { role: UserRole }): Promise<UserRecord>;
  listInvites(): Promise<readonly InviteRecord[]>;
  createInvite(input: { label: string; expires_in_days?: number }): Promise<CreatedInviteResponse>;
  revokeInvite(token: string): Promise<void>;
  listAgentTokens(): Promise<readonly PublicAgentTokenRecord[]>;
  createAgentToken(input: {
    label: string;
    scope: AgentTokenScope;
  }): Promise<CreatedAgentTokenResponse>;
  revokeAgentToken(tokenId: string): Promise<void>;
}

export interface AdminPageProps {
  adminClient?: AdminApiClient;
}

export const AdminPage: React.FC<AdminPageProps> = ({ adminClient }) => {
  const { dataSource, capabilities } = useArchiveData();
  const client: AdminApiClient | null =
    adminClient ?? (dataSource instanceof HttpWikiDataSource ? dataSource : null);

  const [users, setUsers] = useState<readonly UserRecord[]>([]);
  const [invites, setInvites] = useState<readonly InviteRecord[]>([]);
  const [tokens, setTokens] = useState<readonly PublicAgentTokenRecord[]>([]);
  const [loading, setLoading] = useState<boolean>(Boolean(client && capabilities.canManageSite));
  const [error, setError] = useState<string | null>(null);

  // Invite form state
  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteDays, setInviteDays] = useState('30');
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);

  // Agent token form state
  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenScope, setTokenScope] = useState<AgentTokenScope>('write_batch');
  const [revealedSecret, setRevealedSecret] = useState<CreatedAgentTokenResponse | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const loadAll = useCallback(async (): Promise<void> => {
    if (!client || !capabilities.canManageSite) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [u, inv, tok] = await Promise.all([
        client.listUsers(),
        client.listInvites(),
        client.listAgentTokens(),
      ]);
      setUsers(u);
      setInvites(inv);
      setTokens(tok);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client, capabilities.canManageSite]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const handleToggleRole = async (user: UserRecord): Promise<void> => {
    if (!client) {
      return;
    }
    const nextRole: UserRole = user.role === 'admin' ? 'editor' : 'admin';
    setError(null);
    try {
      const updated = await client.updateUserRole(user.email, { role: nextRole });
      setUsers((prev) => prev.map((u) => (u.email === updated.email ? updated : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateInvite = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!client || !inviteLabel.trim()) {
      return;
    }
    setError(null);
    try {
      const parsedDays = Number(inviteDays);
      const res = await client.createInvite({
        label: inviteLabel.trim(),
        expires_in_days: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : undefined,
      });
      setCreatedInviteUrl(res.invite_url);
      setInviteLabel('');
      setInvites((prev) => [res.invite, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeInvite = async (token: string): Promise<void> => {
    if (!client) {
      return;
    }
    setError(null);
    try {
      await client.revokeInvite(token);
      setInvites((prev) =>
        prev.map((inv) =>
          inv.token === token ? { ...inv, revoked_at: new Date().toISOString() } : inv,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateToken = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!client || !tokenLabel.trim()) {
      return;
    }
    setError(null);
    try {
      const created = await client.createAgentToken({
        label: tokenLabel.trim(),
        scope: tokenScope,
      });
      setRevealedSecret(created);
      setCopiedSecret(false);
      setTokenLabel('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRevokeToken = async (tokenId: string): Promise<void> => {
    if (!client) {
      return;
    }
    setError(null);
    try {
      await client.revokeAgentToken(tokenId);
      setTokens((prev) =>
        prev.map((t) =>
          t.token_id === tokenId ? { ...t, revoked_at: new Date().toISOString() } : t,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!capabilities.canManageSite) {
    return (
      <div>
        <ExplorerTopBar />
        <main className="place-page">
          <section className="place-map-box">
            <h1>Site Administration</h1>
            <p className="empty-ring-note">
              Administrator permissions are required to manage members, invite links, and agent
              tokens.
            </p>
          </section>
        </main>
        <KinloomFooter />
      </div>
    );
  }

  return (
    <div>
      <ExplorerTopBar />
      <main className="place-page">
        <section className="wire-banner" style={{ marginBottom: 18 }}>
          <div>
            <h1>Site Administration</h1>
            <p>
              Manage enrolled family editors, generate revocable read-only invite links, and issue
              scoped bearer tokens for CLI research batches or nightly YAML backups.
            </p>
          </div>
          <div className="folio-metrics">
            <div>
              <strong>{users.length}</strong> enrolled members
            </div>
            <div>
              <strong>{invites.filter((i) => !i.revoked_at).length}</strong> active invites
            </div>
            <div>
              <strong>{tokens.filter((t) => !t.revoked_at).length}</strong> active agent tokens
            </div>
          </div>
        </section>

        {error && (
          <div className="wiki-status-banner is-error" role="alert">
            {error}
          </div>
        )}
        {loading && <p className="empty-ring-note">Loading administration records…</p>}

        {/* Members */}
        <section className="place-map-box">
          <h2 className="wiki-section-title">Enrolled Family Members</h2>
          {users.length === 0 ? (
            <p className="empty-ring-note">No enrolled members found.</p>
          ) : (
            <div className="wiki-admin-list">
              {users.map((user) => (
                <div key={user.email} className="wiki-admin-row">
                  <div>
                    <strong>{user.display_name}</strong>{' '}
                    <span className="wiki-role-chip">{user.role}</span>
                    <div className="wiki-panel-meta">
                      {user.email} · Added {user.added_at}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="pill-btn"
                    onClick={() => {
                      void handleToggleRole(user);
                    }}
                  >
                    {user.role === 'admin' ? 'Demote to Editor' : 'Promote to Admin'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Invite links */}
        <section className="place-map-box">
          <h2 className="wiki-section-title">Family Invite Links</h2>
          <form
            className="wiki-inline-form"
            onSubmit={(e) => {
              void handleCreateInvite(e);
            }}
          >
            <input
              type="text"
              className="wiki-input"
              placeholder="Invite label (e.g. Reunion cousins)"
              value={inviteLabel}
              onChange={(e) => {
                setInviteLabel(e.target.value);
              }}
            />
            <input
              type="number"
              min="1"
              max="365"
              className="wiki-input wiki-input-narrow"
              aria-label="Expires in days"
              value={inviteDays}
              onChange={(e) => {
                setInviteDays(e.target.value);
              }}
            />
            <button type="submit" className="pill-btn active" disabled={!inviteLabel.trim()}>
              Generate Invite Link
            </button>
          </form>

          {createdInviteUrl && (
            <output className="wiki-status-banner is-success" aria-live="polite">
              <div>
                <strong>New invite link:</strong> <code>{createdInviteUrl}</code>
              </div>
            </output>
          )}

          <div className="wiki-admin-list" style={{ marginTop: 12 }}>
            {invites.map((inv) => (
              <div key={inv.token} className="wiki-admin-row">
                <div>
                  <strong>{inv.label}</strong>{' '}
                  {inv.revoked_at ? (
                    <span className="wiki-badge wiki-badge-conflict">Revoked</span>
                  ) : (
                    <span className="wiki-badge wiki-badge-cited">Active</span>
                  )}
                  <div className="wiki-panel-meta">
                    Uses: {inv.uses}
                    {inv.expires_at ? ` · Expires ${inv.expires_at}` : ' · No expiry'}
                  </div>
                </div>
                {!inv.revoked_at && (
                  <button
                    type="button"
                    className="pill-btn wiki-danger-btn"
                    onClick={() => {
                      void handleRevokeInvite(inv.token);
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Agent tokens */}
        <section className="place-map-box">
          <h2 className="wiki-section-title">Scoped AI Agent &amp; Backup Tokens</h2>
          <form
            className="wiki-inline-form"
            onSubmit={(e) => {
              void handleCreateToken(e);
            }}
          >
            <input
              type="text"
              className="wiki-input"
              placeholder="Token label (e.g. Research CLI or Nightly Backup)"
              value={tokenLabel}
              onChange={(e) => {
                setTokenLabel(e.target.value);
              }}
            />
            <select
              className="wiki-input wiki-input-medium"
              aria-label="Agent token scope"
              value={tokenScope}
              onChange={(e) => {
                setTokenScope(e.target.value as AgentTokenScope);
              }}
            >
              <option value="write_batch">write_batch (AI research batches)</option>
              <option value="read_backup">read_backup (Read-only YAML export)</option>
            </select>
            <button type="submit" className="pill-btn active" disabled={!tokenLabel.trim()}>
              Create Token
            </button>
          </form>

          {revealedSecret && (
            <div className="wiki-status-banner is-warning" role="alert">
              <div>
                <strong>Copy this secret now — it will never be shown again:</strong>
                <div style={{ marginTop: 6 }}>
                  <code className="wiki-secret-box">{revealedSecret.plaintext_secret}</code>
                </div>
              </div>
              <div className="wiki-inline-actions" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="pill-btn active"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(revealedSecret.plaintext_secret)
                      .then(() => {
                        setCopiedSecret(true);
                      })
                      .catch(() => {
                        setCopiedSecret(false);
                      });
                  }}
                >
                  {copiedSecret ? 'Copied' : 'Copy Secret'}
                </button>
                <button
                  type="button"
                  className="pill-btn"
                  onClick={() => {
                    setRevealedSecret(null);
                  }}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <div className="wiki-admin-list" style={{ marginTop: 12 }}>
            {tokens.map((tok) => (
              <div key={tok.token_id} className="wiki-admin-row">
                <div>
                  <strong>{tok.label}</strong> <code className="wiki-batch-chip">{tok.scope}</code>{' '}
                  {tok.revoked_at ? (
                    <span className="wiki-badge wiki-badge-conflict">Revoked</span>
                  ) : (
                    <span className="wiki-badge wiki-badge-cited">Active</span>
                  )}
                  <div className="wiki-panel-meta">
                    ID: {tok.token_id} · Created {tok.created_at}
                  </div>
                </div>
                {!tok.revoked_at && (
                  <button
                    type="button"
                    className="pill-btn wiki-danger-btn"
                    onClick={() => {
                      void handleRevokeToken(tok.token_id);
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
      <KinloomFooter />
    </div>
  );
};
