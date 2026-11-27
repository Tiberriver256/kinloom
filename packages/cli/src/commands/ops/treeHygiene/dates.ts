import { edtfYear, type ParsedEdtfInterval, parseEdtfInterval } from '@kinloom/core';
import type { ParsedDatePart, ParsedEdtfRange } from './types.js';

function intervalEndpointToDatePart(interval: ParsedEdtfInterval, bound: 'min' | 'max'): ParsedDatePart {
  if (interval.precision === 'decade') {
    return {
      year: bound === 'max' ? interval.year + 9 : interval.year,
      month: null,
      day: null,
    };
  }
  return {
    year: interval.year,
    month: interval.month,
    day: interval.day,
  };
}

export function parseEdtfRange(edtf: string | null | undefined): ParsedEdtfRange | null {
  if (!edtf) {
    return null;
  }
  const trimmed = edtf.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = parseEdtfInterval(trimmed);
  if (parsed) {
    const slash = trimmed.indexOf('/');
    if (slash === -1) {
      const minDate = intervalEndpointToDatePart(parsed, 'min');
      const maxDate = intervalEndpointToDatePart(parsed, 'max');
      return {
        minYear: minDate.year,
        maxYear: maxDate.year,
        minDate,
        maxDate,
      };
    }

    const leftParsed = Number.isFinite(parsed.startMs) ? parseEdtfInterval(trimmed.slice(0, slash)) : null;
    const rightParsed = Number.isFinite(parsed.endMs) ? parseEdtfInterval(trimmed.slice(slash + 1)) : null;
    const minDate = leftParsed ? intervalEndpointToDatePart(leftParsed, 'min') : null;
    const maxDate = rightParsed ? intervalEndpointToDatePart(rightParsed, 'max') : null;
    return {
      minYear: minDate?.year ?? null,
      maxYear: maxDate?.year ?? null,
      minDate,
      maxDate,
    };
  }

  if (trimmed.includes('/')) {
    return null;
  }

  const fallbackYear = edtfYear(trimmed);
  if (fallbackYear === null) {
    return null;
  }
  const fallbackPart: ParsedDatePart = { year: fallbackYear, month: null, day: null };
  return {
    minYear: fallbackYear,
    maxYear: fallbackYear,
    minDate: fallbackPart,
    maxDate: fallbackPart,
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
