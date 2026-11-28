import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext, type ExecFileFn } from '../runtime/index.js';
import { parsePageFilter, runPdfGrepCommand } from './pdf-grep.js';

const SAMPLE_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-pdf-grep-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokePdfGrep(
  args: readonly string[],
  options: {
    readonly cacheDir: string;
    readonly fetchImpl?: typeof fetch;
    readonly execFileImpl?: ExecFileFn;
  }
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly cacheHit?: boolean | undefined;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_PDF_GREP_CACHE_DIR: options.cacheDir },
    cwd: options.cacheDir,
    fetchImpl: options.fetchImpl ?? (async () => new Response('not found', { status: 404 })),
    execFileImpl: options.execFileImpl,
    sleepFn: async () => {},
  });
  const outcome = await runPdfGrepCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('kinloom pdf-grep', () => {
  it('prints usage and exits 0 on empty args or --help', async () => {
    const cacheDir = await makeTempDir();
    const r0 = await invokePdfGrep([], { cacheDir });
    const r1 = await invokePdfGrep(['--help'], { cacheDir });
    const r2 = await invokePdfGrep(['sample.pdf', '-h'], { cacheDir });
    expect([r0.exitCode, r1.exitCode, r2.exitCode]).toEqual([0, 0, 0]);
    expect(r1.stdout).toContain('kinloom pdf-grep <url-or-path...> --pattern <regex>');
  });

  it('greps local PDF files, caches SHA-256 pdftotext output, and supports --pages, --ignore-case, --limit, zero-width regex, and --refresh', async () => {
    const tmp = await makeTempDir();
    const pdfPath = path.join(tmp, 'probate.pdf');
    await writeFile(pdfPath, SAMPLE_PDF);

    let execCalls = 0;
    const execFileImpl: ExecFileFn = async () => {
      execCalls += 1;
      return {
        stdout: Buffer.from(
          'Page 1 header\nEstate of Abraham Lincoln\nSangamon County\fPage 2 header\nlincoln estate witness\nlincoln again\f'
        ),
        stderr: Buffer.alloc(0),
      };
    };

    const r1 = await invokePdfGrep([pdfPath, '--pattern', 'Lincoln', '--ignore-case', '--json'], {
      cacheDir: tmp,
      execFileImpl,
    });
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(execCalls).toBe(1);
    const p1 = JSON.parse(r1.stdout) as {
      total_matches: number;
      cache_hit: boolean;
      sources: Array<{
        kind: string;
        page_count: number;
        match_count: number;
        pages: number[];
        cache_hit: boolean;
      }>;
    };
    expect(p1.cache_hit).toBe(false);
    expect(p1.total_matches).toBe(3);
    expect(p1.sources[0]?.kind).toBe('file');
    expect(p1.sources[0]?.page_count).toBe(2);
    expect(p1.sources[0]?.pages).toEqual([1, 2]);

    // Second run hits SHA-256 disk cache (zero pdftotext invocations).
    const r2 = await invokePdfGrep(
      [pdfPath, '-e', 'Lincoln', '-e', 'Sangamon', '-i', '--pages', '2', '--limit', '1', '--json'],
      { cacheDir: tmp, execFileImpl }
    );
    expect(r2.exitCode).toBe(0);
    expect(execCalls).toBe(1);
    const p2 = JSON.parse(r2.stdout) as {
      total_matches: number;
      cache_hit: boolean;
      sources: Array<{ returned: number; truncated: boolean; pages: number[] }>;
    };
    expect(p2.cache_hit).toBe(true);
    expect(p2.total_matches).toBe(2);
    expect(p2.sources[0]?.returned).toBe(1);
    expect(p2.sources[0]?.truncated).toBe(true);
    expect(p2.sources[0]?.pages).toEqual([2]);

    // Zero-width regex (^) safely advances without infinite loop and text output shows [cache].
    const rZero = await invokePdfGrep([pdfPath, '--pattern', '^'], {
      cacheDir: tmp,
      execFileImpl,
    });
    expect(rZero.exitCode).toBe(0);
    expect(rZero.stdout).toContain('[cache]');

    // Text mode output + --refresh re-runs pdftotext.
    const r3 = await invokePdfGrep([pdfPath, '--pattern', 'Sangamon', '--refresh'], {
      cacheDir: tmp,
      execFileImpl,
    });
    expect(r3.exitCode).toBe(0);
    expect(execCalls).toBe(2);
    expect(r3.stdout).toContain('1 match(es)');
    expect(r3.stdout).toContain('p.1 L3:');

    // Corrupt text cache entry falls back cleanly to pdftotext.
    const textDir = path.join(tmp, 'text');
    for (const f of fs.readdirSync(textDir)) {
      if (f.endsWith('.json')) {
        await writeFile(path.join(textDir, f), JSON.stringify({ pages: [123] }));
      }
    }
    const rCorrupt = await invokePdfGrep([pdfPath, '--pattern', 'Sangamon', '--json'], {
      cacheDir: tmp,
      execFileImpl,
    });
    expect(rCorrupt.exitCode).toBe(0);
    expect(execCalls).toBe(3);

    for (const f of fs.readdirSync(textDir)) {
      if (f.endsWith('.json')) {
        await writeFile(path.join(textDir, f), '[]');
      }
    }
    const rCorrupt2 = await invokePdfGrep([pdfPath, '--pattern', 'Sangamon', '--json'], {
      cacheDir: tmp,
      execFileImpl,
    });
    expect(rCorrupt2.exitCode).toBe(0);
    expect(execCalls).toBe(4);
  });

  it('downloads remote PDF URLs with SHA-256 disk caching and greps multiple sources', async () => {
    const tmp = await makeTempDir();
    const localPath = path.join(tmp, 'local.pdf');
    await writeFile(localPath, SAMPLE_PDF);

    let fetchCalls = 0;
    const fetchImpl: typeof fetch = async () => {
      fetchCalls += 1;
      return new Response(new Uint8Array(SAMPLE_PDF), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    };
    let execCalls = 0;
    const execFileImpl: ExecFileFn = async () => {
      execCalls += 1;
      return { stdout: Buffer.from('Stout Family Roll\n1880 Census\f'), stderr: Buffer.alloc(0) };
    };

    const url = 'https://archives.example.org/rolls/1880.pdf';
    const r1 = await invokePdfGrep([url, localPath, '--pattern', 'Stout', '--json'], {
      cacheDir: tmp,
      fetchImpl,
      execFileImpl,
    });
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(fetchCalls).toBe(1);
    expect(execCalls).toBe(1);
    const p1 = JSON.parse(r1.stdout) as { source_count: number; total_matches: number; cache_hit: boolean };
    expect(p1.source_count).toBe(2);
    expect(p1.total_matches).toBe(2);
    expect(p1.cache_hit).toBe(false);

    // Repeat run hits both download and text caches.
    const r2 = await invokePdfGrep([url, localPath, '--pattern', 'Stout', '--json'], {
      cacheDir: tmp,
      fetchImpl,
      execFileImpl,
    });
    expect(r2.exitCode).toBe(0);
    expect(fetchCalls).toBe(1);
    expect(execCalls).toBe(1);
    expect((JSON.parse(r2.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
  });

  it('handles validation, SSRF, HTTP, non-PDF, and pdftotext errors cleanly', async () => {
    const tmp = await makeTempDir();
    const dirPath = path.join(tmp, 'folder');
    const htmlPath = path.join(tmp, 'fake.pdf');
    const emptyPath = path.join(tmp, 'empty.pdf');
    const badMagicPath = path.join(tmp, 'bad.pdf');
    const validPath = path.join(tmp, 'valid.pdf');
    fs.mkdirSync(dirPath, { recursive: true });
    await writeFile(htmlPath, '<!DOCTYPE html><html><body>Denied</body></html>');
    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(badMagicPath, 'NOT_A_PDF');
    await writeFile(validPath, SAMPLE_PDF);

    // SSRF loopback blocked
    const ssrf = await invokePdfGrep(['http://127.0.0.1/secret.pdf', '--pattern', 'x'], { cacheDir: tmp });
    expect(ssrf.exitCode).toBe(2);
    expect(ssrf.stderr).toContain('Refused unsafe URL');

    // Missing file & directory
    expect(
      (await invokePdfGrep([path.join(tmp, 'missing.pdf'), '--pattern', 'x'], { cacheDir: tmp })).exitCode
    ).toBe(2);
    expect((await invokePdfGrep([dirPath, '--pattern', 'x'], { cacheDir: tmp })).exitCode).toBe(2);

    // Empty, HTML, bad magic
    expect((await invokePdfGrep([emptyPath, '--pattern', 'x'], { cacheDir: tmp })).exitCode).toBe(1);
    expect((await invokePdfGrep([htmlPath, '--pattern', 'x'], { cacheDir: tmp })).exitCode).toBe(1);
    expect((await invokePdfGrep([badMagicPath, '--pattern', 'x'], { cacheDir: tmp })).exitCode).toBe(1);

    // Bad regex, empty pattern, bad timeout, bad pages
    expect((await invokePdfGrep([validPath, '--pattern', '[unclosed'], { cacheDir: tmp })).exitCode).toBe(2);
    expect((await invokePdfGrep([validPath, '--pattern', '   '], { cacheDir: tmp })).exitCode).toBe(2);
    expect(
      (await invokePdfGrep([validPath, '--pattern', 'x', '--timeout', '0'], { cacheDir: tmp })).exitCode
    ).toBe(2);
    expect(
      (await invokePdfGrep([validPath, '--pattern', 'x', '--pages', '5-2'], { cacheDir: tmp })).exitCode
    ).toBe(2);
    expect(
      (await invokePdfGrep([validPath, '--pattern', 'x', '--pages', '0'], { cacheDir: tmp })).exitCode
    ).toBe(2);
    expect(
      (await invokePdfGrep([validPath, '--pattern', 'x', '--pages', 'abc'], { cacheDir: tmp })).exitCode
    ).toBe(2);
    expect(parsePageFilter('all')).toBeNull();
    expect(parsePageFilter('1-2,,4')).toEqual(new Set([1, 2, 4]));

    // HTTP 404 from remote URL
    const httpErr = await invokePdfGrep(['https://archives.example.org/missing.pdf', '--pattern', 'x'], {
      cacheDir: tmp,
      fetchImpl: async () => new Response('missing', { status: 404 }),
    });
    expect(httpErr.exitCode).toBe(1);
    expect(httpErr.stderr).toContain('HTTP 404');

    // pdftotext ENOENT, timeout, Buffer stderr, string stderr, and non-object throw
    const enoent = await invokePdfGrep([validPath, '--pattern', 'x'], {
      cacheDir: tmp,
      execFileImpl: async () => {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    expect(enoent.exitCode).toBe(1);
    expect(enoent.stderr).toContain('pdftotext not found');

    const timedOut = await invokePdfGrep([validPath, '--pattern', 'x'], {
      cacheDir: tmp,
      execFileImpl: async () => {
        const err = Object.assign(new Error('killed'), { killed: true, code: null });
        throw err;
      },
    });
    expect(timedOut.exitCode).toBe(1);
    expect(timedOut.stderr).toContain('timed out');

    const failedBuf = await invokePdfGrep([validPath, '--pattern', 'x'], {
      cacheDir: tmp,
      execFileImpl: async () => {
        throw Object.assign(new Error('boom'), { code: 1, stderr: Buffer.from('corrupt pdf') });
      },
    });
    expect(failedBuf.exitCode).toBe(1);
    expect(failedBuf.stderr).toContain('corrupt pdf');

    const failedStr = await invokePdfGrep([validPath, '--pattern', 'x'], {
      cacheDir: tmp,
      execFileImpl: async () => {
        throw { code: 2, stderr: 'string stderr' };
      },
    });
    expect(failedStr.exitCode).toBe(1);
    expect(failedStr.stderr).toContain('string stderr');

    const failedPrimitive = await invokePdfGrep([validPath, '--pattern', 'x'], {
      cacheDir: tmp,
      execFileImpl: async () => {
        throw 'plain failure';
      },
    });
    expect(failedPrimitive.exitCode).toBe(1);
    expect(failedPrimitive.stderr).toContain('plain failure');
  });
});
