import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseKinloomConfig } from './schemas/config.js';
import type { MediaItem, Narrative, Place, RawEvent, RawPerson, SourceRecord } from './schemas/entities.js';
import {
  parseEventsYaml,
  parseKinloomConfigYaml,
  parseMediaYaml,
  parseNarrativesYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  parseSourcesYaml,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from './yaml.js';

describe('deterministic YAML serializer and loader', () => {
  it('round-trips people, events, places, sources, media, narratives, and site config deterministically', () => {
    const people: RawPerson[] = [
      {
        id: 'per_b',
        slug: 'b-person',
        full_name: 'Beatrice Bramwell',
        given_name: 'Beatrice',
        surname: 'Bramwell',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1842',
        death_edtf: '1918-04-03',
        portrait_url: null,
      },
      {
        id: 'per_a',
        slug: 'a-person',
        full_name: 'Arthur Alder',
        given_name: 'Arthur',
        surname: 'Alder',
        alt_names: ['A. Alder'],
        sex: 'M',
        is_living: false,
        lineage_group: 'ancestor',
        birth_edtf: '1839-01-12',
        death_edtf: '1911',
        portrait_url: null,
      },
    ];

    const y1 = serializePeopleYaml(people, { sortById: true });
    const parsedPeople = parsePeopleYaml(y1);
    const y2 = serializePeopleYaml(parsedPeople, { sortById: true });
    expect(y1).toBe(y2);
    expect(parsedPeople.map((p) => p.id)).toEqual(['per_a', 'per_b']);

    const places: Place[] = [
      {
        id: 'plc_oak',
        slug: 'oak-county',
        name: 'Oak County',
        full_name: 'Oak County, Ohio, USA',
        place_type: 'county',
        parent_id: null,
        lat: 40.2,
        lng: -82.8,
      },
    ];
    expect(parsePlacesYaml(serializePlacesYaml(places))).toEqual(places);

    const sources: SourceRecord[] = [
      {
        id: 'src_1',
        citation: '1880 Federal Census',
        source_type: 'census',
        repository: 'NARA',
      },
    ];
    expect(parseSourcesYaml(serializeSourcesYaml(sources))).toEqual(sources);

    const events: RawEvent[] = [
      {
        id: 'evt_1',
        title: 'Birth of Arthur Alder',
        scope: 'personal',
        event_kind: 'point_event',
        category: 'life_milestone',
        edtf_date: '1839-01-12',
        place_id: 'plc_oak',
        summary: 'Born in Oak County.',
        participants: [{ person_id: 'per_a', role: 'birth_subject' }],
        sources: [{ source_id: 'src_1', confidence: 'high' }],
      },
    ];
    expect(parseEventsYaml(serializeEventsYaml(events))).toEqual(events);

    const media: MediaItem[] = [
      {
        id: 'med_1',
        kind: 'headstone',
        person_ids: ['per_a', 'per_b'],
        file: '/media/photos/joint.jpg',
        caption: 'Joint monument',
      },
    ];
    expect(parseMediaYaml(serializeMediaYaml(media))).toEqual(media);

    const narratives: Narrative[] = [
      {
        id: 'nar_1',
        slug: 'oak-homestead',
        title: 'Oak County Homestead',
        body_md: '# Homestead\n\nFounded in 1848.',
        person_ids: ['per_a'],
        place_ids: ['plc_oak'],
        event_ids: ['evt_1'],
        source_ids: ['src_1'],
      },
    ];
    expect(parseNarrativesYaml(serializeNarrativesYaml(narratives))).toEqual(narratives);

    const config = parseKinloomConfig({
      site: {
        title: 'Alder Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
      },
      theme: { accent: '#2F5245' },
      branches: [{ id: 'alder', label: 'Alder Line' }],
    });
    const cfgYaml = serializeKinloomConfigYaml(config);
    expect(parseKinloomConfigYaml(cfgYaml)).toEqual(config);
  });

  it('coerces bare YAML integer years to strings and rejects invalid hex accents at boundary', () => {
    const rawYaml = `
- id: per_num_year
  slug: num-year
  full_name: Samuel Darrow
  given_name: Samuel
  surname: Darrow
  birth_edtf: 1852
  death_edtf: 1920
`;
    const parsed = parsePeopleYaml(rawYaml);
    expect(parsed[0]?.birth_edtf).toBe('1852');
    expect(parsed[0]?.death_edtf).toBe('1920');

    expect(() =>
      parseKinloomConfigYaml(`
site:
  title: Bad Accent
  familyName: Test
  gedcomSourceName: TEST_ARCHIVE
theme:
  accent: not-a-hex
`)
    ).toThrow();
  });

  it('property: YAML serialization is idempotent for arbitrary valid RawPerson lists', () => {
    const personArb = fc.record({
      id: fc.stringMatching(/^per_[a-z]{3,8}$/),
      slug: fc.stringMatching(/^[a-z]{3,8}$/),
      full_name: fc.stringMatching(/^[A-Za-z0-9 .,'"-]{1,25}$/),
      given_name: fc.stringMatching(/^[A-Za-z0-9 .,'"-]{1,15}$/),
      surname: fc.stringMatching(/^[A-Za-z0-9 .,'"-]{1,15}$/),
      alt_names: fc.array(fc.stringMatching(/^[A-Za-z ]{2,15}$/), { maxLength: 3 }),
      sex: fc.constantFrom('M', 'F', 'U'),
      is_living: fc.boolean(),
      lineage_group: fc.constantFrom('ancestor', 'descendant', 'extended'),
      birth_edtf: fc.constantFrom('', '1850', '1850-04-12', '1850~'),
      death_edtf: fc.constantFrom('', '1920', '1920-11-01'),
      portrait_url: fc.constantFrom(null, '/media/photos/a.jpg'),
    });

    fc.assert(
      fc.property(fc.array(personArb, { maxLength: 5 }), (people) => {
        const y1 = serializePeopleYaml(people, { sortById: true });
        const roundTripped = parsePeopleYaml(y1);
        const y2 = serializePeopleYaml(roundTripped, { sortById: true });
        expect(y2).toBe(y1);
      }),
      { numRuns: 50 }
    );
  });
});
