import { describe, expect, it } from 'vitest';
import { parseKinloomConfig } from '../schemas/config.js';
import type { ArchiveBundle, ArchiveEvent, Person, Place, SourceRecord } from '../schemas/entities.js';
import { UNVERIFIED_TREE_SOURCE_ID } from './citations.js';
import { buildFilteredGedcom7, exportGedcom7 } from './export.js';
import {
  buildGedcomExportFilename,
  classifyPersonalEventTag,
  escapeGedcomValue,
  formatEdtfToGedcomDate,
  formatGedcomName,
  formatHeaderDate,
  pushTag,
} from './exportFormat.js';
import {
  applyIndiName,
  attachPageToLastSource,
  attachPhotoToEvent,
  type GedcomEvent,
  type GedcomFam,
  type GedcomIndi,
  type GedcomLinkedEvent,
  type GedcomSourMeta,
  linkRecordScans,
  parseGedcomNameValue,
  parseGedcomText,
  recordIndiPage,
  recordScanMatchesSourceCitation,
  sourceMatchesRecordScan,
} from './parse.js';
import {
  buildSliceEventsAndSources,
  buildSliceKinship,
  buildSlicePeople,
  collectRawSlicePlaces,
} from './sliceBuilders.js';
import {
  buildPlacesFromRaw,
  detectLivingStatus,
  inferPlaceType,
  makeUniqueSlug,
  normalizePersonNames,
  placePrecisionFromType,
  slugify,
  splitName,
} from './sliceNormalization.js';
import { resolveRootXref, selectGedcomLineage } from './sliceTraversal.js';
import type { GedcomLineageSelection } from './sliceTypes.js';

