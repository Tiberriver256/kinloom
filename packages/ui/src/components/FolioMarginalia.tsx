import type React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import { cx } from '../lib/cx.js';
import type { FolioMarginaliaCitation, FolioMarginaliaItem } from '../lib/marginaliaModel.js';
import marginaliaStyles from '../styles/FolioMarginalia.module.css';

export const MARGINALIA_STORAGE_KEY = 'kinloom-folio-marginalia';

const listeners = new Set<() => void>();
let storageListenerBound = false;

function readStoredMarginaliaPreference(): boolean {
  if (typeof window === 'undefined') {
    return true;
  }
  try {
    const raw = window.localStorage.getItem(MARGINALIA_STORAGE_KEY);
    if (raw === null) {
      return true;
    }
    return raw !== 'false' && raw !== '0';
  } catch {
    return true;
  }
}

function notifyMarginaliaListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function bindStorageListener(): void {
  if (storageListenerBound || typeof window === 'undefined') {
    return;
  }
  storageListenerBound = true;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === MARGINALIA_STORAGE_KEY) {
      notifyMarginaliaListeners();
    }
  });
}

function subscribeMarginalia(listener: () => void): () => void {
  bindStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setMarginaliaPreference(enabled: boolean): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(MARGINALIA_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // Ignore storage quota or private-mode restrictions.
    }
  }
  notifyMarginaliaListeners();
}

export function useMarginaliaPreference(): readonly [boolean, () => void, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeMarginalia, readStoredMarginaliaPreference, () => true);

  const toggle = useCallback(() => {
    setMarginaliaPreference(!readStoredMarginaliaPreference());
  }, []);

  return [enabled, toggle, setMarginaliaPreference] as const;
}

export interface FolioMarginaliaToggleProps {
  readonly className?: string;
}

export const FolioMarginaliaToggle: React.FC<FolioMarginaliaToggleProps> = ({ className }) => {
  const [enabled, toggle] = useMarginaliaPreference();

  return (
    <button
      type="button"
      className={cx(
        marginaliaStyles,
        className ? `marginalia-toggle-btn print-hide ${className}` : 'marginalia-toggle-btn print-hide'
      )}
      aria-pressed={enabled}
      onClick={toggle}
    >
      Marginalia: {enabled ? 'On' : 'Off'}
    </button>
  );
};

