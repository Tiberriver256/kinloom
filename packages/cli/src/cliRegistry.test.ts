import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CLI_COMMANDS,
  COMMAND_HELP,
  ROOT_HELP,
  resolveBuiltInCliCommand,
} from './cli/builtinCommands.js';
import { isRecordCommand, RECORD_COMMAND_SPECS, resolveRecordCommand } from './commands/records/registry.js';
import { CORE_CLI_COMMANDS, isBuiltInCliCommand } from './plugins.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function extractListedRootHelpCommands(helpText: string): string[] {
  const names: string[] = [];
  let inCommandSection = false;
  for (const line of helpText.split('\n')) {
    if (
      /^(?:Archive lifecycle|Research & archive ops|Federal & general|State archives|International archives|Research directories & guides|Media, scan prep & OCR):/.test(
        line
      )
    ) {
      inCommandSection = true;
      continue;
    }
    if (/^(?:Global options|Environment variables|Exit codes):/.test(line)) {
      inCommandSection = false;
      continue;
    }
    if (!inCommandSection) {
      continue;
    }
    const match = /^\s{2}([a-z][a-z0-9-]*)\s{2,}/.exec(line);
    if (match) {
      names.push(match[1]!);
    }
  }
  return names;
}

describe('BUILTIN_CLI_COMMANDS & ROOT_HELP single source of truth', () => {
  it('registers media, query, patch, and every command listed in ROOT_HELP as a built-in command', () => {
    expect(isBuiltInCliCommand('media')).toBe(true);
    expect(CORE_CLI_COMMANDS.has('media')).toBe(true);
    expect(resolveBuiltInCliCommand('media')?.run).toBeTypeOf('function');

    expect(isBuiltInCliCommand('query')).toBe(true);
    expect(CORE_CLI_COMMANDS.has('query')).toBe(true);
    expect(resolveBuiltInCliCommand('query')?.run).toBeTypeOf('function');

    expect(isBuiltInCliCommand('patch')).toBe(true);
    expect(CORE_CLI_COMMANDS.has('patch')).toBe(true);
    expect(resolveBuiltInCliCommand('patch')?.run).toBeTypeOf('function');

    const listedCommands = extractListedRootHelpCommands(ROOT_HELP);
    expect(listedCommands.length).toBeGreaterThan(35);
    for (const cmd of listedCommands) {
      expect(
        isBuiltInCliCommand(cmd),
        `ROOT_HELP command '${cmd}' must be recognized by isBuiltInCliCommand`
      ).toBe(true);
    }
  });

  it('derives CORE_CLI_COMMANDS, COMMAND_HELP, and handlers from BUILTIN_CLI_COMMANDS without drift', () => {
    for (const spec of BUILTIN_CLI_COMMANDS) {
      expect(CORE_CLI_COMMANDS.has(spec.name)).toBe(true);
      expect(isBuiltInCliCommand(spec.name)).toBe(true);
      if (spec.category !== 'meta') {
        expect(COMMAND_HELP[spec.name]).toBe(spec.help);
        expect(ROOT_HELP).toContain(`  ${spec.name.padEnd(19)}${spec.summary}`);
        expect(spec.run).toBeTypeOf('function');
      }
    }
  });
});

describe('RECORD_COMMAND_SPECS lazy client loading', () => {
  it('imports zero record client modules statically in records/registry.ts', async () => {
    const registryPath = path.join(SRC_DIR, 'commands', 'records', 'registry.ts');
    const source = await readFile(registryPath, 'utf8');
    const staticClientImports = source.match(/^\s*import\s+(?!type\b).*from\s+['"]\.\/clients\//gm) ?? [];
    expect(staticClientImports).toEqual([]);
  });

  it('resolves native record specs with lazy loadHandler thunks without eagerly loading clients', () => {
    expect(isRecordCommand('nara')).toBe(true);
    expect(isRecordCommand('ia')).toBe(true);
    expect(resolveRecordCommand('ia')?.command).toBe('archive-org');

    const nativeSpecs = RECORD_COMMAND_SPECS.filter((spec) => spec.kind === 'native');
    expect(nativeSpecs.length).toBe(23);
    for (const spec of nativeSpecs) {
      expect(spec.loadHandler).toBeTypeOf('function');
    }
  });
});
