#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, '..', '..');

const LEGACY_DIST_DIRS = ['bundled-skills', 'assets'];

function copyFileAtomic(srcPath, destPath) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp.${process.pid}.${Date.now()}`);
  fs.copyFileSync(srcPath, tmpPath);
  fs.renameSync(tmpPath, destPath);
}

function pruneStaleSqlFiles(migrationsDestRoot, expectedPaths) {
  if (!fs.existsSync(migrationsDestRoot)) {
    return;
  }
  for (const entry of fs.readdirSync(migrationsDestRoot, { withFileTypes: true })) {
    const fullPath = path.join(migrationsDestRoot, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      continue;
    }
    if (!expectedPaths.has(fullPath)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

export function copyMigrations(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const cliPkgRoot = path.resolve(options.cliPkgRoot ?? CLI_PKG_ROOT);
  const outDir = path.resolve(options.outDir ?? path.join(cliPkgRoot, 'dist'));

  const migrationsSrcRoot = path.join(repoRoot, 'packages', 'worker', 'migrations');
  const migrationsDestRoot = path.join(outDir, 'migrations');
  const expectedMigrationsPaths = new Set();
  const copiedMigrations = [];

  if (fs.existsSync(migrationsSrcRoot)) {
    fs.mkdirSync(migrationsDestRoot, { recursive: true });
    for (const entry of fs.readdirSync(migrationsSrcRoot, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || !entry.isFile() || !entry.name.endsWith('.sql')) {
        continue;
      }
      const srcPath = path.join(migrationsSrcRoot, entry.name);
      const destPath = path.join(migrationsDestRoot, entry.name);
      copyFileAtomic(srcPath, destPath);
      expectedMigrationsPaths.add(destPath);
      copiedMigrations.push(entry.name);
    }
    copiedMigrations.sort();
    pruneStaleSqlFiles(migrationsDestRoot, expectedMigrationsPaths);
  }

  // Remove obsolete pre-migration asset directories without touching dist/cli.js.
  for (const legacyDir of LEGACY_DIST_DIRS) {
    const legacyPath = path.join(outDir, legacyDir);
    if (fs.existsSync(legacyPath)) {
      fs.rmSync(legacyPath, { recursive: true, force: true });
    }
  }

  const cliJsPath = path.join(outDir, 'cli.js');
  if (fs.existsSync(cliJsPath)) {
    fs.chmodSync(cliJsPath, 0o755);
  }

  return {
    outDir,
    migrationsDestRoot,
    copiedMigrations,
  };
}

function parseCliArgs(argv) {
  let outDir;
  let quiet = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('Missing value for --out-dir');
      }
      outDir = next;
      i += 1;
    } else if (arg.startsWith('--out-dir=')) {
      outDir = arg.slice('--out-dir='.length);
    } else if (arg === '--quiet') {
      quiet = true;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(
        'Usage: node packages/cli/scripts/copy-migrations.mjs [--out-dir <dir>] [--quiet]\n'
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return { outDir, quiet };
}

function isExecutedDirectly() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(entry);
  } catch {
    return fileURLToPath(import.meta.url) === entry;
  }
}

if (isExecutedDirectly()) {
  const { outDir, quiet } = parseCliArgs(process.argv.slice(2));
  const result = copyMigrations({ outDir });
  if (!quiet) {
    process.stdout.write(
      `Copied ${result.copiedMigrations.length} SQL migrations into ${result.migrationsDestRoot}\n`
    );
  }
}
