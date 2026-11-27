import {
  asBatchId,
  asRevisionId,
  asSha256Hex,
  type BundleCache,
  type CachedBundleObject,
  compileArchive,
  type EntityReadStore,
  type KinloomSiteConfig,
  KinloomSiteConfigSchema,
  type MediaStore,
  type PronunciationAudioGenerator,
  type RawEvent,
  type RawPerson,
  type RevisionAuthor,
  type RevisionRecord,
  type StoredEntityRow,
  type StoredKinshipRow,
  toEntityPayload,
} from '@kinloom/core';
import { describe, expect, it, vi } from 'vitest';
import { GoogleOAuthProvider } from './adapters/googleOAuthProvider.js';
import { InMemoryAccessAndTalkStore } from './adapters/inMemory/accessAndTalkStore.js';
import { InMemoryEntityAndMutationStore } from './adapters/inMemory/entityAndMutationStore.js';
import {
  createInMemoryServerPorts,
  FakeAuthProvider,
  InMemoryIncrementalBundleCache,
  InMemoryMediaStore,
  InMemoryPronunciationLexiconStore,
} from './adapters/inMemory.js';
import { FixedClock } from './adapters/systemClock.js';
import {
  base64UrlDecodeString,
  base64UrlEncodeString,
  bytesToStream,
  hmacSignBase64Url,
  hmacVerifyBase64Url,
  sha256Bytes,
} from './crypto.js';
import { KinloomHttpError } from './errors.js';
import { principalToRevisionAuthor, requireMinRole, resolveCallerPrincipal } from './http/authMiddleware.js';
import {
  compilePluginDocumentContributions,
  finalizeServerResponse,
  injectHtmlSnippets,
  isHtmlDocumentResponse,
} from './http/documentContributions.js';
import {
  buildAuthErrorRedirectUrl,
  mapAuthErrorToBrowserCode,
  parsePositiveInt,
  readJsonBody,
} from './http/httpPrimitives.js';
import {
  createRequestTelemetryTracker,
  type KinloomServerPlugin,
  normalizeServerRouteTemplate,
} from './http/pluginLifecycle.js';
import { createKinloomServer, validateAndCompilePluginRoutes } from './http/router.js';
import { handleDynamicOgRequest, renderPrivacyPolicyHtml } from './http/routes/privacyAndOgRoutes.js';
import type { ServerSecurityEvent } from './http/securityEvents.js';
import {
  getOAuthCookieName,
  parseCookies,
  readOAuthCookieRaw,
  signSessionToken,
  verifySessionToken,
} from './http/session.js';
import {
  buildSecurityTelemetryLogRecord,
  createSecurityTelemetryHandler,
  isSecurityTelemetryEnabled,
  type SecurityTelemetryLogRecord,
} from './plugins/securityTelemetry.js';
import { AdminService } from './services/adminService.js';
import { AuthService, sanitizeNextPath } from './services/authService.js';
import { BundleReadService } from './services/bundleReadService.js';
import { MediaService, matchesMagicBytesForMime, parseHttpByteRange } from './services/mediaService.js';
import { generateAndStorePronunciationAudio } from './services/pronunciationHelper.js';
import { PronunciationService } from './services/pronunciationService.js';
import { compileBatchRevertOps, compileBatchSubmissionOps } from './services/wikiWrite/batchCompiler.js';
import {
  buildInitialSnapshotFromRevisions,
  WikiCommitPipeline,
} from './services/wikiWrite/commitPipeline.js';
import {
  assertEditSummaryValid,
  extractMediaEventId,
  maybeGenerateEntityPronunciationAudio,
  prefetchEntitiesByKey,
  rowToWorking,
  validateAndSanitizeEntityPayload,
} from './services/wikiWrite/payloadPolicy.js';
import { WikiWriteService } from './services/wikiWriteService.js';
import {
  CONTRACT_SESSION_SECRET,
  CONTRACT_TEST_ORIGIN,
  createSyntheticEvent,
  createSyntheticHistoricalPerson,
  createSyntheticLivingPerson,
  createSyntheticSiteConfig,
} from './testing/contract/harness.js';

const EDITOR_AUTHOR: RevisionAuthor = {
  author_id: 'editor@alder.test',
  author_name: 'Editor Alder',
  author_type: 'human',
};

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const VALID_PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const VALID_WEBP_BYTES = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const VALID_GIF87_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const VALID_GIF89_BYTES = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);

function makeStubPronunciationGenerator(
  ext: 'wav' | 'mp3' = 'wav',
  contentType = 'audio/wav'
): PronunciationAudioGenerator {
  return {
    async generate() {
      return {
        bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x01, 0x02]),
        contentType,
        ext,
      };
    },
  };
}

describe('wikiWrite payloadPolicy branch coverage', () => {
  it('handles soft-deleted rows, media event extraction, summary validation, and non-batch prefetching', async () => {
    const person = createSyntheticHistoricalPerson({ id: 'per_soft' });
    const softEntity: StoredEntityRow = {
      entity_type: 'person',
      entity_id: 'per_soft',
      slug: 'soft-alder',
      data: toEntityPayload(person),
      current_revision_id: asRevisionId(3),
      has_primary_source: false,
      deleted_at: '2026-11-26T12:00:00.000Z',
      updated_at: '2026-11-26T12:00:00.000Z',
    };
    const softWorking = rowToWorking(softEntity);
    expect(softWorking.lifecycle.kind).toBe('softDeleted');
    expect(softWorking.hasPrimarySource).toBe(false);
    expect(softWorking.slug).toBe('soft-alder');

    const softKinship: StoredKinshipRow = {
      edge_id: 'edge_soft',
      edge: { from: 'per_a', to: 'per_b', relation: 'parent' },
      current_revision_id: asRevisionId(4),
      deleted_at: '2026-11-26T12:00:00.000Z',
      updated_at: '2026-11-26T12:00:00.000Z',
    };
    const softKinshipWorking = rowToWorking(softKinship);
    expect(softKinshipWorking.lifecycle.kind).toBe('softDeleted');
    expect(softKinshipWorking.hasPrimarySource).toBe(true);
    expect(softKinshipWorking.slug).toBeNull();

    expect(extractMediaEventId(null)).toBeNull();
    expect(extractMediaEventId(['bad'])).toBeNull();
    expect(extractMediaEventId({ event_id: '   ' })).toBeNull();
    expect(extractMediaEventId({ event_id: ' evt_1 ' })).toBe('evt_1');

    expect(() => assertEditSummaryValid('no')).toThrow(KinloomHttpError);

    const getEntitySpy = vi.fn(async (_t: unknown, id: string) => (id === 'per_soft' ? softEntity : null));
    const nonBatchRepo: EntityReadStore = {
      getHeadRevisionId: async () => asRevisionId(0),
      getEntity: getEntitySpy,
      getLivingPersonIds: async () => new Set(),
      loadActiveSnapshot: async () => ({
        head_revision_id: asRevisionId(0),
        entities: [],
        kinship: [],
      }),
    };

    expect((await prefetchEntitiesByKey(nonBatchRepo, [])).size).toBe(0);
    const prefetched = await prefetchEntitiesByKey(nonBatchRepo, [
      { entityType: 'person', entityId: 'per_soft' },
      { entityType: 'person', entityId: 'per_soft' },
      { entityType: 'person', entityId: 'per_missing' },
    ]);
    expect(getEntitySpy).toHaveBeenCalledTimes(2);
    expect(prefetched.get('person:per_soft')).toEqual(softEntity);
    expect(prefetched.get('person:per_missing')).toBeNull();
  });

  it('validates extensions cloning, kinship derivation, media event privacy lookups, and pronunciation audio generation', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });
    const writeService = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock,
      siteConfig,
    });

    const living = createSyntheticLivingPerson({ id: 'per_liv_pol' });
    await writeService.createEntity({
      entityType: 'person',
      entityId: living.id,
      data: toEntityPayload(living),
      summary: 'Seed living person',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });

    const eventWithLiving: RawEvent = createSyntheticEvent({
      id: 'evt_liv_pol',
      title: 'Birth Event',
      participants: [{ person_id: living.id, role: 'principal' }],
    });
    await writeService.createEntity({
      entityType: 'event',
      entityId: eventWithLiving.id,
      data: toEntityPayload(eventWithLiving),
      summary: 'Seed event referencing living person',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });

    // Media referencing active event with living participant triggers repo lookup and privacy rejection
    await expect(
      validateAndSanitizeEntityPayload(
        { repository: ports.repository, clock, siteConfig },
        {
          entityType: 'media',
          rawPayload: {
            id: '   ',
            kind: 'portrait',
            title: 'Blocked photo',
            file: '/media/sample.png',
            event_id: eventWithLiving.id,
            extensions: { archive_box: 'B-12' },
          },
          hasPrimarySource: true,
        }
      )
    ).rejects.toThrow();

    // Auto-generated entity id + extensions clone when requestedEntityId and body id are absent
    const validatedPlace = await validateAndSanitizeEntityPayload(
      { repository: ports.repository, clock, siteConfig },
      {
        entityType: 'place',
        rawPayload: {
          id: '   ',
          slug: 'alder-creek',
          name: 'Alder Creek',
          full_name: 'Alder Creek, Vermont',
          place_type: 'town',
          parent_id: null,
          lat: 44.26,
          lng: -72.58,
          extensions: { notes: 'synthetic' },
        },
        hasPrimarySource: true,
      }
    );
    expect(validatedPlace.entityId).toMatch(/^plc_/);

    // Kinship edge without requestedEntityId uses derived id
    const validatedEdge = await validateAndSanitizeEntityPayload(
      { repository: ports.repository, clock, siteConfig },
      {
        entityType: 'kinship_edge',
        rawPayload: {
          from: 'per_a',
          to: 'per_b',
          relation: 'parent',
        },
        hasPrimarySource: true,
      }
    );
    expect(validatedEdge.entityId.length).toBeGreaterThan(0);

    // Pronunciation audio generation branches
    const generator = makeStubPronunciationGenerator();
    const pronDeps = {
      clock,
      siteConfig,
      mediaStore: ports.mediaStore,
      pronunciationGenerator: generator,
    };

    // Non-person/place entity skipped
    const sourcePayload = { id: 'src_1', title: 'Tax Roll', pronunciation: { phonetic: 'TAKS' } };
    expect(
      await maybeGenerateEntityPronunciationAudio(pronDeps, {
        entityType: 'source',
        sanitized: sourcePayload,
        previousPayload: null,
      })
    ).toBe(sourcePayload);

    // Living person skipped
    const livingWithPron = toEntityPayload({
      ...living,
      pronunciation: { phonetic: 'AWL-der' },
    });
    expect(
      await maybeGenerateEntityPronunciationAudio(pronDeps, {
        entityType: 'person',
        sanitized: livingWithPron,
        previousPayload: null,
      })
    ).toBe(livingWithPron);

    // Historical person with audio_url unchanged vs changed phonetic/ipa/language/full_name
    const histPerson = createSyntheticHistoricalPerson({ id: 'per_pron_hist' });
    const prevPersonPayload = toEntityPayload({
      ...histPerson,
      pronunciation: { phonetic: 'AWL-der', audio_url: '/media/existing.wav' },
    });
    const unchangedRes = await maybeGenerateEntityPronunciationAudio(pronDeps, {
      entityType: 'person',
      sanitized: prevPersonPayload,
      previousPayload: prevPersonPayload,
    });
    expect(unchangedRes).toBe(prevPersonPayload);

    const changedLangRes = await maybeGenerateEntityPronunciationAudio(pronDeps, {
      entityType: 'person',
      sanitized: toEntityPayload({
        ...histPerson,
        pronunciation: { phonetic: 'AWL-der', language: 'en-US', audio_url: '/media/existing.wav' },
      }),
      previousPayload: prevPersonPayload,
    });
    expect((changedLangRes.pronunciation as { audio_url?: string }).audio_url).toMatch(
      /^\/media\/pronunciation-/
    );

    // Historical person with empty/non-string full_name falling back to phonetic, ipa, and empty skip
    const fallbackPhonetic = await maybeGenerateEntityPronunciationAudio(pronDeps, {
      entityType: 'person',
      sanitized: {
        ...toEntityPayload(histPerson),
        full_name: '',
        pronunciation: { phonetic: 'AWL-der' },
      },
      previousPayload: null,
    });
    expect((fallbackPhonetic.pronunciation as { audio_url?: string }).audio_url).toMatch(
      /^\/media\/pronunciation-/
    );

    const fallbackIpa = await maybeGenerateEntityPronunciationAudio(pronDeps, {
      entityType: 'person',
      sanitized: {
        ...toEntityPayload(histPerson),
        full_name: '',
        pronunciation: { ipa: '/al.dər/' },
      },
      previousPayload: null,
    });
    expect((fallbackIpa.pronunciation as { audio_url?: string }).audio_url).toMatch(
      /^\/media\/pronunciation-/
    );

    const emptyAllText = {
      ...toEntityPayload(histPerson),
      full_name: '',
      pronunciation: {},
    };
    expect(
      await maybeGenerateEntityPronunciationAudio(pronDeps, {
        entityType: 'person',
        sanitized: emptyAllText,
        previousPayload: null,
      })
    ).toBe(emptyAllText);

    // Place with existing audio_url: unchanged, name changed, full_name changed, empty name fallback
    const prevPlace = {
      id: 'plc_1',
      name: 'Alder',
      full_name: 'Alder, VT',
      pronunciation: { audio_url: '/media/p.wav' },
    };
    expect(
      await maybeGenerateEntityPronunciationAudio(pronDeps, {
        entityType: 'place',
        sanitized: prevPlace,
        previousPayload: prevPlace,
      })
    ).toBe(prevPlace);

    const placeFullNameChanged = await maybeGenerateEntityPronunciationAudio(pronDeps, {
      entityType: 'place',
      sanitized: {
        id: 'plc_1',
        name: '',
        full_name: 'Alder Village, VT',
        pronunciation: { audio_url: '/media/p.wav' },
      },
      previousPayload: {
        id: 'plc_1',
        pronunciation: { audio_url: '/media/p.wav' },
      },
    });
    expect((placeFullNameChanged.pronunciation as { audio_url?: string }).audio_url).toMatch(
      /^\/media\/pronunciation-/
    );

    const placeEmptyNames = {
      id: 'plc_2',
      pronunciation: { audio_url: '/media/p2.wav' },
    };
    expect(
      await maybeGenerateEntityPronunciationAudio(pronDeps, {
        entityType: 'place',
        sanitized: placeEmptyNames,
        previousPayload: { id: 'plc_2', name: 'Old', pronunciation: { audio_url: '/media/p2.wav' } },
      })
    ).toBe(placeEmptyNames);
  });
});

