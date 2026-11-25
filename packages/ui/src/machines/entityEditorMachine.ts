import type {
  ArchiveDataSource,
  ConflictPayload,
  EditorCitationMode,
  EntityPayload,
  EntityType,
  OptimisticConflictError,
  RevisionId,
} from '@kinloom/core';
import {
  asRevisionId,
  hasPendingConflict,
  isEditSummaryValid,
  isMatchingSaveGeneration,
  rebaseEntityDraft,
  validateEntityDraft,
} from '@kinloom/core';
import { assign, fromPromise, setup } from 'xstate';

export interface PendingEntityTarget {
  entityType: EntityType;
  entityId: string;
  revisionId: number;
  snapshot: EntityPayload;
  hasPrimarySource?: boolean;
}

export interface EntityEditorConflict extends ConflictPayload {
  diff?: OptimisticConflictError['diff'];
  serverDeletedAt?: string | null;
}

export interface SaveEntityInput {
  entityType: EntityType;
  entityId: string;
  expectedParentRevisionId: number;
  draft: EntityPayload;
  summary: string;
  hasPrimarySource: boolean;
  sourceIds: readonly string[];
  reqGen: number;
  dataSource?: ArchiveDataSource;
}

export type SaveEntityResult =
  | {
      kind: 'ok';
      entityId: string;
      revisionId: number;
      snapshot: EntityPayload;
      etag: string;
      reqGen: number;
    }
  | {
      kind: 'conflict409';
      entityId: string;
      conflict: EntityEditorConflict;
      reqGen: number;
    };

export interface EntityEditorInput {
  entityType: EntityType;
  entityId: string;
  revisionId: number;
  snapshot: EntityPayload;
  hasPrimarySource?: boolean;
  dataSource?: ArchiveDataSource;
}

export interface EntityEditorContext {
  entityType: EntityType;
  entityId: string;
  baseRevisionId: number;
  baseSnapshot: EntityPayload;
  draft: EntityPayload;
  summary: string;
  citationMode: EditorCitationMode;
  sourceIds: readonly string[];
  dirty: boolean;
  saveGen: number;
  lastAppliedGen: number;
  lastSavedEntityId: string | null;
  lastEtag: string | null;
  conflict: EntityEditorConflict | null;
  validationErrors: readonly string[];
  networkError: string | null;
  pendingEntityChange: PendingEntityTarget | null;
  dataSource?: ArchiveDataSource;
}

export type EntityEditorEvent =
  | { type: 'START_EDIT' }
  | { type: 'EDIT_FIELD'; draft: EntityPayload }
  | { type: 'SET_SUMMARY'; summary: string }
  | { type: 'SET_CITATION'; mode: EditorCitationMode; sourceIds: readonly string[] }
  | { type: 'SUBMIT' }
  | { type: 'CANCEL_EDIT' }
  | { type: 'CANCEL_SAVE' }
  | { type: 'DISCARD_DRAFT' }
  | {
      type: 'ENTITY_CHANGED';
      entityType: EntityType;
      entityId: string;
      revisionId: number;
      snapshot: EntityPayload;
      hasPrimarySource?: boolean;
    }
  | { type: 'CONFIRM_LEAVE' }
  | { type: 'STAY_EDITING' }
  | { type: 'ACCEPT_SERVER' }
  | { type: 'REBASE_AND_RETRY' }
  | { type: 'REBASE_TO_EDIT' }
  | { type: 'RETRY_SAVE' }
  | { type: 'RETURN_TO_EDIT' }
  | { type: 'DISMISS_SAVED' };

function mapConflictPayload(conflict: OptimisticConflictError): EntityEditorConflict {
  return {
    latestRevisionId: conflict.server_revision_id,
    latestSnapshot: conflict.server_entity ?? {},
    lastAuthorName: conflict.last_author_name,
    lastUpdatedAt: conflict.last_updated_at,
    diff: conflict.diff,
    serverDeletedAt: conflict.server_deleted_at,
  };
}

function defaultCitationMode(hasPrimarySource?: boolean): EditorCitationMode {
  return hasPrimarySource ? 'cited' : 'familyMemory';
}

