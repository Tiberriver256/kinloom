import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { useKinloomPlugins } from '../plugins/PluginContext.js';
import { initialsOf } from './Atoms.js';
import { SignInModal } from './wiki/SignInModal.js';

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
  const headerRef = useRef<HTMLElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const headerEl = headerRef.current;
    if (!headerEl || typeof window === 'undefined') {
      return undefined;
    }
    const syncTopbarHeight = (): void => {
      const measured = Math.ceil(headerEl.getBoundingClientRect().height);
      if (measured > 0) {
        document.documentElement.style.setProperty('--topbar-height', `${measured}px`);
      }
    };
    syncTopbarHeight();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncTopbarHeight);
      return (): void => {
        window.removeEventListener('resize', syncTopbarHeight);
      };
    }
    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(headerEl);
    return (): void => {
      observer.disconnect();
    };
  }, []);

  const isPeopleActive = location.pathname === '/' || location.pathname.startsWith('/person/');
  const isPlacesActive = location.pathname === '/places' || location.pathname.startsWith('/place/');
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
    const firstMenuItem = accountDropdownRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([disabled])'
    );
    firstMenuItem?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setAccountOpen(false);
        accountTriggerRef.current?.focus();
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
      <a
        href="#main-content"
        className="skip-to-content"
        onClick={() => {
          const target = document.getElementById('main-content');
          if (target) {
            if (!target.hasAttribute('tabindex')) {
              target.setAttribute('tabindex', '-1');
            }
            target.focus();
          }
        }}
      >
        Skip to content
      </a>
      <header ref={headerRef} className="topbar">
        <div className="topbar-left">
          <Link to="/" className="brand-link">
            {siteConfig.site.title}
          </Link>

          <nav className="nav-links" aria-label="Primary">
            <Link
              to="/"
              className={`nav-pill nav-axis ${isPeopleActive ? 'active' : ''}`}
              aria-current={isPeopleActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.people}
            </Link>
            <Link
              to="/places"
              className={`nav-pill nav-axis ${isPlacesActive ? 'active' : ''}`}
              aria-current={isPlacesActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.places}
            </Link>
            <Link
              to="/time"
              className={`nav-pill nav-axis ${isTimeActive ? 'active' : ''}`}
              aria-current={isTimeActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.time}
            </Link>

            <span className="nav-divider nav-pill-desktop-only" aria-hidden="true" />

            <Link
              to="/tree"
              className={`nav-pill ${location.pathname === '/tree' ? 'active' : ''}`}
              aria-current={location.pathname === '/tree' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.tree}
            </Link>
            <Link
              to="/map"
              className={`nav-pill ${location.pathname === '/map' ? 'active' : ''}`}
              aria-current={location.pathname === '/map' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.map}
            </Link>
            <Link
              to="/kinship"
              className={`nav-pill nav-pill-desktop-only ${location.pathname === '/kinship' ? 'active' : ''}`}
              aria-current={location.pathname === '/kinship' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.kinship}
            </Link>
            <Link
              to="/evidence"
              className={`nav-pill nav-pill-desktop-only ${location.pathname === '/evidence' ? 'active' : ''}`}
              aria-current={location.pathname === '/evidence' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.evidence}
            </Link>

            {navPluginRoutes.map((route) => (
              <Link
                key={`${route.pluginId}:${route.path}`}
                to={route.path}
                className={`nav-pill ${location.pathname === route.path ? 'active' : ''}`}
                aria-current={location.pathname === route.path ? 'page' : undefined}
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

          <button type="button" className="nav-pill nav-pill-desktop-only" onClick={handleOpenSources}>
            {KINLOOM_VOCABULARY.nav.sources}
          </button>

          <button
            type="button"
            className="nav-pill nav-pill-desktop-only"
            onClick={openSearch}
            title={KINLOOM_VOCABULARY.nav.searchTooltip}
          >
            {KINLOOM_VOCABULARY.nav.searchDesktop}
          </button>

          {isInviteViewer && (
            <button
              type="button"
              className="nav-pill nav-pill-desktop-only"
              onClick={() => {
                setSignInOpen(true);
              }}
            >
              {KINLOOM_VOCABULARY.nav.signInToEdit}
            </button>
          )}

          <button
            type="button"
            className="topbar-mobile-icon-btn"
            onClick={openSearch}
            aria-label={KINLOOM_VOCABULARY.nav.searchAria}
            title={KINLOOM_VOCABULARY.nav.searchAria}
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

          <div
            className={`topbar-account ${isSignedInMember ? '' : 'topbar-account-mobile-only'}`}
            ref={accountMenuRef}
          >
            {isSignedInMember ? (
              <button
                ref={accountTriggerRef}
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
                ref={accountTriggerRef}
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
                ref={accountDropdownRef}
                className="topbar-account-menu"
                role="menu"
                aria-label={isSignedInMember ? 'Account options' : 'Archive menu'}
              >
                {isSignedInMember && (
                  <div className="topbar-account-menu-header">
                    <strong>{memberLabel}</strong>
                    <span className="wiki-role-chip">{session?.role === 'admin' ? 'Admin' : 'Editor'}</span>
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
                  {KINLOOM_VOCABULARY.nav.sources}
                </button>

                <Link
                  to="/evidence"
                  role="menuitem"
                  className={`topbar-account-item topbar-account-item-mobile-only ${location.pathname === '/evidence' ? 'active' : ''}`}
                  onClick={() => {
                    setAccountOpen(false);
                  }}
                >
                  {KINLOOM_VOCABULARY.nav.evidenceFull}
                </Link>

                <Link
                  to="/kinship"
                  role="menuitem"
                  className={`topbar-account-item topbar-account-item-mobile-only ${location.pathname === '/kinship' ? 'active' : ''}`}
                  onClick={() => {
                    setAccountOpen(false);
                  }}
                >
                  {KINLOOM_VOCABULARY.nav.kinshipFull}
                </Link>

                {isSignedInMember && capabilities.hasRevisionHistory && (
                  <Link
                    to="/changes"
                    role="menuitem"
                    className={`topbar-account-item ${location.pathname === '/changes' ? 'active' : ''}`}
                    onClick={() => {
                      setAccountOpen(false);
                    }}
                  >
                    {KINLOOM_VOCABULARY.nav.recentChanges}
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
                    {KINLOOM_VOCABULARY.nav.siteSettings}
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
