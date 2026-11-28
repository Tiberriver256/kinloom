import type { BranchConfig, Person } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { TreeLineageMode, TreeSearchCandidate, TreeViewSurface } from '../../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import { TreeAnchorPicker } from './TreeAnchorPicker.js';
import { TreePersonSearch } from './TreePersonSearch.js';
import treeToolbarStyles from './TreeToolbar.module.css';

export interface TreeToolbarProps {
  readonly shellRef?: React.RefObject<HTMLDivElement | null>;
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
  readonly activeAnchor?: Person | null;
  readonly anchorQuery?: string;
  readonly onAnchorQueryChange?: (nextQuery: string) => void;
  readonly anchorCandidates?: readonly TreeSearchCandidate[];
  readonly onSelectAnchor?: (person: Person) => void;
  readonly onResetAnchor?: () => void;
}

export const TreeToolbar: React.FC<TreeToolbarProps> = ({
  shellRef,
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
  activeAnchor = null,
  anchorQuery = '',
  onAnchorQueryChange,
  anchorCandidates = [],
  onSelectAnchor,
  onResetAnchor,
}) => {
  const filtersPanelId = useId();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const localShellRef = useRef<HTMLDivElement | null>(null);
  const filtersTriggerRef = useRef<HTMLButtonElement | null>(null);

  const assignShellRef = useCallback(
    (node: HTMLDivElement | null): void => {
      localShellRef.current = node;
      if (shellRef) {
        shellRef.current = node;
      }
    },
    [shellRef]
  );

  const activeFilterCount =
    (branchFilter !== 'all' ? 1 : 0) +
    (activeAnchor !== null ? 1 : 0) +
    (searchQuery.trim().length > 0 ? 1 : 0);

  useEffect(() => {
    if (!mobileFiltersOpen) {
      return undefined;
    }
    const onPointerDown = (e: MouseEvent): void => {
      if (localShellRef.current && e.target instanceof Node && !localShellRef.current.contains(e.target)) {
        setMobileFiltersOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setMobileFiltersOpen(false);
        filtersTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [mobileFiltersOpen]);

  return (
    <div
      ref={assignShellRef}
      className={cx(treeToolbarStyles, `tree-toolbar-shell${mobileFiltersOpen ? ' is-filters-open' : ''}`)}
    >
      <div
        className={cx(treeToolbarStyles, 'tree-toolbar')}
        role="toolbar"
        aria-label={KINLOOM_VOCABULARY.tree.toolbarAria}
      >
        <div className={cx(treeToolbarStyles, 'tree-toolbar-primary-bar')}>
          <div
            className={cx(treeToolbarStyles, 'tree-segmented tree-layout-segmented')}
            role="group"
            aria-label={KINLOOM_VOCABULARY.tree.layoutGroupAria}
          >
            <button
              type="button"
              className={cx(controlStyles, `pill-btn tree-seg-btn${surface === 'roll' ? ' active' : ''}`)}
              aria-pressed={surface === 'roll'}
              onClick={() => {
                setMobileFiltersOpen(false);
                onSurfaceChange('roll');
              }}
            >
              {KINLOOM_VOCABULARY.tree.listViewShort}
            </button>
            <button
              type="button"
              className={cx(controlStyles, `pill-btn tree-seg-btn${surface === 'diagram' ? ' active' : ''}`)}
              aria-pressed={surface === 'diagram'}
              onClick={() => {
                setMobileFiltersOpen(false);
                onSurfaceChange('diagram');
              }}
            >
              {KINLOOM_VOCABULARY.tree.chartViewShort}
            </button>
            <button
              type="button"
              className={cx(controlStyles, `pill-btn tree-seg-btn${surface === 'loom' ? ' active' : ''}`)}
              aria-pressed={surface === 'loom'}
              onClick={() => {
                setMobileFiltersOpen(false);
                onSurfaceChange('loom');
              }}
            >
              {KINLOOM_VOCABULARY.tree.loomViewShort}
            </button>
          </div>

          {showDirectToggle && (
            <div
              className={cx(treeToolbarStyles, 'tree-segmented tree-scope-segmented')}
              role="group"
              aria-label={KINLOOM_VOCABULARY.tree.scopeGroupAria}
            >
              <button
                type="button"
                className={cx(controlStyles, `pill-btn tree-seg-btn${mode === 'spine' ? ' active' : ''}`)}
                aria-pressed={mode === 'spine'}
                onClick={() => {
                  setMobileFiltersOpen(false);
                  onModeChange('spine');
                }}
              >
                Direct<span className={cx(treeToolbarStyles, 'tree-seg-detail')}> Line</span>
              </button>
              <button
                type="button"
                className={cx(controlStyles, `pill-btn tree-seg-btn${mode === 'full' ? ' active' : ''}`)}
                aria-pressed={mode === 'full'}
                onClick={() => {
                  setMobileFiltersOpen(false);
                  onModeChange('full');
                }}
              >
                Full<span className={cx(treeToolbarStyles, 'tree-seg-detail')}> Tree ({activeCount})</span>
              </button>
            </div>
          )}

          <button
            ref={filtersTriggerRef}
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(
                treeToolbarStyles,
                `tree-filters-toggle-btn${mobileFiltersOpen ? ' active' : ''}${activeFilterCount > 0 ? ' has-active' : ''}`
              )
            )}
            aria-expanded={mobileFiltersOpen}
            aria-controls={filtersPanelId}
            aria-label={
              activeFilterCount > 0 ? `Filters and trace (${activeFilterCount} active)` : 'Filters and trace'
            }
            onClick={() => {
              setMobileFiltersOpen((prev) => !prev);
            }}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d="M2.5 4h11M4.5 8h7M6.5 12h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <span>Filters</span>
            {activeFilterCount > 0 && (
              <span
                className={cx(treeToolbarStyles, 'tree-filters-badge')}
                data-active-count={activeFilterCount}
                aria-hidden="true"
              >
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        <div
          id={filtersPanelId}
          className={cx(
            treeToolbarStyles,
            `tree-toolbar-filters-panel${mobileFiltersOpen ? ' is-open' : ''}`
          )}
          data-filters-open={mobileFiltersOpen ? 'true' : 'false'}
        >
          <div className={cx(treeToolbarStyles, 'tree-filters-sheet-header')}>
            <span className={cx(treeToolbarStyles, 'tree-filters-sheet-title')}>Filters &amp; Trace</span>
            <button
              type="button"
              className={cx(treeToolbarStyles, 'tree-filters-sheet-close')}
              aria-label="Close filters and trace"
              onClick={() => {
                setMobileFiltersOpen(false);
                filtersTriggerRef.current?.focus();
              }}
            >
              Done
            </button>
          </div>

          <TreePersonSearch
            query={searchQuery}
            onQueryChange={onSearchQueryChange}
            candidates={searchCandidates}
            onSelectCandidate={(person) => {
              setMobileFiltersOpen(false);
              onSelectSearchPerson(person);
            }}
            mobileOpen={mobileSearchOpen}
            onMobileOpenChange={onMobileSearchOpenChange}
          />

          {populatedBranches.length > 1 && (
            <select
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(treeToolbarStyles, 'tree-branch-select')
              )}
              aria-label={KINLOOM_VOCABULARY.tree.branchSelectAria}
              value={branchFilter}
              onChange={(e) => {
                onBranchFilterChange(e.target.value);
              }}
            >
              <option value="all">
                {KINLOOM_VOCABULARY.tree.allBranches} ({branchCounts['all'] || 0})
              </option>
              {populatedBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.label} ({branchCounts[branch.id] || 0})
                </option>
              ))}
            </select>
          )}

          {onSelectAnchor && onAnchorQueryChange && onResetAnchor && (
            <TreeAnchorPicker
              activeAnchor={activeAnchor}
              query={anchorQuery}
              onQueryChange={onAnchorQueryChange}
              candidates={anchorCandidates}
              onSelectAnchor={(person) => {
                onSelectAnchor(person);
                setMobileFiltersOpen(false);
              }}
              onResetAnchor={onResetAnchor}
            />
          )}

          {canEdit && (
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn tree-add-person-btn')}
              onClick={() => {
                setMobileFiltersOpen(false);
                onAddPerson();
              }}
            >
              {KINLOOM_VOCABULARY.tree.addPerson}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
