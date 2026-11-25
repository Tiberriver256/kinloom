import { z } from 'zod';

const CoercedEdtfStringSchema = z
  .union([z.string(), z.number(), z.null(), z.undefined()])
  .transform((val) => {
    if (val === null || val === undefined) {
      return '';
    }
    return String(val);
  });

const OptionalCoercedStringSchema = z
  .union([z.string(), z.number(), z.null()])
  .transform((val) => (val === null ? null : String(val)))
  .optional();

export const EventScopeSchema = z.enum([
  'personal',
  'family',
  'local',
  'state',
  'national',
  'global',
]);

export const EventKindSchema = z.enum([
  'point_event',
  'residence_anchor',
  'context_span',
]);

export const ConfidenceTierSchema = z.enum(['Confirmed', 'Inferred', 'Possible']);

export const PlaceTypeSchema = z.enum([
  'country',
  'state',
  'county',
  'town',
  'homestead',
]);

export const KinshipRelationSchema = z.enum(['parent', 'child', 'spouse']);

export const SourceConfidenceSchema = z.enum(['high', 'medium', 'low']);

export const ArchivalMediaKindSchema = z.enum([
  'document_scan',
  'portrait',
  'family_photo',
  'headstone',
  'record_scan',
  'milestone',
]);

export const BuildModeSchema = z.enum(['public', 'private']);

export const AlternateDateSchema = z.object({
  edtf_date: CoercedEdtfStringSchema,
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const AlternatePlaceSchema = z.object({
  place_name: z.string().min(1),
  place_id: z.string().nullable().optional(),
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const FactConflictSchema = z.object({
  claim: z.string().min(1),
  source_id: z.string().min(1),
  note: z.string().nullable().default('').transform((v) => v ?? ''),
});

export const EventParticipantSchema = z.object({
  person_id: z.string().min(1),
  role: z.string().min(1),
});

export const EventSourceRefSchema = z.object({
  source_id: z.string().min(1),
  confidence: SourceConfidenceSchema,
  claimed_date: OptionalCoercedStringSchema,
  citation_detail: z.string().nullable().optional(),
  scan_url: z.string().nullable().optional(),
  scan_title: z.string().nullable().optional(),
});

export const HistoricalNameSchema = z.object({
  name: z.string().min(1),
  valid_from: OptionalCoercedStringSchema,
  valid_to: OptionalCoercedStringSchema,
});

export const RawPersonSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  gedcom_xref: z.string().nullable().optional(),
  full_name: z.string(),
  given_name: z.string(),
  surname: z.string(),
  alt_names: z.array(z.string()).default([]),
  sex: z.string().default('U'),
  is_living: z.boolean().default(false),
  lineage_group: z.string().default('extended'),
  branch: z.string().optional(),
  birth_edtf: CoercedEdtfStringSchema.default(''),
  death_edtf: CoercedEdtfStringSchema.default(''),
  portrait_url: z.string().nullable().default(null),
  thumb_url: z.string().nullable().optional(),
  has_primary_source: z.boolean().optional(),
});

export const PersonSchema = RawPersonSchema.extend({
  birth_year: z.number().int().nullable(),
  death_year: z.number().int().nullable(),
  event_count: z.number().int().nonnegative(),
  media_count: z.number().int().nonnegative().optional(),
  primary_place_id: z.string().nullable(),
});

export const PlaceSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  full_name: z.string().min(1),
  place_type: PlaceTypeSchema,
  parent_id: z.string().nullable(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  min_lat: z.number().optional(),
  max_lat: z.number().optional(),
  min_lng: z.number().optional(),
  max_lng: z.number().optional(),
  ancestor_ids: z.array(z.string()).optional(),
  historical_names: z.array(HistoricalNameSchema).optional(),
  summary: z.string().nullable().optional(),
  photo_url: z.string().nullable().optional(),
  photo_caption: z.string().nullable().optional(),
  sources: z.array(EventSourceRefSchema).optional(),
  has_primary_source: z.boolean().optional(),
});

export const RawEventSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: EventScopeSchema,
  event_kind: EventKindSchema,
  category: z.string().nullable().optional(),
  edtf_date: CoercedEdtfStringSchema.default(''),
  alternate_dates: z.array(AlternateDateSchema).optional(),
  alternate_places: z.array(AlternatePlaceSchema).optional(),
  fact_conflicts: z.array(FactConflictSchema).optional(),
  place_id: z.string().nullable().default(null),
  place_precision: z.string().nullable().optional(),
  summary: z.string().nullable().default('').transform((v) => v ?? ''),
  severity_rank: z.number().nullable().optional(),
  weather_metrics: z.record(z.union([z.string(), z.number()])).optional(),
  source_url: z.string().nullable().optional(),
  photo_url: z.string().nullable().optional(),
  photo_placeholder_caption: z.string().nullable().optional(),
  participants: z.array(EventParticipantSchema).default([]),
  sources: z.array(EventSourceRefSchema).default([]),
  has_primary_source: z.boolean().optional(),
});

