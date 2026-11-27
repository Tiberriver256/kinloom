import type React from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';
import { cx } from '../../lib/cx.js';
import cssMod1 from '../../pages/IndexPage.module.css';
import cssMod0 from './WikiChrome.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1 };

export type WikiEntityTab = 'read' | 'edit' | 'history' | 'talk';

export interface WikiActionBarProps {
  activeTab: WikiEntityTab;
  onSelectTab: (tab: WikiEntityTab) => void;
  revisionCount?: number | null;
  talkCount?: number | null;
  onUploadMedia?: () => void;
  onCreateRecord?: () => void;
  entityLabel?: string;
}

/**
 * Calm, plain-language contributor bar for person and place pages.
 * Keeps primary actions (Edit Page, Add Photo) obvious and tucks secondary
 * views (Family Notes, History) quietly aside. Returns null on read-only static demos.
 */
export const WikiActionBar: React.FC<WikiActionBarProps> = ({
  activeTab,
  onSelectTab,
  revisionCount,
  talkCount,
  onUploadMedia,
  entityLabel = 'page',
}) => {
  const { capabilities } = useArchiveData();

  const showAnyWikiSurface =
    capabilities.canEdit ||
    capabilities.hasRevisionHistory ||
    capabilities.hasTalk ||
    capabilities.canUploadMedia;

  if (!showAnyWikiSurface) {
    return null;
  }

  const viewingSubPanel = activeTab === 'history' || activeTab === 'talk';

  return (
    <div
      className={cx(uiStyles, 'wiki-action-bar print-hide')}
      role="region"
      aria-label={`Contribute to ${entityLabel}`}
    >
      <div className={cx(uiStyles, 'wiki-action-primary')}>
        {viewingSubPanel ? (
          <button
            type="button"
            className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-sm')}
            onClick={() => {
              onSelectTab('read');
            }}
          >
            ← Back to Profile
          </button>
        ) : (
          <>
            {capabilities.canEdit && (
              <button
                type="button"
                className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-sm')}
                onClick={() => {
                  onSelectTab('edit');
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <path d="M11.5 2.5l2 2L5 13H3v-2l8.5-8.5z" />
                </svg>
                Edit Page
              </button>
            )}

            {capabilities.canUploadMedia && onUploadMedia && (
              <button
                type="button"
                className={cx(uiStyles, 'wiki-btn-secondary wiki-btn-sm')}
                onClick={onUploadMedia}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  aria-hidden="true"
                >
                  <rect x="2" y="3.5" width="12" height="9.5" rx="1.5" />
                  <circle cx="8" cy="8.25" r="2.25" />
                  <path d="M5.5 3.5l1-1.5h3l1 1.5" />
                </svg>
                Add Photo
              </button>
            )}
          </>
        )}
      </div>

      <div className={cx(uiStyles, 'wiki-action-secondary')}>
        {capabilities.hasTalk && (
          <button
            type="button"
            aria-pressed={activeTab === 'talk'}
            className={cx(uiStyles, `pill-btn ${activeTab === 'talk' ? 'active' : ''}`)}
            onClick={() => {
              onSelectTab(activeTab === 'talk' ? 'read' : 'talk');
            }}
          >
            Family Notes{typeof talkCount === 'number' ? ` (${talkCount})` : ''}
          </button>
        )}

        {capabilities.hasRevisionHistory && (
          <button
            type="button"
            aria-pressed={activeTab === 'history'}
            className={cx(uiStyles, `pill-btn ${activeTab === 'history' ? 'active' : ''}`)}
            onClick={() => {
              onSelectTab(activeTab === 'history' ? 'read' : 'history');
            }}
          >
            History{typeof revisionCount === 'number' ? ` (${revisionCount})` : ''}
          </button>
        )}
      </div>
    </div>
  );
};
