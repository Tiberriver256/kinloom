import type { AuthorType, EpistemicTier, StewardReviewStamp } from '@kinloom/core';
import { deriveCitationBadge, EPISTEMIC_TIER_CATALOG } from '@kinloom/core';
import type React from 'react';
import { cx } from '../../lib/cx.js';
import { formatArchivalTimestamp } from '../../lib/formatTimestamp.js';
import wikiChromeStyles from './WikiChrome.module.css';

export interface CitationBadgeProps {
  hasPrimarySource?: boolean;
  sourceIds?: readonly string[];
  className?: string;
}

/**
 * WCAG 1.4.1 compliant archival citation badge: icon + text + semantic token.
 */
export const CitationBadge: React.FC<CitationBadgeProps> = ({ hasPrimarySource, sourceIds, className }) => {
  const kind = deriveCitationBadge({
    ...(hasPrimarySource !== undefined ? { hasPrimarySource } : {}),
    ...(sourceIds !== undefined ? { sourceIds } : {}),
  });
  const isCited = kind === 'Cited';

  return (
    <span
      className={cx(
        wikiChromeStyles,
        `wiki-badge ${isCited ? 'wiki-badge-cited' : 'wiki-badge-memory'}${className ? ` ${className}` : ''}`
      )}
      title={
        isCited
          ? 'Backed by a primary archival source'
          : 'Recorded from family memory without a primary source citation yet'
      }
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={cx(wikiChromeStyles, 'wiki-badge-icon')}
      >
        {isCited ? (
          <>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M5.2 8.2L7.1 10.1L11.1 5.9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        ) : (
          <>
            <path
              d="M3 13L5.6 12.2L12.6 5.2C13.1 4.7 13.1 3.9 12.6 3.4L12.5 3.3C12 2.8 11.2 2.8 10.7 3.3L3.7 10.3L3 13Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path d="M9.6 4.4L11.5 6.3" stroke="currentColor" strokeWidth="1.4" />
          </>
        )}
      </svg>
      <span>{kind}</span>
    </span>
  );
};

export interface ConflictBadgeProps {
  label?: string;
  className?: string;
}

/**
 * Split-fork conflict badge used for preserved source discrepancies and 409 edit conflicts.
 */
export const ConflictBadge: React.FC<ConflictBadgeProps> = ({ label = 'Conflict', className }) => (
  <span className={cx(wikiChromeStyles, `wiki-badge wiki-badge-conflict${className ? ` ${className}` : ''}`)}>
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={cx(wikiChromeStyles, 'wiki-badge-icon')}
    >
      <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="11.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M4.5 5.3V7C4.5 8.1 5.4 9 6.5 9H9.5C10.6 9 11.5 8.1 11.5 7V5.3M8 9V10.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
    <span>{label}</span>
  </span>
);

export interface EpistemicTierBadgeProps {
  tier: EpistemicTier;
  label?: string;
  title?: string;
  className?: string;
}

/**
 * Unified 3-tier reader epistemic badge (Cited, Family memory / Inferred, Discrepancy / Open question).
 */
