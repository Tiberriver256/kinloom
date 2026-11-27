import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPlainRecord } from '../../runtime/primitives.js';
import type { ExecFileFn } from '../../runtime/types.js';
import { OcrTimeoutError, type SubprocessOutput } from './types.js';

let workSeq = 0;

export function nextWorkDir(baseDir: string, prefix: string): string {
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
