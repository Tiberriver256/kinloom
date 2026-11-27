import {
  type EntityPayload,
  type EntityType,
  safeParseEntityPayload,
  type TypedEntityByType,
} from '../schemas/revisions.js';

export const MIN_EDIT_SUMMARY_LENGTH = 3;

export type EditorCitationMode = 'cited' | 'familyMemory';
export type CitationBadgeKind = 'Cited' | 'Family memory';

export interface ConflictPayload {
  latestRevisionId: number;
  latestSnapshot: EntityPayload;
  lastAuthorName?: string;
  lastUpdatedAt?: string;
}

/**
 * Guard: edit summaries must contain at least 3 non-whitespace characters.
 */
export function isEditSummaryValid(summary: string): boolean {
  return summary.trim().length >= MIN_EDIT_SUMMARY_LENGTH;
}

/**
 * Guard: prevents same-entity ABA stale save resolution by requiring both entity ID and monotonic save generation to match.
 */
export function isMatchingSaveGeneration(params: {
  activeEntityId: string;
  activeSaveGen: number;
  responseEntityId: string;
  responseSaveGen: number;
}): boolean {
  return (
    params.activeSaveGen > 0 &&
    params.responseEntityId === params.activeEntityId &&
    params.responseSaveGen === params.activeSaveGen
  );
}

/**
 * Guard: routes leave-confirmation cancel back to conflict resolution instead of silently dropping the 409 diff.
 */
export function hasPendingConflict(conflict: ConflictPayload | null | undefined): boolean {
  return conflict !== null && conflict !== undefined;
}

/**
 * Derive the visible citation badge from primary-source status or attached source IDs.
 */
export function deriveCitationBadge(input: {
  hasPrimarySource?: boolean;
  citationMode?: EditorCitationMode;
  sourceIds?: readonly string[];
}): CitationBadgeKind {
  if (input.citationMode === 'cited') {
    return 'Cited';
  }
  if (input.hasPrimarySource === true) {
    return 'Cited';
  }
  if (input.sourceIds && input.sourceIds.some((id) => id.trim().length > 0)) {
    return 'Cited';
  }
  return 'Family memory';
}

export type DraftValidationResult<T extends EntityType = EntityType> =
  | { ok: true; data: TypedEntityByType[T] }
  | { ok: false; errors: string[] };

/**
 * Validate an editor draft against the authoritative Zod schema for its entity type.
 */
export function validateEntityDraft<T extends EntityType>(
  entityType: T,
  draft: unknown
): DraftValidationResult<T> {
  const result = safeParseEntityPayload(entityType, draft);
  if (result.success) {
    return { ok: true, data: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
  return { ok: false, errors };
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null) {
    return false;
  }
  if (typeof a === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/**
 * 3-way shallow field rebase: preserves non-conflicting server updates while replaying local changes over base.
 */
export function rebaseEntityDraft(
  base: EntityPayload,
  server: EntityPayload,
  local: EntityPayload
): EntityPayload {
  const merged = structuredClone(server);
  const allKeys = new Set([...Object.keys(base), ...Object.keys(local)]);

  for (const key of allKeys) {
    const baseVal = base[key];
    const localVal = local[key];
    if (valuesEqual(baseVal, localVal)) {
      continue;
    }
    if (localVal === undefined) {
      delete merged[key];
    } else {
      merged[key] = structuredClone(localVal);
    }
  }

  return merged;
}
