import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { compileArchive } from './compileArchive.js';
import {
  PrivacyViolationError,
  applyPrivacyFilter,
  assertMediaAllowedForPrivacy,
  isPersonLivingPublic,
  redactSinglePerson,
  sanitizeEventForWrite,
  sanitizePersonForWrite,
} from './privacy.js';
import { parseKinloomConfig } from './schemas/config.js';
import type { KinshipEdge, MediaItem, Place, RawEvent, RawPerson, SourceRecord } from './schemas/entities.js';

const SYNTHETIC_CONFIG = parseKinloomConfig({
  site: {
    title: 'Alder Family Archive',
    familyName: 'Alder',
    gedcomSourceName: 'ALDER_FAMILY_ARCHIVE',
  },
  defaultBranchId: 'alder_main',
  branches: [
    { id: 'alder_main', label: 'Alder Lineage', surnames: ['Alder'], lineageGroups: ['ancestor', 'descendant'] },
    { id: 'mercer_side', label: 'Mercer Branch', surnames: ['Mercer'] },
  ],
  migrationEras: [
    { id: 'europe', label: 'Europe', minLng: -20 },
    { id: 'midwest', label: 'Midwest', maxLng: -20 },
  ],
});

const SYNTHETIC_PLACES: Place[] = [
  {
    id: 'plc_usa',
    slug: 'usa',
    name: 'USA',
    full_name: 'USA',
    place_type: 'country',
    parent_id: null,
    lat: 39.8,
    lng: -98.5,
  },
  {
    id: 'plc_ohio',
    slug: 'ohio-usa',
    name: 'Ohio',
    full_name: 'Ohio, USA',
    place_type: 'state',
    parent_id: 'plc_usa',
    lat: 40.4,
    lng: -82.9,
  },
  {
    id: 'plc_riverdale',
    slug: 'riverdale-ohio-usa',
    name: 'Riverdale',
    full_name: 'Riverdale, Ohio, USA',
    place_type: 'town',
    parent_id: 'plc_ohio',
    lat: 40.1,
    lng: -83.1,
  },
];

const SYNTHETIC_PEOPLE: RawPerson[] = [
  {
    id: 'per_arthur_alder',
    slug: 'arthur-alder',
    full_name: 'Arthur Alder',
    given_name: 'Arthur',
    surname: 'Alder',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: '1850-03-14',
    death_edtf: '1922-11-02',
    portrait_url: null,
  },
  {
    id: 'per_clara_mercer',
    slug: 'clara-mercer',
    full_name: 'Clara Mercer',
    given_name: 'Clara',
    surname: 'Mercer',
    alt_names: ['Clara Alder'],
    sex: 'F',
    is_living: false,
    lineage_group: 'descendant_spouse',
    birth_edtf: '1854-07-19',
    death_edtf: '1930-01-12',
    portrait_url: null,
  },
  {
    id: 'per_elena_alder',
    slug: 'elena-alder',
    full_name: 'Elena Alder',
    given_name: 'Elena',
    surname: 'Alder',
    alt_names: [],
    sex: 'F',
    is_living: true,
    lineage_group: 'descendant',
    birth_edtf: '1984-06-21',
    death_edtf: '',
    portrait_url: '/media/photos/elena-private.jpg',
  },
];

