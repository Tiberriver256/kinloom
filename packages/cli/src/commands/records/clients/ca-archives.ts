import { CliValidationError } from '../../../errors.js';
import type { ChromiumLauncher } from '../runtime/browser.js';
import { handleRecordCommandError } from '../runtime/primitives.js';
import { emitStdout, type RecordCommandOutcome, type RecordHandler } from '../runtime/types.js';
import { renderRootHelp } from './caArchives/cliSpecs.js';
import { runGet, runSearch, runUrl } from './caArchives/commands.js';
import type { CaArchivesOverrides } from './caArchives/domain.js';

export {
  ALL_SOURCES,
  buildUrl,
  CALISPHERE_BASE,
  type CaArchivesOverrides,
  type CaExhibitsItem,
  type CaPortalItem,
  type CaSearchableSource,
  type CaSearchResultItem,
  type CaSource,
  type CaSourceEntry,
  type CaSourceOutput,
  CDNC_BASE,
  calisphereUrl,
  cdncUrl,
  dedupeCalisphereLinks,
  dedupeOacLinks,
  EXHIBITS_BASE,
  exhibitsUrl,
  MINERVA_URL,
  OAC_BASE,
  oacUrl,
  PORTAL_BASE,
  parsePortalSearchHtml,
  portalUrl,
  SEARCHABLE_SOURCES,
} from './caArchives/domain.js';
export { browserSearch, searchExhibits, searchPortal } from './caArchives/transport.js';
export type { ChromiumLauncher };

export function createCaArchivesCommand(overrides: CaArchivesOverrides = {}): RecordHandler {
  return async (args, ctx): Promise<RecordCommandOutcome> => {
    try {
      if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
        return { exitCode: 0, bytesOut: emitStdout(ctx.io, renderRootHelp()) };
      }
      const [subcmd, ...rest] = args;
      switch (subcmd) {
        case 'search':
          return await runSearch(rest, ctx, overrides);
        case 'url':
          return runUrl(rest, ctx);
        case 'get':
          return await runGet(rest, ctx);
        default:
          throw new CliValidationError(
            `No such command '${subcmd}'. Run 'kinloom ca-archives --script-help'.`
          );
      }
    } catch (err: unknown) {
      return handleRecordCommandError(err, ctx);
    }
  };
}

export const runCaArchivesCommand: RecordHandler = createCaArchivesCommand();
