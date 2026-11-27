import type { AuditCommandResult } from './types.js';

export function formatAuditTextReport(report: Omit<AuditCommandResult, 'rendered'>): string {
  const lines: string[] = [];
  const status = report.ok ? 'PASS' : 'FAIL';
  lines.push(`Audit [${status}] ${report.person_id} (${report.duration_ms} ms)`);
  lines.push(`  Repo: ${report.repo}`);
  lines.push(
    `  1. Chronology: ${report.checks.chronology.ok ? 'PASS' : 'FAIL'} | ` +
      `${report.checks.chronology.birth_edtf ?? '?'} .. ${report.checks.chronology.death_edtf ?? '?'} ` +
      `(${report.checks.chronology.lifespan.label ?? 'unknown'}) | ` +
      `events=${report.checks.chronology.checkedEvents} errors=${report.checks.chronology.errors.length} warnings=${report.checks.chronology.warnings.length}`
  );
  lines.push(
    `  2. Privacy/Style: ${report.checks.privacy.ok ? 'PASS' : 'FAIL'} | ` +
      `livingHits=${report.checks.privacy.livingNameHits.length} ssn=${report.checks.privacy.ssnHits.length} ` +
      `phones=${report.checks.privacy.phoneHits.length} emDashes=${report.checks.privacy.emDashCount}`
  );
  lines.push(
    `  3. Citations: ${report.checks.citations.ok ? 'PASS' : 'WARN'} | ` +
      `cited=${report.checks.citations.citedSentences}/${report.checks.citations.totalSentences} ` +
      `uncited=${report.checks.citations.uncitedCount} inlineTokens=${report.checks.dryRun.inlineCitationCount}`
  );
  lines.push(
    `  4. Scans: ${report.checks.scans.ok ? 'PASS' : 'FAIL'} | ` +
      `checked=${report.checks.scans.checkedCount} errors=${report.checks.scans.errors.length} warnings=${report.checks.scans.warnings.length}`
  );
  lines.push(
    `  5. Dry-Run: ${report.checks.dryRun.ok ? 'PASS' : 'FAIL'} (${report.checks.dryRun.durationMs} ms) | ` +
      `reviewFlags=${report.checks.dryRun.reviewFlags} livingLeaks=${report.checks.dryRun.livingLeaks} zeroCoordPlaces=${report.zeroCoordinatePlaces.length}`
  );
  const pron = report.checks.pronunciation;
  const pronStatus = !pron.ok ? 'FAIL' : pron.warnings.length > 0 ? 'WARN' : 'PASS';
  lines.push(
    `  6. Pronunciation: ${pronStatus} (${pron.durationMs} ms) | errors=${pron.errors.length} warnings=${pron.warnings.length}`
  );
  for (const pc of report.pluginChecks) {
    const pcStatus = !pc.ok ? 'FAIL' : pc.warnings.length > 0 || !pc.strictOk ? 'WARN' : 'PASS';
    lines.push(
      `  Plugin [${pc.pluginId}/${pc.id}] ${pc.name}: ${pcStatus} (${pc.durationMs} ms) | errors=${pc.errors.length} warnings=${pc.warnings.length}`
    );
  }
  for (const err of report.errors) {
    lines.push(`  ERROR: ${err}`);
  }
  for (const warn of report.warnings) {
    lines.push(`  WARN: ${warn}`);
  }
  return `${lines.join('\n')}\n`;
}
