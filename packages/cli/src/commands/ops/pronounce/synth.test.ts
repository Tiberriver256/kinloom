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
import { runCli } from '../../../cli.js';
import { CliValidationError } from '../../../errors.js';
import { type AudioExecFileFn, pronunciationAudioFilename } from '../shared/audio/index.js';
import { type PronounceBatchManifest, runPronounceSynthCommand, wrapPcmAsWav } from './synth.js';
import { collectPronounceSynthTargets } from './synthTargets.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'kinloom-pron-synth-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function createSyntheticArchive(repoDir: string, options?: { includeLivingLeak?: boolean }): void {
  fs.mkdirSync(path.join(repoDir, 'data'), { recursive: true });
  const config = parseKinloomConfig({
    site: {
      title: 'Synthetic Oakville Archive',
      familyName: 'Van der Meer Family',
      gedcomSourceName: 'OAKVILLE_SYNTH',
    },
    privacy: {
      livingCutoffYears: 101,
      referenceYear: 2026,
    },
    pronunciations: {
      'Hendrik van der Meer': {
        phonetic: 'HEN-drik vahn der MAIR',
        ipa: '/ˈɦɛn.drɪk vɑn dɛr meːr/',
        language: 'nl',
        source_label: 'Synthetic test guide',
      },
      Oakville: {
        phonetic: 'OHK-vil',
        ipa: '/ˈoʊk.vɪl/',
        language: 'en-US',
        audio_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/En-us-Oakville.ogg',
        source_label: 'Wikimedia Commons',
      },
    },
  });
  fs.writeFileSync(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(config), 'utf8');

  fs.writeFileSync(
    path.join(repoDir, 'data', 'people.yaml'),
    serializePeopleYaml([
      {
        id: 'per_jane',
        slug: 'jane-doe',
        full_name: 'Jane Doe',
        given_name: 'Jane',
        surname: 'Doe',
        alt_names: [],
        sex: 'F',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1855',
        death_edtf: '1924',
        portrait_url: null,
        pronunciation: {
          phonetic: 'JAYN DOH',
          ipa: '/dʒeɪn doʊ/',
          language: 'en-US',
        },
      },
      {
        id: 'per_hendrik',
        slug: 'hendrik-van-der-meer',
        full_name: 'Hendrik van der Meer',
        given_name: 'Hendrik',
        surname: 'van der Meer',
        alt_names: [],
        sex: 'M',
        is_living: false,
        lineage_group: 'pivot_ancestor',
        birth_edtf: '1840',
        death_edtf: '1912',
        portrait_url: null,
      },
      {
        id: 'per_living_case',
        slug: 'living-person',
        full_name: 'Alex PrivateLiving',
        given_name: 'Alex',
        surname: 'PrivateLiving',
        alt_names: [],
        sex: 'U',
        is_living: true,
        lineage_group: 'descendant',
        birth_edtf: '1995',
        death_edtf: '',
        portrait_url: null,
        ...(options?.includeLivingLeak ? { pronunciation: { phonetic: 'PRY-vit', ipa: '/ˈpraɪ.vɪt/' } } : {}),
      },
    ]),
    'utf8'
  );

  fs.writeFileSync(
    path.join(repoDir, 'data', 'places.yaml'),
    serializePlacesYaml([
      {
        id: 'plc_oakville',
        slug: 'oakville',
        name: 'Oakville',
        full_name: 'Oakville, Ontario, Canada',
        place_type: 'town',
        parent_id: null,
        lat: 43.4675,
        lng: -79.6877,
      },
      {
        id: 'plc_harbor',
        slug: 'harbor-town',
        name: 'Harbortown',
        full_name: 'Harbortown, Michigan, United States',
        place_type: 'town',
        parent_id: null,
        lat: 42.78,
        lng: -86.11,
        pronunciation: {
          phonetic: 'HAR-ber-town',
          ipa: '/ˈhɑːr.bər.taʊn/',
          language: 'en-US',
        },
      },
      {
        id: 'plc_ungeocoded',
        slug: 'ungeocoded-spot',
        name: 'ZeroPlace',
        full_name: 'ZeroPlace',
        place_type: 'town',
        parent_id: null,
        lat: 0,
        lng: 0,
      },
    ]),
    'utf8'
  );
}

