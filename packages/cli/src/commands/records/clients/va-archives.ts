import { CliValidationError } from '../../../errors.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import {
  runChanceryCase,
  runChanceryDownload,
  runChanceryLocalities,
  runChancerySearch,
} from './vaArchives/chanceryCommands.js';
import { renderChanceryHelp, renderRootHelp } from './vaArchives/cliSpecs.js';
import {
  runCatalog,
  runDownloadRosetta,
  runDunmore,
  runGrantTif,
  runUrl,
} from './vaArchives/collectionCommands.js';

export {
  CACHE_ENV,
  CHANCERY_AVAILABLE,
  CHANCERY_BASE,
  CHANCERY_DETAIL,
  CHANCERY_IMAGES,
  CHANCERY_SEARCH,
  CHANCERY_ZIP,
  type ChanceryCaseDetail,
  type ChanceryImagesInfo,
  type ChanceryLocalityRow,
  type ChancerySearchPage,
  type ChancerySearchRecord,
  DUNMORE_CGI,
  type DunmoreDrawerResult,
  type DunmoreImage,
  getCacheRoot,
  LVA_IMAGE_BASE,
  LVA_IMAGE_HOST,
  normalizeLvaImageUrl,
  PRIMO_BASE,
  PRIMO_PNXS,
  PRIMO_VID,
  parsePageSpec,
  ROSETTA_BASE,
  ROSETTA_DELIVERY,
  ROSETTA_HOST,
  ROSETTA_VIEWER,
  type RosettaDeliveryInfo,
  type RosettaFileEntry,
  type RosettaViewerInfo,
  resolveTtlHours,
  TTL_ENV,
  TTL_ENV_ALIAS,
  USER_AGENT,
  validateFlId,
  validateIeId,
} from './vaArchives/domain.js';
export {
  parseCasePage,
  parseDunmoreDrawer,
  parseImagesPage,
  parseLocalitiesPage,
  parseRosettaDelivery,
  parseRosettaViewer,
  parseSearchPage,
} from './vaArchives/parsers.js';

export const runVaArchivesCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    let globalRefresh = false;
    let remaining = [...args];
    while (remaining[0] === '--refresh') {
      globalRefresh = true;
      remaining = remaining.slice(1);
    }

    if (remaining.length === 0 || remaining[0] === '--help' || remaining[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }

    const [subcmd, ...rest] = remaining;
    switch (subcmd) {
      case 'chancery': {
        if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
          return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderChanceryHelp()) };
        }
        const [chancerySub, ...chanceryRest] = rest;
        switch (chancerySub) {
          case 'search':
            return await runChancerySearch(chanceryRest, ctx, globalRefresh);
          case 'case':
            return await runChanceryCase(chanceryRest, ctx, globalRefresh);
          case 'download':
            return await runChanceryDownload(chanceryRest, ctx, globalRefresh);
          case 'localities':
            return await runChanceryLocalities(chanceryRest, ctx, globalRefresh);
          default:
            throw new CliValidationError(
              `No such chancery command '${chancerySub}'. Run 'kinloom va-archives chancery --help'.`
            );
        }
      }
      case 'catalog':
        return await runCatalog(rest, ctx, globalRefresh);
      case 'url':
        return runUrl(rest, ctx);
      case 'grant-tif':
        return await runGrantTif(rest, ctx, globalRefresh, 'grant-tif');
      case 'lva-tif':
        return await runGrantTif(rest, ctx, globalRefresh, 'lva-tif');
      case 'dunmore':
        return await runDunmore(rest, ctx, globalRefresh);
      case 'download-rosetta':
        return await runDownloadRosetta(rest, ctx, globalRefresh);
      default:
        throw new CliValidationError(`No such command '${subcmd}'. Run 'kinloom va-archives --script-help'.`);
    }
  } catch (err: unknown) {
    return handleRecordCommandError(err, ctx);
  }
};
