import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliValidationError } from '../../errors.js';
import {
  hasImageMagic,
  imageContentType,
  resolvePositionalName,
  sanitizePrefix,
  validateEntityId,
  validatePhotoUrl,
} from './clients/findagrave/domain.js';
import {
  cemeteryUrl,
  coordsPair,
  enrichCemetery,
  enrichMemorial,
  firstPlaceName,
  fmtCemetery,
  fmtDate,
  fmtEvent,
  formatCemeteriesText,
  formatMemorialsLines,
  formatPlacesText,
  formatSearchText,
  memorialUrl,
  primaryName,
} from './clients/findagrave/formatters.js';
import {
  fetchPhotoBytes,
  loadOrFetchCemeteryById,
  loadOrFetchMemorialsWithHits,
  photoCacheFresh,
  runGraphqlQuery,
  storePhotoCache,
} from './clients/findagrave/transport.js';
import { runFindagraveCommand } from './clients/findagrave.js';
import { defaultBrowserGetRecords, defaultBrowserSearchMany } from './clients/nara/browserFallback.js';
import {
  canonicalSearchParams,
  readCachedRecord,
  readCachedSearch,
  writeCachedRecord,
  writeCachedSearch,
} from './clients/nara/catalogCache.js';
import {
  apiGetJson,
  apiSearchOne,
  fetchFollowingRedirects,
  loadOrFetchFullRecordsWithHits,
  parseRetryAfterSeconds,
} from './clients/nara/catalogTransport.js';
import {
  census1950FetchJpeg,
  parseCensus1950ImageSource,
  requireJpegBytes,
  resolveCensus1950ImageOutput,
  storeCensus1950Image,
  validateCensus1950ImagePath,
} from './clients/nara/census1950.js';
import {
  canonicalCensus1950Query,
  census1950FetchJson,
  normalizeCensus1950State,
  readCachedCensus1950,
} from './clients/nara/census1950Search.js';
import {
  downloadObjectToCache,
  readCachedDownloadEntry,
  resolveDirectDownloadDest,
  safeUrlFilename,
  validateDownloadedFile,
} from './clients/nara/downloadCore.js';
import { downloadDirectUrl, downloadRecordObjects } from './clients/nara/downloads.js';
import {
  buildSearchPayload,
  extractRecord,
  formatRecordText,
  projectRecord,
} from './clients/nara/queryAndRecords.js';
import {
  buildQueryParams,
  detectErrorPayload,
  encodeCatalogUrl,
  parsePageSpec,
  quotePythonStyle,
  resolveQueryTtlHours,
  safeObjectFilename,
  validateNaraDownloadUrl,
} from './clients/nara/queryValidation.js';
import { NaraWafOrNonJsonError, type SearchFilterOptions } from './clients/nara/types.js';
import { createNaraCommand } from './clients/nara.js';
import {
  type CommandParseSpec,
  formatCommandUsage,
  getStringListOption,
  parseCommandArgs,
} from './runtime/args.js';
import {
  BrowserTimeoutError,
  findSystemChromium,
  forceTerminateBrowserProcess,
  isExecutableFile,
  launchOptionalChromium,
  type OptionalBrowser,
  type OptionalBrowserPage,
  type OptionalBrowserProcess,
  type PlaywrightCoreModule,
  runWithBrowserSession,
  withBrowserDeadline,
} from './runtime/browser.js';
import {
  atomicWriteFileSync,
  CacheHitTracker,
  cachedJsonCall,
  expandHomePath,
  readBinaryCache,
  readSchemaCacheEntry,
  withAdvisoryLock,
} from './runtime/cache.js';
import {
  CURL_META_MARKER,
  defaultExecFile,
  fetchWithCurl,
  httpGetBytes,
  httpGetJson,
  httpGetText,
  httpRequest,
} from './runtime/http.js';
import {
  applyBlackBoxes,
  buildBlackBoxesSvg,
  buildLabeledContactStrip,
  chooseDefaultGridStep,
  createSyntheticPng,
  downscaleForCursiveOcr,
  downscaleForOcr,
  encodeCompactJpegBuffer,
  orientedDimensions,
  readImageInfo,
} from './runtime/image.js';
import {
  atomicCopyFileSync,
  fetchWithTimeout,
  isBrokenPipeError,
  JPEG_MAGIC,
  readJsonRecordIfValid,
  resolveSafeChildPath,
  resolveUserPathFromContext,
  runWithConcurrency,
} from './runtime/primitives.js';
import {
  createRecordContext,
  type ExecFileFn,
  type RecordCommandContext,
  RecordRuntimeError,
} from './runtime/types.js';
import {
  assertSafeUrl,
  CookieJar,
  HttpStatusError,
  isPrivateOrReservedIp,
  parseRetryAfterMs,
  SsrfBlockedError,
} from './runtime/urlPolicy.js';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-c4-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const VALID_JPEG = Buffer.concat([JPEG_MAGIC, Buffer.from([0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])]);
const VALID_PDF = Buffer.from('%PDF-1.4\n%synthetic-archive-doc\n', 'ascii');

function makeCapturedContext(overrides: Partial<RecordCommandContext> = {}): {
  ctx: RecordCommandContext;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    sleepFn: async () => {},
    fetchImpl: async () => {
      throw new Error('Unexpected fetch call');
    },
    ...overrides,
  });
  return { ctx, stdout, stderr };
}

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeFakeSearchHit(naId: string, title: string): Record<string, unknown> {
  return {
    _source: {
      record: {
        naId: Number.parseInt(naId, 10),
        title,
        levelOfDescription: 'fileUnit',
        recordGroupNumber: 29,
        digitalObjects: [
          {
            objectId: 'obj-1',
            objectFilename: 'folio_001.jpg',
            objectUrl: `https://s3.amazonaws.com/NARAprodstorage/mock/${naId}/folio_001.jpg`,
            extractedText: `OCR text for ${title}`,
          },
        ],
      },
    },
  };
}

interface FakeResponseEvent {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<unknown>;
}

interface FakeBrowserPage extends OptionalBrowserPage {
  on(event: string, listener: (resp: FakeResponseEvent) => void): void;
  removeListener(event: string, listener: (resp: FakeResponseEvent) => void): void;
  emitResponse(resp: FakeResponseEvent): void;
}

function makeFakeBrowser(options: {
  readonly onGoto: (url: string, page: FakeBrowserPage) => Promise<void> | void;
  readonly waitForFunctionImpl?: (fn: string, arg?: unknown, opts?: { timeout?: number }) => Promise<unknown>;
  readonly omitWaitForTimeout?: boolean;
  readonly evaluateResult?: unknown;
}): { browser: OptionalBrowser; closed: { page: boolean; context: boolean; browser: boolean } } {
  const closed = { page: false, context: false, browser: false };
  const listeners = new Set<(resp: FakeResponseEvent) => void>();

  const page: FakeBrowserPage = {
    on(event, listener) {
      if (event === 'response') {
        listeners.add(listener);
      }
    },
    removeListener(event, listener) {
      if (event === 'response') {
        listeners.delete(listener);
      }
    },
    emitResponse(resp) {
      for (const listener of [...listeners]) {
        listener(resp);
      }
    },
    async goto(url) {
      await options.onGoto(url, page);
    },
    async content() {
      return '<html><body>National Archives Identifier</body></html>';
    },
    async evaluate<T>(): Promise<T> {
      return options.evaluateResult as T;
    },
    async close() {
      closed.page = true;
    },
    ...(options.waitForFunctionImpl ? { waitForFunction: options.waitForFunctionImpl } : {}),
    ...(options.omitWaitForTimeout
      ? {}
      : {
          async waitForTimeout() {
            // Instant in tests.
          },
        }),
  };

  const browser: OptionalBrowser = {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {
          closed.context = true;
        },
      };
    },
    async close() {
      closed.browser = true;
    },
  };

  return { browser, closed };
}

// ============================================================================
// 1. Find a Grave: formatters, domain, CLI help/commands, photoCommand, transport
// ============================================================================

