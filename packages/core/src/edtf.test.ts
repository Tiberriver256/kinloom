import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  daysSinceEpoch,
  edtfSortKey,
  edtfToBounds,
  edtfYear,
  formatEdtfDisplay,
  haversineMiles,
  intervalsOverlap,
  lastDayOfMonth,
  parseGedcomDateToEdtf,
  toJulianDayNumber,
} from './edtf.js';

describe('edtf utilities', () => {
  it('computes proleptic Gregorian epoch days matching Julian Day Number', () => {
    expect(toJulianDayNumber(1970, 1, 1)).toBe(2440588);
    expect(daysSinceEpoch(1970, 1, 1)).toBe(0);
    expect(daysSinceEpoch(1970, 1, 2)).toBe(1);
    expect(daysSinceEpoch(1969, 12, 31)).toBe(-1);
    expect(daysSinceEpoch(1850, 6, 15)).toBe(-43664);
    expect(lastDayOfMonth(2000, 2)).toBe(29);
    expect(lastDayOfMonth(1900, 2)).toBe(28);
  });

  it('parses exact, approximate, uncertain, decade, and interval EDTF bounds', () => {
    expect(edtfToBounds('1852-09-09')).toEqual([
      daysSinceEpoch(1852, 9, 9),
      daysSinceEpoch(1852, 9, 9),
    ]);
    expect(edtfToBounds('1852-09-09~')).toEqual([
      daysSinceEpoch(1852, 9, 9) - 365,
      daysSinceEpoch(1852, 9, 9) + 365,
    ]);
    expect(edtfToBounds('1852-09-09?')).toEqual([
      daysSinceEpoch(1852, 9, 9) - 30,
      daysSinceEpoch(1852, 9, 9) + 30,
    ]);
    expect(edtfToBounds('189X')).toEqual([
      daysSinceEpoch(1890, 1, 1),
      daysSinceEpoch(1899, 12, 31),
    ]);
    expect(edtfToBounds('1850/1860')).toEqual([
      daysSinceEpoch(1850, 1, 1),
      daysSinceEpoch(1860, 12, 31),
    ]);
    expect(edtfToBounds('/1850')).toEqual([
      daysSinceEpoch(1850, 1, 1) - 5 * 365,
      daysSinceEpoch(1850, 12, 31),
    ]);
    expect(edtfToBounds('1850/')).toEqual([
      daysSinceEpoch(1850, 1, 1),
      daysSinceEpoch(1850, 12, 31) + 5 * 365,
    ]);
    expect(edtfToBounds('')).toBeNull();
    expect(edtfSortKey('')).toBe(Number.MAX_SAFE_INTEGER);
    expect(edtfSortKey('1850') < edtfSortKey('1851')).toBe(true);
  });

  it('formats EDTF strings for compact display badges', () => {
    expect(formatEdtfDisplay('')).toBe('Undated');
    expect(formatEdtfDisplay('1852-09-09')).toBe('Sep 9, 1852');
    expect(formatEdtfDisplay('1882-10')).toBe('Oct 1882');
    expect(formatEdtfDisplay('1850~')).toBe('c. 1850');
    expect(formatEdtfDisplay('1850?')).toBe('est. 1850');
    expect(formatEdtfDisplay('/1850')).toBe('Bef. 1850');
    expect(formatEdtfDisplay('1850/')).toBe('Aft. 1850');
    expect(formatEdtfDisplay('1850/1860')).toBe('1850–1860');
  });

  it('converts GEDCOM date syntax including Old Style split years to EDTF', () => {
    expect(parseGedcomDateToEdtf('14 FEB 1880')).toBe('1880-02-14');
    expect(parseGedcomDateToEdtf('Feb 14, 1880')).toBe('1880-02-14');
    expect(parseGedcomDateToEdtf('ABT 1825')).toBe('1825~');
    expect(parseGedcomDateToEdtf('BEF 1890')).toBe('/1890');
    expect(parseGedcomDateToEdtf('AFT 1750')).toBe('1750/');
    expect(parseGedcomDateToEdtf('BET 1840 AND 1845')).toBe('1840/1845');
    expect(parseGedcomDateToEdtf('FROM 1910 TO 1920')).toBe('1910/1920');
    expect(parseGedcomDateToEdtf('JAN 1620/1')).toBe('1621-01');
    expect(parseGedcomDateToEdtf('31 FEB 1880')).toBe('1880-02-29');
    expect(edtfYear('1880-02-14')).toBe(1880);
    expect(edtfYear('1200')).toBeNull();
  });

  it('checks interval overlap and great-circle haversine distance', () => {
    expect(intervalsOverlap(10, 20, 20, 30)).toBe(true);
    expect(intervalsOverlap(10, 20, 25, 30, 0)).toBe(false);
    expect(intervalsOverlap(10, 20, 25, 30, 5)).toBe(true);
    expect(intervalsOverlap(null, 20, 15, 25)).toBe(false);
    expect(haversineMiles(40, -75, 40, -75)).toBe(0);
    expect(Math.round(haversineMiles(40.7128, -74.006, 42.3601, -71.0589))).toBe(190);
  });

  it('property: edtfToBounds always yields min <= max and monotonic year sort keys', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1500, max: 2050 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 31 }),
        fc.constantFrom('', '~', '?'),
        (y, m, d, qual) => {
          const edtf = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}${qual}`;
          const bounds = edtfToBounds(edtf);
          expect(bounds).not.toBeNull();
          if (bounds) {
            expect(bounds[0]).toBeLessThanOrEqual(bounds[1]);
          }
          expect(edtfYear(edtf)).toBe(y);
          expect(formatEdtfDisplay(edtf).length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('property: haversineMiles is symmetric and non-negative', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -89, max: 89, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -89, max: 89, noNaN: true }),
        fc.double({ min: -179, max: 179, noNaN: true }),
        (lat1, lng1, lat2, lng2) => {
          const d1 = haversineMiles(lat1, lng1, lat2, lng2);
          const d2 = haversineMiles(lat2, lng2, lat1, lng1);
          expect(d1).toBeGreaterThanOrEqual(0);
          expect(Math.abs(d1 - d2)).toBeLessThan(1e-6);
        }
      ),
      { numRuns: 100 }
    );
  });
});
