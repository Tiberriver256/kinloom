import { type CommandParseSpec, formatCommandUsage, type OptionSpec } from '../../runtime/args.js';
import { DIGIHAKEMISTO_PRESETS } from './domain.js';

const CACHE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache for this request (the fresh result is still cached).',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168, env KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS; 0 disables reads).',
  },
];

export const PARISHES_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'query',
    kind: 'string',
    flags: ['--query', '-q'],
    help: 'Filter parish names or codes (Finnish or Swedish).',
  },
  { key: 'limit', kind: 'integer', flags: ['--limit'], help: 'Maximum parishes to display.' },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

export const HISKI_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'book',
    kind: 'string',
    flags: ['--book'],
    default: 'christened',
    help: 'Book type: christened|births, married|marriages, buried|burials, moved-in, moved-out, or all.',
  },
  {
    key: 'parish',
    kind: 'string',
    flags: ['--parish'],
    default: '*',
    help: "4-digit HisKi parish code, parish name, comma-separated codes, or '*' for all parishes.",
  },
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname'],
    help: 'Father / groom / person surname (isukunimi).',
  },
  {
    key: 'given',
    kind: 'string',
    flags: ['--given'],
    help: 'Child first name (christened) or person first name (other books).',
  },
  { key: 'fatherGiven', kind: 'string', flags: ['--father-given'], help: 'Father first name (ietunimi).' },
  {
    key: 'fatherPatronymic',
    kind: 'string',
    flags: ['--father-patronymic'],
    help: 'Father / person patronymic (ipatronyymi).',
  },
  {
    key: 'motherGiven',
    kind: 'string',
    flags: ['--mother-given'],
    help: 'Mother / bride / relative first name (aetunimi).',
  },
  {
    key: 'motherSurname',
    kind: 'string',
    flags: ['--mother-surname'],
    help: 'Mother / bride / relative surname (asukunimi).',
  },
  { key: 'village', kind: 'string', flags: ['--village'], help: 'Village or farm name (ikyla).' },
  { key: 'fromYear', kind: 'string', flags: ['--from-year', '--start-year'], help: 'Start year (YYYY).' },
  { key: 'toYear', kind: 'string', flags: ['--to-year', '--end-year'], help: 'End year (YYYY).' },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 30,
    help: 'Maximum records to return (1-1000, default 30).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

export const EVENT_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

export const ARCHIVES_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'preset',
    kind: 'string',
    flags: ['--preset'],
    choices: Object.keys(DIGIHAKEMISTO_PRESETS).toSorted(),
    help: 'Built-in query preset (parishes, henkikirjat, tax, court, inventories, say).',
  },
  {
    key: 'digitized',
    kind: 'boolean',
    flags: ['--digitized'],
    help: 'Show only archives marked as digitized.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 30,
    help: 'Maximum archive rows to return (default 30).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

export const ARCHIVE_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'digitized',
    kind: 'boolean',
    flags: ['--digitized'],
    help: 'Show only digitized child series/volumes.',
  },
  {
    key: 'limit',
    kind: 'integer',
    flags: ['--limit'],
    default: 50,
    help: 'Maximum child rows to return (default 50).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

export const URL_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'finna',
    kind: 'string',
    flags: ['--finna'],
    help: 'Finna browser search URL (Finna API is Cloudflare-challenged).',
  },
  {
    key: 'astia',
    kind: 'boolean',
    flags: ['--astia'],
    help: 'National Archives of Finland Astia search page.',
  },
  { key: 'hiski', kind: 'string', flags: ['--hiski'], help: 'HisKi portal or 4-digit parish page.' },
  { key: 'digihakemisto', kind: 'string', flags: ['--digihakemisto'], help: 'Digihakemisto home page.' },
  {
    key: 'digi',
    kind: 'string',
    flags: ['--digi'],
    help: 'National Library of Finland Digi newspapers search URL.',
  },
  {
    key: 'sshy',
    kind: 'boolean',
    flags: ['--sshy'],
    help: "Finland's Family History Association (SSHY) portal.",
  },
];

export const PARISHES_SPEC: CommandParseSpec = { options: PARISHES_OPTIONS, allowPositionals: false };
export const HISKI_SPEC: CommandParseSpec = { options: HISKI_OPTIONS, allowPositionals: false };
export const EVENT_SPEC: CommandParseSpec = {
  options: EVENT_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'event_ref',
};
export const ARCHIVES_SPEC: CommandParseSpec = {
  options: ARCHIVES_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};
export const ARCHIVE_SPEC: CommandParseSpec = {
  options: ARCHIVE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'archive_id',
};
export const URL_SPEC: CommandParseSpec = { options: URL_OPTIONS, allowPositionals: false };

export function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom fi-archives <command> [options]',
    summary: 'Search Finnish historical archives (HisKi parish registers & Digihakemisto/Astia index).',
    subcommands: [
      { name: 'parishes', summary: 'List or filter HisKi Finnish parishes and 4-digit codes.' },
      { name: 'hiski', summary: 'Search HisKi parish baptisms, marriages, burials, and moves.' },
      { name: 'event', summary: 'Inspect one HisKi event detail page (with SSHY scan link).' },
      { name: 'archives', summary: 'Search National Archives of Finland (Astia) via Digihakemisto.' },
      { name: 'archive', summary: 'Inspect one Digihakemisto/Astia archive series or volume list.' },
      {
        name: 'url',
        summary: 'Build verified browser URLs for Finna, Astia, HisKi, Digihakemisto, Digi, SSHY.',
      },
    ],
  });
}