describe('MediaService branch coverage', () => {
  it('validates magic bytes for PNG, WebP, GIF87a/89a, PDF, and byte range edge cases', () => {
    expect(matchesMagicBytesForMime('image/png', new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(matchesMagicBytesForMime('image/png; charset=binary', VALID_PNG_BYTES)).toBe(true);
    expect(matchesMagicBytesForMime('application/pdf', VALID_PDF_BYTES)).toBe(true);
    expect(matchesMagicBytesForMime('application/pdf', new Uint8Array([0x25, 0x50]))).toBe(false);
    expect(matchesMagicBytesForMime('image/webp', VALID_WEBP_BYTES)).toBe(true);
    expect(matchesMagicBytesForMime('image/webp', new Uint8Array([0x52, 0x49]))).toBe(false);
    for (const idx of [0, 1, 2, 3, 8, 9, 10, 11]) {
      const broken = VALID_WEBP_BYTES.slice();
      broken[idx] = 0x00;
      expect(matchesMagicBytesForMime('image/webp', broken)).toBe(false);
    }

    expect(matchesMagicBytesForMime('image/gif', VALID_GIF87_BYTES)).toBe(true);
    expect(matchesMagicBytesForMime('image/gif', VALID_GIF89_BYTES)).toBe(true);
    expect(matchesMagicBytesForMime('image/gif', new Uint8Array([0x47, 0x49]))).toBe(false);
    for (const idx of [0, 1, 2, 3, 4, 5]) {
      const broken = VALID_GIF89_BYTES.slice();
      broken[idx] = 0x00;
      expect(matchesMagicBytesForMime('image/gif', broken)).toBe(false);
    }

    // parseHttpByteRange edge cases
    expect(parseHttpByteRange('items=0-5', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=0-1,2-3', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=0-1', 0)).toBeNull();
    expect(parseHttpByteRange('bytes=10', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=-abc', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=-0', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=-10', 100)).toEqual({
      start: 90,
      end: 99,
      range: { offset: 90, length: 10 },
    });
    expect(parseHttpByteRange('bytes=abc-10', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=10-abc', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=20-10', 100)).toBeNull();
    expect(parseHttpByteRange('bytes=10-', 100)).toEqual({
      start: 10,
      end: 99,
      range: { offset: 10, length: 90 },
    });
  });

  it('validates upload rejections, living event privacy, unsafe media keys, and ranged fallback metadata', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });
    const wikiWriteService = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock,
      siteConfig,
    });
    const mediaService = new MediaService({
      repository: ports.repository,
      mediaStore: ports.mediaStore,
      wikiWriteService,
      siteConfig,
    });

    await expect(
      mediaService.uploadMedia({
        bytes: VALID_PNG_BYTES,
        contentType: 'image/png',
        metadata: { kind: 'photo', title: 'Short summary' },
        summary: 'no',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    const rejectedReasons: string[] = [];
    await expect(
      mediaService.uploadMedia({
        bytes: new Uint8Array(),
        contentType: 'image/png; charset=binary',
        metadata: { kind: 'photo', title: 'Empty' },
        summary: 'Empty upload test',
        author: EDITOR_AUTHOR,
        onUploadRejected(info) {
          rejectedReasons.push(info.reason);
        },
      })
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(rejectedReasons).toEqual(['empty_file']);

    // Event referencing living person blocks upload in checkLivingPrivacy
    const living = createSyntheticLivingPerson({ id: 'per_med_liv' });
    await wikiWriteService.createEntity({
      entityType: 'person',
      entityId: living.id,
      data: toEntityPayload(living),
      summary: 'Seed living for media test',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    await wikiWriteService.createEntity({
      entityType: 'event',
      entityId: 'evt_med_liv',
      data: toEntityPayload(
        createSyntheticEvent({
          id: 'evt_med_liv',
          title: 'Gathering',
          participants: [{ person_id: living.id, role: 'principal' }],
        })
      ),
      summary: 'Seed event for media test',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    await expect(
      mediaService.uploadMedia({
        bytes: VALID_PNG_BYTES,
        contentType: 'image/png',
        metadata: { kind: 'portrait', title: 'Blocked', event_id: 'evt_med_liv' },
        summary: 'Upload attached to living event',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toThrow();

    // Unsafe relative media keys
    const unsafeKeys = [
      '',
      '/leading.png',
      'trailing/',
      'back\\slash.png',
      'null\0byte.png',
      'a/b/c/d/e/f/g/h/i.png',
      '../escape.png',
      './dot.png',
      'bad space.png',
    ];
    for (const key of unsafeKeys) {
      await expect(mediaService.getMedia({ key, rangeHeader: null })).rejects.toMatchObject({
        status: 404,
      });
    }

    // Custom mediaStore where ranged get returns null, and where ranged get omits `range`
    let returnNullOnGet = true;
    const customMediaStore: MediaStore = {
      async head() {
        return { exists: true, sizeBytes: 10, contentType: 'application/octet-stream' };
      },
      async put() {},
      async get(key) {
        if (returnNullOnGet) {
          return null;
        }
        return {
          key,
          contentType: 'application/octet-stream',
          sizeBytes: 4,
          body: bytesToStream(new Uint8Array([1, 2, 3, 4])),
        };
      },
    };
    const customMediaService = new MediaService({
      repository: ports.repository,
      mediaStore: customMediaStore,
      wikiWriteService,
      siteConfig,
    });
    await expect(
      customMediaService.getMedia({ key: 'sample.bin', rangeHeader: 'bytes=0-3' })
    ).rejects.toMatchObject({ status: 404 });

    returnNullOnGet = false;
    const rangedFallback = await customMediaService.getMedia({
      key: 'sample.bin',
      rangeHeader: 'bytes=0-3',
    });
    expect(rangedFallback.status).toBe(206);
    expect(rangedFallback.object.range).toEqual({ start: 0, end: 3, total: 10 });
  });
});

describe('pluginLifecycle, documentContributions, and securityTelemetry branch coverage', () => {
  it('normalizes all server route templates and exercises tracker span/revision/header/security branches', async () => {
    expect(normalizeServerRouteTemplate('')).toBe('/');
    expect(normalizeServerRouteTemplate('///')).toBe('/');
    expect(normalizeServerRouteTemplate('/api/entities/person/per_1/restore')).toBe(
      '/api/entities/:type/:id/restore'
    );
    expect(normalizeServerRouteTemplate('/api/entities/person/per_1/extra/path')).toBe('/api/entities/*');
    expect(normalizeServerRouteTemplate('/api/revisions/12/revert')).toBe('/api/revisions/:id/revert');
    expect(normalizeServerRouteTemplate('/api/revisions/12/other')).toBe('/api/*');
    expect(normalizeServerRouteTemplate('/api/batches/bat_1/revert')).toBe('/api/batches/:id/revert');
    expect(normalizeServerRouteTemplate('/api/batches/bat_1/other')).toBe('/api/*');
    expect(normalizeServerRouteTemplate('/api/auth/invite/tok_123')).toBe('/api/auth/invite/:token');
    expect(normalizeServerRouteTemplate('/api/media/med_1')).toBe('/api/media/:id');
    expect(normalizeServerRouteTemplate('/api/media/med_1/extra')).toBe('/api/media/*');
    expect(normalizeServerRouteTemplate('/api/talk/person/per_1/42')).toBe('/api/talk/:type/:id/:commentId');
    expect(normalizeServerRouteTemplate('/api/talk/person')).toBe('/api/talk/*');
    expect(normalizeServerRouteTemplate('/api/admin/invites/inv_1')).toBe('/api/admin/invites/:token');
    expect(normalizeServerRouteTemplate('/api/admin/agent-tokens/tok_1')).toBe('/api/admin/agent-tokens/:id');
    expect(normalizeServerRouteTemplate('/api/admin/users/a@b.test')).toBe('/api/admin/users/:email');
    expect(normalizeServerRouteTemplate('/api/admin/unknown/path')).toBe('/api/admin/*');
    expect(normalizeServerRouteTemplate('/api/pronunciations/Alder')).toBe('/api/pronunciations/:term');
    expect(normalizeServerRouteTemplate('/sources/census/1880.pdf')).toBe('/sources/:key');
    expect(normalizeServerRouteTemplate('/places/vermont')).toBe('/places/:slug');
    expect(normalizeServerRouteTemplate('/place/vermont')).toBe('/place/:slug');

    const pluginMatchers = [{ method: 'POST', normalizedPrefix: '/ext/upload' }];
    expect(normalizeServerRouteTemplate('/ext/upload', pluginMatchers, 'GET')).toBe('/*');
    expect(normalizeServerRouteTemplate('/ext/upload', pluginMatchers, 'POST')).toBe('/ext/upload');
    expect(normalizeServerRouteTemplate('/ext/upload/item', pluginMatchers)).toBe('/ext/upload/*');
    expect(
      normalizeServerRouteTemplate('/other/page', [{ method: 'GET', normalizedPrefix: '/' }], 'GET')
    ).toBe('//*');

    const receivedEvents: ServerSecurityEvent[] = [];
    const pluginWithoutHook: KinloomServerPlugin = { id: 'noop-sec', name: 'Noop Sec' };
    const pluginWithHook: KinloomServerPlugin = {
      id: 'capture-sec',
      name: 'Capture Sec',
      onSecurityEvent(event) {
        receivedEvents.push(event);
      },
    };
    const tracker = createRequestTelemetryTracker({
      request: new Request('https://alder.test/api/bundle'),
      method: 'GET',
      route: '/api/bundle',
      securityPlugins: [pluginWithoutHook, pluginWithHook],
    });
    tracker.recordSpan('d1', -5);
    tracker.recordSpan('d1', Number.NaN);
    tracker.recordSpan('d1', 12);
    tracker.setBundleRevision(-1);
    tracker.setBundleRevision(7);
    expect(tracker.snapshot().bundleRevision).toBe(7);
    tracker.setBundleRevision(null);
    expect(tracker.snapshot().bundleRevision).toBeNull();
    expect(tracker.snapshot().spans).toEqual({ d1: 12 });

    tracker.queueSecurityEvent({
      type: 'auth.invite.invalid',
      status: 404,
      reason: 'not_found',
    });
    await tracker.flushSecurityEvents();
    expect(receivedEvents).toHaveLength(1);

    tracker.snapshot().responseHeaders.append('server-timing', 'd1;dur=12');
    const mergedRes = tracker.applyResponseHeaders(
      new Response('ok', { headers: { 'server-timing': 'upstream;dur=2' } })
    );
    expect(mergedRes.headers.get('server-timing')).toContain('upstream;dur=2');
    expect(mergedRes.headers.get('server-timing')).toContain('d1;dur=12');
  });

  it('handles documentContributions HTML injection edge cases and securityTelemetry fallbacks', async () => {
    expect(isHtmlDocumentResponse(new Response('plain'))).toBe(false);
    expect(injectHtmlSnippets('<html><body><p>hi</p></body></html>', ['<p>hi</p>'])).toBe(
      '<html><body><p>hi</p></body></html>'
    );
    expect(injectHtmlSnippets('<html><head><title>T</title></head></html>', ['<script></script>'])).toBe(
      '<html><head><title>T</title><script></script>\n</head></html>'
    );
    expect(injectHtmlSnippets('<div>bare</div>', ['<span>tail</span>'])).toBe(
      '<div>bare</div>\n<span>tail</span>'
    );

    const compiled = compilePluginDocumentContributions([
      {
        documentContributions: {
          csp: { connectSrc: ['https://metrics.alder.test'] },
          bodyEndHtml: ['', '<!-- a -->', '<!-- a -->'],
          privacyDisclosures: [
            { id: 'disc-1', summary: 'First disclosure' },
            { id: 'disc-1', summary: 'Duplicate disclosure' },
          ],
        },
      },
      {
        documentContributions: {
          privacyDisclosures: [{ id: 'disc-2', summary: 'Second disclosure' }],
        },
      },
    ]);
    expect(compiled?.bodyEndHtml).toEqual(['<!-- a -->']);
    expect(compiled?.privacyDisclosures).toHaveLength(2);

    const noCspCompiled = compilePluginDocumentContributions([
      { documentContributions: { privacyDisclosures: [{ id: 'only-disc', summary: 'Note' }] } },
    ]);
    expect(noCspCompiled?.contentSecurityPolicy).toBeUndefined();

    // finalizeServerResponse when snippet is already present (rewrittenHtml === originalHtml)
    const alreadyPresentRes = await finalizeServerResponse({
      request: new Request('https://alder.test/'),
      pathname: '/',
      response: new Response('<html><body><!-- a --></body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
      isSecure: true,
      isMediaPath: false,
      documentContributions: compiled,
    });
    expect(await alreadyPresentRes.text()).toBe('<html><body><!-- a --></body></html>');

    // securityTelemetry branches
    expect(isSecurityTelemetryEnabled(true)).toBe(true);
    expect(isSecurityTelemetryEnabled(false)).toBe(false);
    expect(isSecurityTelemetryEnabled(undefined)).toBe(false);
    expect(isSecurityTelemetryEnabled({ enabled: true })).toBe(true);
    expect(isSecurityTelemetryEnabled({ enabled: false })).toBe(false);

    const baseEvent: ServerSecurityEvent = {
      type: 'auth.write.forbidden',
      timestamp: '2026-11-26T12:00:00.000Z',
      method: 'BAD METHOD!',
      route: 'relative/path?token=secret',
      status: 403,
      reason: 'member_required',
      request: new Request('https://alder.test/api/talk/person/per_1'),
      metadata: new Map(),
    };
    const built = buildSecurityTelemetryLogRecord({
      event: baseEvent,
      requestId: 'req-1',
    });
    expect(built.method).toBe('UNKNOWN');
    expect(built.route).toBe('/relative/path');
    expect(built.timestamp).toBe('2026-11-26T12:00:00.000Z');
    expect(built.required_role).toBeUndefined();
    expect(built.actor_kind).toBeUndefined();

    expect(
      createSecurityTelemetryHandler({
        option: false,
        resolveRequestId: () => 'req-1',
      })
    ).toBeUndefined();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const defaultHandler = createSecurityTelemetryHandler({
        option: true,
        resolveRequestId: () => 'req-2',
      });
      expect(defaultHandler).toBeDefined();
      await defaultHandler?.(baseEvent);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }

    const reported: unknown[] = [];
    const records: SecurityTelemetryLogRecord[] = [];
    const alertHandler = createSecurityTelemetryHandler({
      option: {
        enabled: true,
        sink(rec) {
          records.push(rec);
        },
        alertSink: async () => {
          throw new Error('async alert fail');
        },
      },
      resolveRequestId: () => 'req-3',
    });
    await alertHandler?.({
      ...baseEvent,
      waitUntil() {
        throw new Error('waitUntil rejected');
      },
      reportError(err) {
        reported.push(err);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(records).toHaveLength(1);
    expect(reported.length).toBeGreaterThanOrEqual(1);
  });
});

describe('httpPrimitives, session, authMiddleware, authService, and authRoutes branch coverage', () => {
  it('exercises httpPrimitives and session token verification edge cases', async () => {
    expect(await readJsonBody(new Request('https://alder.test/x', { method: 'POST', body: '   ' }))).toEqual(
      {}
    );
    expect(() => parsePositiveInt('abc', 'limit')).toThrow(KinloomHttpError);
    expect(() => parsePositiveInt('0', 'limit')).toThrow(KinloomHttpError);
    expect(() => parsePositiveInt('999999999999999999999', 'limit')).toThrow(KinloomHttpError);

    expect(
      mapAuthErrorToBrowserCode(
        new KinloomHttpError(403, 'INVITE_REQUIRED', 'expired', { invite_status: 'expired' }),
        'invite'
      )
    ).toBe('INVITE_EXPIRED');
    expect(
      mapAuthErrorToBrowserCode(
        new KinloomHttpError(403, 'INVITE_REQUIRED', 'revoked', { invite_status: 'revoked' }),
        'invite'
      )
    ).toBe('INVITE_REVOKED');
    expect(
      mapAuthErrorToBrowserCode(
        new KinloomHttpError(403, 'INVITE_REQUIRED', 'bad detail', { invite_status: 42 }),
        'invite'
      )
    ).toBe('INVITE_REQUIRED');
    expect(mapAuthErrorToBrowserCode(new KinloomHttpError(400, 'non-canonical', 'x'), 'google')).toBe(
      'GOOGLE_AUTH_FAILED'
    );
    expect(mapAuthErrorToBrowserCode(new Error('unexpected'), 'magic_link')).toBe('MAGIC_LINK_INVALID');
    expect(mapAuthErrorToBrowserCode(new Error('unexpected'), 'invite')).toBe('INVITE_INVALID');
    expect(buildAuthErrorRedirectUrl('/people', 'bad code!', 'google')).toBe(
      '/people?auth_error=AUTH_ERROR&auth_provider=google'
    );

    expect(getOAuthCookieName(false)).toBe('kinloom_oauth');
    const cookies = parseCookies('badsegment; =empty; alpha=1; alpha=2');
    expect(cookies.get('alpha')).toBe('1');
    expect(cookies.size).toBe(1);

    const insecureReqDev = new Request('http://localhost/test', {
      headers: { cookie: 'kinloom_oauth=devtok' },
    });
    expect(readOAuthCookieRaw(insecureReqDev, false)).toBe('devtok');
    const insecureReqProdFallback = new Request('http://localhost/test', {
      headers: { cookie: '__Host-kinloom_oauth=prodtok' },
    });
    expect(readOAuthCookieRaw(insecureReqProdFallback, false)).toBe('prodtok');
    expect(readOAuthCookieRaw(new Request('http://localhost/test'), false)).toBeNull();

    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    expect(await verifySessionToken(CONTRACT_SESSION_SECRET, 'abc.', clock)).toBeNull();
    expect(await verifySessionToken(CONTRACT_SESSION_SECRET, 'abc.def', clock)).toBeNull();

    // Validly signed non-UTF8 / non-JSON / invalid-schema / expired session tokens
    const badJsonEncoded = base64UrlEncodeString('{not-json');
    const badJsonSig = await hmacSignBase64Url(CONTRACT_SESSION_SECRET, badJsonEncoded);
    expect(
      await verifySessionToken(CONTRACT_SESSION_SECRET, `${badJsonEncoded}.${badJsonSig}`, clock)
    ).toBeNull();

    const badSchemaEncoded = base64UrlEncodeString(JSON.stringify({ kind: 'unknown', exp: 9999999999 }));
    const badSchemaSig = await hmacSignBase64Url(CONTRACT_SESSION_SECRET, badSchemaEncoded);
    expect(
      await verifySessionToken(CONTRACT_SESSION_SECRET, `${badSchemaEncoded}.${badSchemaSig}`, clock)
    ).toBeNull();

    const expiredToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: -10,
      payload: { kind: 'user', email: 'a@alder.test', display_name: 'Alder', role: 'editor' },
    });
    expect(await verifySessionToken(CONTRACT_SESSION_SECRET, expiredToken, clock)).toBeNull();
  });

  it('exercises authMiddleware, authService, and authRoutes failure classifications', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });

    // Deleted user cookie resolves to anonymous
    const deletedUserToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: { kind: 'user', email: 'gone@alder.test', display_name: 'Gone', role: 'editor' },
    });
    const deletedUserAuth = await resolveCallerPrincipal({
      request: new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`, {
        headers: { cookie: `__Host-kinloom_session=${deletedUserToken}` },
      }),
      url: new URL(`${CONTRACT_TEST_ORIGIN}/api/auth/me`),
      sessionSecret: CONTRACT_SESSION_SECRET,
      repository: ports.repository,
      clock,
    });
    expect(deletedUserAuth.principal.kind).toBe('anonymous');

    // Revoked invite cookie emits auth.invite.invalid and resolves to anonymous
    await ports.repository.createInvite({
      token: 'inv_revoked_1',
      label: 'Revoked',
      created_by: 'admin@alder.test',
      created_at: clock.nowIso(),
      expires_at: null,
      revoked_at: clock.nowIso(),
      uses: 0,
      last_used_at: null,
    });
    const revokedInviteToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: { kind: 'invite_viewer', invite_token: 'inv_revoked_1', label: 'Revoked' },
    });
    const middlewareEvents: string[] = [];
    const revokedInviteAuth = await resolveCallerPrincipal({
      request: new Request(`${CONTRACT_TEST_ORIGIN}/api/bundle`, {
        headers: { cookie: `__Host-kinloom_session=${revokedInviteToken}` },
      }),
      url: new URL(`${CONTRACT_TEST_ORIGIN}/api/bundle`),
      sessionSecret: CONTRACT_SESSION_SECRET,
      repository: ports.repository,
      clock,
      telemetry: {
        now: () => 0,
        recordSpan: () => undefined,
        queueSecurityEvent(e) {
          middlewareEvents.push(`${e.type}:${e.reason}`);
        },
      },
    });
    expect(revokedInviteAuth.principal.kind).toBe('anonymous');
    expect(middlewareEvents).toContain('auth.invite.invalid:revoked');

    // requireMinRole & principalToRevisionAuthor edge cases
    expect(() =>
      requireMinRole({ kind: 'invite_viewer', invite_token: 'inv_1', label: 'Family' }, 'admin', {
        adminForbiddenCode: 'ADMIN_REQUIRED',
      })
    ).toThrow(KinloomHttpError);
    expect(() =>
      requireMinRole({ kind: 'user', email: 'ed@alder.test', display_name: 'Ed', role: 'editor' }, 'admin')
    ).toThrow(KinloomHttpError);
    expect(
      principalToRevisionAuthor(
        { kind: 'user', email: 'ed@alder.test', display_name: 'Ed', role: 'editor' },
        'system_seed'
      ).author_type
    ).toBe('system_seed');
    expect(
      principalToRevisionAuthor(
        { kind: 'agent', token_id: 'tok_1', label: 'Bot', scope: 'write_batch' },
        'system_seed'
      ).author_type
    ).toBe('system_seed');
    expect(() => principalToRevisionAuthor({ kind: 'anonymous' })).toThrow(KinloomHttpError);

    // AuthService unit edge cases
    expect(sanitizeNextPath('/people?auth_error=BAD&keep=1')).toBe('/people?keep=1');
    const authServiceNoProvider = new AuthService({
      repository: ports.repository,
      emailSender: {
        async sendMagicLink() {
          throw new KinloomHttpError(503, 'EMAIL_SENDER_UNCONFIGURED', 'No mail');
        },
      },
      clock,
      siteConfig: { ...siteConfig, wiki: undefined },
      bootstrapAdminEmail: 'admin@alder.test',
    });
    const inviteSessionInfo = authServiceNoProvider.getSessionInfo({
      kind: 'invite_viewer',
      invite_token: 'inv_1',
      label: 'Cousins',
    });
    expect(inviteSessionInfo.session.principal_kind).toBe('invite_viewer');
    await expect(authServiceNoProvider.redeemInvite('   ')).rejects.toMatchObject({ status: 404 });
    await expect(
      authServiceNoProvider.completeGoogleAuth({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
        inviteToken: null,
      })
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      authServiceNoProvider.requestMagicLink({
        email: 'admin@alder.test',
        inviteToken: 'inv_revoked_1',
        verifyBaseUrl: `${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/verify`,
      })
    ).rejects.toMatchObject({ status: 503, code: 'EMAIL_SENDER_UNCONFIGURED' });
    await expect(authServiceNoProvider.verifyMagicLink({ rawToken: 'short' })).rejects.toMatchObject({
      status: 400,
    });

    // Repository without optional getMagicLink falls back to expired status
    const noGetMagicLinkAuth = new AuthService({
      repository: {
        getUser: (e) => ports.repository.getUser(e),
        listUsers: () => ports.repository.listUsers(),
        upsertUser: (u) => ports.repository.upsertUser(u),
        updateUserRole: (e, r) => ports.repository.updateUserRole(e, r),
        deleteUser: (e) => ports.repository.deleteUser(e),
        touchUserLogin: (e, t) => ports.repository.touchUserLogin(e, t),
        getInvite: (t) => ports.repository.getInvite(t),
        listInvites: () => ports.repository.listInvites(),
        createInvite: (i) => ports.repository.createInvite(i),
        recordInviteUse: (t, a) => ports.repository.recordInviteUse(t, a),
        revokeInvite: (t, a) => ports.repository.revokeInvite(t, a),
        insertMagicLink: (r) => ports.repository.insertMagicLink(r),
        countRecentMagicLinks: (e, s) => ports.repository.countRecentMagicLinks(e, s),
        consumeMagicLink: async () => null,
        findActiveAgentTokenByHash: (h) => ports.repository.findActiveAgentTokenByHash(h),
        listAgentTokens: () => ports.repository.listAgentTokens(),
        createAgentToken: (r) => ports.repository.createAgentToken(r),
        revokeAgentToken: (id, a) => ports.repository.revokeAgentToken(id, a),
      },
      emailSender: ports.emailSender,
      clock,
      siteConfig,
    });
    await expect(
      noGetMagicLinkAuth.verifyMagicLink({ rawToken: 'long_unknown_token' })
    ).rejects.toMatchObject({
      status: 400,
      details: { token_status: 'expired' },
    });

    // Blank displayName + empty email local part fallback in bootstrap/invite enrollment
    await ports.repository.createInvite({
      token: 'inv_active_1',
      label: 'Active',
      created_by: 'admin@alder.test',
      created_at: clock.nowIso(),
      expires_at: null,
      revoked_at: null,
      uses: 0,
      last_used_at: null,
    });
    const fakeAuth = new FakeAuthProvider();
    fakeAuth.registerCode('code_blank_admin', {
      email: 'admin@alder.test',
      displayName: '   ',
      emailVerified: true,
    });
    fakeAuth.registerCode('code_blank_invite', {
      email: '@alder.test',
      displayName: '   ',
      emailVerified: true,
    });
    fakeAuth.registerCode('code_unverified', {
      email: 'unverified@alder.test',
      displayName: 'Unverified',
      emailVerified: false,
    });
    fakeAuth.registerCode('code_unenrolled', {
      email: 'stranger@alder.test',
      displayName: 'Stranger',
      emailVerified: true,
    });
    const authServiceWithProvider = new AuthService({
      repository: ports.repository,
      emailSender: ports.emailSender,
      authProvider: fakeAuth,
      clock,
      siteConfig,
      bootstrapAdminEmail: 'admin@alder.test',
    });
    const bootstrapped = await authServiceWithProvider.completeGoogleAuth({
      code: 'code_blank_admin',
      codeVerifier: 'v',
      redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
      inviteToken: null,
    });
    expect(bootstrapped.user.display_name).toBe('Admin');
    const invitedBlank = await authServiceWithProvider.completeGoogleAuth({
      code: 'code_blank_invite',
      codeVerifier: 'v',
      redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
      inviteToken: 'inv_active_1',
    });
    expect(invitedBlank.user.display_name).toBe('Family Member');
    // Second sign-in as existing editor exercises existing member branch
    const existingSignIn = await authServiceWithProvider.completeGoogleAuth({
      code: 'code_blank_invite',
      codeVerifier: 'v',
      redirectUri: `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback`,
      inviteToken: null,
    });
    expect(existingSignIn.autoEnrolled).toBe(false);

    // authRoutes HTTP branches with security event plugin active
    const securityEvents: ServerSecurityEvent[] = [];
    const securityPlugin: KinloomServerPlugin = {
      id: 'auth-sec',
      name: 'Auth Sec',
      onSecurityEvent(ev) {
        securityEvents.push(ev);
      },
    };
    const serverNoGoogle = createKinloomServer({
      siteConfig,
      ports: { ...ports, authProvider: undefined, plugins: [securityPlugin] },
      sessionSecret: CONTRACT_SESSION_SECRET,
    });
    const startNoGoogleJson = await serverNoGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/google/start`, {
        headers: { accept: 'application/json' },
      })
    );
    expect(startNoGoogleJson.status).toBe(503);

    const serverWithGoogle = createKinloomServer({
      siteConfig,
      ports: { ...ports, authProvider: fakeAuth, plugins: [securityPlugin] },
      sessionSecret: CONTRACT_SESSION_SECRET,
    });

    // OAuth callback: cancelled, provider_error, invalid_state, unverified email, invite_required, exchange_failed
    const cbCancel = await serverWithGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?error=access_denied`, {
        headers: { accept: 'application/json' },
      })
    );
    expect(cbCancel.status).toBe(400);

    const cbProviderErr = await serverWithGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?error=temporarily_unavailable`, {
        headers: { accept: 'application/json' },
      })
    );
    expect(cbProviderErr.status).toBe(400);

    // Start Google auth to get a valid oauth cookie, then replay callback with various fake codes
    const startRes = await serverWithGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/google/start?next=%2Fpeople`, {
        headers: { accept: 'text/html' },
      })
    );
    expect(startRes.status).toBe(302);
    const oauthCookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const authUrl = new URL(startRes.headers.get('location') ?? '');
    const state = authUrl.searchParams.get('state') ?? '';

    const cbUnverified = await serverWithGoogle.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?code=code_unverified&state=${encodeURIComponent(state)}`,
        { headers: { cookie: oauthCookie, accept: 'application/json' } }
      )
    );
    expect(cbUnverified.status).toBe(403);

    const cbUnenrolled = await serverWithGoogle.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?code=code_unenrolled&state=${encodeURIComponent(state)}`,
        { headers: { cookie: oauthCookie, accept: 'application/json' } }
      )
    );
    expect(cbUnenrolled.status).toBe(403);

    const cbUnknownCode = await serverWithGoogle.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/auth/google/callback?code=unknown_code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: oauthCookie, accept: 'application/json' } }
      )
    );
    expect(cbUnknownCode.status).toBe(400);

    // Magic-link verify: missing token, revoked invite attached to magic link, unenrolled without invite, browser stale cookie clear
    const verifyMissing = await serverWithGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/verify`, {
        headers: { accept: 'application/json' },
      })
    );
    expect(verifyMissing.status).toBe(400);

    // Insert a magic link pointing to a revoked invite so verify throws INVITE_REQUIRED with invite_status
    const rawRevokedToken = 'magic_revoked_invite_token_123456';
    const revokedHash = asSha256Hex(
      Array.from(await sha256Bytes(rawRevokedToken))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
    await ports.repository.insertMagicLink({
      token_hash: revokedHash,
      email: 'newcomer@alder.test',
      invite_token: 'inv_revoked_1',
      expires_at: '2026-11-26T13:00:00.000Z',
      used_at: null,
    });
    const verifyRevokedInvite = await serverWithGoogle.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/verify?token=${encodeURIComponent(rawRevokedToken)}`,
        {
          headers: {
            accept: 'text/html',
            cookie: `__Host-kinloom_session=${deletedUserToken}`,
          },
        }
      )
    );
    expect(verifyRevokedInvite.status).toBe(302);
    expect(verifyRevokedInvite.headers.get('set-cookie')).toContain('Max-Age=0');

    // Magic link for unenrolled email with invite_token=null -> INVITE_REQUIRED without invite_status
    const rawNoInviteToken = 'magic_no_invite_token_123456';
    const noInviteHash = asSha256Hex(
      Array.from(await sha256Bytes(rawNoInviteToken))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
    await ports.repository.insertMagicLink({
      token_hash: noInviteHash,
      email: 'uninvited@alder.test',
      invite_token: null,
      expires_at: '2026-11-26T13:00:00.000Z',
      used_at: null,
    });
    const verifyNoInvite = await serverWithGoogle.fetch(
      new Request(
        `${CONTRACT_TEST_ORIGIN}/api/auth/magic-link/verify?token=${encodeURIComponent(rawNoInviteToken)}`,
        { headers: { accept: 'application/json' } }
      )
    );
    expect(verifyNoInvite.status).toBe(403);

    // Invite redeem non-browser failure
    const badInviteJson = await serverWithGoogle.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/invite/inv_revoked_1`, {
        headers: { accept: 'application/json' },
      })
    );
    expect(badInviteJson.status).toBe(404);
    expect(securityEvents.some((e) => e.type === 'auth.oauth.failed' && e.reason === 'cancelled')).toBe(true);
    expect(
      securityEvents.some((e) => e.type === 'auth.oauth.failed' && e.reason === 'email_unverified')
    ).toBe(true);
    expect(
      securityEvents.some(
        (e) => e.type === 'auth.magic_link.invalid_or_expired' && e.reason === 'invite_required'
      )
    ).toBe(true);
    expect(securityEvents.some((e) => e.type === 'auth.invite.invalid' && e.reason === 'revoked')).toBe(true);
  });
});