function makePerson(overrides: Partial<Person> & Pick<Person, 'id' | 'slug' | 'full_name'>): Person {
  return {
    given_name: '',
    surname: '',
    alt_names: [],
    sex: 'U',
    is_living: false,
    lineage_group: 'extended',
    birth_edtf: '',
    death_edtf: '',
    portrait_url: null,
    birth_year: null,
    death_year: null,
    event_count: 0,
    primary_place_id: null,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ArchiveEvent> & Pick<ArchiveEvent, 'id' | 'title'>): ArchiveEvent {
  return {
    scope: 'personal',
    event_kind: 'point_event',
    category: 'life_milestone',
    edtf_date: '',
    place_id: null,
    summary: '',
    participants: [],
    sources: [],
    display_date: '',
    year: null,
    time_min: null,
    time_max: null,
    ...overrides,
  };
}

function makeBundle(overrides: Partial<ArchiveBundle> = {}): ArchiveBundle {
  return {
    meta: {
      version: '1.0',
      generated_at: '2026-01-01T00:00:00Z',
      build_mode: 'public',
      counts: {
        people: 0,
        living_redacted: 0,
        events: 0,
        places: 0,
        sources: 0,
        media: 0,
        residence_spans: 0,
      },
    },
    people: [],
    places: [],
    place_ancestors: {},
    events: [],
    residence_spans: [],
    kinship: [],
    sources: [],
    media: [],
    narratives: [],
    ...overrides,
  };
}

function makeIndi(xref: string, overrides: Partial<GedcomIndi> = {}): GedcomIndi {
  return {
    xref,
    fullName: '',
    givenName: '',
    surname: '',
    altNames: [],
    nameEntries: [],
    sex: 'U',
    famc: [],
    fams: [],
    events: [],
    sources: [],
    objes: [],
    ...overrides,
  };
}

function makeFam(xref: string, overrides: Partial<GedcomFam> = {}): GedcomFam {
  return {
    xref,
    husb: '',
    wife: '',
    children: [],
    events: [],
    sources: [],
    ...overrides,
  };
}

describe('gedcom exportFormat branch coverage', () => {
  it('escapes GEDCOM values and handles pushTag multiline, empty, and @-prefixed inputs', () => {
    expect(escapeGedcomValue('  @handle\r\n')).toBe('@@handle');
    expect(escapeGedcomValue('plain\rtext')).toBe('plain\ntext');

    const lines: string[] = [];
    pushTag(lines, 1, 'BIRT');
    pushTag(lines, 1, 'DEAT', '');
    pushTag(lines, 1, 'NOTE', '   \r\n  ');
    pushTag(lines, 1, 'NOTE', '@first\r\n@second\nthird');
    expect(lines).toEqual(['1 BIRT', '1 DEAT', '1 NOTE @@first', '2 CONT @@second', '2 CONT third']);
  });

  it('formats single, decade, approximate, invalid, and interval EDTF dates to GEDCOM', () => {
    expect(formatEdtfToGedcomDate(null)).toBe('');
    expect(formatEdtfToGedcomDate(undefined)).toBe('');
    expect(formatEdtfToGedcomDate('')).toBe('');
    expect(formatEdtfToGedcomDate('   ')).toBe('');
    expect(formatEdtfToGedcomDate(1875)).toBe('1875');

    expect(formatEdtfToGedcomDate('188X')).toBe('BET 1880 AND 1889');
    expect(formatEdtfToGedcomDate('188X~')).toBe('BET 1880 AND 1889');
    expect(formatEdtfToGedcomDate('1880-05-12')).toBe('12 MAY 1880');
    expect(formatEdtfToGedcomDate('1880-13-12')).toBe('');
    expect(formatEdtfToGedcomDate('1880-05-00')).toBe('');
    expect(formatEdtfToGedcomDate('1880-05-32')).toBe('');
    expect(formatEdtfToGedcomDate('1880-05')).toBe('MAY 1880');
    expect(formatEdtfToGedcomDate('1880-00')).toBe('');
    expect(formatEdtfToGedcomDate('not-a-date')).toBe('');

    expect(formatEdtfToGedcomDate('1880~')).toBe('ABT 1880');
    expect(formatEdtfToGedcomDate('1880?')).toBe('ABT 1880');
    expect(formatEdtfToGedcomDate('1880%')).toBe('ABT 1880');
    expect(formatEdtfToGedcomDate('Abt. 1880-06')).toBe('ABT JUN 1880');

    expect(formatEdtfToGedcomDate('1880/1890')).toBe('BET 1880 AND 1890');
    expect(formatEdtfToGedcomDate('188X/189X')).toBe('BET 1880 AND 1899');
    expect(formatEdtfToGedcomDate('1880~/')).toBe('AFT 1880');
    expect(formatEdtfToGedcomDate('188X/')).toBe('AFT 1880');
    expect(formatEdtfToGedcomDate('/1890?')).toBe('BEF 1890');
    expect(formatEdtfToGedcomDate('/189X')).toBe('BEF 1899');
    expect(formatEdtfToGedcomDate('/')).toBe('');
    expect(formatEdtfToGedcomDate('invalid/invalid')).toBe('');
  });

  it('formats GEDCOM names across all missing-field fallbacks', () => {
    expect(formatGedcomName({ full_name: 'Clara Alder', given_name: 'Clara', surname: 'Alder' })).toBe(
      'Clara /Alder/'
    );
    expect(formatGedcomName({ full_name: 'Alder', given_name: '', surname: 'Alder' })).toBe('/Alder/');
    expect(formatGedcomName({ full_name: 'Mary Anne Birch', given_name: '', surname: '' })).toBe(
      'Mary Anne /Birch/'
    );
    expect(formatGedcomName({ full_name: 'Mononym', given_name: '', surname: '' })).toBe('Mononym');
    expect(formatGedcomName({ full_name: '   ', given_name: '', surname: '' })).toBe('Unknown');
  });

  it('classifies all personal event tags including fallbacks', () => {
    expect(classifyPersonalEventTag(makeEvent({ id: 'e1', title: 'Birth of Clara Alder' }))).toEqual({
      tag: 'BIRT',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e2', title: 'Death of Clara Alder' }))).toEqual({
      tag: 'DEAT',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e3', title: 'Burial at Harbor Hill' }))).toEqual({
      tag: 'BURI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e4', title: 'Clara was buried in Harbor' }))).toEqual({
      tag: 'BURI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e5', title: 'Marriage of Clara and Owen' }))).toBeNull();
    expect(classifyPersonalEventTag(makeEvent({ id: 'e6', title: 'Clara married Owen' }))).toBeNull();
    expect(classifyPersonalEventTag(makeEvent({ id: 'e7', title: 'Divorce record' }))).toBeNull();
    expect(classifyPersonalEventTag(makeEvent({ id: 'e8', title: '1880 Federal Census' }))).toEqual({
      tag: 'CENS',
    });
    expect(
      classifyPersonalEventTag(
        makeEvent({ id: 'e9', title: 'Homestead move', event_kind: 'residence_anchor' })
      )
    ).toEqual({ tag: 'RESI' });
    expect(
      classifyPersonalEventTag(makeEvent({ id: 'e10', title: 'Farm record', category: 'homestead' }))
    ).toEqual({ tag: 'RESI' });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e11', title: 'Residence in Cedar County' }))).toEqual({
      tag: 'RESI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e12', title: 'Lived at Harbor Landing' }))).toEqual({
      tag: 'RESI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e13', title: 'Immigration to Harbor' }))).toEqual({
      tag: 'IMMI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e14', title: 'Arrival at Harbor Port' }))).toEqual({
      tag: 'IMMI',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e15', title: 'Military enlistment' }))).toEqual({
      tag: 'EVEN',
      eventType: 'Military / Service',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e16', title: '1917 Draft Registration' }))).toEqual({
      tag: 'EVEN',
      eventType: 'Military / Service',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e17', title: 'Land Grant Deed' }))).toEqual({
      tag: 'EVEN',
      eventType: 'Land Grant Deed',
    });
    expect(classifyPersonalEventTag(makeEvent({ id: 'e18', title: '', category: null }))).toEqual({
      tag: 'EVEN',
      eventType: 'Historical Event',
    });
  });

  it('formats header date and builds export filenames with default and populated filters', () => {
    expect(formatHeaderDate(new Date('2026-04-09T12:00:00Z'))).toBe('9 APR 2026');

    expect(
      buildGedcomExportFilename({
        familySlug: '!!!',
        lineageFilter: 'all',
        selectedEra: 'all',
        onlyWithMedia: false,
        query: '   ',
        sortBy: 'featured',
        count: 3,
      })
    ).toBe('family-archive-3-relatives.ged');

    expect(
      buildGedcomExportFilename({
        familySlug: 'Alder Line',
        lineageFilter: 'direct_ancestor',
        selectedEra: '1800s',
        onlyWithMedia: true,
        query: 'Harbor Creek',
        sortBy: 'birth_year',
        count: 12,
      })
    ).toBe('alder-line-direct-ancestor-1800s-with-media-harbor-creek-sorted-birth-year-12-relatives.ged');
  });
});

