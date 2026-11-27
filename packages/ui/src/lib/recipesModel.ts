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
  permissions: z
    .object({
      can_create: z.boolean(),
    })
    .optional(),
});
export type UiRecipeListResponse = z.infer<typeof UiRecipeListResponseSchema>;

export const UiRecipeMutationResponseSchema = z.object({
  recipe: UiRecipeDetailSchema,
  permissions: UiRecipePermissionsSchema.optional(),
});
export type UiRecipeMutationResponse = z.infer<typeof UiRecipeMutationResponseSchema>;

export const UiRecipeVersionConflictDetailsSchema = z.object({
  expected_version: z.number().int().min(1),
  server_version: z.number().int().min(1),
  server_updated_at: z.string().min(1),
  server_updated_by_name: z.string(),
  server_recipe: UiRecipeDetailSchema,
});
export type UiRecipeVersionConflictDetails = z.infer<typeof UiRecipeVersionConflictDetailsSchema>;

export interface UiCreateRecipePayload {
  readonly title: string;
  readonly slug?: string;
  readonly summary: string;
  readonly story_md: string;
  readonly ingredients: readonly UiRecipeIngredient[];
  readonly steps: readonly UiRecipeStep[];
  readonly prep_minutes: number | null;
  readonly cook_minutes: number | null;
  readonly servings: string;
  readonly course: UiRecipeCourse;
  readonly tags: readonly string[];
  readonly provenance_note: string;
  readonly source_era: string;
  readonly attributed_person_id: string | null;
}

export interface UiUpdateRecipePayload extends UiCreateRecipePayload {
  readonly expected_version: number;
}

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

export function parseUiRecipeMutationResponse(raw: unknown): UiRecipeMutationResponse {
  return UiRecipeMutationResponseSchema.parse(raw);
}

