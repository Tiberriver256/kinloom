import type { ArchiveBundle, ArchiveEvent, EntityPayload, MediaItem, Person, Place } from '@kinloom/core';
import { haversineMiles } from '@kinloom/core';

export type PlaceScopeMode = 'exact' | 'radius15' | 'county';

export interface PlaceOccupancyRow {
  readonly person: Person;
  readonly startYear: number;
  readonly endYear: number;
  readonly firstEventId: string;
  readonly tier: 'Confirmed' | 'Inferred' | 'Possible';
}

export interface PlaceOccupancySummary {
  readonly rows: readonly PlaceOccupancyRow[];
  readonly minYear: number;
  readonly maxYear: number;
}

export function resolveMatchingPlaceIds(
  bundle: ArchiveBundle,
  place: Place,
  scopeMode: PlaceScopeMode,
  placesById: ReadonlyMap<string, Place>
): Set<string> {
  const set = new Set<string>([place.id]);
  const myAnc = bundle.place_ancestors[place.id] || [];
  const countyAnc = myAnc.find((id) => placesById.get(id)?.place_type === 'county') || place.parent_id;

  for (const other of bundle.places) {
    if (other.id === place.id) {
      continue;
    }
    if (scopeMode === 'exact') {
      if ((bundle.place_ancestors[other.id] || []).includes(place.id)) {
        set.add(other.id);
      }
    } else if (scopeMode === 'radius15') {
      const d = haversineMiles(place.lat, place.lng, other.lat, other.lng);
      if (d <= 15 || (bundle.place_ancestors[other.id] || []).includes(place.id)) {
        set.add(other.id);
      }
    } else if (scopeMode === 'county') {
      const otherAnc = bundle.place_ancestors[other.id] || [];
      if (
        (countyAnc && otherAnc.includes(countyAnc)) ||
        otherAnc.includes(place.id) ||
        myAnc.includes(other.id)
      ) {
        set.add(other.id);
      }
    }
  }
  return set;
}

export function buildPlaceOccupancySummary(
  bundle: ArchiveBundle,
  matchingPlaceIds: ReadonlySet<string>,
  peopleById: ReadonlyMap<string, Person>
): PlaceOccupancySummary {
  const byPerson = new Map<
    string,
    {
      person: Person;
      startYear: number;
      endYear: number;
      firstEventId: string;
      tier: 'Confirmed' | 'Inferred' | 'Possible';
    }
  >();

  for (const ev of bundle.events) {
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    if (!ev.place_id || !matchingPlaceIds.has(ev.place_id) || ev.year === null) {
      continue;
    }
    for (const pt of ev.participants) {
      const person = peopleById.get(pt.person_id);
      if (!person || person.full_name === 'Living') {
        continue;
      }
      const cur = byPerson.get(person.id);
      if (cur) {
        if (ev.year < cur.startYear) {
          cur.startYear = ev.year;
          cur.firstEventId = ev.id;
        }
        if (ev.year > cur.endYear) {
          cur.endYear = ev.year;
        }
      } else {
        byPerson.set(person.id, {
          person,
          startYear: ev.year,
          endYear: ev.year,
          firstEventId: ev.id,
          tier: 'Confirmed',
        });
      }
    }
  }

  for (const span of bundle.residence_spans) {
    if (!matchingPlaceIds.has(span.place_id)) {
      continue;
    }
    if (span.start_year === null || span.end_year === null) {
      continue;
    }
    const person = peopleById.get(span.person_id);
    if (!person || person.full_name === 'Living') {
      continue;
    }
    const cur = byPerson.get(person.id);
    if (cur) {
      if (span.start_year < cur.startYear) {
        cur.startYear = span.start_year;
      }
      if (span.end_year > cur.endYear) {
        cur.endYear = span.end_year;
      }
    } else {
      byPerson.set(person.id, {
        person,
        startYear: span.start_year,
        endYear: span.end_year,
        firstEventId: span.from_event_id,
        tier: span.confidence_tier,
      });
    }
  }

  const rows = [...byPerson.values()].toSorted((a, b) => a.startYear - b.startYear);
  const minYear = rows.length > 0 ? Math.min(...rows.map((r) => r.startYear)) : 1850;
  const maxYear = rows.length > 0 ? Math.max(...rows.map((r) => r.endYear)) : 1960;
  return { rows, minYear, maxYear: Math.max(maxYear, minYear + 10) };
}

export function collectPlaceLocalRecords(
  bundle: ArchiveBundle,
  matchingPlaceIds: ReadonlySet<string>
): ArchiveEvent[] {
  return bundle.events
    .filter((ev) => {
      if (ev.scope !== 'local' && ev.scope !== 'state') {
        return false;
      }
      if (!ev.place_id) {
        return false;
      }
      return matchingPlaceIds.has(ev.place_id);
    })
    .toSorted((a, b) => (a.year ?? 0) - (b.year ?? 0));
}

export function collectRecordDecades(records: readonly ArchiveEvent[]): number[] {
  const set = new Set<number>();
  for (const ev of records) {
    if (ev.year !== null) {
      set.add(Math.floor(ev.year / 10) * 10);
    }
  }
  return [...set].toSorted((a, b) => a - b);
}

export function filterLocalRecordsByDecade(
  records: readonly ArchiveEvent[],
  effectiveDecadeFilter: string
): readonly ArchiveEvent[] {
  if (effectiveDecadeFilter === 'all') {
    return records;
  }
  return records.filter((ev) => {
    if (ev.year === null) {
      return false;
    }
    return String(Math.floor(ev.year / 10) * 10) === effectiveDecadeFilter;
  });
}

export function buildPlaceEditInitialData(place: Place): EntityPayload {
  return {
    id: place.id,
    slug: place.slug,
    name: place.name,
    full_name: place.full_name,
    place_type: place.place_type,
    parent_id: place.parent_id,
    lat: place.lat,
    lng: place.lng,
    summary: place.summary ?? '',
    photo_url: place.photo_url ?? null,
    photo_caption: place.photo_caption ?? null,
    pronunciation: place.pronunciation ?? null,
    has_primary_source: place.has_primary_source,
  };
}

export function computeOccupancyDecadeTicks(minYear: number, maxYear: number): number[] {
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear) || maxYear <= minYear) {
    return [];
  }
  const spanYears = maxYear - minYear;
  let step = 50;
  if (spanYears <= 120) {
    step = 10;
  } else if (spanYears <= 240) {
    step = 20;
  }
  const firstTick = Math.ceil(minYear / step) * step;
  const ticks: number[] = [];
  for (let year = firstTick; year <= maxYear; year += step) {
    ticks.push(year);
  }
  return ticks;
}

export function buildPlacePhotoMedia(place: Place): MediaItem | null {
  if (!place.photo_url) {
    return null;
  }
  return {
    id: `place-photo-${place.id}`,
    kind: 'milestone',
    file: place.photo_url,
    caption: place.photo_caption || `Archival view of ${place.full_name}`,
  };
}
