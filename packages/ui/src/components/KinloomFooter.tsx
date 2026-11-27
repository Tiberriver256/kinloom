import type React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { cx } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { PluginSlot } from '../plugins/PluginContext.js';
import footerStyles from './KinloomFooter.module.css';

export const KinloomMark: React.FC<{ size?: number }> = ({ size = 18 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    role="img"
    aria-label="Kinloom mark"
  >
    <path
      d="M8 2.5V13.5M8 18.5V21.5"
      stroke="var(--surface-header)"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
    <path
      d="M16 2.5V5.5M16 10.5V21.5"
      stroke="var(--surface-header)"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
    <path d="M2.5 8H5.5M10.5 8H21.5" stroke="var(--accent-primary)" strokeWidth="2.5" strokeLinecap="round" />
    <path
      d="M2.5 16H13.5M18.5 16H21.5"
      stroke="var(--surface-header)"
      strokeWidth="2.5"
      strokeLinecap="round"
    />
  </svg>
);

export const KinloomFooter: React.FC<{ hideNav?: boolean }> = ({ hideNav = false }) => {
  const { siteConfig } = useArchiveData();
  const inRouter = useInRouterContext();
  const credit = siteConfig.site.footerCredit || 'Built with Kinloom';

  return (
    <footer className={cx(footerStyles, 'kinloom-footer print-hide')}>
      {inRouter && !hideNav && (
        <nav className={cx(footerStyles, 'kinloom-footer-nav')} aria-label="Archive tools">
          <Link to="/kinship" className={cx(footerStyles, 'kinloom-footer-link')}>
            {KINLOOM_VOCABULARY.nav.kinshipFull}
          </Link>
          <Link to="/evidence" className={cx(footerStyles, 'kinloom-footer-link')}>
            {KINLOOM_VOCABULARY.nav.evidenceFull}
          </Link>
          <PluginSlot name="footer" className={cx(footerStyles, 'kinloom-footer-plugin-slot')} />
        </nav>
      )}
      <span className={cx(footerStyles, 'kinloom-footer-credit')}>
        <KinloomMark size={16} />
        <span>{credit}</span>
      </span>
    </footer>
  );
};
