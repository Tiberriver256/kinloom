import { buildRevertPayload, computeEntityDiff, type EntityDiffSummary } from '../revisions.js';
import type { EntityPayload, EntityType, RevisionAction, RevisionRecord } from '../schemas/revisions.js';

export type EntityLifecycleState =
  | { kind: 'nonExistent' }
  | { kind: 'active'; currentRevisionId: number; data: EntityPayload }
  | { kind: 'softDeleted'; currentRevisionId: number; lastData: EntityPayload; deletedAt: string };

export type EntityLifecycleCommand =
  | { type: 'create'; entityType: EntityType; entityId: string; data: EntityPayload; summary: string }
  | { type: 'update'; expectedParentRevisionId: number; data: EntityPayload; summary: string }
  | { type: 'delete'; expectedParentRevisionId: number; summary: string; nowIso: string }
  | { type: 'restore'; expectedParentRevisionId: number; data?: EntityPayload; summary: string }
  | { type: 'revert'; targetRevision: RevisionRecord; summary?: string; nowIso: string };

export interface LifecycleRevisionInsert {
  action: RevisionAction;
  parentRevisionId: number | null;
  revertedRevisionId: number | null;
  beforeJson: EntityPayload | null;
  afterJson: EntityPayload | null;
  summary: string;
  diff: EntityDiffSummary;
}

export type EntityLifecycleOutcome =
  | {
      ok: true;
      nextState: Exclude<EntityLifecycleState, { kind: 'nonExistent' }>;
      revisionInsert: LifecycleRevisionInsert;
    }
  | { ok: false; status: 404 | 409; code: string; currentRevisionId: number | null };

/**
 * Pure synchronous transition table for canonical D1 entity revision lifecycle.
 * Enforces append-only revision numbers, optimistic concurrency parent checks, and soft-delete create protection.
 */
export function transitionEntityLifecycle(
  state: EntityLifecycleState,
  command: EntityLifecycleCommand,
  nextRevisionId: number
): EntityLifecycleOutcome {
  if (state.kind === 'nonExistent') {
    if (command.type !== 'create') {
      return { ok: false, status: 404, code: 'ENTITY_NOT_FOUND', currentRevisionId: null };
    }
    const nextData = structuredClone(command.data);
    return {
      ok: true,
      nextState: { kind: 'active', currentRevisionId: nextRevisionId, data: nextData },
      revisionInsert: {
        action: 'create',
        parentRevisionId: null,
        revertedRevisionId: null,
        beforeJson: null,
        afterJson: nextData,
        summary: command.summary,
        diff: computeEntityDiff(null, nextData),
      },
    };
  }

  if (command.type === 'create') {
    return {
      ok: false,
      status: 409,
      code:
        state.kind === 'softDeleted'
          ? 'ENTITY_SOFT_DELETED_USE_RESTORE'
          : 'ENTITY_ALREADY_EXISTS',
      currentRevisionId: state.currentRevisionId,
    };
  }

  if (command.type === 'revert') {
    const currentPayload = state.kind === 'active' ? state.data : null;
    const revert = buildRevertPayload(currentPayload, command.targetRevision, {
      summary: command.summary,
    });
    if (currentPayload === null && revert.after_json === null) {
      return {
        ok: false,
        status: 409,
        code: 'NO_OP_REVERT',
        currentRevisionId: state.currentRevisionId,
      };
    }
    const nextState: Exclude<EntityLifecycleState, { kind: 'nonExistent' }> =
      revert.after_json === null
        ? {
            kind: 'softDeleted',
            currentRevisionId: nextRevisionId,
            lastData: state.kind === 'active' ? structuredClone(state.data) : structuredClone(state.lastData),
            deletedAt: command.nowIso,
          }
        : { kind: 'active', currentRevisionId: nextRevisionId, data: revert.after_json };
    return {
      ok: true,
      nextState,
      revisionInsert: {
        action: 'revert',
        parentRevisionId: state.currentRevisionId,
        revertedRevisionId: revert.reverted_revision_id,
        beforeJson: revert.before_json,
        afterJson: revert.after_json,
        summary: revert.summary,
        diff: revert.diff,
      },
    };
  }

  if (command.expectedParentRevisionId !== state.currentRevisionId) {
    return {
      ok: false,
      status: 409,
      code: 'REVISION_CONFLICT',
      currentRevisionId: state.currentRevisionId,
    };
  }

  if (state.kind === 'active') {
    if (command.type === 'restore') {
      return {
        ok: false,
        status: 409,
        code: 'ENTITY_ALREADY_ACTIVE',
        currentRevisionId: state.currentRevisionId,
      };
    }
    if (command.type === 'delete') {
      return {
        ok: true,
        nextState: {
          kind: 'softDeleted',
          currentRevisionId: nextRevisionId,
          lastData: structuredClone(state.data),
          deletedAt: command.nowIso,
        },
        revisionInsert: {
          action: 'delete',
          parentRevisionId: state.currentRevisionId,
          revertedRevisionId: null,
          beforeJson: structuredClone(state.data),
          afterJson: null,
          summary: command.summary,
          diff: computeEntityDiff(state.data, null),
        },
      };
    }
    const nextData = structuredClone(command.data);
    return {
      ok: true,
      nextState: { kind: 'active', currentRevisionId: nextRevisionId, data: nextData },
      revisionInsert: {
        action: 'update',
        parentRevisionId: state.currentRevisionId,
        revertedRevisionId: null,
        beforeJson: structuredClone(state.data),
        afterJson: nextData,
        summary: command.summary,
        diff: computeEntityDiff(state.data, nextData),
      },
    };
  }

  // state.kind === 'softDeleted'
  if (command.type !== 'restore') {
    return {
      ok: false,
      status: 409,
      code: 'ENTITY_IS_SOFT_DELETED',
      currentRevisionId: state.currentRevisionId,
    };
  }
  const restoredData = command.data
    ? { ...structuredClone(state.lastData), ...structuredClone(command.data) }
    : structuredClone(state.lastData);
  return {
    ok: true,
    nextState: { kind: 'active', currentRevisionId: nextRevisionId, data: restoredData },
    revisionInsert: {
      action: 'restore',
      parentRevisionId: state.currentRevisionId,
      revertedRevisionId: null,
      beforeJson: null,
      afterJson: restoredData,
      summary: command.summary,
      diff: computeEntityDiff(null, restoredData),
    },
  };
}

