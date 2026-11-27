import {
  type KinloomSiteConfig,
  mergePronunciationLexicons,
  type Pronunciation,
  PronunciationVariantSchema,
  parseEntityPayload,
  resolveEffectiveLiving,
} from '@kinloom/core';
import { z } from 'zod';
import { KinloomHttpError } from '../../errors.js';
import type { KinloomServerPorts } from '../../ports.js';
import { generateAndStorePronunciationAudio } from '../../services/pronunciationHelper.js';
import { enforceCsrfOrigin, principalToRevisionAuthor, requireMinRole } from '../authMiddleware.js';
import { decodeSegment, type HttpRouteHandler, jsonResponse, readJsonBody } from '../httpPrimitives.js';

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
  readonly siteConfig: KinloomSiteConfig;
  readonly ports: KinloomServerPorts;
  readonly mode: 'private' | 'public';
}

export function createPronunciationRouteHandler(deps: PronunciationRouteHandlerDeps): HttpRouteHandler {
  const { siteConfig, ports, mode } = deps;

  async function loadMergedPronunciations(): Promise<Record<string, Pronunciation>> {
    const staticLexicon = siteConfig.pronunciations ?? {};
    const dynamicLexicon = ports.pronunciationLexiconStore
      ? await ports.pronunciationLexiconStore.list()
      : {};
    return mergePronunciationLexicons(staticLexicon, dynamicLexicon);
  }

  return async (ctx) => {
    const { request, url, pathname, method, segments, auth } = ctx;

    if (method === 'POST' && pathname === '/api/pronunciation/generate') {
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor', { allowAgentScopes: ['write_batch'] });

      const body = GeneratePronunciationBodySchema.parse(await readJsonBody(request));
      const entityRow = await ports.repository.getEntity(body.entity_type, body.entity_id);
      if (entityRow === null || entityRow.deleted_at !== null || 'edge' in entityRow) {
        throw new KinloomHttpError(
          404,
          'NOT_FOUND',
          `Entity ${body.entity_type}/${body.entity_id} was not found.`
        );
      }

      let defaultText = '';
      if (body.entity_type === 'person') {
        const parsedPerson = parseEntityPayload('person', entityRow.data);
        if (resolveEffectiveLiving(parsedPerson, siteConfig.privacy)) {
          throw new KinloomHttpError(
            422,
            'LIVING_PRIVACY_VIOLATION',
            `Cannot generate pronunciation audio for living person '${body.entity_id}'.`
          );
        }
        defaultText = parsedPerson.full_name.trim();
      } else {
        const parsedPlace = parseEntityPayload('place', entityRow.data);
        defaultText = (parsedPlace.name || parsedPlace.full_name).trim();
      }

      if (!ports.pronunciationGenerator) {
        throw new KinloomHttpError(
          503,
          'PRONUNCIATION_UNAVAILABLE',
          'Pronunciation audio generation is not configured on this server.'
        );
      }

      const text = body.text?.trim() || defaultText;
      if (!text) {
        throw new KinloomHttpError(
          400,
          'VALIDATION_ERROR',
          'Pronunciation text is required when entity name is empty.'
        );
      }

      const stored = await generateAndStorePronunciationAudio({
        generator: ports.pronunciationGenerator,
        mediaStore: ports.mediaStore,
        entityType: body.entity_type,
        text,
        phonetic: body.phonetic,
        ipa: body.ipa,
        language: body.language,
        voice: body.voice,
      });

      return jsonResponse(stored, 200);
    }

    if (method === 'GET' && pathname === '/api/pronunciations') {
      if (mode !== 'public') {
        requireMinRole(auth.principal, 'viewer', {
          allowAgentScopes: ['write_batch', 'read_backup'],
        });
      }
      const pronunciations = await loadMergedPronunciations();
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
      enforceCsrfOrigin(request, url, auth.authMethod);
      requireMinRole(auth.principal, 'editor', { allowAgentScopes: ['write_batch'] });

      const term = decodeSegment(segments[2]).trim();
      if (!term) {
        throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Pronunciation term is required.');
      }

      if (!ports.pronunciationLexiconStore) {
        throw new KinloomHttpError(
          503,
          'PRONUNCIATION_STORE_UNAVAILABLE',
          'Pronunciation lexicon persistence is not configured on this server.'
        );
      }

      const body = UpsertPronunciationLexiconBodySchema.parse(await readJsonBody(request));
      const isEmpty =
        !body.phonetic &&
        !body.ipa &&
        !body.language &&
        !body.note &&
        !body.audio_url &&
        !body.source_url &&
        !body.source_label &&
        !body.region &&
        (!body.variants || body.variants.length === 0);

      if (isEmpty) {
        await ports.pronunciationLexiconStore.delete(term);
        const pronunciations = await loadMergedPronunciations();
        return jsonResponse({ term, pronunciation: null, pronunciations }, 200);
      }

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

      if (ports.pronunciationGenerator && ports.mediaStore) {
        try {
          const stored = await generateAndStorePronunciationAudio({
            generator: ports.pronunciationGenerator,
            mediaStore: ports.mediaStore,
            entityType: 'person',
            text: term,
            phonetic: entry.phonetic,
            ipa: entry.ipa,
            language: entry.language,
          });
          entry.audio_url = stored.audio_url;
        } catch {
          // Degrade gracefully when TTS is unavailable so lexicon text still saves
        }
      }

      const author = principalToRevisionAuthor(auth.principal);
      const pronunciation = await ports.pronunciationLexiconStore.upsert(
        term,
        entry,
        author.author_id,
        ports.clock.nowIso()
      );
      const pronunciations = await loadMergedPronunciations();
      return jsonResponse({ term, pronunciation, pronunciations }, 200);
    }

    return null;
  };
}
