import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  computeEntityDiff,
  deriveKinshipEdgeId,
  type EntityPatch,
  type EntityPayload,
  type EntityType,
  filterMediaForPrivacy,
  parseEntityPayload,
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseKinshipYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import {
  type LocalArchiveFiles,
  type RemoteEntityEntry,
  type RemoteSnapshotResponse,
  type SanitizedLocalEntry,
  SYNC_DEPENDENCY_ORDER,
  type SyncChangedSample,
  type SyncDeleteTarget,
  type SyncPlan,
  type SyncTypeCounts,
} from './types.js';

const ENTITY_TYPE_ALIASES: Readonly<Record<string, EntityType>> = {
  place: 'place',
  places: 'place',
  source: 'source',
  sources: 'source',
  person: 'person',
  people: 'person',
  event: 'event',
  events: 'event',
  kinship: 'kinship_edge',
  kinship_edge: 'kinship_edge',
  kinship_edges: 'kinship_edge',
  media: 'media',
  narrative: 'narrative',
  narratives: 'narrative',
};

export function normalizeSyncEntityType(raw: string): EntityType {
  const key = raw.trim().toLowerCase();
  const mapped = ENTITY_TYPE_ALIASES[key];
  if (!mapped) {
    throw new CliValidationError(
      `Unknown entity type '${raw}'. Valid types: ${SYNC_DEPENDENCY_ORDER.join(', ')}.`
    );
  }
  return mapped;
}

export function parseEntityTypeList(csv: string): EntityType[] {
  const requested = new Set(
    csv
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(normalizeSyncEntityType)
  );
  if (requested.size === 0) {
    throw new CliValidationError('Option `--types` must include at least one entity type.');
  }
  return SYNC_DEPENDENCY_ORDER.filter((t) => requested.has(t));
}

export function parseDeleteTargets(csv: string): SyncDeleteTarget[] {
  const targets: SyncDeleteTarget[] = [];
  for (const token of csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const sep = token.indexOf(':');
    if (sep <= 0 || sep === token.length - 1) {
      throw new CliValidationError(
        `Invalid \`--delete\` entry '${token}'. Expected <entity_type>:<entity_id>.`
      );
    }
    const entityType = normalizeSyncEntityType(token.slice(0, sep));
    const entityId = token.slice(sep + 1).trim();
    targets.push({ entity_type: entityType, entity_id: entityId });
  }
  return targets;
}

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}

export async function loadLocalArchive(repoDir: string): Promise<LocalArchiveFiles> {
  const dataDir = path.join(repoDir, 'data');
  const configPath = path.join(repoDir, 'kinloom.config.yaml');

  const [
    configText,
    placesText,
    sourcesText,
    peopleText,
    eventsText,
    kinshipText,
    mediaText,
    narrativesText,
  ] = await Promise.all([
    readOptionalUtf8(configPath),
    readOptionalUtf8(path.join(dataDir, 'places.yaml')),
    readOptionalUtf8(path.join(dataDir, 'sources.yaml')),
    readOptionalUtf8(path.join(dataDir, 'people.yaml')),
    readOptionalUtf8(path.join(dataDir, 'events.yaml')),
    readOptionalUtf8(path.join(dataDir, 'kinship.yaml')),
    readOptionalUtf8(path.join(dataDir, 'media.yaml')),
    readOptionalUtf8(path.join(dataDir, 'narratives.yaml')),
  ]);

  if (!configText) {
    throw new CliValidationError(`Missing kinloom.config.yaml at ${configPath}.`);
  }

  const siteConfig = parseKinloomConfigYaml(configText);
  return {
    siteConfig,
    places: placesText ? parsePlacesYaml(placesText) : [],
    sources: sourcesText ? parseSourcesYaml(sourcesText) : [],
    people: peopleText ? parsePeopleYaml(peopleText) : [],
    events: eventsText ? parseEventsYaml(eventsText) : [],
    kinship: kinshipText ? parseKinshipYaml(kinshipText) : [],
    media: mediaText ? parseMediaYaml(mediaText) : [],
    narratives: narrativesText ? parseNarrativesYaml(narrativesText) : [],
  };
}

function normalizeForDiff(entityType: EntityType, data: EntityPayload): EntityPayload {
  if (entityType === 'kinship_edge') {
    return data;
  }
  return {
    ...data,
    has_primary_source: data.has_primary_source ?? true,
  };
}

