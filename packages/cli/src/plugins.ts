import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { type KinloomSiteConfig, parseKinloomConfigYaml } from '@kinloom/core';
import { CORE_CLI_COMMANDS } from './cli/builtinCatalog.js';
import { isRecordCommand } from './commands/records/registry.js';
import { EXIT_USAGE } from './errors.js';
import type {
  DiscoverSiteCliPluginsResult,
  ExecutedPluginCheckResult,
  KinloomAuditCheck,
  KinloomCheckResult,
  KinloomCliCommand,
  KinloomCliPlugin,
  KinloomVerifyCheck,
  RegisteredAuditCheck,
  RegisteredVerifyCheck,
  ResolvedPluginCommands,
} from './pluginTypes.js';

export type {
  DiscoverSiteCliPluginsResult,
  ExecutedPluginCheckResult,
  KinloomAuditCheck,
  KinloomAuditCheckContext,
  KinloomCheckResult,
  KinloomCliCommand,
  KinloomCliPlugin,
  KinloomCliPluginContext,
  KinloomVerifyCheck,
  KinloomVerifyCheckContext,
  RegisteredAuditCheck,
  RegisteredVerifyCheck,
  ResolvedPluginCommands,
} from './pluginTypes.js';
export { CORE_CLI_COMMANDS };

export const RESERVED_AUDIT_CHECK_IDS: ReadonlySet<string> = new Set(['pronunciation']);
export const RESERVED_VERIFY_CHECK_IDS: ReadonlySet<string> = new Set(['pronunciation']);

export class CliPluginValidationError extends RangeError {
  readonly exitCode = EXIT_USAGE;

  constructor(message: string) {
    super(message);
    this.name = 'CliPluginValidationError';
  }
}

export function isBuiltInCliCommand(name: string): boolean {
  const normalized = name.trim();
  return CORE_CLI_COMMANDS.has(normalized) || isRecordCommand(normalized);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isKinloomCliCommand(value: unknown): value is KinloomCliCommand {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.name) &&
    typeof candidate.summary === 'string' &&
    typeof candidate.help === 'string' &&
    typeof candidate.run === 'function'
  );
}

function isKinloomCheck(value: unknown): value is { id: string; name: string; run: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) && isNonEmptyString(candidate.name) && typeof candidate.run === 'function'
  );
}

function isKinloomCliPlugin(value: unknown): value is KinloomCliPlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isNonEmptyString(candidate.id) || !isNonEmptyString(candidate.name)) {
    return false;
  }
  const hasCommands = candidate.commands !== undefined;
  const hasAuditChecks = candidate.auditChecks !== undefined;
  const hasVerifyChecks = candidate.verifyChecks !== undefined;
  if (!hasCommands && !hasAuditChecks && !hasVerifyChecks) {
    return false;
  }
  if (hasCommands && (!Array.isArray(candidate.commands) || !candidate.commands.every(isKinloomCliCommand))) {
    return false;
  }
  if (
    hasAuditChecks &&
    (!Array.isArray(candidate.auditChecks) || !candidate.auditChecks.every(isKinloomCheck))
  ) {
    return false;
  }
  if (
    hasVerifyChecks &&
    (!Array.isArray(candidate.verifyChecks) || !candidate.verifyChecks.every(isKinloomCheck))
  ) {
    return false;
  }
  return true;
}

