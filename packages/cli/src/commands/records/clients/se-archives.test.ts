import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRecordContext } from '../runtime/index.js';
import { runSeArchivesCommand } from './se-archives.js';

const SAMPLE_SEARCH_RESPONSE = {
  totalHits: 2,
  hits: 2,
  offset: 0,
  items: [
    {
      id: 'Tij9jjX9rH6cxG02H087k3',
      objectType: 'Record',
      type: 'Volume',
      metadata: {
        referenceCode: 'SE/ULA/10392/A I a/9',
        hierarchy: [{ caption: 'Uppsala domkyrkoförsamlings kyrkoarkiv' }, { caption: 'Husförhörslängder' }],
        archivalInstitution: [{ caption: 'Riksarkivet i Uppsala' }],
        date: '1887 - 1896',
        onlyDigitisedMaterials: true,
      },
      _links: {
        self: 'http://data.riksarkivet.se/archive/Tij9jjX9rH6cxG02H087k3',
      },
    },
    {
      id: 'VolTranscribed001',
      objectType: 'Record',
      type: 'Volume',
      metadata: {
        referenceCode: 'SE/ULA/10102/A I b/8',
        date: '1848 - 1851',
        onlyDigitisedMaterials: true,
      },
      transcribedText: {
        snippets: [
          {
            text: 'Anders <em>Andersson</em> i Garphyttan',
            pages: [{ id: '_A0030423_00003', width: 5446, height: 4634 }],
          },
        ],
      },
      _links: { self: 'https://data.riksarkivet.se/archive/VolTranscribed001' },
    },
  ],
};

const SAMPLE_BIRTHS_RESPONSE = {
  totalHits: 1,
  hits: 1,
  offset: 0,
  items: [
    {
      id: 'HcyoChOvigzCJOoDJWqC3',
      objectType: 'Register',
      type: 'BirthRecord',
      caption: 'Erik Johan',
      metadata: {
        date: '1894-11-20',
        childsName: 'Erik Johan',
        fathersName: 'Andersson, Anders',
        mothersName: 'Persdotter, Karin',
        parish: 'Helsingborg Stad',
      },
      _links: {
        self: 'https://data.riksarkivet.se/register/HcyoChOvigzCJOoDJWqC3',
        image: ['https://lbiiif.riksarkivet.se/arkis!00124895/manifest'],
      },
    },
  ],
};

const SAMPLE_MARRIAGES_RESPONSE = {
  totalHits: 1,
  hits: 1,
  offset: 0,
  items: [
    {
      id: 'LcbdSsLiNp8tEJOsC1',
      objectType: 'Register',
      type: 'MarriageRecord',
      caption: 'Johansson, Erik - Persdotter, Karin',
      metadata: {
        groomsName: 'Johansson, Erik',
        bridesName: 'Persdotter, Karin',
        parish: 'Vänge',
        date: '1841-07-04',
      },
      _links: { self: 'https://data.riksarkivet.se/register/LcbdSsLiNp8tEJOsC1' },
    },
  ],
};

const SAMPLE_DEEDS_RESPONSE = {
  totalHits: 1,
  hits: 1,
  offset: 0,
  items: [
    {
      id: 'J65dPc5oT5yO1',
      objectType: 'Register',
      type: 'IndexOfTitleDeedsRecord',
      caption: 'Akebäck - Bäcks',
      metadata: {
        parish: 'Akebäck',
        propertyName: 'Bäcks',
        taxUnit: '5/8',
        year: '1810',
        districtCourtSessions: 'Sommarting',
      },
      _links: { self: 'https://data.riksarkivet.se/register/J65dPc5oT5yO1' },
    },
  ],
};

const SAMPLE_REGISTER_DETAIL = {
  caption: 'Erik Johan',
  childsName: 'Erik Johan',
  date: '1894-11-20',
  parish: 'Helsingborg Stad',
  fathersName: 'Andersson, Anders',
  mothersName: 'Persdotter, Karin',
  volume: 'C I:17',
  archive: 'Helsingborgs stadsförsamlings (Maria) kyrkoarkiv (SE/LLA/13171)',
  image: 'https://lbiiif.riksarkivet.se/arkis!00124895/manifest',
  type: 'BirthRecord',
};

