import { z } from 'zod';
import { KinloomHttpError } from '../../errors.js';
import type { MediaService } from '../../services/mediaService.js';
import type { TalkService } from '../../services/talkService.js';
import { enforceCsrfOrigin, principalToRevisionAuthor, requireMinRole } from '../authMiddleware.js';
import {
  decodeSegment,
  type HttpRouteHandler,
  jsonResponse,
  parseEntityTypeParam,
  parsePositiveInt,
  readJsonBody,
} from '../httpPrimitives.js';
import { sanitizeMediaContentType, timeSpan } from '../pluginLifecycle.js';

const TalkPostBodySchema = z.object({
  body_md: z.string(),
});

const MAX_DOWNLOAD_FILENAME_LENGTH = 120;

function sanitizeFilenameCandidate(raw: string): string {
  const firstLine = raw.split(/[\r\n]/, 1)[0] ?? '';
  const basename = firstLine.split(/[/\\]/).pop() ?? '';
  const cleaned = basename
    .replaceAll(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .slice(0, MAX_DOWNLOAD_FILENAME_LENGTH);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : '';
}

export function sanitizeDownloadFilename(rawFilename: string | null, fallbackKey: string): string {
  if (rawFilename) {
    const safeRequested = sanitizeFilenameCandidate(rawFilename);
    if (safeRequested) {
      return safeRequested;
    }
  }
  const safeKey = sanitizeFilenameCandidate(fallbackKey);
  return safeKey || 'download';
}

export interface MediaAndTalkRouteHandlerDeps {
  readonly mediaService: MediaService;
  readonly talkService: TalkService;
}

export function createMediaAndTalkRouteHandler(deps: MediaAndTalkRouteHandlerDeps): HttpRouteHandler {
  const { mediaService, talkService } = deps;

  return async (ctx) => {
    const { request, url, pathname, method, segments, auth, telemetry } = ctx;

    if (method === 'POST' && pathname === '/api/media/upload') {
      enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
      requireMinRole(auth.principal, 'editor', {
        allowAgentScopes: ['write_batch'],
        telemetry,
        bearerRejected: auth.bearerRejected,
      });

      let formData: FormData;
      try {
        formData = await request.formData();
      } catch {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Expected multipart/form-data upload payload.');
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
      const hasPrimarySource = typeof hasPrimaryRaw === 'string' ? hasPrimaryRaw !== 'false' : true;

      const arrayBuffer = await filePart.arrayBuffer();
      const onUploadRejected = telemetry?.hasSecuritySubscribers
        ? (info: {
            reason: 'magic_bytes_mismatch' | 'unsupported_media_type' | 'file_too_large' | 'empty_file';
            status: number;
            contentType: string;
            sizeBytes: number;
            maxBytes?: number;
          }) => {
            telemetry.queueSecurityEvent({
              type: 'media.upload.rejected',
              status: info.status,
              reason: info.reason,
              contentType: sanitizeMediaContentType(info.contentType),
              sizeBytes: info.sizeBytes,
              ...(info.maxBytes !== undefined ? { maxBytes: info.maxBytes } : {}),
            });
          }
        : undefined;

      const uploaded = await timeSpan(telemetry, 'r2', () =>
        mediaService.uploadMedia({
          bytes: new Uint8Array(arrayBuffer),
          contentType: filePart.type,
          metadata: metadataJson as Record<string, unknown>,
          summary,
          hasPrimarySource,
          author: principalToRevisionAuthor(auth.principal),
          onUploadRejected,
        })
      );
      telemetry?.setBundleRevision(uploaded.revision.revision_id);

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

    if (method === 'GET' && segments.length >= 2 && (segments[0] === 'media' || segments[0] === 'sources')) {
      requireMinRole(auth.principal, 'viewer', {
        allowAgentScopes: ['write_batch', 'read_backup'],
        telemetry,
        bearerRejected: auth.bearerRejected,
      });
      const prefix = segments[0];
      const key = segments.slice(1).map(decodeSegment).join('/');
      const isDownload = prefix === 'media' && url.searchParams.get('download') === '1';
      const result = await timeSpan(telemetry, 'r2', () =>
        mediaService.getMedia({
          prefix,
          key,
          rangeHeader: isDownload ? null : request.headers.get('range'),
        })
      );

      const headers = new Headers({
        'content-type': result.object.contentType,
        'content-length': String(result.object.sizeBytes),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=31536000, immutable',
      });
      if (isDownload) {
        const safeName = sanitizeDownloadFilename(url.searchParams.get('filename'), key);
        headers.set('content-disposition', `attachment; filename="${safeName}"`);
      }
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

    if (segments[0] === 'api' && segments[1] === 'talk') {
      if (segments.length === 4) {
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);

        if (method === 'GET') {
          requireMinRole(auth.principal, 'viewer', {
            telemetry,
            bearerRejected: auth.bearerRejected,
          });
          const comments = await timeSpan(telemetry, 'd1', () =>
            talkService.listComments({ entityType, entityId })
          );
          return jsonResponse({ comments }, 200, { 'cache-control': 'private, no-store' });
        }

        if (method === 'POST') {
          enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
          requireMinRole(auth.principal, 'editor', {
            telemetry,
            bearerRejected: auth.bearerRejected,
          });
          if (auth.principal.kind !== 'user') {
            telemetry?.queueSecurityEvent({
              type: 'auth.write.forbidden',
              status: 403,
              reason: 'member_required',
              requiredRole: 'editor',
              actorKind: auth.principal.kind,
            });
            throw new KinloomHttpError(403, 'FORBIDDEN', 'Only signed-in members can post Talk comments.');
          }
          const userPrincipal = auth.principal;
          const body = TalkPostBodySchema.parse(await readJsonBody(request));
          try {
            const comment = await timeSpan(telemetry, 'd1', () =>
              talkService.postComment({
                entityType,
                entityId,
                bodyMd: body.body_md,
                authorId: userPrincipal.email,
                authorName: userPrincipal.display_name,
              })
            );
            return jsonResponse({ comment }, 201);
          } catch (error) {
            if (error instanceof KinloomHttpError && error.status === 403 && error.code === 'FORBIDDEN') {
              telemetry?.queueSecurityEvent({
                type: 'auth.write.forbidden',
                status: 403,
                reason: 'talk_disabled',
                requiredRole: 'editor',
                actorKind: 'user',
              });
            }
            throw error;
          }
        }
      }

      if (method === 'DELETE' && segments.length === 5) {
        enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
        requireMinRole(auth.principal, 'editor', {
          telemetry,
          bearerRejected: auth.bearerRejected,
        });
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);
        const commentId = parsePositiveInt(decodeSegment(segments[4]), 'comment_id');
        try {
          await timeSpan(telemetry, 'd1', () =>
            talkService.deleteComment({
              entityType,
              entityId,
              commentId,
              principal: auth.principal,
            })
          );
          return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          if (error instanceof KinloomHttpError && error.status === 403 && error.code === 'FORBIDDEN') {
            telemetry?.queueSecurityEvent({
              type: 'auth.write.forbidden',
              status: 403,
              reason: error.message.toLowerCase().includes('disabled') ? 'talk_disabled' : 'not_owner',
              requiredRole: 'admin',
              actorKind: auth.principal.kind,
            });
          }
          throw error;
        }
      }
    }

    return null;
  };
}
