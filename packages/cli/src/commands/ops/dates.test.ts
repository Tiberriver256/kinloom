import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import { CliValidationError, EXIT_OK, EXIT_USAGE } from '../../errors.js';
import {
  buildCalendarTransitionNote,
  calendarToJdn,
  civilFromDays,
  convertCalendarDate,
  daysFromCivil,
  daysInCalendarMonth,
  daysInMonth,
  getIsoWeekday,
  getIsoWeekdayFromJdn,
  getWeekdayNameFromJdn,
  gregorianToJdn,
  isJulianLeapYear,
  isLeapYear,
  jdnToCalendar,
  jdnToGregorian,
  jdnToJulian,
  jdnToSwedish,
  julianToJdn,
  type OpsIo,
  parseCalendarDate,
  parseCalendarRegion,
  parseCalendarSystem,
  parseHistoricalCalendarDate,
  runDatesCommand,
  swedishToJdn,
} from './index.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: OpsIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

afterEach(async () => {
  delete process.env['KINLOOM_TELEMETRY_FILE'];
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('ops/dates historical JDN arithmetic and convert command', () => {
  it('maintains exact JDN round-trip bijections for Gregorian, Julian, and Swedish calendars', () => {
    // 1970-01-01 Gregorian is JDN 2440588 (Thursday)
    expect(gregorianToJdn(1970, 1, 1)).toBe(2440588);
    expect(jdnToGregorian(2440588)).toEqual({ year: 1970, month: 1, day: 1 });
    expect(civilFromDays(daysFromCivil(2000, 2, 29))).toEqual({ year: 2000, month: 2, day: 29 });

    // Papal Gregorian reform boundary: Julian 1582-10-04 (Thu) -> Gregorian 1582-10-15 (Fri)
    expect(julianToJdn(1582, 10, 4)).toBe(2299160);
    expect(gregorianToJdn(1582, 10, 15)).toBe(2299161);
    expect(getWeekdayNameFromJdn(2299160)).toBe('Thursday');
    expect(getWeekdayNameFromJdn(2299161)).toBe('Friday');
    expect(getIsoWeekdayFromJdn(2299160)).toBe(4);
    expect(getIsoWeekdayFromJdn(2299161)).toBe(5);
    expect(getIsoWeekdayFromJdn(gregorianToJdn(2026, 11, 29))).toBe(7); // Sunday -> ISO 7

    // Exhaustive day-by-day bijection across the entire Swedish 1700-1753 transitional era
    const startJdn = gregorianToJdn(1699, 12, 1);
    const endJdn = gregorianToJdn(1754, 1, 1);
    let sawFeb30 = false;
    let saw1700Feb29 = false;
    let saw1753SkippedDay = false;

    for (let jdn = startJdn; jdn <= endJdn; jdn += 1) {
      const greg = jdnToGregorian(jdn);
      expect(gregorianToJdn(greg.year, greg.month, greg.day)).toBe(jdn);

      const jul = jdnToJulian(jdn);
      expect(julianToJdn(jul.year, jul.month, jul.day)).toBe(jdn);

      const swe = jdnToSwedish(jdn);
      expect(swedishToJdn(swe.year, swe.month, swe.day)).toBe(jdn);
      expect(calendarToJdn('swedish', swe.year, swe.month, swe.day)).toBe(jdn);
      expect(jdnToCalendar('swedish', jdn)).toEqual(swe);

      if (swe.year === 1712 && swe.month === 2 && swe.day === 30) {
        sawFeb30 = true;
      }
      if (swe.year === 1700 && swe.month === 2 && swe.day === 29) {
        saw1700Feb29 = true;
      }
      if (swe.year === 1753 && swe.month === 2 && swe.day >= 18) {
        saw1753SkippedDay = true;
      }
    }

    expect(sawFeb30).toBe(true);
    expect(saw1700Feb29).toBe(false);
    expect(saw1753SkippedDay).toBe(false);
  });

  it('converts Julian (OS) to Gregorian (NS) across 1600s (+10d), 1700s (+11d), and 1800s (+12d)', () => {
    // 1600s: +10 days
    const c1650 = convertCalendarDate('1650-06-15', 'julian', 'gregorian');
    expect(c1650).toMatchObject({
      inputDate: '1650-06-15',
      from: 'julian',
      to: 'gregorian',
      convertedDate: '1650-06-25',
      weekday: 'Saturday',
      isoWeekday: 6,
      offsetDays: 10,
      region: null,
    });

    // Reverse 1600s: -10 days
    const r1650 = convertCalendarDate('1650-06-25', 'gregorian', 'julian');
    expect(r1650).toMatchObject({
      convertedDate: '1650-06-15',
      weekday: 'Saturday',
      offsetDays: -10,
    });

    // 1700 leap-day drift boundary
    const feb28 = convertCalendarDate('1700-02-28', 'julian', 'gregorian');
    expect(feb28).toMatchObject({
      convertedDate: '1700-03-10',
      weekday: 'Wednesday',
      offsetDays: 10,
    });

    const feb29 = convertCalendarDate('1700-02-29', 'julian', 'gregorian');
    expect(feb29).toMatchObject({
      convertedDate: '1700-03-11',
      weekday: 'Thursday',
      offsetDays: 11,
    });

    const mar01 = convertCalendarDate('1700-03-01', 'julian', 'gregorian');
    expect(mar01).toMatchObject({
      convertedDate: '1700-03-12',
      weekday: 'Friday',
      offsetDays: 11,
    });

    // Reverse from Gregorian 1700-03-11 to Julian 1700-02-29
    const revFeb29 = convertCalendarDate('1700-03-11', 'gregorian', 'julian');
    expect(revFeb29).toMatchObject({
      convertedDate: '1700-02-29',
      weekday: 'Thursday',
      offsetDays: -11,
    });

    // 1800s: +12 days (including Julian 1800-02-29)
    const c1800 = convertCalendarDate('1800-02-29', 'julian', 'gregorian');
    expect(c1800).toMatchObject({
      convertedDate: '1800-03-12',
      offsetDays: 12,
    });

    // Pre-1582 proleptic Gregorian note and identity conversion
    const pre1582 = convertCalendarDate('1500-05-01', 'julian', 'gregorian');
    expect(pre1582.convertedDate).toBe('1500-05-11');
    expect(pre1582.transitionNote).toContain('1582-10-15');

    const identity = convertCalendarDate('1752-09-14', 'gregorian', 'gregorian');
    expect(identity.convertedDate).toBe('1752-09-14');
    expect(identity.offsetDays).toBe(0);
  });

  it('handles British/American 1752 transition and Lady Day double-dating notes (--region gb)', () => {
    // Last Julian day in Great Britain: Wednesday 1752-09-02 (OS) = 1752-09-13 (NS)
    const lastOs = convertCalendarDate('1752-09-02', 'julian', 'gregorian', 'gb');
    expect(lastOs).toMatchObject({
      convertedDate: '1752-09-13',
      weekday: 'Wednesday',
      offsetDays: 11,
      region: 'gb',
    });
    expect(lastOs.transitionNote).toContain('1752-09-02');
    expect(lastOs.transitionNote).toContain('1752-09-14');

    // First Gregorian day in Great Britain: Thursday 1752-09-14 (NS) = 1752-09-03 (OS)
    const firstNs = convertCalendarDate('1752-09-14', 'gregorian', 'julian', 'gb');
    expect(firstNs).toMatchObject({
      convertedDate: '1752-09-03',
      weekday: 'Thursday',
      offsetDays: -11,
      region: 'gb',
    });
    expect(firstNs.jdn).toBe(lastOs.jdn + 1);
    expect(firstNs.transitionNote).toContain('1752-09-14');

    // George Washington: 1732-02-11 (OS, Friday) -> 1732-02-22 (NS, Friday) with Lady Day double-dating note
    const washington = convertCalendarDate('1732-02-11', 'julian', 'gregorian', 'gb');
    expect(washington).toMatchObject({
      convertedDate: '1732-02-22',
      weekday: 'Friday',
      offsetDays: 11,
    });
    expect(washington.transitionNote).toContain('Lady Day');
    expect(washington.transitionNote).toContain('1731/32');

    // March 20 (< 25 March) triggers Lady Day double-dating; March 25 does not
    const mar20 = convertCalendarDate('1732-03-20', 'julian', 'gregorian', 'gb');
    expect(mar20.transitionNote).toContain('Lady Day');
    const mar25 = convertCalendarDate('1732-03-25', 'julian', 'gregorian', 'gb');
    expect(mar25.transitionNote).not.toContain('Lady Day');
  });

  it('handles Dutch (--region nl) 1582 and 1700-1701 provincial transition notes', () => {
    const pre1582 = convertCalendarDate('1580-06-01', 'julian', 'gregorian', 'nl');
    expect(pre1582.transitionNote).toContain('December 1582');

    const splitEra = convertCalendarDate('1650-06-15', 'julian', 'gregorian', 'nl');
    expect(splitEra.convertedDate).toBe('1650-06-25');
    expect(splitEra.offsetDays).toBe(10);
    expect(splitEra.transitionNote).toContain('Holland, Zeeland, and Brabant');
    expect(splitEra.transitionNote).toContain('1700-1701');

    const post1701 = convertCalendarDate('1725-04-10', 'gregorian', 'julian', 'nl');
    expect(post1701.convertedDate).toBe('1725-03-30');
    expect(post1701.offsetDays).toBe(-11);
    expect(post1701.transitionNote).toContain('All provinces of the Dutch Republic');
  });

  it('handles all Swedish (se-fi) 1700-1753 calendar boundaries including 1712-02-30 and 1753-02-17 -> 1753-03-01', () => {
    // 1700-02-28 (Swedish = Julian) -> 1700-03-10 (Gregorian)
    const beforeDrift = convertCalendarDate('1700-02-28', 'swedish', 'gregorian', 'se-fi');
    expect(beforeDrift).toMatchObject({
      convertedDate: '1700-03-10',
      weekday: 'Wednesday',
      offsetDays: 10,
    });
    expect(beforeDrift.transitionNote).toContain('1700-02-29');

    // 1700-03-01 (Swedish, after skipping 1700-02-29) -> Julian 1700-02-29 & Gregorian 1700-03-11
    const driftStartGreg = convertCalendarDate('1700-03-01', 'swedish', 'gregorian');
    expect(driftStartGreg).toMatchObject({
      convertedDate: '1700-03-11',
      weekday: 'Thursday',
      offsetDays: 10,
    });
    expect(driftStartGreg.jdn).toBe(beforeDrift.jdn + 1);

    const driftStartJul = convertCalendarDate('1700-03-01', 'swedish', 'julian');
    expect(driftStartJul).toMatchObject({
      convertedDate: '1700-02-29',
      weekday: 'Thursday',
      offsetDays: -1,
    });

    // 1704 and 1708 leap days kept in Sweden
    expect(convertCalendarDate('1704-02-29', 'swedish', 'gregorian')).toMatchObject({
      convertedDate: '1704-03-10',
      offsetDays: 10,
    });
    expect(convertCalendarDate('1708-02-29', 'swedish', 'julian')).toMatchObject({
      convertedDate: '1708-02-28',
      offsetDays: -1,
    });

    // 1712-02-29 Swedish -> 1712-02-28 Julian / 1712-03-10 Gregorian
    const feb29_1712 = convertCalendarDate('1712-02-29', 'swedish', 'gregorian');
    expect(feb29_1712).toMatchObject({
      convertedDate: '1712-03-10',
      weekday: 'Thursday',
      offsetDays: 10,
    });

    // 1712-02-30 Swedish double leap day -> 1712-02-29 Julian / 1712-03-11 Gregorian (Friday)
    const feb30Greg = convertCalendarDate('1712-02-30', 'swedish', 'gregorian', 'se-fi');
    expect(feb30Greg).toMatchObject({
      inputDate: '1712-02-30',
      convertedDate: '1712-03-11',
      weekday: 'Friday',
      isoWeekday: 5,
      inputFormatted: 'Friday, 30 February 1712',
      convertedFormatted: 'Friday, 11 March 1712',
      offsetDays: 10,
    });
    expect(feb30Greg.jdn).toBe(feb29_1712.jdn + 1);
    expect(feb30Greg.transitionNote).toContain('1712-02-30');

    const feb30Jul = convertCalendarDate('1712-02-30', 'swedish', 'julian');
    expect(feb30Jul).toMatchObject({
      convertedDate: '1712-02-29',
      weekday: 'Friday',
      offsetDays: -1,
    });

    // Reverse conversions into Swedish 1712-02-30
    expect(convertCalendarDate('1712-03-11', 'gregorian', 'swedish')).toMatchObject({
      convertedDate: '1712-02-30',
      weekday: 'Friday',
      offsetDays: -10,
    });
    expect(convertCalendarDate('1712-02-29', 'julian', 'swedish')).toMatchObject({
      convertedDate: '1712-02-30',
      weekday: 'Friday',
      offsetDays: 1,
    });

    // 1712-03-01 Swedish reverted to Julian (0d vs Julian, +11d vs Gregorian)
    const mar01_1712 = convertCalendarDate('1712-03-01', 'swedish', 'gregorian');
    expect(mar01_1712).toMatchObject({
      convertedDate: '1712-03-12',
      weekday: 'Saturday',
      offsetDays: 11,
    });
    expect(mar01_1712.jdn).toBe(feb30Greg.jdn + 1);
    expect(convertCalendarDate('1712-03-01', 'swedish', 'julian')).toMatchObject({
      convertedDate: '1712-03-01',
      offsetDays: 0,
    });

    // 1753-02-17 Swedish -> 1753-02-28 Gregorian (Wednesday), followed directly by 1753-03-01 (Thursday)
    const lastSweJul = convertCalendarDate('1753-02-17', 'swedish', 'gregorian', 'se-fi');
    expect(lastSweJul).toMatchObject({
      convertedDate: '1753-02-28',
      weekday: 'Wednesday',
      offsetDays: 11,
    });
    expect(lastSweJul.transitionNote).toContain('1753-02-17');

    const firstSweGreg = convertCalendarDate('1753-03-01', 'swedish', 'gregorian', 'se-fi');
    expect(firstSweGreg).toMatchObject({
      convertedDate: '1753-03-01',
      weekday: 'Thursday',
      offsetDays: 0,
    });
    expect(firstSweGreg.jdn).toBe(lastSweJul.jdn + 1);
    expect(firstSweGreg.transitionNote).toContain('1753-03-01');

    const firstSweToJul = convertCalendarDate('1753-03-01', 'swedish', 'julian');
    expect(firstSweToJul).toMatchObject({
      convertedDate: '1753-02-18',
      weekday: 'Thursday',
      offsetDays: -11,
    });

    // Combined region + swedish calendar notes
    const gbAndSwe = buildCalendarTransitionNote(feb30Greg.jdn, 'swedish', 'gregorian', 'gb');
    expect(gbAndSwe).toContain('Great Britain');
    expect(gbAndSwe).toContain('1712-02-30');
    const nlAndSwe = buildCalendarTransitionNote(feb30Greg.jdn, 'swedish', 'gregorian', 'nl');
    expect(nlAndSwe).toContain('Dutch Republic');
    expect(nlAndSwe).toContain('1712-02-30');
  });

  it('validates invalid calendar dates cleanly across Julian, Swedish, and Gregorian systems', () => {
    // 1700-02-29: valid in Julian, rejected in Swedish and Gregorian
    expect(parseHistoricalCalendarDate('1700-02-29', 'julian').iso).toBe('1700-02-29');
    expect(() => parseHistoricalCalendarDate('1700-02-29', 'swedish')).toThrow(CliValidationError);
    expect(() => parseHistoricalCalendarDate('1700-02-29', 'gregorian')).toThrow(CliValidationError);

    // 1712-02-30: valid ONLY in Swedish, rejected in Julian and Gregorian
    expect(parseHistoricalCalendarDate('1712-02-30', 'swedish').iso).toBe('1712-02-30');
    expect(() => parseHistoricalCalendarDate('1712-02-30', 'julian')).toThrow(CliValidationError);
    expect(() => parseHistoricalCalendarDate('1712-02-30', 'gregorian')).toThrow(CliValidationError);

    // 1753-02-18..1753-02-28: skipped in Swedish, valid in Julian and Gregorian
    expect(() => parseHistoricalCalendarDate('1753-02-18', 'swedish')).toThrow(/skipped/i);
    expect(() => parseHistoricalCalendarDate('1753-02-28', 'swedish')).toThrow(/skipped/i);
    expect(parseHistoricalCalendarDate('1753-02-18', 'julian').iso).toBe('1753-02-18');
    expect(parseHistoricalCalendarDate('1753-02-28', 'gregorian').iso).toBe('1753-02-28');

    // Swedish post-1753 century non-leap year 1800 rejects Feb 29, while 1600 accepts it
    expect(daysInCalendarMonth('swedish', 1600, 2)).toBe(29);
    expect(daysInCalendarMonth('swedish', 1800, 2)).toBe(28);
    expect(daysInCalendarMonth('swedish', 2000, 2)).toBe(29);
    expect(daysInCalendarMonth('swedish', 1753, 2)).toBe(17);
    expect(daysInCalendarMonth('gregorian', 2024, 0)).toBe(0);
    expect(daysInCalendarMonth('gregorian', 2024, 13)).toBe(0);
    expect(daysInMonth(2024, 13)).toBe(0);
    expect(isLeapYear(1900)).toBe(false);
    expect(isJulianLeapYear(1900)).toBe(true);

    // Malformed strings and out-of-range year/month
    expect(() => parseHistoricalCalendarDate('not-a-date', 'julian')).toThrow(CliValidationError);
    expect(() => parseHistoricalCalendarDate('0000-01-01', 'julian')).toThrow(CliValidationError);
    expect(() => parseHistoricalCalendarDate('1700-13-01', 'julian')).toThrow(CliValidationError);
    expect(() => parseCalendarDate('bad-date')).toThrow(CliValidationError);
    expect(() => parseCalendarDate('0000-01-01')).toThrow(CliValidationError);
    expect(() => parseCalendarDate('2024-00-10')).toThrow(CliValidationError);
    expect(() => parseCalendarDate('2024-02-30')).toThrow(CliValidationError);

    // Invalid calendar system / region parsers
    expect(parseCalendarSystem('JULIAN', '--from')).toBe('julian');
    expect(parseCalendarRegion('SE-FI')).toBe('se-fi');
    expect(() => parseCalendarSystem('hebrew', '--from')).toThrow(CliValidationError);
    expect(() => parseCalendarRegion('fr')).toThrow(CliValidationError);
  });

  it('renders text and JSON outputs for convert, weekday, diff, and age subcommands', () => {
    const convertText = runDatesCommand({
      subcommand: 'convert',
      date: '1752-09-02',
      from: 'julian',
      to: 'gregorian',
      region: 'gb',
    });
    expect(convertText.subcommand).toBe('convert');
    expect(convertText.rendered).toContain('1752-09-02 (julian) -> 1752-09-13 (gregorian)');
    expect(convertText.rendered).toContain('Weekday: Wednesday');
    expect(convertText.rendered).toContain('Offset: +11 days');
    expect(convertText.rendered).toContain('JDN:');
    expect(convertText.rendered).toContain('Note:');

    const convertSingularOffset = runDatesCommand({
      subcommand: 'convert',
      date: '1712-02-30',
      from: 'swedish',
      to: 'julian',
    });
    expect(convertSingularOffset.rendered).toContain('Offset: -1 day');
    expect(convertSingularOffset.rendered).not.toContain('-1 days');

    const convertJson = runDatesCommand({
      subcommand: 'convert',
      date: '1712-02-30',
      from: 'swedish',
      to: 'gregorian',
      region: 'se-fi',
      json: true,
    });
    const parsedJson = JSON.parse(convertJson.rendered) as Record<string, unknown>;
    expect(parsedJson['convertedDate']).toBe('1712-03-11');
    expect(parsedJson['weekday']).toBe('Friday');
    expect(parsedJson['offsetDays']).toBe(10);

    // Exercise weekday text/JSON, diff forward/reversed/same/leap/JSON, and age single/multi/beforeBirth/JSON
    const weekdayText = runDatesCommand({ subcommand: 'weekday', date: '1898-02-07' });
    expect(weekdayText.rendered).toBe('Monday, 7 February 1898');
    const weekdayJson = runDatesCommand({ subcommand: 'weekday', date: '2026-11-29', json: true });
    expect(JSON.parse(weekdayJson.rendered)).toMatchObject({ weekday: 'Sunday', isoWeekday: 7 });
    expect(getIsoWeekday(parseCalendarDate('2026-11-29'))).toBe(7);

    const sameDiff = runDatesCommand({
      subcommand: 'diff',
      startDate: '1900-01-01',
      endDate: '1900-01-01',
    });
    expect(sameDiff.subcommand === 'diff' && sameDiff.direction).toBe('same');

    const reversedDiff = runDatesCommand({
      subcommand: 'diff',
      startDate: '1905-02-28',
      endDate: '1904-02-29',
      json: true,
    });
    expect(JSON.parse(reversedDiff.rendered)).toMatchObject({
      direction: 'reversed',
      reversed: true,
      years: 0,
      remainingDays: 365,
    });

    const singleAge = runDatesCommand({
      subcommand: 'age',
      birthDate: '1900-01-01',
      atDates: ['1901-01-02'],
    });
    expect(singleAge.rendered).toContain('1 year, 1 day');

    const multiAgeText = runDatesCommand({
      subcommand: 'age',
      birthDate: '1900-01-01',
      atDates: ['1901-01-01', '1899-01-01'],
    });
    expect(multiAgeText.rendered).toContain('Birth: Monday, 1 January 1900');
    expect(multiAgeText.rendered).toContain('before birth');

    const ageJson = runDatesCommand({
      subcommand: 'age',
      birthDate: '1900-01-01',
      atDates: ['1901-01-01'],
      json: true,
    });
    expect(JSON.parse(ageJson.rendered)).toMatchObject({ birthDate: '1900-01-01' });

    expect(() => runDatesCommand({ subcommand: 'age', birthDate: '1900-01-01', atDates: [] })).toThrow(
      CliValidationError
    );
  });

  it('dispatches kinloom dates convert via runCli and validates CLI flags and errors', async () => {
    const tmp = await makeTempDir('kinloom-dates-convert-cli-');
    process.env['KINLOOM_TELEMETRY_FILE'] = path.join(tmp, 'telemetry.jsonl');

    // Valid JSON invocation
    const jsonCap = createCaptureIo();
    const jsonCode = await runCli(
      [
        'dates',
        'convert',
        '1712-02-30',
        '--from',
        'swedish',
        '--to',
        'gregorian',
        '--region',
        'se-fi',
        '--json',
      ],
      { io: jsonCap.io }
    );
    expect(jsonCode).toBe(EXIT_OK);
    expect(JSON.parse(jsonCap.stdout.join('\n'))).toMatchObject({
      subcommand: 'convert',
      inputDate: '1712-02-30',
      convertedDate: '1712-03-11',
      weekday: 'Friday',
      offsetDays: 10,
      region: 'se-fi',
    });

    // Valid text invocation
    const textCap = createCaptureIo();
    const textCode = await runCli(
      ['dates', 'convert', '1752-09-02', '--from', 'julian', '--to', 'gregorian', '--region', 'gb'],
      { io: textCap.io }
    );
    expect(textCode).toBe(EXIT_OK);
    expect(textCap.stdout.join('\n')).toContain('1752-09-02 (julian) -> 1752-09-13 (gregorian)');

    // CLI error cases
    const errorCases: Array<[string[], string]> = [
      [['dates', 'bogus'], "Unknown dates subcommand 'bogus'"],
      [['dates', 'convert'], 'Usage: kinloom dates convert'],
      [
        ['dates', 'convert', '1752-09-02', '--to', 'gregorian'],
        'Missing required option `--from <julian|swedish|gregorian>`',
      ],
      [
        ['dates', 'convert', '1752-09-02', '--from', 'julian'],
        'Missing required option `--to <gregorian|julian|swedish>`',
      ],
      [
        ['dates', 'convert', '1752-09-02', '--from', 'mayan', '--to', 'gregorian'],
        "Invalid --from calendar 'mayan'",
      ],
      [
        ['dates', 'convert', '1752-09-02', '--from', 'julian', '--to', 'roman'],
        "Invalid --to calendar 'roman'",
      ],
      [
        ['dates', 'convert', '1752-09-02', '--from', 'julian', '--to', 'gregorian', '--region', 'de'],
        "Invalid --region 'de'",
      ],
      [
        ['dates', 'convert', '1752-09-02', '--from', 'julian', '--to', 'gregorian', '--at', '1760-01-01'],
        'Option `--at` is only valid with `kinloom dates age`.',
      ],
      [
        ['dates', 'weekday', '1752-09-02', '--from', 'julian'],
        'Options `--from`, `--to`, and `--region` are only valid with `kinloom dates convert`.',
      ],
      [['dates', 'convert', '1700-02-29', '--from', 'swedish', '--to', 'gregorian'], 'out of range'],
      [['dates', 'convert', '1712-02-30', '--from', 'julian', '--to', 'gregorian'], 'out of range'],
      [['dates', 'convert', '1753-02-20', '--from', 'swedish', '--to', 'gregorian'], 'skipped'],
    ];

    for (const [args, expectedError] of errorCases) {
      const cap = createCaptureIo();
      const code = await runCli(args, { io: cap.io });
      expect(code).toBe(EXIT_USAGE);
      expect(cap.stderr.join('\n')).toContain(expectedError);
    }
  });
});
