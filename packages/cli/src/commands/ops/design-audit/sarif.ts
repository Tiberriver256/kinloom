import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  DesignAuditFinding,
  DesignAuditSarifSummary,
  SarifReport,
  SarifResult,
  SarifRule,
  SarifRun,
} from './types.js';

function readJsonIfExists<T>(filePath: string | undefined, fallback: T): T {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

export function fingerprintFinding(finding: DesignAuditFinding): string {
  const key = [
    finding.ruleId,
    finding.route,
    finding.theme,
    finding.uiState,
    finding.physicalLocation?.uri ?? '',
    finding.physicalLocation?.selector ?? '',
  ].join('|');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

export function dedupeFindings(allFindings: readonly DesignAuditFinding[]): DesignAuditFinding[] {
  const byKey = new Map<string, DesignAuditFinding>();
  for (const finding of allFindings) {
    const key = [
      finding.metricId,
      finding.route,
      finding.viewport,
      finding.theme,
      finding.uiState,
      finding.physicalLocation?.selector ?? finding.ruleId,
    ].join('|');
    const existing = byKey.get(key);
    // Deterministic probes always supersede VLM findings on the same target.
    if (!existing) {
      byKey.set(key, finding);
    } else if (existing.provenance !== 'deterministic' && finding.provenance === 'deterministic') {
      byKey.set(key, finding);
    }
  }
  return [...byKey.values()];
}

export function loadBaselineFingerprints(baselinePath: string | undefined): Set<string> {
  const set = new Set<string>();
  const base = readJsonIfExists<SarifReport | null>(baselinePath, null);
  if (!base?.runs) {
    return set;
  }
  for (const run of base.runs) {
    for (const result of run.results) {
      const fp = result.partialFingerprints.primaryLocationLineHash;
      if (fp) {
        set.add(fp);
      }
    }
  }
  return set;
}

function buildSarifRun(
  toolName: string,
  findings: readonly DesignAuditFinding[],
  baselineFps: ReadonlySet<string>
): SarifRun {
  const rulesMap = new Map<string, SarifRule>();
  const results: SarifResult[] = [];

  for (const finding of findings) {
    if (!rulesMap.has(finding.ruleId)) {
      rulesMap.set(finding.ruleId, {
        id: finding.ruleId,
        name: finding.ruleId,
        shortDescription: { text: `Design Audit Metric ${finding.metricId} (Pillar ${finding.pillar})` },
        properties: {
          metricId: finding.metricId,
          pillar: finding.pillar,
          masterCitations: finding.masterCitations,
        },
      });
    }

    const fp = fingerprintFinding(finding);
    const baselineState: 'new' | 'unchanged' =
      baselineFps.size === 0 ? 'new' : baselineFps.has(fp) ? 'unchanged' : 'new';

    results.push({
      ruleId: finding.ruleId,
      level: finding.severity,
      baselineState,
      message: { text: finding.message },
      partialFingerprints: {
        primaryLocationLineHash: fp,
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: finding.physicalLocation?.uri || finding.evidence.screenshotUri,
            },
            ...(finding.physicalLocation?.startLine
              ? { region: { startLine: finding.physicalLocation.startLine } }
              : {}),
          },
          logicalLocations: [
            {
              fullyQualifiedName: `${finding.route} [${finding.viewport} / ${finding.theme} / ${finding.uiState}]`,
              kind: 'route',
            },
          ],
        },
      ],
      properties: {
        provenance: finding.provenance,
        confidence: finding.confidence,
        measuredValue: finding.measuredValue ?? null,
        thresholdValue: finding.thresholdValue ?? null,
        evidence: finding.evidence,
        masterCitations: finding.masterCitations,
        remediationHint: finding.remediationHint ?? '',
      },
    });
  }

  return {
    tool: {
      driver: {
        name: toolName,
        version: '1.0.0',
        informationUri: 'https://github.com/Tiberriver256/kinloom',
        rules: [...rulesMap.values()],
      },
    },
    results: results.slice(0, 5000),
  };
}

export function buildSarifReport(
  findings: readonly DesignAuditFinding[],
  baselineFps: ReadonlySet<string>
): SarifReport {
  const detFindings = findings.filter((f) => f.provenance === 'deterministic');
  const vlmFindings = findings.filter((f) => f.provenance !== 'deterministic');

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      buildSarifRun('kinloom/design-audit/deterministic-probes', detFindings, baselineFps),
      buildSarifRun('kinloom/design-audit/reference-anchored-critics', vlmFindings, baselineFps),
    ],
  };
}

