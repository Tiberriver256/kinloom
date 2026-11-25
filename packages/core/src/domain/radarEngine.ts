import type {
  ArchiveBundle,
  ArchiveEvent,
  CoPresenceItem,
  ConfidenceTier,
  Person,
  Place,
  RadarSnapshot,
} from '../schemas/entities.js';
import { haversineMiles, intervalsOverlap } from '../edtf.js';

const RING_CAP = 8;

const TIER_PRIORITY: Record<ConfidenceTier, number> = {
  Confirmed: 3,
  Inferred: 2,
  Possible: 1,
};

export function getKinshipInfo(
  bundle: ArchiveBundle,
  fromPersonId: string,
  toPersonId: string
): { label: string; rank: number } {
  const direct = bundle.kinship.find((k) => k.from === fromPersonId && k.to === toPersonId);
  if (direct) {
    if (direct.relation === 'spouse') {
      return { label: 'Spouse', rank: 1 };
    }
    if (direct.relation === 'parent') {
      return { label: 'Child', rank: 1 };
    }
    if (direct.relation === 'child') {
      return { label: 'Parent', rank: 1 };
    }
  }
  const myParents = new Set(
    bundle.kinship
      .filter((k) => k.from === fromPersonId && k.relation === 'child')
      .map((k) => k.to)
  );
  if (myParents.size > 0) {
    const sharesParent = bundle.kinship.some(
      (k) => k.from === toPersonId && k.relation === 'child' && myParents.has(k.to)
    );
    if (sharesParent) {
      return { label: 'Sibling', rank: 2 };
    }
  }
  return { label: 'Relative', rank: 3 };
}

function placesMatchSpatial(
  pA: Place | undefined,
  pB: Place | undefined,
  ancA: readonly string[],
  ancB: readonly string[],
  placesById: ReadonlyMap<string, Place>
): { matched: boolean; distanceMiles: number | null } {
  if (!pA || !pB) {
    return { matched: false, distanceMiles: null };
  }
  if (pA.id === pB.id) {
    return { matched: true, distanceMiles: 0 };
  }
  const dist = haversineMiles(pA.lat, pA.lng, pB.lat, pB.lng);
  if (dist <= 15) {
    return { matched: true, distanceMiles: Math.round(dist * 10) / 10 };
  }
  const setB = new Set(ancB);
  const sharedCounty = ancA.find(
    (id) => setB.has(id) && (placesById.get(id)?.place_type === 'county' || id.includes('county'))
  );
  if (sharedCounty) {
    return { matched: true, distanceMiles: Math.round(dist * 10) / 10 };
  }
  if (
    pA.parent_id &&
    pA.parent_id === pB.parent_id &&
    pA.place_type !== 'state' &&
    pA.place_type !== 'country'
  ) {
    return { matched: true, distanceMiles: Math.round(dist * 10) / 10 };
  }
  return { matched: false, distanceMiles: null };
}

