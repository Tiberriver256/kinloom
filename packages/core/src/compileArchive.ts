import { getCurrentReferenceYear, parseIsoReferenceYear } from './clock.js';
import {
  applyNarrativeEnrichments,
  collectUncitedEntityKeys,
  compareArchiveEvents,
  enrichHouseholdDescriptions,
  populateTimedEventInPlace,
  resolvePersonBranch,
} from './compile/enrichment.js';
import { compileAndAttachMedia } from './compile/mediaAndStats.js';
import { cloneEvent, cloneKinship, clonePerson, clonePlace, cloneSource } from './compile/snapshot.js';
import type { CompileArchiveInput, CompileArchiveResult } from './compile/types.js';
import { edtfYear } from './edtf.js';
import { markTrustedArchiveBundle } from './fastCompare.js';
import { applyCitationCleanings } from './gedcom/citations.js';
import {
  applyPrivacyFilter,
  collectLivingNames,
  compileLivingNamePattern,
  filterNarrativesForPrivacy,
  resolveEffectiveLiving,
} from './privacy.js';
import {
  appendResidenceSpansForPerson,
  buildPlaceAncestors,
  getProximityPairCache,
  type ResidenceAnchor,
} from './residenceSpans.js';
import type { PrivacyConfig } from './schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  KinshipEdge,
  Person,
  Place,
  Pronunciation,
  RawEvent,
  RawPerson,
  ResidenceSpan,
  SourceRecord,
} from './schemas/entities.js';

export {
  buildTimedEvent,
  collectUncitedEntityKeys,
  compareArchiveEvents,
  mergeEventSources,
  resolvePersonBranch,
} from './compile/enrichment.js';
export { extractCollectionsFromSnapshot } from './compile/snapshot.js';
export {
  ALLOWED_MANUAL_MEDIA_KINDS,
  type AncestryHouseholdEvent,
  type AncestryPersonRecord,
  type CompileArchiveInput,
  type CompileArchiveResult,
  type CompiledMediaOverlay,
  EVENT_HERO_MEDIA_KINDS,
  type ExtractedSnapshotCollections,
} from './compile/types.js';

interface PreparedBaseArchive {
  readonly placeAncestors: Record<string, string[]>;
  readonly preSortedTimedEvents: ArchiveEvent[];
  readonly cleanedSources: SourceRecord[];
}

const preparedBaseCache = new WeakMap<
  readonly RawEvent[],
  WeakMap<readonly Place[], WeakMap<readonly SourceRecord[], PreparedBaseArchive>>
>();

function clonePreparedArchiveEvent(e: ArchiveEvent): ArchiveEvent {
  if (
    e.alternate_dates === undefined &&
    e.alternate_places === undefined &&
    e.fact_conflicts === undefined &&
    e.weather_metrics === undefined &&
    e.source_url === undefined &&
    e.photo_url === undefined &&
    e.photo_placeholder_caption === undefined &&
    e.extensions === undefined
  ) {
    const out = {
      id: e.id,
      title: e.title,
      scope: e.scope,
      event_kind: e.event_kind,
    } as ArchiveEvent;
    if (e.category !== undefined) {
      out.category = e.category;
    }
    out.edtf_date = e.edtf_date;
    out.place_id = e.place_id;
    if (e.place_precision !== undefined) {
      out.place_precision = e.place_precision;
    }
    out.summary = e.summary;
    if (e.severity_rank !== undefined) {
      out.severity_rank = e.severity_rank;
    }
    out.participants = e.participants;
    out.sources = e.sources;
    if (e.has_primary_source !== undefined) {
      out.has_primary_source = e.has_primary_source;
    }
    out.time_min = e.time_min;
    out.time_max = e.time_max;
    out.display_date = e.display_date;
    out.year = e.year;
    out.place_ancestors = e.place_ancestors ?? [];
    return out;
  }

  const cloned = cloneEvent(e) as ArchiveEvent;
  cloned.time_min = e.time_min;
  cloned.time_max = e.time_max;
  cloned.display_date = e.display_date;
  cloned.year = e.year;
  cloned.place_ancestors = e.place_ancestors ? e.place_ancestors.slice() : [];
  return cloned;
}

