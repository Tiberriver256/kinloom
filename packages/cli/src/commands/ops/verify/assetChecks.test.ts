import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type KinloomSiteConfig,
  type MediaItem,
  type Narrative,
  type Place,
  parseKinloomConfigYaml,
  type RawEvent,
  type RawPerson,
  type SourceRecord,
  serializeEventsYaml,
  serializeKinloomConfigYaml,
  serializeKinshipYaml,
  serializeMediaYaml,
  serializeNarrativesYaml,
  serializePeopleYaml,
  serializePlacesYaml,
  serializeSourcesYaml,
} from '@kinloom/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../cli.js';
import { EXIT_ERROR, EXIT_OK } from '../../../errors.js';
import { runVerifyCommand } from '../verify.js';
import {
  checkBrandkitManifest,
  extractExternalAssetHost,
  scanExternalMediaUrls,
  scanTrackedBinaryMedia,
} from './assetChecks.js';
import type { LoadedVerifyArchive, VerifyCommandResult } from './types.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (chunk: string) => stdout.push(chunk),
      stderr: (chunk: string) => stderr.push(chunk),
    },
  };
}

function makeBaseSiteConfig(pronunciations?: KinloomSiteConfig['pronunciations']): KinloomSiteConfig {
  const base = parseKinloomConfigYaml(`schemaVersion: 1
site:
  title: Alder Family Archive
  familyName: Alder
  gedcomSourceName: ALDER_ARCHIVE
  footerCredit: Alder Family
privacy:
  referenceYear: 2026
  livingCutoffYears: 101
`);
  return pronunciations ? { ...base, pronunciations } : base;
}

function makeBaseArchive(
  repoDir: string,
  overrides: Partial<LoadedVerifyArchive> = {}
): Pick<
  LoadedVerifyArchive,
  | 'repoDir'
  | 'siteConfig'
  | 'people'
  | 'places'
  | 'events'
  | 'media'
  | 'narratives'
  | 'enrichments'
  | 'yamlTexts'
> {
  return {
    repoDir,
    siteConfig: makeBaseSiteConfig(),
    people: [],
    places: [],
    events: [],
    media: [],
    narratives: [],
    enrichments: [],
    yamlTexts: [],
    ...overrides,
  };
}

