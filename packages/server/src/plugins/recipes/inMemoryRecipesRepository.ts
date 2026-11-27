import { KinloomHttpError } from '../../errors.js';
import {
  type AddRecipeCommentOutcome,
  type AddRecipeCommentRepoInput,
  type AddRecipePhotoRepoInput,
  type CreateRecipeRepoInput,
  clampRecipeListPagination,
  type DeleteRecipeCommentOutcome,
  type ListRecipesQuery,
  type ListRecipesResult,
  matchesRecipeSearchQuery,
  type RecipeActorIdentity,
  type RecipesRepository,
  type SoftDeleteRecipeCommentRepoInput,
  type SoftDeleteRecipePhotoResult,
  type ToggleRecipeStarOutcome,
  type UpdateRecipeCommentOutcome,
  type UpdateRecipeCommentRepoInput,
  type UpdateRecipeOutcome,
  type UpdateRecipePhotoRepoInput,
  type UpdateRecipeRepoInput,
} from './recipesRepository.js';
import {
  normalizeRecipeTags,
  type RecipeCommentRecord,
  type RecipeCourse,
  type RecipePhotoRecord,
  type RecipeRecord,
  type RecipeStarRecord,
  redactLivingRecipeAttribution,
  slugifyRecipeTitle,
} from './schemas.js';

function cloneRecipe(recipe: RecipeRecord): RecipeRecord {
  return {
    ...recipe,
    ingredients: recipe.ingredients.map((ing) => ({ ...ing })),
    steps: recipe.steps.map((step) => ({ ...step })),
    tags: [...recipe.tags],
  };
}

function clonePhoto(photo: RecipePhotoRecord): RecipePhotoRecord {
  return { ...photo };
}

function cloneComment(comment: RecipeCommentRecord): RecipeCommentRecord {
  return { ...comment };
}

function comparePhotos(a: RecipePhotoRecord, b: RecipePhotoRecord): number {
  if (a.sort_order !== b.sort_order) {
    return a.sort_order - b.sort_order;
  }
  const createdCmp = a.created_at.localeCompare(b.created_at);
  if (createdCmp !== 0) {
    return createdCmp;
  }
  return a.id.localeCompare(b.id);
}

