import { EVENT_HERO_MEDIA_KINDS } from '../compileArchive.js';
import {
  collectLivingNames,
  compileLivingNamePattern,
  redactSingleEvent,
  redactSingleNarrative,
} from '../privacy.js';
import {
  buildPlaceAncestors,
  deriveResidenceSpansForPerson,
  type ResidenceAnchor,
  samePlaceOrWithin15Miles,
} from '../residenceSpans.js';
import type { ArchiveEvent, Place, ResidenceSpan } from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/pureHelpers.js';
import { arraysEqualStrings, type PatchWorkingState, updateUncitedKey } from './patchState.js';

export function reconcileNewlyLivingEntities(state: PatchWorkingState): void {
  if (state.newlyLivingPersonIds.size === 0) {
    return;
  }
  const { living } = state.ensurePeopleIndex();
  const extraLivingNames = collectLivingNames(
    [...state.newlyLivingNamesById.values()].map((entry) => ({
      is_living: true,
      full_name: entry.full_name,
      alt_names: entry.alt_names,
    }))
  );
  const livingPattern =
    state.mode === 'public'
      ? compileLivingNamePattern([...new Set([...collectLivingNames(state.people), ...extraLivingNames])])
      : null;

  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const ev = state.events[i];
    if (!ev.participants.some((pt) => state.newlyLivingPersonIds.has(pt.person_id))) {
      continue;
    }
    const redacted = redactSingleEvent(ev, living, livingPattern, state.mode, {
      privacy: state.privacy,
      clone: true,
    });
    for (const pt of ev.participants) {
      state.affectedEventCountPersonIds.add(pt.person_id);
      if (ev.event_kind === 'residence_anchor') {
        state.affectedSpanPersonIds.add(pt.person_id);
      }
    }
    if (!redacted) {
      state.events.splice(i, 1);
      updateUncitedKey(state.uncitedKeys, 'event', ev.id, undefined, true, state);
      state.invalidateEventsIndex();
    } else {
      state.events[i] = redacted;
    }
  }

  if (state.narratives) {
    for (let i = 0; i < state.narratives.length; i += 1) {
      const nar = state.narratives[i];
      const hitsNewlyLiving =
        (nar.subject_person_id !== undefined && state.newlyLivingPersonIds.has(nar.subject_person_id)) ||
        nar.person_ids.some((pid) => state.newlyLivingPersonIds.has(pid));
      if (!hitsNewlyLiving) {
        continue;
      }
      state.narratives[i] = redactSingleNarrative(nar, living, livingPattern, state.mode, { clone: true });
    }
  }
}

export function reconcileAffectedMedia(state: PatchWorkingState): void {
  if (
    state.deletedPersonIds.size === 0 &&
    !(state.newlyLivingPersonIds.size > 0 && state.stripLivingPortraits) &&
    state.renamedPersonIds.size === 0
  ) {
    return;
  }

  const { idxById, living } = state.ensurePeopleIndex();
  const evIdxMap = state.ensureEventsIndex();
  for (let i = state.media.length - 1; i >= 0; i -= 1) {
    const item = state.media[i];
    const linkedPids = getMediaPersonIds(item);
    let drop = false;
    for (const pid of linkedPids) {
      if (state.deletedPersonIds.has(pid) || (state.stripLivingPortraits && living.has(pid))) {
        drop = true;
        break;
      }
    }
    if (!drop && state.stripLivingPortraits && item.event_id) {
      const eIdx = evIdxMap.get(item.event_id);
      if (eIdx !== undefined && state.events[eIdx].participants.some((pt) => living.has(pt.person_id))) {
        drop = true;
      }
    }
    if (drop) {
      state.media.splice(i, 1);
      state.mediaMutated = true;
      updateUncitedKey(state.uncitedKeys, 'media', item.id, undefined, true, state);
      for (const pid of linkedPids) {
        state.affectedMediaPersonIds.add(pid);
        if (item.kind === 'portrait') {
          const urls = state.deletedPortraitUrlByPerson.get(pid) ?? new Set<string>();
          urls.add(item.file);
          state.deletedPortraitUrlByPerson.set(pid, urls);
        }
      }
      if (item.event_id && EVENT_HERO_MEDIA_KINDS.has(item.kind)) {
        state.affectedMediaEventIds.add(item.event_id);
        const urls = state.deletedHeroPhotoByEvent.get(item.event_id) ?? new Set<string>();
        urls.add(item.file);
        state.deletedHeroPhotoByEvent.set(item.event_id, urls);
      }
    } else if (item.person_id && state.renamedPersonIds.has(item.person_id)) {
      const pIdx = idxById.get(item.person_id);
      if (pIdx !== undefined) {
        const target = state.people[pIdx];
        state.mediaMutated = true;
        state.media[i] = {
          ...item,
          ...(target.full_name ? { person_name: target.full_name } : {}),
          ...(target.slug ? { person_slug: target.slug } : {}),
        };
      }
    }
  }
}

