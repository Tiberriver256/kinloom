import type { MediaStore } from '@kinloom/core';
import { sha256Hex } from '../crypto.js';
import type { PronunciationAudioGenerator } from '../ports.js';

export interface StoredPronunciationAudio {
  audio_url: string;
  content_type: string;
  size_bytes: number;
  deduplicated?: boolean;
}

/**
 * Build a deterministic, case-normalized cache key for a pronunciation request
 * so shared surnames, given names, and places reuse one R2 clip without
 * calling Gemini TTS more than once.
 */
export async function computePronunciationPromptHash(params: {
  text: string;
  phonetic?: string;
  ipa?: string;
  language?: string;
  voice?: string;
}): Promise<string> {
  const text = params.text.trim().toLowerCase();
  const phonetic = (params.phonetic ?? '').trim().toLowerCase();
  const ipa = (params.ipa ?? '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .trim();
  const lang = (params.language ?? '').trim().toLowerCase();
  const voice = (params.voice ?? 'Charon').trim().toLowerCase();
  const raw = new TextEncoder().encode(
    `v2|text:${text}|phonetic:${phonetic}|ipa:${ipa}|lang:${lang}|voice:${voice}`
  );
  return sha256Hex(raw);
}

export async function generateAndStorePronunciationAudio(params: {
  generator: PronunciationAudioGenerator;
  mediaStore: MediaStore;
  entityType: 'person' | 'place';
  text: string;
  phonetic?: string;
  ipa?: string;
  language?: string;
  voice?: string;
  force?: boolean;
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
    phonetic: params.phonetic,
    ipa: params.ipa,
    language: params.language,
    voice: params.voice,
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
