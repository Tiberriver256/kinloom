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

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDate {
  readonly iso: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly epochDay: number;
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
    };

export type DatesCommandResult = DatesWeekdayResult | DatesDiffResult | DatesAgeResult;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month] ?? 0;
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

function makeCalendarDate(year: number, month: number, day: number): CalendarDate {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    iso,
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
    throw new CliValidationError(
      `Invalid ${label} '${raw}'. Expected ISO calendar date YYYY-MM-DD.`
    );
  }
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  if (year < 1 || month < 1 || month > 12) {
    throw new CliValidationError(
      `Invalid ${label} '${raw}'. Month must be 01..12 and year must be >= 0001.`
    );
  }
  const maxDay = daysInMonth(year, month);
  if (day < 1 || day > maxDay) {
    throw new CliValidationError(
      `Invalid ${label} '${raw}'. Day ${String(day).padStart(2, '0')} is out of range for ${match[1]}-${match[2]} (max ${maxDay}).`
    );
  }
  return makeCalendarDate(year, month, day);
}

export function getWeekdayName(date: CalendarDate): WeekdayName {
  // 1970-01-01 (epochDay 0) was Thursday (index 4 when Sunday = 0).
  const idx = (((date.epochDay + 4) % 7) + 7) % 7;
  return WEEKDAY_NAMES[idx];
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
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

export function computeDateDiff(
  start: CalendarDate,
  end: CalendarDate
): Omit<DatesDiffResult, 'subcommand' | 'rendered'> {
  const rawDays = end.epochDay - start.epochDay;
  const reversed = rawDays < 0;
  const direction: DatesDiffResult['direction'] =
    rawDays > 0 ? 'forward' : rawDays < 0 ? 'reversed' : 'same';
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
      } else if (ages.length === 1) {
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

    default: {
      const _exhaustive: never = options;
      throw new CliValidationError(`Unsupported dates subcommand: ${String(_exhaustive)}`);
    }
  }
}