export function buildSanitizedLocalEntries(local: LocalArchiveFiles): {
  byType: Record<EntityType, SanitizedLocalEntry[]>;
  livingIds: Set<string>;
  filteredOutMediaCount: number;
} {
  const privacy = local.siteConfig.privacy;
  const livingIds = new Set<string>();

  const sanitizedPeople: SanitizedLocalEntry[] = local.people.map((person) => {
    const isLiving = resolveEffectiveLiving(person, privacy);
    if (isLiving) {
      livingIds.add(person.id);
    }
    const sanitized = sanitizePersonForWrite(person, privacy);
    return {
      entity_type: 'person',
      entity_id: sanitized.id,
      data: parseEntityPayload('person', sanitized),
      has_primary_source: sanitized.has_primary_source ?? true,
      isLiving,
    };
  });

  const sanitizedEvents: SanitizedLocalEntry[] = local.events.map((event) => {
    const sanitized = sanitizeEventForWrite(event, livingIds, privacy);
    return {
      entity_type: 'event',
      entity_id: sanitized.id,
      data: parseEntityPayload('event', sanitized),
      has_primary_source: sanitized.has_primary_source ?? true,
      isLiving: false,
    };
  });

  const peopleById = new Map<string, RawPerson>(
    sanitizedPeople.map((p) => [p.entity_id, parseEntityPayload('person', p.data)])
  );
  const eventsById = new Map<string, Pick<RawEvent, 'id' | 'participants'>>(
    sanitizedEvents.map((e) => {
      const parsed = parseEntityPayload('event', e.data);
      return [e.entity_id, { id: e.entity_id, participants: parsed.participants }];
    })
  );

  const allowedMedia = filterMediaForPrivacy(local.media, peopleById, eventsById, {
    stripLivingPortraits: privacy.stripLivingPortraits,
  });

  const byType: Record<EntityType, SanitizedLocalEntry[]> = {
    place: local.places.map((item) => ({
      entity_type: 'place',
      entity_id: item.id,
      data: parseEntityPayload('place', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    source: local.sources.map((item) => ({
      entity_type: 'source',
      entity_id: item.id,
      data: parseEntityPayload('source', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    person: sanitizedPeople,
    event: sanitizedEvents,
    kinship_edge: local.kinship.map((edge) => ({
      entity_type: 'kinship_edge',
      entity_id: deriveKinshipEdgeId(edge),
      data: parseEntityPayload('kinship_edge', edge),
      has_primary_source: true,
      isLiving: false,
    })),
    media: allowedMedia.map((item) => ({
      entity_type: 'media',
      entity_id: item.id,
      data: parseEntityPayload('media', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
    narrative: local.narratives.map((item) => ({
      entity_type: 'narrative',
      entity_id: item.id,
      data: parseEntityPayload('narrative', item),
      has_primary_source: item.has_primary_source ?? true,
      isLiving: false,
    })),
  };

  return {
    byType,
    livingIds,
    filteredOutMediaCount: local.media.length - allowedMedia.length,
  };
}

export function indexRemoteSnapshot(
  snapshot: RemoteSnapshotResponse
): Record<EntityType, Map<string, RemoteEntityEntry>> {
  const byType: Record<EntityType, Map<string, RemoteEntityEntry>> = {
    place: new Map(),
    source: new Map(),
    person: new Map(),
    event: new Map(),
    kinship_edge: new Map(),
    media: new Map(),
    narrative: new Map(),
  };

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
      continue;
    }
    const rawData: EntityPayload =
      row.data.has_primary_source === undefined && row.has_primary_source === false
        ? { ...row.data, has_primary_source: false }
        : row.data;
    const normalized = parseEntityPayload(row.entity_type, rawData);
    byType[row.entity_type].set(row.entity_id, {
      revisionId: Number(row.current_revision_id),
      data: normalized,
      has_primary_source: row.has_primary_source !== false,
    });
  }

  for (const row of snapshot.kinship) {
    if (row.deleted_at !== null && row.deleted_at !== undefined) {
      continue;
    }
    const normalized = parseEntityPayload('kinship_edge', row.edge);
    byType.kinship_edge.set(row.edge_id, {
      revisionId: Number(row.current_revision_id),
      data: normalized,
      has_primary_source: true,
    });
  }

  return byType;
}

export function computeSyncPlan(params: {
  selectedTypes: readonly EntityType[];
  localByType: Readonly<Record<EntityType, readonly SanitizedLocalEntry[]>>;
  remoteByType: Readonly<Record<EntityType, ReadonlyMap<string, RemoteEntityEntry>>>;
  includeLiving: boolean;
  allowDeletes: boolean;
  explicitDeletes: readonly SyncDeleteTarget[];
}): SyncPlan {
  const patches: EntityPatch[] = [];
  const countsByType: Partial<Record<EntityType, SyncTypeCounts>> = {};
  const changedSamples: SyncChangedSample[] = [];
  const plannedDeleteKeys = new Set<string>();

  for (const entityType of params.selectedTypes) {
    const localEntries = params.localByType[entityType] ?? [];
    const remoteMap = params.remoteByType[entityType] ?? new Map<string, RemoteEntityEntry>();
    const localIds = new Set<string>();

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let deleted = 0;
    let skippedLiving = 0;

    for (const entry of localEntries) {
      localIds.add(entry.entity_id);
      if (entityType === 'person' && entry.isLiving && !params.includeLiving) {
        skippedLiving += 1;
        continue;
      }

      const remote = remoteMap.get(entry.entity_id);
      if (!remote) {
        patches.push({
          action: 'create',
          entity_type: entityType,
          entity_id: entry.entity_id,
          data: entry.data,
          has_primary_source: entry.has_primary_source,
        });
        created += 1;
        if (changedSamples.length < 25) {
          changedSamples.push({
            action: 'create',
            entity_type: entityType,
            entity_id: entry.entity_id,
          });
        }
        continue;
      }

      const diff = computeEntityDiff(
        normalizeForDiff(entityType, remote.data),
        normalizeForDiff(entityType, entry.data)
      );
      if (!diff.hasChanges) {
        unchanged += 1;
        continue;
      }

      patches.push({
        action: 'update',
        entity_type: entityType,
        entity_id: entry.entity_id,
        ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
        data: entry.data,
        merge: false,
        has_primary_source: entry.has_primary_source,
      });
      updated += 1;
      if (changedSamples.length < 25) {
        changedSamples.push({
          action: 'update',
          entity_type: entityType,
          entity_id: entry.entity_id,
          changedFields: diff.fields.slice(0, 6).map((f) => f.path),
        });
      }
    }

    if (params.allowDeletes) {
      for (const [remoteId, remote] of remoteMap.entries()) {
        if (localIds.has(remoteId)) {
          continue;
        }
        const key = `${entityType}:${remoteId}`;
        plannedDeleteKeys.add(key);
        patches.push({
          action: 'delete',
          entity_type: entityType,
          entity_id: remoteId,
          ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
        });
        deleted += 1;
        if (changedSamples.length < 25) {
          changedSamples.push({
            action: 'delete',
            entity_type: entityType,
            entity_id: remoteId,
          });
        }
      }
    }

    countsByType[entityType] = {
      local: localEntries.length,
      remote: remoteMap.size,
      create: created,
      update: updated,
      delete: deleted,
      unchanged,
      skippedLiving,
    };
  }

  for (const target of params.explicitDeletes) {
    const key = `${target.entity_type}:${target.entity_id}`;
    if (plannedDeleteKeys.has(key)) {
      continue;
    }
    const remoteMap = params.remoteByType[target.entity_type];
    const remote = remoteMap.get(target.entity_id);
    if (!remote) {
      continue;
    }
    plannedDeleteKeys.add(key);
    patches.push({
      action: 'delete',
      entity_type: target.entity_type,
      entity_id: target.entity_id,
      ...(remote.revisionId > 0 ? { parent_revision_id: remote.revisionId } : {}),
    });
    const existingCounts = countsByType[target.entity_type];
    if (existingCounts) {
      existingCounts.delete += 1;
    } else {
      countsByType[target.entity_type] = {
        local: params.localByType[target.entity_type].length,
        remote: remoteMap.size,
        create: 0,
        update: 0,
        delete: 1,
        unchanged: 0,
        skippedLiving: 0,
      };
    }
    if (changedSamples.length < 25) {
      changedSamples.push({
        action: 'delete',
        entity_type: target.entity_type,
        entity_id: target.entity_id,
      });
    }
  }

  return { patches, countsByType, changedSamples };
}
