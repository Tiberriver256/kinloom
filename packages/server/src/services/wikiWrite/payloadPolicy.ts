import {
  type ArchiveRepository,
  assertMediaAllowedForPrivacy,
  deriveKinshipEdgeId,
  type EntityLifecycleState,
  type EntityLookupKey,
  type EntityPayload,
  type EntityType,
  entityLookupCompositeKey,
  isEditSummaryValid,
  type KinloomSiteConfig,
  type MediaStore,
  type Pronunciation,
  parseEntityPayload,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
  type StoredEntityRecord,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
} from '@kinloom/core';
import { generateEntityId } from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';
import type { PronunciationAudioGenerator } from '../../ports.js';
import { generateAndStorePronunciationAudio } from '../pronunciationHelper.js';

const ENTITY_ID_PREFIX: Record<Exclude<EntityType, 'kinship_edge'>, string> = {
  person: 'per',
  event: 'evt',
  place: 'plc',
  source: 'src',
  media: 'med',
  narrative: 'nar',
};

export interface WorkingEntityRecord {
  lifecycle: EntityLifecycleState;
  hasPrimarySource: boolean;
  slug: string | null;
  updatedAt: string;
}

export interface PayloadPolicyDeps {
  readonly repository: ArchiveRepository;
  readonly siteConfig: KinloomSiteConfig;
  readonly mediaStore?: MediaStore;
  readonly pronunciationGenerator?: PronunciationAudioGenerator;
}

export function rowToPayload(row: StoredEntityRecord): EntityPayload {
  if ('edge' in row) {
    return structuredClone(row.edge) as unknown as EntityPayload;
  }
  return structuredClone(row.data);
}

export function rowToWorking(row: StoredEntityRecord | null): WorkingEntityRecord {
  if (!row) {
    return {
      lifecycle: { kind: 'nonExistent' },
      hasPrimarySource: true,
      slug: null,
      updatedAt: '',
    };
  }
  const payload = rowToPayload(row);
  if (row.deleted_at !== null) {
    return {
      lifecycle: {
        kind: 'softDeleted',
        currentRevisionId: row.current_revision_id,
        lastData: payload,
        deletedAt: row.deleted_at,
      },
      hasPrimarySource: 'edge' in row ? true : row.has_primary_source,
      slug: 'edge' in row ? null : row.slug,
      updatedAt: row.updated_at,
    };
  }
  return {
    lifecycle: {
      kind: 'active',
      currentRevisionId: row.current_revision_id,
      data: payload,
    },
    hasPrimarySource: 'edge' in row ? true : row.has_primary_source,
    slug: 'edge' in row ? null : row.slug,
    updatedAt: row.updated_at,
  };
}

export function extractSlug(entityType: EntityType, payload: EntityPayload | null): string | null {
  if (!payload || entityType === 'kinship_edge') {
    return null;
  }
  return typeof payload.slug === 'string' && payload.slug.trim().length > 0 ? payload.slug.trim() : null;
}

export function extractMediaEventId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const eventId = (payload as Record<string, unknown>).event_id;
  return typeof eventId === 'string' && eventId.trim().length > 0 ? eventId.trim() : null;
}

export function assertEditSummaryValid(summary: string): void {
  if (!isEditSummaryValid(summary)) {
    throw new KinloomHttpError(400, 'VALIDATION_ERROR', 'Edit summary must be at least 3 characters.');
  }
}

export async function prefetchEntitiesByKey(
  repository: ArchiveRepository,
  keys: readonly EntityLookupKey[]
): Promise<Map<string, StoredEntityRecord | null>> {
  if (keys.length === 0) {
    return new Map();
  }
  if (repository.getEntitiesBatch) {
    return repository.getEntitiesBatch(keys);
  }
  const unique: EntityLookupKey[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const composite = entityLookupCompositeKey(key.entityType, key.entityId);
    if (seen.has(composite)) {
      continue;
    }
    seen.add(composite);
    unique.push(key);
  }
  const rows = await Promise.all(unique.map((key) => repository.getEntity(key.entityType, key.entityId)));
  const result = new Map<string, StoredEntityRecord | null>();
  for (let i = 0; i < unique.length; i += 1) {
    const key = unique[i];
    result.set(entityLookupCompositeKey(key.entityType, key.entityId), rows[i] ?? null);
  }
  return result;
}

