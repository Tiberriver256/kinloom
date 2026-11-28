import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import { EMBEDDED_GUIDES, resolveEmbeddedGuide } from '../../guides/index.js';
import type { OpsIo, TelemetryEvent } from '../ops/telemetry.js';
import {
  buildTelemetrySubcmd,
  classifyRecordCommandIntent,
  createSyntheticPng,
  formatRecordCommandsHelp,
  isRecordCommand,
  RECORD_COMMAND_ALIASES,
  RECORD_COMMAND_SPECS,
  renderRecordCommandHelp,
  resolveRecordCommand,
  runRecordCommand,
} from './index.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = path.resolve(THIS_DIR, '..', '..', '..');
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, '..', '..');
const COPY_MIGRATIONS_SCRIPT = path.join(CLI_PKG_ROOT, 'scripts', 'copy-migrations.mjs');
const WORKER_MIGRATIONS_DIR = path.join(REPO_ROOT, 'packages', 'worker', 'migrations');

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
  it('registers all 23 native TypeScript commands plus 2 embedded guide-only commands with zero legacy scripts', () => {
    const nativeCommands = RECORD_COMMAND_SPECS.filter((spec) => spec.kind === 'native')
      .map((spec) => spec.command)
      .sort();

    const guideOnlyCommands = RECORD_COMMAND_SPECS.filter((spec) => spec.kind === 'guide-only')
      .map((spec) => spec.command)
      .sort();

    expect(nativeCommands).toEqual([
      'archive-org',
      'ca-archives',
      'chronam',
      'fi-archives',
      'findagrave',
      'gnis',
      'hathi',
      'ky-archives',
      'michiganology',
      'mn-archives',
      'mo-archives',
      'nara',
      'narrative-audio',
      'nj-archives',
      'ocr',
      'openarchieven',
      'persi',
      'prep-scan',
      'se-archives',
      'texas-archives',
      'uk-archives',
      'va-archives',
      'wikitree',
    ]);
    expect(guideOnlyCommands).toEqual(['blm-glo', 'cyndis-list']);
    expect(RECORD_COMMAND_SPECS).toHaveLength(25);
    expect(EMBEDDED_GUIDES).toHaveLength(27);

    for (const spec of RECORD_COMMAND_SPECS) {
      const guide = resolveEmbeddedGuide(spec.command);
      expect(guide, `missing embedded guide for '${spec.command}'`).toBeDefined();
      expect(guide?.content.length).toBeGreaterThan(0);
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

describe('embedded guides and help rendering', () => {
  it('renders clean embedded help for every registered command with frontmatter stripped', () => {
    for (const spec of RECORD_COMMAND_SPECS) {
      const rendered = renderRecordCommandHelp(spec);
      expect(rendered.startsWith('---')).toBe(false);
      expect(rendered.startsWith('# ')).toBe(true);
      if (spec.kind === 'native') {
        expect(rendered).toContain(`kinloom ${spec.command}`);
        expect(rendered).toContain(`kinloom ${spec.command} --script-help`);
      }
    }

    const iaHelp = renderRecordCommandHelp('ia');
    expect(iaHelp).toContain('# Archive.org');
    expect(iaHelp).toContain('kinloom archive-org grep ');
    expect(iaHelp).toContain('Aliases: kinloom ia');
  });

  it('formats a grouped help catalog containing all 25 record commands', () => {
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

  it('serves kinloom guide [topic] and <cmd> --guide across all 26 guides and subguides', async () => {
    const listCap = createCaptureIo();
    const listCode = await runCli(['guide'], { io: listCap.io });
    expect(listCode).toBe(0);
    const listOut = listCap.stdout.join('\n');
    expect(listOut).toContain('pronounce');
    expect(listOut).toContain('narrative-audio/script-rules');
    expect(listOut).toContain('prep-scan');
    expect(listOut).toContain('ocr');

    const subCap = createCaptureIo();
    const subCode = await runCli(['guide', 'narrative-audio/script-rules'], { io: subCap.io });
    expect(subCode).toBe(0);
    expect(subCap.stdout.join('\n')).toContain('Parent guide: run `kinloom guide narrative-audio`');

    const pronounceCap = createCaptureIo();
    const pronounceCode = await runCli(['pronounce', '--guide'], { io: pronounceCap.io });
    expect(pronounceCode).toBe(0);
    expect(pronounceCap.stdout.join('\n')).toContain('100% deceased Full-Name Pronunciation');

    const ocrCap = createCaptureIo();
    const ocrCode = await runCli(['ocr', '--guide'], { io: ocrCap.io });
    expect(ocrCode).toBe(0);
    expect(ocrCap.stdout.join('\n')).toContain('kinloom ocr batch');

    const missingCap = createCaptureIo();
    const missingCode = await runCli(['guide', 'no-such-topic'], { io: missingCap.io });
    expect(missingCode).toBe(2);
    expect(missingCap.stderr.join('\n')).toContain("Unknown guide topic 'no-such-topic'");
  });
});

describe('help vs subcommand routing, native dispatch, and telemetry', () => {
  it('routes top-level --help/-h/--guide to guide, --script-help to raw --help, and subcommand --help to handler', () => {
    const archiveSpec = resolveRecordCommand('ia')!;
    expect(classifyRecordCommandIntent(archiveSpec, ['--help'])).toEqual({ mode: 'render-guide' });
    expect(classifyRecordCommandIntent(archiveSpec, ['-h'])).toEqual({ mode: 'render-guide' });
    expect(classifyRecordCommandIntent(archiveSpec, ['--guide'])).toEqual({ mode: 'render-guide' });
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

    for (const cmd of ['blm-glo', 'cyndis-list']) {
      const { io, stdout, stderr } = createCaptureIo();
      const result = await runRecordCommand(cmd, [], {
        io,
        telemetryFilePath: telemetryFile,
      });
      expect(result.exitCode).toBe(0);
      expect(result.mode).toBe('guide');
      expect(stderr).toEqual([]);
      expect(stdout.join('\n')).toContain(cmd === 'blm-glo' ? '# BLM GLO Records' : "# Cyndi's List");
    }
  });

  it('dispatches all 23 native TypeScript commands (plus ia alias) with zero uv/python3 spawns', async () => {
    const tmp = await makeTempDir('kinloom-native-dispatch-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');

    const nativeCommands: Array<{ cmd: string; expectToken: string }> = [
      { cmd: 'nara', expectToken: 'census1950' },
      { cmd: 'archive-org', expectToken: 'grep' },
      { cmd: 'ia', expectToken: 'grep' },
      { cmd: 'chronam', expectToken: 'page' },
      { cmd: 'hathi', expectToken: 'bib' },
      { cmd: 'findagrave', expectToken: 'cemetery' },
      { cmd: 'gnis', expectToken: 'search' },
      { cmd: 'wikitree', expectToken: 'ancestors' },
      { cmd: 'persi', expectToken: 'surname' },
      { cmd: 'ca-archives', expectToken: 'search' },
      { cmd: 'ky-archives', expectToken: 'cdm' },
      { cmd: 'michiganology', expectToken: 'collections' },
      { cmd: 'mn-archives', expectToken: 'newspapers' },
      { cmd: 'mo-archives', expectToken: 'death' },
      { cmd: 'nj-archives', expectToken: 'monmouth' },
      { cmd: 'texas-archives', expectToken: 'portal' },
      { cmd: 'va-archives', expectToken: 'chancery' },
      { cmd: 'fi-archives', expectToken: 'hiski' },
      { cmd: 'openarchieven', expectToken: 'download' },
      { cmd: 'se-archives', expectToken: 'manifest' },
      { cmd: 'uk-archives', expectToken: 'freereg' },
      { cmd: 'narrative-audio', expectToken: 'synth' },
      { cmd: 'prep-scan', expectToken: 'pdf-pages' },
      { cmd: 'ocr', expectToken: 'batch' },
    ];

    for (const item of nativeCommands) {
      const { io, stdout, stderr } = createCaptureIo();
      const result = await runRecordCommand(item.cmd, ['--script-help'], {
        io,
        telemetryFilePath: telemetryFile,
      });
      expect(result.mode, item.cmd).toBe('native');
      expect(result.exitCode, item.cmd).toBe(0);
      expect(stderr, item.cmd).toEqual([]);
      expect(stdout.join('\n'), item.cmd).toContain(item.expectToken);
    }
  });

  it('logs ocr telemetry subcmd by mode without leaking private file paths and honors parent suppression', async () => {
    const tmp = await makeTempDir('kinloom-ocr-telemetry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const cacheDir = path.join(tmp, 'cache');
    const secretPath = path.join(tmp, 'private-scan-1890.png');
    const pngBytes = await createSyntheticPng(200, 100);
    await writeFile(secretPath, pngBytes);
    const sha256 = crypto.createHash('sha256').update(pngBytes).digest('hex');

    fs.mkdirSync(cacheDir, { recursive: true });
    for (const slug of ['printed_psm6', 'cursive_hydrogen_low']) {
      await writeFile(
        path.join(cacheDir, `${sha256}_${slug}.json`),
        JSON.stringify({
          sha256,
          mode: slug,
          engine: slug.startsWith('printed') ? 'tesseract' : 'agy',
          created_at: '2026-11-26T00:00:00Z',
          elapsed_ms: 10,
          text: 'Cached telemetry test',
          source_hint: 'private-scan-1890.png',
          meta: {},
        })
      );
    }

    const cursiveRes = await runRecordCommand(
      'ocr',
      [secretPath, '--mode', 'cursive', '--cache-dir', cacheDir, '--json'],
      {
        io: createCaptureIo().io,
        telemetryFilePath: telemetryFile,
      }
    );
    expect(cursiveRes.exitCode).toBe(0);

    const printedEqRes = await runRecordCommand(
      'ocr',
      [secretPath, '--mode=printed', '--cache-dir', cacheDir],
      {
        io: createCaptureIo().io,
        telemetryFilePath: telemetryFile,
      }
    );
    expect(printedEqRes.exitCode).toBe(0);

    const defaultModeRes = await runRecordCommand('ocr', [secretPath, '--cache-dir', cacheDir], {
      io: createCaptureIo().io,
      telemetryFilePath: telemetryFile,
    });
    expect(defaultModeRes.exitCode).toBe(0);

    await runRecordCommand('ocr', ['--script-help'], {
      io: createCaptureIo().io,
      telemetryFilePath: telemetryFile,
    });

    // Parent suppression prevents writing an extra event.
    process.env.KINLOOM_TELEMETRY_PARENT = '1';
    await runRecordCommand('ocr', ['--script-help'], {
      io: createCaptureIo().io,
      telemetryFilePath: telemetryFile,
    });
    delete process.env.KINLOOM_TELEMETRY_PARENT;

    const rawTelemetry = await readFile(telemetryFile, 'utf8');
    expect(rawTelemetry).not.toContain(secretPath);
    expect(rawTelemetry).not.toContain('private-scan');

    const events = rawTelemetry
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.subcmd)).toEqual(['ocr cursive', 'ocr printed', 'ocr printed', 'ocr']);
    expect(events.slice(0, 3).map((e) => e.cache_hit)).toEqual([true, true, true]);

    // General path-leak guard for every record command.
    const prepSpec = resolveRecordCommand('prep-scan')!;
    expect(buildTelemetrySubcmd(prepSpec, ['/abs/private/scan.jpg'], 'native')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['C:\\private\\scan.jpg'], 'native')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['./local-scan.png'], 'native')).toBe('prep-scan');
    expect(buildTelemetrySubcmd(prepSpec, ['preview', '/abs/private/scan.jpg'], 'native')).toBe(
      'prep-scan preview'
    );
  });
});

describe('copy-migrations.mjs build helper', () => {
  it('copies worker SQL migrations atomically, prunes stale files and legacy dirs, and keeps cli.js executable', async () => {
    const tmpOut = await makeTempDir('kinloom-copy-migrations-test-');
    const cliStubPath = path.join(tmpOut, 'cli.js');
    const staleMigrationPath = path.join(tmpOut, 'migrations', '9999_stale.sql');
    const legacySkillsDir = path.join(tmpOut, 'bundled-skills', 'nara');
    const legacyAssetsDir = path.join(tmpOut, 'assets');

    fs.mkdirSync(path.dirname(staleMigrationPath), { recursive: true });
    fs.mkdirSync(legacySkillsDir, { recursive: true });
    fs.mkdirSync(legacyAssetsDir, { recursive: true });
    await writeFile(cliStubPath, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o644 });
    await writeFile(staleMigrationPath, '-- stale\n', 'utf8');
    await writeFile(path.join(legacySkillsDir, 'SKILL.md'), '# legacy\n', 'utf8');
    await writeFile(path.join(legacyAssetsDir, 'prep-scan.py'), '# legacy\n', 'utf8');

    const expectedSqlFiles = fs
      .readdirSync(WORKER_MIGRATIONS_DIR)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(expectedSqlFiles.length).toBeGreaterThan(0);

    const output = execFileSync(process.execPath, [COPY_MIGRATIONS_SCRIPT, '--out-dir', tmpOut], {
      encoding: 'utf8',
    });
    expect(output).toContain(`Copied ${expectedSqlFiles.length} SQL migrations`);
    expect(fs.statSync(cliStubPath).mode & 0o111).not.toBe(0);

    const copiedSqlFiles = fs.readdirSync(path.join(tmpOut, 'migrations')).sort();
    expect(copiedSqlFiles).toEqual(expectedSqlFiles);
    expect(fs.existsSync(staleMigrationPath)).toBe(false);
    expect(fs.existsSync(path.join(tmpOut, 'bundled-skills'))).toBe(false);
    expect(fs.existsSync(path.join(tmpOut, 'assets'))).toBe(false);
  });
});

describe('native TypeScript OCR, alias routing, and ubiquitous-language parity', () => {
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

    expect(result.mode).toBe('native');
    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join('\n')) as { cached: boolean; text: string; sha256: string };
    expect(parsed.cached).toBe(true);
    expect(parsed.text).toBe('Springfield Probate Docket 1862');
    expect(parsed.sha256).toBe(sha256);
  });

  it('forces OMP_THREAD_LIMIT=1 and enforces --timeout on tesseract subprocesses', async () => {
    const tmp = await makeTempDir('kinloom-ocr-hardening-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'scan.png');
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(imgPath, Buffer.from('synthetic-printed-scan'));

    const fakeTesseract = path.join(binDir, 'tesseract');
    await writeFile(fakeTesseract, '#!/bin/sh\necho "OMP=$OMP_THREAD_LIMIT"\n', { mode: 0o755 });

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
    expect(badTimeoutCapture.stderr.join('\n')).toMatch(/positive (?:integer|number)/);

    // Slow tesseract must fail fast when --timeout expires.
    await writeFile(fakeTesseract, '#!/bin/sh\nsleep 10\n', { mode: 0o755 });
    const timeoutCapture = createCaptureIo();
    const t0 = Date.now();
    const timeoutResult = await runRecordCommand(
      'ocr',
      [imgPath, '--cache-dir', cacheDir, '--force', '--timeout', '0.05'],
      {
        io: timeoutCapture.io,
        env: envWithHighOmp,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      }
    );
    const elapsedMs = Date.now() - t0;
    expect(timeoutResult.exitCode).toBe(1);
    expect(elapsedMs).toBeLessThan(8000);
    expect(timeoutCapture.stderr.join('\n')).toContain('timed out after 0.05s');
  });

  it('emits cached --boxes, --find, and --tsv layout output with OMP_THREAD_LIMIT=1', async () => {
    const tmp = await makeTempDir('kinloom-ocr-boxes-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const imgPath = path.join(tmp, 'page.png');
    const callLog = path.join(tmp, 'calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    const imgBytes = Buffer.from('synthetic-layout-scan');
    await writeFile(imgPath, imgBytes);
    const sha256 = crypto.createHash('sha256').update(imgBytes).digest('hex');

    const tsvRows = [
      'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
      '1\t1\t0\t0\t0\t0\t0\t0\t1200\t1600\t-1\t',
      '5\t1\t1\t1\t1\t1\t100\t200\t80\t30\t90\tProbate',
      '5\t1\t1\t1\t1\t2\t190\t205\t90\t32\t80\tDocket',
      '5\t1\t1\t1\t2\t1\t100\t260\t60\t28\t70\tOMP=OMP_VALUE',
      '5\t1\t2\t1\t1\t1\t400\t900\t50\t20\t95\tSpringfield',
    ].join('\n');
    const fixture = path.join(tmp, 'fixture.tsv');
    await writeFile(fixture, `${tsvRows}\n`);
    await writeFile(
      path.join(binDir, 'tesseract'),
      `#!/bin/sh\necho "$*" >> "${callLog}"\nsed "s/OMP_VALUE/$OMP_THREAD_LIMIT/" "${fixture}"\n`,
      { mode: 0o755 }
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OMP_THREAD_LIMIT: '28',
    };
    const run = async (args: string[]) => {
      const cap = createCaptureIo();
      const res = await runRecordCommand('ocr', [imgPath, '--cache-dir', cacheDir, ...args], {
        io: cap.io,
        env,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      });
      return { exitCode: res.exitCode, stdout: cap.stdout.join('\n'), stderr: cap.stderr.join('\n') };
    };
    type Boxes = {
      cached: boolean;
      image_width: number;
      image_height: number;
      lines: Array<{ text: string; x0: number; y0: number; x1: number; y1: number; conf: number }>;
    };

    const first = await run(['--boxes']);
    expect(first.exitCode, first.stderr).toBe(0);
    const boxes = JSON.parse(first.stdout) as Boxes;
    expect(boxes.cached).toBe(false);
    expect([boxes.image_width, boxes.image_height]).toEqual([1200, 1600]);
    expect(boxes.lines.map((l) => l.text)).toEqual(['Probate Docket', 'OMP=1', 'Springfield']);
    expect(boxes.lines[0]).toMatchObject({ x0: 100, y0: 200, x1: 280, y1: 237, conf: 85 });
    expect(fs.readFileSync(callLog, 'utf8')).toContain('--psm 6 tsv');

    const found = await run(['--find', 'DOCKET|spring']);
    expect(found.exitCode, found.stderr).toBe(0);
    const foundBoxes = JSON.parse(found.stdout) as Boxes;
    expect(foundBoxes.cached).toBe(true);
    expect(foundBoxes.lines.map((l) => [l.text, l.x0, l.y0, l.x1, l.y1])).toEqual([
      ['Probate Docket', 100, 200, 280, 237],
      ['Springfield', 400, 900, 450, 920],
    ]);

    const tsv = await run(['--tsv']);
    expect(tsv.exitCode, tsv.stderr).toBe(0);
    expect(tsv.stdout).toContain('level\tpage_num');
    expect(tsv.stdout).toContain('OMP=1');
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.tsv`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.boxes.json`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.json`))).toBe(false);

    const conflict = await run(['--tsv', '--boxes']);
    expect(conflict.exitCode).toBe(2);
    const cursive = await run(['--boxes', '--mode', 'cursive']);
    expect(cursive.exitCode).toBe(2);
  });

  it('caps oversized printed scans in-process via sharp and rescales --boxes/--find/--tsv to original pixels', async () => {
    const tmp = await makeTempDir('kinloom-ocr-scale-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const bigPng = path.join(tmp, 'oversized-4000x3000.png');
    const seenSizesPath = path.join(tmp, 'seen-sizes.log');
    fs.mkdirSync(binDir, { recursive: true });

    // Generate valid 4000x3000 PNG via pure-Node sharp (ZERO Python!).
    const pngBuf = await createSyntheticPng(4000, 3000);
    await writeFile(bigPng, pngBuf);

    // Pure-Node fake tesseract inspects PNG header dimensions and emits scaled TSV.
    await writeFile(
      path.join(binDir, 'tesseract'),
      `${[
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        'const data = fs.readFileSync(process.argv[2]);',
        'const w = data.readUInt32BE(16);',
        'const h = data.readUInt32BE(20);',
        `fs.appendFileSync(${JSON.stringify(seenSizesPath)}, w + "x" + h + "\\n");`,
        'if (process.argv.includes("tsv")) {',
        '  console.log("level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext");',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable expansion inside fake script
        '  console.log(`1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t${w}\\t${h}\\t-1\\t`);',
        '  const x0 = Math.round(w * 0.10), y0 = Math.round(h * 0.20);',
        '  const bw = Math.round(w * 0.20), bh = Math.round(h * 0.05);',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable expansion inside fake script
        '  console.log(`5\\t1\\t1\\t1\\t1\\t1\\t${x0}\\t${y0}\\t${bw}\\t${bh}\\t93\\tProbate`);',
        '} else {',
        '  console.log("Probate");',
        '}',
      ].join('\n')}\n`,
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    const cap = createCaptureIo();
    const res = await runRecordCommand('ocr', [bigPng, '--cache-dir', cacheDir, '--find', 'probate'], {
      io: cap.io,
      env,
      telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
    });

    expect(res.exitCode, cap.stderr.join('\n')).toBe(0);
    const body = JSON.parse(cap.stdout.join('\n')) as {
      image_width: number;
      image_height: number;
      cache_hit: boolean;
      lines: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>;
    };
    expect([body.image_width, body.image_height]).toEqual([4000, 3000]);
    expect(body.cache_hit).toBe(false);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].text).toBe('Probate');
    expect(Math.abs(body.lines[0].x0 - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y0 - 600)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].x1 - 1200)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y1 - 750)).toBeLessThanOrEqual(2);

    const seen = fs.readFileSync(seenSizesPath, 'utf8').trim();
    const [seenW, seenH] = seen.split('x').map(Number);
    expect(Math.max(seenW, seenH)).toBeLessThanOrEqual(3500);

    const tsvCap = createCaptureIo();
    const tsvRes = await runRecordCommand('ocr', [bigPng, '--cache-dir', cacheDir, '--tsv'], {
      io: tsvCap.io,
      env,
      telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
    });
    expect(tsvRes.exitCode, tsvCap.stderr.join('\n')).toBe(0);
    expect(tsvCap.stdout.join('\n')).toContain('\t4000\t3000\t-1');
  });

  it('exits 2 cleanly on missing, directory, empty, HTML, PDF, unknown flag, and corrupt image inputs', async () => {
    const tmp = await makeTempDir('kinloom-ocr-invalid-');
    const cacheDir = path.join(tmp, 'cache');
    const emptyPath = path.join(tmp, 'empty.jpg');
    const htmlPath = path.join(tmp, 'blocked.jpg');
    const pdfPath = path.join(tmp, 'document.pdf');
    const subDir = path.join(tmp, 'subdir');
    const corruptPath = path.join(tmp, 'corrupt.png');
    const binDir = path.join(tmp, 'bin');

    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(emptyPath, Buffer.alloc(0));
    await writeFile(htmlPath, '<!DOCTYPE html><html><body>Access Denied</body></html>');
    await writeFile(pdfPath, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    await writeFile(corruptPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]));
    await writeFile(
      path.join(binDir, 'tesseract'),
      '#!/bin/sh\necho "Error in pixReadStream: Unknown format: no pix returned" >&2\nexit 1\n',
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    };

    const cases: Array<{ args: string[]; expectText: string }> = [
      { args: [path.join(tmp, 'missing.jpg')], expectText: 'image file not found' },
      { args: [subDir], expectText: 'not a regular file' },
      { args: [emptyPath], expectText: 'empty (0 bytes)' },
      { args: [htmlPath], expectText: 'HTML, not an image' },
      { args: [pdfPath], expectText: 'PDF, not an image' },
      { args: ['-z', emptyPath], expectText: 'Unknown option' },
      { args: [corruptPath], expectText: 'invalid or unreadable image' },
    ];

    for (const tc of cases) {
      const cap = createCaptureIo();
      const res = await runRecordCommand('ocr', [...tc.args, '--cache-dir', cacheDir], {
        io: cap.io,
        env,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      });
      expect(res.exitCode, `args=${tc.args.join(' ')} stderr=${cap.stderr.join('\n')}`).toBe(2);
      expect(cap.stderr.join('\n')).toContain(tc.expectText);
    }
  });

  it('routes native aliases with boolean cache_hit telemetry and zero spawns', async () => {
    const tmp = await makeTempDir('kinloom-wave56-aliases-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const cacheDir = path.join(tmp, 'cache');
    const mockFetch: typeof fetch = async (input) => {
      const { hostname } = new URL(String(input));
      if (hostname === 'api.wikitree.com') {
        return new Response(
          JSON.stringify([{ status: 0, person: { Id: 100, Name: 'Lincoln-1', FirstName: 'Abraham' } }]),
          { status: 200 }
        );
      }
      if (hostname === 'catalog.hathitrust.org') {
        return new Response(
          JSON.stringify({
            records: {
              '000578050': {
                titles: ['Synthetic County History'],
                recordURL: 'https://catalog.hathitrust.org/Record/000578050',
              },
            },
            items: [],
          }),
          { status: 200 }
        );
      }
      if (hostname === 'discovery.nationalarchives.gov.uk') {
        return new Response(
          JSON.stringify({ records: [{ id: 'C12345', title: 'Alder Estate' }], count: 1 }),
          { status: 200 }
        );
      }
      if (hostname === 'data.riksarkivet.se') {
        return new Response(JSON.stringify({ items: [], totalHits: 0 }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const nativeEnv: NodeJS.ProcessEnv = {
      KINLOOM_WIKITREE_CACHE_DIR: path.join(cacheDir, 'wt'),
      KINLOOM_HATHI_CACHE_DIR: path.join(cacheDir, 'hathi'),
      KINLOOM_UK_ARCHIVES_CACHE_DIR: path.join(cacheDir, 'uk'),
      KINLOOM_SE_ARCHIVES_CACHE_DIR: path.join(cacheDir, 'se'),
    };
    const nativeCases: Array<{
      command: string;
      args: string[];
      expectedSubcmd: string;
      expectedHit: boolean;
    }> = [
      {
        command: 'wikitree',
        args: ['get', 'Lincoln-1', '--json'],
        expectedSubcmd: 'wikitree get',
        expectedHit: false,
      },
      {
        command: 'wikitree',
        args: ['profile', 'Lincoln-1', '--json'],
        expectedSubcmd: 'wikitree profile',
        expectedHit: true,
      },
      {
        command: 'hathi',
        args: ['bib', 'oclc', '424023', '--json'],
        expectedSubcmd: 'hathi bib',
        expectedHit: false,
      },
      {
        command: 'hathi',
        args: ['bib', 'oclc', '424023', '--json'],
        expectedSubcmd: 'hathi bib',
        expectedHit: true,
      },
      {
        command: 'uk-archives',
        args: ['tna', 'search', 'Alder', '--json'],
        expectedSubcmd: 'uk-archives tna',
        expectedHit: false,
      },
      {
        command: 'uk-archives',
        args: ['discovery', 'search', 'Alder', '--json'],
        expectedSubcmd: 'uk-archives discovery',
        expectedHit: true,
      },
      {
        command: 'se-archives',
        args: ['search', '--text', 'Alder', '--json'],
        expectedSubcmd: 'se-archives search',
        expectedHit: false,
      },
      {
        command: 'se-archives',
        args: ['search', '--text', 'Alder', '--json'],
        expectedSubcmd: 'se-archives search',
        expectedHit: true,
      },
    ];

    for (const tc of nativeCases) {
      const cap = createCaptureIo();
      const res = await runRecordCommand(tc.command, tc.args, {
        io: cap.io,
        env: nativeEnv,
        fetchImpl: mockFetch,
        sleepFn: async () => {},
        telemetryFilePath: telemetryFile,
      });
      expect(res.mode, tc.expectedSubcmd).toBe('native');
      expect(res.exitCode, tc.expectedSubcmd).toBe(0);
    }

    const events = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.subcmd)).toEqual(nativeCases.map((tc) => tc.expectedSubcmd));
    expect(events.map((e) => e.cache_hit)).toEqual(nativeCases.map((tc) => tc.expectedHit));
  });

  it('enforces Wave 52B CLI, skill, embedded guide, and ubiquitous-language parity', async () => {
    const forbiddenPatterns: Array<{ label: string; regex: RegExp }> = [
      { label: 'raw monorepo script path', regex: /skills\/[a-z0-9-]+\/scripts\// },
      { label: 'leaked unittest command', regex: /\bpython3 -m unittest\b/ },
      { label: 'leaked Vitest reference', regex: /\bVitest\b/ },
      { label: 'direct data/ edit phrasing', regex: /\bin `data\/`/ },
      { label: 'deprecated manuscript scan', regex: /\bmanuscript scan\b/i },
      { label: 'deprecated living individuals', regex: /\bliving individuals\b/i },
      { label: 'deprecated phonetic guide', regex: /\bphonetic guide\b/i },
      { label: 'deprecated phonetic respelling', regex: /\bphonetic respelling\b/i },
      { label: 'deprecated Collateral Relative', regex: /\bCollateral Relative\b/ },
      { label: 'deprecated Record discussion', regex: /\bRecord discussion\b/ },
      { label: 'deprecated anchor years', regex: /\banchor years\b/i },
    ];

    // Verify all 27 compiled embedded guides stay scrubbed and clean.
    expect(EMBEDDED_GUIDES).toHaveLength(27);
    for (const guide of EMBEDDED_GUIDES) {
      for (const { label, regex } of forbiddenPatterns) {
        expect(guide.body, `guide '${guide.id}' contains ${label}`).not.toMatch(regex);
      }
      expect(guide.body, `guide '${guide.id}' contains uv run`).not.toMatch(/\buv run\b/);
      if (guide.id !== 'prep-scan' && guide.id !== 'ocr') {
        expect(guide.body, `guide '${guide.id}' mentions Living Privacy Rule`).toContain(
          'Living Privacy Rule'
        );
      }
    }

    const pronounceGuide = EMBEDDED_GUIDES.find((g) => g.id === 'pronounce')!;
    expect(pronounceGuide.body).toContain('--strict');
    expect(pronounceGuide.body).toContain('100% deceased Full-Name Pronunciation');
    expect(pronounceGuide.body).toContain('100% Place coverage');
    expect(pronounceGuide.body).toContain('Zero Living leaks');

    const audioGuide = EMBEDDED_GUIDES.find((g) => g.id === 'narrative-audio')!;
    expect(audioGuide.body).toContain('chirp3-hd');
    expect(audioGuide.body).toContain('GOOGLE_CLOUD_TTS_API_KEY');
    expect(audioGuide.body).toContain('kinloom narrative-audio');

    const audioSpec = RECORD_COMMAND_SPECS.find((s) => s.command === 'narrative-audio');
    expect(audioSpec?.summary).toContain('Chirp 3: HD');
  });
});