const SAMPLE_COLLECTION_RESPONSE = {
  '@context': 'http://iiif.io/api/presentation/3/context.json',
  id: 'https://lbiiif.riksarkivet.se/collection/arkiv/39TJaymaweZJTe018W43t3',
  type: 'Collection',
  label: { sv: ['A I aa Husförhörslängder, Svartbäcksroten'] },
  summary: {
    sv: [
      'Referenskod: SE/ULA/11632/A I aa',
      'Arkivinstitution: Riksarkivet i Uppsala',
      'Datering: 1887-1896',
    ],
  },
  items: [
    {
      id: 'https://lbiiif.riksarkivet.se/arkis!80002567/manifest',
      type: 'Manifest',
      label: { sv: ['8 (1887-1896) - 80002567 - S.D'] },
    },
  ],
};

const SAMPLE_MANIFEST_RESPONSE = {
  '@context': 'http://iiif.io/api/presentation/3/context.json',
  id: 'https://lbiiif.riksarkivet.se/arkis!00124895/manifest',
  type: 'Manifest',
  label: {
    sv: ['Helsingborgs stadsförsamlings (Maria) kyrkoarkiv, SE/LLA/13171/C I/17 (1894)'],
  },
  metadata: [
    { label: { sv: ['Arkiv'] }, value: { none: ['Helsingborgs stadsförsamlings kyrkoarkiv'] } },
    { label: { sv: ['Referenskod'] }, value: { none: ['SE/LLA/13171/C I/17'] } },
  ],
  items: [
    {
      id: 'https://lbiiif.riksarkivet.se/arkis!00124895_00001/canvas',
      type: 'Canvas',
      label: { sv: ['Bild 1'] },
      width: 2998,
      height: 2125,
      metadata: [
        { label: { sv: ['Bildid'] }, value: { none: ['00124895_00001'] } },
        {
          label: { sv: ['Länk'] },
          value: { none: ['https://sok.riksarkivet.se/bildvisning/00124895_00001'] },
        },
        {
          label: { sv: ['Källhänvisning'] },
          value: { sv: ['SE/LLA/13171/C I/17 (1894), bildid: 00124895_00001'] },
        },
      ],
    },
  ],
};

const MINIMAL_JPEG_BYTES = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
  0x00, 0x00, 0xff, 0xd9,
]);

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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-se-test-'));
  tempDirs.push(dir);
  return dir;
}

async function invokeSe(
  args: readonly string[],
  cacheRoot: string,
  fetchImpl?: typeof fetch
): Promise<{ exitCode: number; stdout: string; stderr: string; cacheHit?: boolean }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const ctx = createRecordContext({
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    env: { KINLOOM_CACHE_DIR: cacheRoot },
    fetchImpl: fetchImpl ?? (async () => new Response('', { status: 500 })),
    sleepFn: async () => {},
  });
  const outcome = await runSeArchivesCommand(args, ctx);
  return {
    exitCode: outcome.exitCode,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    cacheHit: outcome.cacheHit,
  };
}

