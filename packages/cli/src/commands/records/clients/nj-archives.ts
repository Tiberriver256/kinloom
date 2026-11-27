import { CliValidationError } from '../../../errors.js';
import {
  type CommandParseSpec,
  CookieJar,
  cachedJsonCall,
  collapseWhitespace,
  emitJsonStdout,
  emitStdout,
  extractFormHiddenInputs,
  formatCommandUsage,
  getBooleanOption,
  getNumberOption,
  getStringOption,
  HttpStatusError,
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
} from '../runtime/index.js';

const DEFAULT_CACHE_TTL_HOURS = 168;
const PORTAL_BASE = 'https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/';
const PORTAL_INDEX = `${PORTAL_BASE}index.aspx`;
const MONMOUTH_BASE = 'https://oprs.co.monmouth.nj.us/oprs/Archives/';
const MONMOUTH_SEARCH = `${MONMOUTH_BASE}ASearch.aspx`;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PREFIX = 'ctl00$ContentPlaceHolder1$';
const GRID_TARGET = 'ctl00$ContentPlaceHolder1$GridView1';
const ALLOWED_HOSTS = ['wwwdnet-dos.nj.gov', 'oprs.co.monmouth.nj.us'] as const;
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);

export interface NjDatabaseSpec {
  readonly title: string;
  readonly page: string;
  readonly target: string;
  readonly count: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly roles?: readonly string[];
  readonly notes?: string;
}

export const DATABASES: Readonly<Record<string, NjDatabaseSpec>> = {
  land: {
    title: 'Early Land Records, ca. 1650-1900s',
    page: 'EarlyLandRecords.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl02$lbtnColonialMarriages',
    count: '75,685 land records, over 397,267 names (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      role: 'ddlToFrom',
      location: 'txtLocation',
      county: 'ddlCounty',
      from_year: 'EYear',
      to_year: 'LYear',
    },
    roles: ['Grantor', 'Grantee', 'Named', 'Official'],
    notes:
      'First stop for colonial New Jersey landholdings. Most deeds after 1785 were recorded at the county level, not the State. Result rows link to scanned PDFs.',
  },
  'supreme-court': {
    title: 'Supreme Court Case Files, 1704-1844',
    page: 'SupremeCourt.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl03$lbtnColonialMarriages',
    count: '55,114 case files, over 234,709 names (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      role: 'ddlRoleList',
      case_type: 'txtCaseType',
      county: 'ddlCountyList',
      from_year: 'EYear',
      to_year: 'LYear',
      case_number: 'txtCN',
    },
    roles: ['Plaintiff', 'Defendant', 'Official', 'Victim', 'Other'],
  },
  'colonial-marriages': {
    title: 'Colonial Marriage Bonds, ca. 1666-1799',
    page: 'ColonialMarriages.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl02$lbtnColonialMarriages',
    count: '11,533 marriage bonds',
    fields: {
      surname: 'txtGRLN',
      given: 'txtGRFN',
      spouse_surname: 'txtBRLN',
      spouse_given: 'txtBRFN',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
      location: 'ddlLocationList',
    },
  },
  'marriages-1848-1900': {
    title: 'Marriage Records, May 1848 - December 1900',
    page: 'Marriage1867.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl03$lbtnColonialMarriages',
    count: 'Approximately 492,000 marriage records',
    fields: {
      surname: 'txtGRLN',
      given: 'txtGRFN',
      spouse_surname: 'txtBRLN',
      spouse_given: 'txtBRFN',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
      county: 'ddlCountyList',
    },
  },
  'deaths-1848-1878': {
    title: 'Death Records, May 1848 - May 1878',
    page: 'DeathIndex1848.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl04$lbtnColonialMarriages',
    count: 'Over 303,172 death records (data entry ongoing)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      from_year: 'Year1',
      to_year: 'Year2',
      county: 'ddlCountyList',
    },
  },
  'deaths-1878-1900': {
    title: 'Death Records, June 1878 - December 1900',
    page: 'DeathIndex.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView1$ctl05$lbtnColonialMarriages',
    count: '628,584 death records (data entry complete)',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      from_year: 'Year1',
      to_year: 'Year2',
      county: 'ddlCountyList',
    },
  },
  'name-changes': {
    title: 'Legal Name Changes, 1847-1947',
    page: 'NameChanges.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl04$lbtnColonialMarriages',
    count: '12,254 name changes, 46,010 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'census-1885': {
    title: '1885 State Census - Passaic County and Atlantic City',
    page: 'Census1885.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView3$ctl05$lbtnColonialMarriages',
    count: '69,302 names',
    fields: { surname: 'txtLN', given: 'txtFN', location: 'ddlLocation' },
  },
  'revwar-damage': {
    title: 'Revolutionary War Damage Claims, 1776-1783',
    page: 'RevWarDamages.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl02$lbtnColonialMarriages',
    count: '2,662 claims, 7,435 names',
    fields: {
      surname: 'txtLN',
      given: 'txtFN',
      county: 'ddlCounty',
      location: 'ddlLocation',
      from_year: 'EYear',
      to_year: 'LYear',
    },
  },
  'civilwar-service': {
    title: 'Civil War Service Records, 1861-1865',
    page: 'StrykerCivilWar.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl03$lbtnColonialMarriages',
    count: '82,471 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'civilwar-vouchers': {
    title: 'Civil War Payment Vouchers, 1861-1865',
    page: 'CivilWarVouchers.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl04$lbtnColonialMarriages',
    count: '15,770 vouchers, 114,212 names',
    fields: { surname: 'txtLN', given: 'txtFN' },
  },
  'wwi-deaths': {
    title: 'World War I Deaths',
    page: 'WWICards.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl05$lbtnColonialMarriages',
    count: '3,427 names (9,310 scanned images)',
    fields: { surname: 'txtLN', given: 'txtFN', county: 'ddlNJCounty' },
  },
  'natguard-photos': {
    title: 'New Jersey National Guard Photographs',
    page: 'natguard1.aspx',
    target: 'ctl00$ContentPlaceHolder1$GridView5$ctl06$lbtnColonialMarriages',
    count: '1,316 images',
    fields: {
      keyword: 'txtSearch',
      location: 'txtLocation',
      from_year: 'txtEYear',
      to_year: 'txtLYear',
    },
  },
};

