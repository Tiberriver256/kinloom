import { edtfToBounds, edtfYear, formatEdtfDisplay } from '../edtf.js';
import type { KinloomSiteConfig } from '../schemas/config.js';
import { resolveDefaultBranchId } from '../schemas/config.js';
import type {
  ArchiveEvent,
  EventSourceRef,
  MediaItem,
  Narrative,
  NarrativeEnrichment,
  NarrativeEnrichmentOverride,
  Person,
  Place,
  RawEvent,
  RawPerson,
  SourceRecord,
} from '../schemas/entities.js';
import type { AncestryPersonRecord } from './types.js';

function isEnrichmentOverride(enr: NarrativeEnrichment): enr is NarrativeEnrichmentOverride {
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

export function resolvePersonBranch(
  person: Pick<RawPerson, 'branch' | 'surname' | 'lineage_group'>,
  siteConfig: KinloomSiteConfig
): string {
  if (person.branch) {
    return person.branch;
  }
  const surnameLower = person.surname.trim().toLowerCase();
  for (const branch of siteConfig.branches) {
    if (branch.lineageGroups.length > 0 && branch.lineageGroups.includes(person.lineage_group)) {
      return branch.id;
    }
    if (surnameLower && branch.surnames.some((s) => s.trim().toLowerCase() === surnameLower)) {
      return branch.id;
    }
  }
  return resolveDefaultBranchId(siteConfig);
}

export function compareArchiveEvents(
  a: Pick<ArchiveEvent, 'id' | 'time_min' | 'severity_rank'>,
  b: Pick<ArchiveEvent, 'id' | 'time_min' | 'severity_rank'>
): number {
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
  const sevDiff = (b.severity_rank ?? 0) - (a.severity_rank ?? 0);
  if (sevDiff !== 0) {
    return sevDiff;
  }
  return a.id.localeCompare(b.id);
}

export function buildTimedEvent(
  ev: RawEvent,
  placeAncestors: Readonly<Record<string, readonly string[]>>
): ArchiveEvent {
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
}

export function collectUncitedEntityKeys(bundle: {
  people: readonly Pick<Person, 'id' | 'has_primary_source'>[];
  events: readonly Pick<ArchiveEvent, 'id' | 'has_primary_source'>[];
  places: readonly Pick<Place, 'id' | 'has_primary_source'>[];
  sources: readonly Pick<SourceRecord, 'id' | 'has_primary_source'>[];
  media?: readonly Pick<MediaItem, 'id' | 'has_primary_source'>[];
  narratives?: readonly Pick<Narrative, 'id' | 'has_primary_source'>[];
}): string[] {
  const uncited: string[] = [];
  const collections: ReadonlyArray<
    readonly [string, readonly { id: string; has_primary_source?: boolean }[]]
  > = [
    ['person', bundle.people],
    ['event', bundle.events],
    ['place', bundle.places],
    ['source', bundle.sources],
    ['media', bundle.media ?? []],
    ['narrative', bundle.narratives ?? []],
  ];
  for (const [prefix, items] of collections) {
    for (const item of items) {
      if (item.has_primary_source === false) {
        uncited.push(`${prefix}:${item.id}`);
      }
    }
  }
  return uncited.toSorted();
}

export function applyNarrativeEnrichments(
  rawEvents: RawEvent[],
  enrichments: readonly NarrativeEnrichment[] | undefined
): void {
  if (!enrichments || enrichments.length === 0) {
    return;
  }
  const rawEventsById = new Map<string, RawEvent>(rawEvents.map((e) => [e.id, e]));
  for (const enr of enrichments) {
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
        target.alternate_places = [
          ...(target.alternate_places ?? []),
          ...structuredClone(enr.alternate_places),
        ];
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
}

export function enrichHouseholdDescriptions(
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
