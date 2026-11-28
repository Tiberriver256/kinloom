import type {
  ArchiveDataSource,
  ConflictPayload,
  EditorCitationMode,
  EntityPayload,
  EntityType,
  OptimisticConflictError,
} from '@kinloom/core';

export interface PendingEntityTarget {
  entityType: EntityType;
  entityId: string;
  revisionId: number;
  snapshot: EntityPayload;
  hasPrimarySource?: boolean | undefined;
}

export interface EntityEditorConflict extends ConflictPayload {
  diff?: OptimisticConflictError['diff'] | undefined;
  serverDeletedAt?: string | null | undefined;
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
  dataSource?: ArchiveDataSource | undefined;
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

export interface LoadLatestEntityInput {
  entityType: EntityType;
  entityId: string;
  dataSource?: ArchiveDataSource | undefined;
}

export interface LoadLatestEntityResult {
  revisionId: number;
  snapshot: EntityPayload;
  hasPrimarySource: boolean;
}

export interface DeleteEntityInput {
  entityType: EntityType;
  entityId: string;
  expectedParentRevisionId: number;
  summary: string;
  dataSource?: ArchiveDataSource | undefined;
}

export interface EntityEditorInput {
  entityType: EntityType;
  entityId: string;
  revisionId: number;
  snapshot: EntityPayload;
  hasPrimarySource?: boolean | undefined;
  dataSource?: ArchiveDataSource | undefined;
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
  deleteSummary: string;
  deleteError: string | null;
  dataSource?: ArchiveDataSource | undefined;
}

export type EntityEditorEvent =
  | {
      type: 'OPEN_EDIT';
      entityType?: EntityType | undefined;
      entityId?: string | undefined;
      revisionId?: number | undefined;
      snapshot?: EntityPayload | undefined;
      hasPrimarySource?: boolean | undefined;
    }
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
      hasPrimarySource?: boolean | undefined;
    }
  | { type: 'CONFIRM_LEAVE' }
  | { type: 'STAY_EDITING' }
  | { type: 'ACCEPT_SERVER' }
  | { type: 'REBASE_AND_RETRY' }
  | { type: 'REBASE_TO_EDIT' }
  | { type: 'RETRY_SAVE' }
  | { type: 'RETURN_TO_EDIT' }
  | { type: 'DISMISS_SAVED' }
  | { type: 'REQUEST_DELETE' }
  | { type: 'CANCEL_DELETE' }
  | { type: 'SET_DELETE_SUMMARY'; summary: string }
  | { type: 'CONFIRM_DELETE' }
  | { type: 'DISMISS_DELETED' };
