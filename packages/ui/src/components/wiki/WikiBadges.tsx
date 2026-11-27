import type { AuthorType } from '@kinloom/core';
import { deriveCitationBadge } from '@kinloom/core';
import type React from 'react';

export interface CitationBadgeProps {
  hasPrimarySource?: boolean;
  sourceIds?: readonly string[];
  className?: string;
}

/**
 * WCAG 1.4.1 compliant archival citation badge: icon + text + semantic token.
 */
export const CitationBadge: React.FC<CitationBadgeProps> = ({ hasPrimarySource, sourceIds, className }) => {
  const kind = deriveCitationBadge({ hasPrimarySource, sourceIds });
  const isCited = kind === 'Cited';

  return (
    <span
      className={`wiki-badge ${isCited ? 'wiki-badge-cited' : 'wiki-badge-memory'}${className ? ` ${className}` : ''}`}
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
        className="wiki-badge-icon"
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
  <span className={`wiki-badge wiki-badge-conflict${className ? ` ${className}` : ''}`}>
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="wiki-badge-icon"
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

export interface AuthorPillProps {
  authorType: AuthorType;
  authorName: string;
  className?: string;
}

/**
 * Authorship pill distinguishing human editors, AI research agents, and initial archive seeds.
 */
export const AuthorPill: React.FC<AuthorPillProps> = ({ authorType, authorName, className }) => {
  let label = authorName;
  let typePrefix = 'Editor';
  if (authorType === 'agent') {
    typePrefix = 'Research agent';
    label = authorName ? `Research agent · ${authorName}` : 'Research agent';
  } else if (authorType === 'system_seed') {
    typePrefix = 'Initial seed';
    label = 'Initial seed';
  }

  return (
    <span
      className={`wiki-author-pill wiki-author-${authorType}${className ? ` ${className}` : ''}`}
      title={`${typePrefix}: ${authorName || label}`}
    >
      <span className="wiki-author-glyph" aria-hidden="true">
        {authorType === 'agent' ? '◈' : authorType === 'system_seed' ? '§' : '●'}
      </span>
      <span>{label}</span>
    </span>
  );
};
