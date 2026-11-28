import type { MediaChecklistItem, MediaItem } from '@kinloom/core';
import type React from 'react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import atomStyles from '../components/Atoms.module.css';
import { EvidenceLegend } from '../components/EvidenceLegend.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { handleTablistKeyDown, scrollBehaviorForMotion } from '../hooks/keyboardNav.js';
import { useHorizontalScrollFade } from '../hooks/useHorizontalScrollFade.js';
import { cx, joinClasses } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import evidenceStyles from './EvidencePage.module.css';
import { EvidenceDiscrepanciesTab } from './evidence/EvidenceDiscrepanciesTab.js';
import { EvidenceMediaLightbox, EvidenceMediaTab } from './evidence/EvidenceMediaTab.js';
import { EvidenceNeedsCitationTab } from './evidence/EvidenceNeedsCitationTab.js';
import { EvidenceSourcesTab } from './evidence/EvidenceSourcesTab.js';
import {
  collectConflictEvents,
  collectUnverifiedEvents,
  computeEvidenceCitationMetrics,
  countMediaByKind,
  EVIDENCE_BATCH_SIZE,
  EVIDENCE_TABS,
  type EvidenceTab,
  filterAndSortSources,
  filterMediaItems,
  type MediaKindFilter,
  parseInitialEvidenceTab,
} from './evidence/evidenceViewModel.js';

