import { describe, expect, it } from 'vitest';
import { compileArchive } from './compileArchive.js';
import { parseKinloomConfig } from './schemas/config.js';
import {
  findIpaGlyphsInPhonetic,
  hasIpaGlyphsInPhonetic,
  inspectPersonPronunciationTokens,
  mergePronunciationLexicons,
  type Place,
  type Pronunciation,
  PronunciationSchema,
  type RawPerson,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
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
      coverage: 'surname',
      matchedPart: 'Mercer',
      resolvedFrom: 'lexicon_surname',
      missingParts: ['Thomas'],
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
    expect(resolved?.coverage).toBe('full');
    expect(resolved?.resolvedFrom).toBe('person');
  });
});

describe('resolvePersonPronunciation compositional full-name resolution', () => {
  it('prefers explicit person.pronunciation over full-name and compositional lexicon entries', () => {
    const person = makeDeceasedPerson({
      pronunciation: {
        phonetic: 'TOH-mas MER-ser',
        ipa: '/ˈtoʊ.məs ˈmɜːr.sər/',
        language: 'en-US',
        source_label: 'Family oral tradition',
      },
    });
    const resolved = resolvePersonPronunciation(person, {
      per_thomas: { phonetic: 'ID-ENTRY' },
      'Thomas Mercer': { phonetic: 'FULL-NAME-ENTRY' },
      Thomas: { phonetic: 'TOM-us', language: 'en-US' },
      Mercer: { phonetic: 'MER-ser', language: 'en-US' },
    });
    expect(resolved?.phonetic).toBe('TOH-mas MER-ser');
    expect(resolved?.coverage).toBe('full');
    expect(resolved?.resolvedFrom).toBe('person');
  });

  it('resolves exact person-ID and full-name lexicon entries with full coverage', () => {
    const thomas = makeDeceasedPerson();
    const byId = resolvePersonPronunciation(thomas, {
      per_thomas: {
        phonetic: 'TOM-us MER-ser (ID)',
        ipa: '/ˈtɒm.əs ˈmɜːr.sər/',
        language: 'en-US',
      },
      'Thomas Mercer': { phonetic: 'FULL-NAME-FALLBACK' },
    });
    expect(byId?.phonetic).toBe('TOM-us MER-ser (ID)');
    expect(byId?.coverage).toBe('full');
    expect(byId?.resolvedFrom).toBe('lexicon_id');

    const byFullName = resolvePersonPronunciation(thomas, {
      'thomas mercer': {
        phonetic: 'TOM-us MER-ser',
        ipa: '/ˈtɒm.əs ˈmɜːr.sər/',
        language: 'en-US',
        source_label: 'Wiktionary (English IPA)',
      },
    });
    expect(byFullName?.phonetic).toBe('TOM-us MER-ser');
    expect(byFullName?.coverage).toBe('full');
    expect(byFullName?.resolvedFrom).toBe('lexicon_full_name');
  });

  it('composes 2-part and 3-part full names from shared lexicon tokens with unified respelling, IPA, and provenance', () => {
    const lexicon: Record<string, Pronunciation> = {
      Mary: {
        phonetic: 'MAIR-ee',
        ipa: '/ˈmɛə.ɹi/',
        language: 'en-US',
        source_label: 'Wiktionary (English IPA)',
      },
      Ann: {
        phonetic: 'AN',
        ipa: '/æn/',
        language: 'en-US',
        source_label: 'Wiktionary (English IPA)',
      },
      Mercer: {
        phonetic: 'MER-ser',
        ipa: '/ˈmɜːr.sər/',
        language: 'en-US',
        source_label: 'Family oral tradition',
        audio_url: '/media/mercer-surname-only.wav',
      },
    };

    const twoPart = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_mary',
        full_name: 'Mary Mercer',
        given_name: 'Mary',
        surname: 'Mercer',
      }),
      lexicon
    );
    expect(twoPart).toEqual({
      phonetic: 'MAIR-ee MER-ser',
      ipa: '/ˈmɛə.ɹi ˈmɜːr.sər/',
      language: 'en-US',
      source_label: 'Wiktionary (English IPA) + Family oral tradition',
      coverage: 'full',
      resolvedFrom: 'composed',
    });
    // Composed full name never reuses single-word surname audio
    expect(twoPart?.audio_url).toBeUndefined();

    const threePart = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_mary_ann',
        full_name: 'Mary Ann Mercer',
        given_name: 'Mary Ann',
        surname: 'Mercer',
      }),
      lexicon
    );
    expect(threePart?.phonetic).toBe('MAIR-ee AN MER-ser');
    expect(threePart?.ipa).toBe('/ˈmɛə.ɹi æn ˈmɜːr.sər/');
    expect(threePart?.coverage).toBe('full');
    expect(threePart?.resolvedFrom).toBe('composed');
    expect(threePart?.token_audio_urls).toBeUndefined();
  });

  it('emits token_audio_urls on composed names when every substantive token has audio_url, skipping unmatched initials and suffixes', () => {
    const fullAudioLexicon: Record<string, Pronunciation> = {
      Mary: {
        phonetic: 'MAIR-ee',
        ipa: '/ˈmɛə.ɹi/',
        language: 'en-US',
        audio_url: '/media/pronunciation-mary.wav',
      },
      Ann: {
        phonetic: 'AN',
        ipa: '/æn/',
        language: 'en-US',
        audio_url: '/media/pronunciation-ann.wav',
      },
      William: {
        phonetic: 'WIL-yum',
        ipa: '/ˈwɪl.jəm/',
        language: 'en-US',
        audio_url: '/media/pronunciation-william.wav',
      },
      Mercer: {
        phonetic: 'MER-ser',
        ipa: '/ˈmɜːr.sər/',
        language: 'en-US',
        audio_url: '/media/pronunciation-mercer.wav',
      },
    };

    const composedThree = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_mary_ann_audio',
        full_name: 'Mary Ann Mercer',
        given_name: 'Mary Ann',
        surname: 'Mercer',
      }),
      fullAudioLexicon
    );
    expect(composedThree?.audio_url).toBeUndefined();
    expect(composedThree?.token_audio_urls).toEqual([
      '/media/pronunciation-mary.wav',
      '/media/pronunciation-ann.wav',
      '/media/pronunciation-mercer.wav',
    ]);

    const withInitialAndSuffix = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_william_j',
        full_name: 'William J. Mercer Jr.',
        given_name: 'William J.',
        surname: 'Mercer',
      }),
      fullAudioLexicon
    );
    expect(withInitialAndSuffix?.audio_url).toBeUndefined();
    expect(withInitialAndSuffix?.token_audio_urls).toEqual([
      '/media/pronunciation-william.wav',
      '/media/pronunciation-mercer.wav',
    ]);

    // Missing audio on any substantive token omits token_audio_urls
    const partialAudioLexicon: Record<string, Pronunciation> = {
      ...fullAudioLexicon,
      Ann: { phonetic: 'AN', ipa: '/æn/', language: 'en-US' },
    };
    const missingMiddleAudio = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_mary_ann_partial',
        full_name: 'Mary Ann Mercer',
        given_name: 'Mary Ann',
        surname: 'Mercer',
      }),
      partialAudioLexicon
    );
    expect(missingMiddleAudio?.audio_url).toBeUndefined();
    expect(missingMiddleAudio?.token_audio_urls).toBeUndefined();
  });

  it('handles middle initials and generational suffixes cleanly during full-name composition', () => {
    const lexicon: Record<string, Pronunciation> = {
      William: {
        phonetic: 'WIL-yum',
        ipa: '/ˈwɪl.jəm/',
        language: 'en-US',
      },
      Mercer: {
        phonetic: 'MER-ser',
        ipa: '/ˈmɜːr.sər/',
        language: 'en-US',
      },
    };
    const resolved = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_william_e',
        full_name: 'William E. Mercer Jr.',
        given_name: 'William E.',
        surname: 'Mercer',
      }),
      lexicon
    );
    expect(resolved?.phonetic).toBe('WIL-yum E. MER-ser Jr.');
    expect(resolved?.ipa).toBe('/ˈwɪl.jəm ˈmɜːr.sər/');
    expect(resolved?.language).toBe('en-US');
    expect(resolved?.coverage).toBe('full');
    expect(resolved?.resolvedFrom).toBe('composed');
  });

  it('matches multi-word surnames atomically and composes hyphenated given names', () => {
    const lexicon: Record<string, Pronunciation> = {
      Jan: {
        phonetic: 'YAHN',
        ipa: '/jɑn/',
        language: 'nl',
        region: 'Netherlands',
        source_label: 'Wiktionary (Dutch IPA)',
      },
      'van der Berg': {
        phonetic: 'vahn der BERKH',
        ipa: '/vɑn dər ˈbɛrx/',
        language: 'nl',
        region: 'Netherlands',
        source_label: 'Wiktionary (Dutch IPA)',
      },
      Anne: {
        phonetic: 'AHN-uh',
        ipa: '/ˈɑn.ə/',
        language: 'nl',
      },
      Marie: {
        phonetic: 'mah-REE',
        ipa: '/maːˈri/',
        language: 'nl',
      },
    };

    const multiWord = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_jan_vdb',
        full_name: 'Jan van der Berg',
        given_name: 'Jan',
        surname: 'van der Berg',
      }),
      lexicon
    );
    expect(multiWord).toEqual({
      phonetic: 'YAHN vahn der BERKH',
      ipa: '/jɑn vɑn dər ˈbɛrx/',
      language: 'nl',
      region: 'Netherlands',
      source_label: 'Wiktionary (Dutch IPA)',
      coverage: 'full',
      resolvedFrom: 'composed',
    });

    const hyphenated = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_anne_marie',
        full_name: 'Anne-Marie van der Berg',
        given_name: 'Anne-Marie',
        surname: 'van der Berg',
      }),
      lexicon
    );
    expect(hyphenated?.phonetic).toBe('AHN-uh-mah-REE vahn der BERKH');
    expect(hyphenated?.ipa).toBe('/ˈɑn.ə-maːˈri vɑn dər ˈbɛrx/');
    expect(hyphenated?.coverage).toBe('full');
  });

  it('composes mixed-language names without forcing a conflicting single-language TTS tag', () => {
    const lexicon: Record<string, Pronunciation> = {
      Thomas: {
        phonetic: 'TOM-us',
        ipa: '/ˈtɒm.əs/',
        language: 'en-US',
        source_label: 'Wiktionary (English IPA)',
      },
      'van Dijk': {
        phonetic: 'vahn DIKE',
        ipa: '/vɑn ˈdɛik/',
        language: 'nl',
        source_label: 'Wiktionary (Dutch IPA)',
      },
    };
    const mixed = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_thomas_vd',
        full_name: 'Thomas van Dijk',
        given_name: 'Thomas',
        surname: 'van Dijk',
      }),
      lexicon
    );
    expect(mixed?.phonetic).toBe('TOM-us vahn DIKE');
    expect(mixed?.ipa).toBe('/ˈtɒm.əs vɑn ˈdɛik/');
    expect(mixed?.language).toBeUndefined();
    expect(mixed?.source_label).toBe('Wiktionary (English IPA) + Wiktionary (Dutch IPA)');
    expect(mixed?.coverage).toBe('full');
    expect(mixed?.resolvedFrom).toBe('composed');
  });

  it('falls back to surname-only coverage when any meaningful given/middle name token is missing and respects match_full_name_contains', () => {
    const lexicon: Record<string, Pronunciation> = {
      Mercer: {
        phonetic: 'MER-ser',
        ipa: '/ˈmɜːr.sər/',
        language: 'en-US',
      },
      Holland: {
        phonetic: 'HOHL-ahnt',
        language: 'nl',
        match_full_name_contains: ['Netherlands', 'Nederland'],
      },
    };
    const fallback = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_barnabas',
        full_name: 'Barnabas Mercer',
        given_name: 'Barnabas',
        surname: 'Mercer',
      }),
      lexicon
    );
    expect(fallback).toEqual({
      phonetic: 'MER-ser',
      ipa: '/ˈmɜːr.sər/',
      language: 'en-US',
      coverage: 'surname',
      matchedPart: 'Mercer',
      resolvedFrom: 'lexicon_surname',
      missingParts: ['Barnabas'],
    });

    // Place-scoped entry must not accidentally match a person surname
    const personHolland = resolvePersonPronunciation(
      makeDeceasedPerson({
        id: 'per_john_holland',
        full_name: 'John Holland',
        given_name: 'John',
        surname: 'Holland',
      }),
      lexicon
    );
    expect(personHolland).toBeNull();
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
        lexicon
      )?.phonetic
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

  it('preserves audio_url from qualified and bare lexicon entries when resolving places', () => {
    const lexicon: Record<string, Pronunciation> = {
      'Oakville, Ontario': {
        phonetic: 'OHK-vil',
        ipa: '/ˈoʊk.vɪl/',
        language: 'en-CA',
        audio_url: '/media/pronunciation-oakville.wav',
      },
      Riverdale: {
        phonetic: 'RIV-er-dayl',
        language: 'en-US',
        audio_url: '/media/pronunciation-riverdale.wav',
      },
    };
    const oakville = makePlace({
      id: 'plc_oakville',
      name: 'Oakville',
      full_name: 'Oakville, Halton Region, Ontario, Canada',
    });
    const riverdale = makePlace({
      id: 'plc_riverdale',
      name: 'Riverdale',
      full_name: 'Riverdale, Ohio, United States',
    });

    expect(resolvePlacePronunciation(oakville, lexicon)?.audio_url).toBe('/media/pronunciation-oakville.wav');
    expect(resolvePlacePronunciation(riverdale, lexicon)?.audio_url).toBe(
      '/media/pronunciation-riverdale.wav'
    );
  });
});

