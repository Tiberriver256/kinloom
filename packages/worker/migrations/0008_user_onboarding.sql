-- Per-user onboarding checklist (#54) and tutorial progress (#53) state (0008_user_onboarding.sql)
CREATE TABLE IF NOT EXISTS user_onboarding_state (
  email TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  checklist_visibility TEXT NOT NULL DEFAULT 'open'
    CHECK (checklist_visibility IN ('open', 'collapsed', 'dismissed')),
  first_login_pending INTEGER NOT NULL DEFAULT 0 CHECK (first_login_pending IN (0, 1)),
  completed_step_ids_json TEXT NOT NULL DEFAULT '[]',
  skipped_step_ids_json TEXT NOT NULL DEFAULT '[]',
  completed_chapter_ids_json TEXT NOT NULL DEFAULT '[]',
  tutorial_modal_dismissed_at TEXT,
  checklist_dismissed_at TEXT,
  last_seen_version TEXT,
  updated_at TEXT NOT NULL
);
