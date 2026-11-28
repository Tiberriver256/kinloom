import type { ArchiveRawSnapshot, StoredEntityRow } from '../contracts.js';
import type {
  AlternateDate,
  AlternatePlace,
  EventParticipant,
  EventSourceRef,
  FactConflict,
  HistoricalName,
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  Pronunciation,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import { type EntityType, parseEntityPayload } from '../schemas/revisions.js';
import type { ExtractedSnapshotCollections } from './types.js';

type NonKinshipEntityType = Exclude<EntityType, 'kinship_edge'>;

function applyPrimarySourceDefault<T extends { has_primary_source?: boolean | undefined }>(
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
      collections.kinship.push(cloneKinship(row.edge));
    }
  }

  return collections;
}

function clonePronunciationFast(p: Pronunciation | null): Pronunciation | null {
  if (p === null) {
    return null;
  }
  if (p.variants !== undefined || p.match_full_name_contains !== undefined) {
    return structuredClone(p);
  }
  return { ...p };
}

function cloneEventSourceRefFast(src: EventSourceRef): EventSourceRef {
  const out: EventSourceRef = {
    source_id: src.source_id,
    confidence: src.confidence,
  };
  if (src.claimed_date !== undefined) {
    out.claimed_date = src.claimed_date;
  }
  if (src.citation_detail !== undefined) {
    out.citation_detail = src.citation_detail;
  }
  if (src.scan_url !== undefined) {
    out.scan_url = src.scan_url;
  }
  if (src.scan_title !== undefined) {
    out.scan_title = src.scan_title;
  }
  return out;
}

export function clonePerson(p: RawPerson): RawPerson {
  if (p.gedcom_xref === undefined && p.branch === undefined) {
    const out: RawPerson = {
      id: p.id,
      slug: p.slug,
      full_name: p.full_name,
      given_name: p.given_name,
      surname: p.surname,
      alt_names: p.alt_names.length > 0 ? p.alt_names.slice() : [],
      sex: p.sex,
      is_living: p.is_living,
      lineage_group: p.lineage_group,
      birth_edtf: p.birth_edtf,
      death_edtf: p.death_edtf,
      portrait_url: p.portrait_url,
    };
    if (p.thumb_url !== undefined) {
      out.thumb_url = p.thumb_url;
    }
    if (p.pronunciation !== undefined) {
      out.pronunciation = clonePronunciationFast(p.pronunciation);
    }
    if (p.has_primary_source !== undefined) {
      out.has_primary_source = p.has_primary_source;
    }
    if (p.extensions !== undefined) {
      out.extensions = structuredClone(p.extensions);
    }
    return out;
  }

  const out = { id: p.id, slug: p.slug } as RawPerson;
  if (p.gedcom_xref !== undefined) {
    out.gedcom_xref = p.gedcom_xref;
  }
  out.full_name = p.full_name;
  out.given_name = p.given_name;
  out.surname = p.surname;
  out.alt_names = p.alt_names.length > 0 ? p.alt_names.slice() : [];
  out.sex = p.sex;
  out.is_living = p.is_living;
  out.lineage_group = p.lineage_group;
  if (p.branch !== undefined) {
    out.branch = p.branch;
  }
  out.birth_edtf = p.birth_edtf;
  out.death_edtf = p.death_edtf;
  out.portrait_url = p.portrait_url;
  if (p.thumb_url !== undefined) {
    out.thumb_url = p.thumb_url;
  }
  if (p.pronunciation !== undefined) {
    out.pronunciation = clonePronunciationFast(p.pronunciation);
  }
  if (p.has_primary_source !== undefined) {
    out.has_primary_source = p.has_primary_source;
  }
  if (p.extensions !== undefined) {
    out.extensions = structuredClone(p.extensions);
  }
  return out;
}

