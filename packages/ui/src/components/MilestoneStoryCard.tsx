import { ArchivalPhotoFrame, DateStamp, SourceCitationTag } from './Atoms.js';
import type { ArchiveEvent, CoPresenceItem, Place, SourceRecord } from '@kinloom/core';
import { Link } from 'react-router-dom';
import React from 'react';

const EMPTY_ALSO_HERE: CoPresenceItem[] = [];

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
}) => (
  // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- selectable story card containing links and buttons, so it cannot be a native button; keyboard activation is provided via onKeyDown and tabIndex
  <article
    tabIndex={0}
    id={event.id}
    ref={cardRef}
    data-event-id={event.id}
    className={`story-card ${isActive ? 'active' : ''}`}
    onClick={(e) => {
      if (e.target instanceof HTMLElement && e.target.closest('details')) {
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
    <div className="story-card-top">
      <DateStamp displayDate={event.display_date} edtf={event.edtf_date} />
      {place && (
        <Link
          to={`/place/${place.slug}`}
          className="ink-link-btn"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          {place.name}
        </Link>
      )}
    </div>

    <h2>{event.title}</h2>
    <p>{event.summary}</p>

    {(event.photo_url || event.photo_placeholder_caption) && (
      <ArchivalPhotoFrame
        caption={event.photo_placeholder_caption || event.title}
        photoUrl={event.photo_url ?? undefined}
      />
    )}

    <SourceCitationTag
      sources={event.sources}
      alternateDates={event.alternate_dates}
      alternatePlaces={event.alternate_places}
      factConflicts={event.fact_conflicts}
      sourcesById={sourcesById}
      eventId={event.id}
    />

    {isActive && alsoHere.length > 0 && onPivotPerson && (
      <details className="also-here">
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
  </article>
);
