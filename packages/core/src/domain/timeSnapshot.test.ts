import { describe, expect, it } from 'vitest';
import type { ArchiveBundle, Person, Place } from '../schemas/entities.js';
import { computeTimeSnapshot } from './timeSnapshot.js';

function makePlace(id: string, name: string, fullName: string): Place {
  return {
    id,
    slug: id,
    name,
    full_name: fullName,
    place_type: 'county',
    parent_id: null,
    lat: 39.84,
    lng: -88.95,
  };
}

function makePerson(overrides: Partial<Person> & { id: string; full_name: string }): Person {
  return {
    slug: overrides.id,
    given_name: overrides.full_name.split(' ')[0] ?? overrides.full_name,
    surname: overrides.full_name.split(' ').at(-1) ?? '',
    alt_names: [],
    sex: 'M',
    birth_edtf: '1802',
    death_edtf: '1889',
    birth_year: 1802,
    death_year: 1889,
    is_living: false,
    lineage_group: 'extended',
    branch: 'synthetic',
    primary_place_id: null,
    event_count: 1,
    portrait_url: null,
    ...overrides,
  };
}

describe('computeTimeSnapshot fallback headline hygiene', () => {
  it('never renders a future death event as the current-year headline and never duplicates headline text', () => {
    const macon = makePlace('pl_macon', 'Macon County', 'Macon County, Illinois');
    const person = makePerson({
      id: 'per_john_mercer',
      full_name: 'John Mercer',
      birth_year: 1802,
      death_year: 1889,
    });
    const unlocatedPerson = makePerson({
      id: 'per_clara_mercer',
      full_name: 'Clara Mercer',
      sex: 'F',
      birth_year: 1820,
      death_year: 1891,
    });

    const bundle: ArchiveBundle = {
      meta: {
        version: '1.0',
        generated_at: '2026-01-01T00:00:00Z',
        build_mode: 'public',
        counts: { people: 2, living_redacted: 0, places: 1, events: 2, residence_spans: 0, sources: 0 },
      },
      people: [person, unlocatedPerson],
      places: [macon],
      place_ancestors: { [macon.id]: [] },
      events: [
        {
          id: 'ev_john_death',
          title: 'Death of John Mercer in Macon County, Illinois',
          summary: 'Died in 1889 in Macon County.',
          category: 'life_milestone',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1889',
          display_date: '1889',
          year: 1889,
          time_min: 0,
          time_max: 0,
          place_id: macon.id,
          participants: [{ person_id: person.id, role: 'primary' }],
          sources: [],
        },
        {
          id: 'ev_clara_death',
          title: 'Death of Clara Mercer',
          summary: 'Died in 1891.',
          category: 'life_milestone',
          scope: 'personal',
          event_kind: 'point_event',
          edtf_date: '1891',
          display_date: '1891',
          year: 1891,
          time_min: 0,
          time_max: 0,
          place_id: null,
          participants: [{ person_id: unlocatedPerson.id, role: 'primary' }],
          sources: [],
        },
      ],
      kinship: [],
      sources: [],
      residence_spans: [],
      media: [],
      narratives: [],
    };

    const placesById = new Map([[macon.id, macon]]);
    const snapshot = computeTimeSnapshot(bundle, 1880, placesById);

    expect(snapshot.lanes).toHaveLength(1);
    const johnEntry = snapshot.lanes[0]?.people.find((p) => p.person.id === person.id);
    expect(johnEntry).toBeDefined();
    expect(johnEntry?.activityTitle).toBe('Likely in Macon County');
    expect(johnEntry?.activityTitle).not.toContain('Death');
    expect(johnEntry?.activityNote).toBe('Recorded in 1889: Death of John Mercer in Macon County, Illinois.');
    expect(johnEntry?.activityNote).not.toBe(johnEntry?.activityTitle);

    const claraEntry = snapshot.unlocatedPeople.find((p) => p.person.id === unlocatedPerson.id);
    expect(claraEntry).toBeDefined();
    expect(claraEntry?.activityTitle).toBe('Location unrecorded');
    expect(claraEntry?.activityTitle).not.toContain('Death');
  });
});
