import fs from 'node:fs';
import { type KinloomSiteConfig, type Pronunciation, serializeKinloomConfigYaml } from '@kinloom/core';
import { OPENAI_SPEECH_RETRYABLE_STATUSES, type PhonemeMode } from '../shared/audio/index.js';
import type { PronounceAudioFormat, PronounceSynthScope, PronounceSynthTarget } from './synthTargets.js';

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
    const candidates = Array.isArray(root.candidates) ? root.candidates : [];
    const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
    const content = firstCand && isPlainRecord(firstCand.content) ? firstCand.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    const firstPart = isPlainRecord(parts[0]) ? parts[0] : undefined;
    const inlineData = firstPart && isPlainRecord(firstPart.inlineData) ? firstPart.inlineData : undefined;
    if (!inlineData || typeof inlineData.data !== 'string') {
      throw new Error(`gemini-tts response missing inline audio data for '${params.target.text}'`);
    }

    const decoded = Buffer.from(inlineData.data, 'base64');
    if (decoded.length >= 4 && decoded.toString('ascii', 0, 4) === 'RIFF') {
      return decoded;
    }
    const mimeType = typeof inlineData.mimeType === 'string' ? inlineData.mimeType : '';
    const rateMatch = /rate=(\d+)/.exec(mimeType);
    const rate = rateMatch ? Number.parseInt(rateMatch[1], 10) : 24000;
    return wrapPcmAsWav(decoded, rate);
  }

  throw new Error(`gemini-tts failed after retries for '${params.target.text}'`);
}

export function applyConfigAudioUpdates(params: {
  readonly configPath: string;
  readonly siteConfig: KinloomSiteConfig;
  readonly items: readonly PronounceSynthItemResult[];
  readonly force: boolean;
}): number {
  const existingPronunciations = params.siteConfig.pronunciations ?? {};
  const nextPronunciations: Record<string, Pronunciation> = { ...existingPronunciations };
  let updatedCount = 0;

  for (const item of params.items) {
    if (item.scope !== 'lexicon') {
      continue;
    }
    if (item.status !== 'synthesized' && item.status !== 'imported' && item.status !== 'skipped_existing') {
      continue;
    }
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
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    const nextConfig: KinloomSiteConfig = {
      ...params.siteConfig,
      pronunciations: nextPronunciations,
    };
    fs.writeFileSync(params.configPath, serializeKinloomConfigYaml(nextConfig), 'utf8');
  }
  return updatedCount;
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
    lines.push(`  Planned: ${s.planned} | Skipped existing: ${s.skipped_existing}`);
  } else {
    lines.push(`  Synthesized: ${s.synthesized} | Skipped existing: ${s.skipped_existing}`);
  }
  if (result.config_updated) {
    lines.push(`  Updated kinloom.config.yaml audio_url entries: ${result.config_entries_updated}`);
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
