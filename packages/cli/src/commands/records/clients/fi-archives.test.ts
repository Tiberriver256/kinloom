import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import {
  DIGIHAKEMISTO_SEARCH_URL,
  encodeIso88591Form,
  HISKI_ENDPOINT,
  runFiArchivesCommand,
} from './fi-archives.js';

const HISKI_PARISHES_BYTES = Buffer.from(
  `
<HTML><BODY><FORM><SELECT NAME=srk>
<OPTION VALUE="0001">Ahlainen
<OPTION VALUE="0012">Anjala
<OPTION VALUE="0565">Turku - Åbo
<OPTION VALUE="24">24 - Penal institutions
</SELECT></FORM></BODY></HTML>
`,
  'latin1'
);

const HISKI_SEARCH_BYTES = Buffer.from(
  `
<HTML><BODY>
<FONT SIZE="+2"><B>Anjala - christened</B></FONT><BR>
<TABLE BORDER=1 CELLSPACING=0>
<TR><TH>Born <TH>Christened <TH>Village <TH>Farm <TH>Father <TH>Mother <TH>Child<BR>
<TR><TD><a href="/hiski?en+0012+kastetut+446"><img src="/historia/sl2.gif"></a>18.1.1800 <TD>19.1.1800 <TD>Korhonen <TD>&nbsp; <TD> Anders  Korhonen <TD> Maria Isaksdr &nbsp; <TD>Anna<BR>
<TR><TD><TD COLSPAN=6>original - ALKUPKOMM: twin
</TABLE>
<P>A total of 1 events found.<P>
</BODY></HTML>
`,
  'latin1'
);

const HISKI_EVENT_BYTES = Buffer.from(
  `
<HTML><BODY>
<H2>Ahlainen</H2>
<H3>Christened</H3>
<P><A HREF="/hiski?en+t149288">Link to this event</A> [ 149288 ]</P>
<TABLE BORDER=4 BGCOLOR="#F5F5F5">
<TR><TD><SMALL>Born / Christened</SMALL> <TD COLSPAN=2>1.1.1750 <TD COLSPAN=3>1.1.1750</TD></TR>
<TR><TD><SMALL>Village / Farm</SMALL> <TD COLSPAN=2>Bocköö <TD COLSPAN=3>&nbsp;</TD></TR>
<TR><TD><SMALL>Father</SMALL> <TD>Tp: <TD>Anders <TD>Johanss: <TD>&nbsp; <TD>&nbsp;</TD></TR>
<TR><TD><SMALL>Mother</SMALL> <TD>&nbsp; <TD>Maria <TD>Eskilsd:r <TD>&nbsp; <TD>&nbsp;</TD></TR>
<TR><TD><SMALL>Child</SMALL> <TD COLSPAN=5>Johan
<TR><TD><SMALL>Links</SMALL> <TD COLSPAN=5><A HREF="http://www.sukuhistoria.fi/sshy/sivut/HisKi-digiarkisto.php?plid=0001&year=1750">SSHY - Digiarkisto</A>
</TABLE>
</BODY></HTML>
`,
  'latin1'
);

const DIGIHAKEMISTO_SEARCH_HTML = `
<html><body><table border>
<tr><th>Arkisto</th><th>Kommentti</th></tr>
<tr class="searchrow arkisto">
  <td class="searchtarget arkisto">
    <a class="aineisto" href="/aineisto/1299923671">
      <span class="searchtarget ">Turun suomalaisen seurakunnan arkisto</span>
    </a>
  <td>
    <span class="searchtarget searchtarget2">1680-1910 // Åbo finska församling</span>
<tr class="searchrow arkisto">
  <td class="searchtarget arkisto">
    <a class="aineisto" href="/aineisto/1299898549">
      <span class="searchtarget nodigi">Turun katolisen seurakunnan arkisto</span>
    </a>
  <td>
    <span class="searchtarget searchtarget2">1930-1934 // ei digitoitu</span>
</table></body></html>
`;

