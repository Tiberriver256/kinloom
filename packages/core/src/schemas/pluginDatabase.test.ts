import { describe, expect, it } from 'vitest';
import {
  AppliedPluginMigrationRecordSchema,
  PluginDatabaseNamespaceSchema,
  PluginMigrationIdSchema,
  PluginSqlMigrationSchema,
} from './pluginDatabase.js';

describe('pluginDatabase schemas', () => {
  it('validates plugin database namespaces and rejects malformed segments', () => {
    expect(PluginDatabaseNamespaceSchema.parse('recipes')).toBe('recipes');
    expect(PluginDatabaseNamespaceSchema.parse('family_notes_2')).toBe('family_notes_2');
    expect(() => PluginDatabaseNamespaceSchema.parse('a')).toThrow();
    expect(() => PluginDatabaseNamespaceSchema.parse('1recipes')).toThrow();
    expect(() => PluginDatabaseNamespaceSchema.parse('Recipes')).toThrow();
    expect(() => PluginDatabaseNamespaceSchema.parse('recipes-bad')).toThrow();
    expect(() => PluginDatabaseNamespaceSchema.parse('a'.repeat(26))).toThrow();
  });

  it('validates plugin migration definitions and applied ledger records', () => {
    expect(PluginMigrationIdSchema.parse('0001_initial_schema')).toBe('0001_initial_schema');
    expect(() => PluginMigrationIdSchema.parse('UPPER')).toThrow();

    const parsedMigration = PluginSqlMigrationSchema.parse({
      version: 1,
      id: '0001_sample_initial',
      description: 'Create sample plugin table',
      sql: 'CREATE TABLE IF NOT EXISTS plugin_sample_items (id TEXT PRIMARY KEY);',
    });
    expect(parsedMigration.version).toBe(1);
    expect(parsedMigration.id).toBe('0001_sample_initial');

    expect(() =>
      PluginSqlMigrationSchema.parse({
        version: 0,
        id: '0000_zero',
        description: 'Invalid zero version',
        sql: 'CREATE TABLE plugin_sample_items (id TEXT);',
      })
    ).toThrow();

    const ledger = AppliedPluginMigrationRecordSchema.parse({
      plugin_id: 'sample-plugin',
      namespace: 'sample',
      version: 1,
      migration_id: '0001_sample_initial',
      checksum_sha256: 'a'.repeat(64),
      applied_at: '2026-11-27T12:00:00.000Z',
    });
    expect(ledger.namespace).toBe('sample');

    expect(() =>
      AppliedPluginMigrationRecordSchema.parse({
        plugin_id: 'sample-plugin',
        namespace: 'sample',
        version: 1,
        migration_id: '0001_sample_initial',
        checksum_sha256: 'not-a-sha256',
        applied_at: '2026-11-27T12:00:00.000Z',
      })
    ).toThrow();
  });
});
