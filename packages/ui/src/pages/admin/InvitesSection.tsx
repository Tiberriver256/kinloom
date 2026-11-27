import type { InviteRecord } from '@kinloom/core';
import type React from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiFormStyles from '../../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import controlStyles from '../../styles/Controls.module.css';
import { type AdminConfirmState, buildInviteUrl } from './adminHelpers.js';

export interface InvitesSectionProps {
  readonly invites: readonly InviteRecord[];
  readonly inviteLabel: string;
  readonly inviteDays: string;
  readonly createdInviteUrl: string | null;
  readonly busyKey: string | null;
  readonly copiedKey: string | null;
  readonly pendingConfirm: AdminConfirmState | null;
  readonly onInviteLabelChange: (value: string) => void;
  readonly onInviteDaysChange: (value: string) => void;
  readonly onCreateInvite: (event: React.FormEvent) => Promise<void>;
  readonly onDismissCreatedInvite: () => void;
  readonly onCopyText: (key: string, text: string) => void;
  readonly onSetPendingConfirm: (next: AdminConfirmState | null) => void;
  readonly onRevokeInvite: (token: string) => Promise<void>;
}

export const InvitesSection: React.FC<InvitesSectionProps> = ({
  invites,
  inviteLabel,
  inviteDays,
  createdInviteUrl,
  busyKey,
  copiedKey,
  pendingConfirm,
  onInviteLabelChange,
  onInviteDaysChange,
  onCreateInvite,
  onDismissCreatedInvite,
  onCopyText,
  onSetPendingConfirm,
  onRevokeInvite,
}) => (
  <section className={cx(controlStyles, 'place-map-box')}>
    <h2 className={cx(wikiPanelStyles, 'wiki-section-title')}>Family Invite Links</h2>
    <form
      className={cx(wikiFormStyles, 'wiki-inline-form')}
      onSubmit={(e) => {
        void onCreateInvite(e);
      }}
    >
      <label className={cx(wikiFormStyles, 'wiki-field wiki-inline-field-grow')}>
        <span className={cx(wikiFormStyles, 'wiki-field-label')}>Invite label</span>
        <input
          type="text"
          className={cx(wikiFormStyles, 'wiki-input')}
          placeholder="e.g. Reunion cousins"
          value={inviteLabel}
          onChange={(e) => {
            onInviteLabelChange(e.target.value);
          }}
        />
      </label>
      <label className={cx(wikiFormStyles, 'wiki-field wiki-inline-field-days')}>
        <span className={cx(wikiFormStyles, 'wiki-field-label')}>Expires (days)</span>
        <input
          type="number"
          min="1"
          max="365"
          className={cx(wikiFormStyles, 'wiki-input')}
          aria-label="Expires in days"
          value={inviteDays}
          onChange={(e) => {
            onInviteDaysChange(e.target.value);
          }}
        />
      </label>
      <button
        type="submit"
        className={cx(wikiChromeStyles, 'wiki-btn-primary wiki-btn-sm')}
        disabled={!inviteLabel.trim() || busyKey !== null}
      >
        {busyKey === 'create_invite' ? 'Creating…' : 'Generate Invite Link'}
      </button>
    </form>

    {createdInviteUrl && (
      <output className={cx(wikiPanelStyles, 'wiki-status-banner is-success')} aria-live="polite">
        <p>
          <strong>New invite link:</strong> <code>{createdInviteUrl}</code>
        </p>
        <div className={cx(wikiPanelStyles, 'wiki-inline-actions')} style={{ marginTop: 4 }}>
          <button
            type="button"
            className={cx(controlStyles, 'pill-btn active')}
            onClick={() => {
              onCopyText('created_invite', createdInviteUrl);
            }}
          >
            {copiedKey === 'created_invite' ? 'Copied' : 'Copy Invite Link'}
          </button>
          <button type="button" className={cx(controlStyles, 'pill-btn')} onClick={onDismissCreatedInvite}>
            Dismiss
          </button>
        </div>
      </output>
    )}

    <div className={cx(wikiPanelStyles, 'wiki-admin-list')} style={{ marginTop: 12 }}>
      {invites.map((inv) => {
        const confirmingRevoke =
          pendingConfirm?.kind === 'revoke_invite' && pendingConfirm.token === inv.token;
        const isRowBusy = busyKey === `revoke_invite:${inv.token}`;
        const copyId = `invite:${inv.token}`;
        return (
          <div key={inv.token} className={cx(wikiPanelStyles, 'wiki-admin-row')}>
            <div>
              <strong>{inv.label}</strong>{' '}
              {inv.revoked_at ? (
                <span className={cx(wikiChromeStyles, 'wiki-badge wiki-badge-conflict')}>Revoked</span>
              ) : (
                <span className={cx(wikiChromeStyles, 'wiki-badge wiki-badge-cited')}>Active</span>
              )}
              <div className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                Uses: {inv.uses}
                {inv.expires_at ? (
                  <>
                    {' '}
                    · Expires{' '}
                    <time dateTime={inv.expires_at} title={inv.expires_at}>
                      {formatArchivalTimestamp(inv.expires_at, false)}
                    </time>
                  </>
                ) : (
                  ' · No expiry'
                )}
              </div>
            </div>
            {!inv.revoked_at && (
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
                        void onRevokeInvite(inv.token);
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
                  <>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                      onClick={() => {
                        onCopyText(copyId, buildInviteUrl(inv.token));
                      }}
                    >
                      {copiedKey === copyId ? 'Copied' : 'Copy Link'}
                    </button>
                    <button
                      type="button"
                      className={joinClasses(
                        cx(controlStyles, 'pill-btn'),
                        cx(wikiFormStyles, 'wiki-danger-btn')
                      )}
                      disabled={busyKey !== null}
                      onClick={() => {
                        onSetPendingConfirm({ kind: 'revoke_invite', token: inv.token });
                      }}
                    >
                      {isRowBusy ? 'Revoking…' : 'Revoke'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </section>
);
