import { buildLibrarianCitation, findSourceUsages, formatSourceTypeLabel } from '@kinloom/core';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { cx } from '../lib/cx.js';
import { useDialogFocusTrap } from '../lib/useDialogFocusTrap.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import cssMod3 from '../pages/IndexPage.module.css';
import { DateStamp, resolveAssetUrl } from './Atoms.js';
import cssMod0 from './SourceInspectorDrawer.module.css';
import cssMod1 from './SourceReaderDrawer.module.css';
import cssMod2 from './wiki/WikiSurfaces.module.css';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1, ...cssMod2, ...cssMod3 };

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
      className={cx(uiStyles, 'drawer-backdrop source-inspector-backdrop')}
      aria-label={KINLOOM_VOCABULARY.sources.inspectorAria}
    >
      <button
        type="button"
        tabIndex={-1}
        className={cx(uiStyles, 'lightbox-backdrop-close')}
        aria-label="Close source inspector"
        onClick={closeSourceInspector}
      />
      <div className={cx(uiStyles, 'drawer-panel source-inspector-panel')}>
        <div className={cx(uiStyles, 'drawer-top')}>
          <div>
            <h2 className={cx(uiStyles, 'source-inspector-title')}>{citation.title}</h2>
            <div className={cx(uiStyles, 'source-inspector-badges')}>
              <span className={cx(uiStyles, `evidence-tier-badge tier-${citation.tier}`)}>
                {citation.tierLabel}
              </span>
              {sourceInspector.confidence && citation.tier !== 'unverified' && (
                <span className={cx(uiStyles, 'evidence-basis-tag')}>{citation.evidenceBasis}</span>
              )}
            </div>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            className={cx(uiStyles, 'drawer-close')}
            onClick={closeSourceInspector}
          >
            Close
          </button>
        </div>

        <p className={cx(uiStyles, 'source-inspector-tier-note')}>{citation.tierDescription}</p>

        {activeEvent && (
          <section className={cx(uiStyles, 'inspector-block')}>
            <h3 className={cx(uiStyles, 'inspector-section-heading')}>Cited Claim</h3>
            <div className={cx(uiStyles, 'inspector-claim-title')}>
              <DateStamp displayDate={activeEvent.display_date} edtf={activeEvent.edtf_date} />{' '}
              <span>{activeEvent.title}</span>
            </div>
            {citation.recordDetail ? (
              <p className={cx(uiStyles, 'inspector-record-detail')}>{citation.recordDetail}</p>
            ) : (
              <p className={cx(uiStyles, 'inspector-missing-detail')}>
                Collection-level citation only. No specific page, sheet, roll, or folio detail is recorded for
                this event.
              </p>
            )}
          </section>
        )}

        <section className={cx(uiStyles, 'inspector-block')}>
          <h3 className={cx(uiStyles, 'inspector-section-heading')}>Bibliographic Record</h3>
          <dl className={cx(uiStyles, 'inspector-bib-list')}>
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
                    className={cx(uiStyles, 'inspector-ext-link')}
                  >
                    {citation.urlHost || citation.url} ↗
                  </a>
                </dd>
              </>
            )}
          </dl>
        </section>

        <section className={cx(uiStyles, 'inspector-block')}>
          <div className={cx(uiStyles, 'inspector-block-header')}>
            <h3 className={cx(uiStyles, 'inspector-section-heading')}>Formatted Reference</h3>
            <button type="button" className={cx(uiStyles, 'source-action-btn')} onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy Citation'}
            </button>
          </div>
          <p className={cx(uiStyles, 'inspector-formatted-citation')}>{citation.bibliographicString}</p>
        </section>

        <div className={cx(uiStyles, 'inspector-actions-row')}>
          {isReadable && (
            <button
              type="button"
              className={cx(uiStyles, 'pill-btn active')}
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
              className={cx(uiStyles, 'pill-btn')}
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
              className={cx(uiStyles, 'pill-btn')}
              style={{ textDecoration: 'none' }}
            >
              Open External Archive ↗
            </a>
          )}
          <Link
            to={`/evidence?tab=citations&source=${encodeURIComponent(activeSourceId)}`}
            className={cx(uiStyles, 'pill-btn')}
            style={{ textDecoration: 'none' }}
            onClick={closeSourceInspector}
          >
            {KINLOOM_VOCABULARY.sources.viewInEvidenceCta}
          </Link>
        </div>

        {scanExpanded && previewScanUrl && (
          <figure className={cx(uiStyles, 'inspector-scan-figure')}>
            <img
              src={resolveAssetUrl(previewScanUrl, baseUrl)}
              alt={previewScanCaption}
              className={cx(uiStyles, 'inspector-scan-img')}
            />
            <figcaption className={cx(uiStyles, 'inspector-scan-caption')}>{previewScanCaption}</figcaption>
          </figure>
        )}

        <section className={cx(uiStyles, 'inspector-block')}>
          <h3 className={cx(uiStyles, 'inspector-section-heading')}>
            Cited Across This Archive ({usages.length} {usages.length === 1 ? 'event' : 'events'})
          </h3>
          {usages.length === 0 ? (
            <p className={cx(uiStyles, 'inspector-missing-detail')}>
              No public events currently cite this source record.
            </p>
          ) : (
            <ul className={cx(uiStyles, 'inspector-usage-list')}>
              {usages.map(({ event, ref, primaryPersonSlug, primaryPersonName }) => {
                const isCurrent = event.id === sourceInspector.eventId;
                return (
                  <li
                    key={`${event.id}|${ref.citation_detail ?? ''}`}
                    className={cx(uiStyles, `inspector-usage-item ${isCurrent ? 'current' : ''}`)}
                  >
                    <div className={cx(uiStyles, 'inspector-usage-top')}>
                      <DateStamp displayDate={event.display_date} edtf={event.edtf_date} />
                      {primaryPersonSlug ? (
                        <Link
                          to={`/person/${primaryPersonSlug}?event=${event.id}`}
                          className={cx(uiStyles, 'inspector-usage-link')}
                          onClick={closeSourceInspector}
                        >
                          {event.title}
                        </Link>
                      ) : (
                        <span className={cx(uiStyles, 'inspector-usage-title')}>{event.title}</span>
                      )}
                    </div>
                    {primaryPersonName && (
                      <div className={cx(uiStyles, 'inspector-usage-person')}>{primaryPersonName}</div>
                    )}
                    {ref.citation_detail && (
                      <div className={cx(uiStyles, 'inspector-usage-detail')}>{ref.citation_detail}</div>
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
