import { edtfYear, haversineMiles } from './edtf.js';
import { fastLocaleCompare } from './fastCompare.js';
import type { ArchiveEvent, ConfidenceTier, Place, RawPerson, ResidenceSpan } from './schemas/entities.js';

export interface ResidenceAnchor {
  id: string;
  edtf_date: string;
  place_id: string;
  time_min: number;
  time_max: number;
  year?: number | null;
}

export interface DeriveResidenceSpansOptions {
  includeLiving?: boolean;
  placesCacheKey?: object;
}

const proximityCacheByObj = new WeakMap<object, Map<string, boolean>>();

export function getProximityPairCache(
  placesById: ReadonlyMap<string, Place>,
  placesCacheKey?: object
): Map<string, boolean> {
  const keyObj: object = placesCacheKey ?? placesById;
  let pairCache = proximityCacheByObj.get(keyObj);
  if (!pairCache) {
    pairCache = new Map<string, boolean>();
    proximityCacheByObj.set(keyObj, pairCache);
  }
  return pairCache;
}

function isWithin15MilesCached(
  placesById: ReadonlyMap<string, Place>,
  pairCache: Map<string, boolean>,
  p1Id: string,
  p2Id: string
): boolean {
  if (p1Id === p2Id) {
    return true;
  }
  const pairKey = p1Id < p2Id ? `${p1Id}\0${p2Id}` : `${p2Id}\0${p1Id}`;
  const cached = pairCache.get(pairKey);
  if (cached !== undefined) {
    return cached;
  }

  const p1 = placesById.get(p1Id);
  const p2 = placesById.get(p2Id);
  let within = false;
  if (p1 && p2) {
    if (haversineMiles(p1.lat, p1.lng, p2.lat, p2.lng) <= 15) {
      within = true;
    } else if (p1.parent_id && p1.parent_id === p2.parent_id) {
      const parent = placesById.get(p1.parent_id);
      if (parent && parent.place_type === 'county') {
        within = true;
      }
    }
  }
  pairCache.set(pairKey, within);
  return within;
}

/**
 * Build the place ancestor chain map (place_id -> [place_id, parent_id, ...]) with cycle guard.
 */
export function buildPlaceAncestors(
  placesById: ReadonlyMap<string, Pick<Place, 'id' | 'parent_id'>>
): Record<string, string[]> {
  const ancestors: Record<string, string[]> = {};
  for (const pid of placesById.keys()) {
    const chain: string[] = [];
    let cur: string | null = pid;
    while (cur && placesById.has(cur) && !chain.includes(cur)) {
      chain.push(cur);
      cur = placesById.get(cur)?.parent_id ?? null;
    }
    ancestors[pid] = chain;
  }
  return ancestors;
}

export function samePlaceOrWithin15Miles(
  placesById: ReadonlyMap<string, Place>,
  p1Id: string | null | undefined,
  p2Id: string | null | undefined
): boolean {
  if (!p1Id || !p2Id) {
    return false;
  }
  if (p1Id === p2Id) {
    return true;
  }
  return isWithin15MilesCached(placesById, getProximityPairCache(placesById), p1Id, p2Id);
}

const CONFIDENCE_TIER_RANK: Readonly<Record<ConfidenceTier, number>> = {
  Confirmed: 3,
  Inferred: 2,
  Possible: 1,
};

function higherConfidenceTier(a: ConfidenceTier, b: ConfidenceTier): ConfidenceTier {
  return CONFIDENCE_TIER_RANK[a] >= CONFIDENCE_TIER_RANK[b] ? a : b;
}

function minNullableYear(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.min(a, b);
}

function maxNullableYear(a: number | null, b: number | null): number | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Math.max(a, b);
}

function spanTier(gapDays: number): ConfidenceTier | null {
  if (gapDays <= 0) {
    return 'Confirmed';
  }
  if (gapDays <= 4017.75) {
    return 'Inferred'; // 11 * 365.25
  }
  if (gapDays <= 7670.25) {
    return 'Possible'; // 21 * 365.25
  }
  return null;
}

function compareResidenceAnchors(a: ResidenceAnchor, b: ResidenceAnchor): number {
  return (
    a.time_min - b.time_min ||
    a.time_max - b.time_max ||
    fastLocaleCompare(a.place_id, b.place_id) ||
    fastLocaleCompare(a.id, b.id)
  );
}

function formatSpanId(seq: number): string {
  if (seq < 10) return `span_000${seq}`;
  if (seq < 100) return `span_00${seq}`;
  if (seq < 1000) return `span_0${seq}`;
  return `span_${seq}`;
}

