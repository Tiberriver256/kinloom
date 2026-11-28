import type { ArchiveBundle, KinloomSiteConfig, Person, Place } from '@kinloom/core';
import { parseKinloomConfig } from '@kinloom/core';
import { describe, expect, it } from 'vitest';
import {
  buildArchiveSummaryLine,
  buildDirectoryJumpTargetId,
  buildDirectoryUrlParams,
  buildPeopleDirectoryModel,
  buildPersonStoryHookMap,
  compareByBirthThenName,
  compareBySurnameThenGiven,
  computeDirectoryBranchCounts,
  computeVisibleSectionPeople,
  countActiveDirectoryFilters,
  DIRECTORY_JUMP_STRIP_THRESHOLD,
  DIRECTORY_SECTION_CAP_TRIGGER,
  DIRECTORY_SECTION_INITIAL_VISIBLE,
  extractAlphabetBucket,
  extractSurnameSortKey,
  formatLivingLifespan,
  formatPersonDirectoryLifespan,
  hasPersonPhotoOrMedia,
  isPhotoFilterSaturated,
  isRedactedLivingPerson,
  LIVING_AUTO_COLLAPSE_THRESHOLD,
  PEOPLE_DIRECTORY_ERA_BANDS,
  PHOTO_FILTER_SATURATION_RATIO,
  parseDirectoryUrlParams,
  resolveArchiveFrontispiece,
  resolveEraBandId,
  resolvePersonStoryHook,
} from './peopleDirectoryModel.js';

function must<T>(val: T | undefined, label = 'value'): T {
  if (val === undefined) throw new Error(`Expected ${label}`);
  return val;
}

function makePerson(overrides: Partial<Person> & { id: string; full_name: string }): Person {
  const parts = overrides.full_name.trim().split(/\s+/);
  const given_name = overrides.given_name ?? parts[0] ?? '';
  const surname = overrides.surname ?? (parts.length > 1 ? (parts.at(-1) ?? '') : '');
  return {
    slug: overrides.slug ?? overrides.id,
    given_name,
    surname,
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'ancestor',
    birth_edtf: overrides.birth_year ? String(overrides.birth_year) : '',
    death_edtf: overrides.death_year ? String(overrides.death_year) : '',
    portrait_url: null,
    birth_year: null,
    death_year: null,
    event_count: 1,
    media_count: 0,
    primary_place_id: null,
    ...overrides,
  };
}

function makePlace(id: string, name: string, fullName: string): Place {
  return {
    id,
    slug: id,
    name,
    full_name: fullName,
    place_type: 'town',
    parent_id: null,
    lat: 42.87,
    lng: -85.86,
    historical_names: [],
    summary: '',
  };
}

function makeBundle(people: Person[], places: Place[] = []): ArchiveBundle {
  return {
    meta: {
      build_mode: 'private',
      generated_at: '2026-01-01T00:00:00Z',
      counts: {
        people: people.length,
        living_redacted: 0,
        events: 0,
        residence_spans: 0,
        places: places.length,
        sources: 0,
      },
    },
    people,
    places,
    events: [],
    residence_spans: [],
    place_ancestors: {},
    sources: [],
    kinship: [],
    narratives: [],
    media: [],
  };
}

function makeSiteConfig(input: Record<string, unknown> = {}): KinloomSiteConfig {
  return parseKinloomConfig({
    site: {
      title: 'Alder Family Archive',
      familyName: 'Alder',
      gedcomSourceName: 'ALDER',
      description: 'Documented stories across three centuries.',
    },
    branches: [
      { id: 'alder', label: 'Alder Line', description: 'Northern Michigan homesteaders.' },
      { id: 'birch', label: 'Birch Line', description: 'Coastal Maine shipwrights.' },
      { id: 'empty', label: 'Empty Line' },
    ],
    defaultBranchId: 'alder',
    ...input,
  });
}

