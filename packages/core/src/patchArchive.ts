import type { KinloomSiteConfig } from './schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  BuildMode,
  KinshipEdge,
  MediaItem,
  Person,
  Place,
  RawEvent,
  RawPerson,
  ResidenceSpan,
  SourceRecord,
} from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';
import type { EntityPayload, EntityType, RevisionAction } from './schemas/revisions.js';
import { deriveKinshipEdgeId, parseEntityPayload } from './schemas/revisions.js';
import {
  ALLOWED_MANUAL_MEDIA_KINDS,
  EVENT_HERO_MEDIA_KINDS,
  buildTimedEvent,
  compareArchiveEvents,
  resolvePersonBranch,
} from './compileArchive.js';
import { edtfYear } from './edtf.js';
import { applyCitationCleanings, cleanSourceCitationTitle } from './gedcom/citations.js';
import {
  collectLivingNames,
  compileLivingNamePattern,
  filterMediaForPrivacy,
  redactSingleEvent,
  redactSingleNarrative,
  redactSinglePerson,
  resolveEffectiveLiving,
} from './privacy.js';
import {
  buildPlaceAncestors,
  deriveResidenceSpansForPerson,
  samePlaceOrWithin15Miles,
  type ResidenceAnchor,
} from './residenceSpans.js';

export interface BundlePatchMutation {
  revision_id?: number;
  entity_type: EntityType;
  entity_id: string;
  action: RevisionAction;
  before_json?: EntityPayload | null;
  after_json: EntityPayload | null;
  has_primary_source?: boolean;
}

export interface PatchCompiledBundleOptions {
  generatedAt?: string;
  legacyContainerSourceIds?: ReadonlySet<string>;
}

function binarySearchEventInsertIndex(events: readonly ArchiveEvent[], target: ArchiveEvent): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareArchiveEvents(events[mid], target) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function arraysEqualStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b || a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function updateUncitedKey(
  uncitedKeys: Set<string>,
  entityType: EntityType,
  entityId: string,
  hasPrimarySource: boolean | undefined,
  deleted: boolean
): void {
  if (entityType === 'kinship_edge') {
    return;
  }
  const key = `${entityType}:${entityId}`;
  if (deleted || hasPrimarySource !== false) {
    uncitedKeys.delete(key);
  } else {
    uncitedKeys.add(key);
  }
}

/**
 * Incrementally patch a compiled ArchiveBundle in O(affected_people) instead of recompiling the entire archive.
 * Pure function: never mutates `previousBundle` or its nested records.
 */
