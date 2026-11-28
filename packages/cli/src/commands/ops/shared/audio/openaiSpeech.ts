import { type ExecFileOptions, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';

export const DEFAULT_OPENAI_SPEECH_MODEL = 'fishaudio/drama-3';
export const OPENAI_SPEECH_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

export interface VoiceCloneReference {
  readonly audioBase64: string;
  readonly text: string;
}

/**
 * OpenAI-compatible `/v1/audio/speech` JSON body.
 * Intentionally omits `seed` because SGLang-Omni rejects Drama 3 payloads that include `seed`.
 */
export interface OpenAiSpeechPayload {
  readonly model: string;
  readonly input: string;
  readonly voice: string;
  readonly response_format: 'wav' | 'mp3';
  readonly speed?: number | undefined;
  readonly references?: ReadonlyArray<{ readonly audio: string; readonly text: string }>;
}

export interface OpenAiSpeechRequest {
  readonly endpoint: string;
  readonly model: string;
  readonly input: string;
  readonly voice: string;
  readonly responseFormat?: 'wav' | 'mp3';
  readonly speed?: number | undefined;
  readonly apiKey?: string | undefined;
  readonly references?: readonly VoiceCloneReference[] | undefined;
  readonly retries?: number;
  readonly baseRetryDelayMs?: number;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly sleepFn?: ((ms: number) => Promise<void>) | undefined;
}

export interface OpenAiSpeechResponse {
  readonly bytes: Buffer;
  readonly contentType: string;
}

export type AudioExecFileOptions = ExecFileOptions & {
  readonly input?: Buffer | undefined;
};

export type AudioExecFileFn = (
  file: string,
  args: readonly string[],
  options?: AudioExecFileOptions
) => Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }>;

