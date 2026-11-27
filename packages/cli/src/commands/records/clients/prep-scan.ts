import { CliValidationError } from '../../../errors.js';
import {
  emitStdout,
  type RecordCommandOutcome,
  type RecordHandler,
  RecordRuntimeError,
} from '../runtime/types.js';
import { renderRootHelp } from './prepScan/cliSpecs.js';
import { cmdPdfGrep, cmdPdfPages } from './prepScan/pdfCommands.js';
import { cmdCrop, cmdGrid, cmdInfo, cmdJoin, cmdPreview, cmdRotate } from './prepScan/rasterCommands.js';
import { cmdSheetStrip, cmdStitch } from './prepScan/sheetAndStitchCommands.js';

export {
  alignOffset,
  type Box,
  clampBox,
  coalesceRanges,
  formatPageSpec,
  type JoinAlign,
  type JoinDirection,
  normalizePdfFormat,
  normalizePrepScanArgv,
  type PdfImageFormat,
  parseBox,
  parseJoinAlign,
  parseJoinDirection,
  parsePageSpec,
  parseRgbColor,
  type RgbColor,
  safeStem,
} from './prepScan/geometry.js';

export const runPrepScanCommand: RecordHandler = async (args, ctx): Promise<RecordCommandOutcome> => {
  try {
    if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
      return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
    }
    const [subcmd, ...rest] = args;
    switch (subcmd) {
      case 'preview':
        return await cmdPreview(rest, ctx);
      case 'crop':
        return await cmdCrop(rest, ctx);
      case 'sheet-strip':
        return await cmdSheetStrip(rest, ctx);
      case 'pdf-pages':
        return await cmdPdfPages(rest, ctx);
      case 'pdf-grep':
        return await cmdPdfGrep(rest, ctx);
      case 'grid':
        return await cmdGrid(rest, ctx);
      case 'stitch':
        return await cmdStitch(rest, ctx);
      case 'info':
        return await cmdInfo(rest, ctx);
      case 'join':
        return await cmdJoin(rest, ctx);
      case 'rotate':
        return await cmdRotate(rest, ctx);
      default:
        throw new CliValidationError(
          `Unknown prep-scan subcommand '${subcmd}'. Run 'kinloom prep-scan --help'.`
        );
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
