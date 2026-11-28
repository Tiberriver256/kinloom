import { isPlainRecord } from '../../runtime/primitives.js';
import { parsePageSpec } from './queryValidation.js';
import {
  CATALOG_WEB_BASE,
  type NaraExtractedTextItem,
  type NaraRecordSummary,
  type NaraSearchPayload,
} from './types.js';

export {
  buildQueryParams,
  detectErrorPayload,
  encodeCatalogUrl,
  hasParentTraversal,
  isDirectDownloadUrl,
  normalizeQueryForWafRetry,
  parsePageSpec,
  quotePythonStyle,
  resolveQueryTtlHours,
  resolveSafeChild,
  resolveUserPath,
  safeObjectFilename,
  validateNaid,
  validateNaraDownloadUrl,
} from './queryValidation.js';

export function extractRecord(
  hit: unknown,
  options: {
    readonly includeObjects?: boolean;
    readonly includeText?: boolean;
    readonly pageSpec?: string | null;
  } = {}
): NaraRecordSummary {
  const includeObjects = options.includeObjects ?? false;
  const includeText = options.includeText ?? false;
  const pageSpec = options.pageSpec ?? null;

  const hitObj = isPlainRecord(hit) ? hit : {};
  const src = isPlainRecord(hitObj['_source']) ? hitObj['_source'] : {};
  const rec = isPlainRecord(src['record']) ? src['record'] : hitObj;

  const naid = rec['naId'] !== undefined && rec['naId'] !== null ? String(rec['naId']) : '';
  const ancestors = (Array.isArray(rec['ancestors']) ? rec['ancestors'] : []).filter(isPlainRecord);
  const rg = ancestors.find((a) => a['levelOfDescription'] === 'recordGroup');
  const series = ancestors.find((a) => a['levelOfDescription'] === 'series');
  const microforms = (Array.isArray(rec['microformPublications']) ? rec['microformPublications'] : []).filter(
    isPlainRecord
  );
  const objs = (Array.isArray(rec['digitalObjects']) ? rec['digitalObjects'] : []).filter(isPlainRecord);

  const out: NaraRecordSummary = {
    naId: naid,
    title: typeof rec['title'] === 'string' ? rec['title'] : '',
    url: naid ? `${CATALOG_WEB_BASE}/id/${naid}` : '',
  };

  if (typeof rec['levelOfDescription'] === 'string' && rec['levelOfDescription']) {
    out.level = rec['levelOfDescription'];
  }

  const rgNum = rg ? rg['recordGroupNumber'] : rec['recordGroupNumber'];
  if (typeof rgNum === 'string' || typeof rgNum === 'number') {
    out.rg = rgNum;
  }
  if (rg && typeof rg['title'] === 'string' && rg['title']) {
    out.rgTitle = rg['title'];
  }
  if (series && typeof series['title'] === 'string' && series['title']) {
    out.series = series['title'];
  }
  if (series && series['naId'] !== undefined && series['naId'] !== null && String(series['naId'])) {
    out.seriesNaId = String(series['naId']);
  }

  const dates: string[] = [];
  for (const key of [
    'inclusiveStartDate',
    'inclusiveEndDate',
    'productionDateArray',
    'coverageStartDate',
    'coverageEndDate',
  ] as const) {
    const val = rec[key];
    if (isPlainRecord(val) && val['logicalDate']) {
      dates.push(String(val['logicalDate']));
    } else if (Array.isArray(val)) {
      for (const entry of val) {
        if (isPlainRecord(entry) && entry['logicalDate']) {
          dates.push(String(entry['logicalDate']));
        }
      }
    }
  }
  if (dates.length > 0) {
    out.dates = dates;
  }

  const mfList: string[] = [];
  for (const m of microforms) {
    const parts = [m['identifier'], m['title'], m['note']]
      .filter((p): p is string | number => p !== null && p !== undefined && String(p).trim() !== '')
      .map((p) => String(p).trim());
    if (parts.length > 0) {
      mfList.push(parts.join(' | '));
    }
  }
  if (mfList.length > 0) {
    out.microform = mfList;
  }

  const access = isPlainRecord(rec['accessRestriction']) ? rec['accessRestriction']['status'] : undefined;
  const use = isPlainRecord(rec['useRestriction']) ? rec['useRestriction']['status'] : undefined;
  if (typeof access === 'string' && access) {
    out.access = access;
  }
  if (typeof use === 'string' && use) {
    out.use = use;
  }
  if (typeof rec['scopeAndContentNote'] === 'string' && rec['scopeAndContentNote']) {
    out.scope = rec['scopeAndContentNote'];
  }

  const locations: string[] = [];
  for (const po of Array.isArray(rec['physicalOccurrences']) ? rec['physicalOccurrences'] : []) {
    if (!isPlainRecord(po)) {
      continue;
    }
    for (const ru of Array.isArray(po['referenceUnits']) ? po['referenceUnits'] : []) {
      if (isPlainRecord(ru) && typeof ru['name'] === 'string' && ru['name'] && !locations.includes(ru['name'])) {
        locations.push(ru['name']);
      }
    }
  }
  if (locations.length > 0) {
    out.location = locations.length === 1 ? locations[0] : locations;
  }

  if (objs.length > 0) {
    out.objectCount = objs.length;
    if (includeObjects) {
      const selected = parsePageSpec(pageSpec, objs.length);
      out.objects = selected.map((p) => {
        const obj = objs[p - 1];
        const filename =
          typeof obj['objectFilename'] === 'string' && obj['objectFilename']
            ? obj['objectFilename']
            : obj['objectId'] !== undefined && obj['objectId'] !== null
              ? String(obj['objectId'])
              : '';
        const url = typeof obj['objectUrl'] === 'string' ? obj['objectUrl'] : '';
        return { page: p, filename, url };
      });
    }
    if (includeText) {
      const selected = parsePageSpec(pageSpec, objs.length);
      const texts: NaraExtractedTextItem[] = [];
      for (const p of selected) {
        const obj = objs[p - 1];
        const txt =
          (typeof obj['extractedText'] === 'string' && obj['extractedText']) ||
          (typeof obj['otherExtractedText'] === 'string' && obj['otherExtractedText']) ||
          '';
        if (txt) {
          texts.push({
            page: p,
            filename: typeof obj['objectFilename'] === 'string' ? obj['objectFilename'] : '',
            text: txt,
          });
        }
      }
      if (texts.length > 0) {
        out.extractedText = texts;
      }
    }
  }

  return out;
}

