import type { AuditCommandResult } from '../audit/types.js';
import type { AuditBatchSummary, AuditOverlaps } from '../shared/stagedOverlaps/types.js';

export * from '../shared/stagedOverlaps/types.js';

export type AuditBatchPerson = Omit<AuditCommandResult, 'rendered'>;

export interface AuditBatchResult {
  ok: boolean;
  strictOk: boolean;
  repo: string;
  people: AuditBatchPerson[];
  overlaps: AuditOverlaps;
  summary: AuditBatchSummary;
  skippedAlreadyIntegrated?: string[];
  skippedDrifted?: string[];
  duration_ms: number;
  rendered: string;
}
