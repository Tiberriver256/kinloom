import fs from 'node:fs';
import path from 'node:path';
import { XMLValidator } from 'fast-xml-parser';
import { atomicWriteFileSync } from '../../runtime/cache.js';
import { gunzipBytes, parseXml } from '../../runtime/parse.js';
import {
  atomicWriteCompactJson,
  isPlainRecord,
  readJsonRecordIfValid,
  runWithConcurrency,
} from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { getCacheRoot, httpGetBytesIa, httpGetJsonIa, withFileLock } from './transport.js';
import {
  ArchiveNotFoundError,
  BASE,
  DEFAULT_TIMEOUT_SECONDS,
  DOWNLOAD_TIMEOUT_SECONDS,
  type ItemCacheEntry,
  type ItemFileEntry,
  type ItemMetadataPayload,
  isTruthyNonEmpty,
  MAX_WORKERS,
  type PageIndex,
  quotePathSegment,
  validateIdentifier,
  validateRelativeItemPath,
} from './types.js';

const SCANDATA_SPEC = { suffixes: ['_scandata.xml', 'scandata.xml'], formats: ['scandata'] } as const;
const DJVU_SPEC = { suffixes: ['_djvu.txt'], formats: ['djvutxt'] } as const;
const HOCR_TEXT_SPEC = { suffixes: ['_hocr_searchtext.txt.gz'], formats: ['ocr search text'] } as const;
const HOCR_IDX_SPEC = { suffixes: ['_hocr_pageindex.json.gz'], formats: ['ocr page index'] } as const;

function isRegularFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function itemDownloadUrl(itemId: string, fileName: string): string {
  return `${BASE}/download/${quotePathSegment(itemId)}/${quotePathSegment(fileName)}`;
}

async function readOrPopulateLocked<T>(
  lockPath: string,
  refresh: boolean,
  tryRead: () => T | undefined,
  populate: () => Promise<T>,
  ctx: RecordCommandContext
): Promise<T> {
  if (!refresh) {
    const cached = tryRead();
    if (cached !== undefined) {
      return cached;
    }
  }
  return withFileLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = tryRead();
        if (cached !== undefined) {
          return cached;
        }
      }
      return populate();
    },
    ctx
  );
}

function isValidMetadata(data: unknown): data is ItemMetadataPayload {
  return isPlainRecord(data) && (isTruthyNonEmpty(data.metadata) || isTruthyNonEmpty(data.files));
}

