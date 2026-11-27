import type { MigrateCommandResult } from './types.js';

export function formatMigrateReport(result: Omit<MigrateCommandResult, 'rendered'>): string {
  const lines: string[] = [];
  const modeLabel = result.dryRun ? 'dry-run' : 'live';
  lines.push(`Kinloom D1 migrate (${modeLabel}, --${result.target}): ${result.dbName}`);
  lines.push(`Config: ${result.configPath}`);
  lines.push(`Migrations: ${result.migrationsDir}`);
  lines.push(
    `Summary: ${result.applied.length} applied, ${result.pending.length} pending, ${result.executed.length} executed`
  );

  if (result.applied.length > 0) {
    lines.push('Applied:');
    for (const item of result.applied) {
      lines.push(`  [ok] ${item.id} (${item.satisfiedBy})`);
    }
  }

  if (result.pending.length > 0) {
    lines.push('Pending:');
    for (const item of result.pending) {
      const detail = item.missingObjects.length > 0 ? ` missing ${item.missingObjects.join(', ')}` : '';
      lines.push(`  [pending] ${item.id}${detail}`);
    }
  } else if (result.dryRun && (!result.pluginPending || result.pluginPending.length === 0)) {
    lines.push('All migrations are already satisfied. No writes needed.');
  } else if (result.verified && (!result.pluginPending || result.pluginPending.length === 0)) {
    lines.push('Post-migration schema verification passed.');
  }

  if (result.pluginMigrationsDir) {
    const pluginApplied = result.pluginApplied ?? [];
    const pluginPending = result.pluginPending ?? [];
    const pluginExecuted = result.pluginExecuted ?? [];
    lines.push(`Plugin migrations: ${result.pluginMigrationsDir}`);
    lines.push(
      `Plugin summary: ${pluginApplied.length} applied, ${pluginPending.length} pending, ${pluginExecuted.length} executed`
    );
    if (pluginApplied.length > 0) {
      lines.push('Plugin applied:');
      for (const item of pluginApplied) {
        lines.push(`  [ok] ${item.namespace}/${item.migrationId} (${item.satisfiedBy})`);
      }
    }
    if (pluginPending.length > 0) {
      lines.push('Plugin pending:');
      for (const item of pluginPending) {
        const detail = item.missingObjects.length > 0 ? ` missing ${item.missingObjects.join(', ')}` : '';
        lines.push(`  [pending] ${item.namespace}/${item.migrationId}${detail}`);
      }
    }
  }

  return lines.join('\n');
}
