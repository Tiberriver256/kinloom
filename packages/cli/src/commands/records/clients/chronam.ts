import { CliValidationError } from '../../../errors.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import { renderRootHelp } from './chronam/cliSpecs.js';
import { runDownload, runGetPage, runSearch, runUrl } from './chronam/commands.js';

export { atomicCopyFileSync } from '../runtime/primitives.js';
export {
  buildResourceUrl,
  buildSearchParams,
  CACHE_SCHEMA,
  type CachedFileResult,
  type ChronamAssetKind,
  COLLECTION_BASE,
  COLLECTION_END_YEAR,
  COLLECTION_START_YEAR,
  CONNECT_TIMEOUT,
  DEFAULT_CACHE_TTL_HOURS,
  DEFAULT_TIMEOUT,
  DOWNLOAD_HEADERS,
  DOWNLOAD_TIMEOUT,
  type DownloadedFileRecord,
  detectInvalidDownload,
  extractSeqFromUrl,
  HEADERS,
  iiifJpegFromInfo,
  MAX_ATTEMPTS,
  MAX_RETRY_AFTER_S,
  normalizeState,
  type PageAssets,
  RETRYABLE_STATUS_CODES,
  resolveChronamCacheDir,
  resolveDates,
  resolvePageAssets,
  resolveQuery,
  resolveSafeChild,
  resolveTtlHours,
  resourceUrlJson,
  SEARCH_ATTEMPT_READ_CAP,
  safeOutputFilename,
  searchCacheable,
  US_STATES,
  USER_AGENT,
  validateLocUrl,
} from './chronam/domain.js';
export {
  cachedDownloadBytes,
  cachedDownloadFile,
  cachedGetJson,
  getJson,
  streamDownloadToPath,
} from './chronam/transport.js';

export const runChronamCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'search':
        return await runSearch(rest, ctx);
      case 'get':
        return await runGetPage('get', rest, ctx);
      case 'page':
        return await runGetPage('page', rest, ctx);
      case 'download':
        return await runDownload(rest, ctx);
      case 'url':
        return runUrl(rest, ctx);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom chronam --help'.`);
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: 2, bytesOut: 0 };
    }
    if (err instanceof RecordRuntimeError) {
      ctx.io.stderr(`Error: ${err.message}`);
      return { exitCode: err.exitCode, bytesOut: 0 };
    }
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return { exitCode: 1, bytesOut: 0 };
  }
};
