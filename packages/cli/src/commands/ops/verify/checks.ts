import {
  type ArchiveBundle,
  ArchiveBundleSchema,
  collectLivingNameHitsWithMatcher,
  collectLivingNames,
  compileArchiveDual,
  compileLivingNameMatcher,
  compileLivingNamePattern,
  extractLatestEdtfYear,
  fastLocaleCompare,
  filterMediaForPrivacy,
  filterNarrativesForPrivacy,
  getCurrentReferenceYear,
  type LivingNameTarget,
  type MediaItem,
  mayMatchLivingNameMatcher,
  type Narrative,
  type Place,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
  type ResidenceSpan,
  resolveEffectiveLiving,
  resolveNarrativeMaxYear,
  type SourceRecord,
  tryValidateArchiveBundle,
} from '@kinloom/core';
import { auditBundlePrivacy } from '../shared/bundlePrivacy.js';
import type {
  LoadedVerifyArchive,
  VerifyCompileResult,
  VerifyInvalidPlace,
  VerifyLivingNamesResult,
  VerifyPlacesResult,
  VerifySsnHit,
  VerifySsnResult,
} from './types.js';

const URL_RE = /https?:\/\/\S+/g;
const SSN_CANDIDATE_RE = /\d{3}-\d{2}-\d{4}/;
const SSN_LINE_RE = /(?<![A-Za-z0-9_/-])\d{3}-\d{2}-\d{4}(?![A-Za-z0-9_/-])/g;
const IGNORED_SSN_YAML_KEY_RE =
  /^\s*(?:-\s*)?(?:id|slug|gedcom_xref|url|file|thumb_file|portrait_url|thumb_url|source_url|photo_url)\s*:/;

function sortByIdIfNeeded<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  for (let i = 1; i < items.length; i += 1) {
    if (fastLocaleCompare(items[i - 1].id, items[i].id) > 0) {
      return [...items].toSorted((a, b) => fastLocaleCompare(a.id, b.id));
    }
  }
  return items;
}

export function validatePlaceCoordinates(places: readonly Place[]): VerifyPlacesResult {
  const invalidPlaces: VerifyInvalidPlace[] = [];
  for (const place of places) {
    const { lat, lng } = place;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      invalidPlaces.push({ id: place.id, reason: `non-finite coordinates (${String(lat)}, ${String(lng)})` });
      continue;
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      invalidPlaces.push({ id: place.id, reason: `coordinates out of range (${lat}, ${lng})` });
      continue;
    }
    if (Math.abs(lat) < 1e-9 && Math.abs(lng) < 1e-9) {
      invalidPlaces.push({ id: place.id, reason: 'forbidden (0, 0) coordinates' });
    }
  }
  return {
    ok: invalidPlaces.length === 0,
    placesChecked: places.length,
    invalidPlaces,
  };
}

export function scanYamlFilesForSsns(
  files: ReadonlyArray<{ name: string; content: string }>
): VerifySsnResult {
  const hits: VerifySsnHit[] = [];

  for (const file of files) {
    if (!SSN_CANDIDATE_RE.test(file.content)) {
      continue;
    }
    const lines = file.content.replaceAll('\r\n', '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i];
      if (!rawLine || !SSN_CANDIDATE_RE.test(rawLine) || IGNORED_SSN_YAML_KEY_RE.test(rawLine)) {
        continue;
      }
      const withoutUrls = rawLine.replaceAll(URL_RE, ' ');
      for (const match of withoutUrls.matchAll(SSN_LINE_RE)) {
        if (hits.length < 50) {
          hits.push({
            file: file.name,
            line: i + 1,
            match: match[0],
          });
        }
      }
    }
  }

  return {
    ok: hits.length === 0,
    filesScanned: files.length,
    hits,
  };
}

function sameSpanTuple(a: ResidenceSpan, b: ResidenceSpan): boolean {
  return (
    a.place_id === b.place_id &&
    a.time_min === b.time_min &&
    a.time_max === b.time_max &&
    a.from_event_id === b.from_event_id &&
    a.to_event_id === b.to_event_id
  );
}