describe('kinloom pronounce synth', () => {
  it('enforces the living privacy fence and deduplicates targets across scopes', async () => {
    const cleanRepo = await makeTempDir('kinloom-pron-clean-');
    createSyntheticArchive(cleanRepo);

    const lexiconOnly = collectPronounceSynthTargets({
      repoDir: cleanRepo,
      scope: 'lexicon',
      voice: 'Charon',
      format: 'wav',
      phonemeMode: 'ipa',
    });
    expect(lexiconOnly.livingExcluded).toBe(1);
    expect(lexiconOnly.targets.map((t) => t.id)).toEqual([
      'lexicon:Hendrik van der Meer',
      'lexicon:Oakville',
    ]);
    expect(JSON.stringify(lexiconOnly.targets)).not.toContain('PrivateLiving');

    const curated = collectPronounceSynthTargets({
      repoDir: cleanRepo,
      scope: 'curated',
      voice: 'Charon',
      format: 'wav',
      phonemeMode: 'ipa',
    });
    expect(curated.targets.map((t) => t.id)).toEqual([
      'lexicon:Hendrik van der Meer',
      'lexicon:Oakville',
      'place:plc_harbor',
      'person:per_jane',
    ]);

    const allScope = collectPronounceSynthTargets({
      repoDir: cleanRepo,
      scope: 'all',
      voice: 'Charon',
      format: 'wav',
      phonemeMode: 'ipa',
    });
    // Oakville place resolves to the exact same v2 cache key as the Oakville lexicon entry and deduplicates
    expect(allScope.deduplicatedCount).toBe(1);
    expect(allScope.targets.map((t) => t.id)).toEqual([
      'lexicon:Hendrik van der Meer',
      'lexicon:Oakville',
      'place:plc_harbor',
      'person:per_jane',
    ]);

    const leakyRepo = await makeTempDir('kinloom-pron-leaky-');
    createSyntheticArchive(leakyRepo, { includeLivingLeak: true });
    expect(() =>
      collectPronounceSynthTargets({
        repoDir: leakyRepo,
        scope: 'curated',
        voice: 'Charon',
        format: 'wav',
        phonemeMode: 'ipa',
      })
    ).toThrow(CliValidationError);
  });

  it('exports privacy-filtered Colab manifests, imports rendered clips, and updates kinloom.config.yaml conservatively', async () => {
    const repoDir = await makeTempDir('kinloom-pron-manifest-');
    createSyntheticArchive(repoDir);
    const manifestPath = path.join(repoDir, 'tmp', 'pronounce-manifest.json');

    const exported = await runPronounceSynthCommand({
      repoDir,
      backend: 'openai-speech',
      phonemeMode: 'arpabet',
      exportManifestPath: manifestPath,
      nowIso: () => '2026-11-27T12:00:00.000Z',
    });
    expect(exported.mode).toBe('export_manifest');
    expect(exported.summary.total_targets).toBe(4);
    expect(exported.summary.living_people_excluded).toBe(1);
    expect(exported.rendered).toContain('Manifest written:');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PronounceBatchManifest;
    expect(manifest.kind).toBe('kinloom-pronounce-manifest');
    expect(manifest.model).toBe('fishaudio/drama-3');
    expect(manifest.living_people_excluded).toBe(1);
    expect(JSON.stringify(manifest)).not.toContain('PrivateLiving');

    const hendrikTarget = manifest.targets.find((t) => t.key === 'Hendrik van der Meer');
    const oakvilleTarget = manifest.targets.find((t) => t.key === 'Oakville');
    expect(hendrikTarget?.filename).toBe(
      pronunciationAudioFilename({
        text: 'Hendrik van der Meer',
        phonetic: 'HEN-drik vahn der MAIR',
        ipa: '/ˈɦɛn.drɪk vɑn dɛr meːr/',
        language: 'nl',
        voice: 'Charon',
        ext: 'wav',
      })
    );
    expect(oakvilleTarget?.speech_input).toBe('<|phoneme_start|>OW1 K V IH0 L<|phoneme_end|>');

    // Simulate Colab rendering two of the four targets
    const importDir = path.join(repoDir, 'colab-out');
    fs.mkdirSync(importDir, { recursive: true });
    fs.writeFileSync(path.join(importDir, hendrikTarget!.filename), Buffer.from('RIFF-hendrik'));
    fs.writeFileSync(path.join(importDir, oakvilleTarget!.filename), Buffer.from('RIFF-oakville'));

    const imported = await runPronounceSynthCommand({
      repoDir,
      importDir,
      updateConfig: true,
      json: true,
    });
    expect(imported.mode).toBe('import_dir');
    expect(imported.summary.imported).toBe(2);
    expect(imported.summary.missing_import).toBe(2);
    // Only Hendrik updated; Oakville kept its existing Wikimedia audio_url because --force was not set
    expect(imported.config_updated).toBe(true);
    expect(imported.config_entries_updated).toBe(1);

    const updatedConfig = parseKinloomConfigYaml(
      fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')
    );
    expect(updatedConfig.pronunciations?.['Hendrik van der Meer']?.audio_url).toBe(hendrikTarget?.audio_url);
    expect(updatedConfig.pronunciations?.Oakville?.audio_url).toBe(
      'https://commons.wikimedia.org/wiki/Special:FilePath/En-us-Oakville.ogg'
    );

    // Re-importing with --force overwrites existing Oakville audio_url
    const forcedImport = await runPronounceSynthCommand({
      repoDir,
      importDir,
      updateConfig: true,
      force: true,
    });
    expect(forcedImport.summary.imported).toBe(2);
    expect(forcedImport.config_entries_updated).toBe(1);
    expect(forcedImport.updatedConfigEntries).toBe(1);
    expect(forcedImport.updatedPersonEntries).toBe(0);
    expect(forcedImport.updatedPlaceEntries).toBe(0);
    const forcedConfig = parseKinloomConfigYaml(
      fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')
    );
    expect(forcedConfig.pronunciations?.Oakville?.audio_url).toBe(oakvilleTarget?.audio_url);
  });

  it('supports true --dry-run on --import-dir and updates explicit person/place overrides in YAML on --update-config', async () => {
    const repoDir = await makeTempDir('kinloom-pron-overrides-');
    createSyntheticArchive(repoDir);

    const collected = collectPronounceSynthTargets({
      repoDir,
      scope: 'curated',
      voice: 'Charon',
      format: 'wav',
      phonemeMode: 'ipa',
    });
    const importDir = path.join(repoDir, 'colab-all');
    fs.mkdirSync(importDir, { recursive: true });
    for (const target of collected.targets) {
      fs.writeFileSync(path.join(importDir, target.filename), Buffer.from(`RIFF-${target.id}`));
    }

    const configBefore = fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8');
    const peopleBefore = fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8');
    const placesBefore = fs.readFileSync(path.join(repoDir, 'data', 'places.yaml'), 'utf8');

    // True dry-run with --import-dir + --update-config: copies zero WAVs and writes zero YAML files
    const dryImport = await runPronounceSynthCommand({
      repoDir,
      importDir,
      updateConfig: true,
      dryRun: true,
      json: true,
    });
    expect(dryImport.mode).toBe('dry_run');
    expect(dryImport.config_updated).toBe(false);
    expect(dryImport.summary.planned).toBe(4);
    expect(dryImport.summary.imported).toBe(0);
    expect(dryImport.updatedConfigEntries).toBe(1);
    expect(dryImport.updatedPersonEntries).toBe(1);
    expect(dryImport.updatedPlaceEntries).toBe(1);
    expect(fs.existsSync(path.join(repoDir, 'media'))).toBe(false);
    expect(fs.readFileSync(path.join(repoDir, 'kinloom.config.yaml'), 'utf8')).toBe(configBefore);
    expect(fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8')).toBe(peopleBefore);
    expect(fs.readFileSync(path.join(repoDir, 'data', 'places.yaml'), 'utf8')).toBe(placesBefore);

    // Real import updates kinloom.config.yaml + explicit person.pronunciation + explicit place.pronunciation
    const realImport = await runPronounceSynthCommand({
      repoDir,
      importDir,
      updateConfig: true,
    });
    expect(realImport.mode).toBe('import_dir');
    expect(realImport.config_updated).toBe(true);
    expect(realImport.updatedConfigEntries).toBe(1);
    expect(realImport.updatedPersonEntries).toBe(1);
    expect(realImport.updatedPlaceEntries).toBe(1);
    expect(realImport.rendered).toContain('Updated data/people.yaml audio_url entries: 1');
    expect(realImport.rendered).toContain('Updated data/places.yaml audio_url entries: 1');

    const janeTarget = collected.targets.find((t) => t.id === 'person:per_jane');
    const harborTarget = collected.targets.find((t) => t.id === 'place:plc_harbor');
    const peopleAfter = parsePeopleYaml(fs.readFileSync(path.join(repoDir, 'data', 'people.yaml'), 'utf8'));
    const placesAfter = parsePlacesYaml(fs.readFileSync(path.join(repoDir, 'data', 'places.yaml'), 'utf8'));

    expect(peopleAfter.find((p) => p.id === 'per_jane')?.pronunciation?.audio_url).toBe(
      janeTarget?.audio_url
    );
    // People without explicit overrides and living people must never receive new pronunciation blocks
    expect(peopleAfter.find((p) => p.id === 'per_hendrik')?.pronunciation).toBeUndefined();
    expect(peopleAfter.find((p) => p.id === 'per_living_case')?.pronunciation).toBeUndefined();

    expect(placesAfter.find((p) => p.id === 'plc_harbor')?.pronunciation?.audio_url).toBe(
      harborTarget?.audio_url
    );
    expect(placesAfter.find((p) => p.id === 'plc_oakville')?.pronunciation).toBeUndefined();

    // Re-running without --force preserves already-set audio_url on overrides
    const secondImport = await runPronounceSynthCommand({
      repoDir,
      importDir,
      updateConfig: true,
    });
    expect(secondImport.updatedConfigEntries).toBe(0);
    expect(secondImport.updatedPersonEntries).toBe(0);
    expect(secondImport.updatedPlaceEntries).toBe(0);
  });

  it('synthesizes via openai-speech without seed, supports voice cloning and skip-existing, and works via Gemini backend', async () => {
    const repoDir = await makeTempDir('kinloom-pron-live-');
    createSyntheticArchive(repoDir);
    const refWav = path.join(repoDir, 'ref-voice.wav');
    fs.writeFileSync(refWav, Buffer.from('RIFF-reference-voice'));

    const openAiBodies: Array<Record<string, unknown>> = [];
    const mockOpenAiFetch = vi.fn<typeof fetch>(async (_url, init) => {
      openAiBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return new Response(wrapPcmAsWav(Buffer.alloc(2400, 0x10), 24000), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    });

    const mockExec: AudioExecFileFn = async (_file, args) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('NORMALIZED-WAV-BYTES'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };

    const first = await runPronounceSynthCommand({
      repoDir,
      backend: 'openai-speech',
      endpoint: 'http://127.0.0.1:8000',
      apiKey: 'gpu-key',
      refAudioPath: refWav,
      refText: 'Reference sample sentence.',
      scope: 'lexicon',
      updateConfig: true,
      fetchImpl: mockOpenAiFetch,
      execFileImpl: mockExec,
      sleepFn: async () => {},
    });
    expect(first.mode).toBe('synth');
    expect(first.summary.synthesized).toBe(2);
    expect(first.summary.skipped_existing).toBe(0);
    expect(openAiBodies).toHaveLength(2);
    for (const body of openAiBodies) {
      expect('seed' in body).toBe(false);
      expect(body.model).toBe('fishaudio/drama-3');
      expect(Array.isArray(body.references)).toBe(true);
    }

    // Second run skips both existing files cleanly without calling fetch
    const second = await runPronounceSynthCommand({
      repoDir,
      backend: 'openai-speech',
      endpoint: 'http://127.0.0.1:8000',
      scope: 'lexicon',
      fetchImpl: mockOpenAiFetch,
      execFileImpl: mockExec,
      sleepFn: async () => {},
    });
    expect(second.summary.synthesized).toBe(0);
    expect(second.summary.skipped_existing).toBe(2);
    expect(mockOpenAiFetch).toHaveBeenCalledTimes(2);

    // Gemini backend (raw PCM wrapped in WAV + retry on 503)
    const geminiOutDir = path.join(repoDir, 'media-gemini');
    let geminiCalls = 0;
    const mockGeminiFetch = vi.fn<typeof fetch>(async () => {
      geminiCalls += 1;
      if (geminiCalls === 1) {
        return new Response('busy', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'audio/L16;rate=24000',
                      data: Buffer.alloc(4800, 0x04).toString('base64'),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    });

    const geminiRes = await runPronounceSynthCommand({
      repoDir,
      backend: 'gemini',
      scope: 'lexicon',
      outDir: geminiOutDir,
      format: 'mp3',
      concurrency: 1,
      env: { GEMINI_API_KEY: 'gem-key' },
      fetchImpl: mockGeminiFetch,
      execFileImpl: mockExec,
      sleepFn: async () => {},
    });
    expect(geminiRes.summary.synthesized).toBe(2);
    expect(geminiCalls).toBe(3); // 1 retry + 2 successes
  });

  it('wires kinloom pronounce synth through runCli for dry-run and rejects invalid flags cleanly', async () => {
    const repoDir = await makeTempDir('kinloom-pron-cli-');
    createSyntheticArchive(repoDir);

    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['pronounce', 'synth', '--repo', repoDir, '--backend', 'openai-speech', '--dry-run', '--json'],
      {
        io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
      }
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const parsed = JSON.parse(out.join('\n')) as {
      mode: string;
      model: string;
      summary: { planned: number; living_people_excluded: number };
    };
    expect(parsed.mode).toBe('dry_run');
    expect(parsed.model).toBe('fishaudio/drama-3');
    expect(parsed.summary.planned).toBe(4);
    expect(parsed.summary.living_people_excluded).toBe(1);

    // Invalid flag exits 2
    const badErr: string[] = [];
    const badCode = await runCli(['pronounce', 'synth', '--repo', repoDir, '--backend', 'bogus'], {
      io: { stdout: () => {}, stderr: (l) => badErr.push(l) },
    });
    expect(badCode).toBe(2);
    expect(badErr.join('\n')).toContain("Invalid --backend 'bogus'");

    // Mismatched ref-audio / ref-text throws CliValidationError
    await expect(
      runPronounceSynthCommand({
        repoDir,
        backend: 'openai-speech',
        endpoint: 'http://127.0.0.1:8000',
        refAudioPath: path.join(repoDir, 'missing.wav'),
      })
    ).rejects.toThrow(CliValidationError);

    // Missing GEMINI_API_KEY throws CliValidationError
    await expect(
      runPronounceSynthCommand({
        repoDir,
        backend: 'gemini',
        env: {},
      })
    ).rejects.toThrow(CliValidationError);

    // Additional CLI validation branches (format, scope, phoneme-mode, unknown/missing subcommand, lookup, deduplicate)
    for (const badArgs of [
      ['pronounce'],
      ['pronounce', 'bogus'],
      ['pronounce', 'lookup'],
      ['pronounce', 'synth', '--repo', repoDir, '--format', 'ogg'],
      ['pronounce', 'synth', '--repo', repoDir, '--scope', 'every'],
      ['pronounce', 'synth', '--repo', repoDir, '--phoneme-mode', 'ssml'],
    ]) {
      const c = await runCli(badArgs, { io: { stdout: () => {}, stderr: () => {} } });
      expect(c).toBe(2);
    }

    const dedupeOut: string[] = [];
    const dedupeCode = await runCli(['pronounce', 'deduplicate', '--repo', repoDir, '--json'], {
      io: { stdout: (l) => dedupeOut.push(l), stderr: () => {} },
    });
    expect(dedupeCode).toBe(0);
    expect(JSON.parse(dedupeOut.join('\n')).ok).toBe(true);

    const lookupOut: string[] = [];
    const lookupCode = await runCli(['pronounce', 'lookup', 'Oakville', '--lang', 'en', '--json'], {
      io: { stdout: (l) => lookupOut.push(l), stderr: () => {} },
      fetchImpl: async () =>
        new Response(JSON.stringify({ query: { pages: [{ title: 'Oakville', missing: true }] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(lookupCode).toBe(0);
    expect(JSON.parse(lookupOut.join('\n')).term).toBe('Oakville');
  });

  it('covers error paths, dry-run/import skip-existing, and Gemini WAV/error branches', async () => {
    const repoDir = await makeTempDir('kinloom-pron-edges-');
    createSyntheticArchive(repoDir);

    // Nonexistent repo / missing config / invalid options
    await expect(runPronounceSynthCommand({ repoDir: path.join(repoDir, 'does-not-exist') })).rejects.toThrow(
      CliValidationError
    );
    const noConfigDir = await makeTempDir('kinloom-pron-noconf-');
    await expect(runPronounceSynthCommand({ repoDir: noConfigDir })).rejects.toThrow(CliValidationError);
    await expect(runPronounceSynthCommand({ repoDir, concurrency: 0 })).rejects.toThrow(CliValidationError);
    await expect(
      runPronounceSynthCommand({ repoDir, importDir: path.join(repoDir, 'missing-import') })
    ).rejects.toThrow(CliValidationError);

    // Pre-create one target file to exercise skipped_existing in dry-run (text) and import-dir (text)
    const dryText = await runPronounceSynthCommand({ repoDir, dryRun: true, scope: 'lexicon' });
    expect(dryText.rendered).toContain('Planned: 2 | Skipped existing: 0');
    const mediaDir = path.join(repoDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, dryText.items[0].filename), Buffer.from('existing'));

    const dryWithExisting = await runPronounceSynthCommand({ repoDir, dryRun: true, scope: 'lexicon' });
    expect(dryWithExisting.summary.skipped_existing).toBe(1);
    expect(dryWithExisting.summary.planned).toBe(1);

    const importDir = path.join(repoDir, 'imp');
    fs.mkdirSync(importDir, { recursive: true });
    const impWithSkip = await runPronounceSynthCommand({ repoDir, importDir, scope: 'lexicon' });
    expect(impWithSkip.summary.skipped_existing).toBe(1);
    expect(impWithSkip.summary.missing_import).toBe(1);
    expect(impWithSkip.rendered).toContain('Imported: 0 | Skipped existing: 1 | Missing in import dir: 1');

    // Gemini RIFF WAV passthrough + error branches (HTTP 400 and missing inlineData)
    const mockExec: AudioExecFileFn = async (_f, args) => {
      fs.writeFileSync(args[args.length - 1], Buffer.from('WAV-OUT'));
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    const riffWav = wrapPcmAsWav(Buffer.alloc(1600, 0x02), 24000);
    const riffRes = await runPronounceSynthCommand({
      repoDir,
      backend: 'gemini',
      scope: 'lexicon',
      outDir: path.join(repoDir, 'gem-riff'),
      env: { GEMINI_API_KEY: 'key' },
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/wav', data: riffWav.toString('base64') } }],
                },
              },
            ],
          }),
          { status: 200 }
        ),
      execFileImpl: mockExec,
      sleepFn: async () => {},
    });
    expect(riffRes.summary.synthesized).toBe(2);

    await expect(
      runPronounceSynthCommand({
        repoDir,
        backend: 'gemini',
        scope: 'lexicon',
        outDir: path.join(repoDir, 'gem-err1'),
        env: { GEMINI_API_KEY: 'key' },
        fetchImpl: async () => new Response('bad prompt', { status: 400 }),
        execFileImpl: mockExec,
        sleepFn: async () => {},
      })
    ).rejects.toThrow('gemini-tts HTTP 400');

    await expect(
      runPronounceSynthCommand({
        repoDir,
        backend: 'gemini',
        scope: 'lexicon',
        outDir: path.join(repoDir, 'gem-err2'),
        env: { GEMINI_API_KEY: 'key' },
        fetchImpl: async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }),
        execFileImpl: mockExec,
        sleepFn: async () => {},
      })
    ).rejects.toThrow('missing inline audio data');
  });
});
