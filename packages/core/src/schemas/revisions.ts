import { z } from 'zod';

export const EntityTypeSchema = z.enum([
  'person',
  'event',
  'place',
  'source',
  'media',
  'narrative',
  'kinship_edge',
]);

export const RevisionActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'restore',
  'revert',
]);

export const AuthorTypeSchema = z.enum(['human', 'agent', 'system_seed']);

export const EntityPayloadSchema = z.record(z.unknown());

export const RevisionRecordSchema = z.object({
  revision_id: z.number().int().positive(),
  batch_id: z.string().nullable().default(null),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  parent_revision_id: z.number().int().positive().nullable().default(null),
  action: RevisionActionSchema,
  reverted_revision_id: z.number().int().positive().nullable().default(null),
  author_id: z.string().min(1),
  author_name: z.string().min(1),
  author_type: AuthorTypeSchema,
  summary: z.string().min(3, 'Edit summary must be at least 3 characters'),
  has_primary_source: z
    .union([z.boolean(), z.literal(0), z.literal(1)])
    .transform((v) => Boolean(v)),
  before_json: EntityPayloadSchema.nullable(),
  after_json: EntityPayloadSchema.nullable(),
  created_at: z.string().min(1),
});

export const EntityPatchCreateSchema = z.object({
  action: z.literal('create'),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  data: EntityPayloadSchema,
  summary: z.string().min(3).optional(),
  has_primary_source: z.boolean().optional(),
});

export const EntityPatchUpdateSchema = z.object({
  action: z.literal('update'),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  parent_revision_id: z.number().int().positive().optional(),
  data: EntityPayloadSchema,
  merge: z.boolean().default(true),
  summary: z.string().min(3).optional(),
  has_primary_source: z.boolean().optional(),
});

export const EntityPatchDeleteSchema = z.object({
  action: z.literal('delete'),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  parent_revision_id: z.number().int().positive().optional(),
  summary: z.string().min(3).optional(),
});

export const EntityPatchRestoreSchema = z.object({
  action: z.literal('restore'),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  parent_revision_id: z.number().int().positive().optional(),
  data: EntityPayloadSchema.optional(),
  summary: z.string().min(3).optional(),
});

export const EntityPatchSchema = z.discriminatedUnion('action', [
  EntityPatchCreateSchema,
  EntityPatchUpdateSchema,
  EntityPatchDeleteSchema,
  EntityPatchRestoreSchema,
]);

export const BatchSubmissionSchema = z.object({
  batch_id: z.string().min(1),
  author_type: AuthorTypeSchema.default('agent'),
  summary: z.string().min(3, 'Batch summary must be at least 3 characters'),
  has_primary_source: z.boolean().default(true),
  patches: z.array(EntityPatchSchema).min(1, 'Batch submission must include at least one patch'),
});

export const TalkCommentSchema = z.object({
  comment_id: z.number().int().positive(),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  author_id: z.string().min(1),
  author_name: z.string().min(1),
  body_md: z.string().min(1),
  created_at: z.string().min(1),
  edited_at: z.string().nullable().default(null),
  deleted_at: z.string().nullable().default(null),
});

export type EntityType = z.infer<typeof EntityTypeSchema>;
export type RevisionAction = z.infer<typeof RevisionActionSchema>;
export type AuthorType = z.infer<typeof AuthorTypeSchema>;
export type EntityPayload = z.infer<typeof EntityPayloadSchema>;
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;
export type EntityPatch = z.infer<typeof EntityPatchSchema>;
export type BatchSubmission = z.infer<typeof BatchSubmissionSchema>;
export type TalkComment = z.infer<typeof TalkCommentSchema>;