describe('gedcom parse branch coverage', () => {
  it('handles name parsing, alt name deduplication, page attachment, photos, and scan linking', () => {
    expect(parseGedcomNameValue('/Mercer/')).toEqual({
      raw: '/Mercer/',
      fullName: 'Mercer',
      givenName: 'Mercer',
      surname: 'Mercer',
    });
    expect(parseGedcomNameValue('@@Clara /Alder/')).toEqual({
      raw: '@Clara /Alder/',
      fullName: '@Clara Alder',
      givenName: '@Clara',
      surname: 'Alder',
    });

    const ind = makeIndi('@I1@');
    applyIndiName(ind, 'Clara /Alder/');
    applyIndiName(ind, 'Clara /Mercer/');
    applyIndiName(ind, 'Clara /Mercer/');
    applyIndiName(ind, '   ');
    expect(ind.fullName).toBe('Clara Alder');
    expect(ind.altNames).toEqual(['Clara Mercer']);

    const emptyEvent: GedcomEvent = { tag: 'BIRT', date: '', place: '', notes: [], sources: [] };
    attachPageToLastSource(emptyEvent, '@S1@', 'p. 1');
    expect(emptyEvent.sources).toEqual([]);

    const sourcedEvent: GedcomEvent = {
      tag: 'BIRT',
      date: '',
      place: '',
      notes: [],
      sources: [{ sourXref: '@S1@', page: '' }],
    };
    attachPageToLastSource(sourcedEvent, '@S2@', 'p. 9');
    expect(sourcedEvent.sources[0]?.page).toBe('');
    attachPageToLastSource(sourcedEvent, '@S1@', 'p. 4');
    attachPageToLastSource(sourcedEvent, '@S1@', 'p. 5');
    expect(sourcedEvent.sources[0]?.page).toBe('p. 4');

    const eventPages = new Map<string, string[]>();
    recordIndiPage('@I1@', 'BIRT', '@S1@', 'Number: 123-45-6789', eventPages, null);
    expect(eventPages.size).toBe(0);

    recordIndiPage('@I1@', 'BIRT', '@S1@', 'Sheet 2A', eventPages, null);
    recordIndiPage('@I1@', 'BIRT', '@S1@', 'Sheet 2A', eventPages, sourcedEvent);
    expect(eventPages.get('@I1@|BIRT|@S1@')).toEqual(['Sheet 2A']);

    expect(attachPhotoToEvent(null, '/a.jpg', 'cap')).toBe(0);
    expect(attachPhotoToEvent(undefined, '/a.jpg', 'cap')).toBe(0);
    const photoTarget: { photo_url?: string; photo_placeholder_caption?: string } = {};
    expect(attachPhotoToEvent(photoTarget, '/a.jpg', 'Harbor Bridge')).toBe(1);
    expect(photoTarget).toEqual({ photo_url: '/a.jpg', photo_placeholder_caption: 'Harbor Bridge' });

    expect(recordScanMatchesSourceCitation('', '1880 Census')).toBe(false);
    expect(recordScanMatchesSourceCitation('1880 Census', '')).toBe(false);
    expect(recordScanMatchesSourceCitation('1880 Census', '1880 U.S. Federal Census')).toBe(true);
    expect(recordScanMatchesSourceCitation('1880 Ohio Census', '1880 Federal Census Roll')).toBe(true);
    expect(recordScanMatchesSourceCitation('1880 Ohio Census', '1900 Federal Census Roll')).toBe(false);
    expect(recordScanMatchesSourceCitation('County Probate Register', 'State Marriage Index')).toBe(false);

    const sourcesById = new Map<string, SourceRecord>([
      ['src_1', { id: 'src_1', citation: '1880 Federal Census', source_type: 'archival_index' }],
      ['src_empty', { id: 'src_empty', citation: '', source_type: 'compiled_record' }],
    ]);
    expect(
      sourceMatchesRecordScan({ source_id: 'missing', confidence: 'low' }, '1880 Census', sourcesById)
    ).toBe(false);
    expect(
      sourceMatchesRecordScan({ source_id: 'src_empty', confidence: 'low' }, '1880 Census', sourcesById)
    ).toBe(false);
    expect(
      sourceMatchesRecordScan({ source_id: 'src_1', confidence: 'high' }, '1880 Census', sourcesById)
    ).toBe(true);

    const linkedEvents: GedcomLinkedEvent[] = [
      { id: 'ev_nosrc' },
      {
        id: 'ev_match',
        sources: [
          { source_id: 'src_empty', confidence: 'low' },
          { source_id: 'src_1', confidence: 'high' },
        ],
      },
    ];
    const linkResult = linkRecordScans(linkedEvents, '1880 Census', '/scans/1880.jpg', sourcesById);
    expect(linkResult).toEqual({ matchedEvId: 'ev_match', linkedCount: 1 });
    expect(linkedEvents[1]?.sources?.[1]?.scan_url).toBe('/scans/1880.jpg');
  });

  it('parses BOM, orphan records, OBJE dimensions, CONT, duplicate links, notes, and FAM pages', () => {
    const gedcom = [
      '\uFEFF0 HEAD',
      'not a valid gedcom line',
      '0 SOUR',
      '1 TITL Orphan Source',
      '0 @S1@ SOUR',
      '1 TITL 1880 Federal Census',
      '1 AUTH Bureau',
      '1 PUBL Harbor Press',
      '2 CONT Second Publisher Line',
      '1 REPO @R1@',
      '0 OBJE',
      '1 TITL Orphan Object',
      '0 @O1@ OBJE',
      '1 TITL First Portrait',
      '1 TITL Ignored Second Title',
      '1 FORM jpg',
      '1 FORM png',
      '1 _MTYPE portrait',
      '1 _WDTH 640',
      '1 _HGHT notanumber',
      '1 DATE 1890',
      '1 DATE 1891',
      '0 @O2@ OBJE',
      '1 _WDTH bad',
      '1 _HGHT 480',
      '0 INDI',
      '1 NAME Orphan Person',
      '0 @I1@ INDI',
      '1 NAME Clara /Alder/',
      '2 TYPE Birth',
      '2 GIVN Clara Mae',
      '2 SURN Alder',
      '2 SOUR @S1@',
      '3 PAGE Name Page',
      '1 SEX',
      '1 RESN CONFIDENTIAL',
      '1 FAMC @F1@',
      '1 FAMC @F1@',
      '1 FAMS @F2@',
      '1 FAMS @F2@',
      '1 SOUR @S1@',
      '1 SOUR @S1@',
      '1 OBJE @O1@',
      '1 OBJE @O2@',
      '1 BIRT',
      '2 DATE 10 MAY 1860',
      '2 PLAC Cedar, Ohio',
      '2 NOTE Born at Harbor',
      '2 SOUR @S1@',
      '3 PAGE Birth Sheet 1',
      '2 OBJE @O2@',
      '0 FAM',
      '1 HUSB @I1@',
      '0 @F2@ FAM',
      '1 HUSB @I1@',
      '1 WIFE @I2@',
      '1 CHIL @I3@',
      '1 SOUR @S1@',
      '1 SOUR @S1@',
      '1 MARR',
      '2 DATE 1882',
      '2 PLAC Cedar, Ohio',
      '2 NOTE Parish register',
      '2 SOUR @S1@',
      '3 PAGE Number: 123-45-6789',
      '2 SOUR @S2@',
      '3 PAGE Vol 4 p 8',
      '1 MARR',
      '2 DATE 1883',
      '0 TRLR',
    ].join('\r\n');

    const parsed = parseGedcomText(gedcom);
    expect(parsed.sours.get('@S1@')?.publisher).toBe('Harbor Press Second Publisher Line');
    expect(parsed.objes.get('@O1@')).toMatchObject({
      title: 'First Portrait',
      form: 'jpg',
      mtype: 'portrait',
      width: 640,
      height: null,
      date: '1890',
    });
    expect(parsed.objes.get('@O2@')).toMatchObject({ width: null, height: 480 });

    const indi = parsed.indis.get('@I1@');
    expect(indi?.sex).toBe('U');
    expect(indi?.resn).toBe('CONFIDENTIAL');
    expect(indi?.famc).toEqual(['@F1@']);
    expect(indi?.fams).toEqual(['@F2@']);
    expect(indi?.sources).toEqual(['@S1@']);
    expect(indi?.nameEntries[0]).toMatchObject({
      nameType: 'birth',
      givenName: 'Clara Mae',
      surname: 'Alder',
    });
    expect(indi?.events[0]?.notes).toEqual(['Born at Harbor']);
    expect(parsed.indiObjes.get('@I1@')?.size).toBe(2);

    const fam = parsed.fams.get('@F2@');
    expect(fam?.marr?.date).toBe('1882');
    expect(fam?.marr?.notes).toEqual(['Parish register']);
    expect(fam?.marr?.sources).toEqual([
      { sourXref: '@S1@', page: '' },
      { sourXref: '@S2@', page: 'Vol 4 p 8' },
    ]);
  });
});

