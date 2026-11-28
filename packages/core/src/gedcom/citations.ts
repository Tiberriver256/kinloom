import type { ArchiveEvent, SourceRecord } from '../schemas/entities.js';

export const UNVERIFIED_TREE_SOURCE_ID = 'src_unverified_tree_entry';

const RE_SSN_NUMBER = /\bNumber:\s*\d{3}-\d{2}-\d{4}\s*;?\s*/gi;
const RE_SSN_BARE = /\b\d{3}-\d{2}-\d{4}\b/g;
const NEWSPAPERS_COM_TOKENS = new Set(['newspapers.com', 'www.newspapers.com']);

function isCitationSeparatorChar(code: number): boolean {
  return code === 59 || code === 44 || code <= 32;
}

function trimCitationSeparators(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isCitationSeparatorChar(value.charCodeAt(start))) {
    start += 1;
  }
  while (end > start && isCitationSeparatorChar(value.charCodeAt(end - 1))) {
    end -= 1;
  }
  return value.slice(start, end);
}

const MAX_CITATION_CACHE_SIZE = 16384;
const summaryCleanCache = new Map<string, string>();
const citationDetailCache = new Map<string, string>();
const sourceTitleCache = new Map<string, string>();

function setBoundedCitationCache(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= MAX_CITATION_CACHE_SIZE) {
    cache.clear();
  }
  cache.set(key, value);
}

function hasIrregularWhitespace(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      return true;
    }
    if (c === 32 && i + 1 < s.length && s.charCodeAt(i + 1) === 32) {
      return true;
    }
  }
  return false;
}

// Fast char-code filter for `\d\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}`.
function mayHaveDayMonthYear(s: string): boolean {
  const end = s.length - 8;
  for (let i = 0; i <= end; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) {
      continue;
    }
    if (s.charCodeAt(i + 1) !== 32) {
      continue;
    }
    let mIdx = i + 2;
    while (mIdx <= end && s.charCodeAt(mIdx) === 32) {
      mIdx += 1;
    }
    if (mIdx + 4 >= s.length) {
      return false;
    }
    const m0 = s.charCodeAt(mIdx) | 32;
    // j=106, f=102, m=109, a=97, s=115, o=111, n=110, d=100
    if (
      (m0 === 106 ||
        m0 === 102 ||
        m0 === 109 ||
        m0 === 97 ||
        m0 === 115 ||
        m0 === 111 ||
        m0 === 110 ||
        m0 === 100) &&
      s.charCodeAt(mIdx + 3) === 32
    ) {
      return true;
    }
  }
  return false;
}

export function redactSensitiveCitationDetail(raw: string): string {
  if (!raw) {
    return '';
  }
  const cached = citationDetailCache.get(raw);
  if (cached !== undefined) {
    return cached;
  }
  let text = raw.trim();
  if (!text) {
    setBoundedCitationCache(citationDetailCache, raw, '');
    return '';
  }
  if (text.includes('-')) {
    text = text.replaceAll(RE_SSN_NUMBER, '');
    text = text.replaceAll(RE_SSN_BARE, '[SSN redacted]');
  }
  if (hasIrregularWhitespace(text)) {
    text = text.replaceAll(/\s{2,}/g, ' ');
  }
  const first = text.charCodeAt(0);
  const last = text.charCodeAt(text.length - 1);
  if (isCitationSeparatorChar(first) || isCitationSeparatorChar(last)) {
    text = trimCitationSeparators(text);
  }
  setBoundedCitationCache(citationDetailCache, raw, text);
  return text;
}

export function cleanSourceCitationTitle(rawTitle: string): string {
  const cached = sourceTitleCache.get(rawTitle);
  if (cached !== undefined) {
    return cached;
  }
  let out = hasIrregularWhitespace(rawTitle) ? rawTitle.replaceAll(/\s+/g, ' ') : rawTitle;
  out = out.trim();
  if (out.includes('@') && out.endsWith(')')) {
    const openIdx = out.lastIndexOf('(');
    if (openIdx !== -1 && /^\(Ancestry GEDCOM @S\d+@\)$/i.test(out.slice(openIdx))) {
      out = out.slice(0, openIdx).trimEnd();
    }
  }
  setBoundedCitationCache(sourceTitleCache, rawTitle, out);
  return out;
}

