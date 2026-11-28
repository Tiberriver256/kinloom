#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CliIo, DEFAULT_IO, ROOT_HELP, type RunCliOptions, runCli } from './cli/runCli.js';
import { EXIT_ERROR } from './errors.js';

export { type CliIo, DEFAULT_IO, ROOT_HELP, type RunCliOptions, runCli };

function isExecutedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryArg);
  } catch {
    return fileURLToPath(import.meta.url) === entryArg;
  }
}

if (isExecutedDirectly()) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });
  void runCli(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = EXIT_ERROR;
    }
  );
}
