import type { ArchiveSearchResult, SearchResultKind } from '@kinloom/core';
import { searchArchive } from '@kinloom/core';
import type React from 'react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type RecentlyViewedItem, readRecentlyViewed } from '../browser/recentlyViewed.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../lib/cx.js';
import { isSearchableQuery, searchNavNext, searchNavPrev, searchNavReset } from '../lib/searchNavigation.js';
import { KINLOOM_VOCABULARY, SEARCH_KIND_LABELS } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import overlayStyles from '../styles/Overlays.module.css';
import searchModalStyles from './GlobalSearchModal.module.css';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderHighlightedText(text: string, rawQuery: string, markClassName: string): React.ReactNode {
  const terms = rawQuery
    .trim()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  if (terms.length === 0) {
    return text;
  }
  const regex = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi');
  const parts = text.split(regex);
  if (parts.length <= 1) {
    return text;
  }
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    offset += part.length;
    const isMatch = terms.some((term) => term.toLowerCase() === part.toLowerCase());
    return isMatch ? (
      <mark key={`m-${start}-${part}`} className={markClassName}>
        {part}
      </mark>
    ) : (
      part
    );
  });
}

export const GlobalSearchModal: React.FC = () => {
  const { bundle, placesById, readings, readingsLoading, siteConfig } = useArchiveData();
  const { searchOpen, closeSearch, openSourceReader } = useArchiveUi();
  const navigate = useNavigate();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  const searchKey = `${searchOpen}:${query}`;
  const [prevSearchKey, setPrevSearchKey] = useState(searchKey);
  if (searchKey !== prevSearchKey) {
    setPrevSearchKey(searchKey);
    setActiveIdx(searchNavReset());
  }

  const dialogRef = useDialogFocusTrap({
    open: searchOpen,
    onClose: closeSearch,
    initialFocusRef: inputRef,
  });

  const quickQueries = useMemo<string[]>(() => {
    const suggestions: string[] = [];
    const seen = new Set<string>();
    const add = (label: string | undefined): void => {
      const trimmed = label?.trim();
      if (!trimmed) {
        return;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      suggestions.push(trimmed);
    };

    if (bundle) {
      const topPeople = [...bundle.people]
        .filter((p) => !(p.is_living && p.full_name === 'Living'))
        .toSorted((a, b) => b.event_count - a.event_count)
        .slice(0, 3);
      for (const p of topPeople) {
        add(p.full_name);
      }

      const topPlaces = bundle.places
        .filter((pl) => pl.place_type === 'town' || pl.place_type === 'county')
        .slice(0, 2);
      for (const pl of topPlaces) {
        add(pl.name);
      }
    }

    const firstAnchor = siteConfig.anchorYears?.[0]?.label;
    if (firstAnchor) {
      add(firstAnchor);
    }
    return suggestions.slice(0, 6);
  }, [bundle, siteConfig.anchorYears]);

  const recentlyViewed = useMemo<RecentlyViewedItem[]>(() => {
    if (!searchOpen) {
      return [];
    }
    return readRecentlyViewed();
  }, [searchOpen]);

  const totalSourcePages = useMemo(() => {
    if (!readings) {
      return 0;
    }
    return Object.values(readings.documents).reduce((a, d) => a + d.pages.length, 0);
  }, [readings]);

  const results = useMemo(
    () =>
      searchArchive({
        query,
        bundle,
        placesById,
        readings,
        limitPerKind: 6,
      }),
    [query, bundle, placesById, readings]
  );

  const activateResult = useCallback(
    (item: ArchiveSearchResult) => {
      closeSearch();
      setQuery('');
      if (item.sourceReaderTarget) {
        openSourceReader({
          sourceId: item.sourceReaderTarget.sourceId,
          page: item.sourceReaderTarget.page,
          highlightQuery: item.sourceReaderTarget.query,
        });
      } else if (item.route) {
        void navigate(item.route);
      }
    },
    [closeSearch, openSourceReader, navigate]
  );

  useEffect(() => {
    if (!searchOpen) {
      return undefined;
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => searchNavNext(i, results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => searchNavPrev(i));
      } else if (e.key === 'Enter' && document.activeElement === inputRef.current && results[activeIdx]) {
        e.preventDefault();
        activateResult(results[activeIdx]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen, results, activeIdx, activateResult]);

  if (!searchOpen) {
    return null;
  }

  const grouped = (['person', 'place', 'event', 'reading'] as SearchResultKind[])
    .map((kind) => ({
      kind,
      items: results.filter((r) => r.kind === kind),
    }))
    .filter((g) => g.items.length > 0);

  const searchable = isSearchableQuery(query);
  const activeOptionId = searchable && results[activeIdx] ? `${listboxId}-option-${activeIdx}` : undefined;
  const liveCountAnnouncement = searchable
    ? results.length === 0
      ? `No results for ${query.trim()}`
      : `${results.length} matching ${results.length === 1 ? 'result' : 'results'} for ${query.trim()}`
    : '';
  const markClass = cx(searchModalStyles, 'global-search-mark');

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={cx(overlayStyles, 'lightbox-backdrop global-search-backdrop')}
      aria-label={KINLOOM_VOCABULARY.search.dialogAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close search"
        onClick={closeSearch}
      />
      <div className={cx(searchModalStyles, 'global-search-card')}>
        <div className={cx(searchModalStyles, 'global-search-header')}>
          <input
            ref={inputRef}
            type="search"
            role="combobox"
            aria-expanded={searchable && results.length > 0}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-activedescendant={activeOptionId}
            className={cx(searchModalStyles, 'global-search-input')}
            placeholder={KINLOOM_VOCABULARY.search.placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            aria-label={KINLOOM_VOCABULARY.search.inputAria}
          />
          <button
            type="button"
            className={joinClasses(
              cx(controlStyles, 'pill-btn'),
              cx(searchModalStyles, 'global-search-close-btn')
            )}
            aria-label="Close search"
            onClick={closeSearch}
          >
            <kbd className={joinClasses('kl-kbd', cx(searchModalStyles, 'global-search-close-desktop'))}>
              Esc
            </kbd>
            <span className={cx(searchModalStyles, 'global-search-close-mobile')}>Close</span>
          </button>
        </div>

        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {liveCountAnnouncement}
        </div>

        <div className={cx(searchModalStyles, 'global-search-body')}>
          {searchable ? (
            <>
              {results.length === 0 && (
                <div style={{ padding: '18px 16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  {KINLOOM_VOCABULARY.search.emptyPrefix} “{query}”.
                </div>
              )}
              {results.length > 0 && (
                <div
                  id={listboxId}
                  role="listbox"
                  aria-label="Search results"
                  className={cx(searchModalStyles, 'global-search-groups')}
                >
                  {grouped.map((group) => (
                    <div key={group.kind} className={'global-search-group'}>
                      <div className={cx(searchModalStyles, 'global-search-group-title')}>
                        {SEARCH_KIND_LABELS[group.kind]} ({group.items.length})
                      </div>
                      {group.items.map((item) => {
                        const flatIdx = results.findIndex((r) => r.id === item.id);
                        const isActive = flatIdx === activeIdx;
                        return (
                          <button
                            key={item.id}
                            id={`${listboxId}-option-${flatIdx}`}
                            role="option"
                            aria-selected={isActive}
                            type="button"
                            className={cx(
                              searchModalStyles,
                              `global-search-item ${isActive ? 'active' : ''}`
                            )}
                            onMouseEnter={() => {
                              setActiveIdx(flatIdx);
                            }}
                            onClick={() => {
                              activateResult(item);
                            }}
                          >
                            <div className={'global-search-item-title'}>
                              {renderHighlightedText(item.title, query, markClass)}
                            </div>
                            <div className={'global-search-item-sub'}>
                              {renderHighlightedText(item.subtitle, query, markClass)}
                            </div>
                            {item.snippet && (
                              <div className={'global-search-item-snippet'}>
                                {renderHighlightedText(item.snippet, query, markClass)}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: '14px 16px' }}>
              {recentlyViewed.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: '0.74rem',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                      color: 'var(--text-secondary)',
                      marginBottom: 6,
                    }}
                  >
                    Recently viewed
                  </div>
                  <div className="kl-cluster">
                    {recentlyViewed.map((item) => (
                      <button
                        key={`${item.kind}:${item.slug}`}
                        type="button"
                        className={cx(searchModalStyles, 'global-search-suggestion-chip')}
                        onClick={() => {
                          closeSearch();
                          setQuery('');
                          void navigate(
                            item.kind === 'person' ? `/person/${item.slug}` : `/place/${item.slug}`
                          );
                        }}
                      >
                        {item.label}
                        {item.meta ? ` (${item.meta})` : ''}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.78rem',
                  color: 'var(--text-secondary)',
                  marginBottom: 8,
                }}
              >
                TRY SEARCHING ACROSS PEOPLE, PLACES, EVENTS &amp;{' '}
                {totalSourcePages > 0 ? `${totalSourcePages} SOURCE PAGES:` : 'SOURCE PAGES:'}
              </div>
              {quickQueries.length > 0 && (
                <div className="kl-cluster">
                  {quickQueries.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className={cx(searchModalStyles, 'global-search-suggestion-chip')}
                      onClick={() => {
                        setQuery(q);
                      }}
                    >
                      {q}
                    </button>
                  ))}
                </div>
              )}
              {readingsLoading && (
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '0.75rem',
                    color: 'var(--text-secondary)',
                    marginTop: 10,
                  }}
                >
                  Loading primary source transcriptions…
                </div>
              )}
            </div>
          )}
        </div>

        <div className={cx(searchModalStyles, 'global-search-footer')}>
          <span className={cx(searchModalStyles, 'global-search-kbd-hint')}>
            <kbd className="kl-kbd">↑</kbd>
            <kbd className="kl-kbd">↓</kbd> navigate · <kbd className="kl-kbd">Enter</kbd> open ·{' '}
            <kbd className="kl-kbd">Esc</kbd> close
          </span>
          <span>{readings ? `${totalSourcePages} source pages searchable` : 'Archive ready'}</span>
        </div>
      </div>
    </dialog>
  );
};
