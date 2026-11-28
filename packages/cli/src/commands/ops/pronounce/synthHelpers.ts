import fs from 'node:fs';
import {
  type KinloomSiteConfig,
  type Place,
  type Pronunciation,
  type RawPerson,
  serializeKinloomConfigYaml,
  serializePeopleYaml,
  serializePlacesYaml,
} from '@kinloom/core';
import { OPENAI_SPEECH_RETRYABLE_STATUSES, type PhonemeMode } from '../shared/audio/index.js';
import { hasPronunciationValues } from '../shared/pronunciation/index.js';
import type {
  DeduplicatedPronounceOverride,
  PronounceAudioFormat,
  PronounceSynthScope,
  PronounceSynthTarget,
} from './synthTargets.js';

export type PronounceSynthBackend = 'gemini' | 'openai-speech';
export const DEFAULT_PRONOUNCE_GEMINI_MODEL = 'gemini-3.8-flash-tts';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface PronounceSynthItemResult {
  readonly id: string;
  readonly scope: 'lexicon' | 'place' | 'person';
  readonly key: string;
  readonly text: string;
  readonly filename: string;
  readonly audio_url: string;
  readonly status: 'synthesized' | 'imported' | 'skipped_existing' | 'planned' | 'missing_import';
  readonly size_bytes?: number;
}

export interface PronounceSynthResult {
  readonly ok: true;
  readonly mode: 'synth' | 'dry_run' | 'export_manifest' | 'import_dir';
  readonly repo: string;
  readonly out_dir: string;
  readonly backend: PronounceSynthBackend;
  readonly model: string;
  readonly voice: string;
  readonly phoneme_mode: PhonemeMode;
  readonly format: PronounceAudioFormat;
  readonly scope: PronounceSynthScope;
  readonly manifest_path: string | null;
  readonly config_updated: boolean;
  readonly config_entries_updated: number;
  readonly updatedConfigEntries: number;
  readonly updatedPersonEntries: number;
  readonly updatedPlaceEntries: number;
  readonly summary: {
    readonly total_targets: number;
    readonly deduplicated: number;
    readonly living_people_excluded: number;
    readonly synthesized: number;
    readonly imported: number;
    readonly skipped_existing: number;
    readonly planned: number;
    readonly missing_import: number;
  };
  readonly items: readonly PronounceSynthItemResult[];
  readonly rendered: string;
}

export interface PronounceBatchManifest {
  readonly version: 1;
  readonly kind: 'kinloom-pronounce-manifest';
  readonly generated_at: string;
  readonly backend: PronounceSynthBackend;
  readonly model: string;
  readonly voice: string;
  readonly phoneme_mode: PhonemeMode;
  readonly format: PronounceAudioFormat;
  readonly scope: PronounceSynthScope;
  readonly living_people_excluded: number;
  readonly targets: readonly PronounceSynthTarget[];
}

export function wrapPcmAsWav(pcm: Buffer, sampleRate = 24000, channels = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

export async function synthesizeTargetWithGemini(params: {
  readonly target: PronounceSynthTarget;
  readonly model: string;
  readonly apiKey: string;
  readonly fetchImpl: typeof fetch;
  readonly sleepFn: (ms: number) => Promise<void>;
}): Promise<Buffer> {
  const url = `${GEMINI_API_BASE}/${encodeURIComponent(params.model)}:generateContent`;
  const promptParts = [params.target.text];
  if (params.target.ipa) {
    promptParts.push(params.target.ipa);
  } else if (params.target.phonetic) {
    promptParts.push(params.target.phonetic);
  }
  const prompt = promptParts.join(' ');
  const retries = 3;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await params.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: params.target.voice } },
          },
        },
      }),
    });

    if (OPENAI_SPEECH_RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
      await params.sleepFn(1500 * 2 ** attempt);
      continue;
    }

    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`gemini-tts HTTP ${response.status}: ${bodyText.slice(0, 600)}`);
    }

    const parsed: unknown = JSON.parse(bodyText);
    const root = isPlainRecord(parsed) ? parsed : {};
    const candidates = Array.isArray(root['candidates']) ? root['candidates'] : [];
    const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
    const content = firstCand && isPlainRecord(firstCand['content']) ? firstCand['content'] : undefined;
    const parts = content && Array.isArray(content['parts']) ? content['parts'] : [];
    const firstPart = isPlainRecord(parts[0]) ? parts[0] : undefined;
    const inlineData =
      firstPart && isPlainRecord(firstPart['inlineData']) ? firstPart['inlineData'] : undefined;
    if (!inlineData || typeof inlineData['data'] !== 'string') {
      throw new Error(`gemini-tts response missing inline audio data for '${params.target.text}'`);
    }

    const decoded = Buffer.from(inlineData['data'], 'base64');
    if (decoded.length >= 4 && decoded.toString('ascii', 0, 4) === 'RIFF') {
      return decoded;
    }
    const mimeType = typeof inlineData['mimeType'] === 'string' ? inlineData['mimeType'] : '';
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    const rate = rateMatch ? Number.parseInt(rateMatch[1] ?? '', 10) : 24000;
    return wrapPcmAsWav(decoded, rate);
  }

  throw new Error(`gemini-tts failed after retries for '${params.target.text}'`);
}

