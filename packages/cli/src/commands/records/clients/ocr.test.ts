import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRecordContext,
  createSyntheticPng,
  type ExecFileFn,
  type RecordCommandContext,
} from '../runtime/index.js';
import {
  modeSlug,
  parseTesseractTsv,
  readImageDimensions,
  rescaleTesseractTsv,
  runOcrCommand,
} from './ocr.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function makeTempDir(prefix = 'kinloom-ocr-test-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function invokeOcr(
  args: readonly string[],
  overrides: Partial<RecordCommandContext> = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    ...overrides,
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    sleepFn: overrides.sleepFn ?? (async () => {}),
  });
  const outcome = await runOcrCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ocr pure helpers', () => {
  it('computes deterministic mode slugs matching disk cache format', () => {
    expect(modeSlug('printed', 6, 'low', undefined)).toBe('printed_psm6');
    expect(modeSlug('printed', 3, 'high', undefined)).toBe('printed_psm3');
    expect(modeSlug('cursive', 6, 'low', undefined)).toBe('cursive_hydrogen_low');
    const customSlug = modeSlug('cursive', 6, 'medium', 'Transcribe names only');
    expect(customSlug).toMatch(/^cursive_hydrogen_medium_p[0-9a-f]{8}$/);
  });

  it('reads PNG dimensions from synthetic sharp PNG buffers', async () => {
    const png = await createSyntheticPng(640, 480);
    expect(readImageDimensions(png)).toEqual([640, 480]);
    expect(readImageDimensions(Buffer.from('not-an-image'))).toBeNull();
  });

  it('rescales and parses Tesseract TSV coordinates accurately', () => {
    const tsv = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t2000\t1500\t-1\t',
      '5\t1\t1\t1\t1\t1\t200\t300\t400\t75\t91\tProbate',
    ].join('\n');
    const rescaled = rescaleTesseractTsv(tsv, 4000, 3000, 2000, 1500);
    const parsed = parseTesseractTsv(rescaled);
    expect(parsed.image_width).toBe(4000);
    expect(parsed.image_height).toBe(3000);
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.lines[0]).toMatchObject({
      text: 'Probate',
      x0: 400,
      y0: 600,
      x1: 1200,
      y1: 750,
      conf: 91,
    });
  });
});

