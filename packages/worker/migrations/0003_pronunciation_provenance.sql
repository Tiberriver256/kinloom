-- Add provenance, regional disambiguation, and variant support to shared pronunciation lexicon (0003_pronunciation_provenance.sql)
ALTER TABLE pronunciation_lexicon ADD COLUMN source_url TEXT;
ALTER TABLE pronunciation_lexicon ADD COLUMN source_label TEXT;
ALTER TABLE pronunciation_lexicon ADD COLUMN region TEXT;
ALTER TABLE pronunciation_lexicon ADD COLUMN variants_json TEXT;