export function parseUiRecipeVersionConflict(details: unknown): UiRecipeVersionConflictDetails | null {
  const parsed = UiRecipeVersionConflictDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
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

export interface RecipeEditorIngredientDraft {
  readonly id: string;
  readonly quantity: string;
  readonly unit: string;
  readonly item: string;
  readonly note: string;
  readonly group: string;
}

export interface RecipeEditorStepDraft {
  readonly id: string;
  readonly instruction: string;
  readonly note: string;
}

export interface RecipeEditorDraft {
  readonly title: string;
  readonly slug: string;
  readonly summary: string;
  readonly story_md: string;
  readonly ingredients: readonly RecipeEditorIngredientDraft[];
  readonly steps: readonly RecipeEditorStepDraft[];
  readonly prep_minutes: string;
  readonly cook_minutes: string;
  readonly servings: string;
  readonly course: UiRecipeCourse;
  readonly tags: readonly string[];
  readonly provenance_note: string;
  readonly source_era: string;
  readonly attributed_person_id: string | null;
}

export type ValidateRecipeDraftResult =
  | {
      readonly ok: true;
      readonly payload: UiCreateRecipePayload;
    }
  | {
      readonly ok: false;
      readonly fieldErrors: Readonly<Record<string, string>>;
      readonly summary: string;
    };

const RECIPE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECIPE_TAG_RE = /^[a-z0-9][a-z0-9 -]*$/i;

export function createEmptyIngredientDraft(id: string): RecipeEditorIngredientDraft {
  return { id, quantity: '', unit: '', item: '', note: '', group: '' };
}

export function createEmptyStepDraft(id: string): RecipeEditorStepDraft {
  return { id, instruction: '', note: '' };
}

export function createEmptyRecipeDraft(): RecipeEditorDraft {
  return {
    title: '',
    slug: '',
    summary: '',
    story_md: '',
    ingredients: [createEmptyIngredientDraft('ing_1')],
    steps: [createEmptyStepDraft('stp_1')],
    prep_minutes: '',
    cook_minutes: '',
    servings: '',
    course: 'other',
    tags: [],
    provenance_note: '',
    source_era: '',
    attributed_person_id: null,
  };
}

export function recipeDetailToEditorDraft(recipe: UiRecipeDetail): RecipeEditorDraft {
  return {
    title: recipe.title,
    slug: recipe.slug,
    summary: recipe.summary,
    story_md: recipe.story_md,
    ingredients:
      recipe.ingredients.length > 0
        ? recipe.ingredients.map((ing) => ({
            id: ing.id,
            quantity: ing.quantity,
            unit: ing.unit,
            item: ing.item,
            note: ing.note,
            group: ing.group,
          }))
        : [createEmptyIngredientDraft('ing_1')],
    steps:
      recipe.steps.length > 0
        ? recipe.steps.map((step) => ({
            id: step.id,
            instruction: step.instruction,
            note: step.note,
          }))
        : [createEmptyStepDraft('stp_1')],
    prep_minutes: recipe.prep_minutes === null ? '' : String(recipe.prep_minutes),
    cook_minutes: recipe.cook_minutes === null ? '' : String(recipe.cook_minutes),
    servings: recipe.servings,
    course: recipe.course,
    tags: [...recipe.tags],
    provenance_note: recipe.provenance_note,
    source_era: recipe.source_era,
    attributed_person_id: recipe.attributed_person_id,
  };
}

export function isRecipeDraftDirty(current: RecipeEditorDraft, baseline: RecipeEditorDraft): boolean {
  return JSON.stringify(current) !== JSON.stringify(baseline);
}

export function moveDraftListItem<T>(items: readonly T[], index: number, delta: -1 | 1): T[] {
  const nextIndex = index + delta;
  if (index < 0 || index >= items.length || nextIndex < 0 || nextIndex >= items.length) {
    return [...items];
  }
  const copy = [...items];
  const [moved] = copy.splice(index, 1);
  if (moved === undefined) {
    return copy;
  }
  copy.splice(nextIndex, 0, moved);
  return copy;
}

export function normalizeDraftTagInput(raw: string): {
  readonly ok: boolean;
  readonly tag?: string;
  readonly error?: string;
} {
  const cleaned = raw.trim().replace(/^#+/, '').trim().toLowerCase();
  if (!cleaned) {
    return { ok: false, error: 'Enter a tag before adding.' };
  }
  if (cleaned.length > 40) {
    return { ok: false, error: 'Tags must be 40 characters or fewer.' };
  }
  if (!RECIPE_TAG_RE.test(cleaned)) {
    return { ok: false, error: 'Tags may contain letters, numbers, spaces, and hyphens.' };
  }
  return { ok: true, tag: cleaned };
}

export function addDraftTag(
  tags: readonly string[],
  raw: string
): { readonly tags: readonly string[]; readonly error?: string } {
  const parsed = normalizeDraftTagInput(raw);
  if (!parsed.ok || !parsed.tag) {
    return { tags, error: parsed.error };
  }
  if (tags.includes(parsed.tag)) {
    return { tags };
  }
  if (tags.length >= 20) {
    return { tags, error: 'Recipes can have at most 20 tags.' };
  }
  return { tags: [...tags, parsed.tag] };
}

export function removeDraftTag(tags: readonly string[], tagToRemove: string): string[] {
  return tags.filter((t) => t !== tagToRemove);
}

function parseOptionalDurationField(
  raw: string,
  label: string
): { readonly ok: true; readonly value: number | null } | { readonly ok: false; readonly error: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: true, value: null };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `${label} must be a whole number of minutes.` };
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10080) {
    return { ok: false, error: `${label} must be between 0 and 10080 minutes.` };
  }
  return { ok: true, value: parsed };
}