describe('peopleDirectoryModel', () => {
  it('maps birth years to monotonic era bands and undated fallback', () => {
    expect(resolveEraBandId(null)).toBe('undated');
    expect(resolveEraBandId(1642)).toBe('before-1700');
    expect(resolveEraBandId(1699)).toBe('before-1700');
    expect(resolveEraBandId(1700)).toBe('1700s');
    expect(resolveEraBandId(1799)).toBe('1700s');
    expect(resolveEraBandId(1800)).toBe('1800-1849');
    expect(resolveEraBandId(1849)).toBe('1800-1849');
    expect(resolveEraBandId(1850)).toBe('1850-1899');
    expect(resolveEraBandId(1899)).toBe('1850-1899');
    expect(resolveEraBandId(1900)).toBe('1900-1949');
    expect(resolveEraBandId(1949)).toBe('1900-1949');
    expect(resolveEraBandId(1950)).toBe('1950-plus');
    expect(resolveEraBandId(1992)).toBe('1950-plus');

    const snapshotYears = PEOPLE_DIRECTORY_ERA_BANDS.filter((b) => b.snapshotYear !== null).map(
      (b) => b.snapshotYear as number
    );
    expect(snapshotYears).toEqual([1665, 1750, 1850, 1880, 1925, 1970]);
  });

  it('buckets By Era monotonically, separates named living relatives, and excludes redacted placeholders', () => {
    const places = [makePlace('plc_1', 'Hudsonville', 'Hudsonville, Michigan')];
    const placesById = new Map(places.map((p) => [p.id, p]));
    const people: Person[] = [
      makePerson({
        id: 'p_1640',
        full_name: 'Gideon Alder',
        birth_year: 1640,
        death_year: 1702,
        branch: 'alder',
      }),
      makePerson({
        id: 'p_1755',
        full_name: 'Martha Alder',
        birth_year: 1755,
        death_year: 1821,
        branch: 'alder',
      }),
      makePerson({
        id: 'p_1820',
        full_name: 'Clara Birch',
        birth_year: 1820,
        death_year: 1891,
        branch: 'birch',
        portrait_url: 'img/clara.jpg',
      }),
      makePerson({
        id: 'p_1858',
        full_name: 'Mabel Birch',
        birth_year: 1858,
        death_year: 1931,
        branch: 'alder',
        lineage_group: 'spouse',
      }),
      makePerson({
        id: 'p_1855',
        full_name: 'Henry Alder',
        birth_year: 1855,
        death_year: 1928,
        branch: 'alder',
        media_count: 2,
        primary_place_id: 'plc_1',
      }),
      makePerson({
        id: 'p_1912',
        full_name: 'Arthur Alder',
        birth_year: 1912,
        death_year: 1995,
        branch: 'alder',
      }),
      makePerson({
        id: 'p_1955',
        full_name: 'Ruth Cedar',
        birth_year: 1955,
        death_year: 2020,
        branch: 'birch',
      }),
      makePerson({
        id: 'p_undated',
        full_name: 'Ezra Unknown',
        birth_year: null,
        death_year: null,
        branch: 'alder',
      }),
      makePerson({
        id: 'p_living_b',
        full_name: 'Nora Birch',
        birth_year: 1988,
        is_living: true,
        branch: 'birch',
        event_count: 0,
      }),
      makePerson({
        id: 'p_living_a',
        full_name: 'Sam Alder',
        birth_year: 1991,
        is_living: true,
        branch: 'alder',
        event_count: 0,
      }),
      makePerson({
        id: 'p_redacted',
        full_name: 'Living',
        given_name: 'Living',
        surname: '',
        is_living: true,
        branch: 'alder',
      }),
    ];

    const model = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });

    expect(model.publicPeople.map((p) => p.id)).not.toContain('p_redacted');
    expect(model.populatedBranches.map((b) => b.id)).toEqual(['alder', 'birch']);
    expect(model.branchCounts).toEqual({ all: 10, alder: 7, birch: 3 });
    expect(model.withPhotosCount).toBe(2);

    expect(model.sections.map((s) => s.heading)).toEqual([
      'Before 1700',
      '1700s',
      '1800–1849',
      '1850–1899',
      '1900–1949',
      '1950 & Later',
      'Undated',
    ]);
    // Spouses born in 1855 and 1858 stay together in ascending chronological order
    const late1800s = model.sections.find((s) => s.id === '1850-1899');
    expect(late1800s?.people.map((p) => p.full_name)).toEqual(['Henry Alder', 'Mabel Birch']);

    // Living relatives separated and sorted by surname -> given name
    expect(model.livingPeople.map((p) => p.full_name)).toEqual(['Sam Alder', 'Nora Birch']);
    expect(model.autoCollapseLiving).toBe(false);
    expect(model.showJumpStrip).toBe(false);
    expect(model.jumpItems.at(-1)).toEqual({
      id: 'dir-sec-living',
      label: 'Living',
      count: 2,
      isLiving: true,
    });
  });

  it('groups A–Z by normalized surname initial, places # last, and includes named living relatives', () => {
    const people: Person[] = [
      makePerson({
        id: 'p1',
        full_name: 'Elena Álvarez',
        given_name: 'Elena',
        surname: 'Álvarez',
        birth_year: 1902,
      }),
      makePerson({
        id: 'p2',
        full_name: 'Sam Alder',
        given_name: 'Sam',
        surname: 'Alder',
        birth_year: 1990,
        is_living: true,
      }),
      makePerson({
        id: 'p3',
        full_name: 'Clara Birch',
        given_name: 'Clara',
        surname: 'Birch',
        birth_year: 1850,
      }),
      makePerson({
        id: 'p4',
        full_name: 'Unknown 1840',
        given_name: 'Unknown',
        surname: '',
        birth_year: 1840,
      }),
      makePerson({ id: 'p5', full_name: 'Ada Fallback', given_name: 'Ada', surname: '', birth_year: 1875 }),
    ];

    expect(extractSurnameSortKey(must(people[4]))).toBe('Fallback');
    expect(extractAlphabetBucket(must(people[0]))).toBe('A');
    expect(extractAlphabetBucket(must(people[3]))).toBe('#');
    expect(
      extractAlphabetBucket(makePerson({ id: 'p_empty', full_name: '   ', given_name: '', surname: '' }))
    ).toBe('#');

    const model = buildPeopleDirectoryModel({
      bundle: makeBundle(people),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'az', branch: 'all', onlyWithPhotos: false, query: '' },
    });

    expect(model.livingPeople).toEqual([]);
    expect(model.sections.map((s) => s.heading)).toEqual(['A', 'B', 'F', '#']);
    expect(model.sections[0]?.people.map((p) => p.full_name)).toEqual(['Sam Alder', 'Elena Álvarez']);
    expect(model.jumpItems.map((j) => j.id)).toEqual([
      'dir-sec-az-a',
      'dir-sec-az-b',
      'dir-sec-az-f',
      'dir-sec-az-other',
    ]);
  });

  it('filters by branch, photo availability, and search query across name, alt names, surname, and place', () => {
    const places = [makePlace('plc_hud', 'Hudsonville', 'Hudsonville, Ottawa County, Michigan')];
    const placesById = new Map(places.map((p) => [p.id, p]));
    const people: Person[] = [
      makePerson({
        id: 'p_h',
        full_name: 'Henry Alder',
        alt_names: ['Hendrik'],
        birth_year: 1855,
        branch: 'alder',
        media_count: 1,
        primary_place_id: 'plc_hud',
      }),
      makePerson({
        id: 'p_m',
        full_name: 'Mabel Birch',
        birth_year: 1858,
        branch: 'birch',
        portrait_url: 'img/mabel.jpg',
      }),
      makePerson({
        id: 'p_n',
        full_name: 'Nora Birch',
        birth_year: 1882,
        branch: 'birch',
      }),
    ];

    const birchOnly = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'birch', onlyWithPhotos: false, query: '' },
    });
    expect(birchOnly.withPhotosCount).toBe(1);
    expect(birchOnly.filteredPeople.map((p) => p.id)).toEqual(['p_m', 'p_n']);

    const birchPhotos = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'birch', onlyWithPhotos: true, query: '' },
    });
    expect(birchPhotos.filteredPeople.map((p) => p.id)).toEqual(['p_m']);

    const byAlt = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: 'hendrik' },
    });
    expect(byAlt.filteredPeople.map((p) => p.id)).toEqual(['p_h']);

    const byPlace = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: 'ottawa' },
    });
    expect(byPlace.filteredPeople.map((p) => p.id)).toEqual(['p_h']);

    const bySurname = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: 'birch' },
    });
    expect(bySurname.filteredPeople.map((p) => p.id)).toEqual(['p_m', 'p_n']);

    // Unknown branch falls back safely to 'all'
    const invalidBranch = buildPeopleDirectoryModel({
      bundle: makeBundle(people, places),
      siteConfig: makeSiteConfig(),
      placesById,
      filter: { view: 'era', branch: 'does-not-exist', onlyWithPhotos: false, query: '' },
    });
    expect(invalidBranch.filteredPeople.length).toBe(3);

    // Null bundle returns empty model safely
    const emptyModel = buildPeopleDirectoryModel({
      bundle: null,
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });
    expect(emptyModel.publicPeople).toEqual([]);
    expect(emptyModel.sections).toEqual([]);
  });

  it('enforces Jump Strip (> 25), Living auto-collapse (> 12), and 24/18 growth guard thresholds', () => {
    const people25: Person[] = Array.from({ length: DIRECTORY_JUMP_STRIP_THRESHOLD }, (_, i) =>
      makePerson({ id: `h_${i}`, full_name: `Ancestor ${i} Alder`, birth_year: 1850 + (i % 40) })
    );
    const model25 = buildPeopleDirectoryModel({
      bundle: makeBundle(people25),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });
    expect(model25.showJumpStrip).toBe(false);

    const people26 = [
      ...people25,
      makePerson({ id: 'h_26', full_name: 'Ancestor 26 Alder', birth_year: 1875 }),
    ];
    const model26 = buildPeopleDirectoryModel({
      bundle: makeBundle(people26),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });
    expect(model26.showJumpStrip).toBe(true);

    // Growth guard: <= 24 shows all; 25 caps at 18 with hiddenCount 7; expanded or active query shows all
    const cap24 = computeVisibleSectionPeople({
      people: people25.slice(0, DIRECTORY_SECTION_CAP_TRIGGER),
      isExpanded: false,
      hasActiveQuery: false,
    });
    expect(cap24.visible.length).toBe(24);
    expect(cap24.hiddenCount).toBe(0);

    const cap25 = computeVisibleSectionPeople({
      people: people25,
      isExpanded: false,
      hasActiveQuery: false,
    });
    expect(cap25.visible.length).toBe(DIRECTORY_SECTION_INITIAL_VISIBLE);
    expect(cap25.hiddenCount).toBe(7);

    const capExpanded = computeVisibleSectionPeople({
      people: people25,
      isExpanded: true,
      hasActiveQuery: false,
    });
    expect(capExpanded.visible.length).toBe(25);
    expect(capExpanded.hiddenCount).toBe(0);

    const capQuery = computeVisibleSectionPeople({
      people: people25,
      isExpanded: false,
      hasActiveQuery: true,
    });
    expect(capQuery.visible.length).toBe(25);
    expect(capQuery.hiddenCount).toBe(0);

    // Living auto-collapse: 12 stays expanded, 13 auto-collapses, active query expands
    const living13: Person[] = Array.from({ length: LIVING_AUTO_COLLAPSE_THRESHOLD + 1 }, (_, i) =>
      makePerson({
        id: `liv_${i}`,
        full_name: `Relative ${i} Rowan`,
        birth_year: 1980 + i,
        is_living: true,
        event_count: 0,
      })
    );
    const modelLiving12 = buildPeopleDirectoryModel({
      bundle: makeBundle(living13.slice(0, LIVING_AUTO_COLLAPSE_THRESHOLD)),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });
    expect(modelLiving12.autoCollapseLiving).toBe(false);

    const modelLiving13 = buildPeopleDirectoryModel({
      bundle: makeBundle(living13),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: '' },
    });
    expect(modelLiving13.autoCollapseLiving).toBe(true);

    const modelLivingQuery = buildPeopleDirectoryModel({
      bundle: makeBundle(living13),
      siteConfig: makeSiteConfig(),
      placesById: new Map(),
      filter: { view: 'era', branch: 'all', onlyWithPhotos: false, query: 'Rowan' },
    });
    expect(modelLivingQuery.autoCollapseLiving).toBe(false);
  });

  it('parses and builds directory URL parameters cleanly while preserving unrelated params', () => {
    const branches = makeSiteConfig().branches.slice(0, 2);
    expect(parseDirectoryUrlParams(new URLSearchParams(''), branches)).toEqual({
      view: 'era',
      branch: 'all',
    });
    expect(parseDirectoryUrlParams(new URLSearchParams('view=az&branch=birch'), branches)).toEqual({
      view: 'az',
      branch: 'birch',
    });
    expect(parseDirectoryUrlParams(new URLSearchParams('view=weird&branch=unknown'), branches)).toEqual({
      view: 'era',
      branch: 'all',
    });

    const switched = buildDirectoryUrlParams(new URLSearchParams('utm=test'), {
      view: 'az',
      branch: 'birch',
    });
    expect(switched.toString()).toBe('utm=test&view=az&branch=birch');

    const clearedBranch = buildDirectoryUrlParams(switched, { branch: 'all' });
    expect(clearedBranch.toString()).toBe('utm=test&view=az');
  });

  it('resolves Archive Frontispiece from extensions, brand config, and computed bundle stats safely', () => {
    const places = [makePlace('plc_1', 'Hudsonville', 'Hudsonville, Michigan')];
    const bundle = makeBundle(
      [
        makePerson({ id: 'p1', full_name: 'Henry Alder', birth_year: 1855, death_year: 1928 }),
        makePerson({ id: 'p2', full_name: 'Living', is_living: true }),
      ],
      places
    );

    expect(buildArchiveSummaryLine(null)).toBeNull();
    expect(buildArchiveSummaryLine(makeBundle([]))).toBeNull();
    expect(buildArchiveSummaryLine(bundle)).toBe('1 person · 1 place · 1855–1928');

    const singleYearBundle = makeBundle([
      makePerson({ id: 'p1', full_name: 'Henry Alder', birth_year: 1855, death_year: null }),
    ]);
    expect(buildArchiveSummaryLine(singleYearBundle)).toBe('1 person · 1855');

    // Explicit editorial frontispiece with unsafe links filtered and max 4 links enforced
    const editorialConfig = makeSiteConfig({
      extensions: {
        frontispiece: {
          kicker: 'Family Folio',
          headline: 'The Alder & Birch Papers',
          intro: 'Five generations from coastal Maine to Ottawa County orchards.',
          image: 'media/homestead.jpg',
          imageAlt: 'Alder Homestead circa 1885',
          imageCaption: 'Homestead porch, 1885',
          featuredLinks: [
            { label: 'Explore 1880', to: '/time?year=1880' },
            { label: 'Family Tree', to: '/tree' },
            { label: 'Unsafe JS', to: 'javascript:alert(1)' },
            { label: 'Protocol Relative', to: '//evil.example' },
            { label: 'Migration Map', to: '/map' },
            { label: 'Places', to: '/places' },
            { label: 'Fifth Ignored', to: '/evidence' },
          ],
        },
      },
    });
    const resolvedEditorial = resolveArchiveFrontispiece(editorialConfig, bundle);
    expect(resolvedEditorial).toEqual({
      kicker: 'Family Folio',
      headline: 'The Alder & Birch Papers',
      intro: 'Five generations from coastal Maine to Ottawa County orchards.',
      metadataLine: '1 person · 1 place · 1855–1928',
      image: 'media/homestead.jpg',
      imageAlt: 'Alder Homestead circa 1885',
      imageCaption: 'Homestead porch, 1885',
      featuredLinks: [
        { label: 'Explore 1880', to: '/time?year=1880' },
        { label: 'Family Tree', to: '/tree' },
        { label: 'Migration Map', to: '/map' },
        { label: 'Places', to: '/places' },
      ],
      isEditorialFrontispiece: true,
    });

    // Malformed frontispiece extension gracefully falls back to brand / default banner
    const malformedConfig = makeSiteConfig({
      brand: {
        subtitle: 'A curated coastal chronicle.',
        metadataLine: 'Custom archive span',
        vignetteImage: 'media/vignette.png',
      },
      extensions: {
        frontispiece: { intro: '' },
      },
    });
    const resolvedBrand = resolveArchiveFrontispiece(malformedConfig, bundle);
    expect(resolvedBrand.isEditorialFrontispiece).toBe(true);
    expect(resolvedBrand.intro).toBe('A curated coastal chronicle.');
    expect(resolvedBrand.metadataLine).toBe('Custom archive span');
    expect(resolvedBrand.image).toBe('media/vignette.png');

    // Minimal default config falls back to calm banner
    const plainConfig = parseKinloomConfig({
      site: { title: 'Rowan Archive', familyName: 'Rowan', gedcomSourceName: 'ROWAN' },
    });
    const resolvedPlain = resolveArchiveFrontispiece(plainConfig, null);
    expect(resolvedPlain.isEditorialFrontispiece).toBe(false);
    expect(resolvedPlain.headline).toBe('Rowan');
    expect(resolvedPlain.metadataLine).toBeNull();
  });

  it('formats lifespans, jump IDs, comparators, and helper predicates accurately', () => {
    const livingDated = makePerson({ id: 'l1', full_name: 'Sam Alder', birth_year: 1990, is_living: true });
    const livingUndated = makePerson({
      id: 'l2',
      full_name: 'Nora Alder',
      birth_year: null,
      is_living: true,
    });
    const historical = makePerson({ id: 'h1', full_name: 'Henry Alder', birth_year: 1855, death_year: 1928 });
    const redacted = makePerson({ id: 'r1', full_name: 'Living', is_living: true });

    expect(formatLivingLifespan(livingDated)).toBe('b. 1990 · Living');
    expect(formatLivingLifespan(livingUndated)).toBe('Living');
    expect(formatPersonDirectoryLifespan(livingDated)).toBe('b. 1990 · Living');
    expect(formatPersonDirectoryLifespan(historical)).toBe('1855 – 1928');
    expect(isRedactedLivingPerson(redacted)).toBe(true);
    expect(isRedactedLivingPerson(makePerson({ id: 'r2', full_name: '   ', is_living: true }))).toBe(true);
    expect(isRedactedLivingPerson(livingDated)).toBe(false);
    expect(hasPersonPhotoOrMedia(historical)).toBe(false);
    expect(hasPersonPhotoOrMedia({ ...historical, media_count: 1 })).toBe(true);
    expect(buildDirectoryJumpTargetId('1850-1899')).toBe('dir-sec-1850-1899');
    expect(computeDirectoryBranchCounts([historical, livingDated], 'alder')).toEqual({ all: 2, alder: 2 });

    expect(compareByBirthThenName(livingUndated, historical)).toBeGreaterThan(0);
    expect(compareByBirthThenName(historical, livingUndated)).toBeLessThan(0);
    expect(
      compareByBirthThenName(livingUndated, makePerson({ id: 'l3', full_name: 'Ada Alder' }))
    ).toBeGreaterThan(0);
    expect(compareBySurnameThenGiven(livingDated, livingUndated)).toBeGreaterThan(0);
    expect(
      compareBySurnameThenGiven(
        makePerson({
          id: 'a1',
          full_name: 'Sam Alder',
          given_name: 'Sam',
          surname: 'Alder',
          birth_year: 1985,
        }),
        livingDated
      )
    ).toBeLessThan(0);
  });

  it('omits redundant date-range era subtitles while keeping Undated explanation (#89)', () => {
    for (const band of PEOPLE_DIRECTORY_ERA_BANDS) {
      if (band.id === 'undated') {
        expect(band.subtitle).toBe('Birth year not yet documented');
      } else {
        expect(band.subtitle).toBe('');
      }
    }
  });

  it('counts active filters and detects >= 85% photo saturation (#89)', () => {
    expect(PHOTO_FILTER_SATURATION_RATIO).toBe(0.85);
    expect(countActiveDirectoryFilters({ query: '', branch: 'all', onlyWithPhotos: false })).toBe(0);
    expect(countActiveDirectoryFilters({ query: '  ', branch: 'all', onlyWithPhotos: false })).toBe(0);
    expect(countActiveDirectoryFilters({ query: 'Alder', branch: 'all', onlyWithPhotos: false })).toBe(1);
    expect(countActiveDirectoryFilters({ query: 'Alder', branch: 'birch', onlyWithPhotos: false })).toBe(2);
    expect(countActiveDirectoryFilters({ query: 'Alder', branch: 'birch', onlyWithPhotos: true })).toBe(3);

    expect(isPhotoFilterSaturated(0, 0)).toBe(false);
    expect(isPhotoFilterSaturated(8, 10)).toBe(false);
    expect(isPhotoFilterSaturated(17, 20)).toBe(true);
    expect(isPhotoFilterSaturated(10, 10)).toBe(true);
  });

  it('builds deterministic 1-line story hooks for historical ancestors while strictly blocking living details (#89)', () => {
    const places = [
      makePlace('pl_1', 'Hingham', 'Hingham, Massachusetts'),
      makePlace('pl_2', 'Monmouth County', 'Monmouth County, New Jersey'),
      makePlace('pl_3', 'Berks County', 'Berks County, Pennsylvania'),
      makePlace('pl_4', 'Rockingham County', 'Rockingham County, Virginia'),
    ];
    const placesById = new Map(places.map((p) => [p.id, p]));

    const pBio = makePerson({ id: 'p_bio', full_name: 'Abraham Alder', birth_year: 1809, death_year: 1865 });
    const pEvent = makePerson({ id: 'p_evt', full_name: 'Samuel Alder', birth_year: 1622, death_year: 1690 });
    const pJourney = makePerson({
      id: 'p_jrn',
      full_name: 'Mordecai Alder',
      birth_year: 1686,
      death_year: 1736,
    });
    const pSingleSpan = makePerson({
      id: 'p_one',
      full_name: 'Quiet Alder',
      birth_year: 1710,
      death_year: 1770,
    });
    const pLivingNamed = makePerson({
      id: 'p_liv',
      full_name: 'Sam Rowan',
      birth_year: 1991,
      is_living: true,
    });
    const pLivingRedacted = makePerson({
      id: 'p_red',
      full_name: 'Living',
      is_living: true,
    });

    const bundle: ArchiveBundle = {
      ...makeBundle([pBio, pEvent, pJourney, pSingleSpan, pLivingNamed, pLivingRedacted], places),
      narratives: [
        {
          id: 'nar_note',
          slug: 'alder-note',
          kind: 'research_note',
          subject_person_id: 'p_bio',
          title: 'Research Note',
          summary: 'Secondary note that should lose to biography.',
          body_md: 'Body',
          person_ids: ['p_bio'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
        {
          id: 'nar_bio_b',
          slug: 'alder-bio-b',
          kind: 'biography',
          subject_person_id: 'p_bio',
          title: 'Later Bio',
          summary: 'Later biography summary.',
          body_md: 'Body',
          person_ids: ['p_bio'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
        {
          id: 'nar_bio_a',
          slug: 'alder-bio-a',
          kind: 'biography',
          subject_person_id: 'p_bio',
          title: 'Primary Bio',
          summary:
            'Capt. Abraham Alder surveyed farms with Dr. Samuel Jr. in Springfield.[^src_1] Second sentence omitted here.',
          body_md: 'Body',
          person_ids: ['p_bio'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
        {
          id: 'nar_living',
          slug: 'living-bio',
          kind: 'biography',
          subject_person_id: 'p_liv',
          title: 'Living Private Bio',
          summary: 'Private living narrative detail that must never appear.',
          body_md: 'Body',
          person_ids: ['p_liv'],
          place_ids: [],
          event_ids: [],
          source_ids: [],
        },
      ],
      events: [
        {
          id: 'evt_macro',
          title: 'Regional storm',
          scope: 'local',
          event_kind: 'context_span',
          category: 'migration',
          edtf_date: '1635',
          display_date: '1635',
          year: 1635,
          time_min: 1635,
          time_max: 1635,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_witness',
          title: 'Witnessed deed',
          scope: 'personal',
          event_kind: 'point_event',
          category: 'migration',
          edtf_date: '1636',
          display_date: '1636',
          year: 1636,
          time_min: 1636,
          time_max: 1636,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'witness' }],
          sources: [],
        },
        {
          id: 'evt_blank',
          title: '   ',
          scope: 'personal',
          event_kind: 'point_event',
          category: 'migration',
          edtf_date: '1636',
          display_date: '1636',
          year: 1636,
          time_min: 1636,
          time_max: 1636,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_birth',
          title: 'Baptism of Samuel Alder in Hingham',
          scope: 'personal',
          event_kind: 'residence_anchor',
          category: 'life_milestone',
          edtf_date: '1622',
          display_date: '1622',
          year: 1622,
          time_min: 1622,
          time_max: 1622,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_custom',
          title: 'Established cooperage workshop',
          scope: 'family',
          event_kind: 'point_event',
          category: 'guild',
          edtf_date: '1645',
          display_date: '1645',
          year: 1645,
          time_min: 1645,
          time_max: 1645,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'spouse' }],
          sources: [],
        },
        {
          id: 'evt_mig_late',
          title: 'Later voyage',
          scope: 'personal',
          event_kind: 'residence_anchor',
          category: 'migration',
          edtf_date: '1640',
          display_date: '1640',
          year: 1640,
          time_min: 1640,
          time_max: 1640,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_mig_early',
          title: 'Samuel Alder sailed from Great Yarmouth to Hingham, Massachusetts',
          scope: 'personal',
          event_kind: 'residence_anchor',
          category: 'migration',
          edtf_date: '1637',
          display_date: '1637',
          year: 1637,
          time_min: 1637,
          time_max: 1637,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_evt', role: 'principal' }],
          sources: [],
        },
        {
          id: 'evt_living',
          title: 'Private living career event',
          scope: 'personal',
          event_kind: 'point_event',
          category: 'career',
          edtf_date: '2018',
          display_date: '2018',
          year: 2018,
          time_min: 2018,
          time_max: 2018,
          place_id: 'pl_1',
          summary: '',
          participants: [{ person_id: 'p_liv', role: 'principal' }],
          sources: [],
        },
      ],
      residence_spans: [
        {
          id: 'sp_3',
          person_id: 'p_jrn',
          place_id: 'pl_3',
          time_min: 1730,
          time_max: 1736,
          start_year: 1730,
          end_year: 1736,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_1',
          person_id: 'p_jrn',
          place_id: 'pl_1',
          time_min: 1686,
          time_max: 1710,
          start_year: 1686,
          end_year: 1710,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_1b',
          person_id: 'p_jrn',
          place_id: 'pl_1',
          time_min: 1710,
          time_max: 1714,
          start_year: null,
          end_year: 1714,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_2',
          person_id: 'p_jrn',
          place_id: 'pl_2',
          time_min: 1715,
          time_max: 1729,
          start_year: 1715,
          end_year: 1729,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_4',
          person_id: 'p_jrn',
          place_id: 'pl_4',
          time_min: 1736,
          time_max: 1736,
          start_year: 1736,
          end_year: 1736,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_one',
          person_id: 'p_one',
          place_id: 'pl_1',
          time_min: 1710,
          time_max: 1770,
          start_year: 1710,
          end_year: 1770,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_liv_1',
          person_id: 'p_liv',
          place_id: 'pl_1',
          time_min: 1995,
          time_max: 2010,
          start_year: 1995,
          end_year: 2010,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
        {
          id: 'sp_liv_2',
          person_id: 'p_liv',
          place_id: 'pl_2',
          time_min: 2011,
          time_max: 2025,
          start_year: 2011,
          end_year: 2025,
          confidence_tier: 'Confirmed',
          from_event_id: 'e1',
          to_event_id: 'e2',
        },
      ],
    };

    const hookMap = buildPersonStoryHookMap(bundle, placesById);
    expect(hookMap.get('p_bio')).toBe(
      'Capt. Abraham Alder surveyed farms with Dr. Samuel Jr. in Springfield.'
    );
    expect(hookMap.get('p_evt')).toBe('Sailed from Great Yarmouth to Hingham, Massachusetts');
    expect(hookMap.get('p_jrn')).toBe('Hingham → Monmouth County → Berks County');
    expect(hookMap.has('p_one')).toBe(false);
    expect(hookMap.has('p_liv')).toBe(false);
    expect(hookMap.has('p_red')).toBe(false);

    expect(resolvePersonStoryHook({ person: pBio, bundle, placesById })).toBe(
      'Capt. Abraham Alder surveyed farms with Dr. Samuel Jr. in Springfield.'
    );
    expect(resolvePersonStoryHook({ person: pEvent, bundle, placesById })).toBe(
      'Sailed from Great Yarmouth to Hingham, Massachusetts'
    );
    expect(resolvePersonStoryHook({ person: pJourney, bundle, placesById })).toBe(
      'Hingham → Monmouth County → Berks County'
    );
    expect(resolvePersonStoryHook({ person: pSingleSpan, bundle, placesById })).toBeNull();
    expect(resolvePersonStoryHook({ person: pLivingNamed, bundle, placesById })).toBeNull();
    expect(resolvePersonStoryHook({ person: pLivingRedacted, bundle, placesById })).toBeNull();
    expect(resolvePersonStoryHook({ person: pBio, bundle: null, placesById })).toBeNull();
    expect(buildPersonStoryHookMap(null, placesById).size).toBe(0);
  });
});
