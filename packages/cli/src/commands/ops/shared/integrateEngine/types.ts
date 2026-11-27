import type { ArchiveBundle, KinshipEdge } from '@kinloom/core';
import type { LoadedLocalArchiveRepo } from '../../../dataFiles.js';

export const YEAR_ONLY_RE = /^\d{4}$/;
export const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;
export const SAFE_SLUG_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const INTEGRATION_RECEIPT_FILENAME = '.integrated.json';

export const INTEGRATE_YAML_FILES = [
  'people.yaml',
  'events.yaml',
  'places.yaml',
  'sources.yaml',
  'kinship.yaml',
  'media.yaml',
  'narratives.yaml',
] as const;

export interface IntegrateCommandOptions {
  repoDir?: string;
  personId: string;
  packageDir?: string;
  dryRun?: boolean;
  json?: boolean;
  preloadedRepo?: LoadedLocalArchiveRepo;
  preparsedPatch?: Record<string, unknown>;
}

export interface UpsertCounts {
  added: number;
  updated: number;
  unchanged: number;
}

export interface StagedScanReportItem {
  filename: string;
  sourcePath: string;
  destPath: string;
  url: string;
  r2Key: string;
  status: 'staged' | 'would_stage' | 'unchanged';
  sizeBytes: number;
  sha256: string;
}

export interface RemoveKinshipEntry {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
  symmetric: boolean;
}

export interface RemoveKinshipTarget {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
}

export interface RemovedKinshipEdge {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref?: string;
}

export interface IntegrateCommandResult {
  ok: true;
  dryRun: boolean;
  repo: string;
  personId: string;
  packageDir: string;
  mediaLayout: 'archive-media' | 'media';
  counts: {
    personUpdated: boolean;
    people: UpsertCounts;
    events: UpsertCounts;
    places: UpsertCounts;
    sources: UpsertCounts;
    media: UpsertCounts;
    kinship: UpsertCounts;
    narratives: UpsertCounts;
  };
  removedSourceIds: string[];
  removedEventIds: string[];
  removedMediaIds: string[];
  removedKinshipCount: number;
  removedKinship: RemovedKinshipEdge[];
  removedEvents: number;
  removedMedia: number;
  inlineCitationCount: number;
  stagedScans: StagedScanReportItem[];
  wouldWriteYamlFiles: string[];
  writtenYamlFiles: string[];
  validation: {
    privateCounts: ArchiveBundle['meta']['counts'];
    publicCounts: ArchiveBundle['meta']['counts'];
    privateReviewFlags: number;
    publicReviewFlags: number;
    livingLeaks: number;
  };
  rendered: string;
}

export interface IntegrationReceiptEntityIds {
  people: string[];
  events: string[];
  places: string[];
  sources: string[];
  media: string[];
  narratives: string[];
}

export interface IntegrationReceipt {
  schema_version: 1;
  person_id: string;
  patch_sha256: string;
  scans_sha256: Record<string, string>;
  integrated_at: string;
  integrated_entity_ids: IntegrationReceiptEntityIds;
}

export interface PackageFingerprints {
  patch_sha256: string;
  scans_sha256: Record<string, string>;
}

export interface IntegrateExecutionOverlay {
  dataDirOverride: string;
  virtualStagedScans: Map<string, string>;
}

export interface MediaLayout {
  layout: 'archive-media' | 'media';
  mediaUrlRoot: string;
  scanDestDir: string;
  scanUrlPrefix: string;
  r2KeyPrefix: string;
}

export interface PlannedScan {
  filename: string;
  sourcePath: string;
  destPath: string;
  url: string;
  r2Key: string;
  sizeBytes: number;
  sha256: string;
  alreadyIdentical: boolean;
}

export interface NormalizedPatch {
  person_id: string;
  person_updates: Record<string, unknown> | null;
  people: unknown[];
  events: unknown[];
  remove_event_ids: string[];
  places: unknown[];
  sources: unknown[];
  remove_source_ids: string[];
  media: unknown[];
  remove_media_ids: string[];
  kinship: unknown[];
  remove_kinship: RemoveKinshipEntry[];
  narratives: unknown[];
}
