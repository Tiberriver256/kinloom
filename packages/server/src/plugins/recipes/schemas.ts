import { type CallerPrincipal, type EntityReadStore, PrivacyViolationError } from '@kinloom/core';
import { z } from 'zod';
import { sha256Hex } from '../../crypto.js';
import { KinloomHttpError } from '../../errors.js';

export const RECIPES_PLUGIN_ID = 'kinloom-recipes';
export const RECIPES_DATABASE_NAMESPACE = 'recipes';

export const RECIPE_COURSES = [
  'breakfast',
  'appetizer',
  'soup_salad',
  'main',
  'side',
  'bread',
  'dessert',
  'beverage',
  'preserve',
  'other',
] as const;

export const RecipeCourseSchema = z.enum(RECIPE_COURSES);
export type RecipeCourse = z.infer<typeof RecipeCourseSchema>;

export const RECIPE_PHOTO_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const RecipePhotoMimeSchema = z.enum(RECIPE_PHOTO_MIMES);
export type RecipePhotoMime = z.infer<typeof RecipePhotoMimeSchema>;

export const RECIPE_CARD_SIDES = ['front', 'back', 'page', 'dish', 'other'] as const;
export const RecipeCardSideSchema = z.enum(RECIPE_CARD_SIDES);
export type RecipeCardSide = z.infer<typeof RecipeCardSideSchema>;

export const RECIPE_COMMENT_DELETED_BY_ROLES = ['author', 'admin'] as const;
export const RecipeCommentDeletedByRoleSchema = z.enum(RECIPE_COMMENT_DELETED_BY_ROLES);
export type RecipeCommentDeletedByRole = z.infer<typeof RecipeCommentDeletedByRoleSchema>;

export const RECIPE_SORT_MODES = ['stars', 'most_starred', 'newest', 'alpha'] as const;
export const RecipeSortModeSchema = z.enum(RECIPE_SORT_MODES);
export type RecipeSortMode = z.infer<typeof RecipeSortModeSchema>;

export const RecipeSlugSchema = z
  .string()
  .trim()
  .min(2)
  .max(96)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must contain lowercase letters, digits, and single hyphens.');

export const RecipeIngredientSchema = z.object({
  id: z.string().min(1).max(32),
  quantity: z.string().trim().max(40).default(''),
  unit: z.string().trim().max(40).default(''),
  item: z.string().trim().min(1).max(160),
  note: z.string().trim().max(160).default(''),
  group: z.string().trim().max(80).default(''),
});
export type RecipeIngredient = z.infer<typeof RecipeIngredientSchema>;

export const RecipeStepSchema = z.object({
  id: z.string().min(1).max(32),
  instruction: z.string().trim().min(1).max(1200),
  note: z.string().trim().max(300).default(''),
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9 -]*$/i, 'Tags may contain letters, numbers, spaces, and hyphens.')
  .transform((v) => v.toLowerCase());

export const CreateRecipeInputSchema = z.object({
  title: z.string().trim().min(2).max(140),
  slug: RecipeSlugSchema.optional(),
  summary: z.string().trim().max(400).default(''),
  story_md: z.string().trim().max(16000).default(''),
  ingredients: z.array(RecipeIngredientSchema).max(100).default([]),
  steps: z.array(RecipeStepSchema).max(60).default([]),
  prep_minutes: z.number().int().min(0).max(10080).nullable().default(null),
  cook_minutes: z.number().int().min(0).max(10080).nullable().default(null),
  servings: z.string().trim().max(60).default(''),
  course: RecipeCourseSchema.default('other'),
  tags: z.array(RecipeTagSchema).max(20).default([]),
  provenance_note: z.string().trim().max(400).default(''),
  source_era: z.string().trim().max(60).default(''),
  attributed_person_id: z.string().trim().min(1).max(64).nullable().default(null),
});
export type CreateRecipeInput = z.infer<typeof CreateRecipeInputSchema>;

