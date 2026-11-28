import { type CliExitCode, CliValidationError, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { formatGuidesCatalog, renderEmbeddedGuide, resolveEmbeddedGuide } from '../guides/index.js';
import {
  BUILTIN_CLI_COMMAND_SPECS,
  type BuiltInCliCommandMeta,
  type BuiltInCliCommandName,
  type BuiltInExecutableCommandName,
} from './builtinCatalog.js';
import type { CliDispatchContext, CliIo } from './types.js';

export type BuiltInCommandHandler = (
  rest: readonly string[],
  ctx: CliDispatchContext
) => Promise<CliExitCode> | CliExitCode;

export interface BuiltInCliCommandDescriptor extends BuiltInCliCommandMeta {
  readonly run?: BuiltInCommandHandler;
}

export function runGuideCliCommand(rest: readonly string[], io: CliIo): CliExitCode {
  if (rest.length === 0) {
    io.stdout(formatGuidesCatalog());
    return EXIT_OK;
  }
  const topic = rest[0];
  if (rest.length > 1 || topic === undefined || topic.startsWith('-')) {
    throw new CliValidationError('Usage: kinloom guide [topic]');
  }
  if (!resolveEmbeddedGuide(topic)) {
    io.stderr(`Unknown guide topic '${topic}'. Run \`kinloom guide\` to list all available guides.`);
    return EXIT_USAGE;
  }
  io.stdout(renderEmbeddedGuide(topic));
  return EXIT_OK;
}

const BUILTIN_COMMAND_HANDLERS: Readonly<Record<BuiltInExecutableCommandName, BuiltInCommandHandler>> = {
  init: async (rest, ctx) => (await import('./coreCommands.js')).runInit(rest, ctx),
  brandkit: async (rest, ctx) => (await import('./coreCommands.js')).runBrandkit(rest, ctx),
  'slice-gedcom': async (rest, ctx) => (await import('./coreCommands.js')).runSliceGedcom(rest, ctx),
  seed: async (rest, ctx) => (await import('./coreCommands.js')).runSeed(rest, ctx),
  'submit-batch': async (rest, ctx) => (await import('./coreCommands.js')).runSubmitBatch(rest, ctx),
  'export-yaml': async (rest, ctx) => (await import('./coreCommands.js')).runExportYaml(rest, ctx),
  'upload-media': async (rest, ctx) => (await import('./coreCommands.js')).runUploadMedia(rest, ctx),
  reconcile: async (rest, ctx) => (await import('./coreCommands.js')).runReconcile(rest, ctx),
  context: async (rest, ctx) => (await import('./researchOpsCommands.js')).runContext(rest, ctx),
  query: async (rest, ctx) => (await import('./researchOpsCommands.js')).runQuery(rest, ctx),
  integrate: async (rest, ctx) => (await import('./researchOpsCommands.js')).runIntegrate(rest, ctx),
  audit: async (rest, ctx) => (await import('./researchOpsCommands.js')).runAudit(rest, ctx),
  verify: async (rest, ctx) => (await import('./researchOpsCommands.js')).runVerify(rest, ctx),
  media: async (rest, ctx) => (await import('./researchOpsCommands.js')).runMedia(rest, ctx),
  status: async (rest, ctx) => (await import('./researchOpsCommands.js')).runStatus(rest, ctx),
  sync: async (rest, ctx) => (await import('./liveAndUtilityCommands.js')).runSync(rest, ctx),
  migrate: async (rest, ctx) => (await import('./liveAndUtilityCommands.js')).runMigrate(rest, ctx),
  dates: async (rest, ctx) => (await import('./liveAndUtilityCommands.js')).runDates(rest, ctx),
  pronounce: async (rest, ctx) => (await import('./liveAndUtilityCommands.js')).runPronounce(rest, ctx),
  telemetry: async (rest, ctx) => (await import('./liveAndUtilityCommands.js')).runTelemetry(rest, ctx),
  screenshots: async (rest, ctx) => (await import('./screenshotsCommand.js')).runScreenshots(rest, ctx),
  'design-audit': async (rest, ctx) => (await import('./designAuditCommand.js')).runDesignAudit(rest, ctx),
  guide: (rest, ctx) => runGuideCliCommand(rest, ctx.io),
};

function attachBuiltInHandler(spec: (typeof BUILTIN_CLI_COMMAND_SPECS)[number]): BuiltInCliCommandDescriptor {
  if (spec.name === 'help') {
    return spec;
  }
  return {
    ...spec,
    run: BUILTIN_COMMAND_HANDLERS[spec.name],
  };
}

export const BUILTIN_CLI_COMMANDS: readonly BuiltInCliCommandDescriptor[] =
  BUILTIN_CLI_COMMAND_SPECS.map(attachBuiltInHandler);

const BUILTIN_BY_NAME = new Map<string, BuiltInCliCommandDescriptor>(
  BUILTIN_CLI_COMMANDS.map((cmd) => [cmd.name, cmd])
);

export function resolveBuiltInCliCommand(name: string): BuiltInCliCommandDescriptor | undefined {
  return BUILTIN_BY_NAME.get(name.trim());
}

export async function dispatchBuiltInCliCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext
): Promise<CliExitCode | undefined> {
  const descriptor = BUILTIN_BY_NAME.get(command);
  if (!descriptor?.run) {
    return undefined;
  }
  return descriptor.run(rest, ctx);
}

export { COMMAND_HELP, CORE_CLI_COMMANDS, ROOT_HELP } from './builtinCatalog.js';
export type { BuiltInCliCommandMeta, BuiltInCliCommandName, BuiltInExecutableCommandName };
