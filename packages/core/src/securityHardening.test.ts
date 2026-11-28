import { describe, expect, it } from 'vitest';
import { isPreviewableCitationImage } from './citations.js';
import { formatPublicCitation, formatPublicRepository } from './domain/publicDisplay.js';
import { buildSourceTextFilename } from './domain/sourceExport.js';
import { parseGedcomDateToEdtf } from './edtf.js';
import {
  cleanEventSummaryProse,
  cleanSourceCitationTitle,
  inferSourceRepository,
  redactSensitiveCitationDetail,
} from './gedcom/citations.js';
import { buildGedcomExportFilename, formatEdtfToGedcomDate } from './gedcom/exportFormat.js';
import { parseGedcomText } from './gedcom/parse.js';
import { tokenizePersonName } from './schemas/pronunciationPhonetics.js';

describe('linear-time parsing and sanitization hardening (#82)', () => {
  it('handles 20,000-character adversarial inputs in linear time across core helpers', () => {
    const start = performance.now();

    const longSpaces = ' '.repeat(20_000);
    const longDashes = '-'.repeat(20_000);
    const longPercents = '%'.repeat(20_000);
    const longParens = '('.repeat(20_000);
    const longSources = '(sources/'.repeat(2_500);
    const longExt = `.mp4?${'.m4a?'.repeat(4_000)}`;

    expect(parseGedcomDateToEdtf(`BET ${longSpaces}1850 AND ${longSpaces}1860`)).toBe('1850/1860');
    expect(parseGedcomDateToEdtf(`FROM ${longSpaces}1850 TO ${longSpaces}1860`)).toBe('1850/1860');
    expect(parseGedcomDateToEdtf(`CA ${longSpaces}1850`)).toBe('1850~');
    expect(parseGedcomDateToEdtf(`BEF ${longSpaces}1850`)).toBe('/1850');
    expect(parseGedcomDateToEdtf(`AFT ${longSpaces}1850`)).toBe('1850/');

    expect(formatPublicRepository(`${longSpaces}${longSources}`)).toBe(longSources);
    expect(formatPublicCitation(`Census${longSpaces}${longSources}`)).toBe(`Census ${longSources}`);

    expect(
      buildSourceTextFilename({
        source_id: 'src_1',
        title: `${longDashes}Oakville${longDashes}`,
        author: 'Archivist',
        provenance: 'Family Archive',
        pages: [],
      })
    ).toBe('oakville.txt');

    expect(formatEdtfToGedcomDate(`1850${longPercents}`)).toBe('ABT 1850');
    expect(formatEdtfToGedcomDate(`1850${longPercents}/1860${longPercents}`)).toBe('BET 1850 AND 1860');
    expect(
      buildGedcomExportFilename({
        familySlug: `${longDashes}oakville${longDashes}`,
        lineageFilter: 'all',
        selectedEra: 'all',
        onlyWithMedia: false,
        query: `${longDashes}alder${longDashes}`,
        sortBy: 'featured',
        count: 3,
      })
    ).toBe('oakville-alder-3-relatives.ged');

    expect(
      isPreviewableCitationImage({
        id: 'med_1',
        kind: 'document_scan',
        person_ids: [],
        caption: 'Clip',
        file: longExt,
      })
    ).toBe(false);

    expect(tokenizePersonName({ full_name: `${longParens}Alder` })).toEqual(['Alder']);
    expect(redactSensitiveCitationDetail(`${'\t'.repeat(20_000)}Page 4${'\t'.repeat(20_000)}`)).toBe(
      'Page 4'
    );
    expect(cleanSourceCitationTitle(`Census${longSpaces}(Ancestry GEDCOM @S12@)${longSpaces}`)).toBe(
      'Census'
    );
    expect(cleanEventSummaryProse(`Born in 1850${longSpaces}.`)).toBe('Born in 1850.');

    const parsed = parseGedcomText(`0 @I1@ INDI\n1 NAME John /Alder/\n0 0 ${'  '.repeat(10_000)}X\n0 TRLR`);
    expect(parsed.indis.size).toBe(1);

    expect(performance.now() - start).toBeLessThan(500);
  });

  it('matches Newspapers.com by exact host token rather than arbitrary substring', () => {
    expect(inferSourceRepository('U.S., Newspapers.com Marriage Index')).toBe(
      'Newspapers.com Historical Archive'
    );
    expect(inferSourceRepository('evilnewspapers.com mirror')).toBe(
      'Archival Record Collection (imported via Ancestry tree)'
    );
  });
});
