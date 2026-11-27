import { z } from 'zod';

export const UI_RECIPE_COURSES = [
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

export const UiRecipeCourseSchema = z.enum(UI_RECIPE_COURSES);
export type UiRecipeCourse = z.infer<typeof UiRecipeCourseSchema>;

export const UI_RECIPE_COURSE_LABELS: Readonly<Record<UiRecipeCourse, string>> = {
  breakfast: 'Breakfast',
  appetizer: 'Appetizer',
  soup_salad: 'Soup & Salad',
  main: 'Main Dish',
  side: 'Side Dish',
  bread: 'Bread & Baking',
  dessert: 'Dessert',
  beverage: 'Beverage',
  preserve: 'Preserve & Pantry',
  other: 'Family Classic',
};

export const UI_RECIPE_SORT_MODES = ['stars', 'newest', 'alpha'] as const;
export const UiRecipeSortModeSchema = z.enum(UI_RECIPE_SORT_MODES);
export type UiRecipeSortMode = z.infer<typeof UiRecipeSortModeSchema>;

export const UI_RECIPE_CARD_SIDES = ['front', 'back', 'page', 'dish', 'other'] as const;
export const UiRecipeCardSideSchema = z.enum(UI_RECIPE_CARD_SIDES);
export type UiRecipeCardSide = z.infer<typeof UiRecipeCardSideSchema>;

export const UI_RECIPE_CARD_SIDE_LABELS: Readonly<Record<UiRecipeCardSide, string>> = {
  front: 'Card Front',
  back: 'Card Back',
  page: 'Cookbook Page',
  dish: 'Finished Dish',
  other: 'Archive Photo',
};

export const UiRecipeIngredientSchema = z.object({
  id: z.string().min(1),
  quantity: z.string().default(''),
  unit: z.string().default(''),
  item: z.string().min(1),
  note: z.string().default(''),
  group: z.string().default(''),
});
export type UiRecipeIngredient = z.infer<typeof UiRecipeIngredientSchema>;

export const UiRecipeStepSchema = z.object({
  id: z.string().min(1),
  instruction: z.string().min(1),
  note: z.string().default(''),
});
export type UiRecipeStep = z.infer<typeof UiRecipeStepSchema>;

export const UiRecipeAncestorRefSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  full_name: z.string().min(1),
});
export type UiRecipeAncestorRef = z.infer<typeof UiRecipeAncestorRefSchema>;

export const UiRecipePhotoSchema = z.object({
  id: z.string().min(1),
  recipe_id: z.string().min(1),
  url: z.string().min(1),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  size_bytes: z.number().int().min(1),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  orientation: z.number().int().min(1).max(8),
  caption: z.string(),
  card_side: UiRecipeCardSideSchema,
  sort_order: z.number().int(),
  uploaded_by_name: z.string(),
  created_at: z.string().min(1),
});
export type UiRecipePhoto = z.infer<typeof UiRecipePhotoSchema>;

export const UiRecipePermissionsSchema = z.object({
  can_edit: z.boolean(),
  can_delete: z.boolean(),
  can_upload: z.boolean(),
  can_star: z.boolean(),
  can_comment: z.boolean(),
});
export type UiRecipePermissions = z.infer<typeof UiRecipePermissionsSchema>;

export const UiRecipeSummarySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  prep_minutes: z.number().int().min(0).nullable(),
  cook_minutes: z.number().int().min(0).nullable(),
  servings: z.string(),
  course: UiRecipeCourseSchema,
  tags: z.array(z.string()),
  provenance_note: z.string(),
  source_era: z.string(),
  attributed_person_id: z.string().nullable(),
  attributed_person: UiRecipeAncestorRefSchema.nullable(),
  cover_photo_id: z.string().nullable(),
  cover_photo_url: z.string().nullable(),
  star_count: z.number().int().min(0),
  comment_count: z.number().int().min(0),
  viewer_has_starred: z.boolean(),
  version: z.number().int().min(1),
  created_by_name: z.string(),
  updated_by_name: z.string(),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
});
export type UiRecipeSummary = z.infer<typeof UiRecipeSummarySchema>;

export const UiRecipeDetailSchema = UiRecipeSummarySchema.extend({
  story_md: z.string(),
  ingredients: z.array(UiRecipeIngredientSchema),
  steps: z.array(UiRecipeStepSchema),
});
export type UiRecipeDetail = z.infer<typeof UiRecipeDetailSchema>;

