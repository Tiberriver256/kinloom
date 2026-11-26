import { DateStamp, resolveAssetUrl } from './Atoms.js';
import {
  buildLibrarianCitation,
  findSourceUsages,
  formatSourceTypeLabel,
} from '@kinloom/core';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';

export const SourceInspectorDrawer: React.FC = () => {
  const { bundle, sourcesById, eventsById, readableSourceIds, baseUrl } = useArchiveData();
  const { sourceInspector, closeSourceInspector, openSourceReader } = useArchiveUi();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [copied, setCopied] = useState(false);
  const [scanExpanded, setScanExpanded] = useState(false);

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
    [sourceRecord, activeSourceId, sourceInspector],
  );

  const { usages, linkedMedia } = useMemo(
    () => findSourceUsages(activeSourceId, bundle),
    [activeSourceId, bundle],
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
  const previewScanCaption =
    sourceInspector.scanTitle || linkedMedia[0]?.caption || citation.title;

  const handleCopy = (): void => {
    if (!navigator.clipboard) {
      return;
    }
    navigator.clipboard
      .writeText(citation.bibliographicString)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        setCopied(false);
      });
  };

  return (
    <dialog
      ref={dialogRef}
      open
      aria-modal="true"
      className="drawer-backdrop source-inspector-backdrop"
      aria-label={KINLOOM_VOCABULARY.sources.inspectorAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className="lightbox-backdrop-close"
        aria-label="Close source inspector"
        onClick={closeSourceInspector}
      />
      <div className="drawer-panel source-inspector-panel">
        <div className="drawer-top">
          <div>
            <h2 className="source-inspector-title">{citation.title}</h2>
            <div className="source-inspector-badges">
              <span className={`evidence-tier-badge tier-${citation.tier}`}>
                {citation.tierLabel}
              </span>
              {sourceInspector.confidence && citation.tier !== 'unverified' && (
                <span className="evidence-basis-tag">{citation.evidenceBasis}</span>
              )}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className="drawer-close"
            onClick={closeSourceInspector}
          >
            Close
          </button>
        </div>

        <p className="source-inspector-tier-note">{citation.tierDescription}</p>

        {activeEvent && (
          <section className="inspector-block">
            <h3 className="inspector-section-heading">Cited Claim</h3>
            <div className="inspector-claim-title">
              <DateStamp displayDate={activeEvent.display_date} edtf={activeEvent.edtf_date} />{' '}
              <span>{activeEvent.title}</span>
            </div>
            {citation.recordDetail ? (
              <p className="inspector-record-detail">{citation.recordDetail}</p>
            ) : (
              <p className="inspector-missing-detail">
                Collection-level citation only. No specific page, sheet, roll, or folio detail is recorded for this event.
              </p>
            )}
          </section>
        )}

        <section className="inspector-block">
          <h3 className="inspector-section-heading">Bibliographic Record</h3>
          <dl className="inspector-bib-list">
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
                    className="inspector-ext-link"
                  >
                    {citation.urlHost || citation.url} ↗
                  </a>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className="inspector-block">
          <div className="inspector-block-header">
            <h3 className="inspector-section-heading">Formatted Reference</h3>
            <button type="button" className="source-action-btn" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy Citation'}
            </button>
          </div>
          <p className="inspector-formatted-citation">{citation.bibliographicString}</p>
        </section>

        <div className="inspector-actions-row">
          {isReadable && (
            <button
              type="button"
              className="pill-btn active"
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
              className="pill-btn"
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
              className="pill-btn"
              style={{ textDecoration: 'none' }}
            >
              Open External Archive ↗
            </a>
          )}
          <Link
            to={`/evidence?tab=citations&source=${encodeURIComponent(activeSourceId)}`}
            className="pill-btn"
            style={{ textDecoration: 'none' }}
            onClick={closeSourceInspector}
          >
            {KINLOOM_VOCABULARY.sources.viewInEvidenceCta}
          </Link>
        </div>

        {scanExpanded && previewScanUrl && (
          <figure className="inspector-scan-figure">
            <img
              src={resolveAssetUrl(previewScanUrl, baseUrl)}
              alt={previewScanCaption}
              className="inspector-scan-img"
            />
            <figcaption className="inspector-scan-caption">{previewScanCaption}</figcaption>
          </figure>
        )}

        <section className="inspector-block">
          <h3 className="inspector-section-heading">
            Cited Across This Archive ({usages.length}{' '}
            {usages.length === 1 ? 'event' : 'events'})
          </h3>
          {usages.length === 0 ? (
            <p className="inspector-missing-detail">
              No public events currently cite this source record.
            </p>
          ) : (
            <ul className="inspector-usage-list">
              {usages.map(({ event, ref, primaryPersonSlug, primaryPersonName }) => {
                const isCurrent = event.id === sourceInspector.eventId;
                return (
                  <li
                    key={`${event.id}|${ref.citation_detail ?? ''}`}
                    className={`inspector-usage-item ${isCurrent ? 'current' : ''}`}
                  >
                    <div className="inspector-usage-top">
                      <DateStamp displayDate={event.display_date} edtf={event.edtf_date} />
                      {primaryPersonSlug ? (
                        <Link
                          to={`/person/${primaryPersonSlug}?event=${event.id}`}
                          className="inspector-usage-link"
                          onClick={closeSourceInspector}
                        >
                          {event.title}
                        </Link>
                      ) : (
                        <span className="inspector-usage-title">{event.title}</span>
                      )}
                    </div>
                    {primaryPersonName && (
                      <div className="inspector-usage-person">{primaryPersonName}</div>
                    )}
                    {ref.citation_detail && (
                      <div className="inspector-usage-detail">{ref.citation_detail}</div>
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
