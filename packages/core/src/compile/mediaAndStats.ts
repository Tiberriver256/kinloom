import { edtfYear } from '../edtf.js';
import { filterMediaForPrivacy } from '../privacy.js';
import type { ArchiveEvent, MediaItem, Person, RawPerson } from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/pureHelpers.js';
import { cloneMedia } from './snapshot.js';
import { ALLOWED_MANUAL_MEDIA_KINDS, type CompiledMediaOverlay, EVENT_HERO_MEDIA_KINDS } from './types.js';

function populatePeopleSummariesCore(
  redactedRawPeople: readonly RawPerson[],
  sortedEvents: readonly ArchiveEvent[],
  mutateInPlace: boolean
): Person[] {
  const eventsByPerson = new Map<string, ArchiveEvent[]>();
  const pushPersonEvent = (personId: string, ev: ArchiveEvent): void => {
    let list = eventsByPerson.get(personId);
    if (!list) {
      list = [ev];
      eventsByPerson.set(personId, list);
    } else {
      list.push(ev);
    }
  };

  for (let i = 0; i < sortedEvents.length; i += 1) {
    const ev = sortedEvents[i];
    const pts = ev.participants;
    const pLen = pts.length;
    if (pLen === 0) {
      continue;
    }
    if (pLen === 1) {
      pushPersonEvent(pts[0].person_id, ev);
      continue;
    }
    if (pLen === 2) {
      const p0 = pts[0].person_id;
      const p1 = pts[1].person_id;
      pushPersonEvent(p0, ev);
      if (p1 !== p0) {
        pushPersonEvent(p1, ev);
      }
      continue;
    }
    const seenInEvent = new Set<string>();
    for (let j = 0; j < pLen; j += 1) {
      const pid = pts[j].person_id;
      if (seenInEvent.has(pid)) {
        continue;
      }
      seenInEvent.add(pid);
      pushPersonEvent(pid, ev);
    }
  }

  const placeCounts = new Map<string, number>();
  const out: Person[] = mutateInPlace
    ? (redactedRawPeople as Person[])
    : new Array<Person>(redactedRawPeople.length);

  for (let i = 0; i < redactedRawPeople.length; i += 1) {
    const p = redactedRawPeople[i];
    const pEvts = eventsByPerson.get(p.id);
    let primaryPlaceId: string | null = null;
    let eventCount = 0;

    if (pEvts && pEvts.length > 0) {
      eventCount = pEvts.length;
      if (eventCount === 1) {
        primaryPlaceId = pEvts[0].place_id ?? null;
      } else if (eventCount === 2) {
        primaryPlaceId = pEvts[0].place_id || pEvts[1].place_id || null;
      } else {
        placeCounts.clear();
        let bestCount = -1;
        for (let j = 0; j < eventCount; j += 1) {
          const pid = pEvts[j].place_id;
          if (pid) {
            const nextCount = (placeCounts.get(pid) ?? 0) + 1;
            placeCounts.set(pid, nextCount);
            if (nextCount > bestCount) {
              bestCount = nextCount;
              primaryPlaceId = pid;
            }
          }
        }
      }
    }

    if (mutateInPlace) {
      const target = p as Person;
      target.birth_year = edtfYear(p.birth_edtf);
      target.death_year = edtfYear(p.death_edtf);
      target.event_count = eventCount;
      target.media_count = 0;
      target.primary_place_id = primaryPlaceId;
    } else {
      out[i] = {
        ...p,
        birth_year: edtfYear(p.birth_edtf),
        death_year: edtfYear(p.death_edtf),
        event_count: eventCount,
        media_count: 0,
        primary_place_id: primaryPlaceId,
      };
    }
  }
  return out;
}

export function compilePeopleSummaries(
  redactedRawPeople: readonly RawPerson[],
  sortedEvents: readonly ArchiveEvent[]
): Person[] {
  return populatePeopleSummariesCore(redactedRawPeople, sortedEvents, false);
}

export function compilePeopleSummariesInPlace(
  redactedRawPeople: RawPerson[],
  sortedEvents: readonly ArchiveEvent[]
): Person[] {
  return populatePeopleSummariesCore(redactedRawPeople, sortedEvents, true);
}

