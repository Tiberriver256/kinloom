-- Declarative plugin settings and isolated write-only secret storage (0004_plugin_settings.sql)
CREATE TABLE IF NOT EXISTS plugin_settings (
  plugin_id TEXT PRIMARY KEY,
  values_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_setting_secrets (
  plugin_id TEXT NOT NULL,
  field_key TEXT NOT NULL,
  secret_value TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, field_key)
);

CREATE INDEX IF NOT EXISTS idx_plugin_setting_secrets_plugin_id
  ON plugin_setting_secrets (plugin_id);
