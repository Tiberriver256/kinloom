import type { Pronunciation } from '@kinloom/core';
import type { PronunciationLexiconStore } from '@kinloom/server';
import type { D1Database } from '../types.js';

interface PronunciationLexiconRow {
  term: string;
  phonetic: string | null;
  ipa: string | null;
  language: string | null;
  audio_url: string | null;
  note: string | null;
}

function rowToPronunciation(row: PronunciationLexiconRow): Pronunciation {
  const entry: Pronunciation = {};
  if (row.phonetic) entry.phonetic = row.phonetic;
  if (row.ipa) entry.ipa = row.ipa;
  if (row.language) entry.language = row.language;
  if (row.audio_url) entry.audio_url = row.audio_url;
  if (row.note) entry.note = row.note;
  return entry;
}

function isMissingTableError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.message);
    if ('cause' in error && error.cause !== undefined) {
      parts.push(error.cause instanceof Error ? error.cause.message : String(error.cause));
    }
  } else {
    parts.push(String(error));
  }
  return parts.some((text) => text.toLowerCase().includes('no such table'));
}

/**
 * Cloudflare D1 implementation of PronunciationLexiconStore backed by the
 * `pronunciation_lexicon` table (migration 0002_pronunciations.sql).
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
          'SELECT term, phonetic, ipa, language, audio_url, note FROM pronunciation_lexicon ORDER BY term ASC'
        )
        .all<PronunciationLexiconRow>();

      const entries: Record<string, Pronunciation> = {};
      for (const row of result.results) {
        entries[row.term] = rowToPronunciation(row);
      }
      return entries;
    } catch (error) {
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

    return normalized;
  }

  async delete(term: string): Promise<void> {
    await this.db.prepare('DELETE FROM pronunciation_lexicon WHERE term = ?').bind(term).run();
  }
}