export const ArchiveEventSchema = RawEventSchema.extend({
  display_date: z.string(),
  year: z.number().int().nullable(),
  time_min: z.number().int().nullable(),
  time_max: z.number().int().nullable(),
  place_ancestors: z.array(z.string()).optional(),
});

export const NarrativeEnrichmentOverrideSchema = z.object({
  override_event_id: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  alternate_dates: z.array(AlternateDateSchema).optional(),
  alternate_places: z.array(AlternatePlaceSchema).optional(),
  fact_conflicts: z.array(FactConflictSchema).optional(),
  sources: z.array(EventSourceRefSchema).optional(),
  category: z.string().optional(),
  severity_rank: z.number().optional(),
  photo_url: z.string().optional(),
  photo_placeholder_caption: z.string().optional(),
});

export const NarrativeEnrichmentSchema = z.union([
  NarrativeEnrichmentOverrideSchema,
  RawEventSchema,
]);

export const ResidenceSpanSchema = z.object({
  id: z.string().min(1),
  person_id: z.string().min(1),
  place_id: z.string().min(1),
  time_min: z.number().int(),
  time_max: z.number().int(),
  start_year: z.number().int().nullable(),
  end_year: z.number().int().nullable(),
  confidence_tier: ConfidenceTierSchema,
  from_event_id: z.string().min(1),
  to_event_id: z.string().min(1),
});

export const KinshipEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  relation: KinshipRelationSchema,
  family_xref: z.string().nullable().optional(),
});

export const SourceRecordSchema = z.object({
  id: z.string().min(1),
  gedcom_xref: z.string().nullable().optional(),
  citation: z.string(),
  author: z.string().nullable().optional(),
  publisher: z.string().nullable().optional(),
  source_type: z.string(),
  repository: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  has_primary_source: z.boolean().optional(),
});

export const MediaItemSchema = z.object({
  id: z.string().min(1),
  kind: ArchivalMediaKindSchema,
  source_id: z.string().nullable().optional(),
  page: z.number().int().nullable().optional(),
  person_id: z.string().nullable().optional(),
  person_ids: z.array(z.string().min(1)).optional(),
  person_slug: z.string().nullable().optional(),
  person_name: z.string().nullable().optional(),
  event_id: z.string().nullable().optional(),
  file: z.string().min(1),
  thumb_file: z.string().nullable().optional(),
  caption: z.string(),
  date_edtf: OptionalCoercedStringSchema,
  provenance: z.string().nullable().optional(),
  has_primary_source: z.boolean().optional(),
});

export const NarrativeSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().optional(),
  body_md: z.string(),
  date_edtf: OptionalCoercedStringSchema,
  person_ids: z.array(z.string().min(1)).default([]),
  place_ids: z.array(z.string().min(1)).default([]),
  event_ids: z.array(z.string().min(1)).default([]),
  source_ids: z.array(z.string().min(1)).default([]),
  updated_at: z.string().optional(),
  has_primary_source: z.boolean().optional(),
});

export const ReadingPageSchema = z.object({
  page: z.number().int().positive(),
  label: z.string().min(1),
  file: z.string().min(1),
  text: z.string(),
  image_url: z.string().optional(),
});

export const ReadingDocumentSchema = z.object({
  source_id: z.string().min(1),
  title: z.string().min(1),
  author: z.string(),
  provenance: z.string(),
  pdf_url: z.string().optional(),
  pdf_size_bytes: z.number().int().nonnegative().optional(),
  pages: z.array(ReadingPageSchema),
});

export const ReadingsBundleSchema = z.object({
  version: z.number().int().positive(),
  documents: z.record(ReadingDocumentSchema),
  event_page_map: z.record(z.record(z.number().int())),
});

export const HistoricalContextItemSchema = RawEventSchema.extend({
  scope: z.enum(['local', 'state', 'national', 'global']),
});

export const ArchiveBundleCountsSchema = z.object({
  people: z.number().int().nonnegative(),
  living_redacted: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  residence_spans: z.number().int().nonnegative(),
  places: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  media: z.number().int().nonnegative().optional(),
  narratives: z.number().int().nonnegative().optional(),
});

