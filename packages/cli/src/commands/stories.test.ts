import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CliIo, runCli } from '../cli/runCli.js';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { slugifyStoryTitle } from './stories.js';

function createMemoryIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
    },
  };
}

describe('kinloom stories CLI', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kinloom-stories-cli-'));
    tempDirs.push(dir);
    return dir;
  }

  it('prints help for root and subcommands and rejects invalid flags or subcommands', async () => {
    for (const argv of [
      ['stories'],
      ['stories', '--help'],
      ['stories', 'init', '--help'],
      ['stories', 'validate', '--help'],
      ['stories', 'build', '--help'],
      ['stories', 'publish', '--help'],
      ['stories', 'list', '--help'],
    ]) {
      const mem = createMemoryIo();
      expect(await runCli(argv, { io: mem.io })).toBe(EXIT_OK);
      expect(mem.out.join('\n')).toContain('kinloom stories <subcommand>');
    }

    expect(slugifyStoryTitle('!!!')).toBe('specialty-story');

    const badCases: readonly (readonly string[])[] = [
      ['stories', 'unknown-sub'],
      ['stories', 'init', '--bogus'],
      ['stories', 'init', '--person'],
      ['stories', 'init', '--format', 'scroll'],
      ['stories', 'init', '--person', 'p1', '--format', 'invalid'],
      ['stories', 'init', '--person', 'p1', '--format', 'documentary', '--aspect-ratio', '4:3'],
      ['stories', 'validate'],
      ['stories', 'build'],
      ['stories', 'publish'],
    ];
    for (const argv of badCases) {
      const bad = createMemoryIo();
      expect(await runCli(argv, { io: bad.io })).toBe(EXIT_USAGE);
    }
  });

  it('scaffolds, validates, builds, publishes locally, and lists stories end-to-end', async () => {
    const cwd = await makeTempDir();
    const storyDir = path.join(cwd, 'stories', 'ada-doc');

    const mockFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          people: [{ id: 'person-ada', full_name: 'Ada Lovelace', birth_year: 1815, death_year: 1852 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )) as typeof fetch;

    const initIo = createMemoryIo();
    expect(
      await runCli(
        [
          'stories',
          'init',
          '--person',
          'person-ada',
          '--format',
          'documentary',
          '--title',
          'Ada Documentary',
          '--aspect-ratio',
          '9:16',
          '--site',
          'https://archive.example',
          '--token',
          'tok-test',
          '--out',
          storyDir,
        ],
        { cwd, io: initIo.io, fetchImpl: mockFetch }
      )
    ).toBe(EXIT_OK);
    expect(initIo.out.join('\n')).toContain('Ada Documentary');

    // Add nested asset file to verify recursive asset walking & copying
    await mkdir(path.join(storyDir, 'assets', 'scans'), { recursive: true });
    await writeFile(path.join(storyDir, 'assets', 'scans', 'note.txt'), 'scan', 'utf8');

    const createdJson = JSON.parse(await readFile(path.join(storyDir, 'story.json'), 'utf8')) as {
      personName?: string;
      aspectRatio?: string;
    };
    expect(createdJson.personName).toBe('Ada Lovelace');
    expect(createdJson.aspectRatio).toBe('9:16');

    // Refuses overwrite without --force, succeeds with --force (and gracefully handles 404 hydration)
    const dupIo = createMemoryIo();
    expect(
      await runCli(['stories', 'init', '--person', 'person-ada', '--format', 'scroll', '--out', storyDir], {
        cwd,
        io: dupIo.io,
      })
    ).toBe(EXIT_USAGE);

    const forceIo = createMemoryIo();
    const notFoundFetch: typeof fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    expect(
      await runCli(
        [
          'stories',
          'init',
          '--person',
          'person-ada',
          '--format',
          'documentary',
          '--title',
          'Ada Documentary',
          '--site',
          'https://archive.example',
          '--out',
          storyDir,
          '--force',
        ],
        { cwd, io: forceIo.io, fetchImpl: notFoundFetch }
      )
    ).toBe(EXIT_OK);

    // Validate pass (text and --json)
    const valIo = createMemoryIo();
    expect(await runCli(['stories', 'validate', storyDir], { cwd, io: valIo.io })).toBe(EXIT_OK);
    expect(valIo.out.join('\n')).toContain('Story validation PASSED');

    const valJsonIo = createMemoryIo();
    expect(await runCli(['stories', 'validate', storyDir, '--json'], { cwd, io: valJsonIo.io })).toBe(
      EXIT_OK
    );
    expect(JSON.parse(valJsonIo.out.join('\n'))).toMatchObject({ valid: true });

    // Build produces portable JSON and HTML and copies assets
    const distDir = path.join(cwd, 'dist-stories');
    const buildIo = createMemoryIo();
    expect(await runCli(['stories', 'build', storyDir, '--out', distDir], { cwd, io: buildIo.io })).toBe(
      EXIT_OK
    );
    const html = await readFile(path.join(distDir, 'ada-documentary.html'), 'utf8');
    expect(html).toContain('Ada Documentary');

    // Publish --dry-run does not write manifest
    const pubDryIo = createMemoryIo();
    expect(await runCli(['stories', 'publish', storyDir, '--dry-run'], { cwd, io: pubDryIo.io })).toBe(
      EXIT_OK
    );
    expect(pubDryIo.out.join('\n')).toContain('[dry-run]');

    // Empty list before publishing
    const preListIo = createMemoryIo();
    expect(await runCli(['stories', 'list'], { cwd, io: preListIo.io })).toBe(EXIT_OK);
    expect(preListIo.out.join('\n')).toContain('No published specialty stories found.');

    // Publish locally and list (all + filtered by --person + --json)
    const pubOut = path.join(cwd, 'public', 'stories');
    const pubIo = createMemoryIo();
    expect(await runCli(['stories', 'publish', storyDir, '--out', pubOut], { cwd, io: pubIo.io })).toBe(
      EXIT_OK
    );

    const listIo = createMemoryIo();
    expect(await runCli(['stories', 'list', '--person', 'person-ada'], { cwd, io: listIo.io })).toBe(EXIT_OK);
    expect(listIo.out.join('\n')).toContain('ada-documentary');

    const listEmptyIo = createMemoryIo();
    expect(await runCli(['stories', 'list', '--person', 'person-other'], { cwd, io: listEmptyIo.io })).toBe(
      EXIT_OK
    );
    expect(listEmptyIo.out.join('\n')).toContain('No published specialty stories found');

    const listJsonIo = createMemoryIo();
    expect(await runCli(['stories', 'list', '--json'], { cwd, io: listJsonIo.io })).toBe(EXIT_OK);
    const parsedList = JSON.parse(listJsonIo.out.join('\n')) as { stories: Array<{ slug: string }> };
    expect(parsedList.stories.map((s) => s.slug)).toEqual(['ada-documentary']);
  });

  it('handles missing paths, corrupt JSON/manifests, warnings, and validation failures cleanly', async () => {
    const cwd = await makeTempDir();
    const scrollDir = path.join(cwd, 'scroll-story');
    const mapDir = path.join(cwd, 'map-story');
    const emptyDir = path.join(cwd, 'empty-dir');
    await mkdir(emptyDir, { recursive: true });

    const missingIo = createMemoryIo();
    expect(await runCli(['stories', 'validate', path.join(cwd, 'nope')], { cwd, io: missingIo.io })).toBe(
      EXIT_USAGE
    );
    expect(await runCli(['stories', 'validate', emptyDir], { cwd, io: missingIo.io })).toBe(EXIT_USAGE);

    const badJsonFile = path.join(cwd, 'bad.json');
    await writeFile(badJsonFile, '{not valid json', 'utf8');
    expect(await runCli(['stories', 'validate', badJsonFile], { cwd, io: missingIo.io })).toBe(EXIT_USAGE);

    const corruptManifest = path.join(cwd, 'bad-manifest.json');
    await writeFile(corruptManifest, JSON.stringify({ version: 999 }), 'utf8');
    expect(await runCli(['stories', 'list', '--manifest', corruptManifest], { cwd, io: missingIo.io })).toBe(
      EXIT_USAGE
    );

    const io1 = createMemoryIo();
    expect(
      await runCli(['stories', 'init', '--person', 'person-1', '--format', 'scroll', '--out', scrollDir], {
        cwd,
        io: io1.io,
      })
    ).toBe(EXIT_OK);
    // Remove citationIds from beat 0 to trigger warning (still valid!)
    const scrollPath = path.join(scrollDir, 'story.json');
    const scrollJson = JSON.parse(await readFile(scrollPath, 'utf8')) as {
      beats: Array<{ citationIds: string[] }>;
    };
    if (scrollJson.beats[0]) {
      scrollJson.beats[0].citationIds = [];
    }
    await writeFile(scrollPath, JSON.stringify(scrollJson, null, 2), 'utf8');
    expect(await runCli(['stories', 'validate', scrollDir], { cwd, io: io1.io })).toBe(EXIT_OK);
    expect(io1.out.join('\n')).toContain('UNCITED_BEAT');

    const io2 = createMemoryIo();
    expect(
      await runCli(['stories', 'init', '--person', 'person-1', '--format', 'map', '--out', mapDir], {
        cwd,
        io: io2.io,
      })
    ).toBe(EXIT_OK);

    // Corrupt a beat to trigger validation error on validate (--json + text), build, and publish
    const brokenPath = path.join(mapDir, 'story.json');
    const story = JSON.parse(await readFile(brokenPath, 'utf8')) as {
      beats: Array<{ caption: string; citationIds: string[] }>;
    };
    const firstBeat = story.beats[0];
    if (firstBeat) {
      firstBeat.caption = '   ';
      firstBeat.citationIds = ['does-not-exist'];
    }
    await writeFile(brokenPath, JSON.stringify(story, null, 2), 'utf8');

    const failVal = createMemoryIo();
    expect(await runCli(['stories', 'validate', brokenPath], { cwd, io: failVal.io })).toBe(EXIT_USAGE);
    expect(failVal.err.join('\n')).toContain('EMPTY_CAPTION');
    expect(await runCli(['stories', 'validate', brokenPath, '--json'], { cwd, io: failVal.io })).toBe(
      EXIT_USAGE
    );

    const failBuild = createMemoryIo();
    expect(await runCli(['stories', 'build', mapDir], { cwd, io: failBuild.io })).toBe(EXIT_USAGE);

    const failPub = createMemoryIo();
    expect(await runCli(['stories', 'publish', mapDir], { cwd, io: failPub.io })).toBe(EXIT_USAGE);
  });

  it('supports remote publish and list via --site and handles HTTP failures', async () => {
    const cwd = await makeTempDir();
    const storyDir = path.join(cwd, 'remote-story');
    const initIo = createMemoryIo();
    await runCli(['stories', 'init', '--person', 'person-r', '--format', 'scroll', '--out', storyDir], {
      cwd,
      io: initIo.io,
    });

    const okFetch: typeof fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith('/publish')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          stories: [
            {
              id: 'story-1',
              slug: 'remote-slug',
              personId: 'person-r',
              title: 'Remote Story',
              summary: 'Remote',
              format: 'scroll',
              beatCount: 2,
              citationCount: 1,
              publishedAt: '2026-11-28T00:00:00.000Z',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const pubIo = createMemoryIo();
    expect(
      await runCli(['stories', 'publish', storyDir, '--site', 'https://archive.example', '--token', 't'], {
        cwd,
        io: pubIo.io,
        fetchImpl: okFetch,
      })
    ).toBe(EXIT_OK);

    const listIo = createMemoryIo();
    expect(
      await runCli(
        ['stories', 'list', '--site', 'https://archive.example', '--person', 'person-r', '--token', 't'],
        { cwd, io: listIo.io, fetchImpl: okFetch }
      )
    ).toBe(EXIT_OK);
    expect(listIo.out.join('\n')).toContain('remote-slug');

    const failFetch: typeof fetch = (async () => new Response('fail', { status: 500 })) as typeof fetch;
    const errPub = createMemoryIo();
    expect(
      await runCli(['stories', 'publish', storyDir, '--site', 'https://archive.example'], {
        cwd,
        io: errPub.io,
        fetchImpl: failFetch,
      })
    ).toBe(EXIT_ERROR);

    const errList = createMemoryIo();
    expect(
      await runCli(['stories', 'list', '--site', 'https://archive.example'], {
        cwd,
        io: errList.io,
        fetchImpl: failFetch,
      })
    ).toBe(EXIT_ERROR);
  });
});
