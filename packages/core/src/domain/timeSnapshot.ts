import { getCurrentReferenceYear } from '../clock.js';
import type { AnchorYearConfig } from '../schemas/config.js';
import type { ArchiveBundle, ArchiveEvent, ConfidenceTier, Person, Place } from '../schemas/entities.js';
import { DEFAULT_ANCHOR_YEARS } from '../schemas/pureHelpers.js';
import {
  buildPersonThumbMap,
  buildPlacesDirectory,
  classifyPlaceStage,
  type PlaceDirectoryEntry,
  resolveCanonicalPlace,
} from './placesDirectory.js';

export {
  buildPersonThumbMap,
  buildPlacesDirectory,
  classifyPlaceStage,
  type PlaceDirectoryEntry,
  resolveCanonicalPlace,
};

export interface TimePersonEntry {
  person: Person;
  age: number | null;
  place: Place | null;
  tier: ConfidenceTier | 'Unlocated';
  activityTitle: string;
  activityNote: string;
  nearestEventId: string | null;
  exactYearMatch: boolean;
}

export interface TimePlaceLane {
  place: Place;
  people: TimePersonEntry[];
  localEvents: ArchiveEvent[];
}

export interface TimeSnapshot {
  year: number;
  totalAlive: number;
  locatedCount: number;
  unlocatedCount: number;
  lanes: TimePlaceLane[];
  unlocatedPeople: TimePersonEntry[];
  macroEvents: ArchiveEvent[];
}

export interface SuggestedYearMarker {
  year: number;
  label: string;
  aliveCount: number;
  locatedCount: number;
}

const MAX_INFERRED_GAP_YEARS = 6;
const MAX_POSSIBLE_GAP_YEARS = 15;
const MS_PER_DAY = 86_400_000;
const DEFAULT_MAX_LIFESPAN = 82;
const DEFAULT_LOOKBACK_WHEN_NO_BIRTH = 72;

function epochDaysToDate(epochDays: number): Date {
  return new Date(epochDays * MS_PER_DAY);
}

export function isPersonAliveInYear(
  person: Person,
  year: number,
  personEventYears?: readonly number[],
  referenceYear = getCurrentReferenceYear()
): boolean {
  if (person.is_living && person.full_name === 'Living') {
    return false;
  }

  const b = person.birth_year;
  const d = person.death_year;

  if (b !== null && d !== null) {
    return year >= b && year <= d;
  }
  if (b !== null) {
    const inferredEnd = Math.min(referenceYear, b + DEFAULT_MAX_LIFESPAN);
    return year >= b && year <= inferredEnd;
  }
  if (d !== null) {
    const inferredStart = d - DEFAULT_LOOKBACK_WHEN_NO_BIRTH;
    return year >= inferredStart && year <= d;
  }
  if (personEventYears && personEventYears.length > 0) {
    const minY = Math.min(...personEventYears) - 5;
    const maxY = Math.max(...personEventYears) + 5;
    return year >= minY && year <= maxY;
  }
  return false;
}

function summarizeActivity(
  ev: ArchiveEvent,
  personName: string,
  fallbackPlaceName?: string
): { title: string; note: string } {
  let title = (ev.title || 'Recorded milestone').trim();
  if (title.toLowerCase().startsWith(`${personName.toLowerCase()} `)) {
    const rest = title.slice(personName.length + 1).trim();
    if (rest.length > 3) {
      title = rest.charAt(0).toUpperCase() + rest.slice(1);
    }
  }
  const raw = (ev.summary || '').trim();
  if (!raw) {
    return {
      title,
      note: fallbackPlaceName ? `Recorded in ${fallbackPlaceName}.` : '',
    };
  }
  if (/^archival residence record places\s+/i.test(raw)) {
    return {
      title: fallbackPlaceName ? `Resided in ${fallbackPlaceName}` : title,
      note: ev.display_date
        ? `Documented by ${ev.display_date} residence record.`
        : 'Documented residence record.',
    };
  }
  const firstSentence = raw.split(/(?<=[.!?])\s+/)[0] || raw;
  const clipped = firstSentence.length > 130 ? `${firstSentence.slice(0, 127).trimEnd()}…` : firstSentence;
  return { title, note: clipped };
}

