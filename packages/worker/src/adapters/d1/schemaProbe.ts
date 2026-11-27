import type { D1Database } from '../../types.js';

/**
 * Non-destructively detects the highest applied Kinloom D1 schema migration.
 * Checks Wrangler's d1_migrations ledger first, then falls back to inspecting schema tables/columns.
 */
export async function probeD1SchemaMigrationLevel(db: D1Database): Promise<string | null> {
  try {
    const migrationRow = await db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name?: unknown }>();
    if (typeof migrationRow?.name === 'string' && migrationRow.name.trim().length > 0) {
      return migrationRow.name.trim();
    }
  } catch {
    // d1_migrations table may not exist when SQL migrations are applied directly (e.g. local Miniflare).
  }

  try {
    const tablesRes = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'pronunciation_lexicon', 'plugin_settings', 'plugin_setting_secrets')"
      )
      .all<{ name?: unknown }>();
    const tableNames = new Set(
      tablesRes.results
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter((name) => name.length > 0)
    );
    if (tableNames.has('plugin_settings') && tableNames.has('plugin_setting_secrets')) {
      return '0004_plugin_settings.sql';
    }
    if (tableNames.has('pronunciation_lexicon')) {
      const colsRes = await db.prepare('PRAGMA table_info(pronunciation_lexicon)').all<{ name?: unknown }>();
      const hasProvenance = colsRes.results.some((col) => col.name === 'source_url');
      return hasProvenance ? '0003_pronunciation_provenance.sql' : '0002_pronunciations.sql';
    }
    if (tableNames.has('entities')) {
      return '0001_initial.sql';
    }
    return null;
  } catch {
    return null;
  }
}
