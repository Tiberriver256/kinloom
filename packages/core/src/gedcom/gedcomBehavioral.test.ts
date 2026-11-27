import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { parseKinloomConfig } from '../schemas/config.js';
import { exportGedcom7 } from './export.js';
import { parseGedcomText } from './parse.js';
import { sliceGedcom } from './slice.js';

const RICH_SYNTHETIC_GEDCOM = [
  '0 HEAD',
  '1 GEDC',
  '2 VERS 7.0',
  '0 @R1@ REPO',
  '1 NAME National Archives and Records Administration',
  '0 @S1@ SOUR',
  '1 TITL 1880 United States Federal Census',
  '1 AUTH Bureau of the Census',
  '1 PUBL Government Printing Office',
  '1 REPO @R1@',
  '0 @S2@ SOUR',
  '1 TITL Ottawa County Marriage Register',
  '0 @O1@ OBJE',
  '1 TITL Henry Alder Portrait',
  '1 FORM jpg',
  '1 _MTYPE portrait',
  '1 _WDTH 800',
  '1 _HGHT 1000',
  '1 DATE 1885',
  '0 @I1@ INDI',
  '1 NAME Thomas /Alder/',
  '2 TYPE birth',
  '1 NAME Tom /Alder/',
  '2 TYPE aka',
  '1 SEX M',
  '1 BIRT',
  '2 DATE ABT 1830',
  '2 PLAC Holland, Ottawa County, Michigan, USA',
  '2 SOUR @S1@',
  '3 PAGE Roll 599, Page 14A',
  '2 NOTE Born near the river',
  '3 CONT Second line of birth note',
  '1 OCCU Carpenter',
  '2 DATE 1860',
  '2 PLAC Holland, Ottawa County, Michigan, USA',
  '1 IMMI',
  '2 DATE 1848',
  '2 PLAC New York, New York, USA',
  '1 DEAT',
  '2 DATE 12 MAR 1902',
  '2 PLAC Hudsonville, Ottawa County, Michigan, USA',
  '1 BURI',
  '2 DATE 15 MAR 1902',
  '2 PLAC Georgetown Cemetery, Hudsonville, Michigan, USA',
  '1 OBJE @O1@',
  '1 FAMS @F1@',
  '0 @I2@ INDI',
  '1 NAME Martha /Alder/',
  '2 TYPE married',
  '1 NAME Martha /Mercer/',
  '2 TYPE birth',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1834',
  '2 PLAC Grand Rapids, Kent County, Michigan, USA',
  '1 DEAT',
  '2 DATE 1908',
  '1 FAMS @F1@',
  '0 @I3@ INDI',
  '1 NAME Henry /Alder/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 14 APR 1858',
  '2 PLAC Holland, Ottawa County, Michigan, USA',
  '1 CENS',
  '2 DATE 1880',
  '2 PLAC Hudsonville, Ottawa County, Michigan, USA',
  '2 SOUR @S1@',
  '3 PAGE ED 236, Sheet 4B',
  '1 EVEN Homestead purchase',
  '2 TYPE Land Patent',
  '2 DATE 1882',
  '2 PLAC Hudsonville, Ottawa County, Michigan, USA',
  '1 DEAT',
  '2 DATE 1930',
  '1 FAMC @F1@',
  '1 FAMS @F2@',
  '0 @I4@ INDI',
  '1 NAME Samuel /Alder/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1861',
  '1 DEAT',
  '2 DATE 1925',
  '1 FAMC @F1@',
  '0 @I5@ INDI',
  '1 NAME Clara /Bramwell/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1862',
  '1 DEAT',
  '2 DATE 1938',
  '1 FAMS @F2@',
  '1 FAMC @F_SPOUSE_PARENTS@',
  '0 @I5P@ INDI',
  '1 NAME George /Bramwell/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1832',
  '1 DEAT',
  '2 DATE 1901',
  '1 FAMS @F_SPOUSE_PARENTS@',
  '0 @I6@ INDI',
  '1 NAME Eleanor /Alder/',
  '1 SEX F',
  '1 BIRT',
  '2 DATE 1886',
  '1 DEAT',
  '2 DATE 1965',
  '1 FAMC @F2@',
  '1 FAMS @F3@',
  '0 @I7@ INDI',
  '1 NAME Arthur /Vance/',
  '1 SEX M',
  '1 BIRT',
  '2 DATE 1884',
  '1 DEAT',
  '2 DATE 1960',
  '1 FAMS @F3@',
  '0 @I8@ INDI',
  '1 NAME Living /Alder/',
  '1 SEX F',
  '1 RESN CONFIDENTIAL',
  '1 BIRT',
  '2 DATE 1995',
  '1 FAMC @F3@',
  '0 @F1@ FAM',
  '1 HUSB @I1@',
  '1 WIFE @I2@',
  '1 CHIL @I3@',
  '1 CHIL @I4@',
  '1 MARR',
  '2 DATE 10 JUN 1855',
  '2 PLAC Holland, Ottawa County, Michigan, USA',
  '2 SOUR @S2@',
  '3 PAGE Book 1, Page 42',
  '0 @F_SPOUSE_PARENTS@ FAM',
  '1 HUSB @I5P@',
  '1 CHIL @I5@',
  '0 @F2@ FAM',
  '1 HUSB @I3@',
  '1 WIFE @I5@',
  '1 CHIL @I6@',
  '1 MARR',
  '2 DATE 1883',
  '2 PLAC Hudsonville, Ottawa County, Michigan, USA',
  '0 @F3@ FAM',
  '1 HUSB @I7@',
  '1 WIFE @I6@',
  '1 CHIL @I8@',
  '1 DIV',
  '2 DATE 1920',
  '0 TRLR',
].join('\n');

