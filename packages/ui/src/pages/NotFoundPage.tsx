import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExplorerTopBar } from '../components/ExplorerTopBar.js';
import { KinloomFooter } from '../components/KinloomFooter.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';

export const NotFoundPage: React.FC = () => {
  const location = useLocation();
  const { openSearch } = useArchiveUi();

  return (
    <div>
      <ExplorerTopBar />
      <main className="not-found-page">
        <h1 className="not-found-title">Page Not Found</h1>
        <p className="not-found-copy">
          We could not find an archive page at{' '}
          <code className="not-found-path">{location.pathname}</code>. The record may have moved, or
          the address may be misspelled.
        </p>
        <nav className="not-found-actions" aria-label="Archive recovery links">
          <Link to="/" className="not-found-link is-primary">
            Return to {KINLOOM_VOCABULARY.nav.people}
          </Link>
          <Link to="/tree" className="not-found-link">
            Open {KINLOOM_VOCABULARY.tree.pageTitleSuffix}
          </Link>
          <Link to="/places" className="not-found-link">
            Browse {KINLOOM_VOCABULARY.nav.places}
          </Link>
          <button
            type="button"
            className="not-found-link"
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
