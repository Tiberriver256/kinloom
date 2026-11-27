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

/**
 * Convert epoch days (days since 1970-01-01) back to a proleptic Gregorian calendar year without `Date`.
 */
export function epochDaysToYear(epochDays: number): number {
  const j = Math.floor(epochDays) + EPOCH_JDN;
  const f = j + 1401 + Math.floor((Math.floor((4 * j + 274277) / 146097) * 3) / 4) - 38;
  const e = 4 * f + 3;
  const g = Math.floor((e % 1461) / 4);
  const h = 5 * g + 2;
  const month = ((Math.floor(h / 153) + 2) % 12) + 1;
  return Math.floor(e / 1461) - 4716 + Math.floor((12 + 2 - month) / 12);
}

export function lastDayOfMonth(year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 31;
  }
  const safeYear = Math.max(year, 1);
  return new Date(Date.UTC(safeYear, month, 0)).getUTCDate();
}
