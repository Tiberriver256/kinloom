import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { downscaleForCursiveOcr, downscaleForOcr } from '../../runtime/image.js';
import { isPlainRecord } from '../../runtime/primitives.js';
import type { ExecFileFn, RecordCommandContext } from '../../runtime/types.js';
import { inferImageMimeType, readImageDimensions, rescaleTesseractTsv } from './imageAndTsv.js';
import {
  CURSIVE_MAX_INPUT_BYTES,
  CURSIVE_TARGET_KB,
  CURSIVE_TARGET_MAX_WIDTH,
  type CursiveEffort,
  type CursiveProvider,
  DEFAULT_CURSIVE_GEMINI_MODEL,
  DEFAULT_CURSIVE_PROMPT,
  DEFAULT_GEMINI_CURSIVE_PROMPT,
  GEMINI_API_BASE,
  InputImageError,
  OcrTimeoutError,
  resolveVisionCli,
  type ScaleInfo,
  type SubprocessOutput,
  TESSERACT_INVALID_IMAGE_MARKERS,
} from './types.js';

let workSeq = 0;

function nextWorkDir(baseDir: string, prefix: string): string {
  workSeq += 1;
  return path.join(baseDir, `${prefix}_${process.pid}_${workSeq}_${process.hrtime.bigint()}`);
}

export function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  if (name.includes(path.sep) || (process.platform === 'win32' && name.includes('/'))) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return fs.statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }
  const pathVar = env.PATH ?? process.env.PATH ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // Try next PATH entry.
    }
  }
  return null;
}

export function createDefaultExecFile(): ExecFileFn {
  return (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(file, [...args], { ...options, encoding: 'buffer' }, (error, stdout, stderr) => {
        if (error) {
          const errObj = error as Error & { stdout?: Buffer; stderr?: Buffer };
          errObj.stdout = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          errObj.stderr = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
          reject(errObj);
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr),
        });
      });
    });
}

function isTesseractInvalidImageError(detail: string): boolean {
  const lowered = detail.toLowerCase();
  return TESSERACT_INVALID_IMAGE_MARKERS.some((marker) => lowered.includes(marker));
}

function makeSubprocessTimeoutError(label: string, timeoutSeconds: number, file: string): OcrTimeoutError {
  return new OcrTimeoutError(
    `${label} timed out after ${timeoutSeconds}s on ${path.basename(file)} ` +
      '(increase --timeout or use --mode cursive for handwritten pages).',
    timeoutSeconds,
    file
  );
}

function decodeExecStream(value: unknown, fallback = ''): string {
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }
  return typeof value === 'string' ? value : fallback;
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 0) {
    return;
  }
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Fall back to killing the child pid directly.
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Process already exited.
  }
}

export async function runSubprocessWithTimeout(params: {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutSeconds: number;
  readonly fileForError: string;
  readonly timeoutLabel: string;
  readonly execFileImpl?: ExecFileFn;
}): Promise<SubprocessOutput> {
  const { bin, args, env, cwd, timeoutSeconds, fileForError, timeoutLabel, execFileImpl } = params;
  const timeoutMs = Math.max(10, Math.round(timeoutSeconds * 1000));

  if (execFileImpl) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const execPromise = execFileImpl(bin, args, {
        env,
        cwd,
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024 * 1024,
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(makeSubprocessTimeoutError(timeoutLabel, timeoutSeconds, fileForError));
        }, timeoutMs);
        timer.unref();
      });
      const res = await Promise.race([execPromise, timeoutPromise]);
      return { exitCode: 0, stdout: res.stdout.toString('utf8'), stderr: res.stderr.toString('utf8') };
    } catch (err: unknown) {
      if (err instanceof OcrTimeoutError) {
        throw err;
      }
      if (isPlainRecord(err)) {
        const signal = typeof err.signal === 'string' ? err.signal : undefined;
        if (err.killed === true || signal === 'SIGKILL' || signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
          throw makeSubprocessTimeoutError(timeoutLabel, timeoutSeconds, fileForError);
        }
        if (typeof err.code === 'number') {
          return {
            exitCode: err.code,
            stdout: decodeExecStream(err.stdout),
            stderr: decodeExecStream(err.stderr, err instanceof Error ? err.message : ''),
          };
        }
      }
      throw err;
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  return new Promise<SubprocessOutput>((resolve, reject) => {
    const child = spawn(bin, [...args], {
      env,
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let killEscalationTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (killEscalationTimer !== undefined) {
        clearTimeout(killEscalationTimer);
      }
      fn();
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      killProcessTree(child.pid, 'SIGTERM');
      killEscalationTimer = setTimeout(() => {
        killProcessTree(child.pid, 'SIGKILL');
        settle(() => reject(makeSubprocessTimeoutError(timeoutLabel, timeoutSeconds, fileForError)));
      }, 250);
      killEscalationTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) =>
      settle(() => {
        if (timedOut) {
          reject(makeSubprocessTimeoutError(timeoutLabel, timeoutSeconds, fileForError));
          return;
        }
        resolve({
          exitCode: typeof code === 'number' ? code : 1,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
        });
      })
    );
  });
}

