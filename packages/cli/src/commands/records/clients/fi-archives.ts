import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  cachedJsonCall,
  collapseWhitespace,
  DEFAULT_USER_AGENT,
  emitJsonStdout,
  emitStdout,
  expandHomePath,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  httpRequest,
  loadHtml,
  type OptionSpec,
  parseCacheTtlHours,
  parseCommandArgs,
  type RecordCommandContext,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
  resolveCacheDir,
  SsrfBlockedError,
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
export const HISKI_BASE = 'https://hiski.genealogia.fi';
export const HISKI_ENDPOINT = `${HISKI_BASE}/hiski`;
const HISKI_PARISHES_URL = `${HISKI_ENDPOINT}?en+A00`;

export const DIGIHAKEMISTO_BASE = 'https://digihakemisto.net';
export const DIGIHAKEMISTO_SEARCH_URL = `${DIGIHAKEMISTO_BASE}/haku`;
const DIGIHAKEMISTO_ARCHIVE_BASE = `${DIGIHAKEMISTO_BASE}/aineisto`;

const ASTIA_CARD_BASE = 'https://astia.narc.fi/uusiastia/kortti_aineisto.html';
const ASTIA_SEARCH_URL = 'https://astia.narc.fi/uusiastia/aineistot.html';
const FINNA_SEARCH_URL = 'https://www.finna.fi/Search/Results';
const DIGI_NEWSPAPERS_URL = 'https://digi.kansalliskirjasto.fi/search';
const SSHY_BASE_URL = 'https://www.sukuhistoria.fi/sshy/index_eng.htm';

export const ALLOWED_HISKI_HOSTS = ['hiski.genealogia.fi'] as const;
export const ALLOWED_DIGIHAKEMISTO_HOSTS = ['digihakemisto.net'] as const;
const TRANSIENT_STATUS_CODES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const MAX_HTTP_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;
const MIN_INTERVAL_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

const BOOK_ALIASES: Readonly<Record<string, string>> = {
  christened: 'kastetut',
  baptism: 'kastetut',
  baptisms: 'kastetut',
  birth: 'kastetut',
  births: 'kastetut',
  kastetut: 'kastetut',
  married: 'vihityt',
  marriage: 'vihityt',
  marriages: 'vihityt',
  vihityt: 'vihityt',
  buried: 'haudatut',
  burial: 'haudatut',
  burials: 'haudatut',
  death: 'haudatut',
  deaths: 'haudatut',
  haudatut: 'haudatut',
  'moved-in': 'smuutt',
  in: 'smuutt',
  smuutt: 'smuutt',
  'moved-out': 'umuutt',
  out: 'umuutt',
  umuutt: 'umuutt',
  all: 'kaikki',
  kaikki: 'kaikki',
};

const BOOK_LABELS: Readonly<Record<string, string>> = {
  kastetut: 'christened',
  vihityt: 'married',
  haudatut: 'buried',
  smuutt: 'moved-in',
  umuutt: 'moved-out',
  kaikki: 'all',
};

const DIGIHAKEMISTO_PRESETS: Readonly<Record<string, string>> = {
  parishes: '*seurakun*, *församl*',
  henkikirjat: 'läänin henkikirjat',
  tax: 'läänin henkikirjat',
  court: 'tuomiokunnan,tuomiokirjat',
  inventories: 'id:perukirjat',
  say: 'id:1585519449',
};

const PARISH_CODE_RE = /^\d{4}$/;
const SAFE_ARCHIVE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HISKI_EVENT_HREF_RE =
  /\/hiski\?(?:en|fi|sv)\+(\d{4})\+(kastetut|vihityt|haudatut|smuutt|umuutt)\+(\d+)/i;
const HISKI_PERMALINK_RE = /\/hiski\?(?:en|fi|sv)\+(t\d+)/i;
const TOTAL_EVENTS_RE = /(?:A total of\s+)?(\d+)\s+events?\s+found/gi;
const YEAR_RE = /^\d{4}$/;

export interface HiskiParish {
  readonly code: string;
  readonly name: string;
  readonly url: string;
}

export interface HiskiRecord {
  readonly parish: string;
  readonly parish_code: string;
  readonly book: string;
  readonly book_code: string;
  readonly row_id: string;
  readonly event_url: string;
  comment?: string;
  readonly [key: string]: unknown;
}

export interface HiskiSearchResult {
  readonly total_reported: number;
  readonly records: HiskiRecord[];
}

export interface HiskiEventDetail {
  readonly parish: string;
  readonly parish_code: string;
  readonly book: string;
  readonly book_code: string;
  readonly row_id: string;
  readonly permalink_id: string;
  readonly permalink_url: string;
  readonly event_url: string;
  readonly sshy_url: string;
  readonly fields: Record<string, string>;
}

export interface DigihakemistoArchiveRow {
  readonly id: string;
  readonly title: string;
  readonly comment: string;
  readonly digitized: boolean;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
}

export interface DigihakemistoChildRow {
  readonly id: string;
  readonly kind: 'item' | 'series';
  readonly title: string;
  readonly comment: string;
  readonly digitized: boolean;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
}

export interface DigihakemistoArchiveDetail {
  readonly id: string;
  readonly title: string;
  readonly digihakemisto_url: string;
  readonly astia_url: string;
  readonly notes: string[];
  readonly access_notes: string[];
  readonly children: DigihakemistoChildRow[];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  const specific = ctx.env.KINLOOM_FI_ARCHIVES_CACHE_DIR;
  if (specific && specific.trim().length > 0) {
    return path.resolve(expandHomePath(specific, ctx.env));
  }
  const shared = ctx.env.KINLOOM_CACHE_DIR;
  if (shared && shared.trim().length > 0) {
    return path.resolve(expandHomePath(shared, ctx.env), 'fi-archives');
  }
  return resolveCacheDir({
    env: ctx.env,
    envVars: [],
    defaultSubdir: path.join('kinloom', 'fi-archives'),
  });
}

