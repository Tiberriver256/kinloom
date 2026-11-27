import type { ExecutedPluginCheckResult } from '../../../plugins.js';
import { TREE_HYGIENE_CATEGORIES, type TreeHygieneSummary } from '../tree-hygiene.js';
import type {
  VerifyCitationsResult,
  VerifyCommandResult,
  VerifyCompileResult,
  VerifyLivingNamesResult,
  VerifyMediaResult,
  VerifyPlacesResult,
  VerifySsnResult,
} from './types.js';

export function collectVerifyDiagnostics(input: {
  citations: VerifyCitationsResult;
  places: VerifyPlacesResult;
  ssn: VerifySsnResult;
  compile: VerifyCompileResult;
  media: VerifyMediaResult;
  livingNames: VerifyLivingNamesResult;
  hygiene: TreeHygieneSummary;
  pronunciation: ExecutedPluginCheckResult;
  pluginDiscoveryWarnings: readonly string[];
  pluginChecks: readonly ExecutedPluginCheckResult[];
  strictHygiene: boolean;
  strictPronunciation: boolean;
}): { warnings: string[]; errors: string[] } {
  const warnings = [
    ...input.hygiene.warnings.map((warning) => `[${warning.category}] ${warning.message}`),
    ...input.pronunciation.warnings.map((w) => `[pronunciation] ${w}`),
    ...input.pluginDiscoveryWarnings.map((w) => `[plugin] ${w}`),
    ...input.pluginChecks.flatMap((pc) => pc.warnings.map((w) => `[plugin:${pc.id}] ${w}`)),
  ];

  const errors: string[] = [
    ...input.citations.errors.map((e) => `citations: ${e}`),
    ...input.places.invalidPlaces.map((p) => `places: '${p.id}' ${p.reason}`),
    ...input.ssn.hits.map((h) => `ssn: ${h.file}:${h.line} matched '${h.match}'`),
    ...input.compile.privateReviewFlags.map((f) => `compile(private): review flag: ${f}`),
    ...input.compile.publicReviewFlags.map((f) => `compile(public): review flag: ${f}`),
    ...input.compile.privateLivingLeaks.map((l) => `compile(private): living leak: ${l}`),
    ...input.compile.publicLivingLeaks.map((l) => `compile(public): living leak: ${l}`),
    ...input.compile.duplicateResidenceSpans.map((d) => `compile: duplicate residence_span: ${d}`),
    ...input.media.missingFiles.map((m) => `media: '${m.id}' (${m.file}) ${m.reason} at ${m.expectedPath}`),
    ...input.media.duplicateFiles.map(
      (dup) =>
        `media: duplicate file '${dup.file}' on ${dup.mediaIds.join(', ')}. Run 'kinloom media dedupe' to preview a safe merge plan (pass '--apply' to write).`
    ),
    ...input.livingNames.hits.map((hit) => `living-name: ${hit.location} matched '${hit.match}'`),
    ...input.pronunciation.errors.map((e) => `pronunciation: ${e}`),
    ...input.pluginChecks.flatMap((pc) => pc.errors.map((e) => `plugin(${pc.id}): ${e}`)),
    ...(input.strictHygiene
      ? input.hygiene.warnings.map((warning) => `hygiene(${warning.category}): ${warning.message}`)
      : []),
    ...(input.strictPronunciation
      ? input.pronunciation.strictFailures.map((f) => `pronunciation: ${f}`)
      : []),
    ...(input.strictHygiene || input.strictPronunciation
      ? input.pluginChecks.flatMap((pc) => pc.strictFailures.map((f) => `plugin(${pc.id}): ${f}`))
      : []),
  ];

  return { warnings, errors };
}

