import { type Pronunciation, PronunciationVariantSchema } from '@kinloom/core';
import { z } from 'zod';
import type { PronunciationService } from '../../services/pronunciationService.js';
import { enforceCsrfOrigin, principalToRevisionAuthor, requireMinRole } from '../authMiddleware.js';
import { decodeSegment, type HttpRouteHandler, jsonResponse, readJsonBody } from '../httpPrimitives.js';
import { timeSpan } from '../pluginLifecycle.js';

const GeneratePronunciationBodySchema = z.object({
  entity_type: z.enum(['person', 'place']),
  entity_id: z.string().trim().min(1),
  text: z.string().trim().min(1).optional(),
  phonetic: z.string().trim().min(1).optional(),
  ipa: z.string().trim().min(1).optional(),
  language: z.string().trim().min(1).optional(),
  voice: z.string().trim().min(1).optional(),
});

const OptionalTrimmedStringSchema = z
  .union([z.string(), z.null()])
  .optional()
  .transform((val) => {
    if (typeof val !== 'string') {
      return undefined;
    }
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  });

const UpsertPronunciationLexiconBodySchema = z.object({
  phonetic: OptionalTrimmedStringSchema,
  ipa: OptionalTrimmedStringSchema,
  language: OptionalTrimmedStringSchema,
  note: OptionalTrimmedStringSchema,
  audio_url: OptionalTrimmedStringSchema,
  source_url: OptionalTrimmedStringSchema,
  source_label: OptionalTrimmedStringSchema,
  region: OptionalTrimmedStringSchema,
  variants: z.array(PronunciationVariantSchema).optional(),
});

export interface PronunciationRouteHandlerDeps {
  readonly pronunciationService: PronunciationService;
  readonly mode: 'private' | 'public';
}

export function createPronunciationRouteHandler(deps: PronunciationRouteHandlerDeps): HttpRouteHandler {
  const { pronunciationService, mode } = deps;

  return async (ctx) => {
    const { request, url, pathname, method, segments, auth, telemetry } = ctx;

    if (method === 'POST' && pathname === '/api/pronunciation/generate') {
      enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
      requireMinRole(auth.principal, 'editor', {
        allowAgentScopes: ['write_batch'],
        telemetry,
        bearerRejected: auth.bearerRejected,
      });

      const body = GeneratePronunciationBodySchema.parse(await readJsonBody(request));
      const stored = await timeSpan(telemetry, 'r2', () =>
        pronunciationService.generateEntityPronunciation({
          entityType: body.entity_type,
          entityId: body.entity_id,
          text: body.text,
          phonetic: body.phonetic,
          ipa: body.ipa,
          language: body.language,
          voice: body.voice,
        })
      );

      return jsonResponse(stored, 200);
    }

    if (method === 'GET' && pathname === '/api/pronunciations') {
      if (mode !== 'public') {
        requireMinRole(auth.principal, 'viewer', {
          allowAgentScopes: ['write_batch', 'read_backup'],
          telemetry,
          bearerRejected: auth.bearerRejected,
        });
      }
      const pronunciations = await timeSpan(telemetry, 'd1', () =>
        pronunciationService.loadMergedPronunciations()
      );
      return jsonResponse({ pronunciations }, 200, {
        'cache-control': mode === 'public' ? 'no-store' : 'private, no-store',
      });
    }

    if (
      method === 'PUT' &&
      segments.length === 3 &&
      segments[0] === 'api' &&
      segments[1] === 'pronunciations'
    ) {
      enforceCsrfOrigin(request, url, auth.authMethod, telemetry);
      requireMinRole(auth.principal, 'editor', {
        allowAgentScopes: ['write_batch'],
        telemetry,
        bearerRejected: auth.bearerRejected,
      });

      const term = decodeSegment(segments[2]);
      const body = UpsertPronunciationLexiconBodySchema.parse(await readJsonBody(request));
      const entry: Pronunciation = {};
      if (body.phonetic) entry.phonetic = body.phonetic;
      if (body.ipa) entry.ipa = body.ipa;
      if (body.language) entry.language = body.language;
      if (body.note) entry.note = body.note;
      if (body.audio_url) entry.audio_url = body.audio_url;
      if (body.source_url) entry.source_url = body.source_url;
      if (body.source_label) entry.source_label = body.source_label;
      if (body.region) entry.region = body.region;
      if (body.variants && body.variants.length > 0) entry.variants = body.variants;

      const author = principalToRevisionAuthor(auth.principal);
      const result = await timeSpan(telemetry, 'd1', () =>
        pronunciationService.upsertLexiconTerm({
          term,
          entry,
          updatedBy: author.author_id,
        })
      );
      return jsonResponse(result, 200);
    }

    return null;
  };
}
