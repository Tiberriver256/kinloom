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

export function cleanEventSummaryProse(summary: string): string {
  if (!summary) {
    return summary;
  }
  return summary
    .replaceAll(/\s*\((?:Ancestry\s+)?GEDCOM\s+@[A-Za-z][0-9]+@\)/gi, '')
    .replaceAll(/\s+according to the Ancestry GEDCOM\s*\(@[A-Za-z][0-9]+@\)\.?/gi, '.')
    .replaceAll(/\s*\(@[A-Za-z][0-9]+@\)/g, '')
    .replaceAll(/\bGEDCOM\s+@[A-Za-z][0-9]+@\b/gi, '')
    .replaceAll(/\s*@[A-Za-z][0-9]+@/g, '')
    .replaceAll(/\brecorded marriage on\s+(?=\d{4}\b)/gi, 'married in ')
    .replaceAll(
      /\brecorded marriage on\s+(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b)/gi,
      'married in '
    )
    .replaceAll(/\brecorded marriage on\s+/gi, 'married on ')
    .replaceAll(
      /\brecorded divorce on\s+(?=(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b|\d{4}\b)/gi,
      'divorced in '
    )
    .replaceAll(/\brecorded divorce on\s+/gi, 'divorced on ')
    .replaceAll(/\bwas died on\b/gi, 'died on')
    .replaceAll(/\bwas born on\s+Abt\.?\s+/gi, 'was born about ')
    .replaceAll(/\bdied on\s+Abt\.?\s+/gi, 'died about ')
    .replaceAll(/\bwas born on\s+(\d{4})(?=\b(?!\s*[-–/]\s*\d))/g, 'was born in $1')
    .replaceAll(/\bdied on\s+(\d{4})(?=\b(?!\s*[-–/]\s*\d))/g, 'died in $1')
    .replaceAll(
      /Note:\s*1\s+conflicting\s+GEDCOM\s+entr(?:y|ies)\s+recorded\.?/gi,
      'Note: 1 alternate record entry preserved.'
    )
    .replaceAll(
      /Note:\s*(\d+)\s+conflicting\s+GEDCOM\s+entr(?:y|ies)\s+recorded\.?/gi,
      'Note: $1 alternate record entries preserved.'
    )
    .replaceAll(
      /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})\b/gi,
      (_, d: string, m: string, y: string) =>
        `${d} ${m[0].toUpperCase()}${m.slice(1).toLowerCase()} ${y}`
    )
    .replaceAll(/\s+\./g, '.')
    .replaceAll(/\.\.+/g, '.')
    .replaceAll(/\s{2,}/g, ' ')
    .trim();
}

export function cleanAlternateNote(note: string): string {
  if (!note) {
    return note;
  }
  return note
    .replaceAll(/\bGEDCOM\s+alternate\s+date:/gi, 'Alternate date:')
    .replaceAll(/\bGEDCOM\s+alternate\s+place:/gi, 'Alternate place:')
    .replaceAll(/\s*\((?:Ancestry\s+)?GEDCOM\s+@[A-Za-z][0-9]+@\)/gi, '')
    .replaceAll(/\bGEDCOM\s+@[A-Za-z][0-9]+@\b/gi, '')
    .replaceAll(/\s*@[A-Za-z][0-9]+@/g, '')
    .replaceAll(/\bGEDCOM\s+entry\b/gi, 'archival entry')
    .replaceAll(/\s{2,}/g, ' ')
    .trim();
}

export function applyCitationCleanings(
  events: ArchiveEvent[],
  sources: SourceRecord[],
  legacyContainerSourceIds: ReadonlySet<string> = new Set(['src_ancestry_gedcom_2026'])
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
