import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CliValidationError } from '../../errors.js';
import type { KinloomCliPlugin } from '../../plugins.js';
import { type LoadedLocalArchiveRepo, loadLocalArchiveRepo } from '../dataFiles.js';
import { runAuditCommand } from './audit.js';
import { formatAuditBatchTextReport } from './auditOverlaps/report.js';
import type { AuditBatchPerson, AuditBatchResult } from './auditOverlaps/types.js';
import {
  collectLiveMediaCollisions,
  type LiveMediaFileCollision,
  loadLiveMedia,
  normalizeMediaFilePath,
  readStagedMediaRefs,
  type StagedMediaRef,
} from './shared/mediaFiles.js';
import {
  analyzeStagedOverlaps,
  countBlockingOverlaps,
  createEmptyAuditOverlaps,
  listStagedAuditPersonIds,
  SAFE_PERSON_ID_RE,
  summarizeBatch,
} from './shared/stagedOverlaps/index.js';

export type {
  AuditBatchPerson,
  AuditBatchResult,
  AuditBatchSummary,
  AuditOverlaps,
  EventDiffField,
  KinshipAddRemoveConflict,
  MediaFileCollision,
  MediaFileCollisionEntry,
  OverlapBlockingCounts,
  PersonDiffField,
  PersonSlugCollision,
  PersonSlugCollisionEntry,
  ScanCollisionPackage,
  ScanFileCollision,
  SharedEventOverlap,
  SharedEventPackage,
  SharedMediaId,
  SharedPersonOverlap,
  SharedPersonPackage,
  SharedSourceId,
  StagedOverlapAnalysis,
} from './auditOverlaps/types.js';
export {
  analyzeStagedOverlaps,
  collectLiveMediaCollisions,
  countBlockingOverlaps,
  createEmptyAuditOverlaps,
  formatAuditBatchTextReport,
  type LiveMediaFileCollision,
  listStagedAuditPersonIds,
  loadLiveMedia,
  normalizeMediaFilePath,
  readStagedMediaRefs,
  type StagedMediaRef,
};

async function tryPreloadBatchArchive(repoDir: string): Promise<LoadedLocalArchiveRepo | undefined> {
  try {
    return await loadLocalArchiveRepo(repoDir, {
      requireConfig: false,
      requirePeopleFile: true,
      includeEnrichments: true,
    });
  } catch {
    return undefined;
  }
}

export async function runAuditBatchCommand(options: {
  repoDir?: string;
  personIds: readonly string[];
  json?: boolean;
  pendingOnly?: boolean;
  skippedAlreadyIntegrated?: readonly string[] | undefined;
  skippedDrifted?: readonly string[] | undefined;
  plugins?: readonly KinloomCliPlugin[];
}): Promise<AuditBatchResult> {
  const started = performance.now();
  const repoDir = path.resolve(options.repoDir?.trim() || process.cwd());
  const personIds = options.personIds
    .map((personId) => personId.trim())
    .filter((personId) => personId.length > 0);
  const includeSkipped = Boolean(options.pendingOnly) || options.skippedAlreadyIntegrated !== undefined;
  const skippedAlreadyIntegrated = includeSkipped ? [...(options.skippedAlreadyIntegrated ?? [])] : undefined;
  const skippedDrifted =
    options.pendingOnly || options.skippedDrifted !== undefined
      ? [...(options.skippedDrifted ?? [])]
      : undefined;

  if (personIds.length === 0 && !options.pendingOnly) {
    throw new CliValidationError('Batch audit requires at least one staged person id.');
  }
  const seen = new Set<string>();
  for (const personId of personIds) {
    if (!SAFE_PERSON_ID_RE.test(personId)) {
      throw new CliValidationError(`Invalid person_id '${personId}'.`);
    }
    if (seen.has(personId)) {
      throw new CliValidationError(`Duplicate person_id '${personId}'.`);
    }
    seen.add(personId);
  }

  const preloadedRepo = personIds.length > 1 ? await tryPreloadBatchArchive(repoDir) : undefined;
  const people: AuditBatchPerson[] = [];
  for (const personId of personIds) {
    const result = await runAuditCommand({
      repoDir,
      personId,
      json: false,
      preloadedRepo,
      ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
    });
    const { rendered: _rendered, ...person } = result;
    people.push(person);
  }

  const analysis = analyzeStagedOverlaps(repoDir, personIds);
  const overlaps = analysis.overlaps;
  const summary = summarizeBatch(people, overlaps);
  const report: Omit<AuditBatchResult, 'rendered'> = {
    ok: people.every((person) => person.ok),
    strictOk: people.every((person) => person.strictOk) && !analysis.hasBlockingConflicts,
    repo: repoDir,
    people,
    overlaps,
    summary,
    ...(skippedAlreadyIntegrated !== undefined ? { skippedAlreadyIntegrated } : {}),
    ...(skippedDrifted !== undefined ? { skippedDrifted } : {}),
    duration_ms: Math.round(performance.now() - started),
  };
  const rendered = options.json ? `${JSON.stringify(report, null, 2)}\n` : formatAuditBatchTextReport(report);
  return { ...report, rendered };
}
