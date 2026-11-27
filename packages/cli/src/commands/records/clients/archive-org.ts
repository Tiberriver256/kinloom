import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { isBrokenPipeError } from '../runtime/primitives.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import { renderRootHelp } from './archiveOrg/cliSpecs.js';
import { runGrep, runPage, runText } from './archiveOrg/pageCommands.js';
import {
  runDownload,
  runFulltext,
  runGet,
  runLookup,
  runSearch,
  runUrl,
} from './archiveOrg/searchCommands.js';
import { SUBCOMMAND_ALIASES } from './archiveOrg/types.js';

export {
  emptyPageIndex,
  ensureItemCache,
  ensureItemMetadata,
  ensurePageImageCache,
  parseScandataXml,
  synthesizeDjvuFromHocr,
} from './archiveOrg/itemCache.js';
export { httpGetBytesIa } from './archiveOrg/transport.js';
export {
  ADVANCED_SEARCH,
  ArchiveNotFoundError,
  BASE,
  DEFAULT_FIELDS,
  DEFAULT_QUERY_TTL_HOURS,
  DEFAULT_TIMEOUT_SECONDS,
  DOWNLOAD_TIMEOUT_SECONDS,
  FULLTEXT_SEARCH,
  type ItemCacheEntry,
  type ItemFileEntry,
  type ItemMetadataPayload,
  itemUrl,
  MAX_HTTP_RETRIES,
  MAX_RETRY_AFTER_SECONDS,
  MAX_WORKERS,
  PAGE_BATCH_LIMIT,
  PAGE_BATCH_WORKERS,
  type PageIndex,
  pageDetailsUrl,
  pageImageUrl,
  parseLeafInt,
  parseRetryAfterMsIa,
  RETRYABLE_HTTP_CODES,
  SEARCH_TIMEOUT_SECONDS,
  USER_AGENT,
  validateIdentifier,
  validateRelativeItemPath,
} from './archiveOrg/types.js';

export const runArchiveOrgCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
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
      case 'download':
        return await runDownload(rest, ctx);
      case 'fulltext':
        return await runFulltext(rest, ctx);
      case 'grep':
        return await runGrep(rest, ctx);
      case 'page':
        return await runPage(rest, ctx);
      case 'text':
        return await runText(rest, ctx);
      case 'lookup':
        return await runLookup(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom ia --help'.`);
    }
  } catch (err: unknown) {
    if (isBrokenPipeError(err)) {
      return { exitCode: 0, bytesOut: 0 };
    }
    if (err instanceof CliValidationError) {
      ctx.io.stderr(err.message);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(err.message);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(message);
    return { exitCode: 1, bytesOut: 0 };
  }
};
