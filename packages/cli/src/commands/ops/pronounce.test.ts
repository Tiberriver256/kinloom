import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parsePeopleYaml,
  parsePlacesYaml,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  parseKinloomConfig,
} from '@kinloom/core';
import { runCli } from '../../cli.js';
import { runIntegrateCommand } from './integrate.js';
import {
  buildCommonsAudioUrl,
  extractMediaWikiPronunciations,
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
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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

      return new Response(
        JSON.stringify({ query: { pages: [{ title: 'Goes', missing: true }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
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
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
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
      return new Response(
        JSON.stringify({ query: { pages: [{ title: 'Mercer', missing: true }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
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
    const emptyFetch = vi.fn<typeof fetch>(async () =>
      new Response(
        JSON.stringify({ query: { pages: [{ title: 'Nonexistenthamlet', missing: true }] } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const missing = await runPronounceLookupCommand({
      term: 'Nonexistenthamlet',
      lang: 'en',
      cacheDir,
      fetchImpl: emptyFetch,
      sleepFn: async () => {},
    });
    expect(missing.verified).toBe(false);
    expect(missing.ipa).toEqual([]);
    expect(missing.primary_ipa).toBeNull();
    expect(missing.source_url).toBeNull();
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
    fs.writeFileSync(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(config),
      'utf8'
    );

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
    const warningCodesByKey = new Map(
      audit.ipa_quality_warnings.map((w) => [`${w.key}:${w.code}`, w])
    );
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
      summary: { homonymous_place_collisions: number };
    };
    expect(parsedCli.summary.homonymous_place_collisions).toBe(1);
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
    fs.writeFileSync(
      path.join(repoDir, 'kinloom.config.yaml'),
      serializeKinloomConfigYaml(config),
      'utf8'
    );
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
    for (const emptyYaml of ['events.yaml', 'sources.yaml', 'kinship.yaml', 'media.yaml', 'narratives.yaml']) {
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

    const updatedPeople = parsePeopleYaml(
      fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8')
    );
    expect(updatedPeople[0]?.pronunciation?.phonetic).toBe('TOM-us MER-ser');
    expect(updatedPeople[0]?.pronunciation?.source_label).toBe('Family oral tradition');
    expect(updatedPeople[0]?.pronunciation?.variants?.[0]?.label).toBe('British English');

    const updatedPlaces = parsePlacesYaml(
      fs.readFileSync(path.join(repoDir, 'data', 'places.yaml'), 'utf8')
    );
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
