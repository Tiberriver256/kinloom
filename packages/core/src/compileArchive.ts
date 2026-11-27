import { getCurrentReferenceYear, parseIsoReferenceYear } from './clock.js';
import {
  applyNarrativeEnrichments,
  buildTimedEvent,
  collectUncitedEntityKeys,
  compareArchiveEvents,
  enrichHouseholdDescriptions,
  resolvePersonBranch,
} from './compile/enrichment.js';
import { compileAndAttachMedia, compilePeopleSummaries } from './compile/mediaAndStats.js';
import { cloneEvent, cloneKinship, clonePerson, clonePlace, cloneSource } from './compile/snapshot.js';
import type { CompileArchiveInput, CompileArchiveResult } from './compile/types.js';
import { applyCitationCleanings } from './gedcom/citations.js';
import {
  applyPrivacyFilter,
  collectLivingNames,
  compileLivingNamePattern,
  filterNarrativesForPrivacy,
  resolveEffectiveLiving,
} from './privacy.js';
import { buildPlaceAncestors, deriveResidenceSpans } from './residenceSpans.js';
import type { PrivacyConfig } from './schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  KinshipEdge,
  Person,
  Place,
  RawEvent,
  RawPerson,
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

/**
 * Pure TypeScript archive compiler replacing legacy Python build.py.
 * Clones external inputs once at entry and forwards siteConfig.privacy through privacy redaction and media filtering.
 */
export function compileArchive(input: CompileArchiveInput): CompileArchiveResult {
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
  // Keep shared lexicon entries in bundle.pronunciations only so live D1 lexicon overrides
  // are never shadowed by stale pre-baked fields on individual person/place records.
  const pronunciationLexicon = siteConfig.pronunciations;
  const rawPeople: RawPerson[] = input.people.map((p) => {
    const clone = clonePerson(p);
    clone.branch = resolvePersonBranch(clone, siteConfig);
    if (resolveEffectiveLiving(clone, privacy, effectiveReferenceYear)) {
      clone.is_living = true;
    }
    return clone;
  });

  const rawEvents: RawEvent[] = input.events.map(cloneEvent);
  const places: Place[] = input.places.map(clonePlace);
  const kinship: KinshipEdge[] = input.kinship.map(cloneKinship);
  const combinedSources: SourceRecord[] = [
    ...input.sources.map(cloneSource),
    ...(input.contextSources ?? []).map(cloneSource),
  ];

  applyNarrativeEnrichments(rawEvents, input.enrichments);
  const enrichedHouseholdCount = enrichHouseholdDescriptions(rawEvents, rawPeople, input.ancestryPeople);

  for (const ctxEv of input.contextEvents ?? []) {
    rawEvents.push(cloneEvent(ctxEv));
  }

  const placesById = new Map<string, Place>(places.map((p) => [p.id, p]));
  const sourcesById = new Map<string, SourceRecord>();
  for (const s of combinedSources) {
    sourcesById.set(s.id, s);
  }
  const uniqueSources = [...sourcesById.values()];
  const placeAncestors = buildPlaceAncestors(placesById);

  // Stage 2: Parse temporal bounds, place ancestors, and GEDCOM citation cleanings.
  const timedEvents: ArchiveEvent[] = rawEvents.map((ev) => buildTimedEvent(ev, placeAncestors));
  applyCitationCleanings(timedEvents, uniqueSources, legacyContainerSourceIds);

  const narrativeLivingPattern =
    mode === 'public' ? compileLivingNamePattern(collectLivingNames(rawPeople)) : null;

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

  // Stage 4: Derive residence spans, sort events chronologically, and compile person summaries.
  const residenceSpans = deriveResidenceSpans(redactedRawPeople, redactedEvents, placesById, {
    includeLiving: includeLivingSpans,
  });
  const sortedEvents = redactedEvents.toSorted(compareArchiveEvents);
  const compiledPeople = compilePeopleSummaries(redactedRawPeople, sortedEvents);

  const peopleById = new Map<string, Person>(compiledPeople.map((p) => [p.id, p]));
  const eventsById = new Map<string, ArchiveEvent>(sortedEvents.map((e) => [e.id, e]));
  const livingIds = new Set(compiledPeople.filter((p) => p.is_living).map((p) => p.id));

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
      ? { pronunciations: structuredClone(pronunciationLexicon) }
      : {}),
  };

  return {
    bundle,
    reviewFlags,
    enrichedHouseholdCount,
  };
}
