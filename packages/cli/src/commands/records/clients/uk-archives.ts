import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderFreeregHelp, renderRootHelp, renderTnaHelp } from './ukArchives/cliSpecs.js';
import { runFreeregSearch, runTnaGet, runTnaSearch, runUrl } from './ukArchives/commands.js';
import { TNA_SUBCOMMAND_ALIASES } from './ukArchives/domain.js';

export {
  ALLOWED_FREEREG_HOSTS,
  ALLOWED_TNA_HOSTS,
  type DiscoveryDetailPayload,
  type DiscoveryHit,
  type FreeregRecord,
  parseFreeregResults,
  validateUkArchivesUrl,
} from './ukArchives/domain.js';

export const runUkArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [group, ...rest] = args;
    switch (group) {
      case 'tna':
      case 'discovery': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderTnaHelp(group)) };
        }
        const subcmd = resolveSubcommandAlias(rest[0] ?? '', TNA_SUBCOMMAND_ALIASES);
        const subArgs = rest.slice(1);
        switch (subcmd) {
          case 'search':
            return await runTnaSearch(subArgs, ctx, group);
          case 'get':
            return await runTnaGet(subArgs, ctx, group);
          default:
            throw new CliValidationError(
              `No such command '${rest[0]}' under '${group}'. Run 'kinloom uk-archives ${group} --help'.`
            );
        }
      }

      case 'freereg': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderFreeregHelp()) };
        }
        const [subcmd, ...subArgs] = rest;
        if (subcmd === 'search') {
          return await runFreeregSearch(subArgs, ctx);
        }
        throw new CliValidationError(
          `No such command '${subcmd}' under 'freereg'. Run 'kinloom uk-archives freereg --help'.`
        );
      }

      case 'url':
        return runUrl(rest, ctx);

      default:
        throw new CliValidationError(`No such command '${group}'. Run 'kinloom uk-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
