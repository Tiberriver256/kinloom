import { describe, expect, it } from 'vitest';
import {
  collectLivingNameHitsWithMatcher,
  compileLivingNameMatcher,
  extractEarliestEdtfYear,
  extractLatestEdtfYear,
  mayMatchLivingNameMatcher,
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

  it('suppresses derived first-plus-surname homonym collisions with deceased relatives while catching exact living full and alt names', () => {
    const emptyMatcher = compileLivingNameMatcher([], [], { referenceYear: 2026 });
    expect(mayMatchLivingNameMatcher(emptyMatcher, 'Arthur Alder in Riverdale')).toBe(false);

    const matcher = compileLivingNameMatcher(
      [
        {
          full_name: 'Arthur James Alder',
          given_name: 'Arthur James',
          surname: 'Alder',
          alt_names: ['Artie Bramwell'],
          birth_edtf: '1990',
        },
      ],
      [
        {
          full_name: 'Arthur Henry Alder',
          given_name: 'Arthur Henry',
          surname: 'Alder',
          alt_names: ['Thomas Mercer'],
        },
      ],
      { referenceYear: 2026 }
    );

    expect(mayMatchLivingNameMatcher(matcher, '')).toBe(false);
    expect(mayMatchLivingNameMatcher(matcher, 'Completely unrelated town chronicle of 1885.')).toBe(false);
    expect(mayMatchLivingNameMatcher(matcher, 'Attended with Arthur James Alder and Artie Bramwell.')).toBe(
      true
    );

    const hits = collectLivingNameHitsWithMatcher(matcher, [
      {
        location: 'narrative:homonym:body',
        text: 'Deceased grandfather Arthur Alder is suppressed, whereas living Arthur James Alder and Artie Bramwell are flagged.',
        maxYear: 2015,
      },
    ]);
    expect(hits).toEqual([
      { location: 'narrative:homonym:body', match: 'Arthur James Alder' },
      { location: 'narrative:homonym:body', match: 'Artie Bramwell' },
    ]);
  });

  it('enforces the 50-hit cap across exact and derived patterns and ignores empty or non-matching targets', async () => {
    const { collectLivingNameHits, compileLivingNamePattern } = await import('../privacy.js');
    expect(collectLivingNameHits(null, [{ location: 'x', text: 'Devon Alder' }])).toEqual([]);

    const pattern = compileLivingNamePattern(['Devon Alder']);
    const repeatedExact = Array.from({ length: 55 }, () => 'Devon Alder').join(', ');
    const exactCapHits = collectLivingNameHits(pattern, [
      { location: 'empty', text: '' },
      { location: 'miss', text: 'Arthur Mercer in 1880' },
      { location: 'capped', text: repeatedExact },
    ]);
    expect(exactCapHits).toHaveLength(50);

    const emptyMatcher = compileLivingNameMatcher([], [], { referenceYear: 2026 });
    expect(collectLivingNameHitsWithMatcher(emptyMatcher, [{ location: 'x', text: 'Devon Alder' }])).toEqual(
      []
    );

    const matcher = compileLivingNameMatcher(
      [
        {
          full_name: 'Devon Caleb Alder',
          given_name: 'Devon Caleb',
          surname: 'Alder',
          birth_edtf: '1990',
        },
      ],
      [],
      { referenceYear: 2026 }
    );

    const exactMatcherCap = collectLivingNameHitsWithMatcher(matcher, [
      { location: 'empty', text: '' },
      { location: 'miss', text: 'Clara Mercer in 1890' },
      {
        location: 'exact55',
        text: Array.from({ length: 55 }, () => 'Devon Caleb Alder').join('; '),
        maxYear: 2020,
      },
    ]);
    expect(exactMatcherCap).toHaveLength(50);

    const derivedMatcherCap = collectLivingNameHitsWithMatcher(matcher, [
      {
        location: 'derived55',
        text: Array.from({ length: 55 }, () => 'Devon Alder').join('; '),
        maxYear: 2020,
      },
    ]);
    expect(derivedMatcherCap).toHaveLength(50);
  });
});
