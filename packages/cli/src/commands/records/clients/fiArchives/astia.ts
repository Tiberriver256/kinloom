import fs from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { CliValidationError } from '../../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  parseCommandArgs,
} from '../../runtime/args.js';
import {
  atomicWriteFileSync,
  cachedJsonCall,
  readBinaryCache,
  sha256Hex,
  ttlHoursToMs,
  withAdvisoryLock,
} from '../../runtime/cache.js';
import {
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  resolveUserPathFromContext,
} from '../../runtime/primitives.js';
import {
  emitJsonStdout,
  emitStdout,
  type RecordCommandContext,
  type RecordCommandOutcome,
  RecordRuntimeError,
} from '../../runtime/types.js';
import { ASTIA_OPTIONS, ASTIA_SPEC } from './cliSpecs.js';
import { getCacheDir, resolveTtlHours, SAFE_ARCHIVE_ID_RE, validateFiUrl } from './domain.js';
import { checkNotChallenged, requestWithRetry } from './transport.js';

export const ASTIA_ORIGIN = 'https://astia.narc.fi';
export const ASTIA_IIIF_MANIFEST_BASE = `${ASTIA_ORIGIN}/uusiastia/digitized/iiif`;
export const ALLOWED_ASTIA_HOSTS = ['astia.narc.fi'] as const;

const PNG_PREFIX = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const PDF_PREFIX = Buffer.from('%PDF');
const TIFF_LE_PREFIX = new Uint8Array([0x49, 0x49, 0x2a, 0x00]);
const TIFF_BE_PREFIX = new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]);
const JP2_BOX_PREFIX = new Uint8Array([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50]);

export interface AstiaScanItem {
  readonly index: number;
  readonly label: string;
  readonly file_id: string | null;
  readonly image_url: string;
  readonly thumbnail_url: string | null;
}

export interface AstiaFolderListing {
  readonly folder_id: string;
  readonly title: string;
  readonly source_url: string;
  readonly scans: readonly AstiaScanItem[];
}

export function parseAstiaFolderRef(raw: string): {
  readonly folderId: string;
  readonly manifestUrl: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new CliValidationError('Provide an Astia folder/archive ID or https://astia.narc.fi/... URL.');
  }
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const validated = validateFiUrl(trimmed, ALLOWED_ASTIA_HOSTS);
    const parsed = new URL(validated);
    const fromQuery =
      parsed.searchParams.get('aineistoId') ??
      parsed.searchParams.get('id') ??
      parsed.searchParams.get('fileId');
    if (fromQuery && SAFE_ARCHIVE_ID_RE.test(fromQuery)) {
      const isDirectManifest = parsed.pathname.includes('/iiif/') || parsed.pathname.endsWith('.json');
      return {
        folderId: fromQuery,
        manifestUrl: isDirectManifest ? validated : `${ASTIA_IIIF_MANIFEST_BASE}/${fromQuery}/manifest`,
      };
    }
    const segs = parsed.pathname.split('/').filter((s) => s.length > 0);
    const idSeg = segs.find((s) => /^\d{4,}$/.test(s)) ?? segs[segs.length - 1] ?? '';
    if (!SAFE_ARCHIVE_ID_RE.test(idSeg)) {
      throw new CliValidationError(`Could not extract Astia folder ID from '${raw}'.`);
    }
    return { folderId: idSeg, manifestUrl: validated };
  }
  if (!SAFE_ARCHIVE_ID_RE.test(trimmed)) {
    throw new CliValidationError(`Invalid Astia folder ID '${raw}'.`);
  }
  return {
    folderId: trimmed,
    manifestUrl: `${ASTIA_IIIF_MANIFEST_BASE}/${trimmed}/manifest`,
  };
}

export function parseAstiaPageSpec(raw: string, total: number): number[] {
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned === 'all') {
    return Array.from({ length: total }, (_, idx) => idx + 1);
  }
  const pages = new Set<number>();
  for (const part of cleaned.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const range = /^(\d+)-(\d+)$/.exec(seg);
    if (range) {
      const start = Number.parseInt(range[1] as string, 10);
      const end = Number.parseInt(range[2] as string, 10);
      if (start < 1 || end < start || end > total) {
        throw new CliValidationError(`Page range '${seg}' is outside 1..${total}.`);
      }
      for (let p = start; p <= end; p += 1) {
        pages.add(p);
      }
      continue;
    }
    if (/^\d+$/.test(seg)) {
      const p = Number.parseInt(seg, 10);
      if (p < 1 || p > total) {
        throw new CliValidationError(`Page ${p} is outside 1..${total}.`);
      }
      pages.add(p);
      continue;
    }
    throw new CliValidationError(`Invalid --pages segment '${seg}'; expected e.g. '1-5,10' or 'all'.`);
  }
  return [...pages].sort((a, b) => a - b);
}

