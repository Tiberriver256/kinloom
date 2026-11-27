import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  atomicCopyFileSync,
  atomicWriteCompactJson,
  hasControlChar,
  hasMagicPrefix,
  isBrokenPipeError,
  isPlainRecord,
  JPEG_MAGIC,
  looksLikeHtmlBuffer,
  readJsonRecordIfValid,
  resolveEnvCacheTtlHours,
  resolveSafeChildPath,
  runWithConcurrency,
  sha256FileSync,
} from './primitives.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-primitives-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('records runtime primitives', () => {
  it('classifies plain records, control chars, broken pipe errors, and binary headers', () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([1])).toBe(false);
    expect(hasControlChar('ok-text')).toBe(false);
    expect(hasControlChar('bad\nline')).toBe(true);
    expect(isBrokenPipeError({ code: 'EPIPE' })).toBe(true);
    expect(isBrokenPipeError(new Error('write broken pipe'))).toBe(true);
    expect(isBrokenPipeError(new Error('other'))).toBe(false);
    expect(hasMagicPrefix(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), JPEG_MAGIC)).toBe(true);
    expect(hasMagicPrefix(Buffer.from([0x89, 0x50]), JPEG_MAGIC)).toBe(false);
    expect(looksLikeHtmlBuffer(Buffer.from('\uFEFF  <!DOCTYPE html><html></html>', 'utf8'))).toBe(true);
    expect(looksLikeHtmlBuffer(Buffer.from('{"ok":true}', 'utf8'))).toBe(false);
  });

  it('writes compact JSON, copies files atomically, hashes files, and validates child paths', () => {
    const dir = makeTempDir();
    const jsonPath = path.join(dir, 'entry.json');
    atomicWriteCompactJson(jsonPath, { ok: true, count: 2 });
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe('{"ok":true,"count":2}');
    expect(readJsonRecordIfValid(jsonPath)).toEqual({ ok: true, count: 2 });

    const copyPath = path.join(dir, 'nested', 'copy.json');
    atomicCopyFileSync(jsonPath, copyPath);
    expect(sha256FileSync(copyPath)).toBe(sha256FileSync(jsonPath));

    expect(resolveSafeChildPath(dir, 'image.jpg')).toBe(path.join(path.resolve(dir), 'image.jpg'));
    expect(() => resolveSafeChildPath(dir, '../escape.jpg')).toThrow(/Unsafe filename/);
    expect(() =>
      resolveSafeChildPath(dir, 'a..b.jpg', {
        rejectDoubleDotSubstring: true,
        errorFactory: (msg) => new RangeError(msg),
      })
    ).toThrow(RangeError);
  });

  it('resolves env cache TTL hours and runs bounded concurrency in input order', async () => {
    expect(resolveEnvCacheTtlHours(12, { TEST_TTL: '24' }, 'TEST_TTL', 48)).toBe(12);
    expect(resolveEnvCacheTtlHours(undefined, { TEST_TTL: '24' }, 'TEST_TTL', 48)).toBe(24);
    expect(resolveEnvCacheTtlHours(undefined, {}, 'TEST_TTL', 48)).toBe(48);

    let active = 0;
    let maxActive = 0;
    const output = await runWithConcurrency([10, 20, 30, 40, 50], 2, async (item, index) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return `${index}:${item * 2}`;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(output).toEqual(['0:20', '1:40', '2:60', '3:80', '4:100']);
  });
});