describe('GEDCOM parse & slice behavioral suite', () => {
  it('parses repositories, sources, media objects, notes with CONT, RESN, and family events', () => {
    const parsed = parseGedcomText(RICH_SYNTHETIC_GEDCOM);

    expect(parsed.repos.get('@R1@')).toBe('National Archives and Records Administration');
    expect(parsed.sours.get('@S1@')?.title).toBe('1880 United States Federal Census');
    expect(parsed.objes.get('@O1@')?.width).toBe(800);
    expect(parsed.objes.get('@O1@')?.height).toBe(1000);
    expect(parsed.indis.get('@I8@')?.resn).toBe('CONFIDENTIAL');
    expect(parsed.indis.get('@I1@')?.altNames).toContain('Tom Alder');
    expect(parsed.fams.get('@F1@')?.marr?.place).toContain('Holland');
    expect(parsed.fams.get('@F3@')?.events.some((e) => e.tag === 'DIV')).toBe(true);
  });

  it('slices ancestors, siblings, descendants, maiden names, depth caps, and living privacy flags', () => {
    const full = sliceGedcom(RICH_SYNTHETIC_GEDCOM, {
      rootName: 'Henry Alder',
      ancestorSurnames: ['Alder'],
      includeAncestorSiblings: true,
      includeDescendantSpouses: true,
      expandSpouseAncestors: false,
      normalizeMaidenNames: true,
      referenceYear: 2026,
      knownPlaces: {
        'hudsonville, ottawa county, michigan, usa': { lat: 42.8711, lng: -85.8648, place_type: 'town' },
      },
    });

    expect(full.rootXref).toBe('@I3@');
    // Spouse Clara Bramwell's parent George Bramwell excluded when expandSpouseAncestors is false
    expect(full.people.some((p) => p.full_name === 'George Bramwell')).toBe(false);
    // Maiden name normalized for Martha Mercer with married name in alt_names
    const martha = full.people.find((p) => p.given_name === 'Martha');
    expect(martha?.surname).toBe('Mercer');
    expect(martha?.alt_names).toContain('Martha Alder');
    // Living descendant marked living
    expect(full.people.some((p) => p.is_living === true)).toBe(true);
    // Sibling Samuel and descendant spouse Arthur included
    expect(full.people.some((p) => p.full_name === 'Samuel Alder')).toBe(true);
    expect(full.people.some((p) => p.full_name === 'Arthur Vance')).toBe(true);
    expect(full.events.length).toBeGreaterThan(5);
    expect(full.sources.length).toBeGreaterThan(0);

    // Depth caps & stopDescendantXrefs prune subtrees
    const pruned = sliceGedcom(RICH_SYNTHETIC_GEDCOM, {
      rootXref: '@I3@',
      expandSpouseAncestors: true,
      includeAncestorSiblings: false,
      includeDescendantSpouses: false,
      stopDescendantXrefs: ['@I6@'],
      maxAncestorDepth: 1,
      maxDescendantDepth: 1,
      normalizeMaidenNames: false,
      referenceYear: 2026,
    });
    expect(pruned.people.some((p) => p.full_name === 'Samuel Alder')).toBe(false);
    expect(pruned.people.some((p) => p.full_name === 'Arthur Vance')).toBe(false);
    expect(pruned.people.some((p) => p.birth_date === '1995')).toBe(false);
  });

  it('handles escaped @ signs, emigration/residence/naturalization events, missing-root errors, and GEDCOM 7 export round-trips', () => {
    const extraGedcom = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0',
      '0 @I1@ INDI',
      '1 NAME Willem /Van Der Berg/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE BET 1820 AND 1822',
      '2 PLAC Utrecht, Netherlands',
      '1 EMIG',
      '2 DATE 1847',
      '2 PLAC Rotterdam, Netherlands',
      '1 NATU',
      '2 DATE 1854',
      '2 PLAC Ottawa County, Michigan, USA',
      '1 RESI',
      '2 DATE 1860',
      '2 PLAC Zeeland, Ottawa County, Michigan, USA',
      '2 NOTE Email contact: archive@@example.test',
      '1 DEAT',
      '2 DATE 1898',
      '0 TRLR',
    ].join('\n');

    const parsed = parseGedcomText(extraGedcom);
    const indi = parsed.indis.get('@I1@');
    expect(indi?.events.some((e) => e.tag === 'EMIG')).toBe(true);
    expect(
      indi?.events.some((e) => e.tag === 'RESI' && e.notes.some((n) => n.includes('archive@example.test')))
    ).toBe(true);

    expect(() => sliceGedcom(extraGedcom, { rootName: 'Nonexistent Person' })).toThrow();

    const sliced = sliceGedcom(extraGedcom, { rootXref: '@I1@', referenceYear: 2026 });
    const siteConfig = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_ARCHIVE' },
      defaultBranchId: 'primary',
      branches: [{ id: 'primary', label: 'Primary' }],
    });
    const { bundle } = compileArchive(
      {
        siteConfig,
        people: sliced.people,
        events: sliced.events,
        places: sliced.places,
        sources: sliced.sources,
        kinship: sliced.kinship,
        narratives: [],
        stories: [],
        media: [],
      },
      { mode: 'public', referenceYear: 2026 }
    );
    const ged = exportGedcom7(bundle, siteConfig);
    expect(ged).toContain('0 HEAD');
    expect(ged).toContain('Van Der Berg');
    expect(ged).toContain('0 TRLR');

    // Full multi-generation fixture exported in private mode with living-person RESN CONFIDENTIAL
    const fullSliced = sliceGedcom(RICH_SYNTHETIC_GEDCOM, { rootName: 'Henry Alder', referenceYear: 2026 });
    const { bundle: privBundle } = compileArchive(
      {
        siteConfig,
        people: fullSliced.people,
        events: fullSliced.events,
        places: fullSliced.places,
        sources: fullSliced.sources,
        kinship: fullSliced.kinship,
        narratives: [],
        stories: [],
        media: [],
      },
      { mode: 'private', referenceYear: 2026 }
    );
    const privGed = exportGedcom7(privBundle, siteConfig, {
      filterDescription: 'Full Alder Branch',
      exportDate: new Date('2026-11-26T00:00:00.000Z'),
      includeRedactedLiving: true,
    });
    expect(privGed).toContain('0 HEAD');
    expect(privGed).toContain('1 MARR');
    expect(privGed).toContain('0 TRLR');
  });

  it('disambiguates duplicate names, flags chronological anomalies, and handles unknown/unparsed GEDCOM dates', () => {
    const edgeGedcom = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 7.0',
      '0 @I1@ INDI',
      '1 NAME Henry /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1880',
      '2 PLAC Holland, Michigan, USA',
      '1 DEAT',
      '2 DATE 1870',
      '1 FAMS @F1@',
      '1 FAMS @F2@',
      '0 @I2@ INDI',
      '1 NAME Henry /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1850',
      '1 DEAT',
      '2 DATE 1920',
      '1 FAMS @F1@',
      '0 @I3@ INDI',
      '1 NAME Henry /Alder/',
      '1 SEX M',
      '1 BIRT',
      '2 DATE 1850',
      '1 DEAT',
      '2 DATE 1915',
      '1 FAMC @F1@',
      '0 @I4@ INDI',
      '1 NAME Sarah /Mercer/',
      '1 SEX F',
      '1 BIRT',
      '2 DATE AFT 1882',
      '1 DEAT',
      '2 DATE BEF 1955',
      '1 FAMS @F2@',
      '0 @I5@ INDI',
      '1 NAME SingleWordName',
      '1 SEX U',
      '1 BIRT',
      '2 DATE CAL 1905',
      '1 DEAT',
      '2 DATE EST 1975',
      '1 FAMC @F2@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I3@',
      '0 @F2@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I4@',
      '1 CHIL @I5@',
      '1 MARR',
      '2 DATE 1902',
      '0 TRLR',
    ].join('\n');

    const sliced = sliceGedcom(edgeGedcom, { rootXref: '@I1@', referenceYear: 2026 });
    const slugs = sliced.people.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(Array.isArray(sliced.anomalies)).toBe(true);
    expect(sliced.people.some((p) => p.full_name === 'SingleWordName')).toBe(true);
  });
});