export function renderExecutiveDossier(
  runId: string,
  findings: readonly DesignAuditFinding[],
  sarif: SarifReport
): string {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  const notes = findings.filter((f) => f.severity === 'note');
  const newBlockers = sarif.runs
    .flatMap((r) => r.results)
    .filter((r) => r.level === 'error' && r.baselineState === 'new');

  const lines: string[] = [
    `# Design Audit Executive Dossier — ${runId}`,
    '',
    '## Scorecard Summary',
    '',
    '| Category | Count |',
    '| :--- | ---: |',
    `| Blocking Errors | ${errors.length} |`,
    `| New Regressions (Ratchet) | ${newBlockers.length} |`,
    `| Warnings | ${warnings.length} |`,
    `| Notes | ${notes.length} |`,
    `| Total Deduplicated Findings | ${findings.length} |`,
    '',
    '## Top Priority Defects',
    '',
  ];

  const top = [...errors, ...warnings].slice(0, 20);
  if (top.length === 0) {
    lines.push('No blocking errors or warnings were detected.');
  } else {
    for (const f of top) {
      lines.push(
        `- **[${f.severity.toUpperCase()}] ${f.ruleId}** (Metric ${f.metricId}, ${f.provenance}) — ${f.route} \`${f.viewport}\` \`${f.theme}\` \`${f.uiState}\`: ${f.message}`,
        `  - Evidence: \`${f.evidence.screenshotUri || 'n/a'}\` | Authorities: ${f.masterCitations.join('; ')}`,
        ...(f.remediationHint ? [`  - Fix: ${f.remediationHint}`] : [])
      );
    }
  }

  lines.push(
    '',
    '## Conformance Note',
    '',
    'APCA perceptual contrast checks use base algorithm 0.0.98G-4g-base-W3 as a public-beta WCAG 3 candidate paired with WCAG 2.2 AA/AAA verification.',
    ''
  );
  return lines.join('\n');
}

export function emitSarifAndDossier(options: {
  readonly bundleDir: string;
  readonly baselinePath?: string | undefined;
}): DesignAuditSarifSummary {
  const bundleDir = path.resolve(options.bundleDir);
  const manifest = readJsonIfExists<{ readonly runId?: string }>(path.join(bundleDir, 'manifest.json'), {
    runId: path.basename(bundleDir),
  });
  const runId = manifest.runId ?? path.basename(bundleDir);

  const det = readJsonIfExists<DesignAuditFinding[]>(path.join(bundleDir, 'track-a-deterministic.json'), []);
  const cssObj = readJsonIfExists<{ readonly findings?: DesignAuditFinding[] }>(
    path.join(bundleDir, 'track-a-css-tokens.json'),
    { findings: [] }
  );
  const clutterObj = readJsonIfExists<{ readonly findings?: DesignAuditFinding[] }>(
    path.join(bundleDir, 'track-a-clutter.json'),
    { findings: [] }
  );
  const trackB = readJsonIfExists<DesignAuditFinding[]>(path.join(bundleDir, 'track-b-findings.json'), []);
  const translated = readJsonIfExists<DesignAuditFinding[] | null>(
    path.join(bundleDir, 'phase-3b-findings.json'),
    null
  );

  const mergedRaw = translated ?? [
    ...det,
    ...(cssObj.findings ?? []),
    ...(clutterObj.findings ?? []),
    ...trackB,
  ];
  const deduped = dedupeFindings(mergedRaw);
  const baselineFps = loadBaselineFingerprints(options.baselinePath);
  const sarif = buildSarifReport(deduped, baselineFps);

  fs.mkdirSync(bundleDir, { recursive: true });
  const sarifPath = path.join(bundleDir, 'design-audit.sarif');
  const dossierPath = path.join(bundleDir, 'audit-dossier.md');
  fs.writeFileSync(sarifPath, JSON.stringify(sarif, null, 2));
  fs.writeFileSync(dossierPath, renderExecutiveDossier(runId, deduped, sarif), 'utf8');

  const blockingErrors = deduped.filter((f) => f.severity === 'error').length;
  const warnings = deduped.filter((f) => f.severity === 'warning').length;
  const notes = deduped.filter((f) => f.severity === 'note').length;
  const newBlockingRegressions = sarif.runs
    .flatMap((r) => r.results)
    .filter((r) => r.level === 'error' && r.baselineState === 'new').length;

  return {
    ok: blockingErrors === 0,
    sarifPath,
    dossierPath,
    totalFindings: deduped.length,
    blockingErrors,
    warnings,
    notes,
    newBlockingRegressions,
  };
}
