import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './seArchives/cliSpecs.js';
import {
  runCensus,
  runCollection,
  runDownload,
  runManifest,
  runRecord,
} from './seArchives/resourceCommands.js';
import { runBirths, runDeeds, runMarriages, runSearch } from './seArchives/searchCommands.js';

export {
  ALLOWED_API_HOSTS,
  ALLOWED_DOWNLOAD_HOSTS,
  buildIiifImageUrl,
  detectImageFormat,
  looksLikeHtmlPayload,
  normalizeBildid,
  parseArchiveId,
  parseRegisterId,
  resolveSafeOutputPath,
  validateSeUrl,
} from './seArchives/domain.js';

export const runSeArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'births':
        return await runBirths(rest, ctx);
      case 'marriages':
        return await runMarriages(rest, ctx);
      case 'deeds':
        return await runDeeds(rest, ctx);
      case 'record':
        return await runRecord(rest, ctx);
      case 'collection':
        return await runCollection(rest, ctx);
      case 'manifest':
        return await runManifest(rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'census':
        return runCensus(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom se-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
