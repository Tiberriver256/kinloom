import type { Person, SourceRecord } from '@kinloom/core';

const FIELD_LABEL_MAP: Readonly<Record<string, string>> = {
  full_name: 'Full name',
  given_name: 'Given name',
  surname: 'Surname',
  birth_edtf: 'Birth date',
  death_edtf: 'Death date',
  primary_place_id: 'Primary place',
  place_id: 'Place',
  edtf_date: 'Date',
  alt_names: 'Alternate names',
  sources: 'Sources',
  source_ids: 'Sources',
  participants: 'Participants',
  alternate_dates: 'Date discrepancies',
  alternate_places: 'Place discrepancies',
  fact_conflicts: 'Fact discrepancies',
  body_md: 'Narrative text',
  summary: 'Summary',
  title: 'Title',
  citation: 'Citation',
  repository: 'Repository',
  portrait_url: 'Portrait',
  pronunciation: 'Pronunciation',
  lineage_group: 'Lineage group',
  is_living: 'Living status',
  event_kind: 'Event type',
  scope: 'Scope',
  category: 'Category',
  caption: 'Caption',
  provenance: 'Provenance',
  date_edtf: 'Date',
  lat: 'Latitude',
  lng: 'Longitude',
  has_primary_source: 'Primary source attached',
};

function sentenceCaseKey(raw: string): string {
  const words = raw
    .split(/[._]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (words.length === 0) {
    return raw;
  }
  const joined = words.join(' ').toLowerCase();
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Convert an internal schema field path such as `birth_edtf` into a plain-English label.
 */
export function formatFieldLabel(path: string): string {
  const direct = FIELD_LABEL_MAP[path];
  if (direct) {
    return direct;
  }
  const segments = path.split('.');
  const leaf = segments[segments.length - 1];
  if (segments.length > 1 && leaf && FIELD_LABEL_MAP[leaf]) {
    const prefix = segments
      .slice(0, -1)
      .map((seg) => FIELD_LABEL_MAP[seg] ?? sentenceCaseKey(seg))
      .join(' · ');
    return `${prefix}: ${FIELD_LABEL_MAP[leaf]}`;
  }
  return sentenceCaseKey(path);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatSourceEntry(entry: unknown, sourcesById?: ReadonlyMap<string, SourceRecord>): string {
  if (typeof entry === 'string') {
    const rec = sourcesById?.get(entry);
    return rec ? `${rec.citation} (${entry})` : entry;
  }
  if (!isPlainRecord(entry)) {
    return String(entry);
  }
  const sourceId = typeof entry['source_id'] === 'string' ? entry['source_id'] : 'Unknown source';
  const rec = sourcesById?.get(sourceId);
  const label = rec ? rec.citation : sourceId;
  const parts = [label];
  if (typeof entry['confidence'] === 'string' && entry['confidence'].length > 0) {
    parts.push(`${entry['confidence']} confidence`);
  }
  if (typeof entry['citation_detail'] === 'string' && entry['citation_detail'].trim().length > 0) {
    parts.push(entry['citation_detail'].trim());
  }
  return parts.join(' · ');
}

function formatParticipantEntry(entry: unknown, peopleById?: ReadonlyMap<string, Person>): string {
  if (!isPlainRecord(entry)) {
    return String(entry);
  }
  const personId = typeof entry['person_id'] === 'string' ? entry['person_id'] : 'Unknown person';
  const person = peopleById?.get(personId);
  const name = person ? person.full_name : personId;
  const role =
    typeof entry['role'] === 'string' && entry['role'].trim().length > 0 ? entry['role'].trim() : null;
  return role ? `${name} (${role})` : name;
}

function formatDiscrepancyEntry(entry: unknown, sourcesById?: ReadonlyMap<string, SourceRecord>): string {
  if (!isPlainRecord(entry)) {
    return String(entry);
  }
  const claim =
    (typeof entry['edtf_date'] === 'string' && entry['edtf_date']) ||
    (typeof entry['place_name'] === 'string' && entry['place_name']) ||
    (typeof entry['claim'] === 'string' && entry['claim']) ||
    'Alternate claim';
  const note =
    typeof entry['note'] === 'string' && entry['note'].trim().length > 0 ? entry['note'].trim() : '';
  const sourceId = typeof entry['source_id'] === 'string' ? entry['source_id'] : '';
  const sourceLabel = sourceId ? (sourcesById?.get(sourceId)?.citation ?? sourceId) : '';
  const withNote = note ? `${claim} — ${note}` : claim;
  return sourceLabel ? `${withNote} (${sourceLabel})` : withNote;
}

function summarizeNarrativeText(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const excerpt = text.length > 260 ? `${text.slice(0, 260).trimEnd()}…` : text;
  if (text.length <= 280) {
    return text;
  }
  return `[${words.length} words, ${paragraphs.length} ${paragraphs.length === 1 ? 'paragraph' : 'paragraphs'}]\n${excerpt}`;
}

export interface ReadableDiffFormatContext {
  readonly peopleById?: ReadonlyMap<string, Person> | undefined;
  readonly sourcesById?: ReadonlyMap<string, SourceRecord> | undefined;
}

/**
 * Format a field diff value for either human-readable inspection or raw JSON view.
 */
export function formatRevisionDiffValue(
  path: string,
  value: unknown,
  mode: 'readable' | 'raw',
  ctx?: ReadableDiffFormatContext
): string {
  if (value === undefined) {
    return '—';
  }
  if (value === null) {
    return mode === 'raw' ? 'null' : 'None';
  }
  if (mode === 'raw') {
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return JSON.stringify(value, null, 2);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    if (path === 'body_md' || path.endsWith('.body_md')) {
      return summarizeNarrativeText(value);
    }
    return value.length > 0 ? value : '(empty)';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'None';
    }
    if (path === 'sources' || path === 'source_ids') {
      return value.map((item) => `• ${formatSourceEntry(item, ctx?.sourcesById)}`).join('\n');
    }
    if (path === 'participants') {
      return value.map((item) => `• ${formatParticipantEntry(item, ctx?.peopleById)}`).join('\n');
    }
    if (path === 'alternate_dates' || path === 'alternate_places' || path === 'fact_conflicts') {
      return value.map((item) => `• ${formatDiscrepancyEntry(item, ctx?.sourcesById)}`).join('\n');
    }
    if (value.every((item) => typeof item === 'string' || typeof item === 'number')) {
      return value.join(', ');
    }
    return JSON.stringify(value, null, 2);
  }
  return JSON.stringify(value, null, 2);
}
