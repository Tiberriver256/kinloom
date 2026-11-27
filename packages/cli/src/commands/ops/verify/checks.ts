import {
  type ArchiveBundle,
  ArchiveBundleSchema,
  collectLivingNames,
  compileArchive,
  compileLivingNamePattern,
  filterMediaForPrivacy,
  filterNarrativesForPrivacy,
  type MediaItem,
  type Narrative,
  type Place,
  type PrivacyConfig,
  type RawEvent,
  type RawPerson,
  resolveEffectiveLiving,
  type SourceRecord,
} from '@kinloom/core';
import { auditBundlePrivacy } from '../integrate.js';
import {
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  computeSourceMaxYearById,
  extractLatestEdtfYear,
  type LivingNameTarget,
  resolveNarrativeMaxYear,
} from '../living-name-matcher.js';
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
const SSN_LINE_RE = /(?<![A-Za-z0-9_/-])\d{3}-\d{2}-\d{4}(?![A-Za-z0-9_/-])/g;
const IGNORED_SSN_YAML_KEY_RE =
  /^\s*(?:-\s*)?(?:id|slug|gedcom_xref|url|file|thumb_file|portrait_url|thumb_url|source_url|photo_url)\s*:/;

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
    const lines = file.content.replaceAll('\r\n', '\n').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const rawLine = lines[i];
      if (!rawLine || IGNORED_SSN_YAML_KEY_RE.test(rawLine)) {
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

export function findDuplicateResidenceSpans(bundle: ArchiveBundle, mode: 'private' | 'public'): string[] {
  const duplicates: string[] = [];
  const seenIds = new Set<string>();
  const seenTuples = new Set<string>();

  for (const span of bundle.residence_spans) {
    if (seenIds.has(span.id)) {
      duplicates.push(`${mode}:id:${span.id}`);
    } else {
      seenIds.add(span.id);
    }

    const tupleKey = `${span.person_id}|${span.place_id}|${span.time_min}|${span.time_max}|${span.from_event_id}|${span.to_event_id}`;
    if (seenTuples.has(tupleKey)) {
      duplicates.push(`${mode}:span:${span.id}(${span.person_id}@${span.place_id})`);
    } else {
      seenTuples.add(tupleKey);
    }
  }

  return duplicates;
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

  const privateResult = compileArchive({ ...compileBase, mode: 'private' });
  const publicResult = compileArchive({ ...compileBase, mode: 'public' });

  ArchiveBundleSchema.parse(privateResult.bundle);
  ArchiveBundleSchema.parse(publicResult.bundle);

  const privateLivingLeaks = auditBundlePrivacy(privateResult.bundle, 'private');
  const publicLivingLeaks = auditBundlePrivacy(publicResult.bundle, 'public');
  const duplicateResidenceSpans = [
    ...findDuplicateResidenceSpans(privateResult.bundle, 'private'),
    ...findDuplicateResidenceSpans(publicResult.bundle, 'public'),
  ];

  return {
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
  };
}

function pushTextTarget(
  targets: LivingNameTarget[],
  location: string,
  text: string | null | undefined,
  maxYear?: number | null
): void {
  if (typeof text === 'string' && text.length > 0) {
    targets.push({ location, text, maxYear: maxYear ?? null });
  }
}

export function scanPublicLivingNames(input: {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  sources: readonly SourceRecord[];
  media: readonly MediaItem[];
  narratives: readonly Narrative[];
  privacy?: Partial<PrivacyConfig>;
}): VerifyLivingNamesResult {
  const livingIds = new Set<string>();
  const livingPeople: RawPerson[] = [];
  const deceasedPeople: RawPerson[] = [];
  for (const person of input.people) {
    if (resolveEffectiveLiving(person, input.privacy)) {
      livingIds.add(person.id);
      livingPeople.push(person);
    } else {
      deceasedPeople.push(person);
    }
  }

  const scrubPattern = compileLivingNamePattern(
    collectLivingNames(
      livingPeople.map((person) => ({
        is_living: true,
        full_name: person.full_name,
        alt_names: person.alt_names,
      }))
    )
  );
  const publicNarratives = filterNarrativesForPrivacy(input.narratives, livingIds, scrubPattern, 'public');
  const peopleById = new Map(
    input.people.map((person) => [person.id, { ...person, is_living: livingIds.has(person.id) }])
  );
  const eventsById = new Map(
    input.events.map((event) => [event.id, { id: event.id, participants: event.participants }])
  );
  const publicMedia = filterMediaForPrivacy(input.media, peopleById, eventsById, {
    stripLivingPortraits: true,
  });

  const eventMaxYearById = new Map<string, number | null>();
  for (const event of input.events) {
    eventMaxYearById.set(event.id, extractLatestEdtfYear(event.edtf_date));
  }
  const sourceMaxYearById = computeSourceMaxYearById(input.events);
  const deathYearByPersonId = new Map<string, number | null>(
    input.people.map((person) => [person.id, extractLatestEdtfYear(person.death_edtf)])
  );

  const targets: LivingNameTarget[] = [];
  for (const narrative of [...publicNarratives].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const narrativeMaxYear = resolveNarrativeMaxYear({
      subjectPersonId: narrative.subject_person_id,
      personIds: narrative.person_ids,
      eventIds: narrative.event_ids,
      livingIds,
      deathYearByPersonId,
      eventMaxYearById,
    });
    pushTextTarget(targets, `narrative:${narrative.id}:title`, narrative.title, narrativeMaxYear);
    pushTextTarget(targets, `narrative:${narrative.id}:summary`, narrative.summary, narrativeMaxYear);
    pushTextTarget(targets, `narrative:${narrative.id}:body_md`, narrative.body_md, narrativeMaxYear);
  }
  for (const item of [...publicMedia].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const mediaMaxYear =
      extractLatestEdtfYear(item.date_edtf) ??
      (item.event_id ? (eventMaxYearById.get(item.event_id) ?? null) : null);
    pushTextTarget(targets, `media:${item.id}:caption`, item.caption, mediaMaxYear);
    pushTextTarget(targets, `media:${item.id}:provenance`, item.provenance, mediaMaxYear);
  }
  for (const source of [...input.sources].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const sourceMaxYear = sourceMaxYearById.get(source.id) ?? null;
    pushTextTarget(targets, `source:${source.id}:citation`, source.citation, sourceMaxYear);
  }
  for (const event of [...input.events].toSorted((a, b) => a.id.localeCompare(b.id))) {
    const hasLivingParticipant = event.participants.some((participant) =>
      livingIds.has(participant.person_id)
    );
    if (hasLivingParticipant) {
      continue;
    }
    const eventMaxYear = eventMaxYearById.get(event.id) ?? null;
    pushTextTarget(targets, `event:${event.id}:title`, event.title, eventMaxYear);
    pushTextTarget(targets, `event:${event.id}:summary`, event.summary, eventMaxYear);
  }

  const hits = collectLivingNameHitsWithMatcher(
    compileLivingNameMatcher(livingPeople, deceasedPeople),
    targets
  );
  return { ok: hits.length === 0, hits };
}
