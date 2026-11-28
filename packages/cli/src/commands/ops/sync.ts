import path from 'node:path';
import type { EntityType } from '@kinloom/core';
import { CliValidationError } from '../../errors.js';
import {
  detectSyncMediaLayout,
  findMissingRemoteMedia,
  resolveMediaUploadTarget,
  uploadMediaTargets,
} from './sync/media.js';
import {
  buildSanitizedLocalEntries,
  computeSyncPlan,
  indexRemoteSnapshot,
  loadLocalArchive,
} from './sync/planner.js';
import {
  fetchRemoteSnapshot,
  purgeCompiledBundleAndRecompile,
  submitPatchChunks,
  verifyLiveEndpoints,
} from './sync/remoteClient.js';
import { formatSyncReport } from './sync/report.js';
import {
  type MediaUploadTarget,
  SYNC_DEPENDENCY_ORDER,
  type SyncCleanupSummary,
  type SyncCommandOptions,
  type SyncCommandResult,
  type SyncExecutionContext,
  type SyncLiveVerificationSummary,
  type SyncRecompileSummary,
  type SyncSubmittedBatch,
} from './sync/types.js';
import {
  cleanupTempTokens,
  DEFAULT_BACKUP_TOKEN_LABEL,
  defaultWranglerExecutor,
  loadWranglerBindings,
  mintTempTokens,
  resolveWranglerBin,
} from './sync/wrangler.js';

export { SYNC_HELP } from './help.js';
export {
  buildSanitizedLocalEntries,
  computeSyncPlan,
  indexRemoteSnapshot,
  normalizeSyncEntityType,
  parseDeleteTargets,
  parseEntityTypeList,
} from './sync/planner.js';
export { formatSyncReport } from './sync/report.js';
export {
  type RemoteEntityEntry,
  type SanitizedLocalEntry,
  SYNC_DEPENDENCY_ORDER,
  type SyncChangedSample,
  type SyncCleanupSummary,
  type SyncCommandOptions,
  type SyncCommandResult,
  type SyncDeleteTarget,
  type SyncLiveVerificationFailure,
  type SyncLiveVerificationSummary,
  type SyncPlan,
  type SyncRecompileSummary,
  type SyncSubmittedBatch,
  type SyncTypeCounts,
  type WranglerBindings,
  type WranglerExecOptions,
  type WranglerExecutor,
} from './sync/types.js';
export {
  buildTempTokenCleanupSql,
  buildTempTokenInsertSql,
  generateTempToken,
  loadWranglerBindings,
  sqlLiteral,
  stripJsoncCommentsAndTrailingCommas,
} from './sync/wrangler.js';

const DEFAULT_CHUNK_SIZE = 25;
const DEFAULT_UPLOAD_CONCURRENCY = 6;

