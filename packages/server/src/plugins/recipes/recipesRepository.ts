import type {
  CreateRecipeInput,
  RecipeCardSide,
  RecipeCommentDeletedByRole,
  RecipeCommentRecord,
  RecipeCourse,
  RecipePhotoMime,
  RecipePhotoRecord,
  RecipeRecord,
  RecipeSortMode,
  UpdateRecipeInput,
} from './schemas.js';

export interface RecipeActorIdentity {
  readonly id: string;
  readonly name: string;
}

export interface CreateRecipeRepoInput {
  readonly id: string;
  readonly data: CreateRecipeInput;
  readonly actor: RecipeActorIdentity;
  readonly nowIso: string;
}

export interface UpdateRecipeRepoInput {
  readonly id: string;
  readonly data: UpdateRecipeInput;
  readonly actor: RecipeActorIdentity;
  readonly nowIso: string;
}

export interface ListRecipesQuery {
  readonly q?: string | undefined;
  readonly course?: RecipeCourse | undefined;
  readonly tag?: string | undefined;
  readonly attributed_person_id?: string | undefined;
  readonly favorites_for_actor_key?: string | undefined;
  readonly viewer_actor_key?: string | undefined;
  readonly sort?: RecipeSortMode | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly exclude_living_person_ids?: ReadonlySet<string> | undefined;
}

export interface RecipeListItem {
  readonly recipe: RecipeRecord;
  readonly viewer_has_starred: boolean;
}

export interface RecipeListFacets {
  readonly courses: readonly RecipeCourse[];
  readonly tags: readonly string[];
}

export interface ListRecipesResult {
  readonly items: readonly RecipeListItem[];
  readonly total: number;
  readonly facets: RecipeListFacets;
}

export type UpdateRecipeOutcome =
  | { readonly kind: 'updated'; readonly recipe: RecipeRecord }
  | { readonly kind: 'not_found' }
  | {
      readonly kind: 'conflict';
      readonly expected_version: number;
      readonly server_version: number;
      readonly server_recipe: RecipeRecord;
    }
  | { readonly kind: 'slug_conflict'; readonly slug: string };

export interface AddRecipePhotoRepoInput {
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
  readonly sort_order?: number | undefined;
  readonly set_cover?: boolean | undefined;
  readonly uploaded_by: RecipeActorIdentity;
  readonly nowIso: string;
}

export interface UpdateRecipePhotoRepoInput {
  readonly recipe_id: string;
  readonly photo_id: string;
  readonly caption?: string | undefined;
  readonly card_side?: RecipeCardSide | undefined;
  readonly sort_order?: number | undefined;
  readonly set_cover?: boolean | undefined;
  readonly nowIso: string;
}

export interface SoftDeleteRecipePhotoResult {
  readonly deleted: true;
  readonly r2_key: string;
  readonly cover_photo_id: string | null;
}

export type ToggleRecipeStarOutcome =
  | {
      readonly kind: 'ok';
      readonly recipe_id: string;
      readonly star_count: number;
      readonly viewer_has_starred: boolean;
    }
  | { readonly kind: 'not_found' };

export interface AddRecipeCommentRepoInput {
  readonly id: string;
  readonly recipe_id: string;
  readonly parent_comment_id: string | null;
  readonly author_id: string;
  readonly author_key: string;
  readonly author_name: string;
  readonly body_md: string;
  readonly nowIso: string;
}

export type AddRecipeCommentOutcome =
  | { readonly kind: 'created'; readonly comment: RecipeCommentRecord; readonly comment_count: number }
  | { readonly kind: 'recipe_not_found' }
  | { readonly kind: 'parent_not_found' }
  | { readonly kind: 'max_depth_exceeded' };

export interface UpdateRecipeCommentRepoInput {
  readonly recipe_id: string;
  readonly comment_id: string;
  readonly body_md: string;
  readonly edited_at: string;
}

