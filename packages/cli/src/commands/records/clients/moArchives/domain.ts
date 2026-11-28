import path from 'node:path';
import { z } from 'zod';
import { resolveCacheDir } from '../../runtime/cache.js';
import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import { resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const BASE = 'https://s1.sos.mo.gov';
export const DEATH_PAGE = `${BASE}/records/Archives/ArchivesMvc/DeathCertificates/`;
export const DEATH_POST = `${BASE}/Records/Archives/ArchivesMvc/`;
export const DEATH_RESULTS = `${BASE}/Records/Archives/ArchivesMvc/DeathCertificates/Results`;
export const PRE1910_PAGE = `${BASE}/records/archives/ArchivesMVC/birthdeath/`;
export const PRE1910_POST = `${BASE}/Records/Archives/ArchivesMvc/BirthDeath`;
export const PRE1910_RESULTS = `${BASE}/Records/Archives/ArchivesMvc/birthdeath/Results`;
export const PRE1910_DETAIL = `${BASE}/records/archives/ArchivesMVC/birthdeath/Detail`;
export const MDH_HOME = 'https://www.sos.mo.gov/mdh';
export const MDH_SEARCH = 'https://mdh.deepwebaccess.com/mdh/';
export const ARCHIVES_HOME = 'https://www.sos.mo.gov/archives';

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const ALLOWED_HOSTS = ['s1.sos.mo.gov', 'www.sos.mo.gov'] as const;

export const ALL_COUNTIES = '-- Search All --';
export const ALL_COUNTIES_PRE1910 = '-- All Counties --';
export const MATCH_METHODS: Readonly<Record<string, string>> = {
  contains: 'Contains',
  'starts-with': 'StartsWith',
  'ends-with': 'EndsWith',
};

export const ROLE_CHOICES = ['deceased', 'spouse', 'father', 'mother'] as const;
export const MATCH_CHOICES = ['contains', 'starts-with', 'ends-with'] as const;
export const PRE1910_TYPE_CHOICES = ['birth', 'death'] as const;

export interface ParsedCell {
  readonly text: string;
  readonly hrefs: readonly string[];
}

export interface DeathRecord {
  readonly name: string;
  readonly deceased?: string | undefined;
  readonly spouse?: string | undefined;
  readonly father?: string | undefined;
  readonly mother?: string | undefined;
  readonly age: string;
  readonly date_of_death: string;
  readonly county: string;
  readonly cert: string;
  readonly ssn4: string;
  readonly image: string;
}

export interface Pre1910DeathRecord {
  readonly name: string;
  readonly age: string;
  readonly sex: string;
  readonly color: string;
  readonly date_of_death: string;
  readonly county: string;
  readonly detail_id: string;
  readonly detail_url: string;
}

export interface Pre1910BirthRecord {
  readonly name: string;
  readonly place: string;
  readonly county: string;
  readonly date_of_birth: string;
  readonly father: string;
  readonly mother: string;
  readonly attendant: string;
  readonly detail_id: string;
  readonly detail_url: string;
}

export type Pre1910Record = Pre1910DeathRecord | Pre1910BirthRecord;

export interface SearchCachePayload<T> {
  readonly total: number;
  readonly results: readonly T[];
  readonly verified: boolean;
}

export interface DetailRecord {
  readonly id: string;
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
}

export function getMoCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_MO_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-mo-archives',
  });
}

export function resolveMoTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_MO_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export function parseTables(html: string): ParsedCell[][][] {
  const $ = loadHtml(html);
  const tables: ParsedCell[][][] = [];
  $('table').each((_tIdx, tableEl) => {
    const rows: ParsedCell[][] = [];
    $(tableEl)
      .find('tr')
      .each((_rIdx, trEl) => {
        const row: ParsedCell[] = [];
        $(trEl)
          .find('td, th')
          .each((_cIdx, cellEl) => {
            const cell = $(cellEl);
            const hrefs: string[] = [];
            cell.find('a[href]').each((_aIdx, aEl) => {
              const href = $(aEl).attr('href');
              if (href) {
                hrefs.push(href);
              }
            });
            const clone = cell.clone();
            clone.find('br, li, p, div').before(' ');
            row.push({ text: collapseWhitespace(clone.text()), hrefs });
          });
        if (row.length > 0) {
          rows.push(row);
        }
      });
    tables.push(rows);
  });
  return tables;
}

