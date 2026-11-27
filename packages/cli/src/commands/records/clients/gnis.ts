import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './gnis/cliSpecs.js';
import { runDownload, runGet, runSearch, runUrl } from './gnis/commands.js';

export {
  extractGnisTxt,
  GNIS_STATE_CODES,
  type GnisCompactFeature,
  type GnisRow,
  type GnisSearchPayload,
  historicalZipUrl,
  loadGnisRows,
  resolveSafeChild,
  S3_BASE,
  SEARCH_APP,
  stateZipUrl,
} from './gnis/domain.js';

export const runGnisCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'download':
        return await runDownload(rest, ctx);
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGet(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom gnis --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
