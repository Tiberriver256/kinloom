import type { ArchiveEvent, TimePersonEntry } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { initialsOf, resolveAssetUrl } from '../../components/Atoms.js';
import atomStyles from '../../components/Atoms.module.css';
import { cx, joinClasses } from '../../lib/cx.js';
import timeStyles from '../TimePage.module.css';

export const TimePersonCard: React.FC<{
  readonly entry: TimePersonEntry;
  readonly activeYear: number;
  readonly personThumbMap: Map<string, string>;
  readonly baseUrl: string;
}> = ({ entry, activeYear, personThumbMap, baseUrl }) => {
  const targetUrl = entry.nearestEventId
    ? `/person/${entry.person.slug}?event=${entry.nearestEventId}`
    : `/person/${entry.person.slug}`;
  let tierClass = 'tier-possible';
  if (entry.tier === 'Confirmed') {
    tierClass = 'tier-confirmed';
  } else if (entry.tier === 'Inferred') {
    tierClass = 'tier-inferred';
  }
  const thumb = personThumbMap.get(entry.person.id) || entry.person.portrait_url;
  return (
    <Link to={targetUrl} className={cx(timeStyles, `time-person-item ${tierClass}`)}>
      <div
        className={joinClasses(cx(atomStyles, 'photo-print'), cx(timeStyles, 'time-person-thumb'))}
        aria-hidden="true"
      >
        {thumb ? (
          <img src={resolveAssetUrl(thumb, baseUrl)} alt="" loading="lazy" />
        ) : (
          <span className={cx(atomStyles, 'photo-print-monogram')}>{initialsOf(entry.person.full_name)}</span>
        )}
      </div>
      <div className={cx(timeStyles, 'time-person-info')}>
        <div className={cx(timeStyles, 'time-person-name-row')}>
          <span className={cx(timeStyles, 'time-person-name')}>{entry.person.full_name}</span>
          {entry.age !== null && <span className={cx(timeStyles, 'time-person-age')}>age {entry.age}</span>}
        </div>
        <div className={cx(timeStyles, 'time-person-status')}>
          {entry.exactYearMatch ? `In ${activeYear}: ` : ''}
          {entry.activityTitle}
        </div>
        <p className={cx(timeStyles, 'time-person-note')}>{entry.activityNote}</p>
        <div className={cx(timeStyles, 'time-person-tier')}>{entry.tier}</div>
      </div>
    </Link>
  );
};

export const TimeLocalNote: React.FC<{ readonly ev: ArchiveEvent }> = ({ ev }) => (
  <div className={cx(timeStyles, 'time-local-note')}>
    <div className={cx(timeStyles, 'time-local-title')}>
      <span>
        {ev.display_date} — {ev.title}
      </span>
    </div>
    {ev.summary && <p>{ev.summary}</p>}
  </div>
);

export const TimeChevronIcon: React.FC<{ readonly direction: 'left' | 'right' | 'up' | 'down' }> = ({
  direction,
}) => {
  let points = '9 18 15 12 9 6';
  if (direction === 'left') {
    points = '15 18 9 12 15 6';
  } else if (direction === 'up') {
    points = '18 15 12 9 6 15';
  } else if (direction === 'down') {
    points = '6 9 12 15 18 9';
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points={points} />
    </svg>
  );
};
