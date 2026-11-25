import { z } from 'zod';
import type {
  ArchiveRepository,
  CallerPrincipal,
  Clock,
  EntityType,
  KinloomSiteConfig,
  TalkComment,
} from '@kinloom/core';
import { KinloomHttpError } from '../errors.js';

const TalkBodySchema = z
  .string()
  .trim()
  .min(1, 'Comment cannot be empty.')
  .max(8000, 'Comment cannot exceed 8000 characters.');

export interface TalkServiceDeps {
  repository: ArchiveRepository;
  clock: Clock;
  siteConfig: KinloomSiteConfig;
}

export class TalkService {
  private readonly repository: ArchiveRepository;
  private readonly clock: Clock;
  private readonly siteConfig: KinloomSiteConfig;

  constructor(deps: TalkServiceDeps) {
    this.repository = deps.repository;
    this.clock = deps.clock;
    this.siteConfig = deps.siteConfig;
  }

  private assertTalkEnabled(): void {
    if (this.siteConfig.wiki?.allowTalk === false) {
      throw new KinloomHttpError(403, 'FORBIDDEN', 'Talk comments are disabled for this archive.');
    }
  }

  async listComments(params: {
    entityType: EntityType;
    entityId: string;
  }): Promise<readonly TalkComment[]> {
    this.assertTalkEnabled();
    return this.repository.listTalkComments(params.entityType, params.entityId);
  }

  async postComment(params: {
    entityType: EntityType;
    entityId: string;
    bodyMd: string;
    authorId: string;
    authorName: string;
  }): Promise<TalkComment> {
    this.assertTalkEnabled();
    const body = TalkBodySchema.parse(params.bodyMd);
    return this.repository.insertTalkComment({
      entity_type: params.entityType,
      entity_id: params.entityId,
      author_id: params.authorId,
      author_name: params.authorName,
      body_md: body,
      created_at: this.clock.nowIso(),
    });
  }

  async deleteComment(params: {
    entityType: EntityType;
    entityId: string;
    commentId: number;
    principal: CallerPrincipal;
  }): Promise<void> {
    this.assertTalkEnabled();
    if (params.principal.kind !== 'user') {
      throw new KinloomHttpError(403, 'FORBIDDEN', 'Only the comment author or an admin can delete comments.');
    }

    const comments = await this.repository.listTalkComments(params.entityType, params.entityId);
    const target = comments.find((c) => c.comment_id === params.commentId);
    if (!target) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `Comment ${params.commentId} was not found.`);
    }

    const isAdmin = params.principal.role === 'admin';
    const isAuthor = params.principal.email === target.author_id;
    if (!isAdmin && !isAuthor) {
      throw new KinloomHttpError(
        403,
        'FORBIDDEN',
        'Only the comment author or an admin can delete this comment.'
      );
    }

    const deleted = await this.repository.softDeleteTalkComment(
      params.commentId,
      this.clock.nowIso()
    );
    if (!deleted) {
      throw new KinloomHttpError(404, 'NOT_FOUND', `Comment ${params.commentId} was not found.`);
    }
  }
}