function extractLabel(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (isPlainRecord(value)) {
    for (const v of Object.values(value)) {
      if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim()) {
        return v[0].trim();
      }
    }
  }
  return fallback;
}

export function parseAstiaFolderJson(raw: unknown, folderId: string, sourceUrl: string): AstiaFolderListing {
  if (!isPlainRecord(raw)) {
    throw new RecordRuntimeError('Unexpected non-object JSON payload from Astia.');
  }
  const title = extractLabel(raw['label'] ?? raw['title'], `Astia ${folderId}`);
  const scans: AstiaScanItem[] = [];

  const sequences = Array.isArray(raw['sequences']) ? raw['sequences'] : [];
  const firstSeq = isPlainRecord(sequences[0]) ? sequences[0] : undefined;
  const canvases = firstSeq && Array.isArray(firstSeq['canvases']) ? firstSeq['canvases'] : [];
  for (const canvas of canvases) {
    if (!isPlainRecord(canvas)) continue;
    const images = Array.isArray(canvas['images']) ? canvas['images'] : [];
    const firstImg = isPlainRecord(images[0]) ? images[0] : undefined;
    const resource = firstImg && isPlainRecord(firstImg['resource']) ? firstImg['resource'] : undefined;
    const imgUrl =
      (resource && typeof resource['@id'] === 'string' ? resource['@id'] : undefined) ??
      (resource && typeof resource['id'] === 'string' ? resource['id'] : undefined);
    if (!imgUrl) continue;
    const thumbObj = isPlainRecord(canvas['thumbnail']) ? canvas['thumbnail'] : undefined;
    const thumbUrl =
      typeof canvas['thumbnail'] === 'string'
        ? canvas['thumbnail']
        : thumbObj && typeof thumbObj['@id'] === 'string'
          ? thumbObj['@id']
          : null;
    scans.push({
      index: scans.length + 1,
      label: extractLabel(canvas['label'], `Page ${scans.length + 1}`),
      file_id: typeof canvas['@id'] === 'string' ? canvas['@id'] : null,
      image_url: imgUrl,
      thumbnail_url: thumbUrl,
    });
  }

  const listCandidate = Array.isArray(raw['items'])
    ? raw['items']
    : Array.isArray(raw['scans'])
      ? raw['scans']
      : Array.isArray(raw['files'])
        ? raw['files']
        : [];

  if (scans.length === 0) {
    for (const item of listCandidate) {
      if (!isPlainRecord(item)) continue;
      let imgUrl: string | undefined =
        (typeof item['image_url'] === 'string' ? item['image_url'] : undefined) ??
        (typeof item['url'] === 'string' ? item['url'] : undefined);
      if (!imgUrl && Array.isArray(item['items'])) {
        const page = isPlainRecord(item['items'][0]) ? item['items'][0] : undefined;
        const anno =
          page && Array.isArray(page['items']) && isPlainRecord(page['items'][0])
            ? page['items'][0]
            : undefined;
        const body = anno && isPlainRecord(anno['body']) ? anno['body'] : undefined;
        if (body && typeof body['id'] === 'string') {
          imgUrl = body['id'];
        }
      }
      if (!imgUrl) continue;
      scans.push({
        index: scans.length + 1,
        label: extractLabel(item['label'] ?? item['name'], `Page ${scans.length + 1}`),
        file_id:
          typeof item['file_id'] === 'string'
            ? item['file_id']
            : typeof item['id'] === 'string'
              ? item['id']
              : null,
        image_url: imgUrl,
        thumbnail_url: typeof item['thumbnail_url'] === 'string' ? item['thumbnail_url'] : null,
      });
    }
  }

  return { folder_id: folderId, title, source_url: sourceUrl, scans };
}