describe('gedcom sliceNormalization and sliceTraversal branch coverage', () => {
  it('covers slug, splitName, place types/precisions, and raw place builder edge cases', () => {
    expect(slugify('!!!')).toBe('unknown');

    const used = new Set<string>();
    expect(makeUniqueSlug('Clara Alder', 1850, used)).toBe('clara-alder');
    expect(makeUniqueSlug('Clara Alder', 1850, used)).toBe('clara-alder-1850');
    expect(makeUniqueSlug('Clara Alder', 1850, used)).toBe('clara-alder-2');
    expect(makeUniqueSlug('Clara Alder', null, used)).toBe('clara-alder-3');

    expect(splitName('')).toEqual({ givenName: 'Unknown', surname: '' });
    expect(splitName('Alder')).toEqual({ givenName: 'Alder', surname: '' });
    expect(splitName('Mary Anne Alder')).toEqual({ givenName: 'Mary Anne', surname: 'Alder' });

    expect(inferPlaceType(4, 0, 'USA')).toBe('country');
    expect(inferPlaceType(4, 1, 'Ohio')).toBe('state');
    expect(inferPlaceType(4, 2, 'Cedar')).toBe('county');
    expect(inferPlaceType(4, 3, 'Birch Homestead')).toBe('homestead');
    expect(inferPlaceType(4, 3, 'Harbor')).toBe('town');
    expect(inferPlaceType(3, 3, 'Harbor')).toBe('county');

    expect(placePrecisionFromType('homestead')).toBe('exact');
    expect(placePrecisionFromType('town')).toBe('town');
    expect(placePrecisionFromType('county')).toBe('county');
    expect(placePrecisionFromType('state')).toBe('state');
    expect(placePrecisionFromType('country')).toBe('county');

    const built = buildPlacesFromRaw(['', ' , , ', 'Harbor, Cedar, Ohio, USA', 'Harbor, Cedar, Ohio, USA'], {
      'harbor, cedar, ohio, usa': { lat: 40.5, lng: -82.5, place_type: 'town' },
    });
    expect(built.rawToPlaceId.size).toBe(1);
    const harbor = built.placesById.get('plc_harbor-cedar-ohio-usa');
    expect(harbor?.lat).toBe(40.5);
    expect(harbor?.place_type).toBe('town');
  });

  it('covers maiden name normalization paths and living status heuristics', () => {
    const father = makeIndi('@FATH@', { fullName: 'Thomas Birch', givenName: 'Thomas', surname: 'Birch' });
    const husband = makeIndi('@HUSB@', { fullName: 'Owen Alder', givenName: 'Owen', surname: 'Alder' });
    const noSurSpouse = makeIndi('@NOSP@', { fullName: 'Sam', givenName: 'Sam', surname: '' });
    const wifeMarried = makeIndi('@W1@', {
      fullName: 'Clara Birch Alder',
      givenName: 'Clara Birch',
      surname: 'Alder',
      famc: ['@FM_MISSING@', '@FM1@'],
      fams: ['@FS_MISSING@', '@FS1@', '@FS2@'],
    });
    const wifeAltMatch = makeIndi('@W2@', {
      fullName: 'Martha Alder',
      givenName: 'Martha',
      surname: 'Alder',
      nameEntries: [
        { raw: 'Martha /Alder/', fullName: 'Martha Alder', givenName: 'Martha', surname: 'Alder' },
        { raw: 'Martha /Birch/', fullName: 'Martha Birch', givenName: 'Martha', surname: 'Birch' },
      ],
      famc: ['@FM1@'],
    });
    const wifeNoMatch = makeIndi('@W3@', {
      fullName: '',
      nameEntries: [
        { raw: 'Nora /Alder/', fullName: 'Nora Alder', givenName: 'Nora', surname: 'Alder' },
        { raw: 'Nora /Mercer/', fullName: 'Nora Mercer', givenName: 'Nora', surname: 'Mercer' },
      ],
      famc: ['@FM1@'],
    });
    const wifeNoDuplicateToken = makeIndi('@W4@', {
      fullName: 'Helen Alder',
      givenName: 'Helen',
      surname: 'Alder',
      famc: ['@FM1@'],
      fams: ['@FS1@'],
    });

    const indis = new Map<string, GedcomIndi>([
      ['@FATH@', father],
      ['@HUSB@', husband],
      ['@NOSP@', noSurSpouse],
      ['@W1@', wifeMarried],
      ['@W2@', wifeAltMatch],
      ['@W3@', wifeNoMatch],
      ['@W4@', wifeNoDuplicateToken],
    ]);
    const fams = new Map<string, GedcomFam>([
      ['@FM1@', makeFam('@FM1@', { husb: '@FATH@', children: ['@W1@', '@W2@', '@W3@', '@W4@'] })],
      ['@FS1@', makeFam('@FS1@', { husb: '@HUSB@', wife: '@W1@' })],
      ['@FS2@', makeFam('@FS2@', { husb: '@W1@', wife: '@NOSP@' })],
    ]);

    expect(normalizePersonNames(wifeMarried, indis, fams, false).fullName).toBe('Clara Birch Alder');
    expect(normalizePersonNames(wifeMarried, indis, fams, true)).toEqual({
      fullName: 'Clara Birch',
      givenName: 'Clara',
      surname: 'Birch',
      altNames: ['Clara Birch Alder'],
    });
    expect(normalizePersonNames(wifeAltMatch, indis, fams, true)).toEqual({
      fullName: 'Martha Birch',
      givenName: 'Martha',
      surname: 'Birch',
      altNames: ['Martha Alder'],
    });
    expect(normalizePersonNames(wifeNoMatch, indis, fams, true).fullName).toBe('Unknown');
    expect(normalizePersonNames(wifeNoDuplicateToken, indis, fams, true)).toEqual({
      fullName: 'Helen Birch',
      givenName: 'Helen',
      surname: 'Birch',
      altNames: ['Helen Alder'],
    });

    // detectLivingStatus fallback branches
    const resnPerson = makeIndi('@L1@', { resn: 'privacy' });
    const modernSpouse = makeIndi('@SP_MOD@', {
      events: [{ tag: 'BIRT', date: '1970', place: '', notes: [], sources: [] }],
    });
    const oldParent = makeIndi('@P_OLD@', {
      events: [{ tag: 'BIRT', date: '1850', place: '', notes: [], sources: [] }],
    });
    const modernParent = makeIndi('@P_MOD@', {
      events: [{ tag: 'BIRT', date: '1950', place: '', notes: [], sources: [] }],
    });
    const byMarr = makeIndi('@L2@', { fams: ['@F_MISSING@', '@F_MARR@'] });
    const bySpouse = makeIndi('@L3@', { fams: ['@F_SP@'] });
    const byParent = makeIndi('@L4@', { famc: ['@F_MISSING@', '@F_PAR@'] });
    const byEventYear = makeIndi('@L5@', {
      events: [{ tag: 'RESI', date: '1995', place: '', notes: [], sources: [] }],
    });
    const noDates = makeIndi('@L6@', { famc: ['@F_EMPTY_PAR@'] });

    const livIndis = new Map<string, GedcomIndi>([
      ['@L1@', resnPerson],
      ['@SP_MOD@', modernSpouse],
      ['@P_OLD@', oldParent],
      ['@P_MOD@', modernParent],
      ['@L2@', byMarr],
      ['@L3@', bySpouse],
      ['@L4@', byParent],
      ['@L5@', byEventYear],
      ['@L6@', noDates],
    ]);
    const livFams = new Map<string, GedcomFam>([
      [
        '@F_MARR@',
        makeFam('@F_MARR@', {
          husb: '@L2@',
          marr: { tag: 'MARR', date: '1980', place: '', notes: [], sources: [] },
        }),
      ],
      ['@F_SP@', makeFam('@F_SP@', { husb: '@L3@', wife: '@SP_MOD@' })],
      ['@F_PAR@', makeFam('@F_PAR@', { husb: '@P_OLD@', wife: '@P_MOD@' })],
      ['@F_EMPTY_PAR@', makeFam('@F_EMPTY_PAR@', { husb: '', wife: '' })],
    ]);

    expect(detectLivingStatus(resnPerson, livIndis, livFams, 2026, 110)).toBe(true);
    expect(detectLivingStatus(byMarr, livIndis, livFams, 2026, 110)).toBe(true);
    expect(detectLivingStatus(bySpouse, livIndis, livFams, 2026, 110)).toBe(true);
    expect(detectLivingStatus(byParent, livIndis, livFams, 2026, 110)).toBe(true);
    expect(detectLivingStatus(byEventYear, livIndis, livFams, 2026, 110)).toBe(true);
    expect(detectLivingStatus(noDates, livIndis, livFams, 2026, 110)).toBe(false);
  });

  it('covers resolveRootXref and selectGedcomLineage depth, surname, stop, and dangling edge branches', () => {
    const grandDad = makeIndi('@I1@', { fullName: 'Arthur Alder', surname: 'Alder', fams: ['@F1@'] });
    const grandMom = makeIndi('@I2@', { fullName: 'Beatrice Birch', surname: 'Birch', fams: ['@F1@'] });
    const root = makeIndi('@I3@', {
      fullName: 'Charles Alder',
      surname: 'Alder',
      altNames: ['Charlie Alder'],
      famc: ['@F_MISSING@', '@F1@', '@F1@'],
      fams: ['@F_MISSING_DESC@', '@F2@', '@F2@'],
    });
    const rootSibling = makeIndi('@I4@', { fullName: 'Dora Alder', surname: 'Alder', famc: ['@F1@'] });
    const spouse = makeIndi('@I5@', { fullName: 'Evelyn Mercer', surname: 'Mercer', fams: ['@F2@'] });
    const child = makeIndi('@I6@', {
      fullName: 'Frank Alder',
      surname: 'Alder',
      famc: ['@F2@'],
      fams: ['@F3@'],
    });
    const grandChild = makeIndi('@I7@', { fullName: 'Grace Alder', surname: 'Alder', famc: ['@F3@'] });

    const indis = new Map<string, GedcomIndi>([
      ['@I1@', grandDad],
      ['@I2@', grandMom],
      ['@I3@', root],
      ['@I4@', rootSibling],
      ['@I5@', spouse],
      ['@I6@', child],
      ['@I7@', grandChild],
    ]);
    const fams = new Map<string, GedcomFam>([
      ['@F1@', makeFam('@F1@', { husb: '@I1@', wife: '@I2@', children: ['@I3@', '@I4@', '@I_MISSING@'] })],
      ['@F2@', makeFam('@F2@', { husb: '@I3@', wife: '@I5@', children: ['@I6@', '@I3@'] })],
      ['@F3@', makeFam('@F3@', { husb: '@I6@', wife: '', children: ['@I7@'] })],
    ]);

    expect(resolveRootXref(indis, { rootName: 'Charlie Alder' })).toBe('@I3@');
    expect(() => resolveRootXref(indis, { rootName: 'Nobody Here' })).toThrow(/Root individual not found/);
    expect(() => resolveRootXref(indis, {})).toThrow(/Root individual not found/);

    const limited = selectGedcomLineage(indis, fams, {
      rootXref: '@I3@',
      ancestorSurnames: ['Alder'],
      maxAncestorDepth: 1,
      maxDescendantDepth: 1,
      includeAncestorSiblings: false,
      includeDescendantSpouses: false,
    });
    expect(limited.ancestors).toEqual(['@I3@', '@I1@', '@I2@']);
    expect(limited.ancestorSiblings).toEqual([]);
    expect(limited.descendants).toEqual(['@I3@', '@I6@']);
    expect(limited.descendantSpouses).toEqual([]);

    const stopped = selectGedcomLineage(indis, fams, {
      rootXref: '@I3@',
      expandSpouseAncestors: true,
      stopDescendantXrefs: ['@I6@'],
    });
    expect(stopped.descendants).toEqual(['@I3@', '@I6@']);
    expect(stopped.ancestorSiblings).toEqual(['@I4@']);
    expect(stopped.descendantSpouses).toEqual(['@I5@']);
  });
});

