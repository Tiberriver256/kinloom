import {
  type ArchiveBundle,
  asRevisionId,
  asSha256Hex,
  compileArchive,
  type RevisionRecord,
} from '@kinloom/core';
import { FixedClock, KinloomHttpError } from '@kinloom/server';
import { createSyntheticSiteConfig } from '@kinloom/server/testing';
import { describe, expect, it, vi } from 'vitest';
import { createCloudflareAssetHandler } from './adapters/cloudflareAssets.js';
import {
  buildMagicLinkEmailMessage,
  buildMagicLinkMimeMessage,
  CloudflareEmailSender,
} from './adapters/cloudflareEmailSender.js';
import { D1AccessAndTalkStore } from './adapters/d1/accessAndTalkStore.js';
import { D1EntityReadStore } from './adapters/d1/entityReadStore.js';
import { isSqliteConstraintError, prepareD1Statement } from './adapters/d1/sqlHelpers.js';
import { D1PronunciationLexiconStore } from './adapters/d1PronunciationLexiconStore.js';
import {
  buildPronunciationPrompt,
  GeminiPronunciationAudioGenerator,
  wrapPcmAsWav,
} from './adapters/geminiPronunciationGenerator.js';
import { computeSiteConfigHash, R2IncrementalPatchBundleCache } from './adapters/r2BundleCache.js';
import { R2MediaStore } from './adapters/r2MediaStore.js';
import type {
  D1Database,
  D1PreparedStatement,
  D1Result,
  Fetcher,
  R2Bucket,
  R2GetOptions,
  R2Object,
  R2ObjectBody,
  R2PutOptions,
  SendEmailBinding,
} from './types.js';

function createStubStatement(handlers: {
  first?: () => Promise<unknown>;
  all?: () => Promise<D1Result<unknown>>;
  run?: () => Promise<D1Result<unknown>>;
}): D1PreparedStatement {
  const stmt: D1PreparedStatement = {
    bind() {
      return stmt;
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      if (!handlers.first) {
        return null;
      }
      return (await handlers.first()) as T | null;
    },
    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      if (!handlers.run) {
        return { success: true, meta: {}, results: [] };
      }
      return (await handlers.run()) as D1Result<T>;
    },
    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
      if (!handlers.all) {
        return { success: true, meta: {}, results: [] };
      }
      return (await handlers.all()) as D1Result<T>;
    },
  };
  return stmt;
}

