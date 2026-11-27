export const EPOCH_JDN = 2440588;
export const EPOCH_MS = Date.UTC(1970, 0, 1);
export const DAY_MS = 86_400 * 1000;

export const MONTHS: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

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

/**
 * Convert proleptic Gregorian (year, month, day) to Julian Day Number.
 */
export function toJulianDayNumber(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

/**
 * Convert proleptic Gregorian (year, month, day) to epoch days (days since 1970-01-01).
 */
export function daysSinceEpoch(year: number, month: number, day: number): number {
  return toJulianDayNumber(year, month, day) - EPOCH_JDN;
}

export function lastDayOfMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 31;
  }
  const safeYear = year < 1 ? 1 : year;
  return new Date(Date.UTC(safeYear, month, 0)).getUTCDate();
}

export function edtfYear(edtf: string | number | null | undefined): number | null {
  if (edtf === null || edtf === undefined || edtf === '') {
    return null;
  }
  const m = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(String(edtf));
  return m ? Number(m[1]) : null;
}

function edtfPartBounds(part: string): [number, number] | null {
  const s = part.trim();
  if (!s) {
    return null;
  }
  const approx = s.endsWith('~') || s.endsWith('%');
  const uncertain = s.endsWith('?');
  const clean = s.replace(/[~?%]+$/, '');

  const mDec = /^(\d{3})X$/.exec(clean);
  if (mDec) {
    const y0 = Number(mDec[1]) * 10;
    return [daysSinceEpoch(y0, 1, 1), daysSinceEpoch(y0 + 9, 12, 31)];
  }

  const mFull = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (mFull) {
    const y = Number(mFull[1]);
    const mo = Number(mFull[2]);
    const last = lastDayOfMonth(y, mo);
    const d = Math.max(1, Math.min(Number(mFull[3]), last));
    const j = daysSinceEpoch(y, mo, d);
    if (approx) {
      return [j - 365, j + 365];
    }
    if (uncertain) {
      return [j - 30, j + 30];
    }
    return [j, j];
  }

  const mMonth = /^(\d{4})-(\d{2})$/.exec(clean);
  if (mMonth) {
    const y = Number(mMonth[1]);
    const mo = Number(mMonth[2]);
    const last = lastDayOfMonth(y, mo);
    const j0 = daysSinceEpoch(y, mo, 1);
    const j1 = daysSinceEpoch(y, mo, last);
    if (approx) {
      return [j0 - 365, j1 + 365];
    }
    return [j0, j1];
  }

  const mYear = /^(\d{4})$/.exec(clean);
  if (mYear) {
    const y = Number(mYear[1]);
    const j0 = daysSinceEpoch(y, 1, 1);
    const j1 = daysSinceEpoch(y, 12, 31);
    if (approx) {
      return [daysSinceEpoch(y - 1, 1, 1), daysSinceEpoch(y + 1, 12, 31)];
    }
    return [j0, j1];
  }

  return null;
}

/**
 * Convert an EDTF string (including intervals and qualifiers) into [time_min, time_max] epoch days.
 */
export function edtfToBounds(edtf: string | number | null | undefined): [number, number] | null {
  if (edtf === null || edtf === undefined || edtf === '') {
    return null;
  }
  const s = String(edtf).trim();
  if (!s) {
    return null;
  }
  if (s.includes('/')) {
    const idx = s.indexOf('/');
    const left = s.slice(0, idx);
    const right = s.slice(idx + 1);
    const lb = left ? edtfPartBounds(left) : null;
    const rb = right ? edtfPartBounds(right) : null;
    if (lb && rb) {
      return [Math.min(lb[0], rb[0]), Math.max(lb[1], rb[1])];
    }
    if (lb) {
      return [lb[0], lb[1] + 5 * 365];
    }
    if (rb) {
      return [rb[0] - 5 * 365, rb[1]];
    }
    return null;
  }
  return edtfPartBounds(s);
}

/**
 * Deterministic numeric sort key for an EDTF string (epoch-day start, or MAX_SAFE_INTEGER when undated).
 */
export function edtfSortKey(edtf: string | number | null | undefined): number {
  const bounds = edtfToBounds(edtf);
  return bounds ? bounds[0] : Number.MAX_SAFE_INTEGER;
}

/**
 * Format EDTF for compact human-readable display badges.
 */