export function reconcilePlaceAncestorsAndSpans(state: PatchWorkingState): void {
  if (!state.placesMutated) {
    return;
  }
  const pMap = state.ensurePlacesById();
  const prevAncestors = state.previousBundle.place_ancestors;
  state.placeAncestors = buildPlaceAncestors(pMap);

  const changedAncestorPlaceIds = new Set<string>();
  for (const pid of Object.keys(state.placeAncestors)) {
    if (!arraysEqualStrings(prevAncestors[pid], state.placeAncestors[pid])) {
      changedAncestorPlaceIds.add(pid);
    }
  }
  for (const pid of Object.keys(prevAncestors)) {
    if (!(pid in state.placeAncestors)) {
      changedAncestorPlaceIds.add(pid);
    }
  }

  const oldPlacesById = new Map<string, Place>(pMap);
  for (const [pid, oldPlace] of state.placesBeforeMutation.entries()) {
    oldPlacesById.set(pid, oldPlace);
  }

  for (let i = 0; i < state.events.length; i += 1) {
    const ev = state.events[i];
    if (ev.place_id && changedAncestorPlaceIds.has(ev.place_id)) {
      state.events[i] = {
        ...ev,
        place_ancestors: [...(state.placeAncestors[ev.place_id] ?? [])],
      };
    }
    if (ev.event_kind === 'residence_anchor' && ev.place_id) {
      let placeProximityAffected = state.mutatedPlaceIds.has(ev.place_id);
      if (!placeProximityAffected) {
        for (const mPid of state.mutatedPlaceIds) {
          if (
            samePlaceOrWithin15Miles(pMap, ev.place_id, mPid) ||
            samePlaceOrWithin15Miles(oldPlacesById, ev.place_id, mPid) ||
            pMap.get(ev.place_id)?.parent_id === mPid ||
            oldPlacesById.get(ev.place_id)?.parent_id === mPid
          ) {
            placeProximityAffected = true;
            break;
          }
        }
      }
      if (placeProximityAffected) {
        for (const pt of ev.participants) {
          state.affectedSpanPersonIds.add(pt.person_id);
        }
      }
    }
  }
}

function reconcileEventCounts(state: PatchWorkingState): void {
  if (state.affectedEventCountPersonIds.size === 0) {
    return;
  }
  const { idxById } = state.ensurePeopleIndex();
  const eventCounts = new Map<string, number>();
  const placeCountsByPerson = new Map<string, Map<string, number>>();
  for (const pid of state.affectedEventCountPersonIds) {
    eventCounts.set(pid, 0);
    placeCountsByPerson.set(pid, new Map<string, number>());
  }

  for (const ev of state.events) {
    const pts = ev.participants;
    if (pts.length === 1) {
      const pid = pts[0].person_id;
      if (state.affectedEventCountPersonIds.has(pid)) {
        eventCounts.set(pid, (eventCounts.get(pid) ?? 0) + 1);
        if (ev.place_id) {
          const pCounts = placeCountsByPerson.get(pid);
          if (pCounts) {
            pCounts.set(ev.place_id, (pCounts.get(ev.place_id) ?? 0) + 1);
          }
        }
      }
      continue;
    }
    let matchedAny = false;
    for (const pt of pts) {
      if (state.affectedEventCountPersonIds.has(pt.person_id)) {
        matchedAny = true;
        break;
      }
    }
    if (!matchedAny) {
      continue;
    }
    const seenInEvent = new Set<string>();
    for (const pt of pts) {
      if (!state.affectedEventCountPersonIds.has(pt.person_id) || seenInEvent.has(pt.person_id)) {
        continue;
      }
      seenInEvent.add(pt.person_id);
      eventCounts.set(pt.person_id, (eventCounts.get(pt.person_id) ?? 0) + 1);
      if (ev.place_id) {
        const pCounts = placeCountsByPerson.get(pt.person_id);
        if (pCounts) {
          pCounts.set(ev.place_id, (pCounts.get(ev.place_id) ?? 0) + 1);
        }
      }
    }
  }

  for (const pid of state.affectedEventCountPersonIds) {
    const pIdx = idxById.get(pid);
    if (pIdx === undefined) {
      continue;
    }
    const pCounts = placeCountsByPerson.get(pid);
    let primaryPlaceId: string | null = null;
    let bestCount = -1;
    if (pCounts) {
      for (const [placeId, count] of pCounts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          primaryPlaceId = placeId;
        }
      }
    }
    const prev = state.people[pIdx];
    const nextCount = eventCounts.get(pid) ?? 0;
    if (prev.event_count !== nextCount || prev.primary_place_id !== primaryPlaceId) {
      state.people[pIdx] = {
        ...prev,
        event_count: nextCount,
        primary_place_id: primaryPlaceId,
      };
    }
  }
}

