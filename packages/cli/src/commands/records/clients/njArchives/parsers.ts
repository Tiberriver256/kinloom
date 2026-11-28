import { CliValidationError } from '../../../../errors.js';
import { collapseWhitespace, extractFormHiddenInputs, loadHtml } from '../../runtime/parse.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import {
  DATABASE_ALIASES,
  DATABASES,
  GRID_TARGET,
  type NjDatabaseEntry,
  type NjDatabaseSpec,
  type NjGridLink,
  type NjGridRow,
  type NjSearchCriteria,
  type NjSearchResult,
  ORDER_ONLY,
  PREFIX,
} from './catalog.js';

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
  const aliased = DATABASE_ALIASES[key];
  if (aliased !== undefined) {
    return aliased;
  }
  const known = [...Object.keys(DATABASES), ...Object.keys(ORDER_ONLY), ...Object.keys(DATABASE_ALIASES)];
  const close = getCloseMatches(key, known, 3, 0.6);
  const mapped = close.map((c) => DATABASE_ALIASES[c] ?? c);
  const hint = mapped.length > 0 ? ` Did you mean: ${mapped.join(', ')}?` : '';
  throw new CliValidationError(
    `unknown database '${name}'.${hint} Valid: ${Object.keys(DATABASES).join(', ')}. Run \`nj-archives databases\` for the live list.`
  );
}

export function hiddenFields(pageHtml: string): Record<string, string> {
  const $ = loadHtml(pageHtml);
  return extractFormHiddenInputs($);
}

export function formAction(pageHtml: string): string | null {
  const $ = loadHtml(pageHtml);
  const action = $('form').first().attr('action');
  return action !== undefined ? action : null;
}

export function selectOptions(pageHtml: string, shortName: string): string[] {
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
      return undefined;
    }
    const texts: string[] = [];
    cells.each((_cIdx, cellEl) => {
      texts.push(collapseWhitespace($(cellEl).text()));
    });

    if (texts.every((t) => t === '')) {
      return undefined;
    }
    if (texts.length === 1 && texts[0] === 'No Records Found') {
      headers = [];
      rows.length = 0;
      return false;
    }
    if (texts.length === 1 && /^[\d\s.]+$/.test(texts[0] ?? '')) {
      return undefined; // single-cell pager row
    }
    if (rowHtml.includes('Page$') && texts.filter(Boolean).every((t) => /^(?:\d+|\.{2,3})$/.test(t))) {
      return undefined; // multi-cell ASP.NET GridView pager row
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
      if (pdfPath === undefined) continue;
      const href = pdfPath.startsWith('http') ? pdfPath : `https://oprs.co.monmouth.nj.us${pdfPath}`;
      links.push({ text: 'census page image', href });
      popupMatch = popupRe.exec(rowHtml);
    }

    const hasTh = tr.children('th').length > 0;
    const isHeader =
      hasTh || (headers.length === 0 && texts.filter(Boolean).every((text) => !/\d/.test(text)));
    if (isHeader) {
      headers = texts;
      return undefined;
    }
    if (headers.length === 0) {
      headers = texts.map((_, idx) => `col${idx + 1}`);
    }
    const rowObj: Record<string, string | readonly NjGridLink[]> = {};
    const limit = Math.min(headers.length, texts.length);
    for (let i = 0; i < limit; i += 1) {
      const hdr = headers[i];
      if (hdr !== undefined) rowObj[hdr] = texts[i] ?? '';
    }
    rowObj['links'] = links;
    rows.push(rowObj as NjGridRow);
    return undefined;
  });

  return [headers, rows];
}

export function parsePortalDatabaseList(pageHtml: string): NjDatabaseEntry[] {
  const byTarget = new Map<string, string>();
  for (const [key, spec] of Object.entries(DATABASES)) {
    byTarget.set(spec.target, key);
  }
  const $ = loadHtml(pageHtml);
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
          key: byTarget.get(targetMatch[1] ?? '') ?? '',
          title: cells[0] ?? '',
          count: cells[1] ?? '',
        });
      });
  });
  return found;
}

export function cappedNotice(pageHtml: string): boolean {
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

export function validateCriteria(
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
    const options = short !== undefined ? selectOptions(pageHtml, short) : [];
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
  if (spec.roles && resolved['role'] !== null && resolved['role'] !== undefined) {
    const matchedRole = matchOptionValue(resolved['role'], spec.roles);
    if (matchedRole === null) {
      throw new CliValidationError(
        `--role '${resolved['role']}' is not valid here; valid: ${spec.roles.join(', ')}`
      );
    }
    resolved['role'] = matchedRole;
  }
  return resolved;
}

export function isNjSearchResult(value: unknown): value is NjSearchResult {
  return (
    isPlainRecord(value) &&
    typeof value['database'] === 'string' &&
    Array.isArray(value['headers']) &&
    Array.isArray(value['rows'])
  );
}
