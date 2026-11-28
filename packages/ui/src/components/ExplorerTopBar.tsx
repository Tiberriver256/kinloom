import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useArchiveData } from '../context/ArchiveDataContext.js';
import { useArchiveUi } from '../context/ArchiveUiContext.js';
import { useOptionalOnboarding } from '../context/OnboardingContext.js';
import { useThemePreference } from '../hooks/useThemePreference.js';
import { cx, joinClasses } from '../lib/cx.js';
import { isPluginNavRouteActive, selectVisiblePluginNavRoutes } from '../lib/pluginNav.js';
import { KINLOOM_VOCABULARY } from '../lib/vocabulary.js';
import { AuthSessionActorContext } from '../machines/authSessionMachine.js';
import { PluginSlot, useKinloomPlugins } from '../plugins/PluginContext.js';
import type { KinloomUiPluginRoute } from '../plugins/types.js';
import controlStyles from '../styles/Controls.module.css';
import { initialsOf } from './Atoms.js';
import topBarStyles from './ExplorerTopBar.module.css';
import { SignInModal } from './wiki/SignInModal.js';
import wikiChromeStyles from './wiki/WikiChrome.module.css';

export interface ActiveOverflowNavSection {
  readonly id: string;
  readonly label: string;
  readonly inDesktopAccountMenu: boolean;
}

export function resolveOverflowNavSection(
  pathname: string,
  navPluginRoutes: readonly (Pick<KinloomUiPluginRoute, 'path' | 'navLabel' | 'navMatchPrefix'> & {
    readonly pluginId: string;
  })[]
): ActiveOverflowNavSection | null {
  if (pathname === '/evidence') {
    return {
      id: 'evidence',
      label: KINLOOM_VOCABULARY.nav.evidence,
      inDesktopAccountMenu: false,
    };
  }
  if (pathname === '/kinship') {
    return {
      id: 'kinship',
      label: KINLOOM_VOCABULARY.nav.kinship,
      inDesktopAccountMenu: false,
    };
  }
  if (pathname === '/changes') {
    return {
      id: 'changes',
      label: KINLOOM_VOCABULARY.nav.recentChanges,
      inDesktopAccountMenu: true,
    };
  }
  if (pathname === '/admin') {
    return {
      id: 'admin',
      label: KINLOOM_VOCABULARY.nav.siteSettings,
      inDesktopAccountMenu: true,
    };
  }
  const activePlugin = navPluginRoutes.find((route) => isPluginNavRouteActive(route, pathname));
  if (activePlugin) {
    return {
      id: `plugin:${activePlugin.pluginId}:${activePlugin.path}`,
      label: activePlugin.navLabel ?? activePlugin.pluginId,
      inDesktopAccountMenu: false,
    };
  }
  return null;
}