function reconcilePersonMediaStats(state: PatchWorkingState): void {
  if (state.affectedMediaPersonIds.size === 0) {
    return;
  }
  const { idxById } = state.ensurePeopleIndex();
  const mediaCounts = new Map<string, number>();
  const portraitFromMedia = new Map<string, string>();

  for (const item of state.media) {
    const pids = getMediaPersonIds(item);
    for (const pid of pids) {
      if (!state.affectedMediaPersonIds.has(pid)) {
        continue;
      }
      mediaCounts.set(pid, (mediaCounts.get(pid) ?? 0) + 1);
      if (item.kind === 'portrait' && !portraitFromMedia.has(pid)) {
        portraitFromMedia.set(pid, item.file);
      }
    }
  }

  for (const pid of state.affectedMediaPersonIds) {
    const pIdx = idxById.get(pid);
    if (pIdx === undefined) {
      continue;
    }
    const prev = state.people[pIdx];
    if (prev.is_living && state.stripLivingPortraits) {
      if (prev.portrait_url !== null || prev.media_count !== 0 || prev.thumb_url !== null) {
        state.people[pIdx] = { ...prev, portrait_url: null, thumb_url: null, media_count: 0 };
      }
      continue;
    }
    const nextMediaCount = mediaCounts.get(pid) ?? 0;
    let nextPortrait = prev.portrait_url;
    const deletedUrls = state.deletedPortraitUrlByPerson.get(pid);
    if (
      deletedUrls &&
      nextPortrait &&
      deletedUrls.has(nextPortrait) &&
      !state.explicitPortraitPersonIds.has(pid)
    ) {
      nextPortrait = portraitFromMedia.get(pid) ?? null;
    } else if (!nextPortrait) {
      nextPortrait = portraitFromMedia.get(pid) ?? null;
    }
    if (prev.media_count !== nextMediaCount || prev.portrait_url !== nextPortrait) {
      state.people[pIdx] = {
        ...prev,
        media_count: nextMediaCount,
        portrait_url: nextPortrait,
      };
    }
  }
}

