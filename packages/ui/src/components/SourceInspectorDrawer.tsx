import { buildLibrarianCitation, findSourceUsages, formatSourceTypeLabel } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap.js';
import { cx, joinClasses } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import citationStyles from '../styles/Citations.module.css';
import controlStyles from '../styles/Controls.module.css';
import overlayStyles from '../styles/Overlays.module.css';
import { ArchivalImage, DateStamp, resolveAssetUrl } from './Atoms.js';
import inspectorStyles from './SourceInspectorDrawer.module.css';

export const SourceInspectorDrawer: React.FC = () => {
  const { bundle, sourcesById, eventsById, readableSourceIds, baseUrl } = useArchiveData();
  const { sourceInspector, closeSourceInspector, openSourceReader } = useArchiveUi();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const copyTimerRef = useRef<number | null>(null);
  const mountedRef = useRef<boolean>(true);
  const [copied, setCopied] = useState(false);
  const [scanExpanded, setScanExpanded] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current !== null && typeof window !== 'undefined') {
        window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  const activeSourceId = sourceInspector?.sourceId ?? '';
  const sourceRecord = activeSourceId ? sourcesById.get(activeSourceId) : undefined;
  const activeEvent = sourceInspector?.eventId ? eventsById.get(sourceInspector.eventId) : undefined;

  const citation = useMemo(
    () =>
      buildLibrarianCitation(sourceRecord, {
        source_id: activeSourceId,
        confidence: sourceInspector?.confidence,
        citation_detail: sourceInspector?.citationDetail,
        claimed_date: sourceInspector?.claimedDate,
        scan_url: sourceInspector?.scanUrl,
        scan_title: sourceInspector?.scanTitle,
      }),
    [sourceRecord, activeSourceId, sourceInspector]
  );

  const { usages, linkedMedia } = useMemo(
    () => findSourceUsages(activeSourceId, bundle),
    [activeSourceId, bundle]
  );

  const dialogRef = useDialogFocusTrap({
    open: Boolean(sourceInspector),
    onClose: closeSourceInspector,
    initialFocusRef: closeBtnRef,
  });

  useEffect(() => {
    if (!sourceInspector) {
      return;
    }
    setCopied(false);
    setScanExpanded(false);
  }, [sourceInspector]);

  if (!sourceInspector) {
    return null;
  }

  const isReadable = readableSourceIds.has(activeSourceId);
  const previewScanUrl = sourceInspector.scanUrl || linkedMedia[0]?.file || null;
  const previewScanCaption = sourceInspector.scanTitle || linkedMedia[0]?.caption || citation.title;

  const handleCopy = (): void => {
    if (!navigator.clipboard) {
      return;
    }
    navigator.clipboard
      .writeText(citation.bibliographicString)
      .then(() => {
        if (!mountedRef.current) {
          return;
        }
        setCopied(true);
        if (typeof window === 'undefined') {
          return;
        }
        if (copyTimerRef.current !== null) {
          window.clearTimeout(copyTimerRef.current);
        }
        copyTimerRef.current = window.setTimeout(() => {
          copyTimerRef.current = null;
          if (mountedRef.current) {
            setCopied(false);
          }
        }, 2000);
      })
      .catch(() => {
        if (mountedRef.current) {
          setCopied(false);
        }
      });
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className={joinClasses(
        cx(overlayStyles, 'drawer-backdrop'),
        cx(inspectorStyles, 'source-inspector-backdrop')
      )}
      aria-label={KINLOOM_VOCABULARY.sources.inspectorAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(overlayStyles, 'lightbox-backdrop-close')}
        aria-label="Close source inspector"
        onClick={closeSourceInspector}
      />
      <div
        className={joinClasses(
          cx(overlayStyles, 'drawer-panel'),
          cx(inspectorStyles, 'source-inspector-panel')
        )}
      >
        <div className={cx(overlayStyles, 'drawer-top')}>
          <div>
            <h2 className={cx(inspectorStyles, 'source-inspector-title')}>{citation.title}</h2>
            <div className={cx(inspectorStyles, 'source-inspector-badges')}>
              <span className={cx(citationStyles, `evidence-tier-badge tier-${citation.tier}`)}>
                {citation.tierLabel}
              </span>
              {sourceInspector.confidence && citation.tier !== 'unverified' && (
                <span className={cx(citationStyles, 'evidence-basis-tag')}>{citation.evidenceBasis}</span>
              )}
            </div>
          </div>
          <button ref={closeBtnRef} type="button" className={'drawer-close'} onClick={closeSourceInspector}>
            Close
          </button>
        </div>

        <p className={cx(inspectorStyles, 'source-inspector-tier-note')}>{citation.tierDescription}</p>

        {activeEvent && (
          <section className={cx(inspectorStyles, 'inspector-block')}>
            <h3 className={cx(inspectorStyles, 'inspector-section-heading')}>Cited Claim</h3>
            <div className={cx(inspectorStyles, 'inspector-claim-title')}>
              <DateStamp displayDate={activeEvent.display_date} edtf={activeEvent.edtf_date} />{' '}
              <span>{activeEvent.title}</span>
            </div>
            {citation.recordDetail ? (
              <p className={cx(inspectorStyles, 'inspector-record-detail')}>{citation.recordDetail}</p>
            ) : (
              <p className={cx(inspectorStyles, 'inspector-missing-detail')}>
                Collection-level citation only. No specific page, sheet, roll, or folio detail is recorded for
                this event.
              </p>
            )}
          </section>
        )}

        <section className={cx(inspectorStyles, 'inspector-block')}>
          <h3 className={cx(inspectorStyles, 'inspector-section-heading')}>Bibliographic Record</h3>
          <dl className={cx(inspectorStyles, 'inspector-bib-list')}>
            {citation.author && (
              <>
                <dt>Author / Creator</dt>
                <dd>{citation.author}</dd>
              </>
            )}
            <dt>Source Title</dt>
            <dd>{citation.title}</dd>
            {citation.recordDetail && !activeEvent && (
              <>
                <dt>Specific Record</dt>
                <dd>{citation.recordDetail}</dd>
              </>
            )}
            {citation.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>{citation.publisher}</dd>
              </>
            )}
            {citation.repository && (
              <>
                <dt>Repository</dt>
                <dd>{citation.repository}</dd>
              </>
            )}
            <dt>Classification</dt>
            <dd>
              {citation.tierLabel} ({formatSourceTypeLabel(sourceRecord?.source_type)})
            </dd>
            {citation.url && (
              <>
                <dt>External Archive</dt>
                <dd>
                  <a
                    href={citation.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cx(inspectorStyles, 'inspector-ext-link')}
                  >
                    {citation.urlHost || citation.url} ↗
                  </a>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className={cx(inspectorStyles, 'inspector-block')}>
          <div className={cx(inspectorStyles, 'inspector-block-header')}>
            <h3 className={cx(inspectorStyles, 'inspector-section-heading')}>Formatted Reference</h3>
            <button type="button" className={cx(citationStyles, 'source-action-btn')} onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy Citation'}
            </button>
          </div>
          <p className={cx(inspectorStyles, 'inspector-formatted-citation')}>
            {citation.bibliographicString}
          </p>
        </section>

        <div className={cx(inspectorStyles, 'inspector-actions-row')}>
          {isReadable && (
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn active')}
              onClick={() => {
                openSourceReader({
                  sourceId: activeSourceId,
                  eventId: sourceInspector.eventId,
                });
              }}
            >
              {KINLOOM_VOCABULARY.sources.openReaderCta}
            </button>
          )}
          {previewScanUrl && (
            <button
              type="button"
              className={cx(controlStyles, 'pill-btn')}
              onClick={() => {
                setScanExpanded((v) => !v);
              }}
            >
              {scanExpanded
                ? KINLOOM_VOCABULARY.sources.hideScanCta
                : KINLOOM_VOCABULARY.sources.previewScanCta}
            </button>
          )}
          {citation.url && (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(controlStyles, 'pill-btn')}
              style={{ textDecoration: 'none' }}
            >
              Open External Archive ↗
            </a>
          )}
          <Link
            to={`/evidence?tab=citations&source=${encodeURIComponent(activeSourceId)}`}
            className={cx(controlStyles, 'pill-btn')}
            style={{ textDecoration: 'none' }}
            onClick={closeSourceInspector}
          >
            {KINLOOM_VOCABULARY.sources.viewInEvidenceCta}
          </Link>
        </div>

        {scanExpanded && previewScanUrl && (
          <figure className={cx(inspectorStyles, 'inspector-scan-figure')}>
            <ArchivalImage
              src={resolveAssetUrl(previewScanUrl, baseUrl)}
              alt={previewScanCaption}
              loading="eager"
              frameStyle={{ width: '100%' }}
              className={cx(inspectorStyles, 'inspector-scan-img')}
              fallbackCaption={previewScanCaption}
            />
            <figcaption className={cx(inspectorStyles, 'inspector-scan-caption')}>
              {previewScanCaption}
            </figcaption>
          </figure>
        )}

        <section className={cx(inspectorStyles, 'inspector-block')}>
          <h3 className={cx(inspectorStyles, 'inspector-section-heading')}>
            Cited Across This Archive ({usages.length} {usages.length === 1 ? 'event' : 'events'})
          </h3>
          {usages.length === 0 ? (
            <p className={cx(inspectorStyles, 'inspector-missing-detail')}>
              No public events currently cite this source record.
            </p>
          ) : (
            <ul className={cx(inspectorStyles, 'inspector-usage-list')}>
              {usages.map(({ event, ref, primaryPersonSlug, primaryPersonName }) => {
                const isCurrent = event.id === sourceInspector.eventId;
                return (
                  <li
                    key={`${event.id}|${ref.citation_detail ?? ''}`}
                    className={cx(inspectorStyles, `inspector-usage-item ${isCurrent ? 'current' : ''}`)}
                  >
                    <div className={cx(inspectorStyles, 'inspector-usage-top')}>
                      <DateStamp displayDate={event.display_date} edtf={event.edtf_date} />
                      {primaryPersonSlug ? (
                        <Link
                          to={`/person/${primaryPersonSlug}?event=${event.id}`}
                          className={cx(inspectorStyles, 'inspector-usage-link')}
                          onClick={closeSourceInspector}
                        >
                          {event.title}
                        </Link>
                      ) : (
                        <span className={cx(inspectorStyles, 'inspector-usage-title')}>{event.title}</span>
                      )}
                    </div>
                    {primaryPersonName && (
                      <div className={cx(inspectorStyles, 'inspector-usage-person')}>{primaryPersonName}</div>
                    )}
                    {ref.citation_detail && (
                      <div className={cx(inspectorStyles, 'inspector-usage-detail')}>
                        {ref.citation_detail}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  );
};
