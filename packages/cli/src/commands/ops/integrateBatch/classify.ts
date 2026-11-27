import fs from 'node:fs';
import path from 'node:path';
import { type LoadedLocalArchiveRepo, loadLocalArchiveRepoSync } from '../../dataFiles.js';
import { runIntegrateCommand } from '../shared/integrateEngine/execute.js';
import { detectMediaLayout } from '../shared/integrateEngine/media.js';
import {
  computePackageFingerprints,
  doesReceiptMatchPackage,
  readIntegrationReceipt,
} from '../shared/integrateEngine/receipts.js';
import type { IntegrateCommandResult, IntegrationReceipt } from '../shared/integrateEngine/types.js';
import { listStagedAuditPersonIds } from '../shared/stagedPackages.js';
import type { ClassifiedStagedPackages, StagedPackageStatus } from './types.js';

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
  const allStaged = personIds !== undefined ? [...personIds] : listStagedAuditPersonIds(resolvedRepo);

  const pending: string[] = [];
  const alreadyIntegrated: string[] = [];
  const alreadyIntegratedDrifted: string[] = [];
  const statuses: StagedPackageStatus[] = [];
  let sharedRepo: LoadedLocalArchiveRepo | null | undefined;

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
          pending.push(personId);
          statuses.push({ kind: 'pending', personId, reason: 'changes' });
          continue;
        }
        pending.push(personId);
        statuses.push({ kind: 'pending', personId, reason: 'package_modified' });
        continue;
      }

      if (sharedRepo === undefined) {
        try {
          sharedRepo = loadLocalArchiveRepoSync(resolvedRepo, {
            requireConfig: true,
            requirePeopleFile: true,
            includeEnrichments: true,
          });
        } catch {
          sharedRepo = null;
        }
      }

      const dryRunResult = await runIntegrateCommand({
        repoDir: resolvedRepo,
        personId,
        dryRun: true,
        json: false,
        preloadedRepo: sharedRepo ?? undefined,
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