function formatDiscrepancyCategory(category: 'date' | 'place' | 'fact'): string {
  switch (category) {
    case 'date':
      return 'Date Discrepancy';
    case 'place':
      return 'Place Discrepancy';
    case 'fact':
      return 'Fact Discrepancy';
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

export interface FolioMarginaliaRailProps {
  readonly items: readonly FolioMarginaliaItem[];
  readonly ariaLabel?: string;
  readonly highlightedSourceId?: string | null;
  readonly onHoverSourceId?: (sourceId: string | null) => void;
  readonly onInspectCitation?: (item: FolioMarginaliaCitation) => void;
  readonly onInspectDiscrepancy?: (item: Extract<FolioMarginaliaItem, { kind: 'discrepancy' }>) => void;
  readonly onReadSource?: (sourceId: string) => void;
  readonly onOpenScan?: (item: FolioMarginaliaCitation) => void;
}

export const FolioMarginaliaRail: React.FC<FolioMarginaliaRailProps> = ({
  items,
  ariaLabel = 'Marginalia citations and notes',
  highlightedSourceId = null,
  onHoverSourceId,
  onInspectCitation,
  onInspectDiscrepancy,
  onReadSource,
  onOpenScan,
}) => {
  if (items.length === 0) {
    return null;
  }

  return (
    <aside className={cx(marginaliaStyles, 'folio-marginalia-rail')} aria-label={ariaLabel}>
      {items.map((item) => {
        switch (item.kind) {
          case 'citation': {
            const isHighlighted = highlightedSourceId !== null && highlightedSourceId === item.sourceId;
            return (
              <div
                key={item.key}
                role="note"
                data-marginalia-source-id={item.sourceId}
                className={cx(
                  marginaliaStyles,
                  `folio-marginalia-item${isHighlighted ? ' is-highlighted' : ''}`
                )}
                onMouseEnter={() => {
                  onHoverSourceId?.(item.sourceId);
                }}
                onMouseLeave={() => {
                  onHoverSourceId?.(null);
                }}
              >
                <div className={cx(marginaliaStyles, 'folio-marginalia-head')}>
                  <span className={cx(marginaliaStyles, 'folio-marginalia-num')}>
                    {item.footnoteNumber !== null ? `[${item.footnoteNumber}]` : '•'}
                  </span>
                  <span className={cx(marginaliaStyles, 'folio-marginalia-tier')}>{item.tierLabel}</span>
                </div>
                <div className={cx(marginaliaStyles, 'folio-marginalia-title')}>{item.title}</div>
                {item.callNumberOrDetail && (
                  <div className={cx(marginaliaStyles, 'folio-marginalia-detail')}>
                    {item.callNumberOrDetail}
                  </div>
                )}
                {item.repository && (
                  <div className={cx(marginaliaStyles, 'folio-marginalia-detail')}>{item.repository}</div>
                )}
                {(onInspectCitation || (item.isReadable && onReadSource) || (item.scanUrl && onOpenScan)) && (
                  <div className={cx(marginaliaStyles, 'folio-marginalia-actions print-hide')}>
                    {onInspectCitation && (
                      <button
                        type="button"
                        className={cx(marginaliaStyles, 'folio-marginalia-action-btn')}
                        onFocus={() => {
                          onHoverSourceId?.(item.sourceId);
                        }}
                        onBlur={() => {
                          onHoverSourceId?.(null);
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          onInspectCitation(item);
                        }}
                      >
                        Inspect
                      </button>
                    )}
                    {item.isReadable && onReadSource && (
                      <button
                        type="button"
                        className={cx(marginaliaStyles, 'folio-marginalia-action-btn')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onReadSource(item.sourceId);
                        }}
                      >
                        Read Source →
                      </button>
                    )}
                    {item.scanUrl && onOpenScan && (
                      <button
                        type="button"
                        className={cx(marginaliaStyles, 'folio-marginalia-action-btn')}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenScan(item);
                        }}
                      >
                        Scan
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          }
          case 'discrepancy': {
            const isHighlighted = highlightedSourceId !== null && highlightedSourceId === item.sourceId;
            return (
              <div
                key={item.key}
                data-marginalia-discrepancy-index={item.indexNumber}
                className={cx(
                  marginaliaStyles,
                  `folio-marginalia-item is-discrepancy${isHighlighted ? ' is-highlighted' : ''}`
                )}
              >
                <div className={cx(marginaliaStyles, 'folio-marginalia-head')}>
                  <span className={cx(marginaliaStyles, 'folio-marginalia-num')}>! {item.indexNumber}</span>
                  <span className={cx(marginaliaStyles, 'folio-marginalia-tier')}>
                    {formatDiscrepancyCategory(item.category)}
                  </span>
                </div>
                <div className={cx(marginaliaStyles, 'folio-marginalia-claim')}>{item.claim}</div>
                {item.note && (
                  <div className={cx(marginaliaStyles, 'folio-marginalia-note')}>{item.note}</div>
                )}
                {item.sourceLabel && onInspectDiscrepancy && (
                  <div className={cx(marginaliaStyles, 'folio-marginalia-actions print-hide')}>
                    <button
                      type="button"
                      className={cx(marginaliaStyles, 'folio-marginalia-action-btn')}
                      onClick={(e) => {
                        e.stopPropagation();
                        onInspectDiscrepancy(item);
                      }}
                    >
                      Inspect Source
                    </button>
                  </div>
                )}
              </div>
            );
          }
          default: {
            const _exhaustive: never = item;
            return _exhaustive;
          }
        }
      })}
    </aside>
  );
};