async function createMinimalValidRepo(options?: {
  initGit?: boolean;
  people?: RawPerson[];
  places?: Place[];
  events?: RawEvent[];
  sources?: SourceRecord[];
  media?: MediaItem[];
  narratives?: Narrative[];
  siteConfig?: KinloomSiteConfig;
  mediaFiles?: Record<string, Buffer | string>;
}): Promise<string> {
  const repoDir = await makeTempDir('kinloom-verify-assets-');
  const dataDir = path.join(repoDir, 'data');
  const mediaDir = path.join(repoDir, 'media');
  await mkdir(dataDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  const siteConfig =
    options?.siteConfig ??
    makeBaseSiteConfig({
      'Henry Alder': {
        phonetic: 'HEN-ree AWL-der',
        ipa: '/ˈhɛn.ri ˈɔːl.dər/',
        audio_url: '/media/pronunciation-henry.wav',
        source_url: 'https://en.wiktionary.org/wiki/Alder',
      },
      Oakville: {
        phonetic: 'OHK-vil',
        ipa: '/ˈoʊk.vɪl/',
        audio_url: '/media/pronunciation-oakville.wav',
        source_url: 'https://en.wikipedia.org/wiki/Oakville',
      },
    });

  const places: Place[] = options?.places ?? [
    {
      id: 'plc_oakville',
      slug: 'oakville',
      name: 'Oakville',
      full_name: 'Oakville, Michigan, USA',
      place_type: 'town',
      parent_id: null,
      lat: 42.96,
      lng: -85.67,
    },
  ];

  const people: RawPerson[] = options?.people ?? [
    {
      id: 'per_henry',
      slug: 'henry-alder',
      full_name: 'Henry Alder',
      given_name: 'Henry',
      surname: 'Alder',
      alt_names: [],
      sex: 'M',
      is_living: false,
      lineage_group: 'ancestor',
      birth_edtf: '1850-05-01',
      death_edtf: '1920-08-12',
      portrait_url: '/media/henry-portrait.jpg',
    },
  ];

  const sources: SourceRecord[] = options?.sources ?? [
    {
      id: 'src_wiki_citation',
      citation: 'Wikimedia Commons archival entry for Oakville.',
      source_type: 'web',
      url: 'https://commons.wikimedia.org/wiki/File:Oakville_1890.jpg',
    },
    {
      id: 'src_census',
      citation: '1900 US Federal Census, Oakville.',
      source_type: 'census',
      url: 'https://www.familysearch.org/ark:/61903/1:1:EXAMPLE',
    },
  ];

  const events: RawEvent[] = options?.events ?? [
    {
      id: 'evt_henry_birth',
      title: 'Birth of Henry Alder',
      scope: 'family',
      event_kind: 'point_event',
      edtf_date: '1850-05-01',
      place_id: 'plc_oakville',
      summary: 'Born in Oakville.',
      source_url: 'https://upload.wikimedia.org/wikipedia/commons/citation-link.pdf',
      participants: [{ person_id: 'per_henry', role: 'principal' }],
      sources: [{ source_id: 'src_census', confidence: 'high' }],
    },
  ];

  const media: MediaItem[] = options?.media ?? [
    {
      id: 'med_henry_portrait',
      kind: 'portrait',
      person_id: 'per_henry',
      file: '/media/henry-portrait.jpg',
      caption: 'Portrait of Henry Alder.',
      date_edtf: '1890',
    },
  ];

  const narratives: Narrative[] = options?.narratives ?? [
    {
      id: 'nar_henry',
      slug: 'henry-alder',
      kind: 'biography',
      subject_person_id: 'per_henry',
      title: 'Henry Alder',
      body_md: 'Henry lived in Oakville [src:src_wiki_citation] and appears in [med:med_henry_portrait].',
      person_ids: ['per_henry'],
      place_ids: ['plc_oakville'],
      event_ids: ['evt_henry_birth'],
      source_ids: ['src_wiki_citation'],
    },
  ];

  const mediaFiles = options?.mediaFiles ?? {
    'henry-portrait.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  };

  for (const [relName, data] of Object.entries(mediaFiles)) {
    const dest = path.join(mediaDir, relName);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
  }

  await Promise.all([
    writeFile(path.join(repoDir, 'kinloom.config.yaml'), serializeKinloomConfigYaml(siteConfig), 'utf8'),
    writeFile(path.join(dataDir, 'people.yaml'), serializePeopleYaml(people, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'places.yaml'), serializePlacesYaml(places, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'sources.yaml'), serializeSourcesYaml(sources, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'kinship.yaml'), serializeKinshipYaml([]), 'utf8'),
    writeFile(path.join(dataDir, 'events.yaml'), serializeEventsYaml(events, { sortById: true }), 'utf8'),
    writeFile(path.join(dataDir, 'media.yaml'), serializeMediaYaml(media, { sortById: true }), 'utf8'),
    writeFile(
      path.join(dataDir, 'narratives.yaml'),
      serializeNarrativesYaml(narratives, { sortById: true }),
      'utf8'
    ),
  ]);

  if (options?.initGit) {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir });
  }

  return repoDir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('extractExternalAssetHost', () => {
  it('returns null for non-strings, blank strings, and local relative paths', () => {
    expect(extractExternalAssetHost(null)).toBeNull();
    expect(extractExternalAssetHost(undefined)).toBeNull();
    expect(extractExternalAssetHost(42)).toBeNull();
    expect(extractExternalAssetHost('')).toBeNull();
    expect(extractExternalAssetHost('   ')).toBeNull();
    expect(extractExternalAssetHost('/media/pronunciation-alder.wav')).toBeNull();
    expect(extractExternalAssetHost('media/portrait.jpg')).toBeNull();
    expect(extractExternalAssetHost('/audio/clip.mp3')).toBeNull();
  });

  it('extracts normalized hostnames from http, https, and protocol-relative URLs', () => {
    expect(
      extractExternalAssetHost('https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.ogg')
    ).toEqual({
      url: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.ogg',
      host: 'upload.wikimedia.org',
    });
    expect(extractExternalAssetHost('  HTTP://CDN.EXAMPLE.ORG:8080/photo.jpg  ')).toEqual({
      url: 'HTTP://CDN.EXAMPLE.ORG:8080/photo.jpg',
      host: 'cdn.example.org',
    });
    expect(extractExternalAssetHost('//commons.wikimedia.org/wiki/Special:FilePath/Foo.ogg')).toEqual({
      url: '//commons.wikimedia.org/wiki/Special:FilePath/Foo.ogg',
      host: 'commons.wikimedia.org',
    });
  });

  it('falls back cleanly on malformed external URLs', () => {
    expect(extractExternalAssetHost('https://user@bad host:99/file.mp3')).toEqual({
      url: 'https://user@bad host:99/file.mp3',
      host: 'bad host',
    });
    expect(extractExternalAssetHost('http://bad host/file.wav')).toEqual({
      url: 'http://bad host/file.wav',
      host: 'bad host',
    });
    expect(extractExternalAssetHost('https://')).toEqual({
      url: 'https://',
      host: 'unknown',
    });
  });
});

describe('scanExternalMediaUrls', () => {
  it('passes with zero false positives when only local assets and external citation URLs exist', async () => {
    const repoDir = await makeTempDir('kinloom-ext-clean-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'data', 'pronunciations.yaml'),
      [
        'Alder:',
        '  phonetic: AWL-der',
        '  audio_url: /media/pronunciation-alder.wav',
        '  source_url: https://en.wiktionary.org/wiki/alder',
        '  variants:',
        '    - label: Regional',
        '      audio_url: /media/pronunciation-alder-reg.wav',
        '      source_url: https://commons.wikimedia.org/wiki/File:Alder.ogg',
      ].join('\n'),
      'utf8'
    );

    const result = scanExternalMediaUrls(
      makeBaseArchive(repoDir, {
        siteConfig: makeBaseSiteConfig({
          Oakville: {
            phonetic: 'OHK-vil',
            audio_url: '/media/pronunciation-oakville.wav',
            source_url: 'https://en.wikipedia.org/wiki/Oakville',
          },
        }),
        people: [
          {
            id: 'per_henry',
            slug: 'henry-alder',
            full_name: 'Henry Alder',
            given_name: 'Henry',
            surname: 'Alder',
            alt_names: [],
            sex: 'M',
            is_living: false,
            lineage_group: 'ancestor',
            birth_edtf: '1850',
            death_edtf: '1920',
            portrait_url: '/media/henry.jpg',
            thumb_url: '/media/henry-thumb.jpg',
            pronunciation: {
              phonetic: 'HEN-ree',
              audio_url: '/media/henry.wav',
              source_url: 'https://en.wiktionary.org/wiki/Henry',
            },
            extensions: {
              citation_url: 'https://upload.wikimedia.org/wikipedia/commons/citation.html',
              tags: ['founder'],
            },
          },
        ],
        places: [
          {
            id: 'plc_oakville',
            slug: 'oakville',
            name: 'Oakville',
            full_name: 'Oakville, MI',
            place_type: 'town',
            parent_id: null,
            lat: 42.96,
            lng: -85.67,
            photo_url: '/media/oakville.jpg',
            pronunciation: {
              phonetic: 'OHK-vil',
              audio_url: '/media/oakville.wav',
              source_url: 'https://en.wikipedia.org/wiki/Oakville',
            },
          },
        ],
        events: [
          {
            id: 'evt_1',
            title: 'Birth',
            scope: 'family',
            event_kind: 'point_event',
            edtf_date: '1850',
            place_id: 'plc_oakville',
            summary: 'Summary',
            photo_url: '/media/evt1.jpg',
            source_url: 'https://commons.wikimedia.org/wiki/File:Record.jpg',
            participants: [],
            sources: [],
          },
        ],
        media: [
          {
            id: 'med_1',
            kind: 'video_story',
            file: '/media/interview.mp4',
            thumb_file: '/media/interview-thumb.jpg',
            poster_url: '/media/interview-poster.jpg',
            transcript_url: '/media/interview.vtt',
            caption: 'See https://upload.wikimedia.org/wiki/Note',
            provenance: 'https://commons.wikimedia.org/wiki/Provenance',
          },
        ],
        narratives: [
          {
            id: 'nar_1',
            slug: 'story',
            title: 'Story',
            body_md: 'External reference: https://upload.wikimedia.org/wikipedia/commons/ref.jpg',
            person_ids: [],
            place_ids: [],
            event_ids: [],
            source_ids: [],
          },
        ],
        yamlTexts: [
          {
            name: 'sources.yaml',
            content:
              '- id: src_1\n  citation: Wiki\n  source_type: web\n  url: https://upload.wikimedia.org/wikipedia/commons/foo.jpg\n  token_audio_urls:\n    - https://upload.wikimedia.org/ignored.ogg\n',
          },
        ],
      })
    );

    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
    expect(result.checkedCount).toBeGreaterThan(0);
  });

  it('flags external URLs across media, people, places, events, enrichments, narratives, config, pronunciations.yaml, and raw token_audio_urls', async () => {
    const repoDir = await makeTempDir('kinloom-ext-fail-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'data', 'pronunciations.yaml'),
      [
        'Hendrik:',
        '  phonetic: HEN-drik',
        '  audio_url: https://upload.wikimedia.org/wikipedia/commons/h/hd/Nl-Hendrik.ogg',
        '  token_audio_urls:',
        '    - /media/local-ok.wav',
        '    - //upload.wikimedia.org/wikipedia/commons/token.ogg',
        '  variants:',
        '    - not-an-object',
        '    - label: Alt',
        '      audio_url: http://audio.example.org/hendrik-alt.mp3',
        '      token_audio_urls:',
        '        - https://cdn.example.net/v-tok.mp3',
        'non_record_entry: just-a-string',
      ].join('\n'),
      'utf8'
    );

    const rawPeopleYaml = [
      '- id: per_henry',
      '  pronunciation:',
      '    audio_url: https://upload.wikimedia.org/henry.ogg',
      '    token_audio_urls:',
      '      - https://upload.wikimedia.org/tok1.ogg',
      '- not-an-object',
      '- token_audio_urls:',
      '    - https://cdn.example.org/orphan-tok.mp3',
    ].join('\n');

    const result = scanExternalMediaUrls(
      makeBaseArchive(repoDir, {
        siteConfig: makeBaseSiteConfig({
          Oakville: {
            phonetic: 'OHK-vil',
            audio_url: 'https://commons.wikimedia.org/wiki/Special:FilePath/En-us-Oakville.ogg',
            variants: [
              {
                label: 'Slow',
                audio_url: 'https://media.example.org/oakville-slow.mp3',
              },
            ],
          },
        }),
        media: [
          {
            id: 'med_ext',
            kind: 'video_story',
            file: 'https://upload.wikimedia.org/wikipedia/commons/a/a1/Photo.jpg',
            thumb_file: 'https://upload.wikimedia.org/wikipedia/commons/thumb.jpg',
            poster_url: 'https://cdn.example.com/poster.jpg',
            transcript_url: 'https://cdn.example.com/transcript.vtt',
            caption: 'External media',
            extensions: {
              audio_url: 'https://cdn.example.com/narration.mp3',
            },
          },
        ],
        people: [
          {
            id: 'per_henry',
            slug: 'henry-alder',
            full_name: 'Henry Alder',
            given_name: 'Henry',
            surname: 'Alder',
            alt_names: [],
            sex: 'M',
            is_living: false,
            lineage_group: 'ancestor',
            birth_edtf: '1850',
            death_edtf: '1920',
            portrait_url: 'https://upload.wikimedia.org/wikipedia/commons/henry.jpg',
            thumb_url: 'https://upload.wikimedia.org/wikipedia/commons/henry-thumb.jpg',
            pronunciation: {
              phonetic: 'HEN-ree',
              audio_url: 'https://upload.wikimedia.org/henry.ogg',
            },
            extensions: {
              nested: [{ portrait_url: 'http://legacy.example.org/old-portrait.jpg' }, 'ignored'],
            },
          },
        ],
        places: [
          {
            id: 'plc_oakville',
            slug: 'oakville',
            name: 'Oakville',
            full_name: 'Oakville, MI',
            place_type: 'town',
            parent_id: null,
            lat: 42.96,
            lng: -85.67,
            photo_url: 'https://upload.wikimedia.org/oakville.jpg',
            pronunciation: {
              phonetic: 'OHK-vil',
              audio_url: 'https://upload.wikimedia.org/oakville.ogg',
            },
            extensions: {
              gallery: { photo_url: 'https://cdn.example.org/gallery.jpg' },
            },
          },
        ],
        events: [
          {
            id: 'evt_1',
            title: 'Event',
            scope: 'family',
            event_kind: 'point_event',
            edtf_date: '1850',
            place_id: 'plc_oakville',
            summary: 'Born',
            photo_url: 'https://cdn.example.org/evt.jpg',
            source_url: 'https://upload.wikimedia.org/citation-only.jpg',
            participants: [],
            sources: [],
            extensions: {
              audio_url: 'https://cdn.example.org/evt-audio.mp3',
            },
          },
        ],
        enrichments: [
          {
            override_event_id: 'evt_override',
            photo_url: 'https://cdn.example.org/override-photo.jpg',
          },
          {
            id: 'evt_full_enrich',
            title: 'Enriched',
            scope: 'local',
            event_kind: 'point_event',
            edtf_date: '1860',
            place_id: null,
            summary: 'Context',
            photo_url: 'https://cdn.example.org/full-enrich.jpg',
            participants: [],
            sources: [],
          },
        ],
        narratives: [
          {
            id: 'nar_1',
            slug: 'nar-1',
            title: 'Nar',
            body_md: 'Body',
            person_ids: [],
            place_ids: [],
            event_ids: [],
            source_ids: [],
            extensions: {
              narrative_audio: {
                audio_url: 'https://cdn.example.org/nar-1.mp3',
                token_audio_urls: ['https://cdn.example.org/nar-tok.mp3'],
              },
            },
          },
        ],
        yamlTexts: [
          { name: 'people.yaml', content: rawPeopleYaml },
          { name: 'places.yaml', content: 'token_audio_urls: not-a-list' },
          { name: 'media.yaml', content: 'token_audio_urls: [unterminated' },
        ],
      })
    );

    expect(result.ok).toBe(false);
    const byKey = new Set(result.hits.map((h) => `${h.file}|${h.entityId}|${h.field}|${h.host}`));

    expect(byKey.has('data/media.yaml|med_ext|file|upload.wikimedia.org')).toBe(true);
    expect(byKey.has('data/media.yaml|med_ext|thumb_file|upload.wikimedia.org')).toBe(true);
    expect(byKey.has('data/media.yaml|med_ext|poster_url|cdn.example.com')).toBe(true);
    expect(byKey.has('data/media.yaml|med_ext|transcript_url|cdn.example.com')).toBe(true);
    expect(byKey.has('data/media.yaml|med_ext|extensions.audio_url|cdn.example.com')).toBe(true);

    expect(byKey.has('data/people.yaml|per_henry|portrait_url|upload.wikimedia.org')).toBe(true);
    expect(byKey.has('data/people.yaml|per_henry|thumb_url|upload.wikimedia.org')).toBe(true);
    expect(byKey.has('data/people.yaml|per_henry|pronunciation.audio_url|upload.wikimedia.org')).toBe(true);
    expect(
      byKey.has('data/people.yaml|per_henry|pronunciation.token_audio_urls[0]|upload.wikimedia.org')
    ).toBe(true);
    expect(byKey.has('data/people.yaml|per_henry|extensions.nested[0].portrait_url|legacy.example.org')).toBe(
      true
    );
    expect(byKey.has('data/people.yaml|unknown|token_audio_urls[0]|cdn.example.org')).toBe(true);

    expect(byKey.has('data/places.yaml|plc_oakville|photo_url|upload.wikimedia.org')).toBe(true);
    expect(byKey.has('data/places.yaml|plc_oakville|pronunciation.audio_url|upload.wikimedia.org')).toBe(
      true
    );
    expect(byKey.has('data/places.yaml|plc_oakville|extensions.gallery.photo_url|cdn.example.org')).toBe(
      true
    );

    expect(byKey.has('data/events.yaml|evt_1|photo_url|cdn.example.org')).toBe(true);
    expect(byKey.has('data/events.yaml|evt_1|extensions.audio_url|cdn.example.org')).toBe(true);
    // Citation source_url must NOT be flagged.
    expect(result.hits.some((h) => h.field === 'source_url')).toBe(false);

    expect(byKey.has('data/narrative-enrichments.yaml|evt_override|photo_url|cdn.example.org')).toBe(true);
    expect(byKey.has('data/narrative-enrichments.yaml|evt_full_enrich|photo_url|cdn.example.org')).toBe(true);

    expect(byKey.has('data/narratives.yaml|nar_1|extensions.narrative_audio.audio_url|cdn.example.org')).toBe(
      true
    );
    expect(
      byKey.has('data/narratives.yaml|nar_1|extensions.narrative_audio.token_audio_urls[0]|cdn.example.org')
    ).toBe(true);

    expect(
      byKey.has('kinloom.config.yaml|Oakville|pronunciations.Oakville.audio_url|commons.wikimedia.org')
    ).toBe(true);
    expect(
      byKey.has(
        'kinloom.config.yaml|Oakville|pronunciations.Oakville.variants[0].audio_url|media.example.org'
      )
    ).toBe(true);

    expect(byKey.has('data/pronunciations.yaml|Hendrik|Hendrik.audio_url|upload.wikimedia.org')).toBe(true);
    expect(
      byKey.has('data/pronunciations.yaml|Hendrik|Hendrik.token_audio_urls[1]|upload.wikimedia.org')
    ).toBe(true);
    expect(
      byKey.has('data/pronunciations.yaml|Hendrik|Hendrik.variants[1].audio_url|audio.example.org')
    ).toBe(true);
    expect(
      byKey.has('data/pronunciations.yaml|Hendrik|Hendrik.variants[1].token_audio_urls[0]|cdn.example.net')
    ).toBe(true);

    // Deduplicated: per_henry pronunciation.audio_url appeared in both parsed people and raw YAML
    const henryAudioHits = result.hits.filter(
      (h) =>
        h.file === 'data/people.yaml' && h.entityId === 'per_henry' && h.field === 'pronunciation.audio_url'
    );
    expect(henryAudioHits).toHaveLength(1);
  });

  it('ignores malformed optional data/pronunciations.yaml gracefully', async () => {
    const repoDir = await makeTempDir('kinloom-ext-bad-yaml-');
    await mkdir(path.join(repoDir, 'data'), { recursive: true });
    await writeFile(path.join(repoDir, 'data', 'pronunciations.yaml'), 'Alder: [unterminated', 'utf8');

    const result = scanExternalMediaUrls(makeBaseArchive(repoDir));
    expect(result.ok).toBe(true);
    expect(result.hits).toEqual([]);
  });
});

describe('scanTrackedBinaryMedia', () => {
  it('handles non-git directories gracefully without throwing', async () => {
    const nonGitDir = await makeTempDir('kinloom-non-git-');
    const result = scanTrackedBinaryMedia(nonGitDir);
    expect(result).toEqual({
      ok: true,
      isGitRepo: false,
      trackedCount: 0,
      files: [],
    });
  });

  it('flags tracked .mp3, .wav, and .mp4 files in Git while ignoring untracked or non-binary files', async () => {
    const gitRepo = await makeTempDir('kinloom-git-media-');
    execFileSync('git', ['init', '-q'], { cwd: gitRepo });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: gitRepo });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: gitRepo });

    await mkdir(path.join(gitRepo, 'media', 'audio'), { recursive: true });
    await writeFile(path.join(gitRepo, 'README.md'), '# Archive\n', 'utf8');
    await writeFile(path.join(gitRepo, 'media', 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(path.join(gitRepo, 'media', 'untracked.mp3'), Buffer.from('ID3'));
    execFileSync('git', ['add', 'README.md', 'media/photo.jpg'], { cwd: gitRepo });

    const cleanResult = scanTrackedBinaryMedia(gitRepo);
    expect(cleanResult).toEqual({
      ok: true,
      isGitRepo: true,
      trackedCount: 2,
      files: [],
    });

    await writeFile(path.join(gitRepo, 'media', 'audio', 'voice.mp3'), Buffer.from('ID3'));
    await writeFile(path.join(gitRepo, 'media', 'audio', 'pronunciation.WAV'), Buffer.from('RIFF'));
    await writeFile(path.join(gitRepo, 'media', 'clip.mp4'), Buffer.from('ftyp'));
    execFileSync('git', ['add', 'media/audio/voice.mp3', 'media/audio/pronunciation.WAV', 'media/clip.mp4'], {
      cwd: gitRepo,
    });

    const failingResult = scanTrackedBinaryMedia(gitRepo);
    expect(failingResult).toEqual({
      ok: false,
      isGitRepo: true,
      trackedCount: 5,
      files: [
        { path: 'media/audio/pronunciation.WAV', extension: '.wav' },
        { path: 'media/audio/voice.mp3', extension: '.mp3' },
        { path: 'media/clip.mp4', extension: '.mp4' },
      ],
    });
  });

  it('normalizes Windows-style separators from git output', () => {
    const result = scanTrackedBinaryMedia('/virtual/repo', {
      execGitLsFiles: () => 'data\\people.yaml\0media\\nested\\clip.MP4\0media\\voice.mp3\0',
    });
    expect(result).toEqual({
      ok: false,
      isGitRepo: true,
      trackedCount: 3,
      files: [
        { path: 'media/nested/clip.MP4', extension: '.mp4' },
        { path: 'media/voice.mp3', extension: '.mp3' },
      ],
    });
  });
});

