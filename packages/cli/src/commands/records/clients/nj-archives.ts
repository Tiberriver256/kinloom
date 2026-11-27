import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './njArchives/cliSpecs.js';
import { runDatabases, runMonmouth, runSearch, runUrl } from './njArchives/commands.js';

export {
  DATABASES,
  type NjDatabaseSpec,
  type NjGridLink,
  type NjGridRow,
  type NjSearchCriteria,
  type NjSearchResult,
  ORDER_ONLY,
} from './njArchives/catalog.js';
export {
  getCloseMatches,
  hasPageLink,
  matchOptionValue,
  parseGrid,
  resolveDatabase,
  sequenceSimilarity,
} from './njArchives/parsers.js';
export { searchPortal } from './njArchives/transport.js';

export const runNjArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;

    switch (subcmd) {
      case 'databases':
        return await runDatabases(rest, ctx);
      case 'search':
        return await runSearch(rest, ctx);
      case 'monmouth':
        return await runMonmouth(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom nj-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
