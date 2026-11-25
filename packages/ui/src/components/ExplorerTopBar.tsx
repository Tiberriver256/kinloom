import { Link, useLocation } from 'react-router-dom';
import React from 'react';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useKinloomPlugins } from '../plugins/PluginContext.js';

export const ExplorerTopBar: React.FC = () => {
  const { siteConfig, featuredDocumentId, capabilities } = useArchiveData();
  const { activeYear, pivotTrail, openSourceReader, openSearch } = useArchiveUi();
  const { routes: pluginRoutes } = useKinloomPlugins();
  const location = useLocation();
  const navPluginRoutes = pluginRoutes.filter((r) => Boolean(r.navLabel));

  const isPeopleActive =
    location.pathname === '/' || location.pathname.startsWith('/person/');
  const isPlacesActive =
    location.pathname === '/places' || location.pathname.startsWith('/place/');
  const isTimeActive = location.pathname === '/time';

  const handleOpenSources = (): void => {
    openSourceReader({ sourceId: featuredDocumentId ?? '' });
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <Link to="/" className="brand-link">
          {siteConfig.site.title}
        </Link>

        <nav className="nav-links" aria-label="Primary navigation">
          <Link to="/" className={`nav-pill nav-axis ${isPeopleActive ? 'active' : ''}`}>
            People
          </Link>
          <Link to="/places" className={`nav-pill nav-axis ${isPlacesActive ? 'active' : ''}`}>
            Places
          </Link>
          <Link to="/time" className={`nav-pill nav-axis ${isTimeActive ? 'active' : ''}`}>
            Time
          </Link>

          <span className="nav-divider nav-pill-desktop-only" aria-hidden="true" />

          <Link to="/tree" className={`nav-pill ${location.pathname === '/tree' ? 'active' : ''}`}>
            Tree
          </Link>
          <Link to="/map" className={`nav-pill ${location.pathname === '/map' ? 'active' : ''}`}>
            Map
          </Link>

          {capabilities.hasRevisionHistory && (
            <Link
              to="/changes"
              className={`nav-pill nav-pill-desktop-only ${location.pathname === '/changes' ? 'active' : ''}`}
            >
              Changes
            </Link>
          )}

          {capabilities.canManageSite && (
            <Link
              to="/admin"
              className={`nav-pill nav-pill-desktop-only ${location.pathname === '/admin' ? 'active' : ''}`}
            >
              Admin
            </Link>
          )}

          {navPluginRoutes.map((route) => (
            <Link
              key={`${route.pluginId}:${route.path}`}
              to={route.path}
              className={`nav-pill ${location.pathname === route.path ? 'active' : ''}`}
            >
              {route.navLabel}
            </Link>
          ))}
        </nav>
      </div>

      <div className="topbar-center">
        {activeYear !== null && location.pathname.startsWith('/person/') && (
          <Link
            to={`/time?year=${activeYear}`}
            className="year-readout"
            aria-live="polite"
            title={`Active timeline year ${activeYear} — click to see where everyone was in ${activeYear}`}
          >
            {activeYear}
          </Link>
        )}

        <button
          type="button"
          className="nav-pill nav-pill-desktop-only"
          onClick={handleOpenSources}
        >
          Sources
        </button>

        <button
          type="button"
          className="nav-pill nav-pill-desktop-only"
          onClick={openSearch}
          title="Search people, places, events, and primary source transcriptions (/ or ⌘K)"
        >
          Search (/)
        </button>

        <button
          type="button"
          className="nav-pill mobile-sources-btn"
          onClick={openSearch}
          aria-label="Search full archive"
        >
          Find
        </button>

        <button
          type="button"
          className="nav-pill mobile-sources-btn"
          onClick={handleOpenSources}
        >
          Sources
        </button>
      </div>

      {pivotTrail.length > 1 && location.pathname.startsWith('/person/') && (
        <div className="topbar-right">
          <div className="breadcrumb-strip" aria-label="Recent pivot trail">
            <span>Trail:</span>
            {pivotTrail.slice(-3).map((c, idx) => (
              <React.Fragment key={c.slug}>
                {idx > 0 && <span>→</span>}
                <Link to={`/person/${c.slug}`}>{c.name}</Link>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </header>
  );
};
