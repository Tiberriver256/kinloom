import React from 'react';
import { useArchiveData } from '../../context/ArchiveDataContext.js';

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
 * Wikipedia-style Read / Edit / History / Talk action bar.
 * Returns null when all wiki capabilities are disabled so read-only static demos stay clean.
 */
export const WikiActionBar: React.FC<WikiActionBarProps> = ({
  activeTab,
  onSelectTab,
  revisionCount,
  talkCount,
  onUploadMedia,
  onCreateRecord,
  entityLabel = 'record',
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

  return (
    <div className="wiki-action-bar print-hide" role="region" aria-label={`Wiki actions for ${entityLabel}`}>
      <div className="wiki-action-tabs" role="tablist" aria-label="Record view tabs">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'read'}
          className={`wiki-tab-btn ${activeTab === 'read' ? 'active' : ''}`}
          onClick={() => {
            onSelectTab('read');
          }}
        >
          Read
        </button>

        {capabilities.canEdit && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'edit'}
            className={`wiki-tab-btn ${activeTab === 'edit' ? 'active' : ''}`}
            onClick={() => {
              onSelectTab('edit');
            }}
          >
            Edit
          </button>
        )}

        {capabilities.hasRevisionHistory && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'history'}
            className={`wiki-tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => {
              onSelectTab('history');
            }}
          >
            History{typeof revisionCount === 'number' ? ` (${revisionCount})` : ''}
          </button>
        )}

        {capabilities.hasTalk && (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'talk'}
            className={`wiki-tab-btn ${activeTab === 'talk' ? 'active' : ''}`}
            onClick={() => {
              onSelectTab('talk');
            }}
          >
            Talk{typeof talkCount === 'number' ? ` (${talkCount})` : ''}
          </button>
        )}
      </div>

      <div className="wiki-action-tools">
        {capabilities.canUploadMedia && onUploadMedia && (
          <button type="button" className="pill-btn" onClick={onUploadMedia}>
            + Upload Media
          </button>
        )}
        {capabilities.canEdit && onCreateRecord && (
          <button type="button" className="pill-btn" onClick={onCreateRecord}>
            + New Record
          </button>
        )}
      </div>
    </div>
  );
};
