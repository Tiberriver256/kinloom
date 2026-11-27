export type {
  AssetHandler,
  KinloomServerPluginContext,
  KinloomServerPluginRoute,
  PluginRouteMinRole,
  PronunciationAudioGenerator,
  PronunciationAudioResult,
  PronunciationLexiconStore,
} from '@kinloom/core';
export { extractCollectionsFromSnapshot } from '@kinloom/core';

export const KINLOOM_SERVER_VERSION = '0.40.1';

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
  type CompiledRoutePrefixMatcher,
  hasRequestLifecyclePlugins,
  isApiOrBundleRoute,
  type KinloomServerPlugin,
  type KinloomServerPorts,
  normalizeServerRouteTemplate,
  type RecordableServerTimingSpanName,
  type ServerRequestErrorEvent,
  type ServerRequestResponseEvent,
  type ServerRequestStartEvent,
  type ServerRequestTelemetryContext,
  type ServerTelemetryCacheStatus,
  type ServerTimingSpanName,
} from './http/pluginLifecycle.js';
export {
  type AuthBrowserProvider,
  buildAuthErrorRedirectUrl,
  type CompiledPluginRoute,
  createKinloomServer,
  isBrowserNavigation,
  type KinloomServer,
  type KinloomServerConfig,
  mapAuthErrorToBrowserCode,
  RESERVED_SERVER_ROUTE_PREFIXES,
  validateAndCompilePluginRoutes,
} from './http/router.js';
export {
  createPrivacyAndOgRouteHandler,
  type DynamicOgRequestOptions,
  handleDynamicOgRequest,
  type PrivacyAndOgRouteHandlerDeps,
  renderPrivacyPolicyHtml,
} from './http/routes/privacyAndOgRoutes.js';
export {
  type ApplySecurityHeadersOptions,
  applySecurityHeaders,
  DEFAULT_CONTENT_SECURITY_POLICY,
  MEDIA_CONTENT_SECURITY_POLICY,
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
  createWorkersObservabilityPlugin,
  formatServerTimingHeader,
  redactObservabilityText,
  resolveObservabilityRequestId,
  sanitizeObservabilityErrorCode,
  WORKERS_OBSERVABILITY_PLUGIN_ID,
  type WorkersObservabilityLogLevel,
  type WorkersObservabilityLogRecord,
  type WorkersObservabilityPluginOptions,
  type WorkersObservabilitySink,
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
  type GenerateEntityPronunciationInput,
  PronunciationService,
  type PronunciationServiceDeps,
  type UpsertLexiconTermInput,
} from './services/pronunciationService.js';
export { TalkService, type TalkServiceDeps } from './services/talkService.js';
export { WikiWriteService, type WikiWriteServiceDeps } from './services/wikiWriteService.js';
