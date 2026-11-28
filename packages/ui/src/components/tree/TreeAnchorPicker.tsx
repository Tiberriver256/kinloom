import type { Person } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TreeSearchCandidate } from '../../lib/archivalTreeModel.js';
import { cx, joinClasses } from '../../lib/cx.js';
import { searchNavNext, searchNavPrev, searchNavReset } from '../../lib/searchNavigation.js';
import { formatTreeCardName } from '../../lib/treeNodeDisplay.js';
import controlStyles from '../../styles/Controls.module.css';
import treeToolbarStyles from './TreeToolbar.module.css';

export interface TreeAnchorPickerProps {
  readonly activeAnchor: Person | null;
  readonly query: string;
  readonly onQueryChange: (nextQuery: string) => void;
  readonly candidates: readonly TreeSearchCandidate[];
  readonly onSelectAnchor: (person: Person) => void;
  readonly onResetAnchor: () => void;
}

export const TreeAnchorPicker: React.FC<TreeAnchorPickerProps> = ({
  activeAnchor,
  query,
  onQueryChange,
  candidates,
  onSelectAnchor,
  onResetAnchor,
}) => {
  const triggerId = useId();
  const popoverId = useId();
  const inputId = useId();
  const listboxId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [prevQuery, setPrevQuery] = useState(query);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
    if (!isOpen) {
      return undefined;
    }
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 0);

    const onPointerDown = (e: MouseEvent): void => {
      if (containerRef.current && e.target instanceof Node && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return (): void => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [isOpen]);

  const activeCandidate = clampedActiveIdx >= 0 ? candidates[clampedActiveIdx] : undefined;
  const activeOptionId = activeCandidate ? `${listboxId}-opt-${activeCandidate.person.id}` : undefined;

  const commitAnchor = (person: Person): void => {
    onSelectAnchor(person);
    onQueryChange('');
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const commitReset = (): void => {
    onResetAnchor();
    onQueryChange('');
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => searchNavNext(i, candidates.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => searchNavPrev(i));
    } else if (e.key === 'Enter' && activeCandidate) {
      e.preventDefault();
      commitAnchor(activeCandidate.person);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (query.length > 0) {
        onQueryChange('');
      } else {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }
  };

  const displayAnchorLabel = activeAnchor ? formatTreeCardName(activeAnchor.full_name, 18) : 'Default';
  const triggerAriaLabel = activeAnchor
    ? `Trace from: ${activeAnchor.full_name}. Select focal person`
    : 'Trace from: Default. Select focal person';

  return (
    <div ref={containerRef} className={cx(treeToolbarStyles, 'tree-anchor-picker')}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={joinClasses(
          cx(controlStyles, 'pill-btn'),
          cx(treeToolbarStyles, `tree-anchor-trigger${activeAnchor ? ' is-custom' : ''}`)
        )}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-controls={isOpen ? popoverId : undefined}
        aria-label={triggerAriaLabel}
        onClick={() => {
          setIsOpen((prev) => !prev);
        }}
      >
        <span className={cx(treeToolbarStyles, 'tree-anchor-trigger-label')}>
          Trace from: <strong>{displayAnchorLabel}</strong>
        </span>
        <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
          <path
            d="M2.5 4.25L6 7.75l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {activeAnchor && (
        <button
          type="button"
          className={joinClasses(
            cx(controlStyles, 'pill-btn'),
            cx(treeToolbarStyles, 'tree-anchor-reset-btn')
          )}
          aria-label="Reset to default"
          onClick={commitReset}
        >
          Reset to default
        </button>
      )}

      {isOpen && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Select focal person to trace ancestors from"
          className={cx(treeToolbarStyles, 'tree-search-popover tree-anchor-popover')}
        >
          <div className={cx(treeToolbarStyles, 'tree-anchor-popover-header')}>
            <label htmlFor={inputId} className={'visually-hidden'}>
              Trace ancestors from person
            </label>
            <input
              ref={inputRef}
              id={inputId}
              type="search"
              role="combobox"
              className={cx(treeToolbarStyles, 'tree-anchor-search-input')}
              placeholder="Trace ancestors from…"
              value={query}
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listboxId}
              aria-activedescendant={activeOptionId}
              onChange={(e) => {
                onQueryChange(e.target.value);
              }}
              onKeyDown={handleInputKeyDown}
            />
            {activeAnchor && (
              <button
                type="button"
                className={cx(treeToolbarStyles, 'tree-anchor-popover-reset')}
                onClick={commitReset}
              >
                Reset to default
              </button>
            )}
          </div>

          <div
            id={listboxId}
            role="listbox"
            aria-label="Focal person candidates"
            className={cx(treeToolbarStyles, 'tree-search-listbox')}
          >
            {candidates.length === 0 ? (
              <div className={cx(treeToolbarStyles, 'tree-search-empty')}>
                No matching people for “{query.trim()}”.
              </div>
            ) : (
              candidates.map((candidate, idx) => {
                const isActive = idx === clampedActiveIdx;
                const isCurrentAnchor = activeAnchor?.id === candidate.person.id;
                const metaBits: string[] = [candidate.lifespanLabel];
                if (candidate.genLabel) {
                  metaBits.push(candidate.genLabel);
                }
                if (candidate.isOutsideCurrentBranch && candidate.branchLabel) {
                  metaBits.push(candidate.branchLabel);
                }
                if (isCurrentAnchor) {
                  metaBits.push('Spine anchor');
                }

                return (
                  <button
                    key={candidate.person.id}
                    id={`${listboxId}-opt-${candidate.person.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    className={cx(
                      treeToolbarStyles,
                      `tree-search-option${isActive ? ' is-active' : ''}${isCurrentAnchor ? ' is-current-anchor' : ''}`
                    )}
                    onMouseEnter={() => {
                      setActiveIdx(idx);
                    }}
                    onClick={() => {
                      commitAnchor(candidate.person);
                    }}
                  >
                    <span className={cx(treeToolbarStyles, 'tree-search-option-name')}>
                      {candidate.person.full_name}
                    </span>
                    <span className={cx(treeToolbarStyles, 'tree-search-option-meta')}>
                      {metaBits.join(' · ')}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
