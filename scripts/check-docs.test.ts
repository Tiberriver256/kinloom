import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkMarkdownLinks,
  checkSyntheticEmailDomains,
  extractHeadingSlugs,
  extractTypecheckSnippets,
  runDocsCheck,
  slugifyHeading,
  typecheckDocSnippets,
} from './check-docs.mjs';

const tempDirs: string[] = [];

function createTempRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinloom-check-docs-test-'));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('scripts/check-docs.mjs', () => {
  it('slugifies headings with GitHub-compatible duplicate suffixes and ignores fenced code blocks', () => {
    expect(slugifyHeading('1. Server plugins (`@kinloom/server` and `@kinloom/core`)')).toBe(
      '1-server-plugins-kinloomserver-and-kinloomcore'
    );
    expect(slugifyHeading('Overview & Setup')).toBe('overview--setup');

    const md = [
      '# Title',
      '## Setup',
      '```md',
      '## Fake Heading Inside Fence',
      '```',
      '## Setup',
      '## `plugin_migrations` table',
    ].join('\n');

    const slugs = extractHeadingSlugs(md);
    expect(slugs.has('title')).toBe(true);
    expect(slugs.has('setup')).toBe(true);
    expect(slugs.has('setup-1')).toBe(true);
    expect(slugs.has('plugin_migrations-table')).toBe(true);
    expect(slugs.has('fake-heading-inside-fence')).toBe(false);
  });

  it('validates relative file links and heading anchors while ignoring fenced and inline code', () => {
    const repoDir = createTempRepo({
      'README.md': [
        '# Home',
        'See [Guide](docs/guide.md#usage) and [Local](#home).',
        'Inline `[ignored](docs/does-not-exist.md)` stays ignored.',
        '```md',
        '[fenced-ignored](docs/missing-in-fence.md#nope)',
        '```',
        'External [site](https://example.org/docs) is skipped.',
      ].join('\n'),
      'docs/guide.md': ['# Guide', '## Usage', 'Back to [README](../README.md#home).'].join('\n'),
    });

    const violations = checkMarkdownLinks(repoDir, ['README.md', 'docs/guide.md']);
    expect(violations).toEqual([]);
  });

  it('flags broken relative file links and missing heading anchors with accurate line numbers', () => {
    const repoDir = createTempRepo({
      'README.md': [
        '# Home',
        'Bad file: [Missing](docs/missing.md)',
        'Bad anchor: [Guide](docs/guide.md#nonexistent-anchor)',
      ].join('\n'),
      'docs/guide.md': '# Guide\n## Real Section\n',
    });

    const violations = checkMarkdownLinks(repoDir, ['README.md', 'docs/guide.md']);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toMatchObject({
      rule: 'broken-relative-link',
      file: 'README.md',
      line: 2,
    });
    expect(violations[1]).toMatchObject({
      rule: 'broken-heading-anchor',
      file: 'README.md',
      line: 3,
    });
  });

  it('allows synthetic email domains and rejects real email domains in docs', () => {
    const repoDir = createTempRepo({
      'docs/ok.md': [
        'Allowed: steward@archive.example',
        'Allowed: steward@archive.example.test',
        'Allowed: demo@example.com',
        'Allowed: demo@example.org',
        'Allowed: 12345+bot@users.noreply.github.com',
        'Package scope @kinloom/core is not an email.',
      ].join('\n'),
      'docs/bad.md': ['Line one', 'Contact person@real-company.net for access.'].join('\n'),
    });

    expect(checkSyntheticEmailDomains(repoDir, ['docs/ok.md'])).toEqual([]);
    const bad = checkSyntheticEmailDomains(repoDir, ['docs/bad.md']);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({
      rule: 'non-synthetic-email-domain',
      file: 'docs/bad.md',
      line: 2,
    });
  });

  it('extracts ts and tsx kinloom-check fenced blocks with accurate start lines', () => {
    const md = [
      '# Example',
      '```ts',
      'const ignored = 1;',
      '```',
      '```ts kinloom-check',
      'export const a: number = 1;',
      '```',
      '```tsx kinloom-check',
      'export const view = () => null;',
      '```',
    ].join('\n');

    const snippets = extractTypecheckSnippets(md, 'docs/developers/sample.md');
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toEqual({
      file: 'docs/developers/sample.md',
      startLine: 6,
      lang: 'ts',
      code: 'export const a: number = 1;',
    });
    expect(snippets[1]).toEqual({
      file: 'docs/developers/sample.md',
      startLine: 9,
      lang: 'tsx',
      code: 'export const view = () => null;',
    });
  });

  it('passes full docs check and compiles live docs/developers kinloom-check snippets', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const result = runDocsCheck({ rootDir: repoRoot, typecheckSnippets: true });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.snippetCount).toBeGreaterThanOrEqual(4);
  });

  it('reports TypeScript errors mapped back to the originating markdown line', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..');
    const badRelPath = path.join('node_modules', '.cache', `bad-snippet-${process.pid}.md`);
    const badAbsPath = path.join(repoRoot, badRelPath);
    fs.mkdirSync(path.dirname(badAbsPath), { recursive: true });
    fs.writeFileSync(
      badAbsPath,
      ['# Broken Snippet', '', '```ts kinloom-check', 'const count: number = "not-a-number";', '```'].join(
        '\n'
      ),
      'utf8'
    );

    try {
      const result = typecheckDocSnippets(repoRoot, [badRelPath]);
      expect(result.snippetCount).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toMatchObject({
        rule: 'snippet-typecheck',
        file: badRelPath,
        line: 4,
      });
      expect(result.violations[0].message).toContain('TS2322');
    } finally {
      fs.rmSync(badAbsPath, { force: true });
    }
  });
});