export function updateWorkingPrivacyContext(
  siteConfig: KinloomSiteConfig,
  entityType: EntityType,
  entityId: string,
  sanitized: EntityPayload,
  livingIds: Set<string>,
  workingEvents: Map<string, Pick<RawEvent, 'id' | 'participants'>>
): void {
  if (entityType === 'person') {
    const parsed = sanitized as unknown as RawPerson;
    if (resolveEffectiveLiving(parsed, siteConfig.privacy)) {
      livingIds.add(entityId);
    } else {
      livingIds.delete(entityId);
    }
  } else if (entityType === 'event') {
    const parsed = sanitized as unknown as RawEvent;
    workingEvents.set(entityId, { id: parsed.id, participants: parsed.participants });
  }
}

export async function validateAndSanitizeEntityPayload(
  deps: Pick<PayloadPolicyDeps, 'repository' | 'siteConfig'>,
  params: {
    entityType: EntityType;
    requestedEntityId?: string;
    rawPayload: EntityPayload;
    hasPrimarySource: boolean;
    requireIdMatch?: boolean;
    livingPersonIdsOverride?: ReadonlySet<string>;
    extraEventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>;
    prefetchedEventIds?: ReadonlySet<string>;
  }
): Promise<{ entityId: string; sanitized: EntityPayload }> {
  const candidate: Record<string, unknown> = { ...params.rawPayload };
  if (candidate.extensions !== undefined) {
    candidate.extensions = structuredClone(candidate.extensions);
  }

  if (params.entityType === 'kinship_edge') {
    const parsedEdge = parseEntityPayload('kinship_edge', candidate);
    const derivedId = deriveKinshipEdgeId(parsedEdge);
    if (params.requireIdMatch && params.requestedEntityId && params.requestedEntityId !== derivedId) {
      throw new KinloomHttpError(
        400,
        'VALIDATION_ERROR',
        `Kinship edge ID mismatch: expected '${params.requestedEntityId}', derived '${derivedId}'.`
      );
    }
    return {
      entityId: params.requestedEntityId ?? derivedId,
      sanitized: parsedEdge as unknown as EntityPayload,
    };
  }

  const prefix = ENTITY_ID_PREFIX[params.entityType];
  const bodyId =
    typeof candidate.id === 'string' && candidate.id.trim().length > 0 ? candidate.id.trim() : undefined;

  if (params.requireIdMatch && params.requestedEntityId && bodyId && bodyId !== params.requestedEntityId) {
    throw new KinloomHttpError(
      400,
      'VALIDATION_ERROR',
      `Payload id '${bodyId}' does not match path id '${params.requestedEntityId}'.`
    );
  }

  const entityId = params.requestedEntityId ?? bodyId ?? generateEntityId(prefix);
  candidate.id = entityId;
  candidate.has_primary_source = params.hasPrimarySource;

  switch (params.entityType) {
    case 'person': {
      const parsed = parseEntityPayload('person', candidate);
      const sanitized = sanitizePersonForWrite(parsed, deps.siteConfig.privacy);
      return { entityId, sanitized: sanitized as unknown as EntityPayload };
    }
    case 'event': {
      const parsed = parseEntityPayload('event', candidate);
      const livingIds = params.livingPersonIdsOverride ?? (await deps.repository.getLivingPersonIds());
      const sanitized = sanitizeEventForWrite(parsed, livingIds, deps.siteConfig.privacy);
      return { entityId, sanitized: sanitized as unknown as EntityPayload };
    }
    case 'media': {
      const parsed = parseEntityPayload('media', candidate);
      const livingIds = params.livingPersonIdsOverride ?? (await deps.repository.getLivingPersonIds());
      let eventsMap: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>> | undefined =
        params.extraEventsById;
      if (
        parsed.event_id &&
        !params.extraEventsById?.has(parsed.event_id) &&
        !params.prefetchedEventIds?.has(parsed.event_id)
      ) {
        const evRow = await deps.repository.getEntity('event', parsed.event_id);
        if (evRow && !('edge' in evRow) && evRow.deleted_at === null) {
          const parsedEv = parseEntityPayload('event', evRow.data);
          const nextEvents = new Map(params.extraEventsById ?? []);
          nextEvents.set(parsedEv.id, parsedEv);
          eventsMap = nextEvents;
        }
      }
      assertMediaAllowedForPrivacy(parsed, livingIds, eventsMap);
      return { entityId, sanitized: parsed as unknown as EntityPayload };
    }
    case 'place': {
      const parsed = parseEntityPayload('place', candidate);
      return { entityId, sanitized: parsed as unknown as EntityPayload };
    }
    case 'source': {
      const parsed = parseEntityPayload('source', candidate);
      return { entityId, sanitized: parsed as unknown as EntityPayload };
    }
    case 'narrative': {
      const parsed = parseEntityPayload('narrative', candidate);
      return { entityId, sanitized: parsed as unknown as EntityPayload };
    }
    default: {
      const _exhaustive: never = params.entityType;
      throw new Error(`Unhandled entity type: ${String(_exhaustive)}`);
    }
  }
}

