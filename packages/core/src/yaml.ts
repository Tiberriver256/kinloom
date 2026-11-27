import { CORE_SCHEMA, load as loadYaml } from 'js-yaml';
import { stringify as stringifyYamlRaw } from 'yaml';
import { z } from 'zod';
import { type KinloomSiteConfig, KinloomSiteConfigSchema } from './schemas/config.js';
import {
  type KinshipEdge,
  KinshipEdgeSchema,
  type MediaItem,
  MediaItemSchema,
  type Narrative,
  type NarrativeEnrichment,
  NarrativeEnrichmentSchema,
  NarrativeSchema,
  type Place,
  PlaceSchema,
  type RawEvent,
  RawEventSchema,
  type RawPerson,
  RawPersonSchema,
  type SourceRecord,
  SourceRecordSchema,
} from './schemas/entities.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively strip undefined keys and sort object keys deterministically (or by preferred key order).
 */
function canonicalizeValue(value: unknown, preferredKeyOrder?: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined);
  const rank = new Map<string, number>();
  if (preferredKeyOrder) {
    preferredKeyOrder.forEach((k, idx) => {
      rank.set(k, idx);
    });
  }
  keys.sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    if (ra !== undefined && rb !== undefined) {
      return ra - rb;
    }
    if (ra !== undefined) {
      return -1;
    }
    if (rb !== undefined) {
      return 1;
    }
    return a.localeCompare(b);
  });
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = canonicalizeValue(value[k]);
  }
  return out;
}

// js-yaml's CORE_SCHEMA matches the YAML 1.2 core schema that `yaml` parses by
// default (no timestamps, no merge keys, duplicate keys rejected) and runs about
// 6x faster on large archive files. `yaml` stays the writer for stable output.
function parseYamlRaw(text: string): unknown {
  return loadYaml(text, { schema: CORE_SCHEMA }) ?? null;
}

export function parseYaml(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return parseYamlRaw(text);
}

export function parseYamlWithSchema<TSchema extends z.ZodTypeAny>(
  text: string,
  schema: TSchema
): z.infer<TSchema> {
  const raw = parseYaml(text);
  return schema.parse(raw);
}

export function stringifyYaml(
  value: unknown,
  options?: { preferredKeyOrder?: readonly string[]; lineWidth?: number }
): string {
  const canonical = Array.isArray(value)
    ? value.map((item) => canonicalizeValue(item, options?.preferredKeyOrder))
    : canonicalizeValue(value, options?.preferredKeyOrder);
  return stringifyYamlRaw(canonical, {
    lineWidth: options?.lineWidth ?? 110,
    minContentWidth: 20,
    singleQuote: false,
  });
}

function parseListYaml<TSchema extends z.ZodTypeAny>(text: string, itemSchema: TSchema): z.infer<TSchema>[] {
  if (!text.trim()) {
    return [];
  }
  const raw = parseYamlRaw(text);
  if (raw === null || raw === undefined) {
    return [];
  }
  return z.array(itemSchema).parse(raw);
}

const PERSON_KEY_ORDER = [
  'id',
  'slug',
  'gedcom_xref',
  'full_name',
  'given_name',
  'surname',
  'alt_names',
  'sex',
  'is_living',
  'lineage_group',
  'branch',
  'birth_edtf',
  'death_edtf',
  'portrait_url',
  'thumb_url',
  'pronunciation',
  'extensions',
] as const;

const EVENT_KEY_ORDER = [
  'id',
  'title',
  'scope',
  'event_kind',
  'category',
  'edtf_date',
  'alternate_dates',
  'alternate_places',
  'fact_conflicts',
  'place_id',
  'place_precision',
  'summary',
  'severity_rank',
  'weather_metrics',
  'source_url',
  'photo_url',
  'photo_placeholder_caption',
  'participants',
  'sources',
  'extensions',
] as const;

const PLACE_KEY_ORDER = [
  'id',
  'slug',
  'name',
  'full_name',
  'place_type',
  'parent_id',
  'lat',
  'lng',
  'min_lat',
  'max_lat',
  'min_lng',
  'max_lng',
  'historical_names',
  'summary',
  'photo_url',
  'photo_caption',
  'pronunciation',
  'sources',
  'extensions',
] as const;

const SOURCE_KEY_ORDER = [
  'id',
  'gedcom_xref',
  'citation',
  'author',
  'publisher',
  'source_type',
  'repository',
  'url',
] as const;

const KINSHIP_KEY_ORDER = ['from', 'to', 'relation', 'family_xref'] as const;

