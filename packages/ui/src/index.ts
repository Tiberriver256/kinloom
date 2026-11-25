// Root Application Shell
export { KinloomApp } from './KinloomApp.js';
export type { KinloomAppProps } from './KinloomApp.js';

// Contexts & Hooks
export {
  ArchiveDataProvider,
  createStaticArchiveLoader,
  useArchiveData,
} from './context/ArchiveDataContext.js';
export type {
  ArchiveCapabilities,
  ArchiveDataContextValue,
  ArchiveDataLoader,
  ArchiveDataProviderProps,
  ArchiveSession,
} from './context/ArchiveDataContext.js';
export { ArchiveUiProvider, useArchiveUi } from './context/ArchiveUiContext.js';
export type { ArchiveUiContextValue, PivotCrumb } from './context/ArchiveUiContext.js';
export { ArchiveProvider } from './context/ArchiveProvider.js';

// Pages
export { IndexPage } from './pages/IndexPage.js';
export { PersonPage } from './pages/PersonPage.js';
export { PlacePage } from './pages/PlacePage.js';
export { PlacesIndexPage } from './pages/PlacesIndexPage.js';
export { TimePage } from './pages/TimePage.js';
export { TreePage } from './pages/TreePage.js';
export { MapPage } from './pages/MapPage.js';
export { KinshipPage } from './pages/KinshipPage.js';
export { EvidencePage } from './pages/EvidencePage.js';

// Components
export { ExplorerTopBar } from './components/ExplorerTopBar.js';
export { GlobalSearchModal } from './components/GlobalSearchModal.js';
export { SourceInspectorDrawer } from './components/SourceInspectorDrawer.js';
export { SourceReaderDrawer } from './components/SourceReaderDrawer.js';
export { LocalSurveyMap } from './components/LocalSurveyMap.js';
export type { LocalSurveyMapProps } from './components/LocalSurveyMap.js';
export { MilestoneStoryCard } from './components/MilestoneStoryCard.js';
export {
  ArchivalPhotoFrame,
  CoordinatePill,
  DateStamp,
  RelativeAvatarChip,
  ScopeGlyph,
  SourceCitationTag,
  initialsOf,
  resolveAssetUrl,
} from './components/Atoms.js';
export { AppErrorBoundary } from './components/AppErrorBoundary.js';
export type { AppErrorBoundaryProps } from './components/AppErrorBoundary.js';
export { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
export { ScrollMemory } from './components/ScrollMemory.js';
export { KinloomFooter, KinloomMark } from './components/KinloomFooter.js';

// UI-Only Helpers
export * from './lib/ohmStyle.js';
export * from './lib/scrollMemory.js';
export * from './lib/searchNavigation.js';
export * from './lib/sourceReaderNav.js';
export * from './lib/timelineScroll.js';
export * from './lib/treeGestures.js';
export * from './lib/clientTelemetry.js';