export const UpdateRecipeInputSchema = CreateRecipeInputSchema.extend({
  expected_version: z.number().int().min(1),
});
export type UpdateRecipeInput = z.infer<typeof UpdateRecipeInputSchema>;

export const UpdateRecipePhotoInputSchema = z.object({
  caption: z.string().trim().max(240).optional(),
  card_side: RecipeCardSideSchema.optional(),
  sort_order: z.number().int().min(0).max(1000).optional(),
  set_cover: z.boolean().optional(),
});
export type UpdateRecipePhotoInput = z.infer<typeof UpdateRecipePhotoInputSchema>;

export const CreateRecipeCommentSchema = z.object({
  body_md: z.string().trim().min(1, 'Comment cannot be empty.').max(4000),
  parent_comment_id: z.string().trim().min(1).max(64).nullable().default(null),
});
export type CreateRecipeCommentInput = z.infer<typeof CreateRecipeCommentSchema>;

export const UpdateRecipeCommentSchema = z.object({
  body_md: z.string().trim().min(1, 'Comment cannot be empty.').max(4000),
});
export type UpdateRecipeCommentInput = z.infer<typeof UpdateRecipeCommentSchema>;

export interface RecipeRecord {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly story_md: string;
  readonly ingredients: readonly RecipeIngredient[];
  readonly steps: readonly RecipeStep[];
  readonly prep_minutes: number | null;
  readonly cook_minutes: number | null;
  readonly servings: string;
  readonly course: RecipeCourse;
  readonly tags: readonly string[];
  readonly provenance_note: string;
  readonly source_era: string;
  readonly attributed_person_id: string | null;
  readonly cover_photo_id: string | null;
  readonly star_count: number;
  readonly comment_count: number;
  readonly version: number;
  readonly created_by_id: string;
  readonly created_by_name: string;
  readonly updated_by_id: string;
  readonly updated_by_name: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly deleted_at: string | null;
}

export interface RecipePhotoRecord {
  readonly id: string;
  readonly recipe_id: string;
  readonly r2_key: string;
  readonly mime_type: RecipePhotoMime;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly caption: string;
  readonly card_side: RecipeCardSide;
  readonly sort_order: number;
  readonly uploaded_by_id: string;
  readonly uploaded_by_name: string;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

export interface RecipeStarRecord {
  readonly recipe_id: string;
  readonly actor_key: string;
  readonly created_at: string;
}

export interface RecipeCommentRecord {
  readonly id: string;
  readonly recipe_id: string;
  readonly parent_comment_id: string | null;
  readonly depth: 0 | 1;
  readonly author_id: string;
  readonly author_key: string;
  readonly author_name: string;
  readonly body_md: string;
  readonly created_at: string;
  readonly edited_at: string | null;
  readonly deleted_at: string | null;
  readonly deleted_by_role: RecipeCommentDeletedByRole | null;
}

export interface PublicRecipeComment {
  readonly id: string;
  readonly parent_comment_id: string | null;
  readonly depth: 0 | 1;
  readonly deleted: boolean;
  readonly deleted_by_role: RecipeCommentDeletedByRole | null;
  readonly author_name: string | null;
  readonly author_key: string | null;
  readonly body_md: string;
  readonly created_at: string;
  readonly edited_at: string | null;
  readonly can_edit: boolean;
  readonly can_delete: boolean;
}

const IngredientsArraySchema = z.array(RecipeIngredientSchema);
const StepsArraySchema = z.array(RecipeStepSchema);
const TagsArraySchema = z.array(z.string());

const RawRecipeItemDbRowSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  story_md: z.string(),
  ingredients_json: z.string(),
  steps_json: z.string(),
  prep_minutes: z.number().int().nullable(),
  cook_minutes: z.number().int().nullable(),
  servings: z.string(),
  course: RecipeCourseSchema,
  tags_json: z.string(),
  provenance_note: z.string(),
  source_era: z.string(),
  attributed_person_id: z.string().nullable(),
  cover_photo_id: z.string().nullable(),
  star_count: z.number().int().min(0),
  comment_count: z.number().int().min(0),
  version: z.number().int().min(1),
  created_by_id: z.string().min(1),
  created_by_name: z.string(),
  updated_by_id: z.string().min(1),
  updated_by_name: z.string(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  deleted_at: z.string().nullable(),
});

