import type { IntegrateCommandResult, UpsertCounts } from '../shared/integrateEngine/types.js';
import type { StagedOverlapAnalysis } from '../shared/stagedOverlaps/types.js';

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
  personIds?: readonly string[] | undefined;
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

export interface BatchSnapshot {
  yamlFiles: Map<string, Buffer | null>;
  mediaFiles: Map<string, Buffer | null>;
  receiptFiles: Map<string, Buffer | null>;
}

export interface RollbackStats {
  restoredYamlFiles: number;
  removedMediaFiles: number;
  restoredMediaFiles: number;
  restoredReceiptFiles: number;
}
