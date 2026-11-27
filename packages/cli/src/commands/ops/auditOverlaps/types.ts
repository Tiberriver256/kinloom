import type { KinshipEdge } from '@kinloom/core';
import type { AuditCommandResult } from '../audit.js';
import type { RemoveKinshipTarget } from '../integrate.js';
import type { LiveMediaFileCollision, StagedMediaRef } from '../live-media-collisions.js';

export const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

export const EVENT_DIFF_FIELDS = ['edtf_date', 'place_id', 'place_precision', 'title'] as const;

export type EventDiffField = (typeof EVENT_DIFF_FIELDS)[number];

export const PERSON_DIFF_FIELDS = [
  'slug',
  'full_name',
  'given_name',
  'surname',
  'sex',
  'birth_edtf',
  'death_edtf',
  'lineage_group',
  'branch',
] as const;

export type PersonDiffField = (typeof PERSON_DIFF_FIELDS)[number];

export interface ScanCollisionPackage {
  person_id: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface ScanFileCollision {
  basename: string;
  bytesIdentical: boolean;
  packages: ScanCollisionPackage[];
}

export interface MediaFileCollisionEntry {
  person_id: string;
  media_id: string;
  file: string;
}

export interface MediaFileCollision {
  file: string;
  mediaIdsConflict: boolean;
  entries: MediaFileCollisionEntry[];
}

export interface SharedMediaId {
  id: string;
  packages: Array<{ person_id: string; file: string }>;
}

export interface SharedSourceId {
  id: string;
  person_ids: string[];
}

export interface SharedEventPackage {
  person_id: string;
  edtf_date: string | null;
  place_id: string | null;
  place_precision: string | null;
  title: string | null;
}

export interface SharedEventOverlap {
  id: string;
  fieldDiffs: EventDiffField[];
  packages: SharedEventPackage[];
}

export interface SharedPersonPackage {
  person_id: string;
  slug: string | null;
  full_name: string | null;
  given_name: string | null;
  surname: string | null;
  sex: string | null;
  birth_edtf: string | null;
  death_edtf: string | null;
  lineage_group: string | null;
  branch: string | null;
}

export interface SharedPersonOverlap {
  id: string;
  fieldDiffs: PersonDiffField[];
  packages: SharedPersonPackage[];
}

export interface PersonSlugCollisionEntry {
  package_person_id: string;
  person_id: string;
  slug: string;
}

export interface PersonSlugCollision {
  slug: string;
  personIdsConflict: boolean;
  entries: PersonSlugCollisionEntry[];
}

export interface KinshipAddRemoveConflict {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  addedBy: string[];
  removedBy: string[];
}

export interface AuditOverlaps {
  scanFileCollisions: ScanFileCollision[];
  mediaFileCollisions: MediaFileCollision[];
  sharedMediaIds: SharedMediaId[];
  sharedSourceIds: SharedSourceId[];
  sharedEventOverlaps: SharedEventOverlap[];
  sharedPersonOverlaps: SharedPersonOverlap[];
  personSlugCollisions: PersonSlugCollision[];
  liveMediaFileCollisions: LiveMediaFileCollision[];
  kinshipAddRemoveConflicts: KinshipAddRemoveConflict[];
}

export interface AuditBatchSummary {
  people: number;
  passed: number;
  failed: number;
  strictPassed: number;
  scanFileCollisions: number;
  differingScanCollisions: number;
  mediaFileCollisions: number;
  conflictingMediaFileCollisions: number;
  sharedMediaIds: number;
  sharedSourceIds: number;
  sharedEventOverlaps: number;
  sharedEventFieldDiffs: number;
  sharedPersonOverlaps: number;
  conflictingPersonOverlaps: number;
  personSlugCollisions: number;
  conflictingPersonSlugCollisions: number;
  liveMediaFileCollisions: number;
  kinshipAddRemoveConflicts: number;
}

export type AuditBatchPerson = Omit<AuditCommandResult, 'rendered'>;

export interface AuditBatchResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  people: AuditBatchPerson[];
  overlaps: AuditOverlaps;
  summary: AuditBatchSummary;
  skippedAlreadyIntegrated?: string[];
  skippedDrifted?: string[];
  duration_ms: number;
  rendered: string;
}

export interface OverlapBlockingCounts {
  differingScanCollisions: number;
  conflictingMediaFileCollisions: number;
  conflictingPersonOverlaps: number;
  conflictingPersonSlugCollisions: number;
  liveMediaFileCollisions: number;
  kinshipAddRemoveConflicts: number;
}

export interface StagedOverlapAnalysis {
  overlaps: AuditOverlaps;
  blocking: OverlapBlockingCounts;
  hasBlockingConflicts: boolean;
}

export interface StagedSourceRef {
  id: string;
}

export interface StagedEventRow extends SharedEventPackage {
  id: string;
}

export interface StagedPersonRow extends SharedPersonPackage {
  id: string;
}

export interface StagedKinshipAdd {
  from: string;
  to: string;
  relation: KinshipEdge['relation'];
  family_xref: string | null;
}

export interface StagedScanFileEntry extends ScanCollisionPackage {
  basename: string;
}

export interface ParsedPackage {
  personId: string;
  packageDir: string;
  media: StagedMediaRef[];
  sources: StagedSourceRef[];
  eventRows: StagedEventRow[];
  stagedPeople: StagedPersonRow[];
  kinshipAdds: StagedKinshipAdd[];
  kinshipRemoves: RemoveKinshipTarget[];
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nullableText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
