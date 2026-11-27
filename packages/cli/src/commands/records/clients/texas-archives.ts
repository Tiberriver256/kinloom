import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderPortalHelp, renderRootHelp } from './texasArchives/cliSpecs.js';
import { runPortalItem, runPortalSearch, runTda, runUrl } from './texasArchives/commands.js';

export {
  entryMatchesFilters,
  extractArkId,
  GLO_LAND,
  normalizeArk,
  PORTAL_BASE,
  PORTAL_OAI,
  PORTAL_OPENSEARCH,
  parseIsoDate,
  parseItemDate,
  parseOaiRecord,
  parseTdaRss,
  TDA_BASE,
  type TexasOaiRecord,
  type TexasOpenSearchEntry,
  type TexasOpenSearchPage,
  type TexasTdaItem,
  TSLAC_HOME,
  TSLAC_RANGERS,
} from './texasArchives/domain.js';

export const runTexasArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'portal': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderPortalHelp()) };
        }
        const [portalSub, ...portalRest] = rest;
        switch (portalSub) {
          case 'search':
            return await runPortalSearch(portalRest, ctx);
          case 'item':
            return await runPortalItem(portalRest, ctx);
          default:
            throw new CliValidationError(
              `No such portal command '${portalSub}'. Run 'kinloom texas-archives portal --help'.`
            );
        }
      }
      case 'tda':
        return await runTda(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(
          `No such command '${subcmd}'. Run 'kinloom texas-archives --script-help'.`
        );
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