export function validateRecipeDraft(draft: RecipeEditorDraft): ValidateRecipeDraftResult {
  const fieldErrors: Record<string, string> = {};

  const title = draft.title.trim();
  if (title.length < 2) {
    fieldErrors.title = 'Enter a recipe title of at least 2 characters.';
  } else if (title.length > 140) {
    fieldErrors.title = 'Recipe title must be 140 characters or fewer.';
  }

  const slug = draft.slug.trim();
  if (slug.length > 0) {
    if (slug.length < 2 || slug.length > 96 || !RECIPE_SLUG_RE.test(slug)) {
      fieldErrors.slug =
        'Use 2 to 96 lowercase letters, numbers, and single hyphens (for example honey-biscuits).';
    }
  }

  const summary = draft.summary.trim();
  if (summary.length > 400) {
    fieldErrors.summary = 'Summary must be 400 characters or fewer.';
  }

  const storyMd = draft.story_md.trim();
  if (storyMd.length > 16000) {
    fieldErrors.story_md = 'Family story must be 16,000 characters or fewer.';
  }

  const prepParsed = parseOptionalDurationField(draft.prep_minutes, 'Prep time');
  if (!prepParsed.ok) {
    fieldErrors.prep_minutes = prepParsed.error;
  }

  const cookParsed = parseOptionalDurationField(draft.cook_minutes, 'Cook time');
  if (!cookParsed.ok) {
    fieldErrors.cook_minutes = cookParsed.error;
  }

  const servings = draft.servings.trim();
  if (servings.length > 60) {
    fieldErrors.servings = 'Servings must be 60 characters or fewer.';
  }

  const provenanceNote = draft.provenance_note.trim();
  if (provenanceNote.length > 400) {
    fieldErrors.provenance_note = 'Provenance note must be 400 characters or fewer.';
  }

  const sourceEra = draft.source_era.trim();
  if (sourceEra.length > 60) {
    fieldErrors.source_era = 'Source era must be 60 characters or fewer.';
  }

  const cleanedIngredients: UiRecipeIngredient[] = [];
  for (let i = 0; i < draft.ingredients.length; i += 1) {
    const row = draft.ingredients[i];
    const quantity = row.quantity.trim();
    const unit = row.unit.trim();
    const item = row.item.trim();
    const note = row.note.trim();
    const group = row.group.trim();
    const hasAnyValue = Boolean(quantity || unit || item || note || group);
    if (!hasAnyValue) {
      continue;
    }
    if (!item) {
      fieldErrors[`ingredients.${i}.item`] = `Enter an ingredient name for row ${i + 1}.`;
      continue;
    }
    if (item.length > 160) {
      fieldErrors[`ingredients.${i}.item`] = `Ingredient ${i + 1} must be 160 characters or fewer.`;
      continue;
    }
    cleanedIngredients.push({
      id: row.id.trim().slice(0, 32) || `ing_${i + 1}`,
      quantity: quantity.slice(0, 40),
      unit: unit.slice(0, 40),
      item,
      note: note.slice(0, 160),
      group: group.slice(0, 80),
    });
  }
  if (cleanedIngredients.length > 100) {
    fieldErrors.ingredients = 'Recipes may include at most 100 ingredients.';
  }

  const cleanedSteps: UiRecipeStep[] = [];
  for (let i = 0; i < draft.steps.length; i += 1) {
    const row = draft.steps[i];
    const instruction = row.instruction.trim();
    const note = row.note.trim();
    if (!instruction && !note) {
      continue;
    }
    if (!instruction) {
      fieldErrors[`steps.${i}.instruction`] = `Enter directions for step ${i + 1}.`;
      continue;
    }
    if (instruction.length > 1200) {
      fieldErrors[`steps.${i}.instruction`] = `Step ${i + 1} must be 1,200 characters or fewer.`;
      continue;
    }
    cleanedSteps.push({
      id: row.id.trim().slice(0, 32) || `stp_${i + 1}`,
      instruction,
      note: note.slice(0, 300),
    });
  }
  if (cleanedSteps.length > 60) {
    fieldErrors.steps = 'Recipes may include at most 60 preparation steps.';
  }

  const normalizedTags: string[] = [];
  const seenTags = new Set<string>();
  for (const rawTag of draft.tags) {
    const parsedTag = normalizeDraftTagInput(rawTag);
    if (!parsedTag.ok || !parsedTag.tag) {
      fieldErrors.tags = parsedTag.error ?? 'Invalid tag format.';
      break;
    }
    if (!seenTags.has(parsedTag.tag)) {
      seenTags.add(parsedTag.tag);
      normalizedTags.push(parsedTag.tag);
    }
  }
  if (normalizedTags.length > 20) {
    fieldErrors.tags = 'Recipes can have at most 20 tags.';
  }

  const errorKeys = Object.keys(fieldErrors);
  if (errorKeys.length > 0 || !prepParsed.ok || !cookParsed.ok) {
    const count = errorKeys.length;
    return {
      ok: false,
      fieldErrors,
      summary:
        count === 1
          ? (fieldErrors[errorKeys[0]] ?? 'Review the highlighted field before saving.')
          : `Fix ${count} highlighted fields before saving.`,
    };
  }

  return {
    ok: true,
    payload: {
      title,
      ...(slug ? { slug } : {}),
      summary,
      story_md: storyMd,
      ingredients: cleanedIngredients,
      steps: cleanedSteps,
      prep_minutes: prepParsed.value,
      cook_minutes: cookParsed.value,
      servings,
      course: draft.course,
      tags: normalizedTags,
      provenance_note: provenanceNote,
      source_era: sourceEra,
      attributed_person_id: draft.attributed_person_id?.trim() || null,
    },
  };
}

const ApiFieldErrorListSchema = z.array(
  z.object({
    path: z.string(),
    message: z.string(),
  })
);

export function extractRecipeApiFieldErrors(details: unknown): Readonly<Record<string, string>> {
  const parsed = ApiFieldErrorListSchema.safeParse(details);
  if (!parsed.success) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const item of parsed.data) {
    if (item.path && !out[item.path]) {
      out[item.path] = item.message;
    }
  }
  return out;
}