export function compareTimeLanes(a: TimePlaceLane, b: TimePlaceLane): number {
  return (
    a.place.name.localeCompare(b.place.name, undefined, { sensitivity: 'base', numeric: true }) ||
    a.place.full_name.localeCompare(b.place.full_name, undefined, {
      sensitivity: 'base',
      numeric: true,
    })
  );
}

export function computeTimeSnapshot(
  bundle: ArchiveBundle,
  year: number,
  placesById: ReadonlyMap<string, Place>,
  referenceYear = getCurrentReferenceYear()
): TimeSnapshot {
  const eventsByPerson = new Map<string, ArchiveEvent[]>();
  for (const ev of bundle.events) {
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    for (const pt of ev.participants) {
      const list = eventsByPerson.get(pt.person_id) ?? [];
      list.push(ev);
      eventsByPerson.set(pt.person_id, list);
    }
  }

  const spansByPerson = new Map<string, typeof bundle.residence_spans>();
  for (const span of bundle.residence_spans) {
    const list = spansByPerson.get(span.person_id) ?? [];
    list.push(span);
    spansByPerson.set(span.person_id, list);
  }

  const locatedByPlace = new Map<string, TimePersonEntry[]>();
  const unlocatedPeople: TimePersonEntry[] = [];

  for (const person of bundle.people) {
    if (person.is_living && person.full_name === 'Living') {
      continue;
    }

    const pEvents = eventsByPerson.get(person.id) ?? [];
    const datedYears = pEvents.map((e) => e.year).filter((y): y is number => y !== null);

    if (!isPersonAliveInYear(person, year, datedYears, referenceYear)) {
      continue;
    }

    const age = person.birth_year === null ? null : Math.max(0, year - person.birth_year);

    const sameYearEvents = pEvents.filter((e) => e.year === year);
    const sameYearWithPlace = sameYearEvents.find((e) => e.place_id && placesById.has(e.place_id));
    if (sameYearWithPlace?.place_id) {
      const place = resolveCanonicalPlace(placesById.get(sameYearWithPlace.place_id), placesById);
      if (!place) {
        continue;
      }
      const act = summarizeActivity(sameYearWithPlace, person.full_name, place.name);
      const entry: TimePersonEntry = {
        person,
        age,
        place,
        tier: 'Confirmed',
        activityTitle: act.title,
        activityNote: act.note,
        nearestEventId: sameYearWithPlace.id,
        exactYearMatch: true,
      };
      const arr = locatedByPlace.get(place.id) ?? [];
      arr.push(entry);
      locatedByPlace.set(place.id, arr);
      continue;
    }

    const pSpans = (spansByPerson.get(person.id) ?? []).filter(
      (s) =>
        s.start_year !== null &&
        s.end_year !== null &&
        s.start_year <= year &&
        year <= s.end_year &&
        placesById.has(s.place_id)
    );
    if (pSpans.length > 0) {
      const rank: Record<ConfidenceTier, number> = { Confirmed: 0, Inferred: 1, Possible: 2 };
      pSpans.sort((a, b) => {
        const rd = rank[a.confidence_tier] - rank[b.confidence_tier];
        if (rd !== 0) {
          return rd;
        }
        return (a.end_year ?? 0) - (a.start_year ?? 0) - ((b.end_year ?? 0) - (b.start_year ?? 0));
      });
      const [bestSpan] = pSpans;
      const place = resolveCanonicalPlace(placesById.get(bestSpan.place_id), placesById);
      if (!place) {
        continue;
      }

      let closestEv: ArchiveEvent | null = null;
      let closestGap = Infinity;
      for (const ev of pEvents) {
        if (ev.year === null) {
          continue;
        }
        const g = Math.abs(ev.year - year);
        if (g < closestGap) {
          closestGap = g;
          closestEv = ev;
        }
      }

      const [sameYearNoPlace] = sameYearEvents;
      const spanYearsText = `${bestSpan.start_year}–${bestSpan.end_year}`;
      const activityTitle = sameYearNoPlace
        ? summarizeActivity(sameYearNoPlace, person.full_name, place.name).title
        : `Residing in ${place.name}`;
      let activityNote = `Documented in ${place.name} across ${spanYearsText}.`;
      if (sameYearNoPlace) {
        activityNote = summarizeActivity(sameYearNoPlace, person.full_name, place.name).note;
      } else if (closestEv && closestGap <= 3) {
        activityNote = `${summarizeActivity(closestEv, person.full_name, place.name).title} (${closestEv.display_date}); residing here ${spanYearsText}.`;
      }

      const entry: TimePersonEntry = {
        person,
        age,
        place,
        tier: bestSpan.confidence_tier,
        activityTitle,
        activityNote,
        nearestEventId: sameYearNoPlace?.id || closestEv?.id || bestSpan.from_event_id || null,
        exactYearMatch: Boolean(sameYearNoPlace),
      };
      const arr = locatedByPlace.get(place.id) ?? [];
      arr.push(entry);
      locatedByPlace.set(place.id, arr);
      continue;
    }

    let bestEv: ArchiveEvent | null = null;
    let bestDiff = Infinity;
    for (const ev of pEvents) {
      if (ev.year === null || !ev.place_id || !placesById.has(ev.place_id)) {
        continue;
      }
      const diff = Math.abs(ev.year - year);
      const weighted = diff + (ev.year > year ? 0.25 : 0);
      if (diff <= MAX_POSSIBLE_GAP_YEARS && weighted < bestDiff) {
        bestDiff = weighted;
        bestEv = ev;
      }
    }

    if (bestEv?.place_id) {
      const place = resolveCanonicalPlace(placesById.get(bestEv.place_id), placesById);
      if (!place) {
        continue;
      }
      const rawDiff = Math.abs((bestEv.year ?? year) - year);
      const tier: ConfidenceTier = rawDiff <= MAX_INFERRED_GAP_YEARS ? 'Inferred' : 'Possible';
      const direction = (bestEv.year ?? year) <= year ? 'Last recorded' : 'Recorded';
      const [sameYearNoPlace] = sameYearEvents;
      const cleanedBest = summarizeActivity(bestEv, person.full_name, place.name);
      const entry: TimePersonEntry = {
        person,
        age,
        place,
        tier,
        activityTitle: sameYearNoPlace
          ? summarizeActivity(sameYearNoPlace, person.full_name, place.name).title
          : `Likely in ${place.name}`,
        activityNote: sameYearNoPlace
          ? summarizeActivity(sameYearNoPlace, person.full_name, place.name).note
          : `${direction} in ${bestEv.year}: ${cleanedBest.title}.`,
        nearestEventId: sameYearNoPlace?.id || bestEv.id,
        exactYearMatch: Boolean(sameYearNoPlace),
      };
      const arr = locatedByPlace.get(place.id) ?? [];
      arr.push(entry);
      locatedByPlace.set(place.id, arr);
      continue;
    }

    const fallbackEvent = sameYearEvents[0] || pEvents[0] || null;
    let activityNote = `No specific town archived near ${year}.`;
    if (sameYearEvents[0]) {
      activityNote = summarizeActivity(sameYearEvents[0], person.full_name).note;
    } else if (person.birth_year && person.death_year) {
      activityNote = `Lived ${person.birth_year}–${person.death_year}; no address archived near ${year}.`;
    }

    unlocatedPeople.push({
      person,
      age,
      place: null,
      tier: 'Unlocated',
      activityTitle: sameYearEvents[0]
        ? summarizeActivity(sameYearEvents[0], person.full_name).title
        : 'Location unrecorded',
      activityNote,
      nearestEventId: fallbackEvent?.id || null,
      exactYearMatch: Boolean(sameYearEvents[0]),
    });
  }

  const localEventsAll = bundle.events.filter(
    (ev) =>
      (ev.scope === 'local' || ev.scope === 'state') &&
      ev.place_id !== null &&
      ev.year !== null &&
      Math.abs(ev.year - year) <= 1
  );

  const isCountryPlace = (placeId: string): boolean => placesById.get(placeId)?.place_type === 'country';

  const lanes: TimePlaceLane[] = [];
  for (const [placeId, people] of locatedByPlace.entries()) {
    const place = placesById.get(placeId);
    if (!place) {
      continue;
    }

    const tierOrder: Record<TimePersonEntry['tier'], number> = {
      Confirmed: 0,
      Inferred: 1,
      Possible: 2,
      Unlocated: 3,
    };
    people.sort((a, b) => {
      if (a.exactYearMatch !== b.exactYearMatch) {
        return a.exactYearMatch ? -1 : 1;
      }
      const td = tierOrder[a.tier] - tierOrder[b.tier];
      if (td !== 0) {
        return td;
      }
      return (b.age ?? -1) - (a.age ?? -1) || a.person.full_name.localeCompare(b.person.full_name);
    });

    const ancSet = new Set<string>([place.id, ...(bundle.place_ancestors[place.id] ?? [])]);
    const matchingLocal = localEventsAll
      .filter((ev) => {
        if (!ev.place_id) {
          return false;
        }
        if (ev.place_id === place.id || ancSet.has(ev.place_id)) {
          return !isCountryPlace(ev.place_id);
        }
        return (ev.place_ancestors ?? []).some((id) => ancSet.has(id) && !isCountryPlace(id));
      })
      .toSorted((a, b) => Math.abs((a.year ?? year) - year) - Math.abs((b.year ?? year) - year))
      .slice(0, 3);

    lanes.push({ place, people, localEvents: matchingLocal });
  }

  lanes.sort(compareTimeLanes);

  unlocatedPeople.sort(
    (a, b) => (b.age ?? -1) - (a.age ?? -1) || a.person.full_name.localeCompare(b.person.full_name)
  );

  const macroEvents = bundle.events
    .filter((ev) => {
      if (ev.scope !== 'national' && ev.scope !== 'global') {
        return false;
      }
      if (ev.year === null) {
        return false;
      }
      if (ev.event_kind === 'context_span' && ev.time_min !== null && ev.time_max !== null) {
        const yStart = epochDaysToDate(ev.time_min).getUTCFullYear();
        const yEnd = epochDaysToDate(ev.time_max).getUTCFullYear();
        return year >= yStart && year <= yEnd;
      }
      return Math.abs(ev.year - year) <= 1;
    })
    .toSorted((a, b) => {
      const aExact = a.year === year ? 0 : 1;
      const bExact = b.year === year ? 0 : 1;
      if (aExact !== bExact) {
        return aExact - bExact;
      }
      return (a.severity_rank ?? 5) - (b.severity_rank ?? 5);
    })
    .slice(0, 4);

  const locatedCount = lanes.reduce((sum, l) => sum + l.people.length, 0);

  return {
    year,
    totalAlive: locatedCount + unlocatedPeople.length,
    locatedCount,
    unlocatedCount: unlocatedPeople.length,
    lanes,
    unlocatedPeople,
    macroEvents,
  };
}