describe('kinloom verify CLI integration for Issue #117 checks', () => {
  it('passes --strict --json on a clean archive with external citation URLs in sources.yaml', async () => {
    const repoDir = await createMinimalValidRepo({ initGit: true });
    execFileSync('git', ['add', 'kinloom.config.yaml', 'data', 'media/henry-portrait.jpg'], { cwd: repoDir });

    const capture = createCaptureIo();
    const exitCode = await runCli(['verify', '--repo', repoDir, '--strict', '--json'], { io: capture.io });
    expect(exitCode).toBe(EXIT_OK);

    const parsed = JSON.parse(capture.stdout.join('\n')) as VerifyCommandResult;
    expect(parsed.ok).toBe(true);
    expect(parsed.strictExternalMedia).toBe(true);
    expect(parsed.strictTrackedMedia).toBe(true);
    expect(parsed.checks.externalMedia.ok).toBe(true);
    expect(parsed.checks.externalMedia.hits).toEqual([]);
    expect(parsed.checks.trackedMedia.ok).toBe(true);
    expect(parsed.checks.trackedMedia.isGitRepo).toBe(true);
    expect(parsed.checks.trackedMedia.files).toEqual([]);
    expect(parsed.errors).toEqual([]);
  });

  it('warns by default and fails under --strict-external-media, --strict-tracked-media, and --strict --json', async () => {
    const repoDir = await createMinimalValidRepo({
      initGit: true,
      siteConfig: makeBaseSiteConfig({
        'Henry Alder': {
          phonetic: 'HEN-ree AWL-der',
          ipa: '/ˈhɛn.ri ˈɔːl.dər/',
          audio_url: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/En-Henry.ogg',
          source_url: 'https://en.wiktionary.org/wiki/Alder',
        },
        Oakville: {
          phonetic: 'OHK-vil',
          ipa: '/ˈoʊk.vɪl/',
          audio_url: '/media/pronunciation-oakville.wav',
          source_url: 'https://en.wikipedia.org/wiki/Oakville',
        },
      }),
      people: [
        {
          id: 'per_henry',
          slug: 'henry-alder',
          full_name: 'Henry Alder',
          given_name: 'Henry',
          surname: 'Alder',
          alt_names: [],
          sex: 'M',
          is_living: false,
          lineage_group: 'ancestor',
          birth_edtf: '1850-05-01',
          death_edtf: '1920-08-12',
          portrait_url: 'https://upload.wikimedia.org/wikipedia/commons/henry.jpg',
        },
      ],
      mediaFiles: {
        'henry-portrait.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        'narration.mp3': Buffer.from('ID3'),
      },
    });
    execFileSync('git', ['add', 'kinloom.config.yaml', 'data', 'media/narration.mp3'], { cwd: repoDir });

    // Default verify: non-breaking WARN (exit 0)
    const defaultCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', repoDir, '--json'], { io: defaultCap.io })).toBe(EXIT_OK);
    const parsedDefault = JSON.parse(defaultCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedDefault.ok).toBe(true);
    expect(parsedDefault.strictExternalMedia).toBe(false);
    expect(parsedDefault.strictTrackedMedia).toBe(false);
    expect(parsedDefault.checks.externalMedia.ok).toBe(false);
    expect(parsedDefault.checks.externalMedia.hits).toEqual([
      {
        file: 'data/people.yaml',
        entityId: 'per_henry',
        field: 'portrait_url',
        url: 'https://upload.wikimedia.org/wikipedia/commons/henry.jpg',
        host: 'upload.wikimedia.org',
      },
      {
        file: 'kinloom.config.yaml',
        entityId: 'Henry Alder',
        field: 'pronunciations.Henry Alder.audio_url',
        url: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/En-Henry.ogg',
        host: 'upload.wikimedia.org',
      },
    ]);
    expect(parsedDefault.checks.trackedMedia.ok).toBe(false);
    expect(parsedDefault.checks.trackedMedia.files).toEqual([
      { path: 'media/narration.mp3', extension: '.mp3' },
    ]);
    expect(parsedDefault.warnings.some((w) => w.startsWith('[external-media]'))).toBe(true);
    expect(parsedDefault.warnings.some((w) => w.startsWith('[tracked-media]'))).toBe(true);
    expect(parsedDefault.errors).toEqual([]);

    // Default text output shows WARN for checks 9 & 10
    const defaultText = await runVerifyCommand({ repoDir });
    expect(defaultText.ok).toBe(true);
    expect(defaultText.rendered).toContain('9. External media CSP: WARN |');
    expect(defaultText.rendered).toContain('10. Tracked binary media: WARN | git=yes');

    // Opt-in --strict-external-media fails only external-media
    const strictExtCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', repoDir, '--strict-external-media', '--json'], {
        io: strictExtCap.io,
      })
    ).toBe(EXIT_ERROR);
    const parsedStrictExt = JSON.parse(strictExtCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedStrictExt.ok).toBe(false);
    expect(parsedStrictExt.strictExternalMedia).toBe(true);
    expect(parsedStrictExt.strictTrackedMedia).toBe(false);
    expect(parsedStrictExt.errors.every((e) => e.startsWith('external-media:'))).toBe(true);
    expect(parsedStrictExt.errors).toHaveLength(2);

    // Opt-in --strict-tracked-media fails only tracked-media
    const strictTrackedCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', repoDir, '--strict-tracked-media', '--json'], {
        io: strictTrackedCap.io,
      })
    ).toBe(EXIT_ERROR);
    const parsedStrictTracked = JSON.parse(strictTrackedCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedStrictTracked.ok).toBe(false);
    expect(parsedStrictTracked.strictExternalMedia).toBe(false);
    expect(parsedStrictTracked.strictTrackedMedia).toBe(true);
    expect(parsedStrictTracked.errors).toEqual([
      'tracked-media: media/narration.mp3 (.mp3) is tracked in Git',
    ]);

    // --strict --json fails both checks with structured file paths and entity IDs
    const strictAllCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', repoDir, '--strict', '--json'], { io: strictAllCap.io })).toBe(
      EXIT_ERROR
    );
    const parsedStrictAll = JSON.parse(strictAllCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedStrictAll.ok).toBe(false);
    expect(parsedStrictAll.strictExternalMedia).toBe(true);
    expect(parsedStrictAll.strictTrackedMedia).toBe(true);
    expect(parsedStrictAll.errors.some((e) => e.startsWith('external-media:'))).toBe(true);
    expect(parsedStrictAll.errors.some((e) => e.startsWith('tracked-media:'))).toBe(true);

    // Strict text output shows FAIL for checks 9 & 10
    const strictText = await runVerifyCommand({
      repoDir,
      strictExternalMedia: true,
      strictTrackedMedia: true,
    });
    expect(strictText.ok).toBe(false);
    expect(strictText.rendered).toContain('9. External media CSP: FAIL |');
    expect(strictText.rendered).toContain('10. Tracked binary media: FAIL | git=yes');

    // --help documents new strict flags
    const helpCap = createCaptureIo();
    expect(await runCli(['verify', '--help'], { io: helpCap.io })).toBe(EXIT_OK);
    const helpText = helpCap.stdout.join('\n');
    expect(helpText).toContain('--strict-external-media');
    expect(helpText).toContain('--strict-tracked-media');
    expect(helpText).toContain('--strict-brandkit');
  });
});

