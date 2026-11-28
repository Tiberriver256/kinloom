-- Steward review stamps for revisions and research batches (0007_steward_reviews.sql)
-- Companion table keeps `revisions` strictly append-only while supporting idempotent steward sign-off.

CREATE TABLE IF NOT EXISTS steward_reviews (
  target_kind TEXT NOT NULL CHECK (target_kind IN ('revision', 'batch')),
  target_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  note TEXT,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS idx_steward_reviews_reviewed_at
  ON steward_reviews (reviewed_at DESC);
