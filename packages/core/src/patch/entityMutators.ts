import {
  cloneEvent,
  cloneKinship,
  cloneMedia,
  clonePerson,
  clonePlace,
  cloneSource,
} from '../compile/snapshot.js';
import {
  ALLOWED_MANUAL_MEDIA_KINDS,
  buildTimedEvent,
  compareArchiveEvents,
  EVENT_HERO_MEDIA_KINDS,
  resolvePersonBranch,
} from '../compileArchive.js';
import { edtfYear } from '../edtf.js';
import { applyCitationCleanings, cleanSourceCitationTitle } from '../gedcom/citations.js';
import {
  filterMediaForPrivacy,
  redactSingleEvent,
  redactSingleNarrative,
  redactSinglePerson,
  resolveEffectiveLiving,
} from '../privacy.js';
import type {
  ArchiveEvent,
  EventParticipant,
  KinshipEdge,
  MediaItem,
  Person,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import { deriveKinshipEdgeId, getMediaPersonIds } from '../schemas/pureHelpers.js';
import { parseEntityPayload } from '../schemas/revisions.js';
import {
  type BundlePatchMutation,
  binarySearchEventInsertIndex,
  type PatchWorkingState,
  resolveEffectivePrimarySource,
  updateUncitedKey,
} from './patchState.js';

function participantsHaveSamePersonIds(
  a: readonly EventParticipant[],
  b: readonly EventParticipant[]
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].person_id !== b[i].person_id) {
      return false;
    }
  }
  return true;
}

function applySourceMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  const existingIdx = state.sources.findIndex((s) => s.id === entity_id);
  if (after_json === null) {
    if (existingIdx !== -1) {
      state.sources.splice(existingIdx, 1);
    }
    updateUncitedKey(state.uncitedKeys, 'source', entity_id, undefined, true, state);
    return;
  }
  const parsed = cloneSource(parseEntityPayload('source', after_json));
  const cleaned: SourceRecord = {
    ...parsed,
    citation: parsed.citation ? cleanSourceCitationTitle(parsed.citation) : parsed.citation,
  };
  if (existingIdx !== -1) {
    state.sources[existingIdx] = cleaned;
  } else {
    state.sources.push(cleaned);
  }
  const effectiveHasPrimary = resolveEffectivePrimarySource(cleaned, mutation.has_primary_source);
  updateUncitedKey(state.uncitedKeys, 'source', entity_id, effectiveHasPrimary, false, state);
}

function applyNarrativeMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  if (after_json === null) {
    if (state.narratives) {
      const existingIdx = state.narratives.findIndex((n) => n.id === entity_id);
      if (existingIdx !== -1) {
        state.narratives.splice(existingIdx, 1);
      }
    }
    updateUncitedKey(state.uncitedKeys, 'narrative', entity_id, undefined, true, state);
    return;
  }
  if (state.narratives === undefined) {
    state.narratives = [];
  }
  const { living } = state.ensurePeopleIndex();
  const parsedNarrative = parseEntityPayload('narrative', after_json);
  const needsLivingPattern =
    state.mode === 'public' &&
    ((parsedNarrative.subject_person_id !== undefined && living.has(parsedNarrative.subject_person_id)) ||
      parsedNarrative.person_ids.some((pid) => living.has(pid)));
  const parsed = redactSingleNarrative(
    parsedNarrative,
    living,
    needsLivingPattern ? state.getLivingPattern() : null,
    state.mode,
    { clone: true }
  );
  const existingIdx = state.narratives.findIndex((n) => n.id === entity_id);
  if (existingIdx !== -1) {
    state.narratives[existingIdx] = parsed;
  } else {
    state.narratives.push(parsed);
  }
  const effectiveHasPrimary = resolveEffectivePrimarySource(parsed, mutation.has_primary_source);
  updateUncitedKey(state.uncitedKeys, 'narrative', entity_id, effectiveHasPrimary, false, state);
}

function applyKinshipMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  const existingIdx = state.kinship.findIndex((edge) => deriveKinshipEdgeId(edge) === entity_id);
  if (after_json === null) {
    if (existingIdx !== -1) {
      state.kinship.splice(existingIdx, 1);
    }
    return;
  }
  const parsed: KinshipEdge = cloneKinship(parseEntityPayload('kinship_edge', after_json));
  const parsedIdx =
    existingIdx !== -1
      ? existingIdx
      : state.kinship.findIndex((edge) => deriveKinshipEdgeId(edge) === deriveKinshipEdgeId(parsed));
  if (parsedIdx !== -1) {
    state.kinship[parsedIdx] = parsed;
  } else {
    state.kinship.push(parsed);
  }
}

function applyPlaceMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  state.placesMutated = true;
  state.mutatedPlaceIds.add(entity_id);
  const pMap = state.ensurePlacesById(true);
  const existingPlace = pMap.get(entity_id);
  if (existingPlace && !state.placesBeforeMutation.has(entity_id)) {
    state.placesBeforeMutation.set(entity_id, existingPlace);
  }
  const existingIdx = state.places.findIndex((pl) => pl.id === entity_id);
  if (after_json === null) {
    if (existingIdx !== -1) {
      state.places.splice(existingIdx, 1);
    }
    pMap.delete(entity_id);
    updateUncitedKey(state.uncitedKeys, 'place', entity_id, undefined, true, state);
    return;
  }
  const parsed: Place = clonePlace(parseEntityPayload('place', after_json));
  if (existingIdx !== -1) {
    state.places[existingIdx] = parsed;
  } else {
    state.places.push(parsed);
  }
  pMap.set(parsed.id, parsed);
  const effectiveHasPrimary = resolveEffectivePrimarySource(parsed, mutation.has_primary_source);
  updateUncitedKey(state.uncitedKeys, 'place', entity_id, effectiveHasPrimary, false, state);
}

function applyPersonMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  const roPeopleIdx = state.ensurePeopleIndex(false);
  const existingIdx = roPeopleIdx.idxById.get(entity_id);
  const prevPerson = existingIdx !== undefined ? state.people[existingIdx] : null;

  if (after_json === null) {
    const { idxById, living } = state.ensurePeopleIndex(true);
    if (existingIdx !== undefined) {
      state.people.splice(existingIdx, 1);
      idxById.clear();
      for (let i = 0; i < state.people.length; i += 1) {
        idxById.set(state.people[i].id, i);
      }
    }
    living.delete(entity_id);
    state.markLivingPatternDirty();
    state.deletedPersonIds.add(entity_id);
    state.affectedSpanPersonIds.add(entity_id);
    updateUncitedKey(state.uncitedKeys, 'person', entity_id, undefined, true, state);
    return;
  }

  const raw: RawPerson = clonePerson(parseEntityPayload('person', after_json));
  raw.branch = resolvePersonBranch(raw, state.siteConfig);
  const isNowLiving = resolveEffectiveLiving(raw, state.privacy);
  if (isNowLiving) {
    raw.is_living = true;
  }
  const rawFullNameBeforeRedaction = raw.full_name;
  const rawAltNamesBeforeRedaction = [...raw.alt_names];
  const hasExplicitPortrait = Boolean(raw.portrait_url) && !(isNowLiving && state.stripLivingPortraits);
  if (hasExplicitPortrait) {
    state.explicitPortraitPersonIds.add(raw.id);
  }

  const redactedRaw = redactSinglePerson(raw, state.mode, { privacy: state.privacy, clone: false });
  const effectiveHasPrimary = resolveEffectivePrimarySource(redactedRaw, mutation.has_primary_source);

  const compiledPerson: Person = {
    ...redactedRaw,
    birth_year: edtfYear(redactedRaw.birth_edtf),
    death_year: edtfYear(redactedRaw.death_edtf),
    event_count: prevPerson ? prevPerson.event_count : 0,
    media_count: isNowLiving && state.stripLivingPortraits ? 0 : (prevPerson?.media_count ?? 0),
    primary_place_id: prevPerson ? prevPerson.primary_place_id : null,
  };

  if (isNowLiving && state.stripLivingPortraits) {
    compiledPerson.portrait_url = null;
    compiledPerson.thumb_url = null;
    compiledPerson.media_count = 0;
  }

  const wasLiving = prevPerson?.is_living ?? false;
  const livingNameChanged =
    isNowLiving &&
    (!prevPerson ||
      !wasLiving ||
      prevPerson.full_name !== compiledPerson.full_name ||
      rawFullNameBeforeRedaction !== prevPerson.full_name ||
      rawAltNamesBeforeRedaction.length !== prevPerson.alt_names.length ||
      rawAltNamesBeforeRedaction.some((a, idx) => a !== prevPerson.alt_names[idx]));

  if (existingIdx !== undefined) {
    state.people[existingIdx] = compiledPerson;
    if (wasLiving !== isNowLiving) {
      const { living } = state.ensurePeopleIndex(true);
      if (isNowLiving) {
        living.add(compiledPerson.id);
      } else {
        living.delete(compiledPerson.id);
      }
      state.markLivingPatternDirty();
    } else if (livingNameChanged) {
      state.markLivingPatternDirty();
    }
  } else {
    const { idxById, living } = state.ensurePeopleIndex(true);
    idxById.set(compiledPerson.id, state.people.length);
    state.people.push(compiledPerson);
    if (isNowLiving) {
      living.add(compiledPerson.id);
      state.markLivingPatternDirty();
    }
  }

  if (isNowLiving && !wasLiving) {
    state.newlyLivingPersonIds.add(compiledPerson.id);
    state.newlyLivingNamesById.set(compiledPerson.id, {
      full_name: rawFullNameBeforeRedaction,
      alt_names: rawAltNamesBeforeRedaction,
    });
  }

  if (!prevPerson || wasLiving !== isNowLiving) {
    state.affectedEventCountPersonIds.add(compiledPerson.id);
    state.affectedSpanPersonIds.add(compiledPerson.id);
    state.affectedMediaPersonIds.add(compiledPerson.id);
  } else if (!hasExplicitPortrait) {
    // If previous person had no media-linked portrait (`media_count === 0` and `portrait_url === null`)
    // and no media mutated in this batch, skip full media scan!
    if (state.mediaMutated || prevPerson.portrait_url !== null || (prevPerson.media_count ?? 0) > 0) {
      state.affectedMediaPersonIds.add(compiledPerson.id);
    }
  }

  if (
    prevPerson &&
    (prevPerson.full_name !== compiledPerson.full_name || prevPerson.slug !== compiledPerson.slug)
  ) {
    state.renamedPersonIds.add(compiledPerson.id);
  }

  updateUncitedKey(state.uncitedKeys, 'person', entity_id, effectiveHasPrimary, false, state);
}

function applyEventMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  const { living } = state.ensurePeopleIndex();
  const evIdxMap = state.ensureEventsIndex();
  const existingIdx = evIdxMap.get(entity_id);
  const prevEvent = existingIdx !== undefined ? state.events[existingIdx] : null;

  if (after_json === null) {
    if (prevEvent) {
      for (const pt of prevEvent.participants) {
        state.affectedEventCountPersonIds.add(pt.person_id);
        if (prevEvent.event_kind === 'residence_anchor') {
          state.affectedSpanPersonIds.add(pt.person_id);
        }
      }
    }
    if (existingIdx !== undefined) {
      state.events.splice(existingIdx, 1);
      state.invalidateEventsIndex();
    }
    updateUncitedKey(state.uncitedKeys, 'event', entity_id, undefined, true, state);
    return;
  }

  const raw: RawEvent = cloneEvent(parseEntityPayload('event', after_json));
  const effectiveHasPrimary = resolveEffectivePrimarySource(raw, mutation.has_primary_source);

  const timed = buildTimedEvent(raw, state.placeAncestors);
  applyCitationCleanings([timed], [], state.legacyContainerSourceIds);
  const hasLivingParticipant = timed.participants.some((pt) => living.has(pt.person_id));
  const pattern = hasLivingParticipant ? state.getLivingPattern() : null;
  const redacted = redactSingleEvent(timed, living, pattern, state.mode, {
    privacy: state.privacy,
    clone: false,
  });

  if (!redacted) {
    if (prevEvent) {
      for (const pt of prevEvent.participants) {
        state.affectedEventCountPersonIds.add(pt.person_id);
        if (prevEvent.event_kind === 'residence_anchor') {
          state.affectedSpanPersonIds.add(pt.person_id);
        }
      }
    }
    if (existingIdx !== undefined) {
      state.events.splice(existingIdx, 1);
      state.invalidateEventsIndex();
    }
    updateUncitedKey(state.uncitedKeys, 'event', entity_id, undefined, true, state);
    return;
  }

  const sameParticipants = prevEvent
    ? participantsHaveSamePersonIds(prevEvent.participants, redacted.participants)
    : false;
  const sortOrderChanged = prevEvent ? compareArchiveEvents(prevEvent, redacted) !== 0 : true;
  if (!prevEvent || !sameParticipants || prevEvent.place_id !== redacted.place_id || sortOrderChanged) {
    if (prevEvent) {
      for (const pt of prevEvent.participants) {
        state.affectedEventCountPersonIds.add(pt.person_id);
      }
    }
    for (const pt of redacted.participants) {
      state.affectedEventCountPersonIds.add(pt.person_id);
    }
  }

  // Only mark residence spans dirty if a residence_anchor was created/changed/removed.
  const involvesResidenceAnchor =
    prevEvent?.event_kind === 'residence_anchor' || redacted.event_kind === 'residence_anchor';
  if (
    involvesResidenceAnchor &&
    (!prevEvent ||
      !sameParticipants ||
      prevEvent.event_kind !== redacted.event_kind ||
      prevEvent.place_id !== redacted.place_id ||
      prevEvent.edtf_date !== redacted.edtf_date ||
      prevEvent.time_min !== redacted.time_min ||
      prevEvent.time_max !== redacted.time_max)
  ) {
    if (prevEvent && prevEvent.event_kind === 'residence_anchor') {
      for (const pt of prevEvent.participants) {
        state.affectedSpanPersonIds.add(pt.person_id);
      }
    }
    if (redacted.event_kind === 'residence_anchor') {
      for (const pt of redacted.participants) {
        state.affectedSpanPersonIds.add(pt.person_id);
      }
    }
  }

  if (!redacted.photo_url) {
    if (!prevEvent || state.mediaMutated || prevEvent.photo_url) {
      state.affectedMediaEventIds.add(redacted.id);
    }
  }

  if (existingIdx !== undefined && prevEvent) {
    if (!sortOrderChanged) {
      state.events[existingIdx] = redacted;
    } else {
      state.events.splice(existingIdx, 1);
      const insertIdx = binarySearchEventInsertIndex(state.events, redacted);
      state.events.splice(insertIdx, 0, redacted);
      state.invalidateEventsIndex();
    }
  } else {
    const insertIdx = binarySearchEventInsertIndex(state.events, redacted);
    state.events.splice(insertIdx, 0, redacted);
    state.invalidateEventsIndex();
  }
  updateUncitedKey(state.uncitedKeys, 'event', entity_id, effectiveHasPrimary, false, state);
}

function applyMediaMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  const { entity_id, after_json } = mutation;
  state.mediaMutated = true;
  const existingIdx = state.media.findIndex((m) => m.id === entity_id);
  const prevMedia = existingIdx !== -1 ? state.media[existingIdx] : null;
  if (prevMedia) {
    for (const pid of getMediaPersonIds(prevMedia)) {
      state.affectedMediaPersonIds.add(pid);
      if (prevMedia.kind === 'portrait') {
        const urls = state.deletedPortraitUrlByPerson.get(pid) ?? new Set<string>();
        urls.add(prevMedia.file);
        state.deletedPortraitUrlByPerson.set(pid, urls);
      }
    }
    if (prevMedia.event_id && EVENT_HERO_MEDIA_KINDS.has(prevMedia.kind)) {
      state.affectedMediaEventIds.add(prevMedia.event_id);
      const urls = state.deletedHeroPhotoByEvent.get(prevMedia.event_id) ?? new Set<string>();
      urls.add(prevMedia.file);
      state.deletedHeroPhotoByEvent.set(prevMedia.event_id, urls);
    }
  }

  if (after_json === null) {
    if (existingIdx !== -1) {
      state.media.splice(existingIdx, 1);
    }
    updateUncitedKey(state.uncitedKeys, 'media', entity_id, undefined, true, state);
    return;
  }

  const parsed: MediaItem = cloneMedia(parseEntityPayload('media', after_json));
  const effectiveHasPrimary = resolveEffectivePrimarySource(parsed, mutation.has_primary_source);

  if (!ALLOWED_MANUAL_MEDIA_KINDS.has(parsed.kind) || !parsed.file) {
    if (existingIdx !== -1) {
      state.media.splice(existingIdx, 1);
    }
    updateUncitedKey(state.uncitedKeys, 'media', entity_id, undefined, true, state);
    return;
  }

  const { idxById } = state.ensurePeopleIndex();
  const peopleLookup = new Map<string, Person>();
  for (const pid of getMediaPersonIds(parsed)) {
    const pIdx = idxById.get(pid);
    if (pIdx !== undefined) {
      peopleLookup.set(pid, state.people[pIdx]);
    }
  }
  let eventsLookup: Map<string, ArchiveEvent> | undefined;
  if (parsed.event_id) {
    const eIdx = state.ensureEventsIndex().get(parsed.event_id);
    if (eIdx !== undefined) {
      const ev = state.events[eIdx];
      eventsLookup = new Map([[ev.id, ev]]);
      for (const pt of ev.participants) {
        const pIdx = idxById.get(pt.person_id);
        if (pIdx !== undefined) {
          peopleLookup.set(pt.person_id, state.people[pIdx]);
        }
      }
    }
  }

  const [filtered] = filterMediaForPrivacy([parsed], peopleLookup, eventsLookup, {
    cloneInputs: false,
    stripLivingPortraits: state.stripLivingPortraits,
  });

  if (!filtered) {
    if (existingIdx !== -1) {
      state.media.splice(existingIdx, 1);
    }
    updateUncitedKey(state.uncitedKeys, 'media', entity_id, undefined, true, state);
    return;
  }

  if (existingIdx !== -1) {
    state.media[existingIdx] = filtered;
  } else {
    state.media.push(filtered);
  }
  for (const pid of getMediaPersonIds(filtered)) {
    state.affectedMediaPersonIds.add(pid);
  }
  if (filtered.event_id && EVENT_HERO_MEDIA_KINDS.has(filtered.kind)) {
    state.affectedMediaEventIds.add(filtered.event_id);
  }
  updateUncitedKey(state.uncitedKeys, 'media', entity_id, effectiveHasPrimary, false, state);
}

const ENTITY_MUTATORS: {
  [K in BundlePatchMutation['entity_type']]: (
    state: PatchWorkingState,
    mutation: BundlePatchMutation
  ) => void;
} = {
  source: applySourceMutation,
  narrative: applyNarrativeMutation,
  kinship_edge: applyKinshipMutation,
  place: applyPlaceMutation,
  person: applyPersonMutation,
  event: applyEventMutation,
  media: applyMediaMutation,
};

export function applyPatchMutation(state: PatchWorkingState, mutation: BundlePatchMutation): void {
  ENTITY_MUTATORS[mutation.entity_type](state, mutation);
}