export async function maybeGenerateEntityPronunciationAudio(
  deps: Pick<PayloadPolicyDeps, 'siteConfig' | 'mediaStore' | 'pronunciationGenerator'>,
  params: {
    entityType: EntityType;
    sanitized: EntityPayload;
    previousPayload: EntityPayload | null;
  }
): Promise<EntityPayload> {
  if (!deps.pronunciationGenerator || !deps.mediaStore) {
    return params.sanitized;
  }
  if (params.entityType !== 'person' && params.entityType !== 'place') {
    return params.sanitized;
  }

  const nextPron = params.sanitized.pronunciation as Pronunciation | null | undefined;
  if (!nextPron || typeof nextPron !== 'object') {
    return params.sanitized;
  }

  if (
    params.entityType === 'person' &&
    resolveEffectiveLiving(params.sanitized as unknown as RawPerson, deps.siteConfig.privacy)
  ) {
    return params.sanitized;
  }

  const prevPron =
    params.previousPayload &&
    typeof params.previousPayload.pronunciation === 'object' &&
    params.previousPayload.pronunciation !== null
      ? (params.previousPayload.pronunciation as Pronunciation)
      : null;

  let shouldGenerate = !nextPron.audio_url;
  if (!shouldGenerate && params.previousPayload !== null) {
    const phoneticChanged = (prevPron?.phonetic ?? '') !== (nextPron.phonetic ?? '');
    const ipaChanged = (prevPron?.ipa ?? '') !== (nextPron.ipa ?? '');
    const languageChanged = (prevPron?.language ?? '') !== (nextPron.language ?? '');
    const nameChanged =
      params.entityType === 'person'
        ? (params.previousPayload.full_name ?? '') !== (params.sanitized.full_name ?? '')
        : (params.previousPayload.name ?? '') !== (params.sanitized.name ?? '') ||
          (params.previousPayload.full_name ?? '') !== (params.sanitized.full_name ?? '');
    shouldGenerate = phoneticChanged || ipaChanged || languageChanged || nameChanged;
  }

  if (!shouldGenerate) {
    return params.sanitized;
  }

  const entityText =
    params.entityType === 'person'
      ? typeof params.sanitized.full_name === 'string'
        ? params.sanitized.full_name.trim()
        : ''
      : typeof params.sanitized.name === 'string' && params.sanitized.name.trim()
        ? params.sanitized.name.trim()
        : typeof params.sanitized.full_name === 'string'
          ? params.sanitized.full_name.trim()
          : '';

  const text = entityText || nextPron.phonetic?.trim() || nextPron.ipa?.trim() || '';
  if (!text) {
    return params.sanitized;
  }

  try {
    const stored = await generateAndStorePronunciationAudio({
      generator: deps.pronunciationGenerator,
      mediaStore: deps.mediaStore,
      entityType: params.entityType,
      text,
      phonetic: nextPron.phonetic,
      ipa: nextPron.ipa,
      language: nextPron.language,
    });
    return {
      ...params.sanitized,
      pronunciation: {
        ...nextPron,
        audio_url: stored.audio_url,
      },
    };
  } catch {
    return params.sanitized;
  }
}
