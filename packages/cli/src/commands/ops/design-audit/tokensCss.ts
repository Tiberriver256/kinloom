import fs from 'node:fs';
import path from 'node:path';
import { resolveDesignAuditArchetype } from './archetypes.js';
import type {
  DesignAuditArchetypeId,
  DesignAuditCssResult,
  DesignAuditCssStats,
  DesignAuditFinding,
  DesignAuditManifest,
  DesignAuditPlan,
} from './types.js';

const COLOR_VALUE_RE =
  /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b|(?:rgba?|hsla?|oklch|oklab)\([^)]+\)/gi;
const FONT_SIZE_DECL_RE = /font-size\s*:\s*([^;}{]+?)(?:\s*!important)?\s*(?:;|(?=\}))/gi;
const IMPORTANT_RE = /!important\b/gi;
const RULE_BLOCK_RE = /[^{}@][^{}]*\{[^{}]*\}/g;
const DECLARATION_RE = /(?:^|[;{\s])([a-zA-Z_-][a-zA-Z0-9_-]*)\s*:\s*([^;{}]+)/g;
const ALIAS_RE = /^\{([^}]+)\}$/;
const MODE_BAKED_RE = /(^|[.-])(dark|light|high-contrast|compact)($|[.-])/i;

interface TokenEntry {
  readonly $value?: unknown;
}

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function analyzeCssMetrics(
  cssText: string,
  scannedCssFiles = 1,
  scannedTokenFiles = 0
): DesignAuditCssStats {
  const cleaned = stripCssComments(cssText);
  const colors = new Set<string>();
  const fontSizes = new Set<string>();

  for (const match of cleaned.matchAll(COLOR_VALUE_RE)) {
    colors.add(match[0].toLowerCase().replace(/\s+/g, ' ').trim());
  }

  for (const match of cleaned.matchAll(FONT_SIZE_DECL_RE)) {
    const val = (match[1] ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (val && !['inherit', 'initial', 'unset'].includes(val)) {
      fontSizes.add(val);
    }
  }

  let importants = 0;
  for (const _ of cleaned.matchAll(IMPORTANT_RE)) {
    importants += 1;
  }

  let rules = 0;
  for (const _ of cleaned.matchAll(RULE_BLOCK_RE)) {
    rules += 1;
  }

  let declarations = 0;
  for (const _ of cleaned.matchAll(DECLARATION_RE)) {
    declarations += 1;
  }

  return {
    rules,
    declarations,
    uniqueColors: colors.size,
    uniqueFontSizes: fontSizes.size,
    importants,
    scannedCssFiles,
    scannedTokenFiles,
  };
}

function walkTokens(
  obj: unknown,
  prefix: readonly string[] = [],
  out: Map<string, TokenEntry> = new Map()
): Map<string, TokenEntry> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return out;
  }
  const rec = obj as Record<string, unknown>;
  if ('$value' in rec) {
    out.set(prefix.join('.'), rec as TokenEntry);
    return out;
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('$')) {
      continue;
    }
    walkTokens(v, [...prefix, k], out);
  }
  return out;
}

export function detectTokenAliasCycles(tokenMap: ReadonlyMap<string, TokenEntry>): string[] {
  const cycles: string[] = [];
  for (const key of tokenMap.keys()) {
    const visited = new Set<string>([key]);
    let current = tokenMap.get(key)?.$value;
    while (typeof current === 'string') {
      const match = current.trim().match(ALIAS_RE);
      if (!match) {
        break;
      }
      const target = match[1];
      if (target === undefined) break;
      if (visited.has(target)) {
        cycles.push([...visited, target].join(' -> '));
        break;
      }
      visited.add(target);
      current = tokenMap.get(target)?.$value;
    }
  }
  return cycles;
}

