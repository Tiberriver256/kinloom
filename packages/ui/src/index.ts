// Root Application Shell
export { KinloomApp } from './KinloomApp.js';
export type { KinloomAppProps } from './KinloomApp.js';

// Data Transport Adapters
export {
  ApiClientError,
  HttpWikiDataSource,
  createHttpWikiDataSource,
} from './adapters/httpWikiDataSource.js';
export type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  HttpWikiDataSourceOptions,
  PublicAgentTokenRecord,
} from './adapters/httpWikiDataSource.js';
export {
  StaticDemoDataSource,
  createStaticArchiveDataSource,
} from './adapters/staticDemoDataSource.js';

// Extension & Plugin Seam
export { KinloomPluginProvider, PluginSlot, useKinloomPlugins } from './plugins/PluginContext.js';
export type {
  KinloomPluginContextValue,
  KinloomPluginProviderProps,
  PluginSlotProps,
} from './plugins/PluginContext.js';
export {
  createNarrativeAudioPlugin,
  readNarrativeAudioMeta,
} from './plugins/narrativeAudioPlugin.js';
export type {
  ActiveNarrativeAudioTrack,
  NarrativeAudioPluginOptions,
  NarrativeAudioTrackMeta,
} from './plugins/narrativeAudioPlugin.js';
export type {
  KinloomMediaRenderer,
  KinloomMediaRendererProps,
  KinloomUiPlugin,
  KinloomUiPluginRoute,
  KinloomUiPluginSlotContext,
  KinloomUiPluginSlotName,
  KinloomUiPluginSlotRenderer,
  KinloomUiPluginSlots,
} from './plugins/types.js';

// XState v5 Statechart Actors
export * from './machines/index.js';

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
export type { ArchiveProviderProps } from './context/ArchiveProvider.js';

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
export { RecentChangesPage } from './pages/RecentChangesPage.js';
export type { RecentChangesPageProps } from './pages/RecentChangesPage.js';
export { AdminPage } from './pages/AdminPage.js';
export type { AdminApiClient, AdminPageProps } from './pages/AdminPage.js';

