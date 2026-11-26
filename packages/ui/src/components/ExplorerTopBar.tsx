import { Link, useLocation } from 'react-router-dom';
import React, { useEffect, useRef, useState } from 'react';
import { SignInModal } from './wiki/SignInModal.js';
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
  const [signInOpen, setSignInOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const isPeopleActive =
    location.pathname === '/' || location.pathname.startsWith('/person/');
  const isPlacesActive =
    location.pathname === '/places' || location.pathname.startsWith('/place/');
  const isTimeActive = location.pathname === '/time';

  const isSignedInMember = Boolean(session?.authenticated && session.principal_kind === 'user');
  const isInviteViewer = Boolean(session && session.principal_kind === 'invite_viewer');
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
    setAccountOpen(false);
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
    <>
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

        {isInviteViewer && (
          <button
            type="button"
            className="nav-pill nav-pill-desktop-only"
            onClick={() => {
              setSignInOpen(true);
            }}
          >
            Sign in to edit
          </button>
        )}

        <button
          type="button"
          className="topbar-mobile-icon-btn"
          onClick={openSearch}
          aria-label="Search full archive"
          title="Search full archive"
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="5.5" />
            <path d="M12.2 12.2L16 16" />
          </svg>
        </button>

        <div className={`topbar-account ${isSignedInMember ? '' : 'topbar-account-mobile-only'}`} ref={accountMenuRef}>
          {isSignedInMember ? (
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
              <svg
                className="topbar-account-caret"
                width="10"
                height="10"
                viewBox="0 0 12 12"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 4.5L6 7.5L9 4.5" />
              </svg>
            </button>
          ) : (
            <button
              type="button"
              className={`topbar-mobile-icon-btn ${accountOpen ? 'is-open' : ''}`}
              aria-expanded={accountOpen}
              aria-haspopup="menu"
              aria-label="Archive menu"
              title="Archive menu"
              onClick={() => {
                setAccountOpen((open) => !open);
              }}
            >
              <svg
                width="17"
                height="17"
                viewBox="0 0 18 18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="M3 5h12M3 9h12M3 13h12" />
              </svg>
            </button>
          )}

          {accountOpen && (
            <div
              className="topbar-account-menu"
              role="menu"
              aria-label={isSignedInMember ? 'Account options' : 'Archive menu'}
            >
              {isSignedInMember && (
                <div className="topbar-account-menu-header">
                  <strong>{memberLabel}</strong>
                  <span className="wiki-role-chip">
                    {session?.role === 'admin' ? 'Admin' : 'Editor'}
                  </span>
                </div>
              )}

              {isInviteViewer && (
                <>
                  <div className="topbar-account-menu-header">
                    <strong>
                      {session?.inviteLabel ? `Invite: ${session.inviteLabel}` : 'Family Invite'}
                    </strong>
                    <span className="wiki-role-chip">Viewer</span>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    className="topbar-account-item"
                    onClick={() => {
                      setAccountOpen(false);
                      setSignInOpen(true);
                    }}
                  >
                    Sign in to edit
                  </button>
                  <div className="topbar-account-divider" role="separator" />
                </>
              )}

              <button
                type="button"
                role="menuitem"
                className="topbar-account-item topbar-account-item-mobile-only"
                onClick={handleOpenSources}
              >
                Primary Sources
              </button>

              {isSignedInMember && capabilities.hasRevisionHistory && (
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

              {isSignedInMember && capabilities.canManageSite && (
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

              {isSignedInMember && dataSource.logout && (
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
      {isInviteViewer && (
        <SignInModal
          open={signInOpen}
          inviteLabel={session?.inviteLabel}
          onClose={() => {
            setSignInOpen(false);
          }}
        />
      )}
    </>
  );
};