const DIGIHAKEMISTO_ARCHIVE_HTML = `
<html><head><title>Turun suomalaisen seurakunnan arkisto</title></head><body>
<a id="alkup" href="https://astia.narc.fi/uusiastia/kortti_aineisto.html?id=1299923671">Astia</a>
<span class="tieto">Digitized parish church books.</span>
<table border>
<tr class="searchrow">
  <td><a class="aineisto" href="/aineisto/1299937880"><span class="searchtarget ">I VÄESTÖREKISTERIARKISTO</span></a>
  <td><span class="searchtarget searchtarget2">Rippikirjat 1700-1850</span>
<tr class="searchrow">
  <td><a class="aineisto" href="/aineisto/1299937881"><span class="searchtarget nodigi">II HALLINTOARKISTO</span></a>
  <td><span class="searchtarget searchtarget2">ei digitoitu</span>
</table></body></html>
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-fi-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeFi(
  args: readonly string[],
  cacheDir: string,
  fetchImpl?: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean | undefined }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_FI_ARCHIVES_CACHE_DIR: cacheDir },
    fetchImpl: fetchImpl ?? (async () => new Response('', { status: 500 })),
    sleepFn: async () => {},
  });
  const outcome = await runFiArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('fi-archives native client', () => {
  it('caches parishes and HisKi search with boolean cache_hit and ISO-8859-1 decoding', async () => {
    const cacheDir = await makeTempDir();
    const calls: (readonly [string, string])[] = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      calls.push([method, url]);
      if (method === 'GET' && url.includes('en+A00')) {
        return new Response(new Uint8Array(HISKI_PARISHES_BYTES), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (method === 'POST' && url === HISKI_ENDPOINT) {
        return new Response(new Uint8Array(HISKI_SEARCH_BYTES), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const r1 = await invokeFi(['parishes', '--query', 'Turku', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeFi(['parishes', '--query', 'Anjala', '--json'], cacheDir, fetchImpl);
    const s1 = await invokeFi(
      [
        'hiski',
        '--parish',
        'Anjala',
        '--book',
        'births',
        '--surname',
        'Korhonen',
        '--from-year',
        '1800',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );
    const s2 = await invokeFi(
      [
        'hiski',
        '--parish',
        '0012',
        '--book',
        'christened',
        '--surname',
        'Korhonen',
        '--from-year',
        '1800',
        '--json',
      ],
      cacheDir,
      fetchImpl
    );

    expect([r1.exitCode, r2.exitCode, s1.exitCode, s2.exitCode]).toEqual([0, 0, 0, 0]);
    // 1 GET for parishes (reused for query=Anjala AND parish resolution) + 1 POST for hiski search
    expect(calls).toHaveLength(2);

    const p1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      total: number;
      parishes: { code: string; name: string }[];
    };
    const p2 = JSON.parse(r2.stdout) as { cache_hit: boolean };
    expect(p1.cache_hit).toBe(false);
    expect(p2.cache_hit).toBe(true);
    expect(p1.total).toBe(3);
    expect(p1.parishes[0]!.code).toBe('0565');
    expect(p1.parishes[0]!.name).toBe('Turku - Åbo');

    const h1 = JSON.parse(s1.stdout) as {
      cache_hit: boolean;
      returned: number;
      records: { child: string; father: string; comment: string }[];
    };
    const h2 = JSON.parse(s2.stdout) as { cache_hit: boolean };
    expect(h1.cache_hit).toBe(false);
    expect(h2.cache_hit).toBe(true);
    expect(h1.returned).toBe(1);
    expect(h1.records[0]!.child).toBe('Anna');
    expect(h1.records[0]!.father).toBe('Anders Korhonen');
    expect(h1.records[0]!.comment).toBe('original - ALKUPKOMM: twin');
  });

  it('parses HisKi event detail fields, ISO-8859-1 names, permalink, and SSHY link', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;

    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(new Uint8Array(HISKI_EVENT_BYTES), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    };

    const r1 = await invokeFi(['event', '0001/kastetut/418', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeFi(
      ['event', 'https://hiski.genealogia.fi/hiski?en+0001+kastetut+418', '--json'],
      cacheDir,
      fetchImpl
    );

    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(calls).toBe(1);
    const d1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      parish: string;
      permalink_id: string;
      fields: Record<string, string>;
      sshy_url: string;
    };
    const d2 = JSON.parse(r2.stdout) as { cache_hit: boolean };
    expect(d1.cache_hit).toBe(false);
    expect(d2.cache_hit).toBe(true);
    expect(d1.parish).toBe('Ahlainen');
    expect(d1.permalink_id).toBe('t149288');
    expect(d1.fields['Child']).toBe('Johan');
    expect(d1.fields['Village / Farm']).toBe('Bocköö');
    expect(d1.sshy_url).toContain('sukuhistoria.fi');
  });

  it('caches Digihakemisto archives search and archive inspect with --digitized filtering', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;

    const fetchImpl: typeof fetch = async (input) => {
      calls += 1;
      const url = String(input);
      if (url === DIGIHAKEMISTO_SEARCH_URL) {
        return new Response(DIGIHAKEMISTO_SEARCH_HTML, { status: 200 });
      }
      if (url.endsWith('/aineisto/1299923671')) {
        return new Response(DIGIHAKEMISTO_ARCHIVE_HTML, { status: 200 });
      }
      return new Response('missing', { status: 404 });
    };

    const r1 = await invokeFi(['archives', 'Turun seurakun*', '--json'], cacheDir, fetchImpl);
    const r2 = await invokeFi(['archives', 'Turun seurakun*', '--digitized', '--json'], cacheDir, fetchImpl);
    const r3 = await invokeFi(['archive', '1299923671', '--digitized', '--json'], cacheDir, fetchImpl);
    const r4 = await invokeFi(
      ['archive', 'https://digihakemisto.net/aineisto/1299923671', '--json'],
      cacheDir,
      fetchImpl
    );

    expect([r1.exitCode, r2.exitCode, r3.exitCode, r4.exitCode]).toEqual([0, 0, 0, 0]);
    expect(calls).toBe(2);

    const a1 = JSON.parse(r1.stdout) as { cache_hit: boolean; returned: number };
    const a2 = JSON.parse(r2.stdout) as {
      cache_hit: boolean;
      returned: number;
      archives: { id: string }[];
    };
    expect(a1.cache_hit).toBe(false);
    expect(a2.cache_hit).toBe(true);
    expect(a1.returned).toBe(2);
    expect(a2.returned).toBe(1);
    expect(a2.archives[0]!.id).toBe('1299923671');

    const i1 = JSON.parse(r3.stdout) as {
      cache_hit: boolean;
      returned_children: number;
      children: { id: string }[];
    };
    const i2 = JSON.parse(r4.stdout) as { cache_hit: boolean; returned_children: number };
    expect(i1.cache_hit).toBe(false);
    expect(i2.cache_hit).toBe(true);
    expect(i1.returned_children).toBe(1);
    expect(i2.returned_children).toBe(2);
    expect(i1.children[0]!.id).toBe('1299937880');
  });

  it('retries transient 429 and refuses anti-bot challenges without caching', async () => {
    const cacheDir = await makeTempDir();
    let calls = 0;
    let mode: 'retry' | 'challenge' = 'retry';

    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (mode === 'retry') {
        if (calls === 1) {
          return new Response('slow down', { status: 429, headers: { 'Retry-After': '0' } });
        }
        return new Response(new Uint8Array(HISKI_EVENT_BYTES), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('<html><body>Processing JavaScript challenge..</body></html>', {
        status: 200,
      });
    };

    const r1 = await invokeFi(['event', '0001/kastetut/418', '--json'], cacheDir, fetchImpl);
    mode = 'challenge';
    const r2 = await invokeFi(['event', '0001/kastetut/418', '--refresh', '--json'], cacheDir, fetchImpl);

    expect(r1.exitCode).toBe(0);
    expect(calls).toBe(3);
    expect((JSON.parse(r1.stdout) as { parish: string }).parish).toBe('Ahlainen');
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr.toLowerCase()).toContain('challenge');
  });

  it('enforces host allowlist, rejects path traversal, encodes ISO-8859-1 forms, and builds offline URLs', async () => {
    const cacheDir = await makeTempDir();

    const badEvent = await invokeFi(['event', '../etc/passwd'], cacheDir);
    expect(badEvent.exitCode).toBe(2);

    const badArch = await invokeFi(['archive', '../../secret'], cacheDir);
    expect(badArch.exitCode).toBe(2);

    const badHostEvent = await invokeFi(
      ['event', 'https://evil.example/hiski?en+0001+kastetut+418'],
      cacheDir
    );
    expect(badHostEvent.exitCode).toBe(2);
    expect(badHostEvent.stderr).toContain('Refusing host');

    const redirectFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'digihakemisto.net') {
        return new Response(null, { status: 302, headers: { Location: 'https://evil.example/x' } });
      }
      return new Response('evil', { status: 200 });
    };
    const blocked = await invokeFi(['archive', '1299923671'], cacheDir, redirectFetch);
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('Refusing host');

    // Verify ISO-8859-1 form encoding for Finnish/Swedish diacritics.
    expect(encodeIso88591Form({ isukunimi: 'Mäkinen', ikyla: 'Åbo' })).toBe(
      'isukunimi=M%E4kinen&ikyla=%C5bo'
    );

    const u = await invokeFi(
      ['url', '--finna', 'Turku kirkonkirjat', '--digi', 'Turku 1850', '--hiski', '--sshy'],
      cacheDir
    );
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain('https://www.finna.fi/Search/Results?');
    expect(u.stdout).toContain('https://digi.kansalliskirjasto.fi/search?');
    expect(u.stdout).toContain('https://hiski.genealogia.fi/hiski?en');
    expect(u.stdout).toContain('https://www.sukuhistoria.fi/sshy/index_eng.htm');

    const help = await invokeFi(['--help'], cacheDir);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('kinloom fi-archives');
  });
});
