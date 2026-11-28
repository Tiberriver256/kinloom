import { daysSinceEpoch, epochDaysToYear, lastDayOfMonth, MONTHS } from './edtf/calendar.js';

export {
  DAY_MS,
  daysSinceEpoch,
  EPOCH_JDN,
  EPOCH_MS,
  epochDaysToYear,
  lastDayOfMonth,
  MONTHS,
  toJulianDayNumber,
} from './edtf/calendar.js';

const GEDCOM_MONTH_MAP: Readonly<Record<string, number>> = {
  JAN: 1,
  FEB: 2,
  FEBR: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  SEPT: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
};

export interface CompiledEdtfMeta {
  readonly timeMin: number | null;
  readonly timeMax: number | null;
  readonly displayDate: string;
  readonly year: number | null;
}

const EMPTY_EDTF_META: CompiledEdtfMeta = {
  timeMin: null,
  timeMax: null,
  displayDate: 'Undated',
  year: null,
};

const MAX_EDTF_CACHE_SIZE = 16384;
const edtfYearCache = new Map<string, number | null>();
const edtfBoundsCache = new Map<string, readonly [number, number] | null>();
const edtfDisplayCache = new Map<string, string>();
const edtfPointCache = new Map<string, ParsedEdtfPoint | null>();
const compiledEdtfMetaCache = new Map<string, CompiledEdtfMeta>();

function setBounded<V>(cache: Map<string, V>, key: string, value: V): void {
  if (cache.size >= MAX_EDTF_CACHE_SIZE) {
    cache.clear();
  }
  cache.set(key, value);
}

function parseFourDigitsAt(str: string, idx: number): number {
  const c0 = str.charCodeAt(idx) - 48;
  const c1 = str.charCodeAt(idx + 1) - 48;
  const c2 = str.charCodeAt(idx + 2) - 48;
  const c3 = str.charCodeAt(idx + 3) - 48;
  if ((c0 | c1 | c2 | c3) < 0 || c0 > 9 || c1 > 9 || c2 > 9 || c3 > 9) {
    return -1;
  }
  return c0 * 1000 + c1 * 100 + c2 * 10 + c3;
}

function parseTwoDigitsAt(str: string, idx: number): number {
  const c0 = str.charCodeAt(idx) - 48;
  const c1 = str.charCodeAt(idx + 1) - 48;
  if ((c0 | c1) < 0 || c0 > 9 || c1 > 9) {
    return -1;
  }
  return c0 * 10 + c1;
}

const EDTF_YEAR_FALLBACK_RE = /\b(1[4-9]\d{2}|20\d{2})\b/;

export function edtfYear(edtf: string | number | null | undefined): number | null {
  if (edtf === null || edtf === undefined || edtf === '') {
    return null;
  }
  if (typeof edtf === 'number') {
    if (Number.isInteger(edtf) && edtf >= 1400 && edtf <= 2099) {
      return edtf;
    }
    const m = EDTF_YEAR_FALLBACK_RE.exec(String(edtf));
    return m ? Number(m[1]) : null;
  }
  const cached = edtfYearCache.get(edtf);
  if (cached !== undefined) {
    return cached;
  }

  let result: number | null = null;
  const len = edtf.length;
  if (len >= 4) {
    const y = parseFourDigitsAt(edtf, 0);
    if (y >= 1400 && y <= 2099) {
      const nextCode = len > 4 ? edtf.charCodeAt(4) : 0;
      const isWordBoundary =
        len === 4 ||
        !(
          (nextCode >= 48 && nextCode <= 57) ||
          (nextCode >= 65 && nextCode <= 90) ||
          (nextCode >= 97 && nextCode <= 122) ||
          nextCode === 95
        );
      if (isWordBoundary) {
        result = y;
      }
    }
  }
  if (result === null) {
    const m = EDTF_YEAR_FALLBACK_RE.exec(edtf);
    result = m ? Number(m[1]) : null;
  }
  setBounded(edtfYearCache, edtf, result);
  return result;
}

export type ParsedEdtfPrecision = 'day' | 'month' | 'year' | 'decade';

export interface ParsedEdtfInterval {
  raw: string;
  year: number;
  month: number | null;
  day: number | null;
  precision: ParsedEdtfPrecision;
  approximate: boolean;
  startMs: number;
  endMs: number;
}

interface ParsedEdtfPoint {
  year: number;
  month: number | null;
  day: number | null;
  precision: ParsedEdtfPrecision;
  startDays: number;
  endDays: number;
  startMs: number;
  endMs: number;
}