const SYNTHETIC_EVENTS: RawEvent[] = [
  {
    id: 'evt_1880_resi',
    title: 'Arthur Alder resided in Riverdale',
    scope: 'personal',
    event_kind: 'residence_anchor',
    category: 'homestead',
    edtf_date: '1880',
    place_id: 'plc_riverdale',
    summary: 'Arthur Alder enumerated in 1880 census (GEDCOM @I1@).',
    severity_rank: 4,
    participants: [{ person_id: 'per_arthur_alder', role: 'resident' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high', citation_detail: 'Number: 123-45-6789; Roll 42' }],
  },
  {
    id: 'evt_1890_resi',
    title: 'Arthur Alder resided in Riverdale',
    scope: 'personal',
    event_kind: 'residence_anchor',
    category: 'homestead',
    edtf_date: '1890',
    place_id: 'plc_riverdale',
    summary: 'Arthur Alder enumerated in 1890 directory.',
    severity_rank: 4,
    participants: [{ person_id: 'per_arthur_alder', role: 'resident' }],
    sources: [{ source_id: 'src_census_1880', confidence: 'high' }],
  },
  {
    id: 'evt_1984_living_birth',
    title: 'Birth of Elena Alder',
    scope: 'personal',
    event_kind: 'point_event',
    category: 'life_milestone',
    edtf_date: '1984-06-21',
    place_id: 'plc_riverdale',
    summary: 'Elena Alder was born at Riverdale Hospital.',
    severity_rank: 5,
    participants: [{ person_id: 'per_elena_alder', role: 'birth_subject' }],
    sources: [],
  },
  {
    id: 'evt_1990_shared',
    title: 'Family reunion with Elena Alder and Arthur Alder memorial',
    scope: 'family',
    event_kind: 'point_event',
    category: 'family_milestone',
    edtf_date: '1990-07-04',
    place_id: 'plc_riverdale',
    summary: 'Elena Alder attended the memorial gathering in Riverdale.',
    severity_rank: 5,
    participants: [
      { person_id: 'per_arthur_alder', role: 'memorial' },
      { person_id: 'per_elena_alder', role: 'attendee' },
    ],
    sources: [],
  },
];

const SYNTHETIC_SOURCES: SourceRecord[] = [
  {
    id: 'src_census_1880',
    citation: '1880 United States Federal Census (Ancestry GEDCOM @S1@)',
    source_type: 'census',
    repository: 'National Archives and Records Administration (NARA)',
  },
];

const SYNTHETIC_KINSHIP: KinshipEdge[] = [
  { from: 'per_arthur_alder', to: 'per_clara_mercer', relation: 'spouse', family_xref: '@F1@' },
  { from: 'per_clara_mercer', to: 'per_arthur_alder', relation: 'spouse', family_xref: '@F1@' },
];

const SYNTHETIC_MEDIA: MediaItem[] = [
  {
    id: 'med_joint_stone',
    kind: 'headstone',
    person_ids: ['per_arthur_alder', 'per_clara_mercer'],
    file: '/media/photos/alder-mercer-stone.jpg',
    caption: 'Arthur Alder and Clara Mercer joint headstone',
  },
  {
    id: 'med_living_photo',
    kind: 'family_photo',
    person_ids: ['per_arthur_alder', 'per_elena_alder'],
    file: '/media/photos/living-group.jpg',
    caption: 'Group photo containing living relative',
  },
];

describe('compileArchive and living-person privacy', () => {
  it('compiles public bundle with full living redaction, shared multi-person media, and cleaned citations', () => {
    const result = compileArchive({
      people: SYNTHETIC_PEOPLE,
      events: SYNTHETIC_EVENTS,
      places: SYNTHETIC_PLACES,
      sources: SYNTHETIC_SOURCES,
      kinship: SYNTHETIC_KINSHIP,
      media: SYNTHETIC_MEDIA,
      siteConfig: SYNTHETIC_CONFIG,
      mode: 'public',
      generatedAt: '2026-11-24T00:00:00.000Z',
    });

    const { bundle } = result;
    const expectedLivingCount = SYNTHETIC_PEOPLE.filter((p) => p.is_living).length;
    expect(bundle.meta.build_mode).toBe('public');
    expect(bundle.meta.counts.people).toBe(SYNTHETIC_PEOPLE.length);
    expect(bundle.meta.counts.living_redacted).toBe(expectedLivingCount);
    expect(bundle.residence_spans.map((span) => span.person_id)).toEqual(['per_arthur_alder']);
    expect(bundle.meta.counts.residence_spans).toBe(bundle.residence_spans.length);

    // Living person completely redacted in public mode
    const elena = bundle.people.find((p) => p.id === 'per_elena_alder');
    expect(elena?.full_name).toBe('Living');
    expect(elena?.birth_edtf).toBe('');
    expect(elena?.birth_year).toBeNull();
    expect(elena?.portrait_url).toBeNull();
    expect(elena?.media_count).toBe(0);

    // Living-only event dropped; shared event scrubbed
    expect(bundle.events.find((e) => e.id === 'evt_1984_living_birth')).toBeUndefined();
    const shared = bundle.events.find((e) => e.id === 'evt_1990_shared');
    expect(shared?.title).toBe('Family reunion with Living and Arthur Alder memorial');
    expect(shared?.place_id).toBeNull();
    expect(shared?.summary).toBe('Shared family milestone (details redacted for living participants).');

    // Citation SSN redacted and GEDCOM suffix stripped
    const resi = bundle.events.find((e) => e.id === 'evt_1880_resi');
    expect(resi?.summary).toBe('Arthur Alder enumerated in 1880 census.');
    expect(resi?.sources[0]?.citation_detail).toBe('Roll 42');
    expect(bundle.sources[0]?.citation).toBe('1880 United States Federal Census');

    // Config-driven branch assignment (no hardcoded family names)
    const arthur = bundle.people.find((p) => p.id === 'per_arthur_alder');
    const clara = bundle.people.find((p) => p.id === 'per_clara_mercer');
    expect(arthur?.branch).toBe('alder_main');
    expect(clara?.branch).toBe('mercer_side');

    // Multi-person headstone increments media_count for BOTH deceased people; photo with living person excluded
    expect(bundle.media?.map((item) => item.id)).toEqual(['med_joint_stone']);
    expect(arthur?.media_count).toBe(1);
    expect(clara?.media_count).toBe(1);
  });

  it('compiles private bundle keeping living name and birth year only, stripping exact birthdate, place, and portrait', () => {
    const result = compileArchive({
      people: SYNTHETIC_PEOPLE,
      events: SYNTHETIC_EVENTS,
      places: SYNTHETIC_PLACES,
      sources: SYNTHETIC_SOURCES,
      kinship: SYNTHETIC_KINSHIP,
      media: SYNTHETIC_MEDIA,
      siteConfig: SYNTHETIC_CONFIG,
      mode: 'private',
      generatedAt: '2026-11-24T00:00:00.000Z',
    });

    const elena = result.bundle.people.find((p) => p.id === 'per_elena_alder');
    expect(elena?.full_name).toBe('Elena Alder');
    expect(elena?.birth_edtf).toBe('1984');
    expect(elena?.birth_year).toBe(1984);
    expect(elena?.portrait_url).toBeNull();
    expect(elena?.media_count).toBe(0);

    const birthEv = result.bundle.events.find((e) => e.id === 'evt_1984_living_birth');
    expect(birthEv?.edtf_date).toBe('1984');
    expect(birthEv?.place_id).toBeNull();
    expect(birthEv?.summary).toBe('Living relative record (location and exact date omitted).');
  });

  it('enforces single-entity API boundary redaction and write sanitization', () => {
    const living = SYNTHETIC_PEOPLE[2];
    const sanitized = sanitizePersonForWrite(living);
    expect(sanitized.full_name).toBe('Elena Alder');
    expect(sanitized.birth_edtf).toBe('1984');
    expect(sanitized.portrait_url).toBeNull();

    const pub = redactSinglePerson(living, 'public');
    expect(pub.full_name).toBe('Living');
    expect(pub.birth_edtf).toBe('');
    expect(pub.portrait_url).toBeNull();

    expect(
      isPersonLivingPublic({ hasDeathOrBurial: false, birthYear: 1925, earliestEventYear: 1925, referenceYear: 2026 })
    ).toBe(false);
    expect(
      isPersonLivingPublic({ hasDeathOrBurial: false, birthYear: 1926, earliestEventYear: 1926, referenceYear: 2026 })
    ).toBe(true);

    // Single-entity event write sanitizer
    const livingIds = new Set(['per_elena_alder']);
    const sanitizedEvent = sanitizeEventForWrite(SYNTHETIC_EVENTS[2], livingIds);
    expect(sanitizedEvent.edtf_date).toBe('1984');
    expect(sanitizedEvent.place_id).toBeNull();
    expect(sanitizedEvent.summary).toBe('Living relative record (location and exact date omitted).');

    const sanitizedNoYear = sanitizeEventForWrite(SYNTHETIC_EVENTS[2], livingIds, {
      privateModeShowsBirthYear: false,
    });
    expect(sanitizedNoYear.edtf_date).toBe('');

    // Single-entity media privacy assertion (direct person_ids and via event participants)
    expect(() => assertMediaAllowedForPrivacy(SYNTHETIC_MEDIA[1], livingIds)).toThrow(
      PrivacyViolationError
    );
    const eventsById = new Map(SYNTHETIC_EVENTS.map((e) => [e.id, e]));
    expect(() =>
      assertMediaAllowedForPrivacy(
        { id: 'med_ev_living', event_id: 'evt_1990_shared' },
        livingIds,
        eventsById
      )
    ).toThrow(PrivacyViolationError);
    expect(() =>
      assertMediaAllowedForPrivacy(SYNTHETIC_MEDIA[0], livingIds, eventsById)
    ).not.toThrow();
  });

  it('wires siteConfig.privacy cutoff, referenceYear, and config schemaVersion + wiki defaults', () => {
    expect(SYNTHETIC_CONFIG.schemaVersion).toBe(1);
    expect(SYNTHETIC_CONFIG.wiki).toBeUndefined();

    const customCfg = parseKinloomConfig({
      site: {
        title: 'Custom Privacy Archive',
        familyName: 'Alder',
        gedcomSourceName: 'CUSTOM_ARCHIVE',
      },
      privacy: {
        livingCutoffYears: 80,
        referenceYear: 2020,
        privateModeShowsBirthYear: false,
        stripLivingPortraits: true,
        stripLivingResidenceSpans: true,
      },
      wiki: {
        allowTalk: true,
        allowWatchlists: true,
        maxUploadBytes: 10_000_000,
      },
    });
    expect(customCfg.schemaVersion).toBe(1);
    expect(customCfg.wiki?.allowWatchlists).toBe(true);

    // Born 1945 with no death date and is_living=false -> > (2020 - 80 = 1940), auto-protected as living
    const recentUnflagged: RawPerson = {
      id: 'per_recent',
      slug: 'recent-alder',
      full_name: 'Sam Alder',
      given_name: 'Sam',
      surname: 'Alder',
      alt_names: [],
      sex: 'U',
      is_living: false,
      lineage_group: 'descendant',
      birth_edtf: '1945-02-10',
      death_edtf: '',
      portrait_url: '/media/sam.jpg',
    };
    const { bundle } = compileArchive({
      people: [recentUnflagged],
      events: [],
      places: [],
      sources: [],
      kinship: [],
      siteConfig: customCfg,
      mode: 'private',
      generatedAt: '2026-11-24T00:00:00.000Z',
    });
    expect(bundle.people[0].is_living).toBe(true);
    expect(bundle.people[0].birth_edtf).toBe('');
    expect(bundle.people[0].birth_year).toBeNull();
    expect(bundle.people[0].portrait_url).toBeNull();
  });

  it('flags living person names mentioned in non-living public events via precompiled livingPattern', () => {
    const leakEvent: RawEvent = {
      id: 'evt_leak_check',
      title: 'Arthur Alder reunion noted by Elena Alder',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1910',
      place_id: 'plc_riverdale',
      summary: 'Later transcribed by Elena Alder in a family notebook.',
      participants: [{ person_id: 'per_arthur_alder', role: 'subject' }],
      sources: [],
    };
    const result = compileArchive({
      people: SYNTHETIC_PEOPLE,
      events: [...SYNTHETIC_EVENTS, leakEvent],
      places: SYNTHETIC_PLACES,
      sources: SYNTHETIC_SOURCES,
      kinship: SYNTHETIC_KINSHIP,
      siteConfig: SYNTHETIC_CONFIG,
      mode: 'public',
      generatedAt: '2026-11-24T00:00:00.000Z',
    });
    expect(result.reviewFlags).toEqual([
      "[evt_leak_check] 'Arthur Alder reunion noted by Elena Alder' mentions living person 'Elena Alder' in event title.",
      "[evt_leak_check] 'Arthur Alder reunion noted by Elena Alder' mentions living person 'Elena Alder' in summary prose.",
    ]);
  });

  it('property: living exact birthdates and portraits never survive private or public privacy filter', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1930, max: 2025 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.constantFrom<'public' | 'private'>('public', 'private'),
        (year, month, day, mode) => {
          const exactDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          const person: RawPerson = {
            id: 'per_test_living',
            slug: 'test-living',
            full_name: 'Morgan Mercer',
            given_name: 'Morgan',
            surname: 'Mercer',
            alt_names: [],
            sex: 'U',
            is_living: true,
            lineage_group: 'descendant',
            birth_edtf: exactDate,
            death_edtf: '',
            portrait_url: '/media/photos/secret.jpg',
          };
          const { people } = applyPrivacyFilter([person], [], [], mode);
          expect(people[0].portrait_url).toBeNull();
          expect(people[0].birth_edtf).not.toContain('-');
          if (mode === 'public') {
            expect(people[0].full_name).toBe('Living');
            expect(people[0].birth_edtf).toBe('');
          } else {
            expect(people[0].full_name).toBe('Morgan Mercer');
            expect(people[0].birth_edtf).toBe(String(year));
          }
        }
      ),
      { numRuns: 60 }
    );
  });
});