export const ORDER_ONLY: Readonly<Record<string, readonly [string, string, string, string]>> = {
  'births-1848-1925': [
    'Birth Record Search: May 1, 1848 - December 31, 1925',
    'BirthRecordsRequest.aspx',
    'GridView2',
    'ctl02',
  ],
  'marriages-1848-1950': [
    'Marriage Record Search: May 1, 1848 - December 31, 1950',
    'MarriageRecordsRequest.aspx',
    'GridView2',
    'ctl03',
  ],
  'deaths-1848-1950': [
    'Death Record Search: May 1, 1848 - December 31, 1950',
    'DeathRecordsRequest.aspx',
    'GridView2',
    'ctl04',
  ],
  'county-clerks-marriages': [
    "County Clerks' Marriage Record Search",
    'CountyMarriageRecordRequest.aspx',
    'GridView2',
    'ctl05',
  ],
  probate: ['Probate Record Search, ca. 1660-1952', 'ProbateRecordRequest.aspx', 'GridView4', 'ctl02'],
  naturalization: [
    'County Naturalization Record Search',
    'NaturalizationRecordRequest.aspx',
    'GridView4',
    'ctl03',
  ],
  'revwar-search': ['Revolutionary War Record Search', 'RevWarRecordRequest.aspx', 'GridView6', 'ctl02'],
  'wwi-search': ['World War I Record Search', 'WorldWarIRecordRequest.aspx', 'GridView6', 'ctl03'],
};

const MARRIAGE_DATABASES = new Set<string>(['colonial-marriages', 'marriages-1848-1900']);
const SUBMIT_BUTTON: Readonly<Record<string, string>> = { 'natguard-photos': 'btnSearch' };

const DATABASE_ALIASES: Readonly<Record<string, string>> = {
  'colonial-marriage': 'colonial-marriages',
  'marriages-colonial': 'colonial-marriages',
  'marriage-colonial': 'colonial-marriages',
  'colonial-marriage-bonds': 'colonial-marriages',
  'marriage-bonds': 'colonial-marriages',
  marriages: 'marriages-1848-1900',
  marriage: 'marriages-1848-1900',
  'marriages-1848': 'marriages-1848-1900',
  deaths: 'deaths-1878-1900',
  'deaths-1848': 'deaths-1848-1878',
  'deaths-1878': 'deaths-1878-1900',
  'land-records': 'land',
  'early-land-records': 'land',
  deeds: 'land',
  supreme: 'supreme-court',
  court: 'supreme-court',
  'name-change': 'name-changes',
  census: 'census-1885',
  revwar: 'revwar-damage',
  'revwar-damages': 'revwar-damage',
  civilwar: 'civilwar-service',
  wwi: 'wwi-deaths',
  natguard: 'natguard-photos',
};

