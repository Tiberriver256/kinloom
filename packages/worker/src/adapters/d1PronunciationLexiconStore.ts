import { PronunciationVariantSchema, type Pronunciation } from '@kinloom/core';
import type { PronunciationLexiconStore } from '@kinloom/server';
import type { D1Database } from '../types.js';

interface PronunciationLexiconRow {
  term: string;
  phonetic: string | null;
  ipa: string | null;
  language: string | null;
  audio_url: string | null;
  note: string | null;
  source_url?: string | null;
  source_label?: string | null;
  region?: string | null;
  variants_json?: string | null;
}

function parseVariantsJson(raw: string | null | undefined): Pronunciation['variants'] {
  if (!raw || !raw.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    const validated = parsed
      .map((item) => PronunciationVariantSchema.safeParse(item))
      .filter((res) => res.success)
      .map((res) => res.data);
    return validated.length > 0 ? validated : undefined;
  } catch {
    return undefined;
  }
}

function rowToPronunciation(row: PronunciationLexiconRow): Pronunciation {
  const entry: Pronunciation = {};
  if (row.phonetic) entry.phonetic = row.phonetic;
  if (row.ipa) entry.ipa = row.ipa;
  if (row.language) entry.language = row.language;
  if (row.audio_url) entry.audio_url = row.audio_url;
  if (row.note) entry.note = row.note;
  if (row.source_url) entry.source_url = row.source_url;
  if (row.source_label) entry.source_label = row.source_label;
  if (row.region) entry.region = row.region;
  const variants = parseVariantsJson(row.variants_json);
  if (variants) entry.variants = variants;
  return entry;
}

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

function isMissingColumnError(error: unknown): boolean {
  return collectErrorMessages(error).some((text) => {
    const lower = text.toLowerCase();
    return lower.includes('no such column') || lower.includes('has no column named');
  });
}

/**
 * Cloudflare D1 implementation of PronunciationLexiconStore backed by the
 * `pronunciation_lexicon` table (migrations 0002_pronunciations.sql + 0003_pronunciation_provenance.sql).
 */
export class D1PronunciationLexiconStore implements PronunciationLexiconStore {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async list(): Promise<Record<string, Pronunciation>> {
    try {
      const result = await this.db
        .prepare(
          'SELECT term, phonetic, ipa, language, audio_url, note, source_url, source_label, region, variants_json FROM pronunciation_lexicon ORDER BY term ASC'
        )
        .all<PronunciationLexiconRow>();

      const entries: Record<string, Pronunciation> = {};
      for (const row of result.results) {
        entries[row.term] = rowToPronunciation(row);
      }
      return entries;
    } catch (error) {
      if (isMissingColumnError(error)) {
        const legacyResult = await this.db
          .prepare(
            'SELECT term, phonetic, ipa, language, audio_url, note FROM pronunciation_lexicon ORDER BY term ASC'
          )
          .all<PronunciationLexiconRow>();
        const entries: Record<string, Pronunciation> = {};
        for (const row of legacyResult.results) {
          entries[row.term] = rowToPronunciation(row);
        }
        return entries;
      }
      if (isMissingTableError(error)) {
        return {};
      }
      throw error;
    }
  }

  async upsert(
    term: string,
    entry: Pronunciation,
    updatedBy: string,
    updatedAt: string
  ): Promise<Pronunciation> {
    const normalized: Pronunciation = {};
    if (entry.phonetic) normalized.phonetic = entry.phonetic;
    if (entry.ipa) normalized.ipa = entry.ipa;
    if (entry.language) normalized.language = entry.language;
    if (entry.audio_url) normalized.audio_url = entry.audio_url;
    if (entry.note) normalized.note = entry.note;
    if (entry.source_url) normalized.source_url = entry.source_url;
    if (entry.source_label) normalized.source_label = entry.source_label;
    if (entry.region) normalized.region = entry.region;
    if (entry.variants && entry.variants.length > 0) {
      normalized.variants = structuredClone(entry.variants);
    }

    const variantsJson = normalized.variants ? JSON.stringify(normalized.variants) : null;

    try {
      await this.db
        .prepare(
          `INSERT INTO pronunciation_lexicon (term, phonetic, ipa, language, audio_url, note, source_url, source_label, region, variants_json, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(term) DO UPDATE SET
             phonetic = excluded.phonetic,
             ipa = excluded.ipa,
             language = excluded.language,
             audio_url = excluded.audio_url,
             note = excluded.note,
             source_url = excluded.source_url,
             source_label = excluded.source_label,
             region = excluded.region,
             variants_json = excluded.variants_json,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(
          term,
          normalized.phonetic ?? null,
          normalized.ipa ?? null,
          normalized.language ?? null,
          normalized.audio_url ?? null,
          normalized.note ?? null,
          normalized.source_url ?? null,
          normalized.source_label ?? null,
          normalized.region ?? null,
          variantsJson,
          updatedBy,
          updatedAt
        )
        .run();
      return normalized;
    } catch (error) {
      if (!isMissingColumnError(error)) {
        throw error;
      }
      await this.db
        .prepare(
          `INSERT INTO pronunciation_lexicon (term, phonetic, ipa, language, audio_url, note, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(term) DO UPDATE SET
             phonetic = excluded.phonetic,
             ipa = excluded.ipa,
             language = excluded.language,
             audio_url = excluded.audio_url,
             note = excluded.note,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(
          term,
          normalized.phonetic ?? null,
          normalized.ipa ?? null,
          normalized.language ?? null,
          normalized.audio_url ?? null,
          normalized.note ?? null,
          updatedBy,
          updatedAt
        )
        .run();
      const legacyNormalized: Pronunciation = {};
      if (normalized.phonetic) legacyNormalized.phonetic = normalized.phonetic;
      if (normalized.ipa) legacyNormalized.ipa = normalized.ipa;
      if (normalized.language) legacyNormalized.language = normalized.language;
      if (normalized.audio_url) legacyNormalized.audio_url = normalized.audio_url;
      if (normalized.note) legacyNormalized.note = normalized.note;
      return legacyNormalized;
    }
  }

  async delete(term: string): Promise<void> {
    await this.db.prepare('DELETE FROM pronunciation_lexicon WHERE term = ?').bind(term).run();
  }
}
