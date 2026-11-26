import type { BranchConfig, Person } from '@kinloom/core';
import type {
  TreeLineageMode,
  TreeSearchCandidate,
  TreeViewSurface,
} from '../../lib/archivalTreeModel.js';
import React from 'react';
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
    <div className="tree-toolbar" role="toolbar" aria-label="Family tree view controls">
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
          aria-label="Select family branch for 2D Tree"
          value={branchFilter}
          onChange={(e) => {
            onBranchFilterChange(e.target.value);
          }}
        >
          <option value="all">All Branches ({branchCounts.all || 0})</option>
          {populatedBranches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.label} ({branchCounts[branch.id] || 0})
            </option>
          ))}
        </select>
      )}

      {showDirectToggle && (
        <div className="tree-segmented" role="group" aria-label="Lineage scope">
          <button
            type="button"
            className={`pill-btn tree-seg-btn${mode === 'spine' ? ' active' : ''}`}
            aria-pressed={mode === 'spine'}
            onClick={() => {
              onModeChange('spine');
            }}
          >
            Direct Spine
          </button>
          <button
            type="button"
            className={`pill-btn tree-seg-btn${mode === 'full' ? ' active' : ''}`}
            aria-pressed={mode === 'full'}
            onClick={() => {
              onModeChange('full');
            }}
          >
            Full Tree ({activeCount})
          </button>
        </div>
      )}

      <div className="tree-segmented" role="group" aria-label="Tree layout">
        <button
          type="button"
          className={`pill-btn tree-seg-btn${surface === 'roll' ? ' active' : ''}`}
          aria-pressed={surface === 'roll'}
          onClick={() => {
            onSurfaceChange('roll');
          }}
        >
          Roll
        </button>
        <button
          type="button"
          className={`pill-btn tree-seg-btn${surface === 'diagram' ? ' active' : ''}`}
          aria-pressed={surface === 'diagram'}
          onClick={() => {
            onSurfaceChange('diagram');
          }}
        >
          Diagram
        </button>
      </div>

      {canEdit && (
        <button
          type="button"
          className="pill-btn tree-add-person-btn"
          onClick={onAddPerson}
        >
          + Add Person
        </button>
      )}
    </div>
  </div>
);
