import React from 'react';
import { useArchiveData } from '../context/ArchiveDataContext.js';

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
    <path d="M8 2.5V13.5M8 18.5V21.5" stroke="#1B2A41" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M16 2.5V5.5M16 10.5V21.5" stroke="#1B2A41" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M2.5 8H5.5M10.5 8H21.5" stroke="var(--accent-primary, #7A4612)" strokeWidth="2.5" strokeLinecap="round" />
    <path d="M2.5 16H13.5M18.5 16H21.5" stroke="#1B2A41" strokeWidth="2.5" strokeLinecap="round" />
  </svg>
);

export const KinloomFooter: React.FC = () => {
  const { siteConfig } = useArchiveData();
  const credit = siteConfig.site.footerCredit || 'Built with Kinloom';

  return (
    <footer className="kinloom-footer print-hide" aria-label="Archive colophon">
      <span className="kinloom-footer-credit">
        <KinloomMark size={16} />
        <span>{credit}</span>
      </span>
    </footer>
  );
};