export function patchCompiledBundle(
  previousBundle: ArchiveBundle,
  mutations: readonly BundlePatchMutation[],
  siteConfig: KinloomSiteConfig,
  mode: BuildMode,
  options?: PatchCompiledBundleOptions
): ArchiveBundle {
  const privacy = siteConfig.privacy;
  const stripLivingPortraits = mode === 'public' || privacy.stripLivingPortraits;
  const includeLivingSpans = mode === 'private' && !privacy.stripLivingResidenceSpans;
  const legacyContainerSourceIds = options?.legacyContainerSourceIds;

  let maxRevisionId = previousBundle.meta.max_revision_id;
  for (const m of mutations) {
    if (m.revision_id !== undefined) {
      maxRevisionId = maxRevisionId === undefined ? m.revision_id : Math.max(maxRevisionId, m.revision_id);
    }
  }

  if (mutations.length === 0) {
    return {
      ...previousBundle,
      meta: {
        ...previousBundle.meta,
        build_mode: mode,
        generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
        ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      },
    };
  }

  const people = [...previousBundle.people];
  const events = [...previousBundle.events];
  const places = [...previousBundle.places];
  const sources = [...previousBundle.sources];
  const kinship = [...previousBundle.kinship];
  const media = previousBundle.media ? [...previousBundle.media] : [];
  let narratives = previousBundle.narratives ? [...previousBundle.narratives] : undefined;
  let placeAncestors: Record<string, string[]> = previousBundle.place_ancestors;
  let residenceSpans: ResidenceSpan[] = previousBundle.residence_spans;

  const uncitedKeys = new Set<string>(previousBundle.meta.uncited_entity_keys ?? []);

  // Lazily initialized indexes so lightweight mutations (source, narrative, kinship) skip unrelated scans
  let peopleIdxById: Map<string, number> | null = null;
  let livingIds: Set<string> | null = null;
  let eventsIdxById: Map<string, number> | null = null;
  let placesById: Map<string, Place> | null = null;
  let livingPatternDirty = true;
  let cachedLivingPattern: RegExp | null = null;

  const ensurePeopleIndex = (): { idxById: Map<string, number>; living: Set<string> } => {
    if (peopleIdxById === null || livingIds === null) {
      peopleIdxById = new Map<string, number>();
      livingIds = new Set<string>();
      for (let i = 0; i < people.length; i += 1) {
        const p = people[i];
        peopleIdxById.set(p.id, i);
        if (p.is_living) {
          livingIds.add(p.id);
        }
      }
    }
    return { idxById: peopleIdxById, living: livingIds };
  };

  const ensureEventsIndex = (): Map<string, number> => {
    if (eventsIdxById === null) {
      eventsIdxById = new Map<string, number>();
      for (let i = 0; i < events.length; i += 1) {
        eventsIdxById.set(events[i].id, i);
      }
    }
    return eventsIdxById;
  };

  const ensurePlacesById = (): Map<string, Place> => {
    if (placesById === null) {
      placesById = new Map<string, Place>();
      for (const pl of places) {
        placesById.set(pl.id, pl);
      }
    }
    return placesById;
  };

  const getLivingPattern = (): RegExp | null => {
    if (mode !== 'public') {
      return null;
    }
    if (livingPatternDirty) {
      cachedLivingPattern = compileLivingNamePattern(collectLivingNames(people));
      livingPatternDirty = false;
    }
    return cachedLivingPattern;
  };

  const affectedEventCountPersonIds = new Set<string>();
  const affectedSpanPersonIds = new Set<string>();
  const affectedMediaPersonIds = new Set<string>();
  const affectedMediaEventIds = new Set<string>();
  const explicitPortraitPersonIds = new Set<string>();
  const deletedPortraitUrlByPerson = new Map<string, Set<string>>();
  const deletedHeroPhotoByEvent = new Map<string, Set<string>>();
  const placesBeforeMutation = new Map<string, Place>();
  let placesMutated = false;
  const mutatedPlaceIds = new Set<string>();
  const newlyLivingPersonIds = new Set<string>();
  const newlyLivingNamesById = new Map<string, { full_name: string; alt_names: string[] }>();
  const deletedPersonIds = new Set<string>();
  const renamedPersonIds = new Set<string>();

  for (const mutation of mutations) {
    const { entity_type, entity_id, after_json } = mutation;

    switch (entity_type) {
      case 'source': {
        const existingIdx = sources.findIndex((s) => s.id === entity_id);
        if (after_json === null) {
          if (existingIdx !== -1) {
            sources.splice(existingIdx, 1);
          }
          updateUncitedKey(uncitedKeys, 'source', entity_id, undefined, true);
        } else {
          const parsed = parseEntityPayload('source', after_json);
          const cleaned: SourceRecord = {
            ...structuredClone(parsed),
            citation: parsed.citation ? cleanSourceCitationTitle(parsed.citation) : parsed.citation,
          };
          if (existingIdx !== -1) {
            sources[existingIdx] = cleaned;
          } else {
            sources.push(cleaned);
          }
          const effectiveHasPrimary =
            cleaned.has_primary_source !== undefined
              ? cleaned.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && cleaned.has_primary_source === undefined) {
            cleaned.has_primary_source = false;
          }
          updateUncitedKey(uncitedKeys, 'source', entity_id, effectiveHasPrimary, false);
        }
        break;
      }

      case 'narrative': {
        if (after_json === null) {
          if (narratives) {
            const existingIdx = narratives.findIndex((n) => n.id === entity_id);
            if (existingIdx !== -1) {
              narratives.splice(existingIdx, 1);
            }
          }
          updateUncitedKey(uncitedKeys, 'narrative', entity_id, undefined, true);
        } else {
          if (narratives === undefined) {
            narratives = [];
          }
          const { living } = ensurePeopleIndex();
          const parsed = redactSingleNarrative(
            parseEntityPayload('narrative', after_json),
            living,
            getLivingPattern(),
            mode,
            { clone: true }
          );
          const existingIdx = narratives.findIndex((n) => n.id === entity_id);
          if (existingIdx !== -1) {
            narratives[existingIdx] = parsed;
          } else {
            narratives.push(parsed);
          }
          const effectiveHasPrimary =
            parsed.has_primary_source !== undefined
              ? parsed.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && parsed.has_primary_source === undefined) {
            parsed.has_primary_source = false;
          }
          updateUncitedKey(uncitedKeys, 'narrative', entity_id, effectiveHasPrimary, false);
        }
        break;
      }

      case 'kinship_edge': {
        const existingIdx = kinship.findIndex((edge) => deriveKinshipEdgeId(edge) === entity_id);
        if (after_json === null) {
          if (existingIdx !== -1) {
            kinship.splice(existingIdx, 1);
          }
        } else {
          const parsed: KinshipEdge = structuredClone(parseEntityPayload('kinship_edge', after_json));
          const parsedIdx =
            existingIdx !== -1
              ? existingIdx
              : kinship.findIndex((edge) => deriveKinshipEdgeId(edge) === deriveKinshipEdgeId(parsed));
          if (parsedIdx !== -1) {
            kinship[parsedIdx] = parsed;
          } else {
            kinship.push(parsed);
          }
        }
        break;
      }

      case 'place': {
        placesMutated = true;
        mutatedPlaceIds.add(entity_id);
        const pMap = ensurePlacesById();
        const existingPlace = pMap.get(entity_id);
        if (existingPlace && !placesBeforeMutation.has(entity_id)) {
          placesBeforeMutation.set(entity_id, existingPlace);
        }
        const existingIdx = places.findIndex((pl) => pl.id === entity_id);
        if (after_json === null) {
          if (existingIdx !== -1) {
            places.splice(existingIdx, 1);
          }
          pMap.delete(entity_id);
          updateUncitedKey(uncitedKeys, 'place', entity_id, undefined, true);
        } else {
          const parsed: Place = structuredClone(parseEntityPayload('place', after_json));
          if (existingIdx !== -1) {
            places[existingIdx] = parsed;
          } else {
            places.push(parsed);
          }
          pMap.set(parsed.id, parsed);
          const effectiveHasPrimary =
            parsed.has_primary_source !== undefined
              ? parsed.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && parsed.has_primary_source === undefined) {
            parsed.has_primary_source = false;
          }
          updateUncitedKey(uncitedKeys, 'place', entity_id, effectiveHasPrimary, false);
        }
        break;
      }

      case 'person': {
        const { idxById, living } = ensurePeopleIndex();
        const existingIdx = idxById.get(entity_id);
        const prevPerson = existingIdx !== undefined ? people[existingIdx] : null;

        if (after_json === null) {
          if (existingIdx !== undefined) {
            people.splice(existingIdx, 1);
            // Refresh index map after splice
            idxById.clear();
            for (let i = 0; i < people.length; i += 1) {
              idxById.set(people[i].id, i);
            }
          }
          living.delete(entity_id);
          livingPatternDirty = true;
          deletedPersonIds.add(entity_id);
          affectedSpanPersonIds.add(entity_id);
          updateUncitedKey(uncitedKeys, 'person', entity_id, undefined, true);
        } else {
          const raw: RawPerson = structuredClone(parseEntityPayload('person', after_json));
          raw.branch = resolvePersonBranch(raw, siteConfig);
          const isNowLiving = resolveEffectiveLiving(raw, privacy);
          if (isNowLiving) {
            raw.is_living = true;
          }
          const rawFullNameBeforeRedaction = raw.full_name;
          const rawAltNamesBeforeRedaction = [...raw.alt_names];
          const hasExplicitPortrait = Boolean(raw.portrait_url) && !(isNowLiving && stripLivingPortraits);
          if (hasExplicitPortrait) {
            explicitPortraitPersonIds.add(raw.id);
          }

          const redactedRaw = redactSinglePerson(raw, mode, { privacy, clone: false });
          const effectiveHasPrimary =
            redactedRaw.has_primary_source !== undefined
              ? redactedRaw.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && redactedRaw.has_primary_source === undefined) {
            redactedRaw.has_primary_source = false;
          }

          const compiledPerson: Person = {
            ...redactedRaw,
            birth_year: edtfYear(redactedRaw.birth_edtf),
            death_year: edtfYear(redactedRaw.death_edtf),
            event_count: prevPerson ? prevPerson.event_count : 0,
            media_count: isNowLiving && stripLivingPortraits ? 0 : (prevPerson?.media_count ?? 0),
            primary_place_id: prevPerson ? prevPerson.primary_place_id : null,
          };

          if (isNowLiving && stripLivingPortraits) {
            compiledPerson.portrait_url = null;
            compiledPerson.thumb_url = null;
            compiledPerson.media_count = 0;
          }

          if (existingIdx !== undefined) {
            people[existingIdx] = compiledPerson;
          } else {
            idxById.set(compiledPerson.id, people.length);
            people.push(compiledPerson);
          }

          const wasLiving = prevPerson?.is_living ?? false;
          if (isNowLiving) {
            living.add(compiledPerson.id);
            livingPatternDirty = true;
            if (!wasLiving) {
              newlyLivingPersonIds.add(compiledPerson.id);
              newlyLivingNamesById.set(compiledPerson.id, {
                full_name: rawFullNameBeforeRedaction,
                alt_names: rawAltNamesBeforeRedaction,
              });
            }
          } else {
            living.delete(compiledPerson.id);
            if (wasLiving) {
              livingPatternDirty = true;
            }
          }

          if (!prevPerson || wasLiving !== isNowLiving) {
            affectedEventCountPersonIds.add(compiledPerson.id);
            affectedSpanPersonIds.add(compiledPerson.id);
            affectedMediaPersonIds.add(compiledPerson.id);
          } else if (!hasExplicitPortrait) {
            // Preserve or re-derive fallback portrait from media if raw.portrait_url is null
            affectedMediaPersonIds.add(compiledPerson.id);
          }

          if (
            prevPerson &&
            (prevPerson.full_name !== compiledPerson.full_name || prevPerson.slug !== compiledPerson.slug)
          ) {
            renamedPersonIds.add(compiledPerson.id);
          }

          updateUncitedKey(uncitedKeys, 'person', entity_id, effectiveHasPrimary, false);
        }
        break;
      }

      case 'event': {
        const { living } = ensurePeopleIndex();
        const evIdxMap = ensureEventsIndex();
        const existingIdx = evIdxMap.get(entity_id);
        const prevEvent = existingIdx !== undefined ? events[existingIdx] : null;

        if (prevEvent) {
          for (const pt of prevEvent.participants) {
            affectedEventCountPersonIds.add(pt.person_id);
            if (prevEvent.event_kind === 'residence_anchor') {
              affectedSpanPersonIds.add(pt.person_id);
            }
          }
        }

        if (after_json === null) {
          if (existingIdx !== undefined) {
            events.splice(existingIdx, 1);
            eventsIdxById = null;
          }
          updateUncitedKey(uncitedKeys, 'event', entity_id, undefined, true);
        } else {
          const raw: RawEvent = structuredClone(parseEntityPayload('event', after_json));
          const effectiveHasPrimary =
            raw.has_primary_source !== undefined
              ? raw.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && raw.has_primary_source === undefined) {
            raw.has_primary_source = false;
          }

          const timed = buildTimedEvent(raw, placeAncestors);
          applyCitationCleanings([timed], [], legacyContainerSourceIds);
          const hasLivingParticipant = timed.participants.some((pt) => living.has(pt.person_id));
          const pattern = hasLivingParticipant ? getLivingPattern() : null;
          const redacted = redactSingleEvent(timed, living, pattern, mode, {
            privacy,
            clone: false,
          });

          if (!redacted) {
            if (existingIdx !== undefined) {
              events.splice(existingIdx, 1);
              eventsIdxById = null;
            }
            updateUncitedKey(uncitedKeys, 'event', entity_id, undefined, true);
          } else {
            for (const pt of redacted.participants) {
              affectedEventCountPersonIds.add(pt.person_id);
              if (redacted.event_kind === 'residence_anchor') {
                affectedSpanPersonIds.add(pt.person_id);
              }
            }
            if (!redacted.photo_url) {
              affectedMediaEventIds.add(redacted.id);
            }

            if (existingIdx !== undefined && prevEvent) {
              if (compareArchiveEvents(prevEvent, redacted) === 0) {
                events[existingIdx] = redacted;
              } else {
                events.splice(existingIdx, 1);
                const insertIdx = binarySearchEventInsertIndex(events, redacted);
                events.splice(insertIdx, 0, redacted);
                eventsIdxById = null;
              }
            } else {
              const insertIdx = binarySearchEventInsertIndex(events, redacted);
              events.splice(insertIdx, 0, redacted);
              eventsIdxById = null;
            }
            updateUncitedKey(uncitedKeys, 'event', entity_id, effectiveHasPrimary, false);
          }
        }
        break;
      }

      case 'media': {
        const existingIdx = media.findIndex((m) => m.id === entity_id);
        const prevMedia = existingIdx !== undefined && existingIdx !== -1 ? media[existingIdx] : null;
        if (prevMedia) {
          for (const pid of getMediaPersonIds(prevMedia)) {
            affectedMediaPersonIds.add(pid);
            if (prevMedia.kind === 'portrait') {
              const urls = deletedPortraitUrlByPerson.get(pid) ?? new Set<string>();
              urls.add(prevMedia.file);
              deletedPortraitUrlByPerson.set(pid, urls);
            }
          }
          if (prevMedia.event_id && EVENT_HERO_MEDIA_KINDS.has(prevMedia.kind)) {
            affectedMediaEventIds.add(prevMedia.event_id);
            const urls = deletedHeroPhotoByEvent.get(prevMedia.event_id) ?? new Set<string>();
            urls.add(prevMedia.file);
            deletedHeroPhotoByEvent.set(prevMedia.event_id, urls);
          }
        }

        if (after_json === null) {
          if (existingIdx !== -1) {
            media.splice(existingIdx, 1);
          }
          updateUncitedKey(uncitedKeys, 'media', entity_id, undefined, true);
        } else {
          const parsed: MediaItem = structuredClone(parseEntityPayload('media', after_json));
          const effectiveHasPrimary =
            parsed.has_primary_source !== undefined
              ? parsed.has_primary_source
              : mutation.has_primary_source === false
                ? false
                : undefined;
          if (effectiveHasPrimary === false && parsed.has_primary_source === undefined) {
            parsed.has_primary_source = false;
          }

          if (!ALLOWED_MANUAL_MEDIA_KINDS.has(parsed.kind) || !parsed.file) {
            if (existingIdx !== -1) {
              media.splice(existingIdx, 1);
            }
            updateUncitedKey(uncitedKeys, 'media', entity_id, undefined, true);
            break;
          }

          const { idxById } = ensurePeopleIndex();
          const peopleLookup = new Map<string, Person>();
          for (const pid of getMediaPersonIds(parsed)) {
            const pIdx = idxById.get(pid);
            if (pIdx !== undefined) {
              peopleLookup.set(pid, people[pIdx]);
            }
          }
          let eventsLookup: Map<string, ArchiveEvent> | undefined;
          if (parsed.event_id) {
            const eIdx = ensureEventsIndex().get(parsed.event_id);
            if (eIdx !== undefined) {
              const ev = events[eIdx];
              eventsLookup = new Map([[ev.id, ev]]);
              for (const pt of ev.participants) {
                const pIdx = idxById.get(pt.person_id);
                if (pIdx !== undefined) {
                  peopleLookup.set(pt.person_id, people[pIdx]);
                }
              }
            }
          }

          const [filtered] = filterMediaForPrivacy([parsed], peopleLookup, eventsLookup, {
            cloneInputs: false,
            stripLivingPortraits,
          });

          if (!filtered) {
            if (existingIdx !== -1) {
              media.splice(existingIdx, 1);
            }
            updateUncitedKey(uncitedKeys, 'media', entity_id, undefined, true);
          } else {
            if (existingIdx !== -1) {
              media[existingIdx] = filtered;
            } else {
              media.push(filtered);
            }
            for (const pid of getMediaPersonIds(filtered)) {
              affectedMediaPersonIds.add(pid);
            }
            if (filtered.event_id && EVENT_HERO_MEDIA_KINDS.has(filtered.kind)) {
              affectedMediaEventIds.add(filtered.event_id);
            }
            updateUncitedKey(uncitedKeys, 'media', entity_id, effectiveHasPrimary, false);
          }
        }
        break;
      }

      default: {
        const _exhaustive: never = entity_type;
        return _exhaustive;
      }
    }
  }

  // Reconcile newly living people's existing events and media
  if (newlyLivingPersonIds.size > 0) {
    const { living } = ensurePeopleIndex();
    const extraLivingNames = collectLivingNames(
      [...newlyLivingNamesById.values()].map((entry) => ({
        is_living: true,
        full_name: entry.full_name,
        alt_names: entry.alt_names,
      }))
    );
    const livingPattern =
      mode === 'public'
        ? compileLivingNamePattern([...new Set([...collectLivingNames(people), ...extraLivingNames])])
        : null;

    for (let i = events.length - 1; i >= 0; i -= 1) {
      const ev = events[i];
      if (!ev.participants.some((pt) => newlyLivingPersonIds.has(pt.person_id))) {
        continue;
      }
      const redacted = redactSingleEvent(ev, living, livingPattern, mode, {
        privacy,
        clone: true,
      });
      for (const pt of ev.participants) {
        affectedEventCountPersonIds.add(pt.person_id);
        if (ev.event_kind === 'residence_anchor') {
          affectedSpanPersonIds.add(pt.person_id);
        }
      }
      if (!redacted) {
        events.splice(i, 1);
        updateUncitedKey(uncitedKeys, 'event', ev.id, undefined, true);
        eventsIdxById = null;
      } else {
        events[i] = redacted;
      }
    }

    if (narratives) {
      for (let i = 0; i < narratives.length; i += 1) {
        const nar = narratives[i];
        const hitsNewlyLiving =
          (nar.subject_person_id !== undefined && newlyLivingPersonIds.has(nar.subject_person_id)) ||
          nar.person_ids.some((pid) => newlyLivingPersonIds.has(pid));
        if (!hitsNewlyLiving) {
          continue;
        }
        narratives[i] = redactSingleNarrative(nar, living, livingPattern, mode, { clone: true });
      }
    }
  }

  // Reconcile media when people were deleted, newly marked living, or renamed
  if (deletedPersonIds.size > 0 || (newlyLivingPersonIds.size > 0 && stripLivingPortraits) || renamedPersonIds.size > 0) {
    const { idxById, living } = ensurePeopleIndex();
    const evIdxMap = ensureEventsIndex();
    for (let i = media.length - 1; i >= 0; i -= 1) {
      const item = media[i];
      const linkedPids = getMediaPersonIds(item);
      let drop = false;
      for (const pid of linkedPids) {
        if (deletedPersonIds.has(pid) || (stripLivingPortraits && living.has(pid))) {
          drop = true;
          break;
        }
      }
      if (!drop && stripLivingPortraits && item.event_id) {
        const eIdx = evIdxMap.get(item.event_id);
        if (eIdx !== undefined && events[eIdx].participants.some((pt) => living.has(pt.person_id))) {
          drop = true;
        }
      }
      if (drop) {
        media.splice(i, 1);
        updateUncitedKey(uncitedKeys, 'media', item.id, undefined, true);
        for (const pid of linkedPids) {
          affectedMediaPersonIds.add(pid);
          if (item.kind === 'portrait') {
            const urls = deletedPortraitUrlByPerson.get(pid) ?? new Set<string>();
            urls.add(item.file);
            deletedPortraitUrlByPerson.set(pid, urls);
          }
        }
        if (item.event_id && EVENT_HERO_MEDIA_KINDS.has(item.kind)) {
          affectedMediaEventIds.add(item.event_id);
          const urls = deletedHeroPhotoByEvent.get(item.event_id) ?? new Set<string>();
          urls.add(item.file);
          deletedHeroPhotoByEvent.set(item.event_id, urls);
        }
      } else if (item.person_id && renamedPersonIds.has(item.person_id)) {
        const pIdx = idxById.get(item.person_id);
        if (pIdx !== undefined) {
          const target = people[pIdx];
          media[i] = {
            ...item,
            ...(target.full_name ? { person_name: target.full_name } : {}),
            ...(target.slug ? { person_slug: target.slug } : {}),
          };
        }
      }
    }
  }

  // Reconcile place_ancestors and affected place events/spans ONLY on place mutations
  if (placesMutated) {
    const pMap = ensurePlacesById();
    const prevAncestors = previousBundle.place_ancestors;
    placeAncestors = buildPlaceAncestors(pMap);

    const changedAncestorPlaceIds = new Set<string>();
    for (const pid of Object.keys(placeAncestors)) {
      if (!arraysEqualStrings(prevAncestors[pid], placeAncestors[pid])) {
        changedAncestorPlaceIds.add(pid);
      }
    }
    for (const pid of Object.keys(prevAncestors)) {
      if (!(pid in placeAncestors)) {
        changedAncestorPlaceIds.add(pid);
      }
    }

    // Build old places map to detect proximity/county changes affecting residence spans
    const oldPlacesById = new Map<string, Place>(pMap);
    for (const [pid, oldPlace] of placesBeforeMutation.entries()) {
      oldPlacesById.set(pid, oldPlace);
    }

    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (ev.place_id && changedAncestorPlaceIds.has(ev.place_id)) {
        events[i] = {
          ...ev,
          place_ancestors: [...(placeAncestors[ev.place_id] ?? [])],
        };
      }
      if (ev.event_kind === 'residence_anchor' && ev.place_id) {
        let placeProximityAffected = mutatedPlaceIds.has(ev.place_id);
        if (!placeProximityAffected) {
          for (const mPid of mutatedPlaceIds) {
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
            affectedSpanPersonIds.add(pt.person_id);
          }
        }
      }
    }
  }

  // Reconcile event_count and primary_place_id strictly for affected people
  if (affectedEventCountPersonIds.size > 0) {
    const { idxById } = ensurePeopleIndex();
    const eventCounts = new Map<string, number>();
    const placeCountsByPerson = new Map<string, Map<string, number>>();
    for (const pid of affectedEventCountPersonIds) {
      eventCounts.set(pid, 0);
      placeCountsByPerson.set(pid, new Map<string, number>());
    }

    for (const ev of events) {
      let matchedAny = false;
      for (const pt of ev.participants) {
        if (affectedEventCountPersonIds.has(pt.person_id)) {
          matchedAny = true;
          break;
        }
      }
      if (!matchedAny) {
        continue;
      }
      const seenInEvent = new Set<string>();
      for (const pt of ev.participants) {
        if (!affectedEventCountPersonIds.has(pt.person_id) || seenInEvent.has(pt.person_id)) {
          continue;
        }
        seenInEvent.add(pt.person_id);
        eventCounts.set(pt.person_id, (eventCounts.get(pt.person_id) ?? 0) + 1);
        if (ev.place_id) {
          const pCounts = placeCountsByPerson.get(pt.person_id)!;
          pCounts.set(ev.place_id, (pCounts.get(ev.place_id) ?? 0) + 1);
        }
      }
    }

    for (const pid of affectedEventCountPersonIds) {
      const pIdx = idxById.get(pid);
      if (pIdx === undefined) {
        continue;
      }
      const pCounts = placeCountsByPerson.get(pid)!;
      let primaryPlaceId: string | null = null;
      let bestCount = -1;
      for (const [placeId, count] of pCounts.entries()) {
        if (count > bestCount) {
          bestCount = count;
          primaryPlaceId = placeId;
        }
      }
      const prev = people[pIdx];
      const nextCount = eventCounts.get(pid) ?? 0;
      if (prev.event_count !== nextCount || prev.primary_place_id !== primaryPlaceId) {
        people[pIdx] = {
          ...prev,
          event_count: nextCount,
          primary_place_id: primaryPlaceId,
        };
      }
    }
  }

  // Reconcile media_count and fallback portrait_url strictly for affected people
  if (affectedMediaPersonIds.size > 0) {
    const { idxById } = ensurePeopleIndex();
    const mediaCounts = new Map<string, number>();
    const portraitFromMedia = new Map<string, string>();

    for (const item of media) {
      const pids = getMediaPersonIds(item);
      for (const pid of pids) {
        if (!affectedMediaPersonIds.has(pid)) {
          continue;
        }
        mediaCounts.set(pid, (mediaCounts.get(pid) ?? 0) + 1);
        if (item.kind === 'portrait' && !portraitFromMedia.has(pid)) {
          portraitFromMedia.set(pid, item.file);
        }
      }
    }

    for (const pid of affectedMediaPersonIds) {
      const pIdx = idxById.get(pid);
      if (pIdx === undefined) {
        continue;
      }
      const prev = people[pIdx];
      if (prev.is_living && stripLivingPortraits) {
        if (prev.portrait_url !== null || prev.media_count !== 0 || prev.thumb_url !== null) {
          people[pIdx] = { ...prev, portrait_url: null, thumb_url: null, media_count: 0 };
        }
        continue;
      }
      const nextMediaCount = mediaCounts.get(pid) ?? 0;
      let nextPortrait = prev.portrait_url;
      const deletedUrls = deletedPortraitUrlByPerson.get(pid);
      if (deletedUrls && nextPortrait && deletedUrls.has(nextPortrait) && !explicitPortraitPersonIds.has(pid)) {
        nextPortrait = portraitFromMedia.get(pid) ?? null;
      } else if (!nextPortrait) {
        nextPortrait = portraitFromMedia.get(pid) ?? null;
      }
      if (prev.media_count !== nextMediaCount || prev.portrait_url !== nextPortrait) {
        people[pIdx] = {
          ...prev,
          media_count: nextMediaCount,
          portrait_url: nextPortrait,
        };
      }
    }
  }

  // Reconcile fallback photo_url strictly for affected events
  if (affectedMediaEventIds.size > 0) {
    const { living } = ensurePeopleIndex();
    const evIdxMap = ensureEventsIndex();
    const heroByEvent = new Map<string, { file: string; caption: string }>();

    for (const item of media) {
      if (
        item.event_id &&
        affectedMediaEventIds.has(item.event_id) &&
        EVENT_HERO_MEDIA_KINDS.has(item.kind) &&
        !heroByEvent.has(item.event_id)
      ) {
        heroByEvent.set(item.event_id, { file: item.file, caption: item.caption });
      }
    }

    for (const evId of affectedMediaEventIds) {
      const eIdx = evIdxMap.get(evId);
      if (eIdx === undefined) {
        continue;
      }
      const prev = events[eIdx];
      const hasLiving = prev.participants.some((pt) => living.has(pt.person_id));
      const deletedHeroUrls = deletedHeroPhotoByEvent.get(evId);
      if (hasLiving && stripLivingPortraits) {
        if (deletedHeroUrls && prev.photo_placeholder_caption !== undefined) {
          const updated: ArchiveEvent = { ...prev };
          delete updated.photo_placeholder_caption;
          events[eIdx] = updated;
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
        events[eIdx] = updated;
      }
    }
  }

  // Recompute residence spans strictly for affected people and splice in people order
  if (affectedSpanPersonIds.size > 0) {
    const { idxById } = ensurePeopleIndex();
    const pMap = ensurePlacesById();
    const anchorsByPerson = new Map<string, ResidenceAnchor[]>();

    for (const ev of events) {
      if (
        ev.event_kind !== 'residence_anchor' ||
        ev.time_min === null ||
        ev.time_max === null ||
        !ev.place_id
      ) {
        continue;
      }
      for (const pt of ev.participants) {
        if (!affectedSpanPersonIds.has(pt.person_id)) {
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
    for (const pid of affectedSpanPersonIds) {
      const pIdx = idxById.get(pid);
      if (pIdx === undefined) {
        recomputedSpansByPerson.set(pid, []);
        continue;
      }
      const person = people[pIdx];
      if (!includeLivingSpans && person.is_living) {
        recomputedSpansByPerson.set(pid, []);
        continue;
      }
      const anchors = anchorsByPerson.get(pid);
      recomputedSpansByPerson.set(
        pid,
        anchors && anchors.length >= 2
          ? deriveResidenceSpansForPerson(pid, anchors, pMap, 0)
          : []
      );
    }

    // Group preserved spans by person_id in O(existing spans) without touching unaffected geometry
    const existingSpansByPerson = new Map<string, ResidenceSpan[]>();
    for (const span of previousBundle.residence_spans) {
      if (affectedSpanPersonIds.has(span.person_id) || deletedPersonIds.has(span.person_id)) {
        continue;
      }
      const list = existingSpansByPerson.get(span.person_id) ?? [];
      list.push(span);
      existingSpansByPerson.set(span.person_id, list);
    }

    const nextSpans: ResidenceSpan[] = [];
    let spanIdx = 0;
    for (const person of people) {
      const personSpans = affectedSpanPersonIds.has(person.id)
        ? (recomputedSpansByPerson.get(person.id) ?? [])
        : (existingSpansByPerson.get(person.id) ?? []);
      for (const span of personSpans) {
        spanIdx += 1;
        const expectedId = `span_${String(spanIdx).padStart(4, '0')}`;
        nextSpans.push(span.id === expectedId ? span : { ...span, id: expectedId });
      }
    }
    residenceSpans = nextSpans;
  }

  const getLivingCount = (): number =>
    livingIds !== null ? livingIds.size : previousBundle.meta.counts.living_redacted;

  const livingRedactedCount = getLivingCount();

  const sortedUncitedKeys = [...uncitedKeys].toSorted();

  return {
    meta: {
      ...(previousBundle.meta.version ? { version: previousBundle.meta.version } : {}),
      build_mode: mode,
      generated_at: options?.generatedAt ?? previousBundle.meta.generated_at,
      ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      ...(sortedUncitedKeys.length > 0 ? { uncited_entity_keys: sortedUncitedKeys } : {}),
      counts: {
        people: people.length,
        living_redacted: livingRedactedCount,
        events: events.length,
        residence_spans: residenceSpans.length,
        places: places.length,
        sources: sources.length,
        media: media.length,
        ...(narratives !== undefined ? { narratives: narratives.length } : {}),
      },
    },
    media,
    people,
    events,
    residence_spans: residenceSpans,
    places,
    place_ancestors: placeAncestors,
    kinship,
    sources,
    ...(narratives !== undefined ? { narratives } : {}),
  };
}