export interface PronunciationAudioUpdateCounts {
  readonly updatedConfigEntries: number;
  readonly updatedPersonEntries: number;
  readonly updatedPlaceEntries: number;
}

export function applyPronunciationAudioUpdates(params: {
  readonly configPath: string;
  readonly siteConfig: KinloomSiteConfig;
  readonly peoplePath: string;
  readonly people: readonly RawPerson[];
  readonly livingPersonIds: ReadonlySet<string>;
  readonly placesPath: string;
  readonly places: readonly Place[];
  readonly targets: readonly PronounceSynthTarget[];
  readonly deduplicatedOverrides: readonly DeduplicatedPronounceOverride[];
  readonly items: readonly PronounceSynthItemResult[];
  readonly force: boolean;
  readonly dryRun?: boolean;
}): PronunciationAudioUpdateCounts {
  const existingPronunciations = params.siteConfig.pronunciations ?? {};
  const nextPronunciations: Record<string, Pronunciation> = { ...existingPronunciations };
  const targetById = new Map(params.targets.map((target) => [target.id, target]));
  const eligibleCacheKeys = new Set<string>();
  const personAudioById = new Map<string, string>();
  const placeAudioById = new Map<string, string>();
  let updatedConfigEntries = 0;

  for (const item of params.items) {
    const isEligible =
      item.status === 'synthesized' ||
      item.status === 'imported' ||
      item.status === 'skipped_existing' ||
      (params.dryRun === true && item.status === 'planned');
    if (!isEligible) {
      continue;
    }

    const target = targetById.get(item.id);
    if (target) {
      eligibleCacheKeys.add(target.cache_key);
    }

    if (item.scope === 'lexicon') {
      const entry = nextPronunciations[item.key];
      if (!entry) {
        continue;
      }
      if (entry.audio_url?.trim() && !params.force) {
        continue;
      }
      if (entry.audio_url === item.audio_url) {
        continue;
      }
      nextPronunciations[item.key] = {
        ...entry,
        audio_url: item.audio_url,
      };
      updatedConfigEntries += 1;
      continue;
    }

    if (item.scope === 'person') {
      personAudioById.set(item.key, item.audio_url);
    } else if (item.scope === 'place') {
      placeAudioById.set(item.key, item.audio_url);
    }
  }

  for (const override of params.deduplicatedOverrides) {
    if (!eligibleCacheKeys.has(override.cache_key)) {
      continue;
    }
    if (override.scope === 'person' && !personAudioById.has(override.key)) {
      personAudioById.set(override.key, override.audio_url);
    } else if (override.scope === 'place' && !placeAudioById.has(override.key)) {
      placeAudioById.set(override.key, override.audio_url);
    }
  }

  let updatedPersonEntries = 0;
  const nextPeople: RawPerson[] = params.people.map((person) => {
    if (params.livingPersonIds.has(person.id) || person.is_living || person.full_name.trim() === 'Living') {
      return person;
    }
    if (!person.pronunciation || !hasPronunciationValues(person.pronunciation)) {
      return person;
    }
    const nextAudioUrl = personAudioById.get(person.id);
    if (!nextAudioUrl) {
      return person;
    }
    if (person.pronunciation.audio_url?.trim() && !params.force) {
      return person;
    }
    if (person.pronunciation.audio_url === nextAudioUrl) {
      return person;
    }
    updatedPersonEntries += 1;
    return {
      ...person,
      pronunciation: {
        ...person.pronunciation,
        audio_url: nextAudioUrl,
      },
    };
  });

  let updatedPlaceEntries = 0;
  const nextPlaces: Place[] = params.places.map((place) => {
    if (!place.pronunciation || !hasPronunciationValues(place.pronunciation)) {
      return place;
    }
    const nextAudioUrl = placeAudioById.get(place.id);
    if (!nextAudioUrl) {
      return place;
    }
    if (place.pronunciation.audio_url?.trim() && !params.force) {
      return place;
    }
    if (place.pronunciation.audio_url === nextAudioUrl) {
      return place;
    }
    updatedPlaceEntries += 1;
    return {
      ...place,
      pronunciation: {
        ...place.pronunciation,
        audio_url: nextAudioUrl,
      },
    };
  });

  if (!params.dryRun) {
    if (updatedConfigEntries > 0) {
      const nextConfig: KinloomSiteConfig = {
        ...params.siteConfig,
        pronunciations: nextPronunciations,
      };
      fs.writeFileSync(params.configPath, serializeKinloomConfigYaml(nextConfig), 'utf8');
    }
    if (updatedPersonEntries > 0) {
      fs.writeFileSync(params.peoplePath, serializePeopleYaml(nextPeople), 'utf8');
    }
    if (updatedPlaceEntries > 0) {
      fs.writeFileSync(params.placesPath, serializePlacesYaml(nextPlaces), 'utf8');
    }
  }

  return {
    updatedConfigEntries,
    updatedPersonEntries,
    updatedPlaceEntries,
  };
}