export const ExplorerTopBar: React.FC = () => {
  const { siteConfig, featuredDocumentId, capabilities, session, dataSource } = useArchiveData();
  const authActorRef = AuthSessionActorContext.useActorRef();
  const signingOut = AuthSessionActorContext.useSelector((state) => state.matches('signingOut'));
  const { activeYear, pivotTrail, openSourceReader, openSearch } = useArchiveUi();
  const onboarding = useOptionalOnboarding();
  const { preference, systemTheme, isDark, setPreference, toggleQuickTheme } = useThemePreference();
  const { routes: pluginRoutes } = useKinloomPlugins();
  const location = useLocation();
  const navigate = useNavigate();
  const navPluginRoutes = selectVisiblePluginNavRoutes(pluginRoutes, session, capabilities);

  const disclosureMenuId = useId();
  const guideMenuId = useId();
  const [accountOpen, setAccountOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const accountTriggerRef = useRef<HTMLButtonElement | null>(null);
  const accountDropdownRef = useRef<HTMLElement | null>(null);
  const guideMenuRef = useRef<HTMLDivElement | null>(null);
  const guideTriggerRef = useRef<HTMLButtonElement | null>(null);
  const guideDropdownRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const headerEl = headerRef.current;
    if (!headerEl || typeof window === 'undefined') {
      return undefined;
    }
    let cancelled = false;
    const syncTopbarHeight = (): void => {
      if (cancelled) {
        return;
      }
      const measured = Math.floor(headerEl.getBoundingClientRect().height);
      if (measured > 0) {
        document.documentElement.style.setProperty('--topbar-height', `${measured}px`);
      }
    };
    syncTopbarHeight();
    void document.fonts?.ready?.then(syncTopbarHeight);
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', syncTopbarHeight);
      return (): void => {
        cancelled = true;
        window.removeEventListener('resize', syncTopbarHeight);
      };
    }
    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(headerEl);
    return (): void => {
      cancelled = true;
      observer.disconnect();
    };
  }, []);

  const isPeopleActive = location.pathname === '/' || location.pathname.startsWith('/person/');
  const isPlacesActive = location.pathname === '/places' || location.pathname.startsWith('/place/');
  const isTimeActive = location.pathname === '/time';
  const activeOverflowSection = resolveOverflowNavSection(location.pathname, navPluginRoutes);

  const isSignedInMember = Boolean(session?.authenticated && session.principal_kind === 'user');
  const isInviteViewer = Boolean(session && session.principal_kind === 'invite_viewer');
  const memberLabel = session?.displayName || session?.email || 'Member';

  // biome-ignore lint/correctness/useExhaustiveDependencies: close menus when route pathname changes
  useEffect(() => {
    setAccountOpen(false);
    setGuideOpen(false);
    setChapterPickerOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!guideOpen) {
      return undefined;
    }
    const items = [
      ...(guideDropdownRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []),
    ];
    items[0]?.focus();
    const onPointerDown = (event: PointerEvent): void => {
      if (guideMenuRef.current && !guideMenuRef.current.contains(event.target as Node)) {
        setGuideOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setGuideOpen(false);
        guideTriggerRef.current?.focus();
        return;
      }
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length > 0) {
        event.preventDefault();
        const activeIdx = items.indexOf(document.activeElement as HTMLElement);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const nextIdx = activeIdx === -1 ? 0 : (activeIdx + delta + items.length) % items.length;
        items[nextIdx]?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [guideOpen]);

  useEffect(() => {
    if (!accountOpen) {
      return undefined;
    }
    const firstMenuItem = accountDropdownRef.current?.querySelector<HTMLElement>(
      'a[href], button:not([disabled])'
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
    setGuideOpen(false);
    openSourceReader({ sourceId: featuredDocumentId ?? '' });
  };

  const handleOpenChecklist = (): void => {
    setAccountOpen(false);
    setGuideOpen(false);
    if (!onboarding) {
      return;
    }
    onboarding.reopenChecklist();
    const targetPath = onboarding.role === 'admin' ? '/admin' : '/';
    if (location.pathname !== targetPath) {
      navigate(targetPath);
    }
    window.setTimeout(() => {
      const el = document.getElementById('onboarding-checklist');
      el?.focus({ preventScroll: false });
    }, 0);
  };

  const handleOpenGuideDialog = (chapterId?: string): void => {
    setAccountOpen(false);
    setGuideOpen(false);
    setChapterPickerOpen(false);
    onboarding?.openGuide(chapterId);
  };

  const handleOpenShortcuts = (): void => {
    setAccountOpen(false);
    setGuideOpen(false);
    onboarding?.openShortcutsDialog();
  };

  const handleResetOnboarding = (): void => {
    setAccountOpen(false);
    setGuideOpen(false);
    onboarding?.resetProgress();
  };

  const handleLogout = (): void => {
    if (!dataSource.logout) {
      return;
    }
    setAccountOpen(false);
    authActorRef.send({ type: 'SIGN_OUT' });
  };

  return (
    <>
      {/* biome-ignore lint/a11y/useValidAnchor: skip-to-content landmark anchor */}
      <a
        href="#main-content"
        className={cx(controlStyles, 'skip-to-content')}
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
      <header ref={headerRef} className={cx(topBarStyles, 'topbar')}>
        <div className={cx(topBarStyles, 'topbar-left')}>
          <Link to="/" className={cx(topBarStyles, 'brand-link')}>
            {siteConfig.site.title}
          </Link>

          <nav className={cx(topBarStyles, 'nav-links')} aria-label="Primary">
            <Link
              to="/"
              className={cx(topBarStyles, `nav-pill ${isPeopleActive ? 'active' : ''}`)}
              aria-current={isPeopleActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.people}
            </Link>
            <Link
              to="/places"
              className={cx(topBarStyles, `nav-pill ${isPlacesActive ? 'active' : ''}`)}
              aria-current={isPlacesActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.places}
            </Link>
            <Link
              to="/evidence"
              className={cx(
                topBarStyles,
                `nav-pill nav-pill-desktop-only ${location.pathname === '/evidence' ? 'active' : ''}`
              )}
              aria-current={location.pathname === '/evidence' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.evidence}
            </Link>

            <span className={cx(topBarStyles, 'nav-divider nav-pill-desktop-only')} aria-hidden="true" />

            <Link
              to="/time"
              className={cx(topBarStyles, `nav-pill ${isTimeActive ? 'active' : ''}`)}
              aria-current={isTimeActive ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.time}
            </Link>
            <Link
              to="/tree"
              className={cx(topBarStyles, `nav-pill ${location.pathname === '/tree' ? 'active' : ''}`)}
              aria-current={location.pathname === '/tree' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.tree}
            </Link>
            <Link
              to="/map"
              className={cx(topBarStyles, `nav-pill ${location.pathname === '/map' ? 'active' : ''}`)}
              aria-current={location.pathname === '/map' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.map}
            </Link>
            <Link
              to="/kinship"
              className={cx(
                topBarStyles,
                `nav-pill nav-pill-desktop-only ${location.pathname === '/kinship' ? 'active' : ''}`
              )}
              aria-current={location.pathname === '/kinship' ? 'page' : undefined}
            >
              {KINLOOM_VOCABULARY.nav.kinship}
            </Link>

            {navPluginRoutes.map((route) => {
              const isActive = isPluginNavRouteActive(route, location.pathname);
              return (
                <Link
                  key={`${route.pluginId}:${route.path}`}
                  to={route.path}
                  className={cx(topBarStyles, `nav-pill ${isActive ? 'active' : ''}`)}
                  aria-current={isActive ? 'page' : undefined}
                >
                  {route.navIcon && (
                    <span className={cx(topBarStyles, 'nav-pill-icon')} aria-hidden="true">
                      {route.navIcon}
                    </span>
                  )}
                  <span>{route.navLabel}</span>
                </Link>
              );
            })}
            <PluginSlot name="topBarNav" className={cx(topBarStyles, 'topbar-nav-plugin-slot')} />
          </nav>
        </div>

        <div className={cx(topBarStyles, 'topbar-center')}>
          {activeYear !== null && location.pathname.startsWith('/person/') && (
            <Link
              to={`/time?year=${activeYear}`}
              className={cx(topBarStyles, 'year-readout')}
              aria-live="polite"
              title={`Active timeline year ${activeYear} — click to see where everyone was in ${activeYear}`}
            >
              {activeYear}
            </Link>
          )}

          <button
            type="button"
            className={cx(topBarStyles, 'topbar-utility-btn nav-pill-desktop-only')}
            onClick={handleOpenSources}
          >
            {KINLOOM_VOCABULARY.nav.sources}
          </button>

          <button
            type="button"
            className={cx(topBarStyles, 'topbar-utility-btn nav-search-btn nav-pill-desktop-only')}
            onClick={openSearch}
            aria-label={KINLOOM_VOCABULARY.nav.searchDesktop}
            title={KINLOOM_VOCABULARY.nav.searchTooltip}
          >
            <span>Search</span> <kbd className="kl-kbd">/</kbd>
          </button>

          <button
            type="button"
            className={cx(topBarStyles, 'topbar-theme-btn')}
            onClick={toggleQuickTheme}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
            title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {isDark ? (
              <svg
                width="17"
                height="17"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.65"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="10" cy="10" r="3.5" />
                <path d="M10 2.5V4.2M10 15.8V17.5M2.5 10H4.2M15.8 10H17.5M4.7 4.7L5.9 5.9M14.1 14.1L15.3 15.3M15.3 4.7L14.1 5.9M5.9 14.1L4.7 15.3" />
              </svg>
            ) : (
              <svg
                width="17"
                height="17"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.65"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M16.2 12.6A6.5 6.5 0 0 1 7.4 3.8a6.5 6.5 0 1 0 8.8 8.8Z" />
              </svg>
            )}
          </button>

          {isInviteViewer && (
            <button
              type="button"
              className={cx(topBarStyles, 'topbar-utility-btn nav-pill-desktop-only')}
              onClick={() => {
                setSignInOpen(true);
              }}
            >
              {KINLOOM_VOCABULARY.nav.signInToEdit}
            </button>
          )}

          <button
            type="button"
            className={cx(topBarStyles, 'topbar-mobile-icon-btn')}
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
            className={joinClasses(
              cx(wikiChromeStyles, 'topbar-account'),
              cx(topBarStyles, isSignedInMember ? '' : 'topbar-account-mobile-only')
            )}
            ref={accountMenuRef}
          >
            {isSignedInMember ? (
              <button
                ref={accountTriggerRef}
                type="button"
                className={joinClasses(
                  cx(wikiChromeStyles, `topbar-account-btn ${accountOpen ? 'is-open' : ''}`),
                  activeOverflowSection ? cx(topBarStyles, 'topbar-menu-active-mobile') : '',
                  activeOverflowSection?.inDesktopAccountMenu
                    ? cx(topBarStyles, 'topbar-menu-active-desktop')
                    : ''
                )}
                aria-expanded={accountOpen}
                aria-controls={disclosureMenuId}
                aria-label={`Account menu for ${memberLabel}`}
                aria-description={
                  activeOverflowSection ? `Current section: ${activeOverflowSection.label}` : undefined
                }
                data-active-section={activeOverflowSection?.label}
                title={
                  activeOverflowSection
                    ? `Account menu (${activeOverflowSection.label})`
                    : `Account menu for ${memberLabel}`
                }
                onClick={() => {
                  setAccountOpen((open) => !open);
                }}
              >
                <span className={cx(wikiChromeStyles, 'topbar-account-avatar')} aria-hidden="true">
                  {initialsOf(memberLabel)}
                </span>
                <span className={cx(wikiChromeStyles, 'topbar-account-name')}>{memberLabel}</span>
                <svg
                  className={cx(wikiChromeStyles, 'topbar-account-caret')}
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
                className={cx(
                  topBarStyles,
                  `topbar-mobile-icon-btn ${accountOpen ? 'is-open' : ''} ${activeOverflowSection ? 'topbar-menu-active-mobile' : ''}`
                )}
                aria-expanded={accountOpen}
                aria-controls={disclosureMenuId}
                aria-label="Archive menu"
                aria-description={
                  activeOverflowSection ? `Current section: ${activeOverflowSection.label}` : undefined
                }
                data-active-section={activeOverflowSection?.label}
                title={
                  activeOverflowSection ? `Archive menu (${activeOverflowSection.label})` : 'Archive menu'
                }
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
              <nav
                id={disclosureMenuId}
                ref={accountDropdownRef}
                className={joinClasses(
                  cx(wikiChromeStyles, 'topbar-account-menu'),
                  cx(topBarStyles, 'topbar-disclosure-panel')
                )}
                aria-label={isSignedInMember ? 'Account options' : 'Archive menu'}
              >
                {isSignedInMember && (
                  <div className={cx(wikiChromeStyles, 'topbar-account-menu-header')}>
                    <strong>{memberLabel}</strong>
                    <span className={cx(wikiChromeStyles, 'wiki-role-chip')}>
                      {session?.role === 'admin' ? 'Admin' : 'Editor'}
                    </span>
                  </div>
                )}

                {isInviteViewer && (
                  <div className={cx(wikiChromeStyles, 'topbar-account-menu-header')}>
                    <strong>
                      {session?.inviteLabel ? `Invite: ${session.inviteLabel}` : 'Family Invite'}
                    </strong>
                    <span className={cx(wikiChromeStyles, 'wiki-role-chip')}>Viewer</span>
                  </div>
                )}

                <ul className={cx(topBarStyles, 'topbar-disclosure-list')}>
                  {isInviteViewer && (
                    <li>
                      <button
                        type="button"
                        className={cx(wikiChromeStyles, 'topbar-account-item')}
                        onClick={() => {
                          setAccountOpen(false);
                          setSignInOpen(true);
                        }}
                      >
                        Sign in to edit
                      </button>
                    </li>
                  )}

                  <li className={cx(topBarStyles, 'topbar-account-item-mobile-only')}>
                    <button
                      type="button"
                      className={cx(wikiChromeStyles, 'topbar-account-item')}
                      onClick={handleOpenSources}
                    >
                      {KINLOOM_VOCABULARY.nav.sources}
                    </button>
                  </li>

                  <li className={cx(topBarStyles, 'topbar-account-item-mobile-only')}>
                    <Link
                      to="/evidence"
                      className={joinClasses(
                        cx(wikiChromeStyles, 'topbar-account-item'),
                        location.pathname === '/evidence' ? 'active' : ''
                      )}
                      aria-current={location.pathname === '/evidence' ? 'page' : undefined}
                      onClick={() => {
                        setAccountOpen(false);
                      }}
                    >
                      {KINLOOM_VOCABULARY.nav.evidenceFull}
                    </Link>
                  </li>

                  <li className={cx(topBarStyles, 'topbar-account-item-mobile-only')}>
                    <Link
                      to="/kinship"
                      className={joinClasses(
                        cx(wikiChromeStyles, 'topbar-account-item'),
                        location.pathname === '/kinship' ? 'active' : ''
                      )}
                      aria-current={location.pathname === '/kinship' ? 'page' : undefined}
                      onClick={() => {
                        setAccountOpen(false);
                      }}
                    >
                      {KINLOOM_VOCABULARY.nav.kinshipFull}
                    </Link>
                  </li>

                  {navPluginRoutes.map((route) => {
                    const isActive = isPluginNavRouteActive(route, location.pathname);
                    return (
                      <li
                        key={`mobile:${route.pluginId}:${route.path}`}
                        className={cx(topBarStyles, 'topbar-account-item-mobile-only')}
                      >
                        <Link
                          to={route.path}
                          className={joinClasses(
                            cx(wikiChromeStyles, 'topbar-account-item'),
                            isActive ? 'active' : ''
                          )}
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => {
                            setAccountOpen(false);
                          }}
                        >
                          {route.navIcon && (
                            <span className={cx(topBarStyles, 'nav-pill-icon')} aria-hidden="true">
                              {route.navIcon}
                            </span>
                          )}
                          <span>{route.navLabel}</span>
                        </Link>
                      </li>
                    );
                  })}

                  <PluginSlot name="topBarMobileMenu" as="fragment" />

                  {onboarding && (
                    <li
                      className={cx(topBarStyles, 'topbar-account-item-mobile-only topbar-mobile-guide-li')}
                    >
                      <div className={cx(wikiChromeStyles, 'topbar-account-divider')} role="separator" />
                      <div
                        className={cx(wikiChromeStyles, 'topbar-theme-group')}
                        role="group"
                        aria-label="Guide and help"
                      >
                        <div className={cx(wikiChromeStyles, 'topbar-theme-group-label')} aria-hidden="true">
                          Guide &amp; Tutorials
                        </div>
                        <button
                          type="button"
                          className={cx(wikiChromeStyles, 'topbar-account-item')}
                          onClick={() => {
                            handleOpenGuideDialog();
                          }}
                        >
                          Interactive Tutorials
                        </button>
                        <button
                          type="button"
                          className={cx(wikiChromeStyles, 'topbar-account-item')}
                          onClick={handleOpenChecklist}
                        >
                          Getting Started Checklist
                        </button>
                        <button
                          type="button"
                          className={cx(wikiChromeStyles, 'topbar-account-item')}
                          onClick={handleOpenShortcuts}
                        >
                          Keyboard Shortcuts
                        </button>
                        <button
                          type="button"
                          className={cx(wikiChromeStyles, 'topbar-account-item')}
                          onClick={handleResetOnboarding}
                        >
                          Reset Tutorial &amp; Onboarding Progress
                        </button>
                      </div>
                    </li>
                  )}

                  {isSignedInMember && capabilities.hasRevisionHistory && (
                    <li>
                      <Link
                        to="/changes"
                        className={cx(
                          wikiChromeStyles,
                          `topbar-account-item ${location.pathname === '/changes' ? 'active' : ''}`
                        )}
                        aria-current={location.pathname === '/changes' ? 'page' : undefined}
                        onClick={() => {
                          setAccountOpen(false);
                        }}
                      >
                        {KINLOOM_VOCABULARY.nav.recentChanges}
                      </Link>
                    </li>
                  )}

                  {isSignedInMember && capabilities.canManageSite && (
                    <li>
                      <Link
                        to="/admin"
                        className={cx(
                          wikiChromeStyles,
                          `topbar-account-item ${location.pathname === '/admin' ? 'active' : ''}`
                        )}
                        aria-current={location.pathname === '/admin' ? 'page' : undefined}
                        onClick={() => {
                          setAccountOpen(false);
                        }}
                      >
                        {KINLOOM_VOCABULARY.nav.siteSettings}
                      </Link>
                    </li>
                  )}

                  <li>
                    <div className={cx(wikiChromeStyles, 'topbar-account-divider')} role="separator" />
                    <div
                      className={cx(wikiChromeStyles, 'topbar-theme-group')}
                      role="radiogroup"
                      aria-label="Appearance"
                    >
                      <div className={cx(wikiChromeStyles, 'topbar-theme-group-label')} aria-hidden="true">
                        Appearance
                      </div>
                      {(
                        [
                          { value: 'light', label: 'Light', ariaLabel: 'Light theme' },
                          { value: 'dark', label: 'Dark', ariaLabel: 'Dark theme' },
                          {
                            value: 'system',
                            label: `System (${systemTheme})`,
                            ariaLabel: `System theme (currently ${systemTheme})`,
                          },
                        ] as const
                      ).map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={preference === option.value}
                          aria-label={option.ariaLabel}
                          className={cx(
                            wikiChromeStyles,
                            `topbar-account-item topbar-theme-option ${preference === option.value ? 'active' : ''}`
                          )}
                          onClick={() => {
                            setPreference(option.value);
                          }}
                        >
                          <span className={cx(wikiChromeStyles, 'topbar-theme-check')} aria-hidden="true">
                            {preference === option.value ? '●' : '○'}
                          </span>
                          <span>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  </li>

                  {isSignedInMember && dataSource.logout && (
                    <li className={cx(topBarStyles, 'topbar-disclosure-danger-item')}>
                      <button
                        type="button"
                        className={cx(wikiChromeStyles, 'topbar-account-item is-danger')}
                        disabled={signingOut}
                        onClick={() => {
                          handleLogout();
                        }}
                      >
                        {signingOut ? 'Signing out…' : 'Sign Out'}
                      </button>
                    </li>
                  )}
                </ul>
              </nav>
            )}
          </div>

          {onboarding && (
            <div
              className={joinClasses(
                cx(wikiChromeStyles, 'topbar-account'),
                cx(topBarStyles, 'nav-pill-desktop-only topbar-guide-desktop-only')
              )}
              ref={guideMenuRef}
            >
              <button
                ref={guideTriggerRef}
                type="button"
                className={cx(topBarStyles, `topbar-utility-btn nav-guide-btn ${guideOpen ? 'active' : ''}`)}
                aria-label="Guide"
                aria-haspopup="menu"
                aria-expanded={guideOpen}
                aria-controls={guideMenuId}
                onClick={() => {
                  setAccountOpen(false);
                  setChapterPickerOpen(false);
                  setGuideOpen((open) => !open);
                }}
              >
                <span>Guide</span>
                {onboarding.tutorialCatalog.totalCount > 0 &&
                  onboarding.tutorialCatalog.completedCount < onboarding.tutorialCatalog.totalCount && (
                    <span
                      className={cx(topBarStyles, 'topbar-guide-badge')}
                      aria-hidden="true"
                      title={`${onboarding.tutorialCatalog.completedCount} of ${onboarding.tutorialCatalog.totalCount} chapters completed`}
                    >
                      {onboarding.tutorialCatalog.completedCount}/{onboarding.tutorialCatalog.totalCount}
                    </span>
                  )}
              </button>
              {guideOpen && (
                <div
                  id={guideMenuId}
                  ref={guideDropdownRef}
                  role="menu"
                  aria-label="Guide and help"
                  className={joinClasses(
                    cx(wikiChromeStyles, 'topbar-account-menu'),
                    cx(topBarStyles, 'topbar-disclosure-panel')
                  )}
                >
                  <button
                    type="button"
                    role="menuitem"
                    aria-label="Interactive Tutorials"
                    className={cx(wikiChromeStyles, 'topbar-account-item')}
                    onClick={() => {
                      handleOpenGuideDialog();
                    }}
                  >
                    <span>Interactive Tutorials</span>
                    {onboarding.tutorialCatalog.totalCount > 0 && (
                      <span className={cx(topBarStyles, 'topbar-guide-badge')} aria-hidden="true">
                        {onboarding.tutorialCatalog.completedCount}/{onboarding.tutorialCatalog.totalCount}
                      </span>
                    )}
                  </button>
                  {onboarding.tutorialCatalog.chapters.length > 0 && (
                    <>
                      <button
                        type="button"
                        role="menuitem"
                        aria-expanded={chapterPickerOpen}
                        className={cx(wikiChromeStyles, 'topbar-account-item')}
                        onClick={() => {
                          setChapterPickerOpen((open) => !open);
                        }}
                      >
                        <span>Jump to chapter…</span>
                        <span aria-hidden="true">{chapterPickerOpen ? '▴' : '▾'}</span>
                      </button>
                      {chapterPickerOpen && (
                        <div
                          className={cx(topBarStyles, 'topbar-guide-chapter-list')}
                          role="group"
                          aria-label="Tutorial chapters"
                        >
                          {onboarding.tutorialCatalog.chapters.map((chapter) => (
                            <button
                              key={chapter.id}
                              type="button"
                              role="menuitem"
                              className={cx(wikiChromeStyles, 'topbar-account-item')}
                              onClick={() => {
                                handleOpenGuideDialog(chapter.id);
                              }}
                            >
                              <span>{chapter.title}</span>
                              {onboarding.state.completed_chapter_ids.includes(chapter.id) && (
                                <>
                                  <span className={cx(topBarStyles, 'topbar-guide-badge')} aria-hidden="true">
                                    ✓
                                  </span>
                                  <span className="visually-hidden"> (completed)</span>
                                </>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <button
                    type="button"
                    role="menuitem"
                    className={cx(wikiChromeStyles, 'topbar-account-item')}
                    onClick={handleOpenChecklist}
                  >
                    Getting Started Checklist
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={cx(wikiChromeStyles, 'topbar-account-item')}
                    onClick={handleOpenShortcuts}
                  >
                    Keyboard Shortcuts
                  </button>
                  <div className={cx(wikiChromeStyles, 'topbar-account-divider')} role="separator" />
                  <button
                    type="button"
                    role="menuitem"
                    className={cx(wikiChromeStyles, 'topbar-account-item')}
                    onClick={handleResetOnboarding}
                  >
                    Reset Tutorial &amp; Onboarding Progress
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {pivotTrail.length > 1 && location.pathname.startsWith('/person/') && (
          <div className={cx(topBarStyles, 'topbar-right')}>
            <nav className={cx(topBarStyles, 'breadcrumb-strip')} aria-label="Recent pivot trail">
              <span>Trail:</span>
              {pivotTrail.slice(-3).map((c, idx) => (
                <React.Fragment key={c.slug}>
                  {idx > 0 && <span>→</span>}
                  <Link to={`/person/${c.slug}`}>{c.name}</Link>
                </React.Fragment>
              ))}
            </nav>
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
