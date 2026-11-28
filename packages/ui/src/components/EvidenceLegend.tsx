import { EPISTEMIC_TIER_CATALOG, EPISTEMIC_TIER_ORDER, type EpistemicTier } from '@kinloom/core';
import type React from 'react';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import styles from './EvidenceLegend.module.css';

export interface EvidenceLegendProps {
  readonly defaultOpen?: boolean;
  readonly showRegistryLink?: boolean;
  readonly className?: string;
}

const EpistemicSwatchGlyph: React.FC<{ readonly tier: EpistemicTier }> = ({ tier }) => (
  <svg
    width="13"
    height="13"
    viewBox="0 0 16 16"
    fill="none"
    aria-hidden="true"
    className={cx(styles, 'evidence-legend-glyph')}
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
);

/**
 * Compact toggleable "How we weigh evidence" legend explaining Kinloom's 3-tier reader vocabulary.
 */
export const EvidenceLegend: React.FC<EvidenceLegendProps> = ({
  defaultOpen = false,
  showRegistryLink = false,
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className={cx(styles, `evidence-legend print-hide${className ? ` ${className}` : ''}`)}>
      <button
        type="button"
        className={cx(styles, 'evidence-legend-toggle')}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen((prev) => !prev);
        }}
      >
        <span className={cx(styles, 'evidence-legend-chevron')} aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span>{KINLOOM_VOCABULARY.epistemic.legendTitle}</span>
      </button>

      {open && (
        <section
          id={panelId}
          aria-label={KINLOOM_VOCABULARY.epistemic.legendTitle}
          className={cx(styles, 'evidence-legend-panel')}
        >
          <ul className={cx(styles, 'evidence-legend-grid')}>
            {EPISTEMIC_TIER_ORDER.map((tier) => {
              const descriptor = EPISTEMIC_TIER_CATALOG[tier];
              return (
                <li key={tier} className={cx(styles, `evidence-legend-item tier-${tier}`)}>
                  <div className={cx(styles, 'evidence-legend-item-head')}>
                    <EpistemicSwatchGlyph tier={tier} />
                    <strong className={cx(styles, 'evidence-legend-label')}>{descriptor.label}</strong>
                  </div>
                  <p className={cx(styles, 'evidence-legend-desc')}>{descriptor.readerDescription}</p>
                </li>
              );
            })}
          </ul>
          {showRegistryLink && (
            <div className={cx(styles, 'evidence-legend-footer')}>
              <Link to="/evidence" className={cx(styles, 'evidence-legend-link')}>
                {KINLOOM_VOCABULARY.epistemic.inspectRegistryCta}
              </Link>
            </div>
          )}
        </section>
      )}
    </div>
  );
};
