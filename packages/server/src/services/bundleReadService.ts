import {
  type ArchiveRawSnapshot,
  type BundleCache,
  type CachedBundleObject,
  type Clock,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  type ExtractedSnapshotCollections,
  extractCollectionsFromSnapshot,
  filterMediaForPrivacy,
  type KinloomSiteConfig,
  parseEntityPayload,
  type RawEvent,
  type RawPerson,
  type RevisionId,
  type RevisionLogStore,
  type RevisionQuery,
  type RevisionRecord,
  redactSingleRawPerson,
  resolveEffectiveLiving,
  type StoredEntityRow,
  sanitizeRawEventForWrite,
  serializeEventsYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
  storedRecordToEntityPayload,
  toEntityPayload,
} from '@kinloom/core';
import { matchesIfNoneMatch } from '../crypto.js';
import { KinloomHttpError } from '../errors.js';

export interface BundleReadServiceDeps {
  repository: EntityReadStore & RevisionLogStore;
  bundleCache: BundleCache;
  clock: Clock;
  siteConfig: KinloomSiteConfig;
}

export type GetBundleResult =
  | { status: 'not_modified'; etag: string }
  | { status: 'hit'; object: CachedBundleObject };

export type ExportYamlResult =
  | { status: 'not_modified'; etag: string; head_revision_id: RevisionId }
  | {
      status: 'ok';
      etag: string;
      head_revision_id: RevisionId;
      exported_at: string;
      files: Record<string, string>;
    };

export type ExportSnapshotResult =
  | { status: 'not_modified'; etag: string; head_revision_id: RevisionId }
  | {
      status: 'ok';
      etag: string;
      head_revision_id: RevisionId;
      exported_at: string;
      snapshot: ArchiveRawSnapshot;
    };

