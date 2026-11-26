export type {
  AssetHandler,
  KinloomServerPlugin,
  KinloomServerPluginContext,
  KinloomServerPluginRoute,
  KinloomServerPorts,
  PluginRouteMinRole,
} from '@kinloom/core';

export const KINLOOM_SERVER_VERSION = '0.19.0';

// Errors & Web-Standard Crypto Helpers
export { KinloomHttpError, toErrorResponseData } from './errors.js';
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

// Layer 2: Pure Use-Case Services
export { AuthService, sanitizeNextPath, type AuthServiceDeps } from './services/authService.js';
export { WikiWriteService, type WikiWriteServiceDeps } from './services/wikiWriteService.js';
export {
  BundleReadService,
  type BundleReadServiceDeps,
  type ExportSnapshotResult,
  type ExportYamlResult,
  type GetBundleResult,
} from './services/bundleReadService.js';
export {
  MediaService,
  parseHttpByteRange,
  type MediaServiceDeps,
} from './services/mediaService.js';
export { TalkService, type TalkServiceDeps } from './services/talkService.js';
export {
  AdminService,
  type AdminServiceDeps,
  type PublicAgentTokenRecord,
} from './services/adminService.js';

// Layer 1: Portable Web-Fetch HTTP Transport
export {
  DEV_OAUTH_COOKIE_NAME,
  DEV_SESSION_COOKIE_NAME,
  PROD_OAUTH_COOKIE_NAME,
  PROD_SESSION_COOKIE_NAME,
  getOAuthCookieName,
  getSessionCookieName,
  isSecureRequestUrl,
  parseCookies,
  readOAuthCookieRaw,
  readSessionCookieRaw,
  serializeClearCookie,
  serializeSetCookie,
  signOAuthStateToken,
  signSessionToken,
  verifyOAuthStateToken,
  verifySessionToken,
  type OAuthStateCookiePayload,
  type SessionCookiePayload,
} from './http/session.js';
export {
  enforceCsrfOrigin,
  principalToRevisionAuthor,
  requireMinRole,
  resolveCallerPrincipal,
  type AuthMethod,
  type ResolvedAuthContext,
} from './http/authMiddleware.js';
export {
  createKinloomServer,
  type KinloomServer,
  type KinloomServerConfig,
} from './http/router.js';

// Layer 4: Portable Built-in Adapters
export { FixedClock, SystemClock } from './adapters/systemClock.js';
export {
  GoogleOAuthProvider,
  type GoogleOAuthProviderConfig,
} from './adapters/googleOAuthProvider.js';
export {
  FakeAuthProvider,
  InMemoryArchiveRepository,
  InMemoryEmailSender,
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  createInMemoryServerPorts,
  extractCollectionsFromSnapshot,
  type FakeOAuthProfile,
  type InMemoryServerPortsBundle,
  type SentMagicLinkEmail,
} from './adapters/inMemory.js';