describe('Find a Grave formatters and domain helpers', () => {
  it('handles coordinate extraction, cemetery/memorial enrichment, names, dates, events, and URLs', () => {
    expect(coordsPair(null)).toEqual([null, null]);
    expect(coordsPair({ lat: 41.25, lon: -95.93 })).toEqual([41.25, -95.93]);
    expect(coordsPair({ lat: 41.25, lng: -95.93 })).toEqual([41.25, -95.93]);
    expect(coordsPair({ lat: Number.NaN, lon: -95.93 })).toEqual([null, null]);

    expect(enrichCemetery('raw-value')).toBe('raw-value');
    expect(enrichCemetery({ id: '99', coordinates: { lat: 40.5, lon: -88.2 } })).toEqual({
      id: '99',
      coordinates: { lat: 40.5, lon: -88.2 },
      lat: 40.5,
      lng: -88.2,
    });
    expect(enrichCemetery({ id: '100' })).toEqual({ id: '100' });

    expect(enrichMemorial({ id: '12' })).toEqual({
      id: '12',
      cemetery_lat: null,
      cemetery_lng: null,
    });
    expect(
      enrichMemorial({
        id: '13',
        cemetery: { id: '50', coordinates: { lat: 42.1, lon: -87.9 } },
      })
    ).toEqual({
      id: '13',
      cemetery: { id: '50', coordinates: { lat: 42.1, lon: -87.9 }, lat: 42.1, lng: -87.9 },
      cemetery_lat: 42.1,
      cemetery_lng: -87.9,
    });

    expect(memorialUrl('4201')).toBe('https://www.findagrave.com/memorial/4201');
    expect(cemeteryUrl('8802')).toBe('https://www.findagrave.com/cemetery/8802');

    expect(primaryName({})).toBe('');
    expect(primaryName({ name: [{ first: 'Jane', last: 'Doe', maiden: 'Roe' }] })).toBe('Jane Doe (nee Roe)');
    expect(firstPlaceName(null)).toBe('');
    expect(firstPlaceName({ names: [] })).toBe('');
    expect(firstPlaceName({ names: [{ name: 'Oakville, River County' }] })).toBe('Oakville, River County');

    expect(fmtDate(null)).toBe('');
    expect(fmtDate({})).toBe('');
    expect(fmtDate({ year: 1840 })).toBe('1840');
    expect(fmtDate({ year: 1840, month: 3 })).toBe('Mar 1840');
    expect(fmtDate({ year: 1840, month: 3, day: 14 })).toBe('14 Mar 1840');
    expect(fmtDate({ year: 1840, month: 13, day: 5 })).toBe('5 1840');
    expect(fmtDate({ year: 1840, month: 3, day: 14, circa: true })).toBe('c. 14 Mar 1840');

    expect(fmtEvent(null)).toBe('');
    expect(
      fmtEvent({
        date: { year: 1840, month: 3, day: 14, circa: false },
        place: { names: [{ name: 'Oakville' }] },
      })
    ).toBe('14 Mar 1840, Oakville');
    expect(fmtCemetery(null)).toBe('');
    expect(fmtCemetery({ names: [] })).toBe('');
    expect(fmtCemetery({ names: [{ name: 'Oakville Cemetery' }] })).toBe('Oakville Cemetery');
  });

  it('formats search results, full/truncated memorials, cemeteries with aliases, and places', () => {
    const searchOut = formatSearchText(2, [
      {
        id: '1001',
        name: [{ first: 'Jane', last: 'Doe', maiden: 'Roe' }],
        birth: { date: { year: 1840, month: 3, day: 14 }, place: { names: [{ name: 'Oakville' }] } },
        death: { date: { year: 1912, month: 11, day: 2 }, place: { names: [{ name: 'Meadowbrook' }] } },
        cemetery: { id: '501', names: [{ name: 'Oakville Cemetery' }] },
        plot: 'Sec B, Lot 14',
        hasGravePhoto: true,
        isVeteran: true,
      },
      {
        id: '1002',
        name: [{ first: 'John', last: 'Doe' }],
        hasGravePhoto: false,
        isVeteran: false,
      },
    ]);
    expect(searchOut).toBe(
      [
        '2 memorials',
        '1001 | Jane Doe (nee Roe) | b. 14 Mar 1840, Oakville | d. 2 Nov 1912, Meadowbrook | Oakville Cemetery | plot: Sec B, Lot 14 | grave photo: yes veteran | https://www.findagrave.com/memorial/1001',
        '1002 | John Doe | b.  | d.  |  | plot:  | grave photo: no | https://www.findagrave.com/memorial/1002',
      ].join('\n')
    );

    const longInscription = 'I'.repeat(550);
    const longBio = 'B'.repeat(560);
    const fullMemorial = {
      id: '2001',
      name: [{ first: 'Jane', last: 'Doe', maiden: 'Roe' }],
      birth: { date: { year: 1840 }, place: { names: [{ name: 'Oakville' }] } },
      death: { date: { year: 1912 }, place: { names: [{ name: 'Meadowbrook' }] } },
      cemetery: {
        id: '501',
        names: [{ name: 'Oakville Cemetery' }],
        coordinates: { lat: 41.25, lon: -95.93 },
      },
      coordinates: { lat: 41.251, lon: -95.931 },
      plot: 'Row 4',
      isVeteran: true,
      hasGravePhoto: true,
      photos: {
        total: 2,
        photos: [
          'skip-non-record',
          { id: 'p1', type: 'Grave', path: 'https://images.findagrave.com/photos/p1.jpg' },
        ],
      },
      inscription: { value: longInscription },
      bio: { value: longBio },
      relationships: [
        'skip-non-record',
        { type: 'Spouse', memorial: { id: '2002', name: [{ first: 'John', last: 'Doe' }] } },
      ],
      dateCreated: '2020-01-01',
      dateModified: '2025-02-02',
    };

    const truncatedLines = formatMemorialsLines([fullMemorial], { full: false, photos: false });
    expect(truncatedLines).toEqual([
      'Memorial 2001: Jane Doe (nee Roe)',
      '  URL: https://www.findagrave.com/memorial/2001',
      '  Born: 1840, Oakville',
      '  Died: 1912, Meadowbrook',
      '  Cemetery: Oakville Cemetery (501)',
      '  Cemetery GPS: 41.25, -95.93',
      '  Grave GPS: 41.251, -95.931',
      '  Plot: Row 4',
      '  Veteran: yes | Grave photo: yes | Photos: 2',
      `  Inscription: ${'I'.repeat(500)}`,
      `  Bio: ${'B'.repeat(500)}`,
      '  Relationships:',
      '    Spouse: John Doe (2002)',
      '  Created: 2020-01-01 | Modified: 2025-02-02',
    ]);

    const fullWithPhotos = formatMemorialsLines([fullMemorial], { full: true, photos: true });
    expect(fullWithPhotos).toContain(`  Inscription: ${longInscription}`);
    expect(fullWithPhotos).toContain(`  Bio: ${longBio}`);
    expect(fullWithPhotos).toContain('  Photos:');
    expect(fullWithPhotos).toContain('    p1 | Grave | https://images.findagrave.com/photos/p1.jpg');

    const cemeteriesText = formatCemeteriesText(2, [
      {
        id: '501',
        names: [{ name: 'Oakville Cemetery' }, { name: 'Old Oak Yard' }, { name: 'Hillside' }],
        memorialCount: 412,
        coordinates: { lat: 41.25, lon: -95.93 },
      },
      {
        id: '502',
        names: [{ name: 'Meadowbrook Yard' }],
        memorialCount: 15,
      },
    ]);
    expect(cemeteriesText).toBe(
      [
        '2 cemeteries',
        '501 | Oakville Cemetery (also: Old Oak Yard, Hillside) | 412 memorials | GPS: 41.25, -95.93 | https://www.findagrave.com/cemetery/501',
        '502 | Meadowbrook Yard | 15 memorials | https://www.findagrave.com/cemetery/502',
      ].join('\n')
    );

    const placesText = formatPlacesText({
      total: 2,
      locations: [
        'skip-non-record',
        { id: 'city_77', __typename: 'Location', names: [{ name: 'Oakville' }] },
        { id: '501', __typename: 'Cemetery', names: [{ name: 'Oakville Cemetery' }], memorialCount: 412 },
      ],
    });
    expect(placesText).toBe(
      [
        '2 places',
        'city_77 | Location | Oakville',
        '501 | Cemetery | Oakville Cemetery | 412 memorials',
      ].join('\n')
    );
  });

  it('validates entity ids, photo URLs, prefixes, positional names, and image magic/content-types', () => {
    expect(() => validateEntityId('', 'memorial id')).toThrow(CliValidationError);
    expect(validateEntityId('https://www.findagrave.com/cemetery/8812/oakville')).toBe('8812');
    expect(() => validateEntityId('https://archive.example.test/memorial/123', 'memorial id')).toThrow(
      CliValidationError
    );

    expect(() => validatePhotoUrl('')).toThrow(RecordRuntimeError);
    expect(() => validatePhotoUrl('https://bad\nurl.findagrave.com/a.jpg')).toThrow(RecordRuntimeError);
    expect(() => validatePhotoUrl('not-a-url')).toThrow(RecordRuntimeError);
    expect(() => validatePhotoUrl('https://archive.example.test/a.jpg')).toThrow(RecordRuntimeError);

    expect(() => sanitizePrefix('...')).toThrow(CliValidationError);
    expect(sanitizePrefix('jane-doe')).toBe('jane-doe_');

    expect(() => resolvePositionalName(['Jane'], undefined, undefined, 'Jane Doe')).toThrow(
      CliValidationError
    );
    expect(() => resolvePositionalName(['Extra'], 'Jane', 'Doe', undefined)).toThrow(CliValidationError);
    expect(resolvePositionalName(['Doe'], 'Jane', undefined, undefined)).toEqual(['Jane', 'Doe']);
    expect(resolvePositionalName(['Jane'], undefined, 'Doe', undefined)).toEqual(['Jane', 'Doe']);
    expect(resolvePositionalName(['Doe'], undefined, undefined, undefined)).toEqual([undefined, 'Doe']);

    expect(imageContentType(null)).toBeUndefined();
    expect(imageContentType('image/webp; charset=binary')).toBe('image/webp');
    expect(hasImageMagic(Buffer.from('GIF89a...'))).toBe(true);
    expect(hasImageMagic(Buffer.from('RIFF1234WEBPextra'))).toBe(true);
    expect(hasImageMagic(Buffer.from('plain text'))).toBe(false);
  });
});

describe('Find a Grave CLI commands, help outputs, and photo command edge cases', () => {
  it('renders help for every Find a Grave subcommand', async () => {
    const cacheRoot = await makeTempDir('kinloom-fg-help-');
    const subcommands = ['search', 'get', 'cemetery', 'place', 'photo', 'url'] as const;
    for (const sub of subcommands) {
      const { ctx, stdout } = makeCapturedContext({ env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot } });
      const res = await runFindagraveCommand([sub, '--help'], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain(`Usage: kinloom findagrave ${sub}`);
    }
  });

  it('handles search/get/cemetery/place text outputs and validation errors', async () => {
    const cacheRoot = await makeTempDir('kinloom-fg-cmd-');

    // Validation errors
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot } });
      const res = await runFindagraveCommand(['search', '--page', '1', '--offset', '10'], ctx);
      expect(res.exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Pass either --page or --offset, not both.');
    }
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot } });
      const res = await runFindagraveCommand(['cemetery'], ctx);
      expect(res.exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Pass a cemetery id, --id, or --name.');
    }
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot } });
      const res = await runFindagraveCommand(['place', 'Oakville', '--name', 'Meadowbrook'], ctx);
      expect(res.exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Pass either a positional place name or --name, not both.');
    }
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot } });
      const res = await runFindagraveCommand(['place'], ctx);
      expect(res.exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Pass a place name positionally or with --name.');
    }

    // Search text mode exercising all filter flags
    let capturedSearchVars: Record<string, unknown> = {};
    const searchFetch: typeof fetch = async (_input, init) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { variables: { s: Record<string, unknown> } };
      capturedSearchVars = parsed.variables.s;
      return jsonResp({
        data: {
          memorialSearch: {
            total: 1,
            memorials: [
              {
                id: '3001',
                name: [{ first: 'Jane', last: 'Doe' }],
                birth: { date: { year: 1840 } },
                death: { date: { year: 1912 } },
                cemetery: { id: '501', names: [{ name: 'Oakville Cemetery' }] },
                plot: 'Lot 2',
                hasGravePhoto: true,
                isVeteran: false,
              },
            ],
          },
        },
      });
    };

    {
      const { ctx, stdout } = makeCapturedContext({
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: searchFetch,
      });
      const res = await runFindagraveCommand(
        [
          'search',
          '--first',
          'Jane',
          '--last',
          'Doe',
          '--birth-year',
          '1840',
          '--birth-year-filter',
          'exact',
          '--bio',
          'pioneer',
          '--text',
          'homestead',
          '--relative',
          'John Doe',
          '--exact',
        ],
        ctx
      );
      expect(res.exitCode).toBe(0);
      expect(capturedSearchVars['birthYearFilter']).toBe('exact');
      expect(capturedSearchVars['bio']).toBe('pioneer');
      expect(capturedSearchVars['fullText']).toBe('homestead');
      expect(capturedSearchVars['linkedToName']).toBe('John Doe');
      expect(capturedSearchVars['exactName']).toBe(true);
      expect(stdout.join('\n')).toContain('3001 | Jane Doe | b. 1840 | d. 1912 | Oakville Cemetery');
    }

    // Get text mode
    {
      const { ctx, stdout } = makeCapturedContext({
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          jsonResp({
            data: {
              memorialsById: [
                {
                  id: '3001',
                  name: [{ first: 'Jane', last: 'Doe' }],
                  photos: { total: 0, photos: [] },
                },
              ],
            },
          }),
      });
      const res = await runFindagraveCommand(['get', '3001'], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('Memorial 3001: Jane Doe');
    }

    // Cemetery search by --name and --place (text mode)
    {
      const { ctx, stdout } = makeCapturedContext({
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          jsonResp({
            data: {
              cemeteries: {
                total: 1,
                cemeteries: [
                  {
                    id: '501',
                    names: [{ name: 'Oakville Cemetery' }],
                    memorialCount: 42,
                    coordinates: { lat: 41.2, lon: -95.9 },
                  },
                ],
              },
            },
          }),
      });
      const res = await runFindagraveCommand(
        ['cemetery', '--name', 'Oakville', '--place', 'River County'],
        ctx
      );
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('501 | Oakville Cemetery | 42 memorials | GPS: 41.2, -95.9');
    }

    // Place text mode
    {
      const { ctx, stdout } = makeCapturedContext({
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          jsonResp({
            data: {
              locationsByTypeahead: {
                total: 1,
                locations: [{ id: 'city_77', __typename: 'Location', names: [{ name: 'Oakville' }] }],
              },
            },
          }),
      });
      const res = await runFindagraveCommand(['place', 'Oakville'], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toBe('1 places\ncity_77 | Location | Oakville');
    }
  });

  it('handles photo command edge cases: NUL --out, missing memorial, no photos, and --metadata --json', async () => {
    const workDir = await makeTempDir('kinloom-fg-photo-');
    const cacheRoot = path.join(workDir, 'cache');

    {
      const { ctx, stderr } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
      });
      const res = await runFindagraveCommand(['photo', '4001', '--out', 'bad\0dir'], ctx);
      expect(res.exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Invalid --out path');
    }

    {
      const { ctx, stderr } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async () => jsonResp({ data: { memorialsById: [] } }),
      });
      const res = await runFindagraveCommand(['photo', '4001'], ctx);
      expect(res.exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('No memorial found with id 4001');
    }

    {
      const { ctx, stdout } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          jsonResp({
            data: {
              memorialsById: [{ id: '4002', name: [{ first: 'Jane', last: 'Doe' }], photos: { photos: [] } }],
            },
          }),
      });
      const resText = await runFindagraveCommand(['photo', '4002'], ctx);
      expect(resText.exitCode).toBe(0);
      expect(stdout.join('\n')).toBe('No photos found.');

      const { ctx: ctx2, stdout: out2 } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
      });
      const resJson = await runFindagraveCommand(['photo', '4002', '--json'], ctx2);
      expect(resJson.exitCode).toBe(0);
      expect(JSON.parse(out2.join('\n'))).toEqual({ memorial_id: '4002', files: [], cache_hit: true });
    }

    // --metadata with --json emits metadata_file
    {
      const outDir = path.join(workDir, 'saved');
      const photoUrl = 'https://images.findagrave.com/photos/777.jpg';
      const { ctx, stdout } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_FINDAGRAVE_CACHE_DIR: cacheRoot },
        fetchImpl: async (input) => {
          const url = String(input);
          if (url.includes('/graphql')) {
            return jsonResp({
              data: {
                memorialsById: [
                  {
                    id: '4003',
                    name: [{ first: 'Jane', last: 'Doe' }],
                    photos: {
                      total: 1,
                      photos: [{ id: '777', type: 'Grave', caption: 'Stone', path: photoUrl }],
                    },
                  },
                ],
              },
            });
          }
          return new Response(VALID_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
        },
      });
      const res = await runFindagraveCommand(['photo', '4003', '--out', outDir, '--metadata', '--json'], ctx);
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(stdout.join('\n')) as { metadata_file?: string; files: unknown[] };
      expect(parsed.metadata_file).toBe(path.join(outDir, '4003.metadata.json'));
      expect(fs.existsSync(path.join(outDir, '4003.metadata.json'))).toBe(true);
    }
  });
});