export const EpistemicTierBadge: React.FC<EpistemicTierBadgeProps> = ({ tier, label, title, className }) => {
  const descriptor = EPISTEMIC_TIER_CATALOG[tier];
  let variantClass = 'wiki-badge-cited';
  if (tier === 'inferred') {
    variantClass = 'wiki-badge-memory';
  } else if (tier === 'open_question') {
    variantClass = 'wiki-badge-conflict';
  }

  return (
    <span
      className={cx(wikiChromeStyles, `wiki-badge ${variantClass}${className ? ` ${className}` : ''}`)}
      title={title ?? descriptor.readerDescription}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={cx(wikiChromeStyles, 'wiki-badge-icon')}
      >
        {tier === 'cited' && (
          <>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M5.2 8.2L7.1 10.1L11.1 5.9"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {tier === 'inferred' && (
          <>
            <path
              d="M3 13L5.6 12.2L12.6 5.2C13.1 4.7 13.1 3.9 12.6 3.4L12.5 3.3C12 2.8 11.2 2.8 10.7 3.3L3.7 10.3L3 13Z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
            <path d="M9.6 4.4L11.5 6.3" stroke="currentColor" strokeWidth="1.4" />
          </>
        )}
        {tier === 'open_question' && (
          <>
            <circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="11.5" cy="3.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="8" cy="12.5" r="1.75" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M4.5 5.3V7C4.5 8.1 5.4 9 6.5 9H9.5C10.6 9 11.5 8.1 11.5 7V5.3M8 9V10.7"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
      <span>{label ?? descriptor.shortLabel}</span>
    </span>
  );
};

export interface StewardReviewBadgeProps {
  review: StewardReviewStamp;
  className?: string;
}

/**
 * Positive archival verification stamp indicating a steward has reviewed a revision or research batch.
 */
export const StewardReviewBadge: React.FC<StewardReviewBadgeProps> = ({ review, className }) => {
  const formattedTime = formatArchivalTimestamp(review.reviewed_at);
  return (
    <span
      className={cx(wikiChromeStyles, `wiki-badge wiki-badge-cited${className ? ` ${className}` : ''}`)}
      title={
        review.note
          ? `${review.reviewer_name}: ${review.note}`
          : `Reviewed by ${review.reviewer_name} on ${review.reviewed_at}`
      }
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        className={cx(wikiChromeStyles, 'wiki-badge-icon')}
      >
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M5.2 8.2L7.1 10.1L11.1 5.9"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        Reviewed by {review.reviewer_name} · {formattedTime}
      </span>
    </span>
  );
};

export interface AuthorPillProps {
  authorType: AuthorType;
  authorName: string;
  className?: string;
}

/**
 * Authorship pill distinguishing human editors, AI research agents, and initial archive seeds.
 */
const CLI_SYNC_TOKEN_RE =
  /^(?:kinloom[\s_.:/-]*)?(?:cli|api|github|ci)?[\s_.:/-]*sync(?:[\s_.:/-]*(?:token|bot|key|client|agent|runner))?(?:[\s_.:/-]*[a-f0-9]{4,})?$/i;

export function formatAgentAuthorLabel(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return '';
  }
  if (CLI_SYNC_TOKEN_RE.test(trimmed)) {
    return 'Archive sync';
  }
  const stripped = trimmed
    .replace(/^(?:agent|token|sync|cli|bot)[\s_.:/-]+/i, '')
    .replace(/[\s_.:/-]+(?:token|key|secret)(?:[\s_.:/-]*[a-f0-9]{4,})?$/i, '')
    .replace(/[\s_.:/-]+[a-f0-9]{6,}$/i, '')
    .trim();
  const base = stripped || trimmed;
  if (!/[_:/-]/.test(base)) {
    return base;
  }
  return base
    .split(/[\s_.:/-]+/)
    .filter(Boolean)
    .map((word) => {
      if (/^(?:ai|cli|api|gedcom)$/i.test(word)) {
        return word.toUpperCase();
      }
      return `${word[0]?.toUpperCase() ?? ''}${word.slice(1).toLowerCase()}`;
    })
    .join(' ');
}

export const AuthorPill: React.FC<AuthorPillProps> = ({ authorType, authorName, className }) => {
  let label = authorName;
  let typePrefix = 'Editor';
  if (authorType === 'agent') {
    typePrefix = 'Research agent';
    const cleanAgent = formatAgentAuthorLabel(authorName);
    label = cleanAgent ? `Research agent · ${cleanAgent}` : 'Research agent';
  } else if (authorType === 'system_seed') {
    typePrefix = 'Initial seed';
    label = 'Initial seed';
  }

  return (
    <span
      className={cx(
        wikiChromeStyles,
        `wiki-author-pill wiki-author-${authorType}${className ? ` ${className}` : ''}`
      )}
      title={`${typePrefix}: ${authorName || label}`}
    >
      <span className={'wiki-author-glyph'} aria-hidden="true">
        {authorType === 'agent' ? '◈' : authorType === 'system_seed' ? '§' : '●'}
      </span>
      <span>{label}</span>
    </span>
  );
};
