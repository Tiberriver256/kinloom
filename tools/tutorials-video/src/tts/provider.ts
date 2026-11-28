import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SAMPLE_RATE, measureWavDurationSeconds } from '../vtt.ts';

export interface TutorialTtsRequest {
  readonly text: string;
  readonly voice: string;
  readonly style: string;
  readonly sampleRate?: number;
}

export interface TutorialTtsResult {
  readonly wav: Buffer;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly cacheHit: boolean;
  readonly cacheKey: string;
}

export interface TutorialTtsProvider {
  readonly providerName: string;
  readonly modelName: string;
  synthesize(request: TutorialTtsRequest): Promise<{
    readonly wav: Buffer;
    readonly sampleRate: number;
  }>;
}

export function normalizeTtsText(text: string): string {
  return text.trim().replaceAll(/\s+/g, ' ');
}

export function computeTtsCacheKey(params: {
  readonly provider: string;
  readonly model: string;
  readonly voice: string;
  readonly style: string;
  readonly text: string;
  readonly sampleRate?: number;
}): string {
  const payload = JSON.stringify({
    provider: params.provider,
    model: params.model,
    voice: params.voice,
    style: params.style.trim(),
    text: normalizeTtsText(params.text),
    sampleRate: params.sampleRate ?? DEFAULT_SAMPLE_RATE,
  });
  return createHash('sha256').update(payload).digest('hex');
}

interface CacheMetaFile {
  readonly provider: string;
  readonly model: string;
  readonly voice: string;
  readonly sampleRate: number;
  readonly durationSeconds: number;
}

export class CachedTutorialTtsProvider {
  readonly #inner: TutorialTtsProvider;
  readonly #cacheDir: string;

  constructor(inner: TutorialTtsProvider, cacheDir: string) {
    this.#inner = inner;
    this.#cacheDir = cacheDir;
  }

  get providerName(): string {
    return this.#inner.providerName;
  }

  get modelName(): string {
    return this.#inner.modelName;
  }

  async synthesize(request: TutorialTtsRequest): Promise<TutorialTtsResult> {
    const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const cacheKey = computeTtsCacheKey({
      provider: this.#inner.providerName,
      model: this.#inner.modelName,
      voice: request.voice,
      style: request.style,
      text: request.text,
      sampleRate,
    });

    const wavPath = path.join(this.#cacheDir, `${cacheKey}.wav`);
    const metaPath = path.join(this.#cacheDir, `${cacheKey}.meta.json`);

    if (fs.existsSync(wavPath) && fs.existsSync(metaPath)) {
      const wav = fs.readFileSync(wavPath);
      const rawMeta: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const meta = rawMeta as Partial<CacheMetaFile>;
      const resolvedRate = typeof meta.sampleRate === 'number' ? meta.sampleRate : sampleRate;
      return {
        wav,
        sampleRate: resolvedRate,
        durationSeconds: measureWavDurationSeconds(wav, resolvedRate),
        cacheHit: true,
        cacheKey,
      };
    }

    const generated = await this.#inner.synthesize({
      ...request,
      text: normalizeTtsText(request.text),
      sampleRate,
    });
    const durationSeconds = measureWavDurationSeconds(generated.wav, generated.sampleRate);

    fs.mkdirSync(this.#cacheDir, { recursive: true });
    fs.writeFileSync(wavPath, generated.wav);
    const metaPayload: CacheMetaFile = {
      provider: this.#inner.providerName,
      model: this.#inner.modelName,
      voice: request.voice,
      sampleRate: generated.sampleRate,
      durationSeconds,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(metaPayload, null, 2)}\n`, 'utf8');

    return {
      wav: generated.wav,
      sampleRate: generated.sampleRate,
      durationSeconds,
      cacheHit: false,
      cacheKey,
    };
  }
}
