import { CliValidationError } from '../../errors.js';

export { DATES_HELP } from './help.js';

export const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

export const CALENDAR_SYSTEMS = ['julian', 'swedish', 'gregorian'] as const;
export type CalendarSystem = (typeof CALENDAR_SYSTEMS)[number];

export const CALENDAR_REGIONS = ['gb', 'se-fi', 'nl'] as const;
export type CalendarRegion = (typeof CALENDAR_REGIONS)[number];

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNIX_EPOCH_JDN = 2440588;

export interface CalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface CalendarDate extends CalendarDateParts {
  readonly iso: string;
  readonly epochDay: number;
}

export interface HistoricalCalendarDate extends CalendarDateParts {
  readonly calendar: CalendarSystem;
  readonly iso: string;
  readonly jdn: number;
}

export interface YearsMonthsDays {
  readonly years: number;
  readonly months: number;
  readonly days: number;
}

export interface DatesWeekdayResult {
  readonly subcommand: 'weekday';
  readonly date: string;
  readonly weekday: WeekdayName;
  readonly isoWeekday: number;
  readonly formatted: string;
  readonly isLeapYear: boolean;
  readonly rendered: string;
}

export interface DatesDiffResult {
  readonly subcommand: 'diff';
  readonly startDate: string;
  readonly endDate: string;
  readonly startWeekday: WeekdayName;
  readonly endWeekday: WeekdayName;
  readonly startFormatted: string;
  readonly endFormatted: string;
  readonly direction: 'forward' | 'same' | 'reversed';
  readonly reversed: boolean;
  readonly totalDays: number;
  readonly absDays: number;
  readonly years: number;
  readonly remainingDays: number;
  readonly yearsMonthsDays: YearsMonthsDays;
  readonly rendered: string;
}

export interface DatesAgeEntry {
  readonly at: string;
  readonly atWeekday: WeekdayName;
  readonly atFormatted: string;
  readonly beforeBirth: boolean;
  readonly years: number;
  readonly remainingDays: number;
  readonly totalDays: number;
  readonly yearsMonthsDays: YearsMonthsDays;
  readonly label: string;
}

export interface DatesAgeResult {
  readonly subcommand: 'age';
  readonly birthDate: string;
  readonly birthWeekday: WeekdayName;
  readonly birthFormatted: string;
  readonly ages: readonly DatesAgeEntry[];
  readonly rendered: string;
}

export interface DatesConvertResult {
  readonly subcommand: 'convert';
  readonly inputDate: string;
  readonly from: CalendarSystem;
  readonly to: CalendarSystem;
  readonly region: CalendarRegion | null;
  readonly convertedDate: string;
  readonly weekday: WeekdayName;
  readonly isoWeekday: number;
  readonly inputFormatted: string;
  readonly convertedFormatted: string;
  readonly jdn: number;
  readonly offsetDays: number;
  readonly transitionNote: string;
  readonly rendered: string;
}

export type DatesCommandOptions =
  | {
      readonly subcommand: 'weekday';
      readonly date: string;
      readonly json?: boolean;
    }
  | {
      readonly subcommand: 'diff';
      readonly startDate: string;
      readonly endDate: string;
      readonly json?: boolean;
    }
  | {
      readonly subcommand: 'age';
      readonly birthDate: string;
      readonly atDates: readonly string[];
      readonly json?: boolean;
    }
  | {
      readonly subcommand: 'convert';
      readonly date: string;
      readonly from: CalendarSystem;
      readonly to: CalendarSystem;
      readonly region?: CalendarRegion | undefined;
      readonly json?: boolean;
    };

export type DatesCommandResult = DatesWeekdayResult | DatesDiffResult | DatesAgeResult | DatesConvertResult;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isJulianLeapYear(year: number): boolean {
  return year % 4 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month] ?? 0;
}

