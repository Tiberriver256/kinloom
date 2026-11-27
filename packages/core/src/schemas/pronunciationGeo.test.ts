import { describe, expect, it } from 'vitest';
import {
  getPlaceQualifierSegments,
  inferCountryCodeFromSegments,
  isBareLexiconEntryCompatibleWithPlace,
  splitPlaceSegments,
} from './pronunciationGeo.js';

describe('pronunciationGeo seam', () => {
  it('splits comma-delimited place names and strips redundant leading place name qualifiers', () => {
    expect(splitPlaceSegments('Zeeland, Ottawa County, Michigan, United States')).toEqual([
      'Zeeland',
      'Ottawa County',
      'Michigan',
      'United States',
    ]);
    expect(
      getPlaceQualifierSegments({
        name: 'Zeeland',
        full_name: 'Zeeland, Ottawa County, Michigan, United States',
      })
    ).toEqual(['Ottawa County', 'Michigan', 'United States']);
  });

  it('infers country codes from US states, European provinces, and explicit country segments', () => {
    expect(inferCountryCodeFromSegments(['Ottawa County', 'Michigan'])).toBe('US');
    expect(inferCountryCodeFromSegments(['Zeeland', 'Gelderland', 'Netherlands'])).toBe('NL');
    expect(inferCountryCodeFromSegments(['Värmland'])).toBe('SE');
    expect(inferCountryCodeFromSegments(['Unknown Valley'])).toBeNull();
  });

  it('rejects bare lexicon entries whose language, region, or full-name filter conflicts with the place', () => {
    const dutchEntry = {
      phonetic: 'ZAY-lahnt',
      language: 'nl',
      region: 'Netherlands',
    };
    const michiganPlace = {
      name: 'Zeeland',
      full_name: 'Zeeland, Ottawa County, Michigan, United States',
    };
    const dutchPlace = {
      name: 'Zeeland',
      full_name: 'Zeeland, North Brabant, Netherlands',
    };

    expect(isBareLexiconEntryCompatibleWithPlace(dutchEntry, michiganPlace)).toBe(false);
    expect(isBareLexiconEntryCompatibleWithPlace(dutchEntry, dutchPlace)).toBe(true);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { phonetic: 'ZEE-land', match_full_name_contains: 'Michigan' },
        michiganPlace
      )
    ).toBe(true);
    expect(
      isBareLexiconEntryCompatibleWithPlace(
        { phonetic: 'ZEE-land', match_full_name_contains: 'Michigan' },
        dutchPlace
      )
    ).toBe(false);
  });
});
