import type { ArchiveBundle, ArchiveDataSource, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import type React from 'react';
import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
import { ExplorerTopBar } from './components/ExplorerTopBar.js';
import { GlobalSearchModal } from './components/GlobalSearchModal.js';
import { ScrollMemory } from './components/ScrollMemory.js';
import { SourceInspectorDrawer } from './components/SourceInspectorDrawer.js';
import { SourceReaderDrawer } from './components/SourceReaderDrawer.js';
import { AuthStatusBanner } from './components/wiki/AuthStatusBanner.js';
import { PrivateArchiveGate } from './components/wiki/PrivateArchiveGate.js';
import type { ArchiveCapabilities, ArchiveDataLoader, ArchiveSession } from './context/ArchiveDataContext.js';
import { useArchiveData } from './context/ArchiveDataContext.js';
import { ArchiveProvider } from './context/ArchiveProvider.js';
import { cx } from './lib/cx.js';
import { IndexPage } from './pages/IndexPage.js';
import cssMod0 from './pages/IndexPage.module.css';
import { NotFoundPage } from './pages/NotFoundPage.js';
import cssMod1 from './pages/TreeAndMapPage.module.css';
import { PluginSlot, useKinloomPlugins } from './plugins/PluginContext.js';
import type { KinloomUiPlugin } from './plugins/types.js';

const uiStyles: Readonly<Record<string, string>> = { ...cssMod0, ...cssMod1 };

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
    <main id="main-content" className={cx(uiStyles, 'index-page')}>
      <output className={cx(uiStyles, 'archive-loading-shell')} aria-live="polite">
        <span className={cx(uiStyles, 'archive-loading-spinner')} aria-hidden="true" />
        <span>Loading archival view…</span>
      </output>
    </main>
  </div>
);

const RoutedAppShell: React.FC<{ siteTitle: string; baseUrl: string }> = ({ siteTitle, baseUrl }) => {
  const location = useLocation();
  const { routes: pluginRoutes } = useKinloomPlugins();
  const { bundle, loading, session } = useArchiveData();

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
      <SourceReaderDrawer />
      <SourceInspectorDrawer />
      <GlobalSearchModal />
      <PluginSlot name="appShell" className={cx(uiStyles, 'kinloom-app-shell-slot')} />
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

  const rootStyle: React.CSSProperties | undefined = siteConfig.theme?.accent
    ? ({
        '--accent-primary': siteConfig.theme.accent,
        '--radar-copresence': siteConfig.theme.accent,
      } as React.CSSProperties)
    : undefined;

  const shell = <RoutedAppShell siteTitle={siteConfig.site.title} baseUrl={resolvedBase} />;

  return (
    <div className={cx(uiStyles, 'kinloom-app')} style={rootStyle}>
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
