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
import {
  buildSearchPreviewSlip,
  COMMAND_BAR_QUICK_ACTIONS,
  findPreviewShortcutAction,
  type SearchShortcutAction,
} from '../lib/searchPreview.js';
import { KINLOOM_VOCABULARY, SEARCH_KIND_LABELS } from '../lib/vocabulary.js';
import controlStyles from '../styles/Controls.module.css';
import overlayStyles from '../styles/Overlays.module.css';
import { PersonPortrait } from './atoms/PersonPortrait.js';
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
  const { bundle, baseUrl, peopleById, placesById, eventsById, readings, readingsLoading, siteConfig } =
    useArchiveData();
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

  const searchable = isSearchableQuery(query);

  const previewSlip = useMemo(
    () =>
      searchable && results.length > 0
        ? buildSearchPreviewSlip({
            item: results[activeIdx],
            bundle,
            peopleById,
            placesById,
            eventsById,
          })
        : null,
    [searchable, results, activeIdx, bundle, peopleById, placesById, eventsById]
  );

  const navigateAndClose = useCallback(
    (route: string) => {
      closeSearch();
      setQuery('');
      void navigate(route);
    },
    [closeSearch, navigate]
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

  const activateShortcutAction = useCallback(
    (action: SearchShortcutAction) => {
      closeSearch();
      setQuery('');
      if (action.sourceReaderTarget) {
        openSourceReader({
          sourceId: action.sourceReaderTarget.sourceId,
          page: action.sourceReaderTarget.page,
          highlightQuery: action.sourceReaderTarget.query,
        });
      } else if (action.route) {
        void navigate(action.route);
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
      } else if (previewSlip && !e.ctrlKey && !e.metaKey) {
        const isTypingInInput = document.activeElement === inputRef.current;
        const canTriggerOneKey = e.altKey || !isTypingInInput;
        if (canTriggerOneKey) {
          const matchedAction = findPreviewShortcutAction(previewSlip, e.key);
          if (matchedAction) {
            e.preventDefault();
            activateShortcutAction(matchedAction);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return (): void => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen, results, activeIdx, previewSlip, activateResult, activateShortcutAction]);

  if (!searchOpen) {
    return null;
  }

  const grouped = (['person', 'place', 'event', 'reading'] as SearchResultKind[])
    .map((kind) => ({
      kind,
      items: results.filter((r) => r.kind === kind),
    }))
    .filter((g) => g.items.length > 0);

  const activeOptionId = searchable && results[activeIdx] ? `${listboxId}-option-${activeIdx}` : undefined;
  const liveCountAnnouncement = searchable
    ? results.length === 0
      ? `No results for ${query.trim()}`
      : `${results.length} matching ${results.length === 1 ? 'result' : 'results'} for ${query.trim()}`
    : '';
  const markClass = cx(searchModalStyles, 'global-search-mark');
  const hasPreview = Boolean(previewSlip);

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
      <div className={cx(searchModalStyles, `global-search-card${hasPreview ? ' has-preview' : ''}`)}>
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
          {query.length > 0 && (
            <button
              type="button"
              className={cx(searchModalStyles, 'global-search-clear-btn')}
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              ×
            </button>
          )}
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
                <div className={cx(searchModalStyles, 'global-search-empty')}>
                  {KINLOOM_VOCABULARY.search.emptyPrefix} “{query}”.
                </div>
              )}
              {results.length > 0 && (
                <div className={cx(searchModalStyles, 'global-search-split')}>
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

                  {previewSlip && (
                    <aside
                      className={cx(searchModalStyles, 'global-search-preview')}
                      aria-label="Selected result preview"
                    >
                      <div className={cx(searchModalStyles, 'global-search-preview-header')}>
                        {previewSlip.kind === 'person' && previewSlip.portraitName && (
                          <PersonPortrait
                            name={previewSlip.portraitName}
                            src={previewSlip.portraitUrl}
                            baseUrl={baseUrl}
                            size="md"
                            variant="print"
                          />
                        )}
                        <div className={cx(searchModalStyles, 'global-search-preview-heading')}>
                          <div className={cx(searchModalStyles, 'global-search-preview-eyebrow')}>
                            {previewSlip.eyebrow}
                          </div>
                          <h3 className={cx(searchModalStyles, 'global-search-preview-title')}>
                            {previewSlip.title}
                          </h3>
                          {previewSlip.lifespan && (
                            <div className={cx(searchModalStyles, 'global-search-preview-lifespan')}>
                              {previewSlip.lifespan}
                            </div>
                          )}
                        </div>
                      </div>

                      {previewSlip.primaryPlace && (
                        <div className={cx(searchModalStyles, 'global-search-preview-place')}>
                          <span className={cx(searchModalStyles, 'global-search-preview-label')}>
                            Primary place
                          </span>
                          <span>{previewSlip.primaryPlace}</span>
                        </div>
                      )}

                      {previewSlip.summaryLines.length > 0 && (
                        <ul className={cx(searchModalStyles, 'global-search-preview-meta')}>
                          {previewSlip.summaryLines.map((line) => (
                            <li key={line}>{line}</li>
                          ))}
                        </ul>
                      )}

                      {previewSlip.excerpt && (
                        <p className={cx(searchModalStyles, 'global-search-preview-excerpt')}>
                          {previewSlip.excerpt}
                        </p>
                      )}

                      {previewSlip.actions.length > 0 && (
                        <div
                          className={cx(searchModalStyles, 'global-search-preview-actions')}
                          role="group"
                          aria-label="Quick navigation shortcuts"
                        >
                          {previewSlip.actions.map((action) => (
                            <button
                              key={`${action.key}-${action.label}`}
                              type="button"
                              className={cx(searchModalStyles, 'global-search-preview-action-btn')}
                              title={
                                action.key === 'Enter'
                                  ? `Press Enter to open ${action.label}`
                                  : `Press ${action.key} (or Alt+${action.key} while typing) to open ${action.label}`
                              }
                              onClick={() => {
                                activateShortcutAction(action);
                              }}
                            >
                              <kbd className="kl-kbd">{action.key}</kbd>
                              <span>{action.label}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </aside>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className={cx(searchModalStyles, 'global-search-zero-query')}>
              {recentlyViewed.length > 0 && (
                <section
                  className={cx(searchModalStyles, 'global-search-zero-section')}
                  aria-label="Recently viewed"
                >
                  <div className={cx(searchModalStyles, 'global-search-section-label')}>Recently viewed</div>
                  <div className="kl-cluster">
                    {recentlyViewed.map((item) => (
                      <button
                        key={`${item.kind}:${item.slug}`}
                        type="button"
                        className={cx(searchModalStyles, 'global-search-suggestion-chip')}
                        onClick={() => {
                          navigateAndClose(
                            item.kind === 'person' ? `/person/${item.slug}` : `/place/${item.slug}`
                          );
                        }}
                      >
                        {item.label}
                        {item.meta ? ` (${item.meta})` : ''}
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <section
                className={cx(searchModalStyles, 'global-search-zero-section')}
                aria-label="Quick actions"
              >
                <div className={cx(searchModalStyles, 'global-search-section-label')}>Quick actions</div>
                <div className={cx(searchModalStyles, 'global-search-quick-actions')}>
                  {COMMAND_BAR_QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={cx(searchModalStyles, 'global-search-quick-action-btn')}
                      onClick={() => {
                        navigateAndClose(action.route);
                      }}
                    >
                      <span className={cx(searchModalStyles, 'global-search-quick-action-title')}>
                        {action.label}
                      </span>
                      <span className={cx(searchModalStyles, 'global-search-quick-action-desc')}>
                        {action.description}
                      </span>
                    </button>
                  ))}
                </div>
              </section>

              <section
                className={cx(searchModalStyles, 'global-search-zero-section')}
                aria-label="Suggested searches"
              >
                <div className={cx(searchModalStyles, 'global-search-section-label')}>
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
              </section>

              {readingsLoading && (
                <div className={cx(searchModalStyles, 'global-search-loading-note')}>
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
            <kbd className="kl-kbd">T</kbd>/<kbd className="kl-kbd">M</kbd>/<kbd className="kl-kbd">K</kbd>{' '}
            jump · <kbd className="kl-kbd">Esc</kbd> close
          </span>
          <span>{readings ? `${totalSourcePages} source pages searchable` : 'Archive ready'}</span>
        </div>
      </div>
    </dialog>
  );
};
