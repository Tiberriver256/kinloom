import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { CliValidationError } from '../../../errors.js';
import { createRecordContext } from '../runtime/index.js';
import {
  CACHE_ENV,
  getCacheRoot,
  normalizeLvaImageUrl,
  parseDunmoreDrawer,
  parseRosettaDelivery,
  parseRosettaViewer,
  runVaArchivesCommand,
  TTL_ENV,
  TTL_ENV_ALIAS,
  validateFlId,
  validateIeId,
} from './va-archives.js';

const FAKE_TIFF = Buffer.concat([
  Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
  Buffer.from('synthetic-tiff-body', 'utf8'),
]);
const FAKE_PDF = Buffer.from('%PDF-1.4\nsynthetic\n%%EOF\n', 'utf8');
const FAKE_ZIP = Buffer.from('PK\x03\x04synthetic-zip', 'utf8');

const DRAWER_HTML = `<html><body>
<div class="pageTitle">
Dunmore's War - Page 12
</div>
<a href="/Microfilm/DW/001/00010.tif">Page 10</a><br />
<a href="/Microfilm/DW/001/00011.tif">Page 11</a><br />
<a href="/Microfilm/DW/001/00012.tif"><img src="/icons/land.office.gif" alt="Document" /></a>
<a href="/Microfilm/DW/001/00013.tif">Page 13</a><br />
<a href="/Microfilm/../../etc/passwd.tif">Page 99</a>
</body></html>`;

const DELIVERY_HTML = `<html><body>
<iframe src="https://rosetta.virginiamemory.com:443/view/action/ieViewer.do?search=hide&amp;is_mobile=false&amp;dps_dvs=111~222&amp;dps_pid=IE900001"></iframe>
<a href="DeliveryManagerServlet?dps_func=metadata">metadata</a>
</body></html>`;

const VIEWER_HTML = `<html><script>
initialSelect = "FL900002"
var toc = "<mets><item id='N1' rel='root' title='Table of Contents'><item id='FL900002' title='Original'></item><item id='FL900003' title='Transcription'></item></item></mets>";
var JSONObject = '{"0":"FL900002,FL900003"}';
</script></html>`;

const CHANCERY_SEARCH_HTML = `<html><body>
<p>Your search returned 1 record(s). You are now viewing records 1 through 1</p>
<table><tr>
  <td><span><strong>Index Number:</strong> 1842-001</span>
      <a href="case_detail.asp?CFN=003-1842-001">View</a></td>
  <td><strong>Locality:</strong> ALBEMARLE CO</td>
  <td valign="top">Doe, John<br />Doe, Jane</td>
  <td valign="top">Roe, Richard</td>
</tr></table>
</body></html>`;

const CHANCERY_CASE_HTML = `<html><body>
<table>
  <tr><td><strong>Locality</strong></td><td><strong>Index Number</strong></td><td><strong>Original Case Number</strong></td></tr>
  <tr><td>ALBEMARLE CO</td><td>1842-001</td><td>42</td></tr>
  <tr><td><strong>Plaintiff(s)</strong></td><td><strong>Defendant(s)</strong></td></tr>
  <tr><td>Doe, John</td><td>Roe, Richard</td></tr>
  <tr><td><strong>Surname(s)</strong></td></tr>
  <tr><td>Doe<br />Roe</td></tr>
  <tr><td><strong>Wills</strong></td><td><strong>Plat?</strong></td></tr>
  <tr><td>John Doe 1840</td><td>No</td></tr>
  <tr><td><strong>Format</strong></td></tr>
  <tr><td>Digital</td></tr>
</table>
</body></html>`;

const CHANCERY_IMAGES_HTML = `<html><script>
myImages[0] = "/ChanceryImg/Albemarle/Box001/003-1842-001_0001.pdf";
myImages[1] = "/ChanceryImg/Albemarle/Box001/003-1842-001_0002.pdf";
</script><body>Page 1 of 2 prev next <a href="/chancery/zip/download.php?cfn=003-1842-001">ZIP</a></body></html>`;

interface RecordedCall {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string;
}

