import {
  AUDIT_HELP,
  CONTEXT_HELP,
  DATES_HELP,
  INTEGRATE_HELP,
  MEDIA_HELP,
  MIGRATE_HELP,
  PRONOUNCE_HELP,
  STATUS_HELP,
  SYNC_HELP,
  TELEMETRY_HELP,
  VERIFY_HELP,
} from '../commands/ops/help.js';
import { formatRecordCommandsHelp, renderRecordCommandHelp } from '../commands/records/help.js';
import { resolveRecordCommand } from '../commands/records/registry.js';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK, EXIT_USAGE } from '../errors.js';
import { formatGuidesCatalog, renderEmbeddedGuide, resolveEmbeddedGuide } from '../guides/index.js';
import {
  type DiscoverSiteCliPluginsResult,
  discoverSiteCliPlugins,
  formatPluginCommandsHelp,
  type KinloomCliPlugin,
  type KinloomCliPluginContext,
  type ResolvedPluginCommands,
  resolvePluginCommands,
} from '../plugins.js';
import { type CliDispatchContext, type CliIo, normalizeExitCode } from './types.js';

export const ROOT_HELP = `Usage: kinloom <command> [options]

Archive lifecycle:
  init               Scaffold a thin private family archive repository
  slice-gedcom       Slice a combined GEDCOM export into deterministic YAML files
  seed               Load local YAML + config and submit an idempotent seed batch
  submit-batch       Validate and submit a typed BatchSubmission JSON/YAML file
  export-yaml        Export deterministic YAML snapshot with ETag/304 support
  upload-media       Validate and upload a media scan or recording via multipart POST
  reconcile          Compare cached GET /api/bundle against full compileArchive

Research & archive ops:
  context            Dump privacy-fenced YAML context, relatives, and leads for a person
  integrate          Validate and merge one or more person research packages into local YAML
  audit              Run 6-check package audits (plus plugin checks) for one person or a staged batch
  verify             Run full-archive invariant checks over local data/*.yaml files
  media              Inspect and deduplicate local archive media records (dry-run by default)
  status             Report archive totals and the deceased biography queue
  sync               Diff and sync local YAML + R2 media to a live Cloudflare archive
  migrate            Idempotently inspect and apply pending Cloudflare D1 SQL migrations
  dates              Compute exact Gregorian weekdays, date diffs, and ages
  pronounce          Look up verified Wikimedia IPA/audio and audit pronunciation lexicons
  telemetry          Report local CLI latency, cache hit rate, and failure summary
  guide              Browse embedded research, archive, OCR, and workflow guides

${formatRecordCommandsHelp()}

Global options:
  -h, --help         Show help for kinloom or a specific command
  help <command>     Show full help or research guide for any command
  <command> --guide  Show the embedded workflow guide for any supported command

Environment variables:
  KINLOOM_TOKEN               Bearer token used when --token is omitted
  KINLOOM_ANCESTRY_FACTS_DIR  Optional external facts JSON directory for \`kinloom context\`
  KINLOOM_PRONOUNCE_CACHE_DIR Override pronunciation lookup cache dir (~/.cache/kinloom-pronounce)
  KINLOOM_TELEMETRY_FILE      Override JSONL telemetry path (~/.cache/kinloom-telemetry/calls.jsonl)

Exit codes:
  0  Success
  1  Runtime, HTTP, audit, or reconciliation drift error
  2  CLI usage or boundary validation error
  3  Optimistic concurrency conflict (HTTP 409)`;