type ParsedEdtfEndpoint = { kind: 'open' } | { kind: 'point'; point: ParsedEdtfPoint };

function parseClosedEdtfPoint(part: string): ParsedEdtfPoint | null {
  const cached = edtfPointCache.get(part);
  if (cached !== undefined) {
    return cached;
  }

  const clean = part.trim().replaceAll(/[~?%]/g, '');
  if (!clean) {
    setBounded(edtfPointCache, part, null);
    return null;
  }

  let point: ParsedEdtfPoint | null = null;
  const len = clean.length;

  if (len === 10 && clean.charCodeAt(4) === 45 && clean.charCodeAt(7) === 45) {
    const y = parseFourDigitsAt(clean, 0);
    const mo = parseTwoDigitsAt(clean, 5);
    const rawD = parseTwoDigitsAt(clean, 8);
    if (y >= 0 && mo >= 0 && rawD >= 0) {
      const last = lastDayOfMonth(y, mo);
      const d = Math.max(1, Math.min(rawD, last));
      const j = daysSinceEpoch(y, mo, d);
      const ms = Date.UTC(y, mo - 1, d);
      point = {
        year: y,
        month: mo,
        day: d,
        precision: 'day',
        startDays: j,
        endDays: j,
        startMs: ms,
        endMs: ms,
      };
    }
  } else if (len === 7 && clean.charCodeAt(4) === 45) {
    const y = parseFourDigitsAt(clean, 0);
    const mo = parseTwoDigitsAt(clean, 5);
    if (y >= 0 && mo >= 0) {
      const last = lastDayOfMonth(y, mo);
      point = {
        year: y,
        month: mo,
        day: null,
        precision: 'month',
        startDays: daysSinceEpoch(y, mo, 1),
        endDays: daysSinceEpoch(y, mo, last),
        startMs: Date.UTC(y, mo - 1, 1),
        endMs: Date.UTC(y, mo - 1, last),
      };
    }
  } else if (len === 4) {
    const y = parseFourDigitsAt(clean, 0);
    if (y >= 0) {
      point = {
        year: y,
        month: null,
        day: null,
        precision: 'year',
        startDays: daysSinceEpoch(y, 1, 1),
        endDays: daysSinceEpoch(y, 12, 31),
        startMs: Date.UTC(y, 0, 1),
        endMs: Date.UTC(y, 11, 31),
      };
    } else if ((clean.charCodeAt(3) | 32) === 120) {
      const mDec = /^(\d{3})X$/i.exec(clean);
      if (mDec) {
        const y0 = Number(mDec[1]) * 10;
        point = {
          year: y0,
          month: null,
          day: null,
          precision: 'decade',
          startDays: daysSinceEpoch(y0, 1, 1),
          endDays: daysSinceEpoch(y0 + 9, 12, 31),
          startMs: Date.UTC(y0, 0, 1),
          endMs: Date.UTC(y0 + 9, 11, 31),
        };
      }
    }
  }

  setBounded(edtfPointCache, part, point);
  return point;
}

function parseEdtfEndpoint(part: string): ParsedEdtfEndpoint | null {
  const trimmed = part.trim();
  if (trimmed === '' || trimmed === '..') {
    return { kind: 'open' };
  }
  const point = parseClosedEdtfPoint(trimmed);
  return point ? { kind: 'point', point } : null;
}

/**
 * Parse an EDTF date or interval into structured UTC millisecond bounds, precision, and approximate metadata.
 * Supports day, month, year, decade (`192X`), open endpoints (`''` / `'..'`), and `[~?%]` qualifiers.
 */
export function parseEdtfInterval(raw: unknown): ParsedEdtfInterval | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const approximate = /[~?%]/.test(trimmed);
  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    const point = parseClosedEdtfPoint(trimmed);
    if (!point) {
      return null;
    }
    return {
      raw: trimmed,
      year: point.year,
      month: point.month,
      day: point.day,
      precision: point.precision,
      approximate,
      startMs: point.startMs,
      endMs: point.endMs,
    };
  }
  if (trimmed.indexOf('/', slash + 1) !== -1) {
    return null;
  }

  const left = parseEdtfEndpoint(trimmed.slice(0, slash));
  const right = parseEdtfEndpoint(trimmed.slice(slash + 1));
  if (!left || !right || (left.kind === 'open' && right.kind === 'open')) {
    return null;
  }

  const anchor = left.kind === 'point' ? left.point : right.kind === 'point' ? right.point : null;
  if (!anchor) {
    return null;
  }
  const startMs = left.kind === 'point' ? left.point.startMs : Number.NEGATIVE_INFINITY;
  const endMs = right.kind === 'point' ? right.point.endMs : Number.POSITIVE_INFINITY;
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs > endMs) {
    return null;
  }

  return {
    raw: trimmed,
    year: anchor.year,
    month: anchor.month,
    day: anchor.day,
    precision: anchor.precision,
    approximate,
    startMs,
    endMs,
  };
}

