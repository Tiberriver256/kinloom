import { z } from 'zod';
import { fastLocaleCompare } from './fastCompare.js';
import { type KinloomSiteConfig, KinloomSiteConfigSchema } from './schemas/config.js';
import {
  type KinshipEdge,
  type MediaItem,
  type Narrative,
  type NarrativeEnrichment,
  NarrativeEnrichmentSchema,
  type Place,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
} from './schemas/entities.js';
import {
  parseEventsArrayFast,
  parseKinshipArrayFast,
  parseMediaArrayFast,
  parseNarrativesArrayFast,
  parsePeopleArrayFast,
  parsePlacesArrayFast,
  parseSourcesArrayFast,
} from './schemas/fastEntities.js';
import { emitCanonicalYaml, parseYamlFast } from './yamlCodec.js';

export function parseYaml(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return parseYamlFast(text);
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
  return emitCanonicalYaml(value, options);
}

function parseListYamlFast<T>(text: string, parseArray: (raw: unknown, ownsInput?: boolean) => T[]): T[] {
  if (!text.trim()) {
    return [];
  }
  const raw = parseYamlFast(text);
  if (raw === null || raw === undefined) {
    return [];
  }
  return parseArray(raw, true);
}

const NarrativeEnrichmentArraySchema = z.array(NarrativeEnrichmentSchema);

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

function sortByEntityId<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  // Fast linear sortedness check avoids cloning & O(N log N) sorting on already-sorted arrays!
  let alreadySorted = true;
  for (let i = 1; i < items.length; i += 1) {
    if (fastLocaleCompare(items[i - 1].id, items[i].id) > 0) {
      alreadySorted = false;
      break;
    }
  }
  if (alreadySorted) {
    return items;
  }
  return [...items].toSorted((a, b) => fastLocaleCompare(a.id, b.id));
}

export function parsePeopleYaml(text: string): RawPerson[] {
  return parseListYamlFast(text, parsePeopleArrayFast);
}

export function serializePeopleYaml(people: readonly RawPerson[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? sortByEntityId(people) : people;
  return emitCanonicalYaml(list, { preferredKeyOrder: PERSON_KEY_ORDER });
}

export function parseEventsYaml(text: string): RawEvent[] {
  return parseListYamlFast(text, parseEventsArrayFast);
}

export function serializeEventsYaml(events: readonly RawEvent[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? sortByEntityId(events) : events;
  return emitCanonicalYaml(list, { preferredKeyOrder: EVENT_KEY_ORDER });
}

export function parsePlacesYaml(text: string): Place[] {
  return parseListYamlFast(text, parsePlacesArrayFast);
}

export function serializePlacesYaml(places: readonly Place[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? sortByEntityId(places) : places;
  return emitCanonicalYaml(list, { preferredKeyOrder: PLACE_KEY_ORDER });
}

export function parseSourcesYaml(text: string): SourceRecord[] {
  return parseListYamlFast(text, parseSourcesArrayFast);
}

export function serializeSourcesYaml(
  sources: readonly SourceRecord[],
  options?: { sortById?: boolean }
): string {
  const list = options?.sortById ? sortByEntityId(sources) : sources;
  return emitCanonicalYaml(list, { preferredKeyOrder: SOURCE_KEY_ORDER });
}

export function parseKinshipYaml(text: string): KinshipEdge[] {
  return parseListYamlFast(text, parseKinshipArrayFast);
}

export function serializeKinshipYaml(
  kinship: readonly KinshipEdge[],
  options?: { sortDeterministic?: boolean }
): string {
  let list: readonly KinshipEdge[] = kinship;
  if (options?.sortDeterministic) {
    let alreadySorted = true;
    for (let i = 1; i < kinship.length; i += 1) {
      const prev = kinship[i - 1];
      const curr = kinship[i];
      const cmp =
        fastLocaleCompare(prev.from, curr.from) ||
        fastLocaleCompare(prev.to, curr.to) ||
        fastLocaleCompare(prev.relation, curr.relation);
      if (cmp > 0) {
        alreadySorted = false;
        break;
      }
    }
    if (!alreadySorted) {
      list = [...kinship].toSorted(
        (a, b) =>
          fastLocaleCompare(a.from, b.from) ||
          fastLocaleCompare(a.to, b.to) ||
          fastLocaleCompare(a.relation, b.relation)
      );
    }
  }
  return emitCanonicalYaml(list, { preferredKeyOrder: KINSHIP_KEY_ORDER });
}

export function parseMediaYaml(text: string): MediaItem[] {
  return parseListYamlFast(text, parseMediaArrayFast);
}

export function serializeMediaYaml(media: readonly MediaItem[], options?: { sortById?: boolean }): string {
  const list = options?.sortById ? sortByEntityId(media) : media;
  return emitCanonicalYaml(list, { preferredKeyOrder: MEDIA_KEY_ORDER });
}

export function parseNarrativesYaml(text: string): Narrative[] {
  return parseListYamlFast(text, parseNarrativesArrayFast);
}

export function serializeNarrativesYaml(
  narratives: readonly Narrative[],
  options?: { sortById?: boolean }
): string {
  const list = options?.sortById ? sortByEntityId(narratives) : narratives;
  return emitCanonicalYaml(list, { preferredKeyOrder: NARRATIVE_KEY_ORDER });
}

export function parseNarrativeEnrichmentsYaml(text: string): NarrativeEnrichment[] {
  return parseListYamlFast(text, (raw) => NarrativeEnrichmentArraySchema.parse(raw));
}

export function parseKinloomConfigYaml(text: string): KinloomSiteConfig {
  return parseYamlWithSchema(text, KinloomSiteConfigSchema);
}

export function serializeKinloomConfigYaml(config: KinloomSiteConfig): string {
  return emitCanonicalYaml(config, { preferredKeyOrder: CONFIG_KEY_ORDER });
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
