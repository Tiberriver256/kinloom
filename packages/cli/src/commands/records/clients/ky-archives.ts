import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './kyArchives/cliSpecs.js';
import {
  runCdm,
  runCdmItem,
  runCdmUrl,
  runCollections,
  runLand,
  runLandPatent,
  runPreservica,
  runUrls,
} from './kyArchives/commands.js';

export {
  CDM_API,
  CDM_BASE,
  type CdmSearchPayload,
  type CdmTrimmedItem,
  cleanHtmlText,
  extractAspState,
  type KyLandPayload,
  type KyLandRecord,
  type KyPreservicaItem,
  type KyPreservicaPayload,
  LAND_BY,
  LAND_URL,
  PRESERVICA_BASE,
  parseLandResults,
  parsePreservicaRss,
} from './kyArchives/domain.js';

export const runKyArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;

    switch (subcmd) {
      case 'cdm':
        return await runCdm(rest, ctx);
      case 'cdm-item':
        return await runCdmItem(rest, ctx);
      case 'collections':
        return await runCollections(rest, ctx);
      case 'cdm-url':
        return runCdmUrl(rest, ctx);
      case 'land':
        return await runLand(rest, ctx);
      case 'land-patent':
        return await runLandPatent(rest, ctx);
      case 'preservica':
        return await runPreservica(rest, ctx);
      case 'urls':
        return runUrls(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom ky-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
