import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { compileArchive } from '../compileArchive.js';
import { parseKinloomConfig } from '../schemas/config.js';
import {
  cleanAlternateNote,
  cleanEventSummaryProse,
  cleanSourceCitationTitle,
  inferSourceRepository,
  redactSensitiveCitationDetail,
} from './citations.js';
import {
  buildGedcomExportFilename,
  escapeGedcomValue,
  exportGedcom7,
  formatEdtfToGedcomDate,
  formatGedcomName,
} from './export.js';
import { parseGedcomText, recordScanMatchesSourceCitation } from './parse.js';
import { sliceGedcom } from './slice.js';

const SYNTHETIC_GEDCOM = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @R1@ REPO
1 NAME State Historical Society
0 @S1@ SOUR
1 TITL 1880 United States Federal Census (Ancestry GEDCOM @S1@)
1 AUTH Bureau of the Census
1 PUBL Ancestry.com Operations Inc
1 REPO @R1@
0 @I1@ INDI
1 NAME William /Alder/
1 SEX M
1 BIRT
2 DATE 10 MAY 1820
2 PLAC Springfield, Franklin, Ohio, USA
2 SOUR @S1@
3 PAGE Number: 123-45-6789; District 4, p. 12
1 DEAT
2 DATE 14 NOV 1895
2 PLAC Springfield, Franklin, Ohio, USA
1 FAMS @F1@
0 @I2@ INDI
1 NAME Martha /Bramwell/
2 TYPE maiden
1 NAME Martha /Alder/
2 TYPE married
1 SEX F
1 BIRT
2 DATE 1824
2 PLAC Dover, Kent, England
1 DEAT
2 DATE 1901
2 PLAC Springfield, Franklin, Ohio, USA
1 FAMC @F99@
1 FAMS @F1@
0 @I99@ INDI
1 NAME George /Bramwell/
1 SEX M
1 BIRT
2 DATE 1795
1 DEAT
2 DATE 1860
1 FAMS @F99@
0 @I3@ INDI
1 NAME Henry /Alder/
1 SEX M
1 BIRT
2 DATE 1850
2 PLAC Springfield, Franklin, Ohio, USA
1 RESI
2 DATE 1880
2 PLAC Springfield, Franklin, Ohio, USA
2 SOUR @S1@
1 DEAT
2 DATE 1922
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Clara /Alder/
1 SEX F
1 BIRT
2 DATE 1853
2 PLAC Springfield, Franklin, Ohio, USA
1 DEAT
2 DATE 1928
1 FAMC @F1@
0 @I5@ INDI
1 NAME Sarah (Larkin) /Alder/
1 SEX F
1 BIRT
2 DATE 1854
1 DEAT
2 DATE 1931
1 FAMS @F2@
0 @I6@ INDI
1 NAME Owen /Alder/
1 SEX M
1 BIRT
2 DATE 1985-04-10
2 PLAC Springfield, Franklin, Ohio, USA
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 12 JUN 1848
2 PLAC Springfield, Franklin, Ohio, USA
2 SOUR @S1@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I5@
1 CHIL @I6@
1 MARR
2 DATE 1878
2 PLAC Springfield, Franklin, Ohio, USA
0 @F99@ FAM
1 HUSB @I99@
1 CHIL @I2@
0 TRLR
`;

describe('GEDCOM citations, parse, export, and sliceGedcom', () => {
  it('redacts SSNs, cleans source titles, infers repositories, and polishes summary prose', () => {
    expect(redactSensitiveCitationDetail('Number: 123-45-6789; Roll 12')).toBe('Roll 12');
    expect(redactSensitiveCitationDetail('SSN 987-65-4321 listed')).toBe('SSN [SSN redacted] listed');
    expect(cleanSourceCitationTitle('1900 United States Federal Census (Ancestry GEDCOM @S42@)')).toBe(
      '1900 United States Federal Census'
    );
    expect(inferSourceRepository('1900 United States Federal Census')).toBe(
      'National Archives and Records Administration (NARA)'
    );
    expect(inferSourceRepository('Parish Register', 'Local Archive')).toBe('Local Archive');
    expect(
      cleanEventSummaryProse('John was born on 27 oct 1850 according to the Ancestry GEDCOM (@I1@).')
    ).toBe('John was born on 27 Oct 1850.');
    expect(cleanAlternateNote('GEDCOM alternate date: 1851 (GEDCOM @I1@)')).toBe('Alternate date: 1851');
    expect(
      recordScanMatchesSourceCitation('1880 US Federal Census', '1880 United States Federal Census')
    ).toBe(true);
  });

  it('slices a combined GEDCOM with maiden names primary, complete siblings, and no upstream spouse-parent subtrees by default', () => {
    const sliced = sliceGedcom(SYNTHETIC_GEDCOM, {
      rootXref: '@I3@',
      ancestorSurnames: ['Alder'],
      branchId: 'alder_line',
      referenceYear: 2026,
    });

    // George Bramwell (@I99@, married-in mother's father) MUST NOT be pulled into slice when expandSpouseAncestors=false
    const xrefs = new Set(sliced.people.map((p) => p.gedcom_xref));
    expect(xrefs.has('@I1@')).toBe(true);
    expect(xrefs.has('@I2@')).toBe(true);
    expect(xrefs.has('@I3@')).toBe(true);
    expect(xrefs.has('@I4@')).toBe(true); // complete sibling of root
    expect(xrefs.has('@I5@')).toBe(true); // spouse of root
    expect(xrefs.has('@I6@')).toBe(true); // living descendant
    expect(xrefs.has('@I99@')).toBe(false);

    // Maiden names normalized as primary, married names in alt_names
    const martha = sliced.people.find((p) => p.gedcom_xref === '@I2@');
    expect(martha?.full_name).toBe('Martha Bramwell');
    expect(martha?.surname).toBe('Bramwell');
    expect(martha?.alt_names).toContain('Martha Alder');

    const sarah = sliced.people.find((p) => p.gedcom_xref === '@I5@');
    expect(sarah?.full_name).toBe('Sarah Larkin');
    expect(sarah?.surname).toBe('Larkin');
    expect(sarah?.alt_names).toContain('Sarah Alder');

    // Living detection works on modern birth without death
    const owen = sliced.people.find((p) => p.gedcom_xref === '@I6@');
    expect(owen?.is_living).toBe(true);

    // SSN redacted on parsed PAGE citation
    const williamBirth = sliced.events.find((e) => e.title === 'Birth of William Alder');
    expect(williamBirth?.sources[0]?.citation_detail).toBe('District 4, p. 12');

    // When expandSpouseAncestors is explicitly true, @I99@ IS included
    const expanded = sliceGedcom(SYNTHETIC_GEDCOM, {
      rootXref: '@I3@',
      ancestorSurnames: ['Alder'],
      expandSpouseAncestors: true,
    });
    expect(expanded.people.some((p) => p.gedcom_xref === '@I99@')).toBe(true);
  });

  it('respects custom livingCutoffYears for undated children via parent birth-year cutoff in sliceGedcom', () => {
    const undatedChildGedcom = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Thomas /Alder/
1 SEX M
1 BIRT
2 DATE 1915
1 DEAT
2 DATE 1988
1 FAMS @F1@
0 @I2@ INDI
1 NAME Nora /Alder/
1 SEX F
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 TRLR
`;

    const defaultCutoff = sliceGedcom(undatedChildGedcom, {
      rootXref: '@I1@',
      ancestorSurnames: ['Alder'],
      referenceYear: 2026,
    });
    const childDefault = defaultCutoff.people.find((p) => p.gedcom_xref === '@I2@');
    expect(childDefault?.is_living).toBe(false);

    const widerCutoff = sliceGedcom(undatedChildGedcom, {
      rootXref: '@I1@',
      ancestorSurnames: ['Alder'],
      referenceYear: 2026,
      livingCutoffYears: 120,
    });
    const childWider = widerCutoff.people.find((p) => p.gedcom_xref === '@I2@');
    expect(childWider?.is_living).toBe(true);
  });

  it('exports parameterized GEDCOM 7 with HEAD.SOUR from siteConfig and 1 RESN CONFIDENTIAL for living people', () => {
    const sliced = sliceGedcom(SYNTHETIC_GEDCOM, {
      rootXref: '@I3@',
      ancestorSurnames: ['Alder'],
      branchId: 'alder_line',
    });

    const siteConfig = parseKinloomConfig({
      site: {
        title: 'Alder Family Archive',
        familyName: 'Alder',
        gedcomSourceName: 'ALDER_ARCHIVE',
      },
      branches: [{ id: 'alder_line', label: 'Alder Line' }],
    });

    const { bundle } = compileArchive({
      people: sliced.people,
      events: sliced.events,
      places: sliced.places,
      sources: sliced.sources,
      kinship: sliced.kinship,
      siteConfig,
      mode: 'private',
      generatedAt: '2026-11-24T00:00:00.000Z',
    });

    const ged7 = exportGedcom7(bundle, siteConfig, {
      exportDate: new Date(Date.UTC(2026, 10, 24)),
    });

    expect(ged7).toContain('2 VERS 7.0');
    expect(ged7).toContain('1 SOUR ALDER_ARCHIVE');
    expect(ged7).toContain('2 NAME Alder Family Archive');
    expect(ged7).toContain('1 RESN CONFIDENTIAL');
    expect(ged7).toContain('0 TRLR');

    // Round-trip parse of exported GEDCOM 7
    const reparsed = parseGedcomText(ged7);
    expect(reparsed.indis.size).toBe(sliced.people.length);
    const livingIndis = [...reparsed.indis.values()].filter((i) => i.resn === 'CONFIDENTIAL');
    expect(livingIndis).toHaveLength(1);
    expect(livingIndis[0].fullName).toBe('Owen Alder');

    expect(
      buildGedcomExportFilename({
        familySlug: 'alder-family',
        lineageFilter: 'ancestor',
        selectedEra: 'all',
        onlyWithMedia: true,
        query: 'Springfield',
        sortBy: 'birth',
        count: 6,
      })
    ).toBe('alder-family-ancestor-with-media-springfield-sorted-birth-6-relatives.ged');
  });

  it('property: redactSensitiveCitationDetail removes every SSN pattern and formatEdtfToGedcomDate never throws', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 999 }),
        fc.integer({ min: 10, max: 99 }),
        fc.integer({ min: 1000, max: 9999 }),
        (a, b, c) => {
          const ssn = `${a}-${b}-${c}`;
          const cleaned = redactSensitiveCitationDetail(`Record; Number: ${ssn}; Sheet 3A`);
          expect(cleaned).not.toContain(ssn);
          expect(cleaned).toContain('Sheet 3A');
        }
      ),
      { numRuns: 50 }
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 1600, max: 2020 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        (y, m, d) => {
          const edtf = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
          const ged = formatEdtfToGedcomDate(edtf);
          expect(ged).toMatch(/^\d{1,2} [A-Z]{3} \d{4}$/);
          expect(escapeGedcomValue('@leading')).toBe('@@leading');
          expect(
            formatGedcomName({ full_name: 'Ada Lovelace', given_name: 'Ada', surname: 'Lovelace' })
          ).toBe('Ada /Lovelace/');
        }
      ),
      { numRuns: 50 }
    );
  });
});
