import { DEFAULT_SAMPLE_RATE, extractWavPcm, wrapPcmAsWav } from '../vtt.ts';
import type { TutorialTtsProvider, TutorialTtsRequest } from './provider.ts';

export const DEFAULT_OPENAI_SPEECH_MODEL = 'tts-1';

export interface OpenAiSpeechTutorialTtsOptions {
  readonly endpointUrl: string;
  readonly apiKey?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

export class OpenAiSpeechTutorialTtsProvider implements TutorialTtsProvider {
  readonly providerName = 'openai-speech';
  readonly modelName: string;
  readonly #endpointUrl: string;
  readonly #apiKey?: string;
  readonly #fetchImpl: typeof fetch;

  constructor(options: OpenAiSpeechTutorialTtsOptions) {
    const endpoint = options.endpointUrl.trim();
    if (!endpoint) {
      throw new Error('OpenAiSpeechTutorialTtsProvider requires a non-empty endpointUrl.');
    }
    this.#endpointUrl = endpoint;
    this.#apiKey = options.apiKey?.trim() || undefined;
    this.modelName = options.model ?? DEFAULT_OPENAI_SPEECH_MODEL;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  async synthesize(request: TutorialTtsRequest): Promise<{ readonly wav: Buffer; readonly sampleRate: number }> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (this.#apiKey) {
      headers.authorization = `Bearer ${this.#apiKey}`;
    }

    const response = await this.#fetchImpl(this.#endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.modelName,
        voice: request.voice,
        input: request.text,
        response_format: 'wav',
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`OpenAI-compatible TTS failed with HTTP ${response.status}: ${detail.slice(0, 400)}`);
    }

    const rawBytes = Buffer.from(await response.arrayBuffer());
    const parsed = extractWavPcm(rawBytes, request.sampleRate ?? DEFAULT_SAMPLE_RATE);
    return {
      wav: wrapPcmAsWav(parsed.pcm, parsed.sampleRate),
      sampleRate: parsed.sampleRate,
    };
  }
}