describe('GEDCOM parser rich record behavioral contract', () => {
  it('parses INDI/FAM names, RESN, FAMC/FAMS, OBJE, SOUR, and PAGE citations with redaction', () => {
    const raw = [
      '0 HEAD',
      '1 GEDC',
      '2 VERS 5.5.1',
      '0 @R1@ REPO',
      '1 NAME County Clerk Archive',
      '0 @S1@ SOUR',
      '1 TITL 1910 Census Schedule',
      '1 REPO @R1@',
      '0 @O1@ OBJE',
      '1 FILE photos/alder.jpg',
      '1 TITL Alder Homestead',
      '0 @I1@ INDI',
      '1 NAME Henry /Alder/',
      '2 TYPE birth',
      '2 GIVN Henry',
      '2 SURN Alder',
      '1 SEX M',
      '1 RESN privacy',
      '1 FAMC @F0@',
      '1 FAMS @F1@',
      '1 SOUR @S1@',
      '1 OBJE @O1@',
      '1 BIRT',
      '2 DATE 14 MAR 1882',
      '2 PLAC Grand Rapids, Kent, Michigan, USA',
      '2 NOTE Born at the west homestead',
      '2 SOUR @S1@',
      '3 PAGE Sheet 4B, SSN 123-45-6789',
      '2 OBJE @O1@',
      '0 @I2@ INDI',
      '1 NAME Clara /Mercer/',
      '1 SEX F',
      '1 FAMS @F1@',
      '0 @I3@ INDI',
      '1 NAME Owen /Alder/',
      '1 SEX M',
      '1 FAMC @F1@',
      '0 @F1@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I3@',
      '1 SOUR @S1@',
      '1 MARR',
      '2 DATE 10 JUN 1905',
      '2 PLAC Hudsonville, Ottawa, Michigan, USA',
      '2 NOTE Married by Rev. Vance',
      '2 SOUR @S1@',
      '3 PAGE Book 2, Page 19',
      '0 TRLR',
    ].join('\n');

    const parsed = parseGedcomText(raw);
    const henry = parsed.indis.get('@I1@');
    expect(henry).toBeDefined();
    expect(henry?.resn).toBe('privacy');
    expect(henry?.famc).toContain('@F0@');
    expect(henry?.fams).toContain('@F1@');
    expect(henry?.sources).toContain('@S1@');
    expect(henry?.objes).toContain('@O1@');
    expect(henry?.events[0]?.notes).toContain('Born at the west homestead');
    expect(henry?.events[0]?.sources[0]?.page).not.toContain('123-45-6789');

    const fam = parsed.fams.get('@F1@');
    expect(fam?.husb).toBe('@I1@');
    expect(fam?.wife).toBe('@I2@');
    expect(fam?.children).toContain('@I3@');
    expect(fam?.marr?.date).toBe('10 JUN 1905');
    expect(fam?.marr?.place).toContain('Hudsonville');
    expect(fam?.marr?.notes).toContain('Married by Rev. Vance');
    expect(fam?.marr?.sources[0]?.page).toBe('Book 2, Page 19');
  });
});
