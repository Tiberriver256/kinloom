import type React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { cx } from '../lib/cx.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import layoutStyles from '../styles/Layout.module.css';
import notFoundStyles from './NotFoundPage.module.css';

export const NotFoundPage: React.FC = () => {
  const location = useLocation();
  const { openSearch } = useArchiveUi();

  return (
    <div className={cx(layoutStyles, 'page-shell')}>
      <ExplorerTopBar />
      <main id="main-content" className={cx(notFoundStyles, 'not-found-page')}>
        <h1 className={cx(notFoundStyles, 'not-found-title')}>Page Not Found</h1>
        <p className={cx(notFoundStyles, 'not-found-copy')}>
          We could not find an archive page at{' '}
          <code className={cx(notFoundStyles, 'not-found-path')}>{location.pathname}</code>. The record may
          have moved, or the address may be misspelled.
        </p>
        <nav className={cx(notFoundStyles, 'not-found-actions')} aria-label="Archive recovery links">
          <Link to="/" className={cx(notFoundStyles, 'not-found-link is-primary')}>
            Return to {KINLOOM_VOCABULARY.nav.people}
          </Link>
          <Link to="/tree" className={cx(notFoundStyles, 'not-found-link')}>
            Open {KINLOOM_VOCABULARY.tree.pageTitleSuffix}
          </Link>
          <Link to="/places" className={cx(notFoundStyles, 'not-found-link')}>
            Browse {KINLOOM_VOCABULARY.nav.places}
          </Link>
          <button
            type="button"
            className={cx(notFoundStyles, 'not-found-link')}
            onClick={() => {
              openSearch();
            }}
          >
            Search Archive
          </button>
        </nav>
      </main>
      <KinloomFooter />
    </div>
  );
};