function edtfPartBounds(part: string): readonly [number, number] | null {
  const s = part.trim();
  if (!s) {
    return null;
  }
  const lastCode = s.charCodeAt(s.length - 1);
  const approx = lastCode === 126 || lastCode === 37; // '~' or '%'
  const uncertain = lastCode === 63; // '?'
  const point = parseClosedEdtfPoint(s);
  if (!point) {
    return null;
  }

  if (point.precision === 'decade') {
    return [point.startDays, point.endDays];
  }
  if (point.precision === 'day') {
    if (approx) {
      return [point.startDays - 365, point.endDays + 365];
    }
    if (uncertain) {
      return [point.startDays - 30, point.endDays + 30];
    }
    return [point.startDays, point.endDays];
  }
  if (point.precision === 'month') {
    if (approx) {
      return [point.startDays - 365, point.endDays + 365];
    }
    return [point.startDays, point.endDays];
  }
  if (approx) {
    return [daysSinceEpoch(point.year - 1, 1, 1), daysSinceEpoch(point.year + 1, 12, 31)];
  }
  return [point.startDays, point.endDays];
}

function computeEdtfBoundsInternal(rawKey: string): readonly [number, number] | null {
  const cached = edtfBoundsCache.get(rawKey);
  if (cached !== undefined) {
    return cached;
  }
  const s = rawKey.trim();
  let result: readonly [number, number] | null = null;
  if (s) {
    const idx = s.indexOf('/');
    if (idx !== -1) {
      const left = s.slice(0, idx);
      const right = s.slice(idx + 1);
      const lb = left ? edtfPartBounds(left) : null;
      const rb = right ? edtfPartBounds(right) : null;
      if (lb && rb) {
        result = [Math.min(lb[0], rb[0]), Math.max(lb[1], rb[1])];
      } else if (lb) {
        result = [lb[0], lb[1] + 5 * 365];
      } else if (rb) {
        result = [rb[0] - 5 * 365, rb[1]];
      }
    } else {
      result = edtfPartBounds(s);
    }
  }
  setBounded(edtfBoundsCache, rawKey, result);
  return result;
}

/**
 * Convert an EDTF string (including intervals and qualifiers) into [time_min, time_max] epoch days.
 */
export function edtfToBounds(edtf: string | number | null | undefined): [number, number] | null {
  if (edtf === null || edtf === undefined || edtf === '') {
    return null;
  }
  const key = typeof edtf === 'string' ? edtf : String(edtf);
  const res = computeEdtfBoundsInternal(key);
  return res ? [res[0], res[1]] : null;
}

/**
 * Convert an EDTF string into [earliestYear, latestYear] using `edtfToBounds()`.
 */
export function edtfYearBounds(edtf: string | number | null | undefined): [number, number] | null {
  if (edtf === null || edtf === undefined || edtf === '') {
    return null;
  }
  const key = typeof edtf === 'string' ? edtf : String(edtf);
  const bounds = computeEdtfBoundsInternal(key);
  if (bounds) {
    return [epochDaysToYear(bounds[0]), epochDaysToYear(bounds[1])];
  }
  const fallback = edtfYear(edtf);
  return fallback !== null ? [fallback, fallback] : null;
}

/**
 * Deterministic numeric sort key for an EDTF string (epoch-day start, or MAX_SAFE_INTEGER when undated).
 */
export function edtfSortKey(edtf: string | number | null | undefined): number {
  if (edtf === null || edtf === undefined || edtf === '') {
    return Number.MAX_SAFE_INTEGER;
  }
  const key = typeof edtf === 'string' ? edtf : String(edtf);
  const bounds = computeEdtfBoundsInternal(key);
  return bounds ? bounds[0] : Number.MAX_SAFE_INTEGER;
}

/**
 * Format EDTF for compact human-readable display badges.
 */
