import {
  AuthorTypeSchema,
  asBatchId,
  asRevisionId,
  BatchSubmissionSchema,
  EntityDeleteInputSchema,
  EntityRestoreInputSchema,
  EntityUpdateInputSchema,
  EntityWriteInputSchema,
  type RevisionQuery,
} from '@kinloom/core';
import { z } from 'zod';
import type { BundleReadService } from '../../services/bundleReadService.js';
import type { WikiWriteService } from '../../services/wikiWriteService.js';
import { enforceCsrfOrigin, principalToRevisionAuthor, requireMinRole } from '../authMiddleware.js';
import {
  decodeSegment,
  type HttpRouteHandler,
  jsonResponse,
  parseEntityTypeParam,
  parsePositiveInt,
  readJsonBody,
} from '../httpPrimitives.js';
import { timeSpan } from '../pluginLifecycle.js';

const OptionalSummaryBodySchema = z.object({
  summary: z.string().trim().min(3).optional(),
});

export interface WikiRouteHandlerDeps {
  readonly bundleReadService: BundleReadService;
  readonly wikiWriteService: WikiWriteService;
}

function buildExportHeaders(etag: string, headRevisionId: number): Record<string, string> {
  return {
    etag,
    'x-kinloom-head-revision': String(headRevisionId),
    'cache-control': 'private, no-cache',
  };
}