function createStubDb(options: {
  onPrepare?: (sql: string) => D1PreparedStatement;
  onBatch?: (statements: D1PreparedStatement[]) => Promise<D1Result<unknown>[]>;
}): D1Database {
  return {
    prepare(sql: string) {
      return options.onPrepare ? options.onPrepare(sql) : createStubStatement({});
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      if (options.onBatch) {
        return (await options.onBatch(statements)) as D1Result<T>[];
      }
      const out: D1Result<T>[] = [];
      for (const stmt of statements) {
        out.push(await stmt.all<T>());
      }
      return out;
    },
    async exec() {
      return { count: 0, duration: 0 };
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function makeR2ObjectBody(params: {
  key: string;
  bytes: Uint8Array;
  etag?: string;
  uploaded?: Date;
  contentType?: string;
  customMetadata?: Record<string, string>;
}): R2ObjectBody {
  const bytes = params.bytes;
  return {
    key: params.key,
    size: bytes.byteLength,
    etag: params.etag ?? 'etag-1',
    uploaded: params.uploaded ?? new Date('2026-11-26T12:00:00.000Z'),
    ...(params.contentType !== undefined ? { httpMetadata: { contentType: params.contentType } } : {}),
    ...(params.customMetadata !== undefined ? { customMetadata: params.customMetadata } : {}),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    bodyUsed: false,
    async arrayBuffer() {
      return bytes.slice().buffer;
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
  };
}

describe('GeminiPronunciationAudioGenerator branch coverage', () => {
  it('builds pronunciation prompts across empty-text, IPA/phonetic, regional, and unknown-language combinations', () => {
    expect(buildPronunciationPrompt({ text: '   ' })).toBe('');
    expect(buildPronunciationPrompt({ text: '', ipa: '/al.dər/', phonetic: 'AWL-der' })).toBe(
      '/al.dər/ (guide: AWL-der)'
    );
    expect(
      buildPronunciationPrompt({
        text: '',
        ipa: '/al.dər/',
        phonetic: 'AWL-der',
        language: 'nl-BE',
      })
    ).toBe('Pronounce in Dutch (nl-BE) as /al.dər/ (guide: AWL-der).');
    expect(buildPronunciationPrompt({ text: '', ipa: '/mer.sər/' })).toBe('/mer.sər/');
    expect(buildPronunciationPrompt({ text: '', ipa: '/mer.sər/', language: 'eo' })).toBe(
      'Pronounce in eo as /mer.sər/.'
    );
    expect(buildPronunciationPrompt({ text: '', phonetic: 'MER-ser' })).toBe('MER-ser');
    expect(buildPronunciationPrompt({ text: '', phonetic: 'MER-ser', language: 'fr_CA' })).toBe(
      'Pronounce in French (fr_CA) as MER-ser.'
    );
  });

  it('validates constructor options, empty prompts, missing inline audio, RIFF detection, and MIME parameter fallbacks', async () => {
    expect(() => new GeminiPronunciationAudioGenerator({ apiKey: '   ' })).toThrow(
      /requires a non-empty apiKey/
    );

    const defaultFetchGenerator = new GeminiPronunciationAudioGenerator({ apiKey: 'synthetic-key' });
    await expect(defaultFetchGenerator.generate({ text: '   ' })).rejects.toThrow(
      /Pronunciation text must not be empty/
    );

    const emptyCandidatesGen = new GeminiPronunciationAudioGenerator({
      apiKey: 'synthetic-key',
      fetchFn: async () =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(emptyCandidatesGen.generate({ text: 'Alder' })).rejects.toThrow(
      /did not contain inline audio data/
    );

    // Default mimeType fallback when inlineData.mimeType is omitted + invalid rate=0 fallback
    const pcm = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const omittedMimeGen = new GeminiPronunciationAudioGenerator({
      apiKey: 'synthetic-key',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { data: bytesToBase64(pcm) } }] } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    });
    const wrappedDefault = await omittedMimeGen.generate({ text: 'Alder' });
    expect(wrappedDefault.bytes.byteLength).toBe(44 + pcm.byteLength);

    // Zero rate parameter falls back to 24000 Hz
    const zeroRateGen = new GeminiPronunciationAudioGenerator({
      apiKey: 'synthetic-key',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/L16;codec=pcm;rate=0;channels=0',
                        data: bytesToBase64(pcm),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        ),
    });
    const zeroRateResult = await zeroRateGen.generate({ text: 'Alder' });
    expect(new DataView(zeroRateResult.bytes.buffer).getUint32(24, true)).toBe(24000);

    // Exercise every byte-check branch of isRiffWav when mimeType is non-wav
    const validWav = wrapPcmAsWav(pcm, 24000, 1, 16);
    const riffVariants: Array<{ bytes: Uint8Array; isWav: boolean }> = [
      { bytes: validWav, isWav: true },
      // Flip each checked RIFF/WAVE header byte individually
      ...[0, 1, 2, 3, 8, 9, 10, 11].map((idx) => {
        const mutated = validWav.slice();
        mutated[idx] = 0x00;
        return { bytes: mutated, isWav: false };
      }),
    ];

    for (const variant of riffVariants) {
      const gen = new GeminiPronunciationAudioGenerator({
        apiKey: 'synthetic-key',
        fetchFn: async () =>
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: {
                          mimeType: 'application/octet-stream',
                          data: bytesToBase64(variant.bytes),
                        },
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
      });
      const res = await gen.generate({ text: 'Mercer' });
      expect(res.bytes.byteLength).toBe(
        variant.isWav ? variant.bytes.byteLength : 44 + variant.bytes.byteLength
      );
    }
  });
});

describe('D1PronunciationLexiconStore branch coverage', () => {
  it('handles malformed variants_json, optional columns, Error.cause chains, non-Error throws, and legacy fallback', async () => {
    const dbWithRows = createStubDb({
      onPrepare() {
        return createStubStatement({
          all: async () => ({
            success: true,
            meta: {},
            results: [
              {
                term: 'Alder',
                phonetic: null,
                ipa: '/al.dər/',
                language: 'en',
                audio_url: null,
                note: null,
                source_url: null,
                source_label: null,
                region: null,
                variants_json: '{"not":"an-array"}',
              },
              {
                term: 'Birch',
                phonetic: 'BURCH',
                ipa: null,
                language: null,
                audio_url: null,
                note: 'Historical parish spelling',
                source_url: null,
                source_label: null,
                region: null,
                variants_json: JSON.stringify([{ invalid: 123 }]),
              },
              {
                term: 'Mercer',
                phonetic: 'MER-ser',
                ipa: null,
                language: null,
                audio_url: null,
                note: null,
                source_url: null,
                source_label: null,
                region: null,
                variants_json: '{malformed-json',
              },
            ],
          }),
        });
      },
    });

    const store = new D1PronunciationLexiconStore(dbWithRows);
    const listed = await store.list();
    expect(listed.Alder).toEqual({ ipa: '/al.dər/', language: 'en' });
    expect(listed.Birch).toEqual({ phonetic: 'BURCH', note: 'Historical parish spelling' });
    expect(listed.Mercer).toEqual({ phonetic: 'MER-ser' });

    // Error with nested Error cause -> missing table returns {}
    const missingTableViaCause = new D1PronunciationLexiconStore(
      createStubDb({
        onPrepare() {
          return createStubStatement({
            all: async () => {
              throw new Error('D1 query failed', {
                cause: new Error('no such table: pronunciation_lexicon'),
              });
            },
          });
        },
      })
    );
    expect(await missingTableViaCause.list()).toEqual({});

    // Non-Error string throw -> missing table returns {}
    const missingTableNonError = new D1PronunciationLexiconStore(
      createStubDb({
        onPrepare() {
          return createStubStatement({
            all: async () => {
              throw 'no such table: pronunciation_lexicon';
            },
          });
        },
      })
    );
    expect(await missingTableNonError.list()).toEqual({});

    // Unexpected error in list() rethrows
    const unexpectedListErr = new D1PronunciationLexiconStore(
      createStubDb({
        onPrepare() {
          return createStubStatement({
            all: async () => {
              throw new Error('disk I/O failure');
            },
          });
        },
      })
    );
    await expect(unexpectedListErr.list()).rejects.toThrow('disk I/O failure');

    // Upsert with minimal fields (no phonetic, with note) + unexpected error rethrow
    const upsertOkStore = new D1PronunciationLexiconStore(createStubDb({}));
    const upsertedMinimal = await upsertOkStore.upsert(
      'Alder',
      { ipa: '/al.dər/', note: 'Archival note' },
      'editor@example.test',
      '2026-11-26T12:00:00.000Z'
    );
    expect(upsertedMinimal).toEqual({ ipa: '/al.dər/', note: 'Archival note' });

    const unexpectedUpsertErr = new D1PronunciationLexiconStore(
      createStubDb({
        onPrepare() {
          return createStubStatement({
            run: async () => {
              throw new Error('constraint failed');
            },
          });
        },
      })
    );
    await expect(
      unexpectedUpsertErr.upsert(
        'Alder',
        { phonetic: 'AWL-der' },
        'editor@example.test',
        '2026-11-26T12:00:00.000Z'
      )
    ).rejects.toThrow('constraint failed');

    // Legacy missing-column fallback via string cause: once with no phonetic/no note, once with note
    const legacyFallbackDb = createStubDb({
      onPrepare(sql) {
        return createStubStatement({
          run: async () => {
            if (sql.includes('variants_json')) {
              throw new Error('D1 failed', {
                cause: 'table pronunciation_lexicon has no column named variants_json',
              });
            }
            return { success: true, meta: { changes: 1 }, results: [] };
          },
        });
      },
    });
    const legacyStore = new D1PronunciationLexiconStore(legacyFallbackDb);
    const legacyNoPhonetic = await legacyStore.upsert(
      'Alder',
      { ipa: '/al.dər/', note: 'Legacy note' },
      'editor@example.test',
      '2026-11-26T12:00:00.000Z'
    );
    expect(legacyNoPhonetic).toEqual({ ipa: '/al.dər/', note: 'Legacy note' });

    const legacyMinimal = await legacyStore.upsert(
      'Birch',
      { phonetic: 'BURCH' },
      'editor@example.test',
      '2026-11-26T12:00:00.000Z'
    );
    expect(legacyMinimal).toEqual({ phonetic: 'BURCH' });
  });
});

describe('D1EntityReadStore, D1AccessAndTalkStore, and sqlHelpers branch coverage', () => {
  it('handles null/empty D1 query results in D1EntityReadStore', async () => {
    const db = createStubDb({
      onPrepare(sql) {
        if (sql.includes('json_extract(data_json')) {
          return createStubStatement({
            all: async () => ({
              success: true,
              meta: {},
              results: [
                { entity_id: 'per_living_null_dates', is_living: 1, birth_edtf: null, death_edtf: null },
                { entity_id: 'per_historical_dates', is_living: 0, birth_edtf: '1842', death_edtf: '1918' },
              ],
            }),
          });
        }
        return createStubStatement({
          first: async () => null,
          all: async () => ({ success: true, meta: {}, results: [] }),
        });
      },
    });

    const store = new D1EntityReadStore(db, undefined, new FixedClock(new Date('2026-11-26T12:00:00.000Z')));
    expect(await store.getHeadRevisionId()).toBe(0);
    expect(await store.getRevisionById(asRevisionId(999))).toBeNull();

    const living = await store.getLivingPersonIds();
    expect(living.has('per_living_null_dates')).toBe(true);
    expect(living.has('per_historical_dates')).toBe(false);

    const snapshot = await store.loadActiveSnapshot();
    expect(snapshot.head_revision_id).toBe(0);
    expect(snapshot.entities).toEqual([]);

    const revisions = await store.listRevisions({});
    expect(revisions.items).toEqual([]);
    expect(revisions.next_cursor).toBeNull();
  });

  it('handles null rows and omitted meta.changes in D1AccessAndTalkStore', async () => {
    const db = createStubDb({
      onPrepare() {
        return createStubStatement({
          first: async () => null,
          run: async () => ({ success: true, meta: {}, results: [] }),
        });
      },
    });

    const store = new D1AccessAndTalkStore(db);
    expect(await store.softDeleteTalkComment(1, '2026-11-26T12:00:00.000Z')).toBe(false);
    expect(await store.deleteUser('nobody@example.test')).toBe(false);
    expect(await store.getInvite('missing-invite')).toBeNull();
    expect(await store.revokeInvite('missing-invite', '2026-11-26T12:00:00.000Z')).toBe(false);
    expect(await store.getMagicLink(asSha256Hex('a'.repeat(64)))).toBeNull();
    expect(await store.countRecentMagicLinks('nobody@example.test', '2026-11-26T00:00:00.000Z')).toBe(0);
    expect(await store.revokeAgentToken('tok_missing', '2026-11-26T12:00:00.000Z')).toBe(false);
  });

  it('handles statement cache capacity limit and non-Error constraint checks in sqlHelpers', () => {
    const prepareSpy = vi.fn(() => createStubStatement({}));
    const db: D1Database = {
      prepare: prepareSpy,
      async batch() {
        return [];
      },
      async exec() {
        return { count: 0, duration: 0 };
      },
    };

    for (let i = 0; i < 66; i += 1) {
      prepareD1Statement(db, `SELECT ${i}`);
    }
    // 65th and 66th statements exceed cache limit of 64 and are not cached
    prepareD1Statement(db, 'SELECT 65');
    expect(prepareSpy).toHaveBeenCalledTimes(67);

    expect(isSqliteConstraintError('SQLITE_CONSTRAINT: unique violation')).toBe(true);
    expect(isSqliteConstraintError('unrelated error')).toBe(false);
  });
});

describe('CloudflareEmailSender branch coverage', () => {
  it('sanitizes empty site titles, handles domainless sender addresses, and defaults MIME Date header', () => {
    const structured = buildMagicLinkEmailMessage({
      fromEmail: 'noreply@alder.test',
      toEmail: 'reader@alder.test',
      siteTitle: '\r\n\t',
      magicLinkUrl: 'https://alder.test/auth/verify?token=abc',
      expiresMinutes: 15,
    });
    expect(structured.subject).toBe('Sign in to Kinloom');

    const mimeNoAt = buildMagicLinkMimeMessage({
      fromEmail: 'noreply',
      toEmail: 'reader@alder.test',
      siteTitle: 'Alder Archive',
      magicLinkUrl: 'https://alder.test/auth/verify?token=abc',
      expiresMinutes: 15,
    });
    expect(mimeNoAt).toContain('@familyloom.org>');
    expect(mimeNoAt).toContain('Date: ');

    const mimeTrailingAt = buildMagicLinkMimeMessage({
      fromEmail: 'noreply@',
      toEmail: 'reader@alder.test',
      siteTitle: 'Alder Archive',
      magicLinkUrl: 'https://alder.test/auth/verify?token=abc',
      expiresMinutes: 15,
      now: new Date('2026-11-26T12:00:00.000Z'),
    });
    expect(mimeTrailingAt).toContain('@familyloom.org>');
  });

  it('rethrows KinloomHttpError directly and handles non-Error throws, empty magicLinkUrl, and invalid error codes', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const httpErr = new KinloomHttpError(429, 'RATE_LIMIT', 'Too many requests');
      const rethrowSender = new CloudflareEmailSender({
        binding: {
          async send() {
            throw httpErr;
          },
        },
      });
      await expect(
        rethrowSender.sendMagicLink({
          toEmail: 'reader@alder.test',
          siteTitle: 'Alder Archive',
          magicLinkUrl: 'https://alder.test/verify?t=1',
          expiresMinutes: 15,
        })
      ).rejects.toBe(httpErr);

      const nonErrorBinding: SendEmailBinding = {
        async send() {
          throw 'plain delivery error';
        },
      };
      const nonErrorSender = new CloudflareEmailSender({ binding: nonErrorBinding });
      await expect(
        nonErrorSender.sendMagicLink({
          toEmail: 'reader@alder.test',
          siteTitle: 'Alder Archive',
          magicLinkUrl: '',
          expiresMinutes: 15,
        })
      ).rejects.toMatchObject({ status: 502, code: 'EMAIL_DELIVERY_FAILED' });

      const emptyCodeSender = new CloudflareEmailSender({
        binding: {
          async send() {
            throw Object.assign(new Error('failed'), { code: '' });
          },
        },
      });
      await expect(
        emptyCodeSender.sendMagicLink({
          toEmail: 'reader@alder.test',
          siteTitle: 'Alder Archive',
          magicLinkUrl: 'https://alder.test/verify?t=2',
          expiresMinutes: 15,
        })
      ).rejects.toMatchObject({ status: 502, code: 'EMAIL_DELIVERY_FAILED' });
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('R2MediaStore, R2IncrementalPatchBundleCache, and CloudflareAssetHandler branch coverage', () => {
  it('handles open-ended ranges, missing ranged objects, key-derived sha256, and default contentType in R2MediaStore', async () => {
    const hash = 'b'.repeat(64);
    const keyWithHash = `media/${hash}.png`;
    const keyWithoutHash = 'media/unhashed.bin';
    const payload = new Uint8Array([10, 20, 30, 40, 50, 60]);

    const objects = new Map<string, R2ObjectBody>([
      [keyWithHash, makeR2ObjectBody({ key: keyWithHash, bytes: payload })],
      [keyWithoutHash, makeR2ObjectBody({ key: keyWithoutHash, bytes: payload })],
    ]);

    const bucket: R2Bucket = {
      async head(key: string): Promise<R2Object | null> {
        return objects.get(key) ?? null;
      },
      async get(key: string, _options?: R2GetOptions): Promise<R2ObjectBody | null> {
        const obj = objects.get(key);
        if (!obj) {
          return null;
        }
        return makeR2ObjectBody({ key, bytes: payload });
      },
      async put() {
        return null;
      },
      async delete() {},
    };

    const store = new R2MediaStore(bucket);

    // Missing ranged object returns null
    expect(await store.get('media/missing.bin', { range: { offset: 0, length: 4 } })).toBeNull();

    // Open-ended range (no length) + default contentType + sha256 extracted from key
    const ranged = await store.get(keyWithHash, { range: { offset: 2 } });
    expect(ranged).not.toBeNull();
    expect(ranged?.contentType).toBe('application/octet-stream');
    expect(ranged?.sha256).toBe(hash);
    expect(ranged?.range).toEqual({ start: 2, end: 5, total: 6 });

    // Non-ranged get with no customMetadata sha256 and non-hex key + default contentType
    const plain = await store.get(keyWithoutHash);
    expect(plain).not.toBeNull();
    expect(plain?.contentType).toBe('application/octet-stream');
    expect(plain?.sha256).toBeUndefined();
  });

  it('handles missing optional customMetadata etag/generated_at and lower-revision mutations in R2IncrementalPatchBundleCache', async () => {
    const siteConfig = createSyntheticSiteConfig();
    const configHash = computeSiteConfigHash(siteConfig);
    const clock = new FixedClock(new Date('2026-11-26T12:00:00.000Z'));
    const uploadedAt = new Date('2026-11-26T10:00:00.000Z');
    const serialized = JSON.stringify(
      compileArchive({
        people: [],
        sources: [],
        events: [],
        places: [],
        kinship: [],
        media: [],
        narratives: [],
        siteConfig,
        mode: 'private',
        generatedAt: uploadedAt.toISOString(),
        maxRevisionId: 5,
      }).bundle
    );
    const encoded = new TextEncoder().encode(serialized);

    const bucket: R2Bucket = {
      async head(key: string): Promise<R2Object | null> {
        return {
          key,
          size: encoded.byteLength,
          etag: 'r2-etag-1',
          uploaded: uploadedAt,
          customMetadata: {
            revision: '5',
            config_hash: configHash,
            // Intentionally omit etag and generated_at to exercise fallbacks
          },
        };
      },
      async get(key: string): Promise<R2ObjectBody | null> {
        return makeR2ObjectBody({
          key,
          bytes: encoded,
          etag: 'r2-etag-1',
          uploaded: uploadedAt,
          customMetadata: {
            revision: '5',
            config_hash: configHash,
          },
        });
      },
      async put(key: string, _value, options?: R2PutOptions): Promise<R2Object | null> {
        return {
          key,
          size: encoded.byteLength,
          etag: 'r2-etag-2',
          uploaded: uploadedAt,
          customMetadata: options?.customMetadata,
        };
      },
      async delete() {},
    };

    const cache = new R2IncrementalPatchBundleCache({ bucket, siteConfig, clock });

    // If-None-Match matches computed fallback head etag when customMetadata.etag is absent
    const notMod = await cache.getCached(`"r5-${configHash}"`);
    expect(notMod).toEqual({ status: 'not_modified', etag: `"r5-${configHash}"` });

    // Direct get without memo or If-None-Match uses computed etag and uploaded.toISOString() fallback
    const hit = await cache.getCached(null);
    expect(hit.status).toBe('hit');
    if (hit.status === 'hit') {
      expect(hit.object.etag).toBe(`"r5-${configHash}"`);
      expect(hit.object.generated_at).toBe(uploadedAt.toISOString());
    }

    // applyMutationsAndStore with omitted max_revision_id and non-increasing mutation revision
    const baseBundle: ArchiveBundle = compileArchive({
      people: [],
      sources: [],
      events: [],
      places: [],
      kinship: [],
      media: [],
      narratives: [],
      siteConfig,
      mode: 'private',
      generatedAt: uploadedAt.toISOString(),
    }).bundle;
    const bundleWithoutMaxRev: ArchiveBundle = {
      ...baseBundle,
      meta: {
        ...baseBundle.meta,
        max_revision_id: undefined,
      },
    };
    const zeroRevMutation: RevisionRecord = {
      revision_id: asRevisionId(0),
      batch_id: null,
      entity_type: 'person',
      entity_id: 'per_noop',
      parent_revision_id: null,
      action: 'delete',
      reverted_revision_id: null,
      author_id: 'editor@example.test',
      author_name: 'Editor Alder',
      author_type: 'human',
      summary: 'No-op revision zero',
      has_primary_source: false,
      before_json: null,
      after_json: null,
      created_at: clock.nowIso(),
    };
    const patched = await cache.applyMutationsAndStore(bundleWithoutMaxRev, [zeroRevMutation]);
    expect(patched.revision_id).toBe(5); // existingHead revision 5 is fresher than 0
  });

  it('handles missing ASSETS binding for favicons and content-type-less responses in createCloudflareAssetHandler', async () => {
    const noAssetsHandler = createCloudflareAssetHandler(undefined);
    const svgRes = await noAssetsHandler.fetch(new Request('https://alder.test/favicon.svg'));
    expect(svgRes.status).toBe(200);
    expect(svgRes.headers.get('content-type')).toContain('image/svg+xml');

    const icoRes = await noAssetsHandler.fetch(new Request('https://alder.test/favicon.ico'));
    expect(icoRes.status).toBe(404);

    const headerlessAssets: Fetcher = {
      async fetch(input) {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
        );
        if (url.pathname === '/assets/data.bin') {
          return new Response(null, { status: 200 });
        }
        if (url.pathname === '/index.html') {
          return new Response(null, { status: 200 });
        }
        return new Response('missing', { status: 404 });
      },
    };

    const handler = createCloudflareAssetHandler(headerlessAssets);
    const binRes = await handler.fetch(new Request('https://alder.test/assets/data.bin'));
    expect(binRes.status).toBe(200);

    const spaFallback = await handler.fetch(new Request('https://alder.test/people/per_alder'));
    expect(spaFallback.status).toBe(200);
    expect(spaFallback.headers.get('content-type')).toBe('text/html; charset=utf-8');
  });
});
