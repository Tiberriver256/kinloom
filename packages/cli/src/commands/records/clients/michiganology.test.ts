import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURL_META_MARKER,
  createRecordContext,
  type ExecFileFn,
} from '../runtime/index.js';
import { runMichiganologyCommand } from './michiganology.js';

const SEARCH_HTML =
  '<html><body><div>2 total results</div>' +
  '<div class="result-item"><a href="https://michigan.access.preservica.com/uncategorized/IO_abc123/">' +
  'Lincoln, Abraham (Death Certificate)</a></div>' +
  '</body></html>';

const ITEM_HTML =
  '<html><body><h1>Lincoln, Abraham</h1>' +
  '<span class="metadata-title">County:</span><span class="metadata-content">Kent</span>' +
  '<a href="https://michigan.access.preservica.com/download/file/IO_abc123">Download</a>' +
  '</body></html>';

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 0x11)]);
const JPEG_BYTES_V2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 0x22)]);
const JPEG_HEADERS =
  'HTTP/1.1 200 OK\r\n' +
  'Content-Type: image/jpeg\r\n' +
  'Content-Disposition: attachment; filename="certificate.jpg"\r\n' +
  '\r\n';
const HTML_HEADERS = 'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n\r\n';
const HTML_BODY = Buffer.from('<!DOCTYPE html><html><body>Just a moment</body></html>', 'utf8');

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-mich-test-'));
  tempDirs.push(dir);
  return dir;
}

function curlStdout(
  body: string | Buffer,
  status: number,
  effectiveUrl: string
): Buffer {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const tail = Buffer.from(`\n${CURL_META_MARKER}\n${status}\n${effectiveUrl}`, 'utf8');
  return Buffer.concat([bodyBuf, tail]);
}

function writeCurlHeaders(args: readonly string[], rawHeaders: string): void {
  const idx = args.indexOf('-D');
  if (idx !== -1 && idx + 1 < args.length) {
    fs.writeFileSync(args[idx + 1], rawHeaders, 'utf8');
  }
}

