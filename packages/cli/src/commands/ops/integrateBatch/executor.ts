import fs from 'node:fs';
import { CliValidationError } from '../../../errors.js';
import { executeIntegrateSingle } from '../shared/integrateEngine/execute.js';
import type { IntegrateExecutionOverlay } from '../shared/integrateEngine/types.js';
import { captureBatchSnapshot, createDryRunDataDirCopy, restoreBatchSnapshot } from './snapshot.js';
import type { IntegrateBatchItemResult } from './types.js';

export interface BatchExecutionOutput {
  results: IntegrateBatchItemResult[];
  wouldWriteSet: Set<string>;
  writtenSet: Set<string>;
}

export async function executeBatchTargets(
  repoDir: string,
  targetIds: readonly string[],
  dryRun: boolean
): Promise<BatchExecutionOutput> {
  const results: IntegrateBatchItemResult[] = [];
  const wouldWriteSet = new Set<string>();
  const writtenSet = new Set<string>();

  if (targetIds.length === 0) {
    return { results, wouldWriteSet, writtenSet };
  }

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
          if (personId === undefined) continue;
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
    return { results, wouldWriteSet, writtenSet };
  }

  const snapshot = captureBatchSnapshot(repoDir, targetIds);
  for (let i = 0; i < targetIds.length; i += 1) {
    const personId = targetIds[i];
    try {
      if (personId === undefined) continue;
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
        const rollbackDetail = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
        rollbackNote = `Rollback FAILED: ${rollbackDetail}.`;
      }
      const message = `Batch integrate failed on '${personId}' (package ${i + 1}/${targetIds.length}): ${detail}. ${rollbackNote}`;
      if (err instanceof CliValidationError) {
        throw new CliValidationError(message, err.issues);
      }
      throw new Error(message, { cause: err });
    }
  }

  return { results, wouldWriteSet, writtenSet };
}
