import { synthesizeOpenAiSpeech, type VoiceCloneReference } from '../../../ops/shared/audio/index.js';
import { type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import { countWords, type SynthChunk, stripWavHeader } from './script.js';
import type { SynthesisOutcome } from './synthesis.js';

export async function synthesizeWithOpenAiSpeech(options: {
  readonly chunks: readonly SynthChunk[];
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey?: string | undefined;
  readonly storyRef?: VoiceCloneReference | undefined;
  readonly notesRef?: VoiceCloneReference | undefined;
  readonly ctx: RecordCommandContext;
}): Promise<SynthesisOutcome> {
  const pcmParts: Buffer[] = [];
  let pcmLength = 0;
  let rate = 24000;
  let totalChars = 0;
  let notesStartSec: number | undefined;

  for (let i = 0; i < options.chunks.length; i += 1) {
    const chunk = options.chunks[i];
    if (chunk === undefined) continue;
    const activeRef = chunk.isNotes ? options.notesRef : options.storyRef;
    let respBytes: Buffer;
    try {
      const resp = await synthesizeOpenAiSpeech({
        endpoint: options.endpoint,
        model: options.model,
        input: chunk.text,
        voice: chunk.voice,
        responseFormat: 'wav',
        apiKey: options.apiKey,
        references: activeRef ? [activeRef] : undefined,
        fetchImpl: options.ctx.fetchImpl,
        sleepFn: options.ctx.sleepFn,
      });
      respBytes = resp.bytes;
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RecordRuntimeError(detail);
    }

    const stripped = stripWavHeader(respBytes, rate);
    rate = stripped.sampleRate;
    if (pcmLength > 0) {
      const silenceSamples = Math.trunc(rate * chunk.pauseBefore);
      const silence = Buffer.alloc(silenceSamples * 2);
      pcmParts.push(silence);
      pcmLength += silence.length;
    }
    if (chunk.isNotes && notesStartSec === undefined) {
      notesStartSec = pcmLength / 2 / rate;
    }
    pcmParts.push(stripped.pcm);
    pcmLength += stripped.pcm.length;
    totalChars += chunk.text.length;
    options.ctx.io.stderr(
      `  section ${i + 1}/${options.chunks.length} [${options.model}:${chunk.voice}]: ${countWords(chunk.text)} words, ` +
        `${(stripped.pcm.length / 2 / rate).toFixed(1)}s, ${chunk.text.length} chars`
    );
  }

  return {
    combinedPcm: Buffer.concat(pcmParts),
    sampleRate: rate,
    notesStartSec,
    usageStr: `${totalChars} chars`,
  };
}
