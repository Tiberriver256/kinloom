import {
  applyOnboardingPatch,
  ChecklistVisibilitySchema,
  createDefaultUserOnboardingState,
  type StoredUserOnboardingRecord,
  type UpdateOnboardingStateRequest,
  type UserOnboardingState,
  type UserOnboardingStore,
} from '@kinloom/core';
import type { D1Database } from '../types.js';

interface UserOnboardingRow {
  email?: unknown;
  schema_version?: unknown;
  checklist_visibility?: unknown;
  first_login_pending?: unknown;
  completed_step_ids_json?: unknown;
  skipped_step_ids_json?: unknown;
  completed_chapter_ids_json?: unknown;
  tutorial_modal_dismissed_at?: unknown;
  checklist_dismissed_at?: unknown;
  last_seen_version?: unknown;
  updated_at?: unknown;
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

function parseJsonStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim());
  } catch {
    return [];
  }
}

function parseOptionalString(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function rowToStoredRecord(row: UserOnboardingRow, fallbackEmail: string): StoredUserOnboardingRecord {
  const email = typeof row.email === 'string' && row.email.length > 0 ? row.email : fallbackEmail;
  const schemaVersion =
    typeof row.schema_version === 'number' && Number.isInteger(row.schema_version) && row.schema_version > 0
      ? row.schema_version
      : 1;
  const parsedVisibility = ChecklistVisibilitySchema.safeParse(row.checklist_visibility);
  const visibility = parsedVisibility.success ? parsedVisibility.data : 'open';
  const firstLoginPending = row.first_login_pending === 1 || row.first_login_pending === true;
  const state: UserOnboardingState = {
    schema_version: schemaVersion,
    checklist_visibility: visibility,
    completed_step_ids: parseJsonStringArray(row.completed_step_ids_json),
    skipped_step_ids: parseJsonStringArray(row.skipped_step_ids_json),
    completed_chapter_ids: parseJsonStringArray(row.completed_chapter_ids_json),
    tutorial_modal_dismissed_at: parseOptionalString(row.tutorial_modal_dismissed_at),
    checklist_dismissed_at: parseOptionalString(row.checklist_dismissed_at),
    last_seen_version: parseOptionalString(row.last_seen_version),
    updated_at: parseOptionalString(row.updated_at),
  };
  return {
    email,
    state,
    first_login_pending: firstLoginPending,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Cloudflare D1 implementation of UserOnboardingStore backed by `user_onboarding_state`
 * (migration 0008_user_onboarding.sql). Degrades cleanly when the migration is not yet applied.
 */
export class D1UserOnboardingStore implements UserOnboardingStore {
  readonly adapterKind = 'd1';
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async get(email: string): Promise<StoredUserOnboardingRecord | null> {
    const normalized = normalizeEmail(email);
    try {
      const row = await this.db
        .prepare(
          `SELECT email, schema_version, checklist_visibility, first_login_pending,
                  completed_step_ids_json, skipped_step_ids_json, completed_chapter_ids_json,
                  tutorial_modal_dismissed_at, checklist_dismissed_at, last_seen_version, updated_at
           FROM user_onboarding_state
           WHERE email = ?`
        )
        .bind(normalized)
        .first<UserOnboardingRow>();
      return row ? rowToStoredRecord(row, normalized) : null;
    } catch (error) {
      if (isMissingTableError(error)) {
        return null;
      }
      throw error;
    }
  }

  async markFirstLoginIfUnset(email: string, nowIso: string): Promise<StoredUserOnboardingRecord> {
    const normalized = normalizeEmail(email);
    const defaultState = createDefaultUserOnboardingState(nowIso);
    try {
      await this.db
        .prepare(
          `INSERT INTO user_onboarding_state (
             email, schema_version, checklist_visibility, first_login_pending,
             completed_step_ids_json, skipped_step_ids_json, completed_chapter_ids_json,
             tutorial_modal_dismissed_at, checklist_dismissed_at, last_seen_version, updated_at
           )
           VALUES (?, 1, 'open', 1, '[]', '[]', '[]', NULL, NULL, NULL, ?)
           ON CONFLICT(email) DO NOTHING`
        )
        .bind(normalized, nowIso)
        .run();
      const stored = await this.get(normalized);
      return (
        stored ?? {
          email: normalized,
          state: defaultState,
          first_login_pending: true,
        }
      );
    } catch (error) {
      if (isMissingTableError(error)) {
        return {
          email: normalized,
          state: defaultState,
          first_login_pending: true,
        };
      }
      throw error;
    }
  }

  async patch(
    email: string,
    mutation: UpdateOnboardingStateRequest,
    nowIso: string
  ): Promise<StoredUserOnboardingRecord> {
    const normalized = normalizeEmail(email);
    const existing = await this.get(normalized);
    const current = existing ?? {
      email: normalized,
      state: createDefaultUserOnboardingState(null),
      first_login_pending: false,
    };
    const next = applyOnboardingPatch(current, mutation, nowIso);
    const record: StoredUserOnboardingRecord = {
      email: normalized,
      state: next.state,
      first_login_pending: next.first_login_pending,
    };

    try {
      await this.db
        .prepare(
          `INSERT INTO user_onboarding_state (
             email, schema_version, checklist_visibility, first_login_pending,
             completed_step_ids_json, skipped_step_ids_json, completed_chapter_ids_json,
             tutorial_modal_dismissed_at, checklist_dismissed_at, last_seen_version, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             schema_version = excluded.schema_version,
             checklist_visibility = excluded.checklist_visibility,
             first_login_pending = excluded.first_login_pending,
             completed_step_ids_json = excluded.completed_step_ids_json,
             skipped_step_ids_json = excluded.skipped_step_ids_json,
             completed_chapter_ids_json = excluded.completed_chapter_ids_json,
             tutorial_modal_dismissed_at = excluded.tutorial_modal_dismissed_at,
             checklist_dismissed_at = excluded.checklist_dismissed_at,
             last_seen_version = excluded.last_seen_version,
             updated_at = excluded.updated_at`
        )
        .bind(
          normalized,
          next.state.schema_version,
          next.state.checklist_visibility,
          next.first_login_pending ? 1 : 0,
          JSON.stringify(next.state.completed_step_ids),
          JSON.stringify(next.state.skipped_step_ids),
          JSON.stringify(next.state.completed_chapter_ids),
          next.state.tutorial_modal_dismissed_at,
          next.state.checklist_dismissed_at,
          next.state.last_seen_version,
          next.state.updated_at ?? nowIso
        )
        .run();
      return record;
    } catch (error) {
      if (isMissingTableError(error)) {
        return record;
      }
      throw error;
    }
  }
}