describe('Find a Grave transport retries, redirects, photo cache, and error handling', () => {
  it('manages photo cache freshness, .type sidecars, and TTL expiration', async () => {
    const dir = await makeTempDir('kinloom-fg-pcache-');
    const photoPath = path.join(dir, 'sample.webp');
    const now = 1_700_000_000_000;

    // Non-magic bytes stored with image/webp creates .type sidecar
    const nonMagic = Buffer.from('synthetic-webp-payload');
    storePhotoCache(photoPath, nonMagic, 'image/webp');
    expect(fs.existsSync(`${photoPath}.type`)).toBe(true);
    expect(photoCacheFresh(photoPath, 0, () => now)).toBe(false);
    expect(photoCacheFresh(dir, 24, () => now)).toBe(false);
    const stat = fs.statSync(photoPath);
    expect(photoCacheFresh(photoPath, 1, () => stat.mtimeMs + 1000)).toBe(true);
    expect(photoCacheFresh(photoPath, 1, () => stat.mtimeMs + 4_000_000)).toBe(false);

    // Deleting .type invalidates non-magic cache entry
    fs.unlinkSync(`${photoPath}.type`);
    expect(photoCacheFresh(photoPath, 1, () => stat.mtimeMs + 1000)).toBe(false);

    // Overwriting with JPEG magic cleans up existing .type sidecar
    fs.writeFileSync(`${photoPath}.type`, 'image/webp\n');
    storePhotoCache(photoPath, VALID_JPEG, 'image/jpeg');
    expect(fs.existsSync(`${photoPath}.type`)).toBe(false);
    expect(photoCacheFresh(photoPath, 1, () => fs.statSync(photoPath).mtimeMs + 1000)).toBe(true);

    // HTML bytes rejected by cache check
    const htmlPhotoPath = path.join(dir, 'photo-html.jpg');
    fs.writeFileSync(htmlPhotoPath, '<!doctype html><html>error</html>');
    expect(photoCacheFresh(htmlPhotoPath, 1, () => fs.statSync(htmlPhotoPath).mtimeMs + 1000)).toBe(false);
  });

  it('handles GraphQL redirects, retries, HTML/JSON/GraphQL errors, and network failures', async () => {
    // 302 redirect to allowed findagrave subdomain switches method to GET
    const seenMethods: string[] = [];
    {
      let hop = 0;
      const { ctx } = makeCapturedContext({
        fetchImpl: async (_url, init) => {
          seenMethods.push(init?.method ?? 'GET');
          hop += 1;
          if (hop === 1) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://api.findagrave.com/orc/graphql' },
            });
          }
          return jsonResp({ data: { ok: true } });
        },
      });
      const data = await runGraphqlQuery(ctx, '{ ok }', {});
      expect(data).toEqual({ ok: true });
      expect(seenMethods).toEqual(['POST', 'GET']);
    }

    // Too many redirects
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () =>
          new Response(null, {
            status: 307,
            headers: { location: 'https://www.findagrave.com/orc/graphql' },
          }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('Too many redirects');
    }

    // Network failure exhausted after 3 attempts
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => {
          throw new Error('socket hangup');
        },
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow(
        'Request failed after 3 attempts: socket hangup'
      );
    }

    // Retryable 429 exhausted
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '0' } }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('HTTP 429');
    }

    // Non-retryable 400
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => new Response('bad request', { status: 400 }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('HTTP 400');
    }

    // HTML error page on 200 exhausted
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () =>
          new Response('<!doctype html><html><body>Wait</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('HTML error page instead of JSON');
    }

    // Invalid JSON on 200 exhausted
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () =>
          new Response('{broken', { status: 200, headers: { 'content-type': 'application/json' } }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('Invalid JSON');
    }

    // Unexpected array JSON payload
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => jsonResp([1, 2, 3]),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow('Unexpected GraphQL payload');
    }

    // GraphQL errors array
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => jsonResp({ errors: [{ message: 'Rate limited' }, 'Secondary error'] }),
      });
      await expect(runGraphqlQuery(ctx, '{ ok }', {})).rejects.toThrow(
        'GraphQL error: Rate limited\nGraphQL error: Secondary error'
      );
    }
  });

  it('handles fetchPhotoBytes redirects, HTTP failures, incomplete downloads, and memorial/cemetery cache edge cases', async () => {
    const validPhotoUrl = 'https://images.findagrave.com/photos/123.jpg';

    // Redirect across allowed CDN host
    {
      let calls = 0;
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(null, {
              status: 302,
              headers: { location: 'https://d22k5h68hofcrd.cloudfront.net/123.jpg' },
            });
          }
          return new Response(VALID_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
        },
      });
      const res = await fetchPhotoBytes(ctx, validPhotoUrl);
      expect(res.content.equals(VALID_JPEG)).toBe(true);
      expect(calls).toBe(2);
    }

    // Too many redirects
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: validPhotoUrl } }),
      });
      await expect(fetchPhotoBytes(ctx, validPhotoUrl)).rejects.toThrow('Too many redirects');
    }

    // Retryable 503 exhausted and non-retryable 404
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => new Response('down', { status: 503 }),
      });
      await expect(fetchPhotoBytes(ctx, validPhotoUrl)).rejects.toThrow('HTTP 503 downloading');
    }
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () => new Response('missing', { status: 404 }),
      });
      await expect(fetchPhotoBytes(ctx, validPhotoUrl)).rejects.toThrow('HTTP 404 downloading');
    }

    // Incomplete download retried and exhausted
    {
      const { ctx } = makeCapturedContext({
        fetchImpl: async () =>
          new Response(VALID_JPEG, {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '9999' },
          }),
      });
      await expect(fetchPhotoBytes(ctx, validPhotoUrl)).rejects.toThrow('Incomplete photo download');
    }

    // Deduplicated IDs, corrupt cache envelope, and cemetery cache hit/miss
    const cacheRoot = await makeTempDir('kinloom-fg-trans-');
    const badEnvPath = path.join(cacheRoot, 'memorials', '555.json');
    fs.mkdirSync(path.dirname(badEnvPath), { recursive: true });
    fs.writeFileSync(badEnvPath, JSON.stringify({ cached_at: 'bad', data: null }));

    const { ctx } = makeCapturedContext({
      nowMs: () => 1_700_000_000_000,
      fetchImpl: async () =>
        jsonResp({
          data: {
            memorialsById: [
              'not-a-record',
              { id: 'bad/id', name: [] },
              { id: '555', name: [{ first: 'Jane', last: 'Doe' }] },
            ],
            cemeteries: {
              total: 1,
              cemeteries: [{ id: '901', names: [{ name: 'Oakville Cemetery' }] }],
            },
          },
        }),
    });

    const memRes = await loadOrFetchMemorialsWithHits(ctx, ['555', '555'], {
      cacheRoot,
      ttlHours: 24,
      refresh: false,
    });
    expect(memRes.memorials).toHaveLength(2);
    expect(memRes.allHit).toBe(false);

    const cemMiss = await loadOrFetchCemeteryById(ctx, '901', { cacheRoot, ttlHours: 24, refresh: false });
    expect(cemMiss.cacheHit).toBe(false);
    const cemHit = await loadOrFetchCemeteryById(ctx, '901', { cacheRoot, ttlHours: 24, refresh: false });
    expect(cemHit.cacheHit).toBe(true);
  });
});

// ============================================================================
// 2. NARA: browserFallback, queryAndRecords, queryValidation, catalog, downloads, census1950
// ============================================================================

