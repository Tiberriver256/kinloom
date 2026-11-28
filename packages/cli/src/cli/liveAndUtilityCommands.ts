import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import {
  type CliDispatchContext,
  parseOptionalPositiveInt,
  parseOptionalPositiveNumber,
  safeParseArgs,
  writeRenderedOutput,
} from './types.js';

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
    if (arg === undefined) continue;
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
      const concurrency = parseOptionalPositiveInt(val, '--concurrency');
      if (concurrency !== undefined) parsed.concurrency = concurrency;
      i = nextIdx;
      continue;
    }
    if (arg === '--chunk-size' || arg.startsWith('--chunk-size=')) {
      const [val, nextIdx] = readFlagValue(arg, i, '--chunk-size');
      const chunkSize = parseOptionalPositiveInt(val, '--chunk-size');
      if (chunkSize !== undefined) parsed.chunkSize = chunkSize;
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
        while (i + 1 < argv.length && !(argv[i + 1] ?? '').startsWith('-')) {
          i += 1;
          for (const item of (argv[i] ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)) {
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

export async function runSync(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const parsed = parseSyncArgs(rest);
  const [{ parseDeleteTargets, parseEntityTypeList, runSyncCommand }, { measureCommand }] = await Promise.all(
    [import('../commands/ops/sync.js'), import('../commands/ops/telemetry.js')]
  );
  const types = parsed.typesRaw ? parseEntityTypeList(parsed.typesRaw) : undefined;
  const explicitDeletes =
    parsed.deleteTokens.length > 0 ? parseDeleteTargets(parsed.deleteTokens.join(',')) : undefined;
  const result = await measureCommand(
    {
      subcmd: parsed.dryRun ? 'sync --dry-run' : 'sync',
      extractResultMeta: (res) => ({
        exitCode: res.liveVerification && !res.liveVerification.ok ? EXIT_ERROR : EXIT_OK,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runSyncCommand({
        repoDir: parsed.repoDir ?? ctx.cwd,
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
        fetchImpl: ctx.fetchImpl,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return result.liveVerification && !result.liveVerification.ok ? EXIT_ERROR : EXIT_OK;
}

export async function runMigrate(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      'plugin-migrations': { type: 'string' },
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
    import('../commands/ops/migrate.js'),
    import('../commands/ops/telemetry.js'),
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
        repoDir: values.repo ?? ctx.cwd,
        pluginMigrationsDir: values['plugin-migrations'],
        target,
        dryRun: values['dry-run'],
        json: values.json,
      })
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}

export async function runDates(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const sub = rest[0];
  if (sub !== 'weekday' && sub !== 'diff' && sub !== 'age' && sub !== 'convert') {
    throw new CliValidationError(
      sub
        ? `Unknown dates subcommand '${sub}'. Expected \`weekday\`, \`diff\`, \`age\`, or \`convert\`.`
        : 'Missing dates subcommand. Expected `weekday`, `diff`, `age`, or `convert`.'
    );
  }
  const subArgs = rest.slice(1);
  const { values, positionals } = safeParseArgs({
    args: subArgs,
    allowPositionals: true,
    options: {
      at: { type: 'string', multiple: true },
      from: { type: 'string' },
      to: { type: 'string' },
      region: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const [{ parseCalendarRegion, parseCalendarSystem, runDatesCommand }, { measureCommand }] =
    await Promise.all([import('../commands/ops/dates.js'), import('../commands/ops/telemetry.js')]);
  const result = await measureCommand(
    {
      subcmd: `dates ${sub}`,
      extractResultMeta: (res) => ({
        exitCode: EXIT_OK,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    async () => {
      if (
        sub !== 'convert' &&
        (values.from !== undefined || values.to !== undefined || values.region !== undefined)
      ) {
        throw new CliValidationError(
          'Options `--from`, `--to`, and `--region` are only valid with `kinloom dates convert`.'
        );
      }
      if (sub === 'weekday') {
        if (values.at && values.at.length > 0) {
          throw new CliValidationError('Option `--at` is only valid with `kinloom dates age`.');
        }
        if (positionals.length !== 1) {
          throw new CliValidationError('Usage: kinloom dates weekday <YYYY-MM-DD> [--json]');
        }
        return runDatesCommand({
          subcommand: 'weekday',
          date: positionals[0] ?? '',
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
          startDate: positionals[0] ?? '',
          endDate: positionals[1] ?? '',
          json: values.json,
        });
      }
      if (sub === 'convert') {
        if (values.at && values.at.length > 0) {
          throw new CliValidationError('Option `--at` is only valid with `kinloom dates age`.');
        }
        if (positionals.length !== 1) {
          throw new CliValidationError(
            'Usage: kinloom dates convert <YYYY-MM-DD> --from julian|swedish|gregorian --to gregorian|julian|swedish [--region gb|se-fi|nl] [--json]'
          );
        }
        if (!values.from) {
          throw new CliValidationError(
            'Missing required option `--from <julian|swedish|gregorian>` for `kinloom dates convert`.'
          );
        }
        if (!values.to) {
          throw new CliValidationError(
            'Missing required option `--to <gregorian|julian|swedish>` for `kinloom dates convert`.'
          );
        }
        const from = parseCalendarSystem(values.from, '--from');
        const to = parseCalendarSystem(values.to, '--to');
        const region = values.region !== undefined ? parseCalendarRegion(values.region) : undefined;
        return runDatesCommand({
          subcommand: 'convert',
          date: positionals[0] ?? '',
          from,
          to,
          region,
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
        birthDate: birthDate ?? '',
        atDates,
        json: values.json,
      });
    }
  );
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

export { runPronounce } from './pronounceCommand.js';

export async function runTelemetry(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const sub = rest[0];
  const subArgs = sub === 'report' ? rest.slice(1) : rest;
  if (sub && sub !== 'report' && !sub.startsWith('-')) {
    throw new CliValidationError(`Unknown telemetry subcommand '${sub}'. Use \`kinloom telemetry report\`.`);
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
  const { measureCommand, runTelemetryReportCommand } = await import('../commands/ops/telemetry.js');
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
  writeRenderedOutput(ctx.io, result.rendered);
  return EXIT_OK;
}

export async function runVerifyLive(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const { values } = safeParseArgs({
    args: rest,
    allowPositionals: false,
    options: {
      repo: { type: 'string' },
      url: { type: 'string' },
      token: { type: 'string' },
      'with-temp-auth': { type: 'boolean', default: false },
      'expect-plugins': { type: 'string' },
      browser: { type: 'boolean', default: false },
      'check-pwa': { type: 'boolean', default: false },
      'timeout-ms': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  if (values['with-temp-auth'] && values.token?.trim()) {
    throw new CliValidationError('Specify either `--token` or `--with-temp-auth`, not both.');
  }

  const [{ parseExpectedPluginsCsv, runVerifyLiveCommand }, { measureCommand }] = await Promise.all([
    import('../commands/ops/verify-live.js'),
    import('../commands/ops/telemetry.js'),
  ]);

  const expectPlugins = parseExpectedPluginsCsv(values['expect-plugins']);
  const timeoutMs = parseOptionalPositiveInt(values['timeout-ms'], '--timeout-ms');

  const result = await measureCommand(
    {
      subcmd: 'verify-live',
      extractResultMeta: (res) => ({
        exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      runVerifyLiveCommand({
        repoDir: values.repo ?? ctx.cwd,
        url: values.url,
        token: values.token,
        withTempAuth: values['with-temp-auth'],
        expectPlugins,
        browser: values.browser,
        checkPwa: values['check-pwa'],
        timeoutMs,
        json: values.json,
        fetchImpl: ctx.fetchImpl,
        execWrangler: ctx.execWrangler,
      })
  );

  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}
