import type { ArchiveSearchResult, SearchResultKind } from '@kinloom/core';
import { searchArchive } from '@kinloom/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSearchableQuery, searchNavNext, searchNavPrev, searchNavReset } from '../lib/searchNavigation.js';
import { KINLOOM_VOCABULARY, SEARCH_KIND_LABELS } from '../lib/vocabulary.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';
import { useNavigate } from 'react-router-dom';

export const GlobalSearchModal: React.FC = () => {
  const { bundle, placesById, readings, readingsLoading, siteConfig } = useArchiveData();
  const { searchOpen, closeSearch, openSourceReader } = useArchiveUi();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);

  const [prevSearchKey, setPrevSearchKey] = useState('');
  const searchKey = `${searchOpen}:${query}`;
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
    [query, bundle, placesById, readings],
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
    [closeSearch, openSourceReader, navigate],
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
      } else if (
        e.key === 'Enter' &&
        document.activeElement === inputRef.current &&
        results[activeIdx]
      ) {
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

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className="lightbox-backdrop global-search-backdrop"
      aria-label={KINLOOM_VOCABULARY.search.dialogAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className="lightbox-backdrop-close"
        aria-label="Close search"
        onClick={closeSearch}
      />
      <div className="global-search-card">
        <div className="global-search-header">
          <input
            ref={inputRef}
            type="search"
            className="global-search-input"
            placeholder={KINLOOM_VOCABULARY.search.placeholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            aria-label={KINLOOM_VOCABULARY.search.inputAria}
          />
          <button
            type="button"
            className="pill-btn global-search-close-btn"
            aria-label="Close search"
            onClick={closeSearch}
          >
            <span className="global-search-close-desktop">Esc</span>
            <span className="global-search-close-mobile">Close</span>
          </button>
        </div>

        <div className="global-search-body">
          {isSearchableQuery(query) ? (
            <>
              {results.length === 0 && (
                <div style={{ padding: '18px 16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  {KINLOOM_VOCABULARY.search.emptyPrefix} “{query}”.
                </div>
              )}
              {results.length > 0 && (
                <div className="global-search-groups">
                  {grouped.map((group) => (
                    <div key={group.kind} className="global-search-group">
                      <div className="global-search-group-title">
                        {SEARCH_KIND_LABELS[group.kind]} ({group.items.length})
                      </div>
                      {group.items.map((item) => {
                        const flatIdx = results.findIndex((r) => r.id === item.id);
                        const isActive = flatIdx === activeIdx;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            className={`global-search-item ${isActive ? 'active' : ''}`}
                            onMouseEnter={() => {
                              setActiveIdx(flatIdx);
                            }}
                            onClick={() => {
                              activateResult(item);
                            }}
                          >
                            <div className="global-search-item-title">{item.title}</div>
                            <div className="global-search-item-sub">{item.subtitle}</div>
                            {item.snippet && (
                              <div className="global-search-item-snippet">{item.snippet}</div>
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
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.78rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
                TRY SEARCHING ACROSS PEOPLE, PLACES, EVENTS &amp;{' '}
                {totalSourcePages > 0 ? `${totalSourcePages} SOURCE PAGES:` : 'SOURCE PAGES:'}
              </div>
              {quickQueries.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {quickQueries.map((q) => (
                    <button
                      key={q}
                      type="button"
                      className="pill-btn"
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
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: 10 }}>
                  Loading primary source transcriptions…
                </div>
              )}
            </div>
          )}
        </div>

        <div className="global-search-footer">
          <span className="global-search-kbd-hint">↑↓ navigate · Enter open · Esc close</span>
          <span>{readings ? `${totalSourcePages} source pages searchable` : 'Archive ready'}</span>
        </div>
      </div>
    </dialog>
  );
};
