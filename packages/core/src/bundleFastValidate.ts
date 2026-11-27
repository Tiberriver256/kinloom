import { markTrustedArchiveBundle } from './fastCompare.js';
import type { ArchiveBundle, MediaChecklistItem, ReadingsBundle } from './schemas/entities.js';

const BUILD_MODES = new Set(['public', 'private']);
const EVENT_SCOPES = new Set(['personal', 'family', 'local', 'state', 'national', 'global']);
const EVENT_KINDS = new Set(['point_event', 'residence_anchor', 'context_span']);
const PLACE_TYPES = new Set(['country', 'state', 'county', 'town', 'homestead']);
const KINSHIP_RELATIONS = new Set(['parent', 'child', 'spouse']);
const CONFIDENCE_TIERS = new Set(['Confirmed', 'Inferred', 'Possible']);
const SOURCE_CONFIDENCES = new Set(['high', 'medium', 'low']);
const MEDIA_KINDS = new Set([
  'document_scan',
  'portrait',
  'family_photo',
  'headstone',
  'record_scan',
  'milestone',
  'video_story',
  'audio_oral_history',
]);
const NARRATIVE_KINDS = new Set(['biography', 'family_story', 'research_note', 'memoir']);

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isOptNullStr(v: unknown): boolean {
  return v === undefined || v === null || typeof v === 'string';
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isStringArray(v: unknown, nonEmptyItems = false): v is string[] {
  if (!Array.isArray(v)) {
    return false;
  }
  for (let i = 0; i < v.length; i += 1) {
    if (typeof v[i] !== 'string' || (nonEmptyItems && v[i].length === 0)) {
      return false;
    }
  }
  return true;
}

function isValidEventSourceRefs(v: unknown): boolean {
  if (!Array.isArray(v)) {
    return false;
  }
  for (let i = 0; i < v.length; i += 1) {
    const s = v[i];
    if (!isPlainObj(s)) {
      return false;
    }
    if (
      !isNonEmptyStr(s.source_id) ||
      typeof s.confidence !== 'string' ||
      !SOURCE_CONFIDENCES.has(s.confidence)
    ) {
      return false;
    }
    if (
      !isOptNullStr(s.claimed_date) ||
      !isOptNullStr(s.citation_detail) ||
      !isOptNullStr(s.scan_url) ||
      !isOptNullStr(s.scan_title)
    ) {
      return false;
    }
  }
  return true;
}

function isValidPronunciation(v: unknown): boolean {
  if (v === undefined || v === null) {
    return true;
  }
  if (!isPlainObj(v)) {
    return false;
  }
  if (
    !isOptNullStr(v.phonetic) ||
    !isOptNullStr(v.ipa) ||
    !isOptNullStr(v.language) ||
    !isOptNullStr(v.audio_url) ||
    !isOptNullStr(v.note) ||
    !isOptNullStr(v.source_url) ||
    !isOptNullStr(v.source_label) ||
    !isOptNullStr(v.region)
  ) {
    return false;
  }
  if (v.variants !== undefined || v.match_full_name_contains !== undefined) {
    return false;
  }
  return true;
}

function isValidCompiledPerson(v: unknown): boolean {
  if (!isPlainObj(v)) {
    return false;
  }
  if (
    !isNonEmptyStr(v.id) ||
    !isNonEmptyStr(v.slug) ||
    typeof v.full_name !== 'string' ||
    typeof v.given_name !== 'string' ||
    typeof v.surname !== 'string' ||
    !isStringArray(v.alt_names) ||
    typeof v.sex !== 'string' ||
    typeof v.is_living !== 'boolean' ||
    typeof v.lineage_group !== 'string' ||
    typeof v.birth_edtf !== 'string' ||
    typeof v.death_edtf !== 'string' ||
    (v.portrait_url !== null && typeof v.portrait_url !== 'string') ||
    !isOptNullStr(v.thumb_url) ||
    !isOptNullStr(v.gedcom_xref) ||
    (v.branch !== undefined && typeof v.branch !== 'string') ||
    (v.has_primary_source !== undefined && typeof v.has_primary_source !== 'boolean') ||
    (v.extensions !== undefined && !isPlainObj(v.extensions)) ||
    !isValidPronunciation(v.pronunciation)
  ) {
    return false;
  }
  if (
    (v.birth_year !== null && !isInt(v.birth_year)) ||
    (v.death_year !== null && !isInt(v.death_year)) ||
    !isNonNegInt(v.event_count) ||
    (v.media_count !== undefined && !isNonNegInt(v.media_count)) ||
    (v.primary_place_id !== null && typeof v.primary_place_id !== 'string')
  ) {
    return false;
  }
  return true;
}

function isValidCompiledEvent(v: unknown): boolean {
  if (!isPlainObj(v)) {
    return false;
  }
  if (
    !isNonEmptyStr(v.id) ||
    typeof v.title !== 'string' ||
    typeof v.scope !== 'string' ||
    !EVENT_SCOPES.has(v.scope) ||
    typeof v.event_kind !== 'string' ||
    !EVENT_KINDS.has(v.event_kind) ||
    !isOptNullStr(v.category) ||
    typeof v.edtf_date !== 'string' ||
    (v.place_id !== null && typeof v.place_id !== 'string') ||
    !isOptNullStr(v.place_precision) ||
    typeof v.summary !== 'string' ||
    (v.severity_rank !== undefined && v.severity_rank !== null && typeof v.severity_rank !== 'number') ||
    !isOptNullStr(v.source_url) ||
    !isOptNullStr(v.photo_url) ||
    !isOptNullStr(v.photo_placeholder_caption) ||
    (v.has_primary_source !== undefined && typeof v.has_primary_source !== 'boolean') ||
    typeof v.display_date !== 'string' ||
    (v.year !== null && !isInt(v.year)) ||
    (v.time_min !== null && !isInt(v.time_min)) ||
    (v.time_max !== null && !isInt(v.time_max)) ||
    (v.place_ancestors !== undefined && !isStringArray(v.place_ancestors))
  ) {
    return false;
  }
  if (
    v.alternate_dates !== undefined ||
    v.alternate_places !== undefined ||
    v.fact_conflicts !== undefined ||
    v.weather_metrics !== undefined ||
    v.extensions !== undefined
  ) {
    // Allow simple alternate_dates arrays; bail to full Zod if exotic nested arrays exist
    if (
      v.alternate_places !== undefined ||
      v.fact_conflicts !== undefined ||
      v.weather_metrics !== undefined ||
      v.extensions !== undefined
    ) {
      return false;
    }
    if (!Array.isArray(v.alternate_dates)) {
      return false;
    }
    for (const ad of v.alternate_dates) {
      if (
        !isPlainObj(ad) ||
        typeof ad.edtf_date !== 'string' ||
        !isNonEmptyStr(ad.source_id) ||
        typeof ad.note !== 'string'
      ) {
        return false;
      }
    }
  }
  if (!Array.isArray(v.participants)) {
    return false;
  }
  for (let i = 0; i < v.participants.length; i += 1) {
    const pt = v.participants[i];
    if (!isPlainObj(pt) || !isNonEmptyStr(pt.person_id) || !isNonEmptyStr(pt.role)) {
      return false;
    }
  }
  return isValidEventSourceRefs(v.sources);
}

function isValidPlace(v: unknown): boolean {
  if (!isPlainObj(v)) {
    return false;
  }
  if (
    !isNonEmptyStr(v.id) ||
    !isNonEmptyStr(v.slug) ||
    !isNonEmptyStr(v.name) ||
    !isNonEmptyStr(v.full_name) ||
    typeof v.place_type !== 'string' ||
    !PLACE_TYPES.has(v.place_type) ||
    (v.parent_id !== null && typeof v.parent_id !== 'string') ||
    typeof v.lat !== 'number' ||
    !Number.isFinite(v.lat) ||
    v.lat < -90 ||
    v.lat > 90 ||
    typeof v.lng !== 'number' ||
    !Number.isFinite(v.lng) ||
    v.lng < -180 ||
    v.lng > 180 ||
    !isOptNullStr(v.summary) ||
    !isOptNullStr(v.photo_url) ||
    !isOptNullStr(v.photo_caption) ||
    !isValidPronunciation(v.pronunciation) ||
    (v.has_primary_source !== undefined && typeof v.has_primary_source !== 'boolean')
  ) {
    return false;
  }
  if (
    v.historical_names !== undefined ||
    v.sources !== undefined ||
    v.extensions !== undefined ||
    v.ancestor_ids !== undefined
  ) {
    return false;
  }
  return true;
}

/**
 * Zero-Zod fast-path validator for already-canonical compiled `ArchiveBundle` JSON payloads.
 * Returns the validated `ArchiveBundle` on standard canonical bundles, or `null` when any
 * field requires full `ArchiveBundleSchema.parse()` coercion, stripping, or `ZodError` reporting.
 */
export function tryValidateArchiveBundle(raw: unknown): ArchiveBundle | null {
  if (!isPlainObj(raw) || !isPlainObj(raw.meta) || !isPlainObj(raw.meta.counts)) {
    return null;
  }
  const { meta } = raw;
  const counts = meta.counts as Record<string, unknown>;
  if (
    typeof meta.build_mode !== 'string' ||
    !BUILD_MODES.has(meta.build_mode) ||
    typeof meta.generated_at !== 'string' ||
    (meta.version !== undefined && typeof meta.version !== 'string') ||
    (meta.max_revision_id !== undefined && !isNonNegInt(meta.max_revision_id)) ||
    (meta.uncited_entity_keys !== undefined && !isStringArray(meta.uncited_entity_keys))
  ) {
    return null;
  }
  if (
    !isNonNegInt(counts.people) ||
    !isNonNegInt(counts.living_redacted) ||
    !isNonNegInt(counts.events) ||
    !isNonNegInt(counts.residence_spans) ||
    !isNonNegInt(counts.places) ||
    !isNonNegInt(counts.sources) ||
    (counts.media !== undefined && !isNonNegInt(counts.media)) ||
    (counts.narratives !== undefined && !isNonNegInt(counts.narratives))
  ) {
    return null;
  }

  if (
    !Array.isArray(raw.people) ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.residence_spans) ||
    !Array.isArray(raw.places) ||
    !isPlainObj(raw.place_ancestors) ||
    !Array.isArray(raw.kinship) ||
    !Array.isArray(raw.sources)
  ) {
    return null;
  }

  for (let i = 0; i < raw.people.length; i += 1) {
    if (!isValidCompiledPerson(raw.people[i])) {
      return null;
    }
  }
  for (let i = 0; i < raw.events.length; i += 1) {
    if (!isValidCompiledEvent(raw.events[i])) {
      return null;
    }
  }
  for (let i = 0; i < raw.residence_spans.length; i += 1) {
    const s = raw.residence_spans[i];
    if (
      !isPlainObj(s) ||
      !isNonEmptyStr(s.id) ||
      !isNonEmptyStr(s.person_id) ||
      !isNonEmptyStr(s.place_id) ||
      !isInt(s.time_min) ||
      !isInt(s.time_max) ||
      (s.start_year !== null && !isInt(s.start_year)) ||
      (s.end_year !== null && !isInt(s.end_year)) ||
      typeof s.confidence_tier !== 'string' ||
      !CONFIDENCE_TIERS.has(s.confidence_tier) ||
      !isNonEmptyStr(s.from_event_id) ||
      !isNonEmptyStr(s.to_event_id)
    ) {
      return null;
    }
  }
  for (let i = 0; i < raw.places.length; i += 1) {
    if (!isValidPlace(raw.places[i])) {
      return null;
    }
  }
  for (const val of Object.values(raw.place_ancestors)) {
    if (!isStringArray(val)) {
      return null;
    }
  }
  for (let i = 0; i < raw.kinship.length; i += 1) {
    const k = raw.kinship[i];
    if (
      !isPlainObj(k) ||
      !isNonEmptyStr(k.from) ||
      !isNonEmptyStr(k.to) ||
      typeof k.relation !== 'string' ||
      !KINSHIP_RELATIONS.has(k.relation) ||
      !isOptNullStr(k.family_xref)
    ) {
      return null;
    }
  }
  for (let i = 0; i < raw.sources.length; i += 1) {
    const s = raw.sources[i];
    if (
      !isPlainObj(s) ||
      !isNonEmptyStr(s.id) ||
      typeof s.citation !== 'string' ||
      typeof s.source_type !== 'string' ||
      !isOptNullStr(s.gedcom_xref) ||
      !isOptNullStr(s.author) ||
      !isOptNullStr(s.publisher) ||
      !isOptNullStr(s.repository) ||
      !isOptNullStr(s.url) ||
      (s.has_primary_source !== undefined && typeof s.has_primary_source !== 'boolean')
    ) {
      return null;
    }
  }
  if (raw.media !== undefined) {
    if (!Array.isArray(raw.media)) {
      return null;
    }
    for (let i = 0; i < raw.media.length; i += 1) {
      const m = raw.media[i];
      if (
        !isPlainObj(m) ||
        !isNonEmptyStr(m.id) ||
        typeof m.kind !== 'string' ||
        !MEDIA_KINDS.has(m.kind) ||
        !isNonEmptyStr(m.file) ||
        typeof m.caption !== 'string' ||
        !isOptNullStr(m.source_id) ||
        (m.page !== undefined && m.page !== null && !isInt(m.page)) ||
        !isOptNullStr(m.person_id) ||
        (m.person_ids !== undefined && !isStringArray(m.person_ids, true)) ||
        !isOptNullStr(m.person_slug) ||
        !isOptNullStr(m.person_name) ||
        !isOptNullStr(m.event_id) ||
        !isOptNullStr(m.thumb_file) ||
        !isOptNullStr(m.date_edtf) ||
        !isOptNullStr(m.provenance) ||
        (m.mime_type !== undefined && m.mime_type !== null && !isNonEmptyStr(m.mime_type)) ||
        (m.duration_seconds !== undefined &&
          m.duration_seconds !== null &&
          (typeof m.duration_seconds !== 'number' || m.duration_seconds < 0)) ||
        (m.poster_url !== undefined && m.poster_url !== null && !isNonEmptyStr(m.poster_url)) ||
        (m.transcript_url !== undefined && m.transcript_url !== null && !isNonEmptyStr(m.transcript_url)) ||
        (m.has_primary_source !== undefined && typeof m.has_primary_source !== 'boolean') ||
        m.extensions !== undefined
      ) {
        return null;
      }
    }
  }
  if (raw.narratives !== undefined) {
    if (!Array.isArray(raw.narratives)) {
      return null;
    }
    for (let i = 0; i < raw.narratives.length; i += 1) {
      const n = raw.narratives[i];
      if (
        !isPlainObj(n) ||
        !isNonEmptyStr(n.id) ||
        !isNonEmptyStr(n.slug) ||
        !isNonEmptyStr(n.title) ||
        typeof n.body_md !== 'string' ||
        (n.kind !== undefined && (typeof n.kind !== 'string' || !NARRATIVE_KINDS.has(n.kind))) ||
        (n.subject_person_id !== undefined && !isNonEmptyStr(n.subject_person_id)) ||
        (n.summary !== undefined && typeof n.summary !== 'string') ||
        !isOptNullStr(n.date_edtf) ||
        !isStringArray(n.person_ids, true) ||
        !isStringArray(n.place_ids, true) ||
        !isStringArray(n.event_ids, true) ||
        !isStringArray(n.source_ids, true) ||
        (n.updated_at !== undefined && typeof n.updated_at !== 'string') ||
        (n.has_primary_source !== undefined && typeof n.has_primary_source !== 'boolean') ||
        n.extensions !== undefined
      ) {
        return null;
      }
    }
  }
  if (raw.pronunciations !== undefined) {
    if (!isPlainObj(raw.pronunciations)) {
      return null;
    }
    for (const entry of Object.values(raw.pronunciations)) {
      if (entry === null || entry === undefined || !isValidPronunciation(entry)) {
        return null;
      }
    }
  }

  const bundle = raw as ArchiveBundle;
  markTrustedArchiveBundle(bundle);
  return bundle;
}

