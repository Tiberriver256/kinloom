import fs from 'node:fs';
import { resolveCacheDir } from '../../runtime/cache.js';
import { unzipEntries } from '../../runtime/parse.js';
import { resolveEnvCacheTtlHours, resolveSafeChildPath } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';

export const S3_BASE = 'https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames';
export const SEARCH_APP = 'https://edits.nationalmap.gov/apps/gaz-domestic/public/search/names';
export const DEFAULT_QUERY_TTL_HOURS = 720;

export const GNIS_STATE_CODES: ReadonlySet<string> = new Set([
  'AK',
  'AL',
  'AR',
  'AS',
  'AZ',
  'CA',
  'CO',
  'CT',
  'DC',
  'DE',
  'FL',
  'GA',
  'GU',
  'HI',
  'IA',
  'ID',
  'IL',
  'IN',
  'KS',
  'KY',
  'LA',
  'MA',
  'MD',
  'ME',
  'MI',
  'MN',
  'MO',
  'MP',
  'MS',
  'MT',
  'NC',
  'ND',
  'NE',
  'NH',
  'NJ',
  'NM',
  'NV',
  'NY',
  'OH',
  'OK',
  'OR',
  'PA',
  'PR',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VA',
  'VI',
  'VT',
  'WA',
  'WI',
  'WV',
  'WY',
]);

export type GnisRow = Record<string, string>;

export interface GnisCompactFeature {
  readonly feature_id: string | null;
  readonly feature_name: string | null;
  readonly feature_class: string | null;
  readonly state: string | null;
  readonly county: string | null;
  readonly map_name: string | null;
  readonly latitude: string | null;
  readonly longitude: string | null;
  readonly date_created: string | null;
  readonly date_edited: string | null;
}

export interface GnisSearchPayload {
  readonly source: string;
  readonly matches: number;
  readonly results: GnisCompactFeature[];
}

export interface GnisQueryParams {
  readonly name: string;
  readonly state: string | null;
  readonly exact: boolean;
  readonly feature_class: string | null;
  readonly county: string | null;
  readonly historical: boolean;
  readonly limit: number;
}

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_GNIS_CACHE_DIR', 'GNIS_CACHE_DIR'],
    defaultSubdir: 'kinloom-gnis',
  });
}

export function resolveQueryTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  if (cliTtl !== undefined || ctx.env['KINLOOM_GNIS_QUERY_TTL_HOURS']?.trim()) {
    return resolveEnvCacheTtlHours(cliTtl, ctx.env, 'KINLOOM_GNIS_QUERY_TTL_HOURS', DEFAULT_QUERY_TTL_HOURS);
  }
  return resolveEnvCacheTtlHours(undefined, ctx.env, 'KINLOOM_GNIS_CACHE_TTL_HOURS', DEFAULT_QUERY_TTL_HOURS);
}

export function resolveSafeChild(root: string, filename: string): string {
  return resolveSafeChildPath(root, filename, {
    errorFactory: (message) => new Error(message),
  });
}

export function stateZipUrl(state: string): string {
  return `${S3_BASE}/DomesticNames/DomesticNames_${state}_Text.zip`;
}

export function historicalZipUrl(): string {
  return `${S3_BASE}/Topical/HistoricalFeatures_National_Text.zip`;
}

export function extractGnisTxt(zipBytes: Uint8Array): { readonly name: string; readonly text: string } {
  const entries = unzipEntries(zipBytes);
  const names = Object.keys(entries);
  const txtName = names.find((name) => name.toLowerCase().endsWith('.txt'));
  if (!txtName) {
    throw new RecordRuntimeError(`No .txt member in downloaded zip (members: ${names.join(', ')})`);
  }
  const entryBytes = entries[txtName];
  if (!entryBytes) throw new RecordRuntimeError(`Missing zip member '${txtName}'`);
  const raw = Buffer.from(entryBytes).toString('utf8');
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  return { name: txtName, text };
}

export function loadGnisRows(filePath: string): GnisRow[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  const content = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || (lines.length === 1 && (lines[0] ?? '').length === 0)) {
    return [];
  }
  const header = (lines[0] ?? '').split('|').map((col) => col.trim());
  const rows: GnisRow[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!line.trim()) {
      continue;
    }
    const fields = line.split('|');
    const row: GnisRow = {};
    for (let c = 0; c < header.length; c += 1) {
      const col = header[c];
      if (col !== undefined) row[col] = fields[c] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

export function compactFeature(row: GnisRow): GnisCompactFeature {
  return {
    feature_id: row['feature_id'] ?? null,
    feature_name: row['feature_name'] ?? null,
    feature_class: row['feature_class'] ?? null,
    state: row['state_name'] ?? null,
    county: row['county_name'] ?? null,
    map_name: row['map_name'] ?? null,
    latitude: row['prim_lat_dec'] ?? null,
    longitude: row['prim_long_dec'] ?? null,
    date_created: row['date_created'] ?? null,
    date_edited: row['date_edited'] ?? null,
  };
}

export function matchRows(
  rows: readonly GnisRow[],
  name: string,
  exact: boolean,
  featureClass: string | undefined,
  county: string | undefined
): GnisRow[] {
  const needle = name.toLowerCase();
  const classLower = featureClass?.toLowerCase();
  const countyLower = county?.toLowerCase();
  const out: GnisRow[] = [];
  for (const row of rows) {
    const fname = (row['feature_name'] ?? '').toLowerCase();
    if (exact) {
      if (fname !== needle) {
        continue;
      }
    } else if (!fname.includes(needle)) {
      continue;
    }
    if (classLower && (row['feature_class'] ?? '').toLowerCase() !== classLower) {
      continue;
    }
    if (countyLower && !(row['county_name'] ?? '').toLowerCase().includes(countyLower)) {
      continue;
    }
    out.push(row);
  }
  return out;
}

export function formatSearchResultsText(payload: GnisSearchPayload): string {
  const lines: string[] = [`source: ${payload.source} | matches shown: ${payload.matches}`];
  for (const c of payload.results) {
    lines.push(
      `- ${c.feature_id ?? ''} | ${c.feature_name ?? ''} (${c.feature_class ?? ''}) | ${c.county ?? ''} County, ${c.state ?? ''} | ${c.latitude ?? ''}, ${c.longitude ?? ''} | map: ${c.map_name ?? ''}`
    );
  }
  return lines.join('\n');
}

export function formatFeatureDetailText(row: GnisRow): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (value !== '') {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}
