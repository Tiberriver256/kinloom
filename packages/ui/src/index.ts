// Root Application Shell

export type {
  BookPublishingClient,
  HttpBookPublishingClientOptions,
} from './adapters/bookPublishingClient.js';
export { createHttpBookPublishingClient } from './adapters/bookPublishingClient.js';
export type {
  CreatedAgentTokenResponse,
  CreatedInviteResponse,
  HttpWikiDataSourceOptions,
  PublicAgentTokenRecord,
} from './adapters/httpWikiDataSource.js';
// Data Transport Adapters
export {
  ApiClientError,
  createHttpWikiDataSource,
  HttpWikiDataSource,
} from './adapters/httpWikiDataSource.js';
export type {
  HttpObservabilityStatsClientOptions,
  ObservabilityStatsClient,
} from './adapters/observabilityStatsClient.js';
export { createHttpObservabilityStatsClient } from './adapters/observabilityStatsClient.js';
export type {
  HttpOpenFinanceClientOptions,
  OpenFinanceClient,
} from './adapters/openFinanceClient.js';
export { createHttpOpenFinanceClient } from './adapters/openFinanceClient.js';
export type {
  HttpPluginApiClientOptions,
  PluginApiClient,
} from './adapters/pluginApiClient.js';
export {
  createHttpPluginApiClient,
  resolvePluginRequestCredentials,
} from './adapters/pluginApiClient.js';
export type {
  HttpRecipesClientOptions,
  RecipesClient,
  StaticRecipesClientOptions,
  UpdateRecipePhotoPatch,
  UploadRecipePhotoInput,
} from './adapters/recipesClient.js';
export { createHttpRecipesClient, createStaticRecipesClient } from './adapters/recipesClient.js';
export {
  createStaticArchiveDataSource,
  StaticDemoDataSource,
} from './adapters/staticDemoDataSource.js';
export * from './browser/clientTelemetry.js';
export * from './browser/ohmStyle.js';
export type { AppErrorBoundaryProps } from './components/AppErrorBoundary.js';
export { AppErrorBoundary } from './components/AppErrorBoundary.js';
export type { ArchivalFileDropzoneProps } from './components/ArchivalFileDropzone.js';
export { ArchivalFileDropzone } from './components/ArchivalFileDropzone.js';
export type {
  ArchivalBannerProps,
  ArchivalMediaGridProps,
  ArchivalMetricsProps,
  ArchivalPageShellProps,
  ArchivalSectionProps,
  ArchivalStoryCardProps,
} from './components/ArchivalLayout.js';
export {
  ArchivalBanner,
  ArchivalMediaGrid,
  ArchivalMetrics,
  ArchivalPageShell,
  ArchivalSection,
  ArchivalStoryCard,
} from './components/ArchivalLayout.js';
export type {
  ArchivalLightboxItem,
  ArchivalLightboxProps,
} from './components/ArchivalLightbox.js';
export { ArchivalLightbox } from './components/ArchivalLightbox.js';
export type { ArchivalMarkdownProps } from './components/ArchivalMarkdown.js';
export {
  ArchivalMarkdown,
  formatNarrativeDateSpan,
  parseMarkdownBlocks,
} from './components/ArchivalMarkdown.js';
export type {
  ArchivalCardGridProps,
  ArchivalEmptyStateProps,
  ArchivalFilterBarProps,
  ArchivalOverlayProps,
  ArchivalTabItem,
  ArchivalTabsProps,
  ArchivalTagPillProps,
  ArchivalToastProps,
} from './components/ArchivalPrimitives.js';
export {
  ArchivalCardGrid,
  ArchivalDrawer,
  ArchivalEmptyState,
  ArchivalFilterBar,
  ArchivalModal,
  ArchivalTabs,
  ArchivalTagPill,
  ArchivalToast,
} from './components/ArchivalPrimitives.js';
export type {
  ArchivalImageProps,
  ArchivalImageStatus,
  PersonPortraitProps,
  PersonPortraitSize,
  PersonPortraitVariant,
} from './components/Atoms.js';
export {
  ArchivalImage,
  ArchivalPhotoFrame,
  CoordinatePill,
  DateStamp,
  initialsOf,
  PersonPortrait,
  RelativeAvatarChip,
  resolveAssetUrl,
  ScopeGlyph,
  SourceCitationTag,
} from './components/Atoms.js';
export { BlankScreenWatchdog } from './components/BlankScreenWatchdog.js';
export type {
  CitationPopoverProps,
  PopoverAnchorRect,
  PopoverCoordinates,
} from './components/CitationPopover.js';
export {
  CitationPopover,
  computeCitationPopoverPosition,
} from './components/CitationPopover.js';
// Core Explorer Components
export { ExplorerTopBar } from './components/ExplorerTopBar.js';
export { GlobalSearchModal } from './components/GlobalSearchModal.js';
export { KeyboardShortcutsDialog, QuickArchiveGuideDialog } from './components/GuideOverlays.js';
export type { InlineEntityMentionProps } from './components/InlineEntityMention.js';
export { InlineEntityMention } from './components/InlineEntityMention.js';
export { KinloomFooter, KinloomMark } from './components/KinloomFooter.js';
export type { LocalSurveyMapProps } from './components/LocalSurveyMap.js';
export { LocalSurveyMap } from './components/LocalSurveyMap.js';
export type { MediaPlayerProps } from './components/MediaPlayer.js';
export {
  formatDurationSeconds,
  isAudioMedia,
  isPdfMedia,
  isVideoMedia,
  MediaPlayer,
} from './components/MediaPlayer.js';
export { MilestoneStoryCard } from './components/MilestoneStoryCard.js';
export type { OnboardingChecklistCardProps } from './components/OnboardingChecklistCard.js';
export { OnboardingChecklistCard } from './components/OnboardingChecklistCard.js';
export type { PronunciationBadgeProps } from './components/PronunciationBadge.js';
export { PronunciationBadge } from './components/PronunciationBadge.js';
export { ScrollMemory } from './components/ScrollMemory.js';
export { SourceInspectorDrawer } from './components/SourceInspectorDrawer.js';
export { SourceReaderDrawer } from './components/SourceReaderDrawer.js';
export type { TreeFocusDrawerProps } from './components/tree/TreeFocusDrawer.js';
// Modular Tree Components
export { TreeFocusDrawer } from './components/tree/TreeFocusDrawer.js';
export type { TreeOrthogonalCanvasProps } from './components/tree/TreeOrthogonalCanvas.js';
export { TreeOrthogonalCanvas } from './components/tree/TreeOrthogonalCanvas.js';
export type { TreePedigreeRollProps } from './components/tree/TreePedigreeRoll.js';
export { TreePedigreeRoll } from './components/tree/TreePedigreeRoll.js';
export type { TreeToolbarProps } from './components/tree/TreeToolbar.js';
export { TreeToolbar } from './components/tree/TreeToolbar.js';
export { AuthStatusBanner } from './components/wiki/AuthStatusBanner.js';
export type {
  AuthErrorCode,
  AuthErrorTone,
  AuthFeedback,
  AuthProviderKind,
  AuthUrlError,
  ParsedInviteInput,
} from './components/wiki/authErrorCopy.js';
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
export type { ConflictMergeDialogProps } from './components/wiki/ConflictMergeDialog.js';
export { ConflictMergeDialog } from './components/wiki/ConflictMergeDialog.js';
export type {
  CreatableKind,
  CreateEntityModalProps,
  PersonLineageGroup,
  PersonSex,
  RelativeCreateContext,
  RelativeRelation,
} from './components/wiki/CreateEntityModal.js';
export { buildUniquePersonIdentity, CreateEntityModal } from './components/wiki/CreateEntityModal.js';
export type { EntityEditDrawerProps } from './components/wiki/EntityEditDrawer.js';
export { EntityEditDrawer } from './components/wiki/EntityEditDrawer.js';
export type {
  BuildCreatePayloadResult,
  CreateEntityDraft,
  EntityCreateFieldProps,
  EntityCreateFormEntry,
  EntityEditFieldProps,
  EntityEditFormEntry,
} from './components/wiki/entityForms/fieldTypes.js';
export type { MediaUploaderModalProps } from './components/wiki/MediaUploaderModal.js';
export { MediaUploaderModal } from './components/wiki/MediaUploaderModal.js';
export type { PrivateArchiveGateProps } from './components/wiki/PrivateArchiveGate.js';
export { PrivateArchiveGate } from './components/wiki/PrivateArchiveGate.js';
export type { PronunciationEditorSectionProps } from './components/wiki/PronunciationEditorSection.js';
export { PronunciationEditorSection } from './components/wiki/PronunciationEditorSection.js';
export type { RevisionDiffViewProps } from './components/wiki/RevisionDiffView.js';
export { RevisionDiffView } from './components/wiki/RevisionDiffView.js';
export type { RevisionHistoryPanelProps } from './components/wiki/RevisionHistoryPanel.js';
export { RevisionHistoryPanel } from './components/wiki/RevisionHistoryPanel.js';
export type { SignInModalProps } from './components/wiki/SignInModal.js';
export { SignInModal } from './components/wiki/SignInModal.js';
export type { TalkPanelProps } from './components/wiki/TalkPanel.js';
export { TalkPanel } from './components/wiki/TalkPanel.js';
export type { WikiActionBarProps, WikiEntityTab } from './components/wiki/WikiActionBar.js';
export { WikiActionBar } from './components/wiki/WikiActionBar.js';
export type {
  AuthorPillProps,
  CitationBadgeProps,
  ConflictBadgeProps,
} from './components/wiki/WikiBadges.js';
// Wiki UI Components
export { AuthorPill, CitationBadge, ConflictBadge } from './components/wiki/WikiBadges.js';
export type {
  ArchiveCapabilities,
  ArchiveDataContextValue,
  ArchiveDataLoader,
  ArchiveDataProviderProps,
  ArchiveSession,
} from './context/ArchiveDataContext.js';
// Contexts & Hooks
export {
  ArchiveDataProvider,
  createStaticArchiveLoader,
  useArchiveData,
} from './context/ArchiveDataContext.js';
export type { ArchiveProviderProps } from './context/ArchiveProvider.js';
export { ArchiveProvider } from './context/ArchiveProvider.js';
export type { ArchiveUiContextValue, PivotCrumb } from './context/ArchiveUiContext.js';
export { ArchiveUiProvider, useArchiveUi } from './context/ArchiveUiContext.js';
export type { OnboardingContextValue, TutorialLauncher } from './context/OnboardingContext.js';
export { OnboardingProvider, useOnboarding, useOptionalOnboarding } from './context/OnboardingContext.js';
export type { ThemePreferenceState } from './hooks/useThemePreference.js';
export {
  applyThemeToDocument,
  readResolvedDarkMode,
  readStoredThemePreference,
  readSystemPrefersDark,
  subscribeResolvedDarkMode,
  useThemePreference,
} from './hooks/useThemePreference.js';
export type { KinloomAppProps } from './KinloomApp.js';
export { KinloomApp } from './KinloomApp.js';
export * from './lib/adminDiagnostics.js';
export * from './lib/archivalTreeModel.js';
export * from './lib/bookPublishingModel.js';
export * from './lib/lightboxModel.js';
export * from './lib/observabilityStatsModel.js';
export * from './lib/onboardingModel.js';
export * from './lib/openFinanceModel.js';
export * from './lib/pluginNav.js';
export * from './lib/pluginSettingsForm.js';
export * from './lib/recipesModel.js';
export * from './lib/scrollMemory.js';
export * from './lib/searchNavigation.js';
export * from './lib/sourceReaderNav.js';
export * from './lib/themeModel.js';
export * from './lib/timelineScroll.js';
export * from './lib/tokens.js';
export * from './lib/treeGestures.js';
export * from './lib/treeNodeDisplay.js';
// UI-Only Helpers & Canonical Vocabulary
export * from './lib/vocabulary.js';
// XState v5 Statechart Actors
export * from './machines/index.js';
export type { AdminApiClient, AdminPageProps } from './pages/AdminPage.js';
export { AdminPage } from './pages/AdminPage.js';
export type { AdminSettingsShellProps } from './pages/admin/AdminSettingsShell.js';
export { AdminSettingsShell } from './pages/admin/AdminSettingsShell.js';
export type { PluginSettingsSectionProps } from './pages/admin/PluginSettingsSection.js';
export { PluginSettingsSection } from './pages/admin/PluginSettingsSection.js';
export type { SystemDiagnosticsSectionProps } from './pages/admin/SystemDiagnosticsSection.js';
export { SystemDiagnosticsSection } from './pages/admin/SystemDiagnosticsSection.js';
export { EvidencePage } from './pages/EvidencePage.js';
// Pages
export { IndexPage } from './pages/IndexPage.js';
export { KinshipPage } from './pages/KinshipPage.js';
export { MapPage } from './pages/MapPage.js';
export { NotFoundPage } from './pages/NotFoundPage.js';
export { PersonPage } from './pages/PersonPage.js';
export { PlacePage } from './pages/PlacePage.js';
export { PlacesIndexPage } from './pages/PlacesIndexPage.js';
export type { RecentChangesPageProps } from './pages/RecentChangesPage.js';
export { RecentChangesPage } from './pages/RecentChangesPage.js';
export { TimePage } from './pages/TimePage.js';
export { TreePage } from './pages/TreePage.js';
export type { BookPublishingUiPluginOptions } from './plugins/bookPublishingPlugin.js';
export {
  BOOK_PUBLISHING_UI_PLUGIN_ID,
  createBookPublishingPlugin,
} from './plugins/bookPublishingPlugin.js';
export type {
  ActiveNarrativeAudioTrack,
  NarrativeAudioDownloadDescriptor,
  NarrativeAudioDownloadInput,
  NarrativeAudioKind,
  NarrativeAudioLabels,
  NarrativeAudioPluginOptions,
  NarrativeAudioTrackMeta,
} from './plugins/narrativeAudioPlugin.js';
export {
  buildNarrativeAudioDownload,
  createNarrativeAudioPlugin,
  extractAudioExtension,
  readNarrativeAudioMeta,
  resolveNarrativeAudioKind,
  resolveNarrativeAudioLabels,
  sanitizeAudioFilenameStem,
} from './plugins/narrativeAudioPlugin.js';
export type { ObservabilityStatsUiPluginOptions } from './plugins/observabilityStatsPlugin.js';
export {
  createObservabilityStatsPlugin,
  OBSERVABILITY_STATS_UI_PLUGIN_ID,
} from './plugins/observabilityStatsPlugin.js';
export type { OpenFinanceUiPluginOptions } from './plugins/openFinancePlugin.js';
export {
  createOpenFinancePlugin,
  OPEN_FINANCE_UI_PLUGIN_ID,
} from './plugins/openFinancePlugin.js';
export type {
  CompiledKinloomOnboardingStep,
  KinloomPluginContextValue,
  KinloomPluginProviderProps,
  KinloomPluginRuntimeContext,
  PluginSettingsListener,
  PluginSettingsSyncEvent,
  PluginSlotProps,
} from './plugins/PluginContext.js';
// Extension & Plugin Seam
export {
  KinloomPluginProvider,
  PluginSlot,
  RESERVED_UI_ROUTE_PATHS,
  resolveDynamicPluginOnboardingSteps,
  useKinloomPluginContext,
  useKinloomPlugins,
  validateAndCompileUiPlugins,
} from './plugins/PluginContext.js';
export type { RecipesUiPluginOptions } from './plugins/recipesPlugin.js';
export { createRecipesUiPlugin, RECIPES_UI_PLUGIN_ID } from './plugins/recipesPlugin.js';
export type {
  KinloomMediaRenderer,
  KinloomMediaRendererProps,
  KinloomOnboardingContext,
  KinloomOnboardingStep,
  KinloomOnboardingStepAction,
  KinloomUiPlugin,
  KinloomUiPluginNavMinRole,
  KinloomUiPluginRoute,
  KinloomUiPluginSlotContext,
  KinloomUiPluginSlotName,
  KinloomUiPluginSlotRenderer,
  KinloomUiPluginSlots,
  OnboardingRole,
} from './plugins/types.js';
export { KINLOOM_UI_VERSION } from './version.js';