export function findResultsTable(
  html: string,
  headerMarkers: readonly string[]
): readonly [readonly string[] | null, readonly (readonly ParsedCell[])[]] {
  for (const table of parseTables(html)) {
    if (table.length === 0) {
      continue;
    }
    const header = (table[0] ?? []).map((c) => c.text);
    const joined = header.join(' ');
    if (headerMarkers.some((m) => joined.includes(m))) {
      return [header, table.slice(1)];
    }
  }
  return [null, []];
}

export function totalResults(html: string): number | null {
  const match = /Showing records \d+ to \d+ of (\d+)/.exec(html);
  return match ? Number.parseInt(match[1] ?? '', 10) : null;
}

export function extractFormToken(html: string): string | null {
  const $ = loadHtml(html);
  const inputVal = $('input[name="__ncforminfo"]').attr('value');
  if (inputVal) {
    return inputVal;
  }
  const match = /name="__ncforminfo"\s+value="([^"]+)"/.exec(html);
  return match?.[1] ?? null;
}

export function parseDeathName(text: string): {
  name: string;
  deceased?: string;
  spouse?: string;
  father?: string;
  mother?: string;
} {
  const cleaned = collapseWhitespace(text);
  const parts = cleaned.split(/\s+-\s+(Deceased|Spouse|Father|Mother)\s*/);
  const roles: Partial<Record<'deceased' | 'spouse' | 'father' | 'mother', string>> = {};
  for (let i = 1; i < parts.length; i += 2) {
    const person = collapseWhitespace(parts[i - 1] ?? '');
    const role = (parts[i] ?? '').toLowerCase();
    if (person && (role === 'deceased' || role === 'spouse' || role === 'father' || role === 'mother')) {
      roles[role] = person;
    }
  }
  const name = roles.deceased ?? collapseWhitespace(parts[0] ?? '');
  return { ...roles, name };
}

export function parseDeathRows(html: string): DeathRecord[] {
  const [, rows] = findResultsTable(html, ['Date of Death']);
  const out: DeathRecord[] = [];
  for (const row of rows) {
    const cells = row.map((c) => c.text);
    if (cells.length < 5 || !cells[0]) {
      continue;
    }
    const nameInfo = parseDeathName(cells[0]);
    const imgHref = row[6]?.hrefs[0] ?? '';
    out.push({
      ...nameInfo,
      age: cells[1] ?? '',
      date_of_death: cells[2] ?? '',
      county: cells[3] ?? '',
      cert: cells[4] ?? '',
      ssn4: cells[5] ?? '',
      image: imgHref ? new URL(imgHref, BASE).toString() : '',
    });
  }
  return out;
}

export function parsePre1910Rows(html: string, kind: 'birth' | 'death'): Pre1910Record[] {
  const [, rows] = findResultsTable(html, kind === 'death' ? ['Date Of Death'] : ['Date Of Birth']);
  const out: Pre1910Record[] = [];
  for (const row of rows) {
    const cells = row.map((c) => c.text);
    if (cells.length === 0 || !cells[0]) {
      continue;
    }
    const lastCell = row.at(-1);
    const detailHref = lastCell?.hrefs[0] ?? '';
    const idMatch = /id=(\d+)/.exec(detailHref);
    const detailId = idMatch?.[1] ?? '';
    const detailUrl = detailHref ? new URL(detailHref, PRE1910_PAGE).toString() : '';

    if (kind === 'death') {
      out.push({
        name: cells[0],
        age: cells[1] ?? '',
        sex: cells[2] ?? '',
        color: cells[3] ?? '',
        date_of_death: cells[4] ?? '',
        county: cells[5] ?? '',
        detail_id: detailId,
        detail_url: detailUrl,
      });
    } else {
      out.push({
        name: cells[0],
        place: cells[1] ?? '',
        county: cells[2] ?? '',
        date_of_birth: cells[3] ?? '',
        father: cells[4] ?? '',
        mother: cells[5] ?? '',
        attendant: cells[6] ?? '',
        detail_id: detailId,
        detail_url: detailUrl,
      });
    }
  }
  return out;
}

