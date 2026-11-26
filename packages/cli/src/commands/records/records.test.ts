import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
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
  isUvOfflineCacheMiss,
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

/** Build a minimal valid PDF with one line of Helvetica text per page. */
function buildTextPdf(pageTexts: string[]): Buffer {
  const objects: string[] = [];
  const pageIds = pageTexts.map((_, i) => 4 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pageTexts.forEach((text, i) => {
    const pageId = pageIds[i]!;
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

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

interface FakeSpawnResponse {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
}

function createFakeSpawnSequence(
  responses: readonly FakeSpawnResponse[]
): { spawnImpl: RecordSpawnFn; calls: FakeSpawnCall[] } {
  const calls: FakeSpawnCall[] = [];
  let index = 0;
  const spawnImpl: RecordSpawnFn = (command, args, options) => {
    const response = responses[Math.min(index, responses.length - 1)] ?? {};
    index += 1;
    calls.push({ command, args: [...args], env: options.env ? { ...options.env } : undefined });
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

function createFakeSpawn(response: FakeSpawnResponse): {
  spawnImpl: RecordSpawnFn;
  calls: FakeSpawnCall[];
} {
  return createFakeSpawnSequence([response]);
}

function spawnPythonSync(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
) {
  const tryOffline = cmd === 'uv' && env.UV_OFFLINE === undefined;
  const first = spawnSync(cmd, args, {
    encoding: 'utf8',
    env: tryOffline ? { ...env, UV_OFFLINE: '1' } : env,
  });
  if (tryOffline && first.status !== 0 && isUvOfflineCacheMiss(first.stderr ?? '')) {
    const retryEnv = { ...env };
    delete retryEnv.UV_OFFLINE;
    return spawnSync(cmd, args, { encoding: 'utf8', env: retryEnv });
  }
  return first;
}

function execPythonSync(
  cmd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): string {
  const result = spawnPythonSync(cmd, args, env);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(' ')}): ${result.stderr}`);
  }
  return result.stdout ?? '';
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
  it('registers all 23 skills on disk plus prep-scan and ocr with zero missing files', () => {
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

    expect(skillDirsOnDisk).toHaveLength(23);
    expect(registeredSkillDirs).toEqual(skillDirsOnDisk);
    expect(RECORD_COMMAND_SPECS).toHaveLength(25);

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

  it('formats a grouped help catalog containing all 25 commands', () => {
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

  it('records cache_hit from JSON stdout and leaves non-JSON output unset', async () => {
    const tmp = await makeTempDir('kinloom-cache-hit-telemetry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const secretUrl = 'https://scans.invalid/private-scan.jpg';
    const secretPath = '/tmp/secret-scan.jpg';

    const hitPayload = `{"cache_hit":true,"files":[{"cache_hit":false,"url":"${secretUrl}","path":"${secretPath}"}]}\n`;
    const hitCapture = createCaptureIo();
    const hitSpawn = createFakeSpawn({ exitCode: 0, stdout: hitPayload });
    const hitResult = await runRecordCommand(
      'openarchieven',
      ['download', 'bhi:11111111-2222-3333-4444-555555555555'],
      {
        io: hitCapture.io,
        spawnImpl: hitSpawn.spawnImpl,
        telemetryFilePath: telemetryFile,
      }
    );
    expect(hitResult.exitCode).toBe(0);
    expect(hitResult.bytesOut).toBe(Buffer.byteLength(hitPayload));
    expect(hitCapture.stdout).toEqual([hitPayload.replace(/\n$/, '')]);

    const missPayload = '{"results":[],"cache_hit":false}\n';
    const missCapture = createCaptureIo();
    await runRecordCommand('nara', ['search', 'example'], {
      io: missCapture.io,
      spawnImpl: createFakeSpawn({ exitCode: 0, stdout: missPayload }).spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(missCapture.stdout).toEqual([missPayload.replace(/\n$/, '')]);

    const textPayload = 'note "cache_hit": true\n';
    const textCapture = createCaptureIo();
    await runRecordCommand('chronam', ['search', 'example'], {
      io: textCapture.io,
      spawnImpl: createFakeSpawn({ exitCode: 0, stdout: textPayload }).spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(textCapture.stdout).toEqual([textPayload.replace(/\n$/, '')]);

    const rawTelemetry = await readFile(telemetryFile, 'utf8');
    expect(rawTelemetry).not.toContain(secretUrl);
    expect(rawTelemetry).not.toContain(secretPath);
    expect(rawTelemetry).not.toContain('private-scan');
    const events = rawTelemetry
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((event) => event.cache_hit)).toEqual([true, false, null]);
  });

  it('records cache_hit from archive-org, findagrave, gnis, and va-archives JSON', async () => {
    const tmp = await makeTempDir('kinloom-cache-hit-archives-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const cases: Array<{ command: string; args: string[]; stdout: string; cacheHit: boolean }> = [
      {
        command: 'archive-org',
        args: ['search', 'title:(Oak)', '--json'],
        stdout: '{"response":{"numFound":1},"cache_hit":false}\n',
        cacheHit: false,
      },
      {
        command: 'archive-org',
        args: ['page', 'synthetic_atlas_1888', '--leaf', '4', '--json'],
        stdout: '{"identifier":"synthetic_atlas_1888","leaf":4,"page_cached":true,"cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'archive-org',
        args: ['page', 'synthetic_atlas_1888', '--leaves', '1,2', '--json'],
        stdout: '{"identifier":"synthetic_atlas_1888","count":2,"pages":[{"leaf":1,"page_cached":true},{"leaf":2,"page_cached":false}],"cache_hit":false}\n',
        cacheHit: false,
      },
      {
        command: 'archive-org',
        args: ['grep', 'synthetic_atlas_1888', '-e', 'Oakridge', '--json'],
        stdout: '{"pattern":"Oakridge","total_matches":0,"returned":0,"hits":[],"cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'findagrave',
        args: ['search', '--last', 'Alder', '--json'],
        stdout: '{"total":0,"memorials":[],"cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'findagrave',
        args: ['get', '627', '--json'],
        stdout: '[{"id":"627","cache_hit":true}]\n',
        cacheHit: true,
      },
      {
        command: 'findagrave',
        args: ['photo', '627', '--json'],
        stdout: '{"memorial_id":"627","files":[],"cache_hit":false}\n',
        cacheHit: false,
      },
      {
        command: 'gnis',
        args: ['search', 'Oak', '--state', 'OH', '--json'],
        stdout: '{"source":"DomesticNames_OH","matches":0,"results":[],"cache_hit":false}\n',
        cacheHit: false,
      },
      {
        command: 'va-archives',
        args: ['catalog', 'Alder', '--json'],
        stdout: '{"total":0,"records":[],"cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'nara',
        args: ['download', '595367', '--json'],
        stdout: '{"naId":"595367","bytes":128,"path":"/tmp/out","url":"https://catalog.archives.gov/id/595367","content_type":"image/jpeg","cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'nara',
        args: ['census1950-image', '1950census/a/b.jpg', '--json'],
        stdout: '{"image":"1950census/a/b.jpg","bytes":64,"width":null,"cache_hit":true}\n',
        cacheHit: true,
      },
      {
        command: 'nara',
        args: ['census1950-image', '1950census/a/b.jpg', '1950census/a/c.jpg', '--json'],
        stdout: '{"count":2,"files":[{"cache_hit":true},{"cache_hit":false}],"cache_hit":false}\n',
        cacheHit: false,
      },
      {
        command: 'chronam',
        args: ['download', '--lccn', 'sn83045462', '--date', '1865-04-15', '--json'],
        stdout: '{"resource_url":"https://www.loc.gov/resource/sn83045462/1865-04-15/ed-1/?sp=1","bytes":512,"cache_hit":false,"files":[]}\n',
        cacheHit: false,
      },
    ];
    for (const item of cases) {
      await runRecordCommand(item.command, item.args, {
        io: createCaptureIo().io,
        spawnImpl: createFakeSpawn({ exitCode: 0, stdout: item.stdout }).spawnImpl,
        telemetryFilePath: telemetryFile,
      });
    }
    const recorded = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(recorded.map((event) => event.cache_hit)).toEqual(cases.map((item) => item.cacheHit));
    expect(recorded.map((event) => event.cmd)).toEqual([
      'records:archive-org',
      'records:archive-org',
      'records:archive-org',
      'records:archive-org',
      'records:findagrave',
      'records:findagrave',
      'records:findagrave',
      'records:gnis',
      'records:va-archives',
      'records:nara',
      'records:nara',
      'records:nara',
      'records:chronam',
    ]);
    expect(recorded.slice(0, 4).map((event) => event.subcmd)).toEqual([
      'archive-org search',
      'archive-org page',
      'archive-org page',
      'archive-org grep',
    ]);
    expect(recorded.slice(4, 7).map((event) => event.subcmd)).toEqual([
      'findagrave search',
      'findagrave get',
      'findagrave photo',
    ]);
    expect(recorded.slice(9, 12).map((event) => event.subcmd)).toEqual([
      'nara download',
      'nara census1950-image',
      'nara census1950-image',
    ]);
  });

  it('streams stdout bytes unchanged while reading a trailing cache_hit', async () => {
    const tmp = await makeTempDir('kinloom-cache-hit-stream-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const pad = 'x'.repeat(300_000);
    const payload = `{"pad":"${pad}","cache_hit":false}\n`;
    const streamed: Buffer[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      streamed.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const result = await runRecordCommand(
        'openarchieven',
        ['show', 'bhi:11111111-2222-3333-4444-555555555555'],
        {
          spawnImpl: createFakeSpawn({ exitCode: 0, stdout: payload }).spawnImpl,
          telemetryFilePath: telemetryFile,
        }
      );
      expect(result.bytesOut).toBe(Buffer.byteLength(payload));
      expect(Buffer.concat(streamed).toString('utf8')).toBe(payload);
    } finally {
      process.stdout.write = originalWrite;
    }
    const event = JSON.parse((await readFile(telemetryFile, 'utf8')).trim()) as TelemetryEvent;
    expect(event.cache_hit).toBe(false);
    expect(event.bytes_out).toBe(Buffer.byteLength(payload));
  });
});

describe('offline-first uv fast-path with cold-cache online retry', () => {
  const UV_SCRIPT_CACHE_MISS_STDERR = [
    'error: No solution found when resolving script dependencies',
    '  cause: Because click was not found in the cache and you require click>=8.1, we',
    '         can conclude that your requirements are unsatisfiable.',
    '',
    'hint: Packages were unavailable because the network was disabled. When the network is disabled, registry packages may only be read from the cache.',
    '',
  ].join('\n');

  const cleanEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.UV_OFFLINE;
    return env;
  };

  it('injects UV_OFFLINE=1 on default uv calls and succeeds in 1 spawn', async () => {
    const tmp = await makeTempDir('kinloom-uv-offline-hit-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const { io, stdout, stderr } = createCaptureIo();
    const { spawnImpl, calls } = createFakeSpawn({
      exitCode: 0,
      stdout: '{"results":[],"cache_hit":true}\n',
    });

    const result = await runRecordCommand('nara', ['search', 'Alder'], {
      io,
      env: cleanEnv(),
      spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout).toEqual(['{"results":[],"cache_hit":true}']);
    expect(stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('uv');
    expect(calls[0].env?.UV_OFFLINE).toBe('1');
  });

  it('retries once without UV_OFFLINE on cold-cache uv miss and succeeds', async () => {
    const tmp = await makeTempDir('kinloom-uv-offline-retry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const { io, stdout, stderr } = createCaptureIo();
    const { spawnImpl, calls } = createFakeSpawnSequence([
      {
        exitCode: 1,
        stderr: UV_SCRIPT_CACHE_MISS_STDERR,
      },
      {
        exitCode: 0,
        stdout: '{"results":[{"id":"1"}],"cache_hit":false}\n',
      },
    ]);

    const result = await runRecordCommand('nara', ['search', 'Alder'], {
      io,
      env: cleanEnv(),
      spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    expect(result.exitCode).toBe(0);
    expect(stdout).toEqual(['{"results":[{"id":"1"}],"cache_hit":false}']);
    expect(stderr).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0].command).toBe('uv');
    expect(calls[0].env?.UV_OFFLINE).toBe('1');
    expect(calls[1].command).toBe('uv');
    expect(calls[1].env?.UV_OFFLINE).toBeUndefined();

    const events = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events).toHaveLength(1);
    expect(events[0].exit_code).toBe(0);
    expect(events[0].cache_hit).toBe(false);
  });

  it('does not retry script runtime errors or failures after stdout bytes were emitted', async () => {
    const tmp = await makeTempDir('kinloom-uv-no-retry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');

    const runtimeCapture = createCaptureIo();
    const runtimeSpawn = createFakeSpawnSequence([
      { exitCode: 2, stderr: 'Usage: nara search <query>\nError: Missing argument.\n' },
      { exitCode: 0, stdout: 'should-not-run\n' },
    ]);
    const runtimeResult = await runRecordCommand('nara', ['search'], {
      io: runtimeCapture.io,
      env: cleanEnv(),
      spawnImpl: runtimeSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(runtimeResult.exitCode).toBe(2);
    expect(runtimeSpawn.calls).toHaveLength(1);
    expect(runtimeSpawn.calls[0].env?.UV_OFFLINE).toBe('1');
    expect(runtimeCapture.stderr[0]).toContain('Usage: nara search');

    const partialOutCapture = createCaptureIo();
    const partialOutSpawn = createFakeSpawnSequence([
      {
        exitCode: 1,
        stdout: '{"partial":true}\n',
        stderr: UV_SCRIPT_CACHE_MISS_STDERR,
      },
      { exitCode: 0, stdout: 'should-not-run\n' },
    ]);
    const partialOutResult = await runRecordCommand('nara', ['search', 'Alder'], {
      io: partialOutCapture.io,
      env: cleanEnv(),
      spawnImpl: partialOutSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(partialOutResult.exitCode).toBe(1);
    expect(partialOutResult.bytesOut).toBe('{"partial":true}\n'.length);
    expect(partialOutSpawn.calls).toHaveLength(1);
  });

  it('respects explicit UV_OFFLINE=0 and UV_OFFLINE=1 without automatic retry', async () => {
    const tmp = await makeTempDir('kinloom-uv-explicit-env-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');

    const onlineCapture = createCaptureIo();
    const onlineSpawn = createFakeSpawn({ exitCode: 0, stdout: 'ok\n' });
    const onlineResult = await runRecordCommand('nara', ['search', 'Alder'], {
      io: onlineCapture.io,
      env: { ...cleanEnv(), UV_OFFLINE: '0' },
      spawnImpl: onlineSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(onlineResult.exitCode).toBe(0);
    expect(onlineSpawn.calls).toHaveLength(1);
    expect(onlineSpawn.calls[0].env?.UV_OFFLINE).toBe('0');

    const offlineCapture = createCaptureIo();
    const offlineSpawn = createFakeSpawnSequence([
      { exitCode: 1, stderr: UV_SCRIPT_CACHE_MISS_STDERR },
      { exitCode: 0, stdout: 'should-not-run\n' },
    ]);
    const offlineResult = await runRecordCommand('nara', ['search', 'Alder'], {
      io: offlineCapture.io,
      env: { ...cleanEnv(), UV_OFFLINE: '1' },
      spawnImpl: offlineSpawn.spawnImpl,
      telemetryFilePath: telemetryFile,
    });
    expect(offlineResult.exitCode).toBe(1);
    expect(offlineSpawn.calls).toHaveLength(1);
    expect(offlineSpawn.calls[0].env?.UV_OFFLINE).toBe('1');
  });

  it('leaves non-uv python3 scripts unaffected', async () => {
    const tmp = await makeTempDir('kinloom-python3-unaffected-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const { io } = createCaptureIo();
    const { spawnImpl, calls } = createFakeSpawnSequence([
      { exitCode: 1, stderr: UV_SCRIPT_CACHE_MISS_STDERR },
      { exitCode: 0, stdout: 'should-not-run\n' },
    ]);

    const result = await runRecordCommand('ia', ['grep', '--help'], {
      io,
      env: cleanEnv(),
      spawnImpl,
      telemetryFilePath: telemetryFile,
    });

    expect(result.exitCode).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('python3');
    expect(calls[0].env?.UV_OFFLINE).toBeUndefined();
  });

  it('detects real uv offline cache-miss diagnostics and ignores script errors', () => {
    expect(isUvOfflineCacheMiss(UV_SCRIPT_CACHE_MISS_STDERR)).toBe(true);
    expect(
      isUvOfflineCacheMiss(
        "error: Failed to resolve `--with` requirement\n  cause: Network connectivity is disabled, but the requested data wasn't found\n         in the cache: https://example.invalid/a.whl\n"
      )
    ).toBe(true);
    expect(
      isUvOfflineCacheMiss(
        'error: No interpreter found for Python >=3.11\nhint: A managed Python download is available for Python >=3.11, but uv is set to offline mode\n'
      )
    ).toBe(true);
    expect(isUvOfflineCacheMiss('httpx.ConnectError: network unreachable\n')).toBe(false);
    expect(isUvOfflineCacheMiss('')).toBe(false);
  });

  it('retries cold-cache uv miss in streaming mode without buffering stdout', async () => {
    const tmp = await makeTempDir('kinloom-uv-stream-retry-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const pad = 'y'.repeat(300_000);
    const payload = `{"pad":"${pad}","cache_hit":false}\n`;
    const streamedOut: Buffer[] = [];
    const streamedErr: Buffer[] = [];
    const originalOutWrite = process.stdout.write.bind(process.stdout);
    const originalErrWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      streamedOut.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      streamedErr.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    }) as typeof process.stderr.write;

    const { spawnImpl, calls } = createFakeSpawnSequence([
      { exitCode: 1, stderr: UV_SCRIPT_CACHE_MISS_STDERR },
      { exitCode: 0, stdout: payload },
    ]);
    try {
      const result = await runRecordCommand('nara', ['search', 'Alder'], {
        env: cleanEnv(),
        spawnImpl,
        telemetryFilePath: telemetryFile,
      });
      expect(result.exitCode).toBe(0);
      expect(result.bytesOut).toBe(Buffer.byteLength(payload));
      expect(Buffer.concat(streamedOut).toString('utf8')).toBe(payload);
      expect(Buffer.concat(streamedErr).toString('utf8')).toContain('network was disabled');
    } finally {
      process.stdout.write = originalOutWrite;
      process.stderr.write = originalErrWrite;
    }

    expect(calls).toHaveLength(2);
    expect(calls[0].env?.UV_OFFLINE).toBe('1');
    expect(calls[1].env?.UV_OFFLINE).toBeUndefined();
  });
});

describe('bundle-skills.mjs and dual-mode bundled resolution', () => {
  it('bundles all 23 skills and 4 assets into a temp dist dir with executable script bits', async () => {
    const tmpOut = await makeTempDir('kinloom-bundle-test-');
    const cliStubPath = path.join(tmpOut, 'cli.js');
    await writeFile(cliStubPath, '#!/usr/bin/env node\n', { encoding: 'utf8', mode: 0o644 });
    const output = execFileSync(process.execPath, [BUNDLE_SCRIPT, '--out-dir', tmpOut], {
      encoding: 'utf8',
    });
    expect(output).toContain('Bundled 23 skills (21 scripts, 1 references) and 4 assets');
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
    expect(prepHelp).toContain('info');
    expect(prepHelp).toContain('join');

    const ocrHelp = execFileSync('python3', [ocrScript, '--help'], { encoding: 'utf8' });
    expect(ocrHelp).toContain('Usage: kinloom ocr <image> [image ...] [options]');
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

  it('passes archive-org full-stack caching, lazy hOCR fallback, retry, and path-safety unit tests', () => {
    const testFile = path.join(SKILLS_ROOT, 'archive-org', 'tests', 'test_archive_org.py');
    const result = spawnSync('python3', ['-m', 'unittest', '-v', testFile], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  it('passes nara, findagrave, and usgs-gnis disk-caching and path-safety unit tests', () => {
    const testFiles = [
      path.join(SKILLS_ROOT, 'nara-catalog-search', 'tests', 'test_nara.py'),
      path.join(SKILLS_ROOT, 'findagrave', 'tests', 'test_findagrave.py'),
      path.join(SKILLS_ROOT, 'usgs-gnis', 'tests', 'test_gnis.py'),
    ];
    let pyCmd = 'python3';
    let pyPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import click, httpx'], { stdio: 'ignore' });
    } catch {
      pyCmd = 'uv';
      pyPrefix = ['run', '--with', 'click', '--with', 'httpx', 'python3'];
    }
    const result = spawnPythonSync(pyCmd, [...pyPrefix, '-m', 'unittest', '-v', ...testFiles]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  it('passes va-archives disk-caching, grant-tif/dunmore path-safety, and rosetta download unit tests', () => {
    const testFile = path.join(SKILLS_ROOT, 'virginia-archives', 'tests', 'test_va_archives.py');
    let pyCmd = 'python3';
    let pyPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import click, httpx'], { stdio: 'ignore' });
    } catch {
      pyCmd = 'uv';
      pyPrefix = ['run', '--with', 'click', '--with', 'httpx', 'python3'];
    }
    const result = spawnPythonSync(pyCmd, [...pyPrefix, '-m', 'unittest', '-v', testFile]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
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
    // --boxes, --find, and --tsv share one tesseract run; plain-text cache is untouched.
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.tsv`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.boxes.json`))).toBe(true);
    expect(fs.existsSync(path.join(cacheDir, `${sha256}_printed_psm6.json`))).toBe(false);

    const conflict = await run(['--tsv', '--boxes']);
    expect(conflict.exitCode).toBe(2);
    const cursive = await run(['--boxes', '--mode', 'cursive']);
    expect(cursive.exitCode).toBe(2);
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
        execPythonSync('uv', ['run', '--with', 'pillow', 'python3', '-c', 'import PIL']);
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
    const testEnv = { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' };

    // Generate a 2000x1200 light-cream synthetic sheet with colored marker stripes.
    execPythonSync(pyCmd, [
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

    const gridStdout = execPythonSync(
      pyCmd,
      [...prepPrefix, 'grid', srcImg, gridOut, '--step', '200', '--max-width', '1000', '--max-kb', '200'],
      testEnv
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
    const stitchStdout = execPythonSync(
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
      testEnv
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
    const pixelCheck = execPythonSync(pyCmd, [
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
    ]);
    const pixels = JSON.parse(pixelCheck) as { size: number[]; div: number[]; red: number[] };
    expect(pixels.size).toEqual([1800, 388]);
    expect(Math.max(...pixels.div)).toBeLessThan(55);
    expect(Math.max(...pixels.red)).toBeLessThan(20);

    // Poka-yoke: `--out <file>` works the same as the positional output on grid/stitch/crop,
    // and space-split boxes (`--box 100, 20, 1900, 180`) are rejoined.
    const gridAliasOut = path.join(tmp, 'grid-alias.jpg');
    const gridAlias = JSON.parse(
      execPythonSync(pyCmd, [...prepPrefix, 'grid', srcImg, '--out', gridAliasOut, '--step', '400'], testEnv)
    ) as { out: string };
    expect(gridAlias.out).toBe(gridAliasOut);
    expect(fs.existsSync(gridAliasOut)).toBe(true);

    const stitchAliasOut = path.join(tmp, 'stitch-alias.jpg');
    const stitchAlias = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'stitch',
          srcImg,
          '-o',
          stitchAliasOut,
          '--box',
          '100,',
          '20,',
          '1900,',
          '180',
          '--box',
          '200 720 1800 940',
        ],
        testEnv
      )
    ) as { out: string; width: number; height: number };
    expect(stitchAlias.out).toBe(stitchAliasOut);
    expect(stitchAlias.width).toBe(1800);

    const cropAliasOut = path.join(tmp, 'crop-alias.jpg');
    const cropAlias = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'crop',
          srcImg,
          '--out',
          cropAliasOut,
          '--box',
          '0,0,1000,600',
          '--quality',
          '85',
          '--preview-out',
          path.join(tmp, 'crop-alias.preview.jpg'),
          '--json',
        ],
        testEnv
      )
    ) as { output: { path: string; width: number } };
    expect(cropAlias.output.path).toBe(cropAliasOut);
    expect(cropAlias.output.width).toBe(1000);

    const previewDir = path.join(tmp, 'previews-alias');
    execPythonSync(pyCmd, [...prepPrefix, 'preview', srcImg, '--out', previewDir, '--json'], testEnv);
    expect(fs.readdirSync(previewDir).length).toBe(1);
  });

  it('prep-scan crop blacks out --redact-orig in pre-crop pixels, allows a missing --box, and names --redact-orig on an out-of-bounds --redact', async () => {
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
        execPythonSync('uv', ['run', '--with', 'pillow', 'python3', '-c', 'import PIL']);
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
    const python = pyCmd;

    const cropHelp = execPythonSync(python, [...prepPrefix, 'crop', '--help']);
    expect(cropHelp).toContain('--redact-orig');
    expect(cropHelp).toContain('[--box BOX]');
    expect(cropHelp.replace(/\s+/g, ' ')).toContain('Omit --box to keep the full rotated frame.');

    const env = { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' };
    const tmp = await makeTempDir('kinloom-prep-crop-redact-');
    const srcImg = path.join(tmp, 'sheet.png');
    execPythonSync(pyCmd, [
      ...pyPrefix,
      '-c',
      [
        'from PIL import Image',
        'import sys',
        'im = Image.new("RGB", (80, 60), (200, 180, 160))',
        'im.save(sys.argv[1])',
      ].join('\n'),
      srcImg,
    ]);

    const readPixels = (file: string, points: string): { size: number[]; px: number[][] } => {
      const raw = execPythonSync(pyCmd, [
        ...pyPrefix,
        '-c',
        [
          'from PIL import Image',
          'import json, sys',
          'im = Image.open(sys.argv[1])',
          'pts = json.loads(sys.argv[2])',
          'print(json.dumps({"size": list(im.size), "px": [list(im.getpixel(tuple(p))) for p in pts]}))',
        ].join('\n'),
        file,
        points,
      ]);
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('size' in parsed) ||
        !('px' in parsed)
      ) {
        throw new Error(`pixel probe returned ${raw}`);
      }
      return parsed as { size: number[]; px: number[][] };
    };

    const cream = [200, 180, 160];
    const black = [0, 0, 0];

    const origOut = path.join(tmp, 'orig.png');
    const origMeta = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'crop',
          srcImg,
          origOut,
          '--box',
          '10,20,50,50',
          '--redact-orig',
          '8,',
          '22,',
          '18,',
          '28',
          '--redact',
          '20,10,24,14',
          '--json',
          '--preview-out',
          path.join(tmp, 'orig.preview.jpg'),
        ],
        env
      )
    ) as {
      box: number[];
      redactions: number[][];
      redactions_orig: number[][];
      output: { width: number; height: number };
    };
    expect(origMeta.box).toEqual([10, 20, 50, 50]);
    expect(origMeta.output).toMatchObject({ width: 40, height: 30 });
    expect(origMeta.redactions_orig).toEqual([[8, 22, 18, 28]]);
    expect(origMeta.redactions).toEqual([[20, 10, 24, 14]]);
    const origPx = readPixels(origOut, '[[0,4],[9,4],[0,0],[20,10],[24,14],[25,10]]');
    expect(origPx.size).toEqual([40, 30]);
    expect(origPx.px[0]).toEqual(black);
    expect(origPx.px[1]).toEqual(cream);
    expect(origPx.px[2]).toEqual(cream);
    expect(origPx.px[3]).toEqual(black);
    expect(origPx.px[4]).toEqual(black);
    expect(origPx.px[5]).toEqual(cream);

    const legacyOut = path.join(tmp, 'legacy.png');
    const legacyMeta = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'crop',
          srcImg,
          legacyOut,
          '--box',
          '10,20,50,50',
          '--redact',
          '5,5,12,12',
          '--json',
          '--preview-out',
          path.join(tmp, 'legacy.preview.jpg'),
        ],
        env
      )
    ) as { redactions: number[][]; redactions_orig: number[][] };
    expect(legacyMeta.redactions).toEqual([[5, 5, 12, 12]]);
    expect(legacyMeta.redactions_orig).toEqual([]);
    const legacyPx = readPixels(legacyOut, '[[5,5],[12,12],[13,5],[4,5]]');
    expect(legacyPx.px).toEqual([black, black, cream, cream]);

    const turned = path.join(tmp, 'turned.png');
    execPythonSync(pyCmd, [
      ...pyPrefix,
      '-c',
      [
        'from PIL import Image',
        'import sys',
        'Image.new("RGB", (40, 20), (200, 180, 160)).save(sys.argv[1])',
      ].join('\n'),
      turned,
    ]);
    const rotOut = path.join(tmp, 'rotated.png');
    const rotMeta = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'crop',
          turned,
          rotOut,
          '--rotate',
          '90',
          '--redact-orig',
          '2,4,6,8',
          '--json',
          '--preview-out',
          path.join(tmp, 'rotated.preview.jpg'),
        ],
        env
      )
    ) as { box: number[]; rotate: number; redactions: number[][]; redactions_orig: number[][] };
    expect(rotMeta.rotate).toBe(90);
    expect(rotMeta.box).toEqual([0, 0, 20, 40]);
    expect(rotMeta.redactions).toEqual([]);
    expect(rotMeta.redactions_orig).toEqual([[2, 4, 6, 8]]);
    const rotPx = readPixels(rotOut, '[[2,4],[6,8],[1,4],[7,4],[2,3],[2,9]]');
    expect(rotPx.size).toEqual([20, 40]);
    expect(rotPx.px).toEqual([black, black, cream, cream, cream, cream]);

    const redactOnly = path.join(tmp, 'redact-only.png');
    const redactOnlyMeta = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'crop',
          turned,
          redactOnly,
          '--rotate',
          '90',
          '--redact',
          '2 4 6 8',
          '--json',
          '--preview-out',
          path.join(tmp, 'redact-only.preview.jpg'),
        ],
        env
      )
    ) as { box: number[]; redactions: number[][]; redactions_orig: number[][] };
    expect(redactOnlyMeta.box).toEqual([0, 0, 20, 40]);
    expect(redactOnlyMeta.redactions).toEqual([[2, 4, 6, 8]]);
    expect(redactOnlyMeta.redactions_orig).toEqual([]);
    const redactOnlyPx = readPixels(redactOnly, '[[2,4],[6,8],[1,4]]');
    expect(redactOnlyPx.px).toEqual([black, black, cream]);

    const oob = spawnPythonSync(
      pyCmd,
      [
        ...prepPrefix,
        'crop',
        srcImg,
        path.join(tmp, 'oob.png'),
        '--box',
        '0,0,30,40',
        '--redact',
        '40,5,50,15',
        '--preview-out',
        path.join(tmp, 'oob.preview.jpg'),
      ],
      env
    );
    expect(oob.status).toBe(2);
    expect(oob.stderr).toContain('--redact #1 (40,5,50,15) starts outside 30x40 image.');
    expect(oob.stderr).toContain('--redact-orig');
    expect(oob.stderr).toContain('prep-scan grid');
    expect(fs.existsSync(path.join(tmp, 'oob.png'))).toBe(false);
  });

  it('runs prep-scan info and prep-scan join on synthetic images when Pillow is available', async () => {
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
        execPythonSync('uv', ['run', '--with', 'pillow', 'python3', '-c', 'import PIL']);
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
    const env = { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' };
    const infoHelp = execPythonSync(pyCmd, [...prepPrefix, 'info', '--help']);
    expect(infoHelp).toContain('--json');
    const joinHelp = execPythonSync(pyCmd, [...prepPrefix, 'join', '--help']);
    expect(joinHelp).toContain('--direction');
    expect(joinHelp).toContain('--align');
    expect(joinHelp).toContain('--preview-out');

    const tmp = await makeTempDir('kinloom-prep-info-join-');
    const red = path.join(tmp, 'red.png');
    const blue = path.join(tmp, 'blue.png');
    const turned = path.join(tmp, 'turned.jpg');
    const note = path.join(tmp, 'note.txt');
    await writeFile(note, 'not an image');
    execPythonSync(pyCmd, [
      ...pyPrefix,
      '-c',
      [
        'from PIL import Image',
        'import sys',
        'Image.new("RGB", (80, 30), (255, 0, 0)).save(sys.argv[1])',
        'Image.new("RGB", (40, 20), (0, 0, 255)).save(sys.argv[2])',
        'turned = Image.new("RGB", (20, 40), (1, 2, 3))',
        'exif = turned.getexif()',
        'exif[274] = 6',
        'turned.save(sys.argv[3], exif=exif)',
      ].join('\n'),
      red,
      blue,
      turned,
    ]);

    const infoText = execPythonSync(pyCmd, [...prepPrefix, 'info', red, blue], env);
    expect(infoText).toBe(
      `${red}: 80x30 PNG (${(fs.statSync(red).size / 1024).toFixed(1)} KB)\n` +
        `${blue}: 40x20 PNG (${(fs.statSync(blue).size / 1024).toFixed(1)} KB)\n`
    );

    const infoJson = JSON.parse(
      execPythonSync(pyCmd, [...prepPrefix, 'info', red, turned, '--json'], env)
    ) as {
      count: number;
      files: Array<{
        path: string;
        width: number;
        height: number;
        format: string;
        mode: string;
        bytes: number;
        kb: number;
      }>;
    };
    expect(infoJson.count).toBe(2);
    expect(infoJson.files[0]).toEqual({
      path: red,
      width: 80,
      height: 30,
      format: 'PNG',
      mode: 'RGB',
      bytes: fs.statSync(red).size,
      kb: Number((fs.statSync(red).size / 1024).toFixed(1)),
    });
    expect(infoJson.files[1]).toMatchObject({
      path: turned,
      width: 40,
      height: 20,
      format: 'JPEG',
      mode: 'RGB',
      bytes: fs.statSync(turned).size,
    });

    const missing = spawnPythonSync(pyCmd, [...prepPrefix, 'info', path.join(tmp, 'missing.png')], env);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('input file not found');
    expect(missing.stdout).toBe('');

    const notImage = spawnPythonSync(pyCmd, [...prepPrefix, 'info', note], env);
    expect(notImage.status).toBe(1);
    expect(notImage.stderr).toContain('cannot read image');
    expect(notImage.stderr).toContain(note);
    expect(notImage.stdout).toBe('');

    const verticalOut = path.join(tmp, 'vertical.png');
    const previewOut = path.join(tmp, 'vertical.preview.jpg');
    const vertical = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'join',
          red,
          blue,
          '--out',
          verticalOut,
          '--direction',
          'v',
          '--gap',
          '8',
          '--align',
          'center',
          '--divider-color',
          '#222222',
          '--quality',
          '92',
          '--preview-out',
          previewOut,
          '--json',
        ],
        env
      )
    ) as {
      width: number;
      height: number;
      bytes: number;
      count: number;
      direction: string;
      out: string;
      preview_out: string;
    };
    expect(vertical).toEqual({
      width: 80,
      height: 58,
      bytes: fs.statSync(verticalOut).size,
      count: 2,
      direction: 'vertical',
      out: verticalOut,
      preview_out: previewOut,
    });

    const horizontalOut = path.join(tmp, 'horizontal.png');
    const horizontal = JSON.parse(
      execPythonSync(
        pyCmd,
        [
          ...prepPrefix,
          'join',
          red,
          blue,
          '-o',
          horizontalOut,
          '--direction',
          'horizontal',
          '--gap',
          '8',
          '--align',
          'end',
        ],
        env
      )
    ) as { width: number; height: number; direction: string; out: string; count: number };
    expect(horizontal).toMatchObject({
      width: 128,
      height: 30,
      count: 2,
      direction: 'horizontal',
      out: horizontalOut,
    });

    const startOut = path.join(tmp, 'start.png');
    execPythonSync(
      pyCmd,
      [
        ...prepPrefix,
        'join',
        red,
        blue,
        '--output',
        startOut,
        '--direction',
        'h',
        '--gap',
        '8',
        '--align',
        'start',
      ],
      env
    );

    const pixels = JSON.parse(
      execPythonSync(pyCmd, [
        ...pyPrefix,
        '-c',
        [
          'from PIL import Image',
          'import json, sys',
          'vertical = Image.open(sys.argv[1]).convert("RGB")',
          'horizontal = Image.open(sys.argv[2]).convert("RGB")',
          'start = Image.open(sys.argv[3]).convert("RGB")',
          'preview = Image.open(sys.argv[4])',
          'print(json.dumps({',
          '  "vertical": {',
          '    "size": list(vertical.size),',
          '    "red": list(vertical.getpixel((0, 0))),',
          '    "gap": list(vertical.getpixel((0, 33))),',
          '    "pad": list(vertical.getpixel((0, 38))),',
          '    "blue": list(vertical.getpixel((20, 38))),',
          '    "blue_end": list(vertical.getpixel((59, 57))),',
          '    "right_pad": list(vertical.getpixel((60, 38))),',
          '  },',
          '  "horizontal": {',
          '    "size": list(horizontal.size),',
          '    "gap": list(horizontal.getpixel((84, 0))),',
          '    "above": list(horizontal.getpixel((88, 0))),',
          '    "blue": list(horizontal.getpixel((88, 10))),',
          '    "blue_corner": list(horizontal.getpixel((127, 29))),',
          '  },',
          '  "start": {',
          '    "blue": list(start.getpixel((88, 0))),',
          '    "below": list(start.getpixel((88, 20))),',
          '  },',
          '  "preview": {"size": list(preview.size), "format": preview.format},',
          '}))',
        ].join('\n'),
        verticalOut,
        horizontalOut,
        startOut,
        previewOut,
      ])
    ) as {
      vertical: {
        size: number[];
        red: number[];
        gap: number[];
        pad: number[];
        blue: number[];
        blue_end: number[];
        right_pad: number[];
      };
      horizontal: { size: number[]; gap: number[]; above: number[]; blue: number[]; blue_corner: number[] };
      start: { blue: number[]; below: number[] };
      preview: { size: number[]; format: string };
    };
    expect(pixels.vertical.size).toEqual([80, 58]);
    expect(pixels.vertical.red).toEqual([255, 0, 0]);
    expect(pixels.vertical.gap).toEqual([34, 34, 34]);
    expect(pixels.vertical.pad).toEqual([34, 34, 34]);
    expect(pixels.vertical.blue).toEqual([0, 0, 255]);
    expect(pixels.vertical.blue_end).toEqual([0, 0, 255]);
    expect(pixels.vertical.right_pad).toEqual([34, 34, 34]);
    expect(pixels.horizontal.size).toEqual([128, 30]);
    expect(pixels.horizontal.gap).toEqual([34, 34, 34]);
    expect(pixels.horizontal.above).toEqual([34, 34, 34]);
    expect(pixels.horizontal.blue).toEqual([0, 0, 255]);
    expect(pixels.horizontal.blue_corner).toEqual([0, 0, 255]);
    expect(pixels.start.blue).toEqual([0, 0, 255]);
    expect(pixels.start.below).toEqual([34, 34, 34]);
    expect(pixels.preview).toEqual({ size: [80, 58], format: 'JPEG' });

    const tooFew = spawnPythonSync(
      pyCmd,
      [...prepPrefix, 'join', red, '--out', path.join(tmp, 'one.jpg')],
      env
    );
    expect(tooFew.status).toBe(2);
    expect(tooFew.stderr).toContain('at least 2');
    expect(fs.existsSync(path.join(tmp, 'one.jpg'))).toBe(false);

    const noOut = spawnPythonSync(pyCmd, [...prepPrefix, 'join', red, blue], env);
    expect(noOut.status).toBe(2);
    expect(noOut.stderr.toLowerCase()).toContain('out');
  });

  it.skipIf(spawnSync('pdftotext', ['-v']).error !== undefined)(
    'prep-scan pdf-grep reports exact 1-based page numbers and a pdf-pages --pages argument',
    async () => {
      const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
      const tmp = await makeTempDir('kinloom-pdf-grep-');
      const pdfPath = path.join(tmp, 'synthetic.pdf');
      const pageTexts = [
        'Abraham Lincoln born 1809 Hardin County',
        'Nothing relevant on this page',
        'Jansen family moved to Lincoln County',
        'Index of names',
        'LINCOLN, A. page 1',
      ];
      await writeFile(pdfPath, buildTextPdf(pageTexts));
      const env = {
        ...process.env,
        KINLOOM_OCR_CACHE_DIR: path.join(tmp, 'ocr-cache'),
        KINLOOM_TELEMETRY_PARENT: '1',
      };

      const hit = spawnSync(
        'python3',
        [prepScript, 'pdf-grep', pdfPath, '--pattern', 'lincoln', '-i', '--context', '10', '--json'],
        { encoding: 'utf8', env }
      );
      expect(hit.status, hit.stderr).toBe(0);
      const parsed = JSON.parse(hit.stdout);
      expect(parsed.page_count).toBe(5);
      expect(parsed.pages).toEqual([1, 3, 5]);
      expect(parsed.pages_arg).toBe('1,3,5');
      expect(parsed.match_count).toBe(3);
      expect(parsed.matches[0]).toMatchObject({ page: 1, line: 1, match: 'Lincoln' });

      const caseSensitive = spawnSync(
        'python3',
        [prepScript, 'pdf-grep', pdfPath, '--pattern', 'Lincoln', '--limit', '1'],
        { encoding: 'utf8', env }
      );
      expect(caseSensitive.status, caseSensitive.stderr).toBe(0);
      expect(caseSensitive.stdout).toContain('p.1 L1:');
      expect(caseSensitive.stdout).toContain('2 match(es) on 2 of 5 page(s)');
      expect(caseSensitive.stdout).toContain('--pages 1,3');

      const miss = spawnSync('python3', [prepScript, 'pdf-grep', pdfPath, '--pattern', 'Washington'], {
        encoding: 'utf8',
        env,
      });
      expect(miss.status).toBe(1);
      expect(miss.stdout).toContain('0 match(es)');

      const badRegex = spawnSync('python3', [prepScript, 'pdf-grep', pdfPath, '--pattern', '('], {
        encoding: 'utf8',
        env,
      });
      expect(badRegex.status).toBe(2);
      expect(badRegex.stderr).toContain('Invalid --pattern');
    }
  );

  it.skipIf(spawnSync('pdftotext', ['-v']).error !== undefined)(
    'prep-scan pdf-grep caches page text, skips pdftotext on the next pattern, and extracts again with --refresh',
    async () => {
      const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
      const tmp = await makeTempDir('kinloom-pdf-grep-cache-');
      const pdfPath = path.join(tmp, 'synthetic.pdf');
      const cacheRoot = path.join(tmp, 'ocr-cache');
      const binDir = path.join(tmp, 'bin');
      const counterPath = path.join(tmp, 'pdftotext-count');
      const pageTexts = [
        'Abraham Lincoln born 1809 Hardin County',
        'Nothing relevant on this page',
      ];
      const pdfBytes = buildTextPdf(pageTexts);
      await writeFile(pdfPath, pdfBytes);
      const digest = crypto.createHash('sha256').update(pdfBytes).digest('hex');
      const cacheFile = path.join(cacheRoot, 'pdf-text', `${digest}.json`);
      fs.mkdirSync(binDir, { recursive: true });
      const realPdftotext = execFileSync('which', ['pdftotext'], { encoding: 'utf8' }).trim();
      await writeFile(
        path.join(binDir, 'pdftotext'),
        `#!/bin/sh\nprintf 'x\\n' >> ${JSON.stringify(counterPath)}\nexec ${JSON.stringify(realPdftotext)} "$@"\n`
      );
      fs.chmodSync(path.join(binDir, 'pdftotext'), 0o755);
      const env = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        KINLOOM_OCR_CACHE_DIR: cacheRoot,
        KINLOOM_TELEMETRY_PARENT: '1',
      };
      const countExtracts = () => {
        if (!fs.existsSync(counterPath)) return 0;
        return fs.readFileSync(counterPath, 'utf8').split('\n').filter(Boolean).length;
      };
      const run = (pattern: string, extra: string[] = []) =>
        spawnSync(
          'python3',
          [prepScript, 'pdf-grep', pdfPath, '--pattern', pattern, '--json', ...extra],
          { encoding: 'utf8', env }
        );

      const first = run('lincoln', ['-i']);
      expect(first.status, first.stderr).toBe(0);
      const firstBody = JSON.parse(first.stdout);
      expect(firstBody.cache_hit).toBe(false);
      expect(firstBody.pages).toEqual([1]);
      expect(countExtracts()).toBe(1);
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { pages: string[] };
      expect(cached.pages).toEqual([
        expect.stringContaining('Lincoln'),
        expect.stringContaining('Nothing relevant'),
      ]);

      const second = run('Hardin');
      expect(second.status, second.stderr).toBe(0);
      const secondBody = JSON.parse(second.stdout);
      expect(secondBody.cache_hit).toBe(true);
      expect(secondBody.pages).toEqual([1]);
      expect(secondBody.match_count).toBe(1);
      expect(countExtracts()).toBe(1);

      const refreshed = run('lincoln', ['-i', '--refresh']);
      expect(refreshed.status, refreshed.stderr).toBe(0);
      expect(JSON.parse(refreshed.stdout).cache_hit).toBe(false);
      expect(countExtracts()).toBe(2);

      await writeFile(cacheFile, '{\n');
      const repaired = run('Hardin');
      expect(repaired.status, repaired.stderr).toBe(0);
      expect(JSON.parse(repaired.stdout).cache_hit).toBe(false);
      expect(countExtracts()).toBe(3);
      const repairedCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { pages: string[] };
      expect(repairedCache.pages).toHaveLength(2);

      const badPath = path.join(tmp, 'not-a.pdf');
      const badBytes = Buffer.from('this is not a pdf');
      await writeFile(badPath, badBytes);
      const badDigest = crypto.createHash('sha256').update(badBytes).digest('hex');
      const bad = spawnSync(
        'python3',
        [prepScript, 'pdf-grep', badPath, '--pattern', 'pdf', '--json'],
        { encoding: 'utf8', env }
      );
      expect(bad.status).toBe(1);
      expect(fs.existsSync(path.join(cacheRoot, 'pdf-text', `${badDigest}.json`))).toBe(false);
    }
  );

  it.skipIf(spawnSync('pdftoppm', ['-v']).error !== undefined)(
    'prep-scan pdf-pages parses ranges in order, renders in parallel, caches per page, and rejects bad specs with exit 2',
    async () => {
      const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
      let pyCmd: string | null = null;
      let prepPrefix: string[] = [];
      try {
        execFileSync('python3', ['-c', 'import PIL'], { stdio: 'ignore' });
        pyCmd = 'python3';
        prepPrefix = [prepScript];
      } catch {
        try {
          execPythonSync('uv', ['run', '--with', 'pillow', 'python3', '-c', 'import PIL']);
          pyCmd = 'uv';
          prepPrefix = ['run', '--script', prepScript];
        } catch {
          pyCmd = null;
        }
      }
      if (!pyCmd) {
        return;
      }

      const tmp = await makeTempDir('kinloom-pdf-pages-cache-');
      const pdfPath = path.join(tmp, 'synthetic-book.pdf');
      const cacheRoot = path.join(tmp, 'ocr-cache');
      const binDir = path.join(tmp, 'bin');
      const counterPath = path.join(tmp, 'pdftoppm-calls.log');
      const inflightDir = path.join(tmp, 'inflight');
      const maxConcPath = path.join(tmp, 'max-conc.log');
      const telemetryFile = path.join(tmp, 'telemetry.jsonl');

      const pdfBytes = buildTextPdf([
        'Page one: Oakridge Township 1850',
        'Page two: Maple Creek Survey',
        'Page three: Pine Hill Cemetery',
        'Page four: River Bend Ferry',
        'Page five: Index of Settlers',
      ]);
      await writeFile(pdfPath, pdfBytes);
      const pdfDigest = crypto.createHash('sha256').update(pdfBytes).digest('hex');

      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(inflightDir, { recursive: true });
      const realPdftoppm = execFileSync('which', ['pdftoppm'], { encoding: 'utf8' }).trim();
      await writeFile(
        path.join(binDir, 'pdftoppm'),
        [
          '#!/bin/sh',
          `printf '%s\\n' "$*" >> ${JSON.stringify(counterPath)}`,
          `marker=${JSON.stringify(inflightDir)}/p_$$`,
          'touch "$marker"',
          `conc=$(ls -1 ${JSON.stringify(inflightDir)} | wc -l)`,
          `printf '%s\\n' "$conc" >> ${JSON.stringify(maxConcPath)}`,
          'sleep 0.15',
          `${JSON.stringify(realPdftoppm)} "$@"`,
          'rc=$?',
          'rm -f "$marker"',
          'exit $rc',
        ].join('\n') + '\n',
        { mode: 0o755 }
      );

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        KINLOOM_OCR_CACHE_DIR: cacheRoot,
        KINLOOM_TELEMETRY_PARENT: '1',
      };
      const countRenders = (): number => {
        if (!fs.existsSync(counterPath)) return 0;
        return fs.readFileSync(counterPath, 'utf8').split('\n').filter(Boolean).length;
      };

      // 1. Cold parallel multi-page render with range + dedup in requested order (4, 1-3, 2 -> [4, 1, 2, 3]).
      const outDir1 = path.join(tmp, 'out1');
      const first = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--pages', '4, 1-3, 2', '--dpi', '72', '--out-dir', outDir1, '--json'],
        env
      );
      expect(first.status, first.stderr).toBe(0);
      const body1 = JSON.parse(first.stdout) as {
        dpi: number;
        format: string;
        requested_pages: number[];
        cache_hit: boolean;
        pages: Array<{ page: number; path: string; width: number; height: number; bytes: number; cache_hit: boolean }>;
      };
      expect(body1.dpi).toBe(72);
      expect(body1.format).toBe('jpg');
      expect(body1.requested_pages).toEqual([4, 1, 2, 3]);
      expect(body1.cache_hit).toBe(false);
      expect(body1.pages.map((p) => [p.page, p.cache_hit])).toEqual([
        [4, false],
        [1, false],
        [2, false],
        [3, false],
      ]);
      for (const page of body1.pages) {
        expect(page.width).toBeGreaterThan(0);
        expect(page.height).toBeGreaterThan(0);
        expect(page.bytes).toBe(fs.statSync(page.path).size);
      }
      expect(countRenders()).toBe(4);
      const maxObservedConcurrency = Math.max(
        ...fs.readFileSync(maxConcPath, 'utf8').trim().split('\n').map((n) => Number(n.trim()))
      );
      expect(maxObservedConcurrency).toBeGreaterThanOrEqual(2);
      expect(maxObservedConcurrency).toBeLessThanOrEqual(4);
      expect(fs.existsSync(path.join(cacheRoot, 'pdf-pages', `${pdfDigest}_p1_dpi72.jpg`))).toBe(true);

      // 2. Warm cache hit into a brand-new output directory invokes pdftoppm 0 times and emits cache_hit: true.
      const outDir2 = path.join(tmp, 'out2');
      const second = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--pages', '1,2-3', '--dpi', '72', '--out-dir', outDir2, '--json'],
        env
      );
      expect(second.status, second.stderr).toBe(0);
      const body2 = JSON.parse(second.stdout) as {
        requested_pages: number[];
        cache_hit: boolean;
        pages: Array<{ page: number; path: string; cache_hit: boolean }>;
      };
      expect(body2.requested_pages).toEqual([1, 2, 3]);
      expect(body2.cache_hit).toBe(true);
      expect(body2.pages.map((p) => [p.page, p.cache_hit])).toEqual([
        [1, true],
        [2, true],
        [3, true],
      ]);
      expect(countRenders()).toBe(4);
      expect(fs.existsSync(path.join(outDir2, 'page-001.jpg'))).toBe(true);
      expect(fs.existsSync(path.join(outDir2, 'page-003.jpg'))).toBe(true);

      // 3. Partial overlap (page 1 cached, page 5 uncached) -> top-level cache_hit: false, only 1 new pdftoppm call.
      const outDir3 = path.join(tmp, 'out3');
      const partial = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--pages', '1,5', '--dpi', '72', '--out-dir', outDir3, '--json'],
        env
      );
      expect(partial.status, partial.stderr).toBe(0);
      const body3 = JSON.parse(partial.stdout) as {
        cache_hit: boolean;
        pages: Array<{ page: number; cache_hit: boolean }>;
      };
      expect(body3.cache_hit).toBe(false);
      expect(body3.pages.map((p) => [p.page, p.cache_hit])).toEqual([
        [1, true],
        [5, false],
      ]);
      expect(countRenders()).toBe(5);

      // 4. --refresh bypasses disk cache and re-renders.
      const refreshed = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--page', '1', '--dpi', '72', '--out-dir', outDir3, '--refresh', '--json'],
        env
      );
      expect(refreshed.status, refreshed.stderr).toBe(0);
      expect(JSON.parse(refreshed.stdout).cache_hit).toBe(false);
      expect(countRenders()).toBe(6);

      // 5. PNG format caches separately and writes .png output.
      const outDirPng = path.join(tmp, 'out-png');
      const pngRun = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--pages', '1', '--dpi', '72', '--format', 'png', '--out-dir', outDirPng, '--json'],
        env
      );
      expect(pngRun.status, pngRun.stderr).toBe(0);
      const pngBody = JSON.parse(pngRun.stdout) as { format: string; cache_hit: boolean; pages: Array<{ path: string }> };
      expect(pngBody.format).toBe('png');
      expect(pngBody.cache_hit).toBe(false);
      expect(pngBody.pages[0].path.endsWith('page-001.png')).toBe(true);
      expect(countRenders()).toBe(7);

      // 6. Backward-compatible text mode works on cache hit.
      const textRun = spawnPythonSync(
        pyCmd,
        [...prepPrefix, 'pdf-pages', pdfPath, '--pages', '1', '--dpi', '72', '--out-dir', outDir2],
        env
      );
      expect(textRun.status, textRun.stderr).toBe(0);
      expect(textRun.stdout).toContain('p.001');
      expect(textRun.stdout).toContain('preview:');
      expect(countRenders()).toBe(7);

      // 7. Telemetry capture through runRecordCommand records boolean cache_hit.
      const runEnv: NodeJS.ProcessEnv = { ...env };
      delete runEnv.KINLOOM_TELEMETRY_PARENT;
      const runRes = await runRecordCommand(
        'prep-scan',
        ['pdf-pages', pdfPath, '--pages', '1,2', '--dpi', '72', '--out-dir', outDir2, '--json'],
        {
          io: createCaptureIo().io,
          env: runEnv,
          telemetryFilePath: telemetryFile,
        }
      );
      expect(runRes.exitCode).toBe(0);
      const recordedEvent = JSON.parse((await readFile(telemetryFile, 'utf8')).trim()) as TelemetryEvent;
      expect(recordedEvent.subcmd).toBe('prep-scan pdf-pages');
      expect(recordedEvent.cache_hit).toBe(true);

      // 8. Invalid, reversed, non-positive, >25-page, and out-of-bounds specs exit 2 with zero new pdftoppm calls.
      const badSpecs = [
        { pages: '3-1', expectText: 'exceeds end' },
        { pages: '0', expectText: '>= 1' },
        { pages: '1,,3', expectText: 'empty page entry' },
        { pages: '1-26', expectText: '25' },
        { pages: '99', expectText: 'out of range' },
      ];
      for (const spec of badSpecs) {
        const badRun = spawnPythonSync(
          pyCmd,
          [...prepPrefix, 'pdf-pages', pdfPath, '--pages', spec.pages, '--out-dir', outDir2],
          env
        );
        expect(badRun.status, `spec=${spec.pages} stderr=${badRun.stderr}`).toBe(2);
        expect(badRun.stderr).toContain(spec.expectText);
      }
      expect(countRenders()).toBe(7);
    }
  );

  it('prep-scan rejects a missing or doubled output path with an actionable exit-2 message', () => {
    const prepScript = path.join(ASSETS_ROOT, 'prep-scan.py');
    const env = { ...process.env, KINLOOM_TELEMETRY_PARENT: '1' };
    const missing = spawnSync('python3', [prepScript, 'grid', 'scan.jpg'], { encoding: 'utf8', env });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('missing output path');
    expect(missing.stderr).toContain('--out');

    const doubled = spawnSync(
      'python3',
      [prepScript, 'stitch', 'scan.jpg', 'a.jpg', '--out', 'b.jpg', '--box', '0,0,10,10'],
      { encoding: 'utf8', env }
    );
    expect(doubled.status).toBe(2);
    expect(doubled.stderr).toContain('output given twice');

    const gridHelp = execFileSync('python3', [prepScript, 'grid', '--help'], { encoding: 'utf8' });
    expect(gridHelp).toContain('--out');
    const previewHelp = execFileSync('python3', [prepScript, 'preview', '--help'], { encoding: 'utf8' });
    expect(previewHelp).toContain('--out-dir');
  });

  it('passes chronam and nj-archives caching, retry, alias, and parsing unit tests', () => {
    const testFiles = [
      path.join(SKILLS_ROOT, 'chronicling-america', 'tests', 'test_chronam.py'),
      path.join(SKILLS_ROOT, 'new-jersey-archives', 'tests', 'test_nj_archives.py'),
    ];
    let pyCmd = 'python3';
    let pyPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import click, httpx'], { stdio: 'ignore' });
    } catch {
      pyCmd = 'uv';
      pyPrefix = ['run', '--with', 'click', '--with', 'httpx', 'python3'];
    }
    const result = spawnPythonSync(pyCmd, [...pyPrefix, '-m', 'unittest', '-v', ...testFiles]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  it('passes openarchieven, michiganology, ca/mo/ky-archives, and wikitree disk-caching unit tests', () => {
    const testFiles = [
      path.join(SKILLS_ROOT, 'openarchieven', 'tests', 'test_openarchieven.py'),
      path.join(SKILLS_ROOT, 'library-of-michigan', 'tests', 'test_michiganology.py'),
      path.join(SKILLS_ROOT, 'california-archives', 'tests', 'test_ca_archives.py'),
      path.join(SKILLS_ROOT, 'missouri-archives', 'tests', 'test_mo_archives.py'),
      path.join(SKILLS_ROOT, 'kentucky-archives', 'tests', 'test_ky_archives.py'),
      path.join(SKILLS_ROOT, 'wikitree', 'tests', 'test_wikitree.py'),
    ];
    let pyCmd = 'python3';
    let pyPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import click, httpx'], { stdio: 'ignore' });
    } catch {
      pyCmd = 'uv';
      pyPrefix = ['run', '--with', 'click', '--with', 'httpx', 'python3'];
    }
    const result = spawnPythonSync(pyCmd, [...pyPrefix, '-m', 'unittest', '-v', ...testFiles]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  it('passes hathi, persi, texas-archives, uk-archives, mn-archives, se-archives, and fi-archives disk-caching and safety unit tests', () => {
    const testFiles = [
      path.join(SKILLS_ROOT, 'hathitrust', 'tests', 'test_hathi.py'),
      path.join(SKILLS_ROOT, 'acpl-persi', 'tests', 'test_persi.py'),
      path.join(SKILLS_ROOT, 'texas-archives', 'tests', 'test_texas_archives.py'),
      path.join(SKILLS_ROOT, 'uk-archives', 'tests', 'test_uk_archives.py'),
      path.join(SKILLS_ROOT, 'minnesota-archives', 'tests', 'test_mn_archives.py'),
      path.join(SKILLS_ROOT, 'swedish-archives', 'tests', 'test_se_archives.py'),
      path.join(SKILLS_ROOT, 'finnish-archives', 'tests', 'test_fi_archives.py'),
    ];
    let pyCmd = 'python3';
    let pyPrefix: string[] = [];
    try {
      execFileSync('python3', ['-c', 'import click, httpx'], { stdio: 'ignore' });
    } catch {
      pyCmd = 'uv';
      pyPrefix = ['run', '--with', 'click', '--with', 'httpx', 'python3'];
    }
    const result = spawnPythonSync(pyCmd, [...pyPrefix, '-m', 'unittest', '-v', ...testFiles]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/Ran [1-9]\d* tests/);
    expect(result.stderr).toMatch(/\bOK\b/);
  });

  it('processes multiple images in kinloom ocr with per-file cache hits and backward-compatible single-file output', async () => {
    const tmp = await makeTempDir('kinloom-ocr-multi-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const img1 = path.join(tmp, 'page1.png');
    const img2 = path.join(tmp, 'page2.png');
    const callLog = path.join(tmp, 'calls.log');
    fs.mkdirSync(binDir, { recursive: true });
    await writeFile(img1, Buffer.from('synthetic-scan-page-1'));
    await writeFile(img2, Buffer.from('synthetic-scan-page-2'));

    const fakeTesseract = path.join(binDir, 'tesseract');
    await writeFile(
      fakeTesseract,
      [
        '#!/bin/sh',
        `echo "$1|$OMP_THREAD_LIMIT|$*" >> "${callLog}"`,
        'base=$(basename "$1")',
        'case "$*" in',
        '  *" tsv"*)',
        '    printf "level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext\\n"',
        '    printf "1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t800\\t600\\t-1\\t\\n"',
        '    if [ "$base" = "page1.png" ]; then',
        '      printf "5\\t1\\t1\\t1\\t1\\t1\\t10\\t20\\t100\\t20\\t92\\tLincoln\\n"',
        '    else',
        '      printf "5\\t1\\t1\\t1\\t1\\t1\\t30\\t40\\t100\\t20\\t88\\tSpringfield\\n"',
        '    fi',
        '    ;;',
        '  *)',
        '    echo "TEXT:$base:OMP=$OMP_THREAD_LIMIT"',
        '    ;;',
        'esac',
      ].join('\n') + '\n',
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OMP_THREAD_LIMIT: '16',
    };
    const runOcr = async (args: string[]) => {
      const cap = createCaptureIo();
      const res = await runRecordCommand('ocr', [...args, '--cache-dir', cacheDir], {
        io: cap.io,
        env,
        telemetryFilePath: path.join(tmp, 'telemetry.jsonl'),
      });
      return { exitCode: res.exitCode, stdout: cap.stdout.join('\n'), stderr: cap.stderr.join('\n') };
    };

    // Cold multi-file text run invokes tesseract once per file with OMP_THREAD_LIMIT=1.
    const coldText = await runOcr([img1, img2]);
    expect(coldText.exitCode, coldText.stderr).toBe(0);
    expect(coldText.stdout).toBe(
      `=== ${img1} ===\nTEXT:page1.png:OMP=1\n\n=== ${img2} ===\nTEXT:page2.png:OMP=1`
    );
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(2);

    // Warm multi-file JSON run hits SHA-256 disk cache with zero new tesseract calls.
    const warmJson = await runOcr([img1, img2, '--json']);
    expect(warmJson.exitCode, warmJson.stderr).toBe(0);
    const parsedMulti = JSON.parse(warmJson.stdout) as {
      count: number;
      cache_hits: number;
      files: Array<{ file: string; cached: boolean; text: string }>;
    };
    expect(parsedMulti.count).toBe(2);
    expect(parsedMulti.cache_hits).toBe(2);
    expect(parsedMulti.files.map((f) => [f.file, f.cached, f.text])).toEqual([
      [img1, true, 'TEXT:page1.png:OMP=1'],
      [img2, true, 'TEXT:page2.png:OMP=1'],
    ]);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(2);

    // Single-file JSON remains a flat object (backward-compatible).
    const singleJson = await runOcr([img1, '--json']);
    expect(singleJson.exitCode, singleJson.stderr).toBe(0);
    const parsedSingle = JSON.parse(singleJson.stdout) as { cached: boolean; text: string; files?: unknown };
    expect(parsedSingle.files).toBeUndefined();
    expect(parsedSingle.cached).toBe(true);
    expect(parsedSingle.text).toBe('TEXT:page1.png:OMP=1');

    // Multi-file --find runs layout OCR once per file and caches boxes for repeat --find queries.
    const find1 = await runOcr([img1, img2, '--find', 'lincoln']);
    expect(find1.exitCode, find1.stderr).toBe(0);
    const parsedFind1 = JSON.parse(find1.stdout) as {
      count: number;
      cache_hits: number;
      files: Array<{ file: string; cached: boolean; lines: Array<{ text: string }> }>;
    };
    expect(parsedFind1.count).toBe(2);
    expect(parsedFind1.cache_hits).toBe(0);
    expect(parsedFind1.files[0].lines.map((l) => l.text)).toEqual(['Lincoln']);
    expect(parsedFind1.files[1].lines).toEqual([]);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);

    const find2 = await runOcr([img1, img2, '--find', 'springfield']);
    expect(find2.exitCode, find2.stderr).toBe(0);
    const parsedFind2 = JSON.parse(find2.stdout) as {
      count: number;
      cache_hits: number;
      files: Array<{ file: string; cached: boolean; lines: Array<{ text: string }> }>;
    };
    expect(parsedFind2.cache_hits).toBe(2);
    expect(parsedFind2.files[0].lines).toEqual([]);
    expect(parsedFind2.files[1].lines.map((l) => l.text)).toEqual(['Springfield']);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);

    // Missing file in a multi-file batch fails cleanly with exit 2 before invoking tesseract.
    const missing = await runOcr([img1, path.join(tmp, 'does-not-exist.png')]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain('image file not found');
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('parallelizes multi-file OCR with OMP_THREAD_LIMIT=1, preserves input order, emits top-level boolean cache_hit, and uses flock', async () => {
    const tmp = await makeTempDir('kinloom-ocr-parallel-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const inflightDir = path.join(tmp, 'inflight');
    const maxConcPath = path.join(tmp, 'max-conc.log');
    const callLog = path.join(tmp, 'calls.log');
    const telemetryFile = path.join(tmp, 'telemetry.jsonl');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(inflightDir, { recursive: true });

    const imgs = [1, 2, 3, 4].map((n) => path.join(tmp, `sheet-${n}.png`));
    for (let i = 0; i < imgs.length; i += 1) {
      await writeFile(imgs[i], Buffer.from(`synthetic-parallel-sheet-${i + 1}`));
    }

    // Earlier images sleep longer so deterministic output ordering is proven despite out-of-order completion.
    await writeFile(
      path.join(binDir, 'tesseract'),
      [
        '#!/bin/sh',
        'base=$(basename "$1")',
        `printf '%s|%s\\n' "$base" "$OMP_THREAD_LIMIT" >> ${JSON.stringify(callLog)}`,
        `marker=${JSON.stringify(inflightDir)}/p_$$`,
        'touch "$marker"',
        `conc=$(ls -1 ${JSON.stringify(inflightDir)} | wc -l)`,
        `printf '%s\\n' "$conc" >> ${JSON.stringify(maxConcPath)}`,
        'case "$base" in',
        '  sheet-1.png) sleep 0.28 ;;',
        '  sheet-2.png) sleep 0.22 ;;',
        '  sheet-3.png) sleep 0.16 ;;',
        '  *) sleep 0.10 ;;',
        'esac',
        'echo "OUT:$base:OMP=$OMP_THREAD_LIMIT"',
        'rm -f "$marker"',
      ].join('\n') + '\n',
      { mode: 0o755 }
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      OMP_THREAD_LIMIT: '32',
    };

    const runOcr = async (args: string[]) => {
      const cap = createCaptureIo();
      const res = await runRecordCommand('ocr', [...args, '--cache-dir', cacheDir], {
        io: cap.io,
        env,
        telemetryFilePath: telemetryFile,
      });
      return { exitCode: res.exitCode, stdout: cap.stdout.join('\n'), stderr: cap.stderr.join('\n') };
    };

    // 1. Cold parallel batch runs concurrently, preserves exact input order, and emits cache_hit: false.
    const cold = await runOcr([...imgs, '--json']);
    expect(cold.exitCode, cold.stderr).toBe(0);
    const coldBody = JSON.parse(cold.stdout) as {
      count: number;
      cache_hits: number;
      cache_hit: boolean;
      files: Array<{ file: string; cached: boolean; cache_hit: boolean; text: string }>;
    };
    expect(coldBody.count).toBe(4);
    expect(coldBody.cache_hits).toBe(0);
    expect(coldBody.cache_hit).toBe(false);
    expect(coldBody.files.map((f) => [f.file, f.cached, f.cache_hit, f.text])).toEqual([
      [imgs[0], false, false, 'OUT:sheet-1.png:OMP=1'],
      [imgs[1], false, false, 'OUT:sheet-2.png:OMP=1'],
      [imgs[2], false, false, 'OUT:sheet-3.png:OMP=1'],
      [imgs[3], false, false, 'OUT:sheet-4.png:OMP=1'],
    ]);

    const maxObserved = Math.max(
      ...fs.readFileSync(maxConcPath, 'utf8').trim().split('\n').map((s) => Number(s.trim()))
    );
    expect(maxObserved).toBeGreaterThanOrEqual(2);
    expect(maxObserved).toBeLessThanOrEqual(4);
    const callLines = fs.readFileSync(callLog, 'utf8').trim().split('\n');
    expect(callLines).toHaveLength(4);
    expect(callLines.every((line) => line.endsWith('|1'))).toBe(true);

    // 2. Warm batch hits disk cache with zero new tesseract calls and emits cache_hit: true.
    const warm = await runOcr([...imgs, '--json']);
    expect(warm.exitCode, warm.stderr).toBe(0);
    const warmBody = JSON.parse(warm.stdout) as {
      cache_hits: number;
      cache_hit: boolean;
      files: Array<{ cache_hit: boolean }>;
    };
    expect(warmBody.cache_hits).toBe(4);
    expect(warmBody.cache_hit).toBe(true);
    expect(warmBody.files.every((f) => f.cache_hit)).toBe(true);
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(4);

    // 3. Single-file --json emits top-level boolean cache_hit and honors --refresh alias.
    const singleHit = await runOcr([imgs[0], '--json']);
    expect(singleHit.exitCode, singleHit.stderr).toBe(0);
    expect(JSON.parse(singleHit.stdout)).toMatchObject({ cached: true, cache_hit: true });

    const refreshed = await runOcr([imgs[0], '--refresh', '--json']);
    expect(refreshed.exitCode, refreshed.stderr).toBe(0);
    expect(JSON.parse(refreshed.stdout)).toMatchObject({ cached: false, cache_hit: false });
    expect(fs.readFileSync(callLog, 'utf8').trim().split('\n')).toHaveLength(5);

    // 4. Telemetry recorded exact boolean cache_hit values from JSON stdout.
    const events = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.cache_hit)).toEqual([false, true, true, false]);
  });

  it('caps oversized printed scans and rescales --boxes, --find, and --tsv coordinates back to original pixels', async () => {
    const tmp = await makeTempDir('kinloom-ocr-scale-');
    const binDir = path.join(tmp, 'bin');
    const cacheDir = path.join(tmp, 'cache');
    const bigPng = path.join(tmp, 'oversized-4000x3000.png');
    const seenSizesPath = path.join(tmp, 'seen-sizes.log');
    fs.mkdirSync(binDir, { recursive: true });

    // Generate a minimal valid 4000x3000 grayscale PNG using Python stdlib zlib/struct (no Pillow required).
    execFileSync('python3', [
      '-c',
      [
        'import struct, sys, zlib',
        'w, h = 4000, 3000',
        'def chunk(tag, data):',
        '    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)',
        'ihdr = struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)',
        'raw = (b"\\x00" + b"\\xff" * w) * h',
        'idat = zlib.compress(raw, level=1)',
        'png = b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")',
        'open(sys.argv[1], "wb").write(png)',
      ].join('\n'),
      bigPng,
    ]);

    // Fake tesseract inspects the actual PNG or JPEG dimensions it received and emits TSV coordinates in that scaled space.
    await writeFile(
      path.join(binDir, 'tesseract'),
      [
        '#!/usr/bin/env python3',
        'import struct, sys',
        'def read_dims(path):',
        '    with open(path, "rb") as fh:',
        '        data = fh.read()',
        '    if data.startswith(b"\\x89PNG\\r\\n\\x1a\\n") and len(data) >= 24:',
        '        return struct.unpack(">II", data[16:24])',
        '    if data.startswith(b"\\xff\\xd8"):',
        '        i = 2',
        '        while i + 4 <= len(data):',
        '            if data[i] != 0xFF:',
        '                i += 1',
        '                continue',
        '            while i < len(data) and data[i] == 0xFF:',
        '                i += 1',
        '            if i >= len(data):',
        '                break',
        '            marker = data[i]',
        '            i += 1',
        '            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:',
        '                continue',
        '            if i + 2 > len(data):',
        '                break',
        '            seg_len = struct.unpack(">H", data[i:i+2])[0]',
        '            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF) and i + 7 <= len(data):',
        '                h, w = struct.unpack(">HH", data[i+3:i+7])',
        '                return (w, h)',
        '            i += max(2, seg_len)',
        '    raise RuntimeError(f"unsupported image format: {path}")',
        'img = sys.argv[1]',
        'w, h = read_dims(img)',
        `open(${JSON.stringify(seenSizesPath)}, "a").write(f"{w}x{h}\\n")`,
        'if "tsv" in sys.argv:',
        '    print("level\\tpage_num\\tblock_num\\tpar_num\\tline_num\\tword_num\\tleft\\ttop\\twidth\\theight\\tconf\\ttext")',
        '    print(f"1\\t1\\t0\\t0\\t0\\t0\\t0\\t0\\t{w}\\t{h}\\t-1\\t")',
        '    # Place a word at exactly 10%..30% X and 20%..25% Y in scaled coordinates.',
        '    x0, y0 = round(w * 0.10), round(h * 0.20)',
        '    bw, bh = round(w * 0.20), round(h * 0.05)',
        '    print(f"5\\t1\\t1\\t1\\t1\\t1\\t{x0}\\t{y0}\\t{bw}\\t{bh}\\t93\\tProbate")',
        'else:',
        '    print("Probate")',
      ].join('\n') + '\n',
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
    // Coordinates must be rescaled accurately back to original 4000x3000 pixel space.
    expect([body.image_width, body.image_height]).toEqual([4000, 3000]);
    expect(body.cache_hit).toBe(false);
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0].text).toBe('Probate');
    expect(Math.abs(body.lines[0].x0 - 400)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y0 - 600)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].x1 - 1200)).toBeLessThanOrEqual(2);
    expect(Math.abs(body.lines[0].y1 - 750)).toBeLessThanOrEqual(2);

    // If a resizer (Pillow, ImageMagick, or prep-scan) was available, verify tesseract saw <= 3500px.
    const seen = fs.readFileSync(seenSizesPath, 'utf8').trim();
    const [seenW, seenH] = seen.split('x').map(Number);
    expect(Math.max(seenW, seenH)).toBeLessThanOrEqual(3500);

    // Cached --tsv must also expose the rescaled 4000x3000 page box and hit cache.
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

  it('routes openarchieven get, findagrave show, wikitree get/show/profile, nara show, and archive-org show with boolean cache_hit telemetry', async () => {
    const tmp = await makeTempDir('kinloom-wave45-aliases-');
    const telemetryFile = path.join(tmp, 'calls.jsonl');
    const cases: Array<{ command: string; args: string[]; stdout: string; expectedSubcmd: string; expectedHit: boolean }> = [
      {
        command: 'openarchieven',
        args: ['get', 'bhi:11111111-2222-3333-4444-555555555555', '--json'],
        stdout: '{"records":[],"cache_hit":true}\n',
        expectedSubcmd: 'openarchieven get',
        expectedHit: true,
      },
      {
        command: 'findagrave',
        args: ['show', '627', '--json'],
        stdout: '[{"id":"627","cache_hit":false}]\n',
        expectedSubcmd: 'findagrave show',
        expectedHit: false,
      },
      {
        command: 'wikitree',
        args: ['get', 'Lincoln-1', '--json'],
        stdout: '[{"status":0,"cache_hit":true}]\n',
        expectedSubcmd: 'wikitree get',
        expectedHit: true,
      },
      {
        command: 'wikitree',
        args: ['profile', 'Lincoln-1', '--json'],
        stdout: '[{"status":0,"cache_hit":true}]\n',
        expectedSubcmd: 'wikitree profile',
        expectedHit: true,
      },
      {
        command: 'nara',
        args: ['show', '595367', '--json'],
        stdout: '{"naId":"595367","cache_hit":true}\n',
        expectedSubcmd: 'nara show',
        expectedHit: true,
      },
      {
        command: 'ia',
        args: ['show', 'synthetic_book_1895', '--json'],
        stdout: '{"metadata":{"identifier":"synthetic_book_1895"},"cache_hit":false}\n',
        expectedSubcmd: 'archive-org show',
        expectedHit: false,
      },
    ];

    for (const tc of cases) {
      const cap = createCaptureIo();
      const res = await runRecordCommand(tc.command, tc.args, {
        io: cap.io,
        spawnImpl: createFakeSpawn({ exitCode: 0, stdout: tc.stdout }).spawnImpl,
        telemetryFilePath: telemetryFile,
      });
      expect(res.exitCode, tc.expectedSubcmd).toBe(0);
    }

    const events = (await readFile(telemetryFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as TelemetryEvent);
    expect(events.map((e) => e.subcmd)).toEqual(cases.map((tc) => tc.expectedSubcmd));
    expect(events.map((e) => e.cache_hit)).toEqual(cases.map((tc) => tc.expectedHit));
  });
});
