import type {
  ArchiveEvent,
  ConfidenceTier,
  Place,
  RawPerson,
  ResidenceSpan,
} from './schemas/entities.js';
import { edtfYear, haversineMiles } from './edtf.js';

export interface ResidenceAnchor {
  id: string;
  edtf_date: string;
  place_id: string;
  time_min: number;
  time_max: number;
}

export interface DeriveResidenceSpansOptions {
  includeLiving?: boolean;
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
    const seen = new Set<string>();
    let cur: string | null = pid;
    while (cur && placesById.has(cur) && !seen.has(cur)) {
      chain.push(cur);
      seen.add(cur);
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
  const p1 = placesById.get(p1Id);
  const p2 = placesById.get(p2Id);
  if (!p1 || !p2) {
    return false;
  }
  if (haversineMiles(p1.lat, p1.lng, p2.lat, p2.lng) <= 15) {
    return true;
  }
  if (p1.parent_id && p1.parent_id === p2.parent_id) {
    const parent = placesById.get(p1.parent_id);
    if (parent && parent.place_type === 'county') {
      return true;
    }
  }
  return false;
}

function spanTier(gapDays: number): ConfidenceTier | null {
  if (gapDays <= 0) {
    return 'Confirmed';
  }
  const gapYears = gapDays / 365.25;
  if (gapYears <= 11) {
    return 'Inferred';
  }
  if (gapYears <= 21) {
    return 'Possible';
  }
  return null;
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
  const sorted = anchors.toSorted(
    (a, b) => a.time_min - b.time_min || a.time_max - b.time_max || a.id.localeCompare(b.id)
  );
  const spans: ResidenceSpan[] = [];
  let spanIdx = startIndex;

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!samePlaceOrWithin15Miles(placesById, a.place_id, b.place_id)) {
      continue;
    }
    const gapDays = b.time_min - a.time_max;
    const tier = spanTier(gapDays);
    if (!tier) {
      continue;
    }
    spanIdx += 1;
    spans.push({
      id: `span_${String(spanIdx).padStart(4, '0')}`,
      person_id: personId,
      place_id: a.place_id,
      time_min: a.time_min,
      time_max: b.time_max,
      start_year: edtfYear(a.edtf_date),
      end_year: edtfYear(b.edtf_date),
      confidence_tier: tier,
      from_event_id: a.id,
      to_event_id: b.id,
    });
  }

  return spans;
}

/**
 * Derive residence spans via bounded same-place bridging (Confirmed overlap, 11-year Inferred, 21-year Possible).
 */
export function deriveResidenceSpans(
  people: readonly Pick<RawPerson, 'id' | 'is_living'>[],
  events: readonly Pick<
    ArchiveEvent,
    'id' | 'event_kind' | 'edtf_date' | 'place_id' | 'time_min' | 'time_max' | 'participants'
  >[],
  placesById: ReadonlyMap<string, Place>,
  options?: DeriveResidenceSpansOptions
): ResidenceSpan[] {
  const includeLiving = options?.includeLiving ?? false;
  const anchorsByPerson = new Map<string, ResidenceAnchor[]>();
  for (const ev of events) {
    if (
      ev.event_kind !== 'residence_anchor' ||
      ev.time_min === null ||
      ev.time_max === null ||
      !ev.place_id
    ) {
      continue;
    }
    for (const pt of ev.participants) {
      const list = anchorsByPerson.get(pt.person_id) ?? [];
      list.push({
        id: ev.id,
        edtf_date: ev.edtf_date,
        place_id: ev.place_id,
        time_min: ev.time_min,
        time_max: ev.time_max,
      });
      anchorsByPerson.set(pt.person_id, list);
    }
  }

  const spans: ResidenceSpan[] = [];
  let spanIdx = 0;

  for (const person of people) {
    if (!includeLiving && person.is_living) {
      continue;
    }
    const personAnchors = anchorsByPerson.get(person.id);
    if (!personAnchors || personAnchors.length < 2) {
      continue;
    }
    const personSpans = deriveResidenceSpansForPerson(person.id, personAnchors, placesById, spanIdx);
    for (const span of personSpans) {
      spans.push(span);
    }
    spanIdx += personSpans.length;
  }

  return spans;
}
