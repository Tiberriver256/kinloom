import type React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { cx } from '../../lib/cx.js';
import styles from './OpenFinance.module.css';
import { useOpenFinanceContext } from './OpenFinanceContext.js';

export const OpenFinanceNavLink: React.FC = () => {
  const { summary, routePath } = useOpenFinanceContext();
  const location = useLocation();

  if (!summary?.visibility.show_support_page || !summary.visibility.show_in_nav) {
    return null;
  }

  const isActive = location.pathname === routePath;
  return (
    <Link
      to={routePath}
      className={cx(styles, `of-nav-link ${isActive ? 'active' : ''}`)}
      aria-current={isActive ? 'page' : undefined}
      data-testid="open-finance-nav-link"
    >
      {summary.nav_label}
    </Link>
  );
};

export const OpenFinanceFooterLink: React.FC = () => {
  const { summary, routePath } = useOpenFinanceContext();

  if (!summary?.visibility.show_support_page || !summary.visibility.show_in_footer) {
    return null;
  }

  return (
    <Link to={routePath} className={cx(styles, 'of-footer-link')} data-testid="open-finance-footer-link">
      {summary.nav_label}
    </Link>
  );
};