export function daysInCalendarMonth(calendar: CalendarSystem, year: number, month: number): number {
  if (month < 1 || month > 12) {
    return 0;
  }
  if (month !== 2) {
    return DAYS_IN_MONTH[month] ?? 0;
  }
  if (calendar === 'gregorian') {
    return isLeapYear(year) ? 29 : 28;
  }
  if (calendar === 'julian') {
    return isJulianLeapYear(year) ? 29 : 28;
  }
  // Swedish transitional calendar (1700-1753):
  // - 1700 skipped Feb 29 (28 days)
  // - 1704 and 1708 observed Julian leap days (29 days)
  // - 1712 added double leap day Feb 30 to revert to Julian (30 days)
  // - 1753 skipped Feb 18-28 when adopting Gregorian on March 1 (17 days)
  if (year === 1700) {
    return 28;
  }
  if (year === 1712) {
    return 30;
  }
  if (year === 1753) {
    return 17;
  }
  return year < 1753 ? (isJulianLeapYear(year) ? 29 : 28) : isLeapYear(year) ? 29 : 28;
}

// Howard Hinnant's civil-from/to-days algorithm (proleptic Gregorian, exact integer UTC days since 1970-01-01).
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mPrime = month > 2 ? month - 3 : month + 9;
  const doy = Math.floor((153 * mPrime + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(epochDay: number): CalendarDateParts {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = y + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

export function gregorianToJdn(year: number, month: number, day: number): number {
  return daysFromCivil(year, month, day) + UNIX_EPOCH_JDN;
}

export function jdnToGregorian(jdn: number): CalendarDateParts {
  return civilFromDays(jdn - UNIX_EPOCH_JDN);
}

export function julianToJdn(year: number, month: number, day: number): number {
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - 32083;
}

export function jdnToJulian(jdn: number): CalendarDateParts {
  const c = jdn + 32082;
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  const day = e - Math.floor((153 * m + 2) / 5) + 1;
  const month = m + 3 - 12 * Math.floor(m / 10);
  const year = d - 4800 + Math.floor(m / 10);
  return { year, month, day };
}

const JDN_GREGORIAN_REFORM = gregorianToJdn(1582, 10, 15);
const JDN_NL_HOLLAND_ADOPTION = gregorianToJdn(1582, 12, 15);
const JDN_NL_ALL_PROVINCES_ADOPTION = gregorianToJdn(1701, 5, 12);
const JDN_GB_GREGORIAN_ADOPTION = gregorianToJdn(1752, 9, 14);
const JDN_SWEDISH_DRIFT_START = julianToJdn(1700, 2, 29); // Swedish 1700-03-01
const JDN_SWEDISH_FEB_30_1712 = julianToJdn(1712, 2, 29); // Swedish 1712-02-30
const JDN_SWEDISH_GREGORIAN_START = gregorianToJdn(1753, 3, 1); // Swedish 1753-03-01

export function swedishToJdn(year: number, month: number, day: number): number {
  if (year < 1700 || (year === 1700 && month <= 2)) {
    return julianToJdn(year, month, day);
  }
  if (year === 1712 && month === 2 && day === 30) {
    return JDN_SWEDISH_FEB_30_1712;
  }
  if (year < 1712 || (year === 1712 && month <= 2)) {
    return julianToJdn(year, month, day) - 1;
  }
  if (year < 1753 || (year === 1753 && month <= 2)) {
    return julianToJdn(year, month, day);
  }
  return gregorianToJdn(year, month, day);
}

export function jdnToSwedish(jdn: number): CalendarDateParts {
  if (jdn < JDN_SWEDISH_DRIFT_START) {
    return jdnToJulian(jdn);
  }
  if (jdn < JDN_SWEDISH_FEB_30_1712) {
    return jdnToJulian(jdn + 1);
  }
  if (jdn === JDN_SWEDISH_FEB_30_1712) {
    return { year: 1712, month: 2, day: 30 };
  }
  if (jdn < JDN_SWEDISH_GREGORIAN_START) {
    return jdnToJulian(jdn);
  }
  return jdnToGregorian(jdn);
}

export function calendarToJdn(calendar: CalendarSystem, year: number, month: number, day: number): number {
  switch (calendar) {
    case 'gregorian':
      return gregorianToJdn(year, month, day);
    case 'julian':
      return julianToJdn(year, month, day);
    case 'swedish':
      return swedishToJdn(year, month, day);
  }
}

export function jdnToCalendar(calendar: CalendarSystem, jdn: number): CalendarDateParts {
  switch (calendar) {
    case 'gregorian':
      return jdnToGregorian(jdn);
    case 'julian':
      return jdnToJulian(jdn);
    case 'swedish':
      return jdnToSwedish(jdn);
  }
}

function formatIsoParts(parts: CalendarDateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function makeCalendarDate(year: number, month: number, day: number): CalendarDate {
  return {
    iso: formatIsoParts({ year, month, day }),
    year,
    month,
    day,
    epochDay: daysFromCivil(year, month, day),
  };
}

export function parseCalendarDate(raw: string, label = 'date'): CalendarDate {
  const trimmed = raw.trim();
  const match = ISO_DATE_RE.exec(trimmed);
  if (!match) {
    throw new CliValidationError(`Invalid ${label} '${raw}'. Expected ISO calendar date YYYY-MM-DD.`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  if (year < 1 || month < 1 || month > 12) {
    throw new CliValidationError(`Invalid ${label} '${raw}'. Month must be 01..12 and year must be >= 0001.`);
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new CliValidationError(
      `Invalid ${label} '${raw}'. Day ${String(day).padStart(2, '0')} is out of range for ${match[1]}-${match[2]} (max ${maxDay}).`
    );
  }
  return makeCalendarDate(year, month, day);
}

export function parseHistoricalCalendarDate(
  raw: string,
  calendar: CalendarSystem,
  label = 'date'
): HistoricalCalendarDate {
  const trimmed = raw.trim();
  const match = ISO_DATE_RE.exec(trimmed);
  if (!match) {
    throw new CliValidationError(`Invalid ${label} '${raw}'. Expected ISO calendar date YYYY-MM-DD.`);
  }
  const year = Number.parseInt(match[1] ?? '', 10);
  const month = Number.parseInt(match[2] ?? '', 10);
  const day = Number.parseInt(match[3] ?? '', 10);
  if (year < 1 || month < 1 || month > 12) {
    throw new CliValidationError(`Invalid ${label} '${raw}'. Month must be 01..12 and year must be >= 0001.`);
  }
  const maxDay = daysInCalendarMonth(calendar, year, month);
  if (day < 1 || day > maxDay) {
    if (calendar === 'swedish' && year === 1753 && month === 2 && day >= 18 && day <= 28) {
      throw new CliValidationError(
        `Invalid ${label} '${raw}' for swedish calendar. Days 1753-02-18 through 1753-02-28 were skipped when Sweden switched to the Gregorian calendar (1753-02-17 -> 1753-03-01).`
      );
    }
    throw new CliValidationError(
      `Invalid ${label} '${raw}' for ${calendar} calendar. Day ${String(day).padStart(2, '0')} is out of range for ${match[1]}-${match[2]} (max ${maxDay}).`
    );
  }
  const jdn = calendarToJdn(calendar, year, month, day);
  return {
    calendar,
    iso: formatIsoParts({ year, month, day }),
    year,
    month,
    day,
    jdn,
  };
}

export function parseCalendarSystem(raw: string, flagName: string): CalendarSystem {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'julian' || normalized === 'swedish' || normalized === 'gregorian') {
    return normalized;
  }
  throw new CliValidationError(
    `Invalid ${flagName} calendar '${raw}'. Expected one of: julian, swedish, gregorian.`
  );
}

export function parseCalendarRegion(raw: string): CalendarRegion {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'gb' || normalized === 'se-fi' || normalized === 'nl') {
    return normalized;
  }
  throw new CliValidationError(`Invalid --region '${raw}'. Expected one of: gb, se-fi, nl.`);
}

export function getWeekdayNameFromJdn(jdn: number): WeekdayName {
  const idx = (((jdn + 1) % 7) + 7) % 7;
  return WEEKDAY_NAMES[idx] ?? 'Sunday';
}

export function getIsoWeekdayFromJdn(jdn: number): number {
  const sunIdx = (((jdn + 1) % 7) + 7) % 7;
  return sunIdx === 0 ? 7 : sunIdx;
}

export function getWeekdayName(date: CalendarDate): WeekdayName {
  // 1970-01-01 (epochDay 0) was Thursday (index 4 when Sunday = 0).
  const idx = (((date.epochDay + 4) % 7) + 7) % 7;
  return WEEKDAY_NAMES[idx] ?? 'Sunday';
}

export function getIsoWeekday(date: CalendarDate): number {
  const sunIdx = (((date.epochDay + 4) % 7) + 7) % 7;
  return sunIdx === 0 ? 7 : sunIdx;
}

export function formatLongDate(date: CalendarDate): string {
  const weekday = getWeekdayName(date);
  const monthName = MONTH_NAMES[date.month - 1];
  return `${weekday}, ${date.day} ${monthName} ${date.year}`;
}

export function formatHistoricalLongDate(parts: CalendarDateParts, jdn: number): string {
  const weekday = getWeekdayNameFromJdn(jdn);
  const monthName = MONTH_NAMES[parts.month - 1];
  return `${weekday}, ${parts.day} ${monthName} ${parts.year}`;
}

function lagBehindGregorian(calendar: CalendarSystem, jdn: number): number {
  if (calendar === 'gregorian') {
    return 0;
  }
  if (calendar === 'swedish') {
    if (jdn >= JDN_SWEDISH_GREGORIAN_START) {
      return 0;
    }
    if (jdn >= JDN_SWEDISH_DRIFT_START && jdn <= JDN_SWEDISH_FEB_30_1712) {
      return 10;
    }
    // Before 1700-03-01 or between 1712-03-01 and 1753-02-17, Swedish matched Julian.
    return lagBehindGregorian('julian', jdn);
  }
  const jul = jdnToJulian(jdn);
  if (jul.month === 2 && jul.day === 29 && !isLeapYear(jul.year)) {
    const greg = jdnToGregorian(jdn);
    return julianToJdn(greg.year, greg.month, greg.day) - jdn;
  }
  return jdn - gregorianToJdn(jul.year, jul.month, jul.day);
}

function buildSwedishTransitionNote(jdn: number): string {
  if (jdn < JDN_SWEDISH_DRIFT_START) {
    return 'Sweden/Finland (se-fi) used the Julian (OS) calendar through 1700-02-28 before skipping 1700-02-29 to start the 1700-1753 transitional calendar.';
  }
  if (jdn < JDN_SWEDISH_FEB_30_1712) {
    return 'Sweden/Finland (se-fi) 1700-1712 transitional calendar: 1700-02-29 was skipped while 1704 and 1708 kept leap days, placing Swedish dates 1 day ahead of Julian (OS) and 10 days behind Gregorian (NS).';
  }
  if (jdn === JDN_SWEDISH_FEB_30_1712) {
    return 'Sweden/Finland (se-fi) double leap day 1712-02-30: added by decree of Charles XII to revert to the Julian (OS) calendar on 1712-03-01 (equals Julian 1712-02-29 and Gregorian 1712-03-11).';
  }
  if (jdn < JDN_SWEDISH_GREGORIAN_START) {
    return 'Sweden/Finland (se-fi) used the Julian (OS) calendar from 1712-03-01 through 1753-02-17 (11 days behind Gregorian) before switching directly from 1753-02-17 to Gregorian 1753-03-01.';
  }
  return 'Sweden/Finland (se-fi) adopted the Gregorian (NS) calendar on 1753-03-01, skipping 1753-02-18 through 1753-02-28 immediately after 1753-02-17.';
}

function buildBritishTransitionNote(jdn: number, julianParts: CalendarDateParts): string {
  if (jdn < JDN_GB_GREGORIAN_ADOPTION) {
    const doubleDateHint =
      julianParts.year < 1752 && (julianParts.month < 3 || (julianParts.month === 3 && julianParts.day <= 24))
        ? ` Note: England/Wales and British colonies used Lady Day (25 March) as New Year's Day prior to 1752, so ${julianParts.year - 1}/${String(julianParts.year % 100).padStart(2, '0')} double-dating often appears in original records.`
        : '';
    return `Great Britain and British American colonies (gb) used the Julian (OS) calendar through Wednesday 1752-09-02 and switched directly to Thursday 1752-09-14 (Gregorian NS, skipping 11 days).${doubleDateHint}`;
  }
  return 'Great Britain and British American colonies (gb) used the Gregorian (NS) calendar from Thursday 1752-09-14 onward (immediately following Julian 1752-09-02).';
}

function buildDutchTransitionNote(jdn: number): string {
  if (jdn < JDN_NL_HOLLAND_ADOPTION) {
    return 'Dutch provinces (nl) used the Julian (OS) calendar prior to December 1582 (Holland, Zeeland, and Brabant adopted Gregorian in December 1582; northern/eastern provinces in 1700-1701).';
  }
  if (jdn < JDN_NL_ALL_PROVINCES_ADOPTION) {
    return 'Dutch Republic (nl) split-calendar era (1582-1701): Holland, Zeeland, and Brabant adopted Gregorian (NS) in December 1582, while Gelderland, Utrecht, Overijssel, Friesland, Groningen, and Drenthe remained on Julian (OS) until 1700-1701.';
  }
  return 'All provinces of the Dutch Republic (nl) used the Gregorian (NS) calendar by 1701 (Holland, Zeeland, and Brabant since December 1582; Gelderland, Utrecht, Overijssel, Friesland, Groningen, and Drenthe since 1700-1701).';
}

export function buildCalendarTransitionNote(
  jdn: number,
  from: CalendarSystem,
  to: CalendarSystem,
  region?: CalendarRegion
): string {
  if (region === 'se-fi') {
    return buildSwedishTransitionNote(jdn);
  }
  if (region === 'gb') {
    const base = buildBritishTransitionNote(jdn, jdnToJulian(jdn));
    if (from === 'swedish' || to === 'swedish') {
      return `${base} ${buildSwedishTransitionNote(jdn)}`;
    }
    return base;
  }
  if (region === 'nl') {
    const base = buildDutchTransitionNote(jdn);
    if (from === 'swedish' || to === 'swedish') {
      return `${base} ${buildSwedishTransitionNote(jdn)}`;
    }
    return base;
  }
  if (from === 'swedish' || to === 'swedish') {
    return buildSwedishTransitionNote(jdn);
  }
  if (jdn < JDN_GREGORIAN_REFORM) {
    return 'Proleptic Gregorian comparison before the initial Gregorian (NS) reform on Friday 1582-10-15 (following Julian Thursday 1582-10-04).';
  }
  const julianLag = lagBehindGregorian('julian', jdn);
  const signedLag = julianLag >= 0 ? `+${julianLag}` : String(julianLag);
  return `Julian (OS) to Gregorian (NS) offset is ${signedLag} days on this date; regional adoption dates varied (pass --region gb, se-fi, or nl for regional transition notes).`;
}

export function convertCalendarDate(
  rawDate: string,
  from: CalendarSystem,
  to: CalendarSystem,
  region?: CalendarRegion
): Omit<DatesConvertResult, 'subcommand' | 'rendered'> {
  const input = parseHistoricalCalendarDate(rawDate, from, 'date');
  const convertedParts = jdnToCalendar(to, input.jdn);
  const convertedDate = formatIsoParts(convertedParts);
  const weekday = getWeekdayNameFromJdn(input.jdn);
  const isoWeekday = getIsoWeekdayFromJdn(input.jdn);
  const offsetDays = lagBehindGregorian(from, input.jdn) - lagBehindGregorian(to, input.jdn);
  const transitionNote = buildCalendarTransitionNote(input.jdn, from, to, region);

  return {
    inputDate: input.iso,
    from,
    to,
    region: region ?? null,
    convertedDate,
    weekday,
    isoWeekday,
    inputFormatted: formatHistoricalLongDate(input, input.jdn),
    convertedFormatted: formatHistoricalLongDate(convertedParts, input.jdn),
    jdn: input.jdn,
    offsetDays,
    transitionNote,
  };
}

function anniversaryDate(start: CalendarDate, yearsOffset: number): CalendarDate {
  const targetYear = start.year + yearsOffset;
  if (start.month === 2 && start.day === 29 && !isLeapYear(targetYear)) {
    return makeCalendarDate(targetYear, 3, 1);
  }
  return makeCalendarDate(targetYear, start.month, start.day);
}

function addMonthsClamped(base: CalendarDate, monthsOffset: number): CalendarDate {
  const totalMonths = base.year * 12 + (base.month - 1) + monthsOffset;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const day = Math.min(base.day, daysInMonth(year, month));
  return makeCalendarDate(year, month, day);
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${Math.abs(count) === 1 ? '' : 's'}`;
}

function formatSignedOffsetDays(offsetDays: number): string {
  const sign = offsetDays > 0 ? '+' : '';
  return `${sign}${pluralize(offsetDays, 'day')}`;
}

export function computeDateDiff(
  start: CalendarDate,
  end: CalendarDate
): Omit<DatesDiffResult, 'subcommand' | 'rendered'> {
  const rawDays = end.epochDay - start.epochDay;
  const reversed = rawDays < 0;
  const direction: DatesDiffResult['direction'] = rawDays > 0 ? 'forward' : rawDays < 0 ? 'reversed' : 'same';
  const lo = reversed ? end : start;
  const hi = reversed ? start : end;
  const absDays = hi.epochDay - lo.epochDay;

  let years = hi.year - lo.year;
  let anniv = anniversaryDate(lo, years);
  if (anniv.epochDay > hi.epochDay) {
    years -= 1;
    anniv = anniversaryDate(lo, years);
  }
  const remainingDays = hi.epochDay - anniv.epochDay;

  let months = Math.min(11, (hi.year - anniv.year) * 12 + (hi.month - anniv.month));
  let monthAnchor = addMonthsClamped(anniv, months);
  if (monthAnchor.epochDay > hi.epochDay) {
    months -= 1;
    monthAnchor = addMonthsClamped(anniv, months);
  }
  const days = hi.epochDay - monthAnchor.epochDay;

  return {
    startDate: start.iso,
    endDate: end.iso,
    startWeekday: getWeekdayName(start),
    endWeekday: getWeekdayName(end),
    startFormatted: formatLongDate(start),
    endFormatted: formatLongDate(end),
    direction,
    reversed,
    totalDays: rawDays,
    absDays,
    years,
    remainingDays,
    yearsMonthsDays: { years, months, days },
  };
}

export function runDatesCommand(options: DatesCommandOptions): DatesCommandResult {
  switch (options.subcommand) {
    case 'weekday': {
      const parsed = parseCalendarDate(options.date, 'date');
      const base = {
        subcommand: 'weekday' as const,
        date: parsed.iso,
        weekday: getWeekdayName(parsed),
        isoWeekday: getIsoWeekday(parsed),
        formatted: formatLongDate(parsed),
        isLeapYear: isLeapYear(parsed.year),
      };
      const rendered = options.json ? JSON.stringify(base, null, 2) : base.formatted;
      return { ...base, rendered };
    }

    case 'diff': {
      const start = parseCalendarDate(options.startDate, 'start date');
      const end = parseCalendarDate(options.endDate, 'end date');
      const diff = computeDateDiff(start, end);
      const base = {
        subcommand: 'diff' as const,
        ...diff,
      };
      const signPrefix = diff.reversed ? '-' : '';
      const ymd = diff.yearsMonthsDays;
      const rendered = options.json
        ? JSON.stringify(base, null, 2)
        : `${signPrefix}${pluralize(diff.years, 'year')}, ${pluralize(diff.remainingDays, 'day')} ` +
          `(${diff.totalDays} total days; ${signPrefix}${ymd.years}y ${ymd.months}m ${ymd.days}d; ` +
          `${diff.startFormatted} -> ${diff.endFormatted})`;
      return { ...base, rendered };
    }

    case 'age': {
      const birth = parseCalendarDate(options.birthDate, 'birth date');
      if (options.atDates.length === 0) {
        throw new CliValidationError(
          'Missing event date for `kinloom dates age`. Pass `--at <YYYY-MM-DD>` or a positional `<YYYY-MM-DD>`.'
        );
      }
      const ages: DatesAgeEntry[] = options.atDates.map((rawAt, idx) => {
        const at = parseCalendarDate(rawAt, `event date #${idx + 1}`);
        const diff = computeDateDiff(birth, at);
        const beforeBirth = diff.reversed;
        const magnitudeLabel = `${pluralize(diff.years, 'year')}, ${pluralize(diff.remainingDays, 'day')} (${diff.totalDays} days)`;
        const label = beforeBirth ? `before birth (-${magnitudeLabel})` : magnitudeLabel;
        return {
          at: at.iso,
          atWeekday: diff.endWeekday,
          atFormatted: diff.endFormatted,
          beforeBirth,
          years: beforeBirth ? -diff.years : diff.years,
          remainingDays: diff.remainingDays,
          totalDays: diff.totalDays,
          yearsMonthsDays: diff.yearsMonthsDays,
          label,
        };
      });
      const base = {
        subcommand: 'age' as const,
        birthDate: birth.iso,
        birthWeekday: getWeekdayName(birth),
        birthFormatted: formatLongDate(birth),
        ages,
      };
      let rendered: string;
      if (options.json) {
        rendered = JSON.stringify(base, null, 2);
      } else if (ages.length === 1 && ages[0] !== undefined) {
        const entry = ages[0];
        rendered = `${base.birthFormatted} -> ${entry.atFormatted}: ${entry.label}`;
      } else {
        const lines = [`Birth: ${base.birthFormatted}`];
        for (const entry of ages) {
          lines.push(`  ${entry.at} (${entry.atWeekday}): ${entry.label}`);
        }
        rendered = lines.join('\n');
      }
      return { ...base, rendered };
    }

    case 'convert': {
      const from = parseCalendarSystem(options.from, '--from');
      const to = parseCalendarSystem(options.to, '--to');
      const region = options.region !== undefined ? parseCalendarRegion(options.region) : undefined;
      const converted = convertCalendarDate(options.date, from, to, region);
      const base = {
        subcommand: 'convert' as const,
        ...converted,
      };
      const rendered = options.json
        ? JSON.stringify(base, null, 2)
        : [
            `${base.inputDate} (${base.from}) -> ${base.convertedDate} (${base.to})`,
            `Weekday: ${base.weekday}`,
            `Offset: ${formatSignedOffsetDays(base.offsetDays)}`,
            `JDN: ${base.jdn}`,
            `Note: ${base.transitionNote}`,
          ].join('\n');
      return { ...base, rendered };
    }

    default: {
      const _exhaustive: never = options;
      throw new CliValidationError(`Unsupported dates subcommand: ${String(_exhaustive)}`);
    }
  }
}
