import fs from 'node:fs';
import path from 'node:path';
import {
  getCurrentReferenceYear,
  type KinloomSiteConfig,
  type Place,
  type Pronunciation,
  parseKinloomConfigYaml,
  parsePeopleYaml,
  parsePlacesYaml,
  type RawPerson,
  resolveEffectiveLiving,
  resolvePersonPronunciation,
  resolvePlacePronunciation,
} from '@kinloom/core';
import { CliValidationError } from '../../../errors.js';
import {
  computePronunciationCacheKey,
  formatPhonemeTerm,
  type PhonemeMode,
  pronunciationAudioFilename,
} from '../shared/audio/index.js';
import {
  detectLivingPronunciationLeaks,
  hasPronunciationValues,
  loadArchivePronunciationLexicon,
} from '../shared/pronunciation/index.js';

export type PronounceSynthScope = 'lexicon' | 'curated' | 'all';
export type PronounceAudioFormat = 'wav' | 'mp3';

export interface PronounceSynthTarget {
  readonly id: string;
  readonly scope: 'lexicon' | 'place' | 'person';
  readonly key: string;
  readonly text: string;
  readonly phonetic?: string;
  readonly ipa?: string;
  readonly language?: string;
  readonly voice: string;
  readonly cache_key: string;
  readonly filename: string;
  readonly audio_url: string;
  readonly speech_input: string;
  readonly existing_audio_url?: string;
}

export interface DeduplicatedPronounceOverride {
  readonly scope: 'place' | 'person';
  readonly key: string;
  readonly cache_key: string;
  readonly audio_url: string;
}

export interface CollectedPronounceTargets {
  readonly repoDir: string;
  readonly configPath: string;
  readonly siteConfig: KinloomSiteConfig;
  readonly peoplePath: string;
  readonly people: readonly RawPerson[];
  readonly livingPersonIds: ReadonlySet<string>;
  readonly placesPath: string;
  readonly places: readonly Place[];
  readonly livingExcluded: number;
  readonly targets: readonly PronounceSynthTarget[];
  readonly deduplicatedOverrides: readonly DeduplicatedPronounceOverride[];
  readonly deduplicatedCount: number;
}

function isGeocodedPlace(place: Place): boolean {
  return (
    typeof place.lat === 'number' &&
    typeof place.lng === 'number' &&
    Number.isFinite(place.lat) &&
    Number.isFinite(place.lng) &&
    (Math.abs(place.lat) > 1e-9 || Math.abs(place.lng) > 1e-9)
  );
}

function isSpeakableEntry(entry: Pronunciation | undefined): entry is Pronunciation {
  return Boolean(entry && (entry.phonetic?.trim() || entry.ipa?.trim()));
}

