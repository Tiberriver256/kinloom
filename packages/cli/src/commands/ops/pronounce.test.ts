import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseKinloomConfig,
  parsePeopleYaml,
  parsePlacesYaml,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  serializePlacesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../cli.js';
import { runIntegrateCommand } from './integrate.js';
import {
  buildCommonsAudioUrl,
  evaluatePronounceCorroboration,
  extractMediaWikiPronunciations,
  rankPronounceSources,
  runPronounceAuditCommand,
  runPronounceLookupCommand,
} from './pronounce.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('extractMediaWikiPronunciations', () => {
  it('extracts Wiktionary and Wikipedia IPA templates plus Wikimedia Commons audio files', () => {
    const wikitext = `
==Dutch==
===Pronunciation===
* {{IPA|nl|/ɣus/|[ɣus]}}
* {{audio|nl|Nl-Goes.ogg|Audio}}
* {{IPA-nl|ˈzeː.lɑnt|-|Nl-Zeeland.ogg}}
* {{IPA|en|/ɡoʊz/}}
`;
    const nlOnly = extractMediaWikiPronunciations(wikitext, { targetLang: 'nl', wikiLang: 'en' });
    expect(nlOnly.ipa).toEqual(['/ɣus/', '[ɣus]', '/ˈzeː.lɑnt/']);
    expect(nlOnly.audioFiles).toEqual([
      { filename: 'Nl-Goes.ogg', language: 'nl' },
      { filename: 'Nl-Zeeland.ogg', language: 'nl' },
    ]);
    expect(buildCommonsAudioUrl('Nl-Goes.ogg')).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Nl-Goes.ogg'
    );
  });

  it('supports nl.wiktionary {{pron|...}} and language-prefixed {{sv-IPA|...}} templates', () => {
    const nlWiki = '* {{pron|/ˈɛl.ə.ʋʌuts.dɛik/|nl}}';
    expect(extractMediaWikiPronunciations(nlWiki, { targetLang: 'nl', wikiLang: 'nl' }).ipa).toEqual([
      '/ˈɛl.ə.ʋʌuts.dɛik/',
    ]);

    const svWiki = '* {{sv-IPA|/ˈɵpːˌsɑːla/}}';
    expect(extractMediaWikiPronunciations(svWiki, { targetLang: 'sv', wikiLang: 'sv' }).ipa).toEqual([
      '/ˈɵpːˌsɑːla/',
    ]);
  });
});

