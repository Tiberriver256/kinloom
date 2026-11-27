import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import { analyzeStagedOverlaps, listStagedAuditPersonIds } from './audit-overlaps.js';
import { buildIntegrationReceiptForPackage, writeIntegrationReceipt } from './integrate.js';
import {
  classifyStagedPackages,
  hasUnintegratedEffect,
  isPackagePending,
} from './integrateBatch/classify.js';
import { executeBatchTargets } from './integrateBatch/executor.js';
import {
  aggregateTotals,
  formatBlockingOverlapError,
  formatIntegrateBatchTextReport,
} from './integrateBatch/report.js';
import type {
  ClassifiedStagedPackages,
  IntegrateBatchCommandOptions,
  IntegrateBatchCommandResult,
  IntegrateBatchItemResult,
  IntegrateBatchTotals,
  StagedPackageStatus,
} from './integrateBatch/types.js';

export type {
  ClassifiedStagedPackages,
  IntegrateBatchCommandOptions,
  IntegrateBatchCommandResult,
  IntegrateBatchItemResult,
  IntegrateBatchTotals,
  StagedPackageStatus,
};
export {
  classifyStagedPackages,
  formatBlockingOverlapError,
  formatIntegrateBatchTextReport,
  hasUnintegratedEffect,
  isPackagePending,
};

const SAFE_PERSON_ID_RE = /^[a-zA-Z0-9_-]+$/;

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
  const explicitIds = (options.personIds ?? []).map((id) => id.trim()).filter((id) => id.length > 0);
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
      throw new CliValidationError('No staged packages with patch.json were found under research/people/.');
    }
  } else {
    if (explicitIds.length === 0) {
      throw new CliValidationError('Integrate requires at least one person_id or `--all-staged`.');
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
          writeIntegrationReceipt(packageDir, buildIntegrationReceiptForPackage(packageDir, personId));
        }
      }
    }
  }

  const preFlightOverlaps = analyzeStagedOverlaps(repoDir, targetIds);
  if (preFlightOverlaps.hasBlockingConflicts) {
    throw new CliValidationError(formatBlockingOverlapError(preFlightOverlaps));
  }

  const { results, wouldWriteSet, writtenSet } = await executeBatchTargets(repoDir, targetIds, dryRun);

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