describe('NARA browser fallback (search and get records)', () => {
  it('captures proxy search JSON responses and falls back to DOM scrape when absent', async () => {
    const searchUrl = 'https://catalog.archives.gov/search?q=Oakville';
    const { browser, closed } = makeFakeBrowser({
      onGoto: async (_url, page) => {
        // Ignored: non-200
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/v2/records/search',
          status: () => 500,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => ({}),
        });
        // Ignored: rejecting json
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/v2/records/search',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json' }),
          json: async () => {
            throw new Error('broken body');
          },
        });
        // Captured valid search response
        page.emitResponse({
          url: () => 'https://catalog.archives.gov/proxy/v2/records/search?q=Oakville',
          status: () => 200,
          headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
          json: async () => ({
            body: {
              hits: {
                total: { value: 1 },
                hits: [makeFakeSearchHit('12345', 'Oakville Township Plat')],
              },
            },
          }),
        });
      },
      waitForFunctionImpl: async () => {
        throw new Error('non-fatal wait timeout');
      },
    });

    const { ctx } = makeCapturedContext();
    const res = await defaultBrowserSearchMany([['Oakville', searchUrl]], ctx, 5000, {
      launcher: async () => browser,
    });
    expect(closed).toEqual({ page: true, context: true, browser: true });
    expect(res).toHaveLength(1);
    expect(res[0].query).toBe('Oakville');
    expect(res[0].total).toBe(1);
    expect(res[0].results[0].naId).toBe('12345');

    // Fallback to DOM evaluate when no proxy JSON captured (and query === null, no waitForTimeout)
    const { browser: domBrowser } = makeFakeBrowser({
      onGoto: () => {},
      omitWaitForTimeout: true,
      evaluateResult: [
        { naId: '98765', title: 'Meadowbrook Ledger', url: 'https://catalog.archives.gov/id/98765' },
      ],
    });
    const domRes = await defaultBrowserSearchMany([[null, searchUrl]], ctx, 5000, {
      launcher: async () => domBrowser,
    });
    expect(domRes[0].query).toBeUndefined();
    expect(domRes[0].total).toBe(1);
    expect(domRes[0].results[0].title).toBe('Meadowbrook Ledger');
  });

  it('captures record metadata and transcriptions in defaultBrowserGetRecords and handles missing capture', async () => {
    const { browser } = makeFakeBrowser({
      onGoto: async (url, page) => {
        if (url.endsWith('/12345')) {
          // Ignored non-json response
          page.emitResponse({
            url: () => 'https://catalog.archives.gov/proxy/v2/records/search?naId_is=12345',
            status: () => 200,
            headers: () => ({ 'content-type': 'text/html' }),
            json: async () => ({}),
          });
          // Valid record response
          page.emitResponse({
            url: () => 'https://catalog.archives.gov/proxy/v2/records/search?naId_is=12345',
            status: () => 200,
            headers: () => ({ 'content-type': 'application/json' }),
            json: async () => ({
              body: {
                hits: {
                  hits: [makeFakeSearchHit('12345', 'Oakville Militia Roll')],
                },
              },
            }),
          });
          // Contributions response with transcriptions
          page.emitResponse({
            url: () => 'https://catalog.archives.gov/proxy/v2/contributions/targetNaId/12345',
            status: () => 200,
            headers: () => ({ 'content-type': 'application/json' }),
            json: async () => [
              { contributionType: 'tag', text: 'ignored-tag' },
              { contributionType: 'transcription', text: 'First transcription line' },
              { contributionType: 'transcription', transcription: 'Second transcription line' },
            ],
          });
        }
      },
      waitForFunctionImpl: async () => true,
    });

    const { ctx } = makeCapturedContext();
    const records = await defaultBrowserGetRecords(
      ['12345', '99999'],
      { includeObjects: true, includeText: true, pageSpec: 'all', timeoutMs: 5000 },
      ctx,
      { launcher: async () => browser }
    );

    expect(records).toHaveLength(2);
    expect(records[0].naId).toBe('12345');
    expect(records[0].title).toBe('Oakville Militia Roll');
    expect(records[0].transcriptions).toEqual(['First transcription line', 'Second transcription line']);
    expect(records[1]).toEqual({
      naId: '99999',
      url: 'https://catalog.archives.gov/id/99999',
      error: 'Record metadata not captured.',
    });
  });
});

describe('NARA queryAndRecords and queryValidation behavioral coverage', () => {
  it('extracts rich records, projects pages/text/transcriptions, and formats full text output', () => {
    const rawHit = {
      _source: {
        record: {
          naId: 54321,
          title: 'Oakville Muster Roll',
          levelOfDescription: 'fileUnit',
          ancestors: [
            { levelOfDescription: 'recordGroup', recordGroupNumber: 94, title: 'Adjutant General' },
            { levelOfDescription: 'series', naId: 11111, title: 'Muster Rolls' },
          ],
          inclusiveStartDate: { logicalDate: '1861-04-01' },
          inclusiveEndDate: { logicalDate: '1865-05-01' },
          productionDateArray: [{ logicalDate: '1863-07-04' }],
          microformPublications: [{ identifier: 'M594', title: 'Compiled Records', note: 'Roll 12' }],
          accessRestriction: { status: 'Unrestricted' },
          useRestriction: { status: 'Unrestricted' },
          scopeAndContentNote: 'Synthetic muster entries for Oakville.',
          physicalOccurrences: [
            'skip-invalid',
            {
              referenceUnits: [
                { name: 'National Archives Building - Washington, DC' },
                { name: 'National Archives Building - Washington, DC' },
                { name: 'National Archives at Chicago' },
              ],
            },
          ],
          digitalObjects: [
            {
              objectId: 'obj-1',
              objectFilename: 'page_1.jpg',
              objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/54321/page_1.jpg',
              extractedText: 'Roll page one',
            },
            {
              objectId: 'obj-2',
              objectUrl: 'https://s3.amazonaws.com/NARAprodstorage/54321/page_2.jpg',
              otherExtractedText: 'Roll page two',
            },
          ],
        },
      },
    };

    const full = extractRecord(rawHit, { includeObjects: true, includeText: true, pageSpec: 'all' });
    full.transcriptions = ['Volunteer transcript A'];
    expect(full.rg).toBe(94);
    expect(full.rgTitle).toBe('Adjutant General');
    expect(full.series).toBe('Muster Rolls');
    expect(full.seriesNaId).toBe('11111');
    expect(full.dates).toEqual(['1861-04-01', '1865-05-01', '1863-07-04']);
    expect(full.microform).toEqual(['M594 | Compiled Records | Roll 12']);
    expect(full.location).toEqual([
      'National Archives Building - Washington, DC',
      'National Archives at Chicago',
    ]);
    expect(full.objects?.[1]?.filename).toBe('obj-2');
    expect(full.extractedText?.map((t) => t.text)).toEqual(['Roll page one', 'Roll page two']);

    const projected = projectRecord(full, { includeObjects: true, includeText: true, pageSpec: '2' });
    expect(projected.objects?.map((o) => o.page)).toEqual([2]);
    expect(projected.extractedText?.map((t) => t.page)).toEqual([2]);
    expect(projected.transcriptions).toEqual(['Volunteer transcript A']);

    const rendered = formatRecordText(projected);
    expect(rendered).toContain('NAID 54321 [fileUnit] RG 94 2 files: Oakville Muster Roll');
    expect(rendered).toContain('  Series: Muster Rolls');
    expect(rendered).toContain('  Dates: 1861-04-01 .. 1865-05-01 .. 1863-07-04');
    expect(rendered).toContain('  Microform: M594 | Compiled Records | Roll 12');
    expect(rendered).toContain('  Access/Use: Unrestricted / Unrestricted');
    expect(rendered).toContain(
      '  Location: National Archives Building - Washington, DC; National Archives at Chicago'
    );
    expect(rendered).toContain('  Scope: Synthetic muster entries for Oakville.');
    expect(rendered).toContain('  [002] obj-2: https://s3.amazonaws.com/NARAprodstorage/54321/page_2.jpg');
    expect(rendered).toContain('  --- Page 2 () ---\nRoll page two');
    expect(rendered).toContain('  --- Transcription ---\nVolunteer transcript A');

    expect(formatRecordText({ naId: '54321', url: '', error: 'Not found' })).toBe(
      'NAID 54321: ERROR - Not found'
    );

    expect(
      buildSearchPayload(null, 'https://catalog.archives.gov/search', { hits: { total: '7', hits: [] } })
    ).toEqual({ searchUrl: 'https://catalog.archives.gov/search', total: 7, results: [] });
    expect(
      buildSearchPayload('q', 'https://catalog.archives.gov/search', { hits: { total: 4, hits: [] } }).total
    ).toBe(4);
  });

  it('validates query parameters, TTLs, filenames, error payloads, URLs, and page specs', () => {
    expect(quotePythonStyle("a/b!'()*", false)).toBe('a%2Fb%21%27%28%29%2A');
    expect(() => resolveQueryTtlHours(-1, {})).toThrow(CliValidationError);
    expect(resolveQueryTtlHours(undefined, { KINLOOM_NARA_QUERY_TTL_HOURS: '12' })).toBe(12);
    expect(() => resolveQueryTtlHours(undefined, { KINLOOM_NARA_QUERY_TTL_HOURS: 'abc' })).toThrow(
      CliValidationError
    );
    expect(() => resolveQueryTtlHours(undefined, { KINLOOM_NARA_QUERY_TTL_HOURS: '-5' })).toThrow(
      CliValidationError
    );

    expect(() => validateNaraDownloadUrl('')).toThrow(RecordRuntimeError);
    expect(() => validateNaraDownloadUrl('not a url')).toThrow(RecordRuntimeError);
    expect(() => safeObjectFilename(0, 'a.jpg')).toThrow(RangeError);
    expect(safeObjectFilename(3, '....')).toBe('003_3.bin');

    expect(detectErrorPayload(Buffer.from('<html>ok</html>'), 'text/html', 'index.html')).toBeNull();
    expect(
      detectErrorPayload(Buffer.from('<!doctype html><html>err</html>'), 'application/octet-stream')
    ).toBe('HTML error page');
    expect(
      detectErrorPayload(
        Buffer.from('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>'),
        'application/xml'
      )
    ).toBe('S3 XML error response');
    expect(detectErrorPayload(Buffer.from('not-a-pdf'), 'application/pdf', 'doc.pdf')).toBe(
      'non-PDF payload'
    );

    const p1 = buildQueryParams('Jane', {
      series: 'M594',
      control: 'T623',
      person: 'Jane Doe',
      geo: 'Oakville',
      materialType: 'Photographs',
    });
    expect(p1).toContainEqual(['q', 'Jane M594']);
    expect(p1).toContainEqual(['personOrOrg', 'Jane Doe']);
    expect(p1).toContainEqual(['geographicReference', 'Oakville']);
    expect(p1).toContainEqual(['typeOfMaterials', 'Photographs']);

    const p2 = buildQueryParams('Jane', { series: 'Muster Series', title: 'Existing Title' });
    expect(p2).toContainEqual(['q', 'Jane Muster Series']);
    expect(encodeCatalogUrl([], false)).toBe('https://catalog.archives.gov/search');

    expect(parsePageSpec('all', 0)).toEqual([]);
    expect(parsePageSpec('1,,4-2', 5)).toEqual([1, 2, 3, 4]);
    expect(() => parsePageSpec('a-3', 5)).toThrow(CliValidationError);
    expect(() => parsePageSpec('foo', 5)).toThrow(CliValidationError);
  });
});