function readSaveEntityOutput(event: unknown): SaveEntityResult | null {
  if (typeof event !== 'object' || event === null || !('output' in event)) {
    return null;
  }
  const output = (event as { output: unknown }).output;
  if (typeof output !== 'object' || output === null || !('kind' in output)) {
    return null;
  }
  const kind = (output as { kind: unknown }).kind;
  if (kind === 'ok' || kind === 'conflict409') {
    return output as SaveEntityResult;
  }
  return null;
}

export const defaultSaveEntityActor = fromPromise<SaveEntityResult, SaveEntityInput>(
  async ({ input, signal }) => {
    if (input.dataSource?.updateEntity) {
      const updateWithSignal = input.dataSource.updateEntity as (
        entityType: EntityType,
        entityId: string,
        body: {
          data: EntityPayload;
          expected_parent_revision_id?: RevisionId;
          summary: string;
          has_primary_source: boolean;
        },
        options?: { signal?: AbortSignal },
      ) => Promise<
        | { ok: true; entity: EntityPayload; revision: { revision_id: number }; etag: string }
        | { ok: false; conflict: OptimisticConflictError }
      >;

      const res = await updateWithSignal(
        input.entityType,
        input.entityId,
        {
          data: input.draft,
          expected_parent_revision_id: asRevisionId(input.expectedParentRevisionId),
          summary: input.summary.trim(),
          has_primary_source: input.hasPrimarySource,
        },
        { signal },
      );

      if (!res.ok) {
        return {
          kind: 'conflict409',
          entityId: input.entityId,
          conflict: mapConflictPayload(res.conflict),
          reqGen: input.reqGen,
        };
      }
      return {
        kind: 'ok',
        entityId: input.entityId,
        revisionId: res.revision.revision_id,
        snapshot: res.entity,
        etag: res.etag,
        reqGen: input.reqGen,
      };
    }

    const response = await fetch(
      `/api/entities/${encodeURIComponent(input.entityType)}/${encodeURIComponent(input.entityId)}`,
      {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          expected_parent_revision_id: input.expectedParentRevisionId,
          data: input.draft,
          summary: input.summary.trim(),
          has_primary_source: input.hasPrimarySource,
        }),
        signal,
      },
    );

    if (response.status === 409) {
      const envelope = (await response.json()) as {
        error?: { details?: OptimisticConflictError };
      };
      const details = envelope.error?.details;
      if (!details) {
        throw new Error('HTTP 409 response missing conflict details');
      }
      return {
        kind: 'conflict409',
        entityId: input.entityId,
        conflict: mapConflictPayload(details),
        reqGen: input.reqGen,
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} saving ${input.entityType}/${input.entityId}`);
    }

    const ok = (await response.json()) as {
      entity: EntityPayload;
      revision: { revision_id: number };
      etag: string;
    };
    return {
      kind: 'ok',
      entityId: input.entityId,
      revisionId: ok.revision.revision_id,
      snapshot: ok.entity,
      etag: ok.etag,
      reqGen: input.reqGen,
    };
  },
);

export const entityEditorMachine = setup({
  types: {
    context: {} as EntityEditorContext,
    events: {} as EntityEditorEvent,
    input: {} as EntityEditorInput,
  },
  actors: {
    saveEntity: defaultSaveEntityActor,
  },
  guards: {
    canSubmit: ({ context }) =>
      context.dirty &&
      isEditSummaryValid(context.summary) &&
      validateEntityDraft(context.entityType, context.draft).ok,
    hasPendingConflict: ({ context }) => hasPendingConflict(context.conflict),
    isOkResult: ({ context, event }) => {
      const output = readSaveEntityOutput(event);
      return (
        output !== null &&
        output.kind === 'ok' &&
        isMatchingSaveGeneration({
          activeEntityId: context.entityId,
          activeSaveGen: context.saveGen,
          responseEntityId: output.entityId,
          responseSaveGen: output.reqGen,
        })
      );
    },
    isConflict409Result: ({ context, event }) => {
      const output = readSaveEntityOutput(event);
      return (
        output !== null &&
        output.kind === 'conflict409' &&
        isMatchingSaveGeneration({
          activeEntityId: context.entityId,
          activeSaveGen: context.saveGen,
          responseEntityId: output.entityId,
          responseSaveGen: output.reqGen,
        })
      );
    },
  },
  actions: {
    resetDraftToBase: assign(({ context }) => ({
      draft: structuredClone(context.baseSnapshot),
      summary: '',
      dirty: false,
      conflict: null,
      validationErrors: [],
      networkError: null,
      pendingEntityChange: null,
    })),
    applyEntityTarget: assign(({ event }) => {
      if (event.type !== 'ENTITY_CHANGED') {
        return {};
      }
      return {
        entityType: event.entityType,
        entityId: event.entityId,
        baseRevisionId: event.revisionId,
        baseSnapshot: structuredClone(event.snapshot),
        draft: structuredClone(event.snapshot),
        summary: '',
        citationMode: defaultCitationMode(event.hasPrimarySource),
        sourceIds: [],
        dirty: false,
        conflict: null,
        validationErrors: [],
        networkError: null,
        pendingEntityChange: null,
      };
    }),
    stashPendingEntityChange: assign(({ event }) => {
      if (event.type !== 'ENTITY_CHANGED') {
        return {};
      }
      return {
        pendingEntityChange: {
          entityType: event.entityType,
          entityId: event.entityId,
          revisionId: event.revisionId,
          snapshot: structuredClone(event.snapshot),
          hasPrimarySource: event.hasPrimarySource,
        },
      };
    }),
    applyPendingLeave: assign(({ context }) => {
      const target = context.pendingEntityChange;
      if (!target) {
        return {
          draft: structuredClone(context.baseSnapshot),
          summary: '',
          dirty: false,
          conflict: null,
          validationErrors: [],
          networkError: null,
          pendingEntityChange: null,
        };
      }
      return {
        entityType: target.entityType,
        entityId: target.entityId,
        baseRevisionId: target.revisionId,
        baseSnapshot: structuredClone(target.snapshot),
        draft: structuredClone(target.snapshot),
        summary: '',
        citationMode: defaultCitationMode(target.hasPrimarySource),
        sourceIds: [],
        dirty: false,
        conflict: null,
        validationErrors: [],
        networkError: null,
        pendingEntityChange: null,
      };
    }),
    clearPendingEntityChange: assign(() => ({ pendingEntityChange: null })),
    recordValidationErrors: assign(({ context }) => {
      const errors: string[] = [];
      if (!context.dirty) {
        errors.push('Make at least one change before saving.');
      }
      if (!isEditSummaryValid(context.summary)) {
        errors.push('Edit summary must be at least 3 characters.');
      }
      const check = validateEntityDraft(context.entityType, context.draft);
      if (!check.ok) {
        errors.push(...check.errors);
      }
      return { validationErrors: errors };
    }),
    incrementSaveGen: assign(({ context }) => ({
      saveGen: context.saveGen + 1,
      validationErrors: [],
      networkError: null,
    })),
    rebaseOntoServer: assign(({ context }) => {
      if (!context.conflict) {
        return {};
      }
      return {
        baseRevisionId: context.conflict.latestRevisionId,
        baseSnapshot: structuredClone(context.conflict.latestSnapshot),
        draft: rebaseEntityDraft(
          context.baseSnapshot,
          context.conflict.latestSnapshot,
          context.draft,
        ),
        conflict: null,
        dirty: true,
      };
    }),
  },
}).createMachine({
  id: 'entityEditor',
  initial: 'viewing',
  context: ({ input }) => ({
    entityType: input.entityType,
    entityId: input.entityId,
    baseRevisionId: input.revisionId,
    baseSnapshot: structuredClone(input.snapshot),
    draft: structuredClone(input.snapshot),
    summary: '',
    citationMode: defaultCitationMode(input.hasPrimarySource),
    sourceIds: [],
    dirty: false,
    saveGen: 0,
    lastAppliedGen: 0,
    lastSavedEntityId: null,
    lastEtag: null,
    conflict: null,
    validationErrors: [],
    networkError: null,
    pendingEntityChange: null,
    dataSource: input.dataSource,
  }),
  states: {
    viewing: {
      tags: ['readonly'],
      on: {
        START_EDIT: {
          target: 'editing',
          actions: [{ type: 'resetDraftToBase' }],
        },
        ENTITY_CHANGED: {
          actions: [{ type: 'applyEntityTarget' }],
        },
      },
    },
    editing: {
      initial: 'clean',
      tags: ['editing'],
      states: {
        clean: {
          on: {
            EDIT_FIELD: {
              target: 'dirty',
              actions: assign(({ event }) => ({ draft: event.draft, dirty: true })),
            },
            SET_SUMMARY: {
              actions: assign(({ event }) => ({ summary: event.summary })),
            },
            SET_CITATION: {
              actions: assign(({ event }) => ({
                citationMode: event.mode,
                sourceIds: event.sourceIds,
              })),
            },
            CANCEL_EDIT: { target: '#entityEditor.viewing' },
            ENTITY_CHANGED: {
              target: '#entityEditor.viewing',
              actions: [{ type: 'applyEntityTarget' }],
            },
          },
        },
        dirty: {
          tags: ['dirty'],
          on: {
            EDIT_FIELD: {
              actions: assign(({ event }) => ({ draft: event.draft, dirty: true })),
            },
            SET_SUMMARY: {
              actions: assign(({ event }) => ({ summary: event.summary })),
            },
            SET_CITATION: {
              actions: assign(({ event }) => ({
                citationMode: event.mode,
                sourceIds: event.sourceIds,
              })),
            },
            SUBMIT: { target: '#entityEditor.validating' },
            DISCARD_DRAFT: {
              target: '#entityEditor.viewing',
              actions: [{ type: 'resetDraftToBase' }],
            },
            ENTITY_CHANGED: {
              target: '#entityEditor.confirmingLeave',
              actions: [{ type: 'stashPendingEntityChange' }],
            },
          },
        },
      },
    },
    confirmingLeave: {
      tags: ['dirty', 'confirming'],
      on: {
        CONFIRM_LEAVE: {
          target: 'viewing',
          actions: [{ type: 'applyPendingLeave' }],
        },
        STAY_EDITING: [
          {
            guard: 'hasPendingConflict',
            target: 'conflict409.resolvingConflict',
            actions: [{ type: 'clearPendingEntityChange' }],
          },
          {
            target: 'editing.dirty',
            actions: [{ type: 'clearPendingEntityChange' }],
          },
        ],
      },
    },
    validating: {
      always: [
        {
          guard: 'canSubmit',
          target: 'saving',
          actions: [{ type: 'incrementSaveGen' }],
        },
        {
          target: 'validationError',
          actions: [{ type: 'recordValidationErrors' }],
        },
      ],
    },
    validationError: {
      tags: ['dirty', 'error'],
      on: {
        EDIT_FIELD: {
          target: 'editing.dirty',
          actions: assign(({ event }) => ({
            draft: event.draft,
            dirty: true,
            validationErrors: [],
          })),
        },
        SET_SUMMARY: {
          target: 'editing.dirty',
          actions: assign(({ event }) => ({
            summary: event.summary,
            validationErrors: [],
          })),
        },
        SET_CITATION: {
          target: 'editing.dirty',
          actions: assign(({ event }) => ({
            citationMode: event.mode,
            sourceIds: event.sourceIds,
            validationErrors: [],
          })),
        },
        SUBMIT: { target: 'validating' },
        DISCARD_DRAFT: {
          target: 'viewing',
          actions: [{ type: 'resetDraftToBase' }],
        },
        ENTITY_CHANGED: {
          target: 'confirmingLeave',
          actions: [{ type: 'stashPendingEntityChange' }],
        },
      },
    },
    saving: {
      tags: ['busy', 'dirty'],
      invoke: {
        id: 'saveEntity',
        src: 'saveEntity',
        input: ({ context }) => ({
          entityType: context.entityType,
          entityId: context.entityId,
          expectedParentRevisionId: context.baseRevisionId,
          draft: context.draft,
          summary: context.summary,
          hasPrimarySource: context.citationMode === 'cited',
          sourceIds: context.sourceIds,
          reqGen: context.saveGen,
          dataSource: context.dataSource,
        }),
        onDone: [
          {
            guard: 'isOkResult',
            target: 'saved',
            actions: assign(({ event }) =>
              event.output.kind === 'ok'
                ? {
                    baseRevisionId: event.output.revisionId,
                    baseSnapshot: structuredClone(event.output.snapshot),
                    draft: structuredClone(event.output.snapshot),
                    dirty: false,
                    conflict: null,
                    lastAppliedGen: event.output.reqGen,
                    lastSavedEntityId: event.output.entityId,
                    lastEtag: event.output.etag,
                    networkError: null,
                  }
                : {},
            ),
          },
          {
            guard: 'isConflict409Result',
            target: 'conflict409',
            actions: assign(({ event }) =>
              event.output.kind === 'conflict409'
                ? {
                    conflict: event.output.conflict,
                    dirty: true,
                    networkError: null,
                  }
                : {},
            ),
          },
          // Stale or mismatched saveGen response is safely ignored while returning editor to dirty draft.
          {
            target: 'editing.dirty',
          },
        ],
        onError: {
          target: 'networkErrorRetryable',
          actions: assign(({ event }) => ({
            networkError:
              event.error instanceof Error ? event.error.message : String(event.error),
          })),
        },
      },
      on: {
        CANCEL_SAVE: { target: 'editing.dirty' },
        ENTITY_CHANGED: {
          target: 'viewing',
          actions: [{ type: 'applyEntityTarget' }],
        },
      },
    },
    saved: {
      tags: ['saved'],
      on: {
        DISMISS_SAVED: { target: 'viewing' },
        START_EDIT: {
          target: 'editing',
          actions: [{ type: 'resetDraftToBase' }],
        },
        ENTITY_CHANGED: {
          target: 'viewing',
          actions: [{ type: 'applyEntityTarget' }],
        },
      },
    },
    conflict409: {
      initial: 'resolvingConflict',
      tags: ['dirty', 'conflict'],
      states: {
        resolvingConflict: {
          on: {
            ACCEPT_SERVER: {
              target: '#entityEditor.viewing',
              actions: assign(({ context }) =>
                context.conflict
                  ? {
                      baseRevisionId: context.conflict.latestRevisionId,
                      baseSnapshot: structuredClone(context.conflict.latestSnapshot),
                      draft: structuredClone(context.conflict.latestSnapshot),
                      summary: '',
                      dirty: false,
                      conflict: null,
                      validationErrors: [],
                      networkError: null,
                    }
                  : {},
              ),
            },
            REBASE_AND_RETRY: {
              target: '#entityEditor.validating',
              actions: [{ type: 'rebaseOntoServer' }],
            },
            REBASE_TO_EDIT: {
              target: '#entityEditor.editing.dirty',
              actions: [{ type: 'rebaseOntoServer' }],
            },
            DISCARD_DRAFT: {
              target: '#entityEditor.viewing',
              actions: [{ type: 'resetDraftToBase' }],
            },
            ENTITY_CHANGED: {
              target: '#entityEditor.confirmingLeave',
              actions: [{ type: 'stashPendingEntityChange' }],
            },
          },
        },
      },
    },
    networkErrorRetryable: {
      tags: ['dirty', 'error'],
      on: {
        RETRY_SAVE: { target: 'validating' },
        RETURN_TO_EDIT: { target: 'editing.dirty' },
        DISCARD_DRAFT: {
          target: 'viewing',
          actions: [{ type: 'resetDraftToBase' }],
        },
        ENTITY_CHANGED: {
          target: 'confirmingLeave',
          actions: [{ type: 'stashPendingEntityChange' }],
        },
      },
    },
  },
});

export const wikiEditorMachine = entityEditorMachine;