export function computeRadarForEvent(
  bundle: ArchiveBundle,
  activeEvent: ArchiveEvent | null,
  focusedPersonId: string,
  peopleById: ReadonlyMap<string, Person>,
  placesById: ReadonlyMap<string, Place>
): RadarSnapshot {
  if (!activeEvent || activeEvent.time_min === null || activeEvent.time_max === null) {
    return {
      coPresenceVisible: [],
      coPresenceOverflow: [],
      localVisible: [],
      localOverflow: [],
      macroVisible: [],
      macroOverflow: [],
    };
  }

  const activePlace = activeEvent.place_id ? placesById.get(activeEvent.place_id) : undefined;
  const activeAncestors = activeEvent.place_ancestors ?? [];
  const activeAncSet = new Set(activeAncestors);
  const bestByPerson = new Map<string, CoPresenceItem>();

  const registerCandidate = (
    personId: string,
    tier: ConfidenceTier,
    distanceMiles: number | null,
    sameHousehold: boolean,
    placeId: string | null,
    matchedEventId: string | null
  ): void => {
    if (personId === focusedPersonId) {
      return;
    }
    const person = peopleById.get(personId);
    if (!person) {
      return;
    }
    const kin = getKinshipInfo(bundle, focusedPersonId, personId);
    const cand: CoPresenceItem = {
      person,
      tier,
      distanceMiles,
      sameHousehold,
      kinshipLabel: kin.label,
      kinshipRank: kin.rank,
      placeId,
      matchedEventId,
    };
    const prev = bestByPerson.get(personId);
    if (
      !prev ||
      TIER_PRIORITY[cand.tier] > TIER_PRIORITY[prev.tier] ||
      (TIER_PRIORITY[cand.tier] === TIER_PRIORITY[prev.tier] &&
        cand.sameHousehold &&
        !prev.sameHousehold)
    ) {
      bestByPerson.set(personId, cand);
    }
  };

  for (const pt of activeEvent.participants) {
    registerCandidate(pt.person_id, 'Confirmed', 0, true, activeEvent.place_id, activeEvent.id);
  }

  for (const ev of bundle.events) {
    if (ev.id === activeEvent.id) {
      continue;
    }
    if (ev.scope !== 'personal' && ev.scope !== 'family') {
      continue;
    }
    if (
      !intervalsOverlap(activeEvent.time_min, activeEvent.time_max, ev.time_min, ev.time_max, 180)
    ) {
      continue;
    }
    const evPlace = ev.place_id ? placesById.get(ev.place_id) : undefined;
    const spatial = placesMatchSpatial(
      activePlace,
      evPlace,
      activeAncestors,
      ev.place_ancestors ?? [],
      placesById
    );
    if (!spatial.matched) {
      continue;
    }

    const exactTime = intervalsOverlap(
      activeEvent.time_min,
      activeEvent.time_max,
      ev.time_min,
      ev.time_max,
      0
    );
    const tier: ConfidenceTier = exactTime ? 'Confirmed' : 'Inferred';
    for (const pt of ev.participants) {
      const sameHouse =
        spatial.distanceMiles === 0 && (pt.role === 'household' || pt.role === 'spouse');
      registerCandidate(pt.person_id, tier, spatial.distanceMiles, sameHouse, ev.place_id, ev.id);
    }
  }

  for (const span of bundle.residence_spans) {
    if (
      !intervalsOverlap(activeEvent.time_min, activeEvent.time_max, span.time_min, span.time_max, 0)
    ) {
      continue;
    }
    const spPlace = placesById.get(span.place_id);
    const spAnc = bundle.place_ancestors?.[span.place_id] ?? [];
    const spatial = placesMatchSpatial(activePlace, spPlace, activeAncestors, spAnc, placesById);
    if (!spatial.matched) {
      continue;
    }
    registerCandidate(
      span.person_id,
      span.confidence_tier,
      spatial.distanceMiles,
      spatial.distanceMiles === 0,
      span.place_id,
      span.from_event_id
    );
  }

  const coAll = [...bestByPerson.values()].toSorted((a, b) => {
    if (a.sameHousehold !== b.sameHousehold) {
      return a.sameHousehold ? -1 : 1;
    }
    const da = a.distanceMiles ?? 9999;
    const db = b.distanceMiles ?? 9999;
    if (da !== db) {
      return da - db;
    }
    if (a.kinshipRank !== b.kinshipRank) {
      return a.kinshipRank - b.kinshipRank;
    }
    return TIER_PRIORITY[b.tier] - TIER_PRIORITY[a.tier];
  });

  const isCountryPlace = (placeId: string): boolean =>
    placesById.get(placeId)?.place_type === 'country';

  const localAll = bundle.events
    .filter((ev) => {
      if (ev.scope !== 'local' && ev.scope !== 'state') {
        return false;
      }
      if (
        !intervalsOverlap(activeEvent.time_min, activeEvent.time_max, ev.time_min, ev.time_max, 365)
      ) {
        return false;
      }
      if (!activePlace || !ev.place_id) {
        return false;
      }
      if (activeAncSet.has(ev.place_id)) {
        return !isCountryPlace(ev.place_id);
      }
      const evAnc = ev.place_ancestors ?? [];
      return evAnc.some((id) => activeAncSet.has(id) && !isCountryPlace(id));
    })
    .toSorted((a, b) => (b.severity_rank ?? 0) - (a.severity_rank ?? 0));

  const macroAll = bundle.events
    .filter((ev) => {
      if (ev.scope !== 'national' && ev.scope !== 'global') {
        return false;
      }
      return intervalsOverlap(
        activeEvent.time_min,
        activeEvent.time_max,
        ev.time_min,
        ev.time_max,
        180
      );
    })
    .toSorted((a, b) => (b.severity_rank ?? 0) - (a.severity_rank ?? 0));

  return {
    coPresenceVisible: coAll.slice(0, RING_CAP),
    coPresenceOverflow: coAll.slice(RING_CAP),
    localVisible: localAll.slice(0, RING_CAP),
    localOverflow: localAll.slice(RING_CAP),
    macroVisible: macroAll.slice(0, RING_CAP),
    macroOverflow: macroAll.slice(RING_CAP),
  };
}

export function getEventsForPerson(bundle: ArchiveBundle, personId: string): ArchiveEvent[] {
  return bundle.events
    .filter((ev) => ev.participants.some((p) => p.person_id === personId))
    .toSorted((a, b) => {
      const am = a.time_min ?? Number.MAX_SAFE_INTEGER;
      const bm = b.time_min ?? Number.MAX_SAFE_INTEGER;
      return am - bm;
    });
}

export function findNearestEventForPerson(
  bundle: ArchiveBundle,
  personId: string,
  targetTimeMin: number | null
): ArchiveEvent | null {
  const list = getEventsForPerson(bundle, personId);
  if (list.length === 0) {
    return null;
  }
  if (targetTimeMin === null) {
    return list[0];
  }
  let [best] = list;
  let bestDiff = Math.abs((best.time_min ?? targetTimeMin) - targetTimeMin);
  for (const ev of list) {
    if (ev.time_min === null) {
      continue;
    }
    const diff = Math.abs(ev.time_min - targetTimeMin);
    if (diff < bestDiff) {
      best = ev;
      bestDiff = diff;
    }
  }
  return best;
}
