import {
  extractNarrativeCitations,
  KinshipEdgeSchema,
  type MediaItem,
  type Narrative,
  NarrativeSchema,
  type RawEvent,
  RawEventSchema,
  type RawPerson,
  validateNarrativeCitations,
} from '@kinloom/core';
import { isPlainObject } from './primitives.js';

export interface PatchReferentialIntegrityInput {
  cleanedPatchEvents: readonly unknown[];
  patchKinship: readonly unknown[];
  normalizedPatchNarratives: readonly unknown[];
  peopleById: ReadonlyMap<string, RawPerson>;
  livingIds: ReadonlySet<string>;
  placeIds: ReadonlySet<string>;
  sourceIds: ReadonlySet<string>;
  eventsById: ReadonlyMap<string, RawEvent>;
}

export function validatePatchReferentialIntegrity(input: PatchReferentialIntegrityInput): void {
  const {
    cleanedPatchEvents,
    patchKinship,
    normalizedPatchNarratives,
    peopleById,
    livingIds,
    placeIds,
    sourceIds,
    eventsById,
  } = input;

  for (const rawEv of cleanedPatchEvents) {
    const ev = RawEventSchema.parse(rawEv);
    if (ev.place_id && !placeIds.has(ev.place_id)) {
      throw new Error(`Event '${ev.id}' references missing place_id '${ev.place_id}'.`);
    }
    let touchesLiving = false;
    for (const pt of ev.participants) {
      if (!peopleById.has(pt.person_id)) {
        throw new Error(`Event '${ev.id}' references missing person_id '${pt.person_id}'.`);
      }
      if (livingIds.has(pt.person_id)) {
        touchesLiving = true;
      }
    }
    if (touchesLiving) {
      throw new Error(`PRIVACY REFUSAL: Patch event '${ev.id}' includes a living participant.`);
    }
    for (const ref of ev.sources) {
      if (!sourceIds.has(ref.source_id)) {
        throw new Error(`Event '${ev.id}' references missing source_id '${ref.source_id}'.`);
      }
    }
  }

  for (const rawEdge of patchKinship) {
    const edge = KinshipEdgeSchema.parse(rawEdge);
    if (!peopleById.has(edge.from)) {
      throw new Error(`Kinship edge references missing 'from' person '${edge.from}'.`);
    }
    if (!peopleById.has(edge.to)) {
      throw new Error(`Kinship edge references missing 'to' person '${edge.to}'.`);
    }
  }

  for (const rawNar of normalizedPatchNarratives) {
    const nar = NarrativeSchema.parse(rawNar);
    if (nar.subject_person_id !== undefined) {
      if (!peopleById.has(nar.subject_person_id)) {
        throw new Error(
          `Narrative '${nar.id}' references missing subject_person_id '${nar.subject_person_id}'.`
        );
      }
      if (livingIds.has(nar.subject_person_id)) {
        throw new Error(
          `PRIVACY REFUSAL: Narrative '${nar.id}' references living subject_person_id '${nar.subject_person_id}'.`
        );
      }
    }
    for (const pid of nar.person_ids) {
      if (!peopleById.has(pid)) {
        throw new Error(`Narrative '${nar.id}' references missing person_id '${pid}'.`);
      }
      if (livingIds.has(pid)) {
        throw new Error(`PRIVACY REFUSAL: Narrative '${nar.id}' references living person '${pid}'.`);
      }
    }
    for (const plId of nar.place_ids) {
      if (!placeIds.has(plId)) {
        throw new Error(`Narrative '${nar.id}' references missing place_id '${plId}'.`);
      }
    }
    for (const evId of nar.event_ids) {
      if (!eventsById.has(evId)) {
        throw new Error(`Narrative '${nar.id}' references missing event_id '${evId}'.`);
      }
    }
    for (const srcId of nar.source_ids) {
      if (!sourceIds.has(srcId)) {
        throw new Error(`Narrative '${nar.id}' references missing source_id '${srcId}'.`);
      }
    }
  }
}

