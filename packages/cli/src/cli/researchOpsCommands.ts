import fs from 'node:fs';
import path from 'node:path';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import { type CliDispatchContext, requireStringFlag, safeParseArgs, writeRenderedOutput } from './types.js';

function bindSignedStatusLimit(args: readonly string[]): string[] {
  const bound: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1];
    if (arg === '--limit' && next !== undefined && /^-?\d+$/.test(next)) {
      bound.push(`--limit=${next}`);
      index += 1;
      continue;
    }
    bound.push(arg);
  }
  return bound;
}

function parseStatusLimit(value: string | undefined): number {
  if (value === undefined) {
    return 8;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliValidationError('Option `--limit` must be an integer greater than or equal to 0.');
  }
  return Number.parseInt(trimmed, 10);
}

function parseStatusFilter(value: string | undefined): 'pending' | 'staged' | 'done_live' | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === 'pending' || trimmed === 'staged' || trimmed === 'done_live') {
    return trimmed;
  }
  throw new CliValidationError('Option `--filter` must be `pending`, `staged`, or `done_live`.');
}

function normalizeIntegratePackageDir(rawPath: string, baseDir: string): string {
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

function readPersonIdFromPackageDir(packageDir: string): string | undefined {
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

interface PackageTargetFlagsInput {
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

interface ResolvedPackageTargetFlags {
  positionalIds: string[];
  personFlag?: string;
  effectiveRepoDir: string;
  packageDir?: string;
}

function parsePackageTargetFlags(input: PackageTargetFlagsInput, cwd: string): ResolvedPackageTargetFlags {
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

function resolveSinglePackageTarget(target: ResolvedPackageTargetFlags): {
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

async function runContext(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values, positionals } = safeParseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      person: { type: 'string' },
      repo: { type: 'string' },
      'ancestry-dir': { type: 'string' },
      'include-family': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const personId = requireStringFlag(values.person ?? positionals[0], '--person');
  const [{ runContextCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/context.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const result = await measureCommand(
    {
      subcmd: 'context',
      personId,
      extractResultMeta: (res) => ({
        personId,
        exitCode: EXIT_OK,
        bytesOut: res.bytesOut,
      }),
    },
    () =>
      runContextCommand({
        repoDir: values.repo ?? ctx.cwd,
        personId,
        ancestryDir: values['ancestry-dir'],
        includeFamily: values['include-family'] || values.full,
        full: values.full,
        json: values.json,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

async function runIntegrate(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values, positionals } = safeParseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      person: { type: 'string' },
      'person-id': { type: 'string' },
      repo: { type: 'string' },
      package: { type: 'string' },
      'package-dir': { type: 'string' },
      patch: { type: 'string' },
      'all-staged': { type: 'boolean', default: false },
      'pending-only': { type: 'boolean', default: false },
      'mark-integrated': { type: 'boolean', default: false },
      'reconcile-receipts': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const markIntegrated = Boolean(values['mark-integrated'] || values['reconcile-receipts']);
  const target = parsePackageTargetFlags(
    {
      positionals,
      person: values.person,
      personId: values['person-id'],
      repo: values.repo,
      package: values.package,
      packageDir: values['package-dir'],
      patch: values.patch,
      allStaged: values['all-staged'],
      pendingOnly: values['pending-only'],
      markIntegrated,
    },
    ctx.cwd
  );

  const useBatch = Boolean(values['all-staged']) || target.positionalIds.length > 1;
  if (useBatch && target.packageDir) {
    throw new CliValidationError('`--package` / `--package-dir` applies to a single person integrate only.');
  }

  if (!useBatch) {
    const resolved = resolveSinglePackageTarget(target);
    if (!resolved.personId) {
      throw new CliValidationError(
        'Missing target person_id. Pass `<person_id>`, `--person <person_id>`, `--package <dir>`, or `--all-staged` (example: `kinloom integrate <person_id> --dry-run`).'
      );
    }
    const personId = resolved.personId;
    const [{ runIntegrateCommand }, { measureCommand }] = await Promise.all([
      import('../commands/ops/integrate.js'),
      import('../commands/ops/telemetry.js'),
    ]);
    const result = await measureCommand(
      {
        subcmd: values['dry-run'] ? 'integrate --dry-run' : 'integrate',
        personId,
        extractResultMeta: (res) => ({
          personId,
          exitCode: EXIT_OK,
          bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
        }),
      },
      () =>
        runIntegrateCommand({
          repoDir: values.repo ?? ctx.cwd,
          personId,
          packageDir: resolved.packageDir,
          dryRun: values['dry-run'],
          json: values.json,
        })
    );
    writeRenderedOutput(ctx.io, result.rendered);
    return EXIT_OK;
  }

  const [{ runIntegrateBatchCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/integrate-batch.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const result = await measureCommand(
    {
      subcmd: values['dry-run'] ? 'integrate --dry-run' : 'integrate',
      personId: null,
      extractResultMeta: (res) => ({
        personId: null,
        exitCode: EXIT_OK,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runIntegrateBatchCommand({
        repoDir: values.repo ?? ctx.cwd,
        personIds: values['all-staged'] ? undefined : target.positionalIds,
        allStaged: values['all-staged'],
        pendingOnly: values['pending-only'],
        markIntegrated,
        dryRun: values['dry-run'],
        json: values.json,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

async function runAudit(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values, positionals } = safeParseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      person: { type: 'string' },
      'person-id': { type: 'string' },
      repo: { type: 'string' },
      package: { type: 'string' },
      'package-dir': { type: 'string' },
      patch: { type: 'string' },
      json: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      'all-staged': { type: 'boolean', default: false },
      'pending-only': { type: 'boolean', default: false },
    },
  });
  const target = parsePackageTargetFlags(
    {
      positionals,
      person: values.person,
      personId: values['person-id'],
      repo: values.repo,
      package: values.package,
      packageDir: values['package-dir'],
      patch: values.patch,
      allStaged: values['all-staged'],
      pendingOnly: values['pending-only'],
    },
    ctx.cwd
  );

  const [auditMod, batchMod, integrateBatchMod, { measureCommand }] = await Promise.all([
    import('../commands/ops/audit.js'),
    import('../commands/ops/audit-overlaps.js'),
    import('../commands/ops/integrate-batch.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const { runAuditCommand } = auditMod;
  const { runAuditBatchCommand, listStagedAuditPersonIds } = batchMod;
  const { classifyStagedPackages } = integrateBatchMod;

  let batchIds = values['all-staged']
    ? listStagedAuditPersonIds(target.effectiveRepoDir)
    : target.positionalIds;
  let skippedAlreadyIntegrated: string[] | undefined;
  let skippedDrifted: string[] | undefined;
  if (values['all-staged'] && !values['pending-only'] && batchIds.length === 0) {
    throw new CliValidationError('No staged packages with patch.json were found under research/people/.');
  }
  if (values['all-staged'] && values['pending-only']) {
    const classified = await classifyStagedPackages(target.effectiveRepoDir, batchIds);
    batchIds = classified.pending;
    skippedAlreadyIntegrated = classified.alreadyIntegrated;
    skippedDrifted = classified.alreadyIntegratedDrifted;
  }

  const useBatch = values['all-staged'] || batchIds.length > 1;
  if (useBatch && target.packageDir) {
    throw new CliValidationError('`--package` / `--package-dir` applies to a single person audit only.');
  }

  if (!useBatch) {
    const resolved = resolveSinglePackageTarget(target);
    const personId = requireStringFlag(resolved.personId, '--person');
    const result = await measureCommand(
      {
        subcmd: 'audit',
        personId,
        extractResultMeta: (res) => ({
          personId,
          exitCode: (values.strict ? res.strictOk : res.ok) ? EXIT_OK : EXIT_ERROR,
          bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
        }),
      },
      () =>
        runAuditCommand({
          repoDir: target.effectiveRepoDir,
          personId,
          packageDir: resolved.packageDir,
          json: values.json,
          ...(ctx.plugins ? { plugins: ctx.plugins } : {}),
        })
    );
    writeRenderedOutput(ctx.io, result.rendered);
    return (values.strict ? result.strictOk : result.ok) ? EXIT_OK : EXIT_ERROR;
  }

  const result = await measureCommand(
    {
      subcmd: 'audit',
      personId: null,
      extractResultMeta: (res) => ({
        personId: null,
        exitCode: (values.strict ? res.strictOk : res.ok) ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runAuditBatchCommand({
        repoDir: target.effectiveRepoDir,
        personIds: batchIds,
        json: values.json,
        pendingOnly: values['pending-only'],
        skippedAlreadyIntegrated,
        skippedDrifted,
        ...(ctx.plugins ? { plugins: ctx.plugins } : {}),
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return (values.strict ? result.strictOk : result.ok) ? EXIT_OK : EXIT_ERROR;
}

async function runMedia(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const sub = rest[0];
  if (sub !== 'dedupe') {
    throw new CliValidationError(
      sub
        ? `Unknown media subcommand '${sub}'. Expected \`dedupe\`.`
        : 'Missing media subcommand. Expected `dedupe` (usage: `kinloom media dedupe [--repo <dir>] [--prefer <id>...] [--apply] [--json]`).'
    );
  }
  const subArgs = rest.slice(1);
  const { values } = safeParseArgs({
    args: subArgs,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      prefer: { type: 'string', multiple: true },
      apply: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const [{ runMediaDedupeCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/media-dedupe.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const result = await measureCommand(
    {
      subcmd: values.apply ? 'media dedupe --apply' : 'media dedupe',
      extractResultMeta: (res) => ({
        exitCode: EXIT_OK,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runMediaDedupeCommand({
        repoDir: values.repo ?? ctx.cwd,
        preferIds: values.prefer,
        apply: values.apply,
        json: values.json,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

async function runVerify(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      'strict-hygiene': { type: 'boolean', default: false },
      'strict-pronunciation': { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const [{ runVerifyCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/verify.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const result = await measureCommand(
    {
      subcmd: 'verify',
      extractResultMeta: (res) => ({
        exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runVerifyCommand({
        repoDir: values.repo ?? ctx.cwd,
        strictHygiene: values['strict-hygiene'] || values.strict,
        strictPronunciation: values['strict-pronunciation'] || values.strict,
        json: values.json,
        ...(ctx.plugins ? { plugins: ctx.plugins } : {}),
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}

async function runStatus(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: bindSignedStatusLimit(rest),
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      limit: { type: 'string' },
      filter: { type: 'string' },
      sort: { type: 'string' },
      'end-of-line': { type: 'boolean', default: false },
      'missing-biography': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const limit = parseStatusLimit(values.limit);
  const filter = parseStatusFilter(values.filter);
  const [{ parseStatusSort, runStatusCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/status.js'),
    import('../commands/ops/telemetry.js'),
  ]);
  const sort = parseStatusSort(values.sort);
  const result = await measureCommand(
    {
      subcmd: 'status',
      extractResultMeta: (res) => ({
        exitCode: EXIT_OK,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runStatusCommand({
        repoDir: values.repo ?? ctx.cwd,
        json: values.json,
        limit,
        filter,
        sort,
        endOfLine: values['end-of-line'],
        missingBiography: values['missing-biography'],
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

export async function dispatchResearchOpsCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext
): Promise<CliExitCode | undefined> {
  switch (command) {
    case 'context':
      return runContext(rest, ctx);
    case 'integrate':
      return runIntegrate(rest, ctx);
    case 'audit':
      return runAudit(rest, ctx);
    case 'media':
      return runMedia(rest, ctx);
    case 'verify':
      return runVerify(rest, ctx);
    case 'status':
      return runStatus(rest, ctx);
    default:
      return undefined;
  }
}
