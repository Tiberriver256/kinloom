import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseKinloomConfig,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  serializePlacesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../cli.js';
import { runIntegrateCommand } from './integrate.js';
import { buildLookupCachePath, readLookupCache } from './pronounce/lookupCache.js';
import {
  buildCommonsAudioUrl,
  evaluatePronounceCorroboration,
  extractMediaWikiPronunciations,
  rankPronounceSources,
  runPronounceAuditCommand,
  runPronounceDeduplicateCommand,
  runPronounceLookupCommand,
} from './pronounce.js';
import { runPronunciationAuditCheck, runPronunciationVerifyCheck } from './pronunciation-checks.js';

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

    const autoOnly = evaluatePronounceCorroboration([ranked[2]!]);
    expect(autoOnly.highestTier).toBe('automated');
    expect(autoOnly.native_speaker_verified).toBe(false);
    expect(autoOnly.verification_note).toContain('automated');
  });

  it('rejects partial or corrupt disk cache entries via Zod and re-fetches cleanly without crashing text formatting', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-corrupt-cache-');
    const cachePath = buildLookupCachePath({
      cacheDir,
      term: 'Goes',
      normalizedLang: 'nl',
      normalizedRegion: null,
      hasForvoKey: false,
    });

    fs.writeFileSync(cachePath, JSON.stringify({ term: 'x' }), 'utf8');
    expect(readLookupCache(cachePath)).toBeNull();

    const mockFetch = vi.fn<typeof fetch>(async () => {
      return new Response(JSON.stringify({ query: { pages: [{ title: 'Goes', missing: true }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const recovered = await runPronounceLookupCommand({
      term: 'Goes',
      lang: 'nl',
      json: false,
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
      nowIso: () => '2026-11-27T04:00:00.000Z',
    });

    expect(recovered.cache_hit).toBe(false);
    expect(recovered.rendered).toContain('Pronunciation lookup: Goes [nl]');
    expect(mockFetch).toHaveBeenCalled();

    const reparsed = readLookupCache(cachePath);
    expect(reparsed).not.toBeNull();
    expect(reparsed?.term).toBe('Goes');
  });

  it('skips malformed MediaWiki payloads (non-array pages, null entries, non-string titles) without throwing', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-bad-wiki-');
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://nl.wiktionary.org/')) {
        return new Response(JSON.stringify({ query: { pages: { '1': { title: 'Goes' } } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://en.wiktionary.org/')) {
        return new Response(JSON.stringify({ query: { pages: [null] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://nl.wikipedia.org/')) {
        return new Response(
          JSON.stringify({
            query: {
              pages: [{ title: 123, revisions: [{ slots: { main: { content: '{{IPA|nl|/ɣus/}}' } } }] }],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          query: {
            pages: [
              {
                title: 'Goes',
                revisions: [{ slots: { main: { content: 'Goes ({{IPA-nl|ɣus}})' } } }],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const result = await runPronounceLookupCommand({
      term: 'Goes',
      lang: 'nl',
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
      nowIso: () => '2026-11-27T04:30:00.000Z',
    });

    expect(result.verified).toBe(true);
    expect(result.primary_ipa).toBe('/ɣus/');
    expect(result.sources.filter((s) => s.status === 'verified').map((s) => s.site)).toEqual([
      'en.wikipedia.org',
    ]);
  });

  it('reports Forvo status error and leaks no audio hits when Forvo returns malformed item field types', async () => {
    const cacheDir = await makeTempDir('kinloom-pron-bad-forvo-');
    const mockFetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://apifree.forvo.com/')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 'not-a-number',
                pathmp3: 12345,
                username: { nested: true },
                num_positive_votes: 'five',
              },
            ],
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
      forvoApiKey: 'test-forvo-key',
      cacheDir,
      fetchImpl: mockFetch,
      sleepFn: async () => {},
      nowIso: () => '2026-11-27T04:30:00.000Z',
    });

    const forvoSource = result.sources.find((s) => s.provider === 'forvo');
    expect(forvoSource?.status).toBe('error');
    expect(forvoSource?.audio_files).toEqual([]);
    expect(result.audio_files).toEqual([]);
    expect(result.verified).toBe(false);

    const cachePath = buildLookupCachePath({
      cacheDir,
      term: 'Zeeland',
      normalizedLang: 'nl',
      normalizedRegion: null,
      hasForvoKey: true,
    });
    const cached = readLookupCache(cachePath);
    expect(cached).not.toBeNull();
    expect(cached?.audio_files).toEqual([]);
    expect(cached?.sources.find((s) => s.provider === 'forvo')?.status).toBe('error');
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
      basePeople[0]!,
      {
        ...basePeople[1]!,
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

describe('IPA-in-phonetic audit checks and kinloom pronounce deduplicate', () => {
  it('flags IPA glyphs and /.../ notation inside phonetic across pronounce audit --strict, audit --strict, and verify', async () => {
    const repoDir = await makeTempDir('kinloom-pron-ipa-phonetic-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic IPA Phonetic Audit',
        familyName: 'Alder Family',
        gedcomSourceName: 'ALDER_IPA_TEST',
      },
      pronunciations: {
        Daniel: {
          phonetic: 'DAN-yəl',
          ipa: '/ˈdæn.jəl/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
        Alder: {
          phonetic: '/ˈɔːl.dər/',
          ipa: '/ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'data', 'people.yaml'),
      serializePeopleYaml([
        {
          id: 'per_daniel',
          slug: 'daniel-alder',
          full_name: 'Daniel Alder',
          given_name: 'Daniel',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'pivot_ancestor',
          birth_edtf: '1835',
          death_edtf: '1908',
          portrait_url: null,
        },
      ]),
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');

    // 1. pronounce audit --strict fails when phonetic contains IPA glyphs or /.../
    const strictAudit = runPronounceAuditCommand({ repoDir, strict: true, json: true });
    expect(strictAudit.ok).toBe(false);
    expect(strictAudit.strictOk).toBe(false);
    const ipaPhoneticWarnings = strictAudit.ipa_quality_warnings.filter((w) => w.code === 'ipa_in_phonetic');
    expect(ipaPhoneticWarnings.map((w) => w.key)).toEqual(['Alder', 'Daniel']);
    expect(ipaPhoneticWarnings[0]?.ipa_glyphs).toEqual(['ˈ', 'ɔ', 'ː', 'ə', '/.../']);
    expect(ipaPhoneticWarnings[1]?.ipa_glyphs).toEqual(['ə']);

    // 2. verify pronunciation check reports them as warnings & strictFailures
    const verifyRes = runPronunciationVerifyCheck({
      repoDir,
      dataDir: path.join(repoDir, 'data'),
      siteConfig: config,
      people: [],
      places: [],
      events: [],
      sources: [],
      kinship: [],
      media: [],
      narratives: [],
      strictHygiene: false,
      strictPronunciation: true,
    });
    expect(verifyRes.warnings.some((w) => w.includes('DAN-yəl'))).toBe(true);
    expect(verifyRes.strictFailures?.some((w) => w.includes('/ˈɔːl.dər/'))).toBe(true);

    // 3. audit --strict (runPronunciationAuditCheck) rejects newly staged phonetic fields containing IPA glyphs
    const stagedAudit = runPronunciationAuditCheck({
      repoDir,
      personId: 'per_daniel',
      packageDir: repoDir,
      dossierText: '',
      siteConfig: config,
      targetPerson: {
        id: 'per_daniel',
        full_name: 'Daniel Alder',
        given_name: 'Daniel',
        surname: 'Alder',
        is_living: false,
      },
      livePeople: [],
      mergedPeople: [],
      patch: {
        person_updates: {
          pronunciation: {
            phonetic: 'DAN-yəl AWL-der',
            ipa: '/ˈdæn.jəl ˈɔːl.dər/',
            source_label: 'Wiktionary',
          },
        },
        places: [
          {
            id: 'plc_leiden',
            name: 'Leiden',
            full_name: 'Leiden, Netherlands',
            pronunciation: {
              phonetic: 'ˈlɛi.dən',
              ipa: '/ˈlɛi.dən/',
              source_label: 'Wiktionary',
            },
          },
        ],
      },
    });
    expect(stagedAudit.warnings.some((w) => w.includes('DAN-yəl AWL-der'))).toBe(true);
    expect(stagedAudit.strictFailures?.some((w) => w.includes('DAN-yəl AWL-der'))).toBe(true);
    expect(stagedAudit.strictFailures?.some((w) => w.includes('ˈlɛi.dən'))).toBe(true);

    // 4. Fixing phonetic to plain English syllables makes pronounce audit --strict pass
    const cleanConfig = parseKinloomConfig({
      ...config,
      pronunciations: {
        Daniel: {
          phonetic: 'DAN-yuhl',
          ipa: '/ˈdæn.jəl/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
        Alder: {
          phonetic: 'AWL-der',
          ipa: '/ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    });
    fs.writeFileSync(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(cleanConfig),
      'utf8'
    );
    const cleanStrict = runPronounceAuditCommand({ repoDir, strict: true, json: true });
    expect(cleanStrict.ok).toBe(true);
    expect(cleanStrict.strictOk).toBe(true);
    expect(cleanStrict.ipa_quality_warnings).toEqual([]);
  });

  it('conservatively deduplicates redundant per-person overrides in dry-run and --apply without losing unique data or exposing living people', async () => {
    const repoDir = await makeTempDir('kinloom-pron-dedupe-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic Dedupe Archive',
        familyName: 'Alder Family',
        gedcomSourceName: 'ALDER_DEDUPE',
      },
      pronunciations: {
        Daniel: {
          phonetic: 'DAN-yuhl',
          ipa: '/ˈdæn.jəl/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
        Alder: {
          phonetic: 'AWL-der',
          ipa: '/ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

    const initialPeople = [
      {
        id: 'per_redundant',
        slug: 'daniel-alder',
        full_name: 'Daniel Alder',
        given_name: 'Daniel',
        surname: 'Alder',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'pivot_ancestor' as const,
        birth_edtf: '1835',
        death_edtf: '1908',
        portrait_url: null,
        pronunciation: {
          phonetic: 'DAN-yuhl AWL-der',
          ipa: '/ˈdæn.jəl ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_unique_note',
        slug: 'daniel-alder-note',
        full_name: 'Daniel Alder',
        given_name: 'Daniel',
        surname: 'Alder',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1810',
        death_edtf: '1880',
        portrait_url: null,
        pronunciation: {
          phonetic: 'DAN-yuhl AWL-der',
          ipa: '/ˈdæn.jəl ˈɔːl.dər/',
          note: 'Family pronounced softly in Pennsylvania branch',
          source_label: 'Family oral tradition',
        },
      },
      {
        id: 'per_different_guide',
        slug: 'daniel-alder-alt',
        full_name: 'Daniel Alder',
        given_name: 'Daniel',
        surname: 'Alder',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'collateral' as const,
        birth_edtf: '1840',
        death_edtf: '1905',
        portrait_url: null,
        pronunciation: {
          phonetic: 'DAN-yuhl AHL-der',
          language: 'en-US',
          source_label: 'Family oral tradition',
        },
      },
      {
        id: 'per_missing_middle',
        slug: 'daniel-anderson-alder',
        full_name: 'Daniel Anderson Alder',
        given_name: 'Daniel Anderson',
        surname: 'Alder',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1855',
        death_edtf: '1922',
        portrait_url: null,
        pronunciation: {
          phonetic: 'DAN-yuhl AN-der-sun AWL-der',
          ipa: '/ˈdæn.jəl ˈæn.dər.sən ˈɔːl.dər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_living_private',
        slug: 'living-private',
        full_name: 'Casey SecretLivingAlder',
        given_name: 'Casey',
        surname: 'SecretLivingAlder',
        alt_names: [],
        sex: 'U' as const,
        is_living: true,
        lineage_group: 'descendant' as const,
        birth_edtf: '1999',
        death_edtf: '',
        portrait_url: null,
      },
    ];
    fs.writeFileSync(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(initialPeople), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');

    // Dry-run by default: identifies per_redundant, keeps note/different/missing-middle, writes 0 files
    const dryRun = runPronounceDeduplicateCommand({ repoDir, json: true });
    expect(dryRun.applied).toBe(false);
    expect(dryRun.files_written).toEqual([]);
    expect(dryRun.summary.living_people_excluded).toBe(1);
    expect(dryRun.removable_overrides.map((r) => r.id)).toEqual(['per_redundant']);
    expect(dryRun.kept_overrides.map((k) => ({ id: k.id, reason: k.reason }))).toEqual([
      { id: 'per_different_guide', reason: 'pronunciation_differs' },
      { id: 'per_unique_note', reason: 'has_unique_note' },
      { id: 'per_missing_middle', reason: 'would_drop_coverage' },
    ]);
    expect(dryRun.rendered).not.toContain('SecretLivingAlder');
    expect(dryRun.rendered).not.toContain('per_living_private');

    // Audit also surfaces the redundant person override without breaking --strict
    const auditBefore = runPronounceAuditCommand({ repoDir, json: true });
    expect(auditBefore.summary.redundant_person_overrides).toBe(1);
    expect(auditBefore.redundant_person_overrides[0]?.id).toBe('per_redundant');

    // --promote-tokens --apply promotes Anderson cleanly and removes both per_redundant and per_missing_middle
    const out: string[] = [];
    const exitCode = await runCli(
      ['pronounce', 'deduplicate', '--repo', repoDir, '--promote-tokens', '--apply', '--json'],
      {
        io: {
          stdout: (line) => out.push(line),
          stderr: () => {},
        },
      }
    );
    expect(exitCode).toBe(0);
    const cliResult = JSON.parse(out.join('\n')) as {
      applied: boolean;
      files_written: string[];
      promoted_tokens: Array<{ term: string; phonetic?: string; ipa?: string }>;
      removable_overrides: Array<{ id: string }>;
      kept_overrides: Array<{ id: string; reason: string }>;
    };
    expect(cliResult.applied).toBe(true);
    expect(cliResult.files_written).toEqual(['kinloom.config.yaml', 'data/people.yaml']);
    expect(cliResult.promoted_tokens).toEqual([
      {
        term: 'Anderson',
        phonetic: 'AN-der-sun',
        ipa: '/ˈæn.dər.sən/',
        language: 'en-US',
        source_person_id: 'per_missing_middle',
      },
    ]);
    expect(cliResult.removable_overrides.map((r) => r.id)).toEqual(['per_redundant', 'per_missing_middle']);
    expect(cliResult.kept_overrides.map((k) => k.id)).toEqual(['per_different_guide', 'per_unique_note']);

    // Verify persisted YAML on disk
    const reloadedPeople = parsePeopleYaml(
      fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8')
    );
    const byId = new Map(reloadedPeople.map((p) => [p.id, p]));
    expect(byId.get('per_redundant')?.pronunciation).toBeUndefined();
    expect(byId.get('per_missing_middle')?.pronunciation).toBeUndefined();
    expect(byId.get('per_unique_note')?.pronunciation?.note).toBe(
      'Family pronounced softly in Pennsylvania branch'
    );
    expect(byId.get('per_different_guide')?.pronunciation?.phonetic).toBe('DAN-yuhl AHL-der');

    // Archive still has 100% strict full-name coverage after deduplication!
    const auditAfter = runPronounceAuditCommand({ repoDir, strict: true, json: true });
    expect(auditAfter.ok).toBe(true);
    expect(auditAfter.strictOk).toBe(true);
    expect(auditAfter.summary.redundant_person_overrides).toBe(0);
  });

  it('extracts clean phonetic and IPA tokens across middle initials, leading initials, and hyphenated respellings without leaking initial segments', async () => {
    const repoDir = await makeTempDir('kinloom-pron-middle-initial-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic Middle Initial Archive',
        familyName: 'Doe Vance Archive',
        gedcomSourceName: 'SYNTHETIC_INITIALS',
      },
      pronunciations: {
        Doe: {
          phonetic: 'DOH',
          ipa: '/doʊ/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
        Clara: {
          phonetic: 'KLAIR-uh',
          ipa: '/ˈklɛə.rə/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
        Mercer: {
          phonetic: 'MER-ser',
          ipa: '/ˈmɜːr.sər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

    const people = [
      {
        id: 'per_jane_m',
        slug: 'jane-m-doe',
        full_name: 'Jane M. Doe',
        given_name: 'Jane M.',
        surname: 'Doe',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1850',
        death_edtf: '1920',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAYN em DOH',
          ipa: '/ˈdʒeɪn ˈɛm doʊ/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_jane_plain',
        slug: 'jane-doe',
        full_name: 'Jane Doe',
        given_name: 'Jane',
        surname: 'Doe',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'collateral' as const,
        birth_edtf: '1852',
        death_edtf: '1922',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAYN DOH',
          ipa: '/ˈdʒeɪn doʊ/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_jane_r_nopunct',
        slug: 'jane-r-doe',
        full_name: 'Jane R Doe',
        given_name: 'Jane R',
        surname: 'Doe',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'collateral' as const,
        birth_edtf: '1854',
        death_edtf: '1924',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAYN, R. DOH',
          ipa: 'dʒeɪn ɑːr doʊ',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_clara_q_sterling',
        slug: 'clara-q-sterling',
        full_name: 'Clara Q. Sterling',
        given_name: 'Clara Q.',
        surname: 'Sterling',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1848',
        death_edtf: '1918',
        portrait_url: null,
        pronunciation: {
          phonetic: 'KLAIR-uh KYOO STER-ling',
          ipa: '/ˈklɛə.rə kjuː ˈstɜːr.lɪŋ/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_j_arthur_doe',
        slug: 'j-arthur-doe',
        full_name: 'J. Arthur Doe',
        given_name: 'J. Arthur',
        surname: 'Doe',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1845',
        death_edtf: '1915',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAY AR-ther DOH',
          ipa: '/ˈdʒeɪ ˈɑːr.θər doʊ/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_j_r_vance',
        slug: 'j-r-vance',
        full_name: 'J. R. Vance',
        given_name: 'J. R.',
        surname: 'Vance',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1840',
        death_edtf: '1909',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAY AR VANS',
          ipa: '/dʒeɪ ɑːr væns/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_owen_w_mercer',
        slug: 'owen-w-mercer',
        full_name: 'Owen W. Mercer',
        given_name: 'Owen W.',
        surname: 'Mercer',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1860',
        death_edtf: '1930',
        portrait_url: null,
        pronunciation: {
          phonetic: 'OH-en DUB-uhl-yoo MER-ser',
          ipa: '/ˈoʊ.ən ˈdʌb.əl.juː ˈmɜːr.sər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_mary_e_mercer',
        slug: 'mary-e-mercer',
        full_name: 'Mary E. Mercer',
        given_name: 'Mary E.',
        surname: 'Mercer',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1862',
        death_edtf: '1932',
        portrait_url: null,
        pronunciation: {
          phonetic: 'MAIR-ee MER-ser',
          ipa: '/ˈmɛə.ɹi ˈmɜːr.sər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_thomas_b_mercer',
        slug: 'thomas-b-mercer',
        full_name: 'Thomas B Mercer',
        given_name: 'Thomas B',
        surname: 'Mercer',
        alt_names: [],
        sex: 'M' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1864',
        death_edtf: '1934',
        portrait_url: null,
        pronunciation: {
          phonetic: 'TOM-us BEE MER-ser',
          ipa: '/ˈtɒm.əs ˈbiː ˈmɜːr.sər/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    ];
    fs.writeFileSync(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(people), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');

    const dedupeOut: string[] = [];
    const dedupeExit = await runCli(
      ['pronounce', 'deduplicate', '--repo', repoDir, '--promote-tokens', '--apply', '--json'],
      {
        io: {
          stdout: (line) => dedupeOut.push(line),
          stderr: () => {},
        },
      }
    );
    expect(dedupeExit).toBe(0);

    const dedupeResult = JSON.parse(dedupeOut.join('\n')) as {
      applied: boolean;
      promoted_tokens: Array<{ term: string; phonetic?: string; ipa?: string; language?: string }>;
      skipped_promotions: Array<{ term: string; reason: string }>;
      removable_overrides: Array<{ id: string }>;
      kept_overrides: Array<{ id: string; reason: string }>;
    };

    expect(dedupeResult.applied).toBe(true);
    expect(dedupeResult.skipped_promotions).toEqual([]);
    expect(dedupeResult.promoted_tokens).toEqual([
      {
        term: 'Arthur',
        phonetic: 'AR-ther',
        ipa: '/ˈɑːr.θər/',
        language: 'en-US',
        source_person_id: 'per_j_arthur_doe',
      },
      {
        term: 'Jane',
        phonetic: 'JAYN',
        ipa: '/ˈdʒeɪn/',
        language: 'en-US',
        source_person_id: 'per_jane_m',
      },
      {
        term: 'Mary',
        phonetic: 'MAIR-ee',
        ipa: '/ˈmɛə.ɹi/',
        language: 'en-US',
        source_person_id: 'per_mary_e_mercer',
      },
      {
        term: 'Owen',
        phonetic: 'OH-en',
        ipa: '/ˈoʊ.ən/',
        language: 'en-US',
        source_person_id: 'per_owen_w_mercer',
      },
      {
        term: 'Sterling',
        phonetic: 'STER-ling',
        ipa: '/ˈstɜːr.lɪŋ/',
        language: 'en-US',
        source_person_id: 'per_clara_q_sterling',
      },
      {
        term: 'Thomas',
        phonetic: 'TOM-us',
        ipa: '/ˈtɒm.əs/',
        language: 'en-US',
        source_person_id: 'per_thomas_b_mercer',
      },
      {
        term: 'Vance',
        phonetic: 'VANS',
        ipa: '/væns/',
        language: 'en-US',
        source_person_id: 'per_j_r_vance',
      },
    ]);
    expect(dedupeResult.kept_overrides).toEqual([]);
    expect(dedupeResult.removable_overrides.map((r) => r.id).toSorted()).toEqual([
      'per_clara_q_sterling',
      'per_j_arthur_doe',
      'per_j_r_vance',
      'per_jane_m',
      'per_jane_plain',
      'per_jane_r_nopunct',
      'per_mary_e_mercer',
      'per_owen_w_mercer',
      'per_thomas_b_mercer',
    ]);

    const auditOut: string[] = [];
    const auditExit = await runCli(['pronounce', 'audit', '--repo', repoDir, '--strict', '--json'], {
      io: {
        stdout: (line) => auditOut.push(line),
        stderr: () => {},
      },
    });
    expect(auditExit).toBe(0);
    const auditParsed = JSON.parse(auditOut.join('\n')) as {
      ok: boolean;
      strictOk: boolean;
      ipa_quality_warnings: unknown[];
      redundant_person_overrides: unknown[];
      summary: {
        deceasedTotal: number;
        deceasedFullCoverage: number;
        deceasedPartialOnly: number;
        deceasedMissing: number;
      };
    };
    expect(auditParsed.ok).toBe(true);
    expect(auditParsed.strictOk).toBe(true);
    expect(auditParsed.ipa_quality_warnings).toEqual([]);
    expect(auditParsed.redundant_person_overrides).toEqual([]);
    expect(auditParsed.summary.deceasedTotal).toBe(9);
    expect(auditParsed.summary.deceasedFullCoverage).toBe(9);
    expect(auditParsed.summary.deceasedPartialOnly).toBe(0);
    expect(auditParsed.summary.deceasedMissing).toBe(0);

    const persistedConfig = parseKinloomConfigYaml(
      fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')
    );
    expect(persistedConfig.pronunciations?.['Jane']).toEqual({
      phonetic: 'JAYN',
      ipa: '/ˈdʒeɪn/',
      language: 'en-US',
      source_label: 'Wiktionary',
    });
    expect(persistedConfig.pronunciations?.['Sterling']).toEqual({
      phonetic: 'STER-ling',
      ipa: '/ˈstɜːr.lɪŋ/',
      language: 'en-US',
      source_label: 'Wiktionary',
    });
    expect(persistedConfig.pronunciations?.['Thomas']).toEqual({
      phonetic: 'TOM-us',
      ipa: '/ˈtɒm.əs/',
      language: 'en-US',
      source_label: 'Wiktionary',
    });
    const persistedPeople = parsePeopleYaml(
      fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8')
    );
    expect(persistedPeople.every((p) => p.pronunciation === undefined)).toBe(true);
  });

  it('still flags genuine pronunciation conflicts and refuses to merge an expanded middle name into a given-name token', async () => {
    const repoDir = await makeTempDir('kinloom-pron-genuine-conflict-');
    fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });

    const config = parseKinloomConfig({
      site: {
        title: 'Synthetic Conflict Archive',
        familyName: 'Vance Family',
        gedcomSourceName: 'VANCE_CONFLICT',
      },
      pronunciations: {
        Vance: {
          phonetic: 'VANS',
          ipa: '/væns/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
    });
    fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

    const people = [
      {
        id: 'per_clara_us',
        slug: 'clara-vance-us',
        full_name: 'Clara Vance',
        given_name: 'Clara',
        surname: 'Vance',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'ancestor' as const,
        birth_edtf: '1850',
        death_edtf: '1920',
        portrait_url: null,
        pronunciation: {
          phonetic: 'KLAIR-uh VANS',
          ipa: '/ˈklɛə.rə væns/',
          language: 'en-US',
          source_label: 'Wiktionary',
        },
      },
      {
        id: 'per_clara_alt',
        slug: 'clara-b-vance-alt',
        full_name: 'Clara B. Vance',
        given_name: 'Clara B.',
        surname: 'Vance',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'collateral' as const,
        birth_edtf: '1855',
        death_edtf: '1925',
        portrait_url: null,
        pronunciation: {
          phonetic: 'KLAH-ruh BEE VANS',
          ipa: '/ˈklɑː.rə biː væns/',
          language: 'en-US',
          source_label: 'Family oral tradition',
        },
      },
      {
        id: 'per_evelyn_expanded_middle',
        slug: 'evelyn-m-vance',
        full_name: 'Evelyn M. Vance',
        given_name: 'Evelyn M.',
        surname: 'Vance',
        alt_names: [],
        sex: 'F' as const,
        is_living: false,
        lineage_group: 'collateral' as const,
        birth_edtf: '1860',
        death_edtf: '1930',
        portrait_url: null,
        pronunciation: {
          phonetic: 'EV-uh-lin MAH-ree VANS',
          ipa: '/ˈɛv.ə.lɪn məˈriː væns/',
          language: 'en-US',
          source_label: 'Family oral tradition',
        },
      },
    ];
    fs.writeFileSync(path.join(repoDir, 'data', 'people.yaml'), serializePeopleYaml(people), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'data', 'places.yaml'), serializePlacesYaml([]), 'utf8');

    const result = runPronounceDeduplicateCommand({ repoDir, promoteTokens: true, json: true });
    expect(result.promoted_tokens).toEqual([]);
    expect(result.skipped_promotions).toEqual([
      {
        term: 'Clara',
        reason: 'conflicting_candidates',
        source_person_ids: ['per_clara_us', 'per_clara_alt'],
      },
    ]);
    expect(result.kept_overrides.map((k) => k.id).toSorted()).toEqual([
      'per_clara_alt',
      'per_clara_us',
      'per_evelyn_expanded_middle',
    ]);
  });
});
