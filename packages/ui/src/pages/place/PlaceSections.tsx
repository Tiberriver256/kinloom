import type { ArchiveEvent, MediaItem, Place, SourceRecord } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { DateStamp, SourceCitationTag } from '../../components/Atoms.js';
import { MediaPlayer } from '../../components/MediaPlayer.js';
import milestoneStyles from '../../components/MilestoneStoryCard.module.css';
import { cx } from '../../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../../lib/vocabulary.js';
import controlStyles from '../../styles/Controls.module.css';
import layoutStyles from '../../styles/Layout.module.css';
import placeStyles from '../PlacePage.module.css';
import type { PlaceOccupancySummary } from './placeViewModel.js';

export const PlaceHistoricalProfileSection: React.FC<{
  readonly place: Place;
  readonly placePhotoSrc: string;
  readonly placePhotoMedia: MediaItem | null;
  readonly sourcesById: Map<string, SourceRecord>;
  readonly baseUrl: string;
}> = ({ place, placePhotoSrc, placePhotoMedia, sourcesById, baseUrl }) => {
  if (!place.summary && !placePhotoSrc && (!place.historical_names || place.historical_names.length === 0)) {
    return null;
  }

  return (
    <section className={cx(layoutStyles, 'place-map-box place-history-section')}>
      <h2 style={{ fontFamily: 'var(--font-serif)', margin: '0 0 12px' }}>Historical Profile</h2>
      <div className={cx(placeStyles, placePhotoSrc ? 'place-history-grid' : undefined)}>
        <div className={'place-history-copy'}>
          {place.summary && <p className={cx(placeStyles, 'place-history-summary')}>{place.summary}</p>}
          {place.historical_names && place.historical_names.length > 0 && (
            <div
              className={cx(placeStyles, 'place-historical-names')}
              role="region"
              aria-label="Historical jurisdictions"
            >
              <span className={cx(placeStyles, 'place-historical-names-label')}>Jurisdictions:</span>
              <div className={cx(placeStyles, 'place-historical-names-list')}>
                {place.historical_names.map((hn) => {
                  const span =
                    hn.valid_from || hn.valid_to
                      ? ` (${hn.valid_from || '?'}–${hn.valid_to || 'present'})`
                      : '';
                  return (
                    <span
                      key={`${hn.name}-${hn.valid_from || ''}-${hn.valid_to || ''}`}
                      className={cx(placeStyles, 'place-jurisdiction-chip')}
                    >
                      {hn.name}
                      {span}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {place.sources && place.sources.length > 0 && (
            <SourceCitationTag sources={place.sources} sourcesById={sourcesById} />
          )}
        </div>
        {placePhotoSrc && placePhotoMedia && (
          <figure className={cx(placeStyles, 'place-history-figure')}>
            <MediaPlayer media={placePhotoMedia} baseUrl={baseUrl} variant="full" />
            {place.photo_caption && <figcaption>{place.photo_caption}</figcaption>}
          </figure>
        )}
      </div>
    </section>
  );
};

export const PlaceOccupancySection: React.FC<{
  readonly occupancyRows: PlaceOccupancySummary;
}> = ({ occupancyRows }) => {
  const spanYears = Math.max(1, occupancyRows.maxYear - occupancyRows.minYear);
  return (
    <section className={cx(layoutStyles, 'place-map-box')}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 12,
        }}
      >
        <h2 style={{ fontFamily: 'var(--font-serif)', margin: 0 }}>Who Passed Through</h2>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
          }}
        >
          {occupancyRows.minYear} — {occupancyRows.maxYear}
        </span>
      </div>

      {occupancyRows.rows.length === 0 ? (
        <p className={cx(controlStyles, 'empty-ring-note')}>
          No family residency records found in this area.
        </p>
      ) : (
        <div>
          {occupancyRows.rows.map((row) => {
            const rawLeftPct = ((row.startYear - occupancyRows.minYear) / spanYears) * 100;
            const widthPct = Math.max(4, (Math.max(1, row.endYear - row.startYear) / spanYears) * 100);
            const leftPct = Math.max(0, Math.min(100 - widthPct, rawLeftPct));
            const yearLabel =
              row.startYear === row.endYear ? String(row.startYear) : `${row.startYear}–${row.endYear}`;
            return (
              <Link
                key={row.person.id}
                to={`/person/${row.person.slug}?event=${row.firstEventId}`}
                className={cx(placeStyles, 'occupancy-row')}
                aria-label={`Jump to ${row.person.full_name} (${yearLabel})`}
              >
                <span className={cx(placeStyles, 'occupancy-row-header')}>
                  <span className={cx(placeStyles, 'occupancy-person-name')}>{row.person.full_name}</span>
                  <span className={cx(placeStyles, 'occupancy-year-label')}>{yearLabel}</span>
                </span>
                <span className={cx(placeStyles, 'occupancy-track')} aria-hidden="true">
                  <span
                    className={cx(placeStyles, `occupancy-bar ${row.tier.toLowerCase()}`)}
                    style={{ left: `${leftPct}%`, width: `${Math.min(100 - leftPct, widthPct)}%` }}
                  />
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
};

export const PlaceLocalHistorySection: React.FC<{
  readonly localRecords: readonly ArchiveEvent[];
  readonly recordDecades: readonly number[];
  readonly effectiveDecadeFilter: string;
  readonly sourcesById: Map<string, SourceRecord>;
  readonly onSelectDecade: (decade: string) => void;
}> = ({ localRecords, recordDecades, effectiveDecadeFilter, sourcesById, onSelectDecade }) => (
  <section className={cx(layoutStyles, 'place-map-box')}>
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        marginBottom: 12,
      }}
    >
      <h2 style={{ fontFamily: 'var(--font-serif)', margin: 0 }}>
        {KINLOOM_VOCABULARY.place.localHistoryHeading}
      </h2>
      <div className={cx(controlStyles, 'filter-bar place-decade-bar print-hide')} style={{ margin: 0 }}>
        <button
          type="button"
          className={cx(controlStyles, `pill-btn ${effectiveDecadeFilter === 'all' ? 'active' : ''}`)}
          aria-pressed={effectiveDecadeFilter === 'all'}
          onClick={() => {
            onSelectDecade('all');
          }}
        >
          All Decades
        </button>
        {recordDecades.map((d) => (
          <button
            key={d}
            type="button"
            className={cx(controlStyles, `pill-btn ${effectiveDecadeFilter === String(d) ? 'active' : ''}`)}
            aria-pressed={effectiveDecadeFilter === String(d)}
            onClick={() => {
              onSelectDecade(String(d));
            }}
          >
            {d}s
          </button>
        ))}
      </div>
    </div>

    {localRecords.length === 0 ? (
      <p className={cx(controlStyles, 'empty-ring-note')}>{KINLOOM_VOCABULARY.place.localHistoryEmpty}</p>
    ) : (
      <div style={{ display: 'grid', gap: 12 }}>
        {localRecords.map((ev) => (
          <article key={ev.id} className={cx(milestoneStyles, 'story-card')} style={{ padding: 14 }}>
            <div className={cx(milestoneStyles, 'story-card-top')}>
              <DateStamp displayDate={ev.display_date} edtf={ev.edtf_date} />
            </div>
            <h3 style={{ fontFamily: 'var(--font-serif)', margin: '0 0 6px', fontSize: '1.02rem' }}>
              {ev.title}
            </h3>
            <p style={{ margin: 0, fontSize: '0.9rem' }}>{ev.summary}</p>
            {ev.source_url && (
              <div className={'print-hide'} style={{ marginTop: 8 }}>
                <a
                  href={ev.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className={cx(controlStyles, 'pill-btn')}
                  style={{ textDecoration: 'none' }}
                >
                  View External Record ↗
                </a>
              </div>
            )}
            <SourceCitationTag
              sources={ev.sources}
              alternateDates={ev.alternate_dates}
              alternatePlaces={ev.alternate_places}
              factConflicts={ev.fact_conflicts}
              sourcesById={sourcesById}
              eventId={ev.id}
            />
          </article>
        ))}
      </div>
    )}
  </section>
);
