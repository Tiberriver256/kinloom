import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import {
  analyzeStagedOverlaps,
  listStagedAuditPersonIds,
  type StagedOverlapAnalysis,
} from './audit-overlaps.js';
import {
  INTEGRATION_RECEIPT_FILENAME,
  INTEGRATE_YAML_FILES,
  buildIntegrationReceiptForPackage,
  computePackageFingerprints,
  detectMediaLayout,
  doesReceiptMatchPackage,
  executeIntegrateSingle,
  readIntegrationReceipt,
  runIntegrateCommand,
  writeIntegrationReceipt,
  type IntegrateCommandResult,
  type IntegrateExecutionOverlay,
  type IntegrationReceipt,
  type UpsertCounts,
} from './integrate.js';

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

export type StagedPackageStatus =
  | {
      kind: 'pending';
      personId: string;
      reason: 'changes' | 'package_modified' | 'error';
      error?: string;
    }
  | { kind: 'already_integrated'; personId: string; reason: 'receipt_match' | 'exact_match' }
  | { kind: 'already_integrated_drifted'; personId: string; reason: 'live_superseded' };

export interface ClassifiedStagedPackages {
  allStaged: string[];
  pending: string[];
  alreadyIntegrated: string[];
  alreadyIntegratedDrifted: string[];
  statuses: StagedPackageStatus[];
}