export function cloneEvent(e: RawEvent): RawEvent {
  const participants: EventParticipant[] = e.participants.map((pt) => ({
    person_id: pt.person_id,
    role: pt.role,
  }));

  const sources: EventSourceRef[] = e.sources.map(cloneEventSourceRefFast);

  const out = {
    id: e.id,
    title: e.title,
    scope: e.scope,
    event_kind: e.event_kind,
  } as RawEvent;
  if (e.category !== undefined) {
    out.category = e.category;
  }
  out.edtf_date = e.edtf_date;
  if (e.alternate_dates !== undefined) {
    const altDates: AlternateDate[] = e.alternate_dates.map((a) => ({
      edtf_date: a.edtf_date,
      source_id: a.source_id,
      note: a.note,
    }));
    out.alternate_dates = altDates;
  }
  if (e.alternate_places !== undefined) {
    const altPlaces: AlternatePlace[] = e.alternate_places.map((a) => {
      const cp: AlternatePlace = { place_name: a.place_name, source_id: a.source_id, note: a.note };
      if (a.place_id !== undefined) {
        cp.place_id = a.place_id;
      }
      return cp;
    });
    out.alternate_places = altPlaces;
  }
  if (e.fact_conflicts !== undefined) {
    const conflicts: FactConflict[] = e.fact_conflicts.map((a) => ({
      claim: a.claim,
      source_id: a.source_id,
      note: a.note,
    }));
    out.fact_conflicts = conflicts;
  }
  out.place_id = e.place_id;
  if (e.place_precision !== undefined) {
    out.place_precision = e.place_precision;
  }
  out.summary = e.summary;
  if (e.severity_rank !== undefined) {
    out.severity_rank = e.severity_rank;
  }
  if (e.weather_metrics !== undefined) {
    out.weather_metrics = { ...e.weather_metrics };
  }
  if (e.source_url !== undefined) {
    out.source_url = e.source_url;
  }
  if (e.photo_url !== undefined) {
    out.photo_url = e.photo_url;
  }
  if (e.photo_placeholder_caption !== undefined) {
    out.photo_placeholder_caption = e.photo_placeholder_caption;
  }
  out.participants = participants;
  out.sources = sources;
  if (e.has_primary_source !== undefined) {
    out.has_primary_source = e.has_primary_source;
  }
  if (e.extensions !== undefined) {
    out.extensions = structuredClone(e.extensions);
  }
  return out;
}

export function clonePlace(p: Place): Place {
  const out: Place = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    full_name: p.full_name,
    place_type: p.place_type,
    parent_id: p.parent_id,
    lat: p.lat,
    lng: p.lng,
  };
  if (p.min_lat !== undefined) {
    out.min_lat = p.min_lat;
  }
  if (p.max_lat !== undefined) {
    out.max_lat = p.max_lat;
  }
  if (p.min_lng !== undefined) {
    out.min_lng = p.min_lng;
  }
  if (p.max_lng !== undefined) {
    out.max_lng = p.max_lng;
  }
  if (p.ancestor_ids !== undefined) {
    out.ancestor_ids = p.ancestor_ids.slice();
  }
  if (p.historical_names !== undefined) {
    const hist: HistoricalName[] = p.historical_names.map((h) => {
      const ch: HistoricalName = { name: h.name };
      if (h.valid_from !== undefined) {
        ch.valid_from = h.valid_from;
      }
      if (h.valid_to !== undefined) {
        ch.valid_to = h.valid_to;
      }
      return ch;
    });
    out.historical_names = hist;
  }
  if (p.summary !== undefined) {
    out.summary = p.summary;
  }
  if (p.photo_url !== undefined) {
    out.photo_url = p.photo_url;
  }
  if (p.photo_caption !== undefined) {
    out.photo_caption = p.photo_caption;
  }
  if (p.pronunciation !== undefined) {
    out.pronunciation = clonePronunciationFast(p.pronunciation);
  }
  if (p.sources !== undefined) {
    out.sources = p.sources.map(cloneEventSourceRefFast);
  }
  if (p.has_primary_source !== undefined) {
    out.has_primary_source = p.has_primary_source;
  }
  if (p.extensions !== undefined) {
    out.extensions = structuredClone(p.extensions);
  }
  return out;
}

