import { validateNarrativeCitations } from './citations.js';
import type {
  KinshipEdge,
  MediaItem,
  Narrative,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';

export interface ValidateArchiveInput {
  people: readonly Pick<RawPerson, 'id'>[];
  places?: readonly Pick<Place, 'id'>[];
  events?: readonly Pick<RawEvent, 'id' | 'place_id' | 'participants' | 'sources'>[];
  sources?: readonly Pick<SourceRecord, 'id'>[];
  kinship?: readonly Pick<KinshipEdge, 'from' | 'to' | 'relation'>[];
  media?: readonly Pick<MediaItem, 'id' | 'person_id' | 'person_ids' | 'event_id' | 'source_id'>[];
  narratives?: readonly (Pick<
    Narrative,
    'id' | 'kind' | 'subject_person_id' | 'person_ids' | 'place_ids' | 'event_ids' | 'source_ids'
  > & { body_md?: string })[];
}

export interface ArchiveValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate cross-entity referential integrity across an archive's collections.
 * Verifies narrative `subject_person_id` and `person_ids` against `people` along with event, place, source, kinship, and media links.
 */
export function validateArchive(input: ValidateArchiveInput): ArchiveValidationResult {
  const errors: string[] = [];
  const personIds = new Set(input.people.map((p) => p.id));
  const placeIds = input.places ? new Set(input.places.map((p) => p.id)) : null;
  const eventIds = input.events ? new Set(input.events.map((e) => e.id)) : null;
  const sourceIds = input.sources ? new Set(input.sources.map((s) => s.id)) : null;

  for (const ev of input.events ?? []) {
    if (ev.place_id && placeIds && !placeIds.has(ev.place_id)) {
      errors.push(`Event '${ev.id}' references missing place_id '${ev.place_id}'.`);
    }
    for (const pt of ev.participants) {
      if (!personIds.has(pt.person_id)) {
        errors.push(`Event '${ev.id}' references missing person_id '${pt.person_id}'.`);
      }
    }
    if (sourceIds) {
      for (const ref of ev.sources) {
        if (!sourceIds.has(ref.source_id)) {
          errors.push(`Event '${ev.id}' references missing source_id '${ref.source_id}'.`);
        }
      }
    }
  }

  for (const edge of input.kinship ?? []) {
    if (!personIds.has(edge.from)) {
      errors.push(
        `Kinship edge '${edge.from}|${edge.to}|${edge.relation}' references missing 'from' person '${edge.from}'.`
      );
    }
    if (!personIds.has(edge.to)) {
      errors.push(
        `Kinship edge '${edge.from}|${edge.to}|${edge.relation}' references missing 'to' person '${edge.to}'.`
      );
    }
  }

  for (const item of input.media ?? []) {
    for (const pid of getMediaPersonIds(item)) {
      if (!personIds.has(pid)) {
        errors.push(`Media '${item.id}' references missing person_id '${pid}'.`);
      }
    }
    if (item.event_id && eventIds && !eventIds.has(item.event_id)) {
      errors.push(`Media '${item.id}' references missing event_id '${item.event_id}'.`);
    }
    if (item.source_id && sourceIds && !sourceIds.has(item.source_id)) {
      errors.push(`Media '${item.id}' references missing source_id '${item.source_id}'.`);
    }
  }

  for (const nar of input.narratives ?? []) {
    if (nar.subject_person_id !== undefined) {
      if (!personIds.has(nar.subject_person_id)) {
        errors.push(`Narrative '${nar.id}' references missing subject_person_id '${nar.subject_person_id}'.`);
      } else if (
        nar.kind === 'biography' &&
        nar.person_ids.length > 0 &&
        !nar.person_ids.includes(nar.subject_person_id)
      ) {
        errors.push(
          `Biography narrative '${nar.id}' subject_person_id '${nar.subject_person_id}' is not listed in person_ids.`
        );
      }
    }
    for (const pid of nar.person_ids) {
      if (!personIds.has(pid)) {
        errors.push(`Narrative '${nar.id}' references missing person_id '${pid}'.`);
      }
    }
    if (placeIds) {
      for (const plId of nar.place_ids) {
        if (!placeIds.has(plId)) {
          errors.push(`Narrative '${nar.id}' references missing place_id '${plId}'.`);
        }
      }
    }
    if (eventIds) {
      for (const evId of nar.event_ids) {
        if (!eventIds.has(evId)) {
          errors.push(`Narrative '${nar.id}' references missing event_id '${evId}'.`);
        }
      }
    }
    if (sourceIds) {
      for (const srcId of nar.source_ids) {
        if (!sourceIds.has(srcId)) {
          errors.push(`Narrative '${nar.id}' references missing source_id '${srcId}'.`);
        }
      }
    }
  }

  if (sourceIds && input.narratives && input.narratives.length > 0) {
    const mediaIds = input.media ? new Set(input.media.map((m) => m.id)) : null;
    errors.push(...validateNarrativeCitations(input.narratives, sourceIds, mediaIds));
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