function resolveTtlHours(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_FI_ARCHIVES_CACHE_TTL_HOURS'
  );
}

export function validateFiUrl(rawUrl: string, allowedHosts: readonly string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliValidationError(`Refusing malformed URL: '${rawUrl}'`);
  }
  if (parsed.protocol !== 'https:') {
    throw new CliValidationError(`Refusing non-HTTPS URL: '${rawUrl}'`);
  }
  if (parsed.username || parsed.password) {
    throw new CliValidationError('Refusing URL containing embedded credentials.');
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) {
    throw new CliValidationError(
      `Refusing host '${host}'; allowed hosts: ${[...allowedHosts].toSorted().join(', ')}.`
    );
  }
  return rawUrl;
}

export function decodeIso88591(bytes: Buffer): string {
  return bytes.toString('latin1');
}

function encodeIso88591Component(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 0xff) {
      continue;
    }
    if (
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2d ||
      code === 0x2e ||
      code === 0x5f ||
      code === 0x7e
    ) {
      out += value[i];
    } else if (code === 0x20) {
      out += '+';
    } else {
      out += `%${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

export function encodeIso88591Form(formData: Readonly<Record<string, string>>): string {
  return Object.entries(formData)
    .map(([k, v]) => `${encodeIso88591Component(k)}=${encodeIso88591Component(v)}`)
    .join('&');
}

function checkNotChallenged(headers: Headers, text: string, label: string): void {
  if ((headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
    throw new RecordRuntimeError(`${label} returned a Cloudflare challenge; open it in a browser instead.`);
  }
  if (text.includes('Processing JavaScript challenge') || text.includes('<title>Just a moment...</title>')) {
    throw new RecordRuntimeError(
      `${label} returned a JavaScript anti-bot challenge; open it in a browser instead.`
    );
  }
}

async function requestWithRetry(
  ctx: RecordCommandContext,
  options: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly allowedHosts: readonly string[];
    readonly label: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }
): Promise<{
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Buffer;
}> {
  validateFiUrl(options.url, options.allowedHosts);
  if (MIN_INTERVAL_MS > 0) {
    await ctx.sleepFn(MIN_INTERVAL_MS);
  }
  try {
    const res = await httpRequest(options.url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      userAgent: DEFAULT_USER_AGENT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxAttempts: MAX_HTTP_ATTEMPTS,
      baseBackoffMs: RETRY_BASE_MS,
      retryStatuses: TRANSIENT_STATUS_CODES,
      urlPolicy: { allowedSchemes: ['https:'], allowedHosts: options.allowedHosts },
      fetchImpl: ctx.fetchImpl,
      sleepFn: ctx.sleepFn,
      nowMs: ctx.nowMs,
      throwOnHttpError: false,
    });
    validateFiUrl(res.url, options.allowedHosts);
    if (res.status >= 400) {
      if ((res.headers.get('cf-mitigated') ?? '').toLowerCase() === 'challenge') {
        throw new RecordRuntimeError(
          `${options.label} returned HTTP ${res.status} (Cloudflare challenge); use a browser.`
        );
      }
      throw new RecordRuntimeError(`${options.label} returned HTTP ${res.status} from ${res.url}`);
    }
    return res;
  } catch (err: unknown) {
    if (err instanceof SsrfBlockedError) {
      let host = '';
      try {
        host = new URL(err.url).hostname.toLowerCase();
      } catch {
        host = err.url;
      }
      throw new CliValidationError(
        `Refusing host '${host}'; allowed hosts: ${[...options.allowedHosts].toSorted().join(', ')}.`
      );
    }
    if (err instanceof CliValidationError || err instanceof RecordRuntimeError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new RecordRuntimeError(`${options.label} request failed: ${message}`);
  }
}

function cleanText(raw: string): string {
  return collapseWhitespace(raw.replaceAll('\u00A0', ' '));
}

function unescapeAndClean(raw: string): string {
  const $ = loadHtml(`<div>${raw}</div>`);
  return cleanText($('div').text());
}

export function parseHiskiParishes(page: string): HiskiParish[] {
  const seen = new Set<string>();
  const parishes: HiskiParish[] = [];
  const regex = /<OPTION\s+VALUE="?([^">]+)"?[^>]*>([^<\r\n]+)/gi;
  for (const match of page.matchAll(regex)) {
    const code = match[1].trim();
    const name = unescapeAndClean(match[2]);
    if (!PARISH_CODE_RE.test(code) || !name || seen.has(code)) {
      continue;
    }
    seen.add(code);
    parishes.push({
      code,
      name,
      url: `${HISKI_ENDPOINT}?en+${code}`,
    });
  }
  return parishes;
}

function hiskiRowToRecord(
  book: string,
  parishName: string,
  parishCode: string,
  rowId: string,
  href: string,
  texts: readonly string[]
): HiskiRecord {
  const col = (idx: number): string => texts[idx] ?? '';
  const base: Record<string, unknown> = {
    parish: parishName,
    parish_code: parishCode,
    book: BOOK_LABELS[book] ?? book,
    book_code: book,
    row_id: rowId,
    event_url: new URL(href, HISKI_BASE).toString(),
  };
  if (book === 'kastetut') {
    Object.assign(base, {
      born: col(0),
      christened: col(1),
      village: col(2),
      farm: col(3),
      father: col(4),
      mother: col(5),
      child: col(6),
    });
  } else if (book === 'vihityt') {
    Object.assign(base, {
      announced: col(0),
      married: col(1),
      groom_village: col(2),
      groom_farm: col(3),
      groom: col(4),
      bride: col(5),
      bride_village: col(6),
      bride_farm: col(7),
    });
  } else if (book === 'haudatut') {
    Object.assign(base, {
      died: col(0),
      buried: col(1),
      village: col(2),
      farm: col(3),
      person: col(4),
      cause: col(5),
      age_years: col(6),
      age_months: col(7),
      age_weeks: col(8),
      age_days: col(9),
    });
  } else if (book === 'smuutt' || book === 'umuutt') {
    Object.assign(base, {
      departure: col(0),
      arrival: col(1),
      village: col(2),
      farm: col(3),
      person: col(4),
      other_place: col(5),
    });
  } else {
    base.columns = [...texts];
  }
  return base as unknown as HiskiRecord;
}

export function parseHiskiResults(page: string): HiskiSearchResult {
  const $ = loadHtml(page);
  const records: HiskiRecord[] = [];
  let currentHeading = '';

  $('font[size="+2"], table[border="1"]').each((_idx, el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'font') {
      const boldText = cleanText($(el).find('b').text());
      if (boldText) {
        currentHeading = boldText;
      }
      return;
    }
    // Skip nested border="1" tables inside another border="1" table.
    if ($(el).parents('table[border="1"]').length > 0) {
      return;
    }
    const parishName = currentHeading.includes(' - ')
      ? currentHeading.split(' - ', 1)[0].trim()
      : currentHeading;

    const rows =
      $(el).children('tbody').length > 0 ? $(el).children('tbody').children('tr') : $(el).children('tr');

    rows.each((_rIdx, trEl) => {
      const cellEls = $(trEl).children('td, th');
      if (cellEls.length === 0) {
        return;
      }
      const cells: { readonly tag: string; readonly text: string; readonly hrefs: string[] }[] = [];
      cellEls.each((_cIdx, cellEl) => {
        const hrefs: string[] = [];
        $(cellEl)
          .find('a[href]')
          .each((_aIdx, aEl) => {
            const href = $(aEl).attr('href')?.trim();
            if (href) {
              hrefs.push(href);
            }
          });
        cells.push({
          tag: cellEl.tagName.toLowerCase(),
          text: cleanText($(cellEl).text()),
          hrefs,
        });
      });

      if (cells.every((c) => c.tag === 'th')) {
        return;
      }

      let eventHref = '';
      let eventMatch: RegExpExecArray | null = null;
      for (const href of cells[0].hrefs) {
        const m = HISKI_EVENT_HREF_RE.exec(href);
        if (m) {
          eventHref = href;
          eventMatch = m;
          break;
        }
      }

      if (!eventMatch) {
        if (records.length > 0 && cells.length >= 2 && !cells[0].text) {
          const note = cells
            .slice(1)
            .map((c) => c.text)
            .filter((t) => t.length > 0)
            .join(' ')
            .trim();
          if (note) {
            const last = records[records.length - 1];
            last.comment = last.comment ? `${last.comment}; ${note}` : note;
          }
        }
        return;
      }

      const parishCode = eventMatch[1];
      const bookCode = eventMatch[2].toLowerCase();
      const rowId = eventMatch[3];
      const texts = cells.map((c) => c.text);
      records.push(hiskiRowToRecord(bookCode, parishName, parishCode, rowId, eventHref, texts));
    });
  });

  let reportedTotal: number | undefined;
  const totalMatches = [...page.matchAll(TOTAL_EVENTS_RE)];
  if (totalMatches.length > 0) {
    reportedTotal = totalMatches.reduce((sum, m) => sum + Number.parseInt(m[1], 10), 0);
  }

  return {
    total_reported: reportedTotal ?? records.length,
    records,
  };
}

export function parseHiskiEventDetail(
  page: string,
  ref: { readonly parishCode: string; readonly bookCode: string; readonly rowId: string }
): HiskiEventDetail {
  const $ = loadHtml(page);
  const parishName = cleanText($('h2').first().text());
  const bookTitle = cleanText($('h3').first().text()) || BOOK_LABELS[ref.bookCode] || ref.bookCode;

  const permalinkMatch = HISKI_PERMALINK_RE.exec(page);
  const permalinkId = permalinkMatch ? permalinkMatch[1] : '';

  const sshyMatch = /HREF="(https?:\/\/www\.sukuhistoria\.fi\/[^"]+)"/i.exec(page);
  const sshyUrl = sshyMatch ? sshyMatch[1] : '';

  const fields: Record<string, string> = {};
  const detailTable = $('table[border="4"]').first();
  if (detailTable.length > 0) {
    const rows =
      detailTable.children('tbody').length > 0
        ? detailTable.children('tbody').children('tr')
        : detailTable.children('tr');
    rows.each((_rIdx, trEl) => {
      const cells: string[] = [];
      $(trEl)
        .children('td, th')
        .each((_cIdx, cellEl) => {
          cells.push(cleanText($(cellEl).text()));
        });
      if (cells.length === 0) {
        return;
      }
      const label = cells[0].replace(/:+$/, '').trim();
      const values = cells.slice(1).filter((v) => v.length > 0);
      if (label && label.toLowerCase() !== 'links') {
        fields[label] = values.join(' | ');
      }
    });
  }

  return {
    parish: parishName,
    parish_code: ref.parishCode,
    book: bookTitle,
    book_code: ref.bookCode,
    row_id: ref.rowId,
    permalink_id: permalinkId,
    permalink_url: permalinkId ? `${HISKI_ENDPOINT}?en+${permalinkId}` : '',
    event_url: `${HISKI_ENDPOINT}?en+${ref.parishCode}+${ref.bookCode}+${ref.rowId}`,
    sshy_url: sshyUrl,
    fields,
  };
}

export function parseDigihakemistoSearch(page: string): DigihakemistoArchiveRow[] {
  const $ = loadHtml(page);
  const results: DigihakemistoArchiveRow[] = [];
  $('tr.searchrow').each((_idx, trEl) => {
    const link = $(trEl).find('a.aineisto[href]').first();
    if (link.length === 0) {
      return;
    }
    const href = link.attr('href') ?? '';
    const hrefMatch = /^\/aineisto\/([A-Za-z0-9_-]+)$/.exec(href);
    if (!hrefMatch) {
      return;
    }
    const archiveId = hrefMatch[1];
    const title = cleanText(link.text());
    const nodigi = link.hasClass('nodigi') || link.find('.nodigi').length > 0;
    const comment = cleanText($(trEl).find('span.searchtarget.searchtarget2').first().text());
    const digitized = !nodigi && !comment.toLowerCase().includes('ei digitoitu');
    const astiaUrl = /^\d+$/.test(archiveId) ? `${ASTIA_CARD_BASE}?id=${archiveId}` : '';
    results.push({
      id: archiveId,
      title,
      comment,
      digitized,
      digihakemisto_url: new URL(href, DIGIHAKEMISTO_BASE).toString(),
      astia_url: astiaUrl,
    });
  });
  return results;
}

export function parseDigihakemistoArchive(page: string, archiveId: string): DigihakemistoArchiveDetail {
  const $ = loadHtml(page);
  const title = cleanText($('title').first().text());
  const astiaAttr = $('a#alkup[href]').attr('href') ?? '';
  const astiaUrl = astiaAttr.startsWith('https://astia.narc.fi/')
    ? astiaAttr
    : /^\d+$/.test(archiveId)
      ? `${ASTIA_CARD_BASE}?id=${archiveId}`
      : '';

  const notes: string[] = [];
  $('span.tieto').each((_idx, el) => {
    const text = cleanText($(el).text());
    if (text) {
      notes.push(text);
    }
  });

  const accessNotes: string[] = [];
  $('div.msg').each((_idx, el) => {
    const text = cleanText($(el).text());
    if (text) {
      accessNotes.push(text);
    }
  });

  const children: DigihakemistoChildRow[] = [];
  $('tr.searchrow').each((_idx, trEl) => {
    let linkEl: ReturnType<typeof $> | undefined;
    $(trEl)
      .find('a[href]')
      .each((_aIdx, aEl) => {
        if (linkEl) {
          return;
        }
        const href = $(aEl).attr('href') ?? '';
        if (href.startsWith('/aineisto/') || href.startsWith('/item/')) {
          linkEl = $(aEl);
        }
      });
    if (!linkEl) {
      return;
    }
    const href = linkEl.attr('href') ?? '';
    const trimmedParts = href.replace(/^\/+|\/+$/g, '').split('/');
    const childId = trimmedParts.at(-1) ?? '';
    const childTitle = cleanText(linkEl.text());
    const nodigi = linkEl.hasClass('nodigi') || linkEl.find('.nodigi').length > 0;
    const comment = cleanText($(trEl).find('span.searchtarget.searchtarget2').first().text());
    const digitized = !nodigi && !comment.toLowerCase().includes('ei digitoitu');
    children.push({
      id: childId,
      kind: href.startsWith('/item/') ? 'item' : 'series',
      title: childTitle,
      comment,
      digitized,
      digihakemisto_url: new URL(href, DIGIHAKEMISTO_BASE).toString(),
      astia_url: /^\d+$/.test(childId) ? `${ASTIA_CARD_BASE}?id=${childId}` : '',
    });
  });

  return {
    id: archiveId,
    title,
    digihakemisto_url: `${DIGIHAKEMISTO_ARCHIVE_BASE}/${archiveId}`,
    astia_url: astiaUrl,
    notes,
    access_notes: accessNotes,
    children,
  };
}

interface ParishesCachePayload {
  readonly parishes: HiskiParish[];
}

function isParishesCachePayload(value: unknown): value is ParishesCachePayload {
  return isPlainRecord(value) && Array.isArray(value.parishes);
}

function isHiskiSearchResult(value: unknown): value is HiskiSearchResult {
  return isPlainRecord(value) && Array.isArray(value.records);
}

function isHiskiEventDetail(value: unknown): value is HiskiEventDetail {
  return isPlainRecord(value) && isPlainRecord(value.fields);
}

interface ArchivesSearchCachePayload {
  readonly archives: DigihakemistoArchiveRow[];
}

function isArchivesSearchCachePayload(value: unknown): value is ArchivesSearchCachePayload {
  return isPlainRecord(value) && Array.isArray(value.archives);
}

function isDigihakemistoArchiveDetail(value: unknown): value is DigihakemistoArchiveDetail {
  return isPlainRecord(value) && Array.isArray(value.children);
}

async function loadParishes(
  ctx: RecordCommandContext,
  refresh: boolean,
  ttlHours: number
): Promise<{ readonly parishes: HiskiParish[]; readonly cacheHit: boolean }> {
  const { value, cacheHit } = await cachedJsonCall<ParishesCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_parishes',
    payload: { lang: 'en' },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url: HISKI_PARISHES_URL,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi parish list',
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi parish list');
      return { parishes: parseHiskiParishes(html) };
    },
    cacheable: (r) => r.parishes.length > 0,
    validateCached: isParishesCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });
  return { parishes: [...value.parishes], cacheHit };
}

async function resolveParishSpec(
  ctx: RecordCommandContext,
  parish: string,
  refresh: boolean,
  ttlHours: number
): Promise<string> {
  const cleaned = parish.trim();
  if (!cleaned || ['*', 'all', 'kaikki'].includes(cleaned.toLowerCase())) {
    return '*';
  }
  const parts = cleaned
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.every((p) => PARISH_CODE_RE.test(p))) {
    return parts.join(',');
  }

  const { parishes } = await loadParishes(ctx, refresh, ttlHours);
  const resolved: string[] = [];
  for (const part of parts) {
    if (PARISH_CODE_RE.test(part)) {
      resolved.push(part);
      continue;
    }
    const needle = part.toLowerCase();
    const exact = parishes
      .filter(
        (p) =>
          p.name.toLowerCase() === needle ||
          p.name.split(' - ').some((seg) => seg.trim().toLowerCase() === needle)
      )
      .map((p) => p.code);
    if (exact.length === 1) {
      resolved.push(exact[0]);
      continue;
    }
    const partial = parishes.filter((p) => p.name.toLowerCase().includes(needle));
    if (partial.length === 1) {
      resolved.push(partial[0].code);
      continue;
    }
    if (partial.length > 1) {
      const sample = partial
        .slice(0, 6)
        .map((p) => `${p.code} (${p.name})`)
        .join(', ');
      throw new CliValidationError(
        `Ambiguous parish '${part}'; matches: ${sample}. Pass a 4-digit parish code.`
      );
    }
    throw new CliValidationError(
      `Unknown parish '${part}'. Run \`parishes --query ${part}\` to find its 4-digit code.`
    );
  }
  return resolved.join(',');
}