export function defaultAudioExecFile(
  file: string,
  args: readonly string[],
  options?: AudioExecFileOptions
): Promise<{ readonly stdout: Buffer; readonly stderr: Buffer }> {
  const { input, ...execOptions } = options ?? {};
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { ...execOptions, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          const enriched = error as Error & { stdout?: Buffer; stderr?: Buffer };
          enriched.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          enriched.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
          reject(enriched);
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
        });
      }
    );
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function normalizeSpeechEndpointUrl(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new CliValidationError(
      'Missing --endpoint <url> (or set KINLOOM_TTS_ENDPOINT) for --backend openai-speech.'
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new CliValidationError(`Invalid speech endpoint URL: '${endpoint}'.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliValidationError(`Speech endpoint must use http or https protocol: '${endpoint}'.`);
  }
  let pathEnd = parsed.pathname.length;
  while (pathEnd > 0 && parsed.pathname.charCodeAt(pathEnd - 1) === 47) {
    pathEnd -= 1;
  }
  const cleanPath = parsed.pathname.slice(0, pathEnd);
  if (cleanPath.endsWith('/v1/audio/speech')) {
    parsed.pathname = cleanPath;
  } else if (cleanPath.endsWith('/v1')) {
    parsed.pathname = `${cleanPath}/audio/speech`;
  } else {
    parsed.pathname = `${cleanPath}/v1/audio/speech`;
  }
  return parsed.toString();
}

export function loadVoiceCloneReference(refAudioPath: string, refText: string): VoiceCloneReference {
  const trimmedText = refText.trim();
  if (!trimmedText) {
    throw new CliValidationError(
      'Voice cloning reference requires non-empty --ref-text alongside --ref-audio.'
    );
  }
  let bytes: Buffer;
  try {
    const fd = fs.openSync(refAudioPath, 'r');
    try {
      if (!fs.fstatSync(fd).isFile()) {
        throw new CliValidationError(`Reference audio file not found: ${refAudioPath}`);
      }
      bytes = fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      throw err;
    }
    throw new CliValidationError(`Reference audio file not found: ${refAudioPath}`);
  }
  if (bytes.byteLength === 0) {
    throw new CliValidationError(`Reference audio file is empty: ${refAudioPath}`);
  }
  return {
    audioBase64: bytes.toString('base64'),
    text: trimmedText,
  };
}

export function buildOpenAiSpeechPayload(params: {
  readonly model: string;
  readonly input: string;
  readonly voice: string;
  readonly responseFormat?: 'wav' | 'mp3';
  readonly speed?: number | undefined;
  readonly references?: readonly VoiceCloneReference[] | undefined;
}): OpenAiSpeechPayload {
  const payload: {
    model: string;
    input: string;
    voice: string;
    response_format: 'wav' | 'mp3';
    speed?: number | undefined;
    references?: ReadonlyArray<{ readonly audio: string; readonly text: string }>;
  } = {
    model: params.model,
    input: params.input,
    voice: params.voice,
    response_format: params.responseFormat ?? 'wav',
  };
  if (params.speed !== undefined && Number.isFinite(params.speed) && params.speed > 0) {
    payload.speed = params.speed;
  }
  if (params.references && params.references.length > 0) {
    payload.references = params.references.map((ref) => ({
      audio: ref.audioBase64,
      text: ref.text,
    }));
  }
  return payload;
}

function parseRetryAfterMs(headerVal: string | null): number | null {
  if (!headerVal) {
    return null;
  }
  const seconds = Number(headerVal.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30_000);
  }
  return null;
}

export async function synthesizeOpenAiSpeech(req: OpenAiSpeechRequest): Promise<OpenAiSpeechResponse> {
  const url = normalizeSpeechEndpointUrl(req.endpoint);
  const fetchFn = req.fetchImpl ?? globalThis.fetch;
  const sleep = req.sleepFn ?? defaultSleep;
  const retries = req.retries ?? 3;
  const baseDelayMs = req.baseRetryDelayMs ?? 1500;
  const responseFormat = req.responseFormat ?? 'wav';

  const payload = buildOpenAiSpeechPayload({
    model: req.model,
    input: req.input,
    voice: req.voice,
    responseFormat,
    speed: req.speed,
    references: req.references,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const trimmedKey = req.apiKey?.trim();
  if (trimmedKey) {
    headers['authorization'] = `Bearer ${trimmedKey}`;
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      if (OPENAI_SPEECH_RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
        const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs = retryAfter ?? Math.min(baseDelayMs * 2 ** attempt, 20_000);
        await sleep(delayMs);
        continue;
      }

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`openai-speech HTTP ${response.status}: ${errText.slice(0, 600)}`);
      }

      const arrayBuf = await response.arrayBuffer();
      const bytes = Buffer.from(arrayBuf);
      if (bytes.byteLength === 0) {
        throw new Error('openai-speech returned an empty audio body');
      }
      const contentType =
        response.headers.get('content-type') ?? (responseFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav');
      return { bytes, contentType };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isHttpError = lastError.message.startsWith('openai-speech HTTP ');
      if (isHttpError || attempt >= retries) {
        throw lastError;
      }
      const delayMs = Math.min(baseDelayMs * 2 ** attempt, 20_000);
      await sleep(delayMs);
    }
  }
  throw lastError ?? new Error('openai-speech request failed after retries');
}

export async function normalizePronunciationAudioWithFfmpeg(params: {
  readonly inputBytes: Buffer;
  readonly outPath: string;
  readonly format: 'wav' | 'mp3';
  readonly bitrate?: string;
  readonly trimSilence?: boolean;
  readonly execFileImpl?: AudioExecFileFn | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Promise<{ readonly sizeBytes: number }> {
  const execFn = params.execFileImpl ?? defaultAudioExecFile;
  const filters: string[] = [];
  if (params.trimSilence !== false) {
    filters.push('silenceremove=start_periods=1:start_silence=0.08:start_threshold=-45dB');
  }
  filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');

  const ffmpegArgs: string[] = [
    '-y',
    '-loglevel',
    'error',
    '-i',
    'pipe:0',
    '-af',
    filters.join(','),
    '-ar',
    '24000',
    '-ac',
    '1',
  ];
  if (params.format === 'mp3') {
    ffmpegArgs.push('-b:a', params.bitrate ?? '96k', params.outPath);
  } else {
    ffmpegArgs.push('-c:a', 'pcm_s16le', params.outPath);
  }

  try {
    fs.mkdirSync(path.dirname(params.outPath), { recursive: true });
    await execFn('ffmpeg', ffmpegArgs, { env: params.env, input: params.inputBytes });
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(params.outPath).size;
    } catch {
      sizeBytes = 0;
    }
    return { sizeBytes };
  } catch (err: unknown) {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      throw new Error('ffmpeg not found on PATH');
    }
    throw err;
  }
}