export function formatPronounceSynthText(result: Omit<PronounceSynthResult, 'rendered'>): string {
  const s = result.summary;
  const lines: string[] = [
    `Pronunciation Synth (${result.mode}) — ${result.repo}`,
    `  Backend: ${result.backend} | Model: ${result.model} | Voice: ${result.voice} | Phonemes: ${result.phoneme_mode} | Format: ${result.format}`,
    `  Targets: ${s.total_targets} (deduplicated: ${s.deduplicated}, living excluded: ${s.living_people_excluded})`,
  ];
  if (result.mode === 'export_manifest' && result.manifest_path) {
    lines.push(`  Manifest written: ${result.manifest_path}`);
  } else if (result.mode === 'import_dir') {
    lines.push(
      `  Imported: ${s.imported} | Skipped existing: ${s.skipped_existing} | Missing in import dir: ${s.missing_import}`
    );
  } else if (result.mode === 'dry_run') {
    const missingPart = s.missing_import > 0 ? ` | Missing in import dir: ${s.missing_import}` : '';
    lines.push(`  Planned: ${s.planned} | Skipped existing: ${s.skipped_existing}${missingPart}`);
  } else {
    lines.push(`  Synthesized: ${s.synthesized} | Skipped existing: ${s.skipped_existing}`);
  }
  const verb = result.mode === 'dry_run' ? 'Would update' : 'Updated';
  if (result.updatedConfigEntries > 0) {
    lines.push(`  ${verb} kinloom.config.yaml audio_url entries: ${result.updatedConfigEntries}`);
  }
  if (result.updatedPersonEntries > 0) {
    lines.push(`  ${verb} data/people.yaml audio_url entries: ${result.updatedPersonEntries}`);
  }
  if (result.updatedPlaceEntries > 0) {
    lines.push(`  ${verb} data/places.yaml audio_url entries: ${result.updatedPlaceEntries}`);
  }
  return lines.join('\n');
}

export function buildSynthResult(
  body: Omit<PronounceSynthResult, 'rendered'>,
  json: boolean
): PronounceSynthResult {
  return {
    ...body,
    rendered: json ? JSON.stringify(body, null, 2) : formatPronounceSynthText(body),
  };
}
