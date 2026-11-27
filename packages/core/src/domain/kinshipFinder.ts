import { getCurrentReferenceYear } from '../clock.js';
import type { ArchiveBundle, KinshipEdge, Person, Place } from '../schemas/entities.js';

export interface KinshipStep {
  fromId: string;
  toId: string;
  relation: 'parent' | 'child' | 'spouse';
}

export interface KinshipPathResult {
  connected: boolean;
  steps: KinshipStep[];
  personIds: string[];
  relationshipLabel: string;
  overlapYears: {
    start: number;
    end: number;
    durationYears: number;
  } | null;
  sharedPlaces: {
    place: Place;
    distanceMiles: number;
  }[];
}

const peopleByIdCache = new WeakMap<readonly Person[], Map<string, Person>>();
const eventPlacesCache = new WeakMap<readonly ArchiveBundle['events'][number][], Map<string, Set<string>>>();
const kinshipAdjCache = new WeakMap<readonly KinshipEdge[], Map<string, KinshipEdge[]>>();

function getCachedPeopleById(people: readonly Person[]): Map<string, Person> {
  let cached = peopleByIdCache.get(people);
  if (!cached) {
    cached = new Map();
    for (let i = 0; i < people.length; i += 1) {
      cached.set(people[i].id, people[i]);
    }
    peopleByIdCache.set(people, cached);
  }
  return cached;
}

function getCachedEventPlacesByPerson(
  events: readonly ArchiveBundle['events'][number][]
): Map<string, Set<string>> {
  let cached = eventPlacesCache.get(events);
  if (!cached) {
    cached = new Map();
    for (let i = 0; i < events.length; i += 1) {
      const ev = events[i];
      if (!ev.place_id) {
        continue;
      }
      for (let j = 0; j < ev.participants.length; j += 1) {
        const pid = ev.participants[j].person_id;
        let set = cached.get(pid);
        if (!set) {
          set = new Set();
          cached.set(pid, set);
        }
        set.add(ev.place_id);
      }
    }
    eventPlacesCache.set(events, cached);
  }
  return cached;
}