describe('mergePronunciationLexicons', () => {
  it('replaces case-variant keys cleanly without leaving shadowed duplicates', () => {
    const merged = mergePronunciationLexicons(
      { mercer: { phonetic: 'MER-ser-OLD' }, alder: { phonetic: 'AWL-der' } },
      { Mercer: { phonetic: 'MUR-ser-NEW', note: 'Updated' } }
    );
    expect(merged).toEqual({
      alder: { phonetic: 'AWL-der' },
      Mercer: { phonetic: 'MUR-ser-NEW', note: 'Updated' },
    });
    expect(merged.mercer).toBeUndefined();
  });
});

describe('findIpaGlyphsInPhonetic', () => {
  it('detects IPA glyphs and /.../ slash notation while accepting clean plain-English respellings', () => {
    expect(findIpaGlyphsInPhonetic('DAN-yuhl AN-der-sun AWL-der')).toEqual([]);
    expect(hasIpaGlyphsInPhonetic('AY-bruh-ham LING-kun')).toBe(false);
    expect(findIpaGlyphsInPhonetic('MER-ser / MUR-ser')).toEqual([]);
    expect(findIpaGlyphsInPhonetic('')).toEqual([]);

    expect(findIpaGlyphsInPhonetic('DAN-yəl')).toEqual(['ə']);
    expect(hasIpaGlyphsInPhonetic('DAN-yəl')).toBe(true);
    expect(findIpaGlyphsInPhonetic('/ˈmɜːr.sər/')).toEqual(['ˈ', 'ɜ', 'ː', 'ə', '/.../']);
    expect(findIpaGlyphsInPhonetic('/alder/')).toEqual(['/.../']);
    expect(findIpaGlyphsInPhonetic('THAWM-ɪs ʃɔːrt')).toEqual(['ɪ', 'ʃ', 'ɔ', 'ː']);
  });
});

