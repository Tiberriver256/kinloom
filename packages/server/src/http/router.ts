import { z } from 'zod';
import {
  asBatchId,
  asRevisionId,
  AuthorTypeSchema,
  BatchSubmissionSchema,
  EntityDeleteInputSchema,
  EntityRestoreInputSchema,
  EntityTypeSchema,
  EntityUpdateInputSchema,
  EntityWriteInputSchema,
  type EntityType,
  type KinloomServerPluginRoute,
  type KinloomServerPorts,
  type KinloomSiteConfig,
  type RevisionQuery,
} from '@kinloom/core';
import { KinloomHttpError, toErrorResponseData } from '../errors.js';
import { AdminService } from '../services/adminService.js';
import { AuthService, sanitizeNextPath } from '../services/authService.js';
import { BundleReadService } from '../services/bundleReadService.js';
import { MediaService } from '../services/mediaService.js';
import { TalkService } from '../services/talkService.js';
import { WikiWriteService } from '../services/wikiWriteService.js';
import {
  enforceCsrfOrigin,
  principalToRevisionAuthor,
  requireMinRole,
  resolveCallerPrincipal,
} from './authMiddleware.js';
import {
  getOAuthCookieName,
  getSessionCookieName,
  isSecureRequestUrl,
  readOAuthCookieRaw,
  serializeClearCookie,
  serializeSetCookie,
  signOAuthStateToken,
  signSessionToken,
  verifyOAuthStateToken,
} from './session.js';

export interface KinloomServerConfig {
  siteConfig: KinloomSiteConfig;
  ports: KinloomServerPorts;
  sessionSecret: string;
  bootstrapAdminEmail?: string;
  sessionTtlSeconds?: number;
  oauthCookieTtlSeconds?: number;
  magicLinkTtlMinutes?: number;
  onPluginError?: (pluginId: string, error: unknown) => void;
}

export interface KinloomServer {
  fetch(request: Request): Promise<Response>;
}

const MagicLinkRequestSchema = z.object({
  email: z.string().trim().email(),
  next: z.string().optional(),
});

const OptionalSummaryBodySchema = z.object({
  summary: z.string().trim().min(3).optional(),
});

const TalkPostBodySchema = z.object({
  body_md: z.string(),
});

const CreateInviteBodySchema = z.object({
  label: z.string(),
  expires_in_days: z.number().int().positive().optional(),
});

const CreateAgentTokenBodySchema = z.object({
  label: z.string(),
  scope: z.enum(['write_batch', 'read_backup']),
});

const CreateUserBodySchema = z.object({
  email: z.string(),
  display_name: z.string(),
  role: z.enum(['admin', 'editor']),
});

const UpdateUserBodySchema = z.object({
  role: z.enum(['admin', 'editor']),
  display_name: z.string().optional(),
});

const DEFAULT_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string>
): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers.set(k, v);
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function redirectResponse(location: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({
    location,
    'cache-control': 'no-store',
  });
  for (const cookie of setCookies) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 302, headers });
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
  }
}

function parseEntityTypeParam(raw: string): EntityType {
  const parsed = EntityTypeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KinloomHttpError(
      400,
      'INVALID_ENTITY_TYPE',
      `Invalid entity type '${raw}'.`
    );
  }
  return parsed.data;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Malformed URL path encoding.');
  }
}

function parsePositiveInt(raw: string, fieldName: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid ${fieldName}: '${raw}'.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', `Invalid ${fieldName}: '${raw}'.`);
  }
  return value;
}

function matchPluginRoute(
  routes: readonly KinloomServerPluginRoute[],
  method: string,
  pathname: string
): KinloomServerPluginRoute | null {
  const upperMethod = method.toUpperCase();
  for (const route of routes) {
    const routeMethod = route.method.toUpperCase();
    if (routeMethod !== '*' && routeMethod !== upperMethod) {
      continue;
    }
    if (pathname === route.pathPrefix || pathname.startsWith(route.pathPrefix)) {
      return route;
    }
  }
  return null;
}

