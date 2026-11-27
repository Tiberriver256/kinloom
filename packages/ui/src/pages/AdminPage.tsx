import type {
  AdminDataSource,
  AdminDiagnosticsReport,
  AgentTokenScope,
  CreatedAgentTokenResponse,
  InviteRecord,
  PluginSettingsSnapshot,
  PluginSettingsUpdateRequest,
  PublicAgentTokenRecord,
  UserRecord,
  UserRole,
} from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import atomStyles from '../components/Atoms.module.css';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import wikiPanelStyles from '../components/wiki/WikiPanels.module.css';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import { AdminSettingsShell } from './admin/AdminSettingsShell.js';
import { AgentTokensSection } from './admin/AgentTokensSection.js';
import type { AdminConfirmState } from './admin/adminHelpers.js';
import { InvitesSection } from './admin/InvitesSection.js';
import { MembersSection } from './admin/MembersSection.js';

export type AdminApiClient = AdminDataSource;

export interface AdminPageProps {
  adminClient?: AdminDataSource;
  extraSettingsPanels?: React.ReactNode;
}

export const AdminPage: React.FC<AdminPageProps> = ({ adminClient, extraSettingsPanels }) => {
  const { session, dataSource, adminDataSource, capabilities } = useArchiveData();
  const client: AdminDataSource | null = adminClient ?? adminDataSource ?? dataSource.admin ?? null;

  const [users, setUsers] = useState<readonly UserRecord[]>([]);
  const [invites, setInvites] = useState<readonly InviteRecord[]>([]);
  const [tokens, setTokens] = useState<readonly PublicAgentTokenRecord[]>([]);
  const [diagnostics, setDiagnostics] = useState<AdminDiagnosticsReport | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState<boolean>(false);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [pluginSettings, setPluginSettings] = useState<readonly PluginSettingsSnapshot[]>([]);
  const [pluginSettingsLoading, setPluginSettingsLoading] = useState<boolean>(false);
  const [pluginSettingsError, setPluginSettingsError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(client && capabilities.canManageSite));
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<AdminConfirmState | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const [inviteLabel, setInviteLabel] = useState('');
  const [inviteDays, setInviteDays] = useState('30');
  const [createdInviteUrl, setCreatedInviteUrl] = useState<string | null>(null);

  const [tokenLabel, setTokenLabel] = useState('');
  const [tokenScope, setTokenScope] = useState<AgentTokenScope>('write_batch');
  const [revealedSecret, setRevealedSecret] = useState<CreatedAgentTokenResponse | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const diagnosticsSupported = Boolean(client?.getSystemDiagnostics);
  const pluginSettingsSupported = Boolean(client?.getPluginSettings && client?.updatePluginSettings);

  const loadDiagnostics = useCallback(async (): Promise<void> => {
    if (!client?.getSystemDiagnostics || !capabilities.canManageSite) {
      setDiagnostics(null);
      setDiagnosticsLoading(false);
      setDiagnosticsError(null);
      return;
    }
    setDiagnosticsLoading(true);
    setDiagnosticsError(null);
    try {
      const report = await client.getSystemDiagnostics();
      setDiagnostics(report);
    } catch (err) {
      setDiagnosticsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDiagnosticsLoading(false);
    }
  }, [client, capabilities.canManageSite]);

  const loadPluginSettings = useCallback(async (): Promise<void> => {
    if (!client?.getPluginSettings || !capabilities.canManageSite) {
      setPluginSettings([]);
      setPluginSettingsLoading(false);
      setPluginSettingsError(null);
      return;
    }
    setPluginSettingsLoading(true);
    setPluginSettingsError(null);
    try {
      const list = await client.getPluginSettings();
      setPluginSettings(list);
    } catch (err) {
      setPluginSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setPluginSettingsLoading(false);
    }
  }, [client, capabilities.canManageSite]);

  const handleUpdatePluginSettings = useCallback(
    async (pluginId: string, input: PluginSettingsUpdateRequest): Promise<PluginSettingsSnapshot> => {
      if (!client?.updatePluginSettings) {
        throw new Error('Plugin settings updates are not supported by the active admin data source.');
      }
      const updated = await client.updatePluginSettings(pluginId, input);
      setPluginSettings((prev) =>
        prev.map((item) => (item.plugin_id === updated.plugin_id ? updated : item))
      );
      return updated;
    },
    [client]
  );

  const scheduleCopyReset = (key: string): void => {
    if (!mountedRef.current || typeof window === 'undefined') {
      return;
    }
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      if (mountedRef.current) {
        setCopiedKey((current) => (current === key ? null : current));
      }
    }, 2000);
  };

  const copyText = (key: string, text: string): void => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) {
      setCopiedKey(key);
      scheduleCopyReset(key);
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => {
        if (!mountedRef.current) {
          return;
        }
        setCopiedKey(key);
        scheduleCopyReset(key);
      })
      .catch(() => {
        if (mountedRef.current) {
          setCopiedKey(null);
        }
      });
  };

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
    void loadDiagnostics();
    void loadPluginSettings();
  }, [loadAll, loadDiagnostics, loadPluginSettings]);

  const handleToggleRole = async (user: UserRecord): Promise<void> => {
    if (!client) {
      return;
    }
    const nextRole: UserRole = user.role === 'admin' ? 'editor' : 'admin';
    setBusyKey(`role:${user.email}`);
    setPendingConfirm(null);
    setError(null);
    try {
      const updated = await client.updateUserRole(user.email, { role: nextRole });
      setUsers((prev) => prev.map((u) => (u.email === updated.email ? updated : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateInvite = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!client || !inviteLabel.trim()) {
      return;
    }
    setBusyKey('create_invite');
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
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevokeInvite = async (token: string): Promise<void> => {
    if (!client) {
      return;
    }
    setBusyKey(`revoke_invite:${token}`);
    setPendingConfirm(null);
    setError(null);
    try {
      await client.revokeInvite(token);
      setInvites((prev) =>
        prev.map((inv) => (inv.token === token ? { ...inv, revoked_at: new Date().toISOString() } : inv))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateToken = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!client || !tokenLabel.trim()) {
      return;
    }
    setBusyKey('create_token');
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
    } finally {
      setBusyKey(null);
    }
  };

  const handleRevokeToken = async (tokenId: string): Promise<void> => {
    if (!client) {
      return;
    }
    setBusyKey(`revoke_token:${tokenId}`);
    setPendingConfirm(null);
    setError(null);
    try {
      await client.revokeAgentToken(tokenId);
      setTokens((prev) =>
        prev.map((t) => (t.token_id === tokenId ? { ...t, revoked_at: new Date().toISOString() } : t))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const adminCount = users.filter((u) => u.role === 'admin').length;
  const currentAdminEmail = session?.email?.toLowerCase() ?? null;

  if (!capabilities.canManageSite) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(layoutStyles, 'place-page')}>
          <section className={cx(layoutStyles, 'place-map-box')}>
            <h1>Site Administration</h1>
            <p className={cx(controlStyles, 'empty-ring-note')}>
              Administrator permissions are required to manage members, invite links, and agent tokens.
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
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section className={cx(layoutStyles, 'wire-banner')} style={{ marginBottom: 18 }}>
          <div>
            <h1>Site Administration</h1>
            <p>
              Manage enrolled family editors, create read-only invite links, and manage access keys for
              research helpers or archive backups.
            </p>
          </div>
          <div className={cx(atomStyles, 'folio-metrics')}>
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
          <div className={cx(wikiPanelStyles, 'wiki-status-banner is-error')} role="alert">
            {error}
          </div>
        )}
        {loading && <p className={cx(controlStyles, 'empty-ring-note')}>Loading administration records…</p>}

        <MembersSection
          users={users}
          adminCount={adminCount}
          currentAdminEmail={currentAdminEmail}
          busyKey={busyKey}
          pendingConfirm={pendingConfirm}
          onSetPendingConfirm={setPendingConfirm}
          onToggleRole={handleToggleRole}
        />

        <InvitesSection
          invites={invites}
          inviteLabel={inviteLabel}
          inviteDays={inviteDays}
          createdInviteUrl={createdInviteUrl}
          busyKey={busyKey}
          copiedKey={copiedKey}
          pendingConfirm={pendingConfirm}
          onInviteLabelChange={setInviteLabel}
          onInviteDaysChange={setInviteDays}
          onCreateInvite={handleCreateInvite}
          onDismissCreatedInvite={() => {
            setCreatedInviteUrl(null);
          }}
          onCopyText={copyText}
          onSetPendingConfirm={setPendingConfirm}
          onRevokeInvite={handleRevokeInvite}
        />

        <AgentTokensSection
          tokens={tokens}
          tokenLabel={tokenLabel}
          tokenScope={tokenScope}
          revealedSecret={revealedSecret}
          copiedSecret={copiedSecret}
          busyKey={busyKey}
          pendingConfirm={pendingConfirm}
          onTokenLabelChange={setTokenLabel}
          onTokenScopeChange={setTokenScope}
          onCreateToken={handleCreateToken}
          onCopySecret={() => {
            if (!revealedSecret) {
              return;
            }
            void navigator.clipboard
              ?.writeText(revealedSecret.plaintext_secret)
              .then(() => {
                setCopiedSecret(true);
              })
              .catch(() => {
                setCopiedSecret(false);
              });
          }}
          onDismissSecret={() => {
            setRevealedSecret(null);
          }}
          onSetPendingConfirm={setPendingConfirm}
          onRevokeToken={handleRevokeToken}
        />

        <AdminSettingsShell
          diagnostics={diagnostics}
          diagnosticsLoading={diagnosticsLoading}
          diagnosticsError={diagnosticsError}
          diagnosticsSupported={diagnosticsSupported}
          onRefreshDiagnostics={loadDiagnostics}
          pluginSettings={pluginSettings}
          pluginSettingsLoading={pluginSettingsLoading}
          pluginSettingsError={pluginSettingsError}
          pluginSettingsSupported={pluginSettingsSupported}
          onRefreshPluginSettings={loadPluginSettings}
          onUpdatePluginSettings={handleUpdatePluginSettings}
          extraPanels={extraSettingsPanels}
        />
      </main>
      <KinloomFooter />
    </div>
  );
};
