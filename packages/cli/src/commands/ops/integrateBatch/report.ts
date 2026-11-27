import type { StagedOverlapAnalysis } from '../audit-overlaps.js';
import type { UpsertCounts } from '../integrate.js';
import type { IntegrateBatchCommandResult, IntegrateBatchItemResult, IntegrateBatchTotals } from './types.js';

function emptyUpsertCounts(): UpsertCounts {
  return { added: 0, updated: 0, unchanged: 0 };
}

function addUpsertCounts(target: UpsertCounts, delta: UpsertCounts): void {
  target.added += delta.added;
  target.updated += delta.updated;
  target.unchanged += delta.unchanged;
}

function createEmptyTotals(): IntegrateBatchTotals {
  return {
    personUpdated: 0,
    people: emptyUpsertCounts(),
    events: emptyUpsertCounts(),
    places: emptyUpsertCounts(),
    sources: emptyUpsertCounts(),
    media: emptyUpsertCounts(),
    kinship: emptyUpsertCounts(),
    narratives: emptyUpsertCounts(),
    removedSources: 0,
    removedEvents: 0,
    removedMedia: 0,
    removedKinship: 0,
    inlineCitations: 0,
    stagedScans: 0,
  };
}

export function aggregateTotals(results: readonly IntegrateBatchItemResult[]): IntegrateBatchTotals {
  const totals = createEmptyTotals();
  for (const item of results) {
    if (item.counts.personUpdated) {
      totals.personUpdated += 1;
    }
    addUpsertCounts(totals.people, item.counts.people);
    addUpsertCounts(totals.events, item.counts.events);
    addUpsertCounts(totals.places, item.counts.places);
    addUpsertCounts(totals.sources, item.counts.sources);
    addUpsertCounts(totals.media, item.counts.media);
    addUpsertCounts(totals.kinship, item.counts.kinship);
    addUpsertCounts(totals.narratives, item.counts.narratives);
    totals.removedSources += item.removedSourceIds.length;
    totals.removedEvents += item.removedEventIds.length;
    totals.removedMedia += item.removedMediaIds.length;
    totals.removedKinship += item.removedKinshipCount;
    totals.inlineCitations += item.inlineCitationCount;
    totals.stagedScans += item.stagedScans.length;
  }
  return totals;
}

export function formatBlockingOverlapError(analysis: StagedOverlapAnalysis): string {
  const { blocking, overlaps } = analysis;
  const details: string[] = [];

  if (blocking.differingScanCollisions > 0) {
    const items = overlaps.scanFileCollisions
      .filter((row) => !row.bytesIdentical)
      .map((row) => `${row.basename} (${row.packages.map((pkg) => pkg.person_id).join(', ')})`);
    details.push(`differingScanCollisions=${blocking.differingScanCollisions}: ${items.join('; ')}`);
  }
  if (blocking.conflictingMediaFileCollisions > 0) {
    const items = overlaps.mediaFileCollisions
      .filter((row) => row.mediaIdsConflict)
      .map((row) => `${row.file} (${row.entries.map((e) => `${e.person_id}:${e.media_id}`).join(', ')})`);
    details.push(
      `conflictingMediaFileCollisions=${blocking.conflictingMediaFileCollisions}: ${items.join('; ')}`
    );
  }
  if (blocking.conflictingPersonOverlaps > 0) {
    const items = overlaps.sharedPersonOverlaps
      .filter((row) => row.fieldDiffs.length > 0)
      .map(
        (row) =>
          `${row.id} differs in [${row.fieldDiffs.join(', ')}] across ${row.packages.map((p) => p.person_id).join(', ')}`
      );
    details.push(`conflictingPersonOverlaps=${blocking.conflictingPersonOverlaps}: ${items.join('; ')}`);
  }
  if (blocking.conflictingPersonSlugCollisions > 0) {
    const items = overlaps.personSlugCollisions
      .filter((row) => row.personIdsConflict)
      .map(
        (row) => `${row.slug} (${row.entries.map((e) => `${e.package_person_id}:${e.person_id}`).join(', ')})`
      );
    details.push(
      `conflictingPersonSlugCollisions=${blocking.conflictingPersonSlugCollisions}: ${items.join('; ')}`
    );
  }
  if (blocking.liveMediaFileCollisions > 0) {
    const items = overlaps.liveMediaFileCollisions.map(
      (row) =>
        `${row.file} (live=${row.live_media_id}, staged=${row.staged.map((s) => `${s.person_id}:${s.media_id}`).join(', ')})`
    );
    details.push(`liveMediaFileCollisions=${blocking.liveMediaFileCollisions}: ${items.join('; ')}`);
  }
  if (blocking.kinshipAddRemoveConflicts > 0) {
    const items = overlaps.kinshipAddRemoveConflicts.map(
      (row) =>
        `${row.from}->${row.to}:${row.relation} (added=${row.addedBy.join(',')}, removed=${row.removedBy.join(',')})`
    );
    details.push(`kinshipAddRemoveConflicts=${blocking.kinshipAddRemoveConflicts}: ${items.join('; ')}`);
  }

  return (
    `Pre-flight overlap check blocked batch integrate before writing any files. ` +
    `Resolve conflicts and retry (run \`kinloom audit --all-staged --strict\` for full details): ` +
    details.join(' | ')
  );
}