export function createWikiRouteHandler(deps: WikiRouteHandlerDeps): HttpRouteHandler {
  const { bundleReadService, wikiWriteService } = deps;

  return async (ctx) => {
    const { request, url, pathname, method, segments, auth, telemetry } = ctx;

    if (method === 'GET' && pathname === '/api/bundle') {
      requireMinRole(auth.principal, 'viewer', {
        allowAgentScopes: ['write_batch', 'read_backup'],
      });
      const result = await timeSpan(telemetry, 'bundle', () =>
        bundleReadService.getBundle({
          ifNoneMatch: request.headers.get('if-none-match'),
          telemetry,
        })
      );
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

    if (segments[0] === 'api' && segments[1] === 'entities') {
      if (method === 'POST' && segments.length === 3) {
        enforceCsrfOrigin(request, url, auth.authMethod);
        requireMinRole(auth.principal, 'editor');
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const body = EntityWriteInputSchema.parse(await readJsonBody(request));
        const created = await timeSpan(telemetry, 'd1', () =>
          wikiWriteService.createEntity({
            entityType,
            entityId: body.entity_id,
            data: body.data,
            summary: body.summary,
            hasPrimarySource: body.has_primary_source,
            author: principalToRevisionAuthor(auth.principal),
          })
        );
        telemetry?.setBundleRevision(created.revision.revision_id);
        return jsonResponse(created, 201);
      }

      if (segments.length === 4) {
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);

        if (method === 'GET') {
          requireMinRole(auth.principal, 'viewer', { allowAgentScopes: ['write_batch'] });
          const entity = await timeSpan(telemetry, 'd1', () =>
            bundleReadService.getEntity({ entityType, entityId })
          );
          return jsonResponse(entity, 200, { 'cache-control': 'private, no-store' });
        }

        if (method === 'PUT') {
          enforceCsrfOrigin(request, url, auth.authMethod);
          requireMinRole(auth.principal, 'editor');
          const body = EntityUpdateInputSchema.parse(await readJsonBody(request));
          const updated = await timeSpan(telemetry, 'd1', () =>
            wikiWriteService.updateEntity({
              entityType,
              entityId,
              expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
              data: body.data,
              merge: body.merge,
              summary: body.summary,
              hasPrimarySource: body.has_primary_source,
              author: principalToRevisionAuthor(auth.principal),
            })
          );
          telemetry?.setBundleRevision(updated.revision.revision_id);
          return jsonResponse(updated, 200);
        }

        if (method === 'DELETE') {
          enforceCsrfOrigin(request, url, auth.authMethod);
          requireMinRole(auth.principal, 'editor');
          const body = EntityDeleteInputSchema.parse(await readJsonBody(request));
          const deleted = await timeSpan(telemetry, 'd1', () =>
            wikiWriteService.deleteEntity({
              entityType,
              entityId,
              expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
              summary: body.summary,
              author: principalToRevisionAuthor(auth.principal),
            })
          );
          telemetry?.setBundleRevision(deleted.revision.revision_id);
          return jsonResponse(deleted, 200);
        }
      }

      if (method === 'POST' && segments.length === 5 && segments[4] === 'restore') {
        enforceCsrfOrigin(request, url, auth.authMethod);
        requireMinRole(auth.principal, 'editor');
        const entityType = parseEntityTypeParam(decodeSegment(segments[2]));
        const entityId = decodeSegment(segments[3]);
        const body = EntityRestoreInputSchema.parse(await readJsonBody(request));
        const restored = await timeSpan(telemetry, 'd1', () =>
          wikiWriteService.restoreEntity({
            entityType,
            entityId,
            expectedParentRevisionId: asRevisionId(body.expected_parent_revision_id),
            data: body.data,
            summary: body.summary,
            author: principalToRevisionAuthor(auth.principal),
          })
        );
        telemetry?.setBundleRevision(restored.revision.revision_id);
        return jsonResponse(restored, 200);
      }
    }

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

      const listed = await timeSpan(telemetry, 'd1', () => bundleReadService.listRevisions(query));
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
      const reverted = await timeSpan(telemetry, 'd1', () =>
        wikiWriteService.revertRevision({
          revisionId,
          summary: body.summary,
          author: principalToRevisionAuthor(auth.principal),
        })
      );
      telemetry?.setBundleRevision(reverted.revision.revision_id);
      return jsonResponse(reverted, 201);
    }

    if (method === 'POST' && pathname === '/api/batches') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['write_batch'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const submission = BatchSubmissionSchema.parse(await readJsonBody(request));
      const committed = await timeSpan(telemetry, 'd1', () =>
        wikiWriteService.submitBatch({
          submission,
          author: principalToRevisionAuthor(auth.principal, submission.author_type),
        })
      );
      telemetry?.setBundleRevision(committed.head_revision_id);
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
      const reverted = await timeSpan(telemetry, 'd1', () =>
        wikiWriteService.revertBatch({
          batchId,
          summary: body.summary,
          author: principalToRevisionAuthor(auth.principal),
        })
      );
      telemetry?.setBundleRevision(reverted.head_revision_id);
      return jsonResponse(reverted, 201);
    }

    if (method === 'GET' && pathname === '/api/export/yaml') {
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['read_backup'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const exported = await timeSpan(telemetry, 'bundle', () =>
        bundleReadService.exportYaml({
          ifNoneMatch: request.headers.get('if-none-match'),
          telemetry,
        })
      );
      const headers = buildExportHeaders(exported.etag, exported.head_revision_id);
      if (exported.status === 'not_modified') {
        return new Response(null, { status: 304, headers });
      }
      return jsonResponse(
        {
          head_revision_id: exported.head_revision_id,
          exported_at: exported.exported_at,
          files: exported.files,
        },
        200,
        headers
      );
    }

    if (method === 'GET' && pathname === '/api/export/snapshot') {
      requireMinRole(auth.principal, 'admin', {
        allowAgentScopes: ['read_backup'],
        adminForbiddenCode: 'FORBIDDEN',
      });
      const exported = await timeSpan(telemetry, 'bundle', () =>
        bundleReadService.exportSnapshot({
          ifNoneMatch: request.headers.get('if-none-match'),
          telemetry,
        })
      );
      const headers = buildExportHeaders(exported.etag, exported.head_revision_id);
      if (exported.status === 'not_modified') {
        return new Response(null, { status: 304, headers });
      }
      return jsonResponse(
        {
          head_revision_id: exported.head_revision_id,
          exported_at: exported.exported_at,
          snapshot: exported.snapshot,
        },
        200,
        headers
      );
    }

    return null;
  };
}