export interface BatchRevertStep {
  entityKey: string;
  entityType: EntityType;
  entityId: string;
  assignedRevisionId: number;
  nextState: Exclude<EntityLifecycleState, { kind: 'nonExistent' }>;
  revisionInsert: LifecycleRevisionInsert;
}

export type BatchRevertLifecycleOutcome =
  | {
      ok: true;
      nextStatesByKey: Map<string, EntityLifecycleState>;
      steps: BatchRevertStep[];
    }
  | {
      ok: false;
      status: 404 | 409;
      code: string;
      failedRevisionId: number;
    };

/**
 * Unwind an entire revision batch strictly in descending `revision_id` order so multi-step edits
 * on the same entity (for example `create` followed by `update`) converge cleanly to `softDeleted`
 * without resurrecting deleted rows or mutating past ledger entries.
 */
export function transitionBatchRevertLifecycle(
  currentStatesByKey: ReadonlyMap<string, EntityLifecycleState>,
  batchRevisions: readonly RevisionRecord[],
  startNextRevisionId: number,
  options: { nowIso: string; summaryPrefix?: string }
): BatchRevertLifecycleOutcome {
  const ordered = [...batchRevisions].toSorted((a, b) => b.revision_id - a.revision_id);
  const workingStates = new Map<string, EntityLifecycleState>(currentStatesByKey);
  const steps: BatchRevertStep[] = [];
  let nextRevId = startNextRevisionId;

  for (const rev of ordered) {
    const entityKey = `${rev.entity_type}:${rev.entity_id}`;
    const currentState: EntityLifecycleState = workingStates.get(entityKey) ?? { kind: 'nonExistent' };
    const summary = options.summaryPrefix
      ? `${options.summaryPrefix}: revert r${rev.revision_id}`
      : undefined;

    const outcome = transitionEntityLifecycle(
      currentState,
      {
        type: 'revert',
        targetRevision: rev,
        summary,
        nowIso: options.nowIso,
      },
      nextRevId
    );

    if (!outcome.ok) {
      return {
        ok: false,
        status: outcome.status,
        code: outcome.code,
        failedRevisionId: rev.revision_id,
      };
    }

    workingStates.set(entityKey, outcome.nextState);
    steps.push({
      entityKey,
      entityType: rev.entity_type,
      entityId: rev.entity_id,
      assignedRevisionId: nextRevId,
      nextState: outcome.nextState,
      revisionInsert: outcome.revisionInsert,
    });
    nextRevId += 1;
  }

  return {
    ok: true,
    nextStatesByKey: workingStates,
    steps,
  };
}