describe('NARA catalog cache, transport, commands, and download helpers', () => {
  it('handles catalog cache edge cases, redirects, API errors, and WAF fallback', async () => {
    const cacheRoot = await makeTempDir('kinloom-nara-cat-');
    const filter: SearchFilterOptions = {
      levels: ['fileUnit,item'],
      recordGroups: ['29, 94'],
      online: false,
      page: 1,
      limit: 20,
    };
    const canonical = canonicalSearchParams('Oakville', filter);
    expect(canonical.levels).toEqual(['fileUnit', 'item']);
    expect(canonical.record_groups).toEqual(['29', '94']);

    const { ctx } = makeCapturedContext({ nowMs: () => 1_700_000_000_000 });
    await writeCachedSearch(
      canonical,
      {
        query: 'Oakville',
        searchUrl: 'https://catalog.archives.gov/search?q=Oakville',
        total: 0,
        results: [],
      },
      cacheRoot,
      ctx
    );
    expect(readCachedSearch(canonical, cacheRoot, 1, () => 1_700_000_000_000 + 7_200_000)).toBeNull();

    // Error records are never cached
    await writeCachedRecord(
      '777',
      { naId: '777', url: 'https://catalog.archives.gov/id/777', error: 'Not found' },
      cacheRoot,
      false,
      ctx
    );
    expect(readCachedRecord('777', cacheRoot, false)).toBeNull();

    // Corrupt record cache envelope with error field returns null
    const recPath = path.join(cacheRoot, 'records', '778.json');
    fs.mkdirSync(path.dirname(recPath), { recursive: true });
    fs.writeFileSync(
      recPath,
      JSON.stringify({ cached_at: 1, naId: '778', has_text: false, record: { naId: '778', error: 'boom' } })
    );
    expect(readCachedRecord('778', cacheRoot, false)).toBeNull();

    expect(
      parseRetryAfterSeconds(new Headers({ 'retry-after': 'not-a-date' }), () => 1000, 30)
    ).toBeUndefined();

    // Redirects in fetchFollowingRedirects
    let hop = 0;
    const redirected = await fetchFollowingRedirects('https://catalog.archives.gov/api/v2/records/search', {
      headers: {},
      timeoutMs: 5000,
      fetchImpl: async (u) => {
        hop += 1;
        if (hop === 1) {
          return new Response(null, { status: 302, headers: { location: '/api/v2/records/search?v=2' } });
        }
        return jsonResp({ ok: String(u) });
      },
    });
    expect(redirected.status).toBe(200);

    // Redirect without location returns response directly
    const noLoc = await fetchFollowingRedirects('https://catalog.archives.gov/api/v2/records/search', {
      headers: {},
      timeoutMs: 5000,
      fetchImpl: async () => new Response(null, { status: 302 }),
    });
    expect(noLoc.status).toBe(302);

    // Too many redirects
    await expect(
      fetchFollowingRedirects('https://catalog.archives.gov/api/v2/records/search', {
        headers: {},
        timeoutMs: 5000,
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
      })
    ).rejects.toThrow('Too many redirects');

    // apiGetJson failure branches
    const makeCtxWithFetch = (fetchImpl: typeof fetch) => makeCapturedContext({ fetchImpl }).ctx;
    await expect(
      apiGetJson(
        'https://catalog.archives.gov/api/v2/records/search',
        'key',
        makeCtxWithFetch(async () => {
          throw new Error('conn reset');
        })
      )
    ).rejects.toThrow('Network error fetching');

    await expect(
      apiGetJson(
        'https://catalog.archives.gov/api/v2/records/search',
        'key',
        makeCtxWithFetch(async () => new Response('overloaded', { status: 503 }))
      )
    ).rejects.toThrow(HttpStatusError);

    await expect(
      apiGetJson(
        'https://catalog.archives.gov/api/v2/records/search',
        'key',
        makeCtxWithFetch(async () => new Response('missing', { status: 404 }))
      )
    ).rejects.toThrow(HttpStatusError);

    await expect(
      apiGetJson(
        'https://catalog.archives.gov/api/v2/records/search',
        'key',
        makeCtxWithFetch(
          async () =>
            new Response('{invalid', { status: 200, headers: { 'content-type': 'application/json' } })
        )
      )
    ).rejects.toThrow(NaraWafOrNonJsonError);

    await expect(
      apiGetJson(
        'https://catalog.archives.gov/api/v2/records/search',
        'key',
        makeCtxWithFetch(async () => jsonResp([1, 2]))
      )
    ).rejects.toThrow(NaraWafOrNonJsonError);

    // apiSearchOne WAF retry returning WAF again -> [null, webUrl]
    const [wafPayload, webUrl] = await apiSearchOne(
      '"Jane Doe" AND Oakville',
      'key',
      filter,
      makeCtxWithFetch(
        async () =>
          new Response('<html>waf</html>', { status: 403, headers: { 'content-type': 'text/html' } })
      )
    );
    expect(wafPayload).toBeNull();
    expect(webUrl).toContain('catalog.archives.gov/search');

    // loadOrFetchFullRecordsWithHits: API WAF fallback to browser + API empty hits -> Not found
    let apiCalls = 0;
    const [recs] = await loadOrFetchFullRecordsWithHits(
      ['1001', '1002'],
      { apiKey: 'key', forceBrowser: false, includeText: false, refresh: true, cacheRoot },
      makeCtxWithFetch(async (u) => {
        apiCalls += 1;
        if (String(u).includes('naId_is=1001')) {
          return new Response('<html>waf</html>', { status: 403, headers: { 'content-type': 'text/html' } });
        }
        return jsonResp({ body: { hits: { hits: [] } } });
      }),
      {
        browserGetRecords: async (ids) =>
          ids.map((id) => ({
            naId: id,
            title: 'Browser Fallback Record',
            url: `https://catalog.archives.gov/id/${id}`,
          })),
      }
    );
    expect(apiCalls).toBe(2);
    expect(recs[0].title).toBe('Browser Fallback Record');
    expect(recs[1].error).toBe('Not found');
  });

  it('exercises NARA CLI help, text outputs, browser mode, and download validation errors', async () => {
    const cacheRoot = await makeTempDir('kinloom-nara-cli-');
    const nara = createNaraCommand({
      browserSearchMany: async (items) =>
        items.map(([q, url]) => ({
          ...(q ? { query: q } : {}),
          searchUrl: url,
          total: 1,
          results: [
            {
              naId: '44001',
              title: 'Oakville Register',
              url: 'https://catalog.archives.gov/id/44001',
              level: 'fileUnit',
              rg: 29,
              objectCount: 3,
              series: 'Township Registers',
            },
          ],
        })),
      browserGetRecords: async (ids) =>
        ids.map((id) =>
          id === '44002'
            ? { naId: id, url: `https://catalog.archives.gov/id/${id}`, error: 'Missing' }
            : {
                naId: id,
                title: 'Empty Object Record',
                url: `https://catalog.archives.gov/id/${id}`,
                objectCount: 0,
                objects: [],
              }
        ),
    });

    for (const sub of ['url', 'search', 'get', 'download', 'census1950', 'census1950-image'] as const) {
      const { ctx, stdout } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      const res = await nara([sub, '--help'], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain(`Usage: kinloom nara ${sub}`);
    }

    // Search text output with 2 queries in browser mode
    {
      const { ctx, stdout } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      const res = await nara(['search', 'Oakville', 'Meadowbrook', '--browser'], ctx);
      expect(res.exitCode).toBe(0);
      const out = stdout.join('\n');
      expect(out).toContain('Query: Oakville | Total: 1 |');
      expect(out).toContain(
        '   1. NAID 44001 (fileUnit | RG 29 | 3 files): Oakville Register [Township Registers]'
      );
      expect(out).toContain('Query: Meadowbrook | Total: 1 |');
    }

    // Get text output with mixed normal + error record
    {
      const { ctx, stdout } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      const res = await nara(['get', '44001', '44002', '--browser'], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('NAID 44001: Empty Object Record');
      expect(stdout.join('\n')).toContain('NAID 44002: ERROR - Missing');
    }

    // Download validation errors: timeout <= 0, error record, no objects, unsafe relative outDir
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      expect((await nara(['download', '44001', '--timeout', '0'], ctx)).exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Invalid --timeout value');
    }
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      expect((await nara(['download', '44002', '--browser'], ctx)).exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('NAID 44002: Missing');
    }
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      expect((await nara(['download', '44001', '--browser'], ctx)).exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('has no matching digital objects');
    }
  });

  it('validates downloadCore and downloads text/skip/error paths', async () => {
    const workDir = await makeTempDir('kinloom-nara-dl-');
    const cacheRoot = path.join(workDir, 'cache');

    expect(() =>
      validateDownloadedFile(path.join(workDir, 'missing.pdf'), {
        url: 'https://s3.amazonaws.com/NARAprodstorage/a.pdf',
        contentType: 'application/pdf',
      })
    ).toThrow('Failed reading downloaded file');

    const emptyFile = path.join(workDir, 'empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    expect(() => validateDownloadedFile(emptyFile, { url: 'not-a-url', contentType: '' })).toThrow(
      'Downloaded empty response'
    );

    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/', 'application/pdf')).toBe(
      'download.pdf'
    );
    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/', 'image/jpeg')).toBe('download.jpg');
    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/', 'image/png')).toBe('download.png');
    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/', 'image/tiff')).toBe('download.tif');
    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/', 'application/octet-stream')).toBe(
      'download.bin'
    );
    expect(safeUrlFilename('https://s3.amazonaws.com/NARAprodstorage/%ZZbad.jpg')).toBe('_ZZbad.jpg');

    // readCachedDownloadEntry edge cases
    const binPath = path.join(workDir, 'cached.pdf');
    const metaPath = path.join(workDir, 'cached.json');
    fs.writeFileSync(binPath, VALID_PDF);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ cached_at: 100, bytes: 99999, content_type: 'application/pdf' })
    );
    const dlUrl = 'https://s3.amazonaws.com/NARAprodstorage/doc.pdf';
    expect(
      readCachedDownloadEntry(binPath, metaPath, { url: dlUrl, ttlHours: 0, nowMs: () => 200_000 })
    ).toBeNull();
    expect(
      readCachedDownloadEntry(workDir, metaPath, { url: dlUrl, ttlHours: 10, nowMs: () => 200_000 })
    ).toBeNull();
    expect(
      readCachedDownloadEntry(binPath, metaPath, { url: dlUrl, ttlHours: 1, nowMs: () => 10_000_000 })
    ).toBeNull();
    // Byte count mismatch invalidates entry
    expect(
      readCachedDownloadEntry(binPath, metaPath, { url: dlUrl, ttlHours: 10, nowMs: () => 200_000 })
    ).toBeNull();

    // resolveDirectDownloadDest variants
    expect(resolveDirectDownloadDest(undefined, dlUrl, 'application/pdf', workDir)).toBe(
      path.join(workDir, 'doc.pdf')
    );
    expect(() => resolveDirectDownloadDest('bad\0path', dlUrl, 'application/pdf', workDir)).toThrow(
      CliValidationError
    );
    expect(resolveDirectDownloadDest(workDir, dlUrl, 'application/pdf', workDir)).toBe(
      path.join(workDir, 'doc.pdf')
    );
    expect(resolveDirectDownloadDest('new-subdir', dlUrl, 'application/pdf', workDir)).toBe(
      path.join(workDir, 'new-subdir', 'doc.pdf')
    );
    expect(() => resolveDirectDownloadDest('../escape-dir', dlUrl, 'application/pdf', workDir)).toThrow(
      RecordRuntimeError
    );

    // downloadObjectToCache failure branches
    const outCacheBin = path.join(cacheRoot, 'obj.pdf');
    await expect(
      downloadObjectToCache(
        dlUrl,
        outCacheBin,
        { timeoutSec: 5 },
        makeCapturedContext({ fetchImpl: async () => new Response('err', { status: 503 }) }).ctx
      )
    ).rejects.toThrow('HTTP 503 downloading');
    await expect(
      downloadObjectToCache(
        dlUrl,
        outCacheBin,
        { timeoutSec: 5 },
        makeCapturedContext({ fetchImpl: async () => new Response('missing', { status: 404 }) }).ctx
      )
    ).rejects.toThrow('HTTP 404 downloading');
    await expect(
      downloadObjectToCache(
        dlUrl,
        outCacheBin,
        { timeoutSec: 5 },
        makeCapturedContext({
          fetchImpl: async () =>
            new Response(VALID_PDF, {
              status: 200,
              headers: { 'content-type': 'application/pdf', 'content-length': '9999' },
            }),
        }).ctx
      )
    ).rejects.toThrow('Incomplete download');
    await expect(
      downloadObjectToCache(
        dlUrl,
        outCacheBin,
        { timeoutSec: 5 },
        makeCapturedContext({
          fetchImpl: async () => {
            throw new Error('reset');
          },
        }).ctx
      )
    ).rejects.toThrow('Failed downloading');

    // downloadDirectUrl text mode: Downloaded -> Exists (skip) -> Cached (with overwrite)
    const directOut = path.join(workDir, 'direct', 'doc.pdf');
    {
      const { ctx, stdout } = makeCapturedContext({
        cwd: workDir,
        fetchImpl: async () =>
          new Response(VALID_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      });
      await downloadDirectUrl(
        dlUrl,
        {
          outPath: directOut,
          overwrite: false,
          refresh: false,
          timeoutSec: 5,
          ttlHours: 24,
          asJson: false,
          cacheRoot,
        },
        ctx
      );
      expect(stdout.join('\n')).toContain(`Downloaded: ${directOut}`);
    }
    {
      const { ctx, stdout } = makeCapturedContext({ cwd: workDir });
      await downloadDirectUrl(
        dlUrl,
        {
          outPath: directOut,
          overwrite: false,
          refresh: false,
          timeoutSec: 5,
          ttlHours: 24,
          asJson: false,
          cacheRoot,
        },
        ctx
      );
      expect(stdout.join('\n')).toBe(`Exists (skip): ${directOut}`);
    }
    {
      const { ctx, stdout } = makeCapturedContext({ cwd: workDir });
      await downloadDirectUrl(
        dlUrl,
        {
          outPath: directOut,
          overwrite: true,
          refresh: false,
          timeoutSec: 5,
          ttlHours: 24,
          asJson: false,
          cacheRoot,
        },
        ctx
      );
      expect(stdout.join('\n')).toContain(`Cached: ${directOut}`);
    }

    // downloadRecordObjects skipping missing url & skipping existing file
    const recTargetDir = path.join(workDir, 'rec-out');
    const existingObjDest = path.join(recTargetDir, '002_page2.pdf');
    fs.mkdirSync(recTargetDir, { recursive: true });
    fs.writeFileSync(existingObjDest, VALID_PDF);
    {
      const { ctx, stdout, stderr } = makeCapturedContext({
        cwd: workDir,
        fetchImpl: async () =>
          new Response(VALID_PDF, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      });
      await downloadRecordObjects(
        '55001',
        { naId: '55001', url: 'https://catalog.archives.gov/id/55001', title: 'Test' },
        [
          { page: 1, filename: 'missing.pdf', url: '' },
          { page: 2, filename: 'page2.pdf', url: dlUrl },
        ],
        {
          targetDir: recTargetDir,
          cacheRoot,
          totalCount: 2,
          metaCacheHit: false,
          metadata: false,
          overwrite: false,
          refresh: false,
          timeoutSec: 5,
          ttlOverride: 24,
          asJson: false,
        },
        ctx
      );
      expect(stderr.join('\n')).toContain('Skipping page 1: missing url');
      expect(stdout.join('\n')).toContain(`Exists (skip): ${existingObjDest}`);
    }
  });
});