describe('inspectPersonPronunciationTokens', () => {
  it('segments given, middle, and surname tokens with lexicon matches and composed preview', () => {
    const lexicon: Record<string, Pronunciation> = {
      daniel: { phonetic: 'DAN-yuhl', ipa: '/ˈdæn.jəl/', language: 'en-US', source_label: 'Wiktionary' },
      Alder: { phonetic: 'AWL-der', ipa: '/ˈɔːl.dər/', language: 'en-US', source_label: 'Wiktionary' },
    };

    const partial = inspectPersonPronunciationTokens(
      {
        full_name: 'Daniel Anderson Alder',
        given_name: 'Daniel Anderson',
        surname: 'Alder',
      },
      lexicon
    );

    expect(partial.tokens.map((t) => ({ role: t.role, text: t.text, key: t.lexiconKey }))).toEqual([
      { role: 'given', text: 'Daniel', key: 'daniel' },
      { role: 'middle', text: 'Anderson', key: null },
      { role: 'surname', text: 'Alder', key: 'Alder' },
    ]);
    expect(partial.allTokensResolved).toBe(false);
    expect(partial.hasAnySharedToken).toBe(true);
    expect(partial.composed).toBeNull();
    expect(partial.missingParts).toEqual(['Anderson']);

    const full = inspectPersonPronunciationTokens(
      {
        full_name: 'Daniel Anderson Alder',
        given_name: 'Daniel Anderson',
        surname: 'Alder',
      },
      {
        ...lexicon,
        Anderson: { phonetic: 'AN-der-sun', ipa: '/ˈæn.dər.sən/', language: 'en-US' },
      }
    );
    expect(full.allTokensResolved).toBe(true);
    expect(full.composed?.phonetic).toBe('DAN-yuhl AN-der-sun AWL-der');
    expect(full.composed?.ipa).toBe('/ˈdæn.jəl ˈæn.dər.sən ˈɔːl.dər/');
  });

  it('keeps unmatched multi-word surnames grouped as one editable token and handles initials/suffixes', () => {
    const multi = inspectPersonPronunciationTokens(
      {
        full_name: 'Jan H. van der Berg Jr.',
        given_name: 'Jan H.',
        surname: 'van der Berg',
      },
      {
        Jan: { phonetic: 'YAHN', ipa: '/jɑn/', language: 'nl' },
      }
    );

    expect(multi.tokens.map((t) => ({ kind: t.kind, role: t.role, text: t.text }))).toEqual([
      { kind: 'token', role: 'given', text: 'Jan' },
      { kind: 'initial', role: 'middle', text: 'H.' },
      { kind: 'token', role: 'surname', text: 'van der Berg' },
      { kind: 'decoration', role: 'suffix', text: 'Jr.' },
    ]);
    expect(multi.allTokensResolved).toBe(false);
  });

  it('returns empty tokens for living people', () => {
    const living = inspectPersonPronunciationTokens(
      {
        full_name: 'Pat Mercer',
        given_name: 'Pat',
        surname: 'Mercer',
        is_living: true,
      },
      { Mercer: { phonetic: 'MER-ser' } }
    );
    expect(living.tokens).toEqual([]);
    expect(living.allTokensResolved).toBe(false);
  });
});