export function getSuggestedSnapshotYears(
  bundle: ArchiveBundle,
  placesById: ReadonlyMap<string, Place>,
  anchorYears?: readonly AnchorYearConfig[]
): SuggestedYearMarker[] {
  const anchors = anchorYears && anchorYears.length > 0 ? anchorYears : DEFAULT_ANCHOR_YEARS;
  return anchors
    .map((item) => {
      const snap = computeTimeSnapshot(bundle, item.year, placesById);
      return {
        year: item.year,
        label: item.label,
        aliveCount: snap.totalAlive,
        locatedCount: snap.locatedCount,
      };
    })
    .filter((m) => m.aliveCount > 0);
}

export function pickDefaultSnapshotYear(
  bundle: ArchiveBundle,
  placesById: ReadonlyMap<string, Place>,
  anchorYears?: readonly AnchorYearConfig[]
): number {
  const markers = getSuggestedSnapshotYears(bundle, placesById, anchorYears);
  const modern = markers.filter((m) => m.year >= 1880 && m.year <= 1945);
  const pool = modern.length > 0 ? modern : markers;
  if (pool.length === 0) {
    return 1900;
  }
  let [best] = pool;
  for (const m of pool) {
    if (m.locatedCount > best.locatedCount) {
      best = m;
    }
  }
  return best.year;
}
