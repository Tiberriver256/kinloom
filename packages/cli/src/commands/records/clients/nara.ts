import { CliValidationError } from '../../../errors.js';
import { resolveSubcommandAlias } from '../runtime/args.js';
import { isBrokenPipeError } from '../runtime/primitives.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import { runAad } from './nara/aad.js';
import { runDownload, runGet, runSearch, runUrl } from './nara/catalogCommands.js';
import { runCensus1950, runCensus1950Image } from './nara/censusCommands.js';
import { renderRootHelp, SUBCOMMAND_ALIASES } from './nara/cliSpecs.js';
import type { NaraBrowserOverrides } from './nara/types.js';

export {
  AAD_DATABASE_PRESETS,
  buildAadRecordUrl,
  buildAadSearchUrl,
  parseAadRecordHtml,
  parseAadSearchHtml,
  resolveAadDatabase,
  validateAadUrl,
} from './nara/aad.js';
export { defaultBrowserGetRecords, defaultBrowserSearchMany } from './nara/browserFallback.js';
export { apiGetJson } from './nara/catalogTransport.js';
export {
  canonicalCensus1950Query,
  census1950CachePaths,
  census1950FetchJpeg,
  census1950FetchJson,
  census1950ImageCachePaths,
  census1950ImageJpegUrl,
  census1950SearchUrl,
  normalizeCensus1950State,
  parseCensus1950ImageSource,
  requireJpegBytes,
  resolveCensus1950ImageOutput,
  validateCensus1950ImagePath,
} from './nara/census1950.js';
export {
  buildQueryParams,
  detectErrorPayload,
  encodeCatalogUrl,
  extractRecord,
  formatRecordText,
  isDirectDownloadUrl,
  normalizeQueryForWafRetry,
  parsePageSpec,
  projectRecord,
  resolveQueryTtlHours,
  resolveSafeChild,
  safeObjectFilename,
  validateNaid,
  validateNaraDownloadUrl,
} from './nara/queryAndRecords.js';
export {
  API_ATTEMPTS,
  API_MAX_WORKERS,
  API_READ_TIMEOUT_MS,
  CATALOG_API_BASE,
  CATALOG_WEB_BASE,
  type CanonicalCensus1950Query,
  type CanonicalSearchParams,
  CENSUS1950_API_BASE,
  CENSUS1950_DEFAULT_LIMIT,
  CENSUS1950_IIIF_ORIGIN,
  CENSUS1950_IMAGE_ATTEMPTS,
  CENSUS1950_IMAGE_FETCH_WORKERS,
  CENSUS1950_IMAGE_MAX_PER_CALL,
  CENSUS1950_IMAGE_MAX_WIDTH,
  CENSUS1950_IMAGE_PATH_RE,
  CENSUS1950_IMAGE_TIMEOUT,
  CENSUS1950_RETRY_AFTER_CAP_S,
  CENSUS1950_STATES,
  CENSUS1950_TRANSIENT_STATUS,
  type Census1950ApiPayload,
  type Census1950ImageRecord,
  DEFAULT_BROWSER_TIMEOUT_MS,
  DEFAULT_BROWSER_TIMEOUT_S,
  DEFAULT_DOWNLOAD_TIMEOUT,
  DEFAULT_QUERY_TTL_HOURS,
  DOWNLOAD_ATTEMPTS,
  DOWNLOAD_MAX_WORKERS,
  IncompleteDownloadError,
  JPEG_MAGIC,
  NARA_BUCKET_HOST_RE,
  NARA_PATH_PREFIXES,
  type NaraBrowserOverrides,
  type NaraDigitalObjectSummary,
  type NaraExtractedTextItem,
  type NaraRecordSummary,
  type NaraSearchPayload,
  NaraWafOrNonJsonError,
  RETRY_AFTER_CAP_S,
  S3_PATH_HOST_RE,
  type SearchFilterOptions,
  TRANSIENT_STATUS_CODES,
  USER_AGENT,
  VALID_LEVELS,
} from './nara/types.js';

export function createNaraCommand(overrides: NaraBrowserOverrides = {}): RecordHandler {
  return async (args, ctx): Promise<RecordCommandOutcome> => {
    try {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
      }
      const [rawSubcmd = '', ...rest] = args;
      const subcmd = resolveSubcommandAlias(rawSubcmd, SUBCOMMAND_ALIASES);
      switch (subcmd) {
        case 'url':
          return runUrl(rest, ctx);
        case 'search':
          return await runSearch(rest, ctx, overrides);
        case 'get':
          return await runGet(rest, ctx, overrides);
        case 'download':
          return await runDownload(rest, ctx, overrides);
        case 'census1950':
          return await runCensus1950(rest, ctx);
        case 'census1950-image':
          return await runCensus1950Image(rest, ctx);
        case 'aad':
          return await runAad(rest, ctx);
        default:
          throw new CliValidationError(`No such command '${rawSubcmd}'. Run 'kinloom nara --script-help'.`);
      }
    } catch (err: unknown) {
      if (isBrokenPipeError(err)) {
        return { exitCode: 0, bytesOut: 0 };
      }
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
}

export const runNaraCommand: RecordHandler = createNaraCommand();
