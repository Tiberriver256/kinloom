import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './mnArchives/cliSpecs.js';
import {
  runMdlCommand,
  runNewspapersCommand,
  runPeopleCommand,
  runRecordCommand,
} from './mnArchives/commands.js';

export {
  buildPeopleQuery,
  dateToUtcMillis,
  type NewspaperSearchItem,
  type NormalizedPeopleHit,
  normalizeIsoDate,
  type PeopleQueryBody,
  type PeopleQueryClause,
  type PeopleQueryGroup,
  type PeopleQueryParams,
  RECORD_TYPE_SPECS,
  resolveRecordType,
  validateMnUrl,
} from './mnArchives/domain.js';
export {
  detectImageFormat,
  parseNewspapersMetadataHtml,
  parseNewspapersSearchHtml,
  validateNewspaperDocId,
} from './mnArchives/parsers.js';

export const runMnArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'death':
        return await runPeopleCommand(
          ctx,
          rest,
          'death-records',
          'death',
          'Search MNHS Death Records Index (1904-2001).',
          true
        );
      case 'birth':
        return await runPeopleCommand(
          ctx,
          rest,
          'birth-records',
          'birth',
          'Search MNHS Birth Records Index (1900-1934).',
          true
        );
      case 'census':
        return await runPeopleCommand(
          ctx,
          rest,
          'census',
          'census',
          'Search MNHS Minnesota State Censuses (1849-1905).',
          false
        );
      case 'vets':
        return await runPeopleCommand(
          ctx,
          rest,
          'vets-graves',
          'vets',
          'Search MNHS Veterans Graves Registration (1857-1975).',
          false
        );
      case 'people':
        return await runPeopleCommand(
          ctx,
          rest,
          null,
          'people',
          'Search any MNHS People Records collection.',
          true
        );
      case 'record':
        return await runRecordCommand(ctx, rest);
      case 'newspapers':
        return await runNewspapersCommand(ctx, rest);
      case 'mdl':
        return runMdlCommand(ctx, rest);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom mn-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
