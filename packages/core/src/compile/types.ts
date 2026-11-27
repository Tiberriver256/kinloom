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
  type?: string;
  description?: string;
  date?: string;
}

export interface AncestryPersonRecord {
  personId?: string | number;
  events?: AncestryHouseholdEvent[];
}

export interface CompiledMediaOverlay {
  media?: readonly MediaItem[];
  people?: readonly { id: string; portrait_url?: string | null }[];
  events?: readonly { id: string; photo_url?: string }[];
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
  enrichments?: readonly NarrativeEnrichment[];
  contextEvents?: readonly RawEvent[];
  contextSources?: readonly SourceRecord[];
  media?: readonly MediaItem[];
  narratives?: readonly Narrative[];
  ancestryPeople?: readonly AncestryPersonRecord[];
  compiledMediaOverlay?: CompiledMediaOverlay | null;
  resolveThumbUrl?: (mediaUrl: string | null | undefined) => string | undefined;
  mediaExists?: (fileUrl: string) => boolean;
  siteConfig: KinloomSiteConfig;
  mode: BuildMode;
  generatedAt?: string;
  referenceYear?: number;
  version?: string;
  maxRevisionId?: number;
  legacyContainerSourceIds?: ReadonlySet<string>;
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
