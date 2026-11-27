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

const TalkPostBodySchema = z.object({
  body_md: z.string(),
});

export interface MediaAndTalkRouteHandlerDeps {
  readonly mediaService: MediaService;
  readonly talkService: TalkService;
}

export function createMediaAndTalkRouteHandler(deps: MediaAndTalkRouteHandlerDeps): HttpRouteHandler {
  const { mediaService, talkService } = deps;

  return async (ctx) => {
    const { request, url, pathname, method, segments, auth } = ctx;

    if (method === 'POST' && pathname === '/api/media/upload') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor', { allowAgentScopes: ['write_batch'] });

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

    if (method === 'GET' && segments.length >= 2 && (segments[0] === 'media' || segments[0] === 'sources')) {
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

    return null;
  };
}