export function parseAstiaFolderHtml(html: string, folderId: string, sourceUrl: string): AstiaFolderListing {
  const $ = cheerio.load(html);
  const title = $('h1, title').first().text().replace(/\s+/g, ' ').trim() || `Astia ${folderId}`;
  const scans: AstiaScanItem[] = [];
  const seen = new Set<string>();

  for (const el of $('a[href], img[src]').toArray()) {
    const rawHref = $(el).attr('href') ?? $(el).attr('src') ?? '';
    if (!/\.(?:jpe?g|png|tif|tiff|jp2|pdf)(?:[?#]|$)|\/iiif\/|fileId=/i.test(rawHref)) {
      continue;
    }
    const absUrl = new URL(rawHref, ASTIA_ORIGIN).toString();
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    const label =
      $(el).attr('title')?.trim() ||
      $(el).attr('alt')?.trim() ||
      $(el).text().replace(/\s+/g, ' ').trim() ||
      `Page ${scans.length + 1}`;
    const parsed = new URL(absUrl);
    scans.push({
      index: scans.length + 1,
      label,
      file_id: parsed.searchParams.get('fileId'),
      image_url: absUrl,
      thumbnail_url: null,
    });
  }

  return { folder_id: folderId, title, source_url: sourceUrl, scans };
}

export function classifyAstiaImageExtension(bytes: Buffer, contentType: string): string {
  if (bytes.length === 0) {
    throw new RecordRuntimeError('Astia scan download returned an empty body.');
  }
  const media = (contentType.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (media === 'text/html' || media === 'application/xhtml+xml' || looksLikeHtmlBuffer(bytes, 512)) {
    throw new RecordRuntimeError('Astia returned HTML instead of a scan image; the response was not cached.');
  }
  if (hasMagicPrefix(bytes, JPEG_MAGIC)) return 'jpg';
  if (hasMagicPrefix(bytes, PNG_PREFIX)) return 'png';
  if (hasMagicPrefix(bytes, PDF_PREFIX)) return 'pdf';
  if (hasMagicPrefix(bytes, TIFF_LE_PREFIX) || hasMagicPrefix(bytes, TIFF_BE_PREFIX)) return 'tif';
  if (hasMagicPrefix(bytes, JP2_BOX_PREFIX)) return 'jp2';
  throw new RecordRuntimeError(
    `Astia scan response was not a recognized image or PDF (${media || 'unknown'}).`
  );
}

function isAstiaFolderListing(value: unknown): value is AstiaFolderListing {
  return isPlainRecord(value) && Array.isArray(value['scans']) && typeof value['folder_id'] === 'string';
}

async function fetchCachedAstiaFolder(
  ctx: RecordCommandContext,
  folderId: string,
  manifestUrl: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly value: AstiaFolderListing; readonly cacheHit: boolean }> {
  return cachedJsonCall<AstiaFolderListing>({
    cacheDir: path.join(getCacheDir(ctx), 'astia'),
    kind: 'astia_folder',
    payload: { folder_id: folderId, manifest_url: manifestUrl },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url: manifestUrl,
        allowedHosts: ALLOWED_ASTIA_HOSTS,
        label: 'Astia folder',
        headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.1' },
      });
      const text = resp.bytes.toString('utf8');
      checkNotChallenged(resp.headers, text, 'Astia folder');
      const ct = (resp.headers.get('content-type') ?? '').toLowerCase();
      if (ct.includes('json') || text.trimStart().startsWith('{')) {
        return parseAstiaFolderJson(JSON.parse(text), folderId, manifestUrl);
      }
      return parseAstiaFolderHtml(text, folderId, manifestUrl);
    },
    cacheable: (r) => r.scans.length > 0,
    validateCached: isAstiaFolderListing,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
}

async function fetchCachedAstiaScan(
  ctx: RecordCommandContext,
  imageUrl: string,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly bytes: Buffer; readonly ext: string; readonly cacheHit: boolean }> {
  validateFiUrl(imageUrl, ALLOWED_ASTIA_HOSTS);
  const digest = sha256Hex(imageUrl);
  const scanCacheDir = path.join(getCacheDir(ctx), 'astia', 'scans');
  const binPath = path.join(scanCacheDir, `${digest}.bin`);
  const lockPath = path.join(scanCacheDir, `${digest}.lock`);
  const ttlMs = ttlHoursToMs(ttlHours);

  return withAdvisoryLock(
    lockPath,
    async () => {
      if (!refresh) {
        const cached = readBinaryCache(binPath, ttlMs, ctx.nowMs);
        if (cached.hit) {
          const ext = classifyAstiaImageExtension(cached.value, 'application/octet-stream');
          return { bytes: cached.value, ext, cacheHit: true };
        }
      }
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url: imageUrl,
        allowedHosts: ALLOWED_ASTIA_HOSTS,
        label: 'Astia scan',
        headers: { Accept: 'image/*,application/pdf;q=0.9,*/*;q=0.1' },
      });
      const ext = classifyAstiaImageExtension(resp.bytes, resp.headers.get('content-type') ?? '');
      atomicWriteFileSync(binPath, resp.bytes);
      return { bytes: resp.bytes, ext, cacheHit: false };
    },
    { nowMs: ctx.nowMs, sleepFn: ctx.sleepFn }
  );
}

