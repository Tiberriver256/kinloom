import type { AgentTokenScope, CreatedAgentTokenResponse, PublicAgentTokenRecord } from '@kinloom/core';
import type React from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiFormStyles from '../../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import { type AdminConfirmState, formatTokenScopeLabel } from './adminHelpers.js';

export interface AgentTokensSectionProps {
  readonly tokens: readonly PublicAgentTokenRecord[];
  readonly tokenLabel: string;
  readonly tokenScope: AgentTokenScope;
  readonly revealedSecret: CreatedAgentTokenResponse | null;
  readonly copiedSecret: boolean;
  readonly busyKey: string | null;
  readonly pendingConfirm: AdminConfirmState | null;
  readonly onTokenLabelChange: (value: string) => void;
  readonly onTokenScopeChange: (value: AgentTokenScope) => void;
  readonly onCreateToken: (event: React.FormEvent) => Promise<void>;
  readonly onCopySecret: () => void;
  readonly onDismissSecret: () => void;
  readonly onSetPendingConfirm: (next: AdminConfirmState | null) => void;
  readonly onRevokeToken: (tokenId: string) => Promise<void>;
}

export const AgentTokensSection: React.FC<AgentTokensSectionProps> = ({
  tokens,
  tokenLabel,
  tokenScope,
  revealedSecret,
  copiedSecret,
  busyKey,
  pendingConfirm,
  onTokenLabelChange,
  onTokenScopeChange,
  onCreateToken,
  onCopySecret,
  onDismissSecret,
  onSetPendingConfirm,
  onRevokeToken,
}) => (
  <section className={cx(layoutStyles, 'place-map-box')}>
    <h2 className={cx(wikiPanelStyles, 'wiki-section-title')}>Scoped AI Agent &amp; Backup Tokens</h2>
    <form
      className={cx(wikiFormStyles, 'wiki-inline-form')}
      onSubmit={(e) => {
        void onCreateToken(e);
      }}
    >
      <label className={cx(wikiFormStyles, 'wiki-field wiki-inline-field-grow')}>
        <span className={cx(wikiFormStyles, 'wiki-field-label')}>Token label</span>
        <input
          type="text"
          className={cx(wikiFormStyles, 'wiki-input')}
          placeholder="e.g. Research CLI or Nightly Backup"
          value={tokenLabel}
          onChange={(e) => {
            onTokenLabelChange(e.target.value);
          }}
        />
      </label>
      <label className={cx(wikiFormStyles, 'wiki-field wiki-inline-field-scope')}>
        <span className={cx(wikiFormStyles, 'wiki-field-label')}>Permission scope</span>
        <select
          className={cx(wikiFormStyles, 'wiki-input')}
          aria-label="Agent token scope"
          value={tokenScope}
          onChange={(e) => {
            onTokenScopeChange(e.target.value as AgentTokenScope);
          }}
        >
          <option value="write_batch">Research assistant updates</option>
          <option value="read_backup">Read-only archive backup</option>
        </select>
      </label>
      <button
        type="submit"
        className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
        disabled={!tokenLabel.trim() || busyKey !== null}
      >
        {busyKey === 'create_token' ? 'Creating…' : 'Create Token'}
      </button>
    </form>

    {revealedSecret && (
      <div className={cx(wikiPanelStyles, 'wiki-status-banner is-warning')} role="alert">
        <div>
          <strong>Copy this secret now — it will never be shown again:</strong>
          <div style={{ marginTop: 6 }}>
            <code className={cx(wikiPanelStyles, 'wiki-secret-box')}>{revealedSecret.plaintext_secret}</code>
          </div>
        </div>
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')} style={{ marginTop: 8 }}>
          <button type="button" className={cx(controlStyles, 'pill-btn active')} onClick={onCopySecret}>
            {copiedSecret ? 'Copied' : 'Copy Secret'}
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onDismissSecret}>
            Dismiss
          </button>
        </div>
      </div>
    )}

    <div className={cx(wikiPanelStyles, 'wiki-admin-list')} style={{ marginTop: 12 }}>
      {tokens.map((tok) => {
        const confirmingRevoke =
          pendingConfirm?.kind === 'revoke_token' && pendingConfirm.tokenId === tok.token_id;
        const isRowBusy = busyKey === `revoke_token:${tok.token_id}`;
        return (
          <div key={tok.token_id} className={cx(wikiPanelStyles, 'wiki-admin-row')}>
            <div>
              <strong>{tok.label}</strong>{' '}
              <span className={cx(wikiPanelStyles, 'wiki-batch-chip')}>
                {formatTokenScopeLabel(tok.scope)}
              </span>{' '}
              {tok.revoked_at ? (
                <span className={cx(wikiChromeStyles, 'wiki-badge wiki-badge-conflict')}>Revoked</span>
              ) : (
                <span className={cx(wikiChromeStyles, 'wiki-badge wiki-badge-cited')}>Active</span>
              )}
              <div className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                ID: {tok.token_id} · Created{' '}
                <time dateTime={tok.created_at} title={tok.created_at}>
                  {formatArchivalTimestamp(tok.created_at, false)}
                </time>
              </div>
            </div>
            {!tok.revoked_at && (
              <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
                {confirmingRevoke ? (
                  <>
                    <button
                      type="button"
                      className={joinClasses(
                        cx(controlStyles, 'pill-btn'),
                        cx(wikiFormStyles, 'wiki-danger-btn')
                      )}
                      disabled={busyKey !== null}
                      onClick={() => {
                        void onRevokeToken(tok.token_id);
                      }}
                    >
                      Confirm Revoke
                    </button>
                    <button
                      type="button"
                      className={cx(controlStyles, 'pill-btn')}
                      disabled={busyKey !== null}
                      onClick={() => {
                        onSetPendingConfirm(null);
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={joinClasses(
                      cx(controlStyles, 'pill-btn'),
                      cx(wikiFormStyles, 'wiki-danger-btn')
                    )}
                    disabled={busyKey !== null}
                    onClick={() => {
                      onSetPendingConfirm({ kind: 'revoke_token', tokenId: tok.token_id });
                    }}
                  >
                    {isRowBusy ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </section>
);
