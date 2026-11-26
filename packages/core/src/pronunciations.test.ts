import { describe, expect, it } from 'vitest';
import { compileArchive } from './compileArchive.js';
import { parseKinloomConfig } from './schemas/config.js';
import {
  PronunciationSchema,
  mergePronunciationLexicons,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
  type Place,
  type Pronunciation,
  type RawPerson,
} from './schemas/entities.js';

function makeBaseConfig(pronunciations?: Record<string, Pronunciation>) {
  return parseKinloomConfig({
    site: {
      title: 'Mercer Synthetic Archive',
      familyName: 'Mercer Family',
      gedcomSourceName: 'MERCER_TEST',
    },
    ...(pronunciations ? { pronunciations } : {}),
  });
}

function makeDeceasedPerson(overrides: Partial<RawPerson> = {}): RawPerson {
  return {
    id: 'per_thomas',
    slug: 'thomas-mercer',
    full_name: 'Thomas Mercer',
    given_name: 'Thomas',
    surname: 'Mercer',
    alt_names: [],
    sex: 'M',
    is_living: false,
    lineage_group: 'pivot_ancestor',
    birth_edtf: '1842-05-10',
    death_edtf: '1911-08-19',
    portrait_url: null,
    ...overrides,
  };
}

function makePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: 'plc_zeeland_mi',
    slug: 'zeeland-michigan',
    name: 'Zeeland',
    full_name: 'Zeeland, Ottawa County, Michigan, United States',
    place_type: 'town',
    parent_id: null,
    lat: 42.8125,
    lng: -86.0187,
    ...overrides,
  };
}

describe('PronunciationSchema provenance and multi-variant support', () => {
  it('validates source_url, source_label, region, match_full_name_contains, and variants while staying backward-compatible', () => {
    const minimal = PronunciationSchema.parse({ phonetic: 'MER-ser' });
    expect(minimal).toEqual({ phonetic: 'MER-ser' });

    const rich = PronunciationSchema.parse({
      phonetic: 'ZAY-lahnt',
      ipa: '/ˈzeː.lɑnt/',
      language: 'nl',
      region: 'Netherlands',
      source_label: 'Wiktionary (Dutch IPA)',
      source_url: 'https://en.wiktionary.org/wiki/Zeeland',
      match_full_name_contains: ['Netherlands', 'Nederland'],
      variants: [
        {
          label: 'West Michigan (English)',
          phonetic: 'ZEE-lund',
          ipa: '/ˈziː.lənd/',
          language: 'en-US',
          region: 'West Michigan',
          source_label: 'Family oral tradition',
          note: 'Local pronunciation in Ottawa County',
        },
      ],
    });
    expect(rich.source_label).toBe('Wiktionary (Dutch IPA)');
    expect(rich.region).toBe('Netherlands');
    expect(rich.variants).toHaveLength(1);
    expect(rich.variants?.[0]?.label).toBe('West Michigan (English)');
  });
});

