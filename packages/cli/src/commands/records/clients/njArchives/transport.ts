import { CliValidationError } from '../../../../errors.js';
import { resolveCacheDir } from '../../runtime/cache.js';
import { CookieJar, HttpStatusError, httpRequest } from '../../runtime/http.js';
import { resolveEnvCacheTtlHours } from '../../runtime/primitives.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  ALLOWED_HOSTS,
  DATABASES,
  DEFAULT_CACHE_TTL_HOURS,
  GRID_TARGET,
  MONMOUTH_SEARCH,
  type NjDatabaseEntry,
  type NjSearchCriteria,
  type NjSearchResult,
  PORTAL_BASE,
  PORTAL_INDEX,
  PREFIX,
  RETRYABLE_HTTP_STATUSES,
  SUBMIT_BUTTON,
  USER_AGENT,
} from './catalog.js';
import {
  cappedNotice,
  formAction,
  hasPageLink,
  hiddenFields,
  parseGrid,
  parsePortalDatabaseList,
  validateCriteria,
} from './parsers.js';

export function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_NJ_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-nj-archives',
  });
}

export function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return resolveEnvCacheTtlHours(
    cliTtl,
    ctx.env,
    'KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS',
    DEFAULT_CACHE_TTL_HOURS
  );
}

export async function portalGet(
  ctx: RecordCommandContext,
  jar: CookieJar,
  url: string,
  timeoutMs = 25_000
): Promise<string> {
  const res = await httpRequest(url, {
    method: 'GET',
    userAgent: USER_AGENT,
    timeoutMs,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return res.bytes.toString('utf8');
}

export async function portalPost(
  ctx: RecordCommandContext,
  jar: CookieJar,
  url: string,
  data: Readonly<Record<string, string>>,
  timeoutMs = 25_000
): Promise<string> {
  const res = await httpRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data).toString(),
    userAgent: USER_AGENT,
    timeoutMs,
    maxAttempts: 1,
    cookieJar: jar,
    urlPolicy: { allowedSchemes: ['https:'], allowedHosts: ALLOWED_HOSTS },
    fetchImpl: ctx.fetchImpl,
    sleepFn: ctx.sleepFn,
    nowMs: ctx.nowMs,
  });
  return res.bytes.toString('utf8');
}

export async function listPortalDatabases(ctx: RecordCommandContext): Promise<NjDatabaseEntry[]> {
  const jar = new CookieJar();
  const page = await portalGet(ctx, jar, PORTAL_INDEX);
  return parsePortalDatabaseList(page);
}

async function searchPortalOnce(
  ctx: RecordCommandContext,
  jar: CookieJar,
  key: string,
  criteria: NjSearchCriteria,
  pages: number
): Promise<NjSearchResult> {
  const spec = DATABASES[key];
  const indexHtml = await portalGet(ctx, jar, PORTAL_INDEX);
  const openData: Record<string, string> = {
    ...hiddenFields(indexHtml),
    __EVENTTARGET: spec.target,
    __EVENTARGUMENT: '',
  };
  const pageHtml = await portalPost(ctx, jar, PORTAL_INDEX, openData);
  const action = formAction(pageHtml) || spec.page;
  const pageUrl = `${PORTAL_BASE}${action.replace(/^[./]+/, '')}`;

  const resolved = validateCriteria(criteria, spec, pageHtml);
  const searchData: Record<string, string> = {
    ...hiddenFields(pageHtml),
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
  };
  for (const [option, value] of Object.entries(resolved)) {
    if (value !== null && value !== undefined && option in spec.fields) {
      searchData[`${PREFIX}${spec.fields[option]}`] = value;
    }
  }
  const submitName = SUBMIT_BUTTON[key] ?? 'Search';
  searchData[`${PREFIX}${submitName}`] = 'Search';

  let resultHtml = await portalPost(ctx, jar, pageUrl, searchData);
  const [headers, rows] = parseGrid(resultHtml, 'GridView1');
  const capped = cappedNotice(resultHtml);
  let seenPages = 1;

  while (seenPages < pages && rows.length > 0) {
    const nextPage = seenPages + 1;
    if (!hasPageLink(resultHtml, nextPage)) {
      break;
    }
    const pagerData: Record<string, string> = {
      ...hiddenFields(resultHtml),
      __EVENTTARGET: GRID_TARGET,
      __EVENTARGUMENT: `Page$${nextPage}`,
    };
    resultHtml = await portalPost(ctx, jar, pageUrl, pagerData);
    const [, more] = parseGrid(resultHtml, 'GridView1');
    if (more.length === 0) {
      break;
    }
    rows.push(...more);
    seenPages += 1;
  }

  return {
    database: key,
    title: spec.title,
    headers,
    rows,
    capped_500: capped,
    pages_read: seenPages,
  };
}

export async function searchPortal(
  ctx: RecordCommandContext,
  key: string,
  criteria: NjSearchCriteria,
  pages = 1
): Promise<NjSearchResult> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const jar = new CookieJar();
    try {
      return await searchPortalOnce(ctx, jar, key, criteria, pages);
    } catch (err: unknown) {
      if (err instanceof CliValidationError) {
        throw err;
      }
      if (err instanceof HttpStatusError) {
        if (RETRYABLE_HTTP_STATUSES.has(err.status) && attempt === 0) {
          await ctx.sleepFn(500);
          continue;
        }
        throw new RecordRuntimeError(
          `portal returned HTTP ${err.status} for ${key} after one retry; the portal may be briefly down. Retry later or drop --pages/--from-year filters.`
        );
      }
      if (attempt === 0) {
        await ctx.sleepFn(500);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(`portal request failed for ${key}: ${message}`);
    }
  }
  throw new RecordRuntimeError(`portal request failed for ${key}`);
}

export async function searchMonmouth(
  ctx: RecordCommandContext,
  surname: string,
  town: string,
  category: string,
  match: string
): Promise<NjSearchResult> {
  const jar = new CookieJar();
  try {
    const pageHtml = await portalGet(ctx, jar, MONMOUTH_SEARCH, 60_000);
    const data: Record<string, string> = {
      ...hiddenFields(pageHtml),
      __EVENTTARGET: '',
      __EVENTARGUMENT: '',
      [`${PREFIX}ddlTown`]: town,
      [`${PREFIX}ddlCat`]: category,
      [`${PREFIX}txtName`]: surname,
      [`${PREFIX}Search`]: match === 'contains' ? 'radContains' : 'radStarts',
      [`${PREFIX}btnSearch`]: 'Search',
    };
    const resultHtml = await portalPost(ctx, jar, MONMOUTH_SEARCH, data, 60_000);
    const [headers, rows] = parseGrid(resultHtml, 'dgdArcSearch');
    return {
      database: 'monmouth-1875-census',
      headers,
      rows,
      pages_read: 1,
    };
  } catch (err: unknown) {
    if (err instanceof HttpStatusError) {
      throw new RecordRuntimeError(
        `Monmouth OPRS returned HTTP ${err.status}; the site may be down or blocking automated access`
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`Monmouth OPRS request failed: ${message}`);
  }
}