describe('NARA 1950 Census search and image behavioral coverage', () => {
  it('validates 1950 census query params, cache, and fetch errors', async () => {
    expect(() => normalizeCensus1950State('')).toThrow(CliValidationError);
    expect(() => canonicalCensus1950Query({ state: 'IL', limit: 0 })).toThrow(CliValidationError);
    expect(() => canonicalCensus1950Query({ state: 'IL', ed: 'bad/ed', limit: 10 })).toThrow(
      CliValidationError
    );

    const dir = await makeTempDir('kinloom-c1950-');
    const cacheFile = path.join(dir, 'q.json');
    fs.writeFileSync(cacheFile, JSON.stringify({ cached_at: 'bad', data: {} }));
    expect(readCachedCensus1950(cacheFile, 24, () => 1_700_000_000_000)).toBeNull();
    fs.writeFileSync(cacheFile, JSON.stringify({ cached_at: 100, data: { results: [] } }));
    expect(readCachedCensus1950(cacheFile, 1, () => 10_000_000)).toBeNull();

    const apiUrl = 'https://1950census.archives.gov/api/search?state=IL&size=10&page=1';
    await expect(
      census1950FetchJson(
        apiUrl,
        makeCapturedContext({
          fetchImpl: async () => {
            throw new Error('offline');
          },
        }).ctx
      )
    ).rejects.toThrow('Network error fetching');

    await expect(
      census1950FetchJson(
        apiUrl,
        makeCapturedContext({ fetchImpl: async () => new Response('busy', { status: 503 }) }).ctx
      )
    ).rejects.toThrow(HttpStatusError);

    await expect(
      census1950FetchJson(
        apiUrl,
        makeCapturedContext({ fetchImpl: async () => new Response('bad', { status: 400 }) }).ctx
      )
    ).rejects.toThrow(HttpStatusError);

    await expect(
      census1950FetchJson(
        apiUrl,
        makeCapturedContext({
          fetchImpl: async () =>
            new Response('<html>err</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        }).ctx
      )
    ).rejects.toThrow('did not return JSON');

    await expect(
      census1950FetchJson(
        apiUrl,
        makeCapturedContext({
          fetchImpl: async () =>
            new Response('{bad', { status: 200, headers: { 'content-type': 'application/json' } }),
        }).ctx
      )
    ).rejects.toThrow('invalid JSON');

    await expect(
      census1950FetchJson(apiUrl, makeCapturedContext({ fetchImpl: async () => jsonResp({ total: 1 }) }).ctx)
    ).rejects.toThrow('unexpected payload');
  });

  it('parses 1950 census IIIF paths/URLs, validates JPEG bytes, and exercises census CLI error/text paths', async () => {
    expect(() => validateCensus1950ImagePath('1950census/bad/../sheet.jpg')).toThrow(CliValidationError);
    expect(() => parseCensus1950ImageSource('')).toThrow(CliValidationError);
    expect(() => parseCensus1950ImageSource('1950census%2f%ZZbad.jpg')).toThrow(CliValidationError);
    expect(() => parseCensus1950ImageSource('https://[bad-url')).toThrow(CliValidationError);
    expect(() => parseCensus1950ImageSource('https://1950census.archives.gov/iiif/2/')).toThrow(
      CliValidationError
    );
    expect(
      parseCensus1950ImageSource(
        'https://1950census.archives.gov/iiif/2/1950census%2F43290879-IL%2Fsheet.jpg/0,0,100,100/800,/0/default.jpg'
      )
    ).toBe('1950census/43290879-IL/sheet.jpg');
    expect(() =>
      parseCensus1950ImageSource('https://1950census.archives.gov/iiif/2/short/default.jpg')
    ).toThrow(CliValidationError);
    expect(() =>
      parseCensus1950ImageSource('https://1950census.archives.gov/iiif/2/1950census%2Fsheet.png')
    ).toThrow(CliValidationError);
    expect(() =>
      parseCensus1950ImageSource('https://1950census.archives.gov/iiif/2/1950census%2F%ZZ.jpg/info.json')
    ).toThrow(CliValidationError);
    expect(() => resolveCensus1950ImageOutput('bad\0out.jpg', '1950census/a.jpg', '/tmp')).toThrow(
      CliValidationError
    );
    expect(() => requireJpegBytes(Buffer.from('not-jpeg'))).toThrow(RecordRuntimeError);

    const imgUrl = 'https://1950census.archives.gov/iiif/2/1950census%2Fa.jpg/full/full/0/default.jpg';
    await expect(
      census1950FetchJpeg(
        imgUrl,
        makeCapturedContext({
          fetchImpl: async () =>
            new Response(VALID_JPEG, {
              status: 200,
              headers: { 'content-type': 'image/jpeg', 'content-length': '9999' },
            }),
        }).ctx
      )
    ).rejects.toThrow('Incomplete 1950 Census JPEG download');
    await expect(
      census1950FetchJpeg(
        imgUrl,
        makeCapturedContext({
          fetchImpl: async () => {
            throw new Error('socket closed');
          },
        }).ctx
      )
    ).rejects.toThrow('socket closed');

    // Corrupt cached JPEG re-fetches cleanly
    const workDir = await makeTempDir('kinloom-c1950-img-');
    const cacheRoot = path.join(workDir, 'cache');
    const imgPath = '1950census/43290879-IL/sheet-0001.jpg';
    const { ctx: storeCtx } = makeCapturedContext({
      cwd: workDir,
      fetchImpl: async () =>
        new Response(VALID_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    });
    const first = await storeCensus1950Image(
      imgPath,
      { outPath: workDir, width: null, refresh: false, ttlHours: 24, timeoutSec: 5, cacheRoot },
      storeCtx
    );
    expect(first.cache_hit).toBe(false);

    // Run census1950 and census1950-image commands through createNaraCommand
    const nara = createNaraCommand();
    {
      const { ctx, stderr } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      expect((await nara(['census1950', 'Doe', '--name', 'Jane'], ctx)).exitCode).toBe(2);
      expect(stderr.join('\n')).toContain('Pass either a positional name or --name/--surname, not both.');
    }

    // census1950 text output + cache hit badge
    {
      const { ctx, stdout } = makeCapturedContext({
        env: { KINLOOM_NARA_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          jsonResp({
            total: 1,
            page: 1,
            size: 25,
            results: [
              {
                abbr: 'IL',
                county: 'River',
                ed: '12-3',
                scheduleId: '4',
                image: imgPath,
                names: [{ row: 7, name: 'Jane Doe' }],
              },
            ],
          }),
      });
      expect((await nara(['census1950', '--state', 'IL', '--name', 'Jane Doe'], ctx)).exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('1950 Census population schedules: 1 hit(s)');

      const { ctx: ctx2, stdout: out2 } = makeCapturedContext({ env: { KINLOOM_NARA_CACHE_DIR: cacheRoot } });
      expect((await nara(['census1950', '--state', 'IL', '--name', 'Jane Doe'], ctx2)).exitCode).toBe(0);
      expect(out2.join('\n')).toContain('1950 Census population schedules: 1 hit(s) [cache]');
    }

    // census1950-image batch text output & error mappings (503, 400, IncompleteDownload)
    {
      const img2 = '1950census/43290879-IL/sheet-0002.jpg';
      const { ctx, stdout } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_NARA_CACHE_DIR: cacheRoot },
        fetchImpl: async () =>
          new Response(VALID_JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      });
      const res = await nara(['census1950-image', imgPath, img2, '--out', path.join(workDir, 'batch')], ctx);
      expect(res.exitCode).toBe(0);
      expect(stdout.join('\n')).toContain('Cached:');
      expect(stdout.join('\n')).toContain('Downloaded:');
    }
    {
      const { ctx, stderr } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_NARA_CACHE_DIR: cacheRoot },
        fetchImpl: async () => new Response('down', { status: 503 }),
      });
      expect((await nara(['census1950-image', '1950census/43290879-IL/err503.jpg'], ctx)).exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('IIIF server returned HTTP 503');
    }
    {
      const { ctx, stderr } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_NARA_CACHE_DIR: cacheRoot },
        fetchImpl: async () => new Response('bad', { status: 400 }),
      });
      expect((await nara(['census1950-image', '1950census/43290879-IL/err400.jpg'], ctx)).exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('HTTP 400 downloading 1950 Census image');
    }
    {
      const { ctx, stderr } = makeCapturedContext({
        cwd: workDir,
        env: { KINLOOM_NARA_CACHE_DIR: cacheRoot },
        fetchImpl: async () => {
          throw new Error('truncated stream');
        },
      });
      expect((await nara(['census1950-image', '1950census/43290879-IL/errinc.jpg'], ctx)).exitCode).toBe(1);
      expect(stderr.join('\n')).toContain('1950 Census image download failed after 3 attempts');
    }
  });
});

// ============================================================================
// 3. Records runtime: image, urlPolicy, browser, cache, args, http, primitives
// ============================================================================

