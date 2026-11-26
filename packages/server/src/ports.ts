import type { KinloomServerPorts as CoreKinloomServerPorts } from '@kinloom/core';

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

export interface KinloomServerPorts extends CoreKinloomServerPorts {
  pronunciationGenerator?: PronunciationAudioGenerator;
}
