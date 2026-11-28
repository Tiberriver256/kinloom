import {
  type AtomicMutationOp,
  type AtomicMutationStore,
  asRevisionId,
  type BatchId,
  type BatchSubmission,
  type BundleCache,
  type Clock,
  type EntityPayload,
  type EntityReadStore,
  type EntityType,
  type KinloomServerPlugin,
  type KinloomSiteConfig,
  type MediaStore,
  type PluginSettingsStore,
  type PronunciationAudioGenerator,
  type PronunciationEnvDefaults,
  type RevisionAuthor,
  type RevisionId,
  type RevisionLogStore,
  type RevisionRecord,
  type StewardReviewStamp,
  transitionEntityLifecycle,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';
import { compileBatchRevertOps, compileBatchSubmissionOps } from './wikiWrite/batchCompiler.js';
import { WikiCommitPipeline } from './wikiWrite/commitPipeline.js';
import {
  assertEditSummaryValid,
  extractSlug,
  maybeGenerateEntityPronunciationAudio,
  rowToPayload,
  rowToWorking,
  validateAndSanitizeEntityPayload,
} from './wikiWrite/payloadPolicy.js';

export interface WikiWriteServiceDeps {
  repository: EntityReadStore & AtomicMutationStore & RevisionLogStore;
  bundleCache: BundleCache;
  clock: Clock;
  siteConfig: KinloomSiteConfig;
  mediaStore?: MediaStore;
  pronunciationGenerator?: PronunciationAudioGenerator;
  pronunciationEnv?: PronunciationEnvDefaults;
  pluginSettingsStore?: PluginSettingsStore;
  plugins?: readonly KinloomServerPlugin[];
  onPluginError?: (pluginId: string, error: unknown) => void;
}

export class WikiWriteService {
  private readonly repository: EntityReadStore & AtomicMutationStore & RevisionLogStore;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;
  private readonly mediaStore?: MediaStore;
  private readonly pronunciationGenerator?: PronunciationAudioGenerator;
  private readonly pronunciationEnv?: PronunciationEnvDefaults;
  private readonly pluginSettingsStore?: PluginSettingsStore;
  private readonly commitPipeline: WikiCommitPipeline;

  constructor(deps: WikiWriteServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
    this.mediaStore = deps.mediaStore;
    this.pronunciationGenerator = deps.pronunciationGenerator;
    this.pronunciationEnv = deps.pronunciationEnv;
    this.pluginSettingsStore = deps.pluginSettingsStore;
    this.commitPipeline = new WikiCommitPipeline({
      repository: deps.repository,
      bundleCache: deps.bundleCache,
      clock: deps.clock,
      plugins: deps.plugins ?? [],
      onPluginError: deps.onPluginError,
    });
  }

  async createEntity(params: {
    entityType: EntityType;
    entityId?: string;
    data: EntityPayload;
    summary: string;
    hasPrimarySource: boolean;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    assertEditSummaryValid(params.summary);

    const { entityId, sanitized: initialSanitized } = await validateAndSanitizeEntityPayload(
      { repository: this.repository, clock: this.clock, siteConfig: this.siteConfig },
      {
        entityType: params.entityType,
        requestedEntityId: params.entityId,
        rawPayload: params.data,
        hasPrimarySource: params.hasPrimarySource,
      }
    );

    const existing = await this.repository.getEntity(params.entityType, entityId);
    if (existing !== null) {
      throw new KinloomHttpError(
        409,
        'ENTITY_EXISTS',
        existing.deleted_at !== null
          ? `Entity ${params.entityType}/${entityId} is soft-deleted; use restore or revert instead.`
          : `Entity ${params.entityType}/${entityId} already exists.`
      );
    }

    const sanitized = await maybeGenerateEntityPronunciationAudio(
      {
        clock: this.clock,
        siteConfig: this.siteConfig,
        mediaStore: this.mediaStore,
        pronunciationGenerator: this.pronunciationGenerator,
        pronunciationEnv: this.pronunciationEnv,
        pluginSettingsStore: this.pluginSettingsStore,
      },
      {
        entityType: params.entityType,
        sanitized: initialSanitized,
        previousPayload: null,
      }
    );

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'create',
      expected_parent_revision_id: null,
      summary: params.summary.trim(),
      has_primary_source: params.hasPrimarySource,
      before_json: null,
      after_json: sanitized,
    };

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations: [op],
    });

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag: committed.etag,
    };
  }

  async updateEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    data: EntityPayload;
    merge?: boolean;
    summary: string;
    hasPrimarySource: boolean;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    assertEditSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    const existingPayload = rowToPayload(existing);
    const mergedRaw: EntityPayload = params.merge
      ? { ...existingPayload, ...structuredClone(params.data) }
      : structuredClone(params.data);

    const { sanitized: initialSanitized } = await validateAndSanitizeEntityPayload(
      { repository: this.repository, clock: this.clock, siteConfig: this.siteConfig },
      {
        entityType: params.entityType,
        requestedEntityId: params.entityId,
        rawPayload: mergedRaw,
        hasPrimarySource: params.hasPrimarySource,
        requireIdMatch: true,
      }
    );

    if (existing.deleted_at !== null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.commitPipeline.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: initialSanitized,
      });
    }

    const sanitized = await maybeGenerateEntityPronunciationAudio(
      {
        clock: this.clock,
        siteConfig: this.siteConfig,
        mediaStore: this.mediaStore,
        pronunciationGenerator: this.pronunciationGenerator,
        pronunciationEnv: this.pronunciationEnv,
        pluginSettingsStore: this.pluginSettingsStore,
      },
      {
        entityType: params.entityType,
        sanitized: initialSanitized,
        previousPayload: existingPayload,
      }
    );

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'update',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: params.hasPrimarySource,
      before_json: existingPayload,
      after_json: sanitized,
    };

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations: [op],
    });

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag: committed.etag,
    };
  }

  async deleteEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    summary: string;
    author: RevisionAuthor;
  }): Promise<{ revision: RevisionRecord; etag: string }> {
    assertEditSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    if (existing.deleted_at !== null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.commitPipeline.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: null,
      });
    }

    const beforePayload = rowToPayload(existing);
    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: 'edge' in existing ? null : existing.slug,
      action: 'delete',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: 'edge' in existing ? true : existing.has_primary_source,
      before_json: beforePayload,
      after_json: null,
      soft_delete: true,
    };

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations: [op],
    });

    return {
      revision: committed.revisions[0],
      etag: committed.etag,
    };
  }

  async restoreEntity(params: {
    entityType: EntityType;
    entityId: string;
    expectedParentRevisionId: RevisionId;
    data?: EntityPayload;
    summary: string;
    author: RevisionAuthor;
  }): Promise<{ entity: EntityPayload; revision: RevisionRecord; etag: string }> {
    assertEditSummaryValid(params.summary);

    const existing = await this.repository.getEntity(params.entityType, params.entityId);
    if (existing === null) {
      throw new KinloomHttpError(
        404,
        'NOT_FOUND',
        `Entity ${params.entityType}/${params.entityId} was not found.`
      );
    }

    const existingPayload = rowToPayload(existing);
    const candidateRaw = params.data
      ? { ...existingPayload, ...structuredClone(params.data) }
      : existingPayload;

    const hasPrimary = 'edge' in existing ? true : existing.has_primary_source;
    const { sanitized } = await validateAndSanitizeEntityPayload(
      { repository: this.repository, clock: this.clock, siteConfig: this.siteConfig },
      {
        entityType: params.entityType,
        requestedEntityId: params.entityId,
        rawPayload: candidateRaw,
        hasPrimarySource: hasPrimary,
        requireIdMatch: true,
      }
    );

    if (existing.deleted_at === null || existing.current_revision_id !== params.expectedParentRevisionId) {
      throw await this.commitPipeline.buildConflictHttpError({
        entityType: params.entityType,
        entityId: params.entityId,
        expectedParentRevisionId: params.expectedParentRevisionId,
        existing,
        candidateAfter: sanitized,
      });
    }

    const op: AtomicMutationOp = {
      entity_type: params.entityType,
      entity_id: params.entityId,
      slug: extractSlug(params.entityType, sanitized),
      action: 'restore',
      expected_parent_revision_id: params.expectedParentRevisionId,
      summary: params.summary.trim(),
      has_primary_source: hasPrimary,
      before_json: null,
      after_json: sanitized,
      restore_deleted: true,
    };

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations: [op],
    });

    return {
      entity: sanitized,
      revision: committed.revisions[0],
      etag: committed.etag,
    };
  }

  async revertRevision(params: {
    revisionId: RevisionId;
    summary?: string;
    author: RevisionAuthor;
  }): Promise<{ revision: RevisionRecord; etag: string }> {
    const targetRev = await this.repository.getRevisionById(params.revisionId);
    if (!targetRev) {
      throw new KinloomHttpError(404, 'REVISION_NOT_FOUND', `Revision r${params.revisionId} was not found.`);
    }

    const [existing, headRev] = await Promise.all([
      this.repository.getEntity(targetRev.entity_type, targetRev.entity_id),
      this.repository.getHeadRevisionId(),
    ]);
    const working = rowToWorking(existing);

    const outcome = transitionEntityLifecycle(
      working.lifecycle,
      {
        type: 'revert',
        targetRevision: targetRev,
        summary: params.summary,
        nowIso: this.clock.nowIso(),
      },
      headRev + 1
    );

    if (!outcome.ok) {
      throw new KinloomHttpError(
        outcome.status,
        outcome.status === 409 ? 'OPTIMISTIC_CONFLICT' : 'NOT_FOUND',
        `Cannot revert revision r${params.revisionId}: ${outcome.code}.`
      );
    }

    let sanitizedAfter: EntityPayload | null = null;
    if (outcome.revisionInsert.afterJson !== null) {
      const validated = await validateAndSanitizeEntityPayload(
        { repository: this.repository, clock: this.clock, siteConfig: this.siteConfig },
        {
          entityType: targetRev.entity_type,
          requestedEntityId: targetRev.entity_id,
          rawPayload: outcome.revisionInsert.afterJson,
          hasPrimarySource: targetRev.has_primary_source,
        }
      );
      sanitizedAfter = validated.sanitized;
    }

    const op: AtomicMutationOp = {
      entity_type: targetRev.entity_type,
      entity_id: targetRev.entity_id,
      slug: extractSlug(targetRev.entity_type, sanitizedAfter),
      action: 'revert',
      expected_parent_revision_id: existing ? existing.current_revision_id : null,
      reverted_revision_id: asRevisionId(targetRev.revision_id),
      summary: outcome.revisionInsert.summary,
      has_primary_source: targetRev.has_primary_source,
      before_json: outcome.revisionInsert.beforeJson,
      after_json: sanitizedAfter,
      soft_delete: sanitizedAfter === null,
      restore_deleted: working.lifecycle.kind === 'softDeleted' && sanitizedAfter !== null,
    };

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations: [op],
    });

    return {
      revision: committed.revisions[0],
      etag: committed.etag,
    };
  }

  async submitBatch(params: { submission: BatchSubmission; author: RevisionAuthor }): Promise<{
    batch_id: BatchId;
    revisions: readonly RevisionRecord[];
    head_revision_id: RevisionId;
    etag: string;
  }> {
    const { batchId, operations } = await compileBatchSubmissionOps(
      {
        repository: this.repository,
        clock: this.clock,
        siteConfig: this.siteConfig,
        commitPipeline: this.commitPipeline,
      },
      params.submission
    );

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId,
      author: params.author,
      operations,
    });

    return {
      batch_id: batchId,
      revisions: committed.revisions,
      head_revision_id: committed.head_revision_id,
      etag: committed.etag,
    };
  }

  async revertBatch(params: { batchId: BatchId; summary?: string; author: RevisionAuthor }): Promise<{
    reverted_batch_id: BatchId;
    revisions: readonly RevisionRecord[];
    head_revision_id: RevisionId;
    etag: string;
  }> {
    const operations = await compileBatchRevertOps(
      {
        repository: this.repository,
        clock: this.clock,
        siteConfig: this.siteConfig,
      },
      { batchId: params.batchId, summary: params.summary }
    );

    const committed = await this.commitPipeline.commitAndPropagate({
      batchId: null,
      author: params.author,
      operations,
    });

    return {
      reverted_batch_id: params.batchId,
      revisions: committed.revisions,
      head_revision_id: committed.head_revision_id,
      etag: committed.etag,
    };
  }

  async markRevisionReviewed(params: {
    revisionId: RevisionId;
    note?: string | null;
    reviewer: RevisionAuthor;
  }): Promise<{ review: StewardReviewStamp }> {
    const targetRev = await this.repository.getRevisionById(params.revisionId);
    if (!targetRev) {
      throw new KinloomHttpError(404, 'REVISION_NOT_FOUND', `Revision r${params.revisionId} was not found.`);
    }
    const trimmedNote = params.note?.trim();
    const review = await this.repository.upsertStewardReview({
      target_kind: 'revision',
      target_id: String(params.revisionId),
      reviewer_id: params.reviewer.author_id,
      reviewer_name: params.reviewer.author_name,
      note: trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
      reviewed_at: this.clock.nowIso(),
    });
    return { review };
  }

  async clearRevisionReview(params: { revisionId: RevisionId }): Promise<{ cleared: boolean }> {
    const targetRev = await this.repository.getRevisionById(params.revisionId);
    if (!targetRev) {
      throw new KinloomHttpError(404, 'REVISION_NOT_FOUND', `Revision r${params.revisionId} was not found.`);
    }
    const cleared = await this.repository.deleteStewardReview('revision', String(params.revisionId));
    return { cleared };
  }

  async markBatchReviewed(params: {
    batchId: BatchId;
    note?: string | null;
    reviewer: RevisionAuthor;
  }): Promise<{ review: StewardReviewStamp }> {
    const batchRevisions = await this.repository.getRevisionsByBatch(params.batchId);
    if (batchRevisions.length === 0) {
      throw new KinloomHttpError(404, 'BATCH_NOT_FOUND', `Batch '${params.batchId}' was not found.`);
    }
    const trimmedNote = params.note?.trim();
    const review = await this.repository.upsertStewardReview({
      target_kind: 'batch',
      target_id: params.batchId,
      reviewer_id: params.reviewer.author_id,
      reviewer_name: params.reviewer.author_name,
      note: trimmedNote && trimmedNote.length > 0 ? trimmedNote : null,
      reviewed_at: this.clock.nowIso(),
    });
    return { review };
  }

  async clearBatchReview(params: { batchId: BatchId }): Promise<{ cleared: boolean }> {
    const batchRevisions = await this.repository.getRevisionsByBatch(params.batchId);
    if (batchRevisions.length === 0) {
      throw new KinloomHttpError(404, 'BATCH_NOT_FOUND', `Batch '${params.batchId}' was not found.`);
    }
    const cleared = await this.repository.deleteStewardReview('batch', params.batchId);
    return { cleared };
  }
}