export async function preparePrintedImage(
  imgPath: string,
  rawBytes: Buffer,
  workDir: string,
  maxDim: number
): Promise<{
  readonly sendPath: string;
  readonly cleanupDir: string | null;
  readonly scaleInfo: ScaleInfo | null;
}> {
  const unchanged = { sendPath: imgPath, cleanupDir: null, scaleInfo: null } as const;
  if (maxDim <= 0) {
    return unchanged;
  }
  const dims = readImageDimensions(rawBytes);
  if (dims === null || dims[0] <= 0 || dims[1] <= 0 || Math.max(dims[0], dims[1]) <= maxDim) {
    return unchanged;
  }

  const jobDir = nextWorkDir(workDir, 'printed');
  try {
    const downscaled = await downscaleForOcr(imgPath, maxDim);
    if (!downscaled.downscaled || downscaled.width <= 0 || downscaled.height <= 0) {
      return unchanged;
    }
    fs.mkdirSync(jobDir, { recursive: true });
    const outPath = path.join(jobDir, 'scaled.png');
    fs.writeFileSync(outPath, downscaled.buffer);
    return {
      sendPath: outPath,
      cleanupDir: jobDir,
      scaleInfo: {
        original_width: downscaled.origWidth,
        original_height: downscaled.origHeight,
        scaled_width: downscaled.width,
        scaled_height: downscaled.height,
      },
    };
  } catch {
    fs.rmSync(jobDir, { recursive: true, force: true });
    return unchanged;
  }
}