class MockLva {
  readonly calls: RecordedCall[] = [];
  tiff: Buffer = FAKE_TIFF;
  localitiesVersion = 1;

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === 'string' ? init.body : '';
    this.calls.push({ url, method, headers, body });

    if (url.hostname === 'old.lva.virginia.gov') {
      if (url.pathname.endsWith('/available.asp')) {
        const html =
          `<TR><TD>SYNTHETIC CO</td><TD>Piedmont</td><TD>1800-1900</td>` +
          `<TD>Scanned v${this.localitiesVersion}</td><TD>none</td></TR>`;
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.pathname.endsWith('/default.asp')) {
        return new Response(CHANCERY_SEARCH_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname.endsWith('/case_detail.asp')) {
        return new Response(CHANCERY_CASE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname.endsWith('/case_images.asp')) {
        return new Response(CHANCERY_IMAGES_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname.endsWith('/zip/download.php')) {
        return new Response(new Uint8Array(FAKE_ZIP), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      if (url.pathname.endsWith('.pdf')) {
        return new Response(new Uint8Array(FAKE_PDF), {
          status: 200,
          headers: { 'content-type': 'application/pdf' },
        });
      }
    }

    if (url.hostname === 'lva.primo.exlibrisgroup.com') {
      return new Response(JSON.stringify({ info: { total: 0, first: 0, last: 0 }, docs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.hostname === 'image.lva.virginia.gov') {
      if (url.pathname === '/cgi-bin/GetDW.pl') {
        return new Response('', {
          status: 302,
          headers: { location: '/cgi-bin/drawer?retrieve_image=DW&page=12' },
        });
      }
      if (url.pathname === '/cgi-bin/drawer') {
        return new Response(DRAWER_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      if (url.pathname === '/redirect-out.tif') {
        return new Response('', {
          status: 302,
          headers: { location: 'https://evil.example/x.tif' },
        });
      }
      if (url.pathname.endsWith('.tif')) {
        return new Response(new Uint8Array(this.tiff), {
          status: 200,
          headers: { 'content-type': 'image/tiff' },
        });
      }
    }

    if (url.hostname === 'rosetta.virginiamemory.com') {
      if (url.pathname === '/delivery/DeliveryManagerServlet') {
        const pid = url.searchParams.get('dps_pid') ?? '';
        if (pid.startsWith('IE')) {
          return new Response(DELIVERY_HTML, {
            status: 200,
            headers: {
              'content-type': 'text/html',
              'set-cookie': 'JSESSIONID=synthetic; Path=/',
            },
          });
        }
        if (pid.startsWith('FL') && url.searchParams.get('dps_func') === 'stream') {
          const cookie = headers.get('cookie') ?? '';
          if (!cookie.includes('JSESSIONID=synthetic')) {
            return new Response('no session', { status: 403 });
          }
          const payload = Buffer.concat([FAKE_PDF, Buffer.from(pid, 'utf8')]);
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { 'content-type': 'application/pdf;charset=UTF-8' },
          });
        }
      }
      if (url.pathname === '/view/action/ieViewer.do') {
        if (url.searchParams.get('dps_dvs') !== '111~222' || url.searchParams.get('dps_pid') !== 'IE900001') {
          return new Response('bad viewer params', { status: 400 });
        }
        return new Response(VIEWER_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
    }

    return new Response(`unmocked ${url.toString()}`, { status: 404 });
  };
}

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-va-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeVa(
  args: readonly string[],
  options: {
    readonly cacheDir: string;
    readonly cwd: string;
    readonly mock: MockLva;
    readonly extraEnv?: NodeJS.ProcessEnv;
  }
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { [CACHE_ENV]: options.cacheDir, ...options.extraEnv },
    cwd: options.cwd,
    fetchImpl: options.mock.fetchImpl,
    sleepFn: async () => {},
  });
  const outcome = await runVaArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

function listFilesRecursive(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('va-archives cache root resolution', () => {
  it('prefers CACHE_ENV then XDG_CACHE_HOME then HOME/.cache', () => {
    expect(getCacheRoot({ [CACHE_ENV]: '/tmp/kinloom-va-x' })).toBe(path.resolve('/tmp/kinloom-va-x'));
    expect(getCacheRoot({ HOME: '/tmp/synth-home' })).toBe(
      path.join('/tmp/synth-home', '.cache', 'kinloom-va-archives')
    );
    expect(getCacheRoot({ HOME: '/tmp/synth-home', XDG_CACHE_HOME: '/tmp/xdg-synth' })).toBe(
      path.resolve('/tmp/xdg-synth', 'kinloom-va-archives')
    );
  });
});

describe('va-archives HTML caching & TTL', () => {
  it('serves localities from cache and refetches on per-command and global --refresh without leaking state', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const r1 = await invokeVa(['chancery', 'localities', '--json'], { cacheDir, cwd: root, mock });
    expect(r1.exitCode).toBe(0);
    expect(Array.isArray(JSON.parse(r1.stdout))).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect((JSON.parse(r1.stdout) as { viewing_status: string }[])[0].viewing_status).toBe('Scanned v1');

    mock.localitiesVersion = 2;
    const r2 = await invokeVa(['chancery', 'localities', '--json'], { cacheDir, cwd: root, mock });
    expect(r2.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    expect((JSON.parse(r2.stdout) as { viewing_status: string }[])[0].viewing_status).toBe('Scanned v1');

    const r3 = await invokeVa(['chancery', 'localities', '--refresh', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r3.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(2);
    expect((JSON.parse(r3.stdout) as { viewing_status: string }[])[0].viewing_status).toBe('Scanned v2');

    mock.localitiesVersion = 3;
    const r4 = await invokeVa(['--refresh', 'chancery', 'localities', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r4.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(3);
    expect((JSON.parse(r4.stdout) as { viewing_status: string }[])[0].viewing_status).toBe('Scanned v3');

    const r5 = await invokeVa(['chancery', 'localities', '--json'], { cacheDir, cwd: root, mock });
    expect(r5.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(3);
  });

  it('forces refetch when TTL=0 via primary or alias env var', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const cold = await invokeVa(['catalog', 'Synthetic', '--json'], {
      cacheDir,
      cwd: root,
      mock,
      extraEnv: { [TTL_ENV]: '0' },
    });
    expect(cold.exitCode).toBe(0);
    expect((JSON.parse(cold.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const coldAlias = await invokeVa(['catalog', 'Synthetic', '--json'], {
      cacheDir,
      cwd: root,
      mock,
      extraEnv: { [TTL_ENV_ALIAS]: '0' },
    });
    expect(coldAlias.exitCode).toBe(0);
    expect((JSON.parse(coldAlias.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(mock.calls).toHaveLength(2);

    const warm = await invokeVa(['catalog', 'Synthetic', '--json'], { cacheDir, cwd: root, mock });
    expect(warm.exitCode).toBe(0);
    expect((JSON.parse(warm.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(mock.calls).toHaveLength(2);
  });

  it('writes cache entries atomically with no .tmp leftovers', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const res = await invokeVa(['catalog', 'Synthetic'], { cacheDir, cwd: root, mock });
    expect(res.exitCode).toBe(0);
    const allFiles = listFilesRecursive(cacheDir);
    expect(allFiles.filter((f) => f.endsWith('.tmp'))).toEqual([]);
    const bodies = allFiles.filter((f) => f.endsWith('.body'));
    expect(bodies).toHaveLength(1);
    expect(fs.existsSync(`${bodies[0]}.meta.json`)).toBe(true);
  });
});

describe('va-archives path & ID validation', () => {
  it('accepts https and relative paths on image.lva.virginia.gov', () => {
    const want = 'https://image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif';
    for (const ok of [
      want,
      '/LONN/LO-3/372/372_0195.tif',
      'LONN/LO-3/372/372_0195.tif',
      'https://IMAGE.lva.virginia.gov:443/LONN/LO-3/372/372_0195.tif',
    ]) {
      expect(normalizeLvaImageUrl(ok)).toBe(want);
    }
  });

  it('rejects bad hosts, schemes, credentials, ports, queries, and traversal', () => {
    const bad = [
      '',
      'http://image.lva.virginia.gov/LONN/a.tif',
      'ftp://image.lva.virginia.gov/LONN/a.tif',
      'file:///etc/passwd.tif',
      'javascript:alert(1).tif',
      'https://evil.example/LONN/a.tif',
      'https://image.lva.virginia.gov.evil.example/a.tif',
      'https://user:pw@image.lva.virginia.gov/a.tif',
      'https://image.lva.virginia.gov:8443/a.tif',
      '//image.lva.virginia.gov/a.tif',
      '/LONN/../secret.tif',
      '/LONN/%2e%2e/secret.tif',
      '/LONN/%252e%252e/secret.tif',
      '/LONN/./a.tif',
      '/LONN//a.tif',
      '\\LONN\\a.tif',
      '/LONN/a.tif?x=1',
      '/LONN/a.tif#frag',
      '/LONN/a b.tif',
      '/LONN/a.tif\x00.png',
      '/LONN/LO.html',
      '/cgi-bin/script.pl',
    ];
    for (const raw of bad) {
      expect(() => normalizeLvaImageUrl(raw), raw).toThrow();
    }
  });

  it('validates Rosetta IE and FL identifiers', () => {
    expect(validateIeId(' IE3453061 ')).toBe('IE3453061');
    for (const raw of ['IE', 'ie123', 'IE12a', '../IE1', 'IE1/..', 'FL123', 'IE1 2', '']) {
      expect(() => validateIeId(raw), raw).toThrow(CliValidationError);
    }
    expect(validateFlId('FL42')).toBe('FL42');
    expect(() => validateFlId('FL42/../x')).toThrow(CliValidationError);
  });
});

describe('va-archives grant-tif / lva-tif', () => {
  it('saves, caches, aliases, and refreshes raw TIFFs', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const out = path.join(root, 'grant.tif');
    const r1 = await invokeVa(['grant-tif', '/LONN/LO-3/372/372_0195.tif', '--out', out, '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r1.exitCode).toBe(0);
    expect(fs.readFileSync(out)).toEqual(FAKE_TIFF);
    expect((JSON.parse(r1.stdout) as { mode: string }).mode).toBe('raw');
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);
    expect(mock.calls).toHaveLength(1);

    mock.tiff = Buffer.concat([FAKE_TIFF, Buffer.from('-v2', 'utf8')]);
    const out2 = path.join(root, 'grant2.tiff');
    const r2 = await invokeVa(
      ['lva-tif', 'https://image.lva.virginia.gov/LONN/LO-3/372/372_0195.tif', '--out', out2],
      { cacheDir, cwd: root, mock }
    );
    expect(r2.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(1);
    expect(fs.readFileSync(out2)).toEqual(FAKE_TIFF);

    const rHit = await invokeVa(['grant-tif', '/LONN/LO-3/372/372_0195.tif', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(rHit.exitCode).toBe(0);
    expect((JSON.parse(rHit.stdout) as { cache_hit: boolean }).cache_hit).toBe(true);
    expect(mock.calls).toHaveLength(1);

    const r3 = await invokeVa(['grant-tif', '/LONN/LO-3/372/372_0195.tif', '--out', out2, '--refresh'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r3.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(2);
    expect(fs.readFileSync(out2)).toEqual(Buffer.concat([FAKE_TIFF, Buffer.from('-v2', 'utf8')]));
  });

  it('makes no request on bad path and refuses off-host redirects', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();
    const out = path.join(root, 'x.tif');

    for (const bad of [
      '/LONN/../x.tif',
      'https://evil.example/x.tif',
      'http://image.lva.virginia.gov/x.tif',
    ]) {
      const res = await invokeVa(['grant-tif', bad, '--out', out], { cacheDir, cwd: root, mock });
      expect(res.exitCode).not.toBe(0);
    }
    expect(mock.calls).toHaveLength(0);
    expect(fs.existsSync(out)).toBe(false);

    const redir = await invokeVa(['grant-tif', '/redirect-out.tif', '--out', out], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(redir.exitCode).not.toBe(0);
    expect(fs.existsSync(out)).toBe(false);
    expect(listFilesRecursive(path.join(cacheDir, 'files')).filter((f) => f.endsWith('.tif'))).toEqual([]);
  });

  it('converts CCITT G4 TIFF to JPEG when --out ends in .jpg', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const g4Tiff = await sharp({
      create: { width: 16, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .greyscale()
      .toColourspace('b-w')
      .threshold(128)
      .tiff({ compression: 'ccittfax4', bitdepth: 1 })
      .toBuffer();
    mock.tiff = g4Tiff;

    const out = path.join(root, 'grant.jpg');
    const res = await invokeVa(['grant-tif', '/LONN/b.tif', '--out', out, '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(res.exitCode).toBe(0);
    expect((JSON.parse(res.stdout) as { mode: string }).mode).toBe('jpeg');
    expect(fs.readFileSync(out).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });
});

describe('va-archives dunmore', () => {
  it('parses drawer page marking current and dropping unsafe traversal links', () => {
    const parsed = parseDunmoreDrawer(DRAWER_HTML);
    expect(parsed.current_page).toBe(12);
    expect(parsed.images.map((im) => im.page)).toEqual([10, 11, 12, 13]);
    const current = parsed.images.filter((im) => im.current);
    expect(current).toHaveLength(1);
    expect(current[0].url).toBe('https://image.lva.virginia.gov/Microfilm/DW/001/00012.tif');
  });

  it('saves card page, caches drawer page, and rejects bad drawer/card values', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const out = path.join(root, 'dw.tif');
    const r1 = await invokeVa(['dunmore', '0001/W0002', '3', '--out', out, '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r1.exitCode).toBe(0);
    expect((JSON.parse(r1.stdout) as { selected: { page: number } }).selected.page).toBe(12);
    expect(fs.readFileSync(out)).toEqual(FAKE_TIFF);

    const callsAfterR1 = mock.calls.length;
    const r2 = await invokeVa(['dunmore', '0001/W0002', '3', '--page', '13', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r2.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(callsAfterR1);
    expect((JSON.parse(r2.stdout) as { selected: { page: number } }).selected.page).toBe(13);

    const mock2 = new MockLva();
    for (const [drawer, card] of [
      ['../x', '1'],
      ['0001/W0002', '1;rm'],
      ['0001/W0002/..', '1'],
    ]) {
      const bad = await invokeVa(['dunmore', drawer, card], { cacheDir, cwd: root, mock: mock2 });
      expect(bad.exitCode).not.toBe(0);
    }
    expect(mock2.calls).toHaveLength(0);
  });
});

describe('va-archives rosetta', () => {
  it('parses delivery and viewer pages', () => {
    const d = parseRosettaDelivery(DELIVERY_HTML);
    expect(d.viewer_url).toContain('ieViewer.do');
    expect(d.viewer_url).toContain('&dps_pid=IE900001');
    expect(d.dps_dvs).toBe('111~222');

    const v = parseRosettaViewer(VIEWER_HTML);
    expect(v.initial).toBe('FL900002');
    expect(v.files).toEqual([
      { fl: 'FL900002', title: 'Original' },
      { fl: 'FL900003', title: 'Transcription' },
    ]);
  });

  it('resolves with cookie session, caches by IE, warms session for second file, and refetches on --refresh', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const out = path.join(root, 'doc.pdf');
    const r1 = await invokeVa(['download-rosetta', 'IE900001', '--out', out, '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r1.exitCode).toBe(0);
    expect(fs.readFileSync(out)).toEqual(Buffer.concat([FAKE_PDF, Buffer.from('FL900002', 'utf8')]));
    expect(mock.calls.map((c) => c.url.pathname)).toEqual([
      '/delivery/DeliveryManagerServlet',
      '/view/action/ieViewer.do',
      '/delivery/DeliveryManagerServlet',
    ]);
    expect(fs.existsSync(path.join(cacheDir, 'rosetta', 'IE900001', 'files.json'))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, 'rosetta', 'IE900001', 'FL900002.bin'))).toBe(true);

    // Cache hit with default output filename in ctx.cwd.
    const r2 = await invokeVa(['download-rosetta', 'IE900001'], { cacheDir, cwd: root, mock });
    expect(r2.exitCode).toBe(0);
    expect(fs.existsSync(path.join(root, 'IE900001_FL900002.pdf'))).toBe(true);
    expect(mock.calls).toHaveLength(3);

    // Second file: listing is cached so only session warm-up + stream are fetched.
    const out2 = path.join(root, 't.pdf');
    const r3 = await invokeVa(['download-rosetta', 'IE900001', '--file', '2', '--out', out2], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r3.exitCode).toBe(0);
    expect(fs.readFileSync(out2)).toEqual(Buffer.concat([FAKE_PDF, Buffer.from('FL900003', 'utf8')]));
    expect(mock.calls.slice(3).map((c) => c.url.searchParams.get('dps_pid'))).toEqual([
      'IE900001',
      'FL900003',
    ]);

    // --refresh re-resolves the IE and refetches bytes.
    const r4 = await invokeVa(['download-rosetta', 'IE900001', '--refresh', '--out', out], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r4.exitCode).toBe(0);
    expect(mock.calls).toHaveLength(8);
  });

  it('lists files, enforces FL membership, and rejects invalid IE ids without network calls', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const r = await invokeVa(['download-rosetta', 'IE900001', '--list', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(r.exitCode).toBe(0);
    expect((JSON.parse(r.stdout) as { files: { fl: string }[] }).files.map((f) => f.fl)).toEqual([
      'FL900002',
      'FL900003',
    ]);

    const badFl = await invokeVa(['download-rosetta', 'IE900001', '--fl', 'FL1'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(badFl.exitCode).not.toBe(0);

    const mock2 = new MockLva();
    for (const bad of ['IE../1', '123', 'FL900002', 'IE1&dps_func=x']) {
      const res = await invokeVa(['download-rosetta', bad], { cacheDir, cwd: root, mock: mock2 });
      expect(res.exitCode).not.toBe(0);
    }
    expect(mock2.calls).toHaveLength(0);
  });
});

describe('va-archives chancery search, case, download, and url', () => {
  it('handles chancery search, case --images, download PDFs/ZIP, and url pointers', async () => {
    const root = await makeTempDir();
    const cacheDir = path.join(root, 'cache');
    const mock = new MockLva();

    const search = await invokeVa(['chancery', 'search', 'Doe', '--locality', 'ALBEMARLE CO', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(search.exitCode).toBe(0);
    const searchData = JSON.parse(search.stdout) as {
      total: number;
      records: { cfn: string; plaintiffs: string[]; defendants: string[] }[];
    };
    expect(searchData.total).toBe(1);
    expect(searchData.records[0].cfn).toBe('003-1842-001');
    expect(searchData.records[0].plaintiffs).toEqual(['Doe, John', 'Doe, Jane']);

    const caseRes = await invokeVa(['chancery', 'case', '003-1842-001', '--images', '--json'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(caseRes.exitCode).toBe(0);
    const caseData = JSON.parse(caseRes.stdout) as {
      locality: string;
      images: { total_pages: number; page_pdfs: string[] };
    };
    expect(caseData.locality).toBe('ALBEMARLE CO');
    expect(caseData.images.total_pages).toBe(2);

    const dlDir = path.join(root, 'case-pdfs');
    const dlPdf = await invokeVa(['chancery', 'download', '003-1842-001', '--pages', '1', '--out', dlDir], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(dlPdf.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dlDir, '003-1842-001_0001.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(dlDir, 'metadata.json'))).toBe(true);

    const zipDir = path.join(root, 'case-zip');
    const dlZip = await invokeVa(['chancery', 'download', '003-1842-001', '--zip', '--out', zipDir], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(dlZip.exitCode).toBe(0);
    expect(fs.readFileSync(path.join(zipDir, '003-1842-001.zip'))).toEqual(FAKE_ZIP);

    const urlRes = await invokeVa(['url', '--chancery-case', '003-1842-001', '--land'], {
      cacheDir,
      cwd: root,
      mock,
    });
    expect(urlRes.exitCode).toBe(0);
    expect(urlRes.stdout).toContain('case_detail.asp?CFN=003-1842-001');
    expect(urlRes.stdout).toContain('image.lva.virginia.gov/LONN/LO.html');
  });
});
