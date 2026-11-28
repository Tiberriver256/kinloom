import type { MediaStore, PronunciationAudioGenerator, PronunciationPhonemeMode } from '@kinloom/core';
import { sha256Hex } from '../crypto.js';

export interface StoredPronunciationAudio {
  audio_url: string;
  content_type: string;
  size_bytes: number;
  deduplicated?: boolean;
}

function trimEdgeSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Build a deterministic, case-normalized cache key for a pronunciation request
 * so shared surnames, given names, and places reuse one R2 clip without
 * calling TTS more than once.
 */
export async function computePronunciationPromptHash(params: {
  text: string;
  phonetic?: string | undefined;
  ipa?: string | undefined;
  language?: string | undefined;
  voice?: string | undefined;
  phonemeMode?: PronunciationPhonemeMode | undefined;
}): Promise<string> {
  const text = params.text.trim().toLowerCase();
  const phonetic = (params.phonetic ?? '').trim().toLowerCase();
  const ipa = trimEdgeSlashes((params.ipa ?? '').trim()).trim();
  const lang = (params.language ?? '').trim().toLowerCase();
  const voice = (params.voice ?? 'Charon').trim().toLowerCase();
  const modeSuffix = params.phonemeMode && params.phonemeMode !== 'ipa' ? `|mode:${params.phonemeMode}` : '';
  const raw = new TextEncoder().encode(
    `v2|text:${text}|phonetic:${phonetic}|ipa:${ipa}|lang:${lang}|voice:${voice}${modeSuffix}`
  );
  return sha256Hex(raw);
}

export async function generateAndStorePronunciationAudio(params: {
  generator: PronunciationAudioGenerator;
  mediaStore: MediaStore;
  entityType: 'person' | 'place';
  text: string;
  phonetic?: string | undefined;
  ipa?: string | undefined;
  language?: string | undefined;
  voice?: string | undefined;
  phonemeMode?: PronunciationPhonemeMode | undefined;
  force?: boolean | undefined;
}): Promise<StoredPronunciationAudio> {
  const promptHash = await computePronunciationPromptHash(params);

  // Pre-generation R2 deduplication: reuse existing clip for identical prompt/surname/place
  if (!params.force) {
    for (const ext of ['wav', 'mp3'] as const) {
      const candidateFilename = `pronunciation-${promptHash.slice(0, 16)}.${ext}`;
      const candidateKey = `media/${candidateFilename}`;
      const existing = await params.mediaStore.head(candidateKey);
      if (existing.exists) {
        return {
          audio_url: `/media/${candidateFilename}`,
          content_type: existing.contentType ?? (ext === 'wav' ? 'audio/wav' : 'audio/mpeg'),
          size_bytes: existing.sizeBytes ?? 0,
          deduplicated: true,
        };
      }
    }
  }

  const result = await params.generator.generate({
    text: params.text,
    ...(params.phonetic !== undefined ? { phonetic: params.phonetic } : {}),
    ...(params.ipa !== undefined ? { ipa: params.ipa } : {}),
    ...(params.language !== undefined ? { language: params.language } : {}),
    ...(params.voice !== undefined ? { voice: params.voice } : {}),
    ...(params.phonemeMode !== undefined ? { phonemeMode: params.phonemeMode } : {}),
  });

  const sha256 = await sha256Hex(result.bytes);
  const filename = `pronunciation-${promptHash.slice(0, 16)}.${result.ext}`;
  const storeKey = `media/${filename}`;
  const publicUrl = `/media/${filename}`;

  const arrayBuffer = new Uint8Array(result.bytes).buffer;
  await params.mediaStore.put({
    key: storeKey,
    body: arrayBuffer,
    contentType: result.contentType,
    sha256,
  });

  return {
    audio_url: publicUrl,
    content_type: result.contentType,
    size_bytes: result.bytes.byteLength,
    deduplicated: false,
  };
}