export async function runSyncCommand(options: SyncCommandOptions = {}): Promise<SyncCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const selectedTypes: EntityType[] =
    options.types && options.types.length > 0
      ? SYNC_DEPENDENCY_ORDER.filter((t) => options.types?.includes(t))
      : [...SYNC_DEPENDENCY_ORDER];
  const concurrency = options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const dryRun = Boolean(options.dryRun);
  const verifyLive = Boolean(options.verifyLive);
  const includeLiving = Boolean(options.includeLiving);
  const allowDeletes = Boolean(options.allowDeletes);
  const syncMissingMedia = Boolean(options.syncMissingMedia);
  const uploadMediaPaths = options.uploadMediaPaths ?? [];
  const explicitDeletes = options.explicitDeletes ?? [];
  const backupTokenLabel = options.backupTokenLabel?.trim() || DEFAULT_BACKUP_TOKEN_LABEL;

  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new CliValidationError('Option `--concurrency` must be a positive integer.');
  }
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new CliValidationError('Option `--chunk-size` must be a positive integer.');
  }
  if (options.summary !== undefined && options.summary.trim().length < 3) {
    throw new CliValidationError('Option `--summary` requires text of at least 3 characters.');
  }

  const bindings = loadWranglerBindings(repoDir, options.siteUrl);
  const wranglerBin = resolveWranglerBin(repoDir, options.wranglerBin);
  const mediaLayout = detectSyncMediaLayout(repoDir);
  const ctx: SyncExecutionContext = {
    repoDir,
    mediaLayout,
    bindings,
    wranglerBin,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    execWrangler: options.execWrangler ?? defaultWranglerExecutor,
    backupTokenLabel,
  };

  const local = await loadLocalArchive(repoDir);
  const sanitizedLocal = buildSanitizedLocalEntries(local);
  const summary =
    options.summary?.trim() || `Sync ${local.siteConfig.site.familyName} archive from local YAML`;

  const minted = await mintTempTokens(ctx);
  const mintedIds = [minted.read_backup.tokenId, minted.write_batch.tokenId];

  let cleanupResult: SyncCleanupSummary | null = null;
  let primaryError: unknown = null;
  let baseReport: Omit<SyncCommandResult, 'rendered'> | null = null;

  try {
    const remoteSnap = await fetchRemoteSnapshot(ctx, minted.read_backup.rawToken);
    const remoteByType = indexRemoteSnapshot(remoteSnap.snapshot);

    const plan = computeSyncPlan({
      selectedTypes,
      localByType: sanitizedLocal.byType,
      remoteByType,
      includeLiving,
      allowDeletes,
      explicitDeletes,
    });

    const mediaUploadTargetsMap = new Map<string, MediaUploadTarget>();
    for (const rawMediaPath of uploadMediaPaths) {
      const target = resolveMediaUploadTarget(repoDir, mediaLayout, rawMediaPath);
      mediaUploadTargetsMap.set(target.r2Key, target);
    }

    let checkedRemoteMediaCount = 0;
    if (syncMissingMedia) {
      const missingRes = await findMissingRemoteMedia(
        ctx,
        minted.write_batch.rawToken,
        sanitizedLocal.byType.media,
        {
          siteConfig: local.siteConfig,
          people: sanitizedLocal.byType.person,
          places: sanitizedLocal.byType.place,
        }
      );
      checkedRemoteMediaCount = missingRes.checkedCount;
      for (const item of missingRes.missing) {
        mediaUploadTargetsMap.set(item.r2Key, item);
      }
    }

    const mediaUploadTargets = [...mediaUploadTargetsMap.values()];
    let uploadedKeys: string[] = [];
    let batchesSubmitted: SyncSubmittedBatch[] = [];
    let recompile: SyncRecompileSummary | null = null;
    let liveVerification: SyncLiveVerificationSummary | null = null;

    if (!dryRun) {
      if (mediaUploadTargets.length > 0) {
        uploadedKeys = await uploadMediaTargets(ctx, mediaUploadTargets, concurrency);
      }
      if (plan.patches.length > 0) {
        batchesSubmitted = await submitPatchChunks({
          ctx,
          writeToken: minted.write_batch.rawToken,
          batchLabel: local.siteConfig.site.familyName,
          summary,
          patches: plan.patches,
          chunkSize,
        });
        recompile = await purgeCompiledBundleAndRecompile(ctx, minted.write_batch.rawToken);
      }
      if (verifyLive) {
        const expectedRevision =
          batchesSubmitted[batchesSubmitted.length - 1]?.head_revision_id ?? remoteSnap.headRevisionId;
        liveVerification = await verifyLiveEndpoints({
          ctx,
          writeToken: minted.write_batch.rawToken,
          expectedRevision,
          uploadedKeys,
          concurrency,
        });
      }
    }

    baseReport = {
      repoDir,
      baseUrl: bindings.baseUrl,
      dbName: bindings.dbName,
      r2Bucket: bindings.r2Bucket,
      dryRun,
      selectedTypes,
      remoteHeadBefore: remoteSnap.headRevisionId,
      remoteEtagBefore: remoteSnap.etag,
      countsByType: plan.countsByType,
      totalPatches: plan.patches.length,
      chunkSize,
      plannedBatches: Math.ceil(plan.patches.length / chunkSize),
      changedSamples: plan.changedSamples,
      filteredOutLivingMedia: sanitizedLocal.filteredOutMediaCount,
      media: {
        checkedRemoteCount: checkedRemoteMediaCount,
        plannedUploads: mediaUploadTargets.map((t) => t.r2Key),
        uploadedKeys,
        concurrency,
      },
      batchesSubmitted,
      recompile,
      liveVerification,
      cleanup: null,
    };
  } catch (err: unknown) {
    primaryError = err;
  } finally {
    try {
      cleanupResult = await cleanupTempTokens(ctx, mintedIds);
    } catch (cleanupErr: unknown) {
      if (!primaryError) {
        primaryError = cleanupErr;
      }
    }
  }

  if (primaryError !== null) {
    throw primaryError;
  }
  if (!baseReport) {
    throw new Error('Sync completed without producing a report.');
  }

  baseReport.cleanup = cleanupResult;

  const rendered = options.json ? `${JSON.stringify(baseReport, null, 2)}\n` : formatSyncReport(baseReport);

  return {
    ...baseReport,
    rendered,
  };
}
