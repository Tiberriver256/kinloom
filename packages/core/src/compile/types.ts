import type { KinloomSiteConfig } from '../schemas/config.js';
import type {
  ArchiveBundle,
  BuildMode,
  KinshipEdge,
  MediaItem,
  Narrative,
  NarrativeEnrichment,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';

export interface AncestryHouseholdEvent {
  type?: string | undefined;
  description?: string | undefined;
  date?: string | undefined;
}

export interface AncestryPersonRecord {
  personId?: string | number | undefined;
  events?: AncestryHouseholdEvent[] | undefined;
}

export interface CompiledMediaOverlay {
  media?: readonly MediaItem[] | undefined;
  people?: readonly { id: string; portrait_url?: string | null | undefined }[] | undefined;
  events?: readonly { id: string; photo_url?: string | undefined }[] | undefined;
}

export interface ExtractedSnapshotCollections {
  people: RawPerson[];
  events: RawEvent[];
  places: Place[];
  sources: SourceRecord[];
  media: MediaItem[];
  narratives: Narrative[];
  kinship: KinshipEdge[];
}

export interface CompileArchiveInput {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  places: readonly Place[];
  sources: readonly SourceRecord[];
  kinship: readonly KinshipEdge[];
  enrichments?: readonly NarrativeEnrichment[] | undefined;
  contextEvents?: readonly RawEvent[] | undefined;
  contextSources?: readonly SourceRecord[] | undefined;
  media?: readonly MediaItem[] | undefined;
  narratives?: readonly Narrative[] | undefined;
  ancestryPeople?: readonly AncestryPersonRecord[] | undefined;
  compiledMediaOverlay?: CompiledMediaOverlay | null | undefined;
  resolveThumbUrl?: ((mediaUrl: string | null | undefined) => string | undefined) | undefined;
  mediaExists?: ((fileUrl: string) => boolean) | undefined;
  siteConfig: KinloomSiteConfig;
  mode: BuildMode;
  generatedAt?: string | undefined;
  referenceYear?: number | undefined;
  version?: string | undefined;
  maxRevisionId?: number | undefined;
  legacyContainerSourceIds?: ReadonlySet<string> | undefined;
}

export interface CompileArchiveResult {
  bundle: ArchiveBundle;
  reviewFlags: string[];
  enrichedHouseholdCount: number;
}

export const ALLOWED_MANUAL_MEDIA_KINDS = new Set([
  'milestone',
  'portrait',
  'headstone',
  'family_photo',
  'document_scan',
  'record_scan',
  'video_story',
  'audio_oral_history',
]);

export const EVENT_HERO_MEDIA_KINDS = new Set(['milestone', 'headstone', 'family_photo']);