export function formatEdtfDisplay(edtf: string | number | null | undefined): string {
  if (edtf === null || edtf === undefined || edtf === '') {
    return 'Undated';
  }
  const key = typeof edtf === 'string' ? edtf : String(edtf);
  const cached = edtfDisplayCache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const raw = key.trim();
  let formatted: string;
  if (!raw) {
    formatted = 'Undated';
  } else {
    const idx = raw.indexOf('/');
    if (idx !== -1) {
      const left = raw.slice(0, idx);
      const right = raw.slice(idx + 1);
      if (!left) {
        formatted = `Bef. ${formatEdtfDisplay(right)}`;
      } else if (!right) {
        formatted = `Aft. ${formatEdtfDisplay(left)}`;
      } else {
        formatted = `${formatEdtfDisplay(left)}–${formatEdtfDisplay(right)}`;
      }
    } else {
      let prefix = '';
      let s = raw;
      const lastCode = s.charCodeAt(s.length - 1);
      if (lastCode === 126) {
        prefix = 'c. ';
        s = s.slice(0, -1);
      } else if (lastCode === 63) {
        prefix = 'est. ';
        s = s.slice(0, -1);
      }
      if (s.length === 10 && s.charCodeAt(4) === 45 && s.charCodeAt(7) === 45) {
        const y = parseFourDigitsAt(s, 0);
        const mo = parseTwoDigitsAt(s, 5);
        const d = parseTwoDigitsAt(s, 8);
        if (y >= 0 && mo >= 1 && mo <= 12 && d >= 0) {
          formatted = `${prefix}${MONTHS[mo - 1]} ${d}, ${s.slice(0, 4)}`;
        } else {
          formatted = `${prefix}${s}`;
        }
      } else if (s.length === 7 && s.charCodeAt(4) === 45) {
        const y = parseFourDigitsAt(s, 0);
        const mo = parseTwoDigitsAt(s, 5);
        if (y >= 0 && mo >= 1 && mo <= 12) {
          formatted = `${prefix}${MONTHS[mo - 1]} ${s.slice(0, 4)}`;
        } else {
          formatted = `${prefix}${s}`;
        }
      } else {
        formatted = `${prefix}${s}`;
      }
    }
  }

  setBounded(edtfDisplayCache, key, formatted);
  return formatted;
}

/**
 * Single-lookup compiled EDTF metadata (`timeMin`, `timeMax`, `displayDate`, `year`) for archive compilation.
 */
export function getCompiledEdtfMeta(edtf: string | number | null | undefined): CompiledEdtfMeta {
  if (edtf === null || edtf === undefined || edtf === '') {
    return EMPTY_EDTF_META;
  }
  const key = typeof edtf === 'string' ? edtf : String(edtf);
  const cached = compiledEdtfMetaCache.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const bounds = computeEdtfBoundsInternal(key);
  const meta: CompiledEdtfMeta = {
    timeMin: bounds ? bounds[0] : null,
    timeMax: bounds ? bounds[1] : null,
    displayDate: formatEdtfDisplay(key),
    year: edtfYear(key),
  };
  setBounded(compiledEdtfMetaCache, key, meta);
  return meta;
}

