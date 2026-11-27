import type { Person } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TreeSearchCandidate } from '../../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { searchNavNext, searchNavPrev, searchNavReset } from '../../lib/searchNavigation.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import treeToolbarStyles from './TreeToolbar.module.css';

export interface TreePersonSearchProps {
  readonly query: string;
  readonly onQueryChange: (nextQuery: string) => void;
  readonly candidates: readonly TreeSearchCandidate[];
  readonly onSelectCandidate: (person: Person) => void;
  readonly mobileOpen: boolean;
  readonly onMobileOpenChange: (open: boolean) => void;
}

export const TreePersonSearch: React.FC<TreePersonSearchProps> = ({
  query,
  onQueryChange,
  candidates,
  onSelectCandidate,
  mobileOpen,
  onMobileOpenChange,
}) => {
  const inputId = useId();
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);
  const desktopInputRef = useRef<HTMLInputElement | null>(null);
  const mobileInputRef = useRef<HTMLInputElement | null>(null);

  if (query !== prevQuery) {
    setPrevQuery(query);
    setActiveIdx(searchNavReset());
  }

  const clampedActiveIdx = useMemo(() => {
    if (candidates.length === 0) {
      return -1;
    }
    return Math.max(0, Math.min(activeIdx, candidates.length - 1));
  }, [activeIdx, candidates.length]);

  useEffect(() => {
    if (mobileOpen) {
      window.setTimeout(() => {
        mobileInputRef.current?.focus();
      }, 10);
    }
  }, [mobileOpen]);

  const showDesktopDropdown = isOpen && !mobileOpen;
  const activeCandidate = clampedActiveIdx >= 0 ? candidates[clampedActiveIdx] : undefined;
  const activeOptionId = activeCandidate ? `${listboxId}-opt-${activeCandidate.person.id}` : undefined;

  const commitSelection = (person: Person): void => {
    onSelectCandidate(person);
    onQueryChange('');
    setIsOpen(false);
    onMobileOpenChange(false);
    desktopInputRef.current?.blur();
    mobileInputRef.current?.blur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen && !mobileOpen) {
        setIsOpen(true);
      }
      setActiveIdx((i) => searchNavNext(i, candidates.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen && !mobileOpen) {
        setIsOpen(true);
      }
      setActiveIdx((i) => searchNavPrev(i));
    } else if (e.key === 'Enter' && activeCandidate) {
      e.preventDefault();
      commitSelection(activeCandidate.person);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query.length > 0) {
        onQueryChange('');
      } else {
        setIsOpen(false);
        onMobileOpenChange(false);
        e.currentTarget.blur();
      }
    }
  };

  const renderListbox = (): React.ReactNode => (
    <div
      id={listboxId}
      role="listbox"
      aria-label="Matching people in family tree"
      className={cx(treeToolbarStyles, 'tree-search-listbox')}
    >
      {candidates.length === 0 ? (
        <div className={cx(treeToolbarStyles, 'tree-search-empty')}>
          No matching people for “{query.trim()}”.
        </div>
      ) : (
        candidates.map((candidate, idx) => {
          const isActive = idx === clampedActiveIdx;
          const metaBits: string[] = [candidate.lifespanLabel];
          if (candidate.genLabel) {
            metaBits.push(candidate.genLabel);
          }
          if (candidate.isOutsideCurrentBranch && candidate.branchLabel) {
            metaBits.push(candidate.branchLabel);
          } else if (candidate.isCollapsed) {
            metaBits.push(KINLOOM_VOCABULARY.tree.moreSiblingsTag);
          } else if (candidate.isOutsideCurrentMode) {
            metaBits.push(KINLOOM_VOCABULARY.tree.fullTree);
          }

          return (
            <button
              key={candidate.person.id}
              id={`${listboxId}-opt-${candidate.person.id}`}
              type="button"
              role="option"
              aria-selected={isActive}
              className={cx(treeToolbarStyles, `tree-search-option${isActive ? ' is-active' : ''}`)}
              onMouseEnter={() => {
                setActiveIdx(idx);
              }}
              onClick={() => {
                commitSelection(candidate.person);
              }}
            >
              <span className={cx(treeToolbarStyles, 'tree-search-option-name')}>
                {candidate.person.full_name}
              </span>
              <span className={cx(treeToolbarStyles, 'tree-search-option-meta')}>{metaBits.join(' · ')}</span>
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <>
      <div className={cx(treeToolbarStyles, 'tree-search-desktop')}>
        <label htmlFor={inputId} className={'visually-hidden'}>
          Find person in family tree
        </label>
        <span className={cx(treeToolbarStyles, 'tree-search-icon')} aria-hidden="true">
          <svg viewBox="0 0 20 20" width="14" height="14" focusable="false" aria-hidden="true">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.7" />
            <path d="M13 13l4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={desktopInputRef}
          id={inputId}
          type="search"
          role="combobox"
          className={cx(treeToolbarStyles, 'tree-search-input')}
          placeholder="Find person…"
          value={query}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={showDesktopDropdown}
          aria-controls={listboxId}
          aria-activedescendant={showDesktopDropdown ? activeOptionId : undefined}
          onFocus={() => {
            setIsOpen(true);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              setIsOpen(false);
            }, 140);
          }}
          onChange={(e) => {
            onQueryChange(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {query.length > 0 && (
          <button
            type="button"
            className={cx(treeToolbarStyles, 'tree-search-clear')}
            aria-label="Clear person search"
            onMouseDown={(e) => {
              e.preventDefault();
            }}
            onClick={() => {
              onQueryChange('');
              desktopInputRef.current?.focus();
            }}
          >
            ✕
          </button>
        )}
        {showDesktopDropdown && (
          // biome-ignore lint/a11y/noStaticElementInteractions: prevents input blur while clicking dropdown items
          <div
            className={cx(treeToolbarStyles, 'tree-search-popover')}
            onMouseDown={(e) => {
              e.preventDefault();
            }}
          >
            {renderListbox()}
          </div>
        )}
      </div>

      <button
        type="button"
        className={joinClasses(
          cx(controlStyles, 'pill-btn'),
          cx(treeToolbarStyles, 'tree-search-toggle-btn'),
          mobileOpen ? ' active' : ''
        )}
        aria-label="Find person in tree"
        aria-expanded={mobileOpen}
        aria-controls={mobileOpen ? listboxId : undefined}
        title="Find person"
        onClick={() => {
          onMobileOpenChange(!mobileOpen);
        }}
      >
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
          <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M13 13l4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>

      {mobileOpen && (
        // biome-ignore lint/a11y/noStaticElementInteractions: prevents input blur while clicking dropdown items
        <div
          className={cx(treeToolbarStyles, 'tree-search-popover is-mobile-open')}
          onMouseDown={(e) => {
            if (!(e.target instanceof HTMLInputElement)) {
              e.preventDefault();
            }
          }}
        >
          <div className={cx(treeToolbarStyles, 'tree-search-mobile-bar')}>
            <label htmlFor={`${inputId}-mobile`} className={'visually-hidden'}>
              Find person in family tree
            </label>
            <input
              ref={mobileInputRef}
              id={`${inputId}-mobile`}
              type="search"
              role="combobox"
              className={cx(treeToolbarStyles, 'tree-search-mobile-input')}
              placeholder="Find person by name or year…"
              value={query}
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              onChange={(e) => {
                onQueryChange(e.target.value);
              }}
              onKeyDown={handleKeyDown}
            />
            <button
              type="button"
              className={joinClasses(
                cx(controlStyles, 'pill-btn'),
                cx(treeToolbarStyles, 'tree-search-mobile-close')
              )}
              aria-label="Close person search"
              onClick={() => {
                onMobileOpenChange(false);
                onQueryChange('');
              }}
            >
              Done
            </button>
          </div>
          {renderListbox()}
        </div>
      )}
    </>
  );
};