describe('gedcom sliceBuilders branch coverage', () => {
  it('covers missing xrefs, duplicate kinship/self-loops, multiple BIRT/DEAT alternates, RESI dedup, and family events', () => {
    const ind1 = makeIndi('@I1@', {
      fullName: 'Arthur Alder',
      givenName: 'Arthur',
      surname: 'Alder',
      sex: '',
      events: [
        {
          tag: 'BIRT',
          date: '',
          place: 'Harbor, Ohio',
          notes: [],
          sources: [{ sourXref: '@S_MISSING@', page: 'p. 1' }],
        },
        {
          tag: 'BIRT',
          date: '1851',
          place: 'Cedar, Ohio',
          notes: [],
          sources: [{ sourXref: '@S1@', page: '' }],
        },
        {
          tag: 'BIRT',
          date: '1852',
          place: 'Harbor, Ohio',
          notes: [],
          sources: [],
        },
        {
          tag: 'BIRT',
          date: '',
          place: 'Harbor, Ohio',
          notes: [],
          sources: [],
        },
        { tag: 'RESI', date: '1880', place: 'Harbor, Ohio', notes: [], sources: [] },
        { tag: 'RESI', date: '1880', place: 'Harbor, Ohio', notes: [], sources: [] },
        { tag: 'RESI', date: '1890', place: '', notes: [], sources: [] },
        { tag: 'RESI', date: '', place: 'Harbor, Ohio', notes: [], sources: [] },
        { tag: 'OCCU', date: '', place: '', notes: [], sources: [] },
        { tag: 'BURI', date: '1920', place: 'Harbor, Ohio', notes: [], sources: [] },
        { tag: 'CUSTOM_TAG', date: '1900', place: 'Unmapped Place', notes: [], sources: [] },
      ],
    });
    const ind2 = makeIndi('@I2@', {
      fullName: '',
      sex: 'F',
      events: [
        { tag: 'DEAT', date: '1925', place: '', notes: [], sources: [] },
        { tag: 'DEAT', date: '1926', place: '', notes: [], sources: [] },
      ],
    });

    const indis = new Map<string, GedcomIndi>([
      ['@I1@', ind1],
      ['@I2@', ind2],
    ]);
    const fams = new Map<string, GedcomFam>([
      [
        '@F1@',
        makeFam('@F1@', {
          husb: '@I1@',
          wife: '@I2@',
          children: ['@I_MISSING@', '@I1@'],
          sources: ['@S1@'],
          events: [
            { tag: 'EVEN', date: '1875', place: '', notes: [], sources: [] },
            { tag: 'MARR', date: '', place: '', notes: [], sources: [] },
            { tag: 'MARR', date: '1876', place: 'Harbor, Ohio', notes: [], sources: [] },
            {
              tag: 'DIV',
              date: '',
              place: 'Harbor, Ohio',
              notes: [],
              sources: [{ sourXref: '@S1@', page: 'docket 9' }],
            },
          ],
        }),
      ],
      ['@F2@', makeFam('@F2@', { husb: '@I1@', wife: '@I2@', children: [] })],
      ['@F_ORPHAN_SPOUSES@', makeFam('@F_ORPHAN_SPOUSES@', { husb: '@NO1@', wife: '@NO2@', events: [] })],
      [
        '@F_WIFE_ONLY@',
        makeFam('@F_WIFE_ONLY@', {
          husb: '',
          wife: '@I2@',
          children: ['@I1@'],
          events: [{ tag: 'MARR', date: '1880', place: '', notes: [], sources: [] }],
        }),
      ],
    ]);

    const selection: GedcomLineageSelection = {
      rootXref: '@I1@',
      ancestors: [],
      ancestorSiblings: [],
      descendants: ['@I1@', '@I2@'],
      descendantSpouses: [],
      orderedXrefs: ['@I1@', '@I2@', '@I_MISSING@'],
      allFamilyIds: ['@F1@', '@F2@', '@F_MISSING@', '@F_ORPHAN_SPOUSES@', '@F_WIFE_ONLY@'],
      bucketByXref: new Map([['@I1@', 'pivot_ancestor']]),
    };

    const rawPlaces = collectRawSlicePlaces(indis, fams, selection);
    expect(rawPlaces).toContain('Harbor, Ohio');

    const builtPlaces = buildPlacesFromRaw(rawPlaces);
    const builtPeople = buildSlicePeople({
      indis,
      fams,
      selection,
      normalizeMaidenNames: false,
      branchId: 'primary',
      referenceYear: 2026,
      livingCutoffYears: 110,
    });
    expect(builtPeople.people).toHaveLength(2);
    expect(builtPeople.people[0]?.sex).toBe('U');
    expect(builtPeople.people[1]?.lineage_group).toBe('extended');

    const kinship = buildSliceKinship(fams, selection.allFamilyIds, builtPeople.xrefToPid);
    // Self-loop @I1@ -> @I1@ skipped, duplicate spouse edges from @F2@ deduped, @F_WIFE_ONLY@ adds wife-parent/child
    expect(kinship.filter((e) => e.relation === 'spouse')).toHaveLength(2);
    expect(kinship.some((e) => e.from === builtPeople.xrefToPid.get('@I2@') && e.relation === 'parent')).toBe(
      true
    );

    const sours = new Map<string, GedcomSourMeta>([
      [
        '@S1@',
        {
          xref: '@S1@',
          title: '1880 Census Index',
          author: 'Clerk',
          publisher: 'Harbor Press',
          repoXref: '@R1@',
        },
      ],
    ]);
    const repos = new Map<string, string>([['@R1@', 'State Archive']]);

    const { events, sources, anomalies } = buildSliceEventsAndSources({
      indis,
      fams,
      sours,
      repos,
      selection,
      xrefToPid: builtPeople.xrefToPid,
      normalizedNamesByXref: builtPeople.normalizedNamesByXref,
      placesById: builtPlaces.placesById,
      rawToPlaceId: builtPlaces.rawToPlaceId,
    });

    expect(anomalies).toHaveLength(2);
    const birt = events.find((e) => e.title.startsWith('Birth of Arthur'));
    expect(birt?.id).toContain('undated');
    expect(birt?.alternate_dates).toHaveLength(2);
    expect(birt?.summary).toContain('2 alternate record entries preserved.');

    const deat = events.find((e) => e.title.startsWith('Death of'));
    expect(deat?.summary).toContain('1 alternate record entry preserved.');

    const resiEvents = events.filter((e) => e.category === 'homestead');
    // 4 RESI inputs minus 1 duplicate = 3
    expect(resiEvents).toHaveLength(3);
    expect(resiEvents.some((e) => e.title === 'Residence of Arthur Alder')).toBe(true);
    expect(events.some((e) => e.title === 'Burial of Arthur Alder')).toBe(true);
    expect(events.some((e) => e.title === 'Recorded event for Arthur Alder')).toBe(true);
    expect(events.some((e) => e.title.startsWith('Divorce of'))).toBe(true);
    expect(events.some((e) => e.title.includes('Spouse'))).toBe(true);
    expect(sources.some((s) => s.id === 'src_ged_smissing' && s.source_type === 'compiled_record')).toBe(
      true
    );
    expect(sources.some((s) => s.id === 'src_ged_s1' && s.source_type === 'archival_index')).toBe(true);
  });
});

