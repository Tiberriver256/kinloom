import { CliValidationError } from '../../../../errors.js';
import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import {
  hasMagicPrefix,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  PNG_MAGIC,
  stripLeadingBomAndWs,
} from '../../runtime/primitives.js';
import {
  DOC_ID_SAFE_RE,
  MNHS_PEOPLE_RECORD_URL,
  MNHS_PEOPLE_SEARCH_URL,
  NEWSPAPERS_BASE,
  NEWSPAPERS_METADATA_URL,
  NEWSPAPERS_THUMB_URL,
  NEWSPAPERS_VIEWER_URL,
  type NewspaperMetadataResult,
  type NewspaperSearchItem,
  type NewspaperSearchResult,
  type NormalizedPeopleHit,
  type PeopleRecordDetailResult,
  type PeopleSearchResult,
  RECORD_TYPE_SPECS,
} from './domain.js';

function trimIsoDate(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return raw.split('T', 1)[0]?.trim() ?? '';
}

function stringField(raw: Record<string, unknown>, key: string): string {
  const val = raw[key];
  return typeof val === 'string' ? val : val !== null && val !== undefined ? String(val) : '';
}

export function normalizePeopleHit(recordType: string, raw: Record<string, unknown>): NormalizedPeopleHit {
  const recordId = stringField(raw, 'id').trim();
  const nameParts = [raw['firstName'], raw['middleName'], raw['familyName'], raw['suffix']]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  const fullName = nameParts.join(' ');
  const dateField = RECORD_TYPE_SPECS[recordType]?.dateField ?? null;
  const primaryDate = dateField ? trimIsoDate(raw[dateField]) : '';
  const countyRaw = raw['county'] ?? raw['burialLocation'] ?? raw['residencePriorToService'] ?? raw['residence'] ?? '';
  const county = String(countyRaw ?? '').trim();
  const recordUrl = recordId
    ? `${MNHS_PEOPLE_RECORD_URL}?uuid=${encodeURIComponent(recordId)}&recordType=${encodeURIComponent(recordType)}`
    : MNHS_PEOPLE_SEARCH_URL;

  const base: NormalizedPeopleHit = {
    id: recordId,
    record_type: recordType,
    name: fullName,
    first_name: typeof raw['firstName'] === 'string' ? raw['firstName'] : '',
    middle_name: typeof raw['middleName'] === 'string' ? raw['middleName'] : '',
    family_name: typeof raw['familyName'] === 'string' ? raw['familyName'] : '',
    certificate_id: stringField(raw, 'certificateId'),
    date: primaryDate,
    county,
    url: recordUrl,
    ...(raw['mothersMaidenName'] ? { mothers_maiden_name: String(raw['mothersMaidenName']) } : {}),
    ...(raw['birthDate'] ? { birth_date: trimIsoDate(raw['birthDate']) } : {}),
    ...(raw['birthPlace'] ? { birth_place: String(raw['birthPlace']) } : {}),
    ...(raw['age'] !== null && raw['age'] !== undefined && String(raw['age']).trim()
      ? { age: String(raw['age']).trim() }
      : {}),
    ...(raw['locality'] ? { locality: String(raw['locality']).trim() } : {}),
    ...(raw['lineInImage'] !== null && raw['lineInImage'] !== undefined ? { line: raw['lineInImage'] } : {}),
  };

  if (Array.isArray(raw['militaryServices']) && raw['militaryServices'].length > 0) {
    const services: string[] = [];
    for (const item of raw['militaryServices']) {
      if (isPlainRecord(item) && item['value']) {
        services.push(String(item['value']).trim());
      }
    }
    if (services.length > 0) {
      return { ...base, military_services: services };
    }
  }

  return base;
}

function extractDocIdFromHref(href: string): string {
  const cleaned = href.replace(/;jsessionid=[^?]+/i, '');
  try {
    const parsed = new URL(cleaned, NEWSPAPERS_BASE);
    const val = parsed.searchParams.get('doc_id');
    return val ? val.trim() : '';
  } catch {
    return '';
  }
}

