import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AssetScriptCommandSpec, RecordCommandSpec, SkillScriptCommandSpec } from './registry.js';

export interface ResolveRootsOptions {
  /** Override the directory of this module (defaults to directory of resolve.ts/js). */
  moduleDir?: string;
  /** Explicit override for a bundled-skills directory (e.g. dist/bundled-skills). */
  bundledSkillsDir?: string;
  /** Explicit override for a monorepo skills directory (e.g. <repo>/skills). */
  monorepoSkillsDir?: string;
  /** Explicit override for a bundled/dev assets directory (e.g. dist/assets or packages/cli/assets). */
  assetsDir?: string;
}

const DEFAULT_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function candidateSkillDirs(options?: ResolveRootsOptions): string[] {
  const dirs: string[] = [];
  if (options?.bundledSkillsDir) {
    dirs.push(path.resolve(options.bundledSkillsDir));
  }
  if (options?.monorepoSkillsDir) {
    dirs.push(path.resolve(options.monorepoSkillsDir));
  }
  if (dirs.length > 0) {
    return dirs;
  }

  const baseDir = path.resolve(options?.moduleDir ?? DEFAULT_MODULE_DIR);
  // 1. Installed/published layout: dist/commands/records -> dist/bundled-skills
  dirs.push(path.resolve(baseDir, '..', '..', 'bundled-skills'));
  // 2. Package root fallback: packages/cli/dist/bundled-skills when running from src/
  dirs.push(path.resolve(baseDir, '..', '..', '..', 'dist', 'bundled-skills'));
  // 3. Monorepo dev/test layout: packages/cli/src/commands/records -> <repo>/skills
  dirs.push(path.resolve(baseDir, '..', '..', '..', '..', '..', 'skills'));
  return dirs;
}

function candidateAssetDirs(options?: ResolveRootsOptions): string[] {
  if (options?.assetsDir) {
    return [path.resolve(options.assetsDir)];
  }
  const baseDir = path.resolve(options?.moduleDir ?? DEFAULT_MODULE_DIR);
  return [
    // 1. Installed/published layout: dist/commands/records -> dist/assets
    path.resolve(baseDir, '..', '..', 'assets'),
    // 2. Monorepo dev/test layout: packages/cli/src/commands/records -> packages/cli/assets
    path.resolve(baseDir, '..', '..', '..', 'assets'),
  ];
}

function findExistingFile(candidates: readonly string[], label: string): string {
  for (const filePath of candidates) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      return filePath;
    }
  }
  throw new Error(`Could not locate ${label}. Searched:\n${candidates.map((c) => `  - ${c}`).join('\n')}`);
}

export function resolveRecordGuidePath(spec: RecordCommandSpec, options?: ResolveRootsOptions): string {
  if (spec.kind === 'asset-script' || (spec.kind === 'native' && spec.assetGuide)) {
    const assetGuide = spec.assetGuide ?? `${spec.command}.md`;
    const candidates = candidateAssetDirs(options).map((dir) => path.join(dir, assetGuide));
    return findExistingFile(candidates, `guide '${assetGuide}' for '${spec.command}'`);
  }

  const skillDir = spec.skillDir ?? spec.command;
  const candidates = candidateSkillDirs(options).map((dir) => path.join(dir, skillDir, 'SKILL.md'));
  return findExistingFile(candidates, `SKILL.md for '${spec.command}' (${skillDir})`);
}

export function resolveRecordScriptPath(
  spec: SkillScriptCommandSpec | AssetScriptCommandSpec,
  options?: ResolveRootsOptions
): string {
  if (spec.kind === 'asset-script') {
    const candidates = candidateAssetDirs(options).map((dir) => path.join(dir, spec.assetScript));
    return findExistingFile(candidates, `script '${spec.assetScript}' for '${spec.command}'`);
  }

  const candidates = candidateSkillDirs(options).map((dir) =>
    path.join(dir, spec.skillDir, 'scripts', spec.scriptName)
  );
  return findExistingFile(candidates, `script '${spec.scriptName}' for '${spec.command}' (${spec.skillDir})`);
}
