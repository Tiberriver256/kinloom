import type { ArchiveEvent, CoPresenceItem, Place, SourceRecord } from '@kinloom/core';
import type React from 'react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useOptionalArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { cx } from '../lib/cx.js';
import { buildEventMarginaliaItems } from '../lib/marginaliaModel.js';
import marginaliaStyles from '../styles/FolioMarginalia.module.css';
import { ArchivalPhotoFrame, DateStamp, SourceCitationTag } from './Atoms.js';
import atomStyles from './Atoms.module.css';
import { FolioMarginaliaRail, useMarginaliaPreference } from './FolioMarginalia.js';
import milestoneStyles from './MilestoneStoryCard.module.css';

const EMPTY_ALSO_HERE: CoPresenceItem[] = [];
const EMPTY_READABLE_IDS: ReadonlySet<string> = new Set();

export const MilestoneStoryCard: React.FC<{
  event: ArchiveEvent;
  place: Place | undefined;
  isActive: boolean;
  sourcesById: Map<string, SourceRecord>;
  onSelect: () => void;
  cardRef?: (el: HTMLElement | null) => void;
  alsoHere?: CoPresenceItem[];
  onPivotPerson?: (item: CoPresenceItem) => void;
}> = ({
  event,
  place,
  isActive,
  sourcesById,
  onSelect,
  cardRef,
  alsoHere = EMPTY_ALSO_HERE,
  onPivotPerson,
}) => {
  const [marginaliaEnabled] = useMarginaliaPreference();
  const archiveData = useOptionalArchiveData();
  const { openSourceInspector, openSourceReader } = useArchiveUi();
  const readableSourceIds = archiveData?.readableSourceIds ?? EMPTY_READABLE_IDS;

  const marginaliaItems = useMemo(
    () =>
      buildEventMarginaliaItems({
        sources: event.sources,
        alternateDates: event.alternate_dates,
        alternatePlaces: event.alternate_places,
        factConflicts: event.fact_conflicts,
        sourcesById,
        readableSourceIds,
      }),
    [
      event.sources,
      event.alternate_dates,
      event.alternate_places,
      event.fact_conflicts,
      sourcesById,
      readableSourceIds,
    ]
  );

  const showMarginalia = marginaliaEnabled && marginaliaItems.length > 0;

  const mainContent = (
    <>
      <div className={cx(milestoneStyles, 'story-card-top')}>
        <DateStamp displayDate={event.display_date} edtf={event.edtf_date} />
        {place && (
          <Link
            to={`/place/${place.slug}`}
            className={cx(atomStyles, 'ink-link-btn')}
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            {place.name}
          </Link>
        )}
      </div>

      <h3>{event.title}</h3>
      <p>{event.summary}</p>

      {(event.photo_url || event.photo_placeholder_caption) && (
        <ArchivalPhotoFrame
          caption={event.photo_placeholder_caption || event.title}
          photoUrl={event.photo_url ?? null}
        />
      )}

      <div className={showMarginalia ? cx(marginaliaStyles, 'folio-marginalia-inline-fallback') : undefined}>
        <SourceCitationTag
          sources={event.sources}
          alternateDates={event.alternate_dates}
          alternatePlaces={event.alternate_places}
          factConflicts={event.fact_conflicts}
          sourcesById={sourcesById}
          eventId={event.id}
        />
      </div>

      {isActive && alsoHere.length > 0 && onPivotPerson && (
        <details className={cx(milestoneStyles, 'also-here')}>
          <summary>Also here</summary>
          <ul>
            {alsoHere.map((item) => (
              <li key={item.person.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPivotPerson(item);
                  }}
                >
                  {item.person.full_name}
                  {item.kinshipLabel ? <span>{item.kinshipLabel}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );

  return (
    <article
      // biome-ignore lint/a11y/noNoninteractiveTabindex: selectable story card with keyboard activation
      tabIndex={0}
      id={event.id}
      ref={cardRef}
      data-event-id={event.id}
      className={cx(milestoneStyles, `story-card ${isActive ? 'active' : ''}`)}
      onClick={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest('details, aside')) {
          return;
        }
        onSelect();
      }}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      {showMarginalia ? (
        <div className={cx(marginaliaStyles, 'folio-marginalia-row')}>
          <div className={cx(marginaliaStyles, 'folio-marginalia-main')}>{mainContent}</div>
          <FolioMarginaliaRail
            items={marginaliaItems}
            ariaLabel={`Citations and notes for ${event.title}`}
            onInspectCitation={(item) => {
              openSourceInspector({
                sourceId: item.sourceId,
                eventId: event.id,
                citationDetail: item.callNumberOrDetail ?? undefined,
                claimedDate: item.claimedDate ?? undefined,
                scanUrl: item.scanUrl ?? undefined,
                scanTitle: item.scanTitle ?? undefined,
                confidence: item.confidence,
              });
            }}
            onInspectDiscrepancy={(item) => {
              openSourceInspector({
                sourceId: item.sourceId,
                eventId: event.id,
                citationDetail: item.note,
                claimedDate: item.category === 'date' ? item.claim : undefined,
              });
            }}
            onReadSource={(sourceId) => {
              openSourceReader({ sourceId, eventId: event.id });
            }}
            onOpenScan={(item) => {
              openSourceInspector({
                sourceId: item.sourceId,
                eventId: event.id,
                citationDetail: item.callNumberOrDetail ?? undefined,
                claimedDate: item.claimedDate ?? undefined,
                scanUrl: item.scanUrl ?? undefined,
                scanTitle: item.scanTitle ?? undefined,
                confidence: item.confidence,
              });
            }}
          />
        </div>
      ) : (
        mainContent
      )}
    </article>
  );
};
