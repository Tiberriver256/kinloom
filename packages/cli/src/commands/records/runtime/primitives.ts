import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../../errors.js';
import { atomicWriteFileSync, expandHomePath, parseCacheTtlHours } from './cache.js';
import { type RecordCommandContext, type RecordCommandOutcome, RecordRuntimeError } from './types.js';

export const JPEG_MAGIC: Buffer = Buffer.from([0xff, 0xd8, 0xff]);
export const PNG_MAGIC: Buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const PDF_MAGIC: Buffer = Buffer.from('%PDF-', 'ascii');

export const HTML_ERROR_PREFIXES: readonly string[] = ['<!doctype', '<html', '<head', '<body', '<title'];

export class IncompleteDownloadError extends RecordRuntimeError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'IncompleteDownloadError';
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 32) {
      return true;
    }
  }
  return false;
}

export function isBrokenPipeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  if ('code' in err && (err as { code?: unknown }).code === 'EPIPE') {
    return true;
  }
  if (err instanceof Error && /broken pipe/i.test(err.message)) {
    return true;
  }
  return false;
}

export function hasMagicPrefix(buf: Uint8Array, magic: Uint8Array): boolean {
  if (buf.length < magic.length) {
    return false;
  }
  for (let i = 0; i < magic.length; i += 1) {
    if (buf[i] !== magic[i]) {
      return false;
    }
  }
  return true;
}

export function stripLeadingBomAndWs(buf: Uint8Array, sampleBytes = 512): string {
  let start = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3;
  }
  return Buffer.from(buf.subarray(start, start + sampleBytes))
    .toString('latin1')
    .replace(/^[ \t\r\n]+/, '')
    .toLowerCase();
}

export function looksLikeHtmlBuffer(buf: Uint8Array, sampleBytes = 256): boolean {
  const sample = stripLeadingBomAndWs(buf, sampleBytes);
  return (
    sample.startsWith('<!doctype') ||
    sample.startsWith('<html') ||
    sample.startsWith('<head') ||
    sample.startsWith('<body')
  );
}

export function atomicWriteCompactJson(dest: string, payload: unknown): void {
  atomicWriteFileSync(dest, JSON.stringify(payload));
}

export function atomicCopyFileSync(src: string, dest: string): void {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(dest);
  const tmpPath = path.join(dir, `.${base}.${process.pid}.${process.hrtime.bigint()}.tmp`);
  try {
    fs.copyFileSync(src, tmpPath);
    fs.renameSync(tmpPath, dest);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort temp cleanup.
    }
    throw err;
  }
}

export function readJsonRecordIfValid(filePath: string): Record<string, unknown> | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    let rawText: string;
    try {
      if (!fs.fstatSync(fd).isFile()) {
        return null;
      }
      rawText = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    const parsed: unknown = JSON.parse(rawText);
    return isPlainRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function sha256FileSync(filePath: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export interface ResolveSafeChildOptions {
  readonly rejectDoubleDotSubstring?: boolean;
  readonly errorFactory?: (message: string) => Error;
  readonly formatName?: (filename: string) => string;
  readonly escapeRootLabel?: string;
}

export function resolveSafeChildPath(
  root: string,
  filename: string,
  options: ResolveSafeChildOptions = {}
): string {
  const makeError = options.errorFactory ?? ((msg: string) => new RecordRuntimeError(msg));
  const formatName = options.formatName ?? ((name: string) => `'${name}'`);
  if (
    !filename ||
    filename.includes('\0') ||
    filename.includes('/') ||
    filename.includes('\\') ||
    filename.includes(':') ||
    filename === '.' ||
    filename === '..' ||
    (options.rejectDoubleDotSubstring && filename.includes('..'))
  ) {
    throw makeError(`Unsafe filename: ${formatName(filename)}`);
  }
  const rootResolved = path.resolve(root);
  const dest = path.resolve(rootResolved, filename);
  const rel = path.relative(rootResolved, dest);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel) || dest === rootResolved) {
    const target = options.escapeRootLabel ?? 'root';
    throw makeError(`Unsafe path escaping ${target}: ${formatName(filename)}`);
  }
  return dest;
}

export function resolveUserPathFromContext(rawPath: string, ctx: RecordCommandContext): string {
  const expanded = expandHomePath(rawPath, ctx.env);
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(ctx.cwd, expanded);
}

export function resolveEnvCacheTtlHours(
  cliTtl: number | undefined,
  env: NodeJS.ProcessEnv,
  envVarName: string,
  defaultHours: number
): number {
  if (cliTtl !== undefined) {
    return parseCacheTtlHours(cliTtl, defaultHours, '--cache-ttl-hours');
  }
  const rawEnv = env[envVarName];
  const trimmed = rawEnv !== undefined ? rawEnv.trim() : '';
  if (trimmed.length > 0) {
    return parseCacheTtlHours(trimmed, defaultHours, envVarName);
  }
  return defaultHours;
}

export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = Array.from<R>({ length: items.length });
  let nextIdx = 0;

  const runners: Promise<void>[] = [];
  for (let w = 0; w < limit; w += 1) {
    runners.push(
      (async () => {
        for (;;) {
          const idx = nextIdx;
          nextIdx += 1;
          if (idx >= items.length) {
            return;
          }
          results[idx] = await worker(items[idx], idx);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function encodeUrlPathPreservingSlashes(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, '/');
}

export function handleRecordCommandError(
  err: unknown,
  ctx: RecordCommandContext,
  options: { readonly ignoreBrokenPipe?: boolean } = {}
): RecordCommandOutcome {
  if (options.ignoreBrokenPipe && isBrokenPipeError(err)) {
    return { exitCode: 0, bytesOut: 0 };
  }
  if (err instanceof CliValidationError) {
    ctx.io.stderr(`Error: ${err.message}`);
    return { exitCode: 2, bytesOut: 0 };
  }
  if (err instanceof RecordRuntimeError) {
    ctx.io.stderr(`Error: ${err.message}`);
    return { exitCode: err.exitCode, bytesOut: 0 };
  }
  const message = err instanceof Error ? err.message : String(err);
  ctx.io.stderr(`Error: ${message}`);
  return { exitCode: 1, bytesOut: 0 };
}