async function loadOrFetchMetadataUnlocked(
  itemId: string,
  metaPath: string,
  ctx: RecordCommandContext,
  options: { readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [ItemMetadataPayload, boolean]> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (!options.refresh) {
    const cached = readJsonRecordIfValid(metaPath);
    if (isValidMetadata(cached)) {
      return [cached, true];
    }
  }
  const url = `${BASE}/metadata/${quotePathSegment(itemId)}`;
  const data = await httpGetJsonIa(url, ctx, { timeout });
  if (!isValidMetadata(data)) {
    throw new ArchiveNotFoundError(`No item with identifier ${itemId}`);
  }
  atomicWriteCompactJson(metaPath, data);
  return [data, false];
}

export async function ensureItemMetadata(
  identifier: string,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [ItemMetadataPayload, boolean]> {
  const itemId = validateIdentifier(identifier);
  const itemDir = path.join(options.cacheRoot ?? getCacheRoot(ctx), itemId);
  const metaPath = path.join(itemDir, 'metadata.json');
  return readOrPopulateLocked<readonly [ItemMetadataPayload, boolean]>(
    path.join(itemDir, '.lock'),
    options.refresh ?? false,
    () => {
      const cached = readJsonRecordIfValid(metaPath);
      return isValidMetadata(cached) ? [cached, true] : undefined;
    },
    () => loadOrFetchMetadataUnlocked(itemId, metaPath, ctx, options),
    ctx
  );
}

export function getMetadataFiles(meta: ItemMetadataPayload): readonly ItemFileEntry[] {
  return Array.isArray(meta.files)
    ? meta.files.filter((entry): entry is ItemFileEntry => isPlainRecord(entry))
    : [];
}

export function findItemFile(
  files: readonly ItemFileEntry[],
  options: { readonly suffixes: readonly string[]; readonly formats?: readonly string[] }
): string | undefined {
  const lowerSuffixes = options.suffixes.map((s) => s.toLowerCase());
  for (const entry of files) {
    const name = typeof entry.name === 'string' ? entry.name : '';
    const lowerName = name.toLowerCase();
    if (name && lowerSuffixes.some((suf) => lowerName.endsWith(suf))) {
      return name;
    }
  }
  if (options.formats && options.formats.length > 0) {
    const fmtSet = new Set(options.formats.map((f) => f.toLowerCase()));
    for (const entry of files) {
      const fmt = typeof entry.format === 'string' ? entry.format.toLowerCase() : '';
      const name = typeof entry.name === 'string' ? entry.name : '';
      if (name && fmtSet.has(fmt)) {
        return name;
      }
    }
  }
  return undefined;
}

function extractXmlText(node: unknown): string {
  if (node === null || node === undefined) {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    return String(node);
  }
  if (isPlainRecord(node) && '#text' in node) {
    return extractXmlText(node['#text']);
  }
  return '';
}

function findPageDataNode(node: unknown): unknown {
  if (!node || typeof node !== 'object') {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPageDataNode(item);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (Object.hasOwn(record, 'pageData')) {
    return record.pageData;
  }
  for (const value of Object.values(record)) {
    const found = findPageDataNode(value);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

export function parseScandataXml(xmlBytes: Uint8Array): PageIndex {
  const xmlText = Buffer.from(xmlBytes).toString('utf8');
  if (XMLValidator.validate(xmlText) !== true) {
    throw new Error('Invalid scandata.xml XML payload.');
  }
  const pageDataNode = findPageDataNode(parseXml<unknown>(xmlText));
  if (pageDataNode === undefined) {
    throw new Error('scandata.xml is missing <pageData>.');
  }

  let rawPages: unknown[] = [];
  if (isPlainRecord(pageDataNode) && Object.hasOwn(pageDataNode, 'page')) {
    const pageField = pageDataNode.page;
    rawPages = Array.isArray(pageField) ? pageField : pageField ? [pageField] : [];
  }

  const scandataToBookreader: Record<string, number> = {};
  const bookreaderToScandata: Record<string, number> = {};
  const scandataToPrinted: Record<string, string> = {};
  const bookreaderToPrinted: Record<string, string> = {};
  const printedToBookreader: Record<string, number> = {};
  const printedToBookreaderCi: Record<string, number> = {};
  const printedToScandata: Record<string, number> = {};

  let accessIdx = 0;
  for (let seqIdx = 0; seqIdx < rawPages.length; seqIdx += 1) {
    const rawPage = rawPages[seqIdx];
    const pageEl = isPlainRecord(rawPage) ? rawPage : {};
    const rawLeaf = pageEl['@_leafNum'];
    const leafNum =
      typeof rawLeaf === 'string' && /^[+-]?\d+$/.test(rawLeaf.trim())
        ? Number.parseInt(rawLeaf.trim(), 10)
        : seqIdx;

    const pageType = extractXmlText(pageEl.pageType).trim();
    const inAccess =
      Object.hasOwn(pageEl, 'addToAccessFormats') && pageEl.addToAccessFormats !== undefined
        ? extractXmlText(pageEl.addToAccessFormats).trim().toLowerCase() === 'true'
        : pageType.toLowerCase() !== 'delete';

    const printed = extractXmlText(pageEl.pageNumber).trim();
    const leafKey = String(leafNum);
    if (printed) {
      scandataToPrinted[leafKey] = printed;
      if (!Object.hasOwn(printedToScandata, printed)) {
        printedToScandata[printed] = leafNum;
      }
    }

    if (inAccess) {
      const brN = accessIdx;
      accessIdx += 1;
      scandataToBookreader[leafKey] = brN;
      bookreaderToScandata[String(brN)] = leafNum;
      if (printed) {
        bookreaderToPrinted[String(brN)] = printed;
        if (!Object.hasOwn(printedToBookreader, printed)) {
          printedToBookreader[printed] = brN;
        }
        const printedLower = printed.toLowerCase();
        if (!Object.hasOwn(printedToBookreaderCi, printedLower)) {
          printedToBookreaderCi[printedLower] = brN;
        }
      }
    }
  }

  return {
    leaf_count: rawPages.length,
    access_leaf_count: accessIdx,
    scandata_to_bookreader: scandataToBookreader,
    bookreader_to_scandata: bookreaderToScandata,
    scandata_to_printed: scandataToPrinted,
    bookreader_to_printed: bookreaderToPrinted,
    printed_to_bookreader: printedToBookreader,
    printed_to_bookreader_ci: printedToBookreaderCi,
    printed_to_scandata: printedToScandata,
    segment_mode: 'scandata',
  };
}

export function emptyPageIndex(): PageIndex {
  return {
    leaf_count: 0,
    access_leaf_count: 0,
    scandata_to_bookreader: {},
    bookreader_to_scandata: {},
    scandata_to_printed: {},
    bookreader_to_printed: {},
    printed_to_bookreader: {},
    printed_to_bookreader_ci: {},
    printed_to_scandata: {},
    segment_mode: 'bookreader',
  };
}

function maybeGunzip(raw: Uint8Array): Buffer {
  return raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b ? gunzipBytes(raw) : Buffer.from(raw);
}

export function synthesizeDjvuFromHocr(searchtextGz: Uint8Array, pageindexGz: Uint8Array): string {
  const text = maybeGunzip(searchtextGz).toString('utf8');
  const offsets: unknown = JSON.parse(maybeGunzip(pageindexGz).toString('utf8'));
  if (!Array.isArray(offsets) || offsets.length === 0) {
    return text;
  }
  const segments: string[] = [];
  const textLen = text.length;
  for (const row of offsets) {
    if (Array.isArray(row) && row.length >= 2) {
      const rawStart = Number(row[0]);
      const rawEnd = Number(row[1]);
      if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
        throw new Error('Invalid hOCR page index offset.');
      }
      const start = Math.max(0, Math.min(Math.trunc(rawStart), textLen));
      const end = Math.max(start, Math.min(Math.trunc(rawEnd), textLen));
      segments.push(text.slice(start, end).replaceAll('\x0c', ' '));
    } else {
      segments.push('');
    }
  }
  return segments.join('\x0c');
}

async function fetchUrlsMap(
  tasks: Readonly<Record<string, string>>,
  ctx: RecordCommandContext,
  timeoutSeconds: number
): Promise<{ readonly fetched: Record<string, Buffer>; readonly errors: Record<string, Error> }> {
  const entries = Object.entries(tasks);
  const fetched: Record<string, Buffer> = {};
  const errors: Record<string, Error> = {};
  if (entries.length === 0) {
    return { fetched, errors };
  }
  await runWithConcurrency(entries, MAX_WORKERS, async ([key, url]) => {
    try {
      fetched[key] = await httpGetBytesIa(url, ctx, timeoutSeconds);
    } catch (err: unknown) {
      errors[key] = err instanceof Error ? err : new Error(String(err));
    }
  });
  return { fetched, errors };
}

export function readPageIndex(filePath: string): PageIndex | undefined {
  const parsed = readJsonRecordIfValid(filePath);
  return parsed ? (parsed as unknown as PageIndex) : undefined;
}

export async function ensureItemCache(
  identifier: string,
  ctx: RecordCommandContext,
  options: {
    readonly needDjvu: boolean;
    readonly cacheRoot?: string;
    readonly timeout?: number;
    readonly refresh?: boolean;
  }
): Promise<ItemCacheEntry> {
  const itemId = validateIdentifier(identifier);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const refresh = options.refresh ?? false;
  const itemDir = path.join(options.cacheRoot ?? getCacheRoot(ctx), itemId);
  const metaPath = path.join(itemDir, 'metadata.json');
  const scandataPath = path.join(itemDir, 'scandata.xml');
  const pageIndexPath = path.join(itemDir, 'page_index.json');
  const djvuPath = path.join(itemDir, 'djvu.txt');

  const buildEntry = (cached: boolean): ItemCacheEntry => ({
    identifier: itemId,
    itemDir,
    metadataPath: metaPath,
    scandataPath,
    pageIndexPath,
    djvuPath,
    cached,
  });

  const tryReadReady = (): ItemCacheEntry | undefined =>
    isValidMetadata(readJsonRecordIfValid(metaPath)) &&
    readJsonRecordIfValid(pageIndexPath) !== null &&
    (!options.needDjvu || isRegularFile(djvuPath))
      ? buildEntry(true)
      : undefined;

  return readOrPopulateLocked(
    path.join(itemDir, '.lock'),
    refresh,
    tryReadReady,
    async () => {
      const [metaData] = await loadOrFetchMetadataUnlocked(itemId, metaPath, ctx, { timeout, refresh });
      const existingPageIndex = refresh ? undefined : readPageIndex(pageIndexPath);
      const hasPageIndex = existingPageIndex !== undefined;
      const hasDjvu = !refresh && isRegularFile(djvuPath);

      const files = getMetadataFiles(metaData);
      const scandataName = findItemFile(files, SCANDATA_SPEC);
      const djvuName = findItemFile(files, DJVU_SPEC);
      const hocrTextName = findItemFile(files, HOCR_TEXT_SPEC);
      const hocrIdxName = findItemFile(files, HOCR_IDX_SPEC);

      const stage1Tasks: Record<string, string> = {};
      if (!hasPageIndex && scandataName && (refresh || !isRegularFile(scandataPath))) {
        stage1Tasks.scandata = itemDownloadUrl(itemId, scandataName);
      }
      if (options.needDjvu && !hasDjvu) {
        if (djvuName) {
          stage1Tasks.djvu = itemDownloadUrl(itemId, djvuName);
        } else if (hocrTextName && hocrIdxName) {
          stage1Tasks.hocr_text = itemDownloadUrl(itemId, hocrTextName);
          stage1Tasks.hocr_idx = itemDownloadUrl(itemId, hocrIdxName);
        }
      }

      const { fetched, errors: fetchErrors } = await fetchUrlsMap(stage1Tasks, ctx, timeout);

      let pageIndex: PageIndex;
      if (hasPageIndex && existingPageIndex) {
        pageIndex = existingPageIndex;
      } else {
        const scandataBytes =
          fetched.scandata ??
          (!refresh && isRegularFile(scandataPath) ? fs.readFileSync(scandataPath) : undefined);
        if (scandataBytes !== undefined) {
          try {
            pageIndex = parseScandataXml(scandataBytes);
            atomicWriteFileSync(scandataPath, scandataBytes);
          } catch {
            pageIndex = emptyPageIndex();
          }
        } else {
          pageIndex = emptyPageIndex();
        }
      }

      if (options.needDjvu && !hasDjvu) {
        const djvuRaw = fetched.djvu;
        const decodedDjvu = djvuRaw?.toString('utf8');
        const hasFormFeeds = decodedDjvu?.includes('\x0c');

        if (!hasFormFeeds && hocrTextName && hocrIdxName) {
          const hocrTasks: Record<string, string> = {};
          if (!Object.hasOwn(fetched, 'hocr_text')) {
            hocrTasks.hocr_text = itemDownloadUrl(itemId, hocrTextName);
          }
          if (!Object.hasOwn(fetched, 'hocr_idx')) {
            hocrTasks.hocr_idx = itemDownloadUrl(itemId, hocrIdxName);
          }
          if (Object.keys(hocrTasks).length > 0) {
            const hocrRes = await fetchUrlsMap(hocrTasks, ctx, timeout);
            Object.assign(fetched, hocrRes.fetched);
            Object.assign(fetchErrors, hocrRes.errors);
          }
        }

        let djvuBytesOut: Buffer | undefined;
        let djvuSource: string | undefined;
        let segmentMode = pageIndex.segment_mode || 'scandata';

        if (hasFormFeeds && djvuRaw !== undefined && decodedDjvu !== undefined) {
          djvuBytesOut = djvuRaw;
          djvuSource = 'djvu_txt';
          const segCount = decodedDjvu.split('\x0c').length;
          const accessCount = Number(pageIndex.access_leaf_count || 0);
          const leafCount = Number(pageIndex.leaf_count || 0);
          segmentMode =
            accessCount > 0 && Math.abs(segCount - accessCount) < Math.abs(segCount - leafCount)
              ? 'bookreader'
              : 'scandata';
        } else if (fetched.hocr_text !== undefined && fetched.hocr_idx !== undefined) {
          try {
            djvuBytesOut = Buffer.from(synthesizeDjvuFromHocr(fetched.hocr_text, fetched.hocr_idx), 'utf8');
            djvuSource = 'hocr';
            segmentMode = 'scandata';
          } catch (err: unknown) {
            fetchErrors.hocr = err instanceof Error ? err : new Error(String(err));
          }
        }

        if (djvuBytesOut === undefined && djvuRaw !== undefined) {
          djvuBytesOut = djvuRaw;
          djvuSource = 'djvu_txt';
          segmentMode = 'flat';
        }

        if (djvuBytesOut === undefined) {
          const errDetail = Object.entries(fetchErrors)
            .map(([k, v]) => `${k}: ${v.message}`)
            .join('; ');
          throw new RecordRuntimeError(
            `Item ${itemId} has no downloadable OCR text (_djvu.txt or _hocr_searchtext.txt.gz)${errDetail ? ` (${errDetail})` : ''}`
          );
        }

        pageIndex.segment_mode = segmentMode;
        if (djvuSource !== undefined) {
          pageIndex.djvu_source = djvuSource;
        }
        atomicWriteFileSync(djvuPath, djvuBytesOut);
        atomicWriteCompactJson(pageIndexPath, pageIndex);
      } else if (!hasPageIndex) {
        atomicWriteCompactJson(pageIndexPath, pageIndex);
      }

      return buildEntry(false);
    },
    ctx
  );
}

export function reuseExistingItemArtifact(
  itemDir: string,
  fileName: string,
  fileList: readonly ItemFileEntry[],
  fileEntry: ItemFileEntry
): Buffer | undefined {
  const scandataName = findItemFile(fileList, SCANDATA_SPEC);
  const scandataPath = path.join(itemDir, 'scandata.xml');
  if (scandataName && fileName === scandataName && isRegularFile(scandataPath)) {
    return fs.readFileSync(scandataPath);
  }

  const djvuName = findItemFile(fileList, DJVU_SPEC);
  const djvuPath = path.join(itemDir, 'djvu.txt');
  if (djvuName && fileName === djvuName && isRegularFile(djvuPath)) {
    const pageIndex = readJsonRecordIfValid(path.join(itemDir, 'page_index.json')) ?? {};
    const djvuSource = pageIndex.djvu_source;
    if (djvuSource === 'djvu_txt') {
      return fs.readFileSync(djvuPath);
    }
    if (djvuSource === undefined || djvuSource === null) {
      const rawSize = fileEntry.size;
      if (rawSize !== undefined && rawSize !== null) {
        const expectedSize = Number.parseInt(String(rawSize), 10);
        try {
          if (Number.isFinite(expectedSize) && fs.statSync(djvuPath).size === expectedSize) {
            return fs.readFileSync(djvuPath);
          }
        } catch {
          // Ignore stat error.
        }
      } else if (!findItemFile(fileList, HOCR_TEXT_SPEC)) {
        return fs.readFileSync(djvuPath);
      }
    }
  }
  return undefined;
}

export async function ensureDownloadedFile(
  identifier: string,
  fileName: string,
  fileList: readonly ItemFileEntry[],
  fileEntry: ItemFileEntry,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [Buffer, string, boolean]> {
  const itemId = validateIdentifier(identifier);
  const timeout = options.timeout ?? DOWNLOAD_TIMEOUT_SECONDS;
  const itemDir = path.join(options.cacheRoot ?? getCacheRoot(ctx), itemId);
  const [, cachePath] = validateRelativeItemPath(fileName, path.join(itemDir, 'files'));

  return readOrPopulateLocked<readonly [Buffer, string, boolean]>(
    path.join(itemDir, '.lock'),
    options.refresh ?? false,
    () => {
      if (isRegularFile(cachePath)) {
        return [fs.readFileSync(cachePath), cachePath, true];
      }
      const reused = reuseExistingItemArtifact(itemDir, fileName, fileList, fileEntry);
      return reused !== undefined ? [reused, itemDir, true] : undefined;
    },
    async () => {
      const content = await httpGetBytesIa(itemDownloadUrl(itemId, fileName), ctx, timeout);
      atomicWriteFileSync(cachePath, content);
      return [content, cachePath, false];
    },
    ctx
  );
}

export async function ensurePageImageCache(
  identifier: string,
  leafN: number,
  suffixTag: string,
  url: string,
  ctx: RecordCommandContext,
  options: { readonly cacheRoot?: string; readonly timeout?: number; readonly refresh?: boolean } = {}
): Promise<readonly [Buffer, string, boolean]> {
  const itemId = validateIdentifier(identifier);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const itemDir = path.join(options.cacheRoot ?? getCacheRoot(ctx), itemId);
  const pageCachePath = path.join(itemDir, 'pages', `n${leafN}_${suffixTag}.jpg`);
  const pageLock = path.join(path.dirname(pageCachePath), `.${path.basename(pageCachePath)}.lock`);

  return readOrPopulateLocked<readonly [Buffer, string, boolean]>(
    pageLock,
    options.refresh ?? false,
    () => {
      try {
        const stat = fs.statSync(pageCachePath);
        if (stat.isFile() && stat.size > 0) {
          return [fs.readFileSync(pageCachePath), pageCachePath, true];
        }
      } catch {
        // Not cached.
      }
      return undefined;
    },
    async () => {
      const content = await httpGetBytesIa(url, ctx, timeout);
      atomicWriteFileSync(pageCachePath, content);
      return [content, pageCachePath, false];
    },
    ctx
  );
}
