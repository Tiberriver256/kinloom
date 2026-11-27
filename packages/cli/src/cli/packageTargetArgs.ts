import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../errors.js';

export function normalizeIntegratePackageDir(rawPath: string, baseDir: string): string {
  const resolved = path.resolve(baseDir, rawPath.trim());
  try {
    if (fs.statSync(resolved).isFile() && path.basename(resolved) === 'patch.json') {
      return path.dirname(resolved);
    }
  } catch {
    // Missing paths stay as-is so downstream validation reports the exact missing path.
  }
  return resolved;
}

export function readPersonIdFromPackageDir(packageDir: string): string | undefined {
  const patchPath = path.join(packageDir, 'patch.json');
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const personId = (raw as Record<string, unknown>).person_id;
      if (typeof personId === 'string' && personId.trim().length > 0) {
        return personId.trim();
      }
    }
  } catch {
    // Missing or malformed patch.json is reported downstream.
  }
  return undefined;
}

function resolvePositionalIntegratePackage(
  token: string,
  baseDir: string
): { packageDir: string; personId: string } | undefined {
  const looksLikePath =
    token.includes('/') || token.includes('\\') || token.endsWith('.json') || token.startsWith('.');
  const resolved = path.resolve(baseDir, token);
  if (!looksLikePath && !fs.existsSync(resolved)) {
    return undefined;
  }
  try {
    const stat = fs.statSync(resolved);
    const pkgDir =
      stat.isFile() && path.basename(resolved) === 'patch.json'
        ? path.dirname(resolved)
        : stat.isDirectory() && fs.existsSync(path.join(resolved, 'patch.json'))
          ? resolved
          : undefined;
    if (!pkgDir) {
      return undefined;
    }
    const inferredPersonId = readPersonIdFromPackageDir(pkgDir) ?? path.basename(pkgDir);
    return { packageDir: pkgDir, personId: inferredPersonId };
  } catch {
    return undefined;
  }
}

export interface PackageTargetFlagsInput {
  positionals: readonly string[];
  person?: string;
  personId?: string;
  repo?: string;
  package?: string;
  packageDir?: string;
  patch?: string;
  allStaged: boolean;
  pendingOnly: boolean;
  markIntegrated?: boolean;
}

export interface ResolvedPackageTargetFlags {
  positionalIds: string[];
  personFlag?: string;
  effectiveRepoDir: string;
  packageDir?: string;
}

export function parsePackageTargetFlags(
  input: PackageTargetFlagsInput,
  cwd: string
): ResolvedPackageTargetFlags {
  const positionalIds = input.positionals.map((id) => id.trim()).filter((id) => id.length > 0);
  const packageFlags = [
    input.package !== undefined ? '--package' : undefined,
    input.packageDir !== undefined ? '--package-dir' : undefined,
    input.patch !== undefined ? '--patch' : undefined,
  ].filter((flag): flag is string => flag !== undefined);
  if (packageFlags.length > 1) {
    throw new CliValidationError(
      `Specify only one of ${packageFlags.map((flag) => `\`${flag}\``).join(' or ')}, not both.`
    );
  }
  if (
    input.person !== undefined &&
    input.personId !== undefined &&
    input.person.trim() !== input.personId.trim()
  ) {
    throw new CliValidationError(
      'Specify either `--person` or `--person-id` with matching values, not conflicting ids.'
    );
  }

  const personFlag = input.person?.trim() || input.personId?.trim() || undefined;
  const effectiveRepoDir = input.repo?.trim() || cwd;
  const rawPackageDir = input.packageDir ?? input.package ?? input.patch;
  const packageDir = rawPackageDir
    ? normalizeIntegratePackageDir(rawPackageDir, effectiveRepoDir)
    : undefined;

  if (input.pendingOnly && !input.allStaged) {
    throw new CliValidationError('Option `--pending-only` requires `--all-staged`.');
  }
  if (input.markIntegrated && (!input.allStaged || !input.pendingOnly)) {
    throw new CliValidationError(
      'Option `--mark-integrated` requires both `--all-staged` and `--pending-only`.'
    );
  }
  if (input.allStaged && (positionalIds.length > 0 || personFlag)) {
    throw new CliValidationError(
      '`--all-staged` discovers person ids from research/people and does not take person ids.'
    );
  }
  if (personFlag && positionalIds.length > 0) {
    throw new CliValidationError('Pass person ids as positionals or with `--person`, not both.');
  }

  return { positionalIds, personFlag, effectiveRepoDir, packageDir };
}

export function resolveSinglePackageTarget(target: ResolvedPackageTargetFlags): {
  personId?: string;
  packageDir?: string;
} {
  let resolvedPersonId: string | undefined = target.personFlag ?? target.positionalIds[0];
  let packageDir = target.packageDir;
  if (!target.personFlag && !packageDir && target.positionalIds.length === 1) {
    const fromPositionalPath = resolvePositionalIntegratePackage(
      target.positionalIds[0],
      target.effectiveRepoDir
    );
    if (fromPositionalPath) {
      packageDir = fromPositionalPath.packageDir;
      resolvedPersonId = fromPositionalPath.personId;
    }
  }
  if (!resolvedPersonId && packageDir) {
    resolvedPersonId = readPersonIdFromPackageDir(packageDir);
  }
  return { personId: resolvedPersonId, packageDir };
}
