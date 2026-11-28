import fs from 'node:fs';
import path from 'node:path';
import { CliValidationError } from '../../errors.js';
import {
  DESIGN_AUDIT_ARCHETYPES,
  DESIGN_AUDIT_INVARIANTS,
  DESIGN_AUDIT_STANDARDS,
  resolveDesignAuditArchetype,
} from './design-audit/archetypes.js';
import { type DesignAuditBrowserFactory, runDesignAuditCaptureMatrix } from './design-audit/capture.js';
import { evaluateBundleDeterministic } from './design-audit/deterministic.js';
import { discoverDesignAuditAutoRoutes, mergeUniqueRoutes } from './design-audit/discovery.js';
import { emitSarifAndDossier } from './design-audit/sarif.js';
import { auditTokensAndCss } from './design-audit/tokensCss.js';
import type {
  DesignAuditArchetypeId,
  DesignAuditCssResult,
  DesignAuditManifest,
  DesignAuditPlan,
  DesignAuditSarifSummary,
  DesignAuditTheme,
  DesignAuditUiState,
} from './design-audit/types.js';
import { redeemEphemeralInviteSession, withEphemeralD1Auth } from './shared/ephemeralAuth.js';
import type { WranglerExecutor } from './shared/wrangler.js';

export * from './design-audit/apca.js';
export * from './design-audit/archetypes.js';
export * from './design-audit/capture.js';
export * from './design-audit/deterministic.js';
export * from './design-audit/discovery.js';
export * from './design-audit/sarif.js';
export * from './design-audit/tokensCss.js';
export type * from './design-audit/types.js';
export { DESIGN_AUDIT_HELP } from './help.js';

export interface DesignAuditInitOptions {
  readonly outPath: string;
  readonly baseUrl?: string | undefined;
  readonly archetype?: DesignAuditArchetypeId | undefined;
  readonly routes?: readonly string[] | undefined;
  readonly repoRoot?: string | undefined;
  readonly force?: boolean | undefined;
}

export interface DesignAuditInitResult {
  readonly ok: boolean;
  readonly planPath: string;
  readonly plan: DesignAuditPlan;
  readonly rendered: string;
}

export interface DesignAuditRunOptions {
  readonly url?: string | undefined;
  readonly planPath?: string | undefined;
  readonly outDir?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly archetype?: DesignAuditArchetypeId | undefined;
  readonly routes?: readonly string[] | undefined;
  readonly themes?: readonly DesignAuditTheme[] | undefined;
  readonly states?: readonly DesignAuditUiState[] | undefined;
  readonly tokenPaths?: readonly string[] | undefined;
  readonly cssPaths?: readonly string[] | undefined;
  readonly baselinePath?: string | undefined;
  readonly staticOnly?: boolean | undefined;
  readonly failOnError?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly browserFactory?: DesignAuditBrowserFactory | undefined;
  readonly loadingDelayMs?: number | undefined;
  readonly withTempAuth?: boolean | undefined;
  readonly authCookie?: string | undefined;
  readonly inviteToken?: string | undefined;
  readonly authHeaders?: Readonly<Record<string, string>> | undefined;
  readonly autoRoutes?: boolean | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly execWrangler?: WranglerExecutor | undefined;
  readonly backupTokenLabel?: string | undefined;
}

export interface DesignAuditRunResult {
  readonly ok: boolean;
  readonly runId: string;
  readonly mode: DesignAuditPlan['mode'];
  readonly deterministicRuntime: boolean;
  readonly coverage: 'full' | 'partial';
  readonly bundleDir: string;
  readonly manifestPath: string;
  readonly sarifPath: string;
  readonly dossierPath: string;
  readonly captureCount: number;
  readonly cssStats: DesignAuditCssResult['cssStats'];
  readonly summary: DesignAuditSarifSummary;
  readonly degradedReason?: string;
  readonly discoveredRoutes?: readonly string[] | undefined;
  readonly rendered: string;
}

