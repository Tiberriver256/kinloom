import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './persi/cliSpecs.js';
import { runLocation, runSearch, runSurname, runTitle, runUrl } from './persi/commands.js';

export {
  type PersiArticle,
  type PersiCategory,
  parsePersiArticles,
  parsePersiCategories,
} from './persi/domain.js';

export const runPersiCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'surname':
        return await runSurname(rest, ctx);
      case 'title':
        return await runTitle(rest, ctx);
      case 'location':
        return await runLocation(rest, ctx);
      case 'search':
        return await runSearch(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom persi --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
