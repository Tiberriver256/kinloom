import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyVersionFiles,
  buildReleaseNotes,
  classifyCommit,
  listPackageJsons,
  parseCommitMessage,
  planRelease,
  renderNotes,
  rewritePackageJson,
  rewriteSource,
  verifyRelease,
} from './release-version.mjs';

const scriptPath = path.resolve('scripts/release-version.mjs');
const repoRoot = path.resolve('.');

const serverRule = {
  path: 'packages/server/src/index.ts',
  pattern: /export const KINLOOM_SERVER_VERSION = '(\d+\.\d+\.\d+)';/g,
  replace(version: string) {
    return `export const KINLOOM_SERVER_VERSION = '${version}';`;
  },
};

function sample(subject: string, body = '') {
  return classifyCommit({
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    authorName: 'Release Tester',
    subject,
    body,
  });
}

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(message: string) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'kinloom-release-'));
  git(cwd, ['init', '-b', 'main']);
  git(cwd, ['config', 'user.email', 'dev@example.com']);
  git(cwd, ['config', 'user.name', 'Release Tester']);
  git(cwd, ['config', 'commit.gpgsign', 'false']);
  git(cwd, ['config', 'tag.gpgSign', 'false']);
  writeFileSync(path.join(cwd, 'README.md'), 'synthetic\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['commit', '-m', 'chore: init']);
  git(cwd, ['tag', 'v0.2.0']);
  git(cwd, ['commit', '--allow-empty', '-m', message]);
  return cwd;
}

describe('conventional commit planning', () => {
  it('bumps a feat on 0.2.0 to minor 0.3.0 and keeps a fix at patch', () => {
    const feat = planRelease({
      current: '0.2.0',
      commits: [sample('fix(worker): surface rejection'), sample('feat(cli): add dates')],
      bump: 'auto',
    });
    expect(feat).toMatchObject({
      shouldRelease: true,
      version: '0.3.0',
      tag: 'v0.3.0',
      bump: 'minor',
      reason: 'conventional minor',
    });

    const fix = planRelease({
      current: '0.2.0',
      commits: [sample('fix(worker): surface rejection'), sample('perf(cli): cache scans')],
      bump: 'auto',
    });
    expect(fix).toMatchObject({
      shouldRelease: true,
      version: '0.2.1',
      tag: 'v0.2.1',
      bump: 'patch',
      reason: 'conventional patch',
    });
  });

  it('treats a breaking feat on 0.2.0 as major 1.0.0', () => {
    expect(parseCommitMessage('feat(cli)!: drop export', '').level).toBe('major');
    expect(parseCommitMessage('fix(worker): surface', 'BREAKING CHANGE: callers must handle it').level).toBe(
      'major',
    );
    expect(
      planRelease({
        current: '0.2.0',
        commits: [sample('feat!: drop export')],
        bump: 'auto',
      }),
    ).toMatchObject({ version: '1.0.0', bump: 'major', reason: 'conventional major' });
  });

  it('does not release docs or chore commits unless bump or force-version says so', () => {
    expect(parseCommitMessage('docs: update readme', '').level).toBe('none');
    expect(parseCommitMessage('ci: add release workflow', '').level).toBe('none');
    expect(parseCommitMessage('revert: undo export', '').level).toBe('patch');
    const skipped = planRelease({
      current: '0.2.0',
      commits: [sample('docs: update readme'), sample('chore(release): v0.2.0')],
      bump: 'auto',
    });
    expect(skipped).toMatchObject({
      shouldRelease: false,
      version: null,
      tag: null,
      reason: 'no releasable commits',
    });

    expect(
      planRelease({
        current: '0.2.0',
        commits: [sample('docs: update readme')],
        bump: 'patch',
      }),
    ).toMatchObject({ shouldRelease: true, version: '0.2.1', bump: 'patch', reason: 'explicit patch' });

    expect(
      planRelease({
        current: '0.2.0',
        commits: [sample('feat(cli): add dates')],
        forceVersion: '0.2.1',
      }),
    ).toMatchObject({ shouldRelease: true, version: '0.2.1', bump: null, reason: 'force-version' });
  });

  it('renders categorized notes with the short sha and author', () => {
    expect(
      renderNotes([
        sample('feat(cli,skills): add dates'),
        sample('fix: correct date'),
        sample('docs: update readme'),
      ]),
    ).toBe(
      [
        '## Features',
        '',
        '* **cli,skills:** add dates (aaaaaaa) by Release Tester',
        '',
        '## Bug Fixes',
        '',
        '* correct date (aaaaaaa) by Release Tester',
        '',
        '## Other',
        '',
        '* update readme (aaaaaaa) by Release Tester',
      ].join('\n'),
    );
  });

  it('builds release notes with GitHub logins and the compare link', () => {
    expect(
      buildReleaseNotes({
        notesMarkdown: '## Features\n\n* **cli:** add dates (abc1234) by Release Tester',
        logins: ['octocat', 'not a login', 'hubot'],
        compareUrl: 'https://github.com/example/kinloom/compare/v0.2.0...v0.3.0',
        generatedBody: '## New Contributors\n\n* @octocat made their first contribution',
      }),
    ).toBe(
      [
        '## Features',
        '',
        '* **cli:** add dates (abc1234) by Release Tester',
        '',
        '## GitHub contributors',
        '',
        '* @hubot',
        '* @octocat',
        '',
        '**Full Changelog**: https://github.com/example/kinloom/compare/v0.2.0...v0.3.0',
        '',
        '## New Contributors',
        '',
        '* @octocat made their first contribution',
        '',
      ].join('\n'),
    );
  });
});