function validateYears(fromYear: string | undefined, toYear: string | undefined): readonly [string, string] {
  const fy = (fromYear ?? '').trim();
  const ty = (toYear ?? '').trim();
  if (fy && !YEAR_RE.test(fy)) {
    throw new CliValidationError(`Invalid --from-year '${fromYear}'; expected 4-digit YYYY.`);
  }
  if (ty && !YEAR_RE.test(ty)) {
    throw new CliValidationError(`Invalid --to-year '${toYear}'; expected 4-digit YYYY.`);
  }
  if (fy && ty && Number.parseInt(fy, 10) > Number.parseInt(ty, 10)) {
    throw new CliValidationError('--from-year must not be greater than --to-year.');
  }
  return [fy, ty];
}

function hiskiMaxkpl(limit: number): string {
  for (const bucket of [15, 30, 50, 100, 250, 500, 1000]) {
    if (limit <= bucket) {
      return String(bucket);
    }
  }
  return '1000';
}

function parseEventRef(raw: string): readonly [string, string, string] {
  const text = raw.trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    validateFiUrl(text, ALLOWED_HISKI_HOSTS);
    const match = HISKI_EVENT_HREF_RE.exec(text);
    if (!match) {
      throw new CliValidationError(
        'Expected a HisKi event URL like https://hiski.genealogia.fi/hiski?en+0001+kastetut+418.'
      );
    }
    return [match[1], match[2].toLowerCase(), match[3]];
  }
  const tokens = text.split(/[+/:]/);
  if (tokens.length === 3) {
    const parishCode = tokens[0].trim();
    const rawBook = tokens[1].trim().toLowerCase();
    const rowId = tokens[2].trim();
    const bookCode = BOOK_ALIASES[rawBook] ?? '';
    if (
      PARISH_CODE_RE.test(parishCode) &&
      ['kastetut', 'vihityt', 'haudatut', 'smuutt', 'umuutt'].includes(bookCode) &&
      /^\d+$/.test(rowId)
    ) {
      return [parishCode, bookCode, rowId];
    }
  }
  throw new CliValidationError(
    `Invalid HisKi event reference '${raw}'; use '<parish_code>/<book>/<row_id>' (e.g. '0001/kastetut/418') or a full HisKi event URL.`
  );
}

