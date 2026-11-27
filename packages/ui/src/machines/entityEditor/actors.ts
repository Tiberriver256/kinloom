import type { EditorCitationMode, OptimisticConflictError } from '@kinloom/core';
import { asRevisionId } from '@kinloom/core';
import { fromPromise } from 'xstate';
import type {
  DeleteEntityInput,
  EntityEditorConflict,
  LoadLatestEntityInput,
  LoadLatestEntityResult,
  SaveEntityInput,
  SaveEntityResult,
} from './types.js';

export function mapConflictPayload(conflict: OptimisticConflictError): EntityEditorConflict {
  return {
    latestRevisionId: conflict.server_revision_id,
    latestSnapshot: conflict.server_entity ?? {},
    lastAuthorName: conflict.last_author_name,
    lastUpdatedAt: conflict.last_updated_at,
    diff: conflict.diff,
    serverDeletedAt: conflict.server_deleted_at,
  };
}

export function defaultCitationMode(hasPrimarySource?: boolean): EditorCitationMode {
  return hasPrimarySource ? 'cited' : 'familyMemory';
}

export function readSaveEntityOutput(event: unknown): SaveEntityResult | null {
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

export const defaultLoadLatestEntityActor = fromPromise<LoadLatestEntityResult | null, LoadLatestEntityInput>(
  async ({ input }) => {
    if (!input.dataSource?.getEntity) {
      return null;
    }
    const live = await input.dataSource.getEntity(input.entityType, input.entityId);
    return {
      revisionId: live.current_revision_id,
      snapshot: live.entity,
      hasPrimarySource: live.has_primary_source,
    };
  }
);

export const defaultDeleteEntityActor = fromPromise<void, DeleteEntityInput>(async ({ input }) => {
  if (!input.dataSource?.deleteEntity) {
    throw new Error('Deleting records is not supported by this archive.');
  }
  await input.dataSource.deleteEntity(input.entityType, input.entityId, {
    expected_parent_revision_id: asRevisionId(input.expectedParentRevisionId),
    summary: input.summary.trim(),
  });
});

export const defaultSaveEntityActor = fromPromise<SaveEntityResult, SaveEntityInput>(
  async ({ input, signal }) => {
    if (!input.dataSource?.updateEntity) {
      throw new Error('Editing records is not supported by this archive.');
    }

    const res = await input.dataSource.updateEntity(
      input.entityType,
      input.entityId,
      {
        data: input.draft,
        expected_parent_revision_id: asRevisionId(input.expectedParentRevisionId),
        summary: input.summary.trim(),
        has_primary_source: input.hasPrimarySource,
      },
      { signal }
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
);