export function cloneSource(s: SourceRecord): SourceRecord {
  const out = { id: s.id } as SourceRecord;
  if (s.gedcom_xref !== undefined) {
    out.gedcom_xref = s.gedcom_xref;
  }
  out.citation = s.citation;
  if (s.author !== undefined) {
    out.author = s.author;
  }
  if (s.publisher !== undefined) {
    out.publisher = s.publisher;
  }
  out.source_type = s.source_type;
  if (s.repository !== undefined) {
    out.repository = s.repository;
  }
  if (s.url !== undefined) {
    out.url = s.url;
  }
  if (s.has_primary_source !== undefined) {
    out.has_primary_source = s.has_primary_source;
  }
  return out;
}

export function cloneMedia(m: MediaItem): MediaItem {
  const out = { id: m.id, kind: m.kind } as MediaItem;
  if (m.source_id !== undefined) {
    out.source_id = m.source_id;
  }
  if (m.page !== undefined) {
    out.page = m.page;
  }
  if (m.person_id !== undefined) {
    out.person_id = m.person_id;
  }
  if (m.person_ids !== undefined) {
    out.person_ids = m.person_ids.slice();
  }
  if (m.person_slug !== undefined) {
    out.person_slug = m.person_slug;
  }
  if (m.person_name !== undefined) {
    out.person_name = m.person_name;
  }
  if (m.event_id !== undefined) {
    out.event_id = m.event_id;
  }
  out.file = m.file;
  if (m.thumb_file !== undefined) {
    out.thumb_file = m.thumb_file;
  }
  out.caption = m.caption;
  if (m.date_edtf !== undefined) {
    out.date_edtf = m.date_edtf;
  }
  if (m.provenance !== undefined) {
    out.provenance = m.provenance;
  }
  if (m.mime_type !== undefined) {
    out.mime_type = m.mime_type;
  }
  if (m.duration_seconds !== undefined) {
    out.duration_seconds = m.duration_seconds;
  }
  if (m.poster_url !== undefined) {
    out.poster_url = m.poster_url;
  }
  if (m.transcript_url !== undefined) {
    out.transcript_url = m.transcript_url;
  }
  if (m.has_primary_source !== undefined) {
    out.has_primary_source = m.has_primary_source;
  }
  if (m.extensions !== undefined) {
    out.extensions = structuredClone(m.extensions);
  }
  return out;
}

export function cloneKinship(k: KinshipEdge): KinshipEdge {
  const out: KinshipEdge = {
    from: k.from,
    to: k.to,
    relation: k.relation,
  };
  if (k.family_xref !== undefined) {
    out.family_xref = k.family_xref;
  }
  return out;
}

export function cloneNarrative(n: Narrative): Narrative {
  const out = { id: n.id, slug: n.slug } as Narrative;
  if (n.kind !== undefined) {
    out.kind = n.kind;
  }
  if (n.subject_person_id !== undefined) {
    out.subject_person_id = n.subject_person_id;
  }
  out.title = n.title;
  if (n.summary !== undefined) {
    out.summary = n.summary;
  }
  out.body_md = n.body_md;
  if (n.date_edtf !== undefined) {
    out.date_edtf = n.date_edtf;
  }
  out.person_ids = n.person_ids.slice();
  out.place_ids = n.place_ids.slice();
  out.event_ids = n.event_ids.slice();
  out.source_ids = n.source_ids.slice();
  if (n.updated_at !== undefined) {
    out.updated_at = n.updated_at;
  }
  if (n.has_primary_source !== undefined) {
    out.has_primary_source = n.has_primary_source;
  }
  if (n.extensions !== undefined) {
    out.extensions = structuredClone(n.extensions);
  }
  return out;
}