function extractCliPluginFromModule(mod: unknown): KinloomCliPlugin | null {
  if (typeof mod !== 'object' || mod === null) {
    return null;
  }
  const record = mod as Record<string, unknown>;
  for (const key of ['default', 'cliPlugin', 'plugin'] as const) {
    const candidate = record[key];
    if (isKinloomCliPlugin(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isExistingFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

async function isExistingDirectory(dirPath: string): Promise<boolean> {
  try {
    const info = await stat(dirPath);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function resolveDirectoryCliEntry(dirPath: string): Promise<string | null> {
  for (const fileName of ['cli.mjs', 'cli.js'] as const) {
    const candidate = path.join(dirPath, fileName);
    if (await isExistingFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function resolvePluginImportTarget(cwd: string, specifier: string): Promise<string> {
  const trimmed = specifier.trim();
  if (trimmed.startsWith('file:')) {
    return trimmed;
  }
  if (
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed === '.' ||
    trimmed === '..' ||
    path.isAbsolute(trimmed)
  ) {
    const resolvedPath = path.resolve(cwd, trimmed);
    if (await isExistingDirectory(resolvedPath)) {
      const dirEntry = await resolveDirectoryCliEntry(resolvedPath);
      if (dirEntry) {
        return pathToFileURL(dirEntry).href;
      }
    }
    return pathToFileURL(resolvedPath).href;
  }

  try {
    const siteRequire = createRequire(path.join(cwd, 'package.json'));
    const resolvedPackagePath = siteRequire.resolve(trimmed);
    return pathToFileURL(resolvedPackagePath).href;
  } catch {
    return trimmed;
  }
}

export function resolvePluginCommands(plugins: readonly KinloomCliPlugin[]): ResolvedPluginCommands {
  const seenPluginIds = new Set<string>();
  const seenAuditCheckIds = new Set<string>();
  const seenVerifyCheckIds = new Set<string>();
  const commands = new Map<string, KinloomCliCommand>();
  const auditChecks: RegisteredAuditCheck[] = [];
  const verifyChecks: RegisteredVerifyCheck[] = [];
  const acceptedPlugins: KinloomCliPlugin[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (!pluginId) {
      throw new CliPluginValidationError('CLI plugin id must be a non-empty string.');
    }
    if (seenPluginIds.has(pluginId)) {
      throw new CliPluginValidationError(`Duplicate CLI plugin id '${pluginId}'.`);
    }
    seenPluginIds.add(pluginId);

    const acceptedCommands: KinloomCliCommand[] = [];
    for (const cmd of plugin.commands ?? []) {
      const cmdName = cmd.name.trim();
      if (!cmdName) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' command name must be a non-empty string.`
        );
      }
      if (isBuiltInCliCommand(cmdName)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' command '${cmdName}' collides with built-in CLI command '${cmdName}'.`
        );
      }
      if (commands.has(cmdName)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' attempted to register duplicate command '${cmdName}'.`
        );
      }
      const normalizedCmd: KinloomCliCommand = cmdName === cmd.name ? cmd : { ...cmd, name: cmdName };
      commands.set(cmdName, normalizedCmd);
      acceptedCommands.push(normalizedCmd);
    }

    const acceptedAuditChecks: KinloomAuditCheck[] = [];
    for (const check of plugin.auditChecks ?? []) {
      const checkId = check.id.trim();
      if (!checkId) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' audit check id must be a non-empty string.`
        );
      }
      if (RESERVED_AUDIT_CHECK_IDS.has(checkId)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' audit check '${checkId}' collides with reserved built-in audit check '${checkId}'.`
        );
      }
      if (seenAuditCheckIds.has(checkId)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' attempted to register duplicate audit check '${checkId}'.`
        );
      }
      seenAuditCheckIds.add(checkId);
      const normalizedCheck: KinloomAuditCheck = checkId === check.id ? check : { ...check, id: checkId };
      acceptedAuditChecks.push(normalizedCheck);
      auditChecks.push({ pluginId, check: normalizedCheck });
    }

    const acceptedVerifyChecks: KinloomVerifyCheck[] = [];
    for (const check of plugin.verifyChecks ?? []) {
      const checkId = check.id.trim();
      if (!checkId) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' verify check id must be a non-empty string.`
        );
      }
      if (RESERVED_VERIFY_CHECK_IDS.has(checkId)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' verify check '${checkId}' collides with reserved built-in verify check '${checkId}'.`
        );
      }
      if (seenVerifyCheckIds.has(checkId)) {
        throw new CliPluginValidationError(
          `CLI plugin '${pluginId}' attempted to register duplicate verify check '${checkId}'.`
        );
      }
      seenVerifyCheckIds.add(checkId);
      const normalizedCheck: KinloomVerifyCheck = checkId === check.id ? check : { ...check, id: checkId };
      acceptedVerifyChecks.push(normalizedCheck);
      verifyChecks.push({ pluginId, check: normalizedCheck });
    }

    if (acceptedCommands.length > 0 || acceptedAuditChecks.length > 0 || acceptedVerifyChecks.length > 0) {
      acceptedPlugins.push({
        id: pluginId,
        name: plugin.name,
        commands: acceptedCommands,
        ...(acceptedAuditChecks.length > 0 ? { auditChecks: acceptedAuditChecks } : {}),
        ...(acceptedVerifyChecks.length > 0 ? { verifyChecks: acceptedVerifyChecks } : {}),
      });
    }
  }

  return {
    plugins: acceptedPlugins,
    commands,
    auditChecks,
    verifyChecks,
    warnings: [],
  };
}