export function formatEdtfDisplay(edtf: string | number | null | undefined): string {
  if (edtf === null || edtf === undefined || edtf === '') {
    return 'Undated';
  }
  const raw = String(edtf).trim();
  if (!raw) {
    return 'Undated';
  }
  if (raw.includes('/')) {
    const idx = raw.indexOf('/');
    const left = raw.slice(0, idx);
    const right = raw.slice(idx + 1);
    if (!left) {
      return `Bef. ${formatEdtfDisplay(right)}`;
    }
    if (!right) {
      return `Aft. ${formatEdtfDisplay(left)}`;
    }
    return `${formatEdtfDisplay(left)}–${formatEdtfDisplay(right)}`;
  }
  let prefix = '';
  let s = raw;
  if (s.endsWith('~')) {
    prefix = 'c. ';
    s = s.slice(0, -1);
  } else if (s.endsWith('?')) {
    prefix = 'est. ';
    s = s.slice(0, -1);
  }
  const mFull = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mFull) {
    const mo = Number(mFull[2]);
    if (mo >= 1 && mo <= 12) {
      return `${prefix}${MONTHS[mo - 1]} ${Number(mFull[3])}, ${mFull[1]}`;
    }
  }
  const mMonth = /^(\d{4})-(\d{2})$/.exec(s);
  if (mMonth) {
    const mo = Number(mMonth[2]);
    if (mo >= 1 && mo <= 12) {
      return `${prefix}${MONTHS[mo - 1]} ${mMonth[1]}`;
    }
  }
  return `${prefix}${s}`;
}

function parseSingleGedcomDate(text: string): string {
  const t = text.trim().toUpperCase();

  // Old Style split year: JAN 1620/1 -> 1621-01
  const mOs = /^(?:(\d{1,2})\s+)?([A-Z]{3,9})\s+(\d{4})\/(\d{1,2})$/.exec(t);
  if (mOs) {
    const mon = GEDCOM_MONTH_MAP[mOs[2]];
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
    const mon = GEDCOM_MONTH_MAP[mFull[2]];
    if (mon) {
      const y = Number(mFull[3]);
      const d = Math.min(Number(mFull[1]), lastDayOfMonth(y, mon));
      return `${mFull[3]}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // MON DD, YYYY
  const mUs = /^([A-Z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(t);
  if (mUs) {
    const mon = GEDCOM_MONTH_MAP[mUs[1]];
    if (mon) {
      const y = Number(mUs[3]);
      const d = Math.min(Number(mUs[2]), lastDayOfMonth(y, mon));
      return `${mUs[3]}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // MON YYYY
  const mMo = /^([A-Z]{3,9})\.?\s+(\d{4})$/.exec(t);
  if (mMo) {
    const mon = GEDCOM_MONTH_MAP[mMo[1]];
    if (mon) {
      return `${mMo[2]}-${String(mon).padStart(2, '0')}`;
    }
  }

  // ISO-like YYYY[-MM[-DD]]
  if (/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.test(t)) {
    return t;
  }

  const mYr = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(t);
  if (mYr) {
    return mYr[1];
  }
  return '';
}

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
  const up = s.toUpperCase();

  const mBet = /^BET\.?\s+(.+?)\s+AND\s+(.+)$/.exec(up);
  if (mBet) {
    const a = parseSingleGedcomDate(mBet[1]);
    const b = parseSingleGedcomDate(mBet[2]);
    if (a && b) {
      return `${a}/${b}`;
    }
    return a || b;
  }

  const mFrom = /^FROM\s+(.+?)\s+TO\s+(.+)$/.exec(up);
  if (mFrom) {
    const a = parseSingleGedcomDate(mFrom[1]);
    const b = parseSingleGedcomDate(mFrom[2]);
    if (a && b) {
      return `${a}/${b}`;
    }
    return a || b;
  }

  const mAbt = /^(?:ABT\.?|ABOUT|CA\.?|CIRCA|EST\.?|CAL\.?)\s+(.+)$/.exec(up);
  if (mAbt) {
    const base = parseSingleGedcomDate(mAbt[1]);
    return base ? `${base}~` : '';
  }

  const mBef = /^(?:BEF\.?|BEFORE)\s+(.+)$/.exec(up);
  if (mBef) {
    const base = parseSingleGedcomDate(mBef[1]);
    return base ? `/${base}` : '';
  }

  const mAft = /^(?:AFT\.?|AFTER)\s+(.+)$/.exec(up);
  if (mAft) {
    const base = parseSingleGedcomDate(mAft[1]);
    return base ? `${base}/` : '';
  }

  const mRng = /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(up);
  if (mRng) {
    return `${mRng[1]}/${mRng[2]}`;
  }

  return parseSingleGedcomDate(s);
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/**
 * Great-circle distance in statute miles between two latitude/longitude coordinates.
 */
export function haversineMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const earthRadiusMiles = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
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