export type UpdateRecipeCommentOutcome =
  | { readonly kind: 'updated'; readonly comment: RecipeCommentRecord }
  | { readonly kind: 'not_found' };

export interface SoftDeleteRecipeCommentRepoInput {
  readonly recipe_id: string;
  readonly comment_id: string;
  readonly deleted_at: string;
  readonly deleted_by_role: RecipeCommentDeletedByRole;
}

export type DeleteRecipeCommentOutcome =
  | { readonly kind: 'deleted'; readonly comment_count: number }
  | { readonly kind: 'not_found' };

export interface RecipesRepository {
  readonly adapterKind: string;

  createRecipe(input: CreateRecipeRepoInput): Promise<RecipeRecord>;
  getRecipeById(id: string): Promise<RecipeRecord | null>;
  getRecipeBySlug(slug: string): Promise<RecipeRecord | null>;
  getRecipeBySlugOrId(slugOrId: string): Promise<RecipeRecord | null>;
  listRecipes(query?: ListRecipesQuery): Promise<ListRecipesResult>;
  countActiveRecipes(): Promise<number>;
  updateRecipe(input: UpdateRecipeRepoInput): Promise<UpdateRecipeOutcome>;
  softDeleteRecipe(id: string, deletedAt: string, actor: RecipeActorIdentity): Promise<boolean>;

  addPhoto(
    input: AddRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null>;
  getPhotoById(photoId: string): Promise<RecipePhotoRecord | null>;
  listPhotosForRecipe(recipeId: string): Promise<readonly RecipePhotoRecord[]>;
  updatePhoto(
    input: UpdateRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null>;
  reorderPhotos(
    recipeId: string,
    photoIds: readonly string[],
    nowIso: string
  ): Promise<readonly RecipePhotoRecord[] | null>;
  softDeletePhoto(
    recipeId: string,
    photoId: string,
    deletedAt: string
  ): Promise<SoftDeleteRecipePhotoResult | null>;

  starRecipe(recipeId: string, actorKey: string, createdAt: string): Promise<ToggleRecipeStarOutcome>;
  unstarRecipe(recipeId: string, actorKey: string): Promise<ToggleRecipeStarOutcome>;
  hasActorStarred(recipeId: string, actorKey: string): Promise<boolean>;
  getStarredRecipeIds(actorKey: string, recipeIds?: readonly string[]): Promise<ReadonlySet<string>>;

  listCommentsForRecipe(recipeId: string): Promise<readonly RecipeCommentRecord[]>;
  getCommentById(recipeId: string, commentId: string): Promise<RecipeCommentRecord | null>;
  addComment(input: AddRecipeCommentRepoInput): Promise<AddRecipeCommentOutcome>;
  updateComment(input: UpdateRecipeCommentRepoInput): Promise<UpdateRecipeCommentOutcome>;
  softDeleteComment(input: SoftDeleteRecipeCommentRepoInput): Promise<DeleteRecipeCommentOutcome>;
}

/**
 * Shared search matcher used by both InMemory and SQL repositories to guarantee
 * identical substring matching semantics on title, summary, provenance_note, and tags.
 */
export function matchesRecipeSearchQuery(recipe: RecipeRecord, rawQuery: string): boolean {
  const needle = rawQuery.trim().toLowerCase();
  if (needle.length === 0) {
    return true;
  }
  if (
    recipe.title.toLowerCase().includes(needle) ||
    recipe.summary.toLowerCase().includes(needle) ||
    recipe.provenance_note.toLowerCase().includes(needle)
  ) {
    return true;
  }
  return recipe.tags.some((tag) => tag.toLowerCase().includes(needle));
}

export function clampRecipeListPagination(
  limit?: number,
  offset?: number
): {
  readonly limit: number;
  readonly offset: number;
} {
  const safeLimit =
    limit !== undefined && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 40;
  const safeOffset = offset !== undefined && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  return { limit: safeLimit, offset: safeOffset };
}
