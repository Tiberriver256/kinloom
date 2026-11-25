import type { ArchiveBundle, KinloomSiteConfig, ReadingsBundle } from '@kinloom/core';
import type { ArchiveCapabilities, ArchiveDataLoader, ArchiveSession } from './context/ArchiveDataContext.js';
import { BrowserRouter, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import React, { Suspense, lazy, useEffect } from 'react';
import { AppErrorBoundary } from './components/AppErrorBoundary.js';
import { ArchiveProvider } from './context/ArchiveProvider.js';
import { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
import { ExplorerTopBar } from './components/ExplorerTopBar.js';
import { GlobalSearchModal } from './components/GlobalSearchModal.js';
import { IndexPage } from './pages/IndexPage.js';
import { ScrollMemory } from './components/ScrollMemory.js';
import { SourceInspectorDrawer } from './components/SourceInspectorDrawer.js';
import { SourceReaderDrawer } from './components/SourceReaderDrawer.js';

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
  baseUrl?: string;
  initialBundle?: ArchiveBundle | null;
  initialReadings?: ReadingsBundle | null;
  session?: ArchiveSession | null;
  capabilities?: ArchiveCapabilities;
  /**
   * Optional MemoryRouter initial entries for unit/component tests.
   * When omitted, uses BrowserRouter with `baseUrl`.
   */
  initialEntries?: string[];
}

const RouteLoading: React.FC = () => (
  <div>
    <ExplorerTopBar />
    <main className="index-page">
      <output className="archive-loading-shell" aria-live="polite">
        <span className="archive-loading-spinner" aria-hidden="true" />
        <span>Loading archival view…</span>
      </output>
    </main>
  </div>
);

const RoutedAppShell: React.FC<{ siteTitle: string; baseUrl: string }> = ({
  siteTitle,
  baseUrl,
}) => {
  const location = useLocation();
  return (
    <>
      <BlankScreenWatchdog />
      <AppErrorBoundary key={location.pathname} siteTitle={siteTitle} baseUrl={baseUrl}>
        <ScrollMemory />
        <Suspense fallback={<RouteLoading />}>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route path="/person/:slug" element={<PersonPage />} />
            <Route path="/places" element={<PlacesIndexPage />} />
            <Route path="/place/:slug" element={<PlacePage />} />
            <Route path="/time" element={<TimePage />} />
            <Route path="/tree" element={<TreePage />} />
            <Route path="/map" element={<MapPage />} />
            <Route path="/kinship" element={<KinshipPage />} />
            <Route path="/evidence" element={<EvidencePage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AppErrorBoundary>
      <SourceReaderDrawer />
      <SourceInspectorDrawer />
      <GlobalSearchModal />
    </>
  );
};

export const KinloomApp: React.FC<KinloomAppProps> = ({
  siteConfig,
  loader,
  baseUrl,
  initialBundle,
  initialReadings,
  session,
  capabilities,
  initialEntries,
}) => {
  const resolvedBase =
    baseUrl ??
    ((typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/');
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
    <div className="kinloom-app" style={rootStyle}>
      <AppErrorBoundary siteTitle={siteConfig.site.title} baseUrl={resolvedBase}>
        <ArchiveProvider
          siteConfig={siteConfig}
          loader={loader}
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
