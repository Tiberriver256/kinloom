import { XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { gunzipBytes, parseXml } from '../../runtime/parse.js';
import { isPlainRecord, readJsonRecordIfValid } from '../../runtime/primitives.js';
import type { ItemFileEntry, ItemMetadataPayload, PageIndex } from './types.js';

export const SCANDATA_SPEC = { suffixes: ['_scandata.xml', 'scandata.xml'], formats: ['scandata'] } as const;
export const DJVU_SPEC = { suffixes: ['_djvu.txt'], formats: ['djvutxt'] } as const;
export const HOCR_TEXT_SPEC = {
  suffixes: ['_hocr_searchtext.txt.gz'],
  formats: ['ocr search text'],
} as const;
export const HOCR_IDX_SPEC = {
  suffixes: ['_hocr_pageindex.json.gz'],
  formats: ['ocr page index'],
} as const;

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
  const pageDataNode = findPageDataNode(parseXml(xmlText));
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

const PageIndexSchema = z.object({
  leaf_count: z.number(),
  access_leaf_count: z.number(),
  scandata_to_bookreader: z.record(z.string(), z.number()),
  bookreader_to_scandata: z.record(z.string(), z.number()),
  scandata_to_printed: z.record(z.string(), z.string()),
  bookreader_to_printed: z.record(z.string(), z.string()),
  printed_to_bookreader: z.record(z.string(), z.number()),
  printed_to_bookreader_ci: z.record(z.string(), z.number()),
  printed_to_scandata: z.record(z.string(), z.number()),
  segment_mode: z.string(),
  djvu_source: z.string().optional(),
});

export function readPageIndex(filePath: string): PageIndex | undefined {
  const parsed = readJsonRecordIfValid(filePath);
  if (!parsed) {
    return undefined;
  }
  const result = PageIndexSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}