function getCachedKinshipAdj(kinship: readonly KinshipEdge[]): Map<string, KinshipEdge[]> {
  let cached = kinshipAdjCache.get(kinship);
  if (!cached) {
    cached = new Map();
    for (let i = 0; i < kinship.length; i += 1) {
      const k = kinship[i];
      let list = cached.get(k.from);
      if (!list) {
        list = [k];
        cached.set(k.from, list);
      } else {
        list.push(k);
      }
    }
    kinshipAdjCache.set(kinship, cached);
  }
  return cached;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

export function describeBloodRelation(up: number, down: number): string {
  if (up === 0 && down === 0) {
    return 'Same person';
  }
  if (up > 0 && down === 0) {
    if (up === 1) {
      return 'Child of';
    }
    if (up === 2) {
      return 'Grandchild of';
    }
    if (up === 3) {
      return 'Great-Grandchild of';
    }
    return `${ordinal(up - 2)} Great-Grandchild of`;
  }
  if (down > 0 && up === 0) {
    if (down === 1) {
      return 'Parent of';
    }
    if (down === 2) {
      return 'Grandparent of';
    }
    if (down === 3) {
      return 'Great-Grandparent of';
    }
    return `${ordinal(down - 2)} Great-Grandparent of`;
  }
  if (up === 1 && down === 1) {
    return 'Sibling of';
  }
  if (up === 1 && down === 2) {
    return 'Aunt / Uncle of';
  }
  if (up === 2 && down === 1) {
    return 'Niece / Nephew of';
  }
  if (up === 1 && down > 2) {
    const greats = down - 2;
    return greats === 1 ? 'Great-Aunt / Great-Uncle of' : `${ordinal(greats)} Great-Aunt / Uncle of`;
  }
  if (down === 1 && up > 2) {
    const greats = up - 2;
    return greats === 1 ? 'Great-Niece / Great-Nephew of' : `${ordinal(greats)} Great-Niece / Nephew of`;
  }
  const degree = Math.min(up, down) - 1;
  const removed = Math.abs(up - down);
  if (removed === 0) {
    return `${ordinal(degree)} Cousin of`;
  }
  let removedLabel = `${removed}x`;
  if (removed === 1) {
    removedLabel = 'once';
  } else if (removed === 2) {
    removedLabel = 'twice';
  }
  return `${ordinal(degree)} Cousin ${removedLabel} removed of`;
}

export function describeKinshipSteps(steps: readonly KinshipStep[]): string {
  if (steps.length === 0) {
    return 'Same person';
  }
  if (steps.length === 1 && steps[0].relation === 'spouse') {
    return 'Spouse of';
  }

  const spouseIndices = steps.map((s, idx) => (s.relation === 'spouse' ? idx : -1)).filter((i) => i >= 0);

  if (spouseIndices.length === 0) {
    let up = 0;
    let down = 0;
    let seenDown = false;
    let monotonic = true;
    for (const s of steps) {
      if (s.relation === 'child') {
        if (seenDown) {
          monotonic = false;
        }
        up += 1;
      } else if (s.relation === 'parent') {
        seenDown = true;
        down += 1;
      }
    }
    if (monotonic) {
      return describeBloodRelation(up, down);
    }
    return `Connected by ${steps.length} genealogical steps`;
  }

  if (spouseIndices.length === 1) {
    const [spIdx] = spouseIndices;
    if (spIdx === 0) {
      const rest = describeKinshipSteps(steps.slice(1));
      if (rest === 'Child of') {
        return 'Child-in-Law of';
      }
      if (rest === 'Sibling of') {
        return 'Sibling-in-Law of';
      }
      return `Spouse of ${rest}`;
    }
    if (spIdx === steps.length - 1) {
      const prefix = describeKinshipSteps(steps.slice(0, -1));
      if (prefix === 'Parent of') {
        return 'Parent-in-Law of';
      }
      if (prefix === 'Sibling of') {
        return 'Sibling-in-Law of';
      }
      return `${prefix.replace(/ of$/, '')} of Spouse of`;
    }
  }

  return `Related by marriage (${steps.length} steps)`;
}

export function computeLifeOverlap(
  a: Person,
  b: Person,
  referenceYear = getCurrentReferenceYear()
): KinshipPathResult['overlapYears'] {
  const aStart = a.birth_year;
  const bStart = b.birth_year;
  if (aStart === null || bStart === null) {
    return null;
  }
  const aEnd = a.death_year ?? (a.is_living ? referenceYear : aStart + 72);
  const bEnd = b.death_year ?? (b.is_living ? referenceYear : bStart + 72);
  const start = Math.max(aStart, bStart);
  const end = Math.min(aEnd, bEnd);
  if (end < start) {
    return null;
  }
  return { start, end, durationYears: Math.max(1, end - start) };
}

export function findKinshipPath(params: {
  fromId: string;
  toId: string;
  bundle: ArchiveBundle;
  placesById: ReadonlyMap<string, Place>;
  referenceYear?: number;
}): KinshipPathResult {
  const { fromId, toId, bundle, placesById, referenceYear = getCurrentReferenceYear() } = params;
  const peopleById = getCachedPeopleById(bundle.people);
  const personA = peopleById.get(fromId);
  const personB = peopleById.get(toId);

  const overlapYears = personA && personB ? computeLifeOverlap(personA, personB, referenceYear) : null;

  const placesByPerson = getCachedEventPlacesByPerson(bundle.events);
  const placesA = placesByPerson.get(fromId);
  const placesB = placesByPerson.get(toId);
  const sharedPlaces: { place: Place; distanceMiles: number }[] = [];
  if (placesA && placesB) {
    for (const pid of placesA) {
      if (placesB.has(pid)) {
        const pl = placesById.get(pid);
        if (pl && pl.place_type !== 'country' && pl.place_type !== 'state') {
          sharedPlaces.push({ place: pl, distanceMiles: 0 });
        }
      }
    }
  }

  if (fromId === toId) {
    return {
      connected: true,
      steps: [],
      personIds: [fromId],
      relationshipLabel: 'Same person',
      overlapYears,
      sharedPlaces,
    };
  }

  const adj = getCachedKinshipAdj(bundle.kinship);

  const queue: string[] = [fromId];
  const visited = new Set<string>([fromId]);
  const prev = new Map<string, KinshipStep>();

  let qHead = 0;
  while (qHead < queue.length) {
    const cur = queue[qHead];
    qHead += 1;
    if (cur === toId) {
      break;
    }
    const edges = adj.get(cur);
    if (!edges) {
      continue;
    }
    for (let i = 0; i < edges.length; i += 1) {
      const edge = edges[i];
      if (visited.has(edge.to)) {
        continue;
      }
      visited.add(edge.to);
      prev.set(edge.to, { fromId: cur, toId: edge.to, relation: edge.relation });
      queue.push(edge.to);
    }
  }

  if (!visited.has(toId)) {
    return {
      connected: false,
      steps: [],
      personIds: [],
      relationshipLabel: 'No documented kinship path in this archive slice',
      overlapYears,
      sharedPlaces,
    };
  }

  const steps: KinshipStep[] = [];
  const personIds: string[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = prev.get(cursor);
    if (!step) {
      break;
    }
    steps.push(step);
    personIds.push(step.fromId);
    cursor = step.fromId;
  }
  steps.reverse();
  personIds.reverse();

  return {
    connected: true,
    steps,
    personIds,
    relationshipLabel: describeKinshipSteps(steps),
    overlapYears,
    sharedPlaces,
  };
}