const COMMAND_HELP: Readonly<Record<string, string>> = {
  init: `Usage: kinloom init <dir> --family <name> --title <title> [options]

Options:
  --family <name>     Primary family surname or lineage name (required)
  --title <title>     Display title for the archive site (required)
  --accent <hex>      6-digit hex theme accent color (default: #7A4612)
  --force             Overwrite existing files
  -h, --help          Show this help message`,

  'slice-gedcom': `Usage: kinloom slice-gedcom --input <file.ged> --out <data-dir> --root <xref-or-name> [options]

Options:
  --input <path>               Source GEDCOM file path (required)
  --out <dir>                  Output directory for YAML files (required)
  --root <xref-or-name>        Root person xref (@I1@) or full name (required)
  --surname <name>             Ancestor surname filter (repeatable or comma-separated)
  --branch <id>                Branch identifier stamped on output people
  --include-upstream-spouses   Expand ancestors of married-in spouses
  --no-ancestor-siblings       Exclude sibling sets of direct ancestors
  --no-descendant-spouses      Exclude spouses of descendants
  --no-normalize-maiden        Keep original GEDCOM surnames instead of maiden primary
  --reference-year <year>      Reference year for 100-year living cutoff
  -h, --help                   Show this help message`,

  seed: `Usage: kinloom seed --data <data-dir> --config <kinloom.config.yaml> --site <url> [options]

Options:
  --data <dir>         Directory containing people.yaml, events.yaml, etc. (required)
  --config <path>      Path to kinloom.config.yaml (required)
  --site <url>         Target Kinloom server URL (required unless --dry-run)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --batch-id <id>      Explicit batch identifier (default: content-hashed)
  --chunk-size <N>     Max patches per POST /api/batches request (default: 25)
  --summary <text>     Revision summary for the seed batch
  --dry-run            Validate YAML, run compileArchive locally, and skip HTTP
  -h, --help           Show this help message`,

  'submit-batch': `Usage: kinloom submit-batch --file <patch_spec.json|yaml> --site <url> [options]

Options:
  --file <path>        BatchSubmission JSON or YAML file (or first positional arg)
  --site <url>         Target Kinloom server URL (required unless --dry-run)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --dry-run            Validate envelope and per-entity payloads without HTTP
  -h, --help           Show this help message`,

  'export-yaml': `Usage: kinloom export-yaml --site <url> --out <data-dir> [options]

Options:
  --site <url>         Target Kinloom server URL (required)
  --out <dir>          Output directory for deterministic YAML files (required)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --state-file <path>  Revision state file (default: <out>/.last-backup-revision)
  -h, --help           Show this help message`,

  'upload-media': `Usage: kinloom upload-media --file <path> --metadata <json|@file> --summary <text> --site <url> [options]

Options:
  --file <path>          Local media file to upload (required)
  --metadata <json>      Media metadata JSON string or @file path (required)
  --summary <text>       Edit summary (minimum 3 characters, required)
  --site <url>           Target Kinloom server URL (required unless --dry-run)
  --token <secret>       Bearer token (defaults to KINLOOM_TOKEN)
  --mime <type>          Override detected MIME type
  --allow-audio-video    Allow MP4/WebM/MP3/M4A/OGG/WAV uploads
  --max-bytes <n>        Override maximum allowed file size in bytes
  --dry-run              Validate file and metadata locally without HTTP
  -h, --help             Show this help message`,

  reconcile: `Usage: kinloom reconcile --site <url> --config <kinloom.config.yaml> [options]

Options:
  --site <url>         Target Kinloom server URL (required)
  --config <path>      Path to kinloom.config.yaml (required)
  --token <secret>     Bearer token (defaults to KINLOOM_TOKEN)
  --mode <mode>        Override build mode ('private' or 'public')
  -h, --help           Show this help message`,

  context: CONTEXT_HELP,
  integrate: INTEGRATE_HELP,
  audit: AUDIT_HELP,
  verify: VERIFY_HELP,
  media: MEDIA_HELP,
  status: STATUS_HELP,
  sync: SYNC_HELP,
  migrate: MIGRATE_HELP,
  dates: DATES_HELP,
  pronounce: PRONOUNCE_HELP,
  telemetry: TELEMETRY_HELP,
  guide: `Usage: kinloom guide [topic]

Browse all embedded Kinloom archival, scan-prep, OCR, audio, and workflow guides.

Examples:
  kinloom guide                              List all 26 embedded guides by category
  kinloom guide nara                         Show the National Archives (NARA) workflow guide
  kinloom guide ocr                          Show the safe batch OCR workflow guide
  kinloom guide pronounce                    Show the pronunciation lookup & audit guide
  kinloom guide narrative-audio/script-rules Show the narrative audio script rules subguide

Options:
  -h, --help  Show this help message`,
};

export interface LoadedSitePlugins {
  discovered: DiscoverSiteCliPluginsResult;
  merged: ResolvedPluginCommands;
}

export async function loadSitePlugins(
  cwd: string,
  io: CliIo,
  explicitPlugins?: readonly KinloomCliPlugin[]
): Promise<LoadedSitePlugins> {
  const discovered = await discoverSiteCliPlugins(cwd);
  const merged = resolvePluginCommands([...discovered.plugins, ...(explicitPlugins ?? [])]);
  for (const warning of [...discovered.warnings, ...merged.warnings]) {
    io.stderr(`Warning: ${warning}`);
  }
  return { discovered, merged };
}