describe('compileArchive live-lexicon cache isolation (regression)', () => {
  it('keeps shared siteConfig.pronunciations in bundle.pronunciations without pre-baking onto person/place records', () => {
    const config = makeBaseConfig({
      Mercer: {
        phonetic: 'MER-ser-OLD',
        ipa: '/ˈmɜːr.sər.old/',
        language: 'en-US',
      },
      'Zeeland, Netherlands': {
        phonetic: 'ZAY-lahnt',
        ipa: '/ˈzeː.lɑnt/',
        language: 'nl',
        region: 'Netherlands',
      },
    });

    const thomas = makeDeceasedPerson();
    const explicitPerson = makeDeceasedPerson({
      id: 'per_elena',
      slug: 'elena-mercer',
      full_name: 'Elena Mercer',
      given_name: 'Elena',
      pronunciation: { phonetic: 'eh-LAY-nuh MER-ser', language: 'en-US' },
    });
    const living = makeDeceasedPerson({
      id: 'per_living',
      slug: 'clara-mercer',
      full_name: 'Clara Mercer',
      given_name: 'Clara',
      is_living: true,
      birth_edtf: '1992-03-04',
      death_edtf: '',
      pronunciation: { phonetic: 'SHOULD-BE-REDACTED' },
    });
    const zeelandNl = makePlace({
      id: 'plc_zeeland_nl',
      slug: 'zeeland-netherlands',
      name: 'Zeeland',
      full_name: 'Zeeland, Netherlands',
      lat: 51.494,
      lng: 3.849,
    });

    const { bundle } = compileArchive({
      siteConfig: config,
      mode: 'private',
      people: [thomas, explicitPerson, living],
      places: [zeelandNl],
      events: [],
      sources: [],
      kinship: [],
    });

    const compiledThomas = bundle.people.find((p) => p.id === 'per_thomas')!;
    const compiledElena = bundle.people.find((p) => p.id === 'per_elena')!;
    const compiledLiving = bundle.people.find((p) => p.id === 'per_living')!;
    const compiledZeeland = bundle.places.find((p) => p.id === 'plc_zeeland_nl')!;

    expect(compiledThomas.pronunciation).toBeUndefined();
    expect(compiledZeeland.pronunciation).toBeUndefined();
    expect(compiledElena.pronunciation).toEqual({
      phonetic: 'eh-LAY-nuh MER-ser',
      language: 'en-US',
    });
    expect(compiledLiving.pronunciation).toBeUndefined();
    expect(bundle.pronunciations?.Mercer?.phonetic).toBe('MER-ser-OLD');

    // Simulating a live D1 lexicon update must replace phonetic/ipa/language cleanly without stale shadowing
    const liveLexicon = mergePronunciationLexicons(bundle.pronunciations, {
      Mercer: {
        phonetic: 'MUR-ser-NEW',
        ipa: '/ˈmɜːr.sər.new/',
        language: 'en-GB',
        note: 'Updated in live lexicon',
      },
    });
    const resolved = resolvePersonPronunciation(compiledThomas, liveLexicon);
    expect(resolved).toEqual({
      phonetic: 'MUR-ser-NEW',
      ipa: '/ˈmɜːr.sər.new/',
      language: 'en-GB',
      note: 'Updated in live lexicon',
    });
  });

  it('does not inherit a mismatched shared surname audio_url when a person overrides phonetic/ipa', () => {
    const person = makeDeceasedPerson({
      pronunciation: {
        phonetic: 'TOM-us MER-ser',
        language: 'en-US',
      },
    });
    const resolved = resolvePersonPronunciation(person, {
      Mercer: {
        phonetic: 'MER-ser',
        audio_url: '/media/pronunciation-surname-only.wav',
      },
    });
    expect(resolved?.phonetic).toBe('TOM-us MER-ser');
    expect(resolved?.audio_url).toBeUndefined();
  });
});

