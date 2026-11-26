import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from './cli.js';
import { EXIT_OK, EXIT_USAGE } from './errors.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createCaptureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
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
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('unified kinloom CLI dispatch', () => {
  it('prints grouped top-level help covering lifecycle, ops, and record commands', async () => {
    const { io, stdout, stderr } = createCaptureIo();
    const code = await runCli(['--help'], { io });
    expect(code).toBe(EXIT_OK);
    expect(stderr).toEqual([]);

    const output = stdout.join('\n');
    expect(output).toContain('Archive lifecycle:');
    expect(output).toContain('Research & archive ops:');
    expect(output).toContain('Federal & general record archives:');
    expect(output).toContain('State archives:');
    expect(output).toContain('International archives:');
    expect(output).toContain('Research directories & guides:');
    expect(output).toContain('Media, scan prep & OCR:');
    expect(output).toContain('context');
    expect(output).toContain('integrate');
    expect(output).toContain('audit');
    expect(output).toContain('sync');
    expect(output).toContain('telemetry');
    expect(output).toContain('nara');
    expect(output).toContain('archive-org');
    expect(output).toContain('prep-scan');
    expect(output).toContain('ocr');
  });

  it('renders SKILL.md guides with kinloom invocations for help <cmd> and <cmd> --help', async () => {
    const tmp = await makeTempDir('kinloom-cli-help-');
    process.env.KINLOOM_TELEMETRY_FILE = path.join(tmp, 'calls.jsonl');

    const helpNara = createCaptureIo();
    expect(await runCli(['help', 'nara'], { io: helpNara.io })).toBe(EXIT_OK);
    expect(helpNara.stdout.join('\n')).toContain('kinloom nara');
    expect(helpNara.stdout.join('\n')).not.toContain('skills/nara-catalog-search/scripts/nara');

    const naraFlag = createCaptureIo();
    expect(await runCli(['nara', '--help'], { io: naraFlag.io })).toBe(EXIT_OK);
    expect(naraFlag.stdout.join('\n')).toContain('kinloom nara');
    expect(naraFlag.stdout.join('\n')).toContain('--script-help');

    const helpIa = createCaptureIo();
    expect(await runCli(['help', 'ia'], { io: helpIa.io })).toBe(EXIT_OK);
    expect(helpIa.stdout.join('\n')).toContain('Aliases: kinloom ia');
    expect(helpIa.stdout.join('\n')).toContain('kinloom archive-org');

    const blm = createCaptureIo();
    expect(await runCli(['blm-glo'], { io: blm.io })).toBe(EXIT_OK);
    expect(blm.stdout.join('\n')).toContain('# BLM GLO Records');
  });

  it('serves help for all ops commands and scan/OCR utilities', async () => {
    const tmp = await makeTempDir('kinloom-cli-ops-help-');
    process.env.KINLOOM_TELEMETRY_FILE = path.join(tmp, 'calls.jsonl');

    const checks: Array<[string[], string]> = [
      [['context', '--help'], 'Usage: kinloom context'],
      [['audit', '--help'], 'Usage: kinloom audit'],
      [['integrate', '--help'], 'Usage: kinloom integrate'],
      [['sync', '--help'], 'Usage: kinloom sync'],
      [['telemetry', '--help'], 'Usage: kinloom telemetry report'],
      [['prep-scan', '--help'], '# Scan Preparation'],
      [['ocr', '--help'], '# Cached OCR'],
    ];

    for (const [args, expected] of checks) {
      const cap = createCaptureIo();
      const code = await runCli(args, { io: cap.io });
      expect(code).toBe(EXIT_OK);
      expect(cap.stderr).toEqual([]);
      expect(cap.stdout.join('\n')).toContain(expected);
    }
  });

  it('dispatches telemetry report against a JSONL file', async () => {
    const tmp = await makeTempDir('kinloom-cli-telemetry-');
    const telPath = path.join(tmp, 'calls.jsonl');
    await writeFile(
      telPath,
      `${JSON.stringify({
        ts: '2026-11-25T12:00:00Z',
        cmd: 'kinloom',
        subcmd: 'context',
        person_id: 'per_arthur_alder',
        duration_ms: 42,
        cache_hit: null,
        exit_code: 0,
        bytes_out: 1024,
      })}\n`,
      'utf8'
    );

    const cap = createCaptureIo();
    const code = await runCli(['telemetry', 'report', '--file', telPath, '--json'], { io: cap.io });
    expect(code).toBe(EXIT_OK);
    expect(cap.stderr).toEqual([]);
    const parsed = JSON.parse(cap.stdout.join('\n')) as {
      totalEvents: number;
      rows: Array<{ subcmd: string; count: number }>;
    };
    expect(parsed.totalEvents).toBe(1);
    expect(parsed.rows[0].subcmd).toBe('context');
  });

  it('returns EXIT_USAGE (2) for unknown commands and unknown help targets', async () => {
    const unknownCmd = createCaptureIo();
    expect(await runCli(['nonexistent-command'], { io: unknownCmd.io })).toBe(EXIT_USAGE);
    expect(unknownCmd.stderr.join('\n')).toContain("Unknown command 'nonexistent-command'");

    const unknownHelp = createCaptureIo();
    expect(await runCli(['help', 'nonexistent-command'], { io: unknownHelp.io })).toBe(EXIT_USAGE);
    expect(unknownHelp.stderr.join('\n')).toContain("Unknown command 'nonexistent-command'");
  });
});
