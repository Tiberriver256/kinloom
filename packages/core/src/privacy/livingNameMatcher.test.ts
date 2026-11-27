import { describe, expect, it } from 'vitest';
import {
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  extractEarliestEdtfYear,
  extractLatestEdtfYear,
} from '../privacy.js';

describe('Unicode year-aware living-name matcher', () => {
  it('matches Swedish and Finnish living names with diacritics (Å, Ä, Ö) and enforces Unicode word boundaries', () => {
    const matcher = compileLivingNameMatcher(
      [
        {
          full_name: 'Åsa Linnea Öström',
          given_name: 'Åsa Linnea',
          surname: 'Öström',
          birth_edtf: '1988-05-14',
        },
        {
          full_name: 'Väinö Eelis Äyräpää',
          given_name: 'Väinö Eelis',
          surname: 'Äyräpää',
          alt_names: ['Väinö Mäkinen'],
          birth_edtf: '1992',
        },
      ],
      [],
      { referenceYear: 2026 }
    );

    const hits = collectLivingNameHitsWithMatcher(matcher, [
      {
        location: 'narrative:bio:body',
        text: 'Recorded with Åsa Öström and väinö äyräpää in 2010; also mentions Väinö Mäkinen.',
        maxYear: 2010,
      },
      {
        location: 'narrative:boundary:safe',
        text: 'Historical text mentioning Båsa Öströmsson and Ovainö Äyräpäänen should not match.',
        maxYear: 2010,
      },
    ]);

    expect(hits).toEqual([
      { location: 'narrative:bio:body', match: 'Väinö Mäkinen' },
      { location: 'narrative:bio:body', match: 'Åsa Öström' },
      { location: 'narrative:bio:body', match: 'väinö äyräpää' },
    ]);
  });

  it('uses edtfToBounds for intervals, decades, and approximate dates while respecting minYear', () => {
    expect(extractEarliestEdtfYear('198X')).toBe(1980);
    expect(extractLatestEdtfYear('198X')).toBe(1989);
    expect(extractEarliestEdtfYear('1895/1902')).toBe(1895);
    expect(extractLatestEdtfYear('1895/1902')).toBe(1902);

    const matcher = compileLivingNameMatcher(
      [
        {
          full_name: 'Östen Henrik Åkerman',
          given_name: 'Östen Henrik',
          surname: 'Åkerman',
          birth_edtf: '198X',
        },
      ],
      [],
      { referenceYear: 2026 }
    );

    const historicalHits = collectLivingNameHitsWithMatcher(matcher, [
      {
        location: 'event:1890:summary',
        text: 'Parish register lists Östen Åkerman as a witness.',
        maxYear: 1890,
      },
    ]);
    expect(historicalHits).toEqual([]);

    const modernHits = collectLivingNameHitsWithMatcher(matcher, [
      {
        location: 'event:2004:summary',
        text: 'Reunion photo taken by Östen Åkerman.',
        maxYear: 2004,
      },
    ]);
    expect(modernHits).toEqual([{ location: 'event:2004:summary', match: 'Östen Åkerman' }]);
  });
});