export function formatIntegrateBatchTextReport(
  report: Omit<IntegrateBatchCommandResult, 'rendered'>
): string {
  const lines: string[] = [];
  const dryLabel = report.dryRun ? 'dry-run ' : '';
  const skippedParts: string[] = [];
  if (report.skippedAlreadyIntegrated.length > 0) {
    skippedParts.push(`${report.skippedAlreadyIntegrated.length} already integrated skipped`);
  }
  if (report.skippedDrifted.length > 0) {
    skippedParts.push(`${report.skippedDrifted.length} drifted legacy skipped`);
  }
  const skippedSuffix = skippedParts.length > 0 ? ` (${skippedParts.join(', ')})` : '';
  lines.push(`Batch integrate ${dryLabel}OK: ${report.integrated.length} package(s)${skippedSuffix}`);
  lines.push(`  Repo: ${report.repo}`);
  if (report.skippedAlreadyIntegrated.length > 0) {
    lines.push(
      `  Skipped already integrated (${report.skippedAlreadyIntegrated.length}): ${report.skippedAlreadyIntegrated.join(', ')}`
    );
  }
  if (report.skippedDrifted.length > 0) {
    lines.push(
      `  Warning: Skipped ${report.skippedDrifted.length} legacy already-integrated package(s) whose live YAML has diverged (${report.skippedDrifted.join(', ')}); run 'kinloom integrate <person_id>' explicitly to re-apply or '--mark-integrated' to record receipts.`
    );
  }
  if (report.markedIntegrated && report.markedIntegrated.length > 0) {
    lines.push(
      `  Recorded receipts (${report.markedIntegrated.length}): ${report.markedIntegrated.join(', ')}`
    );
  }
  if (report.integrated.length === 0) {
    lines.push('  No pending staged packages remain to integrate.');
    return lines.join('\n');
  }
  for (const item of report.results) {
    lines.push(
      `  ${item.personId}: person=${item.counts.personUpdated ? 'updated' : 'unchanged'}, ` +
        `people=+${item.counts.people.added}/~${item.counts.people.updated}, ` +
        `events=+${item.counts.events.added}/~${item.counts.events.updated}${item.removedEventIds.length > 0 ? `/-${item.removedEventIds.length}` : ''}, ` +
        `places=+${item.counts.places.added}/~${item.counts.places.updated}, ` +
        `sources=+${item.counts.sources.added}/~${item.counts.sources.updated}${item.removedSourceIds.length > 0 ? `/-${item.removedSourceIds.length}` : ''}, ` +
        `media=+${item.counts.media.added}/~${item.counts.media.updated}${item.removedMediaIds.length > 0 ? `/-${item.removedMediaIds.length}` : ''}, ` +
        `${item.counts.kinship.added > 0 || item.counts.kinship.updated > 0 || item.removedKinshipCount > 0 ? `kinship=+${item.counts.kinship.added}/~${item.counts.kinship.updated}${item.removedKinshipCount > 0 ? `/-${item.removedKinshipCount}` : ''}, ` : ''}` +
        `narratives=+${item.counts.narratives.added}/~${item.counts.narratives.updated}, ` +
        `scans=${item.stagedScans.length}`
    );
  }
  const { totals } = report;
  lines.push(
    `  Totals: personUpdated=${totals.personUpdated}, ` +
      `people=+${totals.people.added}/~${totals.people.updated}, ` +
      `events=+${totals.events.added}/~${totals.events.updated}${totals.removedEvents > 0 ? `/-${totals.removedEvents}` : ''}, ` +
      `places=+${totals.places.added}/~${totals.places.updated}, ` +
      `sources=+${totals.sources.added}/~${totals.sources.updated}${totals.removedSources > 0 ? `/-${totals.removedSources}` : ''}, ` +
      `media=+${totals.media.added}/~${totals.media.updated}${totals.removedMedia > 0 ? `/-${totals.removedMedia}` : ''}, ` +
      `kinship=+${totals.kinship.added}/~${totals.kinship.updated}${totals.removedKinship > 0 ? `/-${totals.removedKinship}` : ''}, ` +
      `narratives=+${totals.narratives.added}/~${totals.narratives.updated}, ` +
      `inlineCitations=${totals.inlineCitations}, scans=${totals.stagedScans}, ` +
      `written=${report.writtenYamlFiles.length}`
  );
  return lines.join('\n');
}
