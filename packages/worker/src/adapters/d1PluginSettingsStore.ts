import {
  type PluginSettingScalarValue,
  PluginSettingScalarValueSchema,
  type PluginSettingsSecretWriteOp,
  type PluginSettingsStore,
  type StoredPluginSecretMetadata,
  type StoredPluginSettingsRecord,
} from '@kinloom/core';
import type { D1Database, D1PreparedStatement } from '../types.js';

function collectErrorMessages(error: unknown): string[] {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if ('cause' in error && error.cause !== undefined) {
      parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
    }
  } else {
    parts.push(String(error));
  }
  return parts;
}

function isMissingTableError(error: unknown): boolean {
  return collectErrorMessages(error).some((text) => text.toLowerCase().includes('no such table'));
}

function parseValuesJson(raw: string): Record<string, PluginSettingScalarValue> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, PluginSettingScalarValue> = {};
    for (const [key, val] of Object.entries(parsed)) {
      const checked = PluginSettingScalarValueSchema.safeParse(val);
      if (checked.success) {
        out[key] = checked.data;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Cloudflare D1 implementation of PluginSettingsStore backed by separate
 * `plugin_settings` and `plugin_setting_secrets` tables (migration 0004_plugin_settings.sql).
 * Metadata queries never select the `secret_value` column.
 */
export class D1PluginSettingsStore implements PluginSettingsStore {
  readonly adapterKind = 'd1';
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async getSettings(pluginId: string): Promise<StoredPluginSettingsRecord | null> {
    try {
      const row = await this.db
        .prepare(
          'SELECT plugin_id, values_json, updated_by, updated_at FROM plugin_settings WHERE plugin_id = ?'
        )
        .bind(pluginId)
        .first<{
          plugin_id?: unknown;
          values_json?: unknown;
          updated_by?: unknown;
          updated_at?: unknown;
        }>();

      if (
        !row ||
        typeof row.plugin_id !== 'string' ||
        typeof row.values_json !== 'string' ||
        typeof row.updated_by !== 'string' ||
        typeof row.updated_at !== 'string'
      ) {
        return null;
      }

      return {
        plugin_id: row.plugin_id,
        values: parseValuesJson(row.values_json),
        updated_by: row.updated_by,
        updated_at: row.updated_at,
      };
    } catch (error) {
      if (isMissingTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async getSecretMetadata(pluginId: string): Promise<Readonly<Record<string, StoredPluginSecretMetadata>>> {
    try {
      const result = await this.db
        .prepare(
          'SELECT field_key, updated_at FROM plugin_setting_secrets WHERE plugin_id = ? ORDER BY field_key ASC'
        )
        .bind(pluginId)
        .all<{ field_key?: unknown; updated_at?: unknown }>();

      const out: Record<string, StoredPluginSecretMetadata> = {};
      for (const row of result.results) {
        if (typeof row.field_key === 'string' && row.field_key.length > 0) {
          out[row.field_key] = {
            configured: true,
            updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
          };
        }
      }
      return out;
    } catch (error) {
      if (isMissingTableError(error)) {
        return {};
      }
      throw error;
    }
  }

  async getSecretValue(pluginId: string, fieldKey: string): Promise<string | null> {
    try {
      const row = await this.db
        .prepare('SELECT secret_value FROM plugin_setting_secrets WHERE plugin_id = ? AND field_key = ?')
        .bind(pluginId, fieldKey)
        .first<{ secret_value?: unknown }>();
      return typeof row?.secret_value === 'string' ? row.secret_value : null;
    } catch (error) {
      if (isMissingTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async savePluginSettings(params: {
    readonly pluginId: string;
    readonly values: Readonly<Record<string, PluginSettingScalarValue>>;
    readonly secretMutations: readonly PluginSettingsSecretWriteOp[];
    readonly updatedBy: string;
    readonly updatedAt: string;
  }): Promise<{
    readonly settings: StoredPluginSettingsRecord;
    readonly secretMetadata: Readonly<Record<string, StoredPluginSecretMetadata>>;
  }> {
    const serializedValues = JSON.stringify(params.values);
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO plugin_settings (plugin_id, values_json, updated_by, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(plugin_id) DO UPDATE SET
             values_json = excluded.values_json,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(params.pluginId, serializedValues, params.updatedBy, params.updatedAt),
    ];

    for (const mutation of params.secretMutations) {
      if (mutation.action === 'clear') {
        statements.push(
          this.db
            .prepare('DELETE FROM plugin_setting_secrets WHERE plugin_id = ? AND field_key = ?')
            .bind(params.pluginId, mutation.key)
        );
      } else if (mutation.action === 'set' && mutation.value !== undefined) {
        statements.push(
          this.db
            .prepare(
              `INSERT INTO plugin_setting_secrets (plugin_id, field_key, secret_value, updated_by, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(plugin_id, field_key) DO UPDATE SET
                 secret_value = excluded.secret_value,
                 updated_by = excluded.updated_by,
                 updated_at = excluded.updated_at`
            )
            .bind(params.pluginId, mutation.key, mutation.value, params.updatedBy, params.updatedAt)
        );
      }
    }

    await this.db.batch(statements);

    return {
      settings: {
        plugin_id: params.pluginId,
        values: { ...params.values },
        updated_by: params.updatedBy,
        updated_at: params.updatedAt,
      },
      secretMetadata: await this.getSecretMetadata(params.pluginId),
    };
  }
}
