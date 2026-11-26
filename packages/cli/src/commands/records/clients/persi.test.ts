import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { runPersiCommand } from './persi.js';

const SURNAME_HTML = `
<html><body>
<table>
  <tr><th>Article Title</th><th>Periodical</th><th>Year</th><th>Publisher</th></tr>
  <tr>
    <td>Lincoln family in Sangamon County</td>
    <td>Illinois State Genealogical Quarterly</td>
    <td>1985</td>
    <td><a href="https://example.org/issue-1985">ISGS</a></td>
  </tr>
  <tr>
    <td>Lincoln letters, 1858</td>
    <td>Sangamon Circuit Notes</td>
    <td>1992</td>
    <td>Sangamon Historical Society</td>
  </tr>
</table>
</body></html>
`;

const LOCATION_HTML = `
<html><body>
<table>
  <tr><th>Category</th><th>Articles</th></tr>
  <tr><td>Cemeteries</td><td>1,240</td></tr>
  <tr><td>Court Records</td><td>315</td></tr>
</table>
</body></html>
`;

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-persi-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokePersi(
  args: readonly string[],
  cacheDir: string,
  fetchImpl: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_PERSI_CACHE_DIR: cacheDir },
    fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runPersiCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('persi native client', () => {
  it('caches surname and search alias with zero repeat HTTP calls', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(SURNAME_HTML, { status: 200 });
    };

    const r1 = await invokePersi(['surname', 'Lincoln', '--limit', '1', '--json'], cacheDir, fetchImpl);
    const r2 = await invokePersi(['surname', 'lincoln', '--limit', '2', '--json'], cacheDir, fetchImpl);
    const r3 = await invokePersi(['search', 'Lincoln'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect(JSON.parse(r1.stdout) as unknown[]).toHaveLength(1);
    expect(JSON.parse(r2.stdout) as unknown[]).toHaveLength(2);
    expect(r3.stdout).toContain('[cache]');
    expect(r3.stdout).toContain('Lincoln family in Sangamon County');
  });

  it('caches title and location lookups and bypasses cache on --refresh and ttl 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      if (String(input).includes('location')) {
        return new Response(LOCATION_HTML, { status: 200 });
      }
      return new Response(SURNAME_HTML, { status: 200 });
    };

    const rt1 = await invokePersi(['title', 'Lincoln', '--json'], cacheDir, fetchImpl);
    const rt2 = await invokePersi(['title', 'Lincoln'], cacheDir, fetchImpl);
    const rtRef = await invokePersi(['title', 'Lincoln', '--refresh'], cacheDir, fetchImpl);
    const rtTtl = await invokePersi(
      ['search', '--title', 'Lincoln', '--cache-ttl-hours', '0'],
      cacheDir,
      fetchImpl
    );
    const rl1 = await invokePersi(
      ['location', '--state', 'IL', '--county', 'Sangamon', '--json'],
      cacheDir,
      fetchImpl
    );
    const rl2 = await invokePersi(
      ['location', '--state', 'IL', '--county', 'Sangamon'],
      cacheDir,
      fetchImpl
    );

    expect(rt1.exitCode).toBe(0);
    expect(rt2.exitCode).toBe(0);
    expect(rtRef.exitCode).toBe(0);
    expect(rtTtl.exitCode).toBe(0);
    expect(rl1.exitCode).toBe(0);
    expect(rl2.exitCode).toBe(0);
    expect(calls).toBe(4);
    expect(rt2.stdout).toContain('[cache]');
    expect(rtRef.stdout).not.toContain('[cache]');
    expect(rtTtl.stdout).not.toContain('[cache]');
    expect(rl2.stdout).toContain('[cache]');
    expect((JSON.parse(rl1.stdout) as unknown[])[0]).toEqual({
      category: 'Cemeteries',
      articles: 1240,
    });
  });

  it('never caches HTTP errors or empty HTML pages', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls <= 2) {
        return new Response('server error', { status: 500 });
      }
      if (calls === 3) {
        return new Response('<html><body>Maintenance</body></html>', { status: 200 });
      }
      return new Response(SURNAME_HTML, { status: 200 });
    };

    const rErr = await invokePersi(['surname', 'Alder'], cacheDir, fetchImpl);
    const rEmpty = await invokePersi(['surname', 'Alder'], cacheDir, fetchImpl);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const rOk = await invokePersi(['surname', 'Alder', '--json'], cacheDir, fetchImpl);

    expect(rErr.exitCode).toBe(1);
    expect(rEmpty.exitCode).toBe(0);
    expect(rEmpty.stdout).toContain('No results.');
    expect(rOk.exitCode).toBe(0);
    expect(JSON.parse(rOk.stdout) as unknown[]).toHaveLength(2);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });
});