export function collectPronounceSynthTargets(options: {
  readonly repoDir: string;
  readonly scope: PronounceSynthScope;
  readonly voice: string;
  readonly format: PronounceAudioFormat;
  readonly phonemeMode: PhonemeMode;
}): CollectedPronounceTargets {
  const repoDir = path.resolve(options.repoDir.trim() || process.cwd());
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    throw new CliValidationError(`Repository directory does not exist: ${repoDir}`);
  }

  const configPath = path.join(repoDir, 'kinloom.config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new CliValidationError(
      `Missing ${configPath} (pass --repo <archive-root> if running outside the archive root).`
    );
  }

  const peoplePath = path.join(repoDir, 'data', 'people.yaml');
  const placesPath = path.join(repoDir, 'data', 'places.yaml');

  const siteConfig = parseKinloomConfigYaml(fs.readFileSync(configPath, 'utf8'));
  const people: RawPerson[] = fs.existsSync(peoplePath)
    ? parsePeopleYaml(fs.readFileSync(peoplePath, 'utf8'))
    : [];
  const places: Place[] = fs.existsSync(placesPath)
    ? parsePlacesYaml(fs.readFileSync(placesPath, 'utf8'))
    : [];

  const lexicon = loadArchivePronunciationLexicon(repoDir, siteConfig.pronunciations);
  const lexiconLowerKeys = new Map<string, string>();
  for (const key of Object.keys(lexicon)) {
    lexiconLowerKeys.set(key.trim().toLowerCase(), key);
  }

  const deceasedPeople: RawPerson[] = [];
  const livingPeople: Array<{ index: number; person: RawPerson }> = [];
  const referenceYear = siteConfig.privacy.referenceYear ?? getCurrentReferenceYear();
  for (let i = 0; i < people.length; i += 1) {
    const person = people[i];
    if (person === undefined) continue;
    if (
      person.is_living ||
      person.full_name.trim() === 'Living' ||
      resolveEffectiveLiving(person, siteConfig.privacy, referenceYear)
    ) {
      livingPeople.push({ index: i + 1, person });
      continue;
    }
    deceasedPeople.push(person);
  }

  const livingLeaks = detectLivingPronunciationLeaks(livingPeople, deceasedPeople, lexiconLowerKeys);
  if (livingLeaks.length > 0) {
    throw new CliValidationError(
      `Privacy fence blocked synthesis: found ${livingLeaks.length} living-person pronunciation leak(s). Run \`kinloom pronounce audit\` to inspect and remove them first.`
    );
  }

  const seenAudioUrlByCacheKey = new Map<string, string>();
  const targets: PronounceSynthTarget[] = [];
  const deduplicatedOverrides: DeduplicatedPronounceOverride[] = [];
  let deduplicatedCount = 0;

  const pushTarget = (params: {
    id: string;
    scope: 'lexicon' | 'place' | 'person';
    key: string;
    text: string;
    entry: Pronunciation;
    explicitOverride?: boolean;
  }): void => {
    if (!isSpeakableEntry(params.entry)) {
      return;
    }
    const cacheKey = computePronunciationCacheKey({
      text: params.text,
      phonetic: params.entry.phonetic,
      ipa: params.entry.ipa,
      language: params.entry.language,
      voice: options.voice,
    });
    const existingAudioUrl = seenAudioUrlByCacheKey.get(cacheKey);
    if (existingAudioUrl !== undefined) {
      deduplicatedCount += 1;
      if (params.explicitOverride && (params.scope === 'place' || params.scope === 'person')) {
        deduplicatedOverrides.push({
          scope: params.scope,
          key: params.key,
          cache_key: cacheKey,
          audio_url: existingAudioUrl,
        });
      }
      return;
    }

    const filename = pronunciationAudioFilename({
      text: params.text,
      phonetic: params.entry.phonetic,
      ipa: params.entry.ipa,
      language: params.entry.language,
      voice: options.voice,
      ext: options.format,
    });
    const audioUrl = `/media/${filename}`;
    seenAudioUrlByCacheKey.set(cacheKey, audioUrl);
    const speechInput = formatPhonemeTerm(
      {
        text: params.text,
        ipa: params.entry.ipa,
        phonetic: params.entry.phonetic,
      },
      options.phonemeMode
    );

    targets.push({
      id: params.id,
      scope: params.scope,
      key: params.key,
      text: params.text,
      ...(params.entry.phonetic ? { phonetic: params.entry.phonetic } : {}),
      ...(params.entry.ipa ? { ipa: params.entry.ipa } : {}),
      ...(params.entry.language ? { language: params.entry.language } : {}),
      voice: options.voice,
      cache_key: cacheKey,
      filename,
      audio_url: audioUrl,
      speech_input: speechInput,
      ...(params.entry.audio_url ? { existing_audio_url: params.entry.audio_url } : {}),
    });
  };

  for (const [term, entry] of Object.entries(lexicon).toSorted(([a], [b]) => a.localeCompare(b))) {
    pushTarget({
      id: `lexicon:${term}`,
      scope: 'lexicon',
      key: term,
      text: term,
      entry,
    });
  }

  if (options.scope === 'curated' || options.scope === 'all') {
    const sortedPlaces = [...places].toSorted(
      (a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id)
    );
    for (const place of sortedPlaces) {
      if (place.pronunciation && hasPronunciationValues(place.pronunciation)) {
        pushTarget({
          id: `place:${place.id}`,
          scope: 'place',
          key: place.id,
          text: place.name,
          entry: place.pronunciation,
          explicitOverride: true,
        });
      } else if (options.scope === 'all' && isGeocodedPlace(place)) {
        const resolved = resolvePlacePronunciation(place, lexicon);
        if (resolved && isSpeakableEntry(resolved)) {
          pushTarget({
            id: `place:${place.id}`,
            scope: 'place',
            key: place.id,
            text: place.name,
            entry: resolved,
          });
        }
      }
    }

    const sortedDeceased = [...deceasedPeople].toSorted(
      (a, b) => a.full_name.localeCompare(b.full_name) || a.id.localeCompare(b.id)
    );
    for (const person of sortedDeceased) {
      if (person.pronunciation && hasPronunciationValues(person.pronunciation)) {
        pushTarget({
          id: `person:${person.id}`,
          scope: 'person',
          key: person.id,
          text: person.full_name,
          entry: person.pronunciation,
          explicitOverride: true,
        });
      } else if (options.scope === 'all') {
        const resolved = resolvePersonPronunciation(person, lexicon);
        if (resolved && isSpeakableEntry(resolved)) {
          pushTarget({
            id: `person:${person.id}`,
            scope: 'person',
            key: person.id,
            text: person.full_name,
            entry: resolved,
          });
        }
      }
    }
  }

  return {
    repoDir,
    configPath,
    siteConfig,
    peoplePath,
    people,
    livingPersonIds: new Set(livingPeople.map((entry) => entry.person.id)),
    placesPath,
    places,
    livingExcluded: livingPeople.length,
    targets,
    deduplicatedOverrides,
    deduplicatedCount,
  };
}