describe('version files', () => {
  it('rewrites package versions and @kinloom ranges without touching other dependencies', () => {
    const input = `{
  "name": "@kinloom/ui",
  "version": "0.2.0",
  "dependencies": {
    "@kinloom/core": "^0.2.0",
    "@kinloom/tokens": "^0.2.0",
    "react": "^19.3.1"
  }
}
`;
    expect(rewritePackageJson(input, '0.3.0')).toBe(`{
  "name": "@kinloom/ui",
  "version": "0.3.0",
  "dependencies": {
    "@kinloom/core": "^0.3.0",
    "@kinloom/tokens": "^0.3.0",
    "react": "^19.3.1"
  }
}
`);
    expect(rewritePackageJson('{\n  "name": "@kinloom/demo",\n  "version": "0.2.0",\n  "dependencies": {\n    "@kinloom/core": "0.2.0"\n  }\n}\n', '0.2.1')).toContain(
      '"@kinloom/core": "0.2.1"',
    );
  });

  it('keeps a source file byte-stable when the version does not change', () => {
    const serverPath = 'packages/server/src/index.ts';
    const server = readFileSync(serverPath, 'utf8');
    const current = server.match(/KINLOOM_SERVER_VERSION = '(\d+\.\d+\.\d+)'/)?.[1];
    if (!current) throw new Error('missing KINLOOM_SERVER_VERSION');
    expect(rewriteSource(server, serverRule, current)).toBe(server);
    expect(rewriteSource(server, serverRule, '0.9.9')).toContain("KINLOOM_SERVER_VERSION = '0.9.9'");
  });

  it('lists the six packages and the demo', () => {
    expect(listPackageJsons(repoRoot)).toEqual([
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/server/package.json',
      'packages/tokens/package.json',
      'packages/ui/package.json',
      'packages/worker/package.json',
      'examples/demo/package.json',
    ]);
  });

  it('writes a fixture tree that verify accepts only at the bumped version', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'kinloom-version-'));
    try {
      const files: Record<string, string> = {
        'packages/tokens/package.json': '{\n  "name": "@kinloom/tokens",\n  "version": "0.2.0"\n}\n',
        'examples/demo/package.json':
          '{\n  "name": "@kinloom/demo",\n  "version": "0.2.0",\n  "dependencies": {\n    "@kinloom/tokens": "0.2.0"\n  }\n}\n',
        'packages/server/src/index.ts': "export const KINLOOM_SERVER_VERSION = '0.2.0';\n",
        'packages/worker/src/index.ts': "export const KINLOOM_WORKER_VERSION = '0.2.0';\n",
        'packages/cli/src/client.ts': "this.userAgent = options.userAgent ?? 'kinloom-cli/0.2.0';\n",
      };
      for (const [rel, text] of Object.entries(files)) {
        const full = path.join(root, rel);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, text);
      }
      expect(verifyRelease(root, '0.2.0')).toEqual([]);
      applyVersionFiles(root, '0.2.1');
      expect(verifyRelease(root, '0.2.1')).toEqual([]);
      expect(readFileSync(path.join(root, 'packages/cli/src/client.ts'), 'utf8')).toContain('kinloom-cli/0.2.1');
      const failed = spawnSync(process.execPath, [scriptPath, 'verify', '0.2.0'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain('packages/tokens/package.json version is 0.2.1');
      const passed = spawnSync(process.execPath, [scriptPath, 'verify', '0.2.1'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain('versions match 0.2.1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('next command', () => {
  it('reads commits since the tag and prints the minor plan as JSON', () => {
    const cwd = initRepo('feat(cli): add dates');
    try {
      const result = spawnSync(process.execPath, [scriptPath, 'next', '--json'], {
        cwd,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        should_release: boolean;
        version: string;
        tag: string;
        previous_tag: string;
        bump: string;
        policy: string;
        notes_markdown: string;
      };
      expect(payload).toMatchObject({
        should_release: true,
        version: '0.3.0',
        tag: 'v0.3.0',
        previous_tag: 'v0.2.0',
        previous_version: '0.2.0',
        bump: 'minor',
        reason: 'conventional minor',
        policy: 'standard-semver',
      });
      expect(payload.notes_markdown).toMatch(
        /^## Features\n\n\* \*\*cli:\*\* add dates \([0-9a-f]+\) by Release Tester$/,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exits 0 without a release when the only new commit is docs', () => {
    const cwd = initRepo('docs: update readme');
    try {
      const result = spawnSync(process.execPath, [scriptPath, 'next', '--json'], {
        cwd,
        encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        should_release: false,
        version: null,
        tag: null,
        reason: 'no releasable commits',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('accepts an explicit patch version from the force-version flag', () => {
    const cwd = initRepo('docs: update readme');
    try {
      const result = spawnSync(
        process.execPath,
        [scriptPath, 'next', '--json', '--force-version', '0.2.1'],
        { cwd, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        should_release: true,
        version: '0.2.1',
        tag: 'v0.2.1',
        reason: 'force-version',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
