import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { KinloomSiteConfigSchema } from '../schemas/config.js';
import { MediaItemSchema, PlaceSchema, RawEventSchema, RawPersonSchema } from '../schemas/entities.js';
import {
  buildPersonThumbMap,
  buildPlacesDirectory,
  computeTimeSnapshot,
  getSuggestedSnapshotYears,
  pickDefaultSnapshotYear,
  resolveCanonicalPlace,
} from './timeSnapshot.js';

const SITE_CONFIG = KinloomSiteConfigSchema.parse({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder',
    tagline: 'Synthetic Test',
    gedcomSourceName: 'ALDER_SYNTHETIC_TREE',
  },
  privacy: { livingCutoffYears: 101 },
});

function createRichSnapshotFixture() {
  const places = [
    {
      id: 'pl_us',
      name: 'United States',
      full_name: 'United States',
      place_type: 'country',
      lat: 39.8,
      lng: -98.5,
    },
    {
      id: 'pl_mi',
      name: 'Michigan',
      full_name: 'Michigan, USA',
      place_type: 'state',
      parent_id: 'pl_us',
      lat: 44.3,
      lng: -85.6,
    },
    {
      id: 'pl_ottawa',
      name: 'Ottawa County',
      full_name: 'Ottawa County, Michigan, USA',
      place_type: 'county',
      parent_id: 'pl_mi',
      lat: 42.96,
      lng: -85.99,
    },
    {
      id: 'pl_twp',
      name: 'Township 4',
      full_name: 'Township 4, Ottawa County, Michigan',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.87,
      lng: -85.86,
    },
    {
      id: 'pl_hudsonville',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.8711,
      lng: -85.8648,
    },
    {
      id: 'pl_hudsonville_short',
      name: 'Hudsonville',
      full_name: 'Hudsonville, Ottawa, Michigan',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.8711,
      lng: -85.8648,
    },
    {
      id: 'pl_holland',
      name: 'Holland',
      full_name: 'Holland, Ottawa County, Michigan, USA',
      place_type: 'town',
      parent_id: 'pl_ottawa',
      lat: 42.7875,
      lng: -86.1089,
    },
  ];

  const people = [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      sex: 'M',
      birth_edtf: '1855-04-12',
      death_edtf: '1932-11-03',
      is_living: false,
      portrait_url: '/media/henry-portrait.jpg',
    },
    {
      id: 'per_clara',
      slug: 'clara-alder',
      full_name: 'Clara Alder',
      given_name: 'Clara',
      surname: 'Alder',
      sex: 'F',
      birth_edtf: '1860-06-01',
      death_edtf: '1941-02-18',
      is_living: false,
    },
    {
      id: 'per_unknown_birth',
      slug: 'samuel-mercer',
      full_name: 'Samuel Mercer',
      given_name: 'Samuel',
      surname: 'Mercer',
      sex: 'M',
      death_edtf: '1918-08-10',
      is_living: false,
    },
    {
      id: 'per_unlocated',
      slug: 'arthur-mercer',
      full_name: 'Arthur Mercer',
      given_name: 'Arthur',
      surname: 'Mercer',
      sex: 'M',
      birth_edtf: '1875-01-01',
      death_edtf: '1950-01-01',
      is_living: false,
    },
    {
      id: 'per_living_desc',
      slug: 'maya-alder',
      full_name: 'Maya Alder',
      given_name: 'Maya',
      surname: 'Alder',
      sex: 'F',
      birth_edtf: '1992-05-05',
      is_living: true,
    },
  ];

  const events = [
    {
      id: 'evt_henry_birth',
      type: 'birth',
      scope: 'personal',
      title: 'Birth of Henry Alder',
      edtf_date: '1855-04-12',
      place_id: 'pl_holland',
      confidence: 'Confirmed',
      participants: [{ person_id: 'per_henry', role: 'subject' }],
    },
    {
      id: 'evt_census_1880',
      type: 'census',
      scope: 'family',
      title: '1880 Federal Census',
      edtf_date: '1880-06-01',
      place_id: 'pl_twp',
      confidence: 'Confirmed',
      participants: [
        { person_id: 'per_henry', role: 'head' },
        { person_id: 'per_clara', role: 'spouse' },
      ],
    },
    {
      id: 'evt_hudsonville_1900',
      type: 'residence',
      scope: 'family',
      title: 'Settled in Hudsonville',
      edtf_date: '1900-06-01',
      place_id: 'pl_hudsonville',
      confidence: 'Confirmed',
      participants: [
        { person_id: 'per_henry', role: 'subject' },
        { person_id: 'per_clara', role: 'subject' },
      ],
    },
    {
      id: 'evt_hudsonville_1910',
      type: 'census',
      scope: 'family',
      title: '1910 Federal Census',
      edtf_date: '1910-04-15',
      place_id: 'pl_hudsonville_short',
      confidence: 'Confirmed',
      participants: [
        { person_id: 'per_henry', role: 'subject' },
        { person_id: 'per_clara', role: 'subject' },
        { person_id: 'per_unknown_birth', role: 'boarder' },
      ],
    },
    {
      id: 'evt_clara_1930',
      type: 'residence',
      scope: 'personal',
      title: 'Holland retirement home',
      edtf_date: '1930-05-01',
      place_id: 'pl_holland',
      confidence: 'Inferred',
      participants: [{ person_id: 'per_clara', role: 'subject' }],
    },
    {
      id: 'evt_macro_1900',
      type: 'other',
      scope: 'national',
      title: 'Turn of the Century Railroad Expansion',
      edtf_date: '1900-01-01',
      place_id: 'pl_mi',
      confidence: 'Confirmed',
      participants: [],
    },
  ];

  const input = {
    siteConfig: SITE_CONFIG,
    people: people.map((p) => RawPersonSchema.parse(p)),
    events: events.map((e) =>
      RawEventSchema.parse({
        event_kind:
          e.scope === 'national'
            ? 'context_span'
            : e.type === 'residence' || e.type === 'census'
              ? 'residence_anchor'
              : 'point_event',
        ...e,
      })
    ),
    places: places.map((p) => PlaceSchema.parse({ slug: p.id.replaceAll('_', '-'), parent_id: null, ...p })),
    sources: [],
    kinship: [{ from: 'per_henry', to: 'per_clara', relation: 'spouse' as const }],
    narratives: [],
    media: [
      {
        id: 'med_clara_headstone',
        kind: 'headstone',
        file: '/media/clara-stone.jpg',
        person_id: 'per_clara',
        caption: 'Headstone',
      },
      {
        id: 'med_clara_family',
        kind: 'family_photo',
        file: '/media/clara-family.jpg',
        thumb: '/media/clara-family.jpg',
        person_ids: ['per_clara', 'per_henry'],
        caption: 'Family portrait',
      },
      {
        id: 'med_samuel_scan',
        kind: 'record_scan',
        file: '/media/samuel-record.jpg',
        person_id: 'per_unknown_birth',
        caption: 'Census scan',
      },
    ].map((m) => MediaItemSchema.parse(m)),
  };

  return compileArchive({ ...input, mode: 'public' }).bundle;
}

