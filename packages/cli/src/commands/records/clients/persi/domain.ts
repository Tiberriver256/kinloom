import { resolveCacheDir } from '../../runtime/cache.js';
import { collapseWhitespace, loadHtml } from '../../runtime/parse.js';
import { isPlainRecord, resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import type { RecordCommandContext } from '../../runtime/types.js';

export const DEFAULT_CACHE_TTL_HOURS = 168;
export const BASE = 'https://www.genealogycenter.info';
export const SURNAME_URL = `${BASE}/results_persisurname.php`;
export const TITLE_URL = `${BASE}/results_persiarttitle.php`;
export const LOCATION_URL = `${BASE}/results_persilocation.php`;

export const PERSI_MODE_PAGES: Readonly<Record<string, string>> = {
  surname: `${BASE}/search_persisurname.php`,
  title: `${BASE}/search_persiarttitle.php`,
  location: `${BASE}/search_persilocation.php`,
};

export const US_STATES: ReadonlySet<string> = new Set([
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
  'GEN',
]);

export interface PersiArticle {
  readonly title: string;
  readonly periodical: string;
  readonly year: string;
  readonly publisher: string;
  readonly free_link: string | null;
}

export interface PersiCategory {
  readonly category: string;
  readonly articles: number;
}

export interface PersiArticlesPayload {
  readonly articles: PersiArticle[];
}

export interface PersiCategoriesPayload {
  readonly categories: PersiCategory[];
}

interface ParsedPersiTableRow {
  readonly cells: readonly string[];
  readonly links: readonly (readonly string[])[];
}

function parsePersiTableRows(html: string): ParsedPersiTableRow[] {
  const $ = loadHtml(html);
  const rows: ParsedPersiTableRow[] = [];
  $('table tr').each((_rowIdx, trEl) => {
    const cells: string[] = [];
    const links: string[][] = [];
    $(trEl)
      .find('td, th')
      .each((_cellIdx, cellEl) => {
        cells.push(collapseWhitespace($(cellEl).text()));
        const cellLinks: string[] = [];
        $(cellEl)
          .find('a[href]')
          .each((_aIdx, aEl) => {
            const href = $(aEl).attr('href');
            if (href) {
              cellLinks.push(href);
            }
          });
        links.push(cellLinks);
      });
    if (cells.length > 0) {
      rows.push({ cells, links });
    }
  });
  return rows;
}

export function parsePersiArticles(page: string): PersiArticle[] {
  const articles: PersiArticle[] = [];
  for (const row of parsePersiTableRows(page)) {
    const { cells, links } = row;
    if (cells.length < 3) {
      continue;
    }
    if (cells[0].toLowerCase().startsWith('article title')) {
      continue;
    }
    const freeLinks = links.flat().filter((link) => link.startsWith('http'));
    articles.push({
      title: cells[0],
      periodical: cells[1] ?? '',
      year: cells[2] ?? '',
      publisher: cells[3] ?? '',
      free_link: freeLinks[0] ?? null,
    });
  }
  return articles;
}

export function parsePersiCategories(page: string): PersiCategory[] {
  const categories: PersiCategory[] = [];
  for (const row of parsePersiTableRows(page)) {
    const { cells } = row;
    if (cells.length === 2 && /^\d+$/.test(cells[1].replace(/,/g, ''))) {
      if (cells[0].toLowerCase().startsWith('category')) {
        continue;
      }
      categories.push({
        category: cells[0],
        articles: Number.parseInt(cells[1].replace(/,/g, ''), 10),
      });
    }
  }
  return categories;
}

export function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(cliTtl, ctx.env, 'KINLOOM_PERSI_CACHE_TTL_HOURS', DEFAULT_CACHE_TTL_HOURS);
}

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_PERSI_CACHE_DIR'],
    defaultSubdir: 'kinloom-persi',
  });
}

export function isArticlesPayload(value: unknown): value is PersiArticlesPayload {
  return isPlainRecord(value) && Array.isArray(value['articles']);
}

export function isCategoriesPayload(value: unknown): value is PersiCategoriesPayload {
  return isPlainRecord(value) && Array.isArray(value['categories']);
}

export function formatPersiItemsText(
  items: readonly (PersiArticle | PersiCategory)[],
  cacheHit: boolean
): string {
  const marker = cacheHit ? ' [cache]' : '';
  if (items.length === 0) {
    return `No results.${marker}`;
  }
  const lines: string[] = [];
  for (const item of items) {
    if ('articles' in item) {
      lines.push(`${String(item.articles).padStart(6)}  ${item.category}`);
    } else {
      lines.push(`${item.title} | ${item.periodical} | ${item.year} | ${item.publisher}`);
      if (item.free_link) {
        lines.push(`       free online: ${item.free_link}`);
      }
    }
  }
  lines.push(`(${items.length} shown)${marker}`);
  return lines.join('\n');
}
