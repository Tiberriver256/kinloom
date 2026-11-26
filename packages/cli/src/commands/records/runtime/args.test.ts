import { describe, expect, it } from 'vitest';
import { CliValidationError } from '../../../errors.js';
import {
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringListOption,
  getStringOption,
  normalizeCommaSplitArgs,
  parseCommandArgs,
  resolveSubcommandAlias,
  type CommandParseSpec,
} from './args.js';

describe('records runtime args parser', () => {
  const sampleSpec: CommandParseSpec = {
    options: [
      { key: 'limit', kind: 'integer', flags: ['--limit', '--rows', '-n'], min: 1, max: 100, default: 20 },
      { key: 'score', kind: 'number', flags: ['--score'], min: 0 },
      { key: 'format', kind: 'string', flags: ['--format', '-f'], choices: ['json', 'text'], default: 'text' },
      { key: 'tag', kind: 'string', flags: ['--tag', '-t'], multiple: true },
      { key: 'json', kind: 'boolean', flags: ['--json', '-j'] },
      { key: 'exact', kind: 'boolean', flags: ['--exact'], negatable: true, default: false },
      { key: 'verbose', kind: 'boolean', flags: ['-v'] },
    ],
    allowPositionals: true,
    minPositionals: 0,
    commaSplitFlags: ['--box', '--pages'],
  };

  it('parses aliases, short flags, equals syntax, repeatable options, and negatable booleans', () => {
    const parsed = parseCommandArgs(
      [
        '--rows',
        '15',
        '--format=json',
        '-t',
        'census',
        '--tag=birth',
        '-vj',
        '--exact',
        '--score',
        '0.75',
        'Abraham',
        'Lincoln',
      ],
      sampleSpec
    );
    expect(parsed.helpRequested).toBe(false);
    expect(getNumberOption(parsed, 'limit')).toBe(15);
    expect(getNumberOption(parsed, 'score')).toBe(0.75);
    expect(getStringOption(parsed, 'format')).toBe('json');
    expect(getStringListOption(parsed, 'tag')).toEqual(['census', 'birth']);
    expect(getBooleanOption(parsed, 'json')).toBe(true);
    expect(getBooleanOption(parsed, 'verbose')).toBe(true);
    expect(getBooleanOption(parsed, 'exact')).toBe(true);
    expect(parsed.positionals).toEqual(['Abraham', 'Lincoln']);

    const negated = parseCommandArgs(['--exact', '--no-exact'], sampleSpec);
    expect(getBooleanOption(negated, 'exact')).toBe(false);
  });

  it('supports short flags with attached values and -- separator', () => {
    const parsed = parseCommandArgs(['-n10', '-f=json', '--', '--not-a-flag', '-5'], sampleSpec);
    expect(getNumberOption(parsed, 'limit')).toBe(10);
    expect(getStringOption(parsed, 'format')).toBe('json');
    expect(parsed.positionals).toEqual(['--not-a-flag', '-5']);
  });

  it('detects --help and -h immediately', () => {
    expect(parseCommandArgs(['--help'], sampleSpec).helpRequested).toBe(true);
    expect(parseCommandArgs(['-h'], sampleSpec).helpRequested).toBe(true);
    expect(parseCommandArgs(['-vh'], sampleSpec).helpRequested).toBe(true);
  });

  it('throws CliValidationError (exit 2) for invalid values, ranges, choices, and unknown flags', () => {
    expect(() => parseCommandArgs(['--limit', '0'], sampleSpec)).toThrow(CliValidationError);
    expect(() => parseCommandArgs(['--limit', 'abc'], sampleSpec)).toThrow(CliValidationError);
    expect(() => parseCommandArgs(['--format', 'xml'], sampleSpec)).toThrow(CliValidationError);
    expect(() => parseCommandArgs(['--unknown'], sampleSpec)).toThrow(CliValidationError);
    expect(() => parseCommandArgs(['--limit'], sampleSpec)).toThrow(CliValidationError);
  });

  it('normalizes shell-split comma arguments for listed flags', () => {
    expect(
      normalizeCommaSplitArgs(
        ['--box', '10,', '20,', '30,', '40', '--pages=1-3,', '5', 'scan.jpg'],
        new Set(['--box', '--pages'])
      )
    ).toEqual(['--box', '10,20,30,40', '--pages=1-3,5', 'scan.jpg']);
  });

  it('resolves subcommand aliases and formats usage text', () => {
    expect(resolveSubcommandAlias('show', { show: 'get', metadata: 'get' })).toBe('get');
    expect(resolveSubcommandAlias('SEARCH', { show: 'get' })).toBe('search');

    const usage = formatCommandUsage({
      usage: 'kinloom sample [options]',
      summary: 'Run sample search.',
      options: sampleSpec.options,
      subcommands: [{ name: 'search', summary: 'Search records' }],
    });
    expect(usage).toContain('Usage: kinloom sample [options]');
    expect(usage).toContain('--exact, --no-exact');
    expect(usage).toContain('search');
  });
});
