import { describe, expect, it } from 'vitest';
import {
  cloneEvent,
  cloneKinship,
  cloneMedia,
  cloneNarrative,
  clonePerson,
  clonePlace,
  cloneSource,
  extractCollectionsFromSnapshot,
} from './compile/snapshot.js';
import type { ArchiveRawSnapshot } from './contracts.js';
import {
  asRevisionId,
  collectLivingNameHits,
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  compileLivingNameRegex,
  computeSourceMaxYearById,
  extractEarliestEdtfYear,
  extractLatestEdtfYear,
  resolveNarrativeMaxYear,
  sliceGedcom,
} from './index.js';

describe('Snapshot extraction, entity cloning, and GEDCOM slice normalization behaviors', () => {
  it('extracts active collections from raw snapshot while skipping deleted rows and preserving primary source flags', () => {
    const rev = asRevisionId(4);
    const snapshot: ArchiveRawSnapshot = {
      head_revision_id: rev,
      entities: [
        {
          entity_type: 'person',
          entity_id: 'per_1',
          slug: 'henry-alder',
          data: {
            id: 'per_1',
            slug: 'henry-alder',
            full_name: 'Henry Alder',
            given_name: 'Henry',
            surname: 'Alder',
            alt_names: ['H. Alder'],
            sex: 'M',
            is_living: false,
            lineage_group: 'ancestor',
            birth_edtf: '1855',
            death_edtf: '1932',
            portrait_url: null,
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'person',
          entity_id: 'per_deleted',
          slug: 'deleted-alder',
          data: {
            id: 'per_deleted',
            slug: 'deleted-alder',
            full_name: 'Deleted Alder',
            given_name: 'Deleted',
            surname: 'Alder',
            alt_names: [],
            sex: 'M',
            is_living: false,
            lineage_group: 'collateral',
            birth_edtf: '1860',
            death_edtf: '1920',
            portrait_url: null,
          },
          current_revision_id: rev,
          has_primary_source: true,
          deleted_at: '2026-01-02T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
        {
          entity_type: 'place',
          entity_id: 'pl_1',
          slug: 'hudsonville',
          data: {
            id: 'pl_1',
            slug: 'hudsonville',
            name: 'Hudsonville',
            full_name: 'Hudsonville, Michigan, USA',
            place_type: 'town',
            parent_id: null,
            lat: 42.87,
            lng: -85.86,
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'source',
          entity_id: 'src_1',
          slug: null,
          data: {
            id: 'src_1',
            citation: '1880 Federal Census',
            source_type: 'census',
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'event',
          entity_id: 'evt_1',
          slug: null,
          data: {
            id: 'evt_1',
            title: '1880 Farm',
            summary: 'Farmed in Ottawa County.',
            event_kind: 'residence_anchor',
            scope: 'family',
            edtf_date: '1880',
            place_id: 'pl_1',
            participants: [{ person_id: 'per_1', role: 'head' }],
            sources: [{ source_id: 'src_1', confidence: 'high' }],
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'media',
          entity_id: 'med_1',
          slug: null,
          data: {
            id: 'med_1',
            kind: 'portrait',
            file: '/media/henry.jpg',
            caption: 'Henry Alder portrait',
            person_ids: ['per_1'],
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          entity_type: 'narrative',
          entity_id: 'nar_1',
          slug: 'henry-bio',
          data: {
            id: 'nar_1',
            slug: 'henry-bio',
            kind: 'biography',
            subject_person_id: 'per_1',
            title: 'Henry Alder Life',
            body_md: 'Settled in Ottawa County.',
            person_ids: ['per_1'],
            place_ids: ['pl_1'],
            event_ids: ['evt_1'],
            source_ids: ['src_1'],
          },
          current_revision_id: rev,
          has_primary_source: false,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
      kinship: [
        {
          edge_id: 'edge_active',
          edge: { from: 'per_1', to: 'per_1', relation: 'parent' },
          current_revision_id: rev,
          deleted_at: null,
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          edge_id: 'edge_deleted',
          edge: { from: 'per_1', to: 'per_deleted', relation: 'parent' },
          current_revision_id: rev,
          deleted_at: '2026-01-02T00:00:00Z',
          updated_at: '2026-01-02T00:00:00Z',
        },
      ],
    };

    const extracted = extractCollectionsFromSnapshot(snapshot);
    expect(extracted.people.map((p) => p.id)).toEqual(['per_1']);
    expect(extracted.people[0]?.has_primary_source).toBe(false);
    expect(extracted.places[0]?.has_primary_source).toBe(false);
    expect(extracted.sources[0]?.has_primary_source).toBe(false);
    expect(extracted.events[0]?.has_primary_source).toBe(false);
    expect(extracted.media[0]?.has_primary_source).toBe(false);
    expect(extracted.narratives[0]?.has_primary_source).toBe(false);
    expect(extracted.kinship.map((k) => k.from)).toEqual(['per_1']);

    // Deep clone isolation across all entity clone helpers
    const pClone = clonePerson({
      ...extracted.people[0]!,
      pronunciation: { phonetic: 'AHL-der', ipa: '/ˈɔːldər/' },
      extensions: { custom: { tag: 'pioneer' } },
    });
    pClone.alt_names.push('Mutated');
    expect(extracted.people[0]?.alt_names).toEqual(['H. Alder']);
    const pNullPron = clonePerson({ ...extracted.people[0]!, pronunciation: null });
    expect(pNullPron.pronunciation).toBeNull();

    const eClone = cloneEvent({
      ...extracted.events[0]!,
      alternate_dates: [{ edtf_date: '1881', source_id: 'src_1', note: 'Tax roll' }],
      alternate_places: [
        { place_name: 'Hudsonville', place_id: 'pl_1', source_id: 'src_1', note: 'Boundary shift' },
      ],
      fact_conflicts: [{ claim: 'One year variance', source_id: 'src_1', note: 'Tax roll note' }],
      weather_metrics: { temp_high_c: 22, temp_low_c: 11, precip_mm: 2 },
      extensions: { batch: 'b1' },
    });
    eClone.participants[0]!.role = 'witness';
    expect(extracted.events[0]?.participants[0]?.role).toBe('head');

    const plClone = clonePlace({
      ...extracted.places[0]!,
      ancestor_ids: ['pl_parent'],
      historical_names: [{ name: 'Georgetown', valid_from: '1855' }],
      sources: [{ source_id: 'src_1', confidence: 'high' }],
      pronunciation: null,
      extensions: { county_code: 'OT' },
    });
    expect(plClone.ancestor_ids).toEqual(['pl_parent']);
    const plWithPron = clonePlace({
      ...extracted.places[0]!,
      pronunciation: { phonetic: 'HUD-sun-vil' },
    });
    expect(plWithPron.pronunciation?.phonetic).toBe('HUD-sun-vil');

    expect(cloneSource(extracted.sources[0]!).id).toBe('src_1');
    const mClone = cloneMedia({ ...extracted.media[0]!, extensions: { scan_dpi: 600 } });
    mClone.person_ids?.push('per_other');
    expect(extracted.media[0]?.person_ids).toEqual(['per_1']);
    expect(cloneKinship(extracted.kinship[0]!).relation).toBe('parent');
    expect(cloneNarrative(extracted.narratives[0]!).slug).toBe('henry-bio');
  });

  it('normalizes maiden names, living heuristics, place precision, and duplicate slugs in sliceGedcom', () => {
    const gedcom = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 5.5.1',
      '0 @I1@ INDI',
      '1 NAME Arthur /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 10 MAY 1880',
      '2 PLAC Alder Homestead, Georgetown, Ottawa, Michigan, USA',
      '1 DEAT',
      '2 DATE 20 JAN 1955',
      '1 FAMC @F_PARENTS@',
      '1 FAMS @F_MAIN@',
      '0 @I2@ INDI',
      '1 NAME Clara (Mercer) /Alder/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1882',
      '1 DEAT',
      '2 DATE 1960',
      '1 FAMS @F_MAIN@',
      '0 @I3@ INDI',
      '1 NAME Henry /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1850',
      '1 DEAT',
      '2 DATE 1920',
      '1 FAMS @F_PARENTS@',
      '0 @I4@ INDI',
      '1 NAME Martha /Alder/',
      '1 NAME Martha /Bramwell/',
      '2 TYPE birth',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1852',
      '1 DEAT',
      '2 DATE 1925',
      '1 FAMS @F_PARENTS@',
      // Sister with married surname matching spouse while father is Alder
      '0 @I5@ INDI',
      '1 NAME Evelyn Alder /Vance/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1884',
      '1 DEAT',
      '2 DATE 1962',
      '1 FAMC @F_PARENTS@',
      '1 FAMS @F_SIS@',
      '0 @I6@ INDI',
      '1 NAME Walter /Vance/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1881',
      '1 DEAT',
      '2 DATE 1950',
      '1 FAMS @F_SIS@',
      // Sister with multiple NAME entries where one matches father surname
      '0 @I7@ INDI',
      '1 NAME Grace /Hale/',
      '1 NAME Grace /Alder/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE 1886',
      '1 DEAT',
      '2 DATE 1968',
      '1 FAMC @F_PARENTS@',
      // Duplicate Arthur Alder name for makeUniqueSlug collision branches
      '0 @I8@ INDI',
      '1 NAME Arthur /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1880',
      '1 DEAT',
      '2 DATE 1940',
      '1 FAMC @F_PARENTS@',
      '0 @I9@ INDI',
      '1 NAME Arthur /Alder/',
      '1 SEX M',
      '1 DEAT',
      '2 DATE 1941',
      '1 FAMC @F_PARENTS@',
      // Descendants exercising living fallback heuristics without BIRT
      '0 @I10@ INDI',
      '1 NAME ConfidentialChild /Alder/',
      '1 RESN confidential',
      '1 FAMC @F_MAIN@',
      '0 @I11@ INDI',
      '1 NAME ModernMarriage /Alder/',
      '1 FAMC @F_MAIN@',
      '1 FAMS @F_MOD_MARR@',
      '0 @I12@ INDI',
      '1 NAME OldSpouse /Hale/',
      '1 BIRT',
      '2 DATE 1910',
      '1 DEAT',
      '2 DATE 1995',
      '1 FAMS @F_MOD_MARR@',
      '0 @I13@ INDI',
      '1 NAME ModernSpouseLink /Alder/',
      '1 FAMC @F_MAIN@',
      '1 FAMS @F_MOD_SP@',
      '0 @I14@ INDI',
      '1 NAME YoungPartner /Hale/',
      '1 BIRT',
      '2 DATE 1975',
      '1 FAMS @F_MOD_SP@',
      '0 @I15@ INDI',
      '1 NAME ModernEventOnly /Alder/',
      '1 RESI',
      '2 DATE 1990',
      '2 PLAC Ottawa, Michigan, USA',
      '1 FAMC @F_MAIN@',
      '0 @I16@ INDI',
      '1 NAME ChildOfYoung /Alder/',
      '1 FAMC @F_MOD_SP@',
      '0 @F_PARENTS@ FAM',
      '1 HUSB @I3@',
      '1 WIFE @I4@',
      '1 CHIL @I1@',
      '1 CHIL @I5@',
      '1 CHIL @I7@',
      '1 CHIL @I8@',
      '1 CHIL @I9@',
      '0 @F_MAIN@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I10@',
      '1 CHIL @I11@',
      '1 CHIL @I13@',
      '1 CHIL @I15@',
      '0 @F_SIS@ FAM',
      '1 HUSB @I6@',
      '1 WIFE @I5@',
      '0 @F_MOD_MARR@ FAM',
      '1 HUSB @I11@',
      '1 WIFE @I12@',
      '1 MARR',
      '2 DATE 1985',
      '0 @F_MOD_SP@ FAM',
      '1 HUSB @I13@',
      '1 WIFE @I14@',
      '1 CHIL @I16@',
      '0 TRLR',
    ].join('\n');

    const sliced = sliceGedcom(gedcom, {
      rootXref: '@I1@',
      expandSpouseAncestors: true,
      includeAncestorSiblings: true,
      includeDescendantSpouses: true,
      normalizeMaidenNames: true,
      referenceYear: 2026,
      knownPlaces: {
        'ottawa, michigan, usa': { lat: 42.95, lng: -86.0 },
      },
    });

    const byFullName = new Map(sliced.people.map((p) => [p.full_name, p]));
    expect(byFullName.get('Clara Mercer')?.alt_names).toContain('Clara Alder');
    expect(byFullName.get('Martha Bramwell')?.alt_names).toContain('Martha Alder');
    expect(byFullName.get('Evelyn Alder')?.alt_names).toContain('Evelyn Alder Vance');
    expect(byFullName.get('Grace Alder')?.alt_names).toContain('Grace Hale');

    expect(byFullName.get('ConfidentialChild Alder')?.is_living).toBe(true);
    expect(byFullName.get('ModernMarriage Alder')?.is_living).toBe(true);
    expect(byFullName.get('ModernSpouseLink Alder')?.is_living).toBe(true);
    expect(byFullName.get('ModernEventOnly Alder')?.is_living).toBe(true);
    expect(byFullName.get('ChildOfYoung Alder')?.is_living).toBe(true);

    const arthurSlugs = sliced.people.filter((p) => p.full_name === 'Arthur Alder').map((p) => p.slug);
    expect(arthurSlugs).toContain('arthur-alder');
    expect(arthurSlugs).toContain('arthur-alder-1880');
    expect(arthurSlugs).toContain('arthur-alder-2');

    expect(sliced.places.some((pl) => pl.place_type === 'homestead')).toBe(true);

    // Also verify normalizeMaidenNames: false preserves married names verbatim
    const unnormalized = sliceGedcom(gedcom, {
      rootXref: '@I1@',
      normalizeMaidenNames: false,
      referenceYear: 2026,
    });
    expect(unnormalized.people.some((p) => p.full_name === 'Clara (Mercer) Alder')).toBe(true);
  });

  it('enforces living-name matcher year horizons, deceased namesake exemptions, source max-years, and narrative posthumous horizons', () => {
    expect(extractEarliestEdtfYear('1880/1885')).toBe(1880);
    expect(extractLatestEdtfYear('1880/1885')).toBe(1885);
    expect(extractEarliestEdtfYear(42)).toBeNull();
    expect(extractLatestEdtfYear(null)).toBeNull();

    const srcYears = computeSourceMaxYearById([
      { edtf_date: '1875', sources: ['src_dated', { source_id: 'src_mixed' }, ''] },
      { edtf_date: '1892', sources: [{ source_id: 'src_dated' }] },
      { edtf_date: null, sources: ['src_mixed'] },
    ]);
    expect(srcYears.get('src_dated')).toBe(1892);
    expect(srcYears.get('src_mixed')).toBeNull();

    expect(
      resolveNarrativeMaxYear({
        subjectPersonId: null,
        personIds: [],
        eventIds: [],
        livingIds: new Set(),
        deathYearByPersonId: new Map(),
        eventMaxYearById: new Map(),
      })
    ).toBeNull();
    expect(
      resolveNarrativeMaxYear({
        subjectPersonId: 'p_liv',
        personIds: [],
        eventIds: [],
        livingIds: new Set(['p_liv']),
        deathYearByPersonId: new Map([['p_liv', 1920]]),
        eventMaxYearById: new Map(),
      })
    ).toBeNull();
    expect(
      resolveNarrativeMaxYear({
        subjectPersonId: 'p_unk',
        personIds: [],
        eventIds: [],
        livingIds: new Set(),
        deathYearByPersonId: new Map([['p_unk', null]]),
        eventMaxYearById: new Map(),
      })
    ).toBeNull();
    expect(
      resolveNarrativeMaxYear({
        subjectPersonId: 'p_dec',
        personIds: ['p_dec2'],
        eventIds: ['evt_late'],
        livingIds: new Set(),
        deathYearByPersonId: new Map([
          ['p_dec', 1900],
          ['p_dec2', 1910],
        ]),
        eventMaxYearById: new Map([['evt_late', 2025]]),
      })
    ).toBe(2025);

    const living = [
      {
        full_name: 'Clara Elizabeth Alder',
        given_name: 'Clara Elizabeth',
        surname: 'Alder',
        alt_names: ['Beth Alder', 'Clara E. Alder', { name: 'ignored' }],
        birth_edtf: '1995-04-12',
      },
      {
        full_name: 'Clara Rose Alder',
        given_name: 'Clara Rose',
        surname: 'Alder',
        birth_edtf: '2050',
      },
      {
        full_name: 'Henry Thomas Mercer',
        given_name: 'Henry Thomas',
        surname: 'Mercer',
        birth_edtf: '1990',
      },
    ];
    const deceased = [{ full_name: 'Henry Mercer', given_name: 'Henry', surname: 'Mercer' }];

    const regex = compileLivingNameRegex(living, deceased);
    expect(collectLivingNameHits(null, [{ location: 'a', text: 'Clara Alder' }])).toEqual([]);
    const regexHits = collectLivingNameHits(regex, [
      { location: 'empty', text: '' },
      { location: 'bio', text: 'Clara Alder and Beth Alder and Henry Mercer visited.' },
    ]);
    expect(regexHits.map((h) => h.match)).toEqual(['Clara Alder', 'Beth Alder']);

    const emptyMatcher = compileLivingNameMatcher([]);
    expect(collectLivingNameHitsWithMatcher(emptyMatcher, [{ location: 'x', text: 'anything' }])).toEqual([]);

    const matcher = compileLivingNameMatcher(living, deceased, { referenceYear: 2026 });
    const hits = collectLivingNameHitsWithMatcher(matcher, [
      { location: '1880_census', text: 'Clara Alder lived here in 1880.', maxYear: 1880 },
      { location: '2010_note', text: 'Clara Alder and Clara E. Alder attended.', maxYear: 2010 },
    ]);
    expect(hits.some((h) => h.location === '1880_census')).toBe(false);
    expect(hits.some((h) => h.location === '2010_note' && h.match === 'Clara Alder')).toBe(true);
    expect(hits.some((h) => h.location === '2010_note' && h.match === 'Clara E. Alder')).toBe(true);
  });
});
