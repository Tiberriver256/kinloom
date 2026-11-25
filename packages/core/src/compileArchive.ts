import type { KinloomSiteConfig } from './schemas/config.js';
import { resolveDefaultBranchId } from './schemas/config.js';
import type {
  ArchiveBundle,
  ArchiveEvent,
  BuildMode,
  EventSourceRef,
  KinshipEdge,
  MediaItem,
  Narrative,
  NarrativeEnrichment,
  NarrativeEnrichmentOverride,
  Person,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from './schemas/entities.js';
import { getMediaPersonIds } from './schemas/entities.js';
import { edtfToBounds, edtfYear, formatEdtfDisplay } from './edtf.js';
import { applyCitationCleanings } from './gedcom/citations.js';
import { applyPrivacyFilter, filterMediaForPrivacy } from './privacy.js';
import { buildPlaceAncestors, deriveResidenceSpans } from './residenceSpans.js';

export interface AncestryHouseholdEvent {
  type?: string;
  description?: string;
  date?: string;
}

export interface AncestryPersonRecord {
  personId?: string | number;
  events?: AncestryHouseholdEvent[];
}

export interface CompiledMediaOverlay {
  media?: readonly MediaItem[];
  people?: readonly { id: string; portrait_url?: string | null }[];
  events?: readonly { id: string; photo_url?: string }[];
}

export interface CompileArchiveInput {
  people: readonly RawPerson[];
  events: readonly RawEvent[];
  places: readonly Place[];
  sources: readonly SourceRecord[];
  kinship: readonly KinshipEdge[];
  enrichments?: readonly NarrativeEnrichment[];
  contextEvents?: readonly RawEvent[];
  contextSources?: readonly SourceRecord[];
  media?: readonly MediaItem[];
  narratives?: readonly Narrative[];
  ancestryPeople?: readonly AncestryPersonRecord[];
  compiledMediaOverlay?: CompiledMediaOverlay | null;
  resolveThumbUrl?: (mediaUrl: string | null | undefined) => string | undefined;
  mediaExists?: (fileUrl: string) => boolean;
  siteConfig: KinloomSiteConfig;
  mode: BuildMode;
  generatedAt?: string;
  version?: string;
  legacyContainerSourceIds?: ReadonlySet<string>;
}

export interface CompileArchiveResult {
  bundle: ArchiveBundle;
  reviewFlags: string[];
  enrichedHouseholdCount: number;
}

function isEnrichmentOverride(
  enr: NarrativeEnrichment
): enr is NarrativeEnrichmentOverride {
  return 'override_event_id' in enr && typeof enr.override_event_id === 'string';
}

export function mergeEventSources(
  existing: readonly EventSourceRef[],
  additions: readonly EventSourceRef[]
): EventSourceRef[] {
  const merged: EventSourceRef[] = [];
  const idxById = new Map<string, number>();

  const upsert = (entry: EventSourceRef): void => {
    const sid = entry.source_id;
    const existingIdx = sid ? idxById.get(sid) : undefined;
    if (existingIdx === undefined) {
      if (sid) {
        idxById.set(sid, merged.length);
      }
      merged.push({ ...entry });
      return;
    }
    const prev = { ...merged[existingIdx] };
    if (entry.confidence) {
      prev.confidence = entry.confidence;
    }
    if (entry.claimed_date !== undefined && entry.claimed_date !== '') {
      prev.claimed_date = entry.claimed_date;
    }
    if (entry.citation_detail !== undefined && entry.citation_detail !== '') {
      prev.citation_detail = entry.citation_detail;
    }
    if (entry.scan_url !== undefined && entry.scan_url !== '') {
      prev.scan_url = entry.scan_url;
    }
    if (entry.scan_title !== undefined && entry.scan_title !== '') {
      prev.scan_title = entry.scan_title;
    }
    merged[existingIdx] = prev;
  };

  for (const entry of existing) {
    upsert(entry);
  }
  for (const entry of additions) {
    upsert(entry);
  }
  return merged;
}

function resolvePersonBranch(person: RawPerson, siteConfig: KinloomSiteConfig): string {
  if (person.branch) {
    return person.branch;
  }
  const surnameLower = person.surname.trim().toLowerCase();
  for (const branch of siteConfig.branches) {
    if (branch.lineageGroups.length > 0 && branch.lineageGroups.includes(person.lineage_group)) {
      return branch.id;
    }
    if (
      surnameLower &&
      branch.surnames.some((s) => s.trim().toLowerCase() === surnameLower)
    ) {
      return branch.id;
    }
  }
  return resolveDefaultBranchId(siteConfig);
}

function enrichHouseholdDescriptions(
  events: RawEvent[],
  people: readonly RawPerson[],
  ancestryPeople: readonly AncestryPersonRecord[] | undefined
): number {
  if (!ancestryPeople || ancestryPeople.length === 0) {
    return 0;
  }
  const ancestryByXref = new Map<string, AncestryPersonRecord>();
  for (const ap of ancestryPeople) {
    const numId = String(ap.personId ?? '').split(':')[0];
    if (numId) {
      ancestryByXref.set(`@I${numId}@`, ap);
    }
  }
  const peopleById = new Map(people.map((p) => [p.id, p]));
  let enriched = 0;

  for (const ev of events) {
    if (ev.event_kind !== 'residence_anchor') {
      continue;
    }
    const [firstPart] = ev.participants;
    if (!firstPart) {
      continue;
    }
    const person = peopleById.get(firstPart.person_id);
    if (!person || person.is_living || !person.gedcom_xref) {
      continue;
    }
    const ancestry = ancestryByXref.get(person.gedcom_xref);
    if (!ancestry || !Array.isArray(ancestry.events)) {
      continue;
    }
    const year = edtfYear(ev.edtf_date);
    if (year === null) {
      continue;
    }
    const summary = ev.summary || '';
    if (!summary.startsWith('Archival residence record places')) {
      continue;
    }
    const match = ancestry.events.find(
      (entry) =>
        entry.type === 'Residence' &&
        Boolean(entry.description) &&
        String(entry.date ?? '').includes(String(year))
    );
    if (match?.description && !summary.includes(match.description)) {
      ev.summary = `${summary} (${match.description}).`;
      enriched += 1;
    }
  }
  return enriched;
}

const ALLOWED_MANUAL_MEDIA_KINDS = new Set([
  'milestone',
  'portrait',
  'headstone',
  'family_photo',
  'document_scan',
  'record_scan',
]);

/**
 * Pure TypeScript archive compiler replacing legacy Python build.py.
 */
export function compileArchive(input: CompileArchiveInput): CompileArchiveResult {
  const {
    siteConfig,
    mode,
    generatedAt = new Date().toISOString(),
    version,
    resolveThumbUrl,
    mediaExists,
    legacyContainerSourceIds,
  } = input;

  // Stage 1: Clone inputs and assign branches from siteConfig
  const rawPeople: RawPerson[] = input.people.map((p) => {
    const clone = structuredClone(p);
    clone.branch = resolvePersonBranch(clone, siteConfig);
    return clone;
  });

  const rawEvents: RawEvent[] = input.events.map((e) => structuredClone(e));
  const places: Place[] = input.places.map((p) => structuredClone(p));
  const kinship: KinshipEdge[] = input.kinship.map((k) => structuredClone(k));

  const combinedSources: SourceRecord[] = [
    ...input.sources.map((s) => structuredClone(s)),
    ...(input.contextSources ?? []).map((s) => structuredClone(s)),
  ];

  // Apply narrative enrichments (overrides and appended events)
  const rawEventsById = new Map<string, RawEvent>(rawEvents.map((e) => [e.id, e]));
  for (const enr of input.enrichments ?? []) {
    if (isEnrichmentOverride(enr)) {
      const target = rawEventsById.get(enr.override_event_id);
      if (!target) {
        continue;
      }
      if (enr.title !== undefined) {
        target.title = enr.title;
      }
      if (enr.summary !== undefined) {
        target.summary = enr.summary;
      }
      if (enr.category !== undefined) {
        target.category = enr.category;
      }
      if (enr.severity_rank !== undefined) {
        target.severity_rank = enr.severity_rank;
      }
      if (enr.photo_url !== undefined) {
        target.photo_url = enr.photo_url;
      }
      if (enr.photo_placeholder_caption !== undefined) {
        target.photo_placeholder_caption = enr.photo_placeholder_caption;
      }
      if (enr.sources !== undefined) {
        target.sources = mergeEventSources(target.sources, enr.sources);
      }
      if (enr.alternate_dates !== undefined) {
        target.alternate_dates = [...(target.alternate_dates ?? []), ...structuredClone(enr.alternate_dates)];
      }
      if (enr.alternate_places !== undefined) {
        target.alternate_places = [...(target.alternate_places ?? []), ...structuredClone(enr.alternate_places)];
      }
      if (enr.fact_conflicts !== undefined) {
        target.fact_conflicts = [...(target.fact_conflicts ?? []), ...structuredClone(enr.fact_conflicts)];
      }
    } else {
      const clone = structuredClone(enr);
      rawEvents.push(clone);
      rawEventsById.set(clone.id, clone);
    }
  }

  const enrichedHouseholdCount = enrichHouseholdDescriptions(
    rawEvents,
    rawPeople,
    input.ancestryPeople
  );

  // Merge external context events
  for (const ctxEv of input.contextEvents ?? []) {
    rawEvents.push(structuredClone(ctxEv));
  }

  // Build maps for places and sources
  const placesById = new Map<string, Place>(places.map((p) => [p.id, p]));
  const sourcesById = new Map<string, SourceRecord>();
  for (const s of combinedSources) {
    sourcesById.set(s.id, s);
  }
  const uniqueSources = [...sourcesById.values()];
  const placeAncestors = buildPlaceAncestors(placesById);

  // Stage 2: Parse temporal bounds and place ancestor chains
  const timedEvents: ArchiveEvent[] = rawEvents.map((ev) => {
    const edtf = ev.edtf_date || '';
    const bounds = edtfToBounds(edtf);
    return {
      ...ev,
      time_min: bounds ? bounds[0] : null,
      time_max: bounds ? bounds[1] : null,
      display_date: formatEdtfDisplay(edtf),
      year: edtfYear(edtf),
      place_ancestors: ev.place_id ? [...(placeAncestors[ev.place_id] ?? [])] : [],
    };
  });

  // Apply GEDCOM citation cleanings
  applyCitationCleanings(timedEvents, uniqueSources, legacyContainerSourceIds);

  // Stage 3: Derive residence spans
  const rawSpans = deriveResidenceSpans(rawPeople, timedEvents, placesById);

  // Stage 5: Apply living-person privacy filter
  const {
    people: redactedRawPeople,
    events: redactedEvents,
    residenceSpans,
    reviewFlags,
  } = applyPrivacyFilter(rawPeople, timedEvents, rawSpans, mode);

  // Sort events chronologically matching Python's stable sort tuple: (time_min is None, time_min or 99999999, -(severity_rank or 0))
  const sortedEvents = redactedEvents.toSorted((a, b) => {
    const aNone = a.time_min === null ? 1 : 0;
    const bNone = b.time_min === null ? 1 : 0;
    if (aNone !== bNone) {
      return aNone - bNone;
    }
    const aMin = a.time_min ?? 99_999_999;
    const bMin = b.time_min ?? 99_999_999;
    if (aMin !== bMin) {
      return aMin - bMin;
    }
    return (b.severity_rank ?? 0) - (a.severity_rank ?? 0);
  });

  // Compute compiled Person summary fields
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

  const compiledPeople: Person[] = redactedRawPeople.map((p) => {
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

  // Merge compiled media overlay + curated media list
  const mergedMedia: MediaItem[] = [];
  const seenMediaIds = new Set<string>();
  const compiledPortraitByPerson = new Map<string, string>();
  const compiledPhotoByEvent = new Map<string, string>();
  const captionByFile = new Map<string, string>();

  if (input.compiledMediaOverlay) {
    for (const item of input.compiledMediaOverlay.media ?? []) {
      if (mediaExists && item.file.startsWith('/media/') && !mediaExists(item.file)) {
        continue;
      }
      const clone = structuredClone(item);
      mergedMedia.push(clone);
      if (clone.id) {
        seenMediaIds.add(clone.id);
      }
      if (clone.file && clone.caption && !captionByFile.has(clone.file)) {
        captionByFile.set(clone.file, clone.caption);
      }
    }
    for (const p of input.compiledMediaOverlay.people ?? []) {
      if (p.id && p.portrait_url) {
        compiledPortraitByPerson.set(p.id, p.portrait_url);
      }
    }
    for (const ev of input.compiledMediaOverlay.events ?? []) {
      if (ev.id && ev.photo_url) {
        compiledPhotoByEvent.set(ev.id, ev.photo_url);
      }
    }
  }

  for (const item of input.media ?? []) {
    if (!ALLOWED_MANUAL_MEDIA_KINDS.has(item.kind) || !item.file) {
      continue;
    }
    if (seenMediaIds.has(item.id)) {
      continue;
    }
    if (mediaExists && item.file.startsWith('/media/') && !mediaExists(item.file)) {
      continue;
    }
    const clone = structuredClone(item);
    mergedMedia.push(clone);
    seenMediaIds.add(clone.id);
    if (clone.file && clone.caption && !captionByFile.has(clone.file)) {
      captionByFile.set(clone.file, clone.caption);
    }
  }

  const peopleById = new Map<string, Person>(compiledPeople.map((p) => [p.id, p]));
  const eventsById = new Map<string, ArchiveEvent>(sortedEvents.map((e) => [e.id, e]));
  const livingIds = new Set(compiledPeople.filter((p) => p.is_living).map((p) => p.id));

  // Filter media for living-person privacy across both person_id and person_ids[]
  const finalMedia = filterMediaForPrivacy(mergedMedia, peopleById, eventsById);

  const mediaCounts = new Map<string, number>();
  const portraitFromMedia = new Map<string, string>();
  const eventPhotoFromMedia = new Map<string, { file: string; caption: string }>();
  const overlayMediaIds = new Set(
    (input.compiledMediaOverlay?.media ?? []).map((m) => m.id).filter(Boolean)
  );
  const EVENT_HERO_MEDIA_KINDS = new Set(['milestone', 'headstone', 'family_photo']);

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
    if (person.is_living) {
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
    if (hasLiving) {
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

  const narratives = input.narratives
    ? input.narratives.map((n) => structuredClone(n))
    : undefined;

  const bundle: ArchiveBundle = {
    meta: {
      ...(version ? { version } : {}),
      build_mode: mode,
      generated_at: generatedAt,
      counts: {
        people: compiledPeople.length,
        living_redacted: compiledPeople.filter((p) => p.is_living).length,
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
  };

  return {
    bundle,
    reviewFlags,
    enrichedHouseholdCount,
  };
}