export function appendResidenceSpansForPerson(
  personId: string,
  anchors: readonly ResidenceAnchor[],
  placesById: ReadonlyMap<string, Place>,
  pairCache: Map<string, boolean>,
  out: ResidenceSpan[],
  startOffset: number
): void {
  const n = anchors.length;
  if (n < 2) {
    return;
  }
  let sorted: readonly ResidenceAnchor[];
  if (n === 2) {
    sorted = compareResidenceAnchors(anchors[0], anchors[1]) <= 0 ? anchors : [anchors[1], anchors[0]];
  } else {
    let alreadySorted = true;
    for (let i = 1; i < n; i += 1) {
      if (compareResidenceAnchors(anchors[i - 1], anchors[i]) > 0) {
        alreadySorted = false;
        break;
      }
    }
    sorted = alreadySorted ? anchors : anchors.toSorted(compareResidenceAnchors);
  }

  const personStartIdx = out.length;

  for (let i = 0; i < n - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!isWithin15MilesCached(placesById, pairCache, a.place_id, b.place_id)) {
      continue;
    }
    const tier = spanTier(b.time_min - a.time_max);
    if (!tier) {
      continue;
    }

    const startYear = a.year !== undefined ? a.year : edtfYear(a.edtf_date);
    const endYear = b.year !== undefined ? b.year : edtfYear(b.edtf_date);
    const nextTimeMax = Math.max(a.time_max, b.time_max);

    if (out.length > personStartIdx) {
      const prev = out[out.length - 1];
      if (prev.place_id === a.place_id) {
        const sameYearWindow =
          prev.start_year !== null &&
          prev.end_year !== null &&
          prev.start_year === startYear &&
          prev.end_year === endYear;
        const overlappingSameTier = prev.confidence_tier === tier && a.time_min <= prev.time_max;
        if (sameYearWindow || overlappingSameTier) {
          if (a.time_min < prev.time_min) {
            prev.time_min = a.time_min;
          }
          if (nextTimeMax > prev.time_max) {
            prev.time_max = nextTimeMax;
          }
          prev.start_year = minNullableYear(prev.start_year, startYear);
          prev.end_year = maxNullableYear(prev.end_year, endYear);
          prev.confidence_tier = higherConfidenceTier(prev.confidence_tier, tier);
          prev.to_event_id = b.id;
          continue;
        }
      }
    }

    const seq = startOffset + (out.length - personStartIdx) + 1;
    out.push({
      id: formatSpanId(seq),
      person_id: personId,
      place_id: a.place_id,
      time_min: a.time_min,
      time_max: nextTimeMax,
      start_year: startYear,
      end_year: endYear,
      confidence_tier: tier,
      from_event_id: a.id,
      to_event_id: b.id,
    });
  }
}

/**
 * Derive residence spans for a single person from their residence anchor events.
 */
export function deriveResidenceSpansForPerson(
  personId: string,
  anchors: readonly ResidenceAnchor[],
  placesById: ReadonlyMap<string, Place>,
  startIndex = 0
): ResidenceSpan[] {
  if (anchors.length < 2) {
    return [];
  }
  const out: ResidenceSpan[] = [];
  appendResidenceSpansForPerson(
    personId,
    anchors,
    placesById,
    getProximityPairCache(placesById),
    out,
    startIndex
  );
  return out;
}

/**
 * Derive residence spans via bounded same-place bridging (Confirmed overlap, 11-year Inferred, 21-year Possible).
 */
export function deriveResidenceSpans(
  people: readonly Pick<RawPerson, 'id' | 'is_living'>[],
  events: readonly (Pick<
    ArchiveEvent,
    'id' | 'event_kind' | 'edtf_date' | 'place_id' | 'time_min' | 'time_max' | 'participants'
  > & { year?: number | null })[],
  placesById: ReadonlyMap<string, Place>,
  options?: DeriveResidenceSpansOptions
): ResidenceSpan[] {
  const includeLiving = options?.includeLiving ?? false;
  const pairCache = getProximityPairCache(placesById, options?.placesCacheKey);
  const personIdxById = new Map<string, number>();
  for (let i = 0; i < people.length; i += 1) {
    const p = people[i];
    if (!p.is_living || includeLiving) {
      personIdxById.set(p.id, i);
    }
  }

  const anchorsByPersonIdx = new Array<ResidenceAnchor[] | undefined>(people.length);

  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    if (
      ev.event_kind !== 'residence_anchor' ||
      ev.time_min === null ||
      ev.time_max === null ||
      !ev.place_id
    ) {
      continue;
    }
    const anchor = ev as ResidenceAnchor;
    const pts = ev.participants;
    for (let j = 0; j < pts.length; j += 1) {
      const pIdx = personIdxById.get(pts[j].person_id);
      if (pIdx === undefined) {
        continue;
      }
      const list = anchorsByPersonIdx[pIdx];
      if (!list) {
        anchorsByPersonIdx[pIdx] = [anchor];
      } else {
        list.push(anchor);
      }
    }
  }

  const spans: ResidenceSpan[] = [];
  for (let i = 0; i < people.length; i += 1) {
    const anchors = anchorsByPersonIdx[i];
    if (!anchors || anchors.length < 2) {
      continue;
    }
    appendResidenceSpansForPerson(people[i].id, anchors, placesById, pairCache, spans, spans.length);
  }

  return spans;
}