export async function runAstia(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ASTIA_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives astia <folder-id-or-url> [options]',
          summary: 'List National Archives of Finland (Astia) folder scans and download cached scan images.',
          options: ASTIA_OPTIONS,
          notes: [
            'Examples:',
            '  kinloom fi-archives astia 1299923671 --list --json',
            '  kinloom fi-archives astia 1299923671 --pages 1-3 --out-dir ./astia-scans --json',
          ],
        })
      ),
    };
  }

  const ref = parsed.positionals[0] as string;
  const { folderId, manifestUrl } = parseAstiaFolderRef(ref);
  const outDirOpt = getStringOption(parsed, 'outDir');
  const listOnly = getBooleanOption(parsed, 'listOnly') || !outDirOpt;
  const pagesSpec = getStringOption(parsed, 'pages') ?? 'all';
  const limit = getNumberOption(parsed, 'limit');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  const { value: folder, cacheHit: folderHit } = await fetchCachedAstiaFolder(
    ctx,
    folderId,
    manifestUrl,
    refresh,
    ttlHours
  );

  if (listOnly) {
    const shown = limit !== undefined ? folder.scans.slice(0, Math.max(1, limit)) : folder.scans;
    if (asJson) {
      const bytesOut = emitJsonStdout(ctx.io, {
        folder_id: folder.folder_id,
        title: folder.title,
        source_url: folder.source_url,
        total_scans: folder.scans.length,
        returned: shown.length,
        scans: shown,
        cache_hit: folderHit,
      });
      return { exitCode: 0, bytesOut, cacheHit: folderHit };
    }
    const marker = folderHit ? ' [cache]' : '';
    const lines = [
      `Astia ${folder.folder_id}: ${folder.title} (${folder.scans.length} scan(s))${marker}`,
      `Source: ${folder.source_url}`,
    ];
    for (const scan of shown) {
      lines.push(`${scan.index}. ${scan.label}`);
      lines.push(`   ${scan.image_url}`);
    }
    return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: folderHit };
  }

  if (folder.scans.length === 0) {
    throw new RecordRuntimeError(`No digitized scans found in Astia folder ${folder.folder_id}.`);
  }

  const selectedIndices = parseAstiaPageSpec(pagesSpec, folder.scans.length);
  const selectedScans = selectedIndices.map((idx) => folder.scans[idx - 1] as AstiaScanItem);

  const destDir = resolveUserPathFromContext(outDirOpt as string, ctx);
  fs.mkdirSync(destDir, { recursive: true });

  const downloaded: Array<{
    readonly index: number;
    readonly label: string;
    readonly url: string;
    readonly path: string;
    readonly bytes: number;
    readonly cache_hit: boolean;
  }> = [];

  for (const scan of selectedScans) {
    const { bytes, ext, cacheHit } = await fetchCachedAstiaScan(ctx, scan.image_url, refresh, ttlHours);
    const filename = `astia-${folder.folder_id}-p${String(scan.index).padStart(3, '0')}.${ext}`;
    const outPath = path.join(destDir, filename);
    atomicWriteFileSync(outPath, bytes);
    downloaded.push({
      index: scan.index,
      label: scan.label,
      url: scan.image_url,
      path: outPath,
      bytes: bytes.length,
      cache_hit: cacheHit,
    });
  }

  const allCacheHit = Boolean(folderHit && downloaded.every((item) => item.cache_hit));
  if (asJson) {
    const bytesOut = emitJsonStdout(ctx.io, {
      folder_id: folder.folder_id,
      title: folder.title,
      source_url: folder.source_url,
      total_scans: folder.scans.length,
      downloaded: downloaded.length,
      files: downloaded,
      cache_hit: allCacheHit,
    });
    return { exitCode: 0, bytesOut, cacheHit: allCacheHit };
  }

  const lines = downloaded.map((item) => {
    const marker = item.cache_hit ? ' [cache]' : '';
    return `scan ${item.index}: ${item.path} (${item.bytes} bytes)${marker}`;
  });
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit: allCacheHit };
}