export interface RetirementIntegrityInput {
  topLevelRemoveEventIds: ReadonlySet<string>;
  topLevelRemoveMediaIds: ReadonlySet<string>;
  topLevelRemoveSourceIds: ReadonlySet<string>;
  mergedPeople: readonly RawPerson[];
  finalEvents: readonly RawEvent[];
  finalMedia: readonly MediaItem[];
  finalNarratives: readonly Narrative[];
  sourceIds: ReadonlySet<string>;
  mediaIds: ReadonlySet<string>;
}

export function validateRetirementIntegrity(input: RetirementIntegrityInput): void {
  const {
    topLevelRemoveEventIds,
    topLevelRemoveMediaIds,
    topLevelRemoveSourceIds,
    mergedPeople,
    finalEvents,
    finalMedia,
    finalNarratives,
    sourceIds,
    mediaIds,
  } = input;

  // Ensure top-level event removal never leaves dangling references in surviving media or narratives.
  if (topLevelRemoveEventIds.size > 0) {
    for (const item of finalMedia) {
      if (item.event_id && topLevelRemoveEventIds.has(item.event_id)) {
        throw new Error(`Cannot remove event '${item.event_id}': media '${item.id}' still references it.`);
      }
    }
    for (const nar of finalNarratives) {
      for (const evId of nar.event_ids) {
        if (topLevelRemoveEventIds.has(evId)) {
          throw new Error(
            `Cannot remove event '${evId}': narrative '${nar.id}' still references it in event_ids.`
          );
        }
      }
    }
  }

  // Ensure top-level media removal never breaks surviving narrative inline citations.
  if (topLevelRemoveMediaIds.size > 0) {
    for (const nar of finalNarratives) {
      const extracted = extractNarrativeCitations(nar.body_md);
      for (const occ of extracted.occurrences) {
        if (occ.mediaId && topLevelRemoveMediaIds.has(occ.mediaId)) {
          throw new Error(
            `Cannot remove media '${occ.mediaId}': narrative '${nar.id}' still cites it inline.`
          );
        }
      }
    }
  }

  // Ensure top-level source removal never breaks citations or references anywhere in the archive.
  if (topLevelRemoveSourceIds.size > 0) {
    for (const ev of finalEvents) {
      for (const ref of ev.sources) {
        if (topLevelRemoveSourceIds.has(ref.source_id)) {
          throw new Error(`Cannot remove source '${ref.source_id}': event '${ev.id}' still cites it.`);
        }
      }
    }
    for (const item of finalMedia) {
      if (item.source_id && topLevelRemoveSourceIds.has(item.source_id)) {
        throw new Error(`Cannot remove source '${item.source_id}': media '${item.id}' still references it.`);
      }
    }
    for (const nar of finalNarratives) {
      for (const srcId of nar.source_ids) {
        if (topLevelRemoveSourceIds.has(srcId)) {
          throw new Error(
            `Cannot remove source '${srcId}': narrative '${nar.id}' still lists it in source_ids.`
          );
        }
      }
    }
    const allCitationErrors = validateNarrativeCitations(finalNarratives, sourceIds, mediaIds);
    if (allCitationErrors.length > 0) {
      throw new Error(allCitationErrors[0]);
    }
    for (const person of mergedPeople) {
      const extSources =
        isPlainObject(person.extensions) && Array.isArray(person.extensions.sources)
          ? person.extensions.sources
          : [];
      for (const entry of extSources) {
        const refId =
          typeof entry === 'string'
            ? entry.trim()
            : isPlainObject(entry) && typeof entry.source_id === 'string'
              ? entry.source_id
              : null;
        if (refId && topLevelRemoveSourceIds.has(refId)) {
          throw new Error(
            `Cannot remove source '${refId}': person '${person.id}' still cites it in extensions.sources.`
          );
        }
      }
    }
  }
}
