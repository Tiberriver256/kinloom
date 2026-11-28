import { describe, expect, it } from 'vitest';
import { runCli } from '../../cli.js';
import type { OpsIo } from '../ops/telemetry.js';
import { runRecordCommand } from './dispatch.js';

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

describe('kinloom records discovery alias', () => {
  it('lists all federal, state, international, directory, and media/OCR commands and exits 0 for records and records --help', async () => {
    for (const argv of [['records'], ['records', '--help'], ['records', '-h'], ['help', 'records']]) {
      const cap = createCaptureIo();
      const code = await runCli(argv, { io: cap.io });
      expect(code, argv.join(' ')).toBe(0);
      expect(cap.stderr, argv.join(' ')).toEqual([]);
      const out = cap.stdout.join('\n');
      expect(out).toContain('Usage: kinloom records [command] [args...]');
      expect(out).toContain('Federal & general record archives:');
      expect(out).toContain('State archives:');
      expect(out).toContain('International archives:');
      expect(out).toContain('nara');
      expect(out).toContain('fi-archives');
      expect(out).toContain('openarchieven');
      expect(out).toContain('pdf-grep');
    }
  });

  it('supports kinloom records --json, subcommand forwarding, and error paths via runCli and runRecordCommand', async () => {
    const jsonCap = createCaptureIo();
    const jsonCode = await runCli(['records', '--json'], { io: jsonCap.io });
    expect(jsonCode).toBe(0);
    const catalog = JSON.parse(jsonCap.stdout.join('\n')) as {
      categories: Array<{ id: string }>;
      commands: Array<{ command: string }>;
    };
    expect(catalog.categories.map((c) => c.id)).toContain('federal-general');
    expect(catalog.categories.map((c) => c.id)).toContain('state-archives');
    expect(catalog.categories.map((c) => c.id)).toContain('international');
    expect(catalog.commands.map((c) => c.command)).toContain('pdf-grep');

    // Forwarding via runCli
    const fwdCap = createCaptureIo();
    const fwdCode = await runCli(['records', 'nara', 'aad', '--help'], { io: fwdCap.io });
    expect(fwdCode).toBe(0);
    expect(fwdCap.stdout.join('\n')).toContain('kinloom nara aad [QUERY...] [options]');

    // Direct runRecordCommand('records', ...) paths
    const directHelp = createCaptureIo();
    expect((await runRecordCommand('records', ['--help'], { io: directHelp.io })).exitCode).toBe(0);
    expect(directHelp.stdout.join('\n')).toContain('Usage: kinloom records');

    const directJson = createCaptureIo();
    expect((await runRecordCommand('records', ['--json'], { io: directJson.io })).exitCode).toBe(0);
    expect(JSON.parse(directJson.stdout.join('\n'))).toHaveProperty('commands');

    const directBadFlag = createCaptureIo();
    expect((await runRecordCommand('records', ['--unknown'], { io: directBadFlag.io })).exitCode).toBe(2);
    expect(directBadFlag.stderr.join('\n')).toContain('Unknown option');

    // CLI unknown flag and unknown subcommand
    const cliBadFlag = createCaptureIo();
    expect(await runCli(['records', '--unknown'], { io: cliBadFlag.io })).toBe(2);

    const cliUnknownSub = createCaptureIo();
    expect(await runCli(['records', 'not-a-record-cmd'], { io: cliUnknownSub.io })).toBe(2);
    expect(cliUnknownSub.stderr.join('\n')).toContain("Unknown record command 'not-a-record-cmd'");
  });
});
