import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CURL_META_MARKER, createRecordContext, type ExecFileFn } from '../runtime/index.js';
import { runTexasArchivesCommand } from './texas-archives.js';

const OPENSEARCH_PAYLOAD = {
  feed: {
    'opensearch:totalResults': '2',
    entry: [
      {
        id: 'ark:/67531/metapth100001',
        title: 'Austin Gazette (Travis County)',
        'dc:creator': 'Austin Publishing Co.',
        'dc:date': '1874-05-12',
        'dc:description': 'Weekly newspaper from Travis County mentioning Sam Houston.',
        'dc:type': 'text_newspaper',
        link: 'https://texashistory.unt.edu/ark:/67531/metapth100001/',
      },
      {
        id: 'ark:/67531/metapth100002',
        title: 'Travis County Deed Ledger',
        'dc:creator': 'Travis County Clerk',
        'dc:date': '1881',
        'dc:description': 'Land transfers in Travis County.',
        'dc:type': 'text_book',
        link: 'https://texashistory.unt.edu/ark:/67531/metapth100002/',
      },
    ],
  },
};

const OAI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"
         xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <GetRecord>
    <record>
      <header>
        <identifier>ark:/67531/metapth100001</identifier>
        <setSpec>partner:TSLAC</setSpec>
      </header>
      <metadata>
        <oai_dc:dc>
          <dc:title>Austin Gazette (Travis County)</dc:title>
          <dc:creator>Austin Publishing Co.</dc:creator>
          <dc:date>1874-05-12</dc:date>
          <dc:type>text_newspaper</dc:type>
          <dc:subject>Travis County (Tex.)</dc:subject>
        </oai_dc:dc>
      </metadata>
    </record>
  </GetRecord>
</OAI-PMH>`;

const OAI_ERROR_XML = `<?xml version="1.0" encoding="UTF-8"?>
<OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/">
  <error code="idDoesNotExist">No matching identifier</error>