describe('se-archives native client', () => {
  it('normalizes search query params, HTR snippets, and uses disk cache under KINLOOM_CACHE_DIR', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const seenParams: Record<string, string>[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('data.riksarkivet.se');
      expect(url.pathname).toBe('/api/records');
      seenParams.push(Object.fromEntries(url.searchParams.entries()));
      return new Response(JSON.stringify(SAMPLE_SEARCH_RESPONSE), { status: 200 });
    };

    const args = [
      'search',
      '--transcribed',
      'Anders Andersson',
      '--type',
      'volume',
      '--year-min',
      '1840',
      '--year-max',
      '1896',
      '--json',
    ];
    const r1 = await invokeSe(args, cacheRoot, fetchImpl);
    const r2 = await invokeSe(args, cacheRoot, fetchImpl);
    const r3 = await invokeSe(args.slice(0, -1), cacheRoot, fetchImpl);
    const r4 = await invokeSe([...args, '--refresh'], cacheRoot, fetchImpl);

    expect([r1.exitCode, r2.exitCode, r3.exitCode, r4.exitCode]).toEqual([0, 0, 0, 0]);
    expect(seenParams).toHaveLength(2);
    expect(seenParams[0]['transcribed_text']).toBe('Anders Andersson');
    expect(seenParams[0]['only_digitised_materials']).toBe('true');
    expect(seenParams[0]['facet']).toBe('ObjectType:Record;Type:Volume');
    expect(seenParams[0]['year_min']).toBe('1840');
    expect(seenParams[0]['year_max']).toBe('1896');

    const p1 = JSON.parse(r1.stdout) as {
      cache_hit: boolean;
      results: {
        reference_code: string;
        self_url: string;
        snippets?: { text: string; pages: string[] }[];
        iiif_manifests?: string[];
      }[];
    };
    const p2 = JSON.parse(r2.stdout) as { cache_hit: boolean };
    const p4 = JSON.parse(r4.stdout) as { cache_hit: boolean };
    expect(p1.cache_hit).toBe(false);
    expect(p2.cache_hit).toBe(true);
    expect(p4.cache_hit).toBe(false);
    expect(p1.results[0].reference_code).toBe('SE/ULA/10392/A I a/9');
    expect(p1.results[0].self_url).toBe('https://data.riksarkivet.se/archive/Tij9jjX9rH6cxG02H087k3');
    expect(p1.results[1].snippets?.[0].pages).toEqual(['A0030423_00003']);
    expect(p1.results[1].snippets?.[0].text).toBe('Anders Andersson i Garphyttan');
    expect(p1.results[1].iiif_manifests).toEqual(['https://lbiiif.riksarkivet.se/arkis!A0030423/manifest']);
    expect(r3.stdout).toContain('[cache]');
    expect(
      fs.readdirSync(path.join(cacheRoot, 'se-archives')).filter((f) => f.endsWith('.json'))
    ).toHaveLength(1);
  });

  it('supports births, marriages, deeds, and register detail endpoints', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const seenPaths: string[] = [];

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      seenPaths.push(url.pathname);
      if (url.pathname === '/api/records/birthrecords') {
        expect(url.searchParams.get('first_name')).toBe('Erik');
        expect(url.searchParams.get('fathers_name')).toBe('Andersson');
        expect(url.searchParams.get('gender')).toBe('Man');
        return new Response(JSON.stringify(SAMPLE_BIRTHS_RESPONSE), { status: 200 });
      }
      if (url.pathname === '/api/records/marriagerecords') {
        expect(url.searchParams.get('grooms_name')).toBe('Erik Johansson');
        expect(url.searchParams.get('brides_name')).toBe('Karin Persdotter');
        return new Response(JSON.stringify(SAMPLE_MARRIAGES_RESPONSE), { status: 200 });
      }
      if (url.pathname === '/api/records/indexoftitledeeds') {
        expect(url.searchParams.get('parish')).toBe('Akebäck');
        return new Response(JSON.stringify(SAMPLE_DEEDS_RESPONSE), { status: 200 });
      }
      if (url.pathname === '/register/HcyoChOvigzCJOoDJWqC3') {
        return new Response(JSON.stringify(SAMPLE_REGISTER_DETAIL), { status: 200 });
      }
      return new Response('', { status: 404 });
    };

    const rb = await invokeSe(
      ['births', '--first', 'Erik', '--father', 'Andersson', '--gender', 'male', '--json'],
      cacheRoot,
      fetchImpl
    );
    const rmRes = await invokeSe(
      ['marriages', '--groom', 'Erik Johansson', '--bride', 'Karin Persdotter', '--json'],
      cacheRoot,
      fetchImpl
    );
    const rd = await invokeSe(['deeds', '--parish', 'Akebäck', '--json'], cacheRoot, fetchImpl);
    const rr = await invokeSe(['record', 'HcyoChOvigzCJOoDJWqC3', '--json'], cacheRoot, fetchImpl);

    expect([rb.exitCode, rmRes.exitCode, rd.exitCode, rr.exitCode]).toEqual([0, 0, 0, 0]);
    const birthsJson = JSON.parse(rb.stdout) as {
      results: { child_name: string; iiif_manifests: string[] }[];
    };
    expect(birthsJson.results[0].child_name).toBe('Erik Johan');
    expect(birthsJson.results[0].iiif_manifests).toEqual([
      'https://lbiiif.riksarkivet.se/arkis!00124895/manifest',
    ]);
    expect((JSON.parse(rmRes.stdout) as { results: { groom: string }[] }).results[0].groom).toBe(
      'Johansson, Erik'
    );
    expect((JSON.parse(rd.stdout) as { results: { property_name: string }[] }).results[0].property_name).toBe(
      'Bäcks'
    );
    expect((JSON.parse(rr.stdout) as { record: { volume: string } }).record.volume).toBe('C I:17');
    expect(seenPaths).toHaveLength(4);
  });

  it('parses IIIF v3 collections, manifests, and explains 403 restricted volumes', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');

    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/collection/arkiv/39TJaymaweZJTe018W43t3') {
        return new Response(JSON.stringify(SAMPLE_COLLECTION_RESPONSE), { status: 200 });
      }
      if (url.pathname === '/arkis!00124895/manifest') {
        return new Response(JSON.stringify(SAMPLE_MANIFEST_RESPONSE), { status: 200 });
      }
      if (url.pathname === '/arkis!C0003826/manifest') {
        return new Response('<html><body>Forbidden</body></html>', { status: 403 });
      }
      return new Response('', { status: 404 });
    };

    const rc = await invokeSe(['collection', '39TJaymaweZJTe018W43t3', '--json'], cacheRoot, fetchImpl);
    const rmRes = await invokeSe(
      ['manifest', 'https://sok.riksarkivet.se/bildvisning/00124895_00001', '--json'],
      cacheRoot,
      fetchImpl
    );
    const rf = await invokeSe(['manifest', 'C0003826', '--json'], cacheRoot, fetchImpl);

    expect([rc.exitCode, rmRes.exitCode]).toEqual([0, 0]);
    const coll = JSON.parse(rc.stdout) as {
      reference_code: string;
      items: { bildid: string }[];
    };
    expect(coll.reference_code).toBe('SE/ULA/11632/A I aa');
    expect(coll.items[0].bildid).toBe('80002567');

    const man = JSON.parse(rmRes.stdout) as {
      bildid: string;
      canvas_count: number;
      canvases: { page_id: string; full_image_url: string }[];
    };
    expect(man.bildid).toBe('00124895');
    expect(man.canvas_count).toBe(1);
    expect(man.canvases[0].page_id).toBe('00124895_00001');
    expect(man.canvases[0].full_image_url).toBe(
      'https://lbiiif.riksarkivet.se/arkis!00124895_00001/full/max/0/default.jpg'
    );

    expect(rf.exitCode).toBe(1);
    expect(rf.stderr).toContain('restricted on the public IIIF endpoint');
    expect(rf.stderr).toContain('https://sok.riksarkivet.se/bildvisning/C0003826');
  });

  it('recovers from transient 429/503 retries and never caches HTTP 500 errors', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    let attempts = 0;

    const flakyFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('', { status: 429, headers: { 'Retry-After': '0' } });
      }
      if (attempts === 2) {
        return new Response('', { status: 503 });
      }
      return new Response(JSON.stringify(SAMPLE_BIRTHS_RESPONSE), { status: 200 });
    };

    const r1 = await invokeSe(['births', '--first', 'Erik', '--json'], cacheRoot, flakyFetch);
    expect(r1.exitCode).toBe(0);
    expect(attempts).toBe(3);
    expect((JSON.parse(r1.stdout) as { cache_hit: boolean }).cache_hit).toBe(false);

    const failFetch: typeof fetch = async () => new Response('server error', { status: 500 });
    const cacheDir = path.join(cacheRoot, 'se-archives');
    const before = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
    const r2 = await invokeSe(['births', '--first', 'Karin', '--json'], cacheRoot, failFetch);
    const after = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));

    expect(r2.exitCode).toBe(1);
    expect(r2.stderr).toContain('HTTP 500');
    expect(after).toEqual(before);
  });

  it('validates JPEG downloads, refuses HTML, enforces allowlist, and blocks path traversal', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');
    const outJpg = path.join(tmp, 'church-book.jpg');
    const seenUrls: string[] = [];

    const jpegFetch: typeof fetch = async (input) => {
      seenUrls.push(String(input));
      return new Response(MINIMAL_JPEG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    };

    // 1. Valid JPEG download with --width, followed by idempotent skip without --overwrite.
    const r1 = await invokeSe(
      ['download', '00124895', '--page', '2', '--width', '1000', '--out', outJpg, '--json'],
      cacheRoot,
      jpegFetch
    );
    const r2 = await invokeSe(
      ['download', '00124895', '--page', '2', '--width', '1000', '--out', outJpg, '--json'],
      cacheRoot,
      jpegFetch
    );
    expect([r1.exitCode, r2.exitCode]).toEqual([0, 0]);
    expect(seenUrls).toEqual(['https://lbiiif.riksarkivet.se/arkis!00124895_00002/full/1000,/0/default.jpg']);
    const p1 = JSON.parse(r1.stdout) as { format: string; skipped: boolean; cache_hit: boolean };
    const p2 = JSON.parse(r2.stdout) as { skipped: boolean; cache_hit: boolean };
    expect(p1.format).toBe('jpeg');
    expect(p1.skipped).toBe(false);
    expect(p1.cache_hit).toBe(false);
    expect(p2.skipped).toBe(true);
    expect(p2.cache_hit).toBe(true);
    expect(Buffer.compare(fs.readFileSync(outJpg), Buffer.from(MINIMAL_JPEG_BYTES))).toBe(0);

    // 2. HTML returned with HTTP 200 is never saved as an image.
    const badJpg = path.join(tmp, 'html-trap.jpg');
    const htmlFetch: typeof fetch = async () =>
      new Response('<!DOCTYPE html><html><body>Fel - IIIF</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    const rHtml = await invokeSe(
      ['download', '00124895_00001', '--full', '--out', badJpg],
      cacheRoot,
      htmlFetch
    );
    expect(rHtml.exitCode).toBe(1);
    expect(rHtml.stderr).toContain('Refusing to save HTML');
    expect(fs.existsSync(badJpg)).toBe(false);

    // 3. Redirect to a non-allowlisted host is rejected.
    const evilRedirectFetch: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'lbiiif.riksarkivet.se') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://example.invalid/evil.jpg' },
        });
      }
      return new Response(MINIMAL_JPEG_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    };
    const rRedir = await invokeSe(
      ['download', '00124895_00001', '--full', '--out', badJpg],
      cacheRoot,
      evilRedirectFetch
    );
    expect(rRedir.exitCode).toBe(2);
    expect(rRedir.stderr).toContain('Refusing host');
    expect(fs.existsSync(badJpg)).toBe(false);

    // 4. Disallowed host URL, path traversal, and conflicting --width/--full exit 2.
    const rHost = await invokeSe(
      ['download', 'https://example.invalid/arkis!00124895_00001/full/max/0/default.jpg', '--out', badJpg],
      cacheRoot,
      jpegFetch
    );
    expect(rHost.exitCode).toBe(2);
    expect(rHost.stderr).toContain('Refusing host');

    const rTrav = await invokeSe(
      ['download', '00124895_00001', '--out', '../escape.jpg'],
      cacheRoot,
      jpegFetch
    );
    expect(rTrav.exitCode).toBe(2);
    expect(rTrav.stderr).toContain('traversal');

    const rBoth = await invokeSe(
      ['download', '00124895_00001', '--width', '800', '--full', '--out', badJpg],
      cacheRoot,
      jpegFetch
    );
    expect(rBoth.exitCode).toBe(2);
    expect(rBoth.stderr).toContain('not both');
  });

  it('builds census browser-only URLs offline and prints help', async () => {
    const tmp = await makeTempDir();
    const cacheRoot = path.join(tmp, 'cache');

    const res = await invokeSe(
      [
        'census',
        '--surname',
        'Andersson',
        '--given',
        'Anders',
        '--year',
        '1890',
        '--parish',
        'Uppsala',
        '--json',
      ],
      cacheRoot
    );
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as {
      status: string;
      census_url: string;
      church_archives_url: string;
    };
    expect(payload.status).toBe('browser-only');
    expect(payload.census_url).toContain('https://sok.riksarkivet.se/folkrakningar?');
    expect(payload.census_url).toContain('Efternamn=Andersson');
    expect(payload.census_url).toContain('Folk1890=true');
    expect(payload.church_archives_url).toContain('https://sok.riksarkivet.se/kyrkoarkiv?');

    const help = await invokeSe(['--help'], cacheRoot);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('kinloom se-archives');
  });
});