describe('records runtime image helpers', () => {
  it('covers channel modes, orientation swap, SVG boxes, grid steps, horizontal strip, and OCR downscaling', async () => {
    const dir = await makeTempDir('kinloom-rt-img-');

    // Grayscale (L), grayscale+alpha (LA), and RGBA modes
    const grayPath = path.join(dir, 'gray.png');
    const rawGray = Buffer.alloc(30 * 20, 100);
    await sharp(rawGray, { raw: { width: 30, height: 20, channels: 1 } })
      .toColourspace('b-w')
      .png()
      .toFile(grayPath);
    expect((await readImageInfo(grayPath)).mode).toBe('L');

    const cmykPath = path.join(dir, 'cmyk.jpg');
    await sharp({
      create: { width: 10, height: 10, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .toColourspace('cmyk')
      .jpeg()
      .toFile(cmykPath);
    expect((await readImageInfo(cmykPath)).mode).toBe('CMYK');

    const rgbaPath = path.join(dir, 'rgba.png');
    await sharp({
      create: { width: 12, height: 12, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
    })
      .png()
      .toFile(rgbaPath);
    expect((await readImageInfo(rgbaPath)).mode).toBe('RGBA');

    const baseMeta = await sharp(grayPath).metadata();
    expect(orientedDimensions({ ...baseMeta, width: 100, height: 200, orientation: 6 })).toEqual({
      width: 200,
      height: 100,
    });
    expect(orientedDimensions({ ...baseMeta, width: 100, height: 200, orientation: 1 })).toEqual({
      width: 100,
      height: 200,
    });

    // Compact JPEG fallback when budget cannot be met in 1 attempt
    const noisy = await createSyntheticPng(120, 80, { r: 40, g: 80, b: 120 });
    const compact = await encodeCompactJpegBuffer(noisy, { maxKb: 0.001, scales: [1.0], qualities: [90] });
    expect(compact.width).toBe(120);
    expect(compact.height).toBe(80);

    // Black boxes SVG & no-op applyBlackBoxes
    const svg = buildBlackBoxesSvg(100, 100, [{ x0: -5, y0: 10, x1: 50, y1: 120 }]).toString('utf8');
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect x="0" y="10" width="50" height="90" fill="#000000"/></svg>'
    );
    expect(await applyBlackBoxes(noisy, 120, 80, [])).toBe(noisy);
    expect(await applyBlackBoxes(noisy, 120, 80, [{ x0: 200, y0: 200, x1: 210, y1: 210 }])).toBe(noisy);

    // Grid steps
    expect(chooseDefaultGridStep(400, 300)).toBe(100);
    expect(chooseDefaultGridStep(1200, 800)).toBe(200);
    expect(chooseDefaultGridStep(2200, 1200)).toBe(250);
    expect(chooseDefaultGridStep(3600, 2000)).toBe(500);

    // Horizontal contact strip without labels
    const p1 = await createSyntheticPng(40, 30, { r: 200, g: 50, b: 50 });
    const p2 = await createSyntheticPng(50, 30, { r: 50, g: 200, b: 50 });
    const stripDest = path.join(dir, 'horiz.jpg');
    const strip = await buildLabeledContactStrip(
      [
        { buffer: p1, width: 40, height: 30 },
        { buffer: p2, width: 50, height: 30 },
      ],
      stripDest,
      { direction: 'horizontal', gap: 10 }
    );
    expect(strip.width).toBe(100);
    expect(strip.height).toBe(30);

    // downscaleForOcr no-op & downscaleForCursiveOcr both branches
    const smallPath = path.join(dir, 'small.png');
    fs.writeFileSync(smallPath, noisy);
    const noDownscale = await downscaleForOcr(smallPath, 500);
    expect(noDownscale.downscaled).toBe(false);
    expect(noDownscale.scale).toBe(1);

    const cursiveKeep = await downscaleForCursiveOcr(smallPath, { triggerBytes: 500_000, maxWidth: 500 });
    expect(cursiveKeep.downscaled).toBe(false);

    const cursiveShrink = await downscaleForCursiveOcr(smallPath, {
      triggerBytes: 1,
      maxWidth: 60,
      targetKb: 50,
    });
    expect(cursiveShrink.downscaled).toBe(true);
    expect(cursiveShrink.width).toBeLessThanOrEqual(60);
  });
});

describe('records runtime urlPolicy, browser, cache, args, http, and primitives', () => {
  it('enforces IPv4/IPv6 SSRF ranges, host allow rules, CookieJar fallbacks, and Retry-After', () => {
    for (const priv of [
      '0.0.0.1',
      '100.64.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '::',
      '[::1]',
      '::ffff:127.0.0.1',
      'fc00::1',
      'fe80::1%eth0',
      'ff02::1',
      '2001:db8::1',
    ]) {
      expect(isPrivateOrReservedIp(priv)).toBe(true);
    }
    expect(isPrivateOrReservedIp('93.184.216.34')).toBe(false);
    expect(isPrivateOrReservedIp('2606:2800:0220:0001:0248:1893:25c8:1946')).toBe(false);
    expect(isPrivateOrReservedIp('archive.example.test')).toBe(false);

    expect(() => assertSafeUrl('not-a-url')).toThrow(SsrfBlockedError);
    expect(
      assertSafeUrl('https://sub.archive.example.test/data', {
        allowedHosts: [/^sub\.archive\.example\.test$/],
      }).hostname
    ).toBe('sub.archive.example.test');
    expect(
      assertSafeUrl('https://archive.example.test/data', {
        allowedHosts: [(h) => h === 'archive.example.test'],
      }).hostname
    ).toBe('archive.example.test');

    const jar = new CookieJar();
    jar.set('manual', '1');
    expect(jar.get('manual')).toBe('1');
    const legacyHeaders = new Headers({ 'set-cookie': 'sid=abc; Path=/' });
    Object.defineProperty(legacyHeaders, 'getSetCookie', { value: undefined });
    jar.captureFromHeaders(legacyHeaders);
    expect(jar.get('sid')).toBe('abc');
    const badHeaders = new Headers();
    badHeaders.append('set-cookie', '; Path=/');
    badHeaders.append('set-cookie', 'noequals');
    jar.captureFromHeaders(badHeaders);
    expect(jar.toHeaderValue()).toBe('manual=1; sid=abc');

    expect(parseRetryAfterMs('   ', 1000)).toBeUndefined();
    expect(parseRetryAfterMs('invalid-date', 1000)).toBeUndefined();
  });

  it('exercises browser executable discovery, deadlines, process termination, and late-launch cleanup', async () => {
    const dir = await makeTempDir('kinloom-rt-browser-');
    const execPath = path.join(dir, 'chromium');
    const nonExecPath = path.join(dir, 'not-exec');
    fs.writeFileSync(execPath, '#!/bin/sh\n');
    fs.chmodSync(execPath, 0o755);
    fs.writeFileSync(nonExecPath, 'plain');
    fs.chmodSync(nonExecPath, 0o644);

    expect(isExecutableFile(execPath)).toBe(true);
    expect(isExecutableFile(nonExecPath)).toBe(false);
    expect(isExecutableFile(dir)).toBe(false);
    expect(isExecutableFile(path.join(dir, 'missing'))).toBe(false);

    expect(findSystemChromium({ MY_BROWSER: execPath, PATH: '' }, 'MY_BROWSER')).toBe(execPath);
    expect(findSystemChromium({ PATH: `${path.delimiter}${dir}` }, undefined, (p) => p === execPath)).toBe(
      execPath
    );

    await expect(withBrowserDeadline(Promise.resolve('late'), 0, 'step')).rejects.toThrow(
      BrowserTimeoutError
    );

    // forceTerminateBrowserProcess variants
    await forceTerminateBrowserProcess(null);
    await forceTerminateBrowserProcess({ exitCode: 0, kill: () => true });
    await forceTerminateBrowserProcess({ signalCode: 'SIGTERM', kill: () => true });
    await forceTerminateBrowserProcess({
      exitCode: null,
      kill: () => {
        throw new Error('ESRCH');
      },
    });
    const signals: (NodeJS.Signals | number | undefined)[] = [];
    const stubbornProc: OptionalBrowserProcess = {
      exitCode: null,
      signalCode: null,
      kill(sig) {
        signals.push(sig);
        return true;
      },
    };
    await forceTerminateBrowserProcess(stubbornProc, 1);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);

    // launchOptionalChromium when playwright-core cannot be loaded
    await expect(
      launchOptionalChromium({
        env: {},
        loadPlaywright: async () => {
          throw new Error('MODULE_NOT_FOUND');
        },
      })
    ).rejects.toThrow('optional `playwright-core` package');

    // launchOptionalChromium when executablePath() throws + launch timeout closes late browser
    let lateBrowserClosed = false;
    let resolveLaunch: ((b: OptionalBrowser) => void) | undefined;
    const mod: PlaywrightCoreModule = {
      chromium: {
        executablePath() {
          throw new Error('no bundled browser');
        },
        launch() {
          return new Promise<OptionalBrowser>((resolve) => {
            resolveLaunch = resolve;
          });
        },
      },
    };
    await expect(
      launchOptionalChromium({
        env: {},
        launchTimeoutMs: 10,
        loadPlaywright: async () => mod,
        isExecutable: () => false,
      })
    ).rejects.toThrow(BrowserTimeoutError);
    resolveLaunch?.({
      async newContext() {
        throw new Error('unused');
      },
      async close() {
        lateBrowserClosed = true;
      },
    });
    await new Promise((r) => setTimeout(r, 15));
    expect(lateBrowserClosed).toBe(true);

    // runWithBrowserSession: session.runStep rejects when budget exhausted
    let clock = 1000;
    const { browser } = makeFakeBrowser({ onGoto: () => {} });
    await expect(
      runWithBrowserSession(
        {
          env: {},
          totalTimeoutMs: 50,
          nowMs: () => clock,
          launcher: async () => browser,
        },
        async (session) => {
          clock = 2000;
          await session.runStep('exhausted', async () => 'never');
        }
      )
    ).rejects.toThrow(BrowserTimeoutError);
  });

  it('exercises cache edge cases, advisory lock timeout, binary cache, and CacheHitTracker', async () => {
    const dir = await makeTempDir('kinloom-rt-cache-');
    expect(expandHomePath('~', { HOME: '/home/synthetic' })).toBe('/home/synthetic');

    // readSchemaCacheEntry failure branches
    expect(
      readSchemaCacheEntry(
        dir,
        1,
        1,
        () => 1000,
        (v): v is string => typeof v === 'string'
      )
    ).toBeUndefined();
    const arrPath = path.join(dir, 'arr.json');
    fs.writeFileSync(arrPath, '[]');
    expect(
      readSchemaCacheEntry(
        arrPath,
        1,
        1,
        () => 1000,
        (v): v is string => typeof v === 'string'
      )
    ).toBeUndefined();
    const wrongSchemaPath = path.join(dir, 'schema.json');
    fs.writeFileSync(wrongSchemaPath, JSON.stringify({ schema: 2, fetched_at: 1, result: 'x' }));
    expect(
      readSchemaCacheEntry(
        wrongSchemaPath,
        1,
        1,
        () => 2000,
        (v): v is string => typeof v === 'string'
      )
    ).toBeUndefined();
    const badTimePath = path.join(dir, 'badtime.json');
    fs.writeFileSync(badTimePath, JSON.stringify({ schema: 1, fetched_at: 'bad', result: 'x' }));
    expect(
      readSchemaCacheEntry(
        badTimePath,
        1,
        1,
        () => 2000,
        (v): v is string => typeof v === 'string'
      )
    ).toBeUndefined();

    // atomicWriteFileSync failure cleans up tmp file
    const dirTarget = path.join(dir, 'existing-dir');
    fs.mkdirSync(dirTarget);
    expect(() => atomicWriteFileSync(dirTarget, 'data')).toThrow();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // readBinaryCache branches
    const binFile = path.join(dir, 'sample.bin');
    fs.writeFileSync(binFile, Buffer.from('abc'));
    expect(readBinaryCache(binFile, 0)).toEqual({ hit: false });
    expect(readBinaryCache(dir, 60_000)).toEqual({ hit: false });
    expect(readBinaryCache(path.join(dir, 'missing.bin'), 60_000)).toEqual({ hit: false });
    expect(readBinaryCache(binFile, 1000, () => fs.statSync(binFile).mtimeMs + 5000)).toEqual({ hit: false });
    const binHit = readBinaryCache(binFile, 60_000);
    expect(binHit.hit).toBe(true);

    // withAdvisoryLock timeout on live owner PID proceeds unlocked cleanly
    const lockPath = path.join(dir, 'live.lock');
    fs.writeFileSync(lockPath, `${process.pid}\n`);
    let clock = Date.now();
    const unlockedResult = await withAdvisoryLock(lockPath, async () => 'proceeded', {
      timeoutMs: 20,
      staleAfterMs: 600_000,
      nowMs: () => clock,
      sleepFn: async (ms) => {
        clock += ms + 25;
      },
    });
    expect(unlockedResult).toBe('proceeded');
    expect(fs.existsSync(lockPath)).toBe(true);

    // cachedJsonCall basic write + hit
    const cached1 = await cachedJsonCall({
      cacheDir: dir,
      kind: 'test',
      payload: { id: 1 },
      ttlHours: 24,
      refresh: false,
      fetch: async () => 'fresh-val',
      validateCached: (v): v is string => typeof v === 'string',
      sleepFn: async () => {},
    });
    expect(cached1).toEqual({ value: 'fresh-val', cacheHit: false });

    const tracker = new CacheHitTracker();
    expect(tracker.hasAny()).toBe(false);
    tracker.note(true);
    expect(tracker.hasAny()).toBe(true);
    expect(tracker.allHits()).toBe(true);
  });

  it('exercises args parser validation branches and usage formatting', () => {
    const spec: CommandParseSpec = {
      options: [
        { key: 'count', kind: 'integer', flags: ['-c', '--count'], max: 10 },
        { key: 'ratio', kind: 'number', flags: ['-r', '--ratio'], min: 0.5, max: 2.5 },
        { key: 'tag', kind: 'string', flags: ['-t', '--tag'], multiple: true },
        { key: 'flag', kind: 'boolean', flags: ['-f', '--flag'], negatable: true },
        { key: 'req', kind: 'string', flags: ['--req'], required: true },
      ],
      allowPositionals: true,
      minPositionals: 1,
      maxPositionals: 2,
      positionalLabel: 'item',
    };

    const parsed = parseCommandArgs(['--req', 'ok', '-t=a', '-t=b', '-42'], spec);
    expect(getStringListOption(parsed, 'tag')).toEqual(['a', 'b']);
    expect(getStringListOption(parsed, 'missing')).toEqual([]);
    expect(parsed.positionals).toEqual(['-42']);

    expect(() => parseCommandArgs(['--req', 'ok', '--count', '999999999999999999999', 'x'], spec)).toThrow(
      'integer out of range'
    );
    expect(() => parseCommandArgs(['--req', 'ok', '--count', '11', 'x'], spec)).toThrow('must be <= 10');
    expect(() => parseCommandArgs(['--req', 'ok', '--ratio', ' ', 'x'], spec)).toThrow(
      'requires a numeric value'
    );
    expect(() => parseCommandArgs(['--req', 'ok', '--ratio', 'NaN', 'x'], spec)).toThrow(
      'requires a finite number'
    );
    expect(() => parseCommandArgs(['--req', 'ok', '--ratio', '0.1', 'x'], spec)).toThrow('must be >= 0.5');
    expect(() => parseCommandArgs(['--req', 'ok', '--ratio', '3.0', 'x'], spec)).toThrow('must be <= 2.5');
    expect(() => parseCommandArgs(['--req', 'ok', '--flag=true', 'x'], spec)).toThrow(
      'does not accept a value'
    );
    expect(() => parseCommandArgs(['--req', 'ok', '-x=1', 'x'], spec)).toThrow("Unknown option '-x'");
    expect(() => parseCommandArgs(['--req', 'ok', '-f=1', 'x'], spec)).toThrow('does not accept a value');
    expect(() => parseCommandArgs(['--req', 'ok', '-z', 'x'], spec)).toThrow("Unknown option '-z'");
    expect(() => parseCommandArgs(['--req', 'ok', '-c'], spec)).toThrow("Option '-c' requires a value");
    expect(() => parseCommandArgs(['x'], spec)).toThrow("Missing required option '--req'");
    expect(() => parseCommandArgs(['--req', 'ok'], spec)).toThrow('Missing required item');
    expect(() => parseCommandArgs(['--req', 'ok', 'a', 'b', 'c'], spec)).toThrow('Too many arguments');
    expect(() => parseCommandArgs(['extra'], { options: [], allowPositionals: false })).toThrow(
      "Unexpected positional argument 'extra'"
    );

    const usage = formatCommandUsage({
      usage: 'kinloom sample',
      summary: 'Sample summary.',
      notes: ['Note 1: synthetic note'],
    });
    expect(usage).toContain('-h, --help  Show this help message');
    expect(usage).toContain('Note 1: synthetic note');
  });

  it('exercises http helpers, curl wrapper, defaultExecFile, and primitives', async () => {
    // httpRequest: POST with Uint8Array body, custom headers, 302 -> GET redirect, too many redirects
    const methods: string[] = [];
    let hop = 0;
    const redirRes = await httpRequest('https://archive.example.test/start', {
      method: 'POST',
      headers: { 'x-test': '1' },
      body: new Uint8Array([1, 2, 3]),
      fetchImpl: async (_url, init) => {
        methods.push(init?.method ?? 'GET');
        hop += 1;
        if (hop === 1) {
          return new Response(null, { status: 302, headers: { location: '/done' } });
        }
        return new Response('ok-text', { status: 200 });
      },
      sleepFn: async () => {},
    });
    expect(methods).toEqual(['POST', 'GET']);
    expect(redirRes.bytes.toString('utf8')).toBe('ok-text');

    // Redirect without location header stops loop
    const noLocRes = await httpRequest('https://archive.example.test/noloc', {
      throwOnHttpError: false,
      fetchImpl: async () => new Response(null, { status: 302 }),
      sleepFn: async () => {},
    });
    expect(noLocRes.status).toBe(302);

    // Too many redirects
    await expect(
      httpRequest('https://archive.example.test/loop', {
        maxAttempts: 1,
        maxRedirects: 1,
        fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/loop' } }),
        sleepFn: async () => {},
      })
    ).rejects.toThrow('Too many redirects');

    // httpGetJson error branches, httpGetText, httpGetBytes
    await expect(
      httpGetJson('https://archive.example.test/html', {
        fetchImpl: async () => new Response('<!doctype html><html>err</html>', { status: 200 }),
        sleepFn: async () => {},
      })
    ).rejects.toThrow('received an HTML page');

    await expect(
      httpGetJson('https://archive.example.test/badjson', {
        fetchImpl: async () => new Response('{oops', { status: 200 }),
        sleepFn: async () => {},
      })
    ).rejects.toThrow('Invalid JSON');

    const textRes = await httpGetText('https://archive.example.test/hello', {
      fetchImpl: async () => new Response('hello archive', { status: 200 }),
      sleepFn: async () => {},
    });
    expect(textRes.text).toBe('hello archive');

    const bytesRes = await httpGetBytes('https://archive.example.test/bin', {
      verifyContentLength: true,
      fetchImpl: async () =>
        new Response(Buffer.from('1234'), { status: 200, headers: { 'content-length': '4' } }),
      sleepFn: async () => {},
    });
    expect(bytesRes.bytes.toString('utf8')).toBe('1234');

    // defaultExecFile success and error enrichment
    const execOk = await defaultExecFile(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(execOk.stdout.toString('utf8')).toBe('hi');
    await expect(
      defaultExecFile(process.execPath, ['-e', 'process.stderr.write("fail"); process.exit(3)'])
    ).rejects.toMatchObject({ stderr: Buffer.from('fail') });

    // fetchWithCurl: header dump parsing, retry on 429 with Retry-After, custom headers, HTML rejection, ENOENT, non-retryable exit
    let curlAttempt = 0;
    const mockCurl: ExecFileFn = async (_file, args) => {
      curlAttempt += 1;
      const dIdx = args.indexOf('-D');
      const hdrPath = dIdx !== -1 ? args[dIdx + 1] : '';
      if (curlAttempt === 1) {
        if (hdrPath) {
          fs.writeFileSync(hdrPath, 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0\r\n\r\n');
        }
        return {
          stdout: Buffer.from(`rate limited\n${CURL_META_MARKER}\n429\nhttps://archive.example.test/data`),
          stderr: Buffer.alloc(0),
        };
      }
      if (hdrPath) {
        fs.writeFileSync(
          hdrPath,
          'HTTP/1.1 302 Found\r\nLocation: /final\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Custom: ok\r\n'
        );
      }
      return {
        stdout: Buffer.from(`binary-ok\n${CURL_META_MARKER}\n200\nhttps://archive.example.test/final`),
        stderr: Buffer.alloc(0),
      };
    };
    const curlOk = await fetchWithCurl('https://archive.example.test/data', {
      headers: { Accept: '*/*' },
      execFileImpl: mockCurl,
      sleepFn: async () => {},
    });
    expect(curlOk.status).toBe(200);
    expect(curlOk.headers.get('x-custom')).toBe('ok');
    expect(curlOk.bytes.toString('utf8')).toBe('binary-ok');

    // fetchWithCurl without marker & rejectHtml
    await expect(
      fetchWithCurl('https://archive.example.test/html', {
        rejectHtml: true,
        execFileImpl: async () => ({
          stdout: Buffer.from('<!doctype html><html>blocked</html>'),
          stderr: Buffer.alloc(0),
        }),
        sleepFn: async () => {},
      })
    ).rejects.toThrow('received an HTML error page');

    // fetchWithCurl HTTP 404
    await expect(
      fetchWithCurl('https://archive.example.test/missing', {
        execFileImpl: async () => ({
          stdout: Buffer.from(`not found\n${CURL_META_MARKER}\n404\nhttps://archive.example.test/missing`),
          stderr: Buffer.alloc(0),
        }),
        sleepFn: async () => {},
      })
    ).rejects.toThrow(HttpStatusError);

    // fetchWithCurl ENOENT and non-retryable exit code
    await expect(
      fetchWithCurl('https://archive.example.test/enoent', {
        execFileImpl: async () => {
          const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
          throw err;
        },
        sleepFn: async () => {},
      })
    ).rejects.toThrow('curl is required');

    await expect(
      fetchWithCurl('https://archive.example.test/exit22', {
        execFileImpl: async () => {
          const err = Object.assign(new Error('bad url'), { code: 22, stderr: Buffer.from('curl 22') });
          throw err;
        },
        sleepFn: async () => {},
      })
    ).rejects.toThrow('curl error fetching');

    // Primitives edge cases
    expect(isBrokenPipeError(null)).toBe(false);
    expect(isBrokenPipeError({ code: 'EPIPE' })).toBe(true);
    expect(isBrokenPipeError(new Error('write broken pipe'))).toBe(true);
    expect(isBrokenPipeError(new Error('other'))).toBe(false);

    const primDir = await makeTempDir('kinloom-rt-prim-');
    expect(() => atomicCopyFileSync(path.join(primDir, 'nonexistent'), path.join(primDir, 'dest'))).toThrow();
    expect(readJsonRecordIfValid(primDir)).toBeNull();
    expect(() => resolveSafeChildPath(primDir, 'a..b', { rejectDoubleDotSubstring: true })).toThrow(
      RecordRuntimeError
    );

    const { ctx: pathCtx } = makeCapturedContext({ cwd: primDir, env: { HOME: '/home/synthetic' } });
    expect(resolveUserPathFromContext('~/records/doc.pdf', pathCtx)).toBe('/home/synthetic/records/doc.pdf');
    expect(resolveUserPathFromContext('sub/doc.pdf', pathCtx)).toBe(path.join(primDir, 'sub', 'doc.pdf'));
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);

    // fetchWithTimeout abort callback with fake timers
    vi.useFakeTimers();
    let aborted = false;
    const pending = fetchWithTimeout(
      'https://archive.example.test/slow',
      {},
      1000,
      (_u, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        })
    );
    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toThrow('aborted');
    expect(aborted).toBe(true);
  });
});