const MONMOUTH_TOWNS = [
  'Atlantic',
  'Freehold',
  'Holmdel',
  'Howell',
  'Marlboro',
  'Middletown',
  'Ocean',
  'Shrewsbury',
  'Upper Freehold',
  'Wall',
] as const;

const MONMOUTH_CATEGORIES = [
  'Agriculture',
  'Commerce',
  'Manufactures',
  'Mining',
  'Population',
  'Return of Births',
  'Return of Deaths',
] as const;

export interface NjGridLink {
  readonly text: string;
  readonly href: string;
}

export interface NjGridRow {
  readonly links: readonly NjGridLink[];
  readonly [column: string]: string | readonly NjGridLink[];
}

export interface NjSearchResult {
  readonly database: string;
  readonly title?: string;
  readonly headers: readonly string[];
  readonly rows: readonly NjGridRow[];
  readonly capped_500?: boolean;
  readonly pages_read: number;
  readonly cache_hit?: boolean;
}

interface NjDatabaseEntry {
  readonly key: string;
  readonly title: string;
  readonly count: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getCacheDir(ctx: RecordCommandContext): string {
  return resolveCacheDir({
    env: ctx.env,
    envVars: ['KINLOOM_NJ_ARCHIVES_CACHE_DIR'],
    defaultSubdir: 'kinloom-nj-archives',
  });
}

function resolveTtl(cliTtl: number | undefined, ctx: RecordCommandContext): number {
  return parseCacheTtlHours(
    cliTtl !== undefined ? cliTtl : ctx.env.KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS,
    DEFAULT_CACHE_TTL_HOURS,
    cliTtl !== undefined ? '--cache-ttl-hours' : 'KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS'
  );
}

function longestCommonBlock(
  a: string,
  aLo: number,
  aHi: number,
  b: string,
  bLo: number,
  bHi: number
): readonly [number, number, number] {
  let bestI = aLo;
  let bestJ = bLo;
  let bestSize = 0;
  let prev = new Map<number, number>();
  for (let i = aLo; i < aHi; i += 1) {
    const next = new Map<number, number>();
    for (let j = bLo; j < bHi; j += 1) {
      if (a[i] === b[j]) {
        const k = (prev.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestSize) {
          bestI = i - k + 1;
          bestJ = j - k + 1;
          bestSize = k;
        }
      }
    }
    prev = next;
  }
  return [bestI, bestJ, bestSize];
}

export function sequenceSimilarity(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) {
    return 1;
  }
  let matched = 0;
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length > 0) {
    const seg = stack.pop();
    if (!seg) break;
    const [aLo, aHi, bLo, bHi] = seg;
    const [i, j, size] = longestCommonBlock(a, aLo, aHi, b, bLo, bHi);
    if (size > 0) {
      matched += size;
      if (aLo < i && bLo < j) {
        stack.push([aLo, i, bLo, j]);
      }
      if (i + size < aHi && j + size < bHi) {
        stack.push([i + size, aHi, j + size, bHi]);
      }
    }
  }
  return (2 * matched) / total;
}