export interface IntegrateBatchCommandOptions {
  repoDir?: string;
  personIds?: readonly string[];
  allStaged?: boolean;
  pendingOnly?: boolean;
  markIntegrated?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export interface IntegrateBatchTotals {
  personUpdated: number;
  people: UpsertCounts;
  events: UpsertCounts;
  places: UpsertCounts;
  sources: UpsertCounts;
  media: UpsertCounts;
  kinship: UpsertCounts;
  narratives: UpsertCounts;
  removedSources: number;
  removedEvents: number;
  removedMedia: number;
  removedKinship: number;
  inlineCitations: number;
  stagedScans: number;
}

export type IntegrateBatchItemResult = Omit<IntegrateCommandResult, 'rendered'>;

export interface IntegrateBatchCommandResult {
  mode: 'batch';
  ok: true;
  dryRun: boolean;
  repo: string;
  requested: string[];
  integrated: string[];
  skippedAlreadyIntegrated: string[];
  skippedDrifted: string[];
  markedIntegrated?: string[];
  preFlightOverlaps: StagedOverlapAnalysis;
  results: IntegrateBatchItemResult[];
  totals: IntegrateBatchTotals;
  wouldWriteYamlFiles: string[];
  writtenYamlFiles: string[];
  rendered: string;
}

interface BatchSnapshot {
  yamlFiles: Map<string, Buffer | null>;
  mediaFiles: Map<string, Buffer | null>;
  receiptFiles: Map<string, Buffer | null>;
}

interface RollbackStats {
  restoredYamlFiles: number;
  removedMediaFiles: number;
  restoredMediaFiles: number;
  restoredReceiptFiles: number;
}

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

function aggregateTotals(results: readonly IntegrateBatchItemResult[]): IntegrateBatchTotals {
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

export function hasUnintegratedEffect(result: IntegrateCommandResult): boolean {
  const { counts } = result;
  if (counts.personUpdated) {
    return true;
  }
  const buckets = [
    counts.people,
    counts.events,
    counts.places,
    counts.sources,
    counts.media,
    counts.kinship,
    counts.narratives,
  ];
  if (buckets.some((bucket) => bucket.added > 0 || bucket.updated > 0)) {
    return true;
  }
  if (
    result.removedSourceIds.length > 0 ||
    result.removedEventIds.length > 0 ||
    result.removedMediaIds.length > 0 ||
    result.removedKinshipCount > 0
  ) {
    return true;
  }
  if (result.stagedScans.some((scan) => scan.status !== 'unchanged')) {
    return true;
  }
  return false;
}

function hasAllReceiptScansLive(repoDir: string, receipt: IntegrationReceipt): boolean {
  const scanNames = Object.keys(receipt.scans_sha256);
  if (scanNames.length === 0) {
    return true;
  }
  const mediaLayout = detectMediaLayout(repoDir);
  for (const filename of scanNames) {
    const destPath = path.resolve(mediaLayout.scanDestDir, filename);
    if (!fs.existsSync(destPath)) {
      return false;
    }
  }
  return true;
}

function isLegacyLiveSuperseded(result: IntegrateCommandResult): boolean {
  const { counts } = result;
  const buckets = [
    counts.people,
    counts.events,
    counts.places,
    counts.sources,
    counts.media,
    counts.kinship,
    counts.narratives,
  ];
  if (buckets.some((bucket) => bucket.added > 0)) {
    return false;
  }
  if (
    result.removedSourceIds.length > 0 ||
    result.removedEventIds.length > 0 ||
    result.removedMediaIds.length > 0 ||
    result.removedKinshipCount > 0
  ) {
    return false;
  }
  if (result.stagedScans.some((scan) => scan.status !== 'unchanged')) {
    return false;
  }
  return hasUnintegratedEffect(result);
}

export async function isPackagePending(repoDir: string, personId: string): Promise<boolean> {
  const classified = await classifyStagedPackages(repoDir, [personId]);
  return classified.pending.includes(personId);
}

export async function classifyStagedPackages(
  repoDir: string,
  personIds?: readonly string[]
): Promise<ClassifiedStagedPackages> {
  const resolvedRepo = path.resolve(repoDir);
  const allStaged =
    personIds !== undefined
      ? [...personIds]
      : listStagedAuditPersonIds(resolvedRepo);

  const pending: string[] = [];
  const alreadyIntegrated: string[] = [];
  const alreadyIntegratedDrifted: string[] = [];
  const statuses: StagedPackageStatus[] = [];

  for (const personId of allStaged) {
    const packageDir = path.join(resolvedRepo, 'research', 'people', personId);
    try {
      const receipt = readIntegrationReceipt(packageDir);
      if (receipt !== null) {
        const fingerprints = computePackageFingerprints(packageDir);
        if (doesReceiptMatchPackage(receipt, fingerprints)) {
          if (hasAllReceiptScansLive(resolvedRepo, receipt)) {
            alreadyIntegrated.push(personId);
            statuses.push({ kind: 'already_integrated', personId, reason: 'receipt_match' });
            continue;
          }
          // Live media scan was deleted after integration; re-queue as pending to restore it.
          pending.push(personId);
          statuses.push({ kind: 'pending', personId, reason: 'changes' });
          continue;
        }
        pending.push(personId);
        statuses.push({ kind: 'pending', personId, reason: 'package_modified' });
        continue;
      }

      const dryRunResult = await runIntegrateCommand({
        repoDir: resolvedRepo,
        personId,
        dryRun: true,
        json: false,
      });
      if (!hasUnintegratedEffect(dryRunResult)) {
        alreadyIntegrated.push(personId);
        statuses.push({ kind: 'already_integrated', personId, reason: 'exact_match' });
      } else if (isLegacyLiveSuperseded(dryRunResult)) {
        alreadyIntegratedDrifted.push(personId);
        statuses.push({
          kind: 'already_integrated_drifted',
          personId,
          reason: 'live_superseded',
        });
      } else {
        pending.push(personId);
        statuses.push({ kind: 'pending', personId, reason: 'changes' });
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      pending.push(personId);
      statuses.push({ kind: 'pending', personId, reason: 'error', error });
    }
  }

  return { allStaged, pending, alreadyIntegrated, alreadyIntegratedDrifted, statuses };
}

export function formatBlockingOverlapError(analysis: StagedOverlapAnalysis): string {
  const { blocking, overlaps } = analysis;
  const details: string[] = [];

  if (blocking.differingScanCollisions > 0) {
    const items = overlaps.scanFileCollisions
      .filter((row) => !row.bytesIdentical)
      .map((row) => `${row.basename} (${row.packages.map((pkg) => pkg.person_id).join(', ')})`);
    details.push(
      `differingScanCollisions=${blocking.differingScanCollisions}: ${items.join('; ')}`
    );
  }
  if (blocking.conflictingMediaFileCollisions > 0) {
    const items = overlaps.mediaFileCollisions
      .filter((row) => row.mediaIdsConflict)
      .map(
        (row) =>
          `${row.file} (${row.entries.map((e) => `${e.person_id}:${e.media_id}`).join(', ')})`
      );
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
    details.push(
      `conflictingPersonOverlaps=${blocking.conflictingPersonOverlaps}: ${items.join('; ')}`
    );
  }
  if (blocking.conflictingPersonSlugCollisions > 0) {
    const items = overlaps.personSlugCollisions
      .filter((row) => row.personIdsConflict)
      .map(
        (row) =>
          `${row.slug} (${row.entries.map((e) => `${e.package_person_id}:${e.person_id}`).join(', ')})`
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
    details.push(
      `liveMediaFileCollisions=${blocking.liveMediaFileCollisions}: ${items.join('; ')}`
    );
  }
  if (blocking.kinshipAddRemoveConflicts > 0) {
    const items = overlaps.kinshipAddRemoveConflicts.map(
      (row) =>
        `${row.from}->${row.to}:${row.relation} (added=${row.addedBy.join(',')}, removed=${row.removedBy.join(',')})`
    );
    details.push(
      `kinshipAddRemoveConflicts=${blocking.kinshipAddRemoveConflicts}: ${items.join('; ')}`
    );
  }

  return (
    `Pre-flight overlap check blocked batch integrate before writing any files. ` +
    `Resolve conflicts and retry (run \`kinloom audit --all-staged --strict\` for full details): ` +
    details.join(' | ')
  );
}

function writeFileAtomicBuffer(filePath: string, content: Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(6).toString('hex');
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${suffix}`);
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}

function captureBatchSnapshot(repoDir: string, personIds: readonly string[]): BatchSnapshot {
  const dataDir = path.join(repoDir, 'data');
  const yamlFiles = new Map<string, Buffer | null>();
  for (const fileName of INTEGRATE_YAML_FILES) {
    const fullPath = path.join(dataDir, fileName);
    yamlFiles.set(fullPath, fs.existsSync(fullPath) ? fs.readFileSync(fullPath) : null);
  }

  const mediaLayout = detectMediaLayout(repoDir);
  const mediaFiles = new Map<string, Buffer | null>();
  const receiptFiles = new Map<string, Buffer | null>();
  for (const personId of personIds) {
    const receiptPath = path.join(
      repoDir,
      'research',
      'people',
      personId,
      INTEGRATION_RECEIPT_FILENAME
    );
    receiptFiles.set(receiptPath, fs.existsSync(receiptPath) ? fs.readFileSync(receiptPath) : null);

    const scansDir = path.join(repoDir, 'research', 'people', personId, 'scans');
    if (!fs.existsSync(scansDir)) {
      continue;
    }
    const entries = fs.readdirSync(scansDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (
        entry.name.includes('/') ||
        entry.name.includes('\\') ||
        entry.name === '.' ||
        entry.name === '..'
      ) {
        continue;
      }
      const destPath = path.resolve(mediaLayout.scanDestDir, entry.name);
      if (mediaFiles.has(destPath)) {
        continue;
      }
      mediaFiles.set(destPath, fs.existsSync(destPath) ? fs.readFileSync(destPath) : null);
    }
  }

  return { yamlFiles, mediaFiles, receiptFiles };
}

function restoreBatchSnapshot(snapshot: BatchSnapshot): RollbackStats {
  let restoredYamlFiles = 0;
  let removedMediaFiles = 0;
  let restoredMediaFiles = 0;
  let restoredReceiptFiles = 0;

  for (const [filePath, originalBytes] of snapshot.yamlFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        restoredYamlFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(filePath) || !fs.readFileSync(filePath).equals(originalBytes)) {
      writeFileAtomicBuffer(filePath, originalBytes);
      restoredYamlFiles += 1;
    }
  }

  for (const [destPath, originalBytes] of snapshot.mediaFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(destPath)) {
        fs.unlinkSync(destPath);
        removedMediaFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(originalBytes)) {
      writeFileAtomicBuffer(destPath, originalBytes);
      restoredMediaFiles += 1;
    }
  }

  for (const [receiptPath, originalBytes] of snapshot.receiptFiles) {
    if (originalBytes === null) {
      if (fs.existsSync(receiptPath)) {
        fs.unlinkSync(receiptPath);
        restoredReceiptFiles += 1;
      }
      continue;
    }
    if (!fs.existsSync(receiptPath) || !fs.readFileSync(receiptPath).equals(originalBytes)) {
      writeFileAtomicBuffer(receiptPath, originalBytes);
      restoredReceiptFiles += 1;
    }
  }

  return { restoredYamlFiles, removedMediaFiles, restoredMediaFiles, restoredReceiptFiles };
}

function createDryRunDataDirCopy(repoDir: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-integrate-dryrun-'));
  const sourceDataDir = path.join(repoDir, 'data');
  if (fs.existsSync(sourceDataDir) && fs.statSync(sourceDataDir).isDirectory()) {
    const entries = fs.readdirSync(sourceDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.yaml')) {
        fs.copyFileSync(path.join(sourceDataDir, entry.name), path.join(tmpDir, entry.name));
      }
    }
  }
  return tmpDir;
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
  lines.push(
    `Batch integrate ${dryLabel}OK: ${report.integrated.length} package(s)${skippedSuffix}`
  );
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

export async function runIntegrateBatchCommand(
  options: IntegrateBatchCommandOptions
): Promise<IntegrateBatchCommandResult> {
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const allStaged = Boolean(options.allStaged);
  const pendingOnly = Boolean(options.pendingOnly);
  const markIntegrated = Boolean(options.markIntegrated);
  const dryRun = Boolean(options.dryRun);

  if (pendingOnly && !allStaged) {
    throw new CliValidationError('Option `--pending-only` requires `--all-staged`.');
  }
  if (markIntegrated && (!allStaged || !pendingOnly)) {
    throw new CliValidationError(
      'Option `--mark-integrated` requires both `--all-staged` and `--pending-only`.'
    );
  }
  const explicitIds = (options.personIds ?? [])
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  if (allStaged && explicitIds.length > 0) {
    throw new CliValidationError(
      '`--all-staged` discovers person ids from research/people and does not take person ids.'
    );
  }
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  let requested: string[];
  if (allStaged) {
    requested = listStagedAuditPersonIds(repoDir);
    if (!pendingOnly && requested.length === 0) {
      throw new CliValidationError(
        'No staged packages with patch.json were found under research/people/.'
      );
    }
  } else {
    if (explicitIds.length === 0) {
      throw new CliValidationError(
        'Integrate requires at least one person_id or `--all-staged`.'
      );
    }
    const seen = new Set<string>();
    for (const personId of explicitIds) {
      if (!SAFE_PERSON_ID_RE.test(personId)) {
        throw new CliValidationError(
          `Invalid person_id '${personId}'. Only ASCII letters, digits, _, and - are allowed.`
        );
      }
      if (seen.has(personId)) {
        throw new CliValidationError(`Duplicate person_id '${personId}'.`);
      }
      seen.add(personId);
    }
    requested = explicitIds;
  }

  let targetIds = requested;
  let skippedAlreadyIntegrated: string[] = [];
  let skippedDrifted: string[] = [];
  let markedIntegrated: string[] | undefined;
  if (pendingOnly) {
    const classified = await classifyStagedPackages(repoDir, requested);
    targetIds = classified.pending;
    skippedAlreadyIntegrated = classified.alreadyIntegrated;
    skippedDrifted = classified.alreadyIntegratedDrifted;
    if (markIntegrated) {
      const legacyToMark = classified.statuses
        .filter(
          (status) =>
            (status.kind === 'already_integrated' && status.reason === 'exact_match') ||
            status.kind === 'already_integrated_drifted'
        )
        .map((status) => status.personId);
      markedIntegrated = legacyToMark;
      if (!dryRun) {
        for (const personId of legacyToMark) {
          const packageDir = path.join(repoDir, 'research', 'people', personId);
          writeIntegrationReceipt(
            packageDir,
            buildIntegrationReceiptForPackage(packageDir, personId)
          );
        }
      }
    }
  }

  const preFlightOverlaps = analyzeStagedOverlaps(repoDir, targetIds);
  if (preFlightOverlaps.hasBlockingConflicts) {
    throw new CliValidationError(formatBlockingOverlapError(preFlightOverlaps));
  }

  const results: IntegrateBatchItemResult[] = [];
  const wouldWriteSet = new Set<string>();
  const writtenSet = new Set<string>();

  if (targetIds.length > 0) {
    if (dryRun) {
      const tmpDataDir = createDryRunDataDirCopy(repoDir);
      const overlay: IntegrateExecutionOverlay = {
        dataDirOverride: tmpDataDir,
        virtualStagedScans: new Map<string, string>(),
      };
      try {
        for (let i = 0; i < targetIds.length; i += 1) {
          const personId = targetIds[i];
          try {
            const single = await executeIntegrateSingle(
              { repoDir, personId, dryRun: true, json: false },
              overlay
            );
            const { rendered: _rendered, ...item } = single;
            results.push(item);
            for (const filePath of item.wouldWriteYamlFiles) {
              wouldWriteSet.add(filePath);
            }
          } catch (err: unknown) {
            const detail = err instanceof Error ? err.message : String(err);
            const message = `Batch integrate dry-run failed on '${personId}' (package ${i + 1}/${targetIds.length}): ${detail}`;
            if (err instanceof CliValidationError) {
              throw new CliValidationError(message, err.issues);
            }
            throw new Error(message, { cause: err });
          }
        }
      } finally {
        fs.rmSync(tmpDataDir, { recursive: true, force: true });
      }
    } else {
      const snapshot = captureBatchSnapshot(repoDir, targetIds);
      for (let i = 0; i < targetIds.length; i += 1) {
        const personId = targetIds[i];
        try {
          const single = await executeIntegrateSingle({
            repoDir,
            personId,
            dryRun: false,
            json: false,
          });
          const { rendered: _rendered, ...item } = single;
          results.push(item);
          for (const filePath of item.wouldWriteYamlFiles) {
            wouldWriteSet.add(filePath);
          }
          for (const filePath of item.writtenYamlFiles) {
            writtenSet.add(filePath);
          }
        } catch (err: unknown) {
          const detail = err instanceof Error ? err.message : String(err);
          let rollbackNote: string;
          try {
            const stats = restoreBatchSnapshot(snapshot);
            const mediaNote =
              stats.restoredMediaFiles > 0
                ? `${stats.removedMediaFiles} newly staged media file(s) removed and ${stats.restoredMediaFiles} overwritten media file(s) restored`
                : `${stats.removedMediaFiles} newly staged media file(s) removed`;
            rollbackNote = `Rollback succeeded: ${stats.restoredYamlFiles} YAML file(s) restored, ${mediaNote}.`;
          } catch (rollbackErr: unknown) {
            const rollbackDetail =
              rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
            rollbackNote = `Rollback FAILED: ${rollbackDetail}.`;
          }
          const message = `Batch integrate failed on '${personId}' (package ${i + 1}/${targetIds.length}): ${detail}. ${rollbackNote}`;
          if (err instanceof CliValidationError) {
            throw new CliValidationError(message, err.issues);
          }
          throw new Error(message, { cause: err });
        }
      }
    }
  }

  const summaryBase: Omit<IntegrateBatchCommandResult, 'rendered'> = {
    mode: 'batch',
    ok: true,
    dryRun,
    repo: repoDir,
    requested,
    integrated: targetIds,
    skippedAlreadyIntegrated,
    skippedDrifted,
    ...(markedIntegrated !== undefined ? { markedIntegrated } : {}),
    preFlightOverlaps,
    results,
    totals: aggregateTotals(results),
    wouldWriteYamlFiles: [...wouldWriteSet].sort((a, b) => a.localeCompare(b)),
    writtenYamlFiles: [...writtenSet].sort((a, b) => a.localeCompare(b)),
  };

  const rendered = options.json
    ? JSON.stringify(summaryBase, null, 2)
    : formatIntegrateBatchTextReport(summaryBase);

  return {
    ...summaryBase,
    rendered,
  };
}
