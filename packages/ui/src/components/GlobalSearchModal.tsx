import type { ArchiveSearchResult, SearchResultKind } from '@kinloom/core';
import { searchArchive } from '@kinloom/core';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSearchableQuery, searchNavNext, searchNavPrev, searchNavReset } from '../lib/searchNavigation.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useNavigate } from 'react-router-dom';

const KIND_LABELS: Record<SearchResultKind, string> = {
  person: 'People',
  place: 'Places',
  event: 'Milestones & Dispatches',
  reading: 'Primary Source Pages',
};

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

  useEffect(() => {
    if (!searchOpen) {
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 10);
  }, [searchOpen]);

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
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => searchNavNext(i, results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => searchNavPrev(i));
      } else if (e.key === 'Enter' && results[activeIdx]) {
        e.preventDefault();
        activateResult(results[activeIdx]);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen, results, activeIdx, closeSearch, activateResult]);

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
      open
      className="lightbox-backdrop global-search-backdrop"
      aria-label="Global archive search"
    >
      <button
        type="button"
        className="lightbox-backdrop-close"
        aria-label="Close global archive search"
        onClick={closeSearch}
      />
      <div className="global-search-card">
        <div className="global-search-header">
          <input
            ref={inputRef}
            type="search"
            className="global-search-input"
            placeholder="Search people, places, milestones, or primary transcriptions…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            aria-label="Search the entire family archive"
          />
          <button type="button" className="pill-btn" onClick={closeSearch}>
            Esc
          </button>
        </div>

        <div className="global-search-body">
          {isSearchableQuery(query) ? (
            <>
              {results.length === 0 && (
                <div style={{ padding: '18px 16px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                  No matching people, places, events, or primary source passages for “{query}”.
                </div>
              )}
              {results.length > 0 && (
                <div className="global-search-groups">
                  {grouped.map((group) => (
                    <div key={group.kind} className="global-search-group">
                      <div className="global-search-group-title">
                        {KIND_LABELS[group.kind]} ({group.items.length})
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
                TRY SEARCHING ACROSS PEOPLE, PLACES, EVENTS &amp; {totalSourcePages || 'PRIMARY'} ARCHIVAL SOURCE PAGES:
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
          <span>↑↓ navigate · Enter open · Esc close</span>
          <span>{readings ? `${totalSourcePages} source pages searchable` : 'Archive ready'}</span>
        </div>
      </div>
    </dialog>
  );
};
