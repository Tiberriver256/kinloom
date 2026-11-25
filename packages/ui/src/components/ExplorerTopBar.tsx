import { Link, useLocation } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import { initialsOf } from './Atoms.js';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useKinloomPlugins } from '../plugins/PluginContext.js';

export const ExplorerTopBar: React.FC = () => {
  const { siteConfig, featuredDocumentId, capabilities, session, dataSource, refreshSession } =
    useArchiveData();
  const { activeYear, pivotTrail, openSourceReader, openSearch } = useArchiveUi();
  const { routes: pluginRoutes } = useKinloomPlugins();
  const location = useLocation();
  const navPluginRoutes = pluginRoutes.filter((r) => Boolean(r.navLabel));

  const [accountOpen, setAccountOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const isPeopleActive =
    location.pathname === '/' || location.pathname.startsWith('/person/');
  const isPlacesActive =
    location.pathname === '/places' || location.pathname.startsWith('/place/');
  const isTimeActive = location.pathname === '/time';

  const isSignedInMember = Boolean(session?.authenticated && session.principal_kind === 'user');
  const memberLabel = session?.displayName || session?.email || 'Member';

  useEffect(() => {
    setAccountOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!accountOpen) {
      return undefined;
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setAccountOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [accountOpen]);

  const handleOpenSources = (): void => {
    openSourceReader({ sourceId: featuredDocumentId ?? '' });
  };

  const handleLogout = async (): Promise<void> => {
    if (!dataSource.logout) {
      return;
    }
    setSigningOut(true);
    try {
      await dataSource.logout();
      setAccountOpen(false);
      await refreshSession();
    } finally {
      setSigningOut(false);
    }
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

        {isSignedInMember && (
          <div className="topbar-account" ref={accountMenuRef}>
            <button
              type="button"
              className={`topbar-account-btn ${accountOpen ? 'is-open' : ''}`}
              aria-expanded={accountOpen}
              aria-haspopup="menu"
              aria-label={`Account menu for ${memberLabel}`}
              onClick={() => {
                setAccountOpen((open) => !open);
              }}
            >
              <span className="topbar-account-avatar" aria-hidden="true">
                {initialsOf(memberLabel)}
              </span>
              <span className="topbar-account-name">{memberLabel}</span>
              <span className="topbar-account-caret" aria-hidden="true">
                ▾
              </span>
            </button>

            {accountOpen && (
              <div className="topbar-account-menu" role="menu" aria-label="Account options">
                <div className="topbar-account-menu-header">
                  <strong>{memberLabel}</strong>
                  <span className="wiki-role-chip">
                    {session?.role === 'admin' ? 'Admin' : 'Editor'}
                  </span>
                </div>

                {capabilities.hasRevisionHistory && (
                  <Link
                    to="/changes"
                    role="menuitem"
                    className={`topbar-account-item ${location.pathname === '/changes' ? 'active' : ''}`}
                    onClick={() => {
                      setAccountOpen(false);
                    }}
                  >
                    Recent Changes
                  </Link>
                )}

                {capabilities.canManageSite && (
                  <Link
                    to="/admin"
                    role="menuitem"
                    className={`topbar-account-item ${location.pathname === '/admin' ? 'active' : ''}`}
                    onClick={() => {
                      setAccountOpen(false);
                    }}
                  >
                    Site Settings
                  </Link>
                )}

                {dataSource.logout && (
                  <>
                    <div className="topbar-account-divider" role="separator" />
                    <button
                      type="button"
                      role="menuitem"
                      className="topbar-account-item is-danger"
                      disabled={signingOut}
                      onClick={() => {
                        void handleLogout();
                      }}
                    >
                      {signingOut ? 'Signing out…' : 'Sign Out'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
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
