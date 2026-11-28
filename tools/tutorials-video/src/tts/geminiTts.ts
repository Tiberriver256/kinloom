import { DEFAULT_SAMPLE_RATE, extractWavPcm, wrapPcmAsWav } from '../vtt.ts';
import type { TutorialTtsProvider, TutorialTtsRequest } from './provider.ts';

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts';
export const DEFAULT_GEMINI_TTS_VOICE = 'Charon';
export const GEMINI_TTS_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GeminiTutorialTtsOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly apiBase?: string;
  readonly retries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class GeminiTutorialTtsProvider implements TutorialTtsProvider {
  readonly providerName = 'gemini';
  readonly modelName: string;
  readonly #apiKey: string;
  readonly #apiBase: string;
  readonly #retries: number;
  readonly #fetchImpl: typeof fetch;
  readonly #sleepFn: (ms: number) => Promise<void>;

  constructor(options: GeminiTutorialTtsOptions) {
    const trimmedKey = options.apiKey.trim();
    if (!trimmedKey) {
      throw new Error('GeminiTutorialTtsProvider requires a non-empty apiKey.');
    }
    this.#apiKey = trimmedKey;
    this.modelName = options.model ?? DEFAULT_GEMINI_TTS_MODEL;
    this.#apiBase = (options.apiBase ?? GEMINI_TTS_API_BASE).replace(/\/+$/, '');
    this.#retries = options.retries ?? 3;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#sleepFn = options.sleepFn ?? defaultSleep;
  }

  async synthesize(request: TutorialTtsRequest): Promise<{ readonly wav: Buffer; readonly sampleRate: number }> {
    const promptText = request.style ? `${request.style}\n\n${request.text}` : request.text;
    const url = `${this.#apiBase}/${encodeURIComponent(this.modelName)}:generateContent`;
    const body = {
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: request.voice || DEFAULT_GEMINI_TTS_VOICE },
          },
        },
      },
    };

    for (let attempt = 0; attempt <= this.#retries; attempt += 1) {
      const response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.#apiKey,
        },
        body: JSON.stringify(body),
      });

      if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < this.#retries) {
        await this.#sleepFn(1000 * (attempt + 1));
        continue;
      }

      const rawText = await response.text();
      if (response.status !== 200) {
        throw new Error(`Gemini TTS (${this.modelName}) failed with HTTP ${response.status}: ${rawText.slice(0, 400)}`);
      }

      const parsed: unknown = JSON.parse(rawText);
      const inlineData = extractInlineAudioData(parsed);
      if (!inlineData) {
        throw new Error(`Gemini TTS (${this.modelName}) response missing inline audio data.`);
      }

      const decoded = Buffer.from(inlineData.data, 'base64');
      if (decoded.byteLength >= 4 && decoded.toString('ascii', 0, 4) === 'RIFF') {
        const parsedWav = extractWavPcm(decoded, request.sampleRate ?? DEFAULT_SAMPLE_RATE);
        return {
          wav: wrapPcmAsWav(parsedWav.pcm, parsedWav.sampleRate),
          sampleRate: parsedWav.sampleRate,
        };
      }

      const rateMatch = /rate=(\d+)/.exec(inlineData.mimeType);
      const sampleRate = rateMatch?.[1]
        ? Number.parseInt(rateMatch[1], 10)
        : (request.sampleRate ?? DEFAULT_SAMPLE_RATE);
      return {
        wav: wrapPcmAsWav(decoded, sampleRate),
        sampleRate,
      };
    }

    throw new Error(`Gemini TTS (${this.modelName}) failed after ${this.#retries + 1} attempts.`);
  }
}

function extractInlineAudioData(parsed: unknown): { readonly data: string; readonly mimeType: string } | null {
  if (!isPlainObject(parsed) || !Array.isArray(parsed['candidates'])) {
    return null;
  }
  const firstCandidate = parsed['candidates'][0];
  if (!isPlainObject(firstCandidate) || !isPlainObject(firstCandidate['content'])) {
    return null;
  }
  const parts = firstCandidate['content']['parts'];
  if (!Array.isArray(parts)) {
    return null;
  }
  for (const part of parts) {
    if (!isPlainObject(part) || !isPlainObject(part['inlineData'])) {
      continue;
    }
    const data = part['inlineData']['data'];
    if (typeof data === 'string' && data.length > 0) {
      const mimeType = typeof part['inlineData']['mimeType'] === 'string' ? part['inlineData']['mimeType'] : 'audio/pcm';
      return { data, mimeType };
    }
  }
  return null;
}
