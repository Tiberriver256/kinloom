import type { ParsedDatePart, ParsedEdtfRange } from './types.js';

export function parseDatePart(raw: string): ParsedDatePart | null {
  const clean = raw.trim().replaceAll(/[~?%]+$/g, '');
  if (!clean) {
    return null;
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (full) {
    return {
      year: Number(full[1]),
      month: Number(full[2]),
      day: Number(full[3]),
    };
  }
  const monthOnly = /^(\d{4})-(\d{2})$/.exec(clean);
  if (monthOnly) {
    return {
      year: Number(monthOnly[1]),
      month: Number(monthOnly[2]),
      day: null,
    };
  }
  const yearOnly = /^(\d{4})$/.exec(clean);
  if (yearOnly) {
    return {
      year: Number(yearOnly[1]),
      month: null,
      day: null,
    };
  }
  const decade = /^(\d{3})X$/i.exec(clean);
  if (decade) {
    return {
      year: Number(decade[1]) * 10,
      month: null,
      day: null,
    };
  }
  const fallback = /\b(1[4-9]\d{2}|20\d{2})\b/.exec(clean);
  if (fallback) {
    return {
      year: Number(fallback[1]),
      month: null,
      day: null,
    };
  }
  return null;
}

export function parseEdtfRange(edtf: string | null | undefined): ParsedEdtfRange | null {
  if (!edtf) {
    return null;
  }
  const trimmed = edtf.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes('/')) {
    const slash = trimmed.indexOf('/');
    const leftRaw = trimmed.slice(0, slash).trim();
    const rightRaw = trimmed.slice(slash + 1).trim();
    const left = leftRaw ? parseDatePart(leftRaw) : null;
    const right = rightRaw ? parseDatePart(rightRaw) : null;
    if (!left && !right) {
      return null;
    }
    return {
      minYear: left?.year ?? null,
      maxYear: right?.year ?? null,
      minDate: left,
      maxDate: right,
    };
  }
  const decade = /^(\d{3})X$/i.exec(trimmed.replaceAll(/[~?%]+$/g, ''));
  if (decade) {
    const startYear = Number(decade[1]) * 10;
    return {
      minYear: startYear,
      maxYear: startYear + 9,
      minDate: { year: startYear, month: null, day: null },
      maxDate: { year: startYear + 9, month: null, day: null },
    };
  }
  const single = parseDatePart(trimmed);
  if (!single) {
    return null;
  }
  return {
    minYear: single.year,
    maxYear: single.year,
    minDate: single,
    maxDate: single,
  };
}

export function maxPossibleAgeYears(birth: ParsedEdtfRange, target: ParsedEdtfRange): number | null {
  if (birth.minYear === null || target.maxYear === null) {
    return null;
  }
  const b = birth.minDate;
  const t = target.maxDate;
  if (b && t && b.month !== null && t.month !== null) {
    let years = t.year - b.year;
    if (t.month < b.month) {
      years -= 1;
    } else if (t.month === b.month && b.day !== null && t.day !== null && t.day < b.day) {
      years -= 1;
    }
    return years;
  }
  return target.maxYear - birth.minYear;
}

export function isStrictlyAfterDate(later: ParsedEdtfRange, earlier: ParsedEdtfRange): boolean {
  if (later.minYear === null || earlier.maxYear === null) {
    return false;
  }
  if (later.minYear > earlier.maxYear) {
    return true;
  }
  if (later.minYear < earlier.maxYear) {
    return false;
  }
  const l = later.minDate;
  const e = earlier.maxDate;
  if (!l || !e || l.month === null || e.month === null) {
    return false;
  }
  if (l.month > e.month) {
    return true;
  }
  if (l.month < e.month) {
    return false;
  }
  if (l.day !== null && e.day !== null) {
    return l.day > e.day;
  }
  return false;
}

export function isMoreThanOneYearAfter(later: ParsedEdtfRange, earlier: ParsedEdtfRange): boolean {
  if (later.minYear === null || earlier.maxYear === null) {
    return false;
  }
  const yearDiff = later.minYear - earlier.maxYear;
  if (yearDiff > 1) {
    return true;
  }
  if (yearDiff < 1) {
    return false;
  }
  const l = later.minDate;
  const e = earlier.maxDate;
  if (!l || !e || l.month === null || e.month === null) {
    return false;
  }
  if (l.month > e.month) {
    return true;
  }
  if (l.month < e.month) {
    return false;
  }
  if (l.day !== null && e.day !== null) {
    return l.day > e.day;
  }
  return false;
}
