import { z } from 'zod';
import {
  type KinshipEdge,
  KinshipEdgeSchema,
  MediaItemSchema,
  NarrativeSchema,
  PlaceSchema,
  RawEventSchema,
  RawPersonSchema,
  SourceRecordSchema,
} from './entities.js';

export const EntityTypeSchema = z.enum([
  'person',
  'event',
  'place',
  'source',
  'media',
  'narrative',
  'kinship_edge',
]);

export const RevisionActionSchema = z.enum(['create', 'update', 'delete', 'restore', 'revert']);

export const AuthorTypeSchema = z.enum(['human', 'agent', 'system_seed']);

export const AgentTokenScopeSchema = z.enum(['write_batch', 'read_backup']);

export const UserRoleSchema = z.enum(['admin', 'editor']);

export const EntityPayloadSchema = z.record(z.string(), z.unknown());

export const FieldDiffKindSchema = z.enum(['added', 'removed', 'changed']);

export const FieldDiffSchema = z.object({
  path: z.string(),
  kind: FieldDiffKindSchema,
  before: z.unknown(),
  after: z.unknown(),
});

export const EntityDiffSummarySchema = z.object({
  fields: z.array(FieldDiffSchema),
  addedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  changedCount: z.number().int().nonnegative(),
  hasChanges: z.boolean(),
});

export const OptimisticConflictErrorSchema = z.object({
  kind: z.literal('conflict').default('conflict'),
  entity_type: EntityTypeSchema,
  entity_id: z.string().min(1),
  expected_parent_revision_id: z.number().int().positive().nullable(),
  server_revision_id: z.number().int().positive(),
  server_entity: EntityPayloadSchema.nullable(),
  server_deleted_at: z.string().nullable(),
  last_author_name: z.string(),
  last_updated_at: z.string(),
  diff: EntityDiffSummarySchema,
});

export const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }),
});

export const EntityWriteInputSchema = z.object({
  entity_id: z.string().min(1).optional(),
  data: EntityPayloadSchema,
  expected_parent_revision_id: z.number().int().positive().optional(),
  merge: z.boolean().optional(),
  summary: z.string().trim().min(3, 'Edit summary must be at least 3 characters'),
  has_primary_source: z.boolean(),
});

export const EntityUpdateInputSchema = EntityWriteInputSchema.extend({
  expected_parent_revision_id: z.number().int().positive(),
});

export const EntityDeleteInputSchema = z.object({
  expected_parent_revision_id: z.number().int().positive(),
  summary: z.string().trim().min(3, 'Edit summary must be at least 3 characters'),
});

export const EntityRestoreInputSchema = z.object({
  expected_parent_revision_id: z.number().int().positive(),
  data: EntityPayloadSchema.optional(),
  summary: z.string().trim().min(3, 'Edit summary must be at least 3 characters'),
});

export const ENTITY_SCHEMA_BY_TYPE = {
  person: RawPersonSchema,
  event: RawEventSchema,
  place: PlaceSchema,
  source: SourceRecordSchema,
  media: MediaItemSchema,
  narrative: NarrativeSchema,
  kinship_edge: KinshipEdgeSchema,
} as const satisfies Record<z.infer<typeof EntityTypeSchema>, z.ZodTypeAny>;

export type TypedEntityByType = {
  [K in keyof typeof ENTITY_SCHEMA_BY_TYPE]: z.infer<(typeof ENTITY_SCHEMA_BY_TYPE)[K]>;
};

export function parseEntityPayload<T extends EntityType>(entityType: T, raw: unknown): TypedEntityByType[T] {
  const schema = ENTITY_SCHEMA_BY_TYPE[entityType];
  return schema.parse(raw) as TypedEntityByType[T];
}

export function safeParseEntityPayload<T extends EntityType>(
  entityType: T,
  raw: unknown
): z.ZodSafeParseResult<TypedEntityByType[T]> {
  const schema = ENTITY_SCHEMA_BY_TYPE[entityType];
  return schema.safeParse(raw) as z.ZodSafeParseResult<TypedEntityByType[T]>;
}

export function deriveKinshipEdgeId(edge: Pick<KinshipEdge, 'from' | 'relation' | 'to'>): string {
  return `${edge.from}:${edge.relation}:${edge.to}`;
}

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
  has_primary_source: z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => Boolean(v)),
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
export type AgentTokenScope = z.infer<typeof AgentTokenScopeSchema>;
export type UserRole = z.infer<typeof UserRoleSchema>;
export type EntityPayload = z.infer<typeof EntityPayloadSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;
export type EntityPatch = z.infer<typeof EntityPatchSchema>;
export type BatchSubmission = z.infer<typeof BatchSubmissionSchema>;
export type TalkComment = z.infer<typeof TalkCommentSchema>;
