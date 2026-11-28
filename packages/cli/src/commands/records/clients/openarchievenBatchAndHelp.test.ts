import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../cli.js';
import { createRecordContext } from '../runtime/index.js';
import { runOpenarchievenCommand } from './openarchieven.js';

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-oa-batch-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('openarchieven search --help and multi-query batch lookups', () => {
  it('exits 0 with clear usage for openarchieven search --help and help subcommands via runCli and direct handler', async () => {
    const cap1Out: string[] = [];
    const cap1Err: string[] = [];
    const cliCode = await runCli(['openarchieven', 'search', '--help'], {
      io: { stdout: (l) => cap1Out.push(l), stderr: (l) => cap1Err.push(l) },
    });
    expect(cliCode).toBe(0);
    expect(cap1Err).toEqual([]);
    expect(cap1Out.join('\n')).toContain('Usage: kinloom openarchieven search [NAME...] [options]');

    // Also works through `kinloom records openarchieven search --help`
    const cap2Out: string[] = [];
    const cap2Err: string[] = [];
    const viaRecordsCode = await runCli(['records', 'openarchieven', 'search', '--help'], {
      io: { stdout: (l) => cap2Out.push(l), stderr: (l) => cap2Err.push(l) },
    });
    expect(viaRecordsCode).toBe(0);
    expect(cap2Err).toEqual([]);
    expect(cap2Out.join('\n')).toContain('Usage: kinloom openarchieven search [NAME...] [options]');

    // Also works when --help appears after another flag or via `openarchieven help <subcmd>`
    const cacheDir = await makeTempDir();
    for (const args of [
      ['search', '--place', 'Zundert', '--help'],
      ['show', '--help'],
      ['download', '--help'],
      ['url', '--help'],
      ['help'],
      ['help', 'search'],
      ['help', 'get'],
      ['help', 'download'],
      ['help', 'url'],
    ]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const ctx = createRecordContext({
        io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) },
        env: { KINLOOM_OPENARCHIEVEN_CACHE_DIR: cacheDir },
        sleepFn: async () => {},
      });
      const res = await runOpenarchievenCommand(args, ctx);
      expect(res.exitCode, args.join(' ')).toBe(0);
      expect(stderr, args.join(' ')).toEqual([]);
      expect(stdout.join('\n')).toContain('Usage: kinloom openarchieven');
    }

    const badHelpOut: string[] = [];
    const badHelpErr: string[] = [];
    const badHelpRes = await runOpenarchievenCommand(
      ['help', 'nonexistent'],
      createRecordContext({
        io: { stdout: (l) => badHelpOut.push(l), stderr: (l) => badHelpErr.push(l) },
        env: { KINLOOM_OPENARCHIEVEN_CACHE_DIR: cacheDir },
        sleepFn: async () => {},
      })
    );
    expect(badHelpRes.exitCode).toBe(2);
    expect(badHelpErr.join('\n')).toContain("No such command 'nonexistent'");
  });

  it('executes multi-query batch lookups with deterministic --json output, text formatting, and per-query caching', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = new URL(String(input));
      const name = url.searchParams.get('name') ?? '';
      return new Response(
        JSON.stringify({
          response: {
            number_found: 1,
            docs: [
              {
                archive_code: 'bhi',
                identifier: `id-${name.replace(/\s+/g, '-').toLowerCase()}`,
                personname: name,
                relationtype: 'Kind',
                sourcetype: 'BS Geboorte',
                eventdate: { year: 1853, month: 3, day: 30 },
                eventplace: ['Zundert'],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    };

    const run = async (args: readonly string[]) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const ctx = createRecordContext({
        io: { stdout: (l) => stdout.push(l), stderr: (l) => stderr.push(l) },
        env: { KINLOOM_OPENARCHIEVEN_CACHE_DIR: cacheDir },
        fetchImpl,
        sleepFn: async () => {},
      });
      const res = await runOpenarchievenCommand(args, ctx);
      return {
        exitCode: res.exitCode,
        stdout: stdout.join('\n'),
        stderr: stderr.join('\n'),
        cacheHit: res.cacheHit,
      };
    };

    const r1 = await run(['search', '-q', 'Jan Jansen', '-q', 'Pieter Bakker', '--year', '1853', '--json']);
    expect(r1.exitCode, r1.stderr).toBe(0);
    expect(calls).toBe(2);
    const p1 = JSON.parse(r1.stdout) as {
      batch: boolean;
      query_count: number;
      total_found: number;
      cache_hit: boolean;
      queries: Array<{ query: string; name_param: string; number_found: number; cache_hit: boolean }>;
    };
    expect(p1.batch).toBe(true);
    expect(p1.query_count).toBe(2);
    expect(p1.total_found).toBe(2);
    expect(p1.cache_hit).toBe(false);
    expect(p1.queries.map((q) => q.name_param)).toEqual(['Jan Jansen 1853', 'Pieter Bakker 1853']);

    // Second run using multiple positionals hits cache for both queries (zero HTTP calls).
    const r2 = await run(['search', 'Jan Jansen', 'Pieter Bakker', '--year', '1853']);
    expect(r2.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect(r2.cacheHit).toBe(true);
    expect(r2.stdout).toContain('=== Query: Jan Jansen 1853 ===');
    expect(r2.stdout).toContain('=== Query: Pieter Bakker 1853 ===');
    expect(r2.stdout).toContain('[cache]');
  });
});