function parseArchiveId(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('http://') || text.startsWith('https://')) {
    validateFiUrl(text, ALLOWED_DIGIHAKEMISTO_HOSTS);
    const parsed = new URL(text);
    const parts = parsed.pathname.split('/').filter((p) => p.length > 0);
    if (parts.length >= 2 && parts[0] === 'aineisto' && SAFE_ARCHIVE_ID_RE.test(parts[1])) {
      return parts[1];
    }
    throw new CliValidationError(`Expected https://digihakemisto.net/aineisto/<id>, got '${raw}'.`);
  }
  if (text.toLowerCase().startsWith('id:')) {
    text = text.slice(3).trim();
  }
  if (!SAFE_ARCHIVE_ID_RE.test(text)) {
    throw new CliValidationError(`Invalid Digihakemisto archive id '${raw}'.`);
  }
  return text;
}

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

const PARISHES_OPTIONS: readonly OptionSpec[] = [
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

const HISKI_OPTIONS: readonly OptionSpec[] = [
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

const EVENT_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON with boolean cache_hit.' },
  ...CACHE_OPTIONS,
];

const ARCHIVES_OPTIONS: readonly OptionSpec[] = [
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

const ARCHIVE_OPTIONS: readonly OptionSpec[] = [
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

const URL_OPTIONS: readonly OptionSpec[] = [
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

const PARISHES_SPEC: CommandParseSpec = { options: PARISHES_OPTIONS, allowPositionals: false };
const HISKI_SPEC: CommandParseSpec = { options: HISKI_OPTIONS, allowPositionals: false };
const EVENT_SPEC: CommandParseSpec = {
  options: EVENT_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'event_ref',
};
const ARCHIVES_SPEC: CommandParseSpec = {
  options: ARCHIVES_OPTIONS,
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'query',
};
const ARCHIVE_SPEC: CommandParseSpec = {
  options: ARCHIVE_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'archive_id',
};
const URL_SPEC: CommandParseSpec = { options: URL_OPTIONS, allowPositionals: false };

function renderRootHelp(): string {
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

async function runParishes(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, PARISHES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives parishes [options]',
          summary: 'List or filter HisKi Finnish parishes and 4-digit codes.',
          options: PARISHES_OPTIONS,
        })
      ),
    };
  }
  const query = getStringOption(parsed, 'query');
  const limit = getNumberOption(parsed, 'limit');
  const asJson = getBooleanOption(parsed, 'asJson');
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);

  if (limit !== undefined && limit < 1) {
    throw new CliValidationError('--limit must be >= 1.');
  }

  const { parishes: allParishes, cacheHit } = await loadParishes(ctx, refresh, ttlHours);
  const total = allParishes.length;
  let parishes = allParishes;
  if (query) {
    const needle = query.trim().toLowerCase();
    parishes = parishes.filter((p) => p.name.toLowerCase().includes(needle) || needle === p.code);
  }
  if (limit !== undefined) {
    parishes = parishes.slice(0, limit);
  }

  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        query: query ?? null,
        total,
        returned: parishes.length,
        parishes,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`Showing ${parishes.length} of ${total} HisKi parish(es):${marker}`];
  for (const p of parishes) {
    lines.push(`  ${p.code}  ${p.name}  ${p.url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runHiski(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, HISKI_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives hiski [options]',
          summary: 'Search HisKi parish baptisms, marriages, burials, and moves.',
          options: HISKI_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1 || limit > 1000) {
    throw new CliValidationError('--limit must be between 1 and 1000.');
  }

  const rawBook = getStringOption(parsed, 'book') ?? 'christened';
  const bookCode = BOOK_ALIASES[rawBook.trim().toLowerCase()];
  if (!bookCode) {
    throw new CliValidationError(
      `Unsupported --book '${rawBook}'; choose christened, married, buried, moved-in, moved-out, or all.`
    );
  }

  const [fy, ty] = validateYears(getStringOption(parsed, 'fromYear'), getStringOption(parsed, 'toYear'));
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const srk = await resolveParishSpec(ctx, getStringOption(parsed, 'parish') ?? '*', refresh, ttlHours);

  if (srk === '*' && bookCode === 'kaikki') {
    throw new CliValidationError(
      "HisKi does not support nationwide ('*') searches with --book all; pick --book christened, married, buried, moved-in, or moved-out, or specify a --parish."
    );
  }

  const formData: Record<string, string> = {
    komento: 'haku',
    srk,
    kirja: bookCode,
    kieli: 'en',
    maxkpl: hiskiMaxkpl(limit),
  };
  if (fy) formData.alkuvuosi = fy;
  if (ty) formData.loppuvuosi = ty;

  const village = getStringOption(parsed, 'village')?.trim();
  if (village) formData.ikyla = village;

  const given = getStringOption(parsed, 'given')?.trim();
  const fatherGiven = getStringOption(parsed, 'fatherGiven')?.trim();
  const fatherPatronymic = getStringOption(parsed, 'fatherPatronymic')?.trim();
  const surname = getStringOption(parsed, 'surname')?.trim();
  const motherGiven = getStringOption(parsed, 'motherGiven')?.trim();
  const motherSurname = getStringOption(parsed, 'motherSurname')?.trim();

  if (bookCode === 'kastetut') {
    if (given) formData.etunimi = given;
    if (fatherGiven) formData.ietunimi = fatherGiven;
    if (fatherPatronymic) formData.ipatronyymi = fatherPatronymic;
    if (surname) formData.isukunimi = surname;
    if (motherGiven) formData.aetunimi = motherGiven;
    if (motherSurname) formData.asukunimi = motherSurname;
  } else {
    if (given) {
      formData.ietunimi = given;
    } else if (fatherGiven) {
      formData.ietunimi = fatherGiven;
    }
    if (fatherPatronymic) formData.ipatronyymi = fatherPatronymic;
    if (surname) formData.isukunimi = surname;
    if (motherGiven) formData.aetunimi = motherGiven;
    if (motherSurname) formData.asukunimi = motherSurname;
  }

  const filterKeys = [
    'etunimi',
    'ietunimi',
    'ipatronyymi',
    'isukunimi',
    'aetunimi',
    'asukunimi',
    'ikyla',
    'alkuvuosi',
    'loppuvuosi',
  ];
  if (!filterKeys.some((k) => k in formData)) {
    throw new CliValidationError(
      'Provide at least one filter (--surname, --given, --village, --from-year, etc.).'
    );
  }

  const { value: result, cacheHit } = await cachedJsonCall<HiskiSearchResult>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_search',
    payload: { ...formData },
    ttlHours,
    refresh,
    fetch: async () => {
      const encoded = encodeIso88591Form(formData);
      const resp = await requestWithRetry(ctx, {
        method: 'POST',
        url: HISKI_ENDPOINT,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi search',
        body: encoded,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi search');
      if (html.toLowerCase().includes('unknown parish')) {
        throw new RecordRuntimeError(`HisKi rejected parish code '${srk}'.`);
      }
      return parseHiskiResults(html);
    },
    cacheable: (r) => Array.isArray(r.records),
    validateCached: isHiskiSearchResult,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  const records = result.records.slice(0, limit);
  const totalReported = result.total_reported || records.length;

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        parish: srk,
        book: BOOK_LABELS[bookCode] ?? bookCode,
        total_reported: totalReported,
        returned: records.length,
        records,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `HisKi ${BOOK_LABELS[bookCode] ?? bookCode} (parish=${srk}): ${totalReported} found, showing ${records.length}:${marker}`,
  ];
  for (const rec of records) {
    const parishTag = rec.parish ? `${rec.parish} (${rec.parish_code})` : rec.parish_code;
    if (rec.book_code === 'kastetut') {
      const dateS = String(rec.born || rec.christened || '');
      lines.push(
        `- ${dateS} | ${parishTag} | Child: ${String(rec.child ?? '')} | Parents: ${String(rec.father ?? '')} & ${String(rec.mother ?? '')}`
      );
    } else if (rec.book_code === 'vihityt') {
      const dateS = String(rec.married || rec.announced || '');
      lines.push(`- ${dateS} | ${parishTag} | ${String(rec.groom ?? '')} & ${String(rec.bride ?? '')}`);
    } else if (rec.book_code === 'haudatut') {
      const dateS = String(rec.died || rec.buried || '');
      lines.push(
        `- ${dateS} | ${parishTag} | ${String(rec.person ?? '')} | Cause: ${String(rec.cause ?? '')}`
      );
    } else {
      const dateS = String(rec.arrival || rec.departure || '');
      lines.push(
        `- ${dateS} | ${parishTag} | ${String(rec.person ?? '')} | Place: ${String(rec.other_place ?? '')}`
      );
    }
    lines.push(`  ${rec.event_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runEvent(argv: readonly string[], ctx: RecordCommandContext): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, EVENT_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives event <EVENT_REF> [options]',
          summary: 'Inspect one HisKi event detail page (with SSHY scan link).',
          options: EVENT_OPTIONS,
        })
      ),
    };
  }
  const [parishCode, bookCode, rowId] = parseEventRef(parsed.positionals[0]);
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const url = `${HISKI_ENDPOINT}?en+${parishCode}+${bookCode}+${rowId}`;

  const { value: detail, cacheHit } = await cachedJsonCall<HiskiEventDetail>({
    cacheDir: getCacheDir(ctx),
    kind: 'hiski_event',
    payload: { parish_code: parishCode, book_code: bookCode, row_id: rowId },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url,
        allowedHosts: ALLOWED_HISKI_HOSTS,
        label: 'HisKi event',
      });
      const html = decodeIso88591(resp.bytes);
      checkNotChallenged(resp.headers, html, 'HisKi event');
      return parseHiskiEventDetail(html, { parishCode, bookCode, rowId });
    },
    cacheable: (r) => Object.keys(r.fields).length > 0 || Boolean(r.parish),
    validateCached: isHiskiEventDetail,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...detail, cache_hit: cacheHit }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `${detail.parish} (${detail.parish_code}) - ${detail.book} #${detail.row_id}${marker}`,
  ];
  for (const [k, v] of Object.entries(detail.fields)) {
    lines.push(`  ${k}: ${v}`);
  }
  if (detail.sshy_url) {
    lines.push(`  SSHY scan link: ${detail.sshy_url}`);
  }
  if (detail.permalink_url) {
    lines.push(`  Permalink: ${detail.permalink_url}`);
  }
  lines.push(`  Event URL: ${detail.event_url}`);
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runArchivesSearch(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ARCHIVES_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives archives [QUERY] [options]',
          summary: 'Search National Archives of Finland (Astia) via Digihakemisto.',
          options: ARCHIVES_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 30;
  if (limit < 1 || limit > 500) {
    throw new CliValidationError('--limit must be between 1 and 500.');
  }
  const preset = getStringOption(parsed, 'preset');
  const query = preset ? DIGIHAKEMISTO_PRESETS[preset] : (parsed.positionals[0] ?? '').trim();
  if (!query) {
    throw new CliValidationError(
      'Provide QUERY or --preset (parishes, henkikirjat, court, inventories, say).'
    );
  }

  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const digitizedOnly = getBooleanOption(parsed, 'digitized');

  const { value: data, cacheHit } = await cachedJsonCall<ArchivesSearchCachePayload>({
    cacheDir: getCacheDir(ctx),
    kind: 'digihakemisto_search',
    payload: { query },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'POST',
        url: DIGIHAKEMISTO_SEARCH_URL,
        allowedHosts: ALLOWED_DIGIHAKEMISTO_HOSTS,
        label: 'Digihakemisto search',
        body: new URLSearchParams({ query }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const html = resp.bytes.toString('utf8');
      checkNotChallenged(resp.headers, html, 'Digihakemisto search');
      return { archives: parseDigihakemistoSearch(html) };
    },
    cacheable: (r) => Array.isArray(r.archives),
    validateCached: isArchivesSearchCachePayload,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  let archives = [...data.archives];
  if (digitizedOnly) {
    archives = archives.filter((a) => a.digitized);
  }
  const total = archives.length;
  archives = archives.slice(0, limit);

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        query,
        total,
        returned: archives.length,
        archives,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [
    `Digihakemisto "${query}": ${total} match(es), showing ${archives.length}:${marker}`,
  ];
  for (const arch of archives) {
    const flag = arch.digitized ? '[digitized]' : '[not-digitized]';
    lines.push(`- ${arch.id} ${flag} ${arch.title}`);
    if (arch.comment) {
      lines.push(`  ${arch.comment}`);
    }
    lines.push(`  ${arch.digihakemisto_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

async function runArchiveInspect(
  argv: readonly string[],
  ctx: RecordCommandContext
): Promise<RecordCommandOutcome> {
  const parsed = parseCommandArgs(argv, ARCHIVE_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives archive <ARCHIVE_ID> [options]',
          summary: 'Inspect one Digihakemisto/Astia archive series or volume list.',
          options: ARCHIVE_OPTIONS,
        })
      ),
    };
  }

  const limit = getNumberOption(parsed, 'limit') ?? 50;
  if (limit < 1 || limit > 500) {
    throw new CliValidationError('--limit must be between 1 and 500.');
  }
  const archiveId = parseArchiveId(parsed.positionals[0]);
  const refresh = getBooleanOption(parsed, 'refresh');
  const ttlHours = resolveTtlHours(getNumberOption(parsed, 'cacheTtlHours'), ctx);
  const digitizedOnly = getBooleanOption(parsed, 'digitized');
  const url = `${DIGIHAKEMISTO_ARCHIVE_BASE}/${archiveId}`;

  const { value: detail, cacheHit } = await cachedJsonCall<DigihakemistoArchiveDetail>({
    cacheDir: getCacheDir(ctx),
    kind: 'digihakemisto_archive',
    payload: { id: archiveId },
    ttlHours,
    refresh,
    fetch: async () => {
      const resp = await requestWithRetry(ctx, {
        method: 'GET',
        url,
        allowedHosts: ALLOWED_DIGIHAKEMISTO_HOSTS,
        label: 'Digihakemisto archive',
      });
      const html = resp.bytes.toString('utf8');
      checkNotChallenged(resp.headers, html, 'Digihakemisto archive');
      return parseDigihakemistoArchive(html, archiveId);
    },
    cacheable: (r) => Boolean(r.title) || r.children.length > 0,
    validateCached: isDigihakemistoArchiveDetail,
    nowMs: ctx.nowMs,
    sleepFn: ctx.sleepFn,
  });

  let children = [...detail.children];
  if (digitizedOnly) {
    children = children.filter((c) => c.digitized);
  }
  const totalChildren = children.length;
  children = children.slice(0, limit);

  if (getBooleanOption(parsed, 'asJson')) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, {
        ...detail,
        total_children: totalChildren,
        returned_children: children.length,
        children,
        cache_hit: cacheHit,
      }),
      cacheHit,
    };
  }

  const marker = cacheHit ? ' [cache]' : '';
  const lines: string[] = [`${detail.id}  ${detail.title}${marker}`];
  if (detail.astia_url) {
    lines.push(`  Astia: ${detail.astia_url}`);
  }
  for (const note of detail.notes) {
    lines.push(`  Note: ${note}`);
  }
  lines.push(`  Children: ${children.length} of ${totalChildren}`);
  for (const child of children) {
    const flag = child.digitized ? '[digitized]' : '[not-digitized]';
    lines.push(`  - ${child.id} ${flag} ${child.title}`);
    if (child.comment) {
      lines.push(`    ${child.comment}`);
    }
    lines.push(`    ${child.digihakemisto_url}`);
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

function normalizeOptionalValueFlags(argv: readonly string[], optionalFlags: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    out.push(token);
    if (optionalFlags.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        out.push('');
      }
    }
  }
  return out;
}

function runUrl(argv: readonly string[], ctx: RecordCommandContext): RecordCommandOutcome {
  const normalized = normalizeOptionalValueFlags(argv, new Set(['--hiski', '--digihakemisto']));
  const parsed = parseCommandArgs(normalized, URL_SPEC);
  if (parsed.helpRequested) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(
        ctx.io,
        formatCommandUsage({
          usage: 'kinloom fi-archives url [options]',
          summary: 'Build verified browser URLs for Finna, Astia, HisKi, Digihakemisto, Digi, SSHY.',
          options: URL_OPTIONS,
        })
      ),
    };
  }

  const lines: string[] = [];
  const finna = getStringOption(parsed, 'finna');
  if (finna) {
    lines.push(
      `${FINNA_SEARCH_URL}?${new URLSearchParams({ lookfor: finna.trim(), type: 'AllFields' }).toString()}`
    );
  }
  if (getBooleanOption(parsed, 'astia')) {
    lines.push(ASTIA_SEARCH_URL);
  }
  if (parsed.provided.has('hiski')) {
    const code = (getStringOption(parsed, 'hiski') ?? '').trim();
    if (code && PARISH_CODE_RE.test(code)) {
      lines.push(`${HISKI_ENDPOINT}?en+${code}`);
    } else {
      lines.push(`${HISKI_ENDPOINT}?en`);
    }
  }
  if (parsed.provided.has('digihakemisto')) {
    lines.push(`${DIGIHAKEMISTO_BASE}/`);
  }
  const digi = getStringOption(parsed, 'digi');
  if (digi) {
    lines.push(`${DIGI_NEWSPAPERS_URL}?${new URLSearchParams({ query: digi.trim() }).toString()}`);
  }
  if (getBooleanOption(parsed, 'sshy')) {
    lines.push(SSHY_BASE_URL);
  }

  if (lines.length === 0) {
    lines.push(
      `HisKi:         ${HISKI_ENDPOINT}?en`,
      `Digihakemisto: ${DIGIHAKEMISTO_BASE}/`,
      `Astia (NARC):  ${ASTIA_SEARCH_URL}`,
      `Finna:         ${FINNA_SEARCH_URL}`,
      `SSHY:          ${SSHY_BASE_URL}`,
      `Digi (NLF):    ${DIGI_NEWSPAPERS_URL}`
    );
  }
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
}

export const runFiArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'parishes':
        return await runParishes(rest, ctx);
      case 'hiski':
        return await runHiski(rest, ctx);
      case 'event':
        return await runEvent(rest, ctx);
      case 'archives':
        return await runArchivesSearch(rest, ctx);
      case 'archive':
        return await runArchiveInspect(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom fi-archives --script-help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
