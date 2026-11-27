import {
  hasPendingConflict,
  isEditSummaryValid,
  isMatchingSaveGeneration,
  validateEntityDraft,
} from '@kinloom/core';
import { assign, setup } from 'xstate';
import {
  defaultCitationMode,
  defaultDeleteEntityActor,
  defaultLoadLatestEntityActor,
  defaultSaveEntityActor,
  readSaveEntityOutput,
} from './entityEditor/actors.js';
import {
  buildEntityTargetPatch,
  buildOpenEditPatch,
  buildPendingLeavePatch,
  buildRebasePatch,
  buildResetDraftPatch,
  collectValidationErrors,
  createInitialEntityEditorContext,
} from './entityEditor/reducers.js';
import type {
  DeleteEntityInput,
  EntityEditorConflict,
  EntityEditorContext,
  EntityEditorEvent,
  EntityEditorInput,
  LoadLatestEntityInput,
  LoadLatestEntityResult,
  PendingEntityTarget,
  SaveEntityInput,
  SaveEntityResult,
} from './entityEditor/types.js';

export type {
  DeleteEntityInput,
  EntityEditorConflict,
  EntityEditorContext,
  EntityEditorEvent,
  EntityEditorInput,
  LoadLatestEntityInput,
  LoadLatestEntityResult,
  PendingEntityTarget,
  SaveEntityInput,
  SaveEntityResult,
};
export { defaultDeleteEntityActor, defaultLoadLatestEntityActor, defaultSaveEntityActor };