export const UiRecipeListResponseSchema = z.object({
  recipes: z.array(UiRecipeSummarySchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1).default(40),
  offset: z.number().int().min(0).default(0),
  facets: z.object({
    courses: z.array(UiRecipeCourseSchema),
    tags: z.array(z.string()),
  }),
  display: z
    .object({
      show_home_widget: z.boolean(),
    })
    .optional(),
});
export type UiRecipeListResponse = z.infer<typeof UiRecipeListResponseSchema>;

export const UiRecipeMediaLimitsSchema = z.object({
  max_photo_mb: z.number().int().min(1).max(25),
  max_photos_per_recipe: z.number().int().min(1).max(30),
});
export type UiRecipeMediaLimits = z.infer<typeof UiRecipeMediaLimitsSchema>;

export const UiRecipeDetailResponseSchema = z.object({
  recipe: UiRecipeDetailSchema,
  photos: z.array(UiRecipePhotoSchema),
  viewer_has_starred: z.boolean(),
  permissions: UiRecipePermissionsSchema,
  media_limits: UiRecipeMediaLimitsSchema.optional(),
});
export type UiRecipeDetailResponse = z.infer<typeof UiRecipeDetailResponseSchema>;

export const UiRecipePhotoMutationResponseSchema = z.object({
  photo: UiRecipePhotoSchema,
  cover_photo_id: z.string().nullable(),
  cover_photo_url: z.string().nullable().optional(),
});
export type UiRecipePhotoMutationResponse = z.infer<typeof UiRecipePhotoMutationResponseSchema>;

export const UiRecipePhotosReorderResponseSchema = z.object({
  photos: z.array(UiRecipePhotoSchema),
});
export type UiRecipePhotosReorderResponse = z.infer<typeof UiRecipePhotosReorderResponseSchema>;

export const UiRecipesByPersonResponseSchema = z.object({
  person_id: z.string().min(1),
  recipes: z.array(UiRecipeSummarySchema),
  total: z.number().int().min(0),
});
export type UiRecipesByPersonResponse = z.infer<typeof UiRecipesByPersonResponseSchema>;

export function parseUiRecipeListResponse(raw: unknown): UiRecipeListResponse {
  return UiRecipeListResponseSchema.parse(raw);
}

export function parseUiRecipeDetailResponse(raw: unknown): UiRecipeDetailResponse {
  return UiRecipeDetailResponseSchema.parse(raw);
}

export function parseUiRecipePhotoMutationResponse(raw: unknown): UiRecipePhotoMutationResponse {
  return UiRecipePhotoMutationResponseSchema.parse(raw);
}

export function parseUiRecipePhotosReorderResponse(raw: unknown): UiRecipePhotosReorderResponse {
  return UiRecipePhotosReorderResponseSchema.parse(raw);
}

export function parseUiRecipesByPersonResponse(raw: unknown): UiRecipesByPersonResponse {
  return UiRecipesByPersonResponseSchema.parse(raw);
}

export const DEFAULT_RECIPES_ROUTE_BASE = '/recipes';

export function formatRecipeCourseLabel(course: UiRecipeCourse): string {
  return UI_RECIPE_COURSE_LABELS[course];
}

export function formatRecipeDuration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) {
    return null;
  }
  const rounded = Math.trunc(minutes);
  if (rounded === 0) {
    return '0 min';
  }
  const hours = Math.floor(rounded / 60);
  const mins = rounded % 60;
  if (hours === 0) {
    return `${mins} min`;
  }
  if (mins === 0) {
    return `${hours} hr`;
  }
  return `${hours} hr ${mins} min`;
}

export function formatTotalRecipeDuration(
  prepMinutes: number | null,
  cookMinutes: number | null
): string | null {
  if (prepMinutes === null && cookMinutes === null) {
    return null;
  }
  return formatRecipeDuration((prepMinutes ?? 0) + (cookMinutes ?? 0));
}

export interface RecipeIngredientGroup {
  readonly group: string;
  readonly items: readonly UiRecipeIngredient[];
}

/**
 * Groups ingredients by their `group` heading while preserving original declaration order.
 */