const MEDIA_KEY_ORDER = [
  'id',
  'kind',
  'source_id',
  'page',
  'person_id',
  'person_ids',
  'person_slug',
  'person_name',
  'event_id',
  'file',
  'thumb_file',
  'caption',
  'date_edtf',
  'provenance',
  'mime_type',
  'duration_seconds',
  'poster_url',
  'transcript_url',
  'extensions',
] as const;

const NARRATIVE_KEY_ORDER = [
  'id',
  'slug',
  'kind',
  'subject_person_id',
  'title',
  'summary',
  'date_edtf',
  'person_ids',
  'place_ids',
  'event_ids',
  'source_ids',
  'updated_at',
  'has_primary_source',
  'body_md',
  'extensions',
] as const;

const CONFIG_KEY_ORDER = [
  'schemaVersion',
  'site',
  'theme',
  'defaultBranchId',
  'branches',
  'lineageSections',
  'featuredDocumentId',
  'featuredKinshipPairs',
  'migrationEras',
  'mapDefaults',
  'anchorYears',
  'privacy',
  'wiki',
  'pronunciations',
  'plugins',
  'extensions',
] as const;

export function parsePeopleYaml(text: string): RawPerson[] {
  return parseListYaml(text, RawPersonSchema);
}

export function serializePeopleYaml(people: readonly RawPerson[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? [...people].toSorted((a, b) => a.id.localeCompare(b.id)) : people;
  return stringifyYaml(list, { preferredKeyOrder: PERSON_KEY_ORDER });
}

export function parseEventsYaml(text: string): RawEvent[] {
  return parseListYaml(text, RawEventSchema);
}

export function serializeEventsYaml(events: readonly RawEvent[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? [...events].toSorted((a, b) => a.id.localeCompare(b.id)) : events;
  return stringifyYaml(list, { preferredKeyOrder: EVENT_KEY_ORDER });
}

export function parsePlacesYaml(text: string): Place[] {
  return parseListYaml(text, PlaceSchema);
}

export function serializePlacesYaml(places: readonly Place[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? [...places].toSorted((a, b) => a.id.localeCompare(b.id)) : places;
  return stringifyYaml(list, { preferredKeyOrder: PLACE_KEY_ORDER });
}

export function parseSourcesYaml(text: string): SourceRecord[] {
  return parseListYaml(text, SourceRecordSchema);
}

export function serializeSourcesYaml(
  sources: readonly SourceRecord[],
  options?: { sortById?: boolean }
): string {
  const list = options?.sortById ? [...sources].toSorted((a, b) => a.id.localeCompare(b.id)) : sources;
  return stringifyYaml(list, { preferredKeyOrder: SOURCE_KEY_ORDER });
}

export function parseKinshipYaml(text: string): KinshipEdge[] {
  return parseListYaml(text, KinshipEdgeSchema);
}

export function serializeKinshipYaml(
  kinship: readonly KinshipEdge[],
  options?: { sortDeterministic?: boolean }
): string {
  const list = options?.sortDeterministic
    ? [...kinship].toSorted(
        (a, b) =>
          a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.relation.localeCompare(b.relation)
      )
    : kinship;
  return stringifyYaml(list, { preferredKeyOrder: KINSHIP_KEY_ORDER });
}

export function parseMediaYaml(text: string): MediaItem[] {
  return parseListYaml(text, MediaItemSchema);
}

export function serializeMediaYaml(media: readonly MediaItem[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? [...media].toSorted((a, b) => a.id.localeCompare(b.id)) : media;
  return stringifyYaml(list, { preferredKeyOrder: MEDIA_KEY_ORDER });
}

export function parseNarrativesYaml(text: string): Narrative[] {
  return parseListYaml(text, NarrativeSchema);
}

export function serializeNarrativesYaml(
  narratives: readonly Narrative[],
  options?: { sortById?: boolean }
): string {
  const list = options?.sortById ? [...narratives].toSorted((a, b) => a.id.localeCompare(b.id)) : narratives;
  return stringifyYaml(list, { preferredKeyOrder: NARRATIVE_KEY_ORDER });
}

export function parseNarrativeEnrichmentsYaml(text: string): NarrativeEnrichment[] {
  return parseListYaml(text, NarrativeEnrichmentSchema);
}

export function parseKinloomConfigYaml(text: string): KinloomSiteConfig {
  return parseYamlWithSchema(text, KinloomSiteConfigSchema);
}

export function serializeKinloomConfigYaml(config: KinloomSiteConfig): string {
  return stringifyYaml(config, { preferredKeyOrder: CONFIG_KEY_ORDER });
}

/**
 * Scalar YAML quoting helper preserved for compact line-oriented emitters.
 */
export function yamlStr(val: string): string {
  if (val === '' || /[:#[\]{}&*!|>'"%@`?\n]/.test(val) || /^\s|\s$/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}
