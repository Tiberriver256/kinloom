import type {
  ArchiveBundle,
  EntityPatch,
  EntityPayload,
  EntityType,
  KinloomSiteConfig,
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '@kinloom/core';

export const SYNC_DEPENDENCY_ORDER: readonly EntityType[] = [
  'place',
  'source',
  'person',
  'event',
  'kinship_edge',
  'media',
  'narrative',
];

import type { WranglerExecOptions, WranglerExecutor } from '../shared/wrangler.js';

export type { WranglerExecOptions, WranglerExecutor };

export interface SyncDeleteTarget {
  entity_type: EntityType;
  entity_id: string;
}

export interface WranglerBindings {
  configPath: string;
  dbName: string;
  r2Bucket: string;
  domain: string;
  baseUrl: string;
}

export interface SyncCommandOptions {
  repoDir?: string | undefined;
  siteUrl?: string | undefined;
  types?: readonly EntityType[] | undefined;
  syncMissingMedia?: boolean | undefined;
  uploadMediaPaths?: readonly string[] | undefined;
  concurrency?: number | undefined;
  chunkSize?: number | undefined;
  summary?: string | undefined;
  allowDeletes?: boolean | undefined;
  explicitDeletes?: readonly SyncDeleteTarget[] | undefined;
  includeLiving?: boolean | undefined;
  verifyLive?: boolean | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
  backupTokenLabel?: string | undefined;
  wranglerBin?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  execWrangler?: WranglerExecutor | undefined;
}

export interface SanitizedLocalEntry {
  entity_type: EntityType;
  entity_id: string;
  data: EntityPayload;
  has_primary_source: boolean;
  isLiving: boolean;
}

export interface RemoteEntityEntry {
  revisionId: number;
  data: EntityPayload;
  has_primary_source: boolean;
}

export interface SyncTypeCounts {
  local: number;
  remote: number;
  create: number;
  update: number;
  delete: number;
  unchanged: number;
  skippedLiving: number;
}

export interface SyncChangedSample {
  action: 'create' | 'update' | 'delete';
  entity_type: EntityType;
  entity_id: string;
  changedFields?: string[];
}

export interface SyncPlan {
  patches: EntityPatch[];
  countsByType: Partial<Record<EntityType, SyncTypeCounts>>;
  changedSamples: SyncChangedSample[];
}

export interface SyncSubmittedBatch {
  batch_id: string;
  patchCount: number;
  head_revision_id: number;
  etag: string;
}

export interface SyncRecompileSummary {
  httpStatus: number;
  etag: string | null;
  maxRevisionId: number | null;
  counts: ArchiveBundle['meta']['counts'] | null;
}

export interface SyncCleanupSummary {
  deletedTokenIds: string[];
  remainingTmpCount: number;
  backupTokenLabel: string;
  backupCount: number;
}

export interface SyncLiveVerificationFailure {
  target: string;
  url: string;
  status: number | null;
  reason: string;
}

export interface SyncLiveVerificationSummary {
  ok: boolean;
  bundleStatus: number | null;
  bundleRevision: number | null;
  expectedRevision: number | null;
  mediaChecked: number;
  mediaFailed: number;
  failures: SyncLiveVerificationFailure[];
}

export interface SyncCommandResult {
  repoDir: string;
  baseUrl: string;
  dbName: string;
  r2Bucket: string;
  dryRun: boolean;
  selectedTypes: EntityType[];
  remoteHeadBefore: number;
  remoteEtagBefore: string | null;
  countsByType: Partial<Record<EntityType, SyncTypeCounts>>;
  totalPatches: number;
  chunkSize: number;
  plannedBatches: number;
  changedSamples: SyncChangedSample[];
  filteredOutLivingMedia: number;
  media: {
    checkedRemoteCount: number;
    plannedUploads: string[];
    uploadedKeys: string[];
    concurrency: number;
  };
  batchesSubmitted: SyncSubmittedBatch[];
  recompile: SyncRecompileSummary | null;
  liveVerification: SyncLiveVerificationSummary | null;
  cleanup: SyncCleanupSummary | null;
  rendered: string;
}

export interface MintedTempToken {
  tokenId: string;
  rawToken: string;
  tokenHash: string;
  scope: 'read_backup' | 'write_batch';
}

export interface LocalArchiveFiles {
  siteConfig: KinloomSiteConfig;
  places: Place[];
  sources: SourceRecord[];
  people: RawPerson[];
  events: RawEvent[];
  kinship: KinshipEdge[];
  media: MediaItem[];
  narratives: Narrative[];
}

export interface RemoteSnapshotResponse {
  head_revision_id?: number;
  entities: ReadonlyArray<{
    entity_type: Exclude<EntityType, 'kinship_edge'>;
    entity_id: string;
    data: EntityPayload;
    current_revision_id: number;
    has_primary_source?: boolean;
    deleted_at?: string | null;
  }>;
  kinship: ReadonlyArray<{
    edge_id: string;
    edge: KinshipEdge;
    current_revision_id: number;
    deleted_at?: string | null;
  }>;
}

export interface MediaUploadTarget {
  localPath: string;
  r2Key: string;
  contentType: string;
}

export interface SyncExecutionContext {
  repoDir: string;
  mediaLayout: 'archive-media' | 'media';
  bindings: WranglerBindings;
  wranglerBin: string;
  fetchImpl: typeof fetch;
  execWrangler: WranglerExecutor;
  backupTokenLabel: string;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runWithConcurrency<TItem, TOut>(
  items: readonly TItem[],
  limit: number,
  worker: (item: TItem, idx: number) => Promise<TOut>
): Promise<TOut[]> {
  const results: TOut[] = Array.from({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= items.length) {
          return;
        }
        const item = items[idx];
        if (item === undefined) continue;
        results[idx] = await worker(item, idx);
      }
    })
  );

  return results;
}
