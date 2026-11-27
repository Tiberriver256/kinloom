import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliValidationError } from '../../../../errors.js';
import { isPlainRecord, resolveUserPathFromContext } from '../../runtime/primitives.js';
import { type ExecFileFn, type RecordCommandContext, RecordRuntimeError } from '../../runtime/types.js';
import {
  buildChirpPronunciations,
  CLOUD_TTS_API,
  countWords,
  GEMINI_API_BASE,
  inferAudioMimeType,
  type NarrativeRecord,
  parseNarrativesYaml,
  RETRYABLE_STATUSES,
  resolveChirpVoice,
  type SynthChunk,
  stripWavHeader,
} from './script.js';

export interface SynthesisOutcome {
  readonly combinedPcm: Buffer;
  readonly sampleRate: number;
  readonly notesStartSec?: number;
  readonly usageStr: string;
}

export function loadNarratives(filePath: string): NarrativeRecord[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  return parseNarrativesYaml(raw);
}

export function readNamesJson(namesPath: string): Record<string, string> {
  const parsed: unknown = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
  if (!isPlainRecord(parsed)) {
    throw new CliValidationError(`Names file must be a JSON object: ${namesPath}`);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string') {
      throw new CliValidationError(`Names entry '${k}' must map to an IPA string.`);
    }
    out[k] = v;
  }
  return out;
}

export function defaultExecFile(
  file: string,
  args: readonly string[],
  options?: Parameters<ExecFileFn>[2]
): ReturnType<ExecFileFn> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
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
    });
  });
}

export function findExecutableOnPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathVar = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue scanning PATH.
    }
  }
  return null;
}

export function requireExistingFile(rawPath: string, label: string, ctx: RecordCommandContext): string {
  const abs = resolveUserPathFromContext(rawPath, ctx);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new CliValidationError(`${label} not found: ${rawPath}`);
  }
  return abs;
}

export function resolveGeminiApiKey(keyFile: string | undefined, ctx: RecordCommandContext): string {
  if (keyFile) {
    const abs = resolveUserPathFromContext(keyFile, ctx);
    return fs.readFileSync(abs, 'utf8').trim();
  }
  const key = (ctx.env.GEMINI_API_KEY ?? ctx.env.GOOGLE_API_KEY ?? '').trim();
  if (!key) {
    throw new RecordRuntimeError('Set GEMINI_API_KEY (or GOOGLE_API_KEY), or pass --key-file.');
  }
  return key;
}

export async function resolveCloudTtsHeaders(
  gcpProject: string | undefined,
  keyFile: string | undefined,
  ctx: RecordCommandContext
): Promise<Record<string, string>> {
  if (keyFile) {
    const abs = resolveUserPathFromContext(keyFile, ctx);
    return { 'x-goog-api-key': fs.readFileSync(abs, 'utf8').trim() };
  }
  const envKey = (ctx.env.GOOGLE_CLOUD_TTS_API_KEY ?? '').trim();
  if (envKey) {
    return { 'x-goog-api-key': envKey };
  }

  const execFn = ctx.execFileImpl ?? defaultExecFile;
  const hasGcloud = ctx.execFileImpl !== undefined || findExecutableOnPath('gcloud', ctx.env) !== null;

  let token = (ctx.env.GOOGLE_CLOUD_ACCESS_TOKEN ?? '').trim();
  if (!token) {
    if (!hasGcloud) {
      throw new RecordRuntimeError(
        'gcloud not found on PATH; install gcloud or set GOOGLE_CLOUD_TTS_API_KEY / --key-file.'
      );
    }
    try {
      const res = await execFn('gcloud', ['auth', 'print-access-token'], { env: ctx.env });
      token = res.stdout.toString('utf8').trim();
    } catch (err: unknown) {
      const detail =
        isPlainRecord(err) && Buffer.isBuffer(err.stderr)
          ? err.stderr.toString('utf8').trim()
          : err instanceof Error
            ? err.message
            : '';
      throw new RecordRuntimeError(`Failed to get gcloud access token: ${detail || 'run gcloud auth login'}`);
    }
    if (!token) {
      throw new RecordRuntimeError('Failed to get gcloud access token: run gcloud auth login');
    }
  }

  let project =
    (gcpProject ?? '').trim() ||
    (ctx.env.GOOGLE_CLOUD_PROJECT ?? '').trim() ||
    (ctx.env.GCP_PROJECT ?? '').trim();

  if (!project && hasGcloud) {
    try {
      const res = await execFn('gcloud', ['config', 'get-value', 'project'], { env: ctx.env });
      const val = res.stdout.toString('utf8').trim();
      if (val && val !== '(unset)') {
        project = val;
      }
    } catch {
      // Optional billing quota project header.
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (project) {
    headers['x-goog-user-project'] = project;
  }
  return headers;
}

export async function postJsonWithRetries(params: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly label: string;
  readonly ctx: RecordCommandContext;
  readonly retries?: number;
}): Promise<Record<string, unknown>> {
  const retries = params.retries ?? 3;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await params.ctx.fetchImpl(params.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...params.headers,
      },
      body: JSON.stringify(params.body),
    });
    if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
      await params.ctx.sleepFn(5000 * (attempt + 1));
      continue;
    }
    const text = await response.text();
    if (response.status !== 200) {
      throw new RecordRuntimeError(`${params.label}: HTTP ${response.status}: ${text.slice(0, 800)}`);
    }
    const parsed: unknown = JSON.parse(text);
    if (!isPlainRecord(parsed)) {
      throw new RecordRuntimeError(`${params.label}: unexpected non-object JSON response`);
    }
    return parsed;
  }
  throw new RecordRuntimeError(`${params.label}: request failed after retries`);
}

