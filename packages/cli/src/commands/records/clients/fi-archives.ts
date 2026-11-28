import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { runAstia } from './fiArchives/astia.js';
import { renderRootHelp } from './fiArchives/cliSpecs.js';
import {
  runArchiveInspect,
  runArchivesSearch,
  runEvent,
  runHiski,
  runParishes,
  runUrl,
} from './fiArchives/commands.js';

export {
  ALLOWED_ASTIA_HOSTS,
  parseAstiaFolderHtml,
  parseAstiaFolderJson,
  parseAstiaFolderRef,
  parseAstiaPageSpec,
} from './fiArchives/astia.js';
export {
  ALLOWED_DIGIHAKEMISTO_HOSTS,
  ALLOWED_HISKI_HOSTS,
  DIGIHAKEMISTO_BASE,
  DIGIHAKEMISTO_SEARCH_URL,
  type DigihakemistoArchiveDetail,
  type DigihakemistoArchiveRow,
  type DigihakemistoChildRow,
  decodeIso88591,
  encodeIso88591Form,
  HISKI_BASE,
  HISKI_ENDPOINT,
  type HiskiEventDetail,
  type HiskiParish,
  type HiskiRecord,
  type HiskiSearchResult,
  validateFiUrl,
} from './fiArchives/domain.js';
export {
  parseDigihakemistoArchive,
  parseDigihakemistoSearch,
  parseHiskiEventDetail,
  parseHiskiParishes,
  parseHiskiResults,
} from './fiArchives/parsers.js';

export const runFiArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'parishes':
        return await runParishes(rest, ctx);
      case 'hiski':
        return await runHiski(rest, ctx);
      case 'event':
        return await runEvent(rest, ctx);
      case 'archives':
        return await runArchivesSearch(rest, ctx);
      case 'archive':
        return await runArchiveInspect(rest, ctx);
      case 'astia':
        return await runAstia(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom fi-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