export function inferSourceRepository(title: string, repoName?: string, publisher?: string): string {
  if (repoName?.trim() && !/^ancestry\.com$/i.test(repoName.trim())) {
    return repoName.trim();
  }
  const t = title.toLowerCase();
  if (t.includes('federal census')) {
    return 'National Archives and Records Administration (NARA)';
  }
  if (t.includes('find a grave') || t.includes('find a grave®')) {
    return 'Find A Grave';
  }
  if (t.includes('social security')) {
    return 'U.S. Social Security Administration';
  }
  if (t.includes('world war i') || t.includes('world war ii') || t.includes('draft')) {
    return 'National Archives and Records Administration (NARA)';
  }
  if (t.includes('general land office')) {
    return 'U.S. Bureau of Land Management (GLO)';
  }
  if (t.split(/[^a-z0-9.]+/).some((tok) => NEWSPAPERS_COM_TOKENS.has(tok))) {
    return 'Newspapers.com Historical Archive';
  }
  if (t.includes('texas, marriage')) {
    return 'Texas Department of State Health Services';
  }
  if (
    t.includes('california, death') ||
    t.includes('california birth') ||
    t.includes('california, marriage')
  ) {
    return 'California Department of Public Health';
  }
  if (t.includes('virginia, marriage') || t.includes('virginia, divorce')) {
    return 'Virginia Department of Health';
  }
  if (t.includes('church of england') || t.includes('parish records') || t.includes('england, select')) {
    return 'Church of England Parish Registers';
  }
  if (publisher?.trim()) {
    return publisher.trim();
  }
  return 'Archival Record Collection (imported via Ancestry tree)';
}

const RE_AT_ANCESTRY_GEDCOM = / ?\((?:Ancestry )?GEDCOM @[A-Za-z][0-9]+@\)/gi;
const RE_AT_ACCORDING = / according to the Ancestry GEDCOM ?\(@[A-Za-z][0-9]+@\)\.?/gi;
const RE_AT_PARENS = / ?\(@[A-Za-z][0-9]+@\)/g;
const RE_AT_GEDCOM = /\bGEDCOM @[A-Za-z][0-9]+@\b/gi;
const RE_AT_BARE = / ?@[A-Za-z][0-9]+@/g;
const RE_RECORDED_MARRIAGE_YEAR = /\brecorded marriage on (?=\d{4}\b)/gi;
const RE_RECORDED_MARRIAGE_MONTH =
  /\brecorded marriage on (?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{4}\b)/gi;
const RE_RECORDED_MARRIAGE = /\brecorded marriage on /gi;
const RE_RECORDED_DIVORCE_YEAR_MONTH =
  /\brecorded divorce on (?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{4}\b|\d{4}\b)/gi;
const RE_RECORDED_DIVORCE = /\brecorded divorce on /gi;
const RE_WAS_DIED_ON = /\bwas died on\b/gi;
const RE_WAS_BORN_ABT = /\bwas born on Abt\.? /gi;
const RE_DIED_ABT = /\bdied on Abt\.? /gi;
const RE_WAS_BORN_YEAR = /\bwas born on (\d{4})(?=\b(?! ?[-–/] ?\d))/g;
const RE_DIED_YEAR = /\bdied on (\d{4})(?=\b(?! ?[-–/] ?\d))/g;
const RE_CONFLICT_ONE = /Note: ?1 conflicting GEDCOM entr(?:y|ies) recorded\.?/gi;
const RE_CONFLICT_MANY = /Note: ?(\d+) conflicting GEDCOM entr(?:y|ies) recorded\.?/gi;
const RE_DAY_MONTH_YEAR = /\b(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec) (\d{4})\b/gi;
const RE_DAY_MONTH_YEAR_PROBE = /\d (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec) \d{4}/i;
const RE_DOUBLE_DOT = /\.\.+/g;
const RE_MULTI_SPACE = /\s{2,}/g;

const RE_ALT_GEDCOM_DATE = /\bGEDCOM alternate date:/gi;
const RE_ALT_GEDCOM_PLACE = /\bGEDCOM alternate place:/gi;
const RE_ALT_GEDCOM_ENTRY = /\bGEDCOM entry\b/gi;

