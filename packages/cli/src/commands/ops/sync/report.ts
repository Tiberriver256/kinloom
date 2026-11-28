import { SYNC_DEPENDENCY_ORDER, type SyncCommandResult } from './types.js';

export function formatSyncReport(report: Omit<SyncCommandResult, 'rendered'>): string {
  const lines: string[] = [
    `Archive: ${report.baseUrl}`,
    `Mode: ${report.dryRun ? 'DRY RUN (no remote D1/R2 mutations)' : 'LIVE SYNC'}`,
    `Bindings: D1=${report.dbName}, R2=${report.r2Bucket}`,
    `Remote head before sync: r${report.remoteHeadBefore} (etag=${report.remoteEtagBefore ?? 'none'})`,
    `Entity diff by type (${report.selectedTypes.join(', ')}):`,
  ];

  for (const type of SYNC_DEPENDENCY_ORDER) {
    const c = report.countsByType[type];
    if (!c) {
      continue;
    }
    const parts = [
      `local=${c.local}`,
      `remote=${c.remote}`,
      `create=${c.create}`,
      `update=${c.update}`,
      `delete=${c.delete}`,
      `unchanged=${c.unchanged}`,
    ];
    if (c.skippedLiving > 0) {
      parts.push(`skipped_living=${c.skippedLiving}`);
    }
    lines.push(`  - ${type}: ${parts.join(', ')}`);
  }

  lines.push(
    `Planned patches: ${report.totalPatches} (chunk_size=${report.chunkSize}, planned_batches=${report.plannedBatches})`
  );

  if (report.changedSamples.length > 0) {
    lines.push('Sample planned changes:');
    for (const sample of report.changedSamples) {
      const fields = sample.changedFields?.length ? ` [${sample.changedFields.join(', ')}]` : '';
      lines.push(`  - ${sample.action} ${sample.entity_type}:${sample.entity_id}${fields}`);
    }
  }

  if (report.media.checkedRemoteCount > 0 || report.media.plannedUploads.length > 0) {
    lines.push(
      `Media R2 sync: checked=${report.media.checkedRemoteCount}, planned_uploads=${report.media.plannedUploads.length}, uploaded=${report.media.uploadedKeys.length}, concurrency=${report.media.concurrency}`
    );
  }

  if (report.batchesSubmitted.length > 0) {
    lines.push(`Batches submitted: ${report.batchesSubmitted.length}`);
    const last = report.batchesSubmitted[report.batchesSubmitted.length - 1];
    if (last) {
      lines.push(`Last batch: ${last.batch_id} -> r${last.head_revision_id} (${last.etag})`);
    }
  }

  if (report.recompile) {
    lines.push(
      `Recompiled live /api/bundle: HTTP ${report.recompile.httpStatus}, ETag=${report.recompile.etag ?? 'none'}, max_revision_id=${report.recompile.maxRevisionId}`
    );
  }

  if (report.liveVerification) {
    const lv = report.liveVerification;
    lines.push(
      `Live verification [${lv.ok ? 'PASS' : 'FAIL'}]: bundle=HTTP ${lv.bundleStatus ?? 'error'} (rev=${lv.bundleRevision ?? 'none'}, expected=${lv.expectedRevision ?? 'none'}), media=${lv.mediaChecked - lv.mediaFailed}/${lv.mediaChecked} ok`
    );
    for (const failure of lv.failures) {
      lines.push(`  VERIFY FAIL [${failure.target}] ${failure.url}: ${failure.reason}`);
    }
  }

  if (report.cleanup) {
    lines.push(
      `Token cleanup: deleted ${report.cleanup.deletedTokenIds.length} temp token(s), verified ${report.cleanup.remainingTmpCount} remaining; active '${report.cleanup.backupTokenLabel}' count=${report.cleanup.backupCount}`
    );
  }

  return `${lines.join('\n')}\n`;
}
