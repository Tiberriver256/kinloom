import type { MediaDedupeCommandResult } from './types.js';

export function formatMediaDedupeTextReport(report: Omit<MediaDedupeCommandResult, 'rendered'>): string {
  const lines: string[] = [];
  const modeLabel = report.apply ? 'apply' : 'dry-run';
  if (report.duplicateGroupCount === 0) {
    lines.push(`Media dedupe (${modeLabel}) OK: 0 duplicate file groups found.`);
    lines.push(`  Repo: ${report.repo}`);
    return lines.join('\n');
  }

  lines.push(
    `Media dedupe (${modeLabel}) OK: ${report.duplicateGroupCount} duplicate file group(s), ` +
      `${report.retiredCount} retired record(s), ` +
      `${report.citationRewrites.length} inline citation rewrite(s), ` +
      `${report.extensionRewrites.length} extension ref rewrite(s)`
  );
  lines.push(`  Repo: ${report.repo}`);
  for (const group of report.groups) {
    lines.push(
      `  File ${group.normalizedFile}: keep ${group.canonicalId}, retire [${group.retiredIds.join(', ')}]` +
        (group.mergedPersonIds.length > 0 ? ` (people: ${group.mergedPersonIds.join(', ')})` : '')
    );
  }
  if (report.warnings.length > 0) {
    lines.push('  Warnings:');
    for (const w of report.warnings) {
      lines.push(`    - ${w}`);
    }
  }
  if (report.stagedPackageWarnings.length > 0) {
    lines.push('  Staged package warnings (read-only, research/ not modified):');
    for (const sw of report.stagedPackageWarnings) {
      const pairs = sw.retiredMediaIds.map((id) => `${id} -> ${sw.canonicalByRetired[id]}`).join(', ');
      lines.push(`    - research/people/${sw.personId}/patch.json references retired media: ${pairs}`);
    }
  }
  if (!report.apply) {
    lines.push(
      `  Dry-run only: 0 files written (${report.wouldWriteYamlFiles.length} file(s) would be updated; pass '--apply' to write).`
    );
  } else {
    lines.push(
      `  Written YAML files (${report.writtenYamlFiles.length}): ${report.writtenYamlFiles.join(', ')}`
    );
  }
  return lines.join('\n');
}

export function renderMediaDedupeResult(
  base: Omit<MediaDedupeCommandResult, 'rendered'>,
  json: boolean
): MediaDedupeCommandResult {
  return {
    ...base,
    rendered: json ? JSON.stringify(base, null, 2) : formatMediaDedupeTextReport(base),
  };
}