export const entityEditorMachine = setup({
  types: {
    context: {} as EntityEditorContext,
    events: {} as EntityEditorEvent,
    input: {} as EntityEditorInput,
  },
  actors: {
    loadLatestEntity: defaultLoadLatestEntityActor,
    saveEntity: defaultSaveEntityActor,
    deleteEntity: defaultDeleteEntityActor,
  },
  guards: {
    canSyncLatest: ({ context }) => Boolean(context.dataSource?.getEntity),
    canSubmit: ({ context }) =>
      context.dirty &&
      isEditSummaryValid(context.summary) &&
      validateEntityDraft(context.entityType, context.draft).ok,
    canConfirmDelete: ({ context }) =>
      Boolean(context.dataSource?.deleteEntity) && isEditSummaryValid(context.deleteSummary),
    isDirty: ({ context }) => context.dirty,
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
    resetDraftToBase: assign(({ context }) => buildResetDraftPatch(context)),
    applyOpenEditTarget: assign(({ context, event }) => buildOpenEditPatch(context, event)),
    applyEntityTarget: assign(({ event }) => buildEntityTargetPatch(event)),
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
    applyPendingLeave: assign(({ context }) => buildPendingLeavePatch(context)),
    clearPendingEntityChange: assign(() => ({ pendingEntityChange: null })),
    clearDeleteState: assign(() => ({ deleteSummary: '', deleteError: null })),
    recordValidationErrors: assign(({ context }) => ({
      validationErrors: collectValidationErrors(context),
    })),
    incrementSaveGen: assign(({ context }) => ({
      saveGen: context.saveGen + 1,
      validationErrors: [],
      networkError: null,
    })),
    rebaseOntoServer: assign(({ context }) => buildRebasePatch(context)),
  },
}).createMachine({
  id: 'entityEditor',
  initial: 'viewing',
  context: ({ input }) => createInitialEntityEditorContext(input),
  states: {
    viewing: {
      tags: ['readonly'],
      on: {
        OPEN_EDIT: [
          { guard: 'canSyncLatest', target: 'syncingRevision', actions: [{ type: 'applyOpenEditTarget' }] },
          { target: 'editing', actions: [{ type: 'applyOpenEditTarget' }] },
        ],
        START_EDIT: { target: 'editing', actions: [{ type: 'resetDraftToBase' }] },
        ENTITY_CHANGED: { actions: [{ type: 'applyEntityTarget' }] },
      },
    },
    syncingRevision: {
      tags: ['busy', 'syncing'],
      invoke: {
        id: 'loadLatestEntity',
        src: 'loadLatestEntity',
        input: ({ context }) => ({
          entityType: context.entityType,
          entityId: context.entityId,
          dataSource: context.dataSource,
        }),
        onDone: {
          target: 'editing.clean',
          actions: assign(({ event }) => {
            if (!event.output) {
              return {};
            }
            return {
              baseRevisionId: event.output.revisionId,
              baseSnapshot: structuredClone(event.output.snapshot),
              draft: structuredClone(event.output.snapshot),
              citationMode: defaultCitationMode(event.output.hasPrimarySource),
              dirty: false,
              conflict: null,
              validationErrors: [],
              networkError: null,
            };
          }),
        },
        onError: { target: 'editing.clean' },
      },
      on: {
        CANCEL_EDIT: { target: 'viewing' },
        ENTITY_CHANGED: { target: 'viewing', actions: [{ type: 'applyEntityTarget' }] },
      },
    },
    editing: {
      initial: 'clean',
      tags: ['editing'],
      on: {
        REQUEST_DELETE: { target: 'confirmingDelete', actions: [{ type: 'clearDeleteState' }] },
      },
      states: {
        clean: {
          on: {
            OPEN_EDIT: [
              {
                guard: 'canSyncLatest',
                target: '#entityEditor.syncingRevision',
                actions: [{ type: 'applyOpenEditTarget' }],
              },
              { actions: [{ type: 'applyOpenEditTarget' }] },
            ],
            EDIT_FIELD: {
              target: 'dirty',
              actions: assign(({ event }) => ({ draft: event.draft, dirty: true })),
            },
            SET_SUMMARY: { actions: assign(({ event }) => ({ summary: event.summary })) },
            SET_CITATION: {
              actions: assign(({ event }) => ({
                citationMode: event.mode,
                sourceIds: event.sourceIds,
              })),
            },
            CANCEL_EDIT: { target: '#entityEditor.viewing' },
            ENTITY_CHANGED: { target: '#entityEditor.viewing', actions: [{ type: 'applyEntityTarget' }] },
          },
        },
        dirty: {
          tags: ['dirty'],
          on: {
            EDIT_FIELD: { actions: assign(({ event }) => ({ draft: event.draft, dirty: true })) },
            SET_SUMMARY: { actions: assign(({ event }) => ({ summary: event.summary })) },
            SET_CITATION: {
              actions: assign(({ event }) => ({
                citationMode: event.mode,
                sourceIds: event.sourceIds,
              })),
            },
            SUBMIT: { target: '#entityEditor.validating' },
            DISCARD_DRAFT: { target: '#entityEditor.viewing', actions: [{ type: 'resetDraftToBase' }] },
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
        CONFIRM_LEAVE: { target: 'viewing', actions: [{ type: 'applyPendingLeave' }] },
        STAY_EDITING: [
          {
            guard: 'hasPendingConflict',
            target: 'conflict409.resolvingConflict',
            actions: [{ type: 'clearPendingEntityChange' }],
          },
          { target: 'editing.dirty', actions: [{ type: 'clearPendingEntityChange' }] },
        ],
      },
    },
    confirmingDelete: {
      tags: ['confirmingDelete'],
      on: {
        SET_DELETE_SUMMARY: {
          actions: assign(({ event }) => ({ deleteSummary: event.summary, deleteError: null })),
        },
        CONFIRM_DELETE: {
          guard: 'canConfirmDelete',
          target: 'deleting',
          actions: assign(() => ({ deleteError: null })),
        },
        CANCEL_DELETE: [
          { guard: 'isDirty', target: 'editing.dirty', actions: [{ type: 'clearDeleteState' }] },
          { target: 'editing.clean', actions: [{ type: 'clearDeleteState' }] },
        ],
        CANCEL_EDIT: { target: 'viewing', actions: [{ type: 'resetDraftToBase' }] },
        ENTITY_CHANGED: { target: 'viewing', actions: [{ type: 'applyEntityTarget' }] },
      },
    },
    deleting: {
      tags: ['busy', 'deleting'],
      invoke: {
        id: 'deleteEntity',
        src: 'deleteEntity',
        input: ({ context }) => ({
          entityType: context.entityType,
          entityId: context.entityId,
          expectedParentRevisionId: context.baseRevisionId,
          summary: context.deleteSummary,
          dataSource: context.dataSource,
        }),
        onDone: {
          target: 'deleted',
          actions: assign(() => ({ dirty: false, deleteSummary: '', deleteError: null })),
        },
        onError: {
          target: 'confirmingDelete',
          actions: assign(({ event }) => ({
            deleteError: event.error instanceof Error ? event.error.message : String(event.error),
          })),
        },
      },
    },
    deleted: {
      tags: ['deleted'],
      on: {
        DISMISS_DELETED: { target: 'viewing', actions: [{ type: 'resetDraftToBase' }] },
        ENTITY_CHANGED: { target: 'viewing', actions: [{ type: 'applyEntityTarget' }] },
      },
    },
    validating: {
      always: [
        { guard: 'canSubmit', target: 'saving', actions: [{ type: 'incrementSaveGen' }] },
        { target: 'validationError', actions: [{ type: 'recordValidationErrors' }] },
      ],
    },
    validationError: {
      tags: ['dirty', 'error'],
      on: {
        EDIT_FIELD: {
          target: 'editing.dirty',
          actions: assign(({ event }) => ({ draft: event.draft, dirty: true, validationErrors: [] })),
        },
        SET_SUMMARY: {
          target: 'editing.dirty',
          actions: assign(({ event }) => ({ summary: event.summary, validationErrors: [] })),
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
        REQUEST_DELETE: { target: 'confirmingDelete', actions: [{ type: 'clearDeleteState' }] },
        DISCARD_DRAFT: { target: 'viewing', actions: [{ type: 'resetDraftToBase' }] },
        ENTITY_CHANGED: { target: 'confirmingLeave', actions: [{ type: 'stashPendingEntityChange' }] },
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
                : {}
            ),
          },
          {
            guard: 'isConflict409Result',
            target: 'conflict409',
            actions: assign(({ event }) =>
              event.output.kind === 'conflict409'
                ? { conflict: event.output.conflict, dirty: true, networkError: null }
                : {}
            ),
          },
          { target: 'editing.dirty' },
        ],
        onError: {
          target: 'networkErrorRetryable',
          actions: assign(({ event }) => ({
            networkError: event.error instanceof Error ? event.error.message : String(event.error),
          })),
        },
      },
      on: {
        CANCEL_SAVE: { target: 'editing.dirty' },
        ENTITY_CHANGED: { target: 'viewing', actions: [{ type: 'applyEntityTarget' }] },
      },
    },
    saved: {
      tags: ['saved'],
      on: {
        DISMISS_SAVED: { target: 'viewing' },
        OPEN_EDIT: [
          { guard: 'canSyncLatest', target: 'syncingRevision', actions: [{ type: 'applyOpenEditTarget' }] },
          { target: 'editing', actions: [{ type: 'applyOpenEditTarget' }] },
        ],
        START_EDIT: { target: 'editing', actions: [{ type: 'resetDraftToBase' }] },
        REQUEST_DELETE: { target: 'confirmingDelete', actions: [{ type: 'clearDeleteState' }] },
        ENTITY_CHANGED: { target: 'viewing', actions: [{ type: 'applyEntityTarget' }] },
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
                  : {}
              ),
            },
            REBASE_AND_RETRY: { target: '#entityEditor.validating', actions: [{ type: 'rebaseOntoServer' }] },
            REBASE_TO_EDIT: {
              target: '#entityEditor.editing.dirty',
              actions: [{ type: 'rebaseOntoServer' }],
            },
            DISCARD_DRAFT: { target: '#entityEditor.viewing', actions: [{ type: 'resetDraftToBase' }] },
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
        REQUEST_DELETE: { target: 'confirmingDelete', actions: [{ type: 'clearDeleteState' }] },
        DISCARD_DRAFT: { target: 'viewing', actions: [{ type: 'resetDraftToBase' }] },
        ENTITY_CHANGED: { target: 'confirmingLeave', actions: [{ type: 'stashPendingEntityChange' }] },
      },
    },
  },
});

export const wikiEditorMachine = entityEditorMachine;