describe('kinloom pronounce lookup', () => {
  it('fetches Wiktionary/Wikipedia IPA + audio, caches to disk with cache_hit, and honors --refresh', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-cache-');
    const requestedUrls: string[] = [];

    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);

      if (url.startsWith('https://nl.wiktionary.org/')) {
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: 'Goes',
                  revisions: [
                    {
                      slots: {
                        main: {
                          content: '* {{IPA|/ɣus/}}\n* {{audio|nl|Nl-Goes.ogg|Audio}}',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      if (url.startsWith('https://en.wiktionary.org/')) {
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: 'Goes',
                  revisions: [
                    {
                      slots: {
                        main: {
                          content: '==Dutch==\n* {{IPA|nl|/ɣus/}}\n* {{audio|nl|Nl-Goes.ogg}}',
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify({ query: { pages: [{ title: 'Goes', missing: true }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const first = await runPronounceLookupCommand({
      term: 'Goes',
      lang: 'nl',
      json: true,
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
      nowIso: () => '2026-11-26T12:00:00.000Z',
    });

    expect(first.verified).toBe(true);
    expect(first.cache_hit).toBe(false);
    expect(first.primary_ipa).toBe('/ɣus/');
    expect(first.ipa).toEqual(['/ɣus/']);
    expect(first.source_url).toBe('https://nl.wiktionary.org/wiki/Goes');
    expect(first.source_label).toBe('Wiktionary (Dutch IPA)');
    expect(first.audio_files).toEqual([
      {
        filename: 'Nl-Goes.ogg',
        commons_file: 'File:Nl-Goes.ogg',
        url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nl-Goes.ogg',
        language: 'nl',
        source_url: 'https://nl.wiktionary.org/wiki/Goes',
      },
    ]);
    const callsAfterFirst = mockFetch.mock.calls.length;
    expect(callsAfterFirst).toBe(4);

    // Second call hits disk cache with 0 new network requests
    const second = await runPronounceLookupCommand({
      term: 'Goes',
      lang: 'nl',
      json: true,
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
    });
    expect(second.cache_hit).toBe(true);
    expect(second.verified).toBe(true);
    expect(second.primary_ipa).toBe('/ɣus/');
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterFirst);

    // --refresh bypasses disk cache
    const refreshed = await runPronounceLookupCommand({
      term: 'Goes',
      lang: 'nl',
      refresh: true,
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
    });
    expect(refreshed.cache_hit).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(callsAfterFirst * 2);
  });

  it('retries 429/503 responses honoring Retry-After up to 4 attempts and reports verified=false when upstream has no IPA', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-retry-');
    const sleepCalls: number[] = [];
    let enWiktAttempts = 0;

    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://en.wiktionary.org/')) {
        enWiktAttempts += 1;
        if (enWiktAttempts === 1) {
          return new Response('rate limited', {
            status: 429,
            headers: { 'retry-after': '1' },
          });
        }
        if (enWiktAttempts === 2) {
          return new Response('upstream error', { status: 503 });
        }
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: 'Mercer',
                  revisions: [
                    {
                      slots: {
                        main: { content: '==English==\n* {{IPA|en|/ˈmɜː(ɹ)sə(ɹ)/}}' },
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ query: { pages: [{ title: 'Mercer', missing: true }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const retried = await runPronounceLookupCommand({
      term: 'Mercer',
      lang: 'en',
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    expect(enWiktAttempts).toBe(3);
    expect(sleepCalls[0]).toBe(1000);
    expect(retried.verified).toBe(true);
    expect(retried.primary_ipa).toBe('/ˈmɜː(ɹ)sə(ɹ)/');

    // Term with zero upstream IPA returns verified=false and never fabricates IPA
    const emptyFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ query: { pages: [{ title: 'Nonexistenthamlet', missing: true }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
    );
    const missing = await runPronounceLookupCommand({
      term: 'Nonexistenthamlet',
      lang: 'en',
      cacheDir,
      fetchImpl: emptyFetch,
      sleepFn: async () => {},
    });
    expect(missing.verified).toBe(false);
    expect(missing.corroborated).toBe(false);
    expect(missing.sourceCount).toBe(0);
    expect(missing.highestTier).toBeNull();
    expect(missing.ipa).toEqual([]);
    expect(missing.primary_ipa).toBeNull();
    expect(missing.source_url).toBeNull();
    // Structured anti-bot-compliant fallback URLs are always emitted for gated providers
    const providers = missing.sources.map((s) => s.provider);
    expect(providers).toEqual(
      expect.arrayContaining(['forvo', 'youglish', 'voa', 'nameshouts', 'pronouncenames', 'howtopronounce'])
    );
    expect(missing.sources.find((s) => s.provider === 'forvo')?.status).toBe('requires_api_key');
    expect(missing.sources.find((s) => s.provider === 'youglish')?.status).toBe('manual_lookup');
    expect(missing.sources.find((s) => s.provider === 'voa')?.status).toBe('manual_lookup');
  });

  it('ranks verified native-speaker sources above broadcast/community/automated tiers and flags two-source corroboration', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-multi-');
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://apifree.forvo.com/')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 42,
                word: 'Zeeland',
                pathmp3: 'https://audio.forvo.com/mp3/zeeland-nl.mp3',
                username: 'native_nl',
                country: 'Netherlands',
                code: 'nl',
                num_positive_votes: 5,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.startsWith('https://en.wikipedia.org/')) {
        return new Response(
          JSON.stringify({
            query: {
              pages: [
                {
                  title: 'Zeeland',
                  revisions: [
                    {
                      slots: {
                        main: { content: 'Zeeland ({{IPA-nl|ˈzeːlɑnt}})' },
                      },
                    },
                  ],
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ query: { pages: [{ title: 'Zeeland', missing: true }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await runPronounceLookupCommand({
      term: 'Zeeland',
      lang: 'nl',
      region: 'nl',
      forvoApiKey: 'test-forvo-key',
      json: true,
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
    });

    expect(result.verified).toBe(true);
    expect(result.corroborated).toBe(true);
    expect(result.sourceCount).toBe(2);
    expect(result.highestTier).toBe('native_speaker');
    expect(result.native_speaker_verified).toBe(true);
    // Tier 1 Forvo ranks ahead of Tier 2 Wikipedia
    const verifiedOrder = result.sources.filter((s) => s.status === 'verified').map((s) => s.provider);
    expect(verifiedOrder).toEqual(['forvo', 'wikipedia']);
    expect(result.audio_files[0]?.provider).toBe('forvo');
    expect(result.audio_files[0]?.speaker).toBe('native_nl');

    // Pure ranking and corroboration check across all 4 tiers (automated-only emits explicit warning)
    const ranked = rankPronounceSources([
      {
        provider: 'howtopronounce',
        tier: 'automated',
        status: 'verified',
        site: 'howtopronounce.com',
        title: 'Test',
        url: 'https://www.howtopronounce.com/test',
        label: 'Automated',
        ipa: [],
        audio_files: ['a.mp3'],
      },
      {
        provider: 'nameshouts',
        tier: 'community',
        status: 'verified',
        site: 'nameshouts.com',
        title: 'Test',
        url: 'https://www.nameshouts.com/names/test',
        label: 'Community',
        ipa: [],
        audio_files: [],
      },
      {
        provider: 'forvo',
        tier: 'native_speaker',
        status: 'verified',
        site: 'forvo.com',
        title: 'Test',
        url: 'https://forvo.com/word/test/',
        label: 'Forvo',
        ipa: [],
        audio_files: ['native.mp3'],
      },
    ]);
    expect(ranked.map((s) => s.tier)).toEqual(['native_speaker', 'community', 'automated']);

    const autoOnly = evaluatePronounceCorroboration([ranked[2]]);
    expect(autoOnly.highestTier).toBe('automated');
    expect(autoOnly.native_speaker_verified).toBe(false);
    expect(autoOnly.verification_note).toContain('automated');
  });
});

describe('kinloom pronounce audit', () => {
  it('flags coverage gaps, unsourced entries, homonymous bare places, foreign-IPA mismatches, and strictly excludes living people', async () => {
    const repoDir = await makeTempDir('kinloom-pron-audit-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic Audit Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_AUDIT',
      },
      pronunciations: {
        Zeeland: {
          phonetic: 'ZAY-lahnt',
          ipa: '/ˈzeː.lɑnt/',
          language: 'nl',
          // Unsourced intentionally
        },
        Ellewoutsdijk: {
          phonetic: 'EL-uh-wouts-dike',
          ipa: '/ˈɛl.ɚ.waɪts.daɪk/', // Suspicious English rhotic + diphthong inside Dutch entry!
          language: 'nl',
          source_label: 'Draft note',
        },
        MalformedTerm: {
          phonetic: 'MAL-formed',
          ipa: 'unslashed-ipa',
          language: 'en-US',
          source_label: 'Test',
        },
        EmptyTerm: {
          note: 'Only a note, no guide or audio',
          source_label: 'Test',
        },
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

    fs.writeFileSync(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml([
        {
          id: 'per_thomas',
          slug: 'thomas-mercer',
          full_name: 'Thomas Mercer',
          given_name: 'Thomas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1842',
          death_edtf: '1911',
          portrait_url: null,
        },
        {
          id: 'per_living_secret',
          slug: 'living-secret',
          full_name: 'Pat SecretLivingSurname',
          given_name: 'Pat',
          surname: 'SecretLivingSurname',
          alt_names: [],
          sex: 'U',
          is_living: true,
          lineage_group: 'descendant',
          birth_edtf: '1995',
          death_edtf: '',
          portrait_url: null,
        },
      ]),
      'utf8'
    );

    fs.writeFileSync(
      path.join(repoDir, 'data', 'places.yaml'),
      serializePlacesYaml([
        {
          id: 'plc_zeeland_nl',
          slug: 'zeeland-nl',
          name: 'Zeeland',
          full_name: 'Zeeland, Netherlands',
          place_type: 'state',
          parent_id: null,
          lat: 51.494,
          lng: 3.849,
        },
        {
          id: 'plc_zeeland_mi',
          slug: 'zeeland-mi',
          name: 'Zeeland',
          full_name: 'Zeeland, Ottawa County, Michigan, United States',
          place_type: 'town',
          parent_id: null,
          lat: 42.8125,
          lng: -86.0187,
        },
        {
          id: 'plc_goes',
          slug: 'goes-nl',
          name: 'Goes',
          full_name: 'Goes, Zeeland, Netherlands',
          place_type: 'town',
          parent_id: 'plc_zeeland_nl',
          lat: 51.5046,
          lng: 3.8889,
        },
      ]),
      'utf8'
    );

    const audit = runPronounceAuditCommand({ repoDir, json: true });

    expect(audit.summary.deceased_people).toBe(1);
    expect(audit.summary.living_people_excluded).toBe(1);
    expect(audit.coverage_gaps.surnames).toEqual([{ surname: 'Mercer', deceased_count: 1 }]);
    expect(audit.coverage_gaps.places.map((p) => p.id)).toContain('plc_goes');
    expect(audit.unsourced_entries.map((u) => u.key)).toContain('Zeeland');

    // Homonymous bare place collision flagged for Zeeland
    expect(audit.homonymous_place_collisions).toHaveLength(1);
    expect(audit.homonymous_place_collisions[0]?.lexicon_key).toBe('Zeeland');
    expect(audit.homonymous_place_collisions[0]?.places.map((p) => p.id)).toEqual([
      'plc_zeeland_nl',
      'plc_zeeland_mi',
    ]);

    // IPA / quality warnings detect foreign-IPA mismatch, malformed IPA, and empty entry
    const warningCodesByKey = new Map(audit.ipa_quality_warnings.map((w) => [`${w.key}:${w.code}`, w]));
    expect(warningCodesByKey.has('Ellewoutsdijk:suspicious_english_ipa_for_foreign_lang')).toBe(true);
    expect(warningCodesByKey.has('MalformedTerm:malformed_ipa')).toBe(true);
    expect(warningCodesByKey.has('EmptyTerm:empty_entry')).toBe(true);

    // Privacy check: living surname and name NEVER appear in JSON or text output
    expect(audit.rendered).not.toContain('SecretLivingSurname');
    expect(audit.rendered).not.toContain('per_living_secret');
    const textAudit = runPronounceAuditCommand({ repoDir, json: false });
    expect(textAudit.rendered).not.toContain('SecretLivingSurname');
    expect(textAudit.rendered).not.toContain('per_living_secret');

    // CLI router integration for `kinloom pronounce audit --repo ... --json`
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runCli(['pronounce', 'audit', '--repo', repoDir, '--json'], {
      io: {
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      },
    });
    expect(exitCode).toBe(0);
    expect(err).toEqual([]);
    const parsedCli = JSON.parse(out.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      summary: {
        deceasedTotal: number;
        deceasedFullCoverage: number;
        deceasedPartialOnly: number;
        deceasedMissing: number;
        livingLeaks: number;
        placesTotal: number;
        placesCovered: number;
        placesMissing: number;
        homonymous_place_collisions: number;
      };
    };
    expect(parsedCli.ok).toBe(true);
    expect(parsedCli.strictOk).toBe(false);
    expect(parsedCli.summary.deceasedTotal).toBe(1);
    expect(parsedCli.summary.deceasedFullCoverage).toBe(0);
    expect(parsedCli.summary.deceasedMissing).toBe(1);
    expect(parsedCli.summary.livingLeaks).toBe(0);
    expect(parsedCli.summary.placesTotal).toBe(3);
    expect(parsedCli.summary.placesCovered).toBe(1);
    expect(parsedCli.summary.placesMissing).toBe(2);
    expect(parsedCli.summary.homonymous_place_collisions).toBe(1);

    // --strict exits non-zero when coverage is below 100%
    const strictOut: string[] = [];
    const strictExit = await runCli(['pronounce', 'audit', '--repo', repoDir, '--strict', '--json'], {
      io: {
        stdout: (line) => strictOut.push(line),
        stderr: () => {},
      },
    });
    expect(strictExit).toBe(1);
  });

  it('passes --strict at 100% compositional full-name & place coverage, flags surname-only fallbacks, and fails loudly on living leaks without exposing living names', async () => {
    const repoDir = await makeTempDir('kinloom-pron-audit-strict-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const basePeople = [
      {
        id: 'per_thomas',
        slug: 'thomas-mercer',
        full_name: 'Thomas Mercer',
        given_name: 'Thomas',
        surname: 'Mercer',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1842',
        death_edtf: '1911',
        portrait_url: null,
      },
      {
        id: 'per_living_hidden',
        slug: 'living-hidden',
        full_name: 'Riley HiddenLivingName',
        given_name: 'Riley',
        surname: 'HiddenLivingName',
        alt_names: [],
        sex: 'U',
        is_living: true,
        lineage_group: 'descendant',
        birth_edtf: '1998',
        death_edtf: '',
        portrait_url: null,
      },
    ];
    const basePlaces = [
      {
        id: 'plc_oxford',
        slug: 'oxford-ma',
        name: 'Oxford',
        full_name: 'Oxford, Worcester County, Massachusetts, United States',
        place_type: 'town' as const,
        parent_id: null,
        lat: 42.12,
        lng: -71.86,
      },
    ];

    fs.writeFileSync(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(basePeople), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml(basePlaces), 'utf8');

    // 1. Surname-only fallback: Thomas missing from lexicon -> deceasedPartialOnly = 1, --strict fails
    fs.writeFileSync(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(
        parseKinloomConfig({
          site: {
            title: 'Strict Audit Archive',
            familyName: 'Mercer Family',
            gedcomSourceName: 'MERCER_STRICT',
          },
          pronunciations: {
            Mercer: {
              phonetic: 'MER-ser',
              ipa: '/ˈmɜːr.sər/',
              language: 'en-US',
              source_label: 'Wiktionary',
            },
            'Oxford, Massachusetts': {
              phonetic: 'OX-ferd',
              ipa: '/ˈɒks.fərd/',
              language: 'en-US',
              source_label: 'Wiktionary',
            },
          },
        })
      ),
      'utf8'
    );

    const partialAudit = runPronounceAuditCommand({ repoDir, strict: true, json: true });
    expect(partialAudit.ok).toBe(false);
    expect(partialAudit.strictOk).toBe(false);
    expect(partialAudit.summary.deceasedTotal).toBe(1);
    expect(partialAudit.summary.deceasedFullCoverage).toBe(0);
    expect(partialAudit.summary.deceasedPartialOnly).toBe(1);
    expect(partialAudit.summary.deceasedMissing).toBe(0);
    expect(partialAudit.summary.placesTotal).toBe(1);
    expect(partialAudit.summary.placesCovered).toBe(1);
    expect(partialAudit.summary.placesMissing).toBe(0);
    expect(partialAudit.coverage_gaps.people_partial).toEqual([
      {
        id: 'per_thomas',
        full_name: 'Thomas Mercer',
        coverage: 'surname',
        matched_part: 'Mercer',
        missing_parts: ['Thomas'],
      },
    ]);

    // 2. Add "Thomas" -> compositional full-name coverage hits 100%, --strict exits 0
    fs.writeFileSync(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(
        parseKinloomConfig({
          site: {
            title: 'Strict Audit Archive',
            familyName: 'Mercer Family',
            gedcomSourceName: 'MERCER_STRICT',
          },
          pronunciations: {
            Thomas: { phonetic: 'TOM-us', ipa: '/ˈtɒm.əs/', language: 'en-US', source_label: 'Wiktionary' },
            Mercer: {
              phonetic: 'MER-ser',
              ipa: '/ˈmɜːr.sər/',
              language: 'en-US',
              source_label: 'Wiktionary',
            },
            'Oxford, Massachusetts': {
              phonetic: 'OX-ferd',
              ipa: '/ˈɒks.fərd/',
              language: 'en-US',
              source_label: 'Wiktionary',
            },
          },
        })
      ),
      'utf8'
    );

    const passOut: string[] = [];
    const passExit = await runCli(['pronounce', 'audit', '--repo', repoDir, '--strict', '--json'], {
      io: {
        stdout: (line) => passOut.push(line),
        stderr: () => {},
      },
    });
    expect(passExit).toBe(0);
    const passParsed = JSON.parse(passOut.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      summary: {
        deceasedTotal: number;
        deceasedFullCoverage: number;
        deceasedPartialOnly: number;
        deceasedMissing: number;
        livingLeaks: number;
        placesTotal: number;
        placesCovered: number;
        placesMissing: number;
      };
    };
    expect(passParsed.ok).toBe(true);
    expect(passParsed.strictOk).toBe(true);
    expect(passParsed.summary.deceasedTotal).toBe(1);
    expect(passParsed.summary.deceasedFullCoverage).toBe(1);
    expect(passParsed.summary.deceasedPartialOnly).toBe(0);
    expect(passParsed.summary.deceasedMissing).toBe(0);
    expect(passParsed.summary.livingLeaks).toBe(0);
    expect(passParsed.summary.placesTotal).toBe(1);
    expect(passParsed.summary.placesCovered).toBe(1);
    expect(passParsed.summary.placesMissing).toBe(0);

    // 3. Living pronunciation leak fails loudly (even without --strict) and never leaks living name/ID
    const leakedPeople = [
      basePeople[0],
      {
        ...basePeople[1],
        pronunciation: { phonetic: 'LEAKED-GUIDE', language: 'en-US' },
      },
    ];
    fs.writeFileSync(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(leakedPeople), 'utf8');

    const leakOut: string[] = [];
    const leakExit = await runCli(['pronounce', 'audit', '--repo', repoDir, '--json'], {
      io: {
        stdout: (line) => leakOut.push(line),
        stderr: () => {},
      },
    });
    expect(leakExit).toBe(1);
    const leakRaw = leakOut.join('\n');
    expect(leakRaw).not.toContain('HiddenLivingName');
    expect(leakRaw).not.toContain('per_living_hidden');
    const leakParsed = JSON.parse(leakRaw) as {
      ok: boolean;
      summary: { livingLeaks: number };
    };
    expect(leakParsed.ok).toBe(false);
    expect(leakParsed.summary.livingLeaks).toBe(1);
  });
});

describe('kinloom integrate pronunciation support', () => {
  it('accepts person_updates.pronunciation and preserves existing place.pronunciation on partial place upserts', async () => {
    const repoDir = await makeTempDir('kinloom-integrate-pron-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
    const pkgDir = path.join(repoDir, 'research', 'people', 'per_thomas');
    fs.mkdirSync(pkgDir, { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic Integrate Archive',
        familyName: 'Mercer Family',
        gedcomSourceName: 'MERCER_INT',
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml([
        {
          id: 'per_thomas',
          slug: 'thomas-mercer',
          full_name: 'Thomas Mercer',
          given_name: 'Thomas',
          surname: 'Mercer',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1842',
          death_edtf: '1911',
          portrait_url: null,
        },
      ]),
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'data', 'places.yaml'),
      serializePlacesYaml([
        {
          id: 'plc_goes',
          slug: 'goes-netherlands',
          name: 'Goes',
          full_name: 'Goes, Zeeland, Netherlands',
          place_type: 'town',
          parent_id: null,
          lat: 51.5046,
          lng: 3.8889,
          pronunciation: {
            phonetic: 'HOOS',
            ipa: '/ɣus/',
            language: 'nl',
            source_label: 'Wiktionary (Dutch IPA)',
            source_url: 'https://en.wiktionary.org/wiki/Goes',
          },
        },
      ]),
      'utf8'
    );
    for (const emptyYaml of [
      'events.yaml',
      'sources.yaml',
      'kinship.yaml',
      'media.yaml',
      'narratives.yaml',
    ]) {
      fs.writeFileSync(path.join(repoDir, 'data', emptyYaml), '[]\n', 'utf8');
    }

    fs.writeFileSync(
      path.join(pkgDir, 'patch.json'),
      JSON.stringify(
        {
          person_id: 'per_thomas',
          person_updates: {
            pronunciation: {
              phonetic: 'TOM-us MER-ser',
              ipa: '/ˈtɒm.əs ˈmɜːr.sər/',
              language: 'en-US',
              source_label: 'Family oral tradition',
              variants: [
                {
                  label: 'British English',
                  phonetic: 'TOM-us MER-suh',
                  ipa: '/ˈtɒm.əs ˈmɜː.sə/',
                  language: 'en-GB',
                },
              ],
            },
          },
          places: [
            {
              id: 'plc_goes',
              slug: 'goes-netherlands',
              name: 'Goes',
              full_name: 'Goes, Zeeland, Netherlands',
              place_type: 'town',
              parent_id: null,
              lat: 51.5046,
              lng: 3.8889,
              summary: 'Historic market town in Zeeland.',
            },
          ],
        },
        null,
        2
      ),
      'utf8'
    );

    const result = await runIntegrateCommand({
      repoDir,
      personId: 'per_thomas',
      packageDir: pkgDir,
    });
    expect(result.ok).toBe(true);
    expect(result.counts.personUpdated).toBe(true);

    const updatedPeople = parsePeopleYaml(fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    expect(updatedPeople[0]?.pronunciation?.phonetic).toBe('TOM-us MER-ser');
    expect(updatedPeople[0]?.pronunciation?.source_label).toBe('Family oral tradition');
    expect(updatedPeople[0]?.pronunciation?.variants?.[0]?.label).toBe('British English');

    const updatedPlaces = parsePlacesYaml(fs.readFileSync(path.join(repoDir, 'data', 'places.yaml'), 'utf8'));
    expect(updatedPlaces[0]?.summary).toBe('Historic market town in Zeeland.');
    expect(updatedPlaces[0]?.pronunciation).toEqual({
      phonetic: 'HOOS',
      ipa: '/ɣus/',
      language: 'nl',
      source_label: 'Wiktionary (Dutch IPA)',
      source_url: 'https://en.wiktionary.org/wiki/Goes',
    });
  });
});