async function invokeMich(
  args: readonly string[],
  cacheDir: string,
  opts: {
    readonly execFileImpl?: ExecFileFn;
    readonly sleepFn?: (ms: number) => Promise<void>;
    readonly cwd?: string;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_MICHIGANOLOGY_CACHE_DIR: cacheDir },
    cwd: opts.cwd ?? cacheDir,
    execFileImpl:
      opts.execFileImpl ??
      (async () => {
        throw new Error('unexpected curl invocation');
      }),
    sleepFn: opts.sleepFn ?? (async () => {}),
  });
  const outcome = await runMichiganologyCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('michiganology native client', () => {
  it('caches search results and second run makes zero curl calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      const target = args.at(-1) ?? '';
      return { stdout: curlStdout(SEARCH_HTML, 200, target), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });
    const r2 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });
    const r3 = await invokeMich(['search', 'Lincoln'], cacheDir, { execFileImpl });

    expect([r1.exitCode, r2.exitCode, r3.exitCode]).toEqual([0, 0, 0]);
    expect(calls).toBe(1);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(r2.cacheHit).toBe(true);
    expect(r3.stdout).toContain('[cache]');
  });

  it('bypasses cache on --refresh and --cache-ttl-hours 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      return { stdout: curlStdout(SEARCH_HTML, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });
    const rRef = await invokeMich(['search', 'Lincoln', '--refresh', '--json'], cacheDir, {
      execFileImpl,
    });
    const rTtl = await invokeMich(
      ['search', 'Lincoln', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      { execFileImpl }
    );

    expect(calls).toBe(3);
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('caches get item details', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      return { stdout: curlStdout(ITEM_HTML, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['get', 'IO_abc123', '--json'], cacheDir, { execFileImpl });
    const r2 = await invokeMich(['get', 'IO_abc123'], cacheDir, { execFileImpl });

    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(calls).toBe(1);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r2.stdout).toContain('[cache]');
    expect(r2.stdout).toContain('Kent');
  });

  it('never caches HTTP errors or blocked empty pages', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      const target = args.at(-1) ?? '';
      if (calls === 1) {
        return { stdout: curlStdout('forbidden', 403, target), stderr: Buffer.alloc(0) };
      }
      if (calls === 2) {
        return {
          stdout: curlStdout('<html><body>Maintenance</body></html>', 200, target),
          stderr: Buffer.alloc(0),
        };
      }
      return { stdout: curlStdout(SEARCH_HTML, 200, target), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['search', 'Lincoln'], cacheDir, { execFileImpl });
    const r2 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r3 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });

    expect(r1.exitCode).toBe(1);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(3);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('caches downloads and serves repeat runs with zero curl calls', async () => {
    const cacheDir = await makeTempDir();
    const out1 = path.join(cacheDir, 'first');
    const out2 = path.join(cacheDir, 'second');
    let calls = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      writeCurlHeaders(args, JPEG_HEADERS);
      return { stdout: curlStdout(JPEG_BYTES, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['download', 'IO_abc123', '--out', out1, '--json'], cacheDir, {
      execFileImpl,
    });
    const r2 = await invokeMich(['download', 'IO_abc123', '--out', out2, '--json'], cacheDir, {
      execFileImpl,
    });
    const r3 = await invokeMich(
      ['download', 'IO_abc123', '--out', out2, '--filename', 'custom.jpg', '--json'],
      cacheDir,
      { execFileImpl }
    );

    expect([r1.exitCode, r2.exitCode, r3.exitCode]).toEqual([0, 0, 0]);
    expect(calls).toBe(1);
    const first = JSON.parse(r1.stdout) as {
      item_id: string;
      bytes: number;
      filename: string;
      content_type: string;
      cache_hit: boolean;
    };
    const second = JSON.parse(r2.stdout) as { cache_hit: boolean; filename: string };
    const third = JSON.parse(r3.stdout) as { filename: string };

    expect(first.item_id).toBe('IO_abc123');
    expect(first.bytes).toBe(JPEG_BYTES.length);
    expect(first.filename).toBe('certificate.jpg');
    expect(first.content_type).toBe('image/jpeg');
    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second.filename).toBe('certificate.jpg');
    expect(fs.readFileSync(path.join(out1, 'certificate.jpg'))).toEqual(JPEG_BYTES);
    expect(fs.readFileSync(path.join(out2, 'certificate.jpg'))).toEqual(JPEG_BYTES);
    expect(third.filename).toBe('certificate.jpg');
    expect(fs.readFileSync(path.join(out2, 'custom.jpg'))).toEqual(JPEG_BYTES);
    expect(fs.existsSync(path.join(cacheDir, 'files', 'IO_abc123', 'body'))).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(cacheDir, 'files', 'IO_abc123', 'meta.json'), 'utf8')
    ) as { filename: string; content_type: string };
    expect(meta.filename).toBe('certificate.jpg');
    expect(meta.content_type).toBe('image/jpeg');
  });

  it('refetches download on --refresh and skips cache read on ttl 0', async () => {
    const cacheDir = await makeTempDir();
    const out = path.join(cacheDir, 'out');
    let body = JPEG_BYTES;
    let calls = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      writeCurlHeaders(args, JPEG_HEADERS);
      return { stdout: curlStdout(body, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    await invokeMich(['download', 'IO_abc123', '--out', out, '--json'], cacheDir, { execFileImpl });
    body = JPEG_BYTES_V2;
    const refreshed = await invokeMich(
      ['download', 'IO_abc123', '--out', out, '--refresh', '--json'],
      cacheDir,
      { execFileImpl }
    );
    const ttl = await invokeMich(
      ['download', 'IO_abc123', '--out', out, '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      { execFileImpl }
    );

    expect(calls).toBe(3);
    expect(refreshed.exitCode).toBe(0);
    expect((JSON.parse(refreshed.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(fs.readFileSync(path.join(out, 'certificate.jpg'))).toEqual(JPEG_BYTES_V2);
    const ttlPayload = JSON.parse(ttl.stdout) as { bytes: number; cache_hit: boolean };
    expect(ttlPayload.bytes).toBe(JPEG_BYTES_V2.length);
    expect(ttlPayload.cache_hit).toBe(false);
  });

  it('never caches HTML, empty, or curl error download responses', async () => {
    const cacheDir = await makeTempDir();
    const out = path.join(cacheDir, 'out');
    let calls = 0;

    const htmlExec: ExecFileFn = async (_file, args) => {
      calls += 1;
      writeCurlHeaders(args, HTML_HEADERS);
      return { stdout: curlStdout(HTML_BODY, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    const rHtml1 = await invokeMich(['download', 'IO_abc123', '--out', out, '--json'], cacheDir, {
      execFileImpl: htmlExec,
    });
    const rHtml2 = await invokeMich(['download', 'IO_abc123', '--out', out], cacheDir, {
      execFileImpl: htmlExec,
    });
    expect(rHtml1.exitCode).toBe(1);
    expect(rHtml2.exitCode).toBe(1);
    expect(rHtml1.stderr).toContain('HTML');
    expect(calls).toBe(2);
    expect(fs.existsSync(path.join(cacheDir, 'files', 'IO_abc123', 'body'))).toBe(false);
    expect(fs.existsSync(out)).toBe(false);

    const emptyExec: ExecFileFn = async (_file, args) => {
      writeCurlHeaders(args, JPEG_HEADERS);
      return { stdout: curlStdout(Buffer.alloc(0), 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };
    const rEmpty = await invokeMich(['download', 'IO_empty1', '--out', out], cacheDir, {
      execFileImpl: emptyExec,
    });
    expect(rEmpty.exitCode).toBe(1);
    expect(rEmpty.stderr).toContain('empty');
    expect(fs.existsSync(path.join(cacheDir, 'files', 'IO_empty1', 'body'))).toBe(false);

    const failExec: ExecFileFn = async () => {
      const err = new Error('curl exit 7') as Error & { code?: number; stderr?: Buffer };
      err.code = 7;
      err.stderr = Buffer.from('curl exit 7: Failed to connect');
      throw err;
    };
    const rFail = await invokeMich(['download', 'IO_fail1', '--out', out], cacheDir, {
      execFileImpl: failExec,
    });
    expect(rFail.exitCode).toBe(1);
    expect(rFail.stderr).toContain('curl exit 7');
    expect(fs.existsSync(path.join(cacheDir, 'files', 'IO_fail1', 'meta.json'))).toBe(false);
  });

  it('writes directly to explicit file path when --out ends with image/pdf extension', async () => {
    const cacheDir = await makeTempDir();
    const dest = path.join(cacheDir, 'scans', 'plate.tiff');
    const dir = path.join(cacheDir, 'dir');
    let calls = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      writeCurlHeaders(args, JPEG_HEADERS);
      return { stdout: curlStdout(JPEG_BYTES, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['download', 'IO_abc123', '--out', dest], cacheDir, {
      execFileImpl,
    });
    const r2 = await invokeMich(['download', 'IO_abc123', '--out', dir], cacheDir, {
      execFileImpl,
    });

    expect(r1.exitCode).toBe(0);
    expect(fs.readFileSync(dest)).toEqual(JPEG_BYTES);
    expect(fs.statSync(dest).isDirectory()).toBe(false);
    expect(r1.stdout).toContain(dest);
    expect(r1.stdout).toContain(`(${JPEG_BYTES.length} bytes)`);
    expect(r2.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(fs.existsSync(path.join(dir, 'certificate.jpg'))).toBe(true);
  });

  it('retries search on 429 Retry-After, 503, and timeout', async () => {
    const cacheDir = await makeTempDir();
    const sleeps: number[] = [];
    let attempt = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      attempt += 1;
      const target = args.at(-1) ?? '';
      if (attempt === 1) {
        writeCurlHeaders(args, 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 3\r\n\r\n');
        return { stdout: curlStdout('rate limited', 429, target), stderr: Buffer.alloc(0) };
      }
      if (attempt === 2) {
        writeCurlHeaders(args, 'HTTP/1.1 503 Service Unavailable\r\n\r\n');
        return { stdout: curlStdout('unavailable', 503, target), stderr: Buffer.alloc(0) };
      }
      if (attempt === 3) {
        throw new Error('timeout expired');
      }
      writeCurlHeaders(args, 'HTTP/1.1 200 OK\r\n\r\n');
      return { stdout: curlStdout(SEARCH_HTML, 200, target), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, {
      execFileImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    const r2 = await invokeMich(['search', 'Lincoln', '--json'], cacheDir, { execFileImpl });

    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(attempt).toBe(4);
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBe(3000);
    expect(sleeps[1]).toBeGreaterThan(0);
    expect(sleeps[2]).toBeGreaterThan(0);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
  });

  it('retries get on curl exit 28 and 503 with Retry-After', async () => {
    const cacheDir = await makeTempDir();
    const sleeps: number[] = [];
    let attempt = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      attempt += 1;
      const target = args.at(-1) ?? '';
      if (attempt === 1) {
        const err = new Error('Operation timed out') as Error & { code?: number };
        err.code = 28;
        throw err;
      }
      if (attempt === 2) {
        writeCurlHeaders(args, 'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\n\r\n');
        return { stdout: curlStdout('busy', 503, target), stderr: Buffer.alloc(0) };
      }
      writeCurlHeaders(args, 'HTTP/1.1 200 OK\r\n\r\n');
      return { stdout: curlStdout(ITEM_HTML, 200, target), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(['get', 'IO_abc123', '--json'], cacheDir, {
      execFileImpl,
      sleepFn: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r1.exitCode).toBe(0);
    expect(attempt).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[1]).toBe(2000);
    const body = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      metadata: Record<string, string>;
    };
    expect(body.cache_hit).toBe(false);
    expect(body.metadata.County).toBe('Kent');
  });

  it('retries download on 429 and timeout and supports fetch alias + -o/--output', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'dl');
    const sleeps: number[] = [];
    let attempt = 0;

    const execFileImpl: ExecFileFn = async (_file, args) => {
      attempt += 1;
      const target = args.at(-1) ?? '';
      if (attempt === 1) {
        writeCurlHeaders(args, 'HTTP/1.1 429 Too Many Requests\r\nRetry-After: 4\r\n\r\n');
        return { stdout: curlStdout('slow down', 429, target), stderr: Buffer.alloc(0) };
      }
      if (attempt === 2) {
        throw new Error('timeout');
      }
      writeCurlHeaders(args, JPEG_HEADERS);
      return { stdout: curlStdout(JPEG_BYTES, 200, target), stderr: Buffer.alloc(0) };
    };

    const r1 = await invokeMich(
      ['download', 'IO_abc123', '--output', outDir, '--json'],
      cacheDir,
      {
        execFileImpl,
        sleepFn: async (ms) => {
          sleeps.push(ms);
        },
      }
    );
    const r2 = await invokeMich(['fetch', 'IO_abc123', '-o', outDir, '--json'], cacheDir, {
      execFileImpl,
    });

    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(attempt).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBe(4000);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(fs.readFileSync(path.join(outDir, 'certificate.jpg'))).toEqual(JPEG_BYTES);
  });

  it('enforces host allowlist on input URLs and redirects', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;

    const execFileImpl: ExecFileFn = async () => {
      calls += 1;
      return {
        stdout: curlStdout(ITEM_HTML, 200, 'https://evil.invalid/uncategorized/IO_abc123/'),
        stderr: Buffer.alloc(0),
      };
    };

    const badHost = await invokeMich(
      ['get', 'https://evil.invalid/uncategorized/IO_abc123/'],
      cacheDir,
      { execFileImpl }
    );
    const badScheme = await invokeMich(
      ['get', 'http://michigan.access.preservica.com/uncategorized/IO_abc123/'],
      cacheDir,
      { execFileImpl }
    );
    const badCreds = await invokeMich(
      ['get', 'https://user:pass@michigan.access.preservica.com/uncategorized/IO_abc123/'],
      cacheDir,
      { execFileImpl }
    );
    expect(calls).toBe(0);
    const badRedir = await invokeMich(['get', 'IO_abc123'], cacheDir, { execFileImpl });

    expect(badHost.exitCode).toBe(1);
    expect(badHost.stderr).toContain('disallowed host');
    expect(badScheme.exitCode).toBe(1);
    expect(badScheme.stderr).toContain('non-HTTPS');
    expect(badCreds.exitCode).toBe(1);
    expect(badRedir.exitCode).toBe(1);
    expect(badRedir.stderr).toContain('disallowed host');
    expect(calls).toBe(1);
  });

  it('rejects path traversal and sanitizes server Content-Disposition filenames', async () => {
    const cacheDir = await makeTempDir();
    const outDir = path.join(cacheDir, 'safe');
    const traversalHeaders =
      'HTTP/1.1 200 OK\r\n' +
      'Content-Type: image/jpeg\r\n' +
      'Content-Disposition: attachment; filename="../../escaped.jpg"\r\n' +
      '\r\n';

    const execFileImpl: ExecFileFn = async (_file, args) => {
      writeCurlHeaders(args, traversalHeaders);
      return { stdout: curlStdout(JPEG_BYTES, 200, args.at(-1) ?? ''), stderr: Buffer.alloc(0) };
    };

    const badName = await invokeMich(
      ['download', 'IO_abc123', '--out', outDir, '--filename', '../escape.jpg'],
      cacheDir,
      { execFileImpl }
    );
    const badSlash = await invokeMich(
      ['download', 'IO_abc123', '--out', outDir, '--filename', 'sub/file.jpg'],
      cacheDir,
      { execFileImpl }
    );
    const badOut = await invokeMich(
      ['download', 'IO_abc123', '--out', `${outDir}/../escape.jpg`],
      cacheDir,
      { execFileImpl }
    );
    const sanitized = await invokeMich(
      ['download', 'IO_abc123', '--out', outDir, '--json'],
      cacheDir,
      { execFileImpl }
    );

    expect(badName.exitCode).toBe(2);
    expect(badSlash.exitCode).toBe(2);
    expect(badOut.exitCode).toBe(2);
    expect(sanitized.exitCode).toBe(0);
    const payload = JSON.parse(sanitized.stdout) as { path: string };
    const written = path.resolve(payload.path);
    expect(written.startsWith(`${path.resolve(outDir)}${path.sep}`)).toBe(true);
    expect(path.basename(written)).toBe('escaped.jpg');
    expect(fs.readFileSync(written)).toEqual(JPEG_BYTES);
  });

  it('supports flag aliases, subcommand aliases (item/show/info), collections, and url', async () => {
    const cacheDir = await makeTempDir();
    const execFileImpl: ExecFileFn = async (_file, args) => {
      const target = args.at(-1) ?? '';
      if (target.includes('/?s=')) {
        return { stdout: curlStdout(SEARCH_HTML, 200, target), stderr: Buffer.alloc(0) };
      }
      return { stdout: curlStdout(ITEM_HTML, 200, target), stderr: Buffer.alloc(0) };
    };

    const multiWord = await invokeMich(
      ['search', 'Abraham', 'Lincoln', '-n', '1', '--json'],
      cacheDir,
      { execFileImpl }
    );
    const qOpt = await invokeMich(['search', '-q', 'Lincoln', '--json'], cacheDir, {
      execFileImpl,
    });
    const itemAlias = await invokeMich(['item', 'IO_abc123', '--json'], cacheDir, { execFileImpl });
    const showAlias = await invokeMich(['show', 'IO_abc123', '--json'], cacheDir, { execFileImpl });
    const infoAlias = await invokeMich(['info', 'IO_abc123', '--json'], cacheDir, { execFileImpl });
    const cols = await invokeMich(['collections', '--json'], cacheDir);
    const urlRes = await invokeMich(['url', 'Abraham', 'Lincoln'], cacheDir);

    expect(multiWord.exitCode).toBe(0);
    const multiPayload = JSON.parse(multiWord.stdout) as { query: string; results: unknown[] };
    expect(multiPayload.query).toBe('Abraham Lincoln');
    expect(multiPayload.results).toHaveLength(1);
    expect(qOpt.exitCode).toBe(0);
    expect(itemAlias.exitCode).toBe(0);
    expect(showAlias.exitCode).toBe(0);
    expect(infoAlias.exitCode).toBe(0);
    expect((JSON.parse(showAlias.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect((JSON.parse(infoAlias.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);

    expect(cols.exitCode).toBe(0);
    expect((JSON.parse(cols.stdout) as unknown[]).length).toBe(9);
    expect(urlRes.exitCode).toBe(0);
    expect(urlRes.stdout).toBe('https://michigan.access.preservica.com/?s=Abraham+Lincoln');
  });
});