export function cleanEventSummaryProse(summary: string): string {
  if (!summary) {
    return summary;
  }
  const cached = summaryCleanCache.get(summary);
  if (cached !== undefined) {
    return cached;
  }
  let out = hasIrregularWhitespace(summary) ? summary.replaceAll(/\s+/g, ' ') : summary;
  if (out.includes('@')) {
    out = out
      .replaceAll(RE_AT_ANCESTRY_GEDCOM, '')
      .replaceAll(RE_AT_ACCORDING, '.')
      .replaceAll(RE_AT_PARENS, '')
      .replaceAll(RE_AT_GEDCOM, '')
      .replaceAll(RE_AT_BARE, '');
  }
  if (out.includes('recorded ') || out.includes('Recorded ')) {
    out = out
      .replaceAll(RE_RECORDED_MARRIAGE_YEAR, 'married in ')
      .replaceAll(RE_RECORDED_MARRIAGE_MONTH, 'married in ')
      .replaceAll(RE_RECORDED_MARRIAGE, 'married on ')
      .replaceAll(RE_RECORDED_DIVORCE_YEAR_MONTH, 'divorced in ')
      .replaceAll(RE_RECORDED_DIVORCE, 'divorced on ');
  }
  if (out.includes(' on ') || out.includes(' On ')) {
    out = out
      .replaceAll(RE_WAS_DIED_ON, 'died on')
      .replaceAll(RE_WAS_BORN_ABT, 'was born about ')
      .replaceAll(RE_DIED_ABT, 'died about ')
      .replaceAll(RE_WAS_BORN_YEAR, 'was born in $1')
      .replaceAll(RE_DIED_YEAR, 'died in $1');
  }
  if (out.includes('GEDCOM') || out.includes('gedcom')) {
    out = out
      .replaceAll(RE_CONFLICT_ONE, 'Note: 1 alternate record entry preserved.')
      .replaceAll(RE_CONFLICT_MANY, 'Note: $1 alternate record entries preserved.');
  }
  if (mayHaveDayMonthYear(out) && RE_DAY_MONTH_YEAR_PROBE.test(out)) {
    out = out.replaceAll(
      RE_DAY_MONTH_YEAR,
      (_, d: string, m: string, y: string) =>
        `${d} ${(m[0] ?? '').toUpperCase()}${m.slice(1).toLowerCase()} ${y}`
    );
  }
  if (out.includes(' .')) {
    out = out.replaceAll(' .', '.');
  }
  if (out.includes('..')) {
    out = out.replaceAll(RE_DOUBLE_DOT, '.');
  }
  if (hasIrregularWhitespace(out)) {
    out = out.replaceAll(RE_MULTI_SPACE, ' ');
  }
  out = out.trim();
  setBoundedCitationCache(summaryCleanCache, summary, out);
  return out;
}

export function cleanAlternateNote(note: string): string {
  if (!note) {
    return note;
  }
  let out = hasIrregularWhitespace(note) ? note.replaceAll(/\s+/g, ' ') : note;
  if (out.includes('@') || out.includes('GEDCOM') || out.includes('gedcom')) {
    out = out
      .replaceAll(RE_ALT_GEDCOM_DATE, 'Alternate date:')
      .replaceAll(RE_ALT_GEDCOM_PLACE, 'Alternate place:')
      .replaceAll(RE_AT_ANCESTRY_GEDCOM, '')
      .replaceAll(RE_AT_GEDCOM, '')
      .replaceAll(RE_AT_BARE, '')
      .replaceAll(RE_ALT_GEDCOM_ENTRY, 'archival entry');
  }
  if (hasIrregularWhitespace(out)) {
    out = out.replaceAll(RE_MULTI_SPACE, ' ');
  }
  return out.trim();
}

export function applyCitationCleanings(
  events: ArchiveEvent[],
  sources: SourceRecord[],
  legacyContainerSourceIds: ReadonlySet<string> = new Set()
): void {
  const hasLegacyIds = legacyContainerSourceIds.size > 0;
  for (const ev of events) {
    if (ev.summary) {
      ev.summary = cleanEventSummaryProse(ev.summary);
    }
    if (ev.alternate_dates) {
      for (const alt of ev.alternate_dates) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (hasLegacyIds && legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    if (ev.alternate_places) {
      for (const alt of ev.alternate_places) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (hasLegacyIds && legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    if (ev.fact_conflicts) {
      for (const alt of ev.fact_conflicts) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (hasLegacyIds && legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    for (const sr of ev.sources) {
      if (hasLegacyIds && legacyContainerSourceIds.has(sr.source_id)) {
        sr.source_id = UNVERIFIED_TREE_SOURCE_ID;
      }
      if (sr.citation_detail) {
        sr.citation_detail = redactSensitiveCitationDetail(sr.citation_detail);
      }
    }
  }

  for (const src of sources) {
    if (src.citation) {
      src.citation = cleanSourceCitationTitle(src.citation);
    }
  }
}
