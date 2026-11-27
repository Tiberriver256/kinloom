import { describe, expect, it } from 'vitest';
import { isMoreThanOneYearAfter, isStrictlyAfterDate, maxPossibleAgeYears, parseEdtfRange } from './dates.js';

describe('treeHygiene dates (canonical @kinloom/core EDTF delegation)', () => {
  it('parses full, month, year, decade (192X), and qualified ([~?%]) EDTF dates', () => {
    expect(parseEdtfRange('1880-03-15')).toEqual({
      minYear: 1880,
      maxYear: 1880,
      minDate: { year: 1880, month: 3, day: 15 },
      maxDate: { year: 1880, month: 3, day: 15 },
    });

    expect(parseEdtfRange('1880-03~')).toEqual({
      minYear: 1880,
      maxYear: 1880,
      minDate: { year: 1880, month: 3, day: null },
      maxDate: { year: 1880, month: 3, day: null },
    });

    expect(parseEdtfRange('192X')).toEqual({
      minYear: 1920,
      maxYear: 1929,
      minDate: { year: 1920, month: null, day: null },
      maxDate: { year: 1929, month: null, day: null },
    });

    expect(parseEdtfRange('192X?')).toEqual({
      minYear: 1920,
      maxYear: 1929,
      minDate: { year: 1920, month: null, day: null },
      maxDate: { year: 1929, month: null, day: null },
    });

    expect(parseEdtfRange('1895%')).toEqual({
      minYear: 1895,
      maxYear: 1895,
      minDate: { year: 1895, month: null, day: null },
      maxDate: { year: 1895, month: null, day: null },
    });
  });

  it('parses open-ended (.. and empty) and decade intervals while rejecting invalid or inverted intervals', () => {
    expect(parseEdtfRange('../1900-06')).toEqual({
      minYear: null,
      maxYear: 1900,
      minDate: null,
      maxDate: { year: 1900, month: 6, day: null },
    });

    expect(parseEdtfRange('1880-04-12/..')).toEqual({
      minYear: 1880,
      maxYear: null,
      minDate: { year: 1880, month: 4, day: 12 },
      maxDate: null,
    });

    expect(parseEdtfRange('/1890')).toEqual({
      minYear: null,
      maxYear: 1890,
      minDate: null,
      maxDate: { year: 1890, month: null, day: null },
    });

    expect(parseEdtfRange('1880/')).toEqual({
      minYear: 1880,
      maxYear: null,
      minDate: { year: 1880, month: null, day: null },
      maxDate: null,
    });

    expect(parseEdtfRange('192X/193X')).toEqual({
      minYear: 1920,
      maxYear: 1939,
      minDate: { year: 1920, month: null, day: null },
      maxDate: { year: 1939, month: null, day: null },
    });

    expect(parseEdtfRange('../..')).toBeNull();
    expect(parseEdtfRange('1890/1880')).toBeNull();
  });

  it('falls back to edtfYear for loose single prose dates and supports chronological comparisons', () => {
    expect(parseEdtfRange('abt 1885')).toEqual({
      minYear: 1885,
      maxYear: 1885,
      minDate: { year: 1885, month: null, day: null },
      maxDate: { year: 1885, month: null, day: null },
    });
    expect(parseEdtfRange('')).toBeNull();
    expect(parseEdtfRange('undated')).toBeNull();

    const birth = parseEdtfRange('1880-06-15');
    const eventBeforeBirthday = parseEdtfRange('1900-06-10');
    const eventAfterDeath = parseEdtfRange('1902-01-01');
    expect(birth && eventBeforeBirthday && maxPossibleAgeYears(birth, eventBeforeBirthday)).toBe(19);
    expect(birth && eventBeforeBirthday && isStrictlyAfterDate(eventBeforeBirthday, birth)).toBe(true);
    expect(
      eventBeforeBirthday && eventAfterDeath && isMoreThanOneYearAfter(eventAfterDeath, eventBeforeBirthday)
    ).toBe(true);
  });
});