export function compileAndAttachMedia(params: {
  compiledPeople: Person[];
  sortedEvents: ArchiveEvent[];
  peopleById: ReadonlyMap<string, Person>;
  eventsById: ReadonlyMap<string, ArchiveEvent>;
  livingIds: ReadonlySet<string>;
  stripLivingPortraits: boolean;
  compiledMediaOverlay?: CompiledMediaOverlay | null;
  media?: readonly MediaItem[];
  resolveThumbUrl?: (mediaUrl: string | null | undefined) => string | undefined;
  mediaExists?: (fileUrl: string) => boolean;
}): MediaItem[] {
  const {
    compiledPeople,
    sortedEvents,
    peopleById,
    eventsById,
    livingIds,
    stripLivingPortraits,
    compiledMediaOverlay,
    media,
    resolveThumbUrl,
    mediaExists,
  } = params;

  // Fast path when neither legacy compiledMediaOverlay nor custom thumb/file hooks are present.
  if (!compiledMediaOverlay && !resolveThumbUrl && !mediaExists) {
    if (!media || media.length === 0) {
      if (stripLivingPortraits && livingIds.size > 0) {
        for (let i = 0; i < compiledPeople.length; i += 1) {
          const person = compiledPeople[i];
          if (person.is_living) {
            person.portrait_url = null;
            person.thumb_url = null;
            person.media_count = 0;
          }
        }
      }
      return [];
    }

    const finalMedia: MediaItem[] = [];
    const seenMediaIds = new Set<string>();
    const mediaCounts = new Map<string, number>();
    const portraitFromMedia = new Map<string, string>();
    const eventPhotoFromMedia = new Map<string, MediaItem>();

    for (let i = 0; i < media.length; i += 1) {
      const item = media[i];
      if (!ALLOWED_MANUAL_MEDIA_KINDS.has(item.kind) || !item.file || seenMediaIds.has(item.id)) {
        continue;
      }
      seenMediaIds.add(item.id);

      const personIds = getMediaPersonIds(item);
      let blocked = false;
      for (let j = 0; j < personIds.length; j += 1) {
        const person = peopleById.get(personIds[j]);
        if (!person || (stripLivingPortraits && person.is_living)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        continue;
      }
      if (stripLivingPortraits && item.event_id) {
        const ev = eventsById.get(item.event_id);
        if (ev) {
          let evBlocked = false;
          for (let j = 0; j < ev.participants.length; j += 1) {
            if (livingIds.has(ev.participants[j].person_id)) {
              evBlocked = true;
              break;
            }
          }
          if (evBlocked) {
            continue;
          }
        }
      }

      const clone = cloneMedia(item);
      if (clone.person_id) {
        const target = peopleById.get(clone.person_id);
        if (target) {
          if (target.full_name) {
            clone.person_name = target.full_name;
          }
          if (target.slug) {
            clone.person_slug = target.slug;
          }
        }
      }
      finalMedia.push(clone);

      for (let j = 0; j < personIds.length; j += 1) {
        const pid = personIds[j];
        mediaCounts.set(pid, (mediaCounts.get(pid) ?? 0) + 1);
        if (clone.kind === 'portrait' && !portraitFromMedia.has(pid)) {
          portraitFromMedia.set(pid, clone.file);
        }
      }
      if (
        clone.event_id &&
        EVENT_HERO_MEDIA_KINDS.has(clone.kind) &&
        !eventPhotoFromMedia.has(clone.event_id)
      ) {
        eventPhotoFromMedia.set(clone.event_id, clone);
      }
    }

    for (let i = 0; i < compiledPeople.length; i += 1) {
      const person = compiledPeople[i];
      if (person.is_living && stripLivingPortraits) {
        person.portrait_url = null;
        person.thumb_url = null;
        person.media_count = 0;
        continue;
      }
      if (!person.portrait_url) {
        const mediaPortrait = portraitFromMedia.get(person.id);
        if (mediaPortrait) {
          person.portrait_url = mediaPortrait;
        }
      }
      person.media_count = mediaCounts.get(person.id) ?? 0;
    }

    if (eventPhotoFromMedia.size > 0) {
      const hasLivingSet = livingIds.size > 0;
      for (let i = 0; i < sortedEvents.length; i += 1) {
        const ev = sortedEvents[i];
        if (ev.photo_url) {
          continue;
        }
        const mediaPhoto = eventPhotoFromMedia.get(ev.id);
        if (!mediaPhoto) {
          continue;
        }
        if (hasLivingSet && stripLivingPortraits) {
          let hasLiving = false;
          for (let j = 0; j < ev.participants.length; j += 1) {
            if (livingIds.has(ev.participants[j].person_id)) {
              hasLiving = true;
              break;
            }
          }
          if (hasLiving) {
            continue;
          }
        }
        ev.photo_url = mediaPhoto.file;
        if (mediaPhoto.caption) {
          ev.photo_placeholder_caption = mediaPhoto.caption;
        }
      }
    }

    return finalMedia;
  }

  const mergedMedia: MediaItem[] = [];
  const seenMediaIds = new Set<string>();
  const compiledPortraitByPerson = new Map<string, string>();
  const compiledPhotoByEvent = new Map<string, string>();
  const captionByFile = new Map<string, string>();

  if (compiledMediaOverlay) {
    for (const item of compiledMediaOverlay.media ?? []) {
      if (mediaExists && item.file.startsWith('/media/') && !mediaExists(item.file)) {
        continue;
      }
      const clone = cloneMedia(item);
      mergedMedia.push(clone);
      if (clone.id) {
        seenMediaIds.add(clone.id);
      }
      if (clone.file && clone.caption && !captionByFile.has(clone.file)) {
        captionByFile.set(clone.file, clone.caption);
      }
    }
    for (const p of compiledMediaOverlay.people ?? []) {
      if (p.id && p.portrait_url) {
        compiledPortraitByPerson.set(p.id, p.portrait_url);
      }
    }
    for (const ev of compiledMediaOverlay.events ?? []) {
      if (ev.id && ev.photo_url) {
        compiledPhotoByEvent.set(ev.id, ev.photo_url);
      }
    }
  }

  for (const item of media ?? []) {
    if (!ALLOWED_MANUAL_MEDIA_KINDS.has(item.kind) || !item.file) {
      continue;
    }
    if (seenMediaIds.has(item.id)) {
      continue;
    }
    if (mediaExists && item.file.startsWith('/media/') && !mediaExists(item.file)) {
      continue;
    }
    const clone = cloneMedia(item);
    mergedMedia.push(clone);
    seenMediaIds.add(clone.id);
    if (clone.file && clone.caption && !captionByFile.has(clone.file)) {
      captionByFile.set(clone.file, clone.caption);
    }
  }

  const finalMedia = filterMediaForPrivacy(mergedMedia, peopleById, eventsById, {
    cloneInputs: false,
    stripLivingPortraits,
  });

  const mediaCounts = new Map<string, number>();
  const portraitFromMedia = new Map<string, string>();
  const eventPhotoFromMedia = new Map<string, { file: string; caption: string }>();
  const overlayMediaIds = compiledMediaOverlay?.media
    ? new Set(compiledMediaOverlay.media.map((m) => m.id).filter(Boolean))
    : null;

  for (let i = 0; i < finalMedia.length; i += 1) {
    const item = finalMedia[i];
    if (resolveThumbUrl) {
      const thumb = resolveThumbUrl(item.file);
      if (thumb) {
        item.thumb_file = thumb;
      } else {
        delete item.thumb_file;
      }
    }
    const personIds = getMediaPersonIds(item);
    for (let j = 0; j < personIds.length; j += 1) {
      const pid = personIds[j];
      mediaCounts.set(pid, (mediaCounts.get(pid) ?? 0) + 1);
      if (item.kind === 'portrait' && !portraitFromMedia.has(pid)) {
        portraitFromMedia.set(pid, item.file);
      }
    }
    if (
      item.event_id &&
      !overlayMediaIds?.has(item.id) &&
      EVENT_HERO_MEDIA_KINDS.has(item.kind) &&
      !eventPhotoFromMedia.has(item.event_id)
    ) {
      eventPhotoFromMedia.set(item.event_id, {
        file: item.file,
        caption: item.caption,
      });
    }
  }

  for (let i = 0; i < compiledPeople.length; i += 1) {
    const person = compiledPeople[i];
    if (person.is_living && stripLivingPortraits) {
      person.portrait_url = null;
      person.thumb_url = null;
      person.media_count = 0;
      continue;
    }
    if (!person.portrait_url) {
      const overlayPortrait = compiledPortraitByPerson.get(person.id);
      const mediaPortrait = portraitFromMedia.get(person.id);
      if (overlayPortrait) {
        person.portrait_url = overlayPortrait;
      } else if (mediaPortrait) {
        person.portrait_url = mediaPortrait;
      }
    }
    if (resolveThumbUrl) {
      const thumb = resolveThumbUrl(person.portrait_url);
      if (thumb) {
        person.thumb_url = thumb;
      } else {
        delete person.thumb_url;
      }
    }
    person.media_count = mediaCounts.get(person.id) ?? 0;
  }

  const hasLivingSet = livingIds.size > 0;
  for (let i = 0; i < sortedEvents.length; i += 1) {
    const ev = sortedEvents[i];
    if (ev.photo_url) {
      continue;
    }
    if (hasLivingSet && stripLivingPortraits) {
      let hasLiving = false;
      for (let j = 0; j < ev.participants.length; j += 1) {
        if (livingIds.has(ev.participants[j].person_id)) {
          hasLiving = true;
          break;
        }
      }
      if (hasLiving) {
        continue;
      }
    }
    const overlayPhoto = compiledPhotoByEvent.get(ev.id);
    if (overlayPhoto) {
      ev.photo_url = overlayPhoto;
      const caption = captionByFile.get(overlayPhoto);
      if (caption) {
        ev.photo_placeholder_caption = caption;
      }
      continue;
    }
    const mediaPhoto = eventPhotoFromMedia.get(ev.id);
    if (mediaPhoto) {
      ev.photo_url = mediaPhoto.file;
      if (mediaPhoto.caption) {
        ev.photo_placeholder_caption = mediaPhoto.caption;
      }
    }
  }

  return finalMedia;
}
