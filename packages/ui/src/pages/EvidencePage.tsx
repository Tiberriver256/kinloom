import type { MediaChecklistItem, MediaItem } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import atomStyles from '../components/Atoms.module.css';
import { EvidenceLegend } from '../components/EvidenceLegend.js';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { handleTablistKeyDown, scrollBehaviorForMotion } from '../hooks/keyboardNav.js';
import { cx } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import controlStyles from '../styles/Controls.module.css';
import layoutStyles from '../styles/Layout.module.css';
import evidenceStyles from './EvidencePage.module.css';
import { EvidenceDiscrepanciesTab } from './evidence/EvidenceDiscrepanciesTab.js';
import { EvidenceMediaLightbox, EvidenceMediaTab } from './evidence/EvidenceMediaTab.js';
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
  parseEvidenceFilterParam,
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

  const [tab, setTab] = useState<EvidenceTab>(() =>
    parseInitialEvidenceTab(searchParams.get('tab'), searchParams.get('filter'))
  );
  const [uncitedOnly, setUncitedOnly] = useState<boolean>(
    () => parseEvidenceFilterParam(searchParams.get('filter')) === 'uncited'
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
  const pendingFocusUncitedRef = useRef(false);

  const syncEvidenceUrl = (nextTab: EvidenceTab, nextUncitedOnly: boolean): void => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('tab', nextTab);
    if (nextTab === 'citations' && nextUncitedOnly) {
      nextParams.set('filter', 'uncited');
    } else {
      nextParams.delete('filter');
    }
    setSearchParams(nextParams, { replace: true });
  };

  const selectTab = (nextTab: EvidenceTab): void => {
    const keepUncited = nextTab === 'citations' ? uncitedOnly : false;
    setTab(nextTab);
    if (nextTab !== 'citations' && uncitedOnly) {
      setUncitedOnly(false);
    }
    syncEvidenceUrl(nextTab, keepUncited);
  };

  const activateUncitedFilter = (): void => {
    setTab('citations');
    setUncitedOnly(true);
    setShowAllUnverified(false);
    pendingFocusUncitedRef.current = true;
    syncEvidenceUrl('citations', true);
  };

  const clearUncitedFilter = (): void => {
    setUncitedOnly(false);
    setUncitedQuery('');
    syncEvidenceUrl(tab, false);
  };

  useEffect(() => {
    if (!pendingFocusUncitedRef.current || tab !== 'citations' || !uncitedOnly) {
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
  }, [tab, uncitedOnly]);

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

  return (
    <div>
      <ExplorerTopBar />
      <main id="main-content" className={cx(layoutStyles, 'place-page')}>
        <section className={cx(layoutStyles, 'wire-banner')} style={{ marginBottom: 18 }}>
          <div>
            <h1>{KINLOOM_VOCABULARY.evidence.heading}</h1>
            <p>
              Provenance audit separating primary sources from uncited tree entries, preserving source
              discrepancies, and cataloging portraits, family photos, headstones, record scans, and document
              scans.
            </p>
          </div>
          <div className={cx(atomStyles, 'folio-metrics')}>
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
                  aria-pressed={tab === 'citations' && uncitedOnly}
                  onClick={activateUncitedFilter}
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
          className={cx(controlStyles, 'filter-bar evidence-tabs')}
          role="tablist"
          aria-label={KINLOOM_VOCABULARY.evidence.tablistAria}
          onKeyDown={(event) => {
            handleTablistKeyDown(event, EVIDENCE_TABS, tab, (next) => {
              selectTab(next);
            });
          }}
        >
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'conflicts' ? 0 : -1}
            aria-selected={tab === 'conflicts'}
            className={cx(controlStyles, `pill-btn ${tab === 'conflicts' ? 'active' : ''}`)}
            onClick={() => {
              selectTab('conflicts');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.discrepanciesTab} ({conflictEvents.length})
          </button>
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'citations' ? 0 : -1}
            aria-selected={tab === 'citations'}
            className={cx(controlStyles, `pill-btn ${tab === 'citations' ? 'active' : ''}`)}
            onClick={() => {
              selectTab('citations');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.sourcesTab} ({bundle.sources.length})
          </button>
          <button
            type="button"
            role="tab"
            tabIndex={tab === 'media' ? 0 : -1}
            aria-selected={tab === 'media'}
            className={cx(controlStyles, `pill-btn ${tab === 'media' ? 'active' : ''}`)}
            onClick={() => {
              selectTab('media');
            }}
          >
            {KINLOOM_VOCABULARY.evidence.mediaTab} ({allMedia.length})
          </button>
        </div>

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
            unverifiedEvents={unverifiedEvents}
            showAllUnverified={showAllUnverified}
            uncitedOnly={uncitedOnly}
            uncitedQuery={uncitedQuery}
            uncitedHeadingRef={uncitedHeadingRef}
            peopleById={peopleById}
            onSourceQueryChange={(value) => {
              setSourceQuery(value);
              setSourceLimit(EVIDENCE_BATCH_SIZE);
            }}
            onLoadMoreSources={() => {
              setSourceLimit((n) => n + EVIDENCE_BATCH_SIZE);
            }}
            onUncitedQueryChange={setUncitedQuery}
            onClearUncitedFilter={clearUncitedFilter}
            onToggleShowAllUnverified={() => {
              setShowAllUnverified((v) => !v);
            }}
            onOpenSourceInspector={openSourceInspector}
            onOpenSourceReader={openSourceReader}
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
