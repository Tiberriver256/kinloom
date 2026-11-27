import { renderRecordCommandHelp } from '../commands/records/help.js';
import { resolveRecordCommand } from '../commands/records/registry.js';
import { type CliExitCode, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { renderEmbeddedGuide, resolveEmbeddedGuide } from '../guides/index.js';
import type { CliIo } from '../io.js';
import {
  type DiscoverSiteCliPluginsResult,
  discoverSiteCliPlugins,
  formatPluginCommandsHelp,
  type KinloomCliPlugin,
  type KinloomCliPluginContext,
  type ResolvedPluginCommands,
  resolvePluginCommands,
} from '../plugins.js';
import { COMMAND_HELP, ROOT_HELP } from './builtinCatalog.js';
import { type CliDispatchContext, normalizeExitCode } from './types.js';

export { COMMAND_HELP, ROOT_HELP };

export interface LoadedSitePlugins {
  discovered: DiscoverSiteCliPluginsResult;
  merged: ResolvedPluginCommands;
}

export async function loadSitePlugins(
  cwd: string,
  io: CliIo,
  explicitPlugins?: readonly KinloomCliPlugin[]
): Promise<LoadedSitePlugins> {
  const discovered = await discoverSiteCliPlugins(cwd);
  const merged = resolvePluginCommands([...discovered.plugins, ...(explicitPlugins ?? [])]);
  for (const warning of [...discovered.warnings, ...merged.warnings]) {
    io.stderr(`Warning: ${warning}`);
  }
  return { discovered, merged };
}

export function tryHandleHelpInvocation(
  argv: readonly string[],
  io: CliIo,
  mergedPlugins: ResolvedPluginCommands
): CliExitCode | undefined {
  if (argv.length > 0 && argv[0] !== '-h' && argv[0] !== '--help' && argv[0] !== 'help') {
    return undefined;
  }

  const sub = argv[0] === 'help' ? argv[1] : undefined;
  if (!sub) {
    const pluginHelp = formatPluginCommandsHelp(mergedPlugins.plugins);
    io.stdout(pluginHelp ? `${ROOT_HELP}\n\n${pluginHelp}` : ROOT_HELP);
    return EXIT_OK;
  }
  if (COMMAND_HELP[sub]) {
    io.stdout(COMMAND_HELP[sub]);
    return EXIT_OK;
  }
  const recordSpec = resolveRecordCommand(sub);
  if (recordSpec) {
    io.stdout(renderRecordCommandHelp(recordSpec));
    return EXIT_OK;
  }
  const pluginCmd = mergedPlugins.commands.get(sub);
  if (pluginCmd) {
    io.stdout(pluginCmd.help);
    return EXIT_OK;
  }
  io.stderr(`Unknown command '${sub}'. Run \`kinloom --help\` for available commands.`);
  return EXIT_USAGE;
}

export async function tryDispatchRecordCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext
): Promise<CliExitCode | undefined> {
  const recordSpec = resolveRecordCommand(command);
  if (!recordSpec) {
    return undefined;
  }
  try {
    const { runRecordCommand } = await import('../commands/records/dispatch.js');
    const result = await runRecordCommand(recordSpec.command, rest, {
      io: ctx.rawIo,
      fetchImpl: ctx.fetchImpl,
      cwd: ctx.cwd,
    });
    return normalizeExitCode(result.exitCode);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return EXIT_ERROR;
  }
}

export function tryHandleCommandHelpOrGuideFlag(
  command: string,
  rest: readonly string[],
  io: CliIo,
  mergedPlugins: ResolvedPluginCommands
): CliExitCode | undefined {
  if (rest.includes('--guide')) {
    const resolvedGuide = resolveEmbeddedGuide(command);
    if (resolvedGuide) {
      io.stdout(renderEmbeddedGuide(command));
      return EXIT_OK;
    }
    const help = COMMAND_HELP[command] ?? mergedPlugins.commands.get(command)?.help;
    if (help) {
      io.stdout(help);
      return EXIT_OK;
    }
    io.stderr(`No embedded guide found for '${command}'. Run \`kinloom guide\` to list available topics.`);
    return EXIT_USAGE;
  }

  if (rest.includes('-h') || rest.includes('--help')) {
    const help = COMMAND_HELP[command] ?? mergedPlugins.commands.get(command)?.help;
    if (!help) {
      io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
      return EXIT_USAGE;
    }
    io.stdout(help);
    return EXIT_OK;
  }

  return undefined;
}

export async function dispatchPluginOrUnknownCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext,
  loadedPlugins: LoadedSitePlugins
): Promise<CliExitCode> {
  const pluginCmd = loadedPlugins.merged.commands.get(command);
  if (pluginCmd) {
    const pluginCtx: KinloomCliPluginContext = {
      cwd: ctx.cwd,
      io: ctx.io,
      fetchImpl: ctx.fetchImpl,
      siteConfig: loadedPlugins.discovered.siteConfig,
    };
    return normalizeExitCode(await pluginCmd.run(rest, pluginCtx));
  }
  ctx.io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
  return EXIT_USAGE;
}