describe('timeSnapshot domain behavioral suite', () => {
  it('resolves census artifact places up to canonical county/city and prioritizes person thumbnails', () => {
    const bundle = createRichSnapshotFixture();
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));

    expect(resolveCanonicalPlace(undefined, placesById)).toBeNull();
    const resolved = resolveCanonicalPlace(placesById.get('pl_twp'), placesById);
    expect(resolved?.id).toBe('pl_ottawa');
    expect(resolveCanonicalPlace(placesById.get('pl_hudsonville'), placesById)?.id).toBe('pl_hudsonville');

    const thumbs = buildPersonThumbMap(bundle);
    expect(thumbs.get('per_henry')).toBe('/media/henry-portrait.jpg');
    expect(thumbs.get('per_clara')).toBe('/media/clara-family.jpg');
    expect(thumbs.get('per_unknown_birth')).toBe('/media/samuel-record.jpg');
  });

  it('computes multi-year snapshots with exact, inferred, possible, unlocated, and macro events', () => {
    const bundle = createRichSnapshotFixture();
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));

    const snap1880 = computeTimeSnapshot(bundle, 1880, placesById);
    expect(snap1880.totalAlive).toBeGreaterThanOrEqual(3);
    expect(snap1880.locatedCount).toBeGreaterThanOrEqual(2);
    expect(snap1880.unlocatedPeople.some((e) => e.person.id === 'per_unlocated')).toBe(true);
    const ottawaLane = snap1880.lanes.find((l) => l.place.id === 'pl_ottawa');
    expect(ottawaLane?.people.some((e) => e.person.id === 'per_henry' && e.exactYearMatch)).toBe(true);

    const snap1900 = computeTimeSnapshot(bundle, 1900, placesById);
    expect(snap1900.macroEvents.some((e) => e.id === 'evt_macro_1900')).toBe(true);
    const hudLane = snap1900.lanes.find((l) => l.place.id === 'pl_hudsonville');
    expect(hudLane?.people.length).toBeGreaterThanOrEqual(2);

    const snap1904 = computeTimeSnapshot(bundle, 1904, placesById);
    expect(snap1904.locatedCount).toBeGreaterThanOrEqual(2);

    const snap1922 = computeTimeSnapshot(bundle, 1922, placesById);
    expect(snap1922.totalAlive).toBeGreaterThanOrEqual(2);

    const snap1945 = computeTimeSnapshot(bundle, 1945, placesById);
    expect(snap1945.lanes.flatMap((l) => l.people).some((e) => e.person.id === 'per_henry')).toBe(false);
    expect(snap1945.unlocatedPeople.some((e) => e.person.id === 'per_unlocated')).toBe(true);
  });

  it('suggests anchor years, picks default snapshot year, and deduplicates places directory entries', () => {
    const bundle = createRichSnapshotFixture();
    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    const peopleById = new Map(bundle.people.map((p) => [p.id, p]));

    const suggested = getSuggestedSnapshotYears(bundle, placesById);
    expect(suggested.length).toBeGreaterThan(0);

    const customSuggested = getSuggestedSnapshotYears(bundle, placesById, [
      { year: 1880, label: '1880 Census' },
      { year: 1900, label: 'Turn of Century' },
      { year: 1700, label: 'Empty Era' },
    ]);
    expect(customSuggested.map((m) => m.year)).toEqual([1880, 1900]);

    const defaultYear = pickDefaultSnapshotYear(bundle, placesById);
    expect(defaultYear).toBeGreaterThanOrEqual(1880);
    expect(defaultYear).toBeLessThanOrEqual(1945);

    const emptyBundle = compileArchive({
      siteConfig: SITE_CONFIG,
      people: [],
      events: [],
      places: [],
      sources: [],
      kinship: [],
      narratives: [],
      media: [],
      mode: 'public',
    }).bundle;
    expect(pickDefaultSnapshotYear(emptyBundle, new Map())).toBe(1900);

    const directory = buildPlacesDirectory(bundle, placesById, peopleById);
    expect(directory.some((d) => d.place.place_type === 'country' || d.place.place_type === 'state')).toBe(
      false
    );
    const hudsonvilleEntries = directory.filter((d) => d.place.name === 'Hudsonville');
    expect(hudsonvilleEntries).toHaveLength(1);
    expect(hudsonvilleEntries[0].eventCount).toBe(2);
    expect(hudsonvilleEntries[0].minYear).toBe(1900);
    expect(hudsonvilleEntries[0].maxYear).toBeGreaterThanOrEqual(1910);
  });
});
