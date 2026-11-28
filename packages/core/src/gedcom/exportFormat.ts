import type { ArchiveEvent, Person } from '../schemas/entities.js';

const GEDCOM_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

export function escapeGedcomValue(raw: string): string {
  const cleaned = raw.replaceAll(/\r\n?/g, '\n').trim();
  return cleaned.startsWith('@') ? `@${cleaned}` : cleaned;
}

export function pushTag(lines: string[], level: number, tag: string, value?: string): void {
  if (value === undefined || value === '') {
    lines.push(`${level} ${tag}`);
    return;
  }
  const normalized = value.replaceAll(/\r\n?/g, '\n').trim();
  if (!normalized) {
    return;
  }
  const parts = normalized.split('\n');
  for (const [idx, part] of parts.entries()) {
    const escaped = part.startsWith('@') ? `@${part}` : part;
    if (idx === 0) {
      lines.push(`${level} ${tag} ${escaped}`);
    } else {
      lines.push(`${level + 1} CONT ${escaped}`);
    }
  }
}

function formatSingleEdtfDate(cleaned: string): string {
  const decMatch = /^(\d{3})X$/.exec(cleaned);
  if (decMatch) {
    const y0 = Number(decMatch[1]) * 10;
    return `BET ${y0} AND ${y0 + 9}`;
  }

  const fullMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(cleaned);
  if (fullMatch) {
    const [, year, month, dayStr] = fullMatch;
    const monthIdx = Number(month) - 1;
    const day = Number(dayStr);
    const mon = GEDCOM_MONTHS[monthIdx];
    if (mon && day >= 1 && day <= 31) {
      return `${day} ${mon} ${year}`;
    }
  }

  const ymMatch = /^(\d{4})-(\d{2})$/.exec(cleaned);
  if (ymMatch) {
    const [, year, month] = ymMatch;
    const monthIdx = Number(month) - 1;
    const mon = GEDCOM_MONTHS[monthIdx];
    if (mon) {
      return `${mon} ${year}`;
    }
  }

  const yMatch = /^(\d{4})$/.exec(cleaned);
  if (yMatch) {
    return yMatch[1];
  }

  return '';
}

function formatIntervalSideDate(side: string, isLeft: boolean): string {
  const decMatch = /^(\d{3})X$/.exec(side);
  if (decMatch) {
    const y0 = Number(decMatch[1]) * 10;
    return String(isLeft ? y0 : y0 + 9);
  }
  return formatSingleEdtfDate(side);
}

/**
 * Convert EDTF dates into valid GEDCOM 7.0 date values.
 */
function trimTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function trimEdgeChar(value: string, ch: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) {
    start += 1;
  }
  while (end > start && value[end - 1] === ch) {
    end -= 1;
  }
  return value.slice(start, end);
}

export function formatEdtfToGedcomDate(edtf?: string | number | null): string {
  if (edtf === null || edtf === undefined || edtf === '') {
    return '';
  }
  const raw = String(edtf).trim();
  if (!raw) {
    return '';
  }

  if (raw.includes('/')) {
    const idx = raw.indexOf('/');
    const left = trimTrailingChars(raw.slice(0, idx), '~?%').trim();
    const right = trimTrailingChars(raw.slice(idx + 1), '~?%').trim();
    const a = left ? formatIntervalSideDate(left, true) : '';
    const b = right ? formatIntervalSideDate(right, false) : '';
    if (a && b) {
      return `BET ${a} AND ${b}`;
    }
    if (a) {
      return `AFT ${a}`;
    }
    if (b) {
      return `BEF ${b}`;
    }
    return '';
  }

  const approx = raw.endsWith('~') || raw.endsWith('?') || raw.endsWith('%') || /^abt\.?\s/i.test(raw);
  const cleaned = trimTrailingChars(raw, '~?%')
    .replace(/^abt\.?\s+/i, '')
    .trim();

  const single = formatSingleEdtfDate(cleaned);
  if (!single) {
    return '';
  }
  if (single.startsWith('BET ')) {
    return single;
  }
  return `${approx ? 'ABT ' : ''}${single}`;
}

export function formatGedcomName(person: Pick<Person, 'full_name' | 'given_name' | 'surname'>): string {
  const given = (person.given_name || '').trim();
  const surname = (person.surname || '').trim();
  if (given && surname) {
    return `${given} /${surname}/`;
  }
  if (surname) {
    return `/${surname}/`;
  }
  const parts = (person.full_name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts.at(-1);
    const rest = parts.slice(0, -1).join(' ');
    return `${rest} /${last}/`;
  }
  return parts[0] || 'Unknown';
}

export function classifyPersonalEventTag(ev: ArchiveEvent): { tag: string; eventType?: string } | null {
  const titleLow = (ev.title || '').toLowerCase();
  const cat = (ev.category || '').toLowerCase();
  if (titleLow.startsWith('birth')) {
    return { tag: 'BIRT' };
  }
  if (titleLow.startsWith('death')) {
    return { tag: 'DEAT' };
  }
  if (titleLow.startsWith('burial') || titleLow.includes('buried')) {
    return { tag: 'BURI' };
  }
  if (titleLow.includes('marriage') || titleLow.includes('married') || titleLow.includes('divorce')) {
    return null;
  }
  if (titleLow.includes('census')) {
    return { tag: 'CENS' };
  }
  if (
    ev.event_kind === 'residence_anchor' ||
    cat === 'homestead' ||
    titleLow.includes('residence') ||
    titleLow.includes('lived')
  ) {
    return { tag: 'RESI' };
  }
  if (titleLow.includes('immigration') || titleLow.includes('arrival')) {
    return { tag: 'IMMI' };
  }
  if (titleLow.includes('military') || titleLow.includes('draft')) {
    return { tag: 'EVEN', eventType: 'Military / Service' };
  }
  return { tag: 'EVEN', eventType: ev.title || 'Historical Event' };
}

export function formatHeaderDate(date: Date): string {
  const day = date.getUTCDate();
  const mon = GEDCOM_MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  return `${day} ${mon} ${year}`;
}

export interface GedcomFilenameParams {
  familySlug?: string;
  lineageFilter: string;
  selectedEra: string;
  onlyWithMedia: boolean;
  query: string;
  sortBy: string;
  count: number;
}

export function buildGedcomExportFilename(params: GedcomFilenameParams): string {
  const baseSlug = trimEdgeChar(
    (params.familySlug || 'family-archive').toLowerCase().replaceAll(/[^a-z0-9]+/g, '-'),
    '-'
  );
  const parts: string[] = [baseSlug || 'family-archive'];
  if (params.lineageFilter && params.lineageFilter !== 'all') {
    parts.push(params.lineageFilter.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
  if (params.selectedEra && params.selectedEra !== 'all') {
    parts.push(params.selectedEra.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase());
  }
  if (params.onlyWithMedia) {
    parts.push('with-media');
  }
  const cleanQ = trimEdgeChar(
    params.query
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-'),
    '-'
  ).slice(0, 24);
  if (cleanQ) {
    parts.push(cleanQ);
  }
  if (params.sortBy && params.sortBy !== 'featured') {
    parts.push(`sorted-${params.sortBy.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
  }
  parts.push(`${params.count}-relatives`);
  return `${parts.join('-')}.ged`;
}