export function buildSearchPayload(
  query: string | null,
  webUrl: string,
  raw: Record<string, unknown>
): NaraSearchPayload {
  const body = isPlainRecord(raw['body']) ? raw['body'] : raw;
  const hitsObj = isPlainRecord(body['hits']) ? body['hits'] : {};
  const hits = Array.isArray(hitsObj['hits']) ? hitsObj['hits'] : [];
  const totalRaw = hitsObj['total'];
  let total = hits.length;
  if (isPlainRecord(totalRaw) && typeof totalRaw['value'] === 'number') {
    total = totalRaw['value'];
  } else if (typeof totalRaw === 'number') {
    total = totalRaw;
  } else if (typeof totalRaw === 'string' && /^\d+$/.test(totalRaw)) {
    total = Number.parseInt(totalRaw, 10);
  }
  const results = hits.map((h) => extractRecord(h));
  if (query !== null) {
    return { query, searchUrl: webUrl, total, results };
  }
  return { searchUrl: webUrl, total, results };
}

export function projectRecord(
  fullRecord: NaraRecordSummary,
  options: {
    readonly includeObjects?: boolean;
    readonly includeText?: boolean;
    readonly pageSpec?: string | null;
  } = {}
): NaraRecordSummary {
  const includeObjects = options.includeObjects ?? false;
  const includeText = options.includeText ?? false;
  const pageSpec = options.pageSpec ?? null;

  const {
    objects: fullObjects,
    extractedText: fullExtractedText,
    transcriptions: fullTranscriptions,
    ...rest
  } = fullRecord;
  const out: NaraRecordSummary = { ...rest };
  const total = fullRecord.objectCount ?? (fullObjects ? fullObjects.length : 0);

  if (includeObjects && fullObjects && fullObjects.length > 0) {
    const selectedPages = new Set(parsePageSpec(pageSpec, total));
    out.objects = fullObjects.filter((obj) => selectedPages.has(obj.page));
  }
  if (includeText) {
    if (fullExtractedText && fullExtractedText.length > 0) {
      const selectedPages = total > 0 ? new Set(parsePageSpec(pageSpec, total)) : new Set<number>();
      const texts = fullExtractedText.filter(
        (item) => selectedPages.size === 0 || selectedPages.has(item.page)
      );
      if (texts.length > 0) {
        out.extractedText = texts;
      }
    }
    if (fullTranscriptions && fullTranscriptions.length > 0) {
      out.transcriptions = [...fullTranscriptions];
    }
  }
  return out;
}

export function formatRecordText(rec: NaraRecordSummary): string {
  if (rec.error) {
    return `NAID ${rec.naId}: ERROR - ${rec.error}`;
  }
  const headerParts: string[] = [`NAID ${rec.naId}`];
  if (rec.level) {
    headerParts.push(`[${rec.level}]`);
  }
  if (rec.rg !== undefined) {
    headerParts.push(`RG ${rec.rg}`);
  }
  if (rec.objectCount) {
    headerParts.push(`${rec.objectCount} files`);
  }
  const lines: string[] = [`${headerParts.join(' ')}: ${rec.title ?? ''}`, `  ${rec.url}`];
  if (rec.series) {
    lines.push(`  Series: ${rec.series}`);
  }
  if (rec.dates && rec.dates.length > 0) {
    lines.push(`  Dates: ${rec.dates.join(' .. ')}`);
  }
  for (const mf of rec.microform ?? []) {
    lines.push(`  Microform: ${mf}`);
  }
  if (rec.access || rec.use) {
    lines.push(`  Access/Use: ${rec.access ?? '?'} / ${rec.use ?? '?'}`);
  }
  if (rec.location) {
    const loc = typeof rec.location === 'string' ? rec.location : rec.location.join('; ');
    lines.push(`  Location: ${loc}`);
  }
  if (rec.scope) {
    lines.push(`  Scope: ${rec.scope}`);
  }
  for (const obj of rec.objects ?? []) {
    lines.push(`  [${String(obj.page).padStart(3, '0')}] ${obj.filename}: ${obj.url}`);
  }
  for (const item of rec.extractedText ?? []) {
    lines.push(`  --- Page ${item.page} (${item.filename}) ---\n${item.text}`);
  }
  for (const tr of rec.transcriptions ?? []) {
    lines.push(`  --- Transcription ---\n${tr}`);
  }
  return lines.join('\n');
}