export function parseNewspapersSearchHtml(html: string): readonly [number | null, NewspaperSearchItem[]] {
  const countMatch = /\bpsRecCnt\s*=\s*(\d+)\b/.exec(html);
  const total = countMatch ? Number.parseInt(countMatch[1], 10) : null;
  const $ = loadHtml(html);
  const items: NewspaperSearchItem[] = [];

  $('td.ps-result-cell').each((_idx, cellEl) => {
    const cell = $(cellEl);
    const item: NewspaperSearchItem = {};

    const titleAnchor = cell.find('a.ps-result-title').first();
    if (titleAnchor.length > 0) {
      const href = titleAnchor.attr('href') ?? '';
      const attrTitle = (titleAnchor.attr('title') ?? '').trim();
      const textTitle = collapseWhitespace(titleAnchor.text());
      const resolvedTitle = attrTitle || textTitle;
      if (resolvedTitle) {
        item.title = resolvedTitle;
      }
      const docId = extractDocIdFromHref(href);
      if (docId) {
        item.doc_id = docId;
      }
    }

    cell.find('div.ps-result-detail').each((_dIdx, divEl) => {
      const text = collapseWhitespace($(divEl).text());
      const pubMatch = /^Publication Date:\s*(.+)$/i.exec(text);
      if (pubMatch) {
        item.publication_date = pubMatch[1].trim();
      } else if (text && !item.detail) {
        item.detail = text;
      }
    });

    const thumbImg = cell.find('img.ps-result-thumb').first();
    if (thumbImg.length > 0) {
      const src = thumbImg.attr('src') ?? '';
      if (src) {
        const cleaned = src.replace(/;jsessionid=[^?]+/i, '');
        item.thumb_url = new URL(cleaned, NEWSPAPERS_BASE).toString();
      }
    }

    if (item.doc_id) {
      const quoted = encodeURIComponent(item.doc_id);
      item.viewer_url = `${NEWSPAPERS_VIEWER_URL}?doc_id=${quoted}`;
      item.metadata_url = `${NEWSPAPERS_METADATA_URL}?doc_id=${quoted}`;
      if (!item.thumb_url) {
        item.thumb_url = `${NEWSPAPERS_THUMB_URL}?tnName=${quoted}`;
      }
      items.push(item);
    }
  });

  return [total, items];
}

export function parseNewspapersMetadataHtml(html: string): Record<string, string> {
  const $ = loadHtml(html);
  const fields: Record<string, string> = {};
  let currentLabel: string | null = null;
  $('td.ps-md-field-label, td.ps-md-field-value').each((_idx, el) => {
    const td = $(el);
    const text = collapseWhitespace(td.text());
    if (td.hasClass('ps-md-field-label')) {
      currentLabel = text;
    } else if (td.hasClass('ps-md-field-value') && currentLabel) {
      fields[currentLabel] = text;
      currentLabel = null;
    }
  });
  return fields;
}

export function validateNewspaperDocId(raw: string): string {
  let clean: string;
  try {
    clean = decodeURIComponent(raw.trim());
  } catch {
    clean = raw.trim();
  }
  if (!clean || clean.includes('..') || clean.startsWith('/') || !DOC_ID_SAFE_RE.test(clean)) {
    throw new CliValidationError(`Invalid MNHS newspaper doc_id: '${raw}'`);
  }
  return clean;
}

export function detectImageFormat(data: Uint8Array): string | null {
  if (hasMagicPrefix(data, JPEG_MAGIC)) {
    return 'jpeg';
  }
  if (hasMagicPrefix(data, PNG_MAGIC)) {
    return 'png';
  }
  const head6 = Buffer.from(data.subarray(0, 6)).toString('ascii');
  if (head6 === 'GIF87a' || head6 === 'GIF89a') {
    return 'gif';
  }
  if (
    data.length >= 12 &&
    Buffer.from(data.subarray(0, 4)).toString('ascii') === 'RIFF' &&
    Buffer.from(data.subarray(8, 12)).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function looksLikeHtml(data: Uint8Array, contentType: string): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    return true;
  }
  if (looksLikeHtmlBuffer(data, 512)) {
    return true;
  }
  return stripLeadingBomAndWs(data, 512).startsWith('<?xml');
}

export function isPeopleSearchResult(value: unknown): value is PeopleSearchResult {
  return isPlainRecord(value) && typeof value['record_type'] === 'string' && Array.isArray(value['results']);
}

export function isPeopleRecordDetailResult(value: unknown): value is PeopleRecordDetailResult {
  return (
    isPlainRecord(value) &&
    typeof value['id'] === 'string' &&
    isPlainRecord(value['summary']) &&
    isPlainRecord(value['record'])
  );
}

export function isNewspaperSearchResult(value: unknown): value is NewspaperSearchResult {
  return isPlainRecord(value) && Array.isArray(value['results']);
}

export function isNewspaperMetadataResult(value: unknown): value is NewspaperMetadataResult {
  return isPlainRecord(value) && isPlainRecord(value['fields']);
}