// Core Explorer Components
export { ExplorerTopBar } from './components/ExplorerTopBar.js';
export { GlobalSearchModal } from './components/GlobalSearchModal.js';
export { SourceInspectorDrawer } from './components/SourceInspectorDrawer.js';
export { SourceReaderDrawer } from './components/SourceReaderDrawer.js';
export { LocalSurveyMap } from './components/LocalSurveyMap.js';
export type { LocalSurveyMapProps } from './components/LocalSurveyMap.js';
export { MilestoneStoryCard } from './components/MilestoneStoryCard.js';
export {
  MediaPlayer,
  formatDurationSeconds,
  isAudioMedia,
  isPdfMedia,
  isVideoMedia,
} from './components/MediaPlayer.js';
export type { MediaPlayerProps } from './components/MediaPlayer.js';
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
export {
  ArchivalMarkdown,
  formatNarrativeDateSpan,
  parseMarkdownBlocks,
} from './components/ArchivalMarkdown.js';
export type { ArchivalMarkdownProps } from './components/ArchivalMarkdown.js';
export { InlineEntityMention } from './components/InlineEntityMention.js';
export type { InlineEntityMentionProps } from './components/InlineEntityMention.js';
export { PronunciationBadge } from './components/PronunciationBadge.js';
export type { PronunciationBadgeProps } from './components/PronunciationBadge.js';
export {
  CitationPopover,
  computeCitationPopoverPosition,
} from './components/CitationPopover.js';
export type {
  CitationPopoverProps,
  PopoverAnchorRect,
  PopoverCoordinates,
} from './components/CitationPopover.js';
export { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
export { ScrollMemory } from './components/ScrollMemory.js';
export { KinloomFooter, KinloomMark } from './components/KinloomFooter.js';

// Wiki UI Components
export { AuthorPill, CitationBadge, ConflictBadge } from './components/wiki/WikiBadges.js';
export type {
  AuthorPillProps,
  CitationBadgeProps,
  ConflictBadgeProps,
} from './components/wiki/WikiBadges.js';
export { WikiActionBar } from './components/wiki/WikiActionBar.js';
export type { WikiActionBarProps, WikiEntityTab } from './components/wiki/WikiActionBar.js';
export { RevisionDiffView } from './components/wiki/RevisionDiffView.js';
export type { RevisionDiffViewProps } from './components/wiki/RevisionDiffView.js';
export { ConflictMergeDialog } from './components/wiki/ConflictMergeDialog.js';
export type { ConflictMergeDialogProps } from './components/wiki/ConflictMergeDialog.js';
export { EntityEditDrawer } from './components/wiki/EntityEditDrawer.js';
export type { EntityEditDrawerProps } from './components/wiki/EntityEditDrawer.js';
export { CreateEntityModal, buildUniquePersonIdentity } from './components/wiki/CreateEntityModal.js';
export type {
  CreatableKind,
  CreateEntityModalProps,
  PersonLineageGroup,
  PersonSex,
  RelativeCreateContext,
  RelativeRelation,
} from './components/wiki/CreateEntityModal.js';
export { RevisionHistoryPanel } from './components/wiki/RevisionHistoryPanel.js';
export type { RevisionHistoryPanelProps } from './components/wiki/RevisionHistoryPanel.js';
export { MediaUploaderModal } from './components/wiki/MediaUploaderModal.js';
export type { MediaUploaderModalProps } from './components/wiki/MediaUploaderModal.js';
export { TalkPanel } from './components/wiki/TalkPanel.js';
export type { TalkPanelProps } from './components/wiki/TalkPanel.js';
export { SignInModal } from './components/wiki/SignInModal.js';
export type { SignInModalProps } from './components/wiki/SignInModal.js';
export { AuthStatusBanner } from './components/wiki/AuthStatusBanner.js';
export { PrivateArchiveGate } from './components/wiki/PrivateArchiveGate.js';
export type { PrivateArchiveGateProps } from './components/wiki/PrivateArchiveGate.js';
export {
  consumeAuthErrorFromWindow,
  getCleanNextPath,
  normalizeAuthErrorCode,
  normalizeAuthProvider,
  parseInviteInput,
  readAuthErrorFromSearch,
  resolveAuthFeedback,
  resolveClientAuthError,
  stripAuthErrorParams,
  validateEmailInput,
} from './components/wiki/authErrorCopy.js';
export type {
  AuthErrorCode,
  AuthErrorTone,
  AuthFeedback,
  AuthProviderKind,
  AuthUrlError,
  ParsedInviteInput,
} from './components/wiki/authErrorCopy.js';

// UI-Only Helpers
export * from './lib/archivalTreeModel.js';
export * from './lib/ohmStyle.js';
export * from './lib/scrollMemory.js';
export * from './lib/searchNavigation.js';
export * from './lib/sourceReaderNav.js';
export * from './lib/timelineScroll.js';
export * from './lib/treeGestures.js';
export * from './lib/treeNodeDisplay.js';
export * from './lib/clientTelemetry.js';

// Modular Tree Components
export { TreeFocusDrawer } from './components/tree/TreeFocusDrawer.js';
export type { TreeFocusDrawerProps } from './components/tree/TreeFocusDrawer.js';
export { TreeOrthogonalCanvas } from './components/tree/TreeOrthogonalCanvas.js';
export type { TreeOrthogonalCanvasProps } from './components/tree/TreeOrthogonalCanvas.js';
export { TreePedigreeRoll } from './components/tree/TreePedigreeRoll.js';
export type { TreePedigreeRollProps } from './components/tree/TreePedigreeRoll.js';
export { TreeToolbar } from './components/tree/TreeToolbar.js';
export type { TreeToolbarProps } from './components/tree/TreeToolbar.js';