function parseSingleGedcomDate(text: string): string {
  const t = text.trim().toUpperCase();

  // Old Style split year: JAN 1620/1 -> 1621-01
  const mOs = /^(?:(\d{1,2})\s+)?([A-Z]{3,9})\s+(\d{4})\/(\d{1,2})$/.exec(t);
  if (mOs) {
    const mon = mOs[2] ? GEDCOM_MONTH_MAP[mOs[2]] : undefined;
    if (mon) {
      const yr = String(Number(mOs[3]) + 1).padStart(4, '0');
      if (mOs[1]) {
        return `${yr}-${String(mon).padStart(2, '0')}-${mOs[1].padStart(2, '0')}`;
      }
      return `${yr}-${String(mon).padStart(2, '0')}`;
    }
  }

  // DD MON YYYY
  const mFull = /^(\d{1,2})\s+([A-Z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (mFull) {
    const mon = mFull[2] ? GEDCOM_MONTH_MAP[mFull[2]] : undefined;
    if (mon) {
      const y = Number(mFull[3]);
      const d = Math.min(Number(mFull[1]), lastDayOfMonth(y, mon));
      return `${mFull[3]}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // MON DD, YYYY
  const mUs = /^([A-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (mUs) {
    const mon = mUs[1] ? GEDCOM_MONTH_MAP[mUs[1]] : undefined;
    if (mon) {
      const y = Number(mUs[3]);
      const d = Math.min(Number(mUs[2]), lastDayOfMonth(y, mon));
      return `${mUs[3]}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // MON YYYY
  const mMo = /^([A-Z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (mMo) {
    const mon = mMo[1] ? GEDCOM_MONTH_MAP[mMo[1]] : undefined;
    if (mon) {
      return `${mMo[2]}-${String(mon).padStart(2, '0')}`;
    }
  }

  // ISO-like YYYY[-MM[-DD]]
  if (/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.test(t)) {
    return t;
  }

  const mYr = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(t);
  if (mYr && mYr[1]) {
    return mYr[1];
  }
  return '';
}

function stripGedcomPrefix(upperCollapsed: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    if (upperCollapsed.startsWith(prefix)) {
      const rest = upperCollapsed.slice(prefix.length);
      return rest.length > 0 ? rest : null;
    }
  }
  return null;
}

const GEDCOM_BET_PREFIXES = ['BET. ', 'BET '] as const;
const GEDCOM_ABT_PREFIXES = [
  'ABT. ',
  'ABT ',
  'ABOUT ',
  'CA. ',
  'CA ',
  'CIRCA ',
  'EST. ',
  'EST ',
  'CAL. ',
  'CAL ',
] as const;
const GEDCOM_BEF_PREFIXES = ['BEF. ', 'BEF ', 'BEFORE '] as const;
const GEDCOM_AFT_PREFIXES = ['AFT. ', 'AFT ', 'AFTER '] as const;

/**
 * Convert a GEDCOM date string (ABT, BEF, AFT, BET...AND, FROM...TO, Old Style) to EDTF.
 */
export function parseGedcomDateToEdtf(raw: string): string {
  if (!raw) {
    return '';
  }
  const s = raw.trim();
  if (!s) {
    return '';
  }
  const up = s.toUpperCase().replace(/\s+/g, ' ');

  const betRest = stripGedcomPrefix(up, GEDCOM_BET_PREFIXES);
  if (betRest !== null) {
    const andIdx = betRest.indexOf(' AND ');
    if (andIdx > 0 && andIdx + 5 < betRest.length) {
      const a = parseSingleGedcomDate(betRest.slice(0, andIdx));
      const b = parseSingleGedcomDate(betRest.slice(andIdx + 5));
      if (a && b) {
        return `${a}/${b}`;
      }
      return a || b;
    }
  }

  if (up.startsWith('FROM ')) {
    const fromRest = up.slice(5);
    const toIdx = fromRest.indexOf(' TO ');
    if (toIdx > 0 && toIdx + 4 < fromRest.length) {
      const a = parseSingleGedcomDate(fromRest.slice(0, toIdx));
      const b = parseSingleGedcomDate(fromRest.slice(toIdx + 4));
      if (a && b) {
        return `${a}/${b}`;
      }
      return a || b;
    }
  }

  const abtRest = stripGedcomPrefix(up, GEDCOM_ABT_PREFIXES);
  if (abtRest !== null) {
    const base = parseSingleGedcomDate(abtRest);
    return base ? `${base}~` : '';
  }

  const befRest = stripGedcomPrefix(up, GEDCOM_BEF_PREFIXES);
  if (befRest !== null) {
    const base = parseSingleGedcomDate(befRest);
    return base ? `/${base}` : '';
  }

  const aftRest = stripGedcomPrefix(up, GEDCOM_AFT_PREFIXES);
  if (aftRest !== null) {
    const base = parseSingleGedcomDate(aftRest);
    return base ? `${base}/` : '';
  }

  const mRng = /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(up);
  if (mRng) {
    return `${mRng[1]}/${mRng[2]}`;
  }

  return parseSingleGedcomDate(s);
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Great-circle distance in statute miles between two latitude/longitude coordinates.
 */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusMiles = 3958.7613;
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLng = (lng2 - lng1) * DEG_TO_RAD;
  const sinHalfLat = Math.sin(dLat * 0.5);
  const sinHalfLng = Math.sin(dLng * 0.5);
  const a =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * sinHalfLng * sinHalfLng;
  return 2 * earthRadiusMiles * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function intervalsOverlap(
  aMin: number | null,
  aMax: number | null,
  bMin: number | null,
  bMax: number | null,
  padDays = 0
): boolean {
  if (aMin === null || aMax === null || bMin === null || bMax === null) {
    return false;
  }
  return aMin - padDays <= bMax && aMax + padDays >= bMin;
}
