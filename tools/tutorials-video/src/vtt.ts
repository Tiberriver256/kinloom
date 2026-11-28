export const DEFAULT_SAMPLE_RATE = 24_000;
const BYTES_PER_SAMPLE_MONO_16 = 2;

export interface ParsedWavPcm {
  readonly pcm: Buffer;
  readonly sampleRate: number;
  readonly durationSeconds: number;
}

export interface TimedCaptionCue {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

export interface ConcatenatedStepAudio {
  readonly wav: Buffer;
  readonly sampleRate: number;
  readonly durationSeconds: number;
  readonly cues: readonly TimedCaptionCue[];
}

export function wrapPcmAsWav(pcm: Uint8Array, sampleRate = DEFAULT_SAMPLE_RATE): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.byteLength;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]);
}

export function extractWavPcm(raw: Uint8Array, defaultRate = DEFAULT_SAMPLE_RATE): ParsedWavPcm {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  if (buf.byteLength < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    const durationSeconds = buf.byteLength / (defaultRate * BYTES_PER_SAMPLE_MONO_16);
    return { pcm: Buffer.from(buf), sampleRate: defaultRate, durationSeconds };
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let sampleRate = defaultRate;
  let pcm: Buffer | null = null;
  let offset = 12;

  while (offset + 8 <= buf.byteLength) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const dataStart = offset + 8;
    const dataEnd = Math.min(buf.byteLength, dataStart + chunkSize);

    if (chunkId === 'fmt ' && chunkSize >= 16 && dataStart + 8 <= buf.byteLength) {
      const parsedRate = view.getUint32(dataStart + 4, true);
      if (parsedRate > 0) {
        sampleRate = parsedRate;
      }
    } else if (chunkId === 'data') {
      pcm = Buffer.from(buf.subarray(dataStart, dataEnd));
      break;
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  const finalPcm = pcm ?? Buffer.from(buf);
  const durationSeconds = finalPcm.byteLength / (sampleRate * BYTES_PER_SAMPLE_MONO_16);
  return { pcm: finalPcm, sampleRate, durationSeconds };
}

export function measureWavDurationSeconds(raw: Uint8Array, defaultRate = DEFAULT_SAMPLE_RATE): number {
  return extractWavPcm(raw, defaultRate).durationSeconds;
}

export function concatenateCueWavs(
  segments: readonly {
    readonly text: string;
    readonly wav: Uint8Array;
    readonly pauseAfterSeconds: number;
  }[],
  defaultRate = DEFAULT_SAMPLE_RATE
): ConcatenatedStepAudio {
  const pcmParts: Buffer[] = [];
  const cues: TimedCaptionCue[] = [];
  let sampleRate = defaultRate;
  let cursorBytes = 0;

  for (const segment of segments) {
    const parsed = extractWavPcm(segment.wav, sampleRate);
    sampleRate = parsed.sampleRate;
    const bytesPerSecond = sampleRate * BYTES_PER_SAMPLE_MONO_16;
    const startSeconds = cursorBytes / bytesPerSecond;
    pcmParts.push(parsed.pcm);
    cursorBytes += parsed.pcm.byteLength;
    const endSeconds = cursorBytes / bytesPerSecond;

    cues.push({
      startSeconds,
      endSeconds,
      text: segment.text.trim(),
    });

    if (segment.pauseAfterSeconds > 0) {
      const silenceSamples = Math.round(sampleRate * segment.pauseAfterSeconds);
      const silenceBytes = silenceSamples * BYTES_PER_SAMPLE_MONO_16;
      if (silenceBytes > 0) {
        pcmParts.push(Buffer.alloc(silenceBytes));
        cursorBytes += silenceBytes;
      }
    }
  }

  const combinedPcm = Buffer.concat(pcmParts);
  const durationSeconds = combinedPcm.byteLength / (sampleRate * BYTES_PER_SAMPLE_MONO_16);
  return {
    wav: wrapPcmAsWav(combinedPcm, sampleRate),
    sampleRate,
    durationSeconds,
    cues,
  };
}

export function formatVttTimestamp(seconds: number): string {
  const safeMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(safeMs / 3_600_000);
  const minutes = Math.floor((safeMs % 3_600_000) / 60_000);
  const secs = Math.floor((safeMs % 60_000) / 1000);
  const millis = safeMs % 1000;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function buildWebVtt(cues: readonly TimedCaptionCue[]): string {
  const lines: string[] = ['WEBVTT', ''];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    if (cue.endSeconds <= cue.startSeconds) {
      throw new RangeError(`Caption cue ${i + 1} has non-positive duration.`);
    }
    lines.push(String(i + 1));
    lines.push(`${formatVttTimestamp(cue.startSeconds)} --> ${formatVttTimestamp(cue.endSeconds)}`);
    lines.push(cue.text.replaceAll(/\r?\n/g, ' ').trim());
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function validateWebVttMonotonicity(vttText: string): {
  readonly ok: boolean;
  readonly cueCount: number;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  const trimmed = vttText.trimStart();
  if (!trimmed.startsWith('WEBVTT')) {
    return { ok: false, cueCount: 0, errors: ['WebVTT output must begin with WEBVTT header.'] };
  }

  const timeLineRe =
    /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
  const parseTs = (h: string, m: string, s: string, ms: string): number =>
    Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;

  let prevEnd = 0;
  let cueCount = 0;

  for (const rawLine of vttText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.includes('-->')) {
      continue;
    }
    const match = timeLineRe.exec(line);
    if (!match) {
      errors.push(`Malformed WebVTT cue timestamp line: '${line}'.`);
      continue;
    }
    cueCount += 1;
    const start = parseTs(match[1], match[2], match[3], match[4]);
    const end = parseTs(match[5], match[6], match[7], match[8]);
    if (end <= start) {
      errors.push(`Cue ${cueCount} end (${end}) must be greater than start (${start}).`);
    }
    if (start + 0.0005 < prevEnd) {
      errors.push(`Cue ${cueCount} start (${start}) overlaps previous end (${prevEnd}).`);
    }
    prevEnd = end;
  }

  if (cueCount === 0) {
    errors.push('WebVTT contains zero timed cues.');
  }

  return { ok: errors.length === 0, cueCount, errors };
}

export function computeStepDurationFrames(totalStepSeconds: number, fps: number): number {
  return Math.max(1, Math.ceil(totalStepSeconds * fps));
}