export function groupRecipeIngredients(
  ingredients: readonly UiRecipeIngredient[]
): readonly RecipeIngredientGroup[] {
  const groups: Array<{ group: string; items: UiRecipeIngredient[] }> = [];
  const byName = new Map<string, { group: string; items: UiRecipeIngredient[] }>();
  for (const ingredient of ingredients) {
    const key = ingredient.group.trim();
    let bucket = byName.get(key);
    if (!bucket) {
      bucket = { group: key, items: [] };
      byName.set(key, bucket);
      groups.push(bucket);
    }
    bucket.items.push(ingredient);
  }
  return groups;
}

export function formatRecipeIngredientLine(ingredient: UiRecipeIngredient): string {
  const measureParts = [ingredient.quantity.trim(), ingredient.unit.trim()].filter(Boolean);
  const lead = measureParts.length > 0 ? `${measureParts.join(' ')} ` : '';
  const tail = ingredient.note.trim() ? `, ${ingredient.note.trim()}` : '';
  return `${lead}${ingredient.item.trim()}${tail}`;
}

export interface RecipesListQueryParams {
  readonly q?: string;
  readonly course?: UiRecipeCourse;
  readonly tag?: string;
  readonly attributed_person_id?: string;
  readonly favorites?: boolean;
  readonly sort?: UiRecipeSortMode;
  readonly limit?: number;
  readonly offset?: number;
}

export function buildRecipesListQueryString(params: RecipesListQueryParams = {}): string {
  const sp = new URLSearchParams();
  if (params.q && params.q.trim().length > 0) {
    sp.set('q', params.q.trim());
  }
  if (params.course) {
    sp.set('course', params.course);
  }
  if (params.tag && params.tag.trim().length > 0) {
    sp.set('tag', params.tag.trim().toLowerCase());
  }
  if (params.attributed_person_id && params.attributed_person_id.trim().length > 0) {
    sp.set('attributed_person_id', params.attributed_person_id.trim());
  }
  if (params.favorites) {
    sp.set('favorites', '1');
  }
  if (params.sort) {
    sp.set('sort', params.sort);
  }
  if (params.limit !== undefined) {
    sp.set('limit', String(Math.max(1, Math.min(100, Math.trunc(params.limit)))));
  }
  if (params.offset !== undefined && params.offset > 0) {
    sp.set('offset', String(Math.max(0, Math.trunc(params.offset))));
  }
  const encoded = sp.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

/**
 * Pure static-mode catalog filter/sort/pagination helper matching server repository semantics.
 */
export function filterStaticRecipes(
  recipes: readonly UiRecipeDetail[],
  params: RecipesListQueryParams = {},
  showHomeWidget = true
): UiRecipeListResponse {
  const courseSet = new Set<UiRecipeCourse>();
  const tagSet = new Set<string>();
  for (const recipe of recipes) {
    courseSet.add(recipe.course);
    for (const tag of recipe.tags) {
      tagSet.add(tag.toLowerCase());
    }
  }
  const facets = {
    courses: [...courseSet].toSorted((a, b) => a.localeCompare(b)),
    tags: [...tagSet].toSorted((a, b) => a.localeCompare(b)),
  };

  const needle = params.q?.trim().toLowerCase() ?? '';
  const tagFilter = params.tag?.trim().toLowerCase() ?? '';
  const filtered = recipes.filter((recipe) => {
    if (params.course && recipe.course !== params.course) {
      return false;
    }
    if (tagFilter && !recipe.tags.some((t) => t.toLowerCase() === tagFilter)) {
      return false;
    }
    if (params.attributed_person_id && recipe.attributed_person_id !== params.attributed_person_id) {
      return false;
    }
    if (params.favorites && !recipe.viewer_has_starred) {
      return false;
    }
    if (needle) {
      const hit =
        recipe.title.toLowerCase().includes(needle) ||
        recipe.summary.toLowerCase().includes(needle) ||
        recipe.provenance_note.toLowerCase().includes(needle) ||
        recipe.tags.some((t) => t.toLowerCase().includes(needle));
      if (!hit) {
        return false;
      }
    }
    return true;
  });

  const sort = params.sort ?? 'newest';
  const sorted = filtered.toSorted((a, b) => {
    if (sort === 'stars') {
      if (b.star_count !== a.star_count) {
        return b.star_count - a.star_count;
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

  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit ?? 40)));
  const offset = Math.max(0, Math.trunc(params.offset ?? 0));
  const page = sorted.slice(offset, offset + limit);

  return {
    recipes: page,
    total: sorted.length,
    limit,
    offset,
    facets,
    display: { show_home_widget: showHomeWidget },
  };
}