describe('gedcom export branch coverage', () => {
  it('covers living filtering, confidential flag, family/spouse sex variants, event fallbacks, and sources', () => {
    const place: Place = {
      id: 'plc_harbor',
      slug: 'harbor',
      name: 'Harbor',
      full_name: 'Harbor, Cedar, Ohio',
      place_type: 'town',
      parent_id: null,
      lat: 40,
      lng: -82,
    };
    const livingRedacted = makePerson({
      id: 'per_living_redacted',
      slug: 'living-redacted',
      full_name: 'Living',
      is_living: true,
      birth_year: 1990,
      sex: 'Z',
    });
    const livingNamed = makePerson({
      id: 'per_living_named',
      slug: 'living-named',
      full_name: 'Riley Alder',
      given_name: 'Riley',
      surname: 'Alder',
      alt_names: ['  ', 'R. Alder'],
      is_living: true,
      birth_edtf: '1988-03-14',
      birth_year: 1988,
      sex: 'X',
    });
    const livingNoBirthYear = makePerson({
      id: 'per_living_noyr',
      slug: 'living-noyr',
      full_name: 'Morgan Alder',
      given_name: 'Morgan',
      surname: 'Alder',
      is_living: true,
      birth_edtf: '199X',
      birth_year: null,
      sex: 'U',
    });
    const maleA = makePerson({
      id: 'per_male_a',
      slug: 'male-a',
      full_name: 'Arthur Alder',
      given_name: 'Arthur',
      surname: 'Alder',
      birth_edtf: 'invalid',
      birth_year: 1850,
      death_edtf: 'invalid',
      death_year: 1920,
      sex: 'M',
    });
    const maleB = makePerson({
      id: 'per_male_b',
      slug: 'male-b',
      full_name: 'Bernard Birch',
      given_name: '',
      surname: '',
      birth_edtf: 'invalid',
      birth_year: null,
      death_edtf: 'invalid',
      death_year: null,
      sex: 'M',
    });
    const femaleA = makePerson({
      id: 'per_female_a',
      slug: 'female-a',
      full_name: 'Clara Cedar',
      given_name: 'Clara',
      surname: 'Cedar',
      sex: 'F',
    });
    const femaleB = makePerson({
      id: 'per_female_b',
      slug: 'female-b',
      full_name: 'Dora Dale',
      given_name: 'Dora',
      surname: 'Dale',
      sex: 'F',
    });
    const child = makePerson({
      id: 'per_child',
      slug: 'child',
      full_name: 'Eli Alder',
      given_name: 'Eli',
      surname: 'Alder',
      sex: 'M',
    });

    const sources: SourceRecord[] = [
      {
        id: 'src_full',
        citation: 'Harbor Register',
        author: 'Town Clerk',
        publisher: 'Harbor Press',
        source_type: 'archival_index',
        repository: 'County Archive',
      },
      {
        id: 'src_minimal',
        citation: '',
        source_type: 'compiled_record',
      },
    ];

    const events: ArchiveEvent[] = [
      makeEvent({
        id: 'ev_world',
        title: 'Global Event',
        scope: 'global',
        participants: [{ person_id: 'per_male_a', role: 'witness' }],
      }),
      makeEvent({
        id: 'ev_marr_newfam',
        title: 'Marriage of Clara and Dora',
        scope: 'family',
        edtf_date: '',
        year: 1895,
        place_id: 'plc_harbor',
        participants: [
          { person_id: 'per_female_a', role: 'spouse' },
          { person_id: 'per_female_b', role: 'spouse' },
          { person_id: 'per_outside', role: 'witness' },
        ],
        sources: [
          { source_id: UNVERIFIED_TREE_SOURCE_ID, confidence: 'low' },
          { source_id: 'src_missing', confidence: 'low' },
          { source_id: 'src_full', confidence: 'high', citation_detail: 'Vol 1 p 2' },
          { source_id: 'src_full', confidence: 'high' },
        ],
      }),
      makeEvent({
        id: 'ev_div',
        title: 'Divorce of Arthur and Bernard',
        scope: 'family',
        edtf_date: '',
        year: null,
        participants: [
          { person_id: 'per_male_a', role: 'spouse' },
          { person_id: 'per_male_b', role: 'spouse' },
        ],
        sources: [{ source_id: 'src_minimal', confidence: 'medium' }],
      }),
      makeEvent({
        id: 'ev_marr_one',
        title: 'Marriage with one included spouse',
        scope: 'family',
        participants: [{ person_id: 'per_male_a', role: 'spouse' }],
      }),
      makeEvent({
        id: 'ev_birt_child',
        title: 'Birth of Eli Alder',
        scope: 'personal',
        edtf_date: '',
        year: 1882,
        time_min: null,
        place_id: 'plc_harbor',
        summary: 'Birth summary suppressed for BIRT',
        participants: [{ person_id: 'per_child', role: 'birth_subject' }],
        sources: [
          { source_id: 'src_missing', confidence: 'low' },
          { source_id: 'src_full', confidence: 'high', citation_detail: 'Cert 4' },
        ],
      }),
      makeEvent({
        id: 'ev_deat_child',
        title: 'Death of Eli Alder',
        scope: 'personal',
        edtf_date: '1950',
        year: 1950,
        time_min: 19500101,
        participants: [{ person_id: 'per_child', role: 'death_subject' }],
      }),
      makeEvent({
        id: 'ev_living_note',
        title: 'Residence of Riley Alder',
        scope: 'personal',
        edtf_date: '',
        year: null,
        place_id: 'plc_harbor',
        summary: 'Must not emit for living person',
        participants: [{ person_id: 'per_living_named', role: 'resident' }],
      }),
      makeEvent({
        id: 'ev_mil',
        title: 'Military Draft Record',
        scope: 'personal',
        edtf_date: '1917',
        year: 1917,
        time_min: 19170605,
        place_id: 'plc_harbor',
        summary: 'Draft card at Harbor',
        participants: [{ person_id: 'per_child', role: 'subject' }],
      }),
    ];

    const bundle = makeBundle({
      people: [livingRedacted, livingNamed, livingNoBirthYear, maleA, maleB, femaleA, femaleB, child],
      places: [place],
      sources,
      events,
      kinship: [
        { from: 'per_outside', to: 'per_male_a', relation: 'spouse' },
        { from: 'per_male_a', to: 'per_male_b', relation: 'spouse' },
        { from: 'per_male_a', to: 'per_child', relation: 'parent' },
        { from: 'per_child', to: 'per_male_b', relation: 'child' },
      ],
    });

    const placesById = new Map(bundle.places.map((p) => [p.id, p]));
    const sourcesById = new Map(bundle.sources.map((s) => [s.id, s]));

    // Call buildFilteredGedcom7 with omitted siteConfig and duplicate person entry
    const defaultOut = buildFilteredGedcom7({
      people: [
        livingRedacted,
        livingNamed,
        livingNamed,
        livingNoBirthYear,
        maleA,
        maleB,
        femaleA,
        femaleB,
        child,
      ],
      bundle,
      placesById,
      sourcesById,
      exportDate: new Date('2026-02-03T00:00:00Z'),
    });

    expect(defaultOut).toContain('1 SOUR KINLOOM_ARCHIVE');
    expect(defaultOut).toContain('2 NAME Kinloom Family Archive');
    expect(defaultOut).not.toContain('1 NAME Living');
    expect(defaultOut).toContain('1 RESN CONFIDENTIAL');
    expect(defaultOut).toContain('1 NAME R. Alder');
    expect(defaultOut).toContain('1 SEX X');
    expect(defaultOut).toContain('1 DIV');
    expect(defaultOut).toContain('1 MARR');
    expect(defaultOut).toContain('2 TYPE Military / Service');
    expect(defaultOut).toContain('2 NOTE Draft card at Harbor');
    expect(defaultOut).not.toContain('Must not emit for living person');
    expect(defaultOut).toContain('1 TITL src_minimal');
    expect(defaultOut).toContain('1 AUTH Town Clerk');
    expect(defaultOut).toContain('1 PUBL Harbor Press');
    expect(defaultOut).toContain('1 NOTE Repository: County Archive');

    // Call exportGedcom7 with private build mode and confidential flag disabled
    const privateBundle = makeBundle({
      ...bundle,
      meta: { ...bundle.meta, build_mode: 'private' },
    });
    const config = parseKinloomConfig({
      site: { title: 'Alder Archive', familyName: 'Alder', gedcomSourceName: 'ALDER_ARCHIVE' },
      privacy: { markGedcomLivingConfidential: false },
    });
    const privateOut = exportGedcom7(privateBundle, config, {
      filterDescription: 'Private complete export',
      exportDate: new Date('2026-02-03T00:00:00Z'),
    });
    expect(privateOut).toContain('1 SOUR ALDER_ARCHIVE');
    expect(privateOut).toContain('1 NAME Living');
    expect(privateOut).not.toContain('1 RESN CONFIDENTIAL');
    expect(privateOut).toContain('Filtered export (8 relatives): Private complete export');
  });
});