export const ArchiveBundleMetaSchema = z.object({
  version: z.string().optional(),
  build_mode: BuildModeSchema,
  generated_at: z.string(),
  max_revision_id: z.number().int().nonnegative().optional(),
  uncited_entity_keys: z.array(z.string()).optional(),
  counts: ArchiveBundleCountsSchema,
});

export const ArchiveBundleSchema = z.object({
  meta: ArchiveBundleMetaSchema,
  people: z.array(PersonSchema),
  events: z.array(ArchiveEventSchema),
  residence_spans: z.array(ResidenceSpanSchema),
  places: z.array(PlaceSchema),
  place_ancestors: z.record(z.array(z.string())),
  kinship: z.array(KinshipEdgeSchema),
  sources: z.array(SourceRecordSchema),
  media: z.array(MediaItemSchema).optional(),
  narratives: z.array(NarrativeSchema).optional(),
});

export type EventScope = z.infer<typeof EventScopeSchema>;
export type EventKind = z.infer<typeof EventKindSchema>;
export type ConfidenceTier = z.infer<typeof ConfidenceTierSchema>;
export type PlaceType = z.infer<typeof PlaceTypeSchema>;
export type KinshipRelation = z.infer<typeof KinshipRelationSchema>;
export type SourceConfidence = z.infer<typeof SourceConfidenceSchema>;
export type ArchivalMediaKind = z.infer<typeof ArchivalMediaKindSchema>;
export type BuildMode = z.infer<typeof BuildModeSchema>;

export type AlternateDate = z.infer<typeof AlternateDateSchema>;
export type AlternatePlace = z.infer<typeof AlternatePlaceSchema>;
export type FactConflict = z.infer<typeof FactConflictSchema>;
export type EventParticipant = z.infer<typeof EventParticipantSchema>;
export type EventSourceRef = z.infer<typeof EventSourceRefSchema>;
export type HistoricalName = z.infer<typeof HistoricalNameSchema>;
export type RawPerson = z.infer<typeof RawPersonSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type Place = z.infer<typeof PlaceSchema>;
export type RawEvent = z.infer<typeof RawEventSchema>;
export type ArchiveEvent = z.infer<typeof ArchiveEventSchema>;
export type NarrativeEnrichmentOverride = z.infer<typeof NarrativeEnrichmentOverrideSchema>;
export type NarrativeEnrichment = z.infer<typeof NarrativeEnrichmentSchema>;
export type ResidenceSpan = z.infer<typeof ResidenceSpanSchema>;
export type KinshipEdge = z.infer<typeof KinshipEdgeSchema>;
export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type MediaItem = z.infer<typeof MediaItemSchema>;
export type Narrative = z.infer<typeof NarrativeSchema>;
export type ReadingPage = z.infer<typeof ReadingPageSchema>;
export type ReadingDocument = z.infer<typeof ReadingDocumentSchema>;
export type ReadingsBundle = z.infer<typeof ReadingsBundleSchema>;
export type HistoricalContextItem = z.infer<typeof HistoricalContextItemSchema>;
export type ArchiveBundle = z.infer<typeof ArchiveBundleSchema>;

export interface MediaChecklistItem {
  person_id: string;
  person_slug: string;
  person_name: string;
  lifespan: string;
  obje_xref: string;
  title: string;
  media_type: string;
  form: string;
  status?: 'digitized' | 'missing';
  file?: string;
}

export interface CoPresenceItem {
  person: Person;
  tier: ConfidenceTier;
  distanceMiles: number | null;
  sameHousehold: boolean;
  kinshipLabel: string;
  kinshipRank: number;
  placeId: string | null;
  matchedEventId: string | null;
}

export interface RadarSnapshot {
  coPresenceVisible: CoPresenceItem[];
  coPresenceOverflow: CoPresenceItem[];
  localVisible: ArchiveEvent[];
  localOverflow: ArchiveEvent[];
  macroVisible: ArchiveEvent[];
  macroOverflow: ArchiveEvent[];
}

export interface SourceReaderRequest {
  sourceId: string;
  eventId?: string;
  page?: number;
  highlightQuery?: string;
}

export interface SourceInspectorRequest {
  sourceId: string;
  eventId?: string;
  citationDetail?: string;
  claimedDate?: string;
  scanUrl?: string;
  scanTitle?: string;
  confidence?: SourceConfidence;
}

/**
 * Returns every person ID linked to a media item across both `person_ids` and legacy `person_id`.
 */
export function getMediaPersonIds(item: Pick<MediaItem, 'person_id' | 'person_ids'>): string[] {
  const ids = new Set<string>();
  if (item.person_id) {
    ids.add(item.person_id);
  }
  if (item.person_ids) {
    for (const id of item.person_ids) {
      if (id) {
        ids.add(id);
      }
    }
  }
  return [...ids];
}