export function tryHandleHelpInvocation(
  argv: readonly string[],
  io: CliIo,
  mergedPlugins: ResolvedPluginCommands
): CliExitCode | undefined {
  if (argv.length > 0 && argv[0] !== '-h' && argv[0] !== '--help' && argv[0] !== 'help') {
    return undefined;
  }

  const sub = argv[0] === 'help' ? argv[1] : undefined;
  if (!sub) {
    const pluginHelp = formatPluginCommandsHelp(mergedPlugins.plugins);
    io.stdout(pluginHelp ? `${ROOT_HELP}\n\n${pluginHelp}` : ROOT_HELP);
    return EXIT_OK;
  }
  if (COMMAND_HELP[sub]) {
    io.stdout(COMMAND_HELP[sub]);
    return EXIT_OK;
  }
  const recordSpec = resolveRecordCommand(sub);
  if (recordSpec) {
    io.stdout(renderRecordCommandHelp(recordSpec));
    return EXIT_OK;
  }
  const pluginCmd = mergedPlugins.commands.get(sub);
  if (pluginCmd) {
    io.stdout(pluginCmd.help);
    return EXIT_OK;
  }
  io.stderr(`Unknown command '${sub}'. Run \`kinloom --help\` for available commands.`);
  return EXIT_USAGE;
}

export async function tryDispatchRecordCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext
): Promise<CliExitCode | undefined> {
  const recordSpec = resolveRecordCommand(command);
  if (!recordSpec) {
    return undefined;
  }
  try {
    const { runRecordCommand } = await import('../commands/records/dispatch.js');
    const result = await runRecordCommand(recordSpec.command, rest, {
      io: ctx.rawIo,
      fetchImpl: ctx.fetchImpl,
      cwd: ctx.cwd,
    });
    return normalizeExitCode(result.exitCode);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.io.stderr(`Error: ${message}`);
    return EXIT_ERROR;
  }
}

export function tryHandleCommandHelpOrGuideFlag(
  command: string,
  rest: readonly string[],
  io: CliIo,
  mergedPlugins: ResolvedPluginCommands
): CliExitCode | undefined {
  if (rest.includes('--guide')) {
    const resolvedGuide = resolveEmbeddedGuide(command);
    if (resolvedGuide) {
      io.stdout(renderEmbeddedGuide(command));
      return EXIT_OK;
    }
    const help = COMMAND_HELP[command] ?? mergedPlugins.commands.get(command)?.help;
    if (help) {
      io.stdout(help);
      return EXIT_OK;
    }
    io.stderr(`No embedded guide found for '${command}'. Run \`kinloom guide\` to list available topics.`);
    return EXIT_USAGE;
  }

  if (rest.includes('-h') || rest.includes('--help')) {
    const help = COMMAND_HELP[command] ?? mergedPlugins.commands.get(command)?.help;
    if (!help) {
      io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
      return EXIT_USAGE;
    }
    io.stdout(help);
    return EXIT_OK;
  }

  return undefined;
}

export function runGuideCliCommand(rest: readonly string[], io: CliIo): CliExitCode {
  if (rest.length === 0) {
    io.stdout(formatGuidesCatalog());
    return EXIT_OK;
  }
  if (rest.length > 1 || rest[0].startsWith('-')) {
    throw new CliValidationError('Usage: kinloom guide [topic]');
  }
  const topic = rest[0];
  if (!resolveEmbeddedGuide(topic)) {
    io.stderr(`Unknown guide topic '${topic}'. Run \`kinloom guide\` to list all available guides.`);
    return EXIT_USAGE;
  }
  io.stdout(renderEmbeddedGuide(topic));
  return EXIT_OK;
}

export async function dispatchPluginOrUnknownCommand(
  command: string,
  rest: readonly string[],
  ctx: CliDispatchContext,
  loadedPlugins: LoadedSitePlugins
): Promise<CliExitCode> {
  const pluginCmd = loadedPlugins.merged.commands.get(command);
  if (pluginCmd) {
    const pluginCtx: KinloomCliPluginContext = {
      cwd: ctx.cwd,
      io: ctx.io,
      fetchImpl: ctx.fetchImpl,
      siteConfig: loadedPlugins.discovered.siteConfig,
    };
    return normalizeExitCode(await pluginCmd.run(rest, pluginCtx));
  }
  ctx.io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
  return EXIT_USAGE;
}
