import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type KinloomSiteConfig, parseKinloomConfigYaml } from '@kinloom/core';
import type { CliIo } from './cli.js';
import { isRecordCommand } from './commands/records/registry.js';
import type { CliExitCode } from './errors.js';

export interface KinloomCliPluginContext {
  readonly cwd: string;
  readonly io: CliIo;
  readonly fetchImpl?: typeof fetch;
  readonly siteConfig?: KinloomSiteConfig | null;
}

export interface KinloomCliCommand {
  readonly name: string;
  readonly summary: string;
  readonly help: string;
  run(args: readonly string[], ctx: KinloomCliPluginContext): Promise<CliExitCode> | CliExitCode;
}

export interface KinloomCliPlugin {
  readonly id: string;
  readonly name: string;
  readonly commands: readonly KinloomCliCommand[];
}

export interface DiscoverSiteCliPluginsResult {
  plugins: KinloomCliPlugin[];
  siteConfig: KinloomSiteConfig | null;
  warnings: string[];
}

export interface ResolvedPluginCommands {
  plugins: KinloomCliPlugin[];
  commands: Map<string, KinloomCliCommand>;
  warnings: string[];
}

export const CORE_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'help',
  'guide',
  'init',
  'slice-gedcom',
  'seed',
  'submit-batch',
  'export-yaml',
  'upload-media',
  'reconcile',
  'context',
  'integrate',
  'audit',
  'verify',
  'status',
  'sync',
  'migrate',
  'dates',
  'pronounce',
  'telemetry',
]);

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

function isKinloomCliPlugin(value: unknown): value is KinloomCliPlugin {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    isNonEmptyString(candidate.id) &&
    isNonEmptyString(candidate.name) &&
    Array.isArray(candidate.commands) &&
    candidate.commands.every((cmd) => isKinloomCliCommand(cmd))
  );
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
  const commands = new Map<string, KinloomCliCommand>();
  const acceptedPlugins: KinloomCliPlugin[] = [];
  const warnings: string[] = [];

  for (const plugin of plugins) {
    const pluginId = plugin.id.trim();
    if (seenPluginIds.has(pluginId)) {
      warnings.push(`Duplicate CLI plugin '${pluginId}'; ignoring subsequent registration.`);
      continue;
    }
    seenPluginIds.add(pluginId);

    const acceptedCommands: KinloomCliCommand[] = [];
    for (const cmd of plugin.commands) {
      const cmdName = cmd.name.trim();
      if (isBuiltInCliCommand(cmdName)) {
        warnings.push(`Plugin '${pluginId}' attempted to shadow built-in command '${cmdName}'; ignoring.`);
        continue;
      }
      if (commands.has(cmdName)) {
        warnings.push(`Plugin '${pluginId}' attempted to register duplicate command '${cmdName}'; ignoring.`);
        continue;
      }
      const normalizedCmd: KinloomCliCommand = cmdName === cmd.name ? cmd : { ...cmd, name: cmdName };
      commands.set(cmdName, normalizedCmd);
      acceptedCommands.push(normalizedCmd);
    }

    if (acceptedCommands.length > 0) {
      acceptedPlugins.push({
        id: pluginId,
        name: plugin.name,
        commands: acceptedCommands,
      });
    }
  }

  return {
    plugins: acceptedPlugins,
    commands,
    warnings,
  };
}

export function formatPluginCommandsHelp(plugins: readonly KinloomCliPlugin[]): string {
  const rows: string[] = [];
  for (const plugin of plugins) {
    for (const cmd of plugin.commands) {
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
