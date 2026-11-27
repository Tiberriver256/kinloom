import type { AuditBatchResult } from './types.js';

function showNullable(value: string | null): string {
  return value ?? '-';
}

export function formatAuditBatchTextReport(report: Omit<AuditBatchResult, 'rendered'>): string {
  const lines: string[] = [];
  const skipped = report.skippedAlreadyIntegrated ?? [];
  const skippedDrifted = report.skippedDrifted ?? [];
  const skippedParts: string[] = [];
  if (skipped.length > 0) {
    skippedParts.push(`${skipped.length} already integrated skipped`);
  }
  if (skippedDrifted.length > 0) {
    skippedParts.push(`${skippedDrifted.length} drifted legacy skipped`);
  }
  const skippedSuffix = skippedParts.length > 0 ? ` (${skippedParts.join(', ')})` : '';
  lines.push(
    `Batch audit [${report.ok ? 'PASS' : 'FAIL'}] strict [${report.strictOk ? 'PASS' : 'FAIL'}] ` +
      `${report.summary.people} people${skippedSuffix} (${report.duration_ms} ms)`
  );
  lines.push(`  Repo: ${report.repo}`);
  if (skipped.length > 0) {
    lines.push(`  Skipped already integrated (${skipped.length}): ${skipped.join(', ')}`);
  }
  if (skippedDrifted.length > 0) {
    lines.push(`  Skipped drifted legacy (${skippedDrifted.length}): ${skippedDrifted.join(', ')}`);
  }
  if (report.people.length === 0) {
    lines.push('  No pending staged packages remain to audit.');
    return `${lines.join('\n')}\n`;
  }
  for (const person of report.people) {
    lines.push(
      `  ${person.person_id}: ${person.ok ? 'PASS' : 'FAIL'} strict ${person.strictOk ? 'PASS' : 'FAIL'}`
    );
    for (const err of person.errors) {
      lines.push(`    ERROR: ${err}`);
    }
  }

  lines.push('Overlaps:');
  if (report.overlaps.scanFileCollisions.length === 0) {
    lines.push('  Scan files: none');
  }
  for (const collision of report.overlaps.scanFileCollisions) {
    lines.push(
      `  Scan file ${collision.basename}: ${collision.bytesIdentical ? 'identical bytes' : 'different bytes'}`
    );
    for (const staged of collision.packages) {
      const dims =
        staged.width === null || staged.height === null ? 'unknown size' : `${staged.width}x${staged.height}`;
      lines.push(`    ${staged.person_id} ${staged.bytes} bytes ${dims} sha256=${staged.sha256}`);
    }
  }

  if (report.overlaps.mediaFileCollisions.length === 0) {
    lines.push('  Media files: none');
  }
  for (const collision of report.overlaps.mediaFileCollisions) {
    lines.push(
      `  Media file ${collision.file}: ${collision.mediaIdsConflict ? 'conflicting media ids' : 'same media id'}`
    );
    for (const entry of collision.entries) {
      lines.push(`    ${entry.person_id} media_id=${entry.media_id} file=${entry.file}`);
    }
  }

  if (report.overlaps.sharedMediaIds.length === 0) {
    lines.push('  Shared media ids: none');
  }
  for (const shared of report.overlaps.sharedMediaIds) {
    const detail = shared.packages.map((row) => `${row.person_id} file=${row.file}`).join('; ');
    lines.push(`  Shared media id ${shared.id}: ${detail}`);
  }

  if (report.overlaps.sharedSourceIds.length === 0) {
    lines.push('  Shared source ids: none');
  }
  for (const shared of report.overlaps.sharedSourceIds) {
    lines.push(`  Shared source id ${shared.id}: ${shared.person_ids.join(', ')}`);
  }

  if (report.overlaps.sharedEventOverlaps.length === 0) {
    lines.push('  Shared events: none');
  }
  for (const overlap of report.overlaps.sharedEventOverlaps) {
    const diff =
      overlap.fieldDiffs.length === 0
        ? 'same edtf_date, place_id, place_precision, and title'
        : `differs in ${overlap.fieldDiffs.join(', ')}`;
    lines.push(`  Event ${overlap.id}: ${diff}`);
    for (const staged of overlap.packages) {
      lines.push(
        `    ${staged.person_id} date=${showNullable(staged.edtf_date)} place=${showNullable(staged.place_id)} precision=${showNullable(staged.place_precision)} title=${showNullable(staged.title)}`
      );
    }
  }

  if (report.overlaps.sharedPersonOverlaps.length === 0) {
    lines.push('  Shared people: none');
  }
  for (const overlap of report.overlaps.sharedPersonOverlaps) {
    const diff =
      overlap.fieldDiffs.length === 0 ? 'same fields' : `differs in ${overlap.fieldDiffs.join(', ')}`;
    lines.push(`  Person ${overlap.id}: ${diff}`);
    for (const staged of overlap.packages) {
      lines.push(
        `    ${staged.person_id} name=${showNullable(staged.full_name)} slug=${showNullable(staged.slug)} birth=${showNullable(staged.birth_edtf)} death=${showNullable(staged.death_edtf)}`
      );
    }
  }

  if (report.overlaps.personSlugCollisions.length === 0) {
    lines.push('  Person slugs: none');
  }
  for (const collision of report.overlaps.personSlugCollisions) {
    lines.push(
      `  Person slug ${collision.slug}: ${collision.personIdsConflict ? 'conflicting person ids' : 'same person id'}`
    );
    for (const entry of collision.entries) {
      lines.push(`    ${entry.package_person_id} person_id=${entry.person_id} slug=${entry.slug}`);
    }
  }

  if (report.overlaps.liveMediaFileCollisions.length === 0) {
    lines.push('  Live media files: none');
  }
  for (const collision of report.overlaps.liveMediaFileCollisions) {
    lines.push(`  Live media file ${collision.file}: live id ${collision.live_media_id}`);
    for (const staged of collision.staged) {
      lines.push(`    ${staged.person_id} media_id=${staged.media_id} file=${staged.file}`);
    }
  }

  if (report.overlaps.kinshipAddRemoveConflicts.length === 0) {
    lines.push('  Kinship add/remove conflicts: none');
  }
  for (const conflict of report.overlaps.kinshipAddRemoveConflicts) {
    lines.push(
      `  Kinship ${conflict.from} -> ${conflict.to} (${conflict.relation}): ` +
        `added by ${conflict.addedBy.join(', ')}; removed by ${conflict.removedBy.join(', ')}`
    );
  }

  return `${lines.join('\n')}\n`;
}
