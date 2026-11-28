import path from 'node:path';
import type { DesignAuditTheme, DesignAuditUiState } from '../commands/ops/design-audit/types.js';
import { type CliExitCode, CliValidationError, EXIT_ERROR, EXIT_OK } from '../errors.js';
import { type CliDispatchContext, safeParseArgs, writeRenderedOutput } from './types.js';

const VALID_THEMES = new Set<DesignAuditTheme>(['light', 'dark', 'more-contrast']);
const VALID_STATES = new Set<DesignAuditUiState>([
  'ideal',
  'loading',
  'empty-first',
  'empty-cleared',
  'empty-zero',
  'partial',
  'error',
]);

function splitCsvFlags(values: readonly string[] | undefined): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  return values
    .flatMap((v) => v.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseThemes(raw: string | undefined): DesignAuditTheme[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = splitCsvFlags([raw]);
  const out: DesignAuditTheme[] = [];
  for (const item of parsed) {
    if (!VALID_THEMES.has(item as DesignAuditTheme)) {
      throw new CliValidationError(`Unknown theme '${item}'. Expected one of: light, dark, more-contrast.`);
    }
    if (!out.includes(item as DesignAuditTheme)) {
      out.push(item as DesignAuditTheme);
    }
  }
  return out;
}

function parseUiStates(raw: string | undefined): DesignAuditUiState[] | undefined {
  if (!raw) {
    return undefined;
  }
  const parsed = splitCsvFlags([raw]);
  const out: DesignAuditUiState[] = [];
  for (const item of parsed) {
    if (!VALID_STATES.has(item as DesignAuditUiState)) {
      throw new CliValidationError(
        `Unknown UI state '${item}'. Expected one of: ideal, loading, empty-first, empty-cleared, empty-zero, partial, error.`
      );
    }
    if (!out.includes(item as DesignAuditUiState)) {
      out.push(item as DesignAuditUiState);
    }
  }
  return out;
}

export async function runDesignAudit(rest: readonly string[], ctx: CliDispatchContext): Promise<CliExitCode> {
  const first = rest[0];
  const isSubcommand = first !== undefined && !first.startsWith('-');
  const subcommand = isSubcommand ? first : 'run';
  const subArgs = isSubcommand ? rest.slice(1) : rest;

  const [mod, { measureCommand }] = await Promise.all([
    import('../commands/ops/design-audit.js'),
    import('../commands/ops/telemetry.js'),
  ]);

  if (subcommand === 'archetypes') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        archetype: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
    });
    const rendered = mod.formatArchetypesOutput(values.archetype, values.json);
    writeRenderedOutput(ctx.io, rendered);
    return EXIT_OK;
  }

  if (subcommand === 'standards') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        json: { type: 'boolean', default: false },
      },
    });
    const rendered = mod.formatStandardsOutput(values.json);
    writeRenderedOutput(ctx.io, rendered);
    return EXIT_OK;
  }

  if (subcommand === 'init') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        out: { type: 'string' },
        url: { type: 'string' },
        archetype: { type: 'string' },
        routes: { type: 'string', multiple: true },
        repo: { type: 'string' },
        force: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const outPath = path.resolve(ctx.cwd, values.out ?? 'design-audit.plan.json');
    const arch = values.archetype ? mod.resolveDesignAuditArchetype(values.archetype).id : undefined;
    const routes = splitCsvFlags(values.routes);
    const result = mod.initDesignAuditPlan({
      outPath,
      baseUrl: values.url,
      archetype: arch,
      routes: routes.length > 0 ? routes : undefined,
      repoRoot: values.repo ? path.resolve(ctx.cwd, values.repo) : ctx.cwd,
      force: values.force,
      json: values.json,
    });
    writeRenderedOutput(ctx.io, result.rendered);
    return EXIT_OK;
  }

  if (subcommand === 'css') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        bundle: { type: 'string' },
        repo: { type: 'string' },
        css: { type: 'string', multiple: true },
        tokens: { type: 'string', multiple: true },
        archetype: { type: 'string' },
        'fail-on-error': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    const arch = values.archetype ? mod.resolveDesignAuditArchetype(values.archetype).id : undefined;
    const res = mod.auditTokensAndCss({
      bundleDir: values.bundle ? path.resolve(ctx.cwd, values.bundle) : undefined,
      repoRoot: values.repo ? path.resolve(ctx.cwd, values.repo) : ctx.cwd,
      archetype: arch,
      cssPaths: splitCsvFlags(values.css),
      tokenPaths: splitCsvFlags(values.tokens),
      writeOutput: Boolean(values.bundle),
    });
    const rendered = values.json
      ? JSON.stringify(res, null, 2)
      : [
          `CSS & DTCG Token Audit (archetype: ${res.archetype})`,
          res.cssStats
            ? `Stats: ${res.cssStats.scannedCssFiles} CSS files, ${res.cssStats.scannedTokenFiles} DTCG files, ${res.cssStats.uniqueColors} unique colors, ${res.cssStats.uniqueFontSizes} unique font sizes, ${res.cssStats.importants} !important`
            : 'Stats: no CSS content scanned',
          `Findings: ${res.findings.length} (${res.findings.filter((f) => f.severity === 'error').length} errors, ${res.findings.filter((f) => f.severity === 'warning').length} warnings)`,
        ].join('\n');
    writeRenderedOutput(ctx.io, rendered);
    return values['fail-on-error'] && !res.ok ? EXIT_ERROR : EXIT_OK;
  }

  if (subcommand === 'sarif') {
    const { values } = safeParseArgs({
      args: subArgs,
      allowPositionals: false,
      options: {
        bundle: { type: 'string' },
        baseline: { type: 'string' },
        'fail-on-error': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
    });
    if (!values.bundle) {
      throw new CliValidationError(
        'Missing required option `--bundle <dir>` for `kinloom design-audit sarif`.'
      );
    }
    const summary = mod.emitSarifAndDossier({
      bundleDir: path.resolve(ctx.cwd, values.bundle),
      baselinePath: values.baseline ? path.resolve(ctx.cwd, values.baseline) : undefined,
    });
    const rendered = values.json
      ? JSON.stringify(summary, null, 2)
      : [
          `SARIF 2.1.0 emitted: ${summary.sarifPath}`,
          `Executive Dossier:   ${summary.dossierPath}`,
          `Findings: ${summary.totalFindings} total (${summary.blockingErrors} blocking errors, ${summary.warnings} warnings, ${summary.newBlockingRegressions} new regressions)`,
        ].join('\n');
    writeRenderedOutput(ctx.io, rendered);
    return values['fail-on-error'] && !summary.ok ? EXIT_ERROR : EXIT_OK;
  }

  if (subcommand !== 'run') {
    throw new CliValidationError(
      `Unknown design-audit subcommand '${subcommand}'. Expected one of: run, init, css, sarif, archetypes, standards.`
    );
  }

  const { values } = safeParseArgs({
    args: subArgs,
    allowPositionals: false,
    options: {
      url: { type: 'string' },
      plan: { type: 'string' },
      'out-dir': { type: 'string' },
      repo: { type: 'string' },
      archetype: { type: 'string' },
      routes: { type: 'string', multiple: true },
      themes: { type: 'string' },
      states: { type: 'string' },
      css: { type: 'string', multiple: true },
      tokens: { type: 'string', multiple: true },
      baseline: { type: 'string' },
      'static-only': { type: 'boolean', default: false },
      'fail-on-error': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });

  const arch = values.archetype ? mod.resolveDesignAuditArchetype(values.archetype).id : undefined;
  const routes = splitCsvFlags(values.routes);

  const result = await measureCommand(
    {
      subcmd: 'design-audit',
      extractResultMeta: (res) => ({
        exitCode: res.ok ? EXIT_OK : EXIT_ERROR,
        bytesOut: Buffer.byteLength(res.rendered, 'utf8'),
      }),
    },
    () =>
      mod.runDesignAuditCommand({
        url: values.url,
        planPath: values.plan ? path.resolve(ctx.cwd, values.plan) : undefined,
        outDir: values['out-dir'] ? path.resolve(ctx.cwd, values['out-dir']) : undefined,
        repoRoot: values.repo ? path.resolve(ctx.cwd, values.repo) : ctx.cwd,
        archetype: arch,
        routes: routes.length > 0 ? routes : undefined,
        themes: parseThemes(values.themes),
        states: parseUiStates(values.states),
        cssPaths: splitCsvFlags(values.css),
        tokenPaths: splitCsvFlags(values.tokens),
        baselinePath: values.baseline ? path.resolve(ctx.cwd, values.baseline) : undefined,
        staticOnly: values['static-only'],
        failOnError: values['fail-on-error'],
        json: values.json,
      })
  );

  writeRenderedOutput(ctx.io, result.rendered);
  return result.ok ? EXIT_OK : EXIT_ERROR;
}
