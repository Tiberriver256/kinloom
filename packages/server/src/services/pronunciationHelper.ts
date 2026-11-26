import type { MediaStore } from '@kinloom/core';
import { sha256Hex } from '../crypto.js';
import type { PronunciationAudioGenerator } from '../ports.js';

export interface StoredPronunciationAudio {
  audio_url: string;
  content_type: string;
  size_bytes: number;
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
}): Promise<StoredPronunciationAudio> {
  const result = await params.generator.generate({
    text: params.text,
    phonetic: params.phonetic,
    ipa: params.ipa,
    language: params.language,
    voice: params.voice,
  });

  const sha256 = await sha256Hex(result.bytes);
  const filename = `pronunciation-${params.entityType}-${sha256.slice(0, 16)}.${result.ext}`;
  const storeKey = `media/${filename}`;
  const publicUrl = `/media/${filename}`;

  const existing = await params.mediaStore.head(storeKey);
  if (!existing.exists) {
    const arrayBuffer = new Uint8Array(result.bytes).buffer;
    await params.mediaStore.put({
      key: storeKey,
      body: arrayBuffer,
      contentType: result.contentType,
      sha256,
    });
  }

  return {
    audio_url: publicUrl,
    content_type: result.contentType,
    size_bytes: result.bytes.byteLength,
  };
}