export function tryValidateReadingsBundle(raw: unknown): ReadingsBundle | null {
  if (!isPlainObj(raw) || !isInt(raw.version) || raw.version <= 0) {
    return null;
  }
  if (!isPlainObj(raw.documents) || !isPlainObj(raw.event_page_map)) {
    return null;
  }
  for (const doc of Object.values(raw.documents)) {
    if (
      !isPlainObj(doc) ||
      !isNonEmptyStr(doc.source_id) ||
      !isNonEmptyStr(doc.title) ||
      typeof doc.author !== 'string' ||
      typeof doc.provenance !== 'string' ||
      (doc.pdf_url !== undefined && typeof doc.pdf_url !== 'string') ||
      (doc.pdf_size_bytes !== undefined && !isNonNegInt(doc.pdf_size_bytes)) ||
      !Array.isArray(doc.pages)
    ) {
      return null;
    }
    for (let i = 0; i < doc.pages.length; i += 1) {
      const p = doc.pages[i];
      if (
        !isPlainObj(p) ||
        !isInt(p.page) ||
        p.page <= 0 ||
        !isNonEmptyStr(p.label) ||
        !isNonEmptyStr(p.file) ||
        typeof p.text !== 'string' ||
        (p.image_url !== undefined && typeof p.image_url !== 'string')
      ) {
        return null;
      }
    }
  }
  for (const pageMap of Object.values(raw.event_page_map)) {
    if (!isPlainObj(pageMap)) {
      return null;
    }
    for (const pageNum of Object.values(pageMap)) {
      if (!isInt(pageNum)) {
        return null;
      }
    }
  }
  return raw as ReadingsBundle;
}

export function tryValidateMediaChecklistItems(rawItems: readonly unknown[]): MediaChecklistItem[] | null {
  const out: MediaChecklistItem[] = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const item = rawItems[i];
    if (
      !isPlainObj(item) ||
      !isNonEmptyStr(item.person_id) ||
      !isNonEmptyStr(item.person_slug) ||
      !isNonEmptyStr(item.person_name) ||
      typeof item.lifespan !== 'string' ||
      !isNonEmptyStr(item.obje_xref) ||
      !isNonEmptyStr(item.title) ||
      !isNonEmptyStr(item.media_type) ||
      !isNonEmptyStr(item.form) ||
      (item.status !== undefined && item.status !== 'digitized' && item.status !== 'missing') ||
      (item.file !== undefined && typeof item.file !== 'string')
    ) {
      return null;
    }
    out.push(item as MediaChecklistItem);
  }
  return out;
}
