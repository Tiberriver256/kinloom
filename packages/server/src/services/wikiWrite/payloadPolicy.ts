import {
  assertMediaAllowedForPrivacy,
  buildEntityId,
  type Clock,
  deriveKinshipEdgeId,
  type EntityLifecycleState,
  type EntityLookupKey,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  entityLookupCompositeKey,
  isEditSummaryValid,
  type KinloomSiteConfig,
  type MediaStore,
  type PluginSettingsStore,
  type Pronunciation,
  type PronunciationAudioGenerator,
  type PronunciationEnvDefaults,
  parseEntityPayload,
  type RawEvent,
  resolveEffectiveLiving,
  type StoredEntityRecord,
  sanitizePersonForWrite,
  sanitizeRawEventForWrite,
  storedRecordToEntityPayload,
  toEntityPayload,
} from '@kinloom/core';
import { randomBytes, toHex } from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';
import { generateAndStorePronunciationAudio } from '../pronunciationHelper.js';
import { resolveEffectivePronunciationRuntime } from '../pronunciationRuntime.js';

export interface WorkingEntityRecord {
  lifecycle: EntityLifecycleState;
  hasPrimarySource: boolean;
  slug: string | null;
  updatedAt: string;
}

export interface PayloadPolicyDeps {
  readonly repository: EntityReadStore;
  readonly clock: Clock;
  readonly siteConfig: KinloomSiteConfig;
  readonly mediaStore?: MediaStore;
  readonly pronunciationGenerator?: PronunciationAudioGenerator;
  readonly pronunciationEnv?: PronunciationEnvDefaults;
  readonly pluginSettingsStore?: PluginSettingsStore;
}

export function rowToPayload(row: StoredEntityRecord): EntityPayload {
  return storedRecordToEntityPayload(row);
}

export function rowToWorking(row: StoredEntityRecord | null, clonePayload = true): WorkingEntityRecord {
  if (!row) {
    return {
      lifecycle: { kind: 'nonExistent' },
      hasPrimarySource: true,
      slug: null,
      updatedAt: '',
    };
  }
  const payload = clonePayload ? rowToPayload(row) : 'edge' in row ? toEntityPayload(row.edge) : row.data;
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
  repository: EntityReadStore,
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
  referenceYear: number,
  entityType: EntityType,
  entityId: string,
  sanitized: EntityPayload,
  livingIds: Set<string>,
  workingEvents: Map<string, Pick<RawEvent, 'id' | 'participants'>>
): void {
  if (entityType === 'person') {
    const isLiving = resolveEffectiveLiving(
      {
        is_living: Boolean(sanitized.is_living),
        birth_edtf: typeof sanitized.birth_edtf === 'string' ? sanitized.birth_edtf : '',
        death_edtf: typeof sanitized.death_edtf === 'string' ? sanitized.death_edtf : '',
      },
      siteConfig.privacy,
      referenceYear
    );
    if (isLiving) {
      livingIds.add(entityId);
    } else {
      livingIds.delete(entityId);
    }
  } else if (entityType === 'event') {
    const participants = Array.isArray(sanitized.participants)
      ? (sanitized.participants as RawEvent['participants'])
      : parseEntityPayload('event', sanitized).participants;
    workingEvents.set(entityId, {
      id: typeof sanitized.id === 'string' ? sanitized.id : entityId,
      participants,
    });
  }
}

interface NonKinshipSanitizerContext {
  readonly deps: Pick<PayloadPolicyDeps, 'repository' | 'clock' | 'siteConfig'>;
  readonly candidate: Record<string, unknown>;
  readonly livingPersonIdsOverride?: ReadonlySet<string>;
  readonly extraEventsById?: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>>;
  readonly prefetchedEventIds?: ReadonlySet<string>;
}

type NonKinshipEntityType = Exclude<EntityType, 'kinship_edge'>;

