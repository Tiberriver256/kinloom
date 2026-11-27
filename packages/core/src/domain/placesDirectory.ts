import type { MigrationEraConfig } from '../schemas/config.js';
import type { ArchiveBundle, Person, Place } from '../schemas/entities.js';
import { getMediaPersonIds } from '../schemas/pureHelpers.js';
import { classifyMigrationStage } from './geoMap.js';

export interface PlaceDirectoryEntry {
  place: Place;
  stage: string;
  minYear: number | null;
  maxYear: number | null;
  eventCount: number;
  people: {
    person: Person;
    startYear: number;
    endYear: number;
    firstEventId: string;
  }[];
}

const CENSUS_ARTIFACT_RE =
  /^(?:same\s+(?:place|house)|unknown|rural|(?:[a-z]\s+)?(?:twp|township)|justice\s+precinct|precinct|district|ward|ed|enumeration\s+district)\s*\d*$/i;

export function resolveCanonicalPlace(
  place: Place | undefined,
  placesById: ReadonlyMap<string, Place>
): Place | null {
  if (!place) {
    return null;
  }
  let current: Place | undefined = place;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (!CENSUS_ARTIFACT_RE.test(current.name.trim())) {
      return current;
    }
    if (!current.parent_id) {
      break;
    }
    const parent = placesById.get(current.parent_id);
    if (!parent || parent.place_type === 'country' || parent.place_type === 'state') {
      break;
    }
    current = parent;
  }
  return current ?? place;
}

/**
 * Pick the best thumbnail per person across portrait_url and linked media (supports both person_id and person_ids[]).
 */
export function buildPersonThumbMap(bundle: ArchiveBundle): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of bundle.people) {
    const portrait = p.thumb_url || p.portrait_url;
    if (portrait) {
      map.set(p.id, portrait);
    }
  }
  const priority: Record<string, number> = {
    portrait: 0,
    family_photo: 1,
    milestone: 2,
    headstone: 3,
    record_scan: 4,
    document_scan: 5,
  };
  const bestRank = new Map<string, number>();
  for (const item of bundle.media ?? []) {
    const rank = priority[item.kind];
    if (rank === undefined) {
      continue;
    }
    for (const pid of getMediaPersonIds(item)) {
      if (map.has(pid) && !bestRank.has(pid)) {
        continue;
      }
      const prev = bestRank.get(pid);
      if (prev === undefined || rank < prev) {
        bestRank.set(pid, rank);
        map.set(pid, item.thumb_file || item.file);
      }
    }
  }
  return map;
}

export function classifyPlaceStage(place: Place, migrationEras?: readonly MigrationEraConfig[]): string {
  return classifyMigrationStage(place, migrationEras);
}

const normalizePlaceKey = (p: Place): string =>
  p.full_name
    .toLowerCase()
    .replace(/,\s*(?:usa|united states|u\.s\.a\.|united kingdom|u\.k\.|uk)$/i, '')
    .replaceAll(/\b(?:district|parish|county|co\.|twp\.?|township)\b/gi, '')
    .replaceAll(/\s*,\s*/g, ', ')
    .replaceAll(/(?:,\s*){2,}/g, ', ')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/^,\s*|,\s*$/g, '')
    .trim();

export function buildPlacesDirectory(
  bundle: ArchiveBundle,
  placesById: ReadonlyMap<string, Place>,
  peopleById: ReadonlyMap<string, Person>,
  migrationEras?: readonly MigrationEraConfig[]
): PlaceDirectoryEntry[] {
  interface PlaceDirBucket {
    place: Place;
    eventCount: number;
    minYear: number | null;
    maxYear: number | null;
    byPerson: Map<string, { person: Person; startYear: number; endYear: number; firstEventId: string }>;
  }

  const map = new Map<string, PlaceDirBucket>();

  const ensure = (place: Place): PlaceDirBucket => {
    const key = normalizePlaceKey(place);
    let rec = map.get(key);
    if (!rec) {
      rec = {
        place,
        eventCount: 0,
        minYear: null,
        maxYear: null,
        byPerson: new Map(),
      };
      map.set(key, rec);
    } else if (place.full_name.length > rec.place.full_name.length) {
      rec.place = place;
    }
    return rec;
  };

  for (const ev of bundle.events) {
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    if (!ev.place_id) {
      continue;
    }
    const rawPlace = placesById.get(ev.place_id);
    const place = resolveCanonicalPlace(rawPlace, placesById);
    if (!place || place.place_type === 'country' || place.place_type === 'state') {
      continue;
    }

    const rec = ensure(place);
    rec.eventCount += 1;

    if (ev.year !== null) {
      if (rec.minYear === null || ev.year < rec.minYear) {
        rec.minYear = ev.year;
      }
      if (rec.maxYear === null || ev.year > rec.maxYear) {
        rec.maxYear = ev.year;
      }
    }

    for (const pt of ev.participants) {
      const person = peopleById.get(pt.person_id);
      if (!person || (person.is_living && person.full_name === 'Living')) {
        continue;
      }
      const y = ev.year ?? person.birth_year ?? 0;
      const cur = rec.byPerson.get(person.id);
      if (cur) {
        if (y > 0 && (cur.startYear === 0 || y < cur.startYear)) {
          cur.startYear = y;
          cur.firstEventId = ev.id;
        }
        if (y > cur.endYear) {
          cur.endYear = y;
        }
      } else {
        rec.byPerson.set(person.id, {
          person,
          startYear: y,
          endYear: y,
          firstEventId: ev.id,
        });
      }
    }
  }

  for (const span of bundle.residence_spans) {
    const rawPlace = placesById.get(span.place_id);
    const place = resolveCanonicalPlace(rawPlace, placesById);
    if (!place || place.place_type === 'country' || place.place_type === 'state') {
      continue;
    }
    const person = peopleById.get(span.person_id);
    if (!person || (person.is_living && person.full_name === 'Living')) {
      continue;
    }

    const rec = ensure(place);
    if (span.start_year !== null && (rec.minYear === null || span.start_year < rec.minYear)) {
      rec.minYear = span.start_year;
    }
    if (span.end_year !== null && (rec.maxYear === null || span.end_year > rec.maxYear)) {
      rec.maxYear = span.end_year;
    }
    const cur = rec.byPerson.get(person.id);
    if (cur) {
      if (span.start_year !== null && (cur.startYear === 0 || span.start_year < cur.startYear)) {
        cur.startYear = span.start_year;
      }
      if (span.end_year !== null && span.end_year > cur.endYear) {
        cur.endYear = span.end_year;
      }
    } else {
      rec.byPerson.set(person.id, {
        person,
        startYear: span.start_year ?? 0,
        endYear: span.end_year ?? span.start_year ?? 0,
        firstEventId: span.from_event_id,
      });
    }
  }

  return [...map.values()]
    .map((rec) => {
      const people = [...rec.byPerson.values()].toSorted(
        (a, b) => a.startYear - b.startYear || a.person.full_name.localeCompare(b.person.full_name)
      );
      return {
        place: rec.place,
        stage: classifyPlaceStage(rec.place, migrationEras),
        minYear: rec.minYear,
        maxYear: rec.maxYear,
        eventCount: rec.eventCount,
        people,
      };
    })
    .filter((entry) => entry.people.length > 0 || entry.eventCount > 0)
    .toSorted(
      (a, b) =>
        b.people.length - a.people.length ||
        b.eventCount - a.eventCount ||
        a.place.full_name.localeCompare(b.place.full_name)
    );
}
