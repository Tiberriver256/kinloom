import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { edtfToBounds } from './edtf.js';
import { buildPlaceAncestors, deriveResidenceSpans, samePlaceOrWithin15Miles } from './residenceSpans.js';
import type { ArchiveEvent, Place, RawPerson } from './schemas/entities.js';

function makePlace(overrides: Partial<Place> & { id: string }): Place {
  return {
    slug: overrides.id,
    name: overrides.id,
    full_name: overrides.id,
    place_type: 'town',
    parent_id: null,
    lat: 40.0,
    lng: -83.0,
    ...overrides,
  };
}

function makeAnchor(id: string, personId: string, placeId: string, edtf: string): ArchiveEvent {
  const bounds = edtfToBounds(edtf);
  return {
    id,
    title: `Residence ${id}`,
    scope: 'personal',
    event_kind: 'residence_anchor',
    edtf_date: edtf,
    display_date: edtf,
    year: Number(edtf.slice(0, 4)),
    time_min: bounds ? bounds[0] : null,
    time_max: bounds ? bounds[1] : null,
    place_id: placeId,
    summary: '',
    participants: [{ person_id: personId, role: 'resident' }],
    sources: [],
  };
}

describe('residenceSpans and place ancestors', () => {
  it('builds ancestor chains and guards against cyclic parent links', () => {
    const places = new Map<string, Place>([
      ['plc_usa', makePlace({ id: 'plc_usa', place_type: 'country', parent_id: null })],
      ['plc_ohio', makePlace({ id: 'plc_ohio', place_type: 'state', parent_id: 'plc_usa' })],
      ['plc_cedar', makePlace({ id: 'plc_cedar', place_type: 'county', parent_id: 'plc_ohio' })],
      ['plc_oak', makePlace({ id: 'plc_oak', place_type: 'town', parent_id: 'plc_cedar' })],
      ['plc_cycle_a', makePlace({ id: 'plc_cycle_a', parent_id: 'plc_cycle_b' })],
      ['plc_cycle_b', makePlace({ id: 'plc_cycle_b', parent_id: 'plc_cycle_a' })],
    ]);

    const anc = buildPlaceAncestors(places);
    expect(anc['plc_oak']).toEqual(['plc_oak', 'plc_cedar', 'plc_ohio', 'plc_usa']);
    expect(anc['plc_cycle_a']).toEqual(['plc_cycle_a', 'plc_cycle_b']);
  });

  it('bridges anchors with Confirmed, Inferred (<=11y), and Possible (<=21y) tiers and drops living people', () => {
    const places = new Map<string, Place>([
      ['plc_county', makePlace({ id: 'plc_county', place_type: 'county', lat: 40.0, lng: -83.0 })],
      ['plc_town_a', makePlace({ id: 'plc_town_a', parent_id: 'plc_county', lat: 40.0, lng: -83.0 })],
      ['plc_town_b', makePlace({ id: 'plc_town_b', parent_id: 'plc_county', lat: 40.1, lng: -83.0 })],
      ['plc_far', makePlace({ id: 'plc_far', lat: 34.0, lng: -118.0 })],
    ]);

    const people: Pick<RawPerson, 'id' | 'is_living'>[] = [
      { id: 'per_deceased', is_living: false },
      { id: 'per_living', is_living: true },
    ];

    const events: ArchiveEvent[] = [
      makeAnchor('ev1', 'per_deceased', 'plc_town_a', '1850'),
      makeAnchor('ev2', 'per_deceased', 'plc_town_b', '1850'), // overlap -> Confirmed
      makeAnchor('ev3', 'per_deceased', 'plc_town_a', '1860'), // ~9y gap -> Inferred
      makeAnchor('ev4', 'per_deceased', 'plc_town_a', '1878'), // ~17y gap -> Possible
      makeAnchor('ev5', 'per_deceased', 'plc_town_a', '1910'), // >21y gap -> no bridge
      makeAnchor('ev6', 'per_deceased', 'plc_far', '1912'), // different place -> no bridge
      makeAnchor('ev7', 'per_living', 'plc_town_a', '1980'),
      makeAnchor('ev8', 'per_living', 'plc_town_a', '1985'),
    ];

    expect(samePlaceOrWithin15Miles(places, 'plc_town_a', 'plc_town_b')).toBe(true);
    expect(samePlaceOrWithin15Miles(places, 'plc_town_a', 'plc_far')).toBe(false);

    const spans = deriveResidenceSpans(people, events, places);
    expect(spans).toHaveLength(3);
    expect(spans.map((s) => s.confidence_tier)).toEqual(['Confirmed', 'Inferred', 'Possible']);
    expect(spans.map((s) => s.id)).toEqual(['span_0001', 'span_0002', 'span_0003']);
    expect(spans.every((s) => s.person_id === 'per_deceased')).toBe(true);
  });

  it('coalesces co-resident household duplicate anchors at the same place into one Confirmed span', () => {
    const places = new Map<string, Place>([
      ['plc_precinct_1', makePlace({ id: 'plc_precinct_1', lat: 30.0, lng: -98.7 })],
      ['plc_valley_town', makePlace({ id: 'plc_valley_town', lat: 37.6, lng: -120.95 })],
    ]);

    const people: Pick<RawPerson, 'id' | 'is_living'>[] = [{ id: 'per_alder', is_living: false }];

    const household1900 = Array.from({ length: 9 }, (_, idx) =>
      makeAnchor(`ev_1900_${String(idx + 1).padStart(2, '0')}`, 'per_alder', 'plc_precinct_1', '1900')
    );
    const household1920 = Array.from({ length: 5 }, (_, idx) =>
      makeAnchor(`ev_1920_${String(idx + 1).padStart(2, '0')}`, 'per_alder', 'plc_valley_town', '1920')
    );

    const spans1900Only = deriveResidenceSpans(people, household1900, places);
    expect(spans1900Only).toHaveLength(1);
    expect(spans1900Only[0]).toMatchObject({
      id: 'span_0001',
      person_id: 'per_alder',
      place_id: 'plc_precinct_1',
      start_year: 1900,
      end_year: 1900,
      confidence_tier: 'Confirmed',
      from_event_id: 'ev_1900_01',
      to_event_id: 'ev_1900_09',
    });

    const combinedSpans = deriveResidenceSpans(people, [...household1900, ...household1920], places);
    expect(combinedSpans).toHaveLength(2);
    expect(combinedSpans).toMatchObject([
      {
        id: 'span_0001',
        place_id: 'plc_precinct_1',
        start_year: 1900,
        end_year: 1900,
        confidence_tier: 'Confirmed',
        from_event_id: 'ev_1900_01',
        to_event_id: 'ev_1900_09',
      },
      {
        id: 'span_0002',
        place_id: 'plc_valley_town',
        start_year: 1920,
        end_year: 1920,
        confidence_tier: 'Confirmed',
        from_event_id: 'ev_1920_01',
        to_event_id: 'ev_1920_05',
      },
    ]);
  });

  it('coalesces consecutive same-place same-tier spans and keeps higher confidence on same-year merges', () => {
    const places = new Map<string, Place>([
      ['plc_milltown', makePlace({ id: 'plc_milltown', lat: 40.0, lng: -83.0 })],
    ]);
    const people: Pick<RawPerson, 'id' | 'is_living'>[] = [{ id: 'per_mercer', is_living: false }];
    const events: ArchiveEvent[] = [
      makeAnchor('ev_1', 'per_mercer', 'plc_milltown', '1880-01-10'),
      makeAnchor('ev_2', 'per_mercer', 'plc_milltown', '1880-06-01'),
      makeAnchor('ev_3', 'per_mercer', 'plc_milltown', '1880-06-01'),
      makeAnchor('ev_4', 'per_mercer', 'plc_milltown', '1890'),
      makeAnchor('ev_5', 'per_mercer', 'plc_milltown', '1900'),
    ];

    const spans = deriveResidenceSpans(people, events, places);
    expect(spans).toHaveLength(2);
    expect(spans).toMatchObject([
      {
        id: 'span_0001',
        place_id: 'plc_milltown',
        start_year: 1880,
        end_year: 1880,
        confidence_tier: 'Confirmed',
        from_event_id: 'ev_1',
        to_event_id: 'ev_3',
      },
      {
        id: 'span_0002',
        place_id: 'plc_milltown',
        start_year: 1880,
        end_year: 1900,
        confidence_tier: 'Inferred',
        from_event_id: 'ev_3',
        to_event_id: 'ev_5',
      },
    ]);
  });

  it('property: living people never receive residence spans and every span has time_min <= time_max', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.array(fc.integer({ min: 1750, max: 1960 }), { minLength: 2, maxLength: 6 }),
        (isLiving, years) => {
          const places = new Map<string, Place>([
            ['plc_a', makePlace({ id: 'plc_a', lat: 40.0, lng: -83.0 })],
          ]);
          const people = [{ id: 'per_x', is_living: isLiving }];
          const events = years.map((yr, idx) => makeAnchor(`ev_${idx}`, 'per_x', 'plc_a', String(yr)));
          const spans = deriveResidenceSpans(people, events, places);
          if (isLiving) {
            expect(spans).toHaveLength(0);
          }
          for (const span of spans) {
            expect(span.time_min).toBeLessThanOrEqual(span.time_max);
            expect(span.person_id).toBe('per_x');
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});