export const EvidencePage: React.FC = () => {
  const {
    bundle,
    baseUrl,
    peopleById,
    sourcesById,
    readableSourceIds,
    capabilities,
    loadMediaChecklist,
    loading,
  } = useArchiveData();
  const { openSourceReader, openSourceInspector } = useArchiveUi();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabBaseId = useId();

  const [tab, setTab] = useState<EvidenceTab>(() =>
    parseInitialEvidenceTab(searchParams.get('tab'), searchParams.get('filter'))
  );
  const [uncitedQuery, setUncitedQuery] = useState('');
  const [sourceQuery, setSourceQuery] = useState(() => searchParams.get('source') || '');
  const [discrepancyLimit, setDiscrepancyLimit] = useState(EVIDENCE_BATCH_SIZE);
  const [sourceLimit, setSourceLimit] = useState(EVIDENCE_BATCH_SIZE);
  const [showAllUnverified, setShowAllUnverified] = useState(false);
  const [mediaKindFilter, setMediaKindFilter] = useState<MediaKindFilter>('all');
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaLimit, setMediaLimit] = useState(36);
  const [lightboxItem, setLightboxItem] = useState<MediaItem | null>(null);
  const [mediaChecklist, setMediaChecklist] = useState<MediaChecklistItem[]>([]);
  const uncitedHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const evidenceTabsRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusUncitedRef = useRef(false);
  const tabRefs = useRef<Partial<Record<EvidenceTab, HTMLButtonElement | null>>>({});

  const syncEvidenceUrl = (nextTab: EvidenceTab): void => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', nextTab);
    nextParams.delete('filter');
    setSearchParams(nextParams, { replace: true });
  };

  const selectTab = (nextTab: EvidenceTab): void => {
    setTab(nextTab);
    syncEvidenceUrl(nextTab);
  };

  const openNeedsCitationTab = (): void => {
    setTab('uncited');
    setShowAllUnverified(false);
    pendingFocusUncitedRef.current = true;
    syncEvidenceUrl('uncited');
  };

  useHorizontalScrollFade(evidenceTabsRef, bundle ? 'evidence-tabs' : '');

  // biome-ignore lint/correctness/useExhaustiveDependencies: center active mobile tab whenever selected tab changes
  useEffect(() => {
    const activeTab = evidenceTabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (activeTab && typeof activeTab.scrollIntoView === 'function') {
      activeTab.scrollIntoView({
        behavior: scrollBehaviorForMotion(),
        block: 'nearest',
        inline: 'center',
      });
    }
  }, [tab]);

  useEffect(() => {
    const activeTabEl = tabRefs.current[tab];
    if (activeTabEl && typeof activeTabEl.scrollIntoView === 'function') {
      activeTabEl.scrollIntoView({
        behavior: scrollBehaviorForMotion(),
        block: 'nearest',
        inline: 'nearest',
      });
    }
  }, [tab]);

  useEffect(() => {
    if (!pendingFocusUncitedRef.current || tab !== 'uncited') {
      return;
    }
    pendingFocusUncitedRef.current = false;
    const heading = uncitedHeadingRef.current;
    if (heading) {
      heading.focus({ preventScroll: true });
      if (typeof heading.scrollIntoView === 'function') {
        heading.scrollIntoView({ behavior: scrollBehaviorForMotion(), block: 'start' });
      }
    }
  }, [tab]);

  useEffect(() => {
    let cancelled = false;
    void loadMediaChecklist()
      .then((items) => {
        if (!cancelled) {
          setMediaChecklist(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMediaChecklist([]);
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [loadMediaChecklist]);

  const conflictEvents = useMemo(() => collectConflictEvents(bundle), [bundle]);
  const unverifiedEvents = useMemo(() => collectUnverifiedEvents(bundle), [bundle]);
  const { detailedCitationCount, linkedRecordScanCount, sourceUsageCounts } = useMemo(
    () => computeEvidenceCitationMetrics(bundle),
    [bundle]
  );

  const filteredSources = useMemo(
    () => filterAndSortSources(bundle, sourceQuery, sourceUsageCounts),
    [bundle, sourceQuery, sourceUsageCounts]
  );

  const allMedia = useMemo(() => bundle?.media || [], [bundle]);
  const mediaCountsByKind = useMemo(() => countMediaByKind(allMedia), [allMedia]);
  const filteredMedia = useMemo(
    () => filterMediaItems(allMedia, mediaKindFilter, mediaQuery),
    [allMedia, mediaKindFilter, mediaQuery]
  );
  const missingChecklistItems = useMemo(
    () => mediaChecklist.filter((i) => i.status !== 'digitized'),
    [mediaChecklist]
  );
  const navMedia = useMemo(() => filteredMedia.filter((m) => m.kind !== 'document_scan'), [filteredMedia]);

  if (loading || !bundle) {
    return (
      <div>
        <ExplorerTopBar />
        <main id="main-content" className={cx(layoutStyles, 'index-page')}>
          {KINLOOM_VOCABULARY.evidence.loading}
        </main>
      </div>
    );
  }

  const tabpanelId = `${tabBaseId}-panel`;
  const activeTabId = `${tabBaseId}-tab-${tab}`;

  const tabItems: ReadonlyArray<{
    readonly id: EvidenceTab;
    readonly label: string;
    readonly count: number;
  }> = [
    { id: 'conflicts', label: KINLOOM_VOCABULARY.evidence.discrepanciesTab, count: conflictEvents.length },
    { id: 'citations', label: KINLOOM_VOCABULARY.evidence.sourcesTab, count: bundle.sources.length },
    { id: 'uncited', label: KINLOOM_VOCABULARY.evidence.needsCitationTab, count: unverifiedEvents.length },
    { id: 'media', label: KINLOOM_VOCABULARY.evidence.mediaTab, count: allMedia.length },
  ];

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section
          className={joinClasses(cx(layoutStyles, 'wire-banner'), cx(evidenceStyles, 'evidence-banner'))}
        >
          <div>
            <h1>{KINLOOM_VOCABULARY.evidence.heading}</h1>
            <p className={cx(evidenceStyles, 'evidence-banner-lead')}>
              Provenance audit separating primary sources from uncited tree entries, preserving source
              discrepancies, and cataloging portraits, family photos, headstones, record scans, and document
              scans.
            </p>
          </div>
          <div
            className={joinClasses(
              cx(atomStyles, 'folio-metrics'),
              cx(evidenceStyles, 'evidence-banner-metrics')
            )}
          >
            <div>
              <strong>{bundle.sources.length}</strong> cataloged sources
            </div>
            <div>
              <strong>{detailedCitationCount}</strong> page/roll citations ·{' '}
              <strong>{linkedRecordScanCount}</strong> linked record scans
            </div>
            <div style={{ color: 'var(--radar-copresence)' }}>
              <strong>{allMedia.length}</strong> photos &amp; documents ·{' '}
              {unverifiedEvents.length === 0 ? (
                <span>
                  <strong>0</strong> entries needing citation
                </span>
              ) : (
                <button
                  type="button"
                  className={cx(evidenceStyles, 'evidence-gap-cta')}
                  aria-pressed={tab === 'uncited'}
                  onClick={openNeedsCitationTab}
                >
                  <strong>{unverifiedEvents.length}</strong>{' '}
                  {unverifiedEvents.length === 1 ? 'entry' : 'entries'} needing citation →
                </button>
              )}
            </div>
          </div>
        </section>

        <div className={cx(evidenceStyles, 'evidence-legend-bar')}>
          <EvidenceLegend />
        </div>

        <PluginSlot name="evidenceExtra" />

        <div
          ref={evidenceTabsRef}
          className={cx(controlStyles, 'filter-bar evidence-tabs')}
          role="tablist"
          aria-label={KINLOOM_VOCABULARY.evidence.tablistAria}
          onKeyDown={(event) => {
            handleTablistKeyDown(event, EVIDENCE_TABS, tab, (next) => {
              selectTab(next);
            });
          }}
        >
          {tabItems.map((item) => {
            const isSelected = tab === item.id;
            return (
              <button
                key={item.id}
                id={`${tabBaseId}-tab-${item.id}`}
                ref={(node) => {
                  tabRefs.current[item.id] = node;
                }}
                type="button"
                role="tab"
                tabIndex={isSelected ? 0 : -1}
                aria-selected={isSelected}
                className={cx(controlStyles, `pill-btn ${isSelected ? 'active' : ''}`)}
                onClick={() => {
                  selectTab(item.id);
                }}
              >
                {item.label} ({item.count})
              </button>
            );
          })}
        </div>

        <div id={tabpanelId} role="tabpanel" aria-labelledby={activeTabId}>
          {tab === 'conflicts' && (
            <EvidenceDiscrepanciesTab
              conflictEvents={conflictEvents}
              peopleById={peopleById}
              sourcesById={sourcesById}
              readableSourceIds={readableSourceIds}
              discrepancyLimit={discrepancyLimit}
              onLoadMoreDiscrepancies={() => {
                setDiscrepancyLimit((n) => n + EVIDENCE_BATCH_SIZE);
              }}
              onOpenSourceReader={openSourceReader}
            />
          )}

          {tab === 'citations' && (
            <EvidenceSourcesTab
              totalSourceCount={bundle.sources.length}
              canEdit={capabilities.canEdit}
              filteredSources={filteredSources}
              sourceLimit={sourceLimit}
              sourceQuery={sourceQuery}
              sourceUsageCounts={sourceUsageCounts}
              readableSourceIds={readableSourceIds}
              onSourceQueryChange={(value) => {
                setSourceQuery(value);
                setSourceLimit(EVIDENCE_BATCH_SIZE);
              }}
              onLoadMoreSources={() => {
                setSourceLimit((n) => n + EVIDENCE_BATCH_SIZE);
              }}
              onOpenSourceInspector={openSourceInspector}
              onOpenSourceReader={openSourceReader}
            />
          )}

          {tab === 'uncited' && (
            <EvidenceNeedsCitationTab
              totalSourceCount={bundle.sources.length}
              unverifiedEvents={unverifiedEvents}
              showAllUnverified={showAllUnverified}
              uncitedQuery={uncitedQuery}
              uncitedHeadingRef={uncitedHeadingRef}
              peopleById={peopleById}
              onUncitedQueryChange={setUncitedQuery}
              onToggleShowAllUnverified={() => {
                setShowAllUnverified((v) => !v);
              }}
              onOpenSourceRegistry={() => {
                setUncitedQuery('');
                selectTab('citations');
              }}
            />
          )}

          {tab === 'media' && (
            <EvidenceMediaTab
              allMedia={allMedia}
              canEdit={capabilities.canEdit}
              filteredMedia={filteredMedia}
              mediaLimit={mediaLimit}
              mediaKindFilter={mediaKindFilter}
              mediaQuery={mediaQuery}
              mediaCountsByKind={mediaCountsByKind}
              mediaChecklist={mediaChecklist}
              missingChecklistItems={missingChecklistItems}
              baseUrl={baseUrl}
              onMediaQueryChange={(value) => {
                setMediaQuery(value);
                setMediaLimit(36);
              }}
              onMediaKindFilterChange={(kind) => {
                setMediaKindFilter(kind);
                setMediaLimit(36);
              }}
              onClearMediaFilters={() => {
                setMediaKindFilter('all');
                setMediaQuery('');
              }}
              onLoadMoreMedia={() => {
                setMediaLimit((n) => n + 36);
              }}
              onOpenMediaItem={(m) => {
                if (m.kind === 'document_scan' && m.source_id && m.page) {
                  openSourceReader({ sourceId: m.source_id, page: m.page });
                } else {
                  setLightboxItem(m);
                }
              }}
            />
          )}
        </div>

        <EvidenceMediaLightbox
          lightboxItem={lightboxItem}
          navMedia={navMedia}
          baseUrl={baseUrl}
          onSetLightboxItem={setLightboxItem}
        />
      </main>
      <KinloomFooter />
    </div>
  );
};
