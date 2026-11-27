import type { ArchiveRawSnapshot, StoredEntityRow } from '../contracts.js';
import type {
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import { type EntityType, parseEntityPayload } from '../schemas/revisions.js';
import type { ExtractedSnapshotCollections } from './types.js';

type NonKinshipEntityType = Exclude<EntityType, 'kinship_edge'>;

function applyPrimarySourceDefault<T extends { has_primary_source?: boolean }>(
  entity: T,
  rowHasPrimarySource: boolean
): T {
  if (!rowHasPrimarySource && entity.has_primary_source === undefined) {
    entity.has_primary_source = false;
  }
  return entity;
}

const SNAPSHOT_ENTITY_COLLECTORS: {
  [K in NonKinshipEntityType]: (collections: ExtractedSnapshotCollections, row: StoredEntityRow) => void;
} = {
  person(collections, row) {
    collections.people.push(
      applyPrimarySourceDefault(parseEntityPayload('person', row.data), row.has_primary_source)
    );
  },
  event(collections, row) {
    collections.events.push(
      applyPrimarySourceDefault(parseEntityPayload('event', row.data), row.has_primary_source)
    );
  },
  place(collections, row) {
    collections.places.push(
      applyPrimarySourceDefault(parseEntityPayload('place', row.data), row.has_primary_source)
    );
  },
  source(collections, row) {
    collections.sources.push(
      applyPrimarySourceDefault(parseEntityPayload('source', row.data), row.has_primary_source)
    );
  },
  media(collections, row) {
    collections.media.push(
      applyPrimarySourceDefault(parseEntityPayload('media', row.data), row.has_primary_source)
    );
  },
  narrative(collections, row) {
    collections.narratives.push(
      applyPrimarySourceDefault(parseEntityPayload('narrative', row.data), row.has_primary_source)
    );
  },
};

/**
 * Extracts active typed entity collections from a raw storage snapshot for archive compilation or YAML export.
 */
export function extractCollectionsFromSnapshot(snapshot: ArchiveRawSnapshot): ExtractedSnapshotCollections {
  const collections: ExtractedSnapshotCollections = {
    people: [],
    events: [],
    places: [],
    sources: [],
    media: [],
    narratives: [],
    kinship: [],
  };

  for (const row of snapshot.entities) {
    if (row.deleted_at !== null) {
      continue;
    }
    SNAPSHOT_ENTITY_COLLECTORS[row.entity_type](collections, row);
  }

  for (const row of snapshot.kinship) {
    if (row.deleted_at === null) {
      collections.kinship.push(structuredClone(row.edge));
    }
  }

  return collections;
}

export function clonePerson(p: RawPerson): RawPerson {
  return {
    ...p,
    alt_names: [...p.alt_names],
    ...(p.pronunciation !== undefined
      ? { pronunciation: p.pronunciation ? structuredClone(p.pronunciation) : null }
      : {}),
    ...(p.extensions !== undefined ? { extensions: structuredClone(p.extensions) } : {}),
  };
}

export function cloneEvent(e: RawEvent): RawEvent {
  return {
    ...e,
    participants: e.participants.map((pt) => ({ ...pt })),
    sources: e.sources.map((src) => ({ ...src })),
    ...(e.alternate_dates !== undefined ? { alternate_dates: e.alternate_dates.map((a) => ({ ...a })) } : {}),
    ...(e.alternate_places !== undefined
      ? { alternate_places: e.alternate_places.map((a) => ({ ...a })) }
      : {}),
    ...(e.fact_conflicts !== undefined ? { fact_conflicts: e.fact_conflicts.map((a) => ({ ...a })) } : {}),
    ...(e.weather_metrics !== undefined ? { weather_metrics: { ...e.weather_metrics } } : {}),
    ...(e.extensions !== undefined ? { extensions: structuredClone(e.extensions) } : {}),
  };
}

export function clonePlace(p: Place): Place {
  return {
    ...p,
    ...(p.ancestor_ids !== undefined ? { ancestor_ids: [...p.ancestor_ids] } : {}),
    ...(p.historical_names !== undefined
      ? { historical_names: p.historical_names.map((h) => ({ ...h })) }
      : {}),
    ...(p.sources !== undefined ? { sources: p.sources.map((s) => ({ ...s })) } : {}),
    ...(p.pronunciation !== undefined
      ? { pronunciation: p.pronunciation ? structuredClone(p.pronunciation) : null }
      : {}),
    ...(p.extensions !== undefined ? { extensions: structuredClone(p.extensions) } : {}),
  };
}

export function cloneSource(s: SourceRecord): SourceRecord {
  return { ...s };
}

export function cloneMedia(m: MediaItem): MediaItem {
  return {
    ...m,
    ...(m.person_ids !== undefined ? { person_ids: [...m.person_ids] } : {}),
    ...(m.extensions !== undefined ? { extensions: structuredClone(m.extensions) } : {}),
  };
}

export function cloneKinship(k: KinshipEdge): KinshipEdge {
  return { ...k };
}

export function cloneNarrative(n: Narrative): Narrative {
  return structuredClone(n);
}