const RawRecipePhotoDbRowSchema = z.object({
  id: z.string().min(1),
  recipe_id: z.string().min(1),
  r2_key: z.string().min(1),
  mime_type: RecipePhotoMimeSchema,
  size_bytes: z.number().int().min(1),
  sha256: z.string().min(1),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  orientation: z.number().int().min(1).max(8),
  caption: z.string(),
  card_side: RecipeCardSideSchema,
  sort_order: z.number().int(),
  uploaded_by_id: z.string().min(1),
  uploaded_by_name: z.string(),
  created_at: z.string().min(1),
  deleted_at: z.string().nullable(),
});

const RawRecipeStarDbRowSchema = z.object({
  recipe_id: z.string().min(1),
  actor_key: z.string().min(1),
  created_at: z.string().min(1),
});

const RawRecipeCommentDbRowSchema = z.object({
  id: z.string().min(1),
  recipe_id: z.string().min(1),
  parent_comment_id: z.string().nullable(),
  depth: z.union([z.literal(0), z.literal(1)]),
  author_id: z.string().min(1),
  author_key: z.string().min(1),
  author_name: z.string(),
  body_md: z.string(),
  created_at: z.string().min(1),
  edited_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  deleted_by_role: RecipeCommentDeletedByRoleSchema.nullable(),
});

export function parseRecipeItemDbRow(raw: Record<string, unknown>): RecipeRecord {
  const row = RawRecipeItemDbRowSchema.parse(raw);
  const ingredients = IngredientsArraySchema.parse(JSON.parse(row.ingredients_json));
  const steps = StepsArraySchema.parse(JSON.parse(row.steps_json));
  const tags = TagsArraySchema.parse(JSON.parse(row.tags_json));
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    story_md: row.story_md,
    ingredients,
    steps,
    prep_minutes: row.prep_minutes,
    cook_minutes: row.cook_minutes,
    servings: row.servings,
    course: row.course,
    tags,
    provenance_note: row.provenance_note,
    source_era: row.source_era,
    attributed_person_id: row.attributed_person_id,
    cover_photo_id: row.cover_photo_id,
    star_count: row.star_count,
    comment_count: row.comment_count,
    version: row.version,
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    updated_by_id: row.updated_by_id,
    updated_by_name: row.updated_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

export function parseRecipePhotoDbRow(raw: Record<string, unknown>): RecipePhotoRecord {
  return RawRecipePhotoDbRowSchema.parse(raw);
}

export function parseRecipeStarDbRow(raw: Record<string, unknown>): RecipeStarRecord {
  return RawRecipeStarDbRowSchema.parse(raw);
}

export function parseRecipeCommentDbRow(raw: Record<string, unknown>): RecipeCommentRecord {
  return RawRecipeCommentDbRowSchema.parse(raw);
}

/**
 * Normalizes tags to unique lowercase values preserving insertion order.
 */
export function normalizeRecipeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of tags) {
    const normalized = tag.trim().toLowerCase();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) {
    start += 1;
  }
  while (end > start && value.charCodeAt(end - 1) === 45) {
    end -= 1;
  }
  return value.slice(start, end);
}

/**
 * Generates a deterministic URL-safe recipe slug from a human title.
 */
export function slugifyRecipeTitle(title: string): string {
  const ascii = trimDashes(
    trimDashes(
      title
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
    )
      .replace(/-{2,}/g, '-')
      .slice(0, 88)
  );
  if (ascii.length >= 2) {
    return ascii;
  }
  return ascii.length === 1 ? `${ascii}-recipe` : 'recipe';
}

/**
 * Derives a deterministic, non-reversible actor key so raw member emails
 * and invite tokens never appear in public star or comment API payloads.
 */
