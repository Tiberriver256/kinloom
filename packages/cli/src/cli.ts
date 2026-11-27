#!/usr/bin/env node
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
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
} from './commands/ops/help.js';
import { formatRecordCommandsHelp, renderRecordCommandHelp } from './commands/records/help.js';
import { resolveRecordCommand } from './commands/records/registry.js';
import {
  CliValidationError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  KinloomApiError,
  formatConflictDetails,
  type CliExitCode,
} from './errors.js';
import {
  discoverSiteCliPlugins,
  formatPluginCommandsHelp,
  resolvePluginCommands,
  type KinloomCliPlugin,
  type KinloomCliPluginContext,
} from './plugins.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface RunCliOptions {
  io?: CliIo;
  fetchImpl?: typeof fetch;
  cwd?: string;
  plugins?: readonly KinloomCliPlugin[];
}

const DEFAULT_IO: CliIo = {
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

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
  audit              Run 5-check package audits for one person or a staged batch
  verify             Run full-archive invariant checks over local data/*.yaml files
  media              Inspect and deduplicate local archive media records (dry-run by default)
  status             Report archive totals and the deceased biography queue
  sync               Diff and sync local YAML + R2 media to a live Cloudflare archive
  migrate            Idempotently inspect and apply pending Cloudflare D1 SQL migrations
  dates              Compute exact Gregorian weekdays, date diffs, and ages
  pronounce          Look up verified Wikimedia IPA/audio and audit pronunciation lexicons
  telemetry          Report local CLI latency, cache hit rate, and failure summary

${formatRecordCommandsHelp()}

Global options:
  -h, --help         Show help for kinloom or a specific command
  help <command>     Show full help or research guide for any command

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
};

function requireStringFlag(value: string | undefined, flagName: string): string {
  if (!value || !value.trim()) {
    throw new CliValidationError(`Missing required option \`${flagName}\`.`);
  }
  return value.trim();
}

function bindSignedStatusLimit(args: readonly string[]): string[] {
  const bound: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const next = args[index + 1];
    if (arg === '--limit' && next !== undefined && /^-?\d+$/.test(next)) {
      bound.push(`--limit=${next}`);
      index += 1;
      continue;
    }
    bound.push(arg);
  }
  return bound;
}

function parseStatusLimit(value: string | undefined): number {
  if (value === undefined) {
    return 8;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliValidationError(
      'Option `--limit` must be an integer greater than or equal to 0.'
    );
  }
  return Number.parseInt(trimmed, 10);
}

function parseStatusFilter(
  value: string | undefined
): 'pending' | 'staged' | 'done_live' | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === 'pending' || trimmed === 'staged' || trimmed === 'done_live') {
    return trimmed;
  }
  throw new CliValidationError(
    'Option `--filter` must be `pending`, `staged`, or `done_live`.'
  );
}

function parseOptionalPositiveInt(value: string | undefined, flagName: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== value.trim()) {
    throw new CliValidationError(`Option \`${flagName}\` must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalPositiveNumber(
  value: string | undefined,
  flagName: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliValidationError(`Option \`${flagName}\` must be a positive number.`);
  }
  return parsed;
}

function safeParseArgs<const T extends ParseArgsConfig>(
  config: T
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs(config);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliValidationError(message);
  }
}

function normalizeIntegratePackageDir(rawPath: string, baseDir: string): string {
  const resolved = path.resolve(baseDir, rawPath.trim());
  try {
    if (fs.statSync(resolved).isFile() && path.basename(resolved) === 'patch.json') {
      return path.dirname(resolved);
    }
  } catch {
    // Missing paths stay as-is so executeIntegrateSingle reports the exact missing path.
  }
  return resolved;
}

function readPersonIdFromPackageDir(packageDir: string): string | undefined {
  const patchPath = path.join(packageDir, 'patch.json');
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(patchPath, 'utf8'));
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      const personId = (raw as Record<string, unknown>).person_id;
      if (typeof personId === 'string' && personId.trim().length > 0) {
        return personId.trim();
      }
    }
  } catch {
    // Missing or malformed patch.json is reported downstream by executeIntegrateSingle.
  }
  return undefined;
}

function resolvePositionalIntegratePackage(
  token: string,
  baseDir: string
): { packageDir: string; personId: string } | undefined {
  const looksLikePath =
    token.includes('/') || token.includes('\\') || token.endsWith('.json') || token.startsWith('.');
  const resolved = path.resolve(baseDir, token);
  if (!looksLikePath && !fs.existsSync(resolved)) {
    return undefined;
  }
  try {
    const stat = fs.statSync(resolved);
    const pkgDir =
      stat.isFile() && path.basename(resolved) === 'patch.json'
        ? path.dirname(resolved)
        : stat.isDirectory() && fs.existsSync(path.join(resolved, 'patch.json'))
          ? resolved
          : undefined;
    if (!pkgDir) {
      return undefined;
    }
    const inferredPersonId = readPersonIdFromPackageDir(pkgDir) ?? path.basename(pkgDir);
    return { packageDir: pkgDir, personId: inferredPersonId };
  } catch {
    return undefined;
  }
}

function writeRenderedOutput(io: CliIo, rendered: string): void {
  const trimmed = rendered.replace(/\r?\n$/, '');
  if (trimmed.length > 0) {
    io.stdout(trimmed);
  }
}

interface ParsedSyncArgs {
  repoDir?: string;
  siteUrl?: string;
  typesRaw?: string;
  syncMissingMedia: boolean;
  uploadMediaPaths: string[];
  concurrency?: number;
  chunkSize?: number;
  summary?: string;
  allowDeletes: boolean;
  deleteTokens: string[];
  includeLiving: boolean;
  verifyLive: boolean;
  dryRun: boolean;
  json: boolean;
}

function parseSyncArgs(argv: readonly string[]): ParsedSyncArgs {
  const parsed: ParsedSyncArgs = {
    syncMissingMedia: false,
    uploadMediaPaths: [],
    allowDeletes: false,
    deleteTokens: [],
    includeLiving: false,
    verifyLive: false,
    dryRun: false,
    json: false,
  };

  const readFlagValue = (arg: string, index: number, name: string): [string, number] => {
    if (arg.includes('=')) {
      const val = arg.slice(arg.indexOf('=') + 1).trim();
      if (!val) {
        throw new CliValidationError(`Option \`${name}\` requires a value.`);
      }
      return [val, index];
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('-')) {
      throw new CliValidationError(`Option \`${name}\` requires a value.`);
    }
    return [next.trim(), index + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sync-missing-media') {
      parsed.syncMissingMedia = true;
      continue;
    }
    if (arg === '--allow-deletes') {
      parsed.allowDeletes = true;
      continue;
    }
    if (arg === '--include-living') {
      parsed.includeLiving = true;
      continue;
    }
    if (arg === '--verify-live') {
      parsed.verifyLive = true;
      continue;
    }
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    if (arg === '--repo' || arg.startsWith('--repo=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--repo');
      parsed.repoDir = val;
      i = nextIdx;
      continue;
    }
    if (
      arg === '--site-url' ||
      arg.startsWith('--site-url=') ||
      arg === '--site' ||
      arg.startsWith('--site=')
    ) {
      const flagName = arg.startsWith('--site-url') ? '--site-url' : '--site';
      const [val, nextIdx] = readFlagValue(arg, i, flagName);
      parsed.siteUrl = val;
      i = nextIdx;
      continue;
    }
    if (arg === '--types' || arg.startsWith('--types=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--types');
      parsed.typesRaw = parsed.typesRaw ? `${parsed.typesRaw},${val}` : val;
      i = nextIdx;
      continue;
    }
    if (arg === '--summary' || arg.startsWith('--summary=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--summary');
      parsed.summary = val;
      i = nextIdx;
      continue;
    }
    if (arg === '--concurrency' || arg.startsWith('--concurrency=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--concurrency');
      parsed.concurrency = parseOptionalPositiveInt(val, '--concurrency');
      i = nextIdx;
      continue;
    }
    if (arg === '--chunk-size' || arg.startsWith('--chunk-size=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--chunk-size');
      parsed.chunkSize = parseOptionalPositiveInt(val, '--chunk-size');
      i = nextIdx;
      continue;
    }
    if (arg === '--delete' || arg.startsWith('--delete=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--delete');
      parsed.deleteTokens.push(val);
      i = nextIdx;
      continue;
    }
    if (arg === '--upload-media' || arg.startsWith('--upload-media=')) {
      if (arg.startsWith('--upload-media=')) {
        const raw = arg.slice('--upload-media='.length);
        const items = raw
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if (items.length === 0) {
          throw new CliValidationError('Option `--upload-media` requires at least one file path.');
        }
        parsed.uploadMediaPaths.push(...items);
      } else {
        let consumed = 0;
        while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          i += 1;
          for (const item of argv[i].split(',').map((part) => part.trim()).filter(Boolean)) {
            parsed.uploadMediaPaths.push(item);
            consumed += 1;
          }
        }
        if (consumed === 0) {
          throw new CliValidationError('Option `--upload-media` requires at least one file path.');
        }
      }
      continue;
    }
    throw new CliValidationError(`Unknown argument '${arg}' for \`kinloom sync\`.`);
  }

  return parsed;
}

function normalizeExitCode(code: number): CliExitCode {
  if (code === 0 || code === 1 || code === 2 || code === 3) {
    return code;
  }
  return EXIT_ERROR;
}

export async function runCli(
  argv: readonly string[],
  options?: RunCliOptions
): Promise<CliExitCode> {
  const io = options?.io ?? DEFAULT_IO;
  const fetchImpl = options?.fetchImpl;
  const cwd = options?.cwd ?? process.cwd();

  const discovered = await discoverSiteCliPlugins(cwd);
  const mergedPlugins = resolvePluginCommands([
    ...discovered.plugins,
    ...(options?.plugins ?? []),
  ]);
  for (const warning of [...discovered.warnings, ...mergedPlugins.warnings]) {
    io.stderr(`Warning: ${warning}`);
  }

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
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

  const [command, ...rest] = argv;

  // Dispatch record, archive-search, guide, and scan/OCR commands before generic --help parsing
  // so subcommand --help (e.g. `kinloom ia grep --help`) and `--script-help` pass through intact.
  const recordSpec = resolveRecordCommand(command);
  if (recordSpec) {
    try {
      const { runRecordCommand } = await import('./commands/records/dispatch.js');
      const result = await runRecordCommand(recordSpec.command, rest, {
        io: options?.io,
        fetchImpl,
        cwd,
      });
      return normalizeExitCode(result.exitCode);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`Error: ${message}`);
      return EXIT_ERROR;
    }
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

  try {
    switch (command) {
      case 'init': {
        const { values, positionals } = safeParseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            family: { type: 'string' },
            title: { type: 'string' },
            accent: { type: 'string' },
            force: { type: 'boolean', default: false },
          },
        });
        const targetDir = positionals[0];
        if (!targetDir) {
          throw new CliValidationError('Missing required positional argument `<dir>`.');
        }
        const { runInitCommand } = await import('./commands/init.js');
        const result = await runInitCommand({
          targetDir,
          family: requireStringFlag(values.family, '--family'),
          title: requireStringFlag(values.title, '--title'),
          accent: values.accent,
          force: values.force,
        });
        io.stdout(
          `Initialized Kinloom archive at ${result.targetDir} (${result.created.length} created, ${result.skipped.length} skipped).`
        );
        return EXIT_OK;
      }

      case 'slice-gedcom': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            input: { type: 'string' },
            out: { type: 'string' },
            root: { type: 'string' },
            surname: { type: 'string', multiple: true },
            branch: { type: 'string' },
            'include-upstream-spouses': { type: 'boolean', default: false },
            'no-ancestor-siblings': { type: 'boolean', default: false },
            'no-descendant-spouses': { type: 'boolean', default: false },
            'no-normalize-maiden': { type: 'boolean', default: false },
            'reference-year': { type: 'string' },
          },
        });
        const { runSliceGedcomCommand } = await import('./commands/sliceGedcom.js');
        const result = await runSliceGedcomCommand({
          inputPath: requireStringFlag(values.input, '--input'),
          outDir: requireStringFlag(values.out, '--out'),
          root: requireStringFlag(values.root, '--root'),
          surnames: values.surname,
          branchId: values.branch,
          includeUpstreamSpouses: values['include-upstream-spouses'],
          includeAncestorSiblings: !values['no-ancestor-siblings'],
          includeDescendantSpouses: !values['no-descendant-spouses'],
          normalizeMaidenNames: !values['no-normalize-maiden'],
          referenceYear: parseOptionalPositiveInt(values['reference-year'], '--reference-year'),
        });
        io.stdout(
          `Sliced GEDCOM from ${result.rootXref} into ${result.outDir}: ${result.stats.totalPeople} people, ${result.stats.totalEvents} events, ${result.stats.totalPlaces} places, ${result.stats.totalSources} sources, ${result.stats.totalKinshipEdges} kinship edges.`
        );
        if (result.anomalies.length > 0) {
          io.stderr(`Anomalies (${result.anomalies.length}): ${result.anomalies.join('; ')}`);
        }
        return EXIT_OK;
      }

      case 'seed': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            data: { type: 'string' },
            config: { type: 'string' },
            site: { type: 'string' },
            token: { type: 'string' },
            'batch-id': { type: 'string' },
            summary: { type: 'string' },
            'chunk-size': { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
          },
        });
        const dryRun = Boolean(values['dry-run']);
        const siteUrl = dryRun
          ? values.site?.trim() || 'http://localhost'
          : requireStringFlag(values.site, '--site');

        const { runSeedCommand } = await import('./commands/seed.js');
        const result = await runSeedCommand({
          dataDir: requireStringFlag(values.data, '--data'),
          configPath: requireStringFlag(values.config, '--config'),
          siteUrl,
          token: values.token,
          dryRun,
          batchId: values['batch-id'],
          summary: values.summary,
          chunkSize: parseOptionalPositiveInt(values['chunk-size'], '--chunk-size'),
          fetchImpl,
        });

        if (result.dryRun) {
          io.stdout(
            `Dry-run OK for batch ${result.batchId}: ${result.createdCount} entities ready (precompiled ${result.precompiledCounts.people} people, ${result.precompiledCounts.events} events, ${result.precompiledCounts.places} places).`
          );
        } else if (!result.response) {
          io.stdout(
            `Seed up to date (${result.unchangedCount} unchanged, 0 created, 0 updated).`
          );
        } else {
          io.stdout(
            `Seeded batch ${result.batchId}: ${result.createdCount} created, ${result.updatedCount} updated, ${result.unchangedCount} unchanged (head r${result.response.head_revision_id}, etag ${result.response.etag}).`
          );
        }
        return EXIT_OK;
      }

      case 'submit-batch': {
        const { values, positionals } = safeParseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            file: { type: 'string' },
            site: { type: 'string' },
            token: { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
          },
        });
        const dryRun = Boolean(values['dry-run']);
        const filePath = values.file ?? positionals[0];
        const siteUrl = dryRun
          ? values.site?.trim() || 'http://localhost'
          : requireStringFlag(values.site, '--site');

        const { runSubmitBatchCommand } = await import('./commands/submitBatch.js');
        const result = await runSubmitBatchCommand({
          filePath: requireStringFlag(filePath, '--file'),
          siteUrl,
          token: values.token,
          dryRun,
          fetchImpl,
        });

        if (result.dryRun || !result.response) {
          io.stdout(
            `Dry-run OK: batch ${result.batchId} (${result.patchCount} patch(es)) passed validation.`
          );
          return EXIT_OK;
        }

        const revIds = result.response.revisions.map((r) => r.revision_id);
        const revRange =
          revIds.length === 0
            ? 'none'
            : revIds.length === 1
              ? `r${revIds[0]}`
              : `r${Math.min(...revIds)}..r${Math.max(...revIds)}`;
        io.stdout(
          `Committed batch ${result.response.batch_id}: ${revIds.length} revision(s) (${revRange}), head r${result.response.head_revision_id}, etag ${result.response.etag}.`
        );
        return EXIT_OK;
      }

      case 'export-yaml': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            site: { type: 'string' },
            out: { type: 'string' },
            token: { type: 'string' },
            'state-file': { type: 'string' },
          },
        });
        const { runExportYamlCommand } = await import('./commands/exportYaml.js');
        const result = await runExportYamlCommand({
          siteUrl: requireStringFlag(values.site, '--site'),
          outDir: requireStringFlag(values.out, '--out'),
          token: values.token,
          stateFile: values['state-file'],
          fetchImpl,
        });

        if (result.status === 'not_modified') {
          io.stdout(
            `Not modified (304) at revision ${result.revisionId !== null ? `r${result.revisionId}` : 'unknown'}.`
          );
          return EXIT_OK;
        }

        io.stdout(
          `Exported ${result.writtenFiles.length} YAML file(s) at r${result.revisionId} via ${result.source} (state: ${result.stateFile}).`
        );
        return EXIT_OK;
      }

      case 'upload-media': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            file: { type: 'string' },
            metadata: { type: 'string' },
            summary: { type: 'string' },
            site: { type: 'string' },
            token: { type: 'string' },
            mime: { type: 'string' },
            'allow-audio-video': { type: 'boolean', default: false },
            'max-bytes': { type: 'string' },
            'dry-run': { type: 'boolean', default: false },
          },
        });
        const dryRun = Boolean(values['dry-run']);
        const siteUrl = dryRun
          ? values.site?.trim() || 'http://localhost'
          : requireStringFlag(values.site, '--site');

        const { runUploadMediaCommand } = await import('./commands/uploadMedia.js');
        const result = await runUploadMediaCommand({
          filePath: requireStringFlag(values.file, '--file'),
          metadataInput: requireStringFlag(values.metadata, '--metadata'),
          summary: requireStringFlag(values.summary, '--summary'),
          siteUrl,
          token: values.token,
          mimeType: values.mime,
          allowAudioVideo: values['allow-audio-video'],
          maxUploadBytes: parseOptionalPositiveInt(values['max-bytes'], '--max-bytes'),
          dryRun,
          fetchImpl,
        });

        if (result.dryRun || !result.response) {
          io.stdout(
            `Dry-run OK: ${result.fileName} (${result.mimeType}, ${result.sizeBytes} bytes) passed media guards.`
          );
          return EXIT_OK;
        }

        io.stdout(
          `Uploaded ${result.response.media.id} -> ${result.response.url} (r${result.response.revision.revision_id}, etag ${result.response.etag}).`
        );
        return EXIT_OK;
      }

      case 'reconcile': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            site: { type: 'string' },
            config: { type: 'string' },
            token: { type: 'string' },
            mode: { type: 'string' },
          },
        });

        let mode: 'private' | 'public' | undefined;
        if (values.mode !== undefined) {
          if (values.mode !== 'private' && values.mode !== 'public') {
            throw new CliValidationError(
              `Invalid \`--mode\` '${values.mode}'. Expected 'private' or 'public'.`
            );
          }
          mode = values.mode;
        }

        const { runReconcileCommand } = await import('./commands/reconcile.js');
        const result = await runReconcileCommand({
          siteUrl: requireStringFlag(values.site, '--site'),
          configPath: requireStringFlag(values.config, '--config'),
          token: values.token,
          mode,
          fetchImpl,
        });

        if (result.inSync) {
          io.stdout(
            `Reconcile OK: cached bundle matches full compileArchive at r${result.headRevisionId} (${result.mode} mode).`
          );
          return EXIT_OK;
        }

        io.stderr(
          `Reconcile DRIFT detected (head r${result.headRevisionId}, cached ${result.cachedRevisionId !== null ? `r${result.cachedRevisionId}` : 'none'}): ${result.drifts.length} difference(s).`
        );
        for (const drift of result.drifts.slice(0, 20)) {
          io.stderr(
            `  [${drift.kind}] ${drift.path}: cached=${JSON.stringify(drift.before)} recompiled=${JSON.stringify(drift.after)}`
          );
        }
        return EXIT_ERROR;
      }

      case 'context': {
        const { values, positionals } = safeParseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            person: { type: 'string' },
            repo: { type: 'string' },
            'ancestry-dir': { type: 'string' },
            'include-family': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const personId = requireStringFlag(values.person ?? positionals[0], '--person');
        const [{ runContextCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/context.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: 'context',
            personId,
            extractResultMeta: (res) => ({
              personId,
              exitCode: EXIT_OK,
              bytesOut: res.bytesOut,
            }),
          },
          () =>
            runContextCommand({
              repoDir: values.repo ?? cwd,
              personId,
              ancestryDir: values['ancestry-dir'],
              includeFamily: values['include-family'],
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      case 'integrate': {
        const { values, positionals } = safeParseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            person: { type: 'string' },
            'person-id': { type: 'string' },
            repo: { type: 'string' },
            package: { type: 'string' },
            'package-dir': { type: 'string' },
            patch: { type: 'string' },
            'all-staged': { type: 'boolean', default: false },
            'pending-only': { type: 'boolean', default: false },
            'mark-integrated': { type: 'boolean', default: false },
            'reconcile-receipts': { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const positionalIds = positionals
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        const packageFlags = [
          values.package !== undefined ? '--package' : undefined,
          values['package-dir'] !== undefined ? '--package-dir' : undefined,
          values.patch !== undefined ? '--patch' : undefined,
        ].filter((flag): flag is string => flag !== undefined);
        if (packageFlags.length > 1) {
          throw new CliValidationError(
            `Specify only one of ${packageFlags.map((flag) => `\`${flag}\``).join(' or ')}, not both.`
          );
        }
        if (
          values.person !== undefined &&
          values['person-id'] !== undefined &&
          values.person.trim() !== values['person-id'].trim()
        ) {
          throw new CliValidationError(
            'Specify either `--person` or `--person-id` with matching values, not conflicting ids.'
          );
        }
        const personFlag = values.person?.trim() || values['person-id']?.trim() || undefined;
        const rawPackageDir = values['package-dir'] ?? values.package ?? values.patch;
        const effectiveRepoDir = values.repo?.trim() || cwd;
        let packageDir = rawPackageDir
          ? normalizeIntegratePackageDir(rawPackageDir, effectiveRepoDir)
          : undefined;

        if (values['pending-only'] && !values['all-staged']) {
          throw new CliValidationError('Option `--pending-only` requires `--all-staged`.');
        }
        const markIntegrated = Boolean(values['mark-integrated'] || values['reconcile-receipts']);
        if (markIntegrated && (!values['all-staged'] || !values['pending-only'])) {
          throw new CliValidationError(
            'Option `--mark-integrated` requires both `--all-staged` and `--pending-only`.'
          );
        }
        if (values['all-staged'] && (positionalIds.length > 0 || personFlag)) {
          throw new CliValidationError(
            '`--all-staged` discovers person ids from research/people and does not take person ids.'
          );
        }
        if (personFlag && positionalIds.length > 0) {
          throw new CliValidationError('Pass person ids as positionals or with `--person`, not both.');
        }

        const useBatch = Boolean(values['all-staged']) || positionalIds.length > 1;
        if (useBatch && packageDir) {
          throw new CliValidationError(
            '`--package` / `--package-dir` applies to a single person integrate only.'
          );
        }

        if (!useBatch) {
          let resolvedPersonId: string | undefined = personFlag ?? positionalIds[0];
          if (!personFlag && !packageDir && positionalIds.length === 1) {
            const fromPositionalPath = resolvePositionalIntegratePackage(
              positionalIds[0],
              effectiveRepoDir
            );
            if (fromPositionalPath) {
              packageDir = fromPositionalPath.packageDir;
              resolvedPersonId = fromPositionalPath.personId;
            }
          }
          if (!resolvedPersonId && packageDir) {
            resolvedPersonId = readPersonIdFromPackageDir(packageDir);
          }
          if (!resolvedPersonId) {
            throw new CliValidationError(
              'Missing target person_id. Pass `<person_id>`, `--person <person_id>`, `--package <dir>`, or `--all-staged` (example: `kinloom integrate <person_id> --dry-run`).'
            );
          }
          const personId = resolvedPersonId;
          const [{ runIntegrateCommand }, { measureCommand }] = await Promise.all([
            import('./commands/ops/integrate.js'),
            import('./commands/ops/telemetry.js'),
          ]);
          const result = await measureCommand(
            {
              subcmd: values['dry-run'] ? 'integrate --dry-run' : 'integrate',
              personId,
              extractResultMeta: (res) => ({
                personId,
                exitCode: EXIT_OK,
                bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
              }),
            },
            () =>
              runIntegrateCommand({
                repoDir: values.repo ?? cwd,
                personId,
                packageDir,
                dryRun: values['dry-run'],
                json: values.json,
              })
          );
          writeRenderedOutput(io, result.rendered);
          return EXIT_OK;
        }

        const [{ runIntegrateBatchCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/integrate-batch.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: values['dry-run'] ? 'integrate --dry-run' : 'integrate',
            personId: null,
            extractResultMeta: (res) => ({
              personId: null,
              exitCode: EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runIntegrateBatchCommand({
              repoDir: values.repo ?? cwd,
              personIds: values['all-staged'] ? undefined : positionalIds,
              allStaged: values['all-staged'],
              pendingOnly: values['pending-only'],
              markIntegrated,
              dryRun: values['dry-run'],
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      case 'audit': {
        const { values, positionals } = safeParseArgs({
          args: rest,
          allowPositionals: true,
          options: {
            person: { type: 'string' },
            'person-id': { type: 'string' },
            repo: { type: 'string' },
            package: { type: 'string' },
            'package-dir': { type: 'string' },
            patch: { type: 'string' },
            json: { type: 'boolean', default: false },
            strict: { type: 'boolean', default: false },
            'all-staged': { type: 'boolean', default: false },
            'pending-only': { type: 'boolean', default: false },
          },
        });
        const positionalIds = positionals.map((personId) => personId.trim()).filter((personId) => personId.length > 0);
        const packageFlags = [
          values.package !== undefined ? '--package' : undefined,
          values['package-dir'] !== undefined ? '--package-dir' : undefined,
          values.patch !== undefined ? '--patch' : undefined,
        ].filter((flag): flag is string => flag !== undefined);
        if (packageFlags.length > 1) {
          throw new CliValidationError(
            `Specify only one of ${packageFlags.map((flag) => `\`${flag}\``).join(' or ')}, not both.`
          );
        }
        if (
          values.person !== undefined &&
          values['person-id'] !== undefined &&
          values.person.trim() !== values['person-id'].trim()
        ) {
          throw new CliValidationError(
            'Specify either `--person` or `--person-id` with matching values, not conflicting ids.'
          );
        }
        const personFlag = values.person?.trim() || values['person-id']?.trim() || undefined;
        const resolvedRepoDir = values.repo?.trim() || cwd;
        const rawPackageDir = values['package-dir'] ?? values.package ?? values.patch;
        let packageDir = rawPackageDir
          ? normalizeIntegratePackageDir(rawPackageDir, resolvedRepoDir)
          : undefined;

        if (values['pending-only'] && !values['all-staged']) {
          throw new CliValidationError('Option `--pending-only` requires `--all-staged`.');
        }
        if (values['all-staged'] && (positionalIds.length > 0 || personFlag)) {
          throw new CliValidationError(
            '`--all-staged` discovers person ids from research/people and does not take person ids.'
          );
        }
        if (personFlag && positionalIds.length > 0) {
          throw new CliValidationError('Pass person ids as positionals or with `--person`, not both.');
        }
        const [auditMod, batchMod, integrateBatchMod, { measureCommand }] = await Promise.all([
          import('./commands/ops/audit.js'),
          import('./commands/ops/audit-overlaps.js'),
          import('./commands/ops/integrate-batch.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const { runAuditCommand } = auditMod;
        const { runAuditBatchCommand, listStagedAuditPersonIds } = batchMod;
        const { classifyStagedPackages } = integrateBatchMod;
        let batchIds = values['all-staged']
          ? listStagedAuditPersonIds(resolvedRepoDir)
          : positionalIds;
        let skippedAlreadyIntegrated: string[] | undefined;
        let skippedDrifted: string[] | undefined;
        if (values['all-staged'] && !values['pending-only'] && batchIds.length === 0) {
          throw new CliValidationError(
            'No staged packages with patch.json were found under research/people/.'
          );
        }
        if (values['all-staged'] && values['pending-only']) {
          const classified = await classifyStagedPackages(resolvedRepoDir, batchIds);
          batchIds = classified.pending;
          skippedAlreadyIntegrated = classified.alreadyIntegrated;
          skippedDrifted = classified.alreadyIntegratedDrifted;
        }
        const useBatch = values['all-staged'] || batchIds.length > 1;
        if (useBatch && packageDir) {
          throw new CliValidationError('`--package` / `--package-dir` applies to a single person audit only.');
        }
        if (!useBatch) {
          let resolvedPersonId: string | undefined = personFlag ?? positionalIds[0];
          if (!personFlag && !packageDir && positionalIds.length === 1) {
            const fromPositionalPath = resolvePositionalIntegratePackage(
              positionalIds[0],
              resolvedRepoDir
            );
            if (fromPositionalPath) {
              packageDir = fromPositionalPath.packageDir;
              resolvedPersonId = fromPositionalPath.personId;
            }
          }
          if (!resolvedPersonId && packageDir) {
            resolvedPersonId = readPersonIdFromPackageDir(packageDir);
          }
          const personId = requireStringFlag(resolvedPersonId, '--person');
          const result = await measureCommand(
            {
              subcmd: 'audit',
              personId,
              extractResultMeta: (res) => ({
                personId,
                exitCode: (values.strict ? res.strictOk : res.ok) ? EXIT_OK : EXIT_ERROR,
                bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
              }),
            },
            () =>
              runAuditCommand({
                repoDir: resolvedRepoDir,
                personId,
                packageDir,
                json: values.json,
              })
          );
          writeRenderedOutput(io, result.rendered);
          return (values.strict ? result.strictOk : result.ok) ? EXIT_OK : EXIT_ERROR;
        }
        const result = await measureCommand(
          {
            subcmd: 'audit',
            personId: null,
            extractResultMeta: (res) => ({
              personId: null,
              exitCode: (values.strict ? res.strictOk : res.ok) ? EXIT_OK : EXIT_ERROR,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runAuditBatchCommand({
              repoDir: resolvedRepoDir,
              personIds: batchIds,
              json: values.json,
              pendingOnly: values['pending-only'],
              skippedAlreadyIntegrated,
              skippedDrifted,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return (values.strict ? result.strictOk : result.ok) ? EXIT_OK : EXIT_ERROR;
      }

      case 'media': {
        const sub = rest[0];
        if (sub !== 'dedupe') {
          throw new CliValidationError(
            sub
              ? `Unknown media subcommand '${sub}'. Expected \`dedupe\`.`
              : 'Missing media subcommand. Expected `dedupe` (usage: `kinloom media dedupe [--repo <dir>] [--prefer <id>...] [--apply] [--json]`).'
          );
        }
        const subArgs = rest.slice(1);
        const { values } = safeParseArgs({
          args: subArgs,
          allowPositionals: false,
          options: {
            repo: { type: 'string' },
            prefer: { type: 'string', multiple: true },
            apply: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const [{ runMediaDedupeCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/media-dedupe.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: values.apply ? 'media dedupe --apply' : 'media dedupe',
            extractResultMeta: (res) => ({
              exitCode: EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runMediaDedupeCommand({
              repoDir: values.repo ?? cwd,
              preferIds: values.prefer,
              apply: values.apply,
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      case 'verify': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            repo: { type: 'string' },
            'strict-hygiene': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const [{ runVerifyCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/verify.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: 'verify',
            extractResultMeta: (res) => ({
              exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runVerifyCommand({
              repoDir: values.repo ?? cwd,
              strictHygiene: values['strict-hygiene'],
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return result.ok ? EXIT_OK : EXIT_ERROR;
      }

      case 'status': {
        const { values } = safeParseArgs({
          args: bindSignedStatusLimit(rest),
          allowPositionals: false,
          options: {
            repo: { type: 'string' },
            limit: { type: 'string' },
            filter: { type: 'string' },
            sort: { type: 'string' },
            'end-of-line': { type: 'boolean', default: false },
            'missing-biography': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const limit = parseStatusLimit(values.limit);
        const filter = parseStatusFilter(values.filter);
        const [{ parseStatusSort, runStatusCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/status.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const sort = parseStatusSort(values.sort);
        const result = await measureCommand(
          {
            subcmd: 'status',
            extractResultMeta: (res) => ({
              exitCode: EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runStatusCommand({
              repoDir: values.repo ?? cwd,
              json: values.json,
              limit,
              filter,
              sort,
              endOfLine: values['end-of-line'],
              missingBiography: values['missing-biography'],
            })
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      case 'sync': {
        const parsed = parseSyncArgs(rest);
        const [{ parseDeleteTargets, parseEntityTypeList, runSyncCommand }, { measureCommand }] =
          await Promise.all([
            import('./commands/ops/sync.js'),
            import('./commands/ops/telemetry.js'),
          ]);
        const types = parsed.typesRaw ? parseEntityTypeList(parsed.typesRaw) : undefined;
        const explicitDeletes =
          parsed.deleteTokens.length > 0
            ? parseDeleteTargets(parsed.deleteTokens.join(','))
            : undefined;
        const result = await measureCommand(
          {
            subcmd: parsed.dryRun ? 'sync --dry-run' : 'sync',
            extractResultMeta: (res) => ({
              exitCode:
                res.liveVerification && !res.liveVerification.ok ? EXIT_ERROR : EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runSyncCommand({
              repoDir: parsed.repoDir ?? cwd,
              siteUrl: parsed.siteUrl,
              types,
              syncMissingMedia: parsed.syncMissingMedia,
              uploadMediaPaths: parsed.uploadMediaPaths,
              concurrency: parsed.concurrency,
              chunkSize: parsed.chunkSize,
              summary: parsed.summary,
              allowDeletes: parsed.allowDeletes,
              explicitDeletes,
              includeLiving: parsed.includeLiving,
              verifyLive: parsed.verifyLive,
              dryRun: parsed.dryRun,
              json: parsed.json,
              fetchImpl,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return result.liveVerification && !result.liveVerification.ok ? EXIT_ERROR : EXIT_OK;
      }

      case 'migrate': {
        const { values } = safeParseArgs({
          args: rest,
          allowPositionals: false,
          options: {
            repo: { type: 'string' },
            remote: { type: 'boolean', default: false },
            local: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        if (values.remote && values.local) {
          throw new CliValidationError('Specify either `--remote` or `--local`, not both.');
        }
        const target = values.local ? 'local' : 'remote';
        const [{ runMigrateCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/migrate.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: values['dry-run'] ? 'migrate --dry-run' : 'migrate',
            extractResultMeta: (res) => ({
              exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runMigrateCommand({
              repoDir: values.repo ?? cwd,
              target,
              dryRun: values['dry-run'],
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return result.ok ? EXIT_OK : EXIT_ERROR;
      }

      case 'dates': {
        const sub = rest[0];
        if (sub !== 'weekday' && sub !== 'diff' && sub !== 'age') {
          throw new CliValidationError(
            sub
              ? `Unknown dates subcommand '${sub}'. Expected \`weekday\`, \`diff\`, or \`age\`.`
              : 'Missing dates subcommand. Expected `weekday`, `diff`, or `age`.'
          );
        }
        const subArgs = rest.slice(1);
        const { values, positionals } = safeParseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            at: { type: 'string', multiple: true },
            json: { type: 'boolean', default: false },
          },
        });
        const [{ runDatesCommand }, { measureCommand }] = await Promise.all([
          import('./commands/ops/dates.js'),
          import('./commands/ops/telemetry.js'),
        ]);
        const result = await measureCommand(
          {
            subcmd: `dates ${sub}`,
            extractResultMeta: (res) => ({
              exitCode: EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          async () => {
            if (sub === 'weekday') {
              if (values.at && values.at.length > 0) {
                throw new CliValidationError('Option `--at` is only valid with `kinloom dates age`.');
              }
              if (positionals.length !== 1) {
                throw new CliValidationError(
                  'Usage: kinloom dates weekday <YYYY-MM-DD> [--json]'
                );
              }
              return runDatesCommand({
                subcommand: 'weekday',
                date: positionals[0],
                json: values.json,
              });
            }
            if (sub === 'diff') {
              if (values.at && values.at.length > 0) {
                throw new CliValidationError('Option `--at` is only valid with `kinloom dates age`.');
              }
              if (positionals.length !== 2) {
                throw new CliValidationError(
                  'Usage: kinloom dates diff <start-YYYY-MM-DD> <end-YYYY-MM-DD> [--json]'
                );
              }
              return runDatesCommand({
                subcommand: 'diff',
                startDate: positionals[0],
                endDate: positionals[1],
                json: values.json,
              });
            }
            if (positionals.length < 1) {
              throw new CliValidationError(
                'Usage: kinloom dates age <birth-YYYY-MM-DD> --at <YYYY-MM-DD> [--at ...] [--json]'
              );
            }
            const [birthDate, ...positionalAts] = positionals;
            const atDates = [...(values.at ?? []), ...positionalAts];
            return runDatesCommand({
              subcommand: 'age',
              birthDate,
              atDates,
              json: values.json,
            });
          }
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      case 'pronounce': {
        const sub = rest[0];
        if (sub !== 'lookup' && sub !== 'audit') {
          throw new CliValidationError(
            sub
              ? `Unknown pronounce subcommand '${sub}'. Expected \`lookup\` or \`audit\`.`
              : 'Missing pronounce subcommand. Expected `lookup` or `audit`.'
          );
        }
        const subArgs = rest.slice(1);
        const [{ runPronounceAuditCommand, runPronounceLookupCommand }, { measureCommand }] =
          await Promise.all([
            import('./commands/ops/pronounce.js'),
            import('./commands/ops/telemetry.js'),
          ]);
        if (sub === 'lookup') {
          const { values, positionals } = safeParseArgs({
            args: subArgs,
            allowPositionals: true,
            options: {
              lang: { type: 'string' },
              refresh: { type: 'boolean', default: false },
              json: { type: 'boolean', default: false },
            },
          });
          const term = positionals.join(' ').trim();
          if (!term) {
            throw new CliValidationError(
              'Usage: kinloom pronounce lookup <term> [--lang nl|sv|fi|pl|de|en] [--refresh] [--json]'
            );
          }
          const result = await measureCommand(
            {
              subcmd: 'pronounce lookup',
              extractResultMeta: (res) => ({
                exitCode: EXIT_OK,
                cacheHit: res.cache_hit,
                bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
              }),
            },
            () =>
              runPronounceLookupCommand({
                term,
                lang: values.lang,
                refresh: values.refresh,
                json: values.json,
                fetchImpl,
              })
          );
          writeRenderedOutput(io, result.rendered);
          return EXIT_OK;
        }
        const { values } = safeParseArgs({
          args: subArgs,
          allowPositionals: false,
          options: {
            repo: { type: 'string' },
            strict: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
          },
        });
        const result = await measureCommand(
          {
            subcmd: 'pronounce audit',
            extractResultMeta: (res) => ({
              exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          async () =>
            runPronounceAuditCommand({
              repoDir: values.repo ?? cwd,
              strict: values.strict,
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return result.ok ? EXIT_OK : EXIT_ERROR;
      }

      case 'telemetry': {
        const sub = rest[0];
        const subArgs = sub === 'report' ? rest.slice(1) : rest;
        if (sub && sub !== 'report' && !sub.startsWith('-')) {
          throw new CliValidationError(
            `Unknown telemetry subcommand '${sub}'. Use \`kinloom telemetry report\`.`
          );
        }
        const { values } = safeParseArgs({
          args: subArgs,
          allowPositionals: false,
          options: {
            'since-hours': { type: 'string' },
            file: { type: 'string' },
            json: { type: 'boolean', default: false },
          },
        });
        const { measureCommand, runTelemetryReportCommand } = await import(
          './commands/ops/telemetry.js'
        );
        const result = await measureCommand(
          {
            subcmd: 'telemetry report',
            filePath: values.file,
            extractResultMeta: (res) => ({
              exitCode: EXIT_OK,
              bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
            }),
          },
          () =>
            runTelemetryReportCommand({
              filePath: values.file,
              sinceHours: parseOptionalPositiveNumber(values['since-hours'], '--since-hours'),
              json: values.json,
            })
        );
        writeRenderedOutput(io, result.rendered);
        return EXIT_OK;
      }

      default: {
        const pluginCmd = mergedPlugins.commands.get(command);
        if (pluginCmd) {
          const pluginCtx: KinloomCliPluginContext = {
            cwd,
            io,
            fetchImpl,
            siteConfig: discovered.siteConfig,
          };
          return normalizeExitCode(await pluginCmd.run(rest, pluginCtx));
        }
        io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
        return EXIT_USAGE;
      }
    }
  } catch (err: unknown) {
    if (err instanceof CliValidationError) {
      io.stderr(`Validation error: ${err.message}`);
      for (const issue of err.issues) {
        io.stderr(`  - ${issue}`);
      }
      return err.exitCode;
    }

    if (err instanceof KinloomApiError) {
      io.stderr(`API error (${err.status} ${err.code}): ${err.message}`);
      if (err.conflict) {
        io.stderr(formatConflictDetails(err.conflict));
      }
      return err.exitCode;
    }

    const message = err instanceof Error ? err.message : String(err);
    io.stderr(`Error: ${message}`);
    return EXIT_ERROR;
  }
}

function isExecutedDirectly(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entryArg);
  } catch {
    return fileURLToPath(import.meta.url) === entryArg;
  }
}

if (isExecutedDirectly()) {
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      process.exit(0);
    }
    throw err;
  });
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