export function findDuplicateResidenceSpans(bundle: ArchiveBundle, mode: 'private' | 'public'): string[] {
  const spans = bundle.residence_spans;
  if (spans.length === 0) {
    return [];
  }
  const duplicates: string[] = [];
  const seenIds = new Set<string>();
  const completedPersonIds = new Set<string>();
  let fallbackTuples: Set<string> | null = null;
  let groupPersonId = spans[0].person_id;
  let groupStart = 0;

  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    if (seenIds.has(span.id)) {
      duplicates.push(`${mode}:id:${span.id}`);
    } else {
      seenIds.add(span.id);
    }

    if (fallbackTuples) {
      const tupleKey = `${span.person_id}|${span.place_id}|${span.time_min}|${span.time_max}|${span.from_event_id}|${span.to_event_id}`;
      if (fallbackTuples.has(tupleKey)) {
        duplicates.push(`${mode}:span:${span.id}(${span.person_id}@${span.place_id})`);
      } else {
        fallbackTuples.add(tupleKey);
      }
      continue;
    }

    if (span.person_id !== groupPersonId) {
      if (completedPersonIds.has(span.person_id)) {
        fallbackTuples = new Set<string>();
        for (let k = 0; k < i; k += 1) {
          const prev = spans[k];
          fallbackTuples.add(
            `${prev.person_id}|${prev.place_id}|${prev.time_min}|${prev.time_max}|${prev.from_event_id}|${prev.to_event_id}`
          );
        }
        const tupleKey = `${span.person_id}|${span.place_id}|${span.time_min}|${span.time_max}|${span.from_event_id}|${span.to_event_id}`;
        if (fallbackTuples.has(tupleKey)) {
          duplicates.push(`${mode}:span:${span.id}(${span.person_id}@${span.place_id})`);
        } else {
          fallbackTuples.add(tupleKey);
        }
        continue;
      }
      completedPersonIds.add(groupPersonId);
      groupPersonId = span.person_id;
      groupStart = i;
      continue;
    }

    for (let k = groupStart; k < i; k += 1) {
      if (sameSpanTuple(spans[k], span)) {
        duplicates.push(`${mode}:span:${span.id}(${span.person_id}@${span.place_id})`);
        break;
      }
    }
  }

  return duplicates;
}

export function runDualCompileCheckWithArtifacts(
  archive: Pick<
    LoadedVerifyArchive,
    | 'people'
    | 'events'
    | 'places'
    | 'sources'
    | 'kinship'
    | 'media'
    | 'narratives'
    | 'enrichments'
    | 'siteConfig'
  >,
  options?: { skipBundleRevalidation?: boolean }
): {
  result: VerifyCompileResult;
  publicNarratives: readonly Narrative[] | undefined;
  publicMedia: readonly MediaItem[] | undefined;
} {
  const compileBase = {
    people: archive.people,
    events: archive.events,
    places: archive.places,
    sources: archive.sources,
    kinship: archive.kinship,
    media: archive.media,
    narratives: archive.narratives,
    ...(archive.enrichments.length > 0 ? { enrichments: archive.enrichments } : {}),
    siteConfig: archive.siteConfig,
  };

  const { privateResult, publicResult } = compileArchiveDual(compileBase);

  if (!options?.skipBundleRevalidation) {
    if (!tryValidateArchiveBundle(privateResult.bundle)) {
      ArchiveBundleSchema.parse(privateResult.bundle);
    }
    if (!tryValidateArchiveBundle(publicResult.bundle)) {
      ArchiveBundleSchema.parse(publicResult.bundle);
    }
  }

  const privateLivingLeaks = auditBundlePrivacy(privateResult.bundle, 'private');
  const publicLivingLeaks = auditBundlePrivacy(publicResult.bundle, 'public');
  const duplicateResidenceSpans = [
    ...findDuplicateResidenceSpans(privateResult.bundle, 'private'),
    ...findDuplicateResidenceSpans(publicResult.bundle, 'public'),
  ];

  return {
    result: {
      ok:
        privateResult.reviewFlags.length === 0 &&
        publicResult.reviewFlags.length === 0 &&
        privateLivingLeaks.length === 0 &&
        publicLivingLeaks.length === 0 &&
        duplicateResidenceSpans.length === 0,
      privateCounts: privateResult.bundle.meta.counts,
      publicCounts: publicResult.bundle.meta.counts,
      privateReviewFlags: privateResult.reviewFlags,
      publicReviewFlags: publicResult.reviewFlags,
      privateLivingLeaks,
      publicLivingLeaks,
      duplicateResidenceSpans,
    },
    publicNarratives: publicResult.bundle.narratives,
    publicMedia: publicResult.bundle.media,
  };
}