export function auditDtcgTokenFile(filePath: string, findings: DesignAuditFinding[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    findings.push({
      ruleId: 'DA-06-DTCG-INVALID-JSON',
      metricId: '06',
      pillar: 'II',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: 'static',
      viewport: 'static',
      theme: 'all',
      uiState: 'static',
      message: `Invalid JSON in DTCG token file ${filePath}: ${message}`,
      physicalLocation: { uri: filePath, startLine: 1 },
      evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
      masterCitations: ['Nathan Curtis — Tokens in Design Systems', 'W3C DTCG 2025.10'],
      remediationHint: 'Fix JSON syntax error in the DTCG file.',
    });
    return;
  }

  if (filePath.endsWith('.resolver.json')) {
    const rec = parsed as Record<string, unknown> | null;
    if (!rec || !Array.isArray(rec['resolutionOrder'])) {
      findings.push({
        ruleId: 'DA-06-DTCG-RESOLVER-ORDER',
        metricId: '06',
        pillar: 'II',
        provenance: 'deterministic',
        severity: 'error',
        confidence: 1.0,
        route: 'static',
        viewport: 'static',
        theme: 'all',
        uiState: 'static',
        message: `DTCG Resolver ${filePath} is missing required "resolutionOrder" array.`,
        physicalLocation: { uri: filePath, startLine: 1 },
        evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
        masterCitations: ['Nathan Curtis — Naming Tokens', 'W3C DTCG 2025.10 Resolver'],
        remediationHint: 'Declare explicit sets and mode modifiers inside resolutionOrder.',
      });
    }
    return;
  }

  const tokens = walkTokens(parsed);
  for (const cycle of detectTokenAliasCycles(tokens)) {
    findings.push({
      ruleId: 'DA-06-DTCG-CIRCULAR-ALIAS',
      metricId: '06',
      pillar: 'II',
      provenance: 'deterministic',
      severity: 'error',
      confidence: 1.0,
      route: 'static',
      viewport: 'static',
      theme: 'all',
      uiState: 'static',
      message: `Circular DTCG token alias detected: ${cycle}`,
      physicalLocation: { uri: filePath, startLine: 1 },
      evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
      masterCitations: ['Nathan Curtis — Tokens in Design Systems', 'W3C DTCG 2025.10'],
      remediationHint: 'Break the alias cycle so semantic tokens reference primitive options only.',
    });
  }

  const modeBaked = [...tokens.keys()].filter((name) => MODE_BAKED_RE.test(name));
  if (modeBaked.length > 0) {
    findings.push({
      ruleId: 'DA-06-DTCG-MODE-NOT-ORTHOGONAL',
      metricId: '06',
      pillar: 'II',
      provenance: 'deterministic',
      severity: 'warning',
      confidence: 1.0,
      route: 'static',
      viewport: 'static',
      theme: 'all',
      uiState: 'static',
      message: `${modeBaked.length} tokens encode mode names directly (sample: "${modeBaked[0]}") instead of keeping modes orthogonal in a DTCG Resolver.`,
      measuredValue: modeBaked.length,
      thresholdValue: 0,
      physicalLocation: { uri: filePath, startLine: 1 },
      evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
      masterCitations: ['Nathan Curtis — Naming Tokens in Design Systems', 'W3C DTCG 2025.10'],
      remediationHint: 'Move light/dark/density variations into .resolver.json modifiers.',
    });
  }
}

export function discoverRepoStyleFiles(repoRoot: string): {
  readonly cssPaths: readonly string[];
  readonly tokenPaths: readonly string[];
} {
  const cssPaths: string[] = [];
  const tokenPaths: string[] = [];
  const skipDirs = new Set([
    'node_modules',
    'dist',
    '.git',
    '.audit-artifacts',
    'coverage',
    'playwright-report',
    'test-results',
  ]);

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || !fs.existsSync(dir)) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.css')) {
          cssPaths.push(full);
        } else if (entry.name.endsWith('.tokens.json') || entry.name.endsWith('.resolver.json')) {
          tokenPaths.push(full);
        }
      }
    }
  };

  walk(repoRoot, 0);
  cssPaths.sort();
  tokenPaths.sort();
  return { cssPaths, tokenPaths };
}