describe('resolvePlacePronunciation homonymous place disambiguation', () => {
  const zeelandMi = makePlace({
    id: 'plc_zeeland_mi',
    slug: 'zeeland-michigan',
    name: 'Zeeland',
    full_name: 'Zeeland, Ottawa County, Michigan, United States',
    lat: 42.8125,
    lng: -86.0187,
  });
  const zeelandNl = makePlace({
    id: 'plc_zeeland_nl',
    slug: 'zeeland-netherlands',
    name: 'Zeeland',
    full_name: 'Zeeland, Netherlands',
    lat: 51.494,
    lng: 3.849,
  });
  const hollandMi = makePlace({
    id: 'plc_holland_mi',
    slug: 'holland-michigan',
    name: 'Holland',
    full_name: 'Holland, Ottawa County, Michigan, United States',
    lat: 42.7875,
    lng: -86.1089,
  });
  const hinghamMa = makePlace({
    id: 'plc_hingham_ma',
    slug: 'hingham-massachusetts',
    name: 'Hingham',
    full_name: 'Hingham, Plymouth County, Massachusetts, United States',
    lat: 42.2418,
    lng: -70.8898,
  });
  const hinghamUk = makePlace({
    id: 'plc_hingham_uk',
    slug: 'hingham-england',
    name: 'Hingham',
    full_name: 'Hingham, Norfolk, England',
    lat: 52.58,
    lng: 0.983,
  });

  it('prevents a Dutch/Netherlands bare "Zeeland" or "Holland" entry from applying to Michigan', () => {
    const lexicon: Record<string, Pronunciation> = {
      Zeeland: {
        phonetic: 'ZAY-lahnt',
        ipa: '/ˈzeː.lɑnt/',
        language: 'nl',
        region: 'Netherlands',
      },
      Holland: {
        phonetic: 'HOHL-ahnt',
        ipa: '/ˈɦɔl.ɑnt/',
        language: 'nl',
      },
    };

    expect(resolvePlacePronunciation(zeelandNl, lexicon)?.phonetic).toBe('ZAY-lahnt');
    expect(resolvePlacePronunciation(zeelandMi, lexicon)).toBeNull();
    expect(resolvePlacePronunciation(hollandMi, lexicon)).toBeNull();
  });

  it('enforces strict specificity order: place.pronunciation > lexicon[place.id] > lexicon[full_name] > qualified name > compatible bare name', () => {
    const lexicon: Record<string, Pronunciation> = {
      Zeeland: {
        phonetic: 'ZAY-lahnt',
        language: 'nl',
        region: 'Netherlands',
      },
      'Zeeland, Michigan': {
        phonetic: 'ZEE-lund',
        language: 'en-US',
        region: 'Michigan',
      },
      plc_zeeland_nl: {
        phonetic: 'ZAY-lahnt (ID)',
        language: 'nl',
      },
      'Hingham, England': {
        phonetic: 'HING-um (UK)',
        language: 'en-GB',
        region: 'England',
      },
      'Hingham, Plymouth County, Massachusetts, United States': {
        phonetic: 'HING-um (MA)',
        language: 'en-US',
      },
    };

    // 1. Explicit place.pronunciation overrides everything
    expect(
      resolvePlacePronunciation(
        { ...zeelandNl, pronunciation: { phonetic: 'EXPLICIT-OVERRIDE', language: 'nl' } },
        lexicon,
      )?.phonetic,
    ).toBe('EXPLICIT-OVERRIDE');

    // 2. lexicon[place.id] beats full_name and bare name
    expect(resolvePlacePronunciation(zeelandNl, lexicon)?.phonetic).toBe('ZAY-lahnt (ID)');

    // 3. Qualified lexicon key "Zeeland, Michigan" matches "Zeeland, Ottawa County, Michigan, United States"
    expect(resolvePlacePronunciation(zeelandMi, lexicon)?.phonetic).toBe('ZEE-lund');

    // 4. Exact full_name and qualified regional keys disambiguate Hingham, MA vs Hingham, England
    expect(resolvePlacePronunciation(hinghamMa, lexicon)?.phonetic).toBe('HING-um (MA)');
    expect(resolvePlacePronunciation(hinghamUk, lexicon)?.phonetic).toBe('HING-um (UK)');
  });

  it('enforces match_full_name_contains on bare lexicon keys', () => {
    const lexicon: Record<string, Pronunciation> = {
      Springfield: {
        phonetic: 'SPRING-feeld (IL)',
        match_full_name_contains: 'Illinois',
      },
    };
    const ilPlace = makePlace({
      id: 'plc_sp_il',
      name: 'Springfield',
      full_name: 'Springfield, Sangamon County, Illinois',
    });
    const maPlace = makePlace({
      id: 'plc_sp_ma',
      name: 'Springfield',
      full_name: 'Springfield, Hampden County, Massachusetts',
    });

    expect(resolvePlacePronunciation(ilPlace, lexicon)?.phonetic).toBe('SPRING-feeld (IL)');
    expect(resolvePlacePronunciation(maPlace, lexicon)).toBeNull();
  });
});

describe('mergePronunciationLexicons', () => {
  it('replaces case-variant keys cleanly without leaving shadowed duplicates', () => {
    const merged = mergePronunciationLexicons(
      { mercer: { phonetic: 'MER-ser-OLD' }, alder: { phonetic: 'AWL-der' } },
      { Mercer: { phonetic: 'MUR-ser-NEW', note: 'Updated' } },
    );
    expect(merged).toEqual({
      alder: { phonetic: 'AWL-der' },
      Mercer: { phonetic: 'MUR-ser-NEW', note: 'Updated' },
    });
    expect(merged.mercer).toBeUndefined();
  });
});
