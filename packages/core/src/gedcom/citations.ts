import type { ArchiveEvent, SourceRecord } from '../schemas/entities.js';

export const UNVERIFIED_TREE_SOURCE_ID = 'src_unverified_tree_entry';

export function redactSensitiveCitationDetail(raw: string): string {
  if (!raw) {
    return '';
  }
  let text = raw.trim();
  text = text.replaceAll(/\bNumber:\s*\d{3}-\d{2}-\d{4}\s*;?\s*/gi, '');
  text = text.replaceAll(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN redacted]');
  text = text.replaceAll(/\s{2,}/g, ' ').replaceAll(/^[;,\s]+|[;,\s]+$/g, '');
  return text;
}

export function cleanSourceCitationTitle(rawTitle: string): string {
  return rawTitle
    .replace(/\s*\(Ancestry GEDCOM\s+@S\d+@\)\s*$/i, '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function inferSourceRepository(
  title: string,
  repoName?: string,
  publisher?: string
): string {
  if (repoName && repoName.trim() && !/^ancestry\.com$/i.test(repoName.trim())) {
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
  if (t.includes('newspapers.com')) {
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
  if (
    t.includes('church of england') ||
    t.includes('parish records') ||
    t.includes('england, select')
  ) {
    return 'Church of England Parish Registers';
  }
  if (publisher && publisher.trim()) {
    return publisher.trim();
  }
  return 'Archival Record Collection (imported via Ancestry tree)';
}

const RE_AT_ANCESTRY_GEDCOM = /\s*\((?:Ancestry\s+)?GEDCOM\s+@[A-Za-z][0-9]+@\)/gi;
const RE_AT_ACCORDING = /\s+according to the Ancestry GEDCOM\s*\(@[A-Za-z][0-9]+@\)\.?/gi;
const RE_AT_PARENS = /\s*\(@[A-Za-z][0-9]+@\)/g;
const RE_AT_GEDCOM = /\bGEDCOM\s+@[A-Za-z][0-9]+@\b/gi;
const RE_AT_BARE = /\s*@[A-Za-z][0-9]+@/g;
const RE_RECORDED_MARRIAGE_YEAR = /\brecorded marriage on\s+(?=\d{4}\b)/gi;
const RE_RECORDED_MARRIAGE_MONTH =
  /\brecorded marriage on\s+(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b)/gi;
const RE_RECORDED_MARRIAGE = /\brecorded marriage on\s+/gi;
const RE_RECORDED_DIVORCE_YEAR_MONTH =
  /\brecorded divorce on\s+(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b|\d{4}\b)/gi;
const RE_RECORDED_DIVORCE = /\brecorded divorce on\s+/gi;
const RE_WAS_DIED_ON = /\bwas died on\b/gi;
const RE_WAS_BORN_ABT = /\bwas born on\s+Abt\.?\s+/gi;
const RE_DIED_ABT = /\bdied on\s+Abt\.?\s+/gi;
const RE_WAS_BORN_YEAR = /\bwas born on\s+(\d{4})(?=\b(?!\s*[-–/]\s*\d))/g;
const RE_DIED_YEAR = /\bdied on\s+(\d{4})(?=\b(?!\s*[-–/]\s*\d))/g;
const RE_CONFLICT_ONE = /Note:\s*1\s+conflicting\s+GEDCOM\s+entr(?:y|ies)\s+recorded\.?/gi;
const RE_CONFLICT_MANY = /Note:\s*(\d+)\s+conflicting\s+GEDCOM\s+entr(?:y|ies)\s+recorded\.?/gi;
const RE_DAY_MONTH_YEAR = /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/gi;
const RE_SPACE_DOT = /\s+\./g;
const RE_DOUBLE_DOT = /\.\.+/g;
const RE_MULTI_SPACE = /\s{2,}/g;

const RE_ALT_GEDCOM_DATE = /\bGEDCOM\s+alternate\s+date:/gi;
const RE_ALT_GEDCOM_PLACE = /\bGEDCOM\s+alternate\s+place:/gi;
const RE_ALT_GEDCOM_ENTRY = /\bGEDCOM\s+entry\b/gi;

export function cleanEventSummaryProse(summary: string): string {
  if (!summary) {
    return summary;
  }
  let out = summary;
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
  return out
    .replaceAll(
      RE_DAY_MONTH_YEAR,
      (_, d: string, m: string, y: string) =>
        `${d} ${m[0].toUpperCase()}${m.slice(1).toLowerCase()} ${y}`
    )
    .replaceAll(RE_SPACE_DOT, '.')
    .replaceAll(RE_DOUBLE_DOT, '.')
    .replaceAll(RE_MULTI_SPACE, ' ')
    .trim();
}

export function cleanAlternateNote(note: string): string {
  if (!note) {
    return note;
  }
  let out = note;
  if (out.includes('@') || out.includes('GEDCOM') || out.includes('gedcom')) {
    out = out
      .replaceAll(RE_ALT_GEDCOM_DATE, 'Alternate date:')
      .replaceAll(RE_ALT_GEDCOM_PLACE, 'Alternate place:')
      .replaceAll(RE_AT_ANCESTRY_GEDCOM, '')
      .replaceAll(RE_AT_GEDCOM, '')
      .replaceAll(RE_AT_BARE, '')
      .replaceAll(RE_ALT_GEDCOM_ENTRY, 'archival entry');
  }
  return out.replaceAll(RE_MULTI_SPACE, ' ').trim();
}

export function applyCitationCleanings(
  events: ArchiveEvent[],
  sources: SourceRecord[],
  legacyContainerSourceIds: ReadonlySet<string> = new Set()
): void {
  for (const ev of events) {
    if (ev.summary) {
      ev.summary = cleanEventSummaryProse(ev.summary);
    }
    if (ev.alternate_dates) {
      for (const alt of ev.alternate_dates) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    if (ev.alternate_places) {
      for (const alt of ev.alternate_places) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    if (ev.fact_conflicts) {
      for (const alt of ev.fact_conflicts) {
        if (alt.note) {
          alt.note = cleanAlternateNote(alt.note);
        }
        if (legacyContainerSourceIds.has(alt.source_id)) {
          alt.source_id = UNVERIFIED_TREE_SOURCE_ID;
        }
      }
    }
    for (const sr of ev.sources) {
      if (legacyContainerSourceIds.has(sr.source_id)) {
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