describe('wikiWriteService, batchCompiler, batchRevertCompiler, and commitPipeline branch coverage', () => {
  it('exercises create/update/delete/restore/revert error paths and batch/revert compiler branches', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });
    const service = new WikiWriteService({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock,
      siteConfig,
    });

    const person = createSyntheticHistoricalPerson({ id: 'per_ww_1' });
    const created = await service.createEntity({
      entityType: 'person',
      entityId: person.id,
      data: toEntityPayload(person),
      summary: 'Create historical person',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });

    // updateEntity missing -> 404, merge: false -> full replace
    await expect(
      service.updateEntity({
        entityType: 'person',
        entityId: 'per_missing',
        expectedParentRevisionId: asRevisionId(1),
        data: toEntityPayload(person),
        summary: 'Update missing',
        hasPrimarySource: true,
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 404 });

    const updated = await service.updateEntity({
      entityType: 'person',
      entityId: person.id,
      expectedParentRevisionId: asRevisionId(created.revision.revision_id),
      data: toEntityPayload({ ...person, full_name: 'Arthur Miller Alder' }),
      merge: false,
      summary: 'Full replace person',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });

    // deleteEntity missing -> 404, stale parent -> 409
    await expect(
      service.deleteEntity({
        entityType: 'person',
        entityId: 'per_missing',
        expectedParentRevisionId: asRevisionId(1),
        summary: 'Delete missing',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      service.deleteEntity({
        entityType: 'person',
        entityId: person.id,
        expectedParentRevisionId: asRevisionId(created.revision.revision_id),
        summary: 'Delete stale',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409 });

    // restoreEntity on missing -> 404, on active entity -> 409
    await expect(
      service.restoreEntity({
        entityType: 'person',
        entityId: 'per_missing',
        expectedParentRevisionId: asRevisionId(1),
        summary: 'Restore missing',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      service.restoreEntity({
        entityType: 'person',
        entityId: person.id,
        expectedParentRevisionId: asRevisionId(updated.revision.revision_id),
        summary: 'Restore active',
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409 });

    // Soft-delete person, then attempt create on soft-deleted -> 409
    const deleted = await service.deleteEntity({
      entityType: 'person',
      entityId: person.id,
      expectedParentRevisionId: asRevisionId(updated.revision.revision_id),
      summary: 'Soft delete person',
      author: EDITOR_AUTHOR,
    });
    await expect(
      service.createEntity({
        entityType: 'person',
        entityId: person.id,
        data: toEntityPayload(person),
        summary: 'Recreate soft-deleted',
        hasPrimarySource: true,
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409, code: 'ENTITY_EXISTS' });

    // Restore with data override
    const restored = await service.restoreEntity({
      entityType: 'person',
      entityId: person.id,
      expectedParentRevisionId: asRevisionId(deleted.revision.revision_id),
      data: { full_name: 'Arthur Restored Alder' },
      summary: 'Restore with updated full name',
      author: EDITOR_AUTHOR,
    });
    expect(restored.entity.full_name).toBe('Arthur Restored Alder');

    // Kinship edge delete & restore exercises 'edge' in existing branch
    const edgeCreated = await service.createEntity({
      entityType: 'kinship_edge',
      data: { from: 'per_ww_1', to: 'per_ww_2', relation: 'parent' },
      summary: 'Create kinship edge',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    const edgeId = edgeCreated.revision.entity_id;
    const edgeDeleted = await service.deleteEntity({
      entityType: 'kinship_edge',
      entityId: edgeId,
      expectedParentRevisionId: asRevisionId(edgeCreated.revision.revision_id),
      summary: 'Delete kinship edge',
      author: EDITOR_AUTHOR,
    });
    const edgeRestored = await service.restoreEntity({
      entityType: 'kinship_edge',
      entityId: edgeId,
      expectedParentRevisionId: asRevisionId(edgeDeleted.revision.revision_id),
      summary: 'Restore kinship edge',
      author: EDITOR_AUTHOR,
    });
    expect(edgeRestored.revision.action).toBe('restore');

    // revertRevision missing -> 404, reverting a create -> soft-deletes, reverting create again -> 409, reverting a delete -> restores
    await expect(
      service.revertRevision({ revisionId: asRevisionId(9999), author: EDITOR_AUTHOR })
    ).rejects.toMatchObject({ status: 404 });

    const singleCreated = await service.createEntity({
      entityType: 'place',
      entityId: 'plc_rev_1',
      data: {
        id: 'plc_rev_1',
        slug: 'alder-mill',
        name: 'Alder Mill',
        full_name: 'Alder Mill, VT',
        place_type: 'town',
        parent_id: null,
        lat: 44.26,
        lng: -72.58,
      },
      summary: 'Create place for revert',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    const revCreate = await service.revertRevision({
      revisionId: asRevisionId(singleCreated.revision.revision_id),
      author: EDITOR_AUTHOR,
    });
    expect(revCreate.revision.after_json).toBeNull();
    await expect(
      service.revertRevision({
        revisionId: asRevisionId(singleCreated.revision.revision_id),
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409 });
    const revDelete = await service.revertRevision({
      revisionId: asRevisionId(revCreate.revision.revision_id),
      author: EDITOR_AUTHOR,
    });
    expect(revDelete.revision.after_json).not.toBeNull();

    // Batch compiler & batch revert compiler branches (including media referencing event, per-patch has_primary_source, delete person/event, merge: false, restore with data, double-mutated entity revert)
    const histEvt: RawEvent = createSyntheticEvent({
      id: 'evt_batch_1',
      title: 'Alder Homestead',
      participants: [{ person_id: person.id, role: 'principal' }],
    });
    const batch1 = await service.submitBatch({
      submission: {
        batch_id: 'bat_media_1',
        author_type: 'human',
        summary: 'Seed event and media batch',
        has_primary_source: true,
        patches: [
          {
            action: 'create',
            entity_type: 'event',
            entity_id: histEvt.id,
            data: toEntityPayload(histEvt),
          },
          {
            action: 'create',
            entity_type: 'media',
            entity_id: 'med_batch_1',
            has_primary_source: false,
            data: {
              id: 'med_batch_1',
              kind: 'family_photo',
              caption: 'Homestead Photo',
              file: '/media/homestead.jpg',
              event_id: histEvt.id,
            },
          },
          {
            action: 'update',
            entity_type: 'media',
            entity_id: 'med_batch_1',
            merge: true,
            data: { caption: 'Homestead Photo (Updated)' },
          },
        ],
      },
      author: EDITOR_AUTHOR,
    });
    expect(batch1.revisions).toHaveLength(3);

    // Batch updating existing media WITHOUT event_id in patch triggers extraEventKeys prefetch + full replace merge:false
    const mediaRev = batch1.revisions[2].revision_id;
    const batch2 = await service.submitBatch({
      submission: {
        batch_id: 'bat_media_2',
        author_type: 'human',
        summary: 'Update media without event_id and delete/restore',
        has_primary_source: true,
        patches: [
          {
            action: 'update',
            entity_type: 'media',
            entity_id: 'med_batch_1',
            parent_revision_id: mediaRev,
            merge: true,
            data: { caption: 'Homestead v3' },
          },
          {
            action: 'delete',
            entity_type: 'media',
            entity_id: 'med_batch_1',
          },
          {
            action: 'restore',
            entity_type: 'media',
            entity_id: 'med_batch_1',
            data: { caption: 'Homestead Restored' },
          },
        ],
      },
      author: EDITOR_AUTHOR,
    });
    expect(batch2.revisions).toHaveLength(3);

    // Reverting batch2 unwinds multiple ops on same entity (hits alreadyLocked & media event prefetch)
    const reverted2 = await service.revertBatch({
      batchId: asBatchId('bat_media_2'),
      summary: 'Undo media v3 batch',
      author: EDITOR_AUTHOR,
    });
    expect(reverted2.revisions).toHaveLength(3);

    // Reverting unknown batch -> 404
    await expect(
      service.revertBatch({ batchId: asBatchId('bat_missing'), author: EDITOR_AUTHOR })
    ).rejects.toMatchObject({ status: 404 });

    // Reverting batch1 now works, then reverting again conflicts -> 409
    await service.revertBatch({ batchId: asBatchId('bat_media_1'), author: EDITOR_AUTHOR });
    await expect(
      service.revertBatch({ batchId: asBatchId('bat_media_1'), author: EDITOR_AUTHOR })
    ).rejects.toMatchObject({ status: 409 });

    // Batch delete person + event + conflict error branches
    const p2 = createSyntheticHistoricalPerson({ id: 'per_bdel' });
    const createdP2 = await service.createEntity({
      entityType: 'person',
      entityId: p2.id,
      data: toEntityPayload(p2),
      summary: 'Seed person for batch delete',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    const ev2: RawEvent = createSyntheticEvent({
      id: 'evt_bdel',
      title: 'Event 2',
      participants: [],
    });
    await service.createEntity({
      entityType: 'event',
      entityId: ev2.id,
      data: toEntityPayload(ev2),
      summary: 'Seed event for batch delete',
      hasPrimarySource: true,
      author: EDITOR_AUTHOR,
    });
    await service.submitBatch({
      submission: {
        batch_id: 'bat_del_pe',
        author_type: 'human',
        summary: 'Delete person and event',
        has_primary_source: true,
        patches: [
          {
            action: 'update',
            entity_type: 'person',
            entity_id: p2.id,
            parent_revision_id: createdP2.revision.revision_id,
            merge: false,
            data: toEntityPayload({ ...p2, full_name: 'Arthur Cooper Alder' }),
          },
          { action: 'delete', entity_type: 'person', entity_id: p2.id },
          { action: 'delete', entity_type: 'event', entity_id: ev2.id },
        ],
      },
      author: EDITOR_AUTHOR,
    });

    // Update or delete soft-deleted entity in batch -> 409
    await expect(
      service.submitBatch({
        submission: {
          batch_id: 'bat_err_upd_del',
          author_type: 'human',
          summary: 'Update soft deleted fails',
          has_primary_source: true,
          patches: [
            {
              action: 'update',
              entity_type: 'person',
              entity_id: p2.id,
              merge: true,
              data: { full_name: 'Arthur Baker Alder' },
            },
          ],
        },
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      service.submitBatch({
        submission: {
          batch_id: 'bat_err_del_del',
          author_type: 'human',
          summary: 'Delete soft deleted fails',
          has_primary_source: true,
          patches: [{ action: 'delete', entity_type: 'person', entity_id: p2.id }],
        },
        author: EDITOR_AUTHOR,
      })
    ).rejects.toMatchObject({ status: 409 });

    // Stale parent_revision_id in compileBatchSubmissionOps -> 409
    const pipeline = new WikiCommitPipeline({
      repository: ports.repository,
      bundleCache: ports.bundleCache,
      clock,
      plugins: [],
    });
    await expect(
      compileBatchSubmissionOps(
        { repository: ports.repository, clock, siteConfig, commitPipeline: pipeline },
        {
          batch_id: 'bat_stale_parent',
          author_type: 'human',
          summary: 'Stale parent in batch',
          has_primary_source: true,
          patches: [
            {
              action: 'update',
              entity_type: 'person',
              entity_id: person.id,
              parent_revision_id: 1,
              merge: true,
              data: { full_name: 'Stale Name' },
            },
          ],
        }
      )
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      compileBatchRevertOps(
        { repository: ports.repository, clock, siteConfig },
        { batchId: asBatchId('bat_missing_2') }
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('exercises WikiCommitPipeline conflict, stream cancellation, parsedBundle, and empty etag fallbacks', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });

    // buildInitialSnapshotFromRevisions with kinship delete (after_json: null)
    const snap = buildInitialSnapshotFromRevisions(
      [
        {
          revision_id: asRevisionId(1),
          batch_id: null,
          entity_type: 'kinship_edge',
          entity_id: 'edge_1',
          parent_revision_id: null,
          action: 'create',
          reverted_revision_id: null,
          author_id: 'ed@alder.test',
          author_name: 'Ed',
          author_type: 'human',
          summary: 'Create edge',
          has_primary_source: true,
          before_json: null,
          after_json: { from: 'per_a', to: 'per_b', relation: 'parent' },
          created_at: clock.nowIso(),
        },
        {
          revision_id: asRevisionId(2),
          batch_id: null,
          entity_type: 'kinship_edge',
          entity_id: 'edge_1',
          parent_revision_id: asRevisionId(1),
          action: 'delete',
          reverted_revision_id: null,
          author_id: 'ed@alder.test',
          author_name: 'Ed',
          author_type: 'human',
          summary: 'Delete edge',
          has_primary_source: true,
          before_json: { from: 'per_a', to: 'per_b', relation: 'parent' },
          after_json: null,
          created_at: clock.nowIso(),
        },
      ],
      asRevisionId(2)
    );
    expect(snap.kinship).toEqual([]);

    // buildConflictHttpError with no revision history and soft-deleted existing entity
    const noApplyCache: BundleCache = {
      async getCached() {
        return { status: 'miss' };
      },
      async rebuildAndStore(snapshot): Promise<CachedBundleObject> {
        return {
          etag: '',
          revision_id: snapshot.head_revision_id,
          body: '{}',
          byteLength: 2,
          generated_at: clock.nowIso(),
        };
      },
    };
    const pipelineNoApply = new WikiCommitPipeline({
      repository: ports.repository,
      bundleCache: noApplyCache,
      clock,
      plugins: [],
    });
    const conflictErr = await pipelineNoApply.buildConflictHttpError({
      entityType: 'person',
      entityId: 'per_ghost',
      expectedParentRevisionId: asRevisionId(1),
      existing: {
        entity_type: 'person',
        entity_id: 'per_ghost',
        slug: null,
        data: toEntityPayload(createSyntheticHistoricalPerson({ id: 'per_ghost' })),
        current_revision_id: asRevisionId(2),
        has_primary_source: true,
        deleted_at: clock.nowIso(),
        updated_at: clock.nowIso(),
      },
      candidateAfter: null,
    });
    expect(conflictErr.status).toBe(409);

    // commitAndPropagate falls back to `"r1"` when rebuildAndStore returns empty etag
    const person = createSyntheticHistoricalPerson({ id: 'per_cp_1' });
    const committed1 = await pipelineNoApply.commitAndPropagate({
      batchId: null,
      author: EDITOR_AUTHOR,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          slug: null,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed cp1',
          has_primary_source: true,
          before_json: null,
          after_json: toEntityPayload(person),
        },
      ],
    });
    expect(committed1.etag).toBe('"r1"');

    // commitAndPropagate conflict throw when duplicate create hits store
    await expect(
      pipelineNoApply.commitAndPropagate({
        batchId: null,
        author: EDITOR_AUTHOR,
        operations: [
          {
            entity_type: 'person',
            entity_id: person.id,
            slug: null,
            action: 'create',
            expected_parent_revision_id: null,
            summary: 'Duplicate cp1',
            has_primary_source: true,
            before_json: null,
            after_json: toEntityPayload(person),
          },
        ],
      })
    ).rejects.toMatchObject({ status: 409, code: 'OPTIMISTIC_CONFLICT' });

    // parsedBundle valid with ReadableStream body, parsedBundle invalid, and mismatched revision with ReadableStream body
    const compiledBundle = compileArchive({
      people: [person],
      sources: [],
      events: [],
      places: [],
      kinship: [],
      media: [],
      narratives: [],
      siteConfig,
      mode: 'private',
      generatedAt: clock.nowIso(),
      maxRevisionId: 1,
    }).bundle;

    let cacheMode: 'validParsedStream' | 'invalidParsed' | 'staleRevStream' = 'validParsedStream';
    const customCache: BundleCache = {
      async getCached() {
        if (cacheMode === 'validParsedStream') {
          return {
            status: 'hit',
            object: {
              etag: '"r1"',
              revision_id: asRevisionId(1),
              body: bytesToStream(new TextEncoder().encode('{}')),
              byteLength: 2,
              generated_at: clock.nowIso(),
              parsedBundle: compiledBundle,
            },
          };
        }
        if (cacheMode === 'invalidParsed') {
          return {
            status: 'hit',
            object: {
              etag: '"r2"',
              revision_id: asRevisionId(2),
              body: '{}',
              byteLength: 2,
              generated_at: clock.nowIso(),
              parsedBundle: {
                ...compiledBundle,
                meta: {
                  ...compiledBundle.meta,
                  counts: {
                    ...compiledBundle.meta.counts,
                    people: -1,
                  },
                },
              },
            },
          };
        }
        return {
          status: 'hit',
          object: {
            etag: '"r0"',
            revision_id: asRevisionId(0),
            body: bytesToStream(new TextEncoder().encode('{}')),
            byteLength: 2,
            generated_at: clock.nowIso(),
          },
        };
      },
      async applyMutationsAndStore(_prev, muts) {
        const lastRev = muts[muts.length - 1]?.revision_id;
        const maxRev = asRevisionId(lastRev ?? 0);
        return {
          etag: `"r${maxRev}"`,
          revision_id: maxRev,
          body: '{}',
          byteLength: 2,
          generated_at: clock.nowIso(),
        };
      },
      async rebuildAndStore(snapshot) {
        return {
          etag: `"r${snapshot.head_revision_id}"`,
          revision_id: snapshot.head_revision_id,
          body: '{}',
          byteLength: 2,
          generated_at: clock.nowIso(),
        };
      },
    };
    const pipelineStream = new WikiCommitPipeline({
      repository: ports.repository,
      bundleCache: customCache,
      clock,
      plugins: [],
    });

    // r2: hits validParsedStream -> cancels stream and applies incremental patch
    const r2 = await pipelineStream.commitAndPropagate({
      batchId: null,
      author: EDITOR_AUTHOR,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          slug: null,
          action: 'update',
          expected_parent_revision_id: asRevisionId(1),
          summary: 'Update r2',
          has_primary_source: true,
          before_json: toEntityPayload(person),
          after_json: toEntityPayload({ ...person, occupation: 'Smith' }),
        },
      ],
    });
    expect(r2.etag).toBe('"r2"');

    // r3: hits invalidParsed -> falls back to rebuild
    cacheMode = 'invalidParsed';
    const r3 = await pipelineStream.commitAndPropagate({
      batchId: null,
      author: EDITOR_AUTHOR,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          slug: null,
          action: 'update',
          expected_parent_revision_id: asRevisionId(2),
          summary: 'Update r3',
          has_primary_source: true,
          before_json: toEntityPayload({ ...person, occupation: 'Smith' }),
          after_json: toEntityPayload({ ...person, occupation: 'Joiner' }),
        },
      ],
    });
    expect(r3.etag).toBe('"r3"');

    // r4: hits staleRevStream -> cancels stream and falls back to rebuild
    cacheMode = 'staleRevStream';
    const r4 = await pipelineStream.commitAndPropagate({
      batchId: null,
      author: EDITOR_AUTHOR,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          slug: null,
          action: 'update',
          expected_parent_revision_id: asRevisionId(3),
          summary: 'Update r4',
          has_primary_source: true,
          before_json: toEntityPayload({ ...person, occupation: 'Joiner' }),
          after_json: toEntityPayload({ ...person, occupation: 'Weaver' }),
        },
      ],
    });
    expect(r4.etag).toBe('"r4"');
  });
});

describe('InMemory stores, BundleReadService, AdminService, GoogleOAuthProvider, and PronunciationService branch coverage', () => {
  it('exercises InMemoryEntityAndMutationStore, InMemoryAccessAndTalkStore, and InMemory bundle/media stores', async () => {
    const store = new InMemoryEntityAndMutationStore();
    const nowIso = '2026-11-26T12:00:00.000Z';
    const person = createSyntheticHistoricalPerson({ id: 'per_mem_1' });

    // Create entity & kinship edge
    const c1 = await store.commitAtomicMutations({
      batch_id: asBatchId('bat_mem_1'),
      author: EDITOR_AUTHOR,
      nowIso,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Create person',
          has_primary_source: true,
          before_json: null,
          after_json: toEntityPayload(person),
        },
        {
          entity_type: 'kinship_edge',
          entity_id: 'edge_mem_1',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Create edge',
          has_primary_source: true,
          before_json: null,
          after_json: { from: 'per_mem_1', to: 'per_mem_2', relation: 'parent' },
        },
      ],
    });
    expect(c1.kind).toBe('committed');

    // Duplicate create -> conflict; update missing -> conflict; update null parent -> conflict; restore active -> conflict
    expect(
      (
        await store.commitAtomicMutations({
          batch_id: null,
          author: EDITOR_AUTHOR,
          nowIso,
          operations: [
            {
              entity_type: 'person',
              entity_id: person.id,
              action: 'create',
              expected_parent_revision_id: null,
              summary: 'Dup',
              has_primary_source: true,
              before_json: null,
              after_json: toEntityPayload(person),
            },
          ],
        })
      ).kind
    ).toBe('conflict');

    expect(
      (
        await store.commitAtomicMutations({
          batch_id: null,
          author: EDITOR_AUTHOR,
          nowIso,
          operations: [
            {
              entity_type: 'person',
              entity_id: 'per_absent',
              action: 'update',
              expected_parent_revision_id: asRevisionId(1),
              summary: 'Update missing',
              has_primary_source: true,
              before_json: null,
              after_json: toEntityPayload(person),
            },
          ],
        })
      ).kind
    ).toBe('conflict');

    expect(
      (
        await store.commitAtomicMutations({
          batch_id: null,
          author: EDITOR_AUTHOR,
          nowIso,
          operations: [
            {
              entity_type: 'person',
              entity_id: person.id,
              action: 'update',
              expected_parent_revision_id: null,
              summary: 'Null parent',
              has_primary_source: true,
              before_json: toEntityPayload(person),
              after_json: toEntityPayload(person),
            },
          ],
        })
      ).kind
    ).toBe('conflict');

    expect(
      (
        await store.commitAtomicMutations({
          batch_id: null,
          author: EDITOR_AUTHOR,
          nowIso,
          operations: [
            {
              entity_type: 'person',
              entity_id: person.id,
              action: 'restore',
              expected_parent_revision_id: asRevisionId(1),
              summary: 'Restore active',
              has_primary_source: true,
              before_json: null,
              after_json: toEntityPayload(person),
            },
          ],
        })
      ).kind
    ).toBe('conflict');

    // Create with after_json: null throws
    await expect(
      store.commitAtomicMutations({
        batch_id: null,
        author: EDITOR_AUTHOR,
        nowIso,
        operations: [
          {
            entity_type: 'person',
            entity_id: 'per_null_after',
            action: 'create',
            expected_parent_revision_id: null,
            summary: 'Null after',
            has_primary_source: true,
            before_json: null,
            after_json: null,
          },
        ],
      })
    ).rejects.toThrow(/Missing prior entity payload/);

    // Soft-delete both entity and kinship, then loadActiveSnapshot filters them out, and updating soft-deleted conflicts
    await store.commitAtomicMutations({
      batch_id: null,
      author: EDITOR_AUTHOR,
      nowIso,
      operations: [
        {
          entity_type: 'person',
          entity_id: person.id,
          action: 'delete',
          expected_parent_revision_id: asRevisionId(1),
          summary: 'Delete person',
          has_primary_source: true,
          before_json: toEntityPayload(person),
          after_json: null,
        },
        {
          entity_type: 'kinship_edge',
          entity_id: 'edge_mem_1',
          action: 'delete',
          expected_parent_revision_id: asRevisionId(2),
          summary: 'Delete edge',
          has_primary_source: true,
          before_json: { from: 'per_mem_1', to: 'per_mem_2', relation: 'parent' },
          after_json: null,
        },
      ],
    });
    const activeSnap = await store.loadActiveSnapshot();
    expect(activeSnap.entities).toEqual([]);
    expect(activeSnap.kinship).toEqual([]);

    expect(
      (
        await store.commitAtomicMutations({
          batch_id: null,
          author: EDITOR_AUTHOR,
          nowIso,
          operations: [
            {
              entity_type: 'person',
              entity_id: person.id,
              action: 'update',
              expected_parent_revision_id: asRevisionId(3),
              summary: 'Update deleted',
              has_primary_source: true,
              before_json: null,
              after_json: toEntityPayload(person),
            },
          ],
        })
      ).kind
    ).toBe('conflict');

    // listRevisions filters + missing getRevisionById
    const byBatch = await store.listRevisions({ batch_id: asBatchId('bat_mem_1') });
    expect(byBatch.items).toHaveLength(2);
    const byAuthor = await store.listRevisions({ author_type: 'agent' });
    expect(byAuthor.items).toEqual([]);
    expect(await store.getRevisionById(asRevisionId(999))).toBeNull();

    // InMemoryAccessAndTalkStore edge cases
    const accessStore = new InMemoryAccessAndTalkStore();
    expect(await accessStore.softDeleteTalkComment(999, nowIso)).toBe(false);
    expect(await accessStore.updateUserRole('nobody@alder.test', 'admin')).toBeNull();
    await accessStore.upsertUser({
      email: 'ed@alder.test',
      display_name: 'Ed',
      role: 'editor',
      added_by: 'admin',
      added_at: nowIso,
      last_login_at: null,
    });
    expect((await accessStore.updateUserRole('ed@alder.test', 'admin'))?.role).toBe('admin');
    await accessStore.touchUserLogin('nobody@alder.test', nowIso);
    await accessStore.recordInviteUse('missing_inv', nowIso);
    expect(await accessStore.revokeInvite('missing_inv', nowIso)).toBe(false);
    expect(await accessStore.revokeAgentToken('missing_tok', nowIso)).toBe(false);

    // InMemoryIncrementalBundleCache & InMemoryMediaStore edge cases
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock(nowIso);
    const cache = new InMemoryIncrementalBundleCache(siteConfig, clock);
    const baseBundle = compileArchive({
      people: [],
      sources: [],
      events: [],
      places: [],
      kinship: [],
      media: [],
      narratives: [],
      siteConfig,
      mode: 'private',
      generatedAt: nowIso,
    }).bundle;
    const noopRev: RevisionRecord = {
      revision_id: asRevisionId(0),
      batch_id: null,
      entity_type: 'person',
      entity_id: 'per_noop',
      parent_revision_id: null,
      action: 'delete',
      reverted_revision_id: null,
      author_id: 'ed@alder.test',
      author_name: 'Ed',
      author_type: 'human',
      summary: 'Noop',
      has_primary_source: false,
      before_json: null,
      after_json: null,
      created_at: nowIso,
    };
    const patched = await cache.applyMutationsAndStore(
      { ...baseBundle, meta: { ...baseBundle.meta, max_revision_id: undefined } },
      [noopRev]
    );
    expect(patched.revision_id).toBe(0);

    const mediaStore = new InMemoryMediaStore();
    await mediaStore.put({
      key: 'media/stream.bin',
      body: bytesToStream(new Uint8Array([1, 2, 3, 4, 5])),
      contentType: 'application/octet-stream',
      sha256: asSha256Hex('c'.repeat(64)),
    });
    const openRange = await mediaStore.get('media/stream.bin', { range: { offset: 2 } });
    expect(openRange?.range).toEqual({ start: 2, end: 4, total: 5 });
  });

  it('exercises BundleReadService, AdminService, GoogleOAuthProvider, PronunciationService, crypto, and FixedClock', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });

    // BundleReadService stale hit stream cancel + non-revision not_modified etag + rebuild 304 + event redaction + snapshot media filtering
    let fakeCacheMode: 'weirdNotMod' | 'staleStreamHit' = 'weirdNotMod';
    const customBundleCache: BundleCache = {
      async getCached() {
        if (fakeCacheMode === 'weirdNotMod') {
          return { status: 'not_modified', etag: '"non-rev-etag"' };
        }
        return {
          status: 'hit',
          object: {
            etag: '"r0"',
            revision_id: asRevisionId(0),
            body: bytesToStream(new TextEncoder().encode('{}')),
            byteLength: 2,
            generated_at: clock.nowIso(),
          },
        };
      },
      async rebuildAndStore(snapshot) {
        return {
          etag: `"r${snapshot.head_revision_id}"`,
          revision_id: snapshot.head_revision_id,
          body: '{}',
          byteLength: 2,
          generated_at: clock.nowIso(),
        };
      },
    };
    const bundleRead = new BundleReadService({
      repository: ports.repository,
      bundleCache: customBundleCache,
      clock,
      siteConfig,
    });

    // weirdNotMod falls through to rebuild, and matching ifNoneMatch returns not_modified
    const rebuiltNotMod = await bundleRead.getBundle({ ifNoneMatch: '"r0"' });
    expect(rebuiltNotMod).toEqual({ status: 'not_modified', etag: '"r0"' });

    // Seed living person + event + media attached to living person (directly in store so exportSnapshot filters media)
    const living = createSyntheticLivingPerson({ id: 'per_br_liv' });
    const ev: RawEvent = createSyntheticEvent({
      id: 'evt_br_1',
      title: 'Birth',
      participants: [{ person_id: living.id, role: 'principal' }],
    });
    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: EDITOR_AUTHOR,
      nowIso: clock.nowIso(),
      operations: [
        {
          entity_type: 'person',
          entity_id: living.id,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living',
          has_primary_source: true,
          before_json: null,
          after_json: toEntityPayload(living),
        },
        {
          entity_type: 'event',
          entity_id: ev.id,
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed event',
          has_primary_source: true,
          before_json: null,
          after_json: toEntityPayload(ev),
        },
        {
          entity_type: 'media',
          entity_id: 'med_br_liv',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Seed living media',
          has_primary_source: true,
          before_json: null,
          after_json: {
            id: 'med_br_liv',
            kind: 'portrait',
            caption: 'Living Portrait',
            file: '/media/p.jpg',
            person_ids: [living.id],
          },
        },
      ],
    });

    fakeCacheMode = 'staleStreamHit';
    const freshAfterStale = await bundleRead.getBundle({ ifNoneMatch: null });
    expect(freshAfterStale.status).toBe('hit');

    await expect(bundleRead.getEntity({ entityType: 'person', entityId: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    const readEv = await bundleRead.getEntity({ entityType: 'event', entityId: ev.id });
    expect(readEv.entity.id).toBe(ev.id);

    const exportedSnap = await bundleRead.exportSnapshot({ ifNoneMatch: null });
    expect(exportedSnap.status).toBe('ok');
    if (exportedSnap.status === 'ok') {
      expect(exportedSnap.snapshot.entities.some((e) => e.entity_id === 'med_br_liv')).toBe(false);
    }

    // AdminService error & edge branches
    const adminService = new AdminService({ repository: ports.repository, clock });
    await adminService.createUser({
      email: 'admin@alder.test',
      display_name: 'Admin Alder',
      role: 'admin',
      addedBy: 'bootstrap',
    });
    await expect(
      adminService.createUser({
        email: 'admin@alder.test',
        display_name: 'Dup Admin',
        role: 'admin',
        addedBy: 'bootstrap',
      })
    ).rejects.toMatchObject({ status: 409, code: 'USER_EXISTS' });

    await adminService.createUser({
      email: 'editor@alder.test',
      display_name: 'Editor Alder',
      role: 'editor',
      addedBy: 'admin@alder.test',
    });
    // updateUser without display_name hits updateUserRole path
    const promoted = await adminService.updateUser({ email: 'editor@alder.test', role: 'admin' });
    expect(promoted.role).toBe('admin');
    const demoted = await adminService.updateUser({ email: 'editor@alder.test', role: 'editor' });
    expect(demoted.role).toBe('editor');
    await adminService.deleteUser({ email: 'editor@alder.test' });
    await expect(adminService.deleteUser({ email: 'missing@alder.test' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(adminService.revokeInvite({ token: 'missing_inv' })).rejects.toMatchObject({ status: 404 });
    await expect(adminService.revokeAgentToken({ tokenId: 'missing_tok' })).rejects.toMatchObject({
      status: 404,
    });

    // AdminService updateUser/deleteUser when underlying store returns null/false on race
    const racyAdmin = new AdminService({
      repository: {
        ...ports.repository,
        getUser: async () => ({
          email: 'race@alder.test',
          display_name: 'Race',
          role: 'editor',
          added_by: 'admin',
          added_at: clock.nowIso(),
          last_login_at: null,
        }),
        updateUserRole: async () => null,
        deleteUser: async () => false,
      },
      clock,
    });
    await expect(racyAdmin.updateUser({ email: 'race@alder.test', role: 'admin' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(racyAdmin.deleteUser({ email: 'race@alder.test' })).rejects.toMatchObject({ status: 404 });

    // GoogleOAuthProvider branches
    const defaultProvider = new GoogleOAuthProvider({ clientId: 'cid', clientSecret: 'csec' });
    expect(defaultProvider.id).toBe('google');

    const badTokenProvider = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async () => new Response(JSON.stringify({}), { status: 200 }),
    });
    await expect(
      badTokenProvider.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://alder.test/cb' })
    ).rejects.toMatchObject({ status: 502 });

    const userInfoErrProvider = (status: number) =>
      new GoogleOAuthProvider({
        clientId: 'cid',
        clientSecret: 'csec',
        fetchFn: async (input) => {
          const urlStr =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (urlStr.includes('token')) {
            return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
          }
          return new Response('err', { status });
        },
      });
    await expect(
      userInfoErrProvider(401).exchangeCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://alder.test/cb',
      })
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_OAUTH_STATE' });
    await expect(
      userInfoErrProvider(503).exchangeCode({
        code: 'c',
        codeVerifier: 'v',
        redirectUri: 'https://alder.test/cb',
      })
    ).rejects.toMatchObject({ status: 502, code: 'GOOGLE_AUTH_FAILED' });

    const badUserInfoProvider = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async (input) => {
        const urlStr =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('token')) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        return new Response(JSON.stringify({ invalid: true }), { status: 200 });
      },
    });
    await expect(
      badUserInfoProvider.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://alder.test/cb' })
    ).rejects.toMatchObject({ status: 502 });

    const givenNameOnlyProvider = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async (input) => {
        const urlStr =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('token')) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        return new Response(
          JSON.stringify({ email: 'clara@alder.test', email_verified: true, given_name: 'Clara' }),
          { status: 200 }
        );
      },
    });
    expect(
      (
        await givenNameOnlyProvider.exchangeCode({
          code: 'c',
          codeVerifier: 'v',
          redirectUri: 'https://alder.test/cb',
        })
      ).displayName
    ).toBe('Clara');

    const emailFallbackProvider = new GoogleOAuthProvider({
      clientId: 'cid',
      clientSecret: 'csec',
      fetchFn: async (input) => {
        const urlStr =
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (urlStr.includes('token')) {
          return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
        }
        return new Response(JSON.stringify({ email: 'mercer@alder.test', email_verified: true }), {
          status: 200,
        });
      },
    });
    expect(
      (
        await emailFallbackProvider.exchangeCode({
          code: 'c',
          codeVerifier: 'v',
          redirectUri: 'https://alder.test/cb',
        })
      ).displayName
    ).toBe('mercer');

    // PronunciationService & pronunciationHelper branches
    const pronServiceNoStore = new PronunciationService({
      repository: ports.repository,
      mediaStore: ports.mediaStore,
      clock,
      siteConfig,
      pronunciationGenerator: makeStubPronunciationGenerator(),
    });
    expect(await pronServiceNoStore.loadMergedPronunciations()).toEqual({});
    await expect(
      pronServiceNoStore.upsertLexiconTerm({
        term: '   ',
        entry: { phonetic: 'A' },
        updatedBy: 'ed@alder.test',
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pronServiceNoStore.upsertLexiconTerm({
        term: 'Alder',
        entry: { phonetic: 'A' },
        updatedBy: 'ed@alder.test',
      })
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      pronServiceNoStore.generateEntityPronunciation({ entityType: 'person', entityId: 'missing' })
    ).rejects.toMatchObject({ status: 404 });

    // Place with empty name falling back to full_name, and place with empty both -> 400
    await ports.repository.commitAtomicMutations({
      batch_id: null,
      author: EDITOR_AUTHOR,
      nowIso: clock.nowIso(),
      operations: [
        {
          entity_type: 'place',
          entity_id: 'plc_pron_1',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Place full name only',
          has_primary_source: true,
          before_json: null,
          after_json: {
            id: 'plc_pron_1',
            slug: 'alder-falls',
            name: 'Alder Falls',
            full_name: 'Alder Falls, VT',
            place_type: 'town',
            parent_id: null,
            lat: 44.26,
            lng: -72.58,
          },
        },
        {
          entity_type: 'place',
          entity_id: 'plc_pron_empty',
          action: 'create',
          expected_parent_revision_id: null,
          summary: 'Place empty names',
          has_primary_source: true,
          before_json: null,
          after_json: {
            id: 'plc_pron_empty',
            slug: 'alder-empty',
            name: '   ',
            full_name: '   ',
            place_type: 'town',
            parent_id: null,
            lat: 44.26,
            lng: -72.58,
          },
        },
      ],
    });
    const placeAudio = await pronServiceNoStore.generateEntityPronunciation({
      entityType: 'place',
      entityId: 'plc_pron_1',
    });
    expect(placeAudio.audio_url).toMatch(/^\/media\/pronunciation-/);
    await expect(
      pronServiceNoStore.generateEntityPronunciation({ entityType: 'place', entityId: 'plc_pron_empty' })
    ).rejects.toMatchObject({ status: 400 });

    const lexStore = new InMemoryPronunciationLexiconStore();
    const pronServiceWithStore = new PronunciationService({
      repository: ports.repository,
      mediaStore: ports.mediaStore,
      clock,
      siteConfig,
      pronunciationLexiconStore: lexStore,
    });
    const deletedEmpty = await pronServiceWithStore.upsertLexiconTerm({
      term: 'Alder',
      entry: { variants: [] },
      updatedBy: 'ed@alder.test',
    });
    expect(deletedEmpty.pronunciation).toBeNull();

    // pronunciationHelper: force: true, and dedup hit on .wav and .mp3 with omitted contentType/sizeBytes
    let headExtToHit: 'wav' | 'mp3' | null = 'wav';
    const stubMediaStore: MediaStore = {
      async head(key) {
        if (headExtToHit && key.endsWith(`.${headExtToHit}`)) {
          return { exists: true };
        }
        return { exists: false };
      },
      async put() {},
      async get() {
        return null;
      },
    };
    const dedupWav = await generateAndStorePronunciationAudio({
      generator: makeStubPronunciationGenerator('wav', 'audio/wav'),
      mediaStore: stubMediaStore,
      entityType: 'person',
      text: 'Alder',
    });
    expect(dedupWav.content_type).toBe('audio/wav');
    expect(dedupWav.size_bytes).toBe(0);

    headExtToHit = 'mp3';
    const dedupMp3 = await generateAndStorePronunciationAudio({
      generator: makeStubPronunciationGenerator('mp3', 'audio/mpeg'),
      mediaStore: stubMediaStore,
      entityType: 'person',
      text: 'Alder',
    });
    expect(dedupMp3.content_type).toBe('audio/mpeg');

    const forced = await generateAndStorePronunciationAudio({
      generator: makeStubPronunciationGenerator('wav', 'audio/wav'),
      mediaStore: stubMediaStore,
      entityType: 'person',
      text: 'Alder',
      force: true,
    });
    expect(forced.deduplicated).toBe(false);

    // crypto & FixedClock edge cases
    expect(base64UrlDecodeString('!!!invalid!!!')).toBeNull();
    expect((await sha256Bytes(new ArrayBuffer(4))).byteLength).toBe(32);
    expect(await hmacVerifyBase64Url('secret', 'payload', '!!!invalid!!!')).toBe(false);
    expect(() => new FixedClock('not-a-timestamp')).toThrow(RangeError);
    expect(() => clock.setIso('not-a-timestamp')).toThrow(RangeError);
  });
});

describe('router, mediaAndTalkRoutes, and privacyAndOgRoutes branch coverage', () => {
  it('validates plugin route compilation errors, security-only plugin path, /data/* telemetry, media upload errors, talk disabled, and OG edge cases', async () => {
    expect(() => validateAndCompilePluginRoutes([{ id: '   ', name: 'Blank' }])).toThrow(RangeError);
    expect(() =>
      validateAndCompilePluginRoutes([
        {
          id: 'bad-method',
          name: 'Bad Method',
          routes: [
            { method: '   ', pathPrefix: '/ext', minRole: 'public', handle: async () => new Response('ok') },
          ],
        },
      ])
    ).toThrow(RangeError);
    expect(() =>
      validateAndCompilePluginRoutes([
        {
          id: 'bad-prefix',
          name: 'Bad Prefix',
          routes: [
            {
              method: 'GET',
              pathPrefix: 'no-slash',
              minRole: 'public',
              handle: async () => new Response('ok'),
            },
          ],
        },
      ])
    ).toThrow(RangeError);

    const baseSiteConfig = createSyntheticSiteConfig();
    const siteConfig: KinloomSiteConfig = KinloomSiteConfigSchema.parse({
      ...baseSiteConfig,
      wiki: { allowTalk: false, allowWatchlists: false, maxUploadBytes: 15 * 1024 * 1024 },
      brand: { dynamicOg: true },
    });
    const clock = new FixedClock('2026-11-26T12:00:00.000Z');
    const ports = createInMemoryServerPorts(siteConfig, { initialIso: '2026-11-26T12:00:00.000Z' });

    expect(() =>
      createKinloomServer({
        siteConfig,
        ports,
        sessionSecret: 'short',
      })
    ).toThrow(RangeError);

    await ports.repository.upsertUser({
      email: 'admin@alder.test',
      display_name: 'Admin Alder',
      role: 'admin',
      added_by: 'bootstrap',
      added_at: clock.nowIso(),
      last_login_at: clock.nowIso(),
    });
    const adminToken = await signSessionToken({
      secret: CONTRACT_SESSION_SECRET,
      clock,
      ttlSeconds: 3600,
      payload: { kind: 'user', email: 'admin@alder.test', display_name: 'Admin Alder', role: 'admin' },
    });
    const adminCookie = `__Host-kinloom_session=${adminToken}`;

    // Security-only plugin (no onRequestStart/onResponse/onError) exercises lines 437 & 461
    const secOnlyEvents: ServerSecurityEvent[] = [];
    const secOnlyServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        plugins: [
          {
            id: 'sec-only',
            name: 'Security Only',
            onSecurityEvent(ev) {
              secOnlyEvents.push(ev);
            },
            routes: [
              {
                method: 'GET',
                pathPrefix: '/ext/editor',
                minRole: 'editor',
                handle: async () => new Response('editor-ok'),
              },
              {
                method: 'GET',
                pathPrefix: '/ext/admin',
                minRole: 'admin',
                handle: async () => new Response('admin-ok'),
              },
            ],
          },
        ],
      },
      sessionSecret: CONTRACT_SESSION_SECRET,
    });
    expect((await secOnlyServer.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/auth/me`))).status).toBe(200);
    expect(
      (
        await secOnlyServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/ext/editor`, { headers: { cookie: adminCookie } })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await secOnlyServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/ext/admin`, { headers: { cookie: adminCookie } })
        )
      ).status
    ).toBe(200);
    expect((await secOnlyServer.fetch(new Request(`${CONTRACT_TEST_ORIGIN}/api/nonexistent`))).status).toBe(
      404
    );

    // Asset handler returning 304, 200, and 404 for /data/* with lifecycle telemetry
    let dataStatus = 304;
    const cacheStatuses: Array<string | null> = [];
    const dataServer = createKinloomServer({
      siteConfig,
      ports: {
        ...ports,
        mediaStore: {
          async head() {
            return { exists: true, sizeBytes: 4, contentType: 'application/octet-stream' };
          },
          async put() {},
          async get(key) {
            return {
              key,
              contentType: 'application/octet-stream',
              sizeBytes: 4,
              etag: '"quoted-etag"',
              body: bytesToStream(new Uint8Array([1, 2, 3, 4])),
            };
          },
        },
        assetHandler: {
          async fetch() {
            return new Response(dataStatus === 304 ? null : 'ok', { status: dataStatus });
          },
        },
        plugins: [
          {
            id: 'obs-capture',
            name: 'Obs Capture',
            onResponse(ev) {
              cacheStatuses.push(ev.telemetry.cacheStatus);
            },
            onSecurityEvent(ev) {
              secOnlyEvents.push(ev);
            },
          },
        ],
      },
      sessionSecret: CONTRACT_SESSION_SECRET,
    });

    for (const status of [304, 200, 404]) {
      dataStatus = status;
      const res = await dataServer.fetch(
        new Request(`${CONTRACT_TEST_ORIGIN}/data/bundle.json`, { headers: { cookie: adminCookie } })
      );
      expect(res.status).toBe(status);
    }
    expect(cacheStatuses).toEqual(['not_modified', 'hit', null]);

    // GET /media/... with quoted etag and no sha256
    const mediaRes = await dataServer.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/media/quoted.bin`, { headers: { cookie: adminCookie } })
    );
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get('etag')).toBe('"quoted-etag"');

    // POST /api/media/upload validation branches: missing file, missing metadata, non-object metadata, non-string summary
    const fdNoFile = new FormData();
    fdNoFile.set('metadata', '{}');
    expect(
      (
        await dataServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
            body: fdNoFile,
          })
        )
      ).status
    ).toBe(400);

    const fdNoMeta = new FormData();
    fdNoMeta.set('file', new File([VALID_PNG_BYTES], 'a.png', { type: 'image/png' }));
    expect(
      (
        await dataServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
            body: fdNoMeta,
          })
        )
      ).status
    ).toBe(400);

    const fdArrayMeta = new FormData();
    fdArrayMeta.set('file', new File([VALID_PNG_BYTES], 'a.png', { type: 'image/png' }));
    fdArrayMeta.set('metadata', '[]');
    expect(
      (
        await dataServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
            body: fdArrayMeta,
          })
        )
      ).status
    ).toBe(400);

    const fdNoSummary = new FormData();
    fdNoSummary.set('file', new File([VALID_PNG_BYTES], 'a.png', { type: 'image/png' }));
    fdNoSummary.set('metadata', JSON.stringify({ kind: 'photo', title: 'Test' }));
    fdNoSummary.set('has_primary_source', 'false');
    expect(
      (
        await dataServer.fetch(
          new Request(`${CONTRACT_TEST_ORIGIN}/api/media/upload`, {
            method: 'POST',
            headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
            body: fdNoSummary,
          })
        )
      ).status
    ).toBe(400);

    // POST & DELETE /api/talk/* when talk is disabled -> 403 talk_disabled
    const talkPostDisabled = await dataServer.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/talk/person/per_1`, {
        method: 'POST',
        headers: {
          cookie: adminCookie,
          origin: CONTRACT_TEST_ORIGIN,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body_md: 'Hello archive' }),
      })
    );
    expect(talkPostDisabled.status).toBe(403);

    const talkDeleteDisabled = await dataServer.fetch(
      new Request(`${CONTRACT_TEST_ORIGIN}/api/talk/person/per_1/1`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: CONTRACT_TEST_ORIGIN },
      })
    );
    expect(talkDeleteDisabled.status).toBe(403);
    expect(secOnlyEvents.some((e) => e.type === 'auth.write.forbidden' && e.reason === 'talk_disabled')).toBe(
      true
    );

    // privacyAndOgRoutes edge cases
    const htmlWithNonReplacingDisclosure = renderPrivacyPolicyHtml(siteConfig, {
      disclosures: [{ id: 'extra', summary: 'Extra notice', replacesZeroAnalyticsClaim: false }],
    });
    expect(htmlWithNonReplacingDisclosure).toContain('zero tracking pixels');
    expect(htmlWithNonReplacingDisclosure).toContain('Extra notice');

    expect(
      await handleDynamicOgRequest({
        pathname: '/og/unknown.svg',
        headOnly: false,
        isSecure: true,
        siteConfig,
        repository: ports.repository,
        clock,
      })
    ).toBeNull();

    // Soft-deleted person falls back to site OG card, and HEAD returns empty body
    const softDeletedPerson: RawPerson = createSyntheticHistoricalPerson({ id: 'per_og_del' });
    const blankNameHistorical: RawPerson = {
      ...createSyntheticHistoricalPerson({ id: 'per_og_blank' }),
      full_name: '   ',
    };
    const ogRepo: Pick<EntityReadStore, 'getEntity'> = {
      async getEntity(_type, id) {
        if (id === 'per_og_del') {
          return {
            entity_type: 'person',
            entity_id: id,
            slug: null,
            data: toEntityPayload(softDeletedPerson),
            current_revision_id: asRevisionId(1),
            has_primary_source: true,
            deleted_at: clock.nowIso(),
            updated_at: clock.nowIso(),
          };
        }
        if (id === 'per_og_blank') {
          return {
            entity_type: 'person',
            entity_id: id,
            slug: null,
            data: toEntityPayload(blankNameHistorical),
            current_revision_id: asRevisionId(1),
            has_primary_source: true,
            deleted_at: null,
            updated_at: clock.nowIso(),
          };
        }
        return null;
      },
    };
    const siteConfigNoRefYear: KinloomSiteConfig = KinloomSiteConfigSchema.parse({
      ...siteConfig,
      site: { ...siteConfig.site, footerCredit: '' },
      privacy: { ...siteConfig.privacy, referenceYear: undefined },
      brand: { dynamicOg: true, showFooterCredit: false },
    });
    const headSiteOg = await handleDynamicOgRequest({
      pathname: '/og/site.svg',
      headOnly: true,
      isSecure: true,
      siteConfig: siteConfigNoRefYear,
      repository: ogRepo,
      clock,
    });
    expect(headSiteOg?.status).toBe(200);
    expect(await headSiteOg?.text()).toBe('');

    const deletedOg = await handleDynamicOgRequest({
      pathname: '/og/person/per_og_del.svg',
      headOnly: false,
      isSecure: true,
      siteConfig: siteConfigNoRefYear,
      repository: ogRepo,
      clock,
    });
    expect(deletedOg?.status).toBe(200);

    const blankNameOg = await handleDynamicOgRequest({
      pathname: '/og/person/per_og_blank.svg',
      headOnly: false,
      isSecure: true,
      siteConfig: siteConfigNoRefYear,
      repository: ogRepo,
      clock,
    });
    expect(await blankNameOg?.text()).toContain('Historical Person');
  });
});
