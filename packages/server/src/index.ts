export type {
  AssetHandler,
  KinloomServerPlugin,
  KinloomServerPluginContext,
  KinloomServerPluginRoute,
  PluginRouteMinRole,
} from '@kinloom/core';
export type {
  KinloomServerPorts,
  PronunciationAudioGenerator,
  PronunciationAudioResult,
  PronunciationLexiconStore,
} from './ports.js';

export const KINLOOM_SERVER_VERSION = '0.39.0';

export {
  GoogleOAuthProvider,
  type GoogleOAuthProviderConfig,
} from './adapters/googleOAuthProvider.js';
export {
  createInMemoryServerPorts,
  extractCollectionsFromSnapshot,
  FakeAuthProvider,
  type FakeOAuthProfile,
  InMemoryArchiveRepository,
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
  type AuthBrowserProvider,
  buildAuthErrorRedirectUrl,
  createKinloomServer,
  isBrowserNavigation,
  type KinloomServer,
  type KinloomServerConfig,
  mapAuthErrorToBrowserCode,
} from './http/router.js';
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
export { TalkService, type TalkServiceDeps } from './services/talkService.js';
export { WikiWriteService, type WikiWriteServiceDeps } from './services/wikiWriteService.js';