/**
 * Portable Web-Standard Fetch server implementing all Kinloom HTTP API endpoints,
 * session/CSRF/RBAC middleware, plugin routes, and optional static SPA asset fallback.
 */
export function createKinloomServer(config: KinloomServerConfig): KinloomServer {
  if (!config.sessionSecret || config.sessionSecret.length < 16) {
    throw new RangeError('sessionSecret must be at least 16 characters.');
  }

  const sessionTtlSeconds = config.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const oauthCookieTtlSeconds = config.oauthCookieTtlSeconds ?? DEFAULT_OAUTH_COOKIE_TTL_SECONDS;
  const plugins = config.ports.plugins ?? [];
  const pluginRoutes: KinloomServerPluginRoute[] = plugins.flatMap((plugin) =>
    plugin.routes ? [...plugin.routes] : []
  );

  const authService = new AuthService({
    repository: config.ports.repository,
    emailSender: config.ports.emailSender,
    authProvider: config.ports.authProvider,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    bootstrapAdminEmail: config.bootstrapAdminEmail,
    magicLinkTtlMinutes: config.magicLinkTtlMinutes,
  });

  const wikiWriteService = new WikiWriteService({
    repository: config.ports.repository,
    bundleCache: config.ports.bundleCache,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
    plugins,
    onPluginError: config.onPluginError,
  });

  const bundleReadService = new BundleReadService({
    repository: config.ports.repository,
    bundleCache: config.ports.bundleCache,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
  });

  const mediaService = new MediaService({
    repository: config.ports.repository,
    mediaStore: config.ports.mediaStore,
    wikiWriteService,
    siteConfig: config.siteConfig,
  });

  const talkService = new TalkService({
    repository: config.ports.repository,
    clock: config.ports.clock,
    siteConfig: config.siteConfig,
  });

  const adminService = new AdminService({
    repository: config.ports.repository,
    clock: config.ports.clock,
  });

  async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const method = request.method.toUpperCase();
    const isSecure = isSecureRequestUrl(url);
    const segments = pathname.split('/').filter(Boolean);

    const auth = await resolveCallerPrincipal({
      request,
      url,
      sessionSecret: config.sessionSecret,
      repository: config.ports.repository,
      clock: config.ports.clock,
    });

    // -------------------------------------------------------------------------
    // Auth & Invite endpoints
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/auth/me') {
      return jsonResponse(authService.getSessionInfo(auth.principal), 200);
    }

    if (method === 'GET' && pathname === '/api/auth/google/start') {
      const redirectUri = `${url.origin}/api/auth/google/callback`;
      const started = await authService.startGoogleAuth({
        redirectUri,
        inviteToken: auth.inviteToken,
        nextPath: url.searchParams.get('next'),
      });
      const oauthToken = await signOAuthStateToken({
        secret: config.sessionSecret,
        clock: config.ports.clock,
        ttlSeconds: oauthCookieTtlSeconds,
        state: started.state,
        code_verifier: started.codeVerifier,
        invite_token: started.inviteToken,
        next_path: started.nextPath,
      });
      const oauthCookie = serializeSetCookie({
        name: getOAuthCookieName(isSecure),
        value: oauthToken,
        maxAgeSeconds: oauthCookieTtlSeconds,
        isSecure,
      });
      return redirectResponse(started.authorizationUrl, [oauthCookie]);
    }

    if (method === 'GET' && pathname === '/api/auth/google/callback') {
      const code = url.searchParams.get('code')?.trim() ?? '';
      const state = url.searchParams.get('state')?.trim() ?? '';
      const rawOAuthCookie = readOAuthCookieRaw(request, isSecure);

      if (!code || !state || !rawOAuthCookie) {
        throw new KinloomHttpError(
          400,
          'INVALID_OAUTH_STATE',
          'Missing or expired OAuth state.'
        );
      }

      const oauthState = await verifyOAuthStateToken(
        config.sessionSecret,
        rawOAuthCookie,
        config.ports.clock
      );
      if (!oauthState || oauthState.state !== state) {
        throw new KinloomHttpError(
          400,
          'INVALID_OAUTH_STATE',
          'OAuth state verification failed.'
        );
      }

      const { user } = await authService.completeGoogleAuth({
        code,
        codeVerifier: oauthState.code_verifier,
        redirectUri: `${url.origin}/api/auth/google/callback`,
        inviteToken: oauthState.invite_token,
      });

      const sessionToken = await signSessionToken({
        secret: config.sessionSecret,
        clock: config.ports.clock,
        ttlSeconds: sessionTtlSeconds,
        payload: {
          kind: 'user',
          email: user.email,
          display_name: user.display_name,
          role: user.role,
        },
      });

      return redirectResponse(sanitizeNextPath(oauthState.next_path), [
        serializeClearCookie(getOAuthCookieName(isSecure), isSecure),
        serializeSetCookie({
          name: getSessionCookieName(isSecure),
          value: sessionToken,
          maxAgeSeconds: sessionTtlSeconds,
          isSecure,
        }),
      ]);
    }

    if (method === 'POST' && pathname === '/api/auth/magic-link/request') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      const body = MagicLinkRequestSchema.parse(await readJsonBody(request));
      const result = await authService.requestMagicLink({
        email: body.email,
        inviteToken: auth.inviteToken,
        verifyBaseUrl: `${url.origin}/api/auth/magic-link/verify`,
        nextPath: body.next,
      });
      return jsonResponse(result, 202);
    }

    if (method === 'GET' && pathname === '/api/auth/magic-link/verify') {
      const rawToken = url.searchParams.get('token') ?? '';
      const nextPath = sanitizeNextPath(url.searchParams.get('next'));
      const { user } = await authService.verifyMagicLink({ rawToken });
      const sessionToken = await signSessionToken({
        secret: config.sessionSecret,
        clock: config.ports.clock,
        ttlSeconds: sessionTtlSeconds,
        payload: {
          kind: 'user',
          email: user.email,
          display_name: user.display_name,
          role: user.role,
        },
      });
      return redirectResponse(nextPath, [
        serializeSetCookie({
          name: getSessionCookieName(isSecure),
          value: sessionToken,
          maxAgeSeconds: sessionTtlSeconds,
          isSecure,
        }),
      ]);
    }

    if (
      method === 'GET' &&
      ((segments.length === 4 &&
        segments[0] === 'api' &&
        segments[1] === 'auth' &&
        segments[2] === 'invite') ||
        (segments.length === 2 && segments[0] === 'invite'))
    ) {
      const inviteToken = decodeSegment(segments[segments.length - 1]);
      const { invite } = await authService.redeemInvite(inviteToken);
      const sessionToken = await signSessionToken({
        secret: config.sessionSecret,
        clock: config.ports.clock,
        ttlSeconds: sessionTtlSeconds,
        payload: {
          kind: 'invite_viewer',
          invite_token: invite.token,
          label: invite.label,
        },
      });
      return redirectResponse('/', [
        serializeSetCookie({
          name: getSessionCookieName(isSecure),
          value: sessionToken,
          maxAgeSeconds: sessionTtlSeconds,
          isSecure,
        }),
      ]);
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      const headers = new Headers({ 'cache-control': 'no-store' });
      headers.append('set-cookie', serializeClearCookie(getSessionCookieName(isSecure), isSecure));
      return new Response(null, { status: 204, headers });
    }

    // -------------------------------------------------------------------------
    // Bundle read endpoint
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/bundle') {
      requireMinRole(auth.principal, 'viewer', {
        allowAgentScopes: ['write_batch', 'read_backup'],
      });
      const result = await bundleReadService.getBundle({
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      if (result.status === 'not_modified') {
        return new Response(null, {
          status: 304,
          headers: {
            etag: result.etag,
            'cache-control': 'private, no-cache',
            vary: 'Cookie, Authorization',
          },
        });
      }
      return new Response(result.object.body, {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          etag: result.object.etag,
          'cache-control': 'private, no-cache',
          vary: 'Cookie, Authorization',
        },
      });
    }

    // -------------------------------------------------------------------------
    // Entities CRUD & Restore endpoints
    // -------------------------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'entities') {
      // POST /api/entities/:type
      if (method === 'POST' && segments.length === 3) {
        enforceCsrfOrigin(request, url, auth.authMethod);
        requireMinRole(auth.principal, 'editor');
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const body = EntityWriteInputSchema.parse(await readJsonBody(request));
        const created = await wikiWriteService.createEntity({
          entityType,
          entityId: body.entity_id,
          data: body.data,
          summary: body.summary,
          hasPrimarySource: body.has_primary_source,
          author: principalToRevisionAuthor(auth.principal),
        });
        return jsonResponse(created, 201);
      }

      // GET / PUT / DELETE /api/entities/:type/:id
      if (segments.length === 4) {
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);

        if (method === 'GET') {
          requireMinRole(auth.principal, 'viewer', { allowAgentScopes: ['write_batch'] });
          const entity = await bundleReadService.getEntity({ entityType, entityId });
          return jsonResponse(entity, 200, { 'cache-control': 'private, no-store' });
        }

        if (method === 'PUT') {
          enforceCsrfOrigin(request, url, auth.authMethod);
          requireMinRole(auth.principal, 'editor');
          const body = EntityUpdateInputSchema.parse(await readJsonBody(request));
          const updated = await wikiWriteService.updateEntity({
            entityType,
            entityId,
            expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
            data: body.data,
            merge: body.merge,
            summary: body.summary,
            hasPrimarySource: body.has_primary_source,
            author: principalToRevisionAuthor(auth.principal),
          });
          return jsonResponse(updated, 200);
        }

        if (method === 'DELETE') {
          enforceCsrfOrigin(request, url, auth.authMethod);
          requireMinRole(auth.principal, 'editor');
          const body = EntityDeleteInputSchema.parse(await readJsonBody(request));
          const deleted = await wikiWriteService.deleteEntity({
            entityType,
            entityId,
            expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
            summary: body.summary,
            author: principalToRevisionAuthor(auth.principal),
          });
          return jsonResponse(deleted, 200);
        }
      }

      // POST /api/entities/:type/:id/restore
      if (method === 'POST' && segments.length === 5 && segments[4] === 'restore') {
        enforceCsrfOrigin(request, url, auth.authMethod);
        requireMinRole(auth.principal, 'editor');
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);
        const body = EntityRestoreInputSchema.parse(await readJsonBody(request));
        const restored = await wikiWriteService.restoreEntity({
          entityType,
          entityId,
          expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
          data: body.data,
          summary: body.summary,
          author: principalToRevisionAuthor(auth.principal),
        });
        return jsonResponse(restored, 200);
      }
    }

    // -------------------------------------------------------------------------
    // Revisions & Single-Revision Revert endpoints
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/revisions') {
      requireMinRole(auth.principal, 'viewer', { allowAgentScopes: ['write_batch'] });
      const query: RevisionQuery = {};

      const entityTypeRaw = url.searchParams.get('entity_type');
      if (entityTypeRaw) {
        query.entity_type = parseEntityTypeParam(entityTypeRaw);
      }
      const entityIdRaw = url.searchParams.get('entity_id');
      if (entityIdRaw) {
        query.entity_id = entityIdRaw;
      }
      const batchIdRaw = url.searchParams.get('batch_id');
      if (batchIdRaw) {
        query.batch_id = asBatchId(batchIdRaw);
      }
      const authorTypeRaw = url.searchParams.get('author_type');
      if (authorTypeRaw) {
        query.author_type = AuthorTypeSchema.parse(authorTypeRaw);
      }
      const cursorRaw = url.searchParams.get('cursor');
      if (cursorRaw) {
        query.cursor = asRevisionId(parsePositiveInt(cursorRaw, 'cursor'));
      }
      const limitRaw = url.searchParams.get('limit');
      if (limitRaw) {
        query.limit = parsePositiveInt(limitRaw, 'limit');
      }

      const listed = await bundleReadService.listRevisions(query);
      return jsonResponse(listed, 200, { 'cache-control': 'private, no-store' });
    }

    if (
      method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'revisions' &&
      segments[3] === 'revert'
    ) {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor');
      const revisionId = asRevisionId(parsePositiveInt(decodeSegment(segments[2]), 'revision_id'));
      const body = OptionalSummaryBodySchema.parse(await readJsonBody(request));
      const reverted = await wikiWriteService.revertRevision({
        revisionId,
        summary: body.summary,
        author: principalToRevisionAuthor(auth.principal),
      });
      return jsonResponse(reverted, 201);
    }

    // -------------------------------------------------------------------------
    // Batch Submit & Batch Revert endpoints
    // -------------------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/batches') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['write_batch'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const submission = BatchSubmissionSchema.parse(await readJsonBody(request));
      const committed = await wikiWriteService.submitBatch({
        submission,
        author: principalToRevisionAuthor(auth.principal, submission.author_type),
      });
      return jsonResponse(committed, 201);
    }

    if (
      method === 'POST' &&
      segments.length === 4 &&
      segments[0] === 'api' &&
      segments[1] === 'batches' &&
      segments[3] === 'revert'
    ) {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor');
      const batchId = asBatchId(decodeSegment(segments[2]));
      const body = OptionalSummaryBodySchema.parse(await readJsonBody(request));
      const reverted = await wikiWriteService.revertBatch({
        batchId,
        summary: body.summary,
        author: principalToRevisionAuthor(auth.principal),
      });
      return jsonResponse(reverted, 201);
    }

    // -------------------------------------------------------------------------
    // Media Upload & Range Streaming endpoints
    // -------------------------------------------------------------------------
    if (method === 'POST' && pathname === '/api/media/upload') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor', { allowAgentScopes: ['write_batch'] });

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        throw new KinloomHttpError(
          400,
          'VALIDATION_ERROR',
          'Expected multipart/form-data upload payload.'
        );
      }

      const filePart = formData.get('file');
      if (!filePart || typeof filePart === 'string') {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Missing file field in multipart upload.');
      }

      const metadataPart = formData.get('metadata');
      if (typeof metadataPart !== 'string' || !metadataPart.trim()) {
        throw new KinloomHttpError(
          400,
          'VALIDATION_ERROR',
          'Missing metadata JSON field in multipart upload.'
        );
      }
      let metadataJson: unknown;
      try {
        metadataJson = JSON.parse(metadataPart);
      } catch {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'metadata field must be valid JSON.');
      }
      if (metadataJson === null || typeof metadataJson !== 'object' || Array.isArray(metadataJson)) {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'metadata field must be a JSON object.');
      }

      const summaryPart = formData.get('summary');
      const summary = typeof summaryPart === 'string' ? summaryPart : '';
      const hasPrimaryRaw = formData.get('has_primary_source');
      const hasPrimarySource =
        typeof hasPrimaryRaw === 'string' ? hasPrimaryRaw !== 'false' : true;

      const arrayBuffer = await filePart.arrayBuffer();
      const uploaded = await mediaService.uploadMedia({
        bytes: new Uint8Array(arrayBuffer),
        contentType: filePart.type,
        metadata: metadataJson as Record<string, unknown>,
        summary,
        hasPrimarySource,
        author: principalToRevisionAuthor(auth.principal),
      });

      return jsonResponse(
        {
          media: uploaded.media,
          url: uploaded.url,
          revision: uploaded.revision,
          etag: uploaded.etag,
        },
        201
      );
    }

    if (
      method === 'GET' &&
      segments.length >= 2 &&
      (segments[0] === 'media' || segments[0] === 'sources')
    ) {
      requireMinRole(auth.principal, 'viewer', { allowAgentScopes: ['write_batch'] });
      const prefix = segments[0];
      const key = segments.slice(1).map(decodeSegment).join('/');
      const result = await mediaService.getMedia({
        prefix,
        key,
        rangeHeader: request.headers.get('range'),
      });

      const headers = new Headers({
        'content-type': result.object.contentType,
        'content-length': String(result.object.sizeBytes),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=31536000, immutable',
      });
      const rawEtag = result.object.sha256 ?? result.object.etag;
      if (rawEtag) {
        headers.set('etag', rawEtag.startsWith('"') ? rawEtag : `"${rawEtag}"`);
      }
      if (result.status === 206 && result.object.range) {
        const { start, end, total } = result.object.range;
        headers.set('content-range', `bytes ${start}-${end}/${total}`);
      }
      return new Response(result.object.body, {
        status: result.status,
        headers,
      });
    }

    // -------------------------------------------------------------------------
    // Entity Talk endpoints
    // -------------------------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'talk') {
      if (segments.length === 4) {
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);

        if (method === 'GET') {
          requireMinRole(auth.principal, 'viewer');
          const comments = await talkService.listComments({ entityType, entityId });
          return jsonResponse({ comments }, 200, { 'cache-control': 'private, no-store' });
        }

        if (method === 'POST') {
          enforceCsrfOrigin(request, url, auth.authMethod);
          requireMinRole(auth.principal, 'editor');
          if (auth.principal.kind !== 'user') {
            throw new KinloomHttpError(403, 'FORBIDDEN', 'Only signed-in members can post Talk comments.');
          }
          const body = TalkPostBodySchema.parse(await readJsonBody(request));
          const comment = await talkService.postComment({
            entityType,
            entityId,
            bodyMd: body.body_md,
            authorId: auth.principal.email,
            authorName: auth.principal.display_name,
          });
          return jsonResponse({ comment }, 201);
        }
      }

      if (method === 'DELETE' && segments.length === 5) {
        enforceCsrfOrigin(request, url, auth.authMethod);
        requireMinRole(auth.principal, 'editor');
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);
        const commentId = parsePositiveInt(decodeSegment(segments[4]), 'comment_id');
        await talkService.deleteComment({
          entityType,
          entityId,
          commentId,
          principal: auth.principal,
        });
        return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      }
    }

    // -------------------------------------------------------------------------
    // Deterministic YAML & Raw Snapshot Backup Export endpoints
    // -------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/export/yaml') {
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['read_backup'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const exported = await bundleReadService.exportYaml({
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      if (exported.status === 'not_modified') {
        return new Response(null, {
          status: 304,
          headers: {
            etag: exported.etag,
            'x-kinloom-head-revision': String(exported.head_revision_id),
            'cache-control': 'private, no-cache',
          },
        });
      }
      return jsonResponse(
        {
          head_revision_id: exported.head_revision_id,
          exported_at: exported.exported_at,
          files: exported.files,
        },
        200,
        {
          etag: exported.etag,
          'x-kinloom-head-revision': String(exported.head_revision_id),
          'cache-control': 'private, no-cache',
        }
      );
    }

    if (method === 'GET' && pathname === '/api/export/snapshot') {
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['read_backup'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const exported = await bundleReadService.exportSnapshot({
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      if (exported.status === 'not_modified') {
        return new Response(null, {
          status: 304,
          headers: {
            etag: exported.etag,
            'x-kinloom-head-revision': String(exported.head_revision_id),
            'cache-control': 'private, no-cache',
          },
        });
      }
      return jsonResponse(
        {
          head_revision_id: exported.head_revision_id,
          exported_at: exported.exported_at,
          snapshot: exported.snapshot,
        },
        200,
        {
          etag: exported.etag,
          'x-kinloom-head-revision': String(exported.head_revision_id),
          'cache-control': 'private, no-cache',
        }
      );
    }

    // -------------------------------------------------------------------------
    // Admin endpoints (strictly admin users only — zero agent token access)
    // -------------------------------------------------------------------------
    if (segments[0] === 'api' && segments[1] === 'admin') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'admin', { adminForbiddenCode: 'ADMIN_REQUIRED' });
      const adminEmail = auth.principal.kind === 'user' ? auth.principal.email : 'admin';

      // Invites
      if (segments[2] === 'invites') {
        if (method === 'GET' && segments.length === 3) {
          const invites = await adminService.listInvites();
          return jsonResponse({ invites }, 200);
        }
        if (method === 'POST' && segments.length === 3) {
          const body = CreateInviteBodySchema.parse(await readJsonBody(request));
          const created = await adminService.createInvite({
            label: body.label,
            expires_in_days: body.expires_in_days,
            createdBy: adminEmail,
            origin: url.origin,
          });
          return jsonResponse(created, 201);
        }
        if (method === 'DELETE' && segments.length === 4) {
          await adminService.revokeInvite({ token: decodeSegment(segments[3]) });
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
      }

      // Scoped Agent Tokens
      if (segments[2] === 'agent-tokens') {
        if (method === 'GET' && segments.length === 3) {
          const tokens = await adminService.listAgentTokens();
          return jsonResponse({ tokens }, 200);
        }
        if (method === 'POST' && segments.length === 3) {
          const body = CreateAgentTokenBodySchema.parse(await readJsonBody(request));
          const created = await adminService.createAgentToken({
            label: body.label,
            scope: body.scope,
            createdBy: adminEmail,
          });
          return jsonResponse(created, 201);
        }
        if (method === 'DELETE' && segments.length === 4) {
          await adminService.revokeAgentToken({ tokenId: decodeSegment(segments[3]) });
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
      }

      // Users
      if (segments[2] === 'users') {
        if (method === 'GET' && segments.length === 3) {
          const users = await adminService.listUsers();
          return jsonResponse({ users }, 200);
        }
        if (method === 'POST' && segments.length === 3) {
          const body = CreateUserBodySchema.parse(await readJsonBody(request));
          const user = await adminService.createUser({
            email: body.email,
            display_name: body.display_name,
            role: body.role,
            addedBy: adminEmail,
          });
          return jsonResponse({ user }, 201);
        }
        if (method === 'PATCH' && segments.length === 4) {
          const body = UpdateUserBodySchema.parse(await readJsonBody(request));
          const user = await adminService.updateUser({
            email: decodeSegment(segments[3]),
            role: body.role,
            display_name: body.display_name,
          });
          return jsonResponse({ user }, 200);
        }
        if (method === 'DELETE' && segments.length === 4) {
          await adminService.deleteUser({ email: decodeSegment(segments[3]) });
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
      }
    }

    // -------------------------------------------------------------------------
    // Plugin custom routes (inherit identical auth, role, and CSRF middleware)
    // -------------------------------------------------------------------------
    const matchedPluginRoute = matchPluginRoute(pluginRoutes, method, pathname);
    if (matchedPluginRoute) {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, matchedPluginRoute.minRole, {
        allowAgentScopes:
          matchedPluginRoute.minRole === 'viewer'
            ? ['write_batch', 'read_backup']
            : matchedPluginRoute.minRole === 'editor'
              ? ['write_batch']
              : [],
        adminForbiddenCode: matchedPluginRoute.minRole === 'admin' ? 'ADMIN_REQUIRED' : 'FORBIDDEN',
      });
      return matchedPluginRoute.handle({
        request,
        url,
        principal: auth.principal,
        siteConfig: config.siteConfig,
        ports: config.ports,
      });
    }

    // -------------------------------------------------------------------------
    // Optional SPA Asset Handler fallback for unmatched non-API GET/HEAD routes
    // -------------------------------------------------------------------------
    if (
      config.ports.assetHandler &&
      (method === 'GET' || method === 'HEAD') &&
      !pathname.startsWith('/api/') &&
      !pathname.startsWith('/media/') &&
      !pathname.startsWith('/sources/')
    ) {
      if (pathname.startsWith('/data/')) {
        requireMinRole(auth.principal, 'viewer', {
          allowAgentScopes: ['write_batch', 'read_backup'],
        });
      }
      return config.ports.assetHandler.fetch(request);
    }

    throw new KinloomHttpError(404, 'NOT_FOUND', `Route ${method} ${pathname} was not found.`);
  }

  return {
    async fetch(request: Request): Promise<Response> {
      try {
        return await handleRequest(request);
      } catch (error) {
        const mapped = toErrorResponseData(error);
        return jsonResponse(mapped.body, mapped.status, mapped.headers);
      }
    },
  };
}