export async function runRegisteredCheck<TContext>(
  pluginId: string,
  check: {
    readonly id: string;
    readonly name: string;
    run(ctx: TContext): Promise<KinloomCheckResult> | KinloomCheckResult;
  },
  ctx: TContext
): Promise<ExecutedPluginCheckResult> {
  const t0 = performance.now();
  try {
    const raw = await check.run(ctx);
    const errors = [...(raw.errors ?? [])];
    const warnings = [...(raw.warnings ?? [])];
    const strictFailures = [...(raw.strictFailures ?? []), ...(raw.strictWarnings ?? [])];
    const durationMs = Math.round(performance.now() - t0);
    return {
      pluginId,
      id: check.id,
      name: check.name,
      ok: errors.length === 0,
      strictOk: errors.length === 0 && strictFailures.length === 0,
      durationMs,
      errors,
      warnings,
      strictFailures,
      ...(raw.details !== undefined ? { details: raw.details } : {}),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const durationMs = Math.round(performance.now() - t0);
    return {
      pluginId,
      id: check.id,
      name: check.name,
      ok: false,
      strictOk: false,
      durationMs,
      errors: [`Check '${check.id}' threw an error: ${message}`],
      warnings: [],
      strictFailures: [],
    };
  }
}

export function formatPluginCommandsHelp(plugins: readonly KinloomCliPlugin[]): string {
  const rows: string[] = [];
  for (const plugin of plugins) {
    for (const cmd of plugin.commands ?? []) {
      const padded = cmd.name.length >= 18 ? `${cmd.name}  ` : `${cmd.name.padEnd(18)} `;
      rows.push(`  ${padded}${cmd.summary}`);
    }
  }
  if (rows.length === 0) {
    return '';
  }
  return `Site plugin commands:\n${rows.join('\n')}`;
}

export async function discoverSiteCliPlugins(cwd: string): Promise<DiscoverSiteCliPluginsResult> {
  const warnings: string[] = [];
  let siteConfig: KinloomSiteConfig | null = null;

  const configPath = path.join(cwd, 'kinloom.config.yaml');
  if (await isExistingFile(configPath)) {
    try {
      const rawYaml = await readFile(configPath, 'utf8');
      siteConfig = parseKinloomConfigYaml(rawYaml);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not parse kinloom.config.yaml: ${message}`);
    }
  }

  const candidateSpecifiers: string[] = [];
  for (const configured of siteConfig?.plugins ?? []) {
    if (typeof configured === 'string' && configured.trim().length > 0) {
      candidateSpecifiers.push(configured.trim());
    }
  }

  const extensionsDir = path.join(cwd, 'extensions');
  if (await isExistingDirectory(extensionsDir)) {
    try {
      const entries = await readdir(extensionsDir, { withFileTypes: true });
      const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of sortedEntries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const entryDir = path.join(extensionsDir, entry.name);
        if (!(await isExistingDirectory(entryDir))) {
          continue;
        }
        const cliEntry = await resolveDirectoryCliEntry(entryDir);
        if (cliEntry) {
          candidateSpecifiers.push(cliEntry);
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Could not scan extensions directory: ${message}`);
    }
  }

  const seenImportTargets = new Set<string>();
  const loadedPlugins: KinloomCliPlugin[] = [];

  for (const specifier of candidateSpecifiers) {
    const importTarget = await resolvePluginImportTarget(cwd, specifier);
    if (seenImportTargets.has(importTarget)) {
      continue;
    }
    seenImportTargets.add(importTarget);

    try {
      const mod: unknown = await import(importTarget);
      const plugin = extractCliPluginFromModule(mod);
      if (!plugin) {
        warnings.push(
          `CLI plugin module '${specifier}' does not export a valid KinloomCliPlugin (expected default, cliPlugin, or plugin export).`
        );
        continue;
      }
      loadedPlugins.push(plugin);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to load CLI plugin '${specifier}': ${message}`);
    }
  }

  const resolved = resolvePluginCommands(loadedPlugins);
  warnings.push(...resolved.warnings);

  return {
    plugins: resolved.plugins,
    siteConfig,
    warnings,
  };
}