export async function deriveRecipeActorKey(principal: CallerPrincipal): Promise<string | null> {
  if (principal.kind === 'user') {
    const digest = await sha256Hex(principal.email.trim().toLowerCase());
    return `usr_${digest.slice(0, 24)}`;
  }
  if (principal.kind === 'invite_viewer') {
    const digest = await sha256Hex(principal.invite_token);
    return `inv_${digest.slice(0, 24)}`;
  }
  return null;
}

/**
 * Write-path living-person privacy fence for recipe ancestor attribution.
 * Rejects living people with PrivacyViolationError (HTTP 422) and missing/deleted
 * person records with KinloomHttpError (HTTP 400 INVALID_ANCESTOR_REFERENCE).
 */
export async function assertDeceasedRecipeAttribution(
  attributedPersonId: string | null,
  entityStore: Pick<EntityReadStore, 'getLivingPersonIds' | 'getEntity'>
): Promise<string | null> {
  if (attributedPersonId === null) {
    return null;
  }
  const normalizedId = attributedPersonId.trim();
  if (normalizedId.length === 0) {
    return null;
  }

  const livingIds = await entityStore.getLivingPersonIds();
  if (livingIds.has(normalizedId)) {
    throw new PrivacyViolationError(`Recipe attribution cannot reference living person '${normalizedId}'.`, {
      code: 'PRIVACY_VIOLATION',
      blockedPersonIds: [normalizedId],
    });
  }

  const entity = await entityStore.getEntity('person', normalizedId);
  if (!entity || entity.deleted_at !== null) {
    throw new KinloomHttpError(
      400,
      'INVALID_ANCESTOR_REFERENCE',
      `Attributed ancestor '${normalizedId}' does not exist in this archive.`
    );
  }

  if ('data' in entity && entity.data.is_living === true) {
    throw new PrivacyViolationError(`Recipe attribution cannot reference living person '${normalizedId}'.`, {
      code: 'PRIVACY_VIOLATION',
      blockedPersonIds: [normalizedId],
    });
  }

  return normalizedId;
}

/**
 * Read-path living-person privacy fence: if an attributed person is later reclassified
 * as living, redacts `attributed_person_id` to `null` without mutating stored history.
 */
export function redactLivingRecipeAttribution<T extends { readonly attributed_person_id: string | null }>(
  recipe: T,
  livingPersonIds: ReadonlySet<string>
): T {
  if (recipe.attributed_person_id !== null && livingPersonIds.has(recipe.attributed_person_id)) {
    return { ...recipe, attributed_person_id: null };
  }
  return recipe;
}

/**
 * Converts a stored comment record to a public payload with zero raw email exposure.
 * Soft-deleted root comments with active replies render as redacted tombstones.
 */
export function toPublicRecipeComment(
  comment: RecipeCommentRecord,
  principal: CallerPrincipal
): PublicRecipeComment {
  if (comment.deleted_at !== null) {
    return {
      id: comment.id,
      parent_comment_id: comment.parent_comment_id,
      depth: comment.depth,
      deleted: true,
      deleted_by_role: comment.deleted_by_role,
      author_name: null,
      author_key: null,
      body_md: '',
      created_at: comment.created_at,
      edited_at: null,
      can_edit: false,
      can_delete: false,
    };
  }

  const isOwner =
    principal.kind === 'user' &&
    principal.email.trim().toLowerCase() === comment.author_id.trim().toLowerCase();
  const isAdmin = principal.kind === 'user' && principal.role === 'admin';

  return {
    id: comment.id,
    parent_comment_id: comment.parent_comment_id,
    depth: comment.depth,
    deleted: false,
    deleted_by_role: null,
    author_name: comment.author_name,
    author_key: comment.author_key,
    body_md: comment.body_md,
    created_at: comment.created_at,
    edited_at: comment.edited_at,
    can_edit: isOwner,
    can_delete: isOwner || isAdmin,
  };
}
