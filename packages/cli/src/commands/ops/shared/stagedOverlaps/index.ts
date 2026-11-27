import path from 'node:path';
import { loadLiveMedia } from '../mediaFiles.js';
import {
  computeAuditOverlaps,
  countBlockingOverlaps,
  createEmptyAuditOverlaps,
  hasAnyBlockingOverlaps,
  summarizeBatch,
} from './detectors.js';
import { listStagedAuditPersonIds, loadStagedPackage, loadStagedScanEntries } from './loader.js';
import type { StagedOverlapAnalysis } from './types.js';

export * from './detectors.js';
export * from './loader.js';
export * from './types.js';

export function analyzeStagedOverlaps(repoDir: string, personIds: readonly string[]): StagedOverlapAnalysis {
  const resolvedRepo = path.resolve(repoDir);
  if (personIds.length === 0) {
    const overlaps = createEmptyAuditOverlaps();
    const blocking = countBlockingOverlaps(overlaps);
    return { overlaps, blocking, hasBlockingConflicts: false };
  }
  const packages = personIds.map((personId) =>
    loadStagedPackage(personId, path.join(resolvedRepo, 'research', 'people', personId))
  );
  const scanEntries = loadStagedScanEntries(packages);
  const overlaps = computeAuditOverlaps({
    packages,
    scanEntries,
    liveMedia: loadLiveMedia(resolvedRepo),
  });
  const blocking = countBlockingOverlaps(overlaps);
  return {
    overlaps,
    blocking,
    hasBlockingConflicts: hasAnyBlockingOverlaps(blocking),
  };
}

export {
  computeAuditOverlaps,
  countBlockingOverlaps,
  createEmptyAuditOverlaps,
  hasAnyBlockingOverlaps,
  listStagedAuditPersonIds,
  loadStagedPackage,
  loadStagedScanEntries,
  summarizeBatch,
};