export async function runPrintedOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly psm: number;
  readonly timeoutSeconds: number;
  readonly tsv: boolean;
  readonly workDir: string;
  readonly maxDim: number;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly output: string; readonly meta: Record<string, unknown> }> {
  const { imgPath, rawBytes, psm, timeoutSeconds, tsv, workDir, maxDim, ctx } = params;

  const tesseractBin = ctx.execFileImpl ? 'tesseract' : resolveExecutable('tesseract', ctx.env);
  if (!tesseractBin) {
    throw new Error(
      'tesseract executable not found on PATH. Install tesseract-ocr ' +
        '(for example `apt install tesseract-ocr` or `brew install tesseract`).'
    );
  }

  const prepared = await preparePrintedImage(imgPath, rawBytes, workDir, maxDim);
  try {
    // Mandatory single-threaded OpenMP env so parallel OCR never thrashes CPU cores.
    const tesseractEnv: NodeJS.ProcessEnv = { ...ctx.env, OMP_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' };
    const tessArgs = [prepared.sendPath, 'stdout', '--psm', String(psm), ...(tsv ? ['tsv'] : [])];
    const proc = await runSubprocessWithTimeout({
      bin: tesseractBin,
      args: tessArgs,
      env: tesseractEnv,
      timeoutSeconds,
      fileForError: imgPath,
      timeoutLabel: 'tesseract',
      execFileImpl: ctx.execFileImpl,
    });

    if (proc.exitCode !== 0) {
      const detail = (proc.stderr || proc.stdout).trim();
      if (isTesseractInvalidImageError(detail)) {
        throw new InputImageError(
          `invalid or unreadable image ${path.basename(imgPath)}: ${detail.slice(0, 300)}`
        );
      }
      throw new Error(`tesseract exited ${proc.exitCode}: ${detail.slice(0, 300)}`);
    }

    let out = tsv ? proc.stdout : proc.stdout.trim();
    if (tsv && prepared.scaleInfo !== null) {
      out = rescaleTesseractTsv(
        out,
        prepared.scaleInfo.original_width,
        prepared.scaleInfo.original_height,
        prepared.scaleInfo.scaled_width,
        prepared.scaleInfo.scaled_height
      );
    }
    const meta: Record<string, unknown> = { psm, omp_thread_limit: 1, timeout_s: timeoutSeconds };
    if (prepared.scaleInfo !== null) {
      meta.downscaled = true;
      meta.original_size = [prepared.scaleInfo.original_width, prepared.scaleInfo.original_height];
      meta.scaled_size = [prepared.scaleInfo.scaled_width, prepared.scaleInfo.scaled_height];
    }
    return { output: out, meta };
  } finally {
    if (prepared.cleanupDir !== null) {
      fs.rmSync(prepared.cleanupDir, { recursive: true, force: true });
    }
  }
}

async function prepareCursiveBuffer(
  imgPath: string,
  rawBytes: Buffer
): Promise<{ readonly buffer: Buffer; readonly mimeType: string; readonly downscaled: boolean }> {
  if (rawBytes.length <= CURSIVE_MAX_INPUT_BYTES) {
    return { buffer: rawBytes, mimeType: inferImageMimeType(imgPath, rawBytes), downscaled: false };
  }
  try {
    const res = await downscaleForCursiveOcr(imgPath, {
      triggerBytes: CURSIVE_MAX_INPUT_BYTES,
      targetKb: CURSIVE_TARGET_KB,
      maxWidth: CURSIVE_TARGET_MAX_WIDTH,
    });
    return {
      buffer: res.buffer,
      mimeType: res.downscaled ? 'image/jpeg' : inferImageMimeType(imgPath, res.buffer),
      downscaled: res.downscaled,
    };
  } catch {
    return { buffer: rawBytes, mimeType: inferImageMimeType(imgPath, rawBytes), downscaled: false };
  }
}

export async function runCursiveGeminiOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly timeoutSeconds: number;
  readonly customPrompt?: string;
  readonly apiKey: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const { imgPath, rawBytes, effort, timeoutSeconds, customPrompt, apiKey, ctx } = params;
  const model = (ctx.env.KINLOOM_OCR_MODEL ?? '').trim() || DEFAULT_CURSIVE_GEMINI_MODEL;
  const prepared = await prepareCursiveBuffer(imgPath, rawBytes);
  const prompt = customPrompt
    ? customPrompt.replaceAll('{image_path}', path.basename(imgPath))
    : DEFAULT_GEMINI_CURSIVE_PROMPT;

  const controller = new AbortController();
  const timeoutMs = Math.max(10, Math.round(timeoutSeconds * 1000));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();

  try {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;
    const response = await ctx.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inlineData: { mimeType: prepared.mimeType, data: prepared.buffer.toString('base64') } },
              { text: prompt },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    if (!response.ok) {
      throw new Error(`gemini OCR HTTP ${response.status}: ${bodyText.slice(0, 400)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new Error(`gemini OCR returned non-JSON response: ${bodyText.slice(0, 300)}`);
    }
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
      throw new Error('gemini OCR returned no candidates.');
    }
    const firstCandidate = parsed.candidates[0];
    const content = isPlainRecord(firstCandidate) ? firstCandidate.content : undefined;
    const parts = isPlainRecord(content) && Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .map((part) => (isPlainRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (!text) {
      throw new Error('gemini OCR returned an empty transcription response.');
    }
    const usage = isPlainRecord(parsed.usageMetadata) ? parsed.usageMetadata : {};
    return {
      text,
      engine: `gemini:${model}`,
      meta: {
        provider: 'gemini',
        model,
        effort,
        sent_bytes: prepared.buffer.length,
        downscaled: prepared.downscaled,
        total_tokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : undefined,
      },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new OcrTimeoutError(
        `gemini timed out after ${timeoutSeconds}s on ${path.basename(imgPath)} ` +
          '(pass a higher --timeout to override).',
        timeoutSeconds,
        imgPath
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function runCursiveCliOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly timeoutSeconds: number;
  readonly cacheDir: string;
  readonly customPrompt?: string;
  readonly cliName: string;
  readonly cliBin: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const { imgPath, rawBytes, effort, timeoutSeconds, cacheDir, customPrompt, cliName, cliBin, ctx } = params;

  const model = (ctx.env.KINLOOM_OCR_MODEL ?? '').trim() || `gemini-4-hydrogen-${effort}`;
  const prepared = await prepareCursiveBuffer(imgPath, rawBytes);

  let sendPath = imgPath;
  let cleanupDir: string | null = null;
  if (prepared.downscaled) {
    cleanupDir = nextWorkDir(path.join(cacheDir, '.work'), 'cursive');
    fs.mkdirSync(cleanupDir, { recursive: true });
    sendPath = path.join(cleanupDir, 'preview.jpg');
    fs.writeFileSync(sendPath, prepared.buffer);
  }

  try {
    const template = customPrompt ?? DEFAULT_CURSIVE_PROMPT;
    const prompt = template.includes('{image_path}')
      ? template.replaceAll('{image_path}', sendPath)
      : `Call read_file ONCE on ${sendPath}. ${template}`;
    const addDir = path.dirname(sendPath);
    const cliArgs = [
      '--model',
      model,
      '--dangerously-skip-permissions',
      '--disable-slash-commands',
      '--add-dir',
      addDir,
      '--output-format',
      'json',
      '--print-timeout',
      `${timeoutSeconds}s`,
      `-p=${prompt}`,
    ];

    const proc = await runSubprocessWithTimeout({
      bin: cliBin,
      args: cliArgs,
      env: ctx.env,
      cwd: addDir,
      timeoutSeconds,
      fileForError: imgPath,
      timeoutLabel: cliName,
      execFileImpl: ctx.execFileImpl,
    });

    if (proc.exitCode !== 0) {
      const detail = (proc.stderr || proc.stdout).trim();
      throw new Error(`${cliName} exited ${proc.exitCode}: ${detail.slice(0, 400)}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(proc.stdout);
    } catch {
      throw new Error(`${cliName} returned non-JSON stdout: ${proc.stdout.slice(0, 300)}`);
    }
    if (!isPlainRecord(payload) || payload.status !== 'SUCCESS') {
      const status = isPlainRecord(payload) ? String(payload.status) : 'unknown';
      throw new Error(`${cliName} returned status=${status}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    const text = typeof payload.response === 'string' ? payload.response.trim() : '';
    if (!text) {
      throw new Error(`${cliName} returned an empty transcription response.`);
    }
    const usage = isPlainRecord(payload.usage) ? payload.usage : {};
    return {
      text,
      engine: `${cliName}:${model}`,
      meta: {
        cli: cliName,
        model,
        effort,
        sent_bytes: prepared.buffer.length,
        duration_seconds: payload.duration_seconds,
        thinking_tokens: usage.thinking_tokens,
        output_tokens: usage.output_tokens,
      },
    };
  } finally {
    if (cleanupDir !== null) {
      fs.rmSync(cleanupDir, { recursive: true, force: true });
    }
  }
}

export async function runCursiveOcr(params: {
  readonly imgPath: string;
  readonly rawBytes: Buffer;
  readonly effort: CursiveEffort;
  readonly provider: CursiveProvider;
  readonly timeoutSeconds: number;
  readonly cacheDir: string;
  readonly customPrompt?: string;
  readonly ctx: RecordCommandContext;
}): Promise<{ readonly text: string; readonly meta: Record<string, unknown>; readonly engine: string }> {
  const { provider, ctx } = params;
  const geminiKey = (ctx.env.GEMINI_API_KEY ?? ctx.env.GOOGLE_API_KEY ?? '').trim();
  const cliName = resolveVisionCli(ctx.env);
  const cliBin = ctx.execFileImpl ? cliName : resolveExecutable(cliName, ctx.env);

  if (provider === 'gemini' || (provider === 'auto' && !cliBin && geminiKey)) {
    if (!geminiKey) {
      throw new Error('GEMINI_API_KEY or GOOGLE_API_KEY must be set when using --provider gemini.');
    }
    return runCursiveGeminiOcr({ ...params, apiKey: geminiKey });
  }

  if (provider === 'cli' || (provider === 'auto' && cliBin)) {
    if (!cliBin) {
      throw new Error(
        `Vision CLI '${cliName}' not found on PATH. Install '${cliName}' ` +
          'or set KINLOOM_OCR_CLI to a compatible vision CLI executable.'
      );
    }
    return runCursiveCliOcr({ ...params, cliName, cliBin });
  }

  throw new Error(
    `Vision CLI '${cliName}' not found on PATH and no GEMINI_API_KEY/GOOGLE_API_KEY is set. ` +
      `Install '${cliName}', set KINLOOM_OCR_CLI, or set GEMINI_API_KEY.`
  );
}
