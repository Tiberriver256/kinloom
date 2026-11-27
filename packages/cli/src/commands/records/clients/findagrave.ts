import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import { renderRootHelp, SUBCOMMAND_ALIASES } from './findagrave/cliSpecs.js';
import { runCemetery, runGet, runPhoto, runPlace, runSearch, runUrl } from './findagrave/commands.js';

export {
  CEMETERY_BY_ID_QUERY,
  CEMETERY_QUERY,
  enrichCemetery,
  enrichMemorial,
  GET_QUERY,
  GRAPHQL_URL,
  getCacheRoot,
  PLACE_QUERY,
  resolveCacheTtlHours,
  resolveSafeChild,
  SEARCH_QUERY,
  safePhotoFilename,
  sanitizePrefix,
  validateEntityId,
  validatePhotoUrl,
  WEBSITE_BASE,
} from './findagrave/domain.js';
export { runGraphqlQuery } from './findagrave/transport.js';

export const runFindagraveCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }

    const [rawSubcmd, ...rest] = args;
    const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);

    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'cemetery':
        return await runCemetery(rest, ctx);
      case 'place':
        return await runPlace(rest, ctx);
      case 'photo':
        return await runPhoto(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom findagrave --help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
