import type { UserRecord } from '@kinloom/core';
import type React from 'react';
import wikiChromeStyles from '../../components/wiki/WikiChrome.module.css';
import wikiFormStyles from '../../components/wiki/WikiForms.module.css';
import wikiPanelStyles from '../../components/wiki/WikiPanels.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import controlStyles from '../../styles/Controls.module.css';
import type { AdminConfirmState } from './adminHelpers.js';

export interface MembersSectionProps {
  readonly users: readonly UserRecord[];
  readonly adminCount: number;
  readonly currentAdminEmail: string | null;
  readonly busyKey: string | null;
  readonly pendingConfirm: AdminConfirmState | null;
  readonly onSetPendingConfirm: (next: AdminConfirmState | null) => void;
  readonly onToggleRole: (user: UserRecord) => Promise<void>;
}

export const MembersSection: React.FC<MembersSectionProps> = ({
  users,
  adminCount,
  currentAdminEmail,
  busyKey,
  pendingConfirm,
  onSetPendingConfirm,
  onToggleRole,
}) => (
  <section className={cx(controlStyles, 'place-map-box')}>
    <h2 className={cx(wikiPanelStyles, 'wiki-section-title')}>Enrolled Family Members</h2>
    {users.length === 0 ? (
      <p className={cx(controlStyles, 'empty-ring-note')}>No enrolled members found.</p>
    ) : (
      <div className={cx(wikiPanelStyles, 'wiki-admin-list')}>
        {users.map((user) => {
          const isSelf = currentAdminEmail !== null && user.email.toLowerCase() === currentAdminEmail;
          const demoteBlocked = user.role === 'admin' && (isSelf || adminCount <= 1);
          const demoteBlockedReason = isSelf
            ? 'You cannot demote your own admin account.'
            : 'At least one administrator is required.';
          const confirmingDemote = pendingConfirm?.kind === 'demote' && pendingConfirm.email === user.email;
          const isRowBusy = busyKey === `role:${user.email}`;

          return (
            <div key={user.email} className={cx(wikiPanelStyles, 'wiki-admin-row')}>
              <div>
                <strong>{user.display_name}</strong>{' '}
                <span className={cx(wikiChromeStyles, 'wiki-role-chip')}>
                  {user.role === 'admin' ? 'Admin' : 'Editor'}
                </span>
                {isSelf && <span className={cx(wikiChromeStyles, 'wiki-role-chip is-self')}>You</span>}
                <div className={cx(wikiPanelStyles, 'wiki-panel-meta')}>
                  {user.email} · Added{' '}
                  <time dateTime={user.added_at} title={user.added_at}>
                    {formatArchivalTimestamp(user.added_at, false)}
                  </time>
                </div>
                {demoteBlocked && (
                  <div className={cx(wikiPanelStyles, 'wiki-panel-meta')}>{demoteBlockedReason}</div>
                )}
              </div>
              <div className={cx(wikiPanelStyles, 'wiki-inline-actions')}>
                {confirmingDemote ? (
                  <>
                    <button
                      type="button"
                      className={joinClasses(
                        cx(controlStyles, 'pill-btn'),
                        cx(wikiFormStyles, 'wiki-danger-btn')
                      )}
                      disabled={busyKey !== null}
                      onClick={() => {
                        void onToggleRole(user);
                      }}
                    >
                      Confirm Demote
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
                    className={cx(wikiChromeStyles, 'wiki-btn-secondary wiki-btn-sm')}
                    disabled={busyKey !== null || demoteBlocked}
                    title={demoteBlocked ? demoteBlockedReason : undefined}
                    onClick={() => {
                      if (user.role === 'admin') {
                        onSetPendingConfirm({ kind: 'demote', email: user.email });
                      } else {
                        void onToggleRole(user);
                      }
                    }}
                  >
                    {isRowBusy
                      ? 'Updating…'
                      : user.role === 'admin'
                        ? 'Demote to Editor'
                        : 'Promote to Admin'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    )}
  </section>
);