const NON_KINSHIP_SANITIZERS: {
  [K in NonKinshipEntityType]: (ctx: NonKinshipSanitizerContext) => Promise<EntityPayload>;
} = {
  async person({ deps, candidate }) {
    const parsed = parseEntityPayload('person', candidate);
    const sanitized = sanitizePersonForWrite(parsed, deps.siteConfig.privacy, deps.clock.currentYear());
    return toEntityPayload(sanitized);
  },
  async event({ deps, candidate, livingPersonIdsOverride }) {
    const parsed = parseEntityPayload('event', candidate);
    const livingIds = livingPersonIdsOverride ?? (await deps.repository.getLivingPersonIds());
    const sanitized = sanitizeRawEventForWrite(parsed, livingIds, deps.siteConfig.privacy);
    return toEntityPayload(sanitized);
  },
  async media({ deps, candidate, livingPersonIdsOverride, extraEventsById, prefetchedEventIds }) {
    const parsed = parseEntityPayload('media', candidate);
    const livingIds = livingPersonIdsOverride ?? (await deps.repository.getLivingPersonIds());
    let eventsMap: ReadonlyMap<string, Pick<RawEvent, 'id' | 'participants'>> | undefined = extraEventsById;
    if (
      parsed.event_id &&
      !extraEventsById?.has(parsed.event_id) &&
      !prefetchedEventIds?.has(parsed.event_id)
    ) {
      const evRow = await deps.repository.getEntity('event', parsed.event_id);
      if (evRow && !('edge' in evRow) && evRow.deleted_at === null) {
        const parsedEv = parseEntityPayload('event', evRow.data);
        const nextEvents = new Map(extraEventsById ?? []);
        nextEvents.set(parsedEv.id, parsedEv);
        eventsMap = nextEvents;
      }
    }
    assertMediaAllowedForPrivacy(parsed, livingIds, eventsMap);
    return toEntityPayload(parsed);
  },
  async place({ candidate }) {
    return toEntityPayload(parseEntityPayload('place', candidate));
  },
  async source({ candidate }) {
    return toEntityPayload(parseEntityPayload('source', candidate));
  },
  async narrative({ candidate }) {
    return toEntityPayload(parseEntityPayload('narrative', candidate));
  },
};

export async function validateAndSanitizeEntityPayload(
  deps: Pick<PayloadPolicyDeps, 'repository' | 'clock' | 'siteConfig'>,
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
      sanitized: toEntityPayload(parsedEdge),
    };
  }

  const bodyId =
    typeof candidate.id === 'string' && candidate.id.trim().length > 0 ? candidate.id.trim() : undefined;

  if (params.requireIdMatch && params.requestedEntityId && bodyId && bodyId !== params.requestedEntityId) {
    throw new KinloomHttpError(
      400,
      'VALIDATION_ERROR',
      `Payload id '${bodyId}' does not match path id '${params.requestedEntityId}'.`
    );
  }

  const entityId =
    params.requestedEntityId ?? bodyId ?? buildEntityId(params.entityType, toHex(randomBytes(8)));
  candidate.id = entityId;
  candidate.has_primary_source = params.hasPrimarySource;

  const sanitized = await NON_KINSHIP_SANITIZERS[params.entityType]({
    deps,
    candidate,
    livingPersonIdsOverride: params.livingPersonIdsOverride,
    extraEventsById: params.extraEventsById,
    prefetchedEventIds: params.prefetchedEventIds,
  });

  return { entityId, sanitized };
}

export async function maybeGenerateEntityPronunciationAudio(
  deps: Pick<
    PayloadPolicyDeps,
    | 'clock'
    | 'siteConfig'
    | 'mediaStore'
    | 'pronunciationGenerator'
    | 'pronunciationEnv'
    | 'pluginSettingsStore'
  >,
  params: {
    entityType: EntityType;
    sanitized: EntityPayload;
    previousPayload: EntityPayload | null;
  }
): Promise<EntityPayload> {
  if (!deps.mediaStore) {
    return params.sanitized;
  }
  if (!deps.pronunciationGenerator && !deps.pronunciationEnv && !deps.pluginSettingsStore) {
    return params.sanitized;
  }
  if (params.entityType !== 'person' && params.entityType !== 'place') {
    return params.sanitized;
  }

  const nextPron = params.sanitized.pronunciation as Pronunciation | null | undefined;
  if (!nextPron || typeof nextPron !== 'object') {
    return params.sanitized;
  }

  if (params.entityType === 'person') {
    if (
      resolveEffectiveLiving(
        {
          is_living: Boolean(params.sanitized.is_living),
          birth_edtf: typeof params.sanitized.birth_edtf === 'string' ? params.sanitized.birth_edtf : '',
          death_edtf: typeof params.sanitized.death_edtf === 'string' ? params.sanitized.death_edtf : '',
        },
        deps.siteConfig.privacy,
        deps.clock.currentYear()
      )
    ) {
      return params.sanitized;
    }
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

  const runtime = await resolveEffectivePronunciationRuntime({
    pluginSettingsStore: deps.pluginSettingsStore,
    injectedGenerator: deps.pronunciationGenerator,
    envDefaults: deps.pronunciationEnv,
  });
  if (runtime.kind !== 'ready' || !runtime.config.autoGenerateOnSave) {
    return params.sanitized;
  }

  try {
    const stored = await generateAndStorePronunciationAudio({
      generator: runtime.generator,
      mediaStore: deps.mediaStore,
      entityType: params.entityType,
      text,
      phonetic: nextPron.phonetic,
      ipa: nextPron.ipa,
      language: nextPron.language,
      ...(runtime.hasStoredSettings
        ? { voice: runtime.config.defaultVoice, phonemeMode: runtime.config.phonemeMode }
        : {}),
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
