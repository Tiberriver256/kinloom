import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { kinloomOxlintPlugin } from './archive-count-rule.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const CHECKER_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-archive-counts.mjs');

interface CountDiagnostic {
  code?: string;
  message?: string;
  line?: number;
  column?: number;
}

interface CountCheckResult {
  exitCode: number;
  diagnostics: CountDiagnostic[];
  stderr: string;
}

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function runArchiveCountCheck(testFileSource: string): Promise<CountCheckResult> {
  const dir = await makeTempDir('kinloom-count-check-');
  const targetPath = path.join(dir, 'archive.test.ts');
  await writeFile(targetPath, testFileSource, 'utf8');

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CHECKER_SCRIPT, '--json', targetPath], {
      cwd: REPO_ROOT,
    });
    const parsed = JSON.parse(stdout) as { diagnostics?: CountDiagnostic[] };
    return {
      exitCode: 0,
      diagnostics: parsed.diagnostics ?? [],
      stderr,
    };
  } catch (err: unknown) {
    const execErr = err as { code?: number | string; stdout?: string; stderr?: string };
    const stdout = execErr.stdout ?? '';
    let parsed: { diagnostics?: CountDiagnostic[] } = {};
    if (stdout.trim().startsWith('{')) {
      parsed = JSON.parse(stdout) as { diagnostics?: CountDiagnostic[] };
    } else if (stdout.trim().length > 0) {
      throw new Error(`check-archive-counts failed before JSON output: ${stdout}\n${execErr.stderr ?? ''}`);
    }
    return {
      exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
      diagnostics: parsed.diagnostics ?? [],
      stderr: execErr.stderr ?? '',
    };
  }
}

describe('kinloom/no-hardcoded-archive-counts rule', () => {
  it('flags hardcoded positive archive counts across collections, .length, and meta.counts', async () => {
    const badCode = `
declare const expect: any;
declare const bundle: any;
declare const publicBundle: any;
declare const privateBundle: any;
declare const result: any;
declare const res: any;
declare const publicResult: any;
declare const privateResult: any;
declare const archive: any;
declare const snapshot: any;
declare const compiled: any;

expect(bundle.media).toHaveLength(126);
expect(bundle.narratives).toHaveLength(20);
expect(publicBundle.people.length).toBe(35);
expect(privateBundle.events).toHaveLength(235);
expect(bundle.meta.counts.living_redacted).toBe(4);
expect(result.bundle.places.length).toEqual(12);
expect(res.bundle.sources.length).toStrictEqual(9);
expect(publicResult.bundle.kinship).toHaveLength(40);
expect(privateResult.bundle.residence_spans).toHaveLength(18);
expect(archive.entities).toHaveLength(5);
expect(snapshot.people).toHaveLength(10);
expect(compiled.narratives ?? []).toHaveLength(7);
expect((bundle.media ?? []).length).toBe(3);
expect(bundle.media?.length).toBe(4);
expect(bundle.meta.counts.media ?? 0).toEqual(8);
expect(bundle.meta.counts).toEqual({ people: 35, events: 235, living_redacted: 0 });
expect(bundle.meta.counts).toMatchObject({ narratives: 20 });
expect(bundle.meta).toMatchObject({ counts: { sources: 14 } });
expect.soft(bundle.people).toHaveLength(54);
`;

    const result = await runArchiveCountCheck(badCode);
    const ruleDiagnostics = result.diagnostics.filter(
      (d) => d.code === 'kinloom(no-hardcoded-archive-counts)'
    );

    expect(result.exitCode).toBe(1);
    expect(ruleDiagnostics).toHaveLength(20);
    expect(ruleDiagnostics.every((d) => d.message?.includes('change-detector'))).toBe(true);
    expect(ruleDiagnostics.some((d) => d.message?.includes('media === 126'))).toBe(true);
    expect(ruleDiagnostics.some((d) => d.message?.includes('narratives === 20'))).toBe(true);
    expect(ruleDiagnostics.some((d) => d.message?.includes('people.length === 35'))).toBe(true);
    expect(ruleDiagnostics.some((d) => d.message?.includes('meta.counts.living_redacted === 4'))).toBe(true);
    expect(ruleDiagnostics.some((d) => d.message?.includes('meta.counts.living_redacted === 0'))).toBe(false);
  });

  it('allows zero invariants, data-derived expressions, non-empty checks, and non-archive arrays', async () => {
    const goodCode = `
declare const expect: any;
declare const bundle: any;
declare const expectedPublicMedia: any[];
declare const rawPeople: any[];
declare const livingPerson: any;
declare const leaks: any[];
declare const ports: any;
declare const person: any;
declare const items: any[];

expect(bundle.media).toHaveLength(expectedPublicMedia.length);
expect(bundle.media.length).toBeGreaterThan(0);
expect(bundle.media.length).toBeGreaterThanOrEqual(1);
expect(bundle.residence_spans).toHaveLength(0);
expect(livingPerson.residence_spans).toHaveLength(0);
expect(leaks).toHaveLength(0);
expect(bundle.people.length).toBe(0);
expect(bundle.meta.counts.living_redacted).toBe(0);
expect(bundle.meta.counts.people).toBe(bundle.people.length);
expect(bundle.meta.counts).toEqual({ people: rawPeople.length, living_redacted: 0 });
expect(bundle.meta.counts).toMatchObject({ living_redacted: 0 });
expect(bundle.narratives.every((n: { source_ids: string[] }) => n.source_ids.length > 0)).toBe(true);
expect(bundle.media).not.toHaveLength(0);
expect(bundle.meta.build_mode).toBe('public');
expect(bundle.meta.max_revision_id).toBe(7);
expect(ports.bundleCache.rebuildCount).toBe(1);
expect(items).toHaveLength(3);
expect(person.events).toHaveLength(2);
`;

    const result = await runArchiveCountCheck(goodCode);
    expect(result.exitCode).toBe(0);
    expect(result.diagnostics).toEqual([]);
  });

  it('exports the canonical plugin metadata and rule definition', () => {
    expect(kinloomOxlintPlugin.meta.name).toBe('kinloom');
    expect(kinloomOxlintPlugin.rules['no-hardcoded-archive-counts'].meta.type).toBe('problem');
  });
});
