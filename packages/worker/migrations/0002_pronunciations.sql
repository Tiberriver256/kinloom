-- Kinloom shared pronunciation lexicon table (0002_pronunciations.sql)
CREATE TABLE IF NOT EXISTS pronunciation_lexicon (
  term TEXT PRIMARY KEY,
  phonetic TEXT,
  ipa TEXT,
  language TEXT,
  audio_url TEXT,
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
