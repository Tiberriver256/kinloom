import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './moArchives/cliSpecs.js';
import { runDeath, runDetail, runDownload, runMdh, runPre1910 } from './moArchives/commands.js';

export {
  type DeathRecord,
  type Pre1910BirthRecord,
  type Pre1910DeathRecord,
  parseDeathName,
  parseDeathRows,
  parseDetailFields,
  parsePre1910Rows,
} from './moArchives/domain.js';

export const runMoArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;

    switch (subcmd) {
      case 'death':
        return await runDeath(rest, ctx);
      case 'pre1910':
        return await runPre1910(rest, ctx);
      case 'detail':
        return await runDetail(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'mdh':
        return runMdh(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom mo-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