function buildPreparedBaseArchiveFresh(
  events: readonly RawEvent[],
  places: readonly Place[],
  sources: readonly SourceRecord[]
): PreparedBaseArchive {
  const placesById = new Map<string, Place>();
  for (const pl of places) {
    placesById.set(pl.id, pl);
  }
  const placeAncestors = buildPlaceAncestors(placesById);

  const sourcesById = new Map<string, SourceRecord>();
  for (const src of sources) {
    const s = cloneSource(src);
    sourcesById.set(s.id, s);
  }
  const cleanedSources = [...sourcesById.values()];

  const timedEvents: ArchiveEvent[] = events.map((ev) =>
    populateTimedEventInPlace(cloneEvent(ev), placeAncestors)
  );
  applyCitationCleanings(timedEvents, cleanedSources);
  timedEvents.sort(compareArchiveEvents);

  return {
    placeAncestors,
    preSortedTimedEvents: timedEvents,
    cleanedSources,
  };
}

function getOrBuildPreparedBaseArchive(
  events: readonly RawEvent[],
  places: readonly Place[],
  sources: readonly SourceRecord[]
): PreparedBaseArchive {
  let byPlaces = preparedBaseCache.get(events);
  if (byPlaces) {
    const existing = byPlaces.get(places)?.get(sources);
    if (existing) {
      return existing;
    }
  }

  const prepared = buildPreparedBaseArchiveFresh(events, places, sources);

  if (!byPlaces) {
    byPlaces = new WeakMap();
    preparedBaseCache.set(events, byPlaces);
  }
  let bySources = byPlaces.get(places);
  if (!bySources) {
    bySources = new WeakMap();
    byPlaces.set(places, bySources);
  }
  bySources.set(sources, prepared);
  return prepared;
}

export function clonePronunciationLexiconFast(
  lexicon: Readonly<Record<string, Pronunciation>>
): Record<string, Pronunciation> {
  const out: Record<string, Pronunciation> = {};
  for (const [key, entry] of Object.entries(lexicon)) {
    if (entry.variants !== undefined || entry.match_full_name_contains !== undefined) {
      out[key] = structuredClone(entry);
    } else {
      out[key] = { ...entry };
    }
  }
  return out;
}

interface DualSharedPreparedContext {
  readonly prepared: PreparedBaseArchive;
  readonly consumePreparedInPlace: boolean;
  readonly preResolvedPeople: readonly RawPerson[];
  readonly preResolvedBirthYears: readonly (number | null)[];
  readonly preResolvedDeathYears: readonly (number | null)[];
  readonly sharedResidenceSpans?: readonly ResidenceSpan[] | undefined;
  onComputedPrivateSpans?: ((spans: readonly ResidenceSpan[], canShareWithPublic: boolean) => void) | undefined;
}

