import type { KinloomServerPorts as CoreKinloomServerPorts, Pronunciation } from '@kinloom/core';

export interface PronunciationAudioResult {
  bytes: Uint8Array;
  contentType: string;
  ext: 'wav' | 'mp3';
}

export interface PronunciationAudioGenerator {
  generate(params: {
    text: string;
    phonetic?: string;
    ipa?: string;
    language?: string;
    voice?: string;
  }): Promise<PronunciationAudioResult>;
}

export interface PronunciationLexiconStore {
  list(): Promise<Record<string, Pronunciation>>;
  upsert(term: string, entry: Pronunciation, updatedBy: string, updatedAt: string): Promise<Pronunciation>;
  delete(term: string): Promise<void>;
}

export interface KinloomServerPorts extends CoreKinloomServerPorts {
  pronunciationGenerator?: PronunciationAudioGenerator;
  pronunciationLexiconStore?: PronunciationLexiconStore;
}