function reconcileEventHeroPhotos(state: PatchWorkingState): void {
  if (state.affectedMediaEventIds.size === 0) {
    return;
  }
  const { living } = state.ensurePeopleIndex();
  const evIdxMap = state.ensureEventsIndex();
  const heroByEvent = new Map<string, { file: string; caption: string }>();

  for (const item of state.media) {
    if (
      item.event_id &&
      state.affectedMediaEventIds.has(item.event_id) &&
      EVENT_HERO_MEDIA_KINDS.has(item.kind) &&
      !heroByEvent.has(item.event_id)
    ) {
      heroByEvent.set(item.event_id, { file: item.file, caption: item.caption });
    }
  }

  for (const evId of state.affectedMediaEventIds) {
    const eIdx = evIdxMap.get(evId);
    if (eIdx === undefined) {
      continue;
    }
    const prev = state.events[eIdx];
    const hasLiving = prev.participants.some((pt) => living.has(pt.person_id));
    const deletedHeroUrls = state.deletedHeroPhotoByEvent.get(evId);
    if (hasLiving && state.stripLivingPortraits) {
      if (deletedHeroUrls && prev.photo_placeholder_caption !== undefined) {
        const updated: ArchiveEvent = { ...prev };
        delete updated.photo_placeholder_caption;
        state.events[eIdx] = updated;
      }
      continue;
    }
    let nextPhoto = prev.photo_url;
    let nextCaption = prev.photo_placeholder_caption;
    if (deletedHeroUrls && nextPhoto && deletedHeroUrls.has(nextPhoto)) {
      const replacement = heroByEvent.get(evId);
      nextPhoto = replacement?.file;
      nextCaption = replacement?.caption || undefined;
    } else if (!nextPhoto) {
      const fallback = heroByEvent.get(evId);
      if (fallback) {
        nextPhoto = fallback.file;
        if (fallback.caption) {
          nextCaption = fallback.caption;
        }
      }
    }
    if (nextPhoto !== prev.photo_url || nextCaption !== prev.photo_placeholder_caption) {
      const updated: ArchiveEvent = { ...prev };
      if (nextPhoto !== undefined) {
        updated.photo_url = nextPhoto;
      } else {
        delete updated.photo_url;
      }
      if (nextCaption !== undefined) {
        updated.photo_placeholder_caption = nextCaption;
      } else {
        delete updated.photo_placeholder_caption;
      }
      state.events[eIdx] = updated;
    }
  }
}

export function reconcilePersonAndEventDerivedStats(state: PatchWorkingState): void {
  reconcileEventCounts(state);
  reconcilePersonMediaStats(state);
  reconcileEventHeroPhotos(state);
}

export function reconcileResidenceSpans(state: PatchWorkingState): void {
  if (state.affectedSpanPersonIds.size === 0) {
    return;
  }
  const { idxById } = state.ensurePeopleIndex();
  const pMap = state.ensurePlacesById();
  const anchorsByPerson = new Map<string, ResidenceAnchor[]>();

  for (const ev of state.events) {
    if (
      ev.event_kind !== 'residence_anchor' ||
      ev.time_min === null ||
      ev.time_max === null ||
      !ev.place_id
    ) {
      continue;
    }
    for (const pt of ev.participants) {
      if (!state.affectedSpanPersonIds.has(pt.person_id)) {
        continue;
      }
      const list = anchorsByPerson.get(pt.person_id) ?? [];
      list.push({
        id: ev.id,
        edtf_date: ev.edtf_date,
        place_id: ev.place_id,
        time_min: ev.time_min,
        time_max: ev.time_max,
      });
      anchorsByPerson.set(pt.person_id, list);
    }
  }

  const recomputedSpansByPerson = new Map<string, ResidenceSpan[]>();
  for (const pid of state.affectedSpanPersonIds) {
    const pIdx = idxById.get(pid);
    if (pIdx === undefined) {
      recomputedSpansByPerson.set(pid, []);
      continue;
    }
    const person = state.people[pIdx];
    if (!state.includeLivingSpans && person.is_living) {
      recomputedSpansByPerson.set(pid, []);
      continue;
    }
    const anchors = anchorsByPerson.get(pid);
    recomputedSpansByPerson.set(
      pid,
      anchors && anchors.length >= 2 ? deriveResidenceSpansForPerson(pid, anchors, pMap, 0) : []
    );
  }

  const existingSpansByPerson = new Map<string, ResidenceSpan[]>();
  for (const span of state.previousBundle.residence_spans) {
    if (state.affectedSpanPersonIds.has(span.person_id) || state.deletedPersonIds.has(span.person_id)) {
      continue;
    }
    const list = existingSpansByPerson.get(span.person_id) ?? [];
    list.push(span);
    existingSpansByPerson.set(span.person_id, list);
  }

  const nextSpans: ResidenceSpan[] = [];
  let spanIdx = 0;
  for (const person of state.people) {
    const personSpans = state.affectedSpanPersonIds.has(person.id)
      ? (recomputedSpansByPerson.get(person.id) ?? [])
      : (existingSpansByPerson.get(person.id) ?? []);
    for (const span of personSpans) {
      spanIdx += 1;
      const expectedId = `span_${String(spanIdx).padStart(4, '0')}`;
      nextSpans.push(span.id === expectedId ? span : { ...span, id: expectedId });
    }
  }
  state.residenceSpans = nextSpans;
}