function defaultRunId(): string {
  return `audit-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
}

export function initDesignAuditPlan(
  options: DesignAuditInitOptions & { readonly json?: boolean }
): DesignAuditInitResult {
  const planPath = path.resolve(options.outPath);
  if (fs.existsSync(planPath) && !options.force) {
    throw new CliValidationError(`Plan file already exists: ${planPath}. Pass --force to overwrite.`);
  }
  const arch = resolveDesignAuditArchetype(options.archetype ?? 'editorial');
  const routes = (options.routes && options.routes.length > 0 ? options.routes : ['/']).map((routePath) => ({
    path: routePath.startsWith('/') ? routePath : `/${routePath}`,
    archetype: arch.id,
    uiStates: ['ideal'] as readonly DesignAuditUiState[],
  }));

  const plan: DesignAuditPlan = {
    runId: defaultRunId(),
    baseUrl: options.baseUrl ?? 'http://127.0.0.1:4173',
    mode: 'audit-only',
    repoRoot: options.repoRoot ?? '.',
    fixedIsoTime: '2026-01-15T12:00:00.000Z',
    themes: ['light', 'dark'],
    tokenPaths: [],
    routes,
  };

  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  const rendered = options.json
    ? JSON.stringify({ ok: true, planPath, plan }, null, 2)
    : `Created design-audit plan: ${planPath}\nArchetype: ${arch.id} (${arch.label})\nRoutes: ${routes.map((r) => r.path).join(', ')}`;

  return { ok: true, planPath, plan, rendered };
}

export function formatDesignAuditTextReport(result: Omit<DesignAuditRunResult, 'rendered'>): string {
  const lines: string[] = [
    `Design Audit (${result.runId})`,
    `Mode: ${result.mode} | Runtime: ${result.deterministicRuntime ? 'live-playwright' : 'static-degraded'} | Coverage: ${result.coverage}`,
    `Bundle: ${result.bundleDir}`,
    `Captures: ${result.captureCount}`,
  ];
  if (result.discoveredRoutes && result.discoveredRoutes.length > 0) {
    lines.push(`Routes: ${result.discoveredRoutes.join(', ')}`);
  }
  if (result.degradedReason) {
    lines.push(`Note: Degraded to static-only mode (${result.degradedReason})`);
  }
  if (result.cssStats) {
    lines.push(
      `CSS/Tokens: ${result.cssStats.scannedCssFiles} stylesheets, ${result.cssStats.scannedTokenFiles} DTCG files, ${result.cssStats.uniqueColors} unique colors, ${result.cssStats.uniqueFontSizes} unique font sizes, ${result.cssStats.importants} !important`
    );
  }
  lines.push(
    `Findings: ${result.summary.totalFindings} total (${result.summary.blockingErrors} blocking errors, ${result.summary.warnings} warnings, ${result.summary.notes} notes, ${result.summary.newBlockingRegressions} new regressions)`,
    `SARIF 2.1.0: ${result.sarifPath}`,
    `Dossier:     ${result.dossierPath}`
  );
  return lines.join('\n');
}

function assertValidDesignAuditAuthOptions(options: {
  readonly withTempAuth?: boolean | undefined;
  readonly authCookie?: string | undefined;
  readonly inviteToken?: string | undefined;
}): void {
  const hasTempAuth = Boolean(options.withTempAuth);
  const hasCookie = Boolean(options.authCookie?.trim());
  const hasInvite = Boolean(options.inviteToken?.trim());
  const count = Number(hasTempAuth) + Number(hasCookie) + Number(hasInvite);
  if (count > 1) {
    throw new CliValidationError(
      'Specify at most one of `--auth-cookie`, `--invite-token`, or `--with-temp-auth`.'
    );
  }
  if (options.inviteToken !== undefined) {
    if (/[\r\n]/.test(options.inviteToken)) {
      throw new CliValidationError('Option `--invite-token` must not contain CR or LF characters.');
    }
    if (!options.inviteToken.trim()) {
      throw new CliValidationError('Option `--invite-token` must not be empty.');
    }
  }
}

function resolveTargetBaseUrlFromPlan(planPath: string): string {
  const resolvedPlan = path.resolve(planPath);
  if (!fs.existsSync(resolvedPlan)) {
    throw new CliValidationError(`Design-audit plan file not found: ${resolvedPlan}`);
  }
  const planData = JSON.parse(fs.readFileSync(resolvedPlan, 'utf8')) as DesignAuditPlan;
  return planData.baseUrl;
}

export async function runDesignAuditCommand(options: DesignAuditRunOptions): Promise<DesignAuditRunResult> {
  assertValidDesignAuditAuthOptions(options);

  if (options.withTempAuth && !options.staticOnly) {
    const repoDir = path.resolve(options.repoRoot ?? process.cwd());
    const { value } = await withEphemeralD1Auth(
      {
        repoDir,
        urlOverride: options.url,
        mintInvite: true,
        inviteLabel: 'tmp-kinloom-design-audit-invite',
        createdBy: 'kinloom design-audit',
        execWrangler: options.execWrangler,
        backupTokenLabel: options.backupTokenLabel,
      },
      async (auth) => {
        const resolvedUrl = options.url?.trim() || auth.baseUrl || '';
        if (!resolvedUrl && !options.planPath) {
          throw new CliValidationError(
            'Missing target URL. Pass `--url <baseUrl>` or configure `routes[0].pattern` in wrangler config.'
          );
        }
        if (!auth.invite) {
          throw new Error('Ephemeral D1 auth did not mint a viewer invite.');
        }
        const targetBaseUrl =
          resolvedUrl || (options.planPath ? resolveTargetBaseUrlFromPlan(options.planPath) : '');
        const sessionCookie = await redeemEphemeralInviteSession({
          baseUrl: targetBaseUrl,
          inviteToken: auth.invite.token,
          fetchImpl: options.fetchImpl,
        });
        return executeDesignAuditCommand({
          ...options,
          ...(resolvedUrl ? { url: resolvedUrl } : {}),
          authCookie: sessionCookie,
          inviteToken: undefined,
          withTempAuth: false,
        });
      }
    );
    return value;
  }

  const trimmedInvite = options.inviteToken?.trim();
  if (trimmedInvite && !options.staticOnly) {
    const targetBaseUrl =
      options.url?.trim() || (options.planPath ? resolveTargetBaseUrlFromPlan(options.planPath) : '');
    if (!targetBaseUrl) {
      throw new CliValidationError(
        'Option `--invite-token` requires `--url <baseUrl>` or `--plan <path>` with a baseUrl.'
      );
    }
    const sessionCookie = await redeemEphemeralInviteSession({
      baseUrl: targetBaseUrl,
      inviteToken: trimmedInvite,
      fetchImpl: options.fetchImpl,
    });
    return executeDesignAuditCommand({
      ...options,
      authCookie: sessionCookie,
      inviteToken: undefined,
    });
  }

  return executeDesignAuditCommand(options);
}

async function executeDesignAuditCommand(options: DesignAuditRunOptions): Promise<DesignAuditRunResult> {
  let plan: DesignAuditPlan;
  let bundleDir: string;
  let discoveredRoutes: readonly string[] | undefined;

  if (options.planPath) {
    const resolvedPlan = path.resolve(options.planPath);
    if (!fs.existsSync(resolvedPlan)) {
      throw new CliValidationError(`Design-audit plan file not found: ${resolvedPlan}`);
    }
    plan = JSON.parse(fs.readFileSync(resolvedPlan, 'utf8')) as DesignAuditPlan;
    bundleDir = options.outDir ? path.resolve(options.outDir) : path.dirname(resolvedPlan);
    if (options.autoRoutes && !options.staticOnly && plan.baseUrl) {
      const auto = await discoverDesignAuditAutoRoutes({
        baseUrl: plan.baseUrl,
        explicitRoutes: plan.routes.map((r) => r.path),
        authCookie: options.authCookie,
        authHeaders: options.authHeaders,
        fetchImpl: options.fetchImpl,
      });
      discoveredRoutes = auto.routes;
      const defaultArchetype = options.archetype ?? plan.routes[0]?.archetype ?? 'editorial';
      const defaultStates = options.states ?? plan.routes[0]?.uiStates ?? (['ideal'] as const);
      const existingByPath = new Map(plan.routes.map((r) => [r.path, r]));
      plan = {
        ...plan,
        routes: auto.routes.map(
          (routePath) =>
            existingByPath.get(routePath) ?? {
              path: routePath,
              archetype: defaultArchetype,
              uiStates: defaultStates,
            }
        ),
      };
    }
  } else {
    const arch = resolveDesignAuditArchetype(options.archetype ?? 'editorial');
    const runId = defaultRunId();
    let routePaths: readonly string[] =
      options.routes && options.routes.length > 0 ? mergeUniqueRoutes(options.routes) : ['/'];
    if (options.autoRoutes && !options.staticOnly && options.url) {
      const auto = await discoverDesignAuditAutoRoutes({
        baseUrl: options.url,
        explicitRoutes: options.routes,
        authCookie: options.authCookie,
        authHeaders: options.authHeaders,
        fetchImpl: options.fetchImpl,
      });
      routePaths = auto.routes;
      discoveredRoutes = auto.routes;
    }
    const routes = routePaths.map((routePath) => ({
      path: routePath.startsWith('/') ? routePath : `/${routePath}`,
      archetype: arch.id,
      uiStates: options.states && options.states.length > 0 ? options.states : (['ideal'] as const),
    }));
    plan = {
      runId,
      baseUrl: options.url ?? 'http://127.0.0.1:4173',
      mode: options.staticOnly || !options.url ? 'static-degraded' : 'audit-only',
      repoRoot: options.repoRoot ?? process.cwd(),
      fixedIsoTime: '2026-01-15T12:00:00.000Z',
      themes: options.themes && options.themes.length > 0 ? options.themes : ['light', 'dark'],
      tokenPaths: options.tokenPaths ?? [],
      cssPaths: options.cssPaths ?? [],
      routes,
    };
    bundleDir = path.resolve(options.outDir ?? path.join('.audit-artifacts', runId));
  }

  fs.mkdirSync(bundleDir, { recursive: true });
  fs.writeFileSync(path.join(bundleDir, 'plan.json'), JSON.stringify(plan, null, 2));

  let manifest: DesignAuditManifest;
  let degradedReason: string | undefined;

  if (options.staticOnly || (!options.url && !options.planPath)) {
    degradedReason = options.staticOnly
      ? '--static-only requested'
      : 'no --url provided; running static CSS & DTCG token checks';
    manifest = {
      runId: plan.runId,
      sealedAtUtc: new Date().toISOString(),
      baseUrl: plan.baseUrl,
      mode: 'static-degraded',
      deterministicRuntime: false,
      coverage: 'partial',
      captureCount: 0,
      cssFiles: [],
      captures: [],
    };
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  } else {
    try {
      manifest = await runDesignAuditCaptureMatrix({
        plan,
        bundleDir,
        browserFactory: options.browserFactory,
        loadingDelayMs: options.loadingDelayMs,
        authCookie: options.authCookie,
        authHeaders: options.authHeaders,
        autoDiscoverPluginRoutes: options.autoRoutes,
      });
      if (options.autoRoutes) {
        const capturedRoutes = mergeUniqueRoutes(
          discoveredRoutes,
          manifest.captures.map((cap) => cap.route)
        );
        discoveredRoutes = capturedRoutes;
      }
    } catch (err: unknown) {
      degradedReason = err instanceof Error ? err.message : String(err);
      manifest = {
        runId: plan.runId,
        sealedAtUtc: new Date().toISOString(),
        baseUrl: plan.baseUrl,
        mode: 'static-degraded',
        deterministicRuntime: false,
        coverage: 'partial',
        captureCount: 0,
        cssFiles: [],
        captures: [],
      };
      fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
  }

  if (manifest.deterministicRuntime) {
    evaluateBundleDeterministic(manifest, bundleDir);
  }

  const cssResult = auditTokensAndCss({
    bundleDir,
    repoRoot: options.repoRoot ?? plan.repoRoot,
    archetype: options.archetype ?? plan.routes[0]?.archetype ?? 'editorial',
    cssPaths: options.cssPaths ?? plan.cssPaths,
    tokenPaths: options.tokenPaths ?? plan.tokenPaths,
    writeOutput: true,
  });

  const summary = emitSarifAndDossier({
    bundleDir,
    baselinePath: options.baselinePath,
  });

  const ok = options.failOnError ? summary.blockingErrors === 0 : true;
  const baseResult: Omit<DesignAuditRunResult, 'rendered'> = {
    ok,
    runId: manifest.runId,
    mode: manifest.mode,
    deterministicRuntime: manifest.deterministicRuntime,
    coverage: manifest.coverage,
    bundleDir,
    manifestPath: path.join(bundleDir, 'manifest.json'),
    sarifPath: summary.sarifPath,
    dossierPath: summary.dossierPath,
    captureCount: manifest.captureCount,
    cssStats: cssResult.cssStats,
    summary,
    ...(degradedReason ? { degradedReason } : {}),
    ...(discoveredRoutes ? { discoveredRoutes } : {}),
  };

  const rendered = options.json
    ? JSON.stringify(baseResult, null, 2)
    : formatDesignAuditTextReport(baseResult);

  return { ...baseResult, rendered };
}

export function formatArchetypesOutput(archetype: string | undefined, json: boolean): string {
  if (archetype) {
    const spec = resolveDesignAuditArchetype(archetype);
    if (json) {
      return JSON.stringify({ archetype: spec, invariants: DESIGN_AUDIT_INVARIANTS }, null, 2);
    }
    return [
      `${spec.id} — ${spec.label}`,
      spec.description,
      `Viewports: ${spec.viewports.map((v) => `${v.name} (${v.width}x${v.height})`).join(', ')}`,
      `Caps: maxNav=${spec.metrics.maxTopLevelNavLinks}, maxFirstContentY=${spec.metrics.maxFirstContentYPx}px, maxColors=${spec.metrics.maxUniqueColors}, maxFontSizes=${spec.metrics.maxUniqueFontSizes}, touchTarget=${spec.metrics.touchTargetRecommendedPx}px`,
    ].join('\n');
  }
  if (json) {
    return JSON.stringify(
      {
        version: DESIGN_AUDIT_STANDARDS.version,
        invariants: DESIGN_AUDIT_INVARIANTS,
        archetypes: DESIGN_AUDIT_ARCHETYPES,
      },
      null,
      2
    );
  }
  return Object.values(DESIGN_AUDIT_ARCHETYPES)
    .map(
      (spec) =>
        `${spec.id.padEnd(12)} ${spec.label} (nav<=${spec.metrics.maxTopLevelNavLinks}, colors<=${spec.metrics.maxUniqueColors}, fontSizes<=${spec.metrics.maxUniqueFontSizes}, touch>=${spec.metrics.touchTargetRecommendedPx}px)`
    )
    .join('\n');
}

export function formatStandardsOutput(json: boolean): string {
  if (json) {
    return JSON.stringify({ ok: true, ...DESIGN_AUDIT_STANDARDS }, null, 2);
  }
  const lines = [
    `Design Audit Standards Pin (v${DESIGN_AUDIT_STANDARDS.version})`,
    `Network Fetch Policy: ${DESIGN_AUDIT_STANDARDS.networkFetchPolicy}`,
  ];
  for (const [k, v] of Object.entries(DESIGN_AUDIT_STANDARDS.standards)) {
    lines.push(`  ${k.padEnd(15)} ${v}`);
  }
  return lines.join('\n');
}
