import type { BranchConfig, Person } from '@kinloom/core';
import type React from 'react';
import type { TreeLineageMode, TreeSearchCandidate, TreeViewSurface } from '../../lib/archivalTreeModel.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import { TreePersonSearch } from './TreePersonSearch.js';

export interface TreeToolbarProps {
  readonly populatedBranches: readonly BranchConfig[];
  readonly branchCounts: Readonly<Record<string, number>>;
  readonly branchFilter: string;
  readonly onBranchFilterChange: (nextBranch: string) => void;
  readonly showDirectToggle: boolean;
  readonly mode: TreeLineageMode;
  readonly activeCount: number;
  readonly onModeChange: (nextMode: TreeLineageMode) => void;
  readonly surface: TreeViewSurface;
  readonly onSurfaceChange: (nextSurface: TreeViewSurface) => void;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (nextQuery: string) => void;
  readonly searchCandidates: readonly TreeSearchCandidate[];
  readonly onSelectSearchPerson: (person: Person) => void;
  readonly mobileSearchOpen: boolean;
  readonly onMobileSearchOpenChange: (open: boolean) => void;
  readonly canEdit: boolean;
  readonly onAddPerson: () => void;
}

export const TreeToolbar: React.FC<TreeToolbarProps> = ({
  populatedBranches,
  branchCounts,
  branchFilter,
  onBranchFilterChange,
  showDirectToggle,
  mode,
  activeCount,
  onModeChange,
  surface,
  onSurfaceChange,
  searchQuery,
  onSearchQueryChange,
  searchCandidates,
  onSelectSearchPerson,
  mobileSearchOpen,
  onMobileSearchOpenChange,
  canEdit,
  onAddPerson,
}) => (
  <div className="tree-toolbar-shell">
    <div className="tree-toolbar" role="toolbar" aria-label={KINLOOM_VOCABULARY.tree.toolbarAria}>
      <div className="tree-toolbar-row tree-toolbar-row-primary">
        <TreePersonSearch
          query={searchQuery}
          onQueryChange={onSearchQueryChange}
          candidates={searchCandidates}
          onSelectCandidate={onSelectSearchPerson}
          mobileOpen={mobileSearchOpen}
          onMobileOpenChange={onMobileSearchOpenChange}
        />

        {populatedBranches.length > 1 && (
          <select
            className="pill-btn tree-branch-select"
            aria-label={KINLOOM_VOCABULARY.tree.branchSelectAria}
            value={branchFilter}
            onChange={(e) => {
              onBranchFilterChange(e.target.value);
            }}
          >
            <option value="all">
              {KINLOOM_VOCABULARY.tree.allBranches} ({branchCounts.all || 0})
            </option>
            {populatedBranches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.label} ({branchCounts[branch.id] || 0})
              </option>
            ))}
          </select>
        )}

        {canEdit && (
          <button
            type="button"
            className="pill-btn tree-add-person-mobile-btn"
            aria-label="Add person"
            title={KINLOOM_VOCABULARY.tree.addPerson}
            onClick={onAddPerson}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M8 3v10M3 8h10" />
            </svg>
          </button>
        )}

        <div
          className="tree-segmented tree-layout-segmented"
          role="group"
          aria-label={KINLOOM_VOCABULARY.tree.layoutGroupAria}
        >
          <button
            type="button"
            className={`pill-btn tree-seg-btn${surface === 'roll' ? ' active' : ''}`}
            aria-pressed={surface === 'roll'}
            onClick={() => {
              onSurfaceChange('roll');
            }}
          >
            {KINLOOM_VOCABULARY.tree.listViewShort}
          </button>
          <button
            type="button"
            className={`pill-btn tree-seg-btn${surface === 'diagram' ? ' active' : ''}`}
            aria-pressed={surface === 'diagram'}
            onClick={() => {
              onSurfaceChange('diagram');
            }}
          >
            {KINLOOM_VOCABULARY.tree.chartViewShort}
          </button>
        </div>
      </div>

      {(showDirectToggle || canEdit) && (
        <div
          className={`tree-toolbar-row tree-toolbar-row-secondary${showDirectToggle ? '' : ' is-desktop-only'}`}
        >
          {showDirectToggle && (
            <div
              className="tree-segmented tree-scope-segmented"
              role="group"
              aria-label={KINLOOM_VOCABULARY.tree.scopeGroupAria}
            >
              <button
                type="button"
                className={`pill-btn tree-seg-btn${mode === 'spine' ? ' active' : ''}`}
                aria-pressed={mode === 'spine'}
                onClick={() => {
                  onModeChange('spine');
                }}
              >
                {KINLOOM_VOCABULARY.tree.directLine}
              </button>
              <button
                type="button"
                className={`pill-btn tree-seg-btn${mode === 'full' ? ' active' : ''}`}
                aria-pressed={mode === 'full'}
                onClick={() => {
                  onModeChange('full');
                }}
              >
                {KINLOOM_VOCABULARY.tree.fullTree} ({activeCount})
              </button>
            </div>
          )}

          {canEdit && (
            <button type="button" className="pill-btn tree-add-person-btn" onClick={onAddPerson}>
              {KINLOOM_VOCABULARY.tree.addPerson}
            </button>
          )}
        </div>
      )}
    </div>
  </div>
);
