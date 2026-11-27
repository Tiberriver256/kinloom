export type {
  AssetHandler,
  KinloomServerPluginContext,
  KinloomServerPluginReadonlySettingsContext,
  KinloomServerPluginRoute,
  KinloomServerPluginSettingsUpdatedEvent,
  PluginRouteMinRole,
  PluginSettingsStore,
  PronunciationAudioGenerator,
  PronunciationAudioResult,
  PronunciationLexiconStore,
  StoredPluginSecretMetadata,
  StoredPluginSettingsRecord,
} from '@kinloom/core';
export { extractCollectionsFromSnapshot } from '@kinloom/core';
export {
  GoogleOAuthProvider,
  type GoogleOAuthProviderConfig,
} from './adapters/googleOAuthProvider.js';
export {
  createInMemoryArchiveRepository,
  createInMemoryServerPorts,
  FakeAuthProvider,
  type FakeOAuthProfile,
  InMemoryArchiveRepository,
  type InMemoryArchiveRepositoryOptions,
  InMemoryEmailSender,
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPluginSettingsStore,
  InMemoryPronunciationLexiconStore,
  type InMemoryServerPortsBundle,
  type SentMagicLinkEmail,
} from './adapters/inMemory.js';
// Layer 4: Portable Built-in Adapters
export { FixedClock, SystemClock } from './adapters/systemClock.js';
export {
  base64UrlDecodeBytes,
  base64UrlDecodeString,
  base64UrlEncodeBytes,
  base64UrlEncodeString,
  bytesToStream,
  generateEntityId,
  hmacSignBase64Url,
  hmacVerifyBase64Url,
  matchesIfNoneMatch,
  pkceChallengeFromVerifier,
  randomBase64Url,
  randomBytes,
  readBodyToString,
  readStreamToBytes,
  sha256Bytes,
  sha256Hex,
  toHex,
} from './crypto.js';
// Errors & Web-Standard Crypto Helpers
export { KinloomHttpError, toErrorResponseData } from './errors.js';
export {
  type AuthMethod,
  enforceCsrfOrigin,
  principalToRevisionAuthor,
  type ResolvedAuthContext,
  requireMinRole,
  resolveCallerPrincipal,
} from './http/authMiddleware.js';
export {
  type AgentTokenRejectedReason,
  type CompiledDocumentContributions,
  type CompiledRoutePrefixMatcher,
  type CsrfRejectedReason,
  compilePluginDocumentContributions,
  finalizeServerResponse,
  hasRequestLifecyclePlugins,
  hasSecurityEventPlugins,
  type InviteInvalidReason,
  injectHtmlSnippets,
  isApiOrBundleRoute,
  isHtmlDocumentResponse,
  type KinloomServerPlugin,
  type KinloomServerPorts,
  type MagicLinkInvalidReason,
  type MediaUploadRejectedReason,
  normalizeServerRouteTemplate,
  type OAuthFailureReason,
  type RecordableServerTimingSpanName,
  SERVER_SECURITY_EVENT_TYPES,
  type ServerDocumentContributions,
  type ServerPluginObservabilityFlags,
  type ServerPrivacyDisclosure,
  type ServerRequestErrorEvent,
  type ServerRequestResponseEvent,
  type ServerRequestStartEvent,
  type ServerRequestTelemetryContext,
  type ServerSecurityEvent,
  type ServerSecurityEventBase,
  type ServerSecurityEventPayload,
  type ServerSecurityEventType,
  type ServerTelemetryCacheStatus,
  type ServerTimingSpanName,
  sanitizeMediaContentType,
  type WriteForbiddenReason,
} from './http/pluginLifecycle.js';
export {
  DEFAULT_RECENT_ERROR_CAPACITY,
  RecentErrorRingBuffer,
} from './http/recentErrorBuffer.js';
export { sanitizeDiagnosticDetail } from './http/redaction.js';
export {
  type AuthBrowserProvider,
  buildAuthErrorRedirectUrl,
  type CompiledPluginRoute,
  createKinloomServer,
  isBrowserNavigation,
  type KinloomServer,
  type KinloomServerConfig,
  type KinloomServerFetchOptions,
  mapAuthErrorToBrowserCode,
  RESERVED_SERVER_ROUTE_PREFIXES,
  validateAndCompilePluginRoutes,
} from './http/router.js';
export {
  createPrivacyAndOgRouteHandler,
  type DynamicOgRequestOptions,
  handleDynamicOgRequest,
  type PrivacyAndOgRouteHandlerDeps,
  type RenderPrivacyPolicyOptions,
  renderPrivacyPolicyHtml,
} from './http/routes/privacyAndOgRoutes.js';
export {
  type ApplySecurityHeadersOptions,
  applySecurityHeaders,
  buildContentSecurityPolicy,
  DEFAULT_CONTENT_SECURITY_POLICY,
  MEDIA_CONTENT_SECURITY_POLICY,
  type ServerCspDirectiveAdditions,
  STRICT_TRANSPORT_SECURITY_VALUE,
} from './http/securityHeaders.js';
// Layer 1: Portable Web-Fetch HTTP Transport
export {
  DEV_OAUTH_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  getOAuthCookieName,
  getSessionCookieName,
  isSecureRequestUrl,
  type OAuthStateCookiePayload,
  PROD_OAUTH_COOKIE_NAME,
  PROD_SESSION_COOKIE_NAME,
  parseCookies,
  readOAuthCookieRaw,
  readSessionCookieRaw,
  type SessionCookiePayload,
  serializeClearCookie,
  serializeSetCookie,
  signOAuthStateToken,
  signSessionToken,
  verifyOAuthStateToken,
  verifySessionToken,
} from './http/session.js';
export {
  createPronunciationPlugin,
  PRONUNCIATION_PLUGIN_ID,
  type PronunciationFallbackBackend,
  type PronunciationPhonemeMode,
  type PronunciationPluginOptions,
  type PronunciationPluginRuntimeConfig,
  type PronunciationTtsBackend,
} from './plugins/pronunciationPlugin.js';
export {
  buildSecurityTelemetryLogRecord,
  CLOUDFLARE_WEB_ANALYTICS_BEACON_URL,
  CLOUDFLARE_WEB_ANALYTICS_CONNECT_ORIGIN,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_DISCLOSURE_ID,
  CLOUDFLARE_WEB_ANALYTICS_PRIVACY_SUMMARY,
  CLOUDFLARE_WEB_ANALYTICS_SCRIPT_ORIGIN,
  type CloudflareWebAnalyticsToken,
  createSecurityTelemetryHandler,
  createWebAnalyticsDocumentContributions,
  createWorkersObservabilityPlugin,
  defaultSecurityTelemetrySink,
  formatServerTimingHeader,
  isCloudflareWebAnalyticsToken,
  isSecurityTelemetryEnabled,
  isWebAnalyticsEnabled,
  redactObservabilityText,
  renderCloudflareWebAnalyticsBeaconHtml,
  resolveObservabilityRequestId,
  type SecurityTelemetryAlertSink,
  type SecurityTelemetryLogLevel,
  type SecurityTelemetryLogRecord,
  type SecurityTelemetryOptions,
  type SecurityTelemetrySink,
  sanitizeObservabilityErrorCode,
  validateCloudflareWebAnalyticsToken,
  type WebAnalyticsOptions,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogLevel,
  type WorkersObservabilityLogRecord,
  type WorkersObservabilityPluginOptions,
  type WorkersObservabilitySink,
  type WorkersSecurityTelemetryOption,
} from './plugins/workersObservability.js';
export {
  AdminService,
  type AdminServiceDeps,
  type PublicAgentTokenRecord,
} from './services/adminService.js';
// Layer 2: Pure Use-Case Services
export { AuthService, type AuthServiceDeps, sanitizeNextPath } from './services/authService.js';
export {
  BundleReadService,
  type BundleReadServiceDeps,
  type ExportSnapshotResult,
  type ExportYamlResult,
  type GetBundleResult,
} from './services/bundleReadService.js';
export {
  MediaService,
  type MediaServiceDeps,
  matchesMagicBytesForMime,
  parseHttpByteRange,
} from './services/mediaService.js';
export {
  PluginSettingsService,
  type PluginSettingsServiceDeps,
} from './services/pluginSettingsService.js';
export {
  type GenerateEntityPronunciationInput,
  PronunciationService,
  type PronunciationServiceDeps,
  type UpsertLexiconTermInput,
} from './services/pronunciationService.js';
export {
  type KinloomServerDiagnosticsConfig,
  SystemDiagnosticsService,
  type SystemDiagnosticsServiceDeps,
} from './services/systemDiagnosticsService.js';
export { TalkService, type TalkServiceDeps } from './services/talkService.js';
export { WikiWriteService, type WikiWriteServiceDeps } from './services/wikiWriteService.js';
export { KINLOOM_SERVER_VERSION } from './version.js';
