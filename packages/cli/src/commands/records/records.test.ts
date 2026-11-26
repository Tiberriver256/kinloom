import { execFileSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpsIo, TelemetryEvent } from '../ops/telemetry.js';
import {
  RECORD_COMMAND_ALIASES,
  RECORD_COMMAND_SPECS,
  buildTelemetrySubcmd,
  classifyRecordCommandIntent,
  formatRecordCommandsHelp,
  isRecordCommand,
  parseSkillDocument,
  renderRecordCommandHelp,
  resolveRecordCommand,
  resolveRecordGuidePath,
  resolveRecordScriptPath,
  resolveScriptInvocation,
  rewriteSkillCommandExamples,
  runRecordCommand,
  type RecordSpawnFn,
} from './index.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'skills');
const ASSETS_ROOT = path.join(CLI_PKG_ROOT, 'assets');
const BUNDLE_SCRIPT = path.join(CLI_PKG_ROOT, 'scripts', 'bundle-skills.mjs');

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: OpsIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    stdout,
    stderr,
  };
}

interface FakeSpawnCall {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv | undefined;
}

function createFakeSpawn(response: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
}): { spawnImpl: RecordSpawnFn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  const spawnImpl: RecordSpawnFn = (command, args, options) => {
    calls.push({ command, args: [...args], env: options.env });
    const child = new EventEmitter() as ChildProcess;
    const outStream = new PassThrough();
    const errStream = new PassThrough();
    (child as unknown as { stdout: PassThrough }).stdout = outStream;
    (child as unknown as { stderr: PassThrough }).stderr = errStream;
    (child as unknown as { killed: boolean }).killed = false;
    child.kill = () => {
      (child as unknown as { killed: boolean }).killed = true;
      return true;
    };

    queueMicrotask(() => {
      if (response.errorCode) {
        const err = new Error(`spawn ${command} ${response.errorCode}`) as NodeJS.ErrnoException;
        err.code = response.errorCode;
        child.emit('error', err);
        return;
      }
      if (response.stdout) {
        outStream.write(response.stdout);
      }
      outStream.end();
      if (response.stderr) {
        errStream.write(response.stderr);
      }
      errStream.end();
      child.emit('close', response.exitCode ?? 0, null);
    });

    return child;
  };
  return { spawnImpl, calls };
}