export async function synthesizeWithChirp(options: {
  readonly chunks: readonly SynthChunk[];
  readonly namesMap: Readonly<Record<string, string>>;
  readonly languageCode: string;
  readonly gcpProject: string | undefined;
  readonly keyFile: string | undefined;
  readonly ctx: RecordCommandContext;
}): Promise<SynthesisOutcome> {
  const headers = await resolveCloudTtsHeaders(options.gcpProject, options.keyFile, options.ctx);
  const pcmParts: Buffer[] = [];
  let pcmLength = 0;
  let rate = 24000;
  let totalChars = 0;
  let notesStartSec: number | undefined;

  for (let i = 0; i < options.chunks.length; i += 1) {
    const chunk = options.chunks[i];
    const resolvedVoice = resolveChirpVoice(chunk.voice, options.languageCode);
    const inputObj: Record<string, unknown> = { text: chunk.text };
    if (Object.keys(options.namesMap).length > 0) {
      const prons = buildChirpPronunciations(chunk.text, options.namesMap);
      if (prons.length > 0) {
        inputObj.customPronunciations = { pronunciations: prons };
      }
    }
    const payload = {
      input: inputObj,
      voice: { languageCode: options.languageCode, name: resolvedVoice },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
    };
    const resp = await postJsonWithRetries({
      url: CLOUD_TTS_API,
      headers,
      body: payload,
      label: 'cloud-tts',
      ctx: options.ctx,
    });
    if (typeof resp.audioContent !== 'string') {
      throw new RecordRuntimeError('cloud-tts response missing audioContent');
    }
    const decoded = Buffer.from(resp.audioContent, 'base64');
    const stripped = stripWavHeader(decoded, 24000);
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
      `  section ${i + 1}/${options.chunks.length} [${resolvedVoice}]: ${countWords(chunk.text)} words, ` +
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

export async function synthesizeWithGemini(options: {
  readonly chunks: readonly SynthChunk[];
  readonly model: string;
  readonly keyFile: string | undefined;
  readonly ctx: RecordCommandContext;
}): Promise<SynthesisOutcome> {
  const key = resolveGeminiApiKey(options.keyFile, options.ctx);
  const pcmParts: Buffer[] = [];
  let pcmLength = 0;
  let rate = 24000;
  let totalTokens = 0;
  let notesStartSec: number | undefined;

  for (let i = 0; i < options.chunks.length; i += 1) {
    const chunk = options.chunks[i];
    const resp = await postJsonWithRetries({
      url: `${GEMINI_API_BASE}/${encodeURIComponent(options.model)}:generateContent`,
      headers: { 'x-goog-api-key': key },
      body: {
        contents: [{ parts: [{ text: chunk.text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: chunk.voice } },
          },
        },
      },
      label: options.model,
      ctx: options.ctx,
    });

    const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
    const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
    const content = firstCand && isPlainRecord(firstCand.content) ? firstCand.content : undefined;
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    const firstPart = isPlainRecord(parts[0]) ? parts[0] : undefined;
    const inlineData = firstPart && isPlainRecord(firstPart.inlineData) ? firstPart.inlineData : undefined;
    if (!inlineData || typeof inlineData.data !== 'string') {
      throw new RecordRuntimeError(`${options.model}: response missing inline audio data`);
    }

    const decoded = Buffer.from(inlineData.data, 'base64');
    let chunkPcm: Buffer;
    if (decoded.length >= 4 && decoded.toString('ascii', 0, 4) === 'RIFF') {
      const stripped = stripWavHeader(decoded, rate);
      chunkPcm = stripped.pcm;
      rate = stripped.sampleRate;
    } else {
      chunkPcm = decoded;
      const mimeType = typeof inlineData.mimeType === 'string' ? inlineData.mimeType : '';
      const rateMatch = /rate=(\d+)/.exec(mimeType);
      if (rateMatch) {
        rate = Number.parseInt(rateMatch[1], 10);
      }
    }

    if (pcmLength > 0) {
      const silenceSamples = Math.trunc(rate * chunk.pauseBefore);
      const silence = Buffer.alloc(silenceSamples * 2);
      pcmParts.push(silence);
      pcmLength += silence.length;
    }
    if (chunk.isNotes && notesStartSec === undefined) {
      notesStartSec = pcmLength / 2 / rate;
    }
    pcmParts.push(chunkPcm);
    pcmLength += chunkPcm.length;

    const usage = isPlainRecord(resp.usageMetadata) ? resp.usageMetadata : {};
    const tokens = typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : 0;
    totalTokens += tokens;
    options.ctx.io.stderr(
      `  section ${i + 1}/${options.chunks.length} [${chunk.voice}]: ${countWords(chunk.text)} words, ` +
        `${(chunkPcm.length / 2 / rate).toFixed(1)}s, ${tokens} tokens`
    );
  }

  return {
    combinedPcm: Buffer.concat(pcmParts),
    sampleRate: rate,
    notesStartSec,
    usageStr: `${totalTokens} tokens`,
  };
}

export async function encodePcmToMp3(options: {
  readonly pcm: Buffer;
  readonly sampleRate: number;
  readonly bitrate: string;
  readonly outPath: string;
  readonly ctx: RecordCommandContext;
}): Promise<void> {
  const tmpPcmPath = path.join(
    os.tmpdir(),
    `kinloom-narrative-audio-${process.pid}-${process.hrtime.bigint()}.pcm`
  );
  const execFn = options.ctx.execFileImpl ?? defaultExecFile;
  try {
    fs.writeFileSync(tmpPcmPath, options.pcm);
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    await execFn(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-f',
        's16le',
        '-ar',
        String(options.sampleRate),
        '-ac',
        '1',
        '-i',
        tmpPcmPath,
        '-b:a',
        options.bitrate,
        options.outPath,
      ],
      { env: options.ctx.env }
    );
  } catch (err: unknown) {
    if (isPlainRecord(err) && err.code === 'ENOENT') {
      throw new RecordRuntimeError('ffmpeg not found on PATH');
    }
    throw err;
  } finally {
    try {
      fs.unlinkSync(tmpPcmPath);
    } catch {
      // Best-effort temp cleanup.
    }
  }
}

export async function transcribeAudioFile(options: {
  readonly audioPath: string;
  readonly model: string;
  readonly keyFile: string | undefined;
  readonly ctx: RecordCommandContext;
}): Promise<string> {
  const key = resolveGeminiApiKey(options.keyFile, options.ctx);
  const mime = inferAudioMimeType(options.audioPath);

  const prompt =
    'Transcribe this audio VERBATIM with [mm:ss] timestamps at the start of each ' +
    'sentence. Write exactly what is spoken, including mistakes, repetitions and ' +
    'mispronunciations (note them in [brackets]), and any non-speech sounds such as ' +
    'clicks, noise bursts, garbled audio, long silences, or abrupt cuts. If any ' +
    'phonetic symbols or slashes are read out literally, mark them [read IPA aloud]. ' +
    'Do not correct or clean up anything.';

  const audioBase64 = fs.readFileSync(options.audioPath).toString('base64');
  const resp = await postJsonWithRetries({
    url: `${GEMINI_API_BASE}/${encodeURIComponent(options.model)}:generateContent`,
    headers: { 'x-goog-api-key': key },
    body: {
      contents: [
        {
          parts: [{ inlineData: { mimeType: mime, data: audioBase64 } }, { text: prompt }],
        },
      ],
    },
    label: options.model,
    ctx: options.ctx,
  });

  const candidates = Array.isArray(resp.candidates) ? resp.candidates : [];
  const firstCand = isPlainRecord(candidates[0]) ? candidates[0] : undefined;
  const content = firstCand && isPlainRecord(firstCand.content) ? firstCand.content : undefined;
  const parts = content && Array.isArray(content.parts) ? content.parts : [];
  return parts.map((p) => (isPlainRecord(p) && typeof p.text === 'string' ? p.text : '')).join('');
}
