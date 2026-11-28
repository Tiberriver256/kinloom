import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import type React from 'react';
import { lazy, Suspense, useEffect, useRef } from 'react';
import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { registerKinloomServiceWorker } from './browser/registerServiceWorker.js';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import statusShellStyles from './components/ArchiveStatusShell.module.css';
import { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
import { ExplorerTopBar } from './components/ExplorerTopBar.js';
import { ScrollMemory } from './components/ScrollMemory.js';
import { AuthStatusBanner } from './components/wiki/AuthStatusBanner.js';
import { PrivateArchiveGate } from './components/wiki/PrivateArchiveGate.js';
import type { ArchiveCapabilities, ArchiveDataLoader, ArchiveSession } from './context/ArchiveDataContext.js';
import { useArchiveData } from './context/ArchiveDataContext.js';
import { ArchiveProvider } from './context/ArchiveProvider.js';
import { useArchiveUi } from './context/ArchiveUiContext.js';
import { useOptionalOnboarding } from './context/OnboardingContext.js';
import { cx } from './lib/cx.js';
import { readTutorialQueryParam, stripTutorialQueryParam } from './lib/tutorialModel.js';
import { IndexPage } from './pages/IndexPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PluginSlot, useKinloomPlugins } from './plugins/PluginContext.js';
import type { KinloomUiPlugin } from './plugins/types.js';
import layoutStyles from './styles/Layout.module.css';

const AdminPage = lazy(async () => {
  const module = await import('./pages/AdminPage.js');
  return { default: module.AdminPage };
});
const EvidencePage = lazy(async () => {
  const module = await import('./pages/EvidencePage.js');
  return { default: module.EvidencePage };
});
const KinshipPage = lazy(async () => {
  const module = await import('./pages/KinshipPage.js');
  return { default: module.KinshipPage };
});
const MapPage = lazy(async () => {
  const module = await import('./pages/MapPage.js');
  return { default: module.MapPage };
});
const PersonPage = lazy(async () => {
  const module = await import('./pages/PersonPage.js');
  return { default: module.PersonPage };
});
const PlacePage = lazy(async () => {
  const module = await import('./pages/PlacePage.js');
  return { default: module.PlacePage };
});
const PlacesIndexPage = lazy(async () => {
  const module = await import('./pages/PlacesIndexPage.js');
  return { default: module.PlacesIndexPage };
});
const RecentChangesPage = lazy(async () => {
  const module = await import('./pages/RecentChangesPage.js');
  return { default: module.RecentChangesPage };
});
const TimePage = lazy(async () => {
  const module = await import('./pages/TimePage.js');
  return { default: module.TimePage };
});
const TreePage = lazy(async () => {
  const module = await import('./pages/TreePage.js');
  return { default: module.TreePage };
});
const LazyGlobalSearchModal = lazy(async () => {
  const module = await import('./components/GlobalSearchModal.js');
  return { default: module.GlobalSearchModal };
});
const LazySourceReaderDrawer = lazy(async () => {
  const module = await import('./components/SourceReaderDrawer.js');
  return { default: module.SourceReaderDrawer };
});
const LazySourceInspectorDrawer = lazy(async () => {
  const module = await import('./components/SourceInspectorDrawer.js');
  return { default: module.SourceInspectorDrawer };
});
const LazyKeyboardShortcutsDialog = lazy(async () => {
  const module = await import('./components/GuideOverlays.js');
  return { default: module.KeyboardShortcutsDialog };
});
const LazyTutorialModal = lazy(async () => {
  const module = await import('./components/tutorials/TutorialModal.js');
  return { default: module.TutorialModal };
});

export interface KinloomAppProps {
  siteConfig: KinloomSiteConfig;
  loader?: ArchiveDataLoader;
  dataSource?: ArchiveDataSource;
  plugins?: readonly KinloomUiPlugin[];
  baseUrl?: string;
  initialBundle?: ArchiveBundle | null;
  initialReadings?: ReadingsBundle | null;
  session?: ArchiveSession | null;
  capabilities?: Partial<ArchiveCapabilities>;
  /**
   * Optional MemoryRouter initial entries for unit/component tests.
   * When omitted, uses BrowserRouter with `baseUrl`.
   */
  initialEntries?: string[];
}

const RouteLoading: React.FC = () => (
  <div>
    <ExplorerTopBar />
    <main id="main-content" className={cx(layoutStyles, 'index-page')}>
      <output className={cx(statusShellStyles, 'archive-loading-shell')} aria-live="polite">
        <span className={cx(statusShellStyles, 'archive-loading-spinner')} aria-hidden="true" />
        <span>Loading archival view…</span>
      </output>
    </main>
  </div>
);

const LazyShellOverlays: React.FC = () => {
  const { searchOpen, sourceReader, sourceInspector } = useArchiveUi();
  const onboarding = useOptionalOnboarding();
  return (
    <Suspense fallback={null}>
      {sourceReader !== null && <LazySourceReaderDrawer />}
      {sourceInspector !== null && <LazySourceInspectorDrawer />}
      {searchOpen && <LazyGlobalSearchModal />}
      {onboarding?.shortcutsDialogOpen && <LazyKeyboardShortcutsDialog />}
      {onboarding?.tutorialModalOpen && <LazyTutorialModal />}
    </Suspense>
  );
};

const RoutedAppShell: React.FC<{ siteTitle: string; baseUrl: string }> = ({ siteTitle, baseUrl }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { routes: pluginRoutes } = useKinloomPlugins();
  const { bundle, loading, session } = useArchiveData();
  const { searchOpen } = useArchiveUi();
  const onboarding = useOptionalOnboarding();
  const recordSignal = onboarding?.recordSignal;
  const autoOpenedForSessionRef = useRef<string | null>(null);
  const tutorialQueryOpenRef = useRef<boolean>(false);

  useEffect(() => {
    if (!recordSignal) {
      return;
    }
    if (location.pathname.startsWith('/person/')) {
      recordSignal('person_visit');
    } else if (location.pathname === '/changes') {
      recordSignal('changes_visit');
    }
  }, [location.pathname, recordSignal]);

  // First-login interactive tutorial modal auto-open (fires once per account session, never stacked).
  const sessionKey = session?.principal_kind === 'user' ? (session.email ?? 'user') : 'anon';
  const openTutorial = onboarding?.openTutorial;
  const hydrated = Boolean(onboarding?.hydrated);
  const shouldAutoOpen = Boolean(onboarding?.shouldAutoOpenTutorialModal);
  const shortcutsOpen = Boolean(onboarding?.shortcutsDialogOpen);
  const tutorialOpen = Boolean(onboarding?.tutorialModalOpen);
  const visibleChapters = onboarding?.tutorialCatalog.chapters;

  useEffect(() => {
    if (!openTutorial || !hydrated || !shouldAutoOpen) {
      return;
    }
    if (autoOpenedForSessionRef.current === sessionKey) {
      return;
    }
    if (searchOpen || shortcutsOpen || tutorialOpen) {
      return;
    }
    autoOpenedForSessionRef.current = sessionKey;
    openTutorial({ autoOpened: true });
  }, [openTutorial, hydrated, shouldAutoOpen, sessionKey, searchOpen, shortcutsOpen, tutorialOpen]);

  // URL deep-link ?tutorial=<chapterId>: open authorized chapter and strip param on close without pushing history.
  const requestedTutorialFromUrl = readTutorialQueryParam(location.search);
  useEffect(() => {
    if (!openTutorial || !requestedTutorialFromUrl || !visibleChapters) {
      return;
    }
    if (tutorialQueryOpenRef.current) {
      return;
    }
    if (!visibleChapters.some((chapter) => chapter.id === requestedTutorialFromUrl)) {
      return;
    }
    tutorialQueryOpenRef.current = true;
    openTutorial({ chapterId: requestedTutorialFromUrl, autoOpened: false });
  }, [openTutorial, requestedTutorialFromUrl, visibleChapters]);

  useEffect(() => {
    if (!tutorialQueryOpenRef.current || tutorialOpen) {
      return;
    }
    tutorialQueryOpenRef.current = false;
    if (readTutorialQueryParam(location.search) !== null) {
      navigate(
        {
          pathname: location.pathname,
          search: stripTutorialQueryParam(location.search),
          hash: location.hash,
        },
        { replace: true }
      );
    }
  }, [tutorialOpen, location.pathname, location.search, location.hash, navigate]);

  if (!loading && bundle === null && session?.principal_kind === 'anonymous') {
    return (
      <>
        <BlankScreenWatchdog />
        <PrivateArchiveGate />
      </>
    );
  }

  return (
    <>
      <BlankScreenWatchdog />
      <AuthStatusBanner />
      <AppErrorBoundary key={location.pathname} siteTitle={siteTitle} baseUrl={baseUrl}>
        <ScrollMemory />
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="/people" element={<Navigate to="/" replace />} />
            <Route path="/person/:slug" element={<PersonPage />} />
            <Route path="/places" element={<PlacesIndexPage />} />
            <Route path="/place/:slug" element={<PlacePage />} />
            <Route path="/time" element={<TimePage />} />
            <Route path="/tree" element={<TreePage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/kinship" element={<KinshipPage />} />
            <Route path="/evidence" element={<EvidencePage />} />
            <Route path="/changes" element={<RecentChangesPage />} />
            <Route path="/admin" element={<AdminPage />} />
            {pluginRoutes.map((route) => {
              const PluginComponent = route.component;
              return (
                <Route
                  key={`${route.pluginId}:${route.path}`}
                  path={route.path}
                  element={<PluginComponent />}
                />
              );
            })}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </Suspense>
      </AppErrorBoundary>
      <LazyShellOverlays />
      <PluginSlot name="appShell" className={'kinloom-app-shell-slot'} />
    </>
  );
};

export const KinloomApp: React.FC<KinloomAppProps> = ({
  siteConfig,
  loader,
  dataSource,
  plugins,
  baseUrl,
  initialBundle,
  initialReadings,
  session,
  capabilities,
  initialEntries,
}) => {
  const resolvedBase = baseUrl ?? ((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/');
  const routerBasename = resolvedBase.replace(/\/$/, '') || '/';

  useEffect(() => {
    if (typeof document !== 'undefined' && siteConfig.site.title) {
      document.title = siteConfig.site.title;
    }
  }, [siteConfig.site.title]);

  useEffect(() => {
    if (initialEntries) {
      return;
    }
    void registerKinloomServiceWorker({ baseUrl: resolvedBase });
  }, [initialEntries, resolvedBase]);

  const rootStyle: React.CSSProperties | undefined =
    siteConfig.theme?.accent || siteConfig.theme?.accentDark
      ? ({
          ...(siteConfig.theme.accent ? { '--site-accent-light': siteConfig.theme.accent } : {}),
          ...(siteConfig.theme.accentDark ? { '--site-accent-dark': siteConfig.theme.accentDark } : {}),
        } as React.CSSProperties)
      : undefined;

  const shell = <RoutedAppShell siteTitle={siteConfig.site.title} baseUrl={resolvedBase} />;

  return (
    <div className={cx(statusShellStyles, 'kinloom-app')} style={rootStyle}>
      <AppErrorBoundary siteTitle={siteConfig.site.title} baseUrl={resolvedBase}>
        <ArchiveProvider
          siteConfig={siteConfig}
          loader={loader}
          dataSource={dataSource}
          plugins={plugins}
          baseUrl={resolvedBase}
          initialBundle={initialBundle}
          initialReadings={initialReadings}
          session={session}
          capabilities={capabilities}
        >
          {initialEntries ? (
            <MemoryRouter initialEntries={initialEntries}>{shell}</MemoryRouter>
          ) : (
            <BrowserRouter basename={routerBasename}>{shell}</BrowserRouter>
          )}
        </ArchiveProvider>
      </AppErrorBoundary>
    </div>
  );
};