export function formatVerifyTextReport(report: Omit<VerifyCommandResult, 'rendered'>): string {
  const status = report.ok ? 'PASS' : 'FAIL';
  const hygieneWarningCount = report.hygiene.warnings.length;
  const hygieneStatus = hygieneWarningCount === 0 ? 'PASS' : report.strictHygiene ? 'FAIL' : 'WARN';
  const hygieneCountDetail = TREE_HYGIENE_CATEGORIES.filter((category) => report.hygiene.counts[category] > 0)
    .map((category) => `${category}=${report.hygiene.counts[category]}`)
    .join(', ');
  const hygieneSuffix = hygieneCountDetail ? ` (${hygieneCountDetail})` : '';

  const lines: string[] = [
    `Verify [${status}] ${report.repo} (${report.duration_ms} ms)`,
    `  1. Citations: ${report.checks.citations.ok ? 'PASS' : 'FAIL'} | narratives=${report.checks.citations.narrativesChecked} errors=${report.checks.citations.errors.length}`,
    `  2. Places: ${report.checks.places.ok ? 'PASS' : 'FAIL'} | checked=${report.checks.places.placesChecked} invalid=${report.checks.places.invalidPlaces.length}`,
    `  3. SSN scan: ${report.checks.ssn.ok ? 'PASS' : 'FAIL'} | files=${report.checks.ssn.filesScanned} hits=${report.checks.ssn.hits.length}`,
    `  4. Dual compile: ${report.checks.compile.ok ? 'PASS' : 'FAIL'} | private(people=${report.checks.compile.privateCounts.people}, events=${report.checks.compile.privateCounts.events}, spans=${report.checks.compile.privateCounts.residence_spans}, flags=${report.checks.compile.privateReviewFlags.length}, leaks=${report.checks.compile.privateLivingLeaks.length}) public(people=${report.checks.compile.publicCounts.people}, living_redacted=${report.checks.compile.publicCounts.living_redacted}, flags=${report.checks.compile.publicReviewFlags.length}, leaks=${report.checks.compile.publicLivingLeaks.length}) dupSpans=${report.checks.compile.duplicateResidenceSpans.length}`,
    `  5. Media disk: ${report.checks.media.ok ? 'PASS' : 'FAIL'} | layout=${report.checks.media.mediaLayout} checked=${report.checks.media.checkedCount} missing=${report.checks.media.missingFiles.length} duplicates=${report.checks.media.duplicateFiles.length}`,
    `  6. Living names: ${report.checks.livingNames.ok ? 'PASS' : 'FAIL'} | hits=${report.checks.livingNames.hits.length}`,
    `  7. Tree hygiene: ${hygieneStatus} | warnings=${hygieneWarningCount}${hygieneSuffix}`,
    `  8. Pronunciation: ${
      !report.checks.pronunciation.ok
        ? 'FAIL'
        : report.checks.pronunciation.warnings.length > 0
          ? report.strictPronunciation
            ? 'FAIL'
            : 'WARN'
          : 'PASS'
    } | errors=${report.checks.pronunciation.errors.length} warnings=${report.checks.pronunciation.warnings.length}`,
    ...report.pluginChecks.map((pc) => {
      const pcStatus = !pc.ok ? 'FAIL' : pc.warnings.length > 0 || !pc.strictOk ? 'WARN' : 'PASS';
      return `  Plugin [${pc.pluginId}/${pc.id}] ${pc.name}: ${pcStatus} (${pc.durationMs} ms) | errors=${pc.errors.length} warnings=${pc.warnings.length}`;
    }),
  ];

  for (const err of report.errors.slice(0, 30)) {
    lines.push(`  ERROR: ${err}`);
  }
  if (report.errors.length > 30) {
    lines.push(`  ... and ${report.errors.length - 30} more error(s).`);
  }

  const hygieneWarningsText = report.hygiene.warnings.map(
    (warning) => `[${warning.category}] ${warning.message}`
  );
  const nonHygieneWarnings = report.warnings.slice(hygieneWarningsText.length);

  if (hygieneWarningsText.length > 0) {
    lines.push(`Tree hygiene warnings (${hygieneWarningsText.length}):`);
    for (const warning of hygieneWarningsText.slice(0, 30)) {
      lines.push(`  WARN: ${warning}`);
    }
    if (hygieneWarningsText.length > 30) {
      lines.push(`  ... and ${hygieneWarningsText.length - 30} more warning(s).`);
    }
  }

  if (nonHygieneWarnings.length > 0) {
    lines.push(`Pronunciation & plugin warnings (${nonHygieneWarnings.length}):`);
    for (const warning of nonHygieneWarnings.slice(0, 30)) {
      lines.push(`  WARN: ${warning}`);
    }
    if (nonHygieneWarnings.length > 30) {
      lines.push(`  ... and ${nonHygieneWarnings.length - 30} more warning(s).`);
    }
  }

  return `${lines.join('\n')}\n`;
}