export function parseDetailFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const notes: string[] = [];
  for (const table of parseTables(html)) {
    const rows = table.map((r) => r.map((c) => c.text));
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      if (row === undefined) continue;
      if (row.length === 1) {
        if (row[0] && row[0] !== 'NOTE') {
          notes.push(row[0]);
        }
        i += 1;
        continue;
      }
      const nextRow = rows[i + 1];
      if (nextRow && nextRow.length === row.length) {
        for (let col = 0; col < row.length; col += 1) {
          const key = row[col];
          if (key) {
            fields[key] = nextRow[col] ?? '';
          }
        }
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  if (notes.length > 0) {
    fields['notes'] = notes.join('; ');
  }
  return fields;
}

export function safePdfFilename(rawUrl: string): string {
  try {
    const pathname = new URL(rawUrl).pathname;
    const base = path.posix.basename(pathname);
    const sanitized = base.replace(/[^A-Za-z0-9._-]+/g, '_');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
      return 'certificate.pdf';
    }
    return sanitized;
  } catch {
    return 'certificate.pdf';
  }
}

const DeathRecordSchema = z.object({
  name: z.string(),
  deceased: z.string().optional(),
  spouse: z.string().optional(),
  father: z.string().optional(),
  mother: z.string().optional(),
  age: z.string(),
  date_of_death: z.string(),
  county: z.string(),
  cert: z.string(),
  ssn4: z.string(),
  image: z.string(),
}) satisfies z.ZodType<DeathRecord>;

const Pre1910DeathRecordSchema = z.object({
  name: z.string(),
  age: z.string(),
  sex: z.string(),
  color: z.string(),
  date_of_death: z.string(),
  county: z.string(),
  detail_id: z.string(),
  detail_url: z.string(),
}) satisfies z.ZodType<Pre1910DeathRecord>;

const Pre1910BirthRecordSchema = z.object({
  name: z.string(),
  place: z.string(),
  county: z.string(),
  date_of_birth: z.string(),
  father: z.string(),
  mother: z.string(),
  attendant: z.string(),
  detail_id: z.string(),
  detail_url: z.string(),
}) satisfies z.ZodType<Pre1910BirthRecord>;

const Pre1910RecordSchema = z.union([
  Pre1910DeathRecordSchema,
  Pre1910BirthRecordSchema,
]) satisfies z.ZodType<Pre1910Record>;

const DeathSearchCachePayloadSchema = z.object({
  total: z.number(),
  results: z.array(DeathRecordSchema),
  verified: z.boolean(),
}) satisfies z.ZodType<SearchCachePayload<DeathRecord>>;

const Pre1910SearchCachePayloadSchema = z.object({
  total: z.number(),
  results: z.array(Pre1910RecordSchema),
  verified: z.boolean(),
}) satisfies z.ZodType<SearchCachePayload<Pre1910Record>>;

const DetailRecordSchema = z.object({
  id: z.string(),
  url: z.string(),
  fields: z.record(z.string(), z.string()),
}) satisfies z.ZodType<DetailRecord>;

export function isDeathSearchCachePayload(value: unknown): value is SearchCachePayload<DeathRecord> {
  return DeathSearchCachePayloadSchema.safeParse(value).success;
}

export function isPre1910SearchCachePayload(value: unknown): value is SearchCachePayload<Pre1910Record> {
  return Pre1910SearchCachePayloadSchema.safeParse(value).success;
}

export function isDetailRecord(value: unknown): value is DetailRecord {
  return DetailRecordSchema.safeParse(value).success;
}