export function auditTokensAndCss(options: {
  readonly bundleDir?: string | undefined;
  readonly repoRoot?: string | undefined;
  readonly archetype?: DesignAuditArchetypeId | undefined;
  readonly cssPaths?: readonly string[] | undefined;
  readonly tokenPaths?: readonly string[] | undefined;
  readonly writeOutput?: boolean;
}): DesignAuditCssResult {
  const findings: DesignAuditFinding[] = [];
  let combinedCss = '';
  let scannedCssFiles = 0;
  let scannedTokenFiles = 0;
  let archetypeKey: DesignAuditArchetypeId = options.archetype ?? 'editorial';

  const bundleDir = options.bundleDir ? path.resolve(options.bundleDir) : undefined;
  const manifestPath = bundleDir ? path.join(bundleDir, 'manifest.json') : undefined;
  const planPath = bundleDir ? path.join(bundleDir, 'plan.json') : undefined;

  if (manifestPath && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as DesignAuditManifest;
    if (!options.archetype && manifest.captures[0]?.archetype) {
      archetypeKey = manifest.captures[0].archetype;
    }
    for (const relCss of manifest.cssFiles) {
      const p = path.join(bundleDir as string, relCss);
      if (fs.existsSync(p)) {
        combinedCss += `\n${fs.readFileSync(p, 'utf8')}`;
        scannedCssFiles += 1;
      }
    }
  }

  let planTokenPaths: readonly string[] = [];
  let planCssPaths: readonly string[] = [];
  let resolvedRepoRoot = options.repoRoot ? path.resolve(options.repoRoot) : undefined;

  if (planPath && fs.existsSync(planPath)) {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as DesignAuditPlan;
    if (!resolvedRepoRoot && plan.repoRoot) {
      resolvedRepoRoot = path.resolve(plan.repoRoot);
    }
    planTokenPaths = plan.tokenPaths ?? [];
    planCssPaths = plan.cssPaths ?? [];
  }

  const explicitCss = options.cssPaths ?? planCssPaths;
  const explicitTokens = options.tokenPaths ?? planTokenPaths;

  const discovered =
    resolvedRepoRoot && explicitCss.length === 0 && explicitTokens.length === 0 && scannedCssFiles === 0
      ? discoverRepoStyleFiles(resolvedRepoRoot)
      : { cssPaths: [] as string[], tokenPaths: [] as string[] };

  const cssToRead =
    explicitCss.length > 0
      ? explicitCss.map((p) => path.resolve(resolvedRepoRoot ?? process.cwd(), p))
      : discovered.cssPaths;

  for (const cssFile of cssToRead) {
    if (fs.existsSync(cssFile)) {
      combinedCss += `\n${fs.readFileSync(cssFile, 'utf8')}`;
      scannedCssFiles += 1;
    }
  }

  const tokensToRead =
    explicitTokens.length > 0
      ? explicitTokens.map((p) => path.resolve(resolvedRepoRoot ?? process.cwd(), p))
      : discovered.tokenPaths;

  for (const tokenFile of tokensToRead) {
    if (fs.existsSync(tokenFile)) {
      auditDtcgTokenFile(tokenFile, findings);
      scannedTokenFiles += 1;
    }
  }

  let cssStats: DesignAuditCssStats | null = null;
  if (combinedCss.trim().length > 0) {
    const archSpec = resolveDesignAuditArchetype(archetypeKey);
    cssStats = analyzeCssMetrics(combinedCss, scannedCssFiles, scannedTokenFiles);

    if (cssStats.uniqueColors > archSpec.metrics.maxUniqueColors) {
      findings.push({
        ruleId: 'DA-06-COLOR-ENTROPY',
        metricId: '06',
        pillar: 'II',
        provenance: 'deterministic',
        severity: 'warning',
        confidence: 1.0,
        route: 'static',
        viewport: 'static',
        theme: 'all',
        uiState: 'static',
        message: `Stylesheets define ${cssStats.uniqueColors} unique colors, exceeding the ${archetypeKey} archetype cap of ${archSpec.metrics.maxUniqueColors}.`,
        measuredValue: cssStats.uniqueColors,
        thresholdValue: archSpec.metrics.maxUniqueColors,
        evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
        masterCitations: [
          'Nathan Curtis — Tokens in Design Systems',
          'Steve Schoger & Adam Wathan — Refactoring UI',
        ],
        remediationHint: 'Consolidate near-duplicate hex/rgb literals into semantic color tokens.',
      });
    }

    if (cssStats.uniqueFontSizes > archSpec.metrics.maxUniqueFontSizes) {
      findings.push({
        ruleId: 'DA-05-FONT-SIZE-ENTROPY',
        metricId: '05',
        pillar: 'II',
        provenance: 'deterministic',
        severity: 'warning',
        confidence: 1.0,
        route: 'static',
        viewport: 'static',
        theme: 'all',
        uiState: 'static',
        message: `Stylesheets declare ${cssStats.uniqueFontSizes} unique font sizes, exceeding the modular scale cap of ${archSpec.metrics.maxUniqueFontSizes}.`,
        measuredValue: cssStats.uniqueFontSizes,
        thresholdValue: archSpec.metrics.maxUniqueFontSizes,
        evidence: { screenshotUri: 'static', pairwiseVerdict: 'n/a' },
        masterCitations: [
          'Robert Bringhurst — The Elements of Typographic Style',
          'Matthew Butterick — Practical Typography',
        ],
        remediationHint: 'Snap ad-hoc pixel sizes onto a bounded modular typographic scale.',
      });
    }
  }

  let outputPath: string | undefined;
  if (bundleDir && options.writeOutput !== false) {
    fs.mkdirSync(bundleDir, { recursive: true });
    outputPath = path.join(bundleDir, 'track-a-css-tokens.json');
    fs.writeFileSync(outputPath, JSON.stringify({ cssStats, findings }, null, 2));
  }

  return {
    ok: findings.every((f) => f.severity !== 'error'),
    archetype: archetypeKey,
    cssStats,
    findings,
    outputPath,
  };
}
