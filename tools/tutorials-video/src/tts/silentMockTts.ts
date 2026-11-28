import { DEFAULT_SAMPLE_RATE, wrapPcmAsWav } from '../vtt.ts';
import type { TutorialTtsProvider, TutorialTtsRequest } from './provider.ts';

export function estimateSilentCueDurationSeconds(text: string): number {
  const words = text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.max(2.0, Number((words / 2.5).toFixed(2)));
}

export class SilentMockTutorialTtsProvider implements TutorialTtsProvider {
  readonly providerName = 'silent';
  readonly modelName = 'silent-deterministic-v1';

  async synthesize(request: TutorialTtsRequest): Promise<{ readonly wav: Buffer; readonly sampleRate: number }> {
    const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const durationSeconds = estimateSilentCueDurationSeconds(request.text);
    const totalSamples = Math.max(1, Math.round(sampleRate * durationSeconds));
    const silentPcm = Buffer.alloc(totalSamples * 2);
    return {
      wav: wrapPcmAsWav(silentPcm, sampleRate),
      sampleRate,
    };
  }
}
