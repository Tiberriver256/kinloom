import type { EntityPatch, EntityPayload, EntityType, RevisionRecord } from './schemas/revisions.js';

export type FieldDiffKind = 'added' | 'removed' | 'changed';

export interface FieldDiff {
  path: string;
  kind: FieldDiffKind;
  before: unknown;
  after: unknown;
}

export interface EntityDiffSummary {
  fields: FieldDiff[];
  addedCount: number;
  removedCount: number;
  changedCount: number;
  hasChanges: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  if (isPlainRecord(a) && isPlainRecord(b)) {
    const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
    const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
    if (keysA.length !== keysB.length) {
      return false;
    }
    for (const k of keysA) {
      if (!Object.hasOwn(b, k)) {
        return false;
      }
      if (!deepEqual(a[k], b[k])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function diffRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: FieldDiff[]
): void {
  const keys = [
    ...new Set([
      ...Object.keys(before).filter((k) => before[k] !== undefined),
      ...Object.keys(after).filter((k) => after[k] !== undefined),
    ]),
  ].toSorted();

  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const hasBefore = Object.hasOwn(before, key) && before[key] !== undefined;
    const hasAfter = Object.hasOwn(after, key) && after[key] !== undefined;
    const bVal = before[key];
    const aVal = after[key];

    if (!hasBefore && hasAfter) {
      out.push({ path, kind: 'added', before: undefined, after: structuredClone(aVal) });
      continue;
    }
    if (hasBefore && !hasAfter) {
      out.push({ path, kind: 'removed', before: structuredClone(bVal), after: undefined });
      continue;
    }
    if (deepEqual(bVal, aVal)) {
      continue;
    }
    if (isPlainRecord(bVal) && isPlainRecord(aVal)) {
      diffRecords(bVal, aVal, path, out);
      continue;
    }
    out.push({
      path,
      kind: 'changed',
      before: structuredClone(bVal),
      after: structuredClone(aVal),
    });
  }
}

/**
 * Compute deterministic field-level diff between two entity snapshots (either side may be null for create/delete).
 */
export function computeEntityDiff(
  before: EntityPayload | null,
  after: EntityPayload | null
): EntityDiffSummary {
  const fields: FieldDiff[] = [];
  if (before === null && after === null) {
    return { fields, addedCount: 0, removedCount: 0, changedCount: 0, hasChanges: false };
  }
  diffRecords(before ?? {}, after ?? {}, '', fields);

  let addedCount = 0;
  let removedCount = 0;
  let changedCount = 0;
  for (const f of fields) {
    if (f.kind === 'added') {
      addedCount += 1;
    } else if (f.kind === 'removed') {
      removedCount += 1;
    } else {
      changedCount += 1;
    }
  }

  return {
    fields,
    addedCount,
    removedCount,
    changedCount,
    hasChanges: fields.length > 0,
  };
}

export interface EntityPatchApplyResult {
  action: EntityPatch['action'];
  before: EntityPayload | null;
  after: EntityPayload | null;
  diff: EntityDiffSummary;
}

/**
 * Pure state-transition function applying a typed EntityPatch onto the current entity snapshot.
 * Throws explicit domain errors on illegal transitions (e.g. creating an active or soft-deleted entity, or updating a deleted one).
 */
export function applyEntityPatch(
  current: { data: EntityPayload; deletedAt: string | null; revisionId?: number } | null,
  patch: EntityPatch
): EntityPatchApplyResult {
  switch (patch.action) {
    case 'create': {
      if (current !== null) {
        if (current.deletedAt !== null) {
          throw new Error(
            `Cannot create ${patch.entity_type}/${patch.entity_id}: entity is soft-deleted; use restore or revert with expected_parent_revision_id`
          );
        }
        throw new Error(`Cannot create ${patch.entity_type}/${patch.entity_id}: entity already exists`);
      }
      const next = structuredClone(patch.data);
      return {
        action: 'create',
        before: null,
        after: next,
        diff: computeEntityDiff(null, next),
      };
    }
    case 'update': {
      if (current === null || current.deletedAt !== null) {
        throw new Error(
          `Cannot update ${patch.entity_type}/${patch.entity_id}: entity does not exist or is deleted`
        );
      }
      if (
        current.revisionId !== undefined &&
        patch.parent_revision_id !== undefined &&
        patch.parent_revision_id !== current.revisionId
      ) {
        throw new Error(
          `Optimistic concurrency conflict on ${patch.entity_type}/${patch.entity_id}: expected parent revision ${patch.parent_revision_id}, current is ${current.revisionId}`
        );
      }
      const before = structuredClone(current.data);
      const next = patch.merge ? { ...before, ...structuredClone(patch.data) } : structuredClone(patch.data);
      return {
        action: 'update',
        before,
        after: next,
        diff: computeEntityDiff(before, next),
      };
    }
    case 'delete': {
      if (current === null || current.deletedAt !== null) {
        throw new Error(
          `Cannot delete ${patch.entity_type}/${patch.entity_id}: entity does not exist or is already deleted`
        );
      }
      if (
        current.revisionId !== undefined &&
        patch.parent_revision_id !== undefined &&
        patch.parent_revision_id !== current.revisionId
      ) {
        throw new Error(
          `Optimistic concurrency conflict on ${patch.entity_type}/${patch.entity_id}: expected parent revision ${patch.parent_revision_id}, current is ${current.revisionId}`
        );
      }
      const before = structuredClone(current.data);
      return {
        action: 'delete',
        before,
        after: null,
        diff: computeEntityDiff(before, null),
      };
    }
    case 'restore': {
      if (current === null || current.deletedAt === null) {
        throw new Error(`Cannot restore ${patch.entity_type}/${patch.entity_id}: entity is not soft-deleted`);
      }
      if (
        current.revisionId !== undefined &&
        patch.parent_revision_id !== undefined &&
        patch.parent_revision_id !== current.revisionId
      ) {
        throw new Error(
          `Optimistic concurrency conflict on ${patch.entity_type}/${patch.entity_id}: expected parent revision ${patch.parent_revision_id}, current is ${current.revisionId}`
        );
      }
      const restored = patch.data
        ? { ...structuredClone(current.data), ...structuredClone(patch.data) }
        : structuredClone(current.data);
      return {
        action: 'restore',
        before: null,
        after: restored,
        diff: computeEntityDiff(null, restored),
      };
    }
    default: {
      const _exhaustive: never = patch;
      return _exhaustive;
    }
  }
}

export interface RevertPayload {
  entity_type: EntityType;
  entity_id: string;
  action: 'revert';
  reverted_revision_id: number;
  before_json: EntityPayload | null;
  after_json: EntityPayload | null;
  soft_delete: boolean;
  restore_deleted: boolean;
  diff: EntityDiffSummary;
  summary: string;
}

/**
 * Build a Wikipedia-style non-destructive revert payload that restores `targetRevision.before_json`.
 * Never deletes history; creates a new revision R+1 pointing to `reverted_revision_id = R`.
 */
export function buildRevertPayload(
  current: EntityPayload | null,
  targetRevision: RevisionRecord,
  options?: { summary?: string }
): RevertPayload {
  const before = current ? structuredClone(current) : null;
  const after = targetRevision.before_json ? structuredClone(targetRevision.before_json) : null;
  const diff = computeEntityDiff(before, after);

  const summary =
    options?.summary?.trim() || `Revert revision r${targetRevision.revision_id} (${targetRevision.summary})`;

  return {
    entity_type: targetRevision.entity_type,
    entity_id: targetRevision.entity_id,
    action: 'revert',
    reverted_revision_id: targetRevision.revision_id,
    before_json: before,
    after_json: after,
    soft_delete: before !== null && after === null,
    restore_deleted: before === null && after !== null,
    diff,
    summary,
  };
}

/**
 * Build ordered revert payloads for an entire AI agent or bulk edit batch.
 * Processes revisions in reverse revision_id order so multi-step edits on the same entity unwind cleanly.
 */
export function buildBatchRevertPayloads(
  currentEntitiesByKey: ReadonlyMap<string, EntityPayload | null>,
  batchRevisions: readonly RevisionRecord[],
  options?: { summaryPrefix?: string }
): RevertPayload[] {
  const ordered = [...batchRevisions].toSorted((a, b) => b.revision_id - a.revision_id);
  const workingState = new Map<string, EntityPayload | null>(currentEntitiesByKey);
  const payloads: RevertPayload[] = [];

  for (const rev of ordered) {
    const key = `${rev.entity_type}:${rev.entity_id}`;
    const current = workingState.get(key) ?? null;
    const summary = options?.summaryPrefix
      ? `${options.summaryPrefix}: revert r${rev.revision_id}`
      : undefined;
    const payload = buildRevertPayload(current, rev, { summary });
    payloads.push(payload);
    workingState.set(key, payload.after_json ? structuredClone(payload.after_json) : null);
  }

  return payloads;
}