describe('checkBrandkitManifest and kinloom verify Issue #124 guard', () => {
  it('passes cleanly when public/site.webmanifest is absent, when assets match config, or when configured title is Kinloom', async () => {
    const repoDir = await makeTempDir('kinloom-brandkit-verify-ok-');
    const customConfig = parseKinloomConfigYaml(`schemaVersion: 1
site:
  title: Alder Family Archive
  familyName: Alder
  gedcomSourceName: ALDER_ARCHIVE
  footerCredit: Alder Family
theme:
  accent: "#2F5245"
`);

    expect(checkBrandkitManifest(repoDir, customConfig)).toEqual({
      ok: true,
      manifestPath: 'public/site.webmanifest',
      manifestExists: false,
      configuredTitle: 'Alder Family Archive',
      expectedAccent: '#2F5245',
      manifestName: null,
      manifestShortName: null,
      faviconLightAccent: null,
      swAccent: null,
      warnings: [],
    });

    await mkdir(path.join(repoDir, 'public'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({
        name: 'Alder Family Archive',
        short_name: 'Alder Family',
        icons: [{ src: '/icon-192.png' }],
      }),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'favicon-light.svg'),
      '<svg><style>.kl-accent { stroke: #2F5245; }</style></svg>',
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'sw.js'),
      'const OFFLINE_HTML = ":root{--bg:#F5EFE2;--accent:#2F5245}";',
      'utf8'
    );

    const matched = checkBrandkitManifest(repoDir, customConfig);
    expect(matched.ok).toBe(true);
    expect(matched.warnings).toEqual([]);
    expect(matched.manifestName).toBe('Alder Family Archive');
    expect(matched.faviconLightAccent).toBe('#2F5245');
    expect(matched.swAccent).toBe('#2F5245');

    // Configured title literally "Kinloom" does not warn on generic manifest
    const kinloomConfig = parseKinloomConfigYaml(`schemaVersion: 1
site:
  title: Kinloom
  familyName: Kinloom
  gedcomSourceName: KINLOOM_DEMO
  footerCredit: Kinloom
`);
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({ name: 'Kinloom', short_name: 'Kinloom', icons: [{ src: '/icon-192.png' }] }),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'favicon-light.svg'),
      '<svg><style>.kl-accent { stroke: #7A4612; }</style></svg>',
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'sw.js'),
      'const OFFLINE_HTML = ":root{--accent:#7A4612}";',
      'utf8'
    );
    expect(checkBrandkitManifest(repoDir, kinloomConfig).ok).toBe(true);

    // Malformed manifest JSON and custom non-Kinloom SVG/SW without accent tokens are ignored safely
    await writeFile(path.join(repoDir, 'public', 'site.webmanifest'), '{not-valid-json', 'utf8');
    await writeFile(
      path.join(repoDir, 'public', 'favicon-light.svg'),
      '<svg viewBox="0 0 32 32"></svg>',
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'sw.js'),
      'self.addEventListener("fetch", () => {});',
      'utf8'
    );
    const badJsonResult = checkBrandkitManifest(repoDir, customConfig);
    expect(badJsonResult.ok).toBe(true);
    expect(badJsonResult.manifestExists).toBe(true);
    expect(badJsonResult.manifestName).toBeNull();
    expect(badJsonResult.faviconLightAccent).toBeNull();
    expect(badJsonResult.swAccent).toBeNull();

    // Generic short_name alone (without generic name) still triggers warning
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({
        name: 'Alder Family Archive',
        short_name: 'Kinloom',
        icons: [{ src: '/icon-192.png' }],
      }),
      'utf8'
    );
    const shortNameOnly = checkBrandkitManifest(repoDir, customConfig);
    expect(shortNameOnly.ok).toBe(false);
    expect(shortNameOnly.warnings[0]).toContain('(short_name="Kinloom")');

    // Generic name alone (without generic short_name) still triggers warning
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({ name: 'Kinloom', short_name: 'Alder', icons: [{ src: '/icon-192.png' }] }),
      'utf8'
    );
    const nameOnly = checkBrandkitManifest(repoDir, customConfig);
    expect(nameOnly.ok).toBe(false);
    expect(nameOnly.warnings[0]).toContain('(name="Kinloom")');
  });

  it('warns by default and fails under --strict-brandkit and --strict when manifest or brandkit assets drift from kinloom.config.yaml', async () => {
    const repoDir = await createMinimalValidRepo({
      siteConfig: parseKinloomConfigYaml(`schemaVersion: 1
site:
  title: Alder Family Archive
  familyName: Alder
  gedcomSourceName: ALDER_ARCHIVE
  footerCredit: Alder Family
theme:
  accent: "#2F5245"
privacy:
  referenceYear: 2026
  livingCutoffYears: 101
pronunciations:
  Henry Alder:
    phonetic: HEN-ree AWL-der
    ipa: /ˈhɛn.ri ˈɔːl.dər/
    audio_url: /media/pronunciation-henry.wav
    source_url: https://en.wiktionary.org/wiki/Alder
  Oakville:
    phonetic: OHK-vil
    ipa: /ˈoʊk.vɪl/
    audio_url: /media/pronunciation-oakville.wav
    source_url: https://en.wikipedia.org/wiki/Oakville
`),
    });
    await mkdir(path.join(repoDir, 'public'), { recursive: true });
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({ name: 'Kinloom', short_name: 'Kinloom', icons: [{ src: '/icon-192.png' }] }),
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'favicon-light.svg'),
      '<svg><style>.kl-accent { stroke: #7A4612; }</style></svg>',
      'utf8'
    );
    await writeFile(
      path.join(repoDir, 'public', 'sw.js'),
      'const OFFLINE_HTML = ":root{--bg:#F5EFE2;--accent:#7A4612}";',
      'utf8'
    );

    // Default verify warns without failing (exit 0)
    const defaultCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', repoDir, '--json'], { io: defaultCap.io })).toBe(EXIT_OK);
    const parsedDefault = JSON.parse(defaultCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedDefault.ok).toBe(true);
    expect(parsedDefault.strictBrandkit).toBe(false);
    expect(parsedDefault.checks.brandkitManifest.ok).toBe(false);
    expect(parsedDefault.checks.brandkitManifest.warnings).toHaveLength(3);
    expect(parsedDefault.checks.brandkitManifest.warnings[0]).toContain('kinloom brandkit --out public');
    expect(parsedDefault.checks.brandkitManifest.warnings[0]).toContain(
      'name="Kinloom", short_name="Kinloom"'
    );
    expect(parsedDefault.checks.brandkitManifest.warnings[1]).toContain(
      'favicon-light.svg uses accent #7A4612'
    );
    expect(parsedDefault.checks.brandkitManifest.warnings[2]).toContain(
      'sw.js offline notice uses accent #7A4612'
    );
    expect(parsedDefault.warnings.filter((w) => w.startsWith('[brandkit-manifest]'))).toHaveLength(3);
    expect(parsedDefault.errors).toEqual([]);

    const defaultText = await runVerifyCommand({ repoDir });
    expect(defaultText.rendered).toContain(
      '11. Brandkit manifest: WARN | present=yes name=Kinloom warnings=3'
    );

    // --strict-brandkit fails (exit 1)
    const strictBrandkitCap = createCaptureIo();
    expect(
      await runCli(['verify', '--repo', repoDir, '--strict-brandkit', '--json'], { io: strictBrandkitCap.io })
    ).toBe(EXIT_ERROR);
    const parsedStrictBrandkit = JSON.parse(strictBrandkitCap.stdout.join('\n')) as VerifyCommandResult;
    expect(parsedStrictBrandkit.ok).toBe(false);
    expect(parsedStrictBrandkit.strictBrandkit).toBe(true);
    expect(parsedStrictBrandkit.errors).toHaveLength(3);
    expect(parsedStrictBrandkit.errors.every((e) => e.startsWith('brandkit-manifest:'))).toBe(true);

    // --strict also fails on brandkit drift
    const strictCap = createCaptureIo();
    expect(await runCli(['verify', '--repo', repoDir, '--strict'], { io: strictCap.io })).toBe(EXIT_ERROR);
    expect(strictCap.stdout.join('\n')).toContain('11. Brandkit manifest: FAIL | present=yes name=Kinloom');

    // Title drift (custom stale name, non-Kinloom) is also caught
    await writeFile(
      path.join(repoDir, 'public', 'site.webmanifest'),
      JSON.stringify({
        name: 'Old Archive Title',
        short_name: 'Old Archive',
        icons: [{ src: '/icon-192.png' }],
      }),
      'utf8'
    );
    const titleDrift = checkBrandkitManifest(repoDir, makeBaseSiteConfig());
    expect(titleDrift.ok).toBe(false);
    expect(titleDrift.warnings[0]).toContain('does not match expected title "Alder Family Archive"');
  });
});
