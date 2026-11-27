import { isEditSummaryValid, rebaseEntityDraft, validateEntityDraft } from '@kinloom/core';
import { defaultCitationMode } from './actors.js';
import type { EntityEditorContext, EntityEditorEvent, EntityEditorInput } from './types.js';

export function createInitialEntityEditorContext(input: EntityEditorInput): EntityEditorContext {
  return {
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
    deleteSummary: '',
    deleteError: null,
    dataSource: input.dataSource,
  };
}

export function buildResetDraftPatch(context: EntityEditorContext): Partial<EntityEditorContext> {
  return {
    draft: structuredClone(context.baseSnapshot),
    summary: '',
    dirty: false,
    conflict: null,
    validationErrors: [],
    networkError: null,
    pendingEntityChange: null,
    deleteSummary: '',
    deleteError: null,
  };
}

export function buildOpenEditPatch(
  context: EntityEditorContext,
  event: EntityEditorEvent
): Partial<EntityEditorContext> {
  if (event.type !== 'OPEN_EDIT') {
    return {};
  }
  const nextSnapshot = event.snapshot ?? context.baseSnapshot;
  return {
    entityType: event.entityType ?? context.entityType,
    entityId: event.entityId ?? context.entityId,
    baseRevisionId: event.revisionId ?? context.baseRevisionId,
    baseSnapshot: structuredClone(nextSnapshot),
    draft: structuredClone(nextSnapshot),
    summary: '',
    citationMode:
      event.hasPrimarySource !== undefined
        ? defaultCitationMode(event.hasPrimarySource)
        : context.citationMode,
    sourceIds: [],
    dirty: false,
    conflict: null,
    validationErrors: [],
    networkError: null,
    pendingEntityChange: null,
    deleteSummary: '',
    deleteError: null,
  };
}

export function buildEntityTargetPatch(event: EntityEditorEvent): Partial<EntityEditorContext> {
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
    deleteSummary: '',
    deleteError: null,
  };
}

export function buildPendingLeavePatch(context: EntityEditorContext): Partial<EntityEditorContext> {
  const target = context.pendingEntityChange;
  if (!target) {
    return buildResetDraftPatch(context);
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
    deleteSummary: '',
    deleteError: null,
  };
}

export function collectValidationErrors(context: EntityEditorContext): readonly string[] {
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
  return errors;
}

export function buildRebasePatch(context: EntityEditorContext): Partial<EntityEditorContext> {
  if (!context.conflict) {
    return {};
  }
  return {
    baseRevisionId: context.conflict.latestRevisionId,
    baseSnapshot: structuredClone(context.conflict.latestSnapshot),
    draft: rebaseEntityDraft(context.baseSnapshot, context.conflict.latestSnapshot, context.draft),
    conflict: null,
    dirty: true,
  };
}
