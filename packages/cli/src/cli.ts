#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { BuildModeSchema } from '@kinloom/core';
import { runExportYamlCommand } from './commands/exportYaml.js';
import { runInitCommand } from './commands/init.js';
import { runReconcileCommand } from './commands/reconcile.js';
import { runSeedCommand } from './commands/seed.js';
import { runSliceGedcomCommand } from './commands/sliceGedcom.js';
import { runSubmitBatchCommand } from './commands/submitBatch.js';
import { runUploadMediaCommand } from './commands/uploadMedia.js';
import {
  CliValidationError,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  KinloomApiError,
  formatConflictDetails,
  type CliExitCode,
} from './errors.js';

export interface CliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

export interface RunCliOptions {
  io?: CliIo;
  fetchImpl?: typeof fetch;
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

Commands:
  init           Scaffold a thin private family archive repository
  slice-gedcom   Slice a combined GEDCOM export into deterministic YAML files
  seed           Load local YAML + config and submit an idempotent seed batch
  submit-batch   Validate and submit a typed BatchSubmission JSON/YAML file
  export-yaml    Export deterministic YAML snapshot with ETag/304 support
  upload-media   Validate and upload a media scan or recording via multipart POST
  reconcile      Compare cached GET /api/bundle against full compileArchive

Global options:
  -h, --help     Show help for kinloom or a specific command

Environment variables:
  KINLOOM_TOKEN  Bearer token used when --token is omitted

Exit codes:
  0  Success
  1  Runtime, HTTP, or reconciliation drift error
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
  --root <xref-or-name>        Root individual xref (@I1@) or full name (required)
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
};

function requireStringFlag(value: string | undefined, flagName: string): string {
  if (!value || !value.trim()) {
    throw new CliValidationError(`Missing required option \`${flagName}\`.`);
  }
  return value.trim();
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

export async function runCli(
  argv: readonly string[],
  options?: RunCliOptions
): Promise<CliExitCode> {
  const io = options?.io ?? DEFAULT_IO;
  const fetchImpl = options?.fetchImpl;

  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    const sub = argv[0] === 'help' ? argv[1] : undefined;
    if (sub && COMMAND_HELP[sub]) {
      io.stdout(COMMAND_HELP[sub]);
    } else {
      io.stdout(ROOT_HELP);
    }
    return EXIT_OK;
  }

  const [command, ...rest] = argv;

  if (rest.includes('-h') || rest.includes('--help')) {
    const help = COMMAND_HELP[command];
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
            'dry-run': { type: 'boolean', default: false },
          },
        });
        const dryRun = Boolean(values['dry-run']);
        const siteUrl = dryRun
          ? values.site?.trim() || 'http://localhost'
          : requireStringFlag(values.site, '--site');

        const result = await runSeedCommand({
          dataDir: requireStringFlag(values.data, '--data'),
          configPath: requireStringFlag(values.config, '--config'),
          siteUrl,
          token: values.token,
          dryRun,
          batchId: values['batch-id'],
          summary: values.summary,
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

        let mode;
        if (values.mode !== undefined) {
          const parsedMode = BuildModeSchema.safeParse(values.mode);
          if (!parsedMode.success) {
            throw new CliValidationError(
              `Invalid \`--mode\` '${values.mode}'. Expected 'private' or 'public'.`
            );
          }
          mode = parsedMode.data;
        }

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

      default:
        io.stderr(`Unknown command '${command}'. Run \`kinloom --help\` for available commands.`);
        return EXIT_USAGE;
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
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