</OAI-PMH>`;

const TDA_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Houston Correspondence, 1841</title>
    <link>https://tsl.access.preservica.com/uncategorized/IO_1001/</link>
  </item>
  <item>
    <title>Travis County Tax Roll, 1850</title>
    <link>https://tsl.access.preservica.com/uncategorized/IO_1002/</link>
  </item>
</channel></rss>`;

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-texas-archives-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeTexas(
  args: readonly string[],
  cacheDir: string,
  options: {
    readonly fetchImpl?: typeof fetch;
    readonly execFileImpl?: ExecFileFn;
  } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_TEXAS_ARCHIVES_CACHE_DIR: cacheDir },
    fetchImpl:
      options.fetchImpl ??
      (async () => {
        throw new Error('unexpected fetch');
      }),
    execFileImpl: options.execFileImpl,
    sleepFn: async () => {},
  });
  const outcome = await runTexasArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('texas-archives native client', () => {
  it('caches portal search pages and reuses them for local filters', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(OPENSEARCH_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const r1 = await invokeTexas(
      ['portal', 'search', 'Houston', '--county', 'Travis', '--pages', '1', '--json'],
      cacheDir,
      { fetchImpl }
    );
    const r2 = await invokeTexas(
      [
        'portal',
        'search',
        'Houston',
        '--county',
        'Travis',
        '--type',
        'text_newspaper',
        '--date-from',
        '1870-01-01',
        '--date-to',
        '1880-12-31',
        '--pages',
        '1',
        '--json',
      ],
      cacheDir,
      { fetchImpl }
    );
    const r3 = await invokeTexas(
      ['portal', 'search', 'Houston', '--county', 'Travis', '--pages', '1'],
      cacheDir,
      { fetchImpl }
    );

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(calls).toBe(1);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    const d2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { ark: string }[];
    };
    expect(d2.cache_hit).toBe(true);
    expect(d2.returned).toBe(1);
    expect(d2.records[0].ark).toBe('ark:/67531/metapth100001');
    expect(r3.stdout).toContain('[cache]');
  });

  it('caches portal item and bypasses cache on --refresh and ttl 0', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(OAI_XML, { status: 200 });
    };

    const r1 = await invokeTexas(['portal', 'item', 'metapth100001', '--json'], cacheDir, {
      fetchImpl,
    });
    const r2 = await invokeTexas(['portal', 'item', 'ark:/67531/metapth100001'], cacheDir, {
      fetchImpl,
    });
    const rRef = await invokeTexas(['portal', 'item', 'metapth100001', '--refresh', '--json'], cacheDir, {
      fetchImpl,
    });
    const rTtl = await invokeTexas(
      ['portal', 'item', 'metapth100001', '--cache-ttl-hours', '0', '--json'],
      cacheDir,
      { fetchImpl }
    );

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(rRef.exitCode).toBe(0);
    expect(rTtl.exitCode).toBe(0);
    expect(calls).toBe(3);

    const parsedR1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      titles: string[];
      set_specs: string[];
    };
    expect(parsedR1.cache_hit).toBe(false);
    expect(parsedR1.titles).toEqual(['Austin Gazette (Travis County)']);
    expect(parsedR1.set_specs).toEqual(['partner:TSLAC']);
    expect(r2.stdout).toContain('[cache]');
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect((JSON.parse(rTtl.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('caches TDA RSS via fetchWithCurl and slices limit locally', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const execFileImpl: ExecFileFn = async (_file, args) => {
      calls += 1;
      const target = args.at(-1) ?? '';
      return {
        stdout: Buffer.from(`${TDA_RSS}\n${CURL_META_MARKER}\n200\n${target}`, 'utf8'),
        stderr: Buffer.alloc(0),
      };
    };

    const r1 = await invokeTexas(['tda', 'Houston', '--limit', '1', '--json'], cacheDir, {
      execFileImpl,
    });
    const r2 = await invokeTexas(['tda', 'Houston', '--limit', '5', '--json'], cacheDir, {
      execFileImpl,
    });
    const r3 = await invokeTexas(['tda', 'Houston'], cacheDir, { execFileImpl });
    const rRef = await invokeTexas(['tda', 'Houston', '--refresh', '--json'], cacheDir, {
      execFileImpl,
    });

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(0);
    expect(r3.exitCode).toBe(0);
    expect(rRef.exitCode).toBe(0);
    expect(calls).toBe(2);
    expect((JSON.parse(r1.stdout) as { returned: number }).returned).toBe(1);
    const d2 = JSON.parse(r2.stdout) as { cache_hit: boolean; returned: number };
    expect(d2.cache_hit).toBe(true);
    expect(d2.returned).toBe(2);
    expect(r3.stdout).toContain('[cache]');
    expect((JSON.parse(rRef.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
  });

  it('never caches HTTP errors, OAI errors, or empty payloads', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response('server error', { status: 500 });
      }
      if (calls === 2) {
        return new Response(OAI_ERROR_XML, { status: 200 });
      }
      if (calls === 3) {
        return new Response(JSON.stringify({ feed: { 'opensearch:totalResults': '0', entry: [] } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(OPENSEARCH_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const r1 = await invokeTexas(['portal', 'search', 'Smith', '--pages', '1'], cacheDir, {
      fetchImpl,
    });
    const r2 = await invokeTexas(['portal', 'item', 'metapth999999'], cacheDir, { fetchImpl });
    const r3 = await invokeTexas(['portal', 'search', 'Smith', '--pages', '1', '--json'], cacheDir, {
      fetchImpl,
    });
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toEqual([]);
    const r4 = await invokeTexas(['portal', 'search', 'Smith', '--pages', '1', '--json'], cacheDir, {
      fetchImpl,
    });

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).not.toContain('Traceback');
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain('idDoesNotExist');
    expect(r3.exitCode).toBe(0);
    expect((JSON.parse(r3.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(r4.exitCode).toBe(0);
    expect(calls).toBe(4);
    expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('builds portal URLs and rejects invalid date options', async () => {
    const cacheDir = await makeTempDir();
    const res = await invokeTexas(['url', 'Austin'], cacheDir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('https://texashistory.unt.edu/search/?q=Austin&t=fulltext');
    expect(res.stdout).toContain('https://tsl.access.preservica.com/?s=Austin');
    expect(res.stdout).toContain('https://s3.glo.texas.gov/lookup/index.php');

    const badDate = await invokeTexas(['portal', 'search', 'Houston', '--date-from', '2026-02-30'], cacheDir);
    expect(badDate.exitCode).toBe(2);
  });
});