function compileArchiveInternal(
  input: CompileArchiveInput,
  dualCtx?: DualSharedPreparedContext
): CompileArchiveResult {
  const {
    siteConfig,
    mode,
    generatedAt = new Date().toISOString(),
    version,
    maxRevisionId,
    resolveThumbUrl,
    mediaExists,
    legacyContainerSourceIds,
  } = input;

  const effectiveReferenceYear =
    input.referenceYear ??
    siteConfig.privacy.referenceYear ??
    parseIsoReferenceYear(generatedAt) ??
    getCurrentReferenceYear();
  const privacy: PrivacyConfig = {
    ...siteConfig.privacy,
    referenceYear: effectiveReferenceYear,
  };
  const stripLivingPortraits = mode === 'public' || privacy.stripLivingPortraits;
  const includeLivingSpans = mode === 'private' && !privacy.stripLivingResidenceSpans;

  // Stage 1: Clone inputs once at entry and assign branches from siteConfig.
  const pronunciationLexicon = siteConfig.pronunciations;
  const rawPeople: RawPerson[] = dualCtx
    ? dualCtx.preResolvedPeople.map(clonePerson)
    : input.people.map((person) => {
        const clone = clonePerson(person);
        clone.branch = resolvePersonBranch(clone, siteConfig);
        if (resolveEffectiveLiving(clone, privacy, effectiveReferenceYear)) {
          clone.is_living = true;
        }
        return clone;
      });

  const places: Place[] = [];
  const placesById = new Map<string, Place>();
  for (const place of input.places) {
    const pl = clonePlace(place);
    places.push(pl);
    placesById.set(pl.id, pl);
  }
  const kinship: KinshipEdge[] = input.kinship.map(cloneKinship);

  const canUsePreparedBase =
    (!input.enrichments || input.enrichments.length === 0) &&
    (!input.ancestryPeople || input.ancestryPeople.length === 0) &&
    (!input.contextEvents || input.contextEvents.length === 0) &&
    (!input.contextSources || input.contextSources.length === 0) &&
    (!legacyContainerSourceIds || legacyContainerSourceIds.size === 0);

  let timedEvents: ArchiveEvent[];
  let uniqueSources: SourceRecord[];
  let placeAncestors: Record<string, string[]>;
  let enrichedHouseholdCount = 0;

  if (dualCtx && canUsePreparedBase) {
    const prepared = dualCtx.prepared;
    if (dualCtx.consumePreparedInPlace) {
      placeAncestors = prepared.placeAncestors;
      uniqueSources = prepared.cleanedSources;
      timedEvents = prepared.preSortedTimedEvents;
    } else {
      const clonedAncestors: Record<string, string[]> = {};
      for (const [pid, chain] of Object.entries(prepared.placeAncestors)) {
        clonedAncestors[pid] = chain.slice();
      }
      placeAncestors = clonedAncestors;
      uniqueSources = prepared.cleanedSources.map(cloneSource);
      timedEvents = prepared.preSortedTimedEvents.map(clonePreparedArchiveEvent);
    }
  } else if (canUsePreparedBase) {
    const prepared = getOrBuildPreparedBaseArchive(input.events, input.places, input.sources);
    const clonedAncestors: Record<string, string[]> = {};
    for (const [pid, chain] of Object.entries(prepared.placeAncestors)) {
      clonedAncestors[pid] = chain.slice();
    }
    placeAncestors = clonedAncestors;
    uniqueSources = prepared.cleanedSources.map(cloneSource);
    timedEvents = prepared.preSortedTimedEvents.map(clonePreparedArchiveEvent);
  } else {
    const rawEvents: RawEvent[] = input.events.map(cloneEvent);
    const sourcesById = new Map<string, SourceRecord>();
    for (const src of input.sources) {
      const s = cloneSource(src);
      sourcesById.set(s.id, s);
    }
    if (input.contextSources) {
      for (const src of input.contextSources) {
        const s = cloneSource(src);
        sourcesById.set(s.id, s);
      }
    }
    applyNarrativeEnrichments(rawEvents, input.enrichments);
    enrichedHouseholdCount = enrichHouseholdDescriptions(rawEvents, rawPeople, input.ancestryPeople);
    if (input.contextEvents) {
      for (const ev of input.contextEvents) {
        rawEvents.push(cloneEvent(ev));
      }
    }
    uniqueSources = [...sourcesById.values()];
    placeAncestors = buildPlaceAncestors(placesById);
    timedEvents = rawEvents as ArchiveEvent[];
    for (const ev of rawEvents) {
      populateTimedEventInPlace(ev, placeAncestors);
    }
    applyCitationCleanings(timedEvents, uniqueSources, legacyContainerSourceIds);
    timedEvents.sort(compareArchiveEvents);
  }

  const narrativeLivingPattern =
    mode === 'public' && input.narratives && input.narratives.length > 0
      ? compileLivingNamePattern(collectLivingNames(rawPeople))
      : null;

  // Stage 3: Apply living-person privacy filter before deriving residence spans so redacted events cannot leak.
  const {
    people: redactedRawPeople,
    events: redactedEvents,
    reviewFlags,
  } = applyPrivacyFilter(rawPeople, timedEvents, [], mode, {
    privacy,
    referenceYear: effectiveReferenceYear,
    cloneInputs: false,
  });

  let sortedEvents = redactedEvents;
  let prevSortedEv: ArchiveEvent | undefined;
  for (const curEv of sortedEvents) {
    if (prevSortedEv && compareArchiveEvents(prevSortedEv, curEv) > 0) {
      sortedEvents = sortedEvents.toSorted(compareArchiveEvents);
      break;
    }
    prevSortedEv = curEv;
  }

  // Stage 4: Single integer-indexed pass over people & sortedEvents.
  const numPeople = redactedRawPeople.length;
  const compiledPeople = redactedRawPeople as Person[];
  const peopleById = new Map<string, Person>();
  const personIdxById = new Map<string, number>();
  const livingIds = new Set<string>();

  for (let i = 0; i < compiledPeople.length; i += 1) {
    const p = compiledPeople[i];
    if (!p) {
      continue;
    }
    peopleById.set(p.id, p);
    personIdxById.set(p.id, i);
    if (p.is_living) {
      livingIds.add(p.id);
    }
  }

  let referencedMediaEventIds: Set<string> | null = null;
  if (input.compiledMediaOverlay) {
    referencedMediaEventIds = null;
  } else if (stripLivingPortraits && input.media && input.media.length > 0) {
    for (const item of input.media) {
      const eid = item.event_id;
      if (eid) {
        if (!referencedMediaEventIds) {
          referencedMediaEventIds = new Set<string>();
        }
        referencedMediaEventIds.add(eid);
      }
    }
  }

  const reuseSharedSpans = Boolean(dualCtx?.sharedResidenceSpans);
  const eventsById = new Map<string, ArchiveEvent>();
  const buildFullEventsById = Boolean(input.compiledMediaOverlay);
  const eventsByPersonIdx = new Array<ArchiveEvent[] | undefined>(numPeople);
  const anchorsByPersonIdx = reuseSharedSpans ? null : new Array<ResidenceAnchor[] | undefined>(numPeople);
  let hasMixedDeceasedLivingAnchor = false;

  const pushPersonEventAndAnchor = (pIdx: number, ev: ArchiveEvent, isAnchor: boolean): void => {
    const evList = eventsByPersonIdx[pIdx];
    if (!evList) {
      eventsByPersonIdx[pIdx] = [ev];
    } else {
      evList.push(ev);
    }
    const person = compiledPeople[pIdx];
    if (anchorsByPersonIdx && isAnchor && person && (!person.is_living || includeLivingSpans)) {
      const anchor = ev as ResidenceAnchor;
      const aList = anchorsByPersonIdx[pIdx];
      if (!aList) {
        anchorsByPersonIdx[pIdx] = [anchor];
      } else {
        aList.push(anchor);
      }
    }
  };

  for (const ev of sortedEvents) {
    if (buildFullEventsById || referencedMediaEventIds?.has(ev.id)) {
      eventsById.set(ev.id, ev);
    }
    const pts = ev.participants;
    const [pt0, pt1] = pts;
    if (!pt0) {
      continue;
    }
    const isAnchor =
      !reuseSharedSpans &&
      ev.event_kind === 'residence_anchor' &&
      ev.time_min !== null &&
      ev.time_max !== null &&
      Boolean(ev.place_id);

    if (!pt1) {
      const idx0 = personIdxById.get(pt0.person_id);
      if (idx0 !== undefined) {
        pushPersonEventAndAnchor(idx0, ev, isAnchor);
      }
      continue;
    }

    if (isAnchor && !hasMixedDeceasedLivingAnchor && livingIds.size > 0) {
      let sawDeceased = false;
      let sawLiving = false;
      for (const pt of pts) {
        if (livingIds.has(pt.person_id)) {
          sawLiving = true;
        } else {
          sawDeceased = true;
        }
      }
      if (sawDeceased && sawLiving) {
        hasMixedDeceasedLivingAnchor = true;
      }
    }

    if (pts.length === 2) {
      const id0 = pt0.person_id;
      const id1 = pt1.person_id;
      const idx0 = personIdxById.get(id0);
      if (idx0 !== undefined) {
        pushPersonEventAndAnchor(idx0, ev, isAnchor);
      }
      if (id1 !== id0) {
        const idx1 = personIdxById.get(id1);
        if (idx1 !== undefined) {
          pushPersonEventAndAnchor(idx1, ev, isAnchor);
        }
      }
      continue;
    }
    const seenInEvent = new Set<string>();
    for (const pt of pts) {
      const pid = pt.person_id;
      if (seenInEvent.has(pid)) {
        continue;
      }
      seenInEvent.add(pid);
      const pIdx = personIdxById.get(pid);
      if (pIdx !== undefined) {
        pushPersonEventAndAnchor(pIdx, ev, isAnchor);
      }
    }
  }

  let residenceSpans: ResidenceSpan[];
  if (dualCtx?.sharedResidenceSpans) {
    residenceSpans = dualCtx.sharedResidenceSpans.map((span) => ({ ...span }));
  } else {
    const pairCache = getProximityPairCache(placesById, input.places);
    residenceSpans = [];
    if (anchorsByPersonIdx) {
      for (let i = 0; i < compiledPeople.length; i += 1) {
        const person = compiledPeople[i];
        const anchors = anchorsByPersonIdx[i];
        if (person && anchors && anchors.length >= 2) {
          appendResidenceSpansForPerson(
            person.id,
            anchors,
            placesById,
            pairCache,
            residenceSpans,
            residenceSpans.length
          );
        }
      }
    }
    if (dualCtx?.onComputedPrivateSpans) {
      dualCtx.onComputedPrivateSpans(residenceSpans, !includeLivingSpans && !hasMixedDeceasedLivingAnchor);
    }
  }

  const placeCounts = new Map<string, number>();
  for (let i = 0; i < compiledPeople.length; i += 1) {
    const p = compiledPeople[i];
    if (!p) {
      continue;
    }
    const pEvts = eventsByPersonIdx[i];
    let primaryPlaceId: string | null = null;
    let eventCount = 0;
    if (pEvts && pEvts.length > 0) {
      eventCount = pEvts.length;
      const [ev0, ev1] = pEvts;
      if (ev0 && !ev1) {
        primaryPlaceId = ev0.place_id ?? null;
      } else if (ev0 && ev1 && eventCount === 2) {
        primaryPlaceId = ev0.place_id || ev1.place_id || null;
      } else {
        placeCounts.clear();
        let bestCount = -1;
        for (const pev of pEvts) {
          const pid = pev.place_id;
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

    p.birth_year = dualCtx && !p.is_living ? (dualCtx.preResolvedBirthYears[i] ?? null) : edtfYear(p.birth_edtf);
    p.death_year = dualCtx && !p.is_living ? (dualCtx.preResolvedDeathYears[i] ?? null) : edtfYear(p.death_edtf);
    p.event_count = eventCount;
    p.media_count = 0;
    p.primary_place_id = primaryPlaceId;
  }

  // Stage 5: Merge, privacy-filter, and attach media, portraits, and event hero photos.
  const finalMedia = compileAndAttachMedia({
    compiledPeople,
    sortedEvents,
    peopleById,
    eventsById,
    livingIds,
    stripLivingPortraits,
    compiledMediaOverlay: input.compiledMediaOverlay,
    media: input.media,
    resolveThumbUrl,
    mediaExists,
  });

  const narratives = input.narratives
    ? filterNarrativesForPrivacy(input.narratives, livingIds, narrativeLivingPattern, mode, {
        cloneInputs: true,
      })
    : undefined;

  if (narratives) {
    for (const n of narratives) {
      if (n.subject_person_id && !peopleById.has(n.subject_person_id)) {
        reviewFlags.push(`[${n.id}] references unknown subject_person_id '${n.subject_person_id}'.`);
      }
    }
  }

  const uncitedKeys = collectUncitedEntityKeys({
    people: compiledPeople,
    events: sortedEvents,
    places,
    sources: uniqueSources,
    media: finalMedia,
    narratives,
  });

  const bundle: ArchiveBundle = {
    meta: {
      ...(version ? { version } : {}),
      build_mode: mode,
      generated_at: generatedAt,
      ...(maxRevisionId !== undefined ? { max_revision_id: maxRevisionId } : {}),
      ...(uncitedKeys.length > 0 ? { uncited_entity_keys: uncitedKeys } : {}),
      counts: {
        people: compiledPeople.length,
        living_redacted: livingIds.size,
        events: sortedEvents.length,
        residence_spans: residenceSpans.length,
        places: places.length,
        sources: uniqueSources.length,
        media: finalMedia.length,
        ...(narratives !== undefined ? { narratives: narratives.length } : {}),
      },
    },
    media: finalMedia,
    people: compiledPeople,
    events: sortedEvents,
    residence_spans: residenceSpans,
    places,
    place_ancestors: placeAncestors,
    kinship,
    sources: uniqueSources,
    ...(narratives !== undefined ? { narratives } : {}),
    ...(pronunciationLexicon && Object.keys(pronunciationLexicon).length > 0
      ? { pronunciations: clonePronunciationLexiconFast(pronunciationLexicon) }
      : {}),
  };

  markTrustedArchiveBundle(bundle);

  return {
    bundle,
    reviewFlags,
    enrichedHouseholdCount,
  };
}

/**
 * Pure TypeScript archive compiler replacing legacy Python build.py.
 * Clones external inputs once at entry and forwards siteConfig.privacy through privacy redaction and media filtering.
 */
export function compileArchive(input: CompileArchiveInput): CompileArchiveResult {
  return compileArchiveInternal(input);
}

/**
 * Compile both `private` and `public` bundles from the same base archive input in a single pass,
 * sharing pre-sorted timed events, citation cleanings, person branch/living resolution, and
 * deceased-only residence spans without mutating caller inputs.
 */
export function compileArchiveDual(baseInput: Omit<CompileArchiveInput, 'mode'>): {
  privateResult: CompileArchiveResult;
  publicResult: CompileArchiveResult;
} {
  const canUsePreparedBase =
    (!baseInput.enrichments || baseInput.enrichments.length === 0) &&
    (!baseInput.ancestryPeople || baseInput.ancestryPeople.length === 0) &&
    (!baseInput.contextEvents || baseInput.contextEvents.length === 0) &&
    (!baseInput.contextSources || baseInput.contextSources.length === 0) &&
    (!baseInput.legacyContainerSourceIds || baseInput.legacyContainerSourceIds.size === 0);

  if (!canUsePreparedBase) {
    return {
      privateResult: compileArchiveInternal({ ...baseInput, mode: 'private' }),
      publicResult: compileArchiveInternal({ ...baseInput, mode: 'public' }),
    };
  }

  const generatedAt = baseInput.generatedAt ?? new Date().toISOString();
  const effectiveReferenceYear =
    baseInput.referenceYear ??
    baseInput.siteConfig.privacy.referenceYear ??
    parseIsoReferenceYear(generatedAt) ??
    getCurrentReferenceYear();
  const privacy: PrivacyConfig = {
    ...baseInput.siteConfig.privacy,
    referenceYear: effectiveReferenceYear,
  };

  const preResolvedPeople: RawPerson[] = [];
  const preResolvedBirthYears: (number | null)[] = [];
  const preResolvedDeathYears: (number | null)[] = [];
  for (const person of baseInput.people) {
    const clone = clonePerson(person);
    clone.branch = resolvePersonBranch(clone, baseInput.siteConfig);
    if (resolveEffectiveLiving(clone, privacy, effectiveReferenceYear)) {
      clone.is_living = true;
    }
    preResolvedPeople.push(clone);
    preResolvedBirthYears.push(clone.is_living ? null : edtfYear(clone.birth_edtf));
    preResolvedDeathYears.push(clone.is_living ? null : edtfYear(clone.death_edtf));
  }

  const cachedPrepared = preparedBaseCache
    .get(baseInput.events)
    ?.get(baseInput.places)
    ?.get(baseInput.sources);
  const prepared =
    cachedPrepared ?? buildPreparedBaseArchiveFresh(baseInput.events, baseInput.places, baseInput.sources);

  let sharedSpansForPublic: readonly ResidenceSpan[] | undefined;
  const privateResult = compileArchiveInternal(
    { ...baseInput, generatedAt, mode: 'private' },
    {
      prepared,
      consumePreparedInPlace: false,
      preResolvedPeople,
      preResolvedBirthYears,
      preResolvedDeathYears,
      onComputedPrivateSpans: (spans, canShare) => {
        if (canShare) {
          sharedSpansForPublic = spans;
        }
      },
    }
  );

  const publicResult = compileArchiveInternal(
    { ...baseInput, generatedAt, mode: 'public' },
    {
      prepared,
      consumePreparedInPlace: !cachedPrepared,
      preResolvedPeople,
      preResolvedBirthYears,
      preResolvedDeathYears,
      sharedResidenceSpans: sharedSpansForPublic,
    }
  );

  return { privateResult, publicResult };
}