export function getCloseMatches(
  word: string,
  possibilities: readonly string[],
  n = 3,
  cutoff = 0.6
): string[] {
  const scored: { readonly score: number; readonly candidate: string }[] = [];
  for (const candidate of possibilities) {
    const score = sequenceSimilarity(word, candidate);
    if (score >= cutoff) {
      scored.push({ score, candidate });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, n).map((s) => s.candidate);
}

export function resolveDatabase(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if (key in DATABASES || key in ORDER_ONLY || key === 'monmouth') {
    return key;
  }
  if (key in DATABASE_ALIASES) {
    return DATABASE_ALIASES[key];
  }
  const known = [...Object.keys(DATABASES), ...Object.keys(ORDER_ONLY), ...Object.keys(DATABASE_ALIASES)];
  const close = getCloseMatches(key, known, 3, 0.6);
  const mapped = close.map((c) => DATABASE_ALIASES[c] ?? c);
  const hint = mapped.length > 0 ? ` Did you mean: ${mapped.join(', ')}?` : '';
  throw new CliValidationError(
    `unknown database '${name}'.${hint} Valid: ${Object.keys(DATABASES).join(', ')}. Run \`nj-archives databases\` for the live list.`
  );
}

function hiddenFields(pageHtml: string): Record<string, string> {
  const $ = loadHtml(pageHtml);
  return extractFormHiddenInputs($);
}

function formAction(pageHtml: string): string | null {
  const $ = loadHtml(pageHtml);
  const action = $('form').first().attr('action');
  return action !== undefined ? action : null;
}

function selectOptions(pageHtml: string, shortName: string): string[] {
  const $ = loadHtml(pageHtml);
  const targetName = `${PREFIX}${shortName}`;
  const out: string[] = [];
  $('select').each((_idx, el) => {
    if ($(el).attr('name') === targetName) {
      $(el)
        .find('option')
        .each((_oIdx, optEl) => {
          out.push($(optEl).attr('value') ?? '');
        });
    }
  });
  return out;
}

export function parseGrid(pageHtml: string, tableHint: string): readonly [string[], NjGridRow[]] {
  const $ = loadHtml(pageHtml);
  let targetTable: ReturnType<typeof $> | null = null;
  $('table[id]').each((_idx, el) => {
    if (targetTable) return;
    const id = $(el).attr('id') ?? '';
    if (id.includes(tableHint)) {
      targetTable = $(el);
    }
  });
  if (!targetTable) {
    return [[], []];
  }

  let headers: string[] = [];
  const rows: NjGridRow[] = [];

  const tableRows = (targetTable as ReturnType<typeof $>).find('tr');
  tableRows.each((_rIdx, trEl) => {
    const tr = $(trEl);
    const rowHtml = $.html(tr) ?? '';
    const cells = tr.children('td, th');
    if (cells.length === 0) {
      return;
    }
    const texts: string[] = [];
    cells.each((_cIdx, cellEl) => {
      texts.push(collapseWhitespace($(cellEl).text()));
    });

    if (texts.every((t) => t === '')) {
      return;
    }
    if (texts.length === 1 && texts[0] === 'No Records Found') {
      headers = [];
      rows.length = 0;
      return false;
    }
    if (texts.length === 1 && /^[\d\s.]+$/.test(texts[0])) {
      return; // single-cell pager row
    }
    if (rowHtml.includes('Page$') && texts.filter(Boolean).every((t) => /^(?:\d+|\.{2,3})$/.test(t))) {
      return; // multi-cell ASP.NET GridView pager row
    }

    const links: NjGridLink[] = [];
    tr.find('a[href]').each((_aIdx, aEl) => {
      const href = $(aEl).attr('href');
      if (href) {
        links.push({ text: collapseWhitespace($(aEl).text()), href });
      }
    });
    const popupRe = /PopUpBig\((?:&#39;|')([^'&]+?)(?:&#39;|')\)/g;
    let popupMatch: RegExpExecArray | null = popupRe.exec(rowHtml);
    while (popupMatch !== null) {
      const pdfPath = popupMatch[1];
      const href = pdfPath.startsWith('http') ? pdfPath : `https://oprs.co.monmouth.nj.us${pdfPath}`;
      links.push({ text: 'census page image', href });
      popupMatch = popupRe.exec(rowHtml);
    }

    const hasTh = tr.children('th').length > 0;
    const isHeader =
      hasTh || (headers.length === 0 && texts.filter(Boolean).every((text) => !/\d/.test(text)));
    if (isHeader) {
      headers = texts;
      return;
    }
    if (headers.length === 0) {
      headers = texts.map((_, idx) => `col${idx + 1}`);
    }
    const rowObj: Record<string, string | readonly NjGridLink[]> = {};
    const limit = Math.min(headers.length, texts.length);
    for (let i = 0; i < limit; i += 1) {
      rowObj[headers[i]] = texts[i];
    }
    rowObj.links = links;
    rows.push(rowObj as NjGridRow);
  });

  return [headers, rows];
}

function cappedNotice(pageHtml: string): boolean {
  const $ = loadHtml(pageHtml);
  return collapseWhitespace($.text()).includes('Results are limited to 500 records per search');
}

export function hasPageLink(pageHtml: string, pageNum: number, gridTarget: string = GRID_TARGET): boolean {
  const escaped = gridTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `__doPostBack\\((?:&#39;|')${escaped}(?:&#39;|'),\\s*(?:&#39;|')Page\\$${pageNum}(?:&#39;|')\\)`
  );
  return pattern.test(pageHtml);
}

export function matchOptionValue(value: string, options: readonly string[]): string | null {
  if (options.includes(value)) {
    return value;
  }
  const norm = value.trim().toLowerCase();
  for (const opt of options) {
    if (opt.trim().toLowerCase() === norm) {
      return opt;
    }
  }
  const stripped = norm.replace(/\s+county$/, '');
  for (const opt of options) {
    const optNorm = opt
      .trim()
      .toLowerCase()
      .replace(/\s+county$/, '');
    if (optNorm && optNorm === stripped) {
      return opt;
    }
  }
  return null;
}

export interface NjSearchCriteria {
  readonly surname?: string | null;
  readonly given?: string | null;
  readonly spouse_surname?: string | null;
  readonly spouse_given?: string | null;
  readonly county?: string | null;
  readonly location?: string | null;
  readonly from_year?: string | null;
  readonly to_year?: string | null;
  readonly role?: string | null;
  readonly case_type?: string | null;
  readonly case_number?: string | null;
  readonly keyword?: string | null;
}

function validateCriteria(
  criteria: NjSearchCriteria,
  spec: NjDatabaseSpec,
  pageHtml: string
): Record<string, string | null | undefined> {
  const resolved: Record<string, string | null | undefined> = { ...criteria };
  for (const [option, value] of Object.entries(criteria)) {
    if (value === null || value === undefined || !(option in spec.fields)) {
      continue;
    }
    const short = spec.fields[option];
    const options = selectOptions(pageHtml, short);
    if (options.length > 0) {
      const matched = matchOptionValue(value, options);
      if (matched === null) {
        const valid = options.filter(Boolean).join(', ');
        throw new CliValidationError(
          `--${option.replace(/_/g, '-')} '${value}' is not a valid choice for ${spec.title}; valid: ${valid}`
        );
      }
      resolved[option] = matched;
    }
  }
  if (spec.roles && resolved.role !== null && resolved.role !== undefined) {
    const matchedRole = matchOptionValue(resolved.role, spec.roles);
    if (matchedRole === null) {
      throw new CliValidationError(
        `--role '${resolved.role}' is not valid here; valid: ${spec.roles.join(', ')}`
      );
    }
    resolved.role = matchedRole;
  }
  return resolved;
}

async function portalGet(
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

async function portalPost(
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

async function listPortalDatabases(ctx: RecordCommandContext): Promise<NjDatabaseEntry[]> {
  const jar = new CookieJar();
  const page = await portalGet(ctx, jar, PORTAL_INDEX);
  const byTarget = new Map<string, string>();
  for (const [key, spec] of Object.entries(DATABASES)) {
    byTarget.set(spec.target, key);
  }
  const $ = loadHtml(page);
  const found: NjDatabaseEntry[] = [];
  $('table[id]').each((_tIdx, tableEl) => {
    const id = $(tableEl).attr('id') ?? '';
    if (!/GridView\d+/.test(id)) return;
    $(tableEl)
      .find('tr')
      .each((_rIdx, trEl) => {
        const rowHtml = $.html(trEl) ?? '';
        const targetMatch = /__doPostBack\((?:&#39;|')([^'&]+?)(?:&#39;|')/.exec(rowHtml);
        if (!targetMatch) return;
        const cells: string[] = [];
        $(trEl)
          .find('td')
          .each((_cIdx, tdEl) => {
            cells.push(collapseWhitespace($(tdEl).text()));
          });
        found.push({
          key: byTarget.get(targetMatch[1]) ?? '',
          title: cells[0] ?? '',
          count: cells[1] ?? '',
        });
      });
  });
  return found;
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

async function searchMonmouth(
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

function emitNjResult(
  ctx: RecordCommandContext,
  result: NjSearchResult,
  cacheHit: boolean,
  asJson: boolean,
  limit: number | undefined
): RecordCommandOutcome {
  const total = result.rows.length;
  const rows = limit !== undefined ? result.rows.slice(0, limit) : result.rows;
  if (asJson) {
    return {
      exitCode: 0,
      bytesOut: emitJsonStdout(ctx.io, { ...result, rows, cache_hit: cacheHit }),
      cacheHit,
    };
  }
  const title = result.title ?? result.database;
  if (rows.length === 0) {
    return {
      exitCode: 0,
      bytesOut: emitStdout(ctx.io, `${title}: no records found.`),
      cacheHit,
    };
  }
  const headerLine =
    `${title}: ${rows.length} result(s)` +
    (cacheHit ? ' [cache]' : '') +
    (result.capped_500 && total >= 500 ? ' (search capped at 500 records; narrow the criteria)' : '') +
    (result.pages_read > 1 ? ` (pages read: ${result.pages_read})` : '');
  const lines: string[] = [headerLine];
  const visibleHeaders = result.headers.filter((h) => h !== 'Select');
  rows.forEach((row, idx) => {
    const cells = visibleHeaders
      .map((h) => {
        const val = row[h];
        return typeof val === 'string' ? val : '';
      })
      .filter(Boolean);
    lines.push(`${idx + 1}. ${cells.join(' | ')}`);
    for (const link of row.links) {
      if (link.href.toLowerCase().endsWith('.pdf')) {
        lines.push(`   PDF: ${link.href}`);
      }
    }
  });
  return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')), cacheHit };
}

const DATABASES_OPTIONS: readonly OptionSpec[] = [
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const SEARCH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname', '--last', '--last-name'],
    help: 'Surname to search. Marriage databases accept --spouse-surname alone; natguard-photos uses --keyword.',
  },
  {
    key: 'given',
    kind: 'string',
    flags: ['--given', '--first', '--first-name'],
    help: 'Given name.',
  },
  {
    key: 'spouseSurname',
    kind: 'string',
    flags: ['--spouse-surname', '--spouse', '--bride-surname'],
    help: 'Spouse surname (marriage databases).',
  },
  {
    key: 'spouseGiven',
    kind: 'string',
    flags: ['--spouse-given', '--bride-given'],
    help: 'Spouse given name (marriage databases).',
  },
  { key: 'county', kind: 'string', flags: ['--county'], help: 'County filter.' },
  { key: 'location', kind: 'string', flags: ['--location'], help: 'Location filter.' },
  {
    key: 'fromYear',
    kind: 'integer',
    flags: ['--from-year', '--start-year'],
    help: 'Earliest year.',
  },
  {
    key: 'toYear',
    kind: 'integer',
    flags: ['--to-year', '--end-year'],
    help: 'Latest year.',
  },
  {
    key: 'role',
    kind: 'string',
    flags: ['--role'],
    help: 'Role, e.g. Grantee (land) or Defendant (supreme-court).',
  },
  {
    key: 'caseType',
    kind: 'string',
    flags: ['--case-type'],
    help: 'Case type (supreme-court).',
  },
  {
    key: 'caseNumber',
    kind: 'string',
    flags: ['--case-number'],
    help: 'Case number (supreme-court).',
  },
  { key: 'keyword', kind: 'string', flags: ['--keyword'], help: 'Keyword (natguard-photos).' },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, help: 'Max rows to show.' },
  {
    key: 'pages',
    kind: 'integer',
    flags: ['--pages'],
    default: 1,
    help: 'Result pages to read (stops cleanly if fewer pages exist).',
  },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query the portal.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168; env KINLOOM_NJ_ARCHIVES_CACHE_TTL_HOURS).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const MONMOUTH_OPTIONS: readonly OptionSpec[] = [
  {
    key: 'surname',
    kind: 'string',
    flags: ['--surname', '--last', '--name'],
    required: true,
    help: 'Person name to search.',
  },
  {
    key: 'town',
    kind: 'string',
    flags: ['--town'],
    default: 'ALL',
    help: `Town, or ALL. Choices: ${MONMOUTH_TOWNS.join(', ')}`,
  },
  {
    key: 'category',
    kind: 'string',
    flags: ['--category'],
    default: 'ALL',
    help: `Category, or ALL. Choices: ${MONMOUTH_CATEGORIES.join(', ')}`,
  },
  {
    key: 'match',
    kind: 'string',
    flags: ['--match'],
    choices: ['starts', 'contains'],
    default: 'contains',
  },
  { key: 'limit', kind: 'integer', flags: ['--limit'], min: 0, help: 'Max rows to show.' },
  {
    key: 'refresh',
    kind: 'boolean',
    flags: ['--refresh'],
    help: 'Bypass the disk cache and re-query Monmouth OPRS.',
  },
  {
    key: 'cacheTtlHours',
    kind: 'number',
    flags: ['--cache-ttl-hours'],
    min: 0,
    metavar: 'HOURS',
    help: 'Cache TTL in hours (default 168).',
  },
  { key: 'asJson', kind: 'boolean', flags: ['--json'], help: 'Emit JSON.' },
];

const DATABASES_SPEC: CommandParseSpec = {
  options: DATABASES_OPTIONS,
  allowPositionals: false,
};
const SEARCH_SPEC: CommandParseSpec = {
  options: SEARCH_OPTIONS,
  allowPositionals: true,
  minPositionals: 1,
  maxPositionals: 1,
  positionalLabel: 'database',
};
const MONMOUTH_SPEC: CommandParseSpec = {
  options: MONMOUTH_OPTIONS,
  allowPositionals: false,
};
const URL_SPEC: CommandParseSpec = {
  options: [],
  allowPositionals: true,
  maxPositionals: 1,
  positionalLabel: 'database',
};

function isNjSearchResult(value: unknown): value is NjSearchResult {
  return (
    isPlainRecord(value) &&
    typeof value.database === 'string' &&
    Array.isArray(value.headers) &&
    Array.isArray(value.rows)
  );
}

function renderRootHelp(): string {
  return formatCommandUsage({
    usage: 'kinloom nj-archives <command> [options]',
    summary: 'Search New Jersey State Archives databases and the Monmouth County OPRS 1875 census.',
    subcommands: [
      { name: 'databases', summary: 'List the searchable databases on the NJ State Archives portal.' },
      {
        name: 'search',
        summary: 'Search one portal database, e.g. nj-archives search land --surname Lincoln.',
      },
      { name: 'monmouth', summary: 'Search the Monmouth County OPRS 1875 census by person name.' },
      { name: 'url', summary: 'Print the browser URL for the portal, a database, or Monmouth OPRS.' },
    ],
  });
}

export const runNjArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;

    switch (subcmd) {
      case 'databases': {
        const parsed = parseCommandArgs(rest, DATABASES_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom nj-archives databases [options]',
                summary: 'List the searchable databases on the NJ State Archives portal.',
                options: DATABASES_OPTIONS,
              })
            ),
          };
        }
        const live = await listPortalDatabases(ctx);
        if (getBooleanOption(parsed, 'asJson')) {
          return { exitCode: 0, bytesOut: emitJsonStdout(ctx.io, live) };
        }
        const lines: string[] = [];
        for (const entry of live) {
          const key = entry.key ? ` [${entry.key}]` : '';
          const count = entry.count ? ` -- ${entry.count}` : '';
          lines.push(`${entry.title}${key}${count}`);
        }
        lines.push('', 'Order-form only (no online search; use `nj-archives url <key>`):');
        for (const [key, [title]] of Object.entries(ORDER_ONLY)) {
          lines.push(`  ${title} [${key}]`);
        }
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, lines.join('\n')) };
      }

      case 'search': {
        const parsed = parseCommandArgs(rest, SEARCH_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom nj-archives search <DATABASE> [options]',
                summary:
                  'Search one portal database, e.g. kinloom nj-archives search land --surname Lincoln.',
                options: SEARCH_OPTIONS,
              })
            ),
          };
        }
        const database = resolveDatabase(parsed.positionals[0] ?? '');
        if (database === 'monmouth') {
          throw new CliValidationError(
            'Monmouth 1875 census is its own command: `nj-archives monmouth --surname <name>`.'
          );
        }
        if (database in ORDER_ONLY) {
          const [title, page] = ORDER_ONLY[database];
          throw new CliValidationError(
            `${title} has no online search; it is a records-request (order) form. Open it in a browser: ${PORTAL_BASE}${page}`
          );
        }

        const surname = getStringOption(parsed, 'surname') ?? null;
        const given = getStringOption(parsed, 'given') ?? null;
        const spouseSurname = getStringOption(parsed, 'spouseSurname') ?? null;
        const spouseGiven = getStringOption(parsed, 'spouseGiven') ?? null;
        const county = getStringOption(parsed, 'county') ?? null;
        const location = getStringOption(parsed, 'location') ?? null;
        const fromYearNum = getNumberOption(parsed, 'fromYear');
        const toYearNum = getNumberOption(parsed, 'toYear');
        const role = getStringOption(parsed, 'role') ?? null;
        const caseType = getStringOption(parsed, 'caseType') ?? null;
        const caseNumber = getStringOption(parsed, 'caseNumber') ?? null;
        let keyword = getStringOption(parsed, 'keyword') ?? null;
        const limit = getNumberOption(parsed, 'limit');
        const pages = Math.max(1, getNumberOption(parsed, 'pages') ?? 1);
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
        const asJson = getBooleanOption(parsed, 'asJson');

        if (database === 'natguard-photos') {
          if (!keyword && !surname) {
            throw new CliValidationError('natguard-photos requires --keyword (or --surname as keyword).');
          }
          if (!keyword && surname) {
            keyword = surname;
          }
        } else if (!surname) {
          if (!(MARRIAGE_DATABASES.has(database) && spouseSurname)) {
            throw new CliValidationError(
              `Missing option '--surname'${MARRIAGE_DATABASES.has(database) ? ' (or --spouse-surname for marriage databases).' : '.'}`
            );
          }
        }

        const criteria: NjSearchCriteria = {
          surname,
          given,
          spouse_surname: spouseSurname,
          spouse_given: spouseGiven,
          county,
          location,
          from_year: fromYearNum !== undefined ? String(fromYearNum) : null,
          to_year: toYearNum !== undefined ? String(toYearNum) : null,
          role,
          case_type: caseType,
          case_number: caseNumber,
          keyword,
        };

        const { value: result, cacheHit } = await cachedJsonCall<NjSearchResult>({
          cacheDir: getCacheDir(ctx),
          kind: 'search',
          payload: { database, criteria, pages },
          ttlHours,
          refresh,
          fetch: () => searchPortal(ctx, database, criteria, pages),
          validateCached: isNjSearchResult,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });
        return emitNjResult(ctx, result, cacheHit, asJson, limit);
      }

      case 'monmouth': {
        const parsed = parseCommandArgs(rest, MONMOUTH_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom nj-archives monmouth --surname <NAME> [options]',
                summary: 'Search the Monmouth County OPRS 1875 census by person name.',
                options: MONMOUTH_OPTIONS,
              })
            ),
          };
        }
        const surname = getStringOption(parsed, 'surname') ?? '';
        const town = getStringOption(parsed, 'town') ?? 'ALL';
        const category = getStringOption(parsed, 'category') ?? 'ALL';
        const match = getStringOption(parsed, 'match') ?? 'contains';
        const limit = getNumberOption(parsed, 'limit');
        const refresh = getBooleanOption(parsed, 'refresh');
        const ttlHours = resolveTtl(getNumberOption(parsed, 'cacheTtlHours'), ctx);
        const asJson = getBooleanOption(parsed, 'asJson');

        const townMatch = matchOptionValue(town, ['ALL', ...MONMOUTH_TOWNS]);
        if (townMatch === null) {
          throw new CliValidationError(
            `--town '${town}' is not valid; valid: ALL, ${MONMOUTH_TOWNS.join(', ')}`
          );
        }
        const categoryMatch = matchOptionValue(category, ['ALL', ...MONMOUTH_CATEGORIES]);
        if (categoryMatch === null) {
          throw new CliValidationError(
            `--category '${category}' is not valid; valid: ALL, ${MONMOUTH_CATEGORIES.join(', ')}`
          );
        }

        const { value: result, cacheHit } = await cachedJsonCall<NjSearchResult>({
          cacheDir: getCacheDir(ctx),
          kind: 'monmouth',
          payload: { surname, town: townMatch, category: categoryMatch, match },
          ttlHours,
          refresh,
          fetch: () => searchMonmouth(ctx, surname, townMatch, categoryMatch, match),
          validateCached: isNjSearchResult,
          nowMs: ctx.nowMs,
          sleepFn: ctx.sleepFn,
        });
        return emitNjResult(ctx, result, cacheHit, asJson, limit);
      }

      case 'url': {
        const parsed = parseCommandArgs(rest, URL_SPEC);
        if (parsed.helpRequested) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              formatCommandUsage({
                usage: 'kinloom nj-archives url [DATABASE]',
                summary: 'Print the browser URL for the portal, a database, or Monmouth OPRS.',
              })
            ),
          };
        }
        const rawDb = parsed.positionals[0];
        if (!rawDb) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              `Portal index: ${PORTAL_INDEX}\nMonmouth County OPRS 1875 census: ${MONMOUTH_SEARCH}`
            ),
          };
        }
        const database = resolveDatabase(rawDb);
        if (database === 'monmouth') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, MONMOUTH_SEARCH) };
        }
        if (database in DATABASES) {
          return {
            exitCode: 0,
            bytesOut: emitStdout(ctx.io, `${PORTAL_BASE}${DATABASES[database].page}`),
          };
        }
        if (database in ORDER_ONLY) {
          const [title, page] = ORDER_ONLY[database];
          return {
            exitCode: 0,
            bytesOut: emitStdout(
              ctx.io,
              `${title} (records-request form, no online search):\n${PORTAL_BASE}${page}`
            ),
          };
        }
        throw new CliValidationError(
          `unknown database '${rawDb}'; run \`nj-archives databases\` for the list`
        );
      }

      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom nj-archives --script-help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