function parseRevisionFromEtag(etag: string): number | null {
  const match = /^"?r(\d+)(?:-[a-f0-9]+)?"?$/i.exec(etag.trim());
  if (!match) {
    return null;
  }
  const num = Number(match[1]);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

export class BundleReadService {
  private readonly repository: EntityReadStore & RevisionLogStore;
  private readonly bundleCache: BundleCache;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;

  constructor(deps: BundleReadServiceDeps) {
    this.repository = deps.repository;
    this.bundleCache = deps.bundleCache;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
  }

  async getBundle(params: { ifNoneMatch: string | null }): Promise<GetBundleResult> {
    const [headRev, cached] = await Promise.all([
      this.repository.getHeadRevisionId(),
      this.bundleCache.getCached(params.ifNoneMatch),
    ]);

    if (cached.status === 'not_modified') {
      const cachedRev = parseRevisionFromEtag(cached.etag);
      if (cachedRev !== null && cachedRev >= headRev) {
        return cached;
      }
    } else if (cached.status === 'hit') {
      if (cached.object.revision_id >= headRev) {
        return cached;
      }
      if (typeof cached.object.body !== 'string') {
        await cached.object.body.cancel().catch(() => undefined);
      }
    }

    const snapshot = await this.repository.loadActiveSnapshot();
    const rebuilt = await this.bundleCache.rebuildAndStore(snapshot);
    if (matchesIfNoneMatch(params.ifNoneMatch, rebuilt.etag)) {
      return { status: 'not_modified', etag: rebuilt.etag };
    }
    return { status: 'hit', object: rebuilt };
  }

  async getEntity(params: { entityType: EntityType; entityId: string }): Promise<{
    entity: EntityPayload;
    current_revision_id: RevisionId;
    has_primary_source: boolean;
    deleted_at: string | null;
    updated_at: string;
  }> {
    const row = await this.repository.getEntity(params.entityType, params.entityId);
    if (!row) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    if ('edge' in row) {
      return {
        entity: storedRecordToEntityPayload(row),
        current_revision_id: row.current_revision_id,
        has_primary_source: true,
        deleted_at: row.deleted_at,
        updated_at: row.updated_at,
      };
    }

    const redactedEntity = await this.redactEntityForRead(row.entity_type, row.data);
    return {
      entity: redactedEntity,
      current_revision_id: row.current_revision_id,
      has_primary_source: row.has_primary_source,
      deleted_at: row.deleted_at,
      updated_at: row.updated_at,
    };
  }

  async listRevisions(query: RevisionQuery): Promise<{
    items: readonly RevisionRecord[];
    next_cursor: RevisionId | null;
  }> {
    const limit = query.limit === undefined ? 50 : Math.min(200, Math.max(1, query.limit));
    return this.repository.listRevisions({
      ...query,
      limit,
    });
  }

  async exportYaml(params: { ifNoneMatch: string | null }): Promise<ExportYamlResult> {
    const headRev = await this.repository.getHeadRevisionId();
    const etag = `"r${headRev}"`;
    if (matchesIfNoneMatch(params.ifNoneMatch, etag)) {
      return { status: 'not_modified', etag, head_revision_id: headRev };
    }

    const snapshot = await this.repository.loadActiveSnapshot();
    const collections = extractCollectionsFromSnapshot(snapshot);
    const { redactedPeople, redactedEvents, redactedMedia } = this.applyExportPrivacy(collections);

    const files: Record<string, string> = {
      'people.yaml': serializePeopleYaml(redactedPeople, { sortById: true }),
      'events.yaml': serializeEventsYaml(redactedEvents, { sortById: true }),
      'places.yaml': serializePlacesYaml(collections.places, { sortById: true }),
      'sources.yaml': serializeSourcesYaml(collections.sources, { sortById: true }),
      'kinship.yaml': serializeKinshipYaml(collections.kinship, { sortDeterministic: true }),
      'media.yaml': serializeMediaYaml(redactedMedia, { sortById: true }),
      'narratives.yaml': serializeNarrativesYaml(collections.narratives, { sortById: true }),
    };

    const actualEtag = `"r${snapshot.head_revision_id}"`;
    return {
      status: 'ok',
      etag: actualEtag,
      head_revision_id: snapshot.head_revision_id,
      exported_at: this.clock.nowIso(),
      files,
    };
  }

  async exportSnapshot(params: { ifNoneMatch: string | null }): Promise<ExportSnapshotResult> {
    const headRev = await this.repository.getHeadRevisionId();
    const etag = `"r${headRev}"`;
    if (matchesIfNoneMatch(params.ifNoneMatch, etag)) {
      return { status: 'not_modified', etag, head_revision_id: headRev };
    }

    const snapshot = await this.repository.loadActiveSnapshot();
    const collections = extractCollectionsFromSnapshot(snapshot);
    const { redactedPeople, redactedEvents, redactedMedia } = this.applyExportPrivacy(collections);

    const peopleMap = new Map(redactedPeople.map((p) => [p.id, p]));
    const eventsMap = new Map(redactedEvents.map((e) => [e.id, e]));
    const allowedMediaMap = new Map(redactedMedia.map((m) => [m.id, m]));

    const redactedEntities: StoredEntityRow[] = [];
    for (const row of snapshot.entities) {
      if (row.entity_type === 'person') {
        const redacted = peopleMap.get(row.entity_id);
        if (redacted) {
          redactedEntities.push({
            ...row,
            data: toEntityPayload(redacted),
          });
        }
      } else if (row.entity_type === 'event') {
        const redacted = eventsMap.get(row.entity_id);
        if (redacted) {
          redactedEntities.push({
            ...row,
            data: toEntityPayload(redacted),
          });
        }
      } else if (row.entity_type === 'media') {
        const allowed = allowedMediaMap.get(row.entity_id);
        if (allowed) {
          redactedEntities.push({
            ...row,
            data: toEntityPayload(allowed),
          });
        }
      } else {
        redactedEntities.push(structuredClone(row));
      }
    }

    const actualEtag = `"r${snapshot.head_revision_id}"`;
    return {
      status: 'ok',
      etag: actualEtag,
      head_revision_id: snapshot.head_revision_id,
      exported_at: this.clock.nowIso(),
      snapshot: {
        head_revision_id: snapshot.head_revision_id,
        entities: redactedEntities,
        kinship: snapshot.kinship.map((k) => structuredClone(k)),
      },
    };
  }

  private async redactEntityForRead(
    entityType: Exclude<EntityType, 'kinship_edge'>,
    rawData: EntityPayload
  ): Promise<EntityPayload> {
    if (entityType === 'person') {
      const parsed = parseEntityPayload('person', rawData);
      const redacted = redactSingleRawPerson(parsed, 'private', {
        privacy: this.siteConfig.privacy,
        referenceYear: this.clock.currentYear(),
      });
      return toEntityPayload(redacted);
    }
    if (entityType === 'event') {
      const parsed = parseEntityPayload('event', rawData);
      const livingIds = await this.repository.getLivingPersonIds();
      const sanitized = sanitizeRawEventForWrite(parsed, livingIds, this.siteConfig.privacy);
      return toEntityPayload(sanitized);
    }
    return structuredClone(rawData);
  }

  private applyExportPrivacy(collections: ExtractedSnapshotCollections): {
    redactedPeople: RawPerson[];
    redactedEvents: RawEvent[];
    redactedMedia: ExtractedSnapshotCollections['media'];
  } {
    const referenceYear = this.clock.currentYear();
    const livingIds = new Set<string>();
    const redactedPeople = collections.people.map((person) => {
      if (resolveEffectiveLiving(person, this.siteConfig.privacy, referenceYear)) {
        livingIds.add(person.id);
      }
      return redactSingleRawPerson(person, 'private', {
        privacy: this.siteConfig.privacy,
        referenceYear,
      });
    });

    const redactedEvents = collections.events.map((event) =>
      sanitizeRawEventForWrite(event, livingIds, this.siteConfig.privacy)
    );

    const peopleById = new Map(redactedPeople.map((p) => [p.id, p]));
    const eventsById = new Map(redactedEvents.map((e) => [e.id, { id: e.id, participants: e.participants }]));
    const redactedMedia = filterMediaForPrivacy(collections.media, peopleById, eventsById, {
      stripLivingPortraits: this.siteConfig.privacy.stripLivingPortraits,
    });

    return { redactedPeople, redactedEvents, redactedMedia };
  }
}
