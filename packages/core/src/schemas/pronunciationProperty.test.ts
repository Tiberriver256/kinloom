import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  composeLanguageTag,
  composeProvenance,
  findIpaGlyphsInPhonetic,
  findSurnameTokenSpan,
  hasPronunciationEntryContent,
  isLexiconEntryCompatibleWithPerson,
  lookupLexiconEntry,
  mergePronunciationEntry,
  stripIpaDelimiters,
  tokenizePersonName,
} from './pronunciationPhonetics.js';
import { resolvePlacePronunciation } from './pronunciationPlaceResolve.js';
import { inspectPersonPronunciationTokens, resolvePersonPronunciation } from './pronunciationResolve.js';
import type { Pronunciation } from './pronunciationSchema.js';

const PRON_SEED = 20261131;

const alphaWordArb = fc.stringMatching(/^[A-Z][a-z]{3,8}$/);
const suffixArb = fc.constantFrom('Jr.', 'Sr.', 'II', 'III', 'IV');
const initialArb = fc.constantFrom('A.', 'B', 'J.', 'M', 'W.');

describe('Pronunciation composition, tokenization, and disambiguation property invariants', () => {
  it('composes hyphenated tokens, initials, and suffixes consistently across resolve and inspect', () => {
    fc.assert(
      fc.property(
        alphaWordArb,
        alphaWordArb,
        initialArb,
        alphaWordArb,
        suffixArb,
        (firstA, firstB, middleInit, surname, suffix) => {
          fc.pre(new Set([firstA.toLowerCase(), firstB.toLowerCase(), surname.toLowerCase()]).size === 3);
          const lexicon: Record<string, Pronunciation> = {
            [firstA]: {
              phonetic: `PH-${firstA.toUpperCase()}`,
              ipa: `/${firstA.toLowerCase()}/`,
              language: 'en',
              source_label: 'Family Guide',
              source_url: 'https://example.org/guide',
              region: 'Midwest US',
            },
            [firstB]: {
              phonetic: `PH-${firstB.toUpperCase()}`,
              ipa: `[${firstB.toLowerCase()}]`,
              language: 'en-US',
              source_label: 'family guide',
              source_url: 'https://example.org/guide',
              region: 'Midwest US',
            },
            [surname]: {
              phonetic: `PH-${surname.toUpperCase()}`,
              ipa: `/${surname.toLowerCase()}/`,
              language: 'en',
              source_label: 'County Index',
              source_url: 'https://example.org/guide',
              region: 'Midwest US',
            },
          };

          const person = {
            id: 'per_comp',
            is_living: false,
            full_name: `${firstA}-${firstB} ${middleInit} ${surname} ${suffix}`,
            given_name: `${firstA}-${firstB} ${middleInit}`,
            surname,
          };

          const resolved = resolvePersonPronunciation(person, lexicon);
          const inspected = inspectPersonPronunciationTokens(person, lexicon);

          expect(resolved).not.toBeNull();
          expect(resolved?.coverage).toBe('full');
          expect(resolved?.resolvedFrom).toBe('composed');
          expect(resolved?.phonetic).toBe(
            `PH-${firstA.toUpperCase()}-PH-${firstB.toUpperCase()} ${middleInit} PH-${surname.toUpperCase()} ${suffix}`
          );
          expect(resolved?.ipa).toBe(
            `/${firstA.toLowerCase()}-${firstB.toLowerCase()} ${surname.toLowerCase()}/`
          );
          expect(resolved?.language).toBe('en-US');
          expect(resolved?.source_label).toBe('Family Guide + County Index');
          expect(resolved?.source_url).toBe('https://example.org/guide');
          expect(resolved?.region).toBe('Midwest US');

          expect(inspected.allTokensResolved).toBe(true);
          expect(inspected.hasAnySharedToken).toBe(true);
          expect(inspected.missingParts).toEqual([]);
          expect(inspected.composed).toEqual(resolved);
          expect(inspected.tokens.some((t) => t.kind === 'initial' && t.text === middleInit)).toBe(true);
          expect(inspected.tokens.some((t) => t.kind === 'decoration' && t.text === suffix)).toBe(true);
          expect(inspected.tokens.some((t) => t.joinWithHyphen === true && t.text === firstB)).toBe(true);
        }
      ),
      { seed: PRON_SEED, numRuns: 70 }
    );
  });

  it('groups unmatched multi-word surnames and reports missing hyphenated sub-tokens accurately', () => {
    fc.assert(
      fc.property(alphaWordArb, alphaWordArb, alphaWordArb, alphaWordArb, (given, subA, sur1, sur2) => {
        fc.pre(
          new Set([given.toLowerCase(), subA.toLowerCase(), sur1.toLowerCase(), sur2.toLowerCase()]).size ===
            4
        );

        const multiSurname = `${sur1} ${sur2}`;
        const person = {
          id: 'per_multi',
          is_living: false,
          full_name: `${given}-${subA} ${multiSurname}`,
          given_name: `${given}-${subA}`,
          surname: multiSurname,
        };

        // Only `given` exists in lexicon; `subA` and both surname words are missing
        const partialLex: Record<string, Pronunciation> = {
          [given]: { phonetic: `G-${given.toUpperCase()}` },
        };
        const inspected = inspectPersonPronunciationTokens(person, partialLex);
        expect(inspected.allTokensResolved).toBe(false);
        expect(inspected.hasAnySharedToken).toBe(true);
        expect(inspected.composed).toBeNull();
        expect(inspected.missingParts).toEqual([subA, sur1, sur2]);
        expect(
          inspected.tokens.some((t) => t.role === 'surname' && t.text === multiSurname && t.entry === null)
        ).toBe(true);

        // Once the multi-word surname phrase is added, longest-phrase match resolves it atomically
        const withPhrase: Record<string, Pronunciation> = {
          [given]: { phonetic: `G-${given.toUpperCase()}` },
          [subA]: { phonetic: `S-${subA.toUpperCase()}` },
          [multiSurname]: { phonetic: `MULTI-${sur1.toUpperCase()}-${sur2.toUpperCase()}` },
        };
        const full = resolvePersonPronunciation(person, withPhrase);
        expect(full?.coverage).toBe('full');
        expect(full?.phonetic).toBe(
          `G-${given.toUpperCase()}-S-${subA.toUpperCase()} MULTI-${sur1.toUpperCase()}-${sur2.toUpperCase()}`
        );
      }),
      { seed: PRON_SEED + 1, numRuns: 60 }
    );
  });

  it('enforces match_full_name_contains disambiguation, precedence order, and audio invalidation on merge', () => {
    fc.assert(
      fc.property(alphaWordArb, alphaWordArb, alphaWordArb, (given, surA, surB) => {
        fc.pre(new Set([given.toLowerCase(), surA.toLowerCase(), surB.toLowerCase()]).size === 3);

        const lexicon: Record<string, Pronunciation> = {
          [given]: {
            phonetic: 'MATCHED-ONLY-FOR-SURA',
            match_full_name_contains: [surA],
          },
          [surB]: { phonetic: `SUR-${surB.toUpperCase()}` },
        };

        // Person with surB does not satisfy match_full_name_contains for given -> falls back to surname
        const personB = {
          id: 'per_b',
          is_living: false,
          full_name: `${given} ${surB}`,
          given_name: given,
          surname: surB,
        };
        const resB = resolvePersonPronunciation(personB, lexicon);
        expect(resB?.coverage).toBe('surname');
        expect(resB?.resolvedFrom).toBe('lexicon_surname');
        expect(resB?.missingParts).toEqual([given]);

        // Exact lexicon_id overrides full_name and composition; person override beats all
        const richLex: Record<string, Pronunciation> = {
          ...lexicon,
          per_b: { phonetic: 'BY-ID', audio_url: '/audio/id.mp3' },
          [`${given} ${surB}`]: { phonetic: 'BY-FULL-NAME' },
        };
        expect(resolvePersonPronunciation(personB, richLex)?.resolvedFrom).toBe('lexicon_id');

        const fullNameOnly = resolvePersonPronunciation({ ...personB, id: 'per_other' }, richLex);
        expect(fullNameOnly?.resolvedFrom).toBe('lexicon_full_name');
        expect(fullNameOnly?.phonetic).toBe('BY-FULL-NAME');

        // Overriding phonetic without audio_url drops stale shared audio_url
        const overridden = resolvePersonPronunciation(
          { ...personB, pronunciation: { phonetic: 'NEW-SPELLING' } },
          richLex
        );
        expect(overridden?.resolvedFrom).toBe('person');
        expect(overridden?.phonetic).toBe('NEW-SPELLING');
        expect(overridden?.audio_url).toBeUndefined();

        // Keeping same phonetic preserves shared audio_url
        const sameSpelling = resolvePersonPronunciation(
          { ...personB, pronunciation: { phonetic: 'BY-ID', note: 'Confirmed' } },
          richLex
        );
        expect(sameSpelling?.audio_url).toBe('/audio/id.mp3');
      }),
      { seed: PRON_SEED + 2, numRuns: 60 }
    );
  });

  it('enforces place pronunciation specificity and rejects incompatible bare entries across regions', () => {
    fc.assert(
      fc.property(alphaWordArb, alphaWordArb, (city, state) => {
        fc.pre(city.toLowerCase() !== state.toLowerCase());
        const place = {
          id: 'plc_target',
          name: city,
          full_name: `${city}, Cedar County, ${state}, United States`,
        };

        // 1. Bare entry scoped to Sweden must NOT match a United States place
        const foreignBare: Record<string, Pronunciation> = {
          [city]: { phonetic: 'SWEDISH-CITY', language: 'sv-SE', region: 'Sweden' },
        };
        expect(resolvePlacePronunciation(place, foreignBare)).toBeNull();

        // 2. Qualified entry beats bare entry, longer qualified key beats shorter qualified key
        const tieredLex: Record<string, Pronunciation> = {
          [city]: { phonetic: 'BARE' },
          [`${city}, ${state}`]: { phonetic: 'SHORT-QUAL' },
          [`${city}, Cedar County, ${state}`]: { phonetic: 'LONG-QUAL' },
        };
        expect(resolvePlacePronunciation(place, tieredLex)?.phonetic).toBe('LONG-QUAL');

        // 3. Exact full_name beats qualified substring, exact id beats full_name, own overrides all
        const withFull: Record<string, Pronunciation> = {
          ...tieredLex,
          [place.full_name.toLowerCase()]: { phonetic: 'EXACT-FULL' },
        };
        expect(resolvePlacePronunciation(place, withFull)?.phonetic).toBe('EXACT-FULL');

        const withId: Record<string, Pronunciation> = {
          ...withFull,
          [place.id]: { phonetic: 'EXACT-ID', audio_url: '/audio/place.mp3' },
        };
        expect(resolvePlacePronunciation(place, withId)?.phonetic).toBe('EXACT-ID');

        const withOwn = resolvePlacePronunciation(
          { ...place, pronunciation: { phonetic: 'OWN-PLACE' } },
          withId
        );
        expect(withOwn?.phonetic).toBe('OWN-PLACE');
        expect(withOwn?.audio_url).toBeUndefined();
      }),
      { seed: PRON_SEED + 3, numRuns: 60 }
    );
  });

  it('handles phonetic utility edge cases deterministically', () => {
    expect(findIpaGlyphsInPhonetic(null)).toEqual([]);
    expect(findIpaGlyphsInPhonetic('  ')).toEqual([]);
    expect(findIpaGlyphsInPhonetic('ə ə /test/')).toEqual(['ə', '/.../']);
    expect(mergePronunciationEntry(undefined, undefined)).toBeNull();
    expect(mergePronunciationEntry({ phonetic: 'A' }, undefined)).toEqual({ phonetic: 'A' });
    expect(mergePronunciationEntry(undefined, { phonetic: 'B' })).toEqual({ phonetic: 'B' });
    expect(hasPronunciationEntryContent(null)).toBe(false);
    expect(hasPronunciationEntryContent({})).toBe(false);
    expect(hasPronunciationEntryContent({ variants: [{ label: 'v', phonetic: 'VEE' }] })).toBe(true);
    expect(lookupLexiconEntry({ Alder: { phonetic: 'AWL-der' } }, '')).toBeUndefined();
    expect(lookupLexiconEntry({ Alder: { phonetic: 'AWL-der' } }, 'alder')?.phonetic).toBe('AWL-der');
    expect(isLexiconEntryCompatibleWithPerson({ match_full_name_contains: '  ' }, '')).toBe(true);
    expect(isLexiconEntryCompatibleWithPerson({ match_full_name_contains: 'alder' }, 'henry alder')).toBe(
      true
    );
    expect(tokenizePersonName({ full_name: '  ' })).toEqual([]);
    expect(tokenizePersonName({ full_name: '("Nickname")' })).toEqual([]);
    expect(stripIpaDelimiters('/a/')).toBe('a');
    expect(stripIpaDelimiters('[b]')).toBe('b');
    expect(stripIpaDelimiters('plain')).toBe('plain');
    expect(composeLanguageTag([])).toBeUndefined();
    expect(composeLanguageTag([{ language: 'sv' }, { language: 'en' }])).toBeUndefined();
    expect(composeLanguageTag([{ language: 'en' }, { language: 'en-GB' }])).toBe('en-GB');
    expect(
      composeProvenance([
        { source_label: 'A', source_url: 'https://a.test', region: 'OH' },
        { source_label: 'B', source_url: 'https://b.test', region: 'MI' },
      ])
    ).toEqual({ source_label: 'A + B' });
    expect(findSurnameTokenSpan([], 'Alder')).toBeNull();
    expect(findSurnameTokenSpan(['Alder'], 'Alder')).toEqual({ start: 0, end: 1 });
    expect(findSurnameTokenSpan(['Henry', 'Alder', 'Jr.'], 'Other')).toEqual({ start: 1, end: 2 });
    expect(resolvePersonPronunciation({ id: 'p1', full_name: 'Henry Alder' }, null)).toBeNull();
    expect(inspectPersonPronunciationTokens({ is_living: true, full_name: 'Sam' }).tokens).toEqual([]);
    expect(inspectPersonPronunciationTokens({ full_name: '   ' }).tokens).toEqual([]);
  });
});
