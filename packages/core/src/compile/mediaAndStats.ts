import { edtfYear } from '../edtf.js';
import { filterMediaForPrivacy } from '../privacy.js';
import type { ArchiveEvent, MediaItem, Person, RawPerson } from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/entities.js';
import { cloneMedia } from './snapshot.js';
import { ALLOWED_MANUAL_MEDIA_KINDS, type CompiledMediaOverlay, EVENT_HERO_MEDIA_KINDS } from './types.js';

export function compilePeopleSummaries(
  redactedRawPeople: readonly RawPerson[],
  sortedEvents: readonly ArchiveEvent[]
): Person[] {
  const eventsByPerson = new Map<string, ArchiveEvent[]>();
  for (const ev of sortedEvents) {
    const seenInEvent = new Set<string>();
    for (const pt of ev.participants) {
      if (seenInEvent.has(pt.person_id)) {
        continue;
      }
      seenInEvent.add(pt.person_id);
      const list = eventsByPerson.get(pt.person_id) ?? [];
      list.push(ev);
      eventsByPerson.set(pt.person_id, list);
    }
  }

  return redactedRawPeople.map((p) => {
    const pEvts = eventsByPerson.get(p.id) ?? [];
    const placeCounts = new Map<string, number>();
    for (const ev of pEvts) {
      if (ev.place_id) {
        placeCounts.set(ev.place_id, (placeCounts.get(ev.place_id) ?? 0) + 1);
      }
    }
    let primaryPlaceId: string | null = null;
    let bestCount = -1;
    for (const [placeId, count] of placeCounts.entries()) {
      if (count > bestCount) {
        bestCount = count;
        primaryPlaceId = placeId;
      }
    }

    return {
      ...p,
      birth_year: edtfYear(p.birth_edtf),
      death_year: edtfYear(p.death_edtf),
      event_count: pEvts.length,
      media_count: 0,
      primary_place_id: primaryPlaceId,
    };
  });
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

  // Filter media for living-person privacy in place on already-cloned mergedMedia
  const finalMedia = filterMediaForPrivacy(mergedMedia, peopleById, eventsById, {
    cloneInputs: false,
    stripLivingPortraits,
  });

  const mediaCounts = new Map<string, number>();
  const portraitFromMedia = new Map<string, string>();
  const eventPhotoFromMedia = new Map<string, { file: string; caption: string }>();
  const overlayMediaIds = new Set((compiledMediaOverlay?.media ?? []).map((m) => m.id).filter(Boolean));

  for (const item of finalMedia) {
    if (resolveThumbUrl) {
      const thumb = resolveThumbUrl(item.file);
      if (thumb) {
        item.thumb_file = thumb;
      } else {
        delete item.thumb_file;
      }
    }
    const personIds = getMediaPersonIds(item);
    for (const pid of personIds) {
      mediaCounts.set(pid, (mediaCounts.get(pid) ?? 0) + 1);
      if (item.kind === 'portrait' && !portraitFromMedia.has(pid)) {
        portraitFromMedia.set(pid, item.file);
      }
    }
    if (
      item.event_id &&
      !overlayMediaIds.has(item.id) &&
      EVENT_HERO_MEDIA_KINDS.has(item.kind) &&
      !eventPhotoFromMedia.has(item.event_id)
    ) {
      eventPhotoFromMedia.set(item.event_id, {
        file: item.file,
        caption: item.caption,
      });
    }
  }

  for (const person of compiledPeople) {
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

  for (const ev of sortedEvents) {
    if (ev.photo_url) {
      continue;
    }
    const hasLiving = ev.participants.some((pt) => livingIds.has(pt.person_id));
    if (hasLiving && stripLivingPortraits) {
      continue;
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
