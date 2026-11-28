import type { ConfidenceTier, Place } from '@kinloom/core';
import type React from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../../lib/cx.js';
import controlStyles from '../../styles/Controls.module.css';
import atomStyles from '../Atoms.module.css';
import { PersonPortrait } from './PersonPortrait.js';

export const EmptyStateNotice: React.FC<{
  title: string;
  body?: string | undefined;
  eyebrow?: string | undefined;
  role?: 'status' | 'note';
  action?: React.ReactNode | undefined;
  secondaryAction?: React.ReactNode | undefined;
}> = ({ title, body, eyebrow, role = 'status', action, secondaryAction }) => (
  <div className={cx(controlStyles, 'empty-state-notice')} role={role}>
    {eyebrow && <div className={cx(controlStyles, 'empty-state-notice-eyebrow')}>{eyebrow}</div>}
    <p className={cx(controlStyles, 'empty-state-notice-title')}>{title}</p>
    {body && <p className={cx(controlStyles, 'empty-state-notice-body')}>{body}</p>}
    {(action || secondaryAction) && (
      <div className={cx(controlStyles, 'empty-state-notice-action')}>
        {action}
        {secondaryAction}
      </div>
    )}
  </div>
);

export const DateStamp: React.FC<{ displayDate: string; edtf?: string }> = ({ displayDate, edtf }) => (
  <span className={cx(atomStyles, 'date-stamp')} title={edtf ? `Recorded date: ${edtf}` : undefined}>
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
      className={cx(atomStyles, 'coordinate-pill')}
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
  portraitUrl?: string | null;
  baseUrl?: string;
}> = ({ name, relationship, tier, distanceMiles, onClick, portraitUrl, baseUrl }) => {
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
      className={cx(atomStyles, `avatar-chip ${tierClass}`)}
      onClick={onClick}
      title={`${name} (${relationship}) — ${tier}${distLabel}. Open Person Profile.`}
    >
      <PersonPortrait
        name={name}
        src={portraitUrl}
        baseUrl={baseUrl}
        variant="circle"
        size="xs"
        className={cx(atomStyles, 'avatar-circle')}
      />
      <span>
        <strong>{name}</strong>{' '}
        <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem' }}>
          {relationship} · {tier}
        </span>
      </span>
    </button>
  );
};
