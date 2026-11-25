-- Kinloom initial Cloudflare D1 SQLite schema (0001_initial.sql)
-- Includes all base tables, all four C4 Section 5.3 structural refinements,
-- and all secondary indexes required for zero full-table scans on hot paths.

-- Canonical current state of every archive entity (person, event, place, source, media, narrative)
CREATE TABLE entities (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'event', 'place', 'source', 'media', 'narrative')),
  entity_id TEXT NOT NULL,
  slug TEXT,
  data_json TEXT NOT NULL,
  current_revision_id INTEGER NOT NULL,
  has_primary_source INTEGER NOT NULL DEFAULT 1,
  deleted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);

-- Normalized bidirectional kinship edges (versioned through revisions)
CREATE TABLE kinship_edges (
  edge_id TEXT PRIMARY KEY,
  from_person_id TEXT NOT NULL,
  to_person_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('parent', 'child', 'spouse')),
  family_xref TEXT,
  current_revision_id INTEGER NOT NULL,
  deleted_at TEXT,
  updated_at TEXT NOT NULL
);

-- Append-only Wikipedia-style revision ledger (never updated or deleted)
CREATE TABLE revisions (
  revision_id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'event', 'place', 'source', 'media', 'narrative', 'kinship_edge')),
  entity_id TEXT NOT NULL,
  parent_revision_id INTEGER,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore', 'revert')),
  reverted_revision_id INTEGER,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system_seed')),
  summary TEXT NOT NULL,
  has_primary_source INTEGER NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  CHECK (action IN ('create', 'restore') OR parent_revision_id IS NOT NULL)
);

-- Authenticated site members (admins and editors)
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL,
  last_login_at TEXT
);

-- Shareable read-only family invite links with optional expiration and revocation
CREATE TABLE invites (
  token TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);

-- Single-use short-lived email magic links (SHA-256 hashed tokens)
CREATE TABLE magic_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite_token TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- Scoped bearer tokens for AI research agents (write_batch) and archival backups (read_backup)
CREATE TABLE agent_tokens (
  token_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'write_batch' CHECK (scope IN ('write_batch', 'read_backup')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Entity Talk threads (additive v1.1 table)
CREATE TABLE talk_comments (
  comment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'event', 'place', 'source', 'media', 'narrative', 'kinship_edge')),
  entity_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body_md TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);

-- Optional per-user entity watchlists for future digest notifications
CREATE TABLE watchlists (
  email TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, entity_type, entity_id)
);

-- 1. Active entity lookup by slug (enforces uniqueness only for non-deleted rows)
CREATE UNIQUE INDEX idx_entities_active_slug
  ON entities (entity_type, slug)
  WHERE slug IS NOT NULL AND deleted_at IS NULL;

-- 2. Active snapshot load for compileArchive (avoids scanning soft-deleted rows)
CREATE INDEX idx_entities_active_type
  ON entities (entity_type, entity_id)
  WHERE deleted_at IS NULL;

-- 3. Per-record History tab ordered newest-first (zero filesort)
CREATE INDEX idx_revisions_entity_history
  ON revisions (entity_type, entity_id, revision_id DESC);

-- 4. One-click AI agent batch inspection and reverse-order batch revert
CREATE INDEX idx_revisions_batch_lookup
  ON revisions (batch_id, revision_id DESC)
  WHERE batch_id IS NOT NULL;

-- 5. Recent Changes feed filtered by author_type (human vs agent)
CREATE INDEX idx_revisions_author_type_recent
  ON revisions (author_type, revision_id DESC);

-- 6. Kinship graph traversal and active duplicate-edge prevention
CREATE UNIQUE INDEX idx_kinship_active_edge
  ON kinship_edges (from_person_id, to_person_id, relation)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_kinship_to_person
  ON kinship_edges (to_person_id)
  WHERE deleted_at IS NULL;

-- 7. Bearer token lookup by SHA-256 hash on every CLI or backup request
CREATE UNIQUE INDEX idx_agent_tokens_hash
  ON agent_tokens (token_hash)
  WHERE revoked_at IS NULL;

-- 8. Entity Talk thread lookup ordered chronologically
CREATE INDEX idx_talk_comments_entity
  ON talk_comments (entity_type, entity_id, comment_id ASC)
  WHERE deleted_at IS NULL;

-- 9. Magic-link cleanup and lookup by email for rate limiting
CREATE INDEX idx_magic_links_email_expires
  ON magic_links (email, expires_at DESC);
