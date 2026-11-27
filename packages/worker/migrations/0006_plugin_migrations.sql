-- Versioned plugin database migration ledger (0006_plugin_migrations.sql)
-- Remains empty when no database-backed plugins are registered.
CREATE TABLE IF NOT EXISTS plugin_migrations (
  plugin_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  migration_id TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

CREATE INDEX IF NOT EXISTS idx_plugin_migrations_namespace
  ON plugin_migrations (namespace, version DESC);