afterEach(async () => {
  delete process.env.KINLOOM_TELEMETRY_FILE;
  delete process.env.KINLOOM_TELEMETRY_PARENT;
  delete process.env.KINLOOM_TELEMETRY_ACTIVE;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('record command registry and discovery', () => {
  it('registers all 20 skills on disk plus prep-scan and ocr with zero missing files', () => {
    const skillDirsOnDisk = fs
      .readdirSync(SKILLS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const registeredSkillDirs = RECORD_COMMAND_SPECS.filter(
      (spec) => spec.kind === 'skill-script' || spec.kind === 'skill-guide'
    )
      .map((spec) => spec.skillDir)
      .sort();

    expect(skillDirsOnDisk).toHaveLength(20);
    expect(registeredSkillDirs).toEqual(skillDirsOnDisk);
    expect(RECORD_COMMAND_SPECS).toHaveLength(22);

    for (const spec of RECORD_COMMAND_SPECS) {
      const guidePath = resolveRecordGuidePath(spec);
      expect(fs.statSync(guidePath).isFile()).toBe(true);
      if (spec.kind !== 'skill-guide') {
        const scriptPath = resolveRecordScriptPath(spec);
        expect(fs.statSync(scriptPath).isFile()).toBe(true);
      }
    }
  });

  it('resolves aliases including ia -> archive-org and rejects unknown commands', () => {
    expect(RECORD_COMMAND_ALIASES).toEqual({ ia: 'archive-org' });
    expect(isRecordCommand('ia')).toBe(true);
    expect(isRecordCommand('archive-org')).toBe(true);
    expect(isRecordCommand('prep-scan')).toBe(true);
    expect(isRecordCommand('ocr')).toBe(true);
    expect(isRecordCommand('blm-glo')).toBe(true);
    expect(isRecordCommand('cyndis-list')).toBe(true);
    expect(isRecordCommand('not-a-command')).toBe(false);

    const iaSpec = resolveRecordCommand('ia');
    expect(iaSpec?.command).toBe('archive-org');
    expect(resolveRecordCommand('not-a-command')).toBeUndefined();
  });
});

describe('SKILL.md frontmatter parsing, invocation rewriting, and help rendering', () => {
  it('strips YAML frontmatter and extracts metadata fields', () => {
    const sample = `---
name: sample-skill
description: Search sample records cleanly.
---

# Sample Heading

Body text here.`;
    const parsed = parseSkillDocument(sample);
    expect(parsed.frontmatter).toEqual({
      name: 'sample-skill',
      description: 'Search sample records cleanly.',
    });
    expect(parsed.body).toBe('# Sample Heading\n\nBody text here.');
  });

  it('rewrites legacy script paths into copy-paste kinloom commands', () => {
    const ukSpec = resolveRecordCommand('uk-archives')!;
    const ukSample = [
      'uv run --script skills/uk-archives/scripts/uk-archives discovery search Lincoln',
      'skills/uk-archives/scripts/uk-archives url --freereg',
      './scripts/uk-archives freereg search --surname Lincoln',
      '## Bundled CLI (`scripts/uk-archives`)',
    ].join('\n');
    expect(rewriteSkillCommandExamples(ukSample, ukSpec)).toBe(
      [
        'kinloom uk-archives discovery search Lincoln',
        'kinloom uk-archives url --freereg',
        'kinloom uk-archives freereg search --surname Lincoln',
        '## Bundled CLI (`kinloom uk-archives`)',
      ].join('\n')
    );

    const audioSpec = resolveRecordCommand('narrative-audio')!;
    expect(
      rewriteSkillCommandExamples('CLI=skills/narrative-audio/scripts/narrative-audio', audioSpec)
    ).toBe('CLI="kinloom narrative-audio"');

    const prepSpec = resolveRecordCommand('prep-scan')!;
    expect(
      rewriteSkillCommandExamples('python3 scripts/prep-scan.py preview a.jpg --out-dir out', prepSpec)
    ).toBe('kinloom prep-scan preview a.jpg --out-dir out');

    const ocrSpec = resolveRecordCommand('ocr')!;
    expect(
      rewriteSkillCommandExamples('python3 scripts/cached-ocr.py scan.jpg --mode cursive', ocrSpec)
    ).toBe('kinloom ocr scan.jpg --mode cursive');
  });

  it('renders clean SKILL.md help for every registered command with frontmatter stripped', () => {
    for (const spec of RECORD_COMMAND_SPECS) {
      const rendered = renderRecordCommandHelp(spec);
      expect(rendered.startsWith('---')).toBe(false);
      expect(rendered.startsWith('# ')).toBe(true);
      if (spec.kind === 'skill-script') {
        expect(rendered).not.toContain(`skills/${spec.skillDir}/scripts/${spec.scriptName}`);
        expect(rendered).toContain(`kinloom ${spec.command}`);
        expect(rendered).toContain(`kinloom ${spec.command} --script-help`);
      }
    }

    const iaHelp = renderRecordCommandHelp('ia');
    expect(iaHelp).toContain('# Archive.org');
    expect(iaHelp).toContain('kinloom archive-org grep ');
    expect(iaHelp).toContain('Aliases: kinloom ia');
  });

  it('formats a grouped help catalog containing all 22 commands', () => {
    const catalog = formatRecordCommandsHelp();
    expect(catalog).toContain('Federal & general record archives:');
    expect(catalog).toContain('State archives:');
    expect(catalog).toContain('International archives:');
    expect(catalog).toContain('Research directories & guides:');
    expect(catalog).toContain('Media, scan prep & OCR:');
    expect(catalog).toContain('archive-org');
    expect(catalog).toContain('(alias: ia)');
    expect(catalog).toContain('blm-glo');
    expect(catalog).toContain('(guide)');
    expect(catalog).toContain('cyndis-list');
    expect(catalog).toContain('prep-scan');
    expect(catalog).toContain('ocr');

    for (const spec of RECORD_COMMAND_SPECS) {
      expect(catalog).toContain(`  ${spec.command}  `);
    }
  });
});

describe('help vs subcommand routing and guide-only commands', () => {
  it('routes top-level --help/-h to guide, --script-help to raw --help, and subcommand --help to script', () => {
    const archiveSpec = resolveRecordCommand('ia')!;
    expect(classifyRecordCommandIntent(archiveSpec, ['--help'])).toEqual({ mode: 'render-guide' });
    expect(classifyRecordCommandIntent(archiveSpec, ['-h'])).toEqual({ mode: 'render-guide' });
    expect(classifyRecordCommandIntent(archiveSpec, ['--script-help'])).toEqual({
      mode: 'exec-script',
      scriptArgs: ['--help'],
    });
    expect(classifyRecordCommandIntent(archiveSpec, ['grep', '--help'])).toEqual({
      mode: 'exec-script',
      scriptArgs: ['grep', '--help'],
    });

    const blmSpec = resolveRecordCommand('blm-glo')!;
    expect(classifyRecordCommandIntent(blmSpec, [])).toEqual({ mode: 'render-guide' });
    expect(classifyRecordCommandIntent(blmSpec, ['--help'])).toEqual({ mode: 'render-guide' });
  });

  it('renders guide and exits 0 for blm-glo and cyndis-list without spawning', async () => {
    const tmp = await makeTempDir('kinloom-records-guide-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const { spawnImpl, calls } = createFakeSpawn({ exitCode: 0 });

    for (const cmd of ['blm-glo', 'cyndis-list']) {
      const { io, stdout, stderr } = createCaptureIo();
      const result = await runRecordCommand(cmd, [], {
        io,
        spawnImpl,
        telemetryFilePath: telemetryFile,
      });
      expect(result.exitCode).toBe(0);
      expect(result.mode).toBe('guide');
      expect(stderr).toEqual([]);
      expect(stdout.join('\n')).toContain(cmd === 'blm-glo' ? '# BLM GLO Records' : "# Cyndi's List");
    }

    expect(calls).toHaveLength(0);
  });

  it('passes subcommand --help through to child process and sets telemetry suppression env', async () => {
    const tmp = await makeTempDir('kinloom-records-passthrough-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const { io, stdout, stderr } = createCaptureIo();
    const { spawnImpl, calls } = createFakeSpawn({
      exitCode: 0,
      stdout: 'usage: archive-org grep ...\n',
    });

    const result = await runRecordCommand('ia', ['grep', '--help'], {
      io,
      spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    expect(result.command).toBe('archive-org');
    expect(result.mode).toBe('script');
    expect(result.exitCode).toBe(0);
    expect(stdout).toEqual(['usage: archive-org grep ...']);
    expect(stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('python3');
    expect(calls[0].args.slice(-2)).toEqual(['grep', '--help']);
    expect(calls[0].env?.KINLOOM_TELEMETRY_ACTIVE).toBe('1');
    expect(calls[0].env?.KINLOOM_TELEMETRY_PARENT).toBe('1');

    const lines = (await readFile(telemetryFile, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as TelemetryEvent;
    expect(event.cmd).toBe('records:archive-org');
    expect(event.subcmd).toBe('archive-org grep');
    expect(event.exit_code).toBe(0);
    expect(event.bytes_out).toBe('usage: archive-org grep ...\n'.length);
  });

  it('preserves non-zero exit codes, handles ENOENT errors, and honors parent telemetry suppression', async () => {
    const tmp = await makeTempDir('kinloom-records-errors-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');

    const failCapture = createCaptureIo();
    const failSpawn = createFakeSpawn({ exitCode: 3, stderr: 'bad query\n' });
    const failResult = await runRecordCommand('nara', ['search', 'bad'], {
      io: failCapture.io,
      spawnImpl: failSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(failResult.exitCode).toBe(3);
    expect(failCapture.stderr).toEqual(['bad query']);
    expect(failSpawn.calls[0].command).toBe('uv');
    expect(failSpawn.calls[0].args.slice(0, 2)).toEqual(['run', '--script']);

    const enoentCapture = createCaptureIo();
    const enoentSpawn = createFakeSpawn({ errorCode: 'ENOENT' });
    process.env.KINLOOM_TELEMETRY_PARENT = '1';
    const enoentResult = await runRecordCommand('nara', ['search', 'Lincoln'], {
      io: enoentCapture.io,
      spawnImpl: enoentSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(enoentResult.exitCode).toBe(1);
    expect(enoentCapture.stderr[0]).toContain("'uv' is required to run 'kinloom nara'");

    // Only the first call was logged because the second had KINLOOM_TELEMETRY_PARENT=1.
    const events = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events).toHaveLength(1);
    expect(events[0].exit_code).toBe(3);
  });

  it('logs ocr telemetry subcmd by mode without leaking private file paths', async () => {
    const tmp = await makeTempDir('kinloom-ocr-telemetry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const secretPath = '/some/secret/private-scan-1890.jpg';

    const cursiveSpawn = createFakeSpawn({ exitCode: 0, stdout: '{"text":"ok"}\n' });
    const cursiveRes = await runRecordCommand('ocr', [secretPath, '--mode', 'cursive', '--json'], {
      io: createCaptureIo().io,
      spawnImpl: cursiveSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(cursiveRes.exitCode).toBe(0);

    const printedEqSpawn = createFakeSpawn({ exitCode: 0, stdout: 'ok\n' });
    await runRecordCommand('ocr', [secretPath, '--mode=printed'], {
      io: createCaptureIo().io,
      spawnImpl: printedEqSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    const defaultModeSpawn = createFakeSpawn({ exitCode: 0, stdout: 'ok\n' });
    await runRecordCommand('ocr', [secretPath], {
      io: createCaptureIo().io,
      spawnImpl: defaultModeSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    const scriptHelpSpawn = createFakeSpawn({ exitCode: 0, stdout: 'Usage: kinloom ocr\n' });
    await runRecordCommand('ocr', ['--script-help'], {
      io: createCaptureIo().io,
      spawnImpl: scriptHelpSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    const rawTelemetry = await readFile(telemetryFile, 'utf8');
    expect(rawTelemetry).not.toContain(secretPath);
    expect(rawTelemetry).not.toContain('private-scan');

    const events = rawTelemetry
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.subcmd)).toEqual([
      'ocr cursive',
      'ocr printed',
      'ocr printed',
      'ocr',
    ]);

    // General path-leak guard for every record command.
    const prepSpec = resolveRecordCommand('prep-scan')!;
    expect(buildTelemetrySubcmd(prepSpec, ['/abs/private/scan.jpg'], 'script')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['C:\\private\\scan.jpg'], 'script')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['./local-scan.png'], 'script')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['preview', '/abs/private/scan.jpg'], 'script')).toBe(
      'prep-scan preview'
    );
  });
});

describe('bundle-skills.mjs and dual-mode bundled resolution', () => {
  it('bundles all 20 skills and 4 assets into a temp dist dir with executable script bits', async () => {
    const tmpOut = await makeTempDir('kinloom-bundle-test-');
    const cliStubPath = path.join(tmpOut, 'cli.js');
    await writeFile(cliStubPath, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o644 });
    const output = execFileSync(process.execPath, [BUNDLE_SCRIPT, '--out-dir', tmpOut], {
      encoding: 'utf8',
    });
    expect(output).toContain('Bundled 20 skills (18 scripts, 1 references) and 4 assets');
    expect(fs.statSync(cliStubPath).mode & 0o111).not.toBe(0);

    const fakeDistModuleDir = path.join(tmpOut, 'commands', 'records');

    for (const spec of RECORD_COMMAND_SPECS) {
      const guidePath = resolveRecordGuidePath(spec, { moduleDir: fakeDistModuleDir });
      expect(guidePath.startsWith(tmpOut)).toBe(true);
      expect(fs.statSync(guidePath).isFile()).toBe(true);

      if (spec.kind !== 'skill-guide') {
        const scriptPath = resolveRecordScriptPath(spec, { moduleDir: fakeDistModuleDir });
        expect(scriptPath.startsWith(tmpOut)).toBe(true);
        const mode = fs.statSync(scriptPath).mode;
        expect(mode & 0o111).not.toBe(0);
      }
    }

    // Verify narrative-audio reference doc copied and __pycache__ skipped.
    expect(
      fs.existsSync(path.join(tmpOut, 'bundled-skills', 'narrative-audio', 'references', 'script-rules.md'))
    ).toBe(true);
    expect(
      fs.existsSync(path.join(tmpOut, 'bundled-skills', 'archive-org', 'scripts', '__pycache__'))
    ).toBe(false);
  });
});

describe('bundled Python utilities and live script execution', () => {
  it('runs prep-scan.py --help and cached-ocr.py --help cleanly via python3', () => {
    const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
    const ocrScript = path.join(ASSETS_ROOT, 'cached-ocr.py');

    const prepHelp = execFileSync('python3', [prepScript, '--help'], { encoding: 'utf8' });
    expect(prepHelp).toContain('kinloom prep-scan');
    expect(prepHelp).toContain('preview');
    expect(prepHelp).toContain('crop');
    expect(prepHelp).toContain('sheet-strip');
    expect(prepHelp).toContain('pdf-pages');
    expect(prepHelp).toContain('grid');
    expect(prepHelp).toContain('stitch');

    const ocrHelp = execFileSync('python3', [ocrScript, '--help'], { encoding: 'utf8' });
    expect(ocrHelp).toContain('Usage: kinloom ocr <image> [options]');
    expect(ocrHelp).toContain('--mode <printed|cursive>');
    expect(ocrHelp).toContain('KINLOOM_OCR_CACHE_DIR');
    expect(ocrHelp).toContain('KINLOOM_OCR_CLI');
  });

  it('serves cached OCR result from SHA-256 disk cache without invoking external binaries', async () => {
    const tmp = await makeTempDir('kinloom-ocr-cache-');
    const imgPath = path.join(tmp, 'sample.png');
    const cacheDir = path.join(tmp, 'cache');
    const payloadBytes = Buffer.from('synthetic-scan-bytes-for-hash-test');
    await writeFile(imgPath, payloadBytes);

    const sha256 = crypto.createHash('sha256').update(payloadBytes).digest('hex');
    fs.mkdirSync(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, `${sha256}_printed_psm6.json`),
      JSON.stringify({
        sha256,
        mode: 'printed_psm6',
        engine: 'tesseract',
        created_at: '2026-11-25T00:00:00Z',
        elapsed_ms: 12,
        text: 'Springfield Probate Docket 1862',
        source_hint: 'sample.png',
        meta: { psm: 6 },
      })
    );

    const { io, stdout, stderr } = createCaptureIo();
    const result = await runRecordCommand('ocr', [imgPath, '--cache-dir', cacheDir, '--json'], {
      io,
      telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join('\n')) as { cached: boolean; text: string; sha256: string };
    expect(parsed.cached).toBe(true);
    expect(parsed.text).toBe('Springfield Probate Docket 1862');
    expect(parsed.sha256).toBe(sha256);
  });

  it('runs real archive-org --script-help via python3 shebang detection', async () => {
    const tmp = await makeTempDir('kinloom-ia-live-');
    const spec = resolveRecordCommand('ia')!;
    const scriptPath = resolveRecordScriptPath(spec as Extract<typeof spec, { kind: 'skill-script' }>);
    expect(resolveScriptInvocation(scriptPath, ['--help'])).toEqual({
      command: 'python3',
      args: ['-S', scriptPath, '--help'],
    });

    const { io, stdout, stderr } = createCaptureIo();
    const result = await runRecordCommand('ia', ['--script-help'], {
      io,
      telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('grep');
    expect(stdout.join('\n')).toContain('page');
  });

  it('forces OMP_THREAD_LIMIT=1 and enforces --timeout on tesseract subprocesses', async () => {
    const tmp = await makeTempDir('kinloom-ocr-hardening-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'scan.png');
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(imgPath, Buffer.from('synthetic-printed-scan'));

    const fakeTesseract = path.join(binDir, 'tesseract');
    await writeFile(
      fakeTesseract,
      '#!/bin/sh\necho "OMP=$OMP_THREAD_LIMIT"\n',
      { mode: 0o755 }
    );

    const envWithHighOmp: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OMP_THREAD_LIMIT: '28',
    };

    const okCapture = createCaptureIo();
    const okResult = await runRecordCommand(
      'ocr',
      [imgPath, '--cache-dir', cacheDir, '--timeout', '10', '--json'],
      {
        io: okCapture.io,
        env: envWithHighOmp,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      }
    );

    expect(okResult.exitCode).toBe(0);
    const parsed = JSON.parse(okCapture.stdout.join('\n')) as {
      text: string;
      meta: { omp_thread_limit: number; timeout_s: number };
    };
    expect(parsed.text).toBe('OMP=1');
    expect(parsed.meta.omp_thread_limit).toBe(1);
    expect(parsed.meta.timeout_s).toBe(10);

    // Invalid --timeout values must be rejected with usage exit code 2.
    const badTimeoutCapture = createCaptureIo();
    const badTimeoutResult = await runRecordCommand(
      'ocr',
      [imgPath, '--cache-dir', cacheDir, '--timeout', '0'],
      {
        io: badTimeoutCapture.io,
        env: envWithHighOmp,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      }
    );
    expect(badTimeoutResult.exitCode).toBe(2);
    expect(badTimeoutCapture.stderr.join('\n')).toContain('positive integer');

    // Slow tesseract must fail fast when --timeout expires.
    await writeFile(fakeTesseract, '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
    const timeoutCapture = createCaptureIo();
    const t0 = Date.now();
    const timeoutResult = await runRecordCommand(
      'ocr',
      [imgPath, '--cache-dir', cacheDir, '--force', '--timeout', '1'],
      {
        io: timeoutCapture.io,
        env: envWithHighOmp,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      }
    );
    const elapsedMs = Date.now() - t0;
    expect(timeoutResult.exitCode).toBe(1);
    expect(elapsedMs).toBeLessThan(8000);
    expect(timeoutCapture.stderr.join('\n')).toContain('timed out after 1s');
  });

  it('runs prep-scan grid and prep-scan stitch on a synthetic image when Pillow is available', async () => {
    const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
    let pyCmd: string | null = null;
    let pyPrefix: string[] = [];
    let prepPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
      pyCmd = 'python3';
      pyPrefix = [];
      prepPrefix = [prepScript];
    } catch {
      try {
        execFileSync('uv', ['run', '--with', 'pillow', 'python3', '-c', 'import PIL'], {
          stdio: 'ignore',
        });
        pyCmd = 'uv';
        pyPrefix = ['run', '--with', 'pillow', 'python3'];
        prepPrefix = ['run', '--script', prepScript];
      } catch {
        pyCmd = null;
      }
    }
    if (!pyCmd) {
      return;
    }

    const tmp = await makeTempDir('kinloom-prep-grid-stitch-');
    const srcImg = path.join(tmp, 'synthetic-sheet.png');
    const gridOut = path.join(tmp, 'grid.jpg');
    const stitchOut = path.join(tmp, 'stitched.jpg');

    // Generate a 2000x1200 light-cream synthetic sheet with colored marker stripes.
    execFileSync(pyCmd, [
      ...pyPrefix,
      '-c',
      [
        'from PIL import Image, ImageDraw',
        'import sys',
        'im = Image.new("RGB", (2000, 1200), (248, 244, 232))',
        'd = ImageDraw.Draw(im)',
        'd.rectangle((0, 0, 1999, 180), fill=(210, 225, 240))',
        'd.rectangle((0, 700, 1999, 960), fill=(225, 240, 215))',
        'im.save(sys.argv[1])',
      ].join('\n'),
      srcImg,
    ]);

    const gridStdout = execFileSync(
      pyCmd,
      [...prepPrefix, 'grid', srcImg, gridOut, '--step', '200', '--max-width', '1000', '--max-kb', '200'],
      { encoding: 'utf8', env: { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' } }
    );
    const gridMeta = JSON.parse(gridStdout) as {
      original_width: number;
      original_height: number;
      preview_width: number;
      preview_height: number;
      step: number;
      bytes: number;
      out: string;
    };
    expect(gridMeta.original_width).toBe(2000);
    expect(gridMeta.original_height).toBe(1200);
    expect(gridMeta.preview_width).toBeLessThanOrEqual(1000);
    expect(gridMeta.preview_height).toBeLessThanOrEqual(600);
    expect(gridMeta.step).toBe(200);
    expect(gridMeta.out).toBe(gridOut);
    expect(fs.statSync(gridOut).size).toBeLessThanOrEqual(200 * 1024);

    // Stitch header band (width 1800, height 160) + household band (width 1600, height 220) with redaction and 8px gap.
    const stitchStdout = execFileSync(
      pyCmd,
      [
        ...prepPrefix,
        'stitch',
        srcImg,
        stitchOut,
        '--box',
        '100,20,1900,180',
        '--box',
        '200,720,1800,940',
        '--redact',
        '250,750,600,830',
        '--gap',
        '8',
        '--divider-color',
        '#222222',
        '--quality',
        '90',
      ],
      { encoding: 'utf8', env: { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' } }
    );
    const stitchMeta = JSON.parse(stitchStdout) as {
      width: number;
      height: number;
      bytes: number;
      bands: Array<{ box: number[]; width: number; height: number; y_offset: number }>;
      out: string;
    };
    expect(stitchMeta.width).toBe(1800);
    expect(stitchMeta.height).toBe(160 + 8 + 220);
    expect(stitchMeta.bytes).toBeGreaterThan(0);
    expect(stitchMeta.bands).toHaveLength(2);
    expect(stitchMeta.bands[0]).toMatchObject({ width: 1800, height: 160, y_offset: 0 });
    expect(stitchMeta.bands[1]).toMatchObject({ width: 1600, height: 220, y_offset: 168 });
    expect(stitchMeta.out).toBe(stitchOut);

    // Verify actual image dimensions, dark divider band, and redacted black region inside band #2.
    const pixelCheck = execFileSync(
      pyCmd,
      [
        ...pyPrefix,
        '-c',
        [
          'from PIL import Image',
          'import json, sys',
          'im = Image.open(sys.argv[1])',
          '# Divider pixel at y=164 (middle of 8px gap) should be dark (#222222 -> ~34)',
          'div_px = im.getpixel((900, 164))',
          '# Band #2 is centered at x_offset=100, y_offset=168; original redact (250,750)-(600,830) maps to band x=50..400, y=30..110 -> canvas x=150..500, y=198..278',
          'red_px = im.getpixel((300, 230))',
          'print(json.dumps({"size": list(im.size), "div": list(div_px), "red": list(red_px)}))',
        ].join('\n'),
        stitchOut,
      ],
      { encoding: 'utf8' }
    );
    const pixels = JSON.parse(pixelCheck) as { size: number[]; div: number[]; red: number[] };
    expect(pixels.size).toEqual([1800, 388]);
    expect(Math.max(...pixels.div)).toBeLessThan(55);
    expect(Math.max(...pixels.red)).toBeLessThan(20);
  });
});