function compareComments(a: RecipeCommentRecord, b: RecipeCommentRecord): number {
  const createdCmp = a.created_at.localeCompare(b.created_at);
  if (createdCmp !== 0) {
    return createdCmp;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Hermetic in-memory implementation of RecipesRepository for unit tests
 * and portable non-D1 deployments. Behaviorally identical to SqlRecipesRepository.
 */
export class InMemoryRecipesRepository implements RecipesRepository {
  readonly adapterKind = 'in-memory';
  private readonly recipes = new Map<string, RecipeRecord>();
  private readonly photos = new Map<string, RecipePhotoRecord>();
  private readonly stars = new Map<string, RecipeStarRecord>();
  private readonly comments = new Map<string, RecipeCommentRecord>();

  private activeSlugs(excludeRecipeId?: string): Set<string> {
    const slugs = new Set<string>();
    for (const recipe of this.recipes.values()) {
      if (recipe.deleted_at === null && recipe.id !== excludeRecipeId) {
        slugs.add(recipe.slug);
      }
    }
    return slugs;
  }

  private resolveUniqueSlug(title: string, explicitSlug?: string, excludeRecipeId?: string): string {
    const taken = this.activeSlugs(excludeRecipeId);
    if (explicitSlug !== undefined) {
      if (taken.has(explicitSlug)) {
        throw new KinloomHttpError(
          409,
          'RECIPE_SLUG_CONFLICT',
          `Recipe slug '${explicitSlug}' is already in use.`
        );
      }
      return explicitSlug;
    }

    const base = slugifyRecipeTitle(title);
    if (!taken.has(base)) {
      return base;
    }
    let suffix = 2;
    while (true) {
      const candidate = `${base.slice(0, Math.max(2, 96 - String(suffix).length - 1))}-${suffix}`;
      if (!taken.has(candidate)) {
        return candidate;
      }
      suffix += 1;
    }
  }

  async createRecipe(input: CreateRecipeRepoInput): Promise<RecipeRecord> {
    const slug = this.resolveUniqueSlug(input.data.title, input.data.slug);
    const record: RecipeRecord = {
      id: input.id,
      slug,
      title: input.data.title,
      summary: input.data.summary,
      story_md: input.data.story_md,
      ingredients: input.data.ingredients.map((item) => ({ ...item })),
      steps: input.data.steps.map((step) => ({ ...step })),
      prep_minutes: input.data.prep_minutes,
      cook_minutes: input.data.cook_minutes,
      servings: input.data.servings,
      course: input.data.course,
      tags: normalizeRecipeTags(input.data.tags),
      provenance_note: input.data.provenance_note,
      source_era: input.data.source_era,
      attributed_person_id: input.data.attributed_person_id,
      cover_photo_id: null,
      star_count: 0,
      comment_count: 0,
      version: 1,
      created_by_id: input.actor.id,
      created_by_name: input.actor.name,
      updated_by_id: input.actor.id,
      updated_by_name: input.actor.name,
      created_at: input.nowIso,
      updated_at: input.nowIso,
      deleted_at: null,
    };
    this.recipes.set(record.id, record);
    return cloneRecipe(record);
  }

  async getRecipeById(id: string): Promise<RecipeRecord | null> {
    const found = this.recipes.get(id);
    if (!found || found.deleted_at !== null) {
      return null;
    }
    return cloneRecipe(found);
  }

  async getRecipeBySlug(slug: string): Promise<RecipeRecord | null> {
    for (const recipe of this.recipes.values()) {
      if (recipe.deleted_at === null && recipe.slug === slug) {
        return cloneRecipe(recipe);
      }
    }
    return null;
  }

  async getRecipeBySlugOrId(slugOrId: string): Promise<RecipeRecord | null> {
    const byId = await this.getRecipeById(slugOrId);
    if (byId) {
      return byId;
    }
    return this.getRecipeBySlug(slugOrId);
  }

  async listRecipes(query: ListRecipesQuery = {}): Promise<ListRecipesResult> {
    const livingIds = query.exclude_living_person_ids;
    const activeAll = [...this.recipes.values()]
      .filter((r) => r.deleted_at === null)
      .map((r) => (livingIds ? redactLivingRecipeAttribution(r, livingIds) : r));

    const courseSet = new Set<RecipeCourse>();
    const tagSet = new Set<string>();
    for (const recipe of activeAll) {
      courseSet.add(recipe.course);
      for (const tag of recipe.tags) {
        tagSet.add(tag);
      }
    }
    const facets = {
      courses: [...courseSet].sort((a, b) => a.localeCompare(b)),
      tags: [...tagSet].sort((a, b) => a.localeCompare(b)),
    };

    const favoritesIds = query.favorites_for_actor_key
      ? await this.getStarredRecipeIds(query.favorites_for_actor_key)
      : null;

    const normalizedTag = query.tag?.trim().toLowerCase();
    const filtered = activeAll.filter((recipe) => {
      if (query.course && recipe.course !== query.course) {
        return false;
      }
      if (normalizedTag && !recipe.tags.includes(normalizedTag)) {
        return false;
      }
      if (query.attributed_person_id !== undefined) {
        if (livingIds?.has(query.attributed_person_id)) {
          return false;
        }
        if (recipe.attributed_person_id !== query.attributed_person_id) {
          return false;
        }
      }
      if (favoritesIds && !favoritesIds.has(recipe.id)) {
        return false;
      }
      if (query.q && !matchesRecipeSearchQuery(recipe, query.q)) {
        return false;
      }
      return true;
    });

    const sort = query.sort ?? 'newest';
    filtered.sort((a, b) => {
      if (sort === 'stars' || sort === 'most_starred') {
        if (b.star_count !== a.star_count) {
          return b.star_count - a.star_count;
        }
        const updatedCmp = b.updated_at.localeCompare(a.updated_at);
        if (updatedCmp !== 0) {
          return updatedCmp;
        }
        const createdCmp = b.created_at.localeCompare(a.created_at);
        return createdCmp !== 0 ? createdCmp : a.id.localeCompare(b.id);
      }
      if (sort === 'alpha') {
        const titleCmp = a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        if (titleCmp !== 0) {
          return titleCmp;
        }
        const createdCmp = b.created_at.localeCompare(a.created_at);
        return createdCmp !== 0 ? createdCmp : a.id.localeCompare(b.id);
      }
      const createdCmp = b.created_at.localeCompare(a.created_at);
      return createdCmp !== 0 ? createdCmp : a.id.localeCompare(b.id);
    });

    const { limit, offset } = clampRecipeListPagination(query.limit, query.offset);
    const page = filtered.slice(offset, offset + limit);
    const viewerStarred = query.viewer_actor_key
      ? await this.getStarredRecipeIds(
          query.viewer_actor_key,
          page.map((r) => r.id)
        )
      : new Set<string>();

    return {
      items: page.map((recipe) => ({
        recipe: cloneRecipe(recipe),
        viewer_has_starred: viewerStarred.has(recipe.id),
      })),
      total: filtered.length,
      facets,
    };
  }

  async countActiveRecipes(): Promise<number> {
    let count = 0;
    for (const recipe of this.recipes.values()) {
      if (recipe.deleted_at === null) {
        count += 1;
      }
    }
    return count;
  }

  async updateRecipe(input: UpdateRecipeRepoInput): Promise<UpdateRecipeOutcome> {
    const existing = this.recipes.get(input.id);
    if (!existing || existing.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    if (existing.version !== input.data.expected_version) {
      return {
        kind: 'conflict',
        expected_version: input.data.expected_version,
        server_version: existing.version,
        server_recipe: cloneRecipe(existing),
      };
    }

    const nextSlug = input.data.slug ?? existing.slug;
    if (nextSlug !== existing.slug && this.activeSlugs(existing.id).has(nextSlug)) {
      return { kind: 'slug_conflict', slug: nextSlug };
    }

    const updated: RecipeRecord = {
      ...existing,
      slug: nextSlug,
      title: input.data.title,
      summary: input.data.summary,
      story_md: input.data.story_md,
      ingredients: input.data.ingredients.map((item) => ({ ...item })),
      steps: input.data.steps.map((step) => ({ ...step })),
      prep_minutes: input.data.prep_minutes,
      cook_minutes: input.data.cook_minutes,
      servings: input.data.servings,
      course: input.data.course,
      tags: normalizeRecipeTags(input.data.tags),
      provenance_note: input.data.provenance_note,
      source_era: input.data.source_era,
      attributed_person_id: input.data.attributed_person_id,
      version: existing.version + 1,
      updated_by_id: input.actor.id,
      updated_by_name: input.actor.name,
      updated_at: input.nowIso,
    };
    this.recipes.set(updated.id, updated);
    return { kind: 'updated', recipe: cloneRecipe(updated) };
  }

  async softDeleteRecipe(id: string, deletedAt: string, actor: RecipeActorIdentity): Promise<boolean> {
    const existing = this.recipes.get(id);
    if (!existing || existing.deleted_at !== null) {
      return false;
    }
    this.recipes.set(id, {
      ...existing,
      deleted_at: deletedAt,
      updated_at: deletedAt,
      updated_by_id: actor.id,
      updated_by_name: actor.name,
    });
    return true;
  }

  async addPhoto(
    input: AddRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null> {
    const recipe = this.recipes.get(input.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }

    const activePhotos = [...this.photos.values()].filter(
      (p) => p.recipe_id === input.recipe_id && p.deleted_at === null
    );
    const maxSort = activePhotos.reduce((acc, p) => Math.max(acc, p.sort_order), -1);
    const sortOrder = input.sort_order ?? maxSort + 1;

    const photo: RecipePhotoRecord = {
      id: input.id,
      recipe_id: input.recipe_id,
      r2_key: input.r2_key,
      mime_type: input.mime_type,
      size_bytes: input.size_bytes,
      sha256: input.sha256,
      width: input.width,
      height: input.height,
      orientation: input.orientation,
      caption: input.caption,
      card_side: input.card_side,
      sort_order: sortOrder,
      uploaded_by_id: input.uploaded_by.id,
      uploaded_by_name: input.uploaded_by.name,
      created_at: input.nowIso,
      deleted_at: null,
    };
    this.photos.set(photo.id, photo);

    const shouldSetCover = recipe.cover_photo_id === null || input.set_cover === true;
    const nextCoverId = shouldSetCover ? photo.id : recipe.cover_photo_id;
    if (shouldSetCover) {
      this.recipes.set(recipe.id, {
        ...recipe,
        cover_photo_id: nextCoverId,
        updated_at: input.nowIso,
      });
    }

    return { photo: clonePhoto(photo), cover_photo_id: nextCoverId };
  }

  async getPhotoById(photoId: string): Promise<RecipePhotoRecord | null> {
    const photo = this.photos.get(photoId);
    if (!photo || photo.deleted_at !== null) {
      return null;
    }
    const recipe = this.recipes.get(photo.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }
    return clonePhoto(photo);
  }

  async listPhotosForRecipe(recipeId: string): Promise<readonly RecipePhotoRecord[]> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return [];
    }
    return [...this.photos.values()]
      .filter((p) => p.recipe_id === recipeId && p.deleted_at === null)
      .sort(comparePhotos)
      .map(clonePhoto);
  }

  async updatePhoto(
    input: UpdateRecipePhotoRepoInput
  ): Promise<{ readonly photo: RecipePhotoRecord; readonly cover_photo_id: string | null } | null> {
    const recipe = this.recipes.get(input.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }
    const existing = this.photos.get(input.photo_id);
    if (!existing || existing.recipe_id !== input.recipe_id || existing.deleted_at !== null) {
      return null;
    }

    const updated: RecipePhotoRecord = {
      ...existing,
      caption: input.caption ?? existing.caption,
      card_side: input.card_side ?? existing.card_side,
      sort_order: input.sort_order ?? existing.sort_order,
    };
    this.photos.set(updated.id, updated);

    let nextCoverId = recipe.cover_photo_id;
    if (input.set_cover === true) {
      nextCoverId = updated.id;
      this.recipes.set(recipe.id, {
        ...recipe,
        cover_photo_id: nextCoverId,
        updated_at: input.nowIso,
      });
    }
    return { photo: clonePhoto(updated), cover_photo_id: nextCoverId };
  }

  async reorderPhotos(
    recipeId: string,
    photoIds: readonly string[],
    nowIso: string
  ): Promise<readonly RecipePhotoRecord[] | null> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }
    photoIds.forEach((photoId, idx) => {
      const existing = this.photos.get(photoId);
      if (existing && existing.recipe_id === recipeId && existing.deleted_at === null) {
        this.photos.set(photoId, { ...existing, sort_order: idx });
      }
    });
    this.recipes.set(recipeId, { ...recipe, updated_at: nowIso });
    return this.listPhotosForRecipe(recipeId);
  }

  async softDeletePhoto(
    recipeId: string,
    photoId: string,
    deletedAt: string
  ): Promise<SoftDeleteRecipePhotoResult | null> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }
    const existing = this.photos.get(photoId);
    if (!existing || existing.recipe_id !== recipeId || existing.deleted_at !== null) {
      return null;
    }

    this.photos.set(photoId, { ...existing, deleted_at: deletedAt });
    let nextCoverId = recipe.cover_photo_id;
    if (recipe.cover_photo_id === photoId) {
      const remaining = [...this.photos.values()]
        .filter((p) => p.recipe_id === recipeId && p.deleted_at === null)
        .sort(comparePhotos);
      nextCoverId = remaining[0]?.id ?? null;
      this.recipes.set(recipeId, {
        ...recipe,
        cover_photo_id: nextCoverId,
        updated_at: deletedAt,
      });
    }
    return {
      deleted: true,
      r2_key: existing.r2_key,
      cover_photo_id: nextCoverId,
    };
  }

  private countStars(recipeId: string): number {
    let count = 0;
    for (const star of this.stars.values()) {
      if (star.recipe_id === recipeId) {
        count += 1;
      }
    }
    return count;
  }

  async starRecipe(recipeId: string, actorKey: string, createdAt: string): Promise<ToggleRecipeStarOutcome> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    const key = `${recipeId}\u0000${actorKey}`;
    if (!this.stars.has(key)) {
      this.stars.set(key, { recipe_id: recipeId, actor_key: actorKey, created_at: createdAt });
    }
    const starCount = this.countStars(recipeId);
    this.recipes.set(recipeId, { ...recipe, star_count: starCount });
    return {
      kind: 'ok',
      recipe_id: recipeId,
      star_count: starCount,
      viewer_has_starred: true,
    };
  }

  async unstarRecipe(recipeId: string, actorKey: string): Promise<ToggleRecipeStarOutcome> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    this.stars.delete(`${recipeId}\u0000${actorKey}`);
    const starCount = this.countStars(recipeId);
    this.recipes.set(recipeId, { ...recipe, star_count: starCount });
    return {
      kind: 'ok',
      recipe_id: recipeId,
      star_count: starCount,
      viewer_has_starred: false,
    };
  }

  async hasActorStarred(recipeId: string, actorKey: string): Promise<boolean> {
    return this.stars.has(`${recipeId}\u0000${actorKey}`);
  }

  async getStarredRecipeIds(actorKey: string, recipeIds?: readonly string[]): Promise<ReadonlySet<string>> {
    const filter = recipeIds ? new Set(recipeIds) : null;
    const result = new Set<string>();
    for (const star of this.stars.values()) {
      if (star.actor_key === actorKey && (!filter || filter.has(star.recipe_id))) {
        result.add(star.recipe_id);
      }
    }
    return result;
  }

  private countActiveComments(recipeId: string): number {
    let count = 0;
    for (const comment of this.comments.values()) {
      if (comment.recipe_id === recipeId && comment.deleted_at === null) {
        count += 1;
      }
    }
    return count;
  }

  async listCommentsForRecipe(recipeId: string): Promise<readonly RecipeCommentRecord[]> {
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return [];
    }
    const forRecipe = [...this.comments.values()].filter((c) => c.recipe_id === recipeId);
    const rootsWithActiveReplies = new Set<string>();
    for (const comment of forRecipe) {
      if (comment.deleted_at === null && comment.parent_comment_id !== null) {
        rootsWithActiveReplies.add(comment.parent_comment_id);
      }
    }

    return forRecipe
      .filter((c) => c.deleted_at === null || (c.depth === 0 && rootsWithActiveReplies.has(c.id)))
      .sort(compareComments)
      .map(cloneComment);
  }

  async getCommentById(recipeId: string, commentId: string): Promise<RecipeCommentRecord | null> {
    const comment = this.comments.get(commentId);
    if (!comment || comment.recipe_id !== recipeId || comment.deleted_at !== null) {
      return null;
    }
    const recipe = this.recipes.get(recipeId);
    if (!recipe || recipe.deleted_at !== null) {
      return null;
    }
    return cloneComment(comment);
  }

  async addComment(input: AddRecipeCommentRepoInput): Promise<AddRecipeCommentOutcome> {
    const recipe = this.recipes.get(input.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return { kind: 'recipe_not_found' };
    }

    let depth: 0 | 1 = 0;
    if (input.parent_comment_id !== null) {
      const parent = this.comments.get(input.parent_comment_id);
      if (!parent || parent.recipe_id !== input.recipe_id || parent.deleted_at !== null) {
        return { kind: 'parent_not_found' };
      }
      if (parent.depth >= 1) {
        return { kind: 'max_depth_exceeded' };
      }
      depth = 1;
    }

    const comment: RecipeCommentRecord = {
      id: input.id,
      recipe_id: input.recipe_id,
      parent_comment_id: input.parent_comment_id,
      depth,
      author_id: input.author_id,
      author_key: input.author_key,
      author_name: input.author_name,
      body_md: input.body_md,
      created_at: input.nowIso,
      edited_at: null,
      deleted_at: null,
      deleted_by_role: null,
    };
    this.comments.set(comment.id, comment);
    const commentCount = this.countActiveComments(input.recipe_id);
    this.recipes.set(input.recipe_id, { ...recipe, comment_count: commentCount });
    return {
      kind: 'created',
      comment: cloneComment(comment),
      comment_count: commentCount,
    };
  }

  async updateComment(input: UpdateRecipeCommentRepoInput): Promise<UpdateRecipeCommentOutcome> {
    const existing = this.comments.get(input.comment_id);
    if (!existing || existing.recipe_id !== input.recipe_id || existing.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    const recipe = this.recipes.get(input.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    const updated: RecipeCommentRecord = {
      ...existing,
      body_md: input.body_md,
      edited_at: input.edited_at,
    };
    this.comments.set(updated.id, updated);
    return { kind: 'updated', comment: cloneComment(updated) };
  }

  async softDeleteComment(input: SoftDeleteRecipeCommentRepoInput): Promise<DeleteRecipeCommentOutcome> {
    const existing = this.comments.get(input.comment_id);
    if (!existing || existing.recipe_id !== input.recipe_id || existing.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    const recipe = this.recipes.get(input.recipe_id);
    if (!recipe || recipe.deleted_at !== null) {
      return { kind: 'not_found' };
    }
    this.comments.set(existing.id, {
      ...existing,
      deleted_at: input.deleted_at,
      deleted_by_role: input.deleted_by_role,
    });
    const commentCount = this.countActiveComments(input.recipe_id);
    this.recipes.set(input.recipe_id, { ...recipe, comment_count: commentCount });
    return { kind: 'deleted', comment_count: commentCount };
  }
}
