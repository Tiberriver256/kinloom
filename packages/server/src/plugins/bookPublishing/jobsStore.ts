import type { PluginDatabasePort, PluginSqlMigration } from '@kinloom/core';
import { z } from 'zod';
import { BookPhysicalSpecSchema, type BookPrintJobRecord, BookPrintJobStatusSchema } from './types.js';

export const BOOK_PUBLISHING_DATABASE_NAMESPACE = 'book_publishing';

export const BOOK_PUBLISHING_INITIAL_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS plugin_book_publishing_jobs (
  job_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  status_detail TEXT,
  tracking_urls_json TEXT NOT NULL DEFAULT '[]',
  sandbox INTEGER NOT NULL DEFAULT 1,
  quantity INTEGER NOT NULL DEFAULT 1,
  spec_json TEXT NOT NULL,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_plugin_book_publishing_jobs_updated
  ON plugin_book_publishing_jobs (updated_at DESC, job_id ASC);
`.trim();

export const BOOK_PUBLISHING_PLUGIN_MIGRATIONS: readonly PluginSqlMigration[] = [
  {
    version: 1,
    id: '0001_book_publishing_initial',
    description: 'Create plugin_book_publishing_jobs table for cross-isolate print job persistence.',
    sql: BOOK_PUBLISHING_INITIAL_MIGRATION_SQL,
  },
];

const JobDbRowSchema = z.object({
  job_id: z.string().min(1),
  provider_id: z.string().min(1),
  external_id: z.string().min(1),
  title: z.string().min(1),
  status: BookPrintJobStatusSchema,
  status_detail: z.string().nullable().optional(),
  tracking_urls_json: z.string(),
  sandbox: z.union([z.number(), z.boolean()]),
  quantity: z.number().int().min(1),
  spec_json: z.string(),
  artifact_ids_json: z.string().optional(),
  updated_at: z.string().min(1),
});

const StringArraySchema = z.array(z.string());

export interface StoredBookJobRow {
  readonly job: BookPrintJobRecord;
  readonly artifactIds: readonly string[];
}

export interface BookPublishingJobsStore {
  readonly adapterKind: string;
  listJobs(): Promise<readonly BookPrintJobRecord[]>;
  getJob(jobId: string): Promise<StoredBookJobRow | null>;
  upsertJob(job: BookPrintJobRecord, artifactIds?: readonly string[]): Promise<void>;
  clearArtifactIds(jobId: string): Promise<readonly string[]>;
}

export function isMissingBookPublishingTableError(error: unknown): boolean {
  const messages: string[] = [];
  if (error instanceof Error) {
    messages.push(error.message);
    if (error.cause instanceof Error) {
      messages.push(error.cause.message);
    } else if (typeof error.cause === 'string') {
      messages.push(error.cause);
    }
  } else if (typeof error === 'string') {
    messages.push(error);
  }
  return messages.some((msg) => /no such table:\s*plugin_book_publishing_/i.test(msg));
}

function parseJobDbRow(raw: Record<string, unknown>): StoredBookJobRow {
  const row = JobDbRowSchema.parse(raw);
  const trackingUrls = StringArraySchema.parse(JSON.parse(row.tracking_urls_json));
  const spec = BookPhysicalSpecSchema.parse(JSON.parse(row.spec_json));
  const artifactIds = row.artifact_ids_json ? StringArraySchema.parse(JSON.parse(row.artifact_ids_json)) : [];
  return {
    job: {
      providerId: row.provider_id,
      jobId: row.job_id,
      externalId: row.external_id,
      title: row.title,
      status: row.status,
      ...(row.status_detail ? { statusDetail: row.status_detail } : {}),
      trackingUrls,
      sandbox: row.sandbox === true || row.sandbox === 1,
      quantity: row.quantity,
      spec,
      updatedAt: row.updated_at,
    },
    artifactIds,
  };
}

export class InMemoryBookPublishingJobsStore implements BookPublishingJobsStore {
  readonly adapterKind = 'in-memory';
  private readonly rows = new Map<string, StoredBookJobRow>();

  async listJobs(): Promise<readonly BookPrintJobRecord[]> {
    return [...this.rows.values()]
      .map((entry) => entry.job)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.jobId.localeCompare(b.jobId));
  }

  async getJob(jobId: string): Promise<StoredBookJobRow | null> {
    return this.rows.get(jobId) ?? null;
  }

  async upsertJob(job: BookPrintJobRecord, artifactIds?: readonly string[]): Promise<void> {
    const existing = this.rows.get(job.jobId);
    this.rows.set(job.jobId, {
      job,
      artifactIds: artifactIds !== undefined ? [...artifactIds] : (existing?.artifactIds ?? []),
    });
  }

  async clearArtifactIds(jobId: string): Promise<readonly string[]> {
    const existing = this.rows.get(jobId);
    if (!existing) {
      return [];
    }
    const ids = [...existing.artifactIds];
    this.rows.set(jobId, { job: existing.job, artifactIds: [] });
    return ids;
  }
}

const JOB_SELECT_COLUMNS = `
  job_id, provider_id, external_id, title, status, status_detail,
  tracking_urls_json, sandbox, quantity, spec_json, artifact_ids_json, updated_at
`.trim();

export class SqlBookPublishingJobsStore implements BookPublishingJobsStore {
  readonly adapterKind: string;
  private readonly db: PluginDatabasePort;
  private readonly fallback: BookPublishingJobsStore;

  constructor(pluginDb: PluginDatabasePort, fallback: BookPublishingJobsStore) {
    this.db = pluginDb;
    this.adapterKind = pluginDb.adapterKind;
    this.fallback = fallback;
  }

  async listJobs(): Promise<readonly BookPrintJobRecord[]> {
    try {
      const rows = await this.db.query(
        `SELECT ${JOB_SELECT_COLUMNS}
         FROM plugin_book_publishing_jobs
         ORDER BY updated_at DESC, job_id ASC`,
        [],
        parseJobDbRow
      );
      return rows.map((row) => row.job);
    } catch (err) {
      if (isMissingBookPublishingTableError(err)) {
        return this.fallback.listJobs();
      }
      throw err;
    }
  }

  async getJob(jobId: string): Promise<StoredBookJobRow | null> {
    try {
      return await this.db.first(
        `SELECT ${JOB_SELECT_COLUMNS}
         FROM plugin_book_publishing_jobs
         WHERE job_id = ?
         LIMIT 1`,
        [jobId],
        parseJobDbRow
      );
    } catch (err) {
      if (isMissingBookPublishingTableError(err)) {
        return this.fallback.getJob(jobId);
      }
      throw err;
    }
  }

  async upsertJob(job: BookPrintJobRecord, artifactIds?: readonly string[]): Promise<void> {
    try {
      const existing = artifactIds === undefined ? await this.getJob(job.jobId) : null;
      const effectiveArtifacts = artifactIds ?? existing?.artifactIds ?? [];
      await this.db.run(
        `INSERT INTO plugin_book_publishing_jobs (
          job_id, provider_id, external_id, title, status, status_detail,
          tracking_urls_json, sandbox, quantity, spec_json, artifact_ids_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          provider_id = excluded.provider_id,
          external_id = excluded.external_id,
          title = excluded.title,
          status = excluded.status,
          status_detail = excluded.status_detail,
          tracking_urls_json = excluded.tracking_urls_json,
          sandbox = excluded.sandbox,
          quantity = excluded.quantity,
          spec_json = excluded.spec_json,
          artifact_ids_json = excluded.artifact_ids_json,
          updated_at = excluded.updated_at`,
        [
          job.jobId,
          job.providerId,
          job.externalId,
          job.title,
          job.status,
          job.statusDetail ?? null,
          JSON.stringify(job.trackingUrls),
          job.sandbox ? 1 : 0,
          job.quantity,
          JSON.stringify(job.spec),
          JSON.stringify(effectiveArtifacts),
          job.updatedAt,
        ]
      );
    } catch (err) {
      if (isMissingBookPublishingTableError(err)) {
        await this.fallback.upsertJob(job, artifactIds);
        return;
      }
      throw err;
    }
  }

  async clearArtifactIds(jobId: string): Promise<readonly string[]> {
    try {
      const existing = await this.getJob(jobId);
      if (!existing || existing.artifactIds.length === 0) {
        return [];
      }
      await this.db.run(
        `UPDATE plugin_book_publishing_jobs
         SET artifact_ids_json = '[]'
         WHERE job_id = ?`,
        [jobId]
      );
      return existing.artifactIds;
    } catch (err) {
      if (isMissingBookPublishingTableError(err)) {
        return this.fallback.clearArtifactIds(jobId);
      }
      throw err;
    }
  }
}