export function runDualCompileCheck(
  archive: Pick<
    LoadedVerifyArchive,
    | 'people'
    | 'events'
    | 'places'
    | 'sources'
    | 'kinship'
    | 'media'
    | 'narratives'
    | 'enrichments'
    | 'siteConfig'
  >
): VerifyCompileResult {
  return runDualCompileCheckWithArtifacts(archive).result;
}

export function scanPublicLivingNames(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  sources: readonly SourceRecord[];
  media: readonly MediaItem[];
  narratives: readonly Narrative[];
  privacy?: Partial<PrivacyConfig>;
  precomputedPublicNarratives?: readonly Narrative[];
  precomputedPublicMedia?: readonly MediaItem[];
}): VerifyLivingNamesResult {
  const livingIds = new Set<string>();
  const livingPeople: RawPerson[] = [];
  const deceasedPeople: RawPerson[] = [];
  const referenceYear = input.privacy?.referenceYear ?? getCurrentReferenceYear();
  for (let i = 0; i < input.people.length; i += 1) {
    const person = input.people[i];
    if (resolveEffectiveLiving(person, input.privacy, referenceYear)) {
      livingIds.add(person.id);
      livingPeople.push(person);
    } else {
      deceasedPeople.push(person);
    }
  }

  if (livingPeople.length === 0) {
    return { ok: true, hits: [] };
  }

  const matcher = compileLivingNameMatcher(livingPeople, deceasedPeople);
  if (!matcher.exactPattern && matcher.derivedRules.length === 0) {
    return { ok: true, hits: [] };
  }

  let publicNarratives: readonly Narrative[];
  if (input.precomputedPublicNarratives !== undefined) {
    publicNarratives = input.precomputedPublicNarratives;
  } else {
    const scrubPattern = compileLivingNamePattern(
      collectLivingNames(
        livingPeople.map((person) => ({
          is_living: true,
          full_name: person.full_name,
          alt_names: person.alt_names,
        }))
      )
    );
    publicNarratives = filterNarrativesForPrivacy(input.narratives, livingIds, scrubPattern, 'public');
  }

  let deathYearByPersonId: Map<string, number | null> | null = null;
  let yearMaps: {
    eventMaxYearById: Map<string, number | null>;
    sourceMaxYearById: Map<string, number | null>;
  } | null = null;

  const ensureDeathYears = (): Map<string, number | null> => {
    if (!deathYearByPersonId) {
      deathYearByPersonId = new Map<string, number | null>();
      for (let i = 0; i < input.people.length; i += 1) {
        const person = input.people[i];
        deathYearByPersonId.set(
          person.id,
          livingIds.has(person.id) ? null : extractLatestEdtfYear(person.death_edtf)
        );
      }
    }
    return deathYearByPersonId;
  };

  const ensureEventAndSourceYears = (): {
    eventMaxYearById: Map<string, number | null>;
    sourceMaxYearById: Map<string, number | null>;
  } => {
    if (!yearMaps) {
      const eventMaxYearById = new Map<string, number | null>();
      const sourceMaxYearById = new Map<string, number | null>();
      for (let i = 0; i < input.events.length; i += 1) {
        const ev = input.events[i];
        const eventYear = extractLatestEdtfYear(ev.edtf_date);
        eventMaxYearById.set(ev.id, eventYear);
        const srcs = ev.sources;
        for (let s = 0; s < srcs.length; s += 1) {
          const sourceId = srcs[s].source_id;
          const prev = sourceMaxYearById.get(sourceId);
          if (prev === undefined) {
            sourceMaxYearById.set(sourceId, eventYear);
          } else if (prev !== null) {
            sourceMaxYearById.set(sourceId, eventYear === null ? null : Math.max(prev, eventYear));
          }
        }
      }
      yearMaps = { eventMaxYearById, sourceMaxYearById };
    }
    return yearMaps;
  };

  let publicMedia: readonly MediaItem[];
  if (input.precomputedPublicMedia !== undefined) {
    publicMedia = input.precomputedPublicMedia;
  } else if (input.media.length === 0) {
    publicMedia = [];
  } else {
    const peopleById = new Map<string, RawPerson>();
    for (let i = 0; i < input.people.length; i += 1) {
      const person = input.people[i];
      const isLiv = livingIds.has(person.id);
      peopleById.set(person.id, person.is_living === isLiv ? person : { ...person, is_living: isLiv });
    }
    const eventsById = new Map<string, RawEvent>();
    for (let i = 0; i < input.events.length; i += 1) {
      eventsById.set(input.events[i].id, input.events[i]);
    }
    publicMedia = filterMediaForPrivacy(input.media, peopleById, eventsById, {
      stripLivingPortraits: true,
    });
  }

  const targets: LivingNameTarget[] = [];
  for (const narrative of sortByIdIfNeeded(publicNarratives)) {
    const titleHit = Boolean(narrative.title && mayMatchLivingNameMatcher(matcher, narrative.title));
    const summaryHit = Boolean(narrative.summary && mayMatchLivingNameMatcher(matcher, narrative.summary));
    const bodyHit = Boolean(narrative.body_md && mayMatchLivingNameMatcher(matcher, narrative.body_md));
    if (!titleHit && !summaryHit && !bodyHit) {
      continue;
    }
    const narrativeMaxYear = resolveNarrativeMaxYear({
      subjectPersonId: narrative.subject_person_id,
      personIds: narrative.person_ids,
      eventIds: narrative.event_ids,
      livingIds,
      deathYearByPersonId: ensureDeathYears(),
      eventMaxYearById: ensureEventAndSourceYears().eventMaxYearById,
    });
    if (titleHit) {
      targets.push({
        location: `narrative:${narrative.id}:title`,
        text: narrative.title,
        maxYear: narrativeMaxYear,
      });
    }
    if (summaryHit && narrative.summary) {
      targets.push({
        location: `narrative:${narrative.id}:summary`,
        text: narrative.summary,
        maxYear: narrativeMaxYear,
      });
    }
    if (bodyHit) {
      targets.push({
        location: `narrative:${narrative.id}:body_md`,
        text: narrative.body_md,
        maxYear: narrativeMaxYear,
      });
    }
  }

  for (const item of sortByIdIfNeeded(publicMedia)) {
    const capHit = Boolean(item.caption && mayMatchLivingNameMatcher(matcher, item.caption));
    const provHit = Boolean(item.provenance && mayMatchLivingNameMatcher(matcher, item.provenance));
    if (!capHit && !provHit) {
      continue;
    }
    const mediaMaxYear =
      extractLatestEdtfYear(item.date_edtf) ??
      (item.event_id ? (ensureEventAndSourceYears().eventMaxYearById.get(item.event_id) ?? null) : null);
    if (capHit) {
      targets.push({ location: `media:${item.id}:caption`, text: item.caption, maxYear: mediaMaxYear });
    }
    if (provHit && item.provenance) {
      targets.push({ location: `media:${item.id}:provenance`, text: item.provenance, maxYear: mediaMaxYear });
    }
  }

  for (const source of sortByIdIfNeeded(input.sources)) {
    if (source.citation && mayMatchLivingNameMatcher(matcher, source.citation)) {
      targets.push({
        location: `source:${source.id}:citation`,
        text: source.citation,
        maxYear: ensureEventAndSourceYears().sourceMaxYearById.get(source.id) ?? null,
      });
    }
  }

  for (const event of sortByIdIfNeeded(input.events)) {
    const titleHit = Boolean(event.title && mayMatchLivingNameMatcher(matcher, event.title));
    const summaryHit = Boolean(event.summary && mayMatchLivingNameMatcher(matcher, event.summary));
    if (!titleHit && !summaryHit) {
      continue;
    }
    let hasLivingParticipant = false;
    for (let p = 0; p < event.participants.length; p += 1) {
      if (livingIds.has(event.participants[p].person_id)) {
        hasLivingParticipant = true;
        break;
      }
    }
    if (hasLivingParticipant) {
      continue;
    }
    const eventMaxYear = ensureEventAndSourceYears().eventMaxYearById.get(event.id) ?? null;
    if (titleHit) {
      targets.push({ location: `event:${event.id}:title`, text: event.title, maxYear: eventMaxYear });
    }
    if (summaryHit) {
      targets.push({ location: `event:${event.id}:summary`, text: event.summary, maxYear: eventMaxYear });
    }
  }

  if (targets.length === 0) {
    return { ok: true, hits: [] };
  }

  const hits = collectLivingNameHitsWithMatcher(matcher, targets);
  return { ok: hits.length === 0, hits };
}
