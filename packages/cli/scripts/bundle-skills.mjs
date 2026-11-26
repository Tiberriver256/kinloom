#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(CLI_PKG_ROOT, '..', '..');

const IGNORED_NAMES = new Set(['__pycache__', '.DS_Store']);

function shouldSkipEntry(name) {
  if (IGNORED_NAMES.has(name)) {
    return true;
  }
  if (name.startsWith('.') || name.endsWith('.pyc') || name.endsWith('.pyo')) {
    return true;
  }
  return false;
}

function copyFileAtomic(srcPath, destPath, executable) {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(destPath)}.tmp.${process.pid}.${Date.now()}`);
  fs.copyFileSync(srcPath, tmpPath);
  if (executable) {
    fs.chmodSync(tmpPath, 0o755);
  }
  fs.renameSync(tmpPath, destPath);
}

function pruneStaleEntries(rootDir, expectedPaths) {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      pruneStaleEntries(fullPath, expectedPaths);
      if (!expectedPaths.has(fullPath) && fs.readdirSync(fullPath).length === 0) {
        fs.rmdirSync(fullPath);
      }
      continue;
    }
    if (!expectedPaths.has(fullPath)) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}

function copyDirectoryFiles(srcDir, destDir, executable, expectedPaths) {
  let count = 0;
  if (!fs.existsSync(srcDir)) {
    return count;
  }
  fs.mkdirSync(destDir, { recursive: true });
  expectedPaths.add(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (shouldSkipEntry(entry.name)) {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      count += copyDirectoryFiles(srcPath, destPath, executable, expectedPaths);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    copyFileAtomic(srcPath, destPath, executable);
    expectedPaths.add(destPath);
    count += 1;
  }
  return count;
}

export function bundleSkills(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? REPO_ROOT);
  const cliPkgRoot = path.resolve(options.cliPkgRoot ?? CLI_PKG_ROOT);
  const outDir = path.resolve(options.outDir ?? path.join(cliPkgRoot, 'dist'));

  const skillsSrcRoot = path.join(repoRoot, 'skills');
  const assetsSrcRoot = path.join(cliPkgRoot, 'assets');
  const skillsDestRoot = path.join(outDir, 'bundled-skills');
  const assetsDestRoot = path.join(outDir, 'assets');

  if (!fs.existsSync(skillsSrcRoot)) {
    throw new Error(`Skills source directory not found: ${skillsSrcRoot}`);
  }
  if (!fs.existsSync(assetsSrcRoot)) {
    throw new Error(`CLI assets source directory not found: ${assetsSrcRoot}`);
  }

  // Overwrite in place via atomic rename so concurrent CLI readers never see missing files.
  fs.mkdirSync(skillsDestRoot, { recursive: true });
  fs.mkdirSync(assetsDestRoot, { recursive: true });

  const expectedSkillsPaths = new Set([skillsDestRoot]);
  const expectedAssetsPaths = new Set([assetsDestRoot]);

  const bundledSkills = [];
  let copiedScripts = 0;
  let copiedReferences = 0;

  const skillEntries = fs
    .readdirSync(skillsSrcRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !shouldSkipEntry(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of skillEntries) {
    const skillDir = path.join(skillsSrcRoot, entry.name);
    const skillMdSrc = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillMdSrc)) {
      continue;
    }

    const skillDest = path.join(skillsDestRoot, entry.name);
    fs.mkdirSync(skillDest, { recursive: true });
    expectedSkillsPaths.add(skillDest);
    const skillMdDest = path.join(skillDest, 'SKILL.md');
    copyFileAtomic(skillMdSrc, skillMdDest, false);
    expectedSkillsPaths.add(skillMdDest);

    const scriptsSrc = path.join(skillDir, 'scripts');
    if (fs.existsSync(scriptsSrc)) {
      copiedScripts += copyDirectoryFiles(
        scriptsSrc,
        path.join(skillDest, 'scripts'),
        true,
        expectedSkillsPaths
      );
    }

    const refsSrc = path.join(skillDir, 'references');
    if (fs.existsSync(refsSrc)) {
      copiedReferences += copyDirectoryFiles(
        refsSrc,
        path.join(skillDest, 'references'),
        false,
        expectedSkillsPaths
      );
    }

    bundledSkills.push(entry.name);
  }

  const copiedAssets = [];
  for (const entry of fs.readdirSync(assetsSrcRoot, { withFileTypes: true })) {
    if (shouldSkipEntry(entry.name) || !entry.isFile()) {
      continue;
    }
    const srcPath = path.join(assetsSrcRoot, entry.name);
    const destPath = path.join(assetsDestRoot, entry.name);
    copyFileAtomic(srcPath, destPath, entry.name.endsWith('.py'));
    expectedAssetsPaths.add(destPath);
    copiedAssets.push(entry.name);
  }
  copiedAssets.sort();

  pruneStaleEntries(skillsDestRoot, expectedSkillsPaths);
  pruneStaleEntries(assetsDestRoot, expectedAssetsPaths);

  const cliJsPath = path.join(outDir, 'cli.js');
  if (fs.existsSync(cliJsPath)) {
    fs.chmodSync(cliJsPath, 0o755);
  }

  return {
    outDir,
    skillsDestRoot,
    assetsDestRoot,
    skillsCount: bundledSkills.length,
    bundledSkills,
    copiedScripts,
    copiedReferences,
    copiedAssets,
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
        'Usage: node packages/cli/scripts/bundle-skills.mjs [--out-dir <dir>] [--quiet]\n'
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
  const result = bundleSkills({ outDir });
  if (!quiet) {
    process.stdout.write(
      `Bundled ${result.skillsCount} skills (${result.copiedScripts} scripts, ${result.copiedReferences} references) and ${result.copiedAssets.length} assets into ${result.outDir}\n`
    );
  }
}