describe('ocr native client', () => {
  it('prints help for root command and batch subcommand', async () => {
    const rootHelp = await invokeOcr(['--help']);
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout).toContain('Usage: kinloom ocr <image> [image ...] [options]');
    expect(rootHelp.stdout).toContain('--mode <printed|cursive>');
    expect(rootHelp.stdout).toContain('KINLOOM_OCR_CACHE_DIR');
    expect(rootHelp.stdout).toContain('KINLOOM_OCR_CLI');
    expect(rootHelp.stdout).toContain('batch');

    const batchHelp = await invokeOcr(['batch', '--help']);
    expect(batchHelp.exitCode).toBe(0);
    expect(batchHelp.stdout).toContain('Usage: kinloom ocr batch <glob-or-dir>');
    expect(batchHelp.stdout).toContain('--grep <regex>');
    expect(batchHelp.stdout).toContain('OMP_THREAD_LIMIT=1');
  });

  it('serves cached OCR result from SHA-256 disk cache without invoking external binaries', async () => {
    const tmp = await makeTempDir('kinloom-ocr-cache-');
    const imgPath = path.join(tmp, 'sample.png');
    const cacheDir = path.join(tmp, 'cache');
    const payloadBytes = await createSyntheticPng(32, 32);
    await writeFile(imgPath, payloadBytes);

    const sha256 = crypto.createHash('sha256').update(payloadBytes).digest('hex');
    fs.mkdirSync(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `${sha256}_printed_psm6.json`),
      JSON.stringify({
        sha256,
        mode: 'printed_psm6',
        engine: 'tesseract',
        created_at: '2026-11-25T00:00:00Z',
        elapsed_ms: 12,
        text: 'Springfield Probate Docket 1862',
        source_hint: 'sample.png',
        meta: { psm: 6 },
      })
    );

    const forbidExec: ExecFileFn = async () => {
      throw new Error('Should not invoke external binary on cache hit');
    };

    const result = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--json'], {
      execFileImpl: forbidExec,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.cacheHit).toBe(true);
    const parsed = JSON.parse(result.stdout) as {
      cached: boolean;
      cache_hit: boolean;
      text: string;
      sha256: string;
    };
    expect(parsed.cached).toBe(true);
    expect(parsed.cache_hit).toBe(true);
    expect(parsed.text).toBe('Springfield Probate Docket 1862');
    expect(parsed.sha256).toBe(sha256);
  });

  it('always injects OMP_THREAD_LIMIT=1 and OMP_NUM_THREADS=1 into every tesseract call', async () => {
    const tmp = await makeTempDir('kinloom-ocr-omp-');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'scan.png');
    await writeFile(imgPath, await createSyntheticPng(64, 64));

    const observedEnvs: NodeJS.ProcessEnv[] = [];
    const mockExec: ExecFileFn = async (_file, _args, options) => {
      observedEnvs.push({ ...options?.env });
      return {
        stdout: Buffer.from(`OMP=${options?.env?.['OMP_THREAD_LIMIT'] ?? ''}`),
        stderr: Buffer.alloc(0),
      };
    };

    const res = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--timeout', '10', '--json'], {
      env: { ...process.env, OMP_THREAD_LIMIT: '28', OMP_NUM_THREADS: '28' },
      execFileImpl: mockExec,
    });

    expect(res.exitCode, res.stderr).toBe(0);
    expect(observedEnvs).toHaveLength(1);
    expect(observedEnvs[0]['OMP_THREAD_LIMIT']).toBe('1');
    expect(observedEnvs[0]['OMP_NUM_THREADS']).toBe('1');
    const parsed = JSON.parse(res.stdout) as {
      text: string;
      meta: { omp_thread_limit: number; timeout_s: number };
    };
    expect(parsed.text).toBe('OMP=1');
    expect(parsed.meta.omp_thread_limit).toBe(1);
    expect(parsed.meta.timeout_s).toBe(10);

    // Invalid --timeout values must be rejected with exit code 2.
    for (const badVal of ['0', '-5', 'abc']) {
      const badRes = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--timeout', badVal], {
        execFileImpl: mockExec,
      });
      expect(badRes.exitCode).toBe(2);
      expect(badRes.stderr).toContain('positive');
    }
  });

  it('kills hung tesseract child process cleanly at --timeout, emits structured OCR_TIMEOUT, and leaves no zombie process', async () => {
    const tmp = await makeTempDir('kinloom-ocr-hang-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'hung.png');
    const pidFile = path.join(tmp, 'child.pid');
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(imgPath, await createSyntheticPng(48, 48));

    // Real POSIX shell script that writes its PID immediately (~1ms), traps SIGTERM (to prove SIGKILL escalation works!), and hangs.
    const fakeTesseract = path.join(binDir, 'tesseract');
    await writeFile(
      fakeTesseract,
      `${['#!/bin/sh', 'trap "" TERM', `printf "%s" "$$" > "${pidFile}"`, 'while :; do sleep 1; done'].join(
        '\n'
      )}\n`,
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      OMP_THREAD_LIMIT: '16',
    };

    const t0 = Date.now();
    const res = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--timeout', '0.08', '--json'], { env });
    const elapsedMs = Date.now() - t0;

    expect(res.exitCode).toBe(1);
    expect(elapsedMs).toBeLessThan(3500);
    expect(res.stderr).toContain('timed out after 0.08s');
    const payload = JSON.parse(res.stdout) as {
      error_code: string;
      timeout_seconds: number;
      file: string;
      message: string;
    };
    expect(payload.error_code).toBe('OCR_TIMEOUT');
    expect(payload.timeout_seconds).toBe(0.08);
    expect(payload.file).toBe(imgPath);
    expect(payload.message).toContain('timed out');

    // Verify the spawned child process is completely terminated (no hung/zombie process left behind).
    const childPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true);
    for (let attempt = 0; attempt < 20 && isPidAlive(childPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(isPidAlive(childPid)).toBe(false);
  });

  it('emits cached --boxes, --find, and --tsv layout output with OMP_THREAD_LIMIT=1', async () => {
    const tmp = await makeTempDir('kinloom-ocr-boxes-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'page.png');
    const callLog = path.join(tmp, 'calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    const imgBytes = await createSyntheticPng(120, 160);
    await writeFile(imgPath, imgBytes);
    const sha256 = crypto.createHash('sha256').update(imgBytes).digest('hex');

    const tsvRows = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t200\t80\t30\t90\tProbate',
      '5\t1\t1\t1\t1\t2\t190\t205\t90\t32\t80\tDocket',
      '5\t1\t1\t1\t2\t1\t100\t260\t60\t28\t70\tOMP=OMP_VALUE',
      '5\t1\t2\t1\t1\t1\t400\t900\t50\t20\t95\tSpringfield',
    ].join('\n');
    const fixture = path.join(tmp, 'fixture.tsv');
    await writeFile(fixture, `${tsvRows}\n`);
    await writeFile(
      path.join(binDir, 'tesseract'),
      `#!/bin/sh\necho "$*" >> "${callLog}"\nsed "s/OMP_VALUE/$OMP_THREAD_LIMIT/" "${fixture}"\n`,
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      OMP_THREAD_LIMIT: '28',
    };

    type Boxes = {
      cached: boolean;
      cache_hit: boolean;
      image_width: number;
      image_height: number;
      lines: Array<{ text: string; x0: number; y0: number; x1: number; y1: number; conf: number }>;
    };

    const first = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--boxes'], { env });
    expect(first.exitCode, first.stderr).toBe(0);
    const boxes = JSON.parse(first.stdout) as Boxes;
    expect(boxes.cached).toBe(false);
    expect(boxes.cache_hit).toBe(false);
    expect([boxes.image_width, boxes.image_height]).toEqual([1200, 1600]);
    expect(boxes.lines.map((l) => l.text)).toEqual(['Probate Docket', 'OMP=1', 'Springfield']);
    expect(boxes.lines[0]).toMatchObject({ x0: 100, y0: 200, x1: 280, y1: 237, conf: 85 });
    expect(fs.readFileSync(callLog, 'utf8')).toContain('--psm 6 tsv');

    const found = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--find', 'DOCKET|spring'], {
      env,
    });
    expect(found.exitCode, found.stderr).toBe(0);
    const foundBoxes = JSON.parse(found.stdout) as Boxes;
    expect(foundBoxes.cached).toBe(true);
    expect(foundBoxes.lines.map((l) => [l.text, l.x0, l.y0, l.x1, l.y1])).toEqual([
      ['Probate Docket', 100, 200, 280, 237],
      ['Springfield', 400, 900, 450, 920],
    ]);

    const tsv = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--tsv'], { env });
    expect(tsv.exitCode, tsv.stderr).toBe(0);
    expect(tsv.stdout).toContain('level\tpage_num');
    expect(tsv.stdout).toContain('OMP=1');
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.tsv`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.boxes.json`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.json`))).toBe(false);

    const conflict = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--tsv', '--boxes'], {
      env,
    });
    expect(conflict.exitCode).toBe(2);
    const cursive = await invokeOcr([imgPath, '--cache-dir', cacheDir, '--boxes', '--mode', 'cursive'], {
      env,
    });
    expect(cursive.exitCode).toBe(2);
  });

  it('processes multiple images with per-file cache hits and backward-compatible single-file output', async () => {
    const tmp = await makeTempDir('kinloom-ocr-multi-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const img1 = path.join(tmp, 'page1.png');
    const img2 = path.join(tmp, 'page2.png');
    const callLog = path.join(tmp, 'calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(img1, await createSyntheticPng(32, 32, { r: 240, g: 240, b: 240 }));
    await writeFile(img2, await createSyntheticPng(32, 32, { r: 220, g: 220, b: 220 }));

    await writeFile(
      path.join(binDir, 'tesseract'),
      `${[
        '#!/bin/sh',
        `echo "$1|$OMP_THREAD_LIMIT|$*" >> "${callLog}"`,
        'base=$(basename "$1")',
        'case "$*" in',
        '  *" tsv"*)',
        '    printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"',
        '    printf "1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t800\\t600\\t-1\\t\\n"',
        '    if [ "$base" = "page1.png" ]; then',
        '      printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t20\\t100\\t20\\t92\\tLincoln\\n"',
        '    else',
        '      printf "5\\t1\\t1\\t1\\t1\\t1\\t30\\t40\\t100\\t20\\t88\\tSpringfield\\n"',
        '    fi',
        '    ;;',
        '  *)',
        '    echo "TEXT:$base:OMP=$OMP_THREAD_LIMIT"',
        '    ;;',
        'esac',
      ].join('\n')}\n`,
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      OMP_THREAD_LIMIT: '16',
    };

    const coldText = await invokeOcr([img1, img2, '--cache-dir', cacheDir], { env });
    expect(coldText.exitCode, coldText.stderr).toBe(0);
    expect(coldText.stdout).toBe(
      `=== ${img1} ===\nTEXT:page1.png:OMP=1\n\n=== ${img2} ===\nTEXT:page2.png:OMP=1`
    );
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(2);

    const warmJson = await invokeOcr([img1, img2, '--cache-dir', cacheDir, '--json'], { env });
    expect(warmJson.exitCode, warmJson.stderr).toBe(0);
    const parsedMulti = JSON.parse(warmJson.stdout) as {
      count: number;
      cache_hits: number;
      cache_hit: boolean;
      files: Array<{ file: string; cached: boolean; cache_hit: boolean; text: string }>;
    };
    expect(parsedMulti.count).toBe(2);
    expect(parsedMulti.cache_hits).toBe(2);
    expect(parsedMulti.cache_hit).toBe(true);
    expect(parsedMulti.files.map((f) => [f.file, f.cached, f.text])).toEqual([
      [img1, true, 'TEXT:page1.png:OMP=1'],
      [img2, true, 'TEXT:page2.png:OMP=1'],
    ]);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(2);

    // Single-file JSON remains a flat object.
    const singleJson = await invokeOcr([img1, '--cache-dir', cacheDir, '--json'], { env });
    expect(singleJson.exitCode, singleJson.stderr).toBe(0);
    const parsedSingle = JSON.parse(singleJson.stdout) as {
      cached: boolean;
      cache_hit: boolean;
      text: string;
      files?: unknown;
    };
    expect(parsedSingle.files).toBeUndefined();
    expect(parsedSingle.cached).toBe(true);
    expect(parsedSingle.cache_hit).toBe(true);
    expect(parsedSingle.text).toBe('TEXT:page1.png:OMP=1');

    // Multi-file --find caches boxes for repeat --find queries.
    const find1 = await invokeOcr([img1, img2, '--cache-dir', cacheDir, '--find', 'lincoln'], {
      env,
    });
    expect(find1.exitCode, find1.stderr).toBe(0);
    const parsedFind1 = JSON.parse(find1.stdout) as {
      count: number;
      cache_hits: number;
      files: Array<{ lines: Array<{ text: string }> }>;
    };
    expect(parsedFind1.count).toBe(2);
    expect(parsedFind1.cache_hits).toBe(0);
    expect(parsedFind1.files[0].lines.map((l) => l.text)).toEqual(['Lincoln']);
    expect(parsedFind1.files[1].lines).toEqual([]);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);

    const find2 = await invokeOcr([img1, img2, '--cache-dir', cacheDir, '--find', 'springfield'], {
      env,
    });
    expect(find2.exitCode, find2.stderr).toBe(0);
    const parsedFind2 = JSON.parse(find2.stdout) as {
      cache_hits: number;
      files: Array<{ lines: Array<{ text: string }> }>;
    };
    expect(parsedFind2.cache_hits).toBe(2);
    expect(parsedFind2.files[0].lines).toEqual([]);
    expect(parsedFind2.files[1].lines.map((l) => l.text)).toEqual(['Springfield']);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);

    // Missing file fails cleanly with exit 2 before invoking tesseract.
    const missing = await invokeOcr([img1, path.join(tmp, 'does-not-exist.png'), '--cache-dir', cacheDir], {
      env,
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('image file not found');
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('parallelizes multi-file OCR, preserves exact input order, and honors --refresh', async () => {
    const tmp = await makeTempDir('kinloom-ocr-parallel-');
    const cacheDir = path.join(tmp, 'cache');
    const imgs = [1, 2, 3, 4].map((n) => path.join(tmp, `sheet-${n}.png`));
    for (let i = 0; i < imgs.length; i += 1) {
      await writeFile(imgs[i], await createSyntheticPng(24, 24, { r: 200 + i * 10, g: 200, b: 200 }));
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let totalCalls = 0;
    const mockExec: ExecFileFn = async (_bin, args, options) => {
      totalCalls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const base = path.basename(args[0]);
      const delayMs =
        base === 'sheet-1.png' ? 90 : base === 'sheet-2.png' ? 65 : base === 'sheet-3.png' ? 40 : 15;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      inFlight -= 1;
      return {
        stdout: Buffer.from(`OUT:${base}:OMP=${options?.env?.['OMP_THREAD_LIMIT'] ?? ''}`),
        stderr: Buffer.alloc(0),
      };
    };

    const cold = await invokeOcr([...imgs, '--cache-dir', cacheDir, '--json'], {
      env: { ...process.env, OMP_THREAD_LIMIT: '32' },
      execFileImpl: mockExec,
    });
    expect(cold.exitCode, cold.stderr).toBe(0);
    expect(cold.cacheHit).toBe(false);
    const coldBody = JSON.parse(cold.stdout) as {
      count: number;
      cache_hits: number;
      cache_hit: boolean;
      files: Array<{ file: string; cached: boolean; cache_hit: boolean; text: string }>;
    };
    expect(coldBody.count).toBe(4);
    expect(coldBody.cache_hits).toBe(0);
    expect(coldBody.cache_hit).toBe(false);
    expect(coldBody.files.map((f) => [f.file, f.cached, f.cache_hit, f.text])).toEqual([
      [imgs[0], false, false, 'OUT:sheet-1.png:OMP=1'],
      [imgs[1], false, false, 'OUT:sheet-2.png:OMP=1'],
      [imgs[2], false, false, 'OUT:sheet-3.png:OMP=1'],
      [imgs[3], false, false, 'OUT:sheet-4.png:OMP=1'],
    ]);
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(totalCalls).toBe(4);

    const warm = await invokeOcr([...imgs, '--cache-dir', cacheDir, '--json'], {
      execFileImpl: mockExec,
    });
    expect(warm.exitCode).toBe(0);
    expect(warm.cacheHit).toBe(true);
    expect(totalCalls).toBe(4);

    const refreshed = await invokeOcr([imgs[0], '--cache-dir', cacheDir, '--refresh', '--json'], {
      execFileImpl: mockExec,
    });
    expect(refreshed.exitCode).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({ cached: false, cache_hit: false });
    expect(totalCalls).toBe(5);
  });

  it('caps oversized printed scans in-process via sharp and rescales --boxes, --find, and --tsv back to original pixels', async () => {
    const tmp = await makeTempDir('kinloom-ocr-scale-');
    const cacheDir = path.join(tmp, 'cache');
    const bigPng = path.join(tmp, 'oversized-4000x3000.png');

    await writeFile(bigPng, await createSyntheticPng(4000, 3000));

    const seenSizes: Array<readonly [number, number]> = [];
    const mockExec: ExecFileFn = async (_bin, args) => {
      const targetPath = args[0];
      const dims = readImageDimensions(fs.readFileSync(targetPath));
      if (!dims) {
        throw new Error(`Could not read dimensions of ${targetPath}`);
      }
      const [w, h] = dims;
      seenSizes.push([w, h]);
      if (args.includes('tsv')) {
        const x0 = Math.round(w * 0.1);
        const y0 = Math.round(h * 0.2);
        const bw = Math.round(w * 0.2);
        const bh = Math.round(h * 0.05);
        const tsv = [
          'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
          `1\t1\t0\t0\t0\t0\t0\t0\t${w}\t${h}\t-1\t`,
          `5\t1\t1\t1\t1\t1\t${x0}\t${y0}\t${bw}\t${bh}\t93\tProbate`,
        ].join('\n');
        return { stdout: Buffer.from(`${tsv}\n`), stderr: Buffer.alloc(0) };
      }
      return { stdout: Buffer.from('Probate\n'), stderr: Buffer.alloc(0) };
    };

    const res = await invokeOcr([bigPng, '--cache-dir', cacheDir, '--find', 'probate'], {
      execFileImpl: mockExec,
    });
    expect(res.exitCode, res.stderr).toBe(0);
    const body = JSON.parse(res.stdout) as {
      image_width: number;
      image_height: number;
      cache_hit: boolean;
      lines: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
    };
    expect([body.image_width, body.image_height]).toEqual([4000, 3000]);
    expect(body.cache_hit).toBe(false);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].text).toBe('Probate');
    expect(Math.abs(body.lines[0].x0 - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y0 - 600)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].x1 - 1200)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y1 - 750)).toBeLessThanOrEqual(2);

    expect(seenSizes).toHaveLength(1);
    expect(Math.max(seenSizes[0][0], seenSizes[0][1])).toBeLessThanOrEqual(3500);

    // Cached --tsv exposes rescaled 4000x3000 page box and hits cache.
    const tsvRes = await invokeOcr([bigPng, '--cache-dir', cacheDir, '--tsv'], {
      execFileImpl: mockExec,
    });
    expect(tsvRes.exitCode, tsvRes.stderr).toBe(0);
    expect(tsvRes.cacheHit).toBe(true);
    expect(tsvRes.stdout).toContain('\t4000\t3000\t-1');
    expect(seenSizes).toHaveLength(1);
  });

  it('exits 2 cleanly on missing, directory, empty, HTML, PDF, unknown flag, and corrupt image inputs', async () => {
    const tmp = await makeTempDir('kinloom-ocr-invalid-');
    const cacheDir = path.join(tmp, 'cache');
    const emptyPath = path.join(tmp, 'empty.jpg');
    const htmlPath = path.join(tmp, 'blocked.jpg');
    const pdfPath = path.join(tmp, 'document.pdf');
    const subDir = path.join(tmp, 'subdir');
    const corruptPath = path.join(tmp, 'corrupt.png');

    fs.mkdirSync(subDir, { recursive: true });
    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(htmlPath, '<!DOCTYPE html><html><body>Access Denied</body></html>');
    await writeFile(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    await writeFile(corruptPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));

    const mockCorruptExec: ExecFileFn = async () => {
      const err = new Error('tesseract failed') as Error & {
        code: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      err.code = 1;
      err.stdout = Buffer.alloc(0);
      err.stderr = Buffer.from('Error in pixReadStream: Unknown format: no pix returned\n');
      throw err;
    };

    const cases: Array<{ args: string[]; expectText: string }> = [
      { args: [path.join(tmp, 'missing.jpg')], expectText: 'image file not found' },
      { args: [subDir], expectText: 'not a regular file' },
      { args: [emptyPath], expectText: 'empty (0 bytes)' },
      { args: [htmlPath], expectText: 'HTML, not an image' },
      { args: [pdfPath], expectText: 'PDF, not an image' },
      { args: ['-z', emptyPath], expectText: 'Unknown option' },
      { args: [corruptPath], expectText: 'invalid or unreadable image' },
    ];

    for (const tc of cases) {
      const res = await invokeOcr([...tc.args, '--cache-dir', cacheDir], {
        execFileImpl: mockCorruptExec,
      });
      expect(res.exitCode, `args=${tc.args.join(' ')} stderr=${res.stderr}`).toBe(2);
      expect(res.stderr).toContain(tc.expectText);
    }
  });

  it('supports --mode cursive via both Gemini API (--provider gemini) and vision CLI', async () => {
    const tmp = await makeTempDir('kinloom-ocr-cursive-');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'handwritten.png');
    await writeFile(imgPath, await createSyntheticPng(64, 64));

    let fetchCalls = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      fetchCalls += 1;
      const url = String(input);
      expect(url).toContain('generativelanguage.googleapis.com');
      const headers = new Headers(init?.headers);
      expect(headers.get('x-goog-api-key')).toBe('test-gemini-key');
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: 'Alden Mercer, age 42, Farmer, born Ohio' }],
              },
            },
          ],
          usageMetadata: { totalTokenCount: 150 },
        }),
        { status: 200 }
      );
    };

    const gemRes = await invokeOcr(
      [imgPath, '--cursive', '--provider', 'gemini', '--cache-dir', cacheDir, '--json'],
      {
        env: { ...process.env, GEMINI_API_KEY: 'test-gemini-key' },
        fetchImpl: mockFetch,
      }
    );
    expect(gemRes.exitCode, gemRes.stderr).toBe(0);
    expect(fetchCalls).toBe(1);
    const gemJson = JSON.parse(gemRes.stdout) as {
      text: string;
      engine: string;
      cache_hit: boolean;
    };
    expect(gemJson.text).toBe('Alden Mercer, age 42, Farmer, born Ohio');
    expect(gemJson.engine).toContain('gemini:');
    expect(gemJson.cache_hit).toBe(false);

    // Vision CLI mode with --force recomputes via configured CLI.
    const cliCalls: Array<{ file: string; args: readonly string[] }> = [];
    const mockCliExec: ExecFileFn = async (file, args) => {
      cliCalls.push({ file, args });
      return {
        stdout: Buffer.from(
          JSON.stringify({
            status: 'SUCCESS',
            response: 'Clarissa Vance, age 38, seamstress',
            duration_seconds: 1.4,
            usage: { thinking_tokens: 10, output_tokens: 20 },
          })
        ),
        stderr: Buffer.alloc(0),
      };
    };

    const cliRes = await invokeOcr(
      [imgPath, '--mode', 'cursive', '--provider', 'cli', '--force', '--cache-dir', cacheDir, '--json'],
      {
        env: { ...process.env, KINLOOM_OCR_CLI: 'mock-vision-cli' },
        execFileImpl: mockCliExec,
      }
    );
    expect(cliRes.exitCode, cliRes.stderr).toBe(0);
    expect(cliCalls).toHaveLength(1);
    expect(cliCalls[0].file).toBe('mock-vision-cli');
    expect(cliCalls[0].args).toContain('--print-timeout');
    const cliJson = JSON.parse(cliRes.stdout) as { text: string; engine: string };
    expect(cliJson.text).toBe('Clarissa Vance, age 38, seamstress');
    expect(cliJson.engine).toContain('mock-vision-cli:');
  });

  it('runs kinloom ocr batch with bounded concurrency, per-page timeout isolation, --grep filtering, and cache_hit', async () => {
    const tmp = await makeTempDir('kinloom-ocr-batch-');
    const scanDir = path.join(tmp, 'scans');
    const cacheDir = path.join(tmp, 'cache');
    fs.mkdirSync(scanDir, { recursive: true });

    const pageNames = ['page-01.png', 'page-02.png', 'page-03.png', 'page-04.png'];
    for (let i = 0; i < pageNames.length; i += 1) {
      await writeFile(
        path.join(scanDir, pageNames[i]),
        await createSyntheticPng(32, 32, { r: 180 + i * 15, g: 200, b: 220 })
      );
    }
    // Non-image file in directory should be ignored by directory expansion.
    await writeFile(path.join(scanDir, 'notes.txt'), 'not an image');

    // Invalid --grep regex exits 2 immediately.
    const badRegex = await invokeOcr(['batch', scanDir, '--grep', '[unclosed']);
    expect(badRegex.exitCode).toBe(2);
    expect(badRegex.stderr).toContain('Invalid --grep regex');

    let inFlight = 0;
    let maxInFlight = 0;
    const mockBatchExec: ExecFileFn = async (_bin, args, options) => {
      expect(options?.env?.['OMP_THREAD_LIMIT']).toBe('1');
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const base = path.basename(args[0]);
      try {
        if (base === 'page-02.png') {
          // Simulate hung page that exceeds 0.05s timeout.
          await new Promise((resolve) => setTimeout(resolve, 400).unref());
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const text =
          base === 'page-01.png'
            ? 'Header 1860\nAlden Mercer farmer'
            : base === 'page-03.png'
              ? 'Springfield docket\nThaddeus Brooks clerk'
              : 'Header 1860\nMercer estate inventory';
        return { stdout: Buffer.from(text), stderr: Buffer.alloc(0) };
      } finally {
        inFlight -= 1;
      }
    };

    const batchRes = await invokeOcr(
      [
        'batch',
        scanDir,
        '--grep',
        'mercer',
        '-i',
        '--concurrency',
        '2',
        '--timeout',
        '0.05',
        '--cache-dir',
        cacheDir,
        '--json',
      ],
      { execFileImpl: mockBatchExec }
    );

    // Partial failure (1 timed-out page) returns exitCode 1, never hangs, and emits full structured JSON.
    expect(batchRes.exitCode).toBe(1);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    const body = JSON.parse(batchRes.stdout) as {
      mode: string;
      total: number;
      succeeded: number;
      timed_out: number;
      failed: number;
      cache_hits: number;
      cache_hit: boolean;
      grep: string;
      matched_count: number;
      matches: Array<{ file: string; line_number: number; text: string }>;
      files: Array<{
        file: string;
        status: string;
        error_code?: string;
        timeout_seconds?: number;
        cached: boolean;
      }>;
    };
    expect(body.mode).toBe('printed');
    expect(body.total).toBe(4);
    expect(body.succeeded).toBe(3);
    expect(body.timed_out).toBe(1);
    expect(body.failed).toBe(0);
    expect(body.cache_hits).toBe(0);
    expect(body.cache_hit).toBe(false);
    expect(body.grep).toBe('mercer');
    expect(body.matched_count).toBe(2);
    expect(body.matches.map((m) => [path.basename(m.file), m.line_number, m.text])).toEqual([
      ['page-01.png', 2, 'Alden Mercer farmer'],
      ['page-04.png', 2, 'Mercer estate inventory'],
    ]);
    const timedOutEntry = body.files.find((f) => path.basename(f.file) === 'page-02.png');
    expect(timedOutEntry).toMatchObject({
      status: 'timeout',
      error_code: 'OCR_TIMEOUT',
      timeout_seconds: 0.05,
    });

    // Warm batch over only the 3 already-cached pages (via glob!) hits cache 100% and exits 0.
    const fastExec: ExecFileFn = async () => {
      throw new Error('Should not re-run OCR for cached pages');
    };
    const warmGlob = await invokeOcr(
      [
        'batch',
        path.join(scanDir, 'page-0[134].png'),
        '--grep',
        'Mercer',
        '--concurrency',
        '2',
        '--cache-dir',
        cacheDir,
        '--json',
      ],
      { cwd: tmp, execFileImpl: fastExec }
    );
    expect(warmGlob.exitCode, warmGlob.stderr).toBe(0);
    expect(warmGlob.cacheHit).toBe(true);
    const warmBody = JSON.parse(warmGlob.stdout) as {
      total: number;
      succeeded: number;
      cache_hits: number;
      cache_hit: boolean;
      matched_count: number;
    };
    expect(warmBody).toMatchObject({
      total: 3,
      succeeded: 3,
      cache_hits: 3,
      cache_hit: true,
      matched_count: 2,
    });
  });
});
