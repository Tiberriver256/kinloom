import type { ConfidenceTier, Place } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../lib/cx.js';
import cssMod4 from '../../pages/NotFoundPage.module.css';
import cssMod0 from '../Atoms.module.css';
import { initialsOf } from './formatters.js';

const uiStyles: Readonly<Record<string, string>> = {
  ...cssMod0,
  ...cssMod4,
};

export const EmptyStateNotice: React.FC<{
  title: string;
  body?: string;
  action?: React.ReactNode;
}> = ({ title, body, action }) => (
  <div className={cx(uiStyles, 'empty-state-notice')} role="status">
    <p className={cx(uiStyles, 'empty-state-notice-title')}>{title}</p>
    {body && <p className={cx(uiStyles, 'empty-state-notice-body')}>{body}</p>}
    {action && <div className={cx(uiStyles, 'empty-state-notice-action')}>{action}</div>}
  </div>
);

export const DateStamp: React.FC<{ displayDate: string; edtf?: string }> = ({ displayDate, edtf }) => (
  <span className={cx(uiStyles, 'date-stamp')} title={edtf ? `Recorded date: ${edtf}` : undefined}>
    {displayDate || 'Undated'}
  </span>
);

export const CoordinatePill: React.FC<{ place: Place | undefined }> = ({ place }) => {
  if (!place) {
    return null;
  }
  const latStr = `${Math.abs(place.lat).toFixed(2)}°${place.lat >= 0 ? 'N' : 'S'}`;
  const lngStr = `${Math.abs(place.lng).toFixed(2)}°${place.lng >= 0 ? 'E' : 'W'}`;
  return (
    <Link
      to={`/place/${place.slug}`}
      className={cx(uiStyles, 'coordinate-pill')}
      title={`Open ${place.full_name} profile`}
    >
      <span>
        {latStr}, {lngStr} · {place.name}
      </span>
    </Link>
  );
};

export const ScopeGlyph: React.FC<{ category?: string; size?: number }> = ({
  category = 'life_milestone',
  size = 15,
}) => {
  if (category === 'weather') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <path d="M8 1v14M1 8h14M3 3l10 10M13 3L3 13" />
      </svg>
    );
  }
  if (category === 'newspaper') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <rect x="2" y="2" width="12" height="12" />
        <path d="M4.5 5.5h7M4.5 8h7M4.5 10.5h4.5" />
      </svg>
    );
  }
  if (category === 'macro') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2a9 9 0 0 1 0 12M8 2a9 9 0 0 0 0 12" />
      </svg>
    );
  }
  if (category === 'homestead') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <path d="M2 8l6-5 6 5v6H2V8z" />
        <path d="M6.5 14v-4h3v4" />
      </svg>
    );
  }
  if (category === 'family_milestone') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        aria-hidden
      >
        <circle cx="6" cy="8" r="3.5" />
        <circle cx="10" cy="8" r="3.5" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden
    >
      <circle cx="8" cy="8" r="4" />
      <path d="M8 1v3M8 12v3" />
    </svg>
  );
};

export const RelativeAvatarChip: React.FC<{
  name: string;
  relationship: string;
  tier: ConfidenceTier;
  distanceMiles: number | null;
  onClick: () => void;
}> = ({ name, relationship, tier, distanceMiles, onClick }) => {
  let tierClass = 'tier-possible';
  if (tier === 'Confirmed') {
    tierClass = 'tier-confirmed';
  } else if (tier === 'Inferred') {
    tierClass = 'tier-inferred';
  }
  let distLabel = '';
  if (distanceMiles === 0) {
    distLabel = ' · same place';
  } else if (distanceMiles !== null) {
    distLabel = ` · ${distanceMiles} mi`;
  }

  return (
    <button
      type="button"
      className={cx(uiStyles, `avatar-chip ${tierClass}`)}
      onClick={onClick}
      title={`${name} (${relationship}) — ${tier}${distLabel}. Open Person Profile.`}
    >
      <span className={cx(uiStyles, 'avatar-circle')}>{initialsOf(name)}</span>
      <span>
        <strong>{name}</strong>{' '}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
          {relationship} · {tier}
        </span>
      </span>
    </button>
  );
};
